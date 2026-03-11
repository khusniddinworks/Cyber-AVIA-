from gevent import monkey
monkey.patch_all()
import gevent

import os
import time
import math
import json
import base64
import logging
import threading
import requests
import numpy as np
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import ProxyHandler, Request, build_opener
from flask import Flask, request, jsonify, send_from_directory, abort, make_response
from flask_socketio import SocketIO, emit
from flask_sqlalchemy import SQLAlchemy
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from sqlalchemy import func
from sklearn.ensemble import IsolationForest
from cryptography.fernet import Fernet
from dotenv import load_dotenv

# Enterprise Logging Configuration
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] SECURITY_AUDIT: %(message)s',
    handlers=[logging.FileHandler("security_audit.log"), logging.StreamHandler()]
)
logger = logging.getLogger(__name__)

load_dotenv()

# --- SECURITY VALIDATION (FAIL-FAST) ---
REQUIRED_ENV = ["ADMIN_USER", "ADMIN_PASS", "ENCRYPTION_KEY", "SECRET_KEY"]
missing_keys = [key for key in REQUIRED_ENV if not os.getenv(key)]

if missing_keys:
    logger.critical(f"FATAL SECURITY ERROR: Missing required environment variables: {missing_keys}")
    print(f"\n[!] SECURITY ERROR: Please set {missing_keys} in your .env file.\n")
    # In a real military-grade app, we stop execution here.
    # For now, we will raise an error to prevent accidental 'admin/admin' scenarios.
    raise EnvironmentError(f"Missing security configuration: {missing_keys}")

HOST = os.getenv("HOST", "0.0.0.0")  # Bind to 0.0.0.0 for external access
PORT = int(os.getenv("PORT", 8080))
DEBUG_MODE = os.getenv("DEBUG", "False").lower() == "true"
OPENSKY_BASE = "https://opensky-network.org/api"
ADSB_BASE = "https://api.adsb.lol/v2"
OPENSKY_BEARER_TOKEN = os.getenv("OPENSKY_BEARER_TOKEN", "").strip()
OPENSKY_USER = os.getenv("OPENSKY_USER", "").strip()
OPENSKY_PASS = os.getenv("OPENSKY_PASS", "").strip()

# Security Config
ADMIN_USER = os.getenv("ADMIN_USER")
ADMIN_PASS = os.getenv("ADMIN_PASS")
ENC_KEY = os.getenv("ENCRYPTION_KEY")
cipher = Fernet(ENC_KEY.encode())

OPEN_TIMEOUT_SEC = 25
LIVE_CACHE_TTL_SEC = 15

# AI Model State
class AIState:
    def __init__(self):
        self.model = IsolationForest(contamination=0.05, random_state=42)
        self.is_trained = False
        self.lock = threading.Lock()

ai_engine = AIState()

app = Flask(__name__, static_folder='.', static_url_path='')
app.config['SECRET_KEY'] = os.getenv("SECRET_KEY")

# Database configuration for local (SQLite) and Cloud (PostgreSQL/Neon)
db_url = os.getenv("DATABASE_URL", "sqlite:///flight.db")
if db_url.startswith("postgres://"):
    db_url = db_url.replace("postgres://", "postgresql://", 1)

app.config['SQLALCHEMY_DATABASE_URI'] = db_url
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='gevent')
limiter = Limiter(get_remote_address, app=app, default_limits=["200 per minute"])

# --- SECURITY MIDDLEWARE (Expert Level) ---
@app.after_request
def apply_security_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['X-XSS-Protection'] = '1; mode=block'
    
    # CORS for client-side direct API fetch
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    
    # Modernized CSP
    csp = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net; "
        "img-src 'self' data: https://*.tile.openstreetmap.org https://unpkg.com https://server.arcgisonline.com https://*.basemaps.cartocdn.com; "
        "style-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "connect-src 'self' https://opensky-network.org https://api.adsb.lol; "
        "frame-ancestors 'none';"
    )
    response.headers['Content-Security-Policy'] = csp
    response.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
    return response

def log_security_event(event_type, details):
    client_ip = request.remote_addr
    logger.warning(f"{event_type} | IP: {client_ip} | Details: {details}")

class Flight(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    icao24 = db.Column(db.String(6), index=True)
    callsign_enc = db.Column(db.Text) # Encrypted callsign
    country = db.Column(db.String(64))
    lon = db.Column(db.Float)
    lat = db.Column(db.Float)
    altitude = db.Column(db.Float)
    velocity = db.Column(db.Float)
    track = db.Column(db.Float)
    on_ground = db.Column(db.Boolean)
    timestamp = db.Column(db.Float, index=True)

    @property
    def callsign(self):
        if not self.callsign_enc: return ""
        try:
            return cipher.decrypt(self.callsign_enc.encode()).decode()
        except:
            return "[ENCRYPTED]"

    @callsign.setter
    def callsign(self, value):
        if value:
            self.callsign_enc = cipher.encrypt(value.encode()).decode()

class Anomaly(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    icao24 = db.Column(db.String(6), index=True)
    type = db.Column(db.String(32))
    severity = db.Column(db.String(8)) # low, medium, high
    risk_score = db.Column(db.Integer) # 0-100
    details = db.Column(db.String(256))
    detected_at = db.Column(db.Float, default=time.time)

# utilities

def calculate_distance(lat1, lon1, lat2, lon2):
    # Haversine formula
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c

def to_float(value, default):
    try:
        return float(value)
    except Exception:
        return default

def to_int(value, default):
    try:
        return int(value)
    except Exception:
        return default

OPENER = build_opener(ProxyHandler({}))
LIVE_CACHE = {}

def get_fallback_data():
    """Returns empty data when all APIs fail. No fake planes — integrity first."""
    return {"provider": "offline", "states": []}

def try_opensky_live(url):
    auth = None
    if OPENSKY_BEARER_TOKEN:
        headers = {"Authorization": f"Bearer {OPENSKY_BEARER_TOKEN}", "User-Agent": "Mozilla/5.0"}
    elif OPENSKY_USER and OPENSKY_PASS:
        auth = (OPENSKY_USER, OPENSKY_PASS)
        headers = {"User-Agent": "Mozilla/5.0"}
    else:
        headers = {"User-Agent": "Mozilla/5.0"}

    try:
        r = requests.get(url, headers=headers, auth=auth, timeout=15)
        r.raise_for_status()
        data = r.json()
        states = data.get("states")
        if isinstance(states, list):
            return {"provider": "opensky", "states": states}
    except Exception as e:
        logger.error(f"OpenSky API Failure: {e}")
    return None

def try_adsb_live(params):
    lamin = to_float(params.get("lamin", -20), -20.0)
    lamax = to_float(params.get("lamax", 70), 70.0)
    lomin = to_float(params.get("lomin", -30), -30.0)
    lomax = to_float(params.get("lomax", 90), 90.0)

    lat_span = max(0.1, abs(lamax - lamin))
    lon_span = max(0.1, abs(lomax - lomin))
    lat_center = (lamin + lamax) / 2.0
    lon_center = (lomin + lomax) / 2.0

    lat_cells = 1 if lat_span < 35 else 2
    lon_cells = 1 if lon_span < 45 else (2 if lon_span < 95 else 3)
    if lat_cells * lon_cells > 6:
        lon_cells = max(1, 6 // lat_cells)

    centers = []
    for i in range(lat_cells):
        for j in range(lon_cells):
            c_lat = lamin + ((i + 0.5) / lat_cells) * lat_span
            c_lon = lomin + ((j + 0.5) / lon_cells) * lon_span
            centers.append((c_lat, c_lon))
    if not centers:
        centers = [(lat_center, lon_center)]

    merged = {}
    for c_lat, c_lon in centers:
        cell_lat_km = lat_span * 111.0 / lat_cells
        cell_lon_km = lon_span * 111.0 * max(0.2, math.cos(math.radians(c_lat))) / lon_cells
        dist_km = max(180, min(3200, int(max(cell_lat_km, cell_lon_km) * 0.95 + 140)))
        ac = fetch_adsb_aircraft(c_lat, c_lon, dist_km)
        if ac is None:
            continue
        for item in ac:
            lat = item.get("lat")
            lon = item.get("lon")
            if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
                continue
            key = ((item.get("hex") or "").lower(), round(lat, 3), round(lon, 3))
            merged[key] = item
    
    if not merged:
        return None

    states = []
    for item in merged.values():
        state = [None] * 17
        state[0] = (item.get("hex") or "").lower()
        state[1] = (item.get("flight") or "").strip()
        state[2] = item.get("r") or "Unknown"
        state[5] = item.get("lon")
        state[6] = item.get("lat")
        
        alt_baro = item.get("alt_baro")
        alt_geom = item.get("alt_geom")
        state[8] = alt_baro == "ground"
        
        gs = item.get("gs")
        if isinstance(gs, (int, float)):
            state[9] = gs * 0.514444
        
        track = item.get("track")
        if isinstance(track, (int, float)):
            state[10] = track
        
        if isinstance(alt_baro, (int, float)):
            state[7] = alt_baro * 0.3048
        if isinstance(alt_geom, (int, float)):
            state[13] = alt_geom * 0.3048
        
        states.append(state)

    return {"provider": "adsb.lol", "states": states}

def fetch_adsb_aircraft(lat, lon, dist_km):
    url = f"{ADSB_BASE}/lat/{lat:.4f}/lon/{lon:.4f}/dist/{dist_km}"
    try:
        r = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=15)
        r.raise_for_status()
        data = r.json()
        ac = data.get("ac")
        return ac if isinstance(ac, list) else None
    except Exception as e:
        logger.error(f"ADSB.lol Failure: {e}")
        return None

def detect_anomalies(flights, timestamp):
    anomalies = []
    seen_icao = set()
    current_icaos = set()
    
    for f in flights:
        icao = f.get('icao24','').lower()
        if not icao: continue
        current_icaos.add(icao)
        
        speed_kmh = (f.get('velocity') or 0) * 3.6
        alt = f.get('altitude') or 0
        
        # 1. High Speed (Supersonic or False Signal)
        if speed_kmh > 1250:
            anomalies.append({
                'icao24': icao, 'type': 'high_speed_anom', 'severity': 'high', 'risk_score': 92,
                'details': f'Extreme vector: {speed_kmh:.0f} km/h'
            })
        
        # 2. Duplicate ICAO (Identity Spoofing)
        if icao in seen_icao:
            anomalies.append({
                'icao24': icao, 'type': 'signal_spoof', 'severity': 'critical', 'risk_score': 98,
                'details': 'Ghost signature: Identity duplication'
            })
        seen_icao.add(icao)

        # 3. Sudden Vector Jumps (Teleportation or Radar Error)
        last_f = Flight.query.filter_by(icao24=icao).order_by(Flight.timestamp.desc()).first()
        if last_f:
            # Altitude Jump (Spoofing indicator)
            if last_f.altitude and alt and abs(alt - last_f.altitude) > 10000: # 10k ft jump
                anomalies.append({
                    'icao24': icao, 'type': 'altitude_tamper', 'severity': 'high', 'risk_score': 88,
                    'details': f'Vertical jump: {abs(alt - last_f.altitude):.0f} ft'
                })
            
            # Distance Jump
            if last_f.lat and last_f.lon and f['lat'] and f['lon']:
                dist = calculate_distance(last_f.lat, last_f.lon, f['lat'], f['lon'])
                dt = timestamp - last_f.timestamp
                if dt > 0 and dt < 120: # Within 2 updates
                    calc_speed = (dist / dt) * 3600
                    if calc_speed > 2000:
                        anomalies.append({
                            'icao24': icao, 'type': 'vector_jump', 'severity': 'high', 'risk_score': 85,
                            'details': f'Incoherent jump: {dist:.1f} km at {calc_speed:.0f} km/h'
                        })

    # 4. Signal Loss Tracking (Selective Intelligence)
    # Only alert for significant signal loss (flights seen in last 2m)
    two_min_ago = timestamp - 120
    lost = db.session.query(Flight.icao24).filter(Flight.timestamp > two_min_ago - 60, Flight.timestamp < two_min_ago).distinct().all()
    for (m_icao,) in lost:
        if m_icao.lower() not in current_icaos:
            exists = Anomaly.query.filter_by(icao24=m_icao, type='signal_loss').filter(Anomaly.detected_at > two_min_ago).first()
            if not exists:
                anomalies.append({
                    'icao24': m_icao, 'type': 'signal_loss', 'severity': 'medium', 'risk_score': 60,
                    'details': 'Target lost contact'
                })
    
    return anomalies

@app.route('/health')
def health_check():
    """Health check endpoint for Render/Koyeb monitoring."""
    return jsonify({"status": "healthy", "timestamp": time.time()})

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

def get_live_data_parallel(params):
    opensky_url = f"{OPENSKY_BASE}/states/all"
    if params:
        opensky_url += "?" + urlencode(params)
    
    # Gevent-friendly parallel execution
    from gevent.pool import Pool
    pool = Pool(size=2)
    t1 = pool.spawn(try_opensky_live, opensky_url)
    t2 = pool.spawn(try_adsb_live, params)
    
    # Priority 1: OpenSky
    res1 = t1.get()
    if res1 and res1.get("states"): return res1
    
    # Priority 2: ADSB.lol
    res2 = t2.get()
    if res2 and res2.get("states"): return res2
    
    return get_fallback_data()

@app.route('/api/live')
@limiter.limit("30 per minute")
def api_live():
    params = {}
    for k in ["lamin","lamax","lomin","lomax"]:
        if k in request.args: params[k] = request.args[k]
    
    now = time.time()
    cache_key = str(sorted(params.items())) if params else "all"
    if cache_key in LIVE_CACHE:
        t, d = LIVE_CACHE[cache_key]
        if now - t < LIVE_CACHE_TTL_SEC: return jsonify(d)

    payload = get_live_data_parallel(params)
    LIVE_CACHE[cache_key] = (now, payload)
    
    # Extract flight details from payload
    flights = []
    for r in payload.get("states",[]):
        flights.append({
            'icao24': (r[0] or "").strip(),
            'callsign': (r[1] or "").strip(),
            'lon': r[5],'lat':r[6],'onGround':bool(r[8]),
            'velocity': r[9],'track':r[10],
            'altitude': r[13] if len(r) > 13 else r[7] if len(r) > 7 else 0,
            'country': r[2] or "Unknown"
        })
    
    # Store flights and detect anomalies - PERFORMANCE OPTIMIZED
    try:
        # Only store anomalies in the database to save storage and improve speed
        anomalies = detect_anomalies(flights, now)
        try:
            ai_anomalies = detect_ai_anomalies(flights)
            anomalies.extend(ai_anomalies)
        except Exception as e:
            logger.warning(f"AI detection error: {e}")

        for a in anomalies:
            db.session.add(Anomaly(
                icao24=a['icao24'], type=a['type'],
                severity=a['severity'], risk_score=a.get('risk_score', 0),
                details=a['details'], detected_at=now
            ))
        
        # Keep only a sample of normal flights in DB to avoid bloat
        # In professional systems, we only log targets of interest (TOI)
        for f in flights[:50]: # Only top 50 to track history
            rec = Flight(
                icao24=f['icao24'], country=f['country'],
                lon=f['lon'], lat=f['lat'], altitude=f['altitude'],
                velocity=f['velocity'], track=f['track'], on_ground=f['onGround'],
                timestamp=now
            )
            rec.callsign = f['callsign']
            db.session.add(rec)
            
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        logger.error(f"Post-processing error: {e}")
    
    return jsonify(payload)

def train_ai_model():
    """Trains the model based on historical flight data."""
    with app.app_context():
        # Get last 5000 flight records for training
        records = Flight.query.order_by(Flight.timestamp.desc()).limit(5000).all()
        if len(records) < 100:
            print("Not enough data to train AI (need > 100 records)")
            return

        # Prepare features: altitude, velocity, track
        data = [[r.altitude or 0, r.velocity or 0, r.track or 0] for r in records]
        X = np.array(data)

        with ai_engine.lock:
            ai_engine.model.fit(X)
            ai_engine.is_trained = True
            print(f"AI Model trained successfully on {len(records)} records")

def detect_ai_anomalies(flights):
    """
    Predicts anomalies using the trained IsolationForest model.
    """
    if not ai_engine.is_trained:
        return []

    ai_alerts = []
    # Prepare features for current flights
    features = []
    flight_map = []
    for f in flights:
        alt = f.get('altitude') or 0
        vel = f.get('velocity') or 0
        trk = f.get('track') or 0
        features.append([alt, vel, trk])
        flight_map.append(f)

    if not features:
        return []

    X = np.array(features)
    with ai_engine.lock:
        preds = ai_engine.model.predict(X) # -1 for anomaly, 1 for normal
        scores = ai_engine.model.decision_function(X) # lower means more anomalous

    for i, p in enumerate(preds):
        if p == -1:
            icao = flight_map[i]['icao24']
            # Only alert if score is significantly low (more confidence)
            score_norm = int(max(0, min(100, (0.5 - scores[i]) * 100))) 
            if score_norm > 60:
                ai_alerts.append({
                    'icao24': icao, 'type': 'ai_anomaly', 'severity': 'medium', 'risk_score': score_norm,
                    'details': f'AI: Detected unusual flight pattern (Confidence: {score_norm}%)'
                })
    return ai_alerts

def check_auth():
    auth = request.authorization
    client_ip = request.remote_addr
    if not auth:
        log_security_event("AUTH_MISSING", f"Unauthorized access attempt to {request.path}")
        abort(401, 'Invalid credentials')
    
    if not (auth.username == ADMIN_USER and auth.password == ADMIN_PASS):
        log_security_event("AUTH_FAILED", f"Failed login for user: {auth.username} on {request.path}")
        # Artificial delay to prevent brute-force
        time.sleep(1)
        abort(401, 'Invalid credentials')
    
    logger.info(f"AUTH_SUCCESS | User: {auth.username} | Path: {request.path} | IP: {client_ip}")

@app.route('/api/admin/train-ai', methods=['POST'])
def api_train_ai():
    check_auth()
    log_security_event("ADMIN_ACTION", "Triggered AI Retraining")
    thread = threading.Thread(target=train_ai_model)
    thread.start()
    return jsonify({"message": "Training started in background"})

@app.route('/api/records')
def api_records():
    # Public for now, can be restricted if needed
    icao24 = (request.args.get("icao24","") or "").strip().lower()
    begin = request.args.get("begin","")
    end = request.args.get("end","")
    if len(icao24)!=6 or any(ch not in "0123456789abcdef" for ch in icao24):
        return jsonify({"error":"icao24 must be 6-char hex"}),400
    if not begin.isdigit() or not end.isdigit() or int(begin)>=int(end):
        return jsonify({"error":"invalid begin/end"}),400
    url=f"{OPENSKY_BASE}/flights/aircraft?" + urlencode({"icao24":icao24,"begin":begin,"end":end})
    headers={"Accept":"application/json","User-Agent":"CyberAvia/1.0"}
    if OPENSKY_BEARER_TOKEN: headers["Authorization"]=f"Bearer {OPENSKY_BEARER_TOKEN}"
    req=Request(url,headers=headers,method="GET")
    try:
        with OPENER.open(req,timeout=OPEN_TIMEOUT_SEC) as resp:
            data=json.loads(resp.read().decode("utf-8",errors="ignore"))
        if not isinstance(data,list): data=[]
        return jsonify(data)
    except HTTPError as exc:
        return jsonify({"error":"opensky_http_error","status":exc.code,"message":str(exc.reason)}),exc.code
    except (URLError,TimeoutError,ValueError,OSError) as exc:
        return jsonify({"error":"opensky_unreachable","message":str(exc)}),502

@app.route('/api/alerts')
def api_alerts():
    # In a real security app, this would require auth
    # For demo, keeping it public but adding risk_score
    recent = Anomaly.query.order_by(Anomaly.detected_at.desc()).limit(200).all()
    result=[]
    for a in recent:
        result.append({
            "icao24": a.icao24,
            "type": a.type,
            "severity": a.severity,
            "risk_score": a.risk_score,
            "details": a.details,
            "detected_at": a.detected_at
        })
    return jsonify(result)

@app.route('/api/stats')
def api_stats():
    by_type = db.session.query(Anomaly.type, func.count()).group_by(Anomaly.type).all()
    return jsonify({"by_type": by_type})

# --- GLOBAL INIT (For Gunicorn) ---
with app.app_context():
    db.create_all()

# --- REAL-TIME STREAMING THREAD ---
streamer_started = False
streamer_lock = threading.Lock()

def telemetry_streamer():
    """Background task to fetch and broadcast telemetry to all clients."""
    while True:
        try:
            payload = get_live_data_parallel({"lamin":-90, "lamax":90, "lomin":-180, "lomax":180})
            if payload and "states" in payload:
                socketio.emit('plane_update', payload)
        except Exception as e:
            logger.error(f"Streamer Error: {e}")
        gevent.sleep(10) # Using gevent.sleep

@socketio.on('connect')
def handle_connect():
    global streamer_started
    if not streamer_started:
        socketio.start_background_task(telemetry_streamer)
        streamer_started = True
    
    logger.info("Intel client connected via Secure-Socket.")
    emit('system_log', {'msg': 'Real-time telemetry link established.'})

# --- RUNTIME ---
if __name__ == '__main__':
    logger.info(f"Cyber-AVIA Manual Start on port {PORT}.")
    socketio.run(app, host=HOST, port=PORT, debug=DEBUG_MODE)
