let map, planeGroup;
let updateInterval;

function login() {
  const user = document.getElementById("adminUser").value.trim();
  const pass = document.getElementById("adminPass").value.trim();

  // Local validation for UI (Security is handled by Backend API)
  if (user && pass) {
    console.log("Authorization requested...");
    document.getElementById("authOverlay").style.transition = "opacity 0.5s";
    document.getElementById("authOverlay").style.opacity = "0";

    setTimeout(() => {
      document.getElementById("authOverlay").style.display = "none";
      document.getElementById("dashboard").style.display = "grid";

      // Initialize systems
      try {
        initMap();
      } catch (e) {
        console.error("Map system failure, continuing with telemetry only:", e);
      }
      startUpdates();
    }, 500);
  } else {
    document.getElementById("errorMsg").innerText = "CREDENTIALS REQUIRED";
  }
}

function initMap() {
  if (map) return;

  map = L.map("map", {
    zoomControl: false,
    attributionControl: false,
    worldCopyJump: true
  }).setView([48.85, 2.35], 5); // Focus on Europe

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(map);

  // Apply dark mode theme safely
  setTimeout(() => {
    const container = document.querySelector('.leaflet-container');
    if (container) {
      container.style.filter = "invert(100%) hue-rotate(180deg) brightness(95%) contrast(90%)";
    }
  }, 100);

  planeGroup = L.layerGroup().addTo(map);
}

function startUpdates() {
  updateStatus();
  updateInterval = setInterval(updateStatus, 15000);

  // Real-time clock logic
  setInterval(() => {
    const clock = document.getElementById("networkClock");
    if (clock) clock.innerText = new Date().toLocaleTimeString();
  }, 1000);
}

async function updateStatus() {
  try {
    const res = await fetch("/api/live");
    if (!res.ok) throw new Error("API Failure");

    const data = await res.json();
    if (data.states) {
      document.getElementById("livePulse").innerText = data.states.length;
      renderPlanes(data.states);
    }

    // Anomaly Check
    const alertRes = await fetch("/api/alerts");
    const alerts = await alertRes.json();
    document.getElementById("anomalyCount").innerText = alerts.length;
    renderAlerts(alerts);
  } catch (e) {
    console.warn("Telemetry link intermittent, retrying...");
  }
}

function renderPlanes(states) {
  if (!planeGroup) return;
  planeGroup.clearLayers();

  states.slice(0, 150).forEach(s => {
    const [icao, call, country, , , lon, lat, , isGnd, vel, trk] = s;
    if (lat && lon) {
      const angle = trk || 0;
      const html = `<div class="plane-marker" style="transform: rotate(${angle}deg); cursor: pointer;">✈</div>`;
      const icon = L.divIcon({ html: html, className: 'plane-icon-div', iconSize: [24, 24] });

      const marker = L.marker([lat, lon], { icon: icon });
      marker.bindPopup(`
        <div style="color: #000; font-family: sans-serif;">
          <b style="color: #0891b2;">${call || 'N/A'}</b><br>
          <small>ICAO: ${icao.toUpperCase()}</small><br>
          <small>Speed: ${Math.round(vel * 3.6)} km/h</small>
        </div>
      `);
      marker.addTo(planeGroup);
    }
  });
}

function renderAlerts(alerts) {
  const container = document.getElementById("alertList");
  if (!container) return;

  if (alerts.length === 0) {
    container.innerHTML = '<div style="color: #475569; font-style: italic;">No active threats...</div>';
    return;
  }

  container.innerHTML = alerts.slice(0, 15).map(a => `
    <div style="border-left: 3px solid ${a.severity === 'high' ? '#f43f5e' : '#f59e0b'}; background: rgba(0,0,0,0.2); padding: 8px; margin-bottom: 10px; border-radius: 0 4px 4px 0;">
      <div style="color: #f1f5f9; font-weight: bold; font-size: 0.8rem;">${a.type.toUpperCase()}</div>
      <div style="font-size: 0.7rem; color: #94a3b8;">${a.icao24.toUpperCase()} • RISK: ${a.risk_score}%</div>
    </div>
  `).join("");
}

function logout() { location.reload(); }
