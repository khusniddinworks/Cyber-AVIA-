let map, planeGroup;
let loggedIn = false;
let updateInterval;

function login() {
  const user = document.getElementById("adminUser").value;
  const pass = document.getElementById("adminPass").value;

  if (user && pass) {
    // Simple frontend logic, but backend still requires auth for API
    document.getElementById("authOverlay").style.display = "none";
    document.getElementById("dashboard").style.display = "grid";
    loggedIn = true;
    initMap();
    startUpdates();
  } else {
    document.getElementById("errorMsg").innerText = "INVALID CREDENTIALS";
  }
}

function initMap() {
  map = L.map("map", {
    zoomControl: false,
    attributionControl: false,
    worldCopyJump: true
  }).setView([48.85, 2.35], 5); // Start at Paris (Busy traffic)

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    className: 'map-tiles'
  }).addTo(map);

  // Apply dark mode filter to OSM
  document.querySelector('.leaflet-container').style.filter = "invert(100%) hue-rotate(180deg) brightness(95%) contrast(90%)";

  planeGroup = L.layerGroup().addTo(map);
}

function startUpdates() {
  updateStatus();
  updateInterval = setInterval(updateStatus, 15000);
  setInterval(() => {
    document.getElementById("networkClock").innerText = new Date().toLocaleTimeString();
  }, 1000);
}

async function updateStatus() {
  try {
    const res = await fetch("/api/live");
    const data = await res.json();
    if (data.states) {
      document.getElementById("livePulse").innerText = data.states.length;
      renderPlanes(data.states);
    }

    // Update Alerts
    const alertRes = await fetch("/api/alerts");
    const alerts = await alertRes.json();
    document.getElementById("anomalyCount").innerText = alerts.length;
    renderAlerts(alerts);
  } catch (e) {
    console.warn("Retrying connectivity...");
  }
}

function renderPlanes(states) {
  planeGroup.clearLayers();
  states.slice(0, 150).forEach(s => {
    const [icao, call, country, , , lon, lat, , isGnd, vel, trk] = s;
    if (lat && lon) {
      const html = `<div class="plane-marker" style="transform: rotate(${trk || 0}deg)">✈</div>`;
      const icon = L.divIcon({ html: html, className: 'plane-icon', iconSize: [24, 24] });
      L.marker([lat, lon], { icon: icon })
        .bindPopup(`<b>${call || 'No Call'}</b><br>ICAO: ${icao}<br>Speed: ${Math.round(vel * 3.6)} km/h`)
        .addTo(planeGroup);
    }
  });
}

function renderAlerts(alerts) {
  const container = document.getElementById("alertList");
  container.innerHTML = alerts.slice(0, 10).map(a => `
    <div style="border-left: 2px solid ${a.severity === 'high' ? 'red' : 'orange'}; padding-left: 10px; margin-bottom: 12px;">
      <div style="color: white; font-weight: bold;">${a.type.toUpperCase()}</div>
      <div style="font-size: 0.7rem; opacity: 0.7;">ICAO: ${a.icao24} | Risk: ${a.risk_score}%</div>
    </div>
  `).join("");
}

function logout() { location.reload(); }
