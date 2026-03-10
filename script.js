let map, planeGroup;
let updateInterval;

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  console.log("DOM Ready. Starting Systems...");
  try {
    initApp();
  } catch (e) {
    console.error("Critical Startup Error:", e);
  }
});

function initApp() {
  // Start clock immediately - this MUST run
  startClock();

  // Try to init map
  try {
    initMap();
  } catch (e) {
    console.error("Map initialization failed. Telemetry will still run.", e);
  }

  // Start telemetry updates
  startUpdates();
}

function startClock() {
  const clock = document.getElementById("networkClock");
  if (clock) {
    setInterval(() => {
      clock.innerText = new Date().toLocaleTimeString();
    }, 1000);
  }
}

function initMap() {
  if (typeof L === 'undefined') {
    throw new Error("Leaflet Library (L) not loaded. Check CSP or Internet connection.");
  }

  if (map) return;

  const mapEl = document.getElementById("map");
  if (!mapEl) return;

  map = L.map("map", {
    zoomControl: false,
    attributionControl: false,
    worldCopyJump: true
  }).setView([48.85, 2.35], 5);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(map);

  // Apply dark mode theme
  setTimeout(() => {
    const container = document.querySelector('.leaflet-container');
    if (container) {
      container.style.filter = "invert(100%) hue-rotate(180deg) brightness(95%) contrast(90%)";
    }
  }, 500);

  planeGroup = L.layerGroup().addTo(map);
}

function startUpdates() {
  updateStatus();
  updateInterval = setInterval(updateStatus, 15000);
}

async function updateStatus() {
  console.log("Fetching live telemetry...");
  try {
    const res = await fetch("/api/live");
    if (!res.ok) {
      console.warn("API returned status:", res.status);
      return;
    }

    const data = await res.json();
    if (data && data.states) {
      const count = data.states.length;
      document.getElementById("livePulse").innerText = count;
      if (map) renderPlanes(data.states);
    }

    // Update Alerts
    const alertRes = await fetch("/api/alerts");
    if (alertRes.ok) {
      const alerts = await alertRes.json();
      document.getElementById("anomalyCount").innerText = alerts.length;
      renderAlerts(alerts);
    }
  } catch (e) {
    console.warn("Retrying telemetry connection...");
  }
}

function renderPlanes(states) {
  if (!planeGroup) return;
  planeGroup.clearLayers();

  states.slice(0, 150).forEach(s => {
    const [icao, call, country, , , lon, lat, , , vel, trk] = s;
    if (lat && lon) {
      const angle = (trk || 0) - 45;
      const html = `<div class="plane-marker" style="transform: rotate(${angle}deg); color: #22d3ee; filter: drop-shadow(0 0 8px rgba(34, 211, 238, 0.8)); cursor: pointer;">✈</div>`;
      const icon = L.divIcon({ html: html, className: 'plane-icon-div', iconSize: [24, 24] });

      const marker = L.marker([lat, lon], { icon: icon });
      marker.bindPopup(`
        <div style="color: #000; min-width: 120px;">
          <b style="color: #0891b2; font-size: 1rem;">${(call || 'UNKNOWN').trim()}</b><br>
          <div style="margin-top: 5px; border-top: 1px solid #eee; padding-top: 5px; font-size: 0.8rem;">
            HEX: ${icao.toUpperCase()}<br>
            SPEED: ${Math.round(vel * 3.6)} km/h<br>
            ORIGIN: ${country || 'N/A'}
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
    container.innerHTML = '<div style="color: #475569; font-style: italic; padding: 10px;">Scanning for threats...</div>';
    return;
  }

  container.innerHTML = alerts.slice(0, 15).map(a => `
    <div style="border-left: 3px solid ${a.severity === 'high' ? '#f43f5e' : '#f59e0b'}; background: rgba(0,0,0,0.4); padding: 10px; margin-bottom: 10px; border-radius: 0 8px 8px 0; border: 1px solid rgba(255,255,255,0.05);">
      <div style="color: #f1f5f9; font-weight: bold; font-size: 0.8rem;">${a.type.replace('_', ' ').toUpperCase()}</div>
      <div style="font-size: 0.7rem; color: #94a3b8; margin-top: 4px;">TARGET: ${a.icao24.toUpperCase()} • RISK: ${a.risk_score}%</div>
    </div>
  `).join("");
}

async function searchICAO() {
  const icao = document.getElementById("icaoInput").value.trim().toLowerCase();
  if (icao.length !== 6) return;
  // Highlight on map if exists or fetch
  console.log("Focusing on target:", icao);
}
