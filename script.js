let map, planeGroup;
let updateInterval;

function initApp() {
  console.log("Cyber-AVIA System Initializing...");
  initMap();
  startUpdates();
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
    const [icao, , , , , lon, lat, , , vel, trk] = s;
    const call = s[1];
    if (lat && lon) {
      const angle = trk || 0;
      const html = `<div class="plane-marker" style="transform: rotate(${angle - 45}deg); cursor: pointer; color: #22d3ee; filter: drop-shadow(0 0 8px rgba(34, 211, 238, 0.8));">✈</div>`;
      const icon = L.divIcon({ html: html, className: 'plane-icon-div', iconSize: [24, 24] });

      const marker = L.marker([lat, lon], { icon: icon });
      marker.bindPopup(`
        <div style="color: #000; font-family: sans-serif; padding: 5px;">
          <b style="color: #0891b2; font-size: 1rem;">${call || 'AERIAL TARGET'}</b><br>
          <div style="margin-top: 5px; border-top: 1px solid #eee; padding-top: 5px;">
            <small>ICAO: ${icao.toUpperCase()}</small><br>
            <small>Velocity: ${Math.round(vel * 3.6)} km/h</small>
          </div>
        </div>
      `);
      marker.addTo(planeGroup);
    }
  });
}

function renderAlerts(alerts) {
  const container = document.getElementById("alertList");
  if (!container) return;

  if (!alerts || alerts.length === 0) {
    container.innerHTML = '<div style="color: #475569; font-style: italic; padding: 10px;">Monitoring airspace for signals...</div>';
    return;
  }

  container.innerHTML = alerts.slice(0, 15).map(a => `
    <div style="border-left: 3px solid ${a.severity === 'high' ? '#f43f5e' : '#f59e0b'}; background: rgba(0,0,0,0.4); padding: 10px; margin-bottom: 10px; border-radius: 0 8px 8px 0; border: 1px solid rgba(255,255,255,0.05); border-left-width: 3px;">
      <div style="color: #f1f5f9; font-weight: bold; font-size: 0.8rem; letter-spacing: 0.5px;">${a.type.replace('_', ' ').toUpperCase()}</div>
      <div style="font-size: 0.7rem; color: #94a3b8; margin-top: 4px;">HEX: ${a.icao24.toUpperCase()} • RISK: ${a.risk_score}%</div>
    </div>
  `).join("");
}

async function searchICAO() {
  const icao = document.getElementById("icaoInput").value.trim();
  if (icao.length !== 6) {
    alert("Please enter a valid 6-char ICAO HEX code.");
    return;
  }
  // Implement search logic or show history
  const detailsCard = document.getElementById("detailsCard");
  const detailsContent = document.getElementById("detailsContent");
  detailsCard.style.display = "block";
  detailsContent.innerHTML = "Fetching historical flight path for target " + icao.toUpperCase() + "...";
}
