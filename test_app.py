"""
Cyber-AVIA Security Dashboard — Test Suite
Covers: API endpoints, anomaly detection, security headers, and data integrity.
"""
import os
import json
import pytest
import time

# Set test environment BEFORE importing app
os.environ["ADMIN_USER"] = "testadmin"
os.environ["ADMIN_PASS"] = "TestPass123!"
os.environ["SECRET_KEY"] = "test-secret-key-for-testing-only"
os.environ["ENCRYPTION_KEY"] = "dGVzdC1lbmNyeXB0aW9uLWtleS0xMjM0NTY3OA=="
os.environ["DATABASE_URL"] = "sqlite:///:memory:"

from app import app, db, Flight, Anomaly, detect_anomalies, calculate_distance
from cryptography.fernet import Fernet


@pytest.fixture
def client():
    """Create a test client with in-memory database."""
    app.config['TESTING'] = True
    app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///:memory:'
    
    with app.test_client() as client:
        with app.app_context():
            db.create_all()
        yield client
        with app.app_context():
            db.drop_all()


# ============================================
# 1. ENDPOINT TESTS
# ============================================

class TestEndpoints:
    """Test all API endpoints return correct status codes."""
    
    def test_index_returns_html(self, client):
        """Homepage should return 200."""
        res = client.get('/')
        assert res.status_code == 200
    
    def test_health_check(self, client):
        """Health endpoint must return healthy status."""
        res = client.get('/health')
        assert res.status_code == 200
        data = json.loads(res.data)
        assert data["status"] == "healthy"
        assert "timestamp" in data

    def test_alerts_endpoint(self, client):
        """Alerts API should return empty list initially."""
        res = client.get('/api/alerts')
        assert res.status_code == 200
        data = json.loads(res.data)
        assert isinstance(data, list)
        assert len(data) == 0

    def test_stats_endpoint(self, client):
        """Stats API should return valid JSON."""
        res = client.get('/api/stats')
        assert res.status_code == 200
        data = json.loads(res.data)
        assert "by_type" in data

    def test_records_bad_icao(self, client):
        """Records API should reject invalid ICAO."""
        res = client.get('/api/records?icao24=ZZZZZZ&begin=1000&end=2000')
        assert res.status_code == 400

    def test_records_missing_params(self, client):
        """Records API should reject missing parameters."""
        res = client.get('/api/records')
        assert res.status_code == 400


# ============================================
# 2. SECURITY TESTS
# ============================================

class TestSecurity:
    """Verify security headers and auth mechanisms."""
    
    def test_security_headers_present(self, client):
        """All critical security headers must be set."""
        res = client.get('/')
        assert res.headers.get('X-Content-Type-Options') == 'nosniff'
        assert res.headers.get('X-Frame-Options') == 'DENY'
        assert 'Content-Security-Policy' in res.headers
        assert 'Strict-Transport-Security' in res.headers

    def test_csp_blocks_unsafe_sources(self, client):
        """CSP should restrict default-src to self."""
        res = client.get('/')
        csp = res.headers.get('Content-Security-Policy', '')
        assert "default-src 'self'" in csp
        assert "frame-ancestors 'none'" in csp

    def test_admin_requires_auth(self, client):
        """Admin endpoints must require authentication."""
        res = client.post('/api/admin/train-ai')
        assert res.status_code == 401

    def test_admin_rejects_wrong_password(self, client):
        """Admin should reject invalid credentials."""
        import base64
        creds = base64.b64encode(b"wrong:wrong").decode()
        res = client.post('/api/admin/train-ai', headers={"Authorization": f"Basic {creds}"})
        assert res.status_code == 401

    def test_admin_accepts_correct_password(self, client):
        """Admin should accept valid credentials."""
        import base64
        creds = base64.b64encode(b"testadmin:TestPass123!").decode()
        res = client.post('/api/admin/train-ai', headers={"Authorization": f"Basic {creds}"})
        assert res.status_code == 200


# ============================================
# 3. ANOMALY DETECTION TESTS
# ============================================

class TestAnomalyDetection:
    """Verify the cyber-security anomaly detection engine."""

    def test_high_speed_detection(self, client):
        """Aircraft exceeding 1200 km/h should trigger alert."""
        with app.app_context():
            flights = [{'icao24': 'abc123', 'velocity': 400, 'lat': 50.0, 'lon': 10.0, 'altitude': 10000, 'track': 90, 'onGround': False, 'callsign': 'TEST01', 'country': 'Test'}]
            anomalies = detect_anomalies(flights, time.time())
            types = [a['type'] for a in anomalies]
            assert 'high_speed' in types

    def test_duplicate_icao_detection(self, client):
        """Duplicate ICAO signals should be flagged as ghost aircraft."""
        with app.app_context():
            flights = [
                {'icao24': 'abc123', 'velocity': 100, 'lat': 50.0, 'lon': 10.0, 'altitude': 10000, 'track': 90, 'onGround': False, 'callsign': 'TEST01', 'country': 'Test'},
                {'icao24': 'abc123', 'velocity': 120, 'lat': 51.0, 'lon': 11.0, 'altitude': 11000, 'track': 95, 'onGround': False, 'callsign': 'TEST02', 'country': 'Test'}
            ]
            anomalies = detect_anomalies(flights, time.time())
            types = [a['type'] for a in anomalies]
            assert 'duplicate_icao' in types

    def test_normal_flight_no_alert(self, client):
        """Normal flight parameters should not trigger any alerts."""
        with app.app_context():
            flights = [{'icao24': 'def456', 'velocity': 200, 'lat': 48.0, 'lon': 2.0, 'altitude': 10000, 'track': 180, 'onGround': False, 'callsign': 'NORM01', 'country': 'France'}]
            anomalies = detect_anomalies(flights, time.time())
            # Filter out signal_loss (which may appear from DB)
            real_anomalies = [a for a in anomalies if a['type'] in ('high_speed', 'duplicate_icao', 'location_jump')]
            assert len(real_anomalies) == 0


# ============================================
# 4. UTILITY TESTS
# ============================================

class TestUtilities:
    """Test mathematical and helper functions."""

    def test_haversine_distance(self):
        """Distance between Paris and London should be ~340 km."""
        dist = calculate_distance(48.8566, 2.3522, 51.5074, -0.1278)
        assert 330 < dist < 360

    def test_haversine_same_point(self):
        """Distance from a point to itself should be 0."""
        dist = calculate_distance(40.0, 30.0, 40.0, 30.0)
        assert dist == 0.0


# ============================================
# 5. DATA MODEL TESTS
# ============================================

class TestDataModels:
    """Test database models and encryption."""
    
    def test_flight_creation(self, client):
        """Flight records should be storable in DB."""
        with app.app_context():
            f = Flight(icao24='abc123', country='Turkey', lat=41.0, lon=28.9, altitude=10000, velocity=250, track=45, on_ground=False, timestamp=time.time())
            f.callsign = 'THY123'
            db.session.add(f)
            db.session.commit()
            
            result = Flight.query.first()
            assert result.icao24 == 'abc123'
            assert result.callsign == 'THY123'  # Should decrypt correctly
    
    def test_callsign_encryption(self, client):
        """Callsign should be encrypted in DB, decrypted on read."""
        with app.app_context():
            f = Flight(icao24='enc001', country='Test', lat=50.0, lon=10.0, altitude=5000, velocity=150, track=90, on_ground=False, timestamp=time.time())
            f.callsign = 'SECRET_FLIGHT'
            db.session.add(f)
            db.session.commit()
            
            result = Flight.query.filter_by(icao24='enc001').first()
            # Encrypted value should NOT be plaintext
            assert result.callsign_enc != 'SECRET_FLIGHT'
            # Decrypted value should match
            assert result.callsign == 'SECRET_FLIGHT'

    def test_anomaly_creation(self, client):
        """Anomaly records should be storable and retrievable."""
        with app.app_context():
            a = Anomaly(icao24='bad001', type='high_speed', severity='high', risk_score=90, details='Test anomaly', detected_at=time.time())
            db.session.add(a)
            db.session.commit()
            
            result = Anomaly.query.first()
            assert result.type == 'high_speed'
            assert result.risk_score == 90
