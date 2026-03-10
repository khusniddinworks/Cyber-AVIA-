import os
import time
import math
import json
import base64
import logging
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import ProxyHandler, Request, build_opener

from flask import Flask, request, jsonify, send_from_directory, abort, make_response
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import func
from sklearn.ensemble import IsolationForest
import numpy as np
import threading
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

# --- SECURITY MIDDLEWARE (Expert Level) ---
@app.after_request
def apply_security_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['X-XSS-Protection'] = '1; mode=block'
    
    # Modernized CSP
    csp = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net; "
        "img-src 'self' data: https://*.tile.openstreetmap.org https://unpkg.com https://server.arcgisonline.com; "
        "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com; "
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

def try_opensky_live(url):
    headers = {"Accept": "application/json", "User-Agent": "CyberAvia/1.0"}
    if OPENSKY_BEARER_TOKEN:
        headers["Authorization"] = f"Bearer {OPENSKY_BEARER_TOKEN}"
    elif OPENSKY_USER and OPENSKY_PASS:
        # Basic Auth for OpenSky
        auth_str = f"{OPENSKY_USER}:{OPENSKY_PASS}"
        encoded_auth = base64.b64encode(auth_str.encode()).decode()
        headers["Authorization"] = f"Basic {encoded_auth}"
        
    req = Request(url, headers=headers, method="GET")
    try:
        with OPENER.open(req, timeout=OPEN_TIMEOUT_SEC) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="ignore"))
        states = data.get("states") if isinstance(data, dict) else None
        if isinstance(states, list):
            return {"provider": "opensky", "states": states}
        return None
    except (HTTPError, URLError, TimeoutError, OSError) as e:
        print(f"OpenSky error: {e}")
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
    req = Request(url, headers={"Accept": "application/json", "User-Agent": "CyberAvia/1.0"}, method="GET")
    try:
        with OPENER.open(req, timeout=OPEN_TIMEOUT_SEC) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="ignore"))
    except (HTTPError, URLError, TimeoutError, OSError):
        return None

    ac = data.get("ac") if isinstance(data, dict) else None
    if not isinstance(ac, list):
        return None
    return ac

def detect_anomalies(flights, timestamp):
    anomalies = []
    seen_icao = set()
    for f in flights:
        icao = f.get('icao24','').lower()
        speed_kmh = (f.get('velocity') or 0) * 3.6
        
        # 1. High Speed
        if speed_kmh > 1200:
            anomalies.append({
                'icao24': icao, 'type': 'high_speed', 'severity': 'high', 'risk_score': 90,
                'details': f'Impossible speed: {speed_kmh:.0f} km/h'
            })
        
        # 2. Duplicate ICAO
        if icao in seen_icao:
            anomalies.append({
                'icao24': icao, 'type': 'duplicate_icao', 'severity': 'high', 'risk_score': 95,
                'details': 'Ghost aircraft: duplicate ICAO signal'
            })
        seen_icao.add(icao)

        # 3. Sudden Location Jump
        last_f = Flight.query.filter_by(icao24=icao).order_by(Flight.timestamp.desc()).first()
        if last_f and last_f.lat and last_f.lon and f['lat'] and f['lon']:
            dist = calculate_distance(last_f.lat, last_f.lon, f['lat'], f['lon'])
            dt = timestamp - last_f.timestamp
            if dt > 0:
                calc_speed = (dist / dt) * 3600 # km/h
                if calc_speed > 1500 and dist > 50: # Jump more than 50km at insane speed
                    anomalies.append({
                        'icao24': icao, 'type': 'location_jump', 'severity': 'high', 'risk_score': 85,
                        'details': f'Sudden jump: {dist:.1f} km in {dt:.0f}s'
                    })

    # 4. Signal Disappearance
    # (Checking for flights that were present in the last 5 mins but missing now)
    five_min_ago = timestamp - 300
    missing_flights = db.session.query(Flight.icao24).filter(Flight.timestamp > five_min_ago, Flight.timestamp < timestamp - 60).distinct().all()
    current_icaos = {f['icao24'].lower() for f in flights}
    for (m_icao,) in missing_flights:
        if m_icao.lower() not in current_icaos:
            # Check if we already alerted for this recently
            exists = Anomaly.query.filter_by(icao24=m_icao, type='signal_loss').filter(Anomaly.detected_at > five_min_ago).first()
            if not exists:
                anomalies.append({
                    'icao24': m_icao, 'type': 'signal_loss', 'severity': 'medium', 'risk_score': 50,
                    'details': 'Signal lost for more than 60 seconds'
                })
    
    return anomalies

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.route('/api/live')
def api_live():
    qs = request.args
    params = {}
    for key in ("lamin","lamax","lomin","lomax"):
        if key in qs:
            params[key] = qs.get(key)
    cache_key = urlencode(sorted(params.items()))
    now = time.time()
    cached = LIVE_CACHE.get(cache_key)
    if cached and now - cached[0] <= LIVE_CACHE_TTL_SEC:
        return jsonify(cached[1])
    opensky_url = f"{OPENSKY_BASE}/states/all"
    if params:
        opensky_url += "?" + urlencode(params)
    payload = try_opensky_live(opensky_url) or try_adsb_live(params)
    if payload is None:
        return jsonify({"error":"live_unavailable","message":"providers down"}),502
    LIVE_CACHE[cache_key] = (now, payload)
    flights = []
    for r in payload.get("states",[]):
        flights.append({
            'icao24': (r[0] or "").strip(),
            'callsign': (r[1] or "").strip(),
            'lon': r[5],'lat':r[6],'onGround':bool(r[8]),
            'velocity': r[9],'track':r[10],
            'altitude': r[13] or r[7],
            'country': r[2] or "Unknown"
        })
    for f in flights:
        rec = Flight(
            icao24=f['icao24'],country=f['country'],
            lon=f['lon'],lat=f['lat'],altitude=f['altitude'],
            velocity=f['velocity'],track=f['track'],on_ground=f['onGround'],
            timestamp=now
        )
        rec.callsign = f['callsign'] # This triggers the encrypted setter
        db.session.add(rec)
    db.session.commit()
    anomalies = detect_anomalies(flights, now)
    
    # Optional: AI Anomaly Detection
    try:
        ai_anomalies = detect_ai_anomalies(flights)
        anomalies.extend(ai_anomalies)
    except Exception as e:
        print(f"AI detection error: {e}")

    for a in anomalies:
        db.session.add(Anomaly(
            icao24=a['icao24'],
            type=a['type'],
            severity=a['severity'],
            risk_score=a.get('risk_score', 0),
            details=a['details'],
            detected_at=now
        ))
    if anomalies:
        db.session.commit()
    return jsonify(payload)

    return anomalies

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

# --- STARTUP LOGIC (PRODUCTION READY) ---
with app.app_context():
    db.create_all()
    # Initial AI training in background to avoid blocking
    threading.Thread(target=train_ai_model, daemon=True).start()

if __name__=="__main__":
    app.run(host=HOST, port=PORT, debug=DEBUG_MODE)
