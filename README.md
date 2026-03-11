# 🛡️ Cyber-AVIA Intelligence Dashboard

A high-performance, military-grade aviation monitoring and cyber-security dashboard. Designed for real-time tracking, anomaly detection, and flight vector analysis.

![Cyber-AVIA Screenshot](https://raw.githubusercontent.com/khusniddinworks/Cyber-AVIA-/main/demo.png)

## 🚀 Key Features

- **🌐 Global Hybrid Telemetry**: Synchronized data from OpenSky Network, ADSB.lol, and multi-zone satellite links.
- **⚡ Smooth Vector Tracking**: Real-time position interpolation and historical trajectory (breadthcrumbs) visualization.
- **🕵️ Cyber-Anomaly Engine**: Detects identity spoofing (duplicate ICAO), altitude tampering, and illegal supersonic vectors.
- **💎 Premium Aesthetics**: Advanced glassmorphism UI with professional CartoDB dark-matter mapping.
- **📦 Containerized (Docker)**: Production-ready with Docker, Gunicorn, and built-in health monitoring.
- **🧪 100% Test Coverage**: 19 automated tests covering security headers, API endpoints, and detection logic.

## 🛠️ Tech Stack

- **Backend**: Python, Flask, SQLAlchemy, Flask-Limiter, Scikit-learn (AI).
- **Frontend**: Vanilla JavaScript (ES6+), Leaflet, MarkerCluster, CSS Grid (Glassmorphism).
- **Deployment**: Docker, Gunicorn, GitHub Actions.

## 📦 Getting Started (Local)

1. Clone the repository: `git clone ...`
2. Install dependencies: `pip install -r requirements.txt`
3. Configure `.env` using `.env.example`.
4. Run the app: `python app.py`

## 🐳 Docker Deployment

To build and run the production image:
```bash
docker build -t cyber-avia .
docker run -p 8080:8080 cyber-avia
```

## 🛡️ Security Implementation

- **Strict CSP**: Content-Security-Policy hardened for modern browsers.
- **Rate Limiting**: Integrated DDoS protection using Flask-Limiter.
- **Encryption**: AES-encrypted sensitive flight signals (Callsigns) in the database.
- **CORS**: Secure Cross-Origin Resource Sharing protocols.

---
**Developed by Khusniddin (Aviation Cybersecurity Analyst)**
