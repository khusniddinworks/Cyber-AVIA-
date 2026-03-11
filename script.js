let map, planeGroup;
let updateInterval;
const planeMarkers = new Map(); // Track planes by ICAO for smooth movement

// ---- STARTUP ----
document.addEventListener("DOMContentLoaded", () => {
  startClock();
  try { initMap(); } catch (e) { addLog("error", "Map subsystem failure: " + e.message); }
  startUpdates();
  addLog("system", "All subsystems initialized. Standby for telemetry.");
});

// ---- CLOCK ----
function startClock() {
  const el = document.getElementById("networkClock");
  if (!el) return;
  setInterval(() => { el.innerText = new Date().toLocaleTimeString(); }, 1000);
}

// ---- MAP (Professional Dark Tiles) ----
function initMap() {
  if (typeof L === 'undefined') throw new Error("Leaflet not loaded");
  if (map) return;

  map = L.map("map", {
    zoomControl: false,
    attributionControl: false,
    worldCopyJump: true
  }).setView([48.85, 2.35], 5);

  // CartoDB Dark Matter — proper dark map (no CSS filter hack)
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    subdomains: 'abcd',
    maxZoom: 19
  }).addTo(map);

  // Marker clustering for thousands of planes
  planeGroup = L.markerClusterGroup({
    maxClusterRadius: 50,
    disableClusteringAtZoom: 8,
    spiderfyOnMaxZoom: false,
    showCoverageOnHover: false,
    chunkedLoading: true,
    iconCreateFunction: function (cluster) {
      const count = cluster.getChildCount();
      let radius = 30;
      if (count > 500) radius = 55;
      else if (count > 100) radius = 45;
      else if (count > 30) radius = 38;
      return L.divIcon({
        html: `<div style="
          width:${radius}px; height:${radius}px; 
          background: rgba(34,211,238,0.2); 
          border: 2px solid #22d3ee; 
          border-radius: 50%; 
          display:flex; align-items:center; justify-content:center;
          color:#22d3ee; font-weight:800; font-size:${Math.max(10, radius / 3)}px;
          font-family:'JetBrains Mono',monospace;
          box-shadow: 0 0 15px rgba(34,211,238,0.4);
        ">${count}</div>`,
        className: 'cyber-cluster',
        iconSize: L.point(radius, radius)
      });
    }
  });
  map.addLayer(planeGroup);
}

// ---- TELEMETRY ----
function startUpdates() {
  updateStatus();
  updateInterval = setInterval(updateStatus, 10000);
}

async function updateStatus() {
  addLog("system", "Synchronizing with ADS-B network...");

  try {
    const res = await fetch("/api/live");
    if (!res.ok) throw new Error(`Server ${res.status}`);
    const data = await res.json();
    if (data && data.states) {
      processTelemetry(data);
      return;
    }
    throw new Error("Empty payload");
  } catch (e) {
    addLog("warn", "Server uplink blocked \u2192 engaging direct satellite link...");
  }

  // Fallback: Multi-region parallel fetch for GLOBAL coverage
  try {
    const regions = [
      "https://api.adsb.lol/v2/lamin/35/lamax/65/lomin/-15/lomax/45",
      "https://api.adsb.lol/v2/lamin/10/lamax/55/lomin/-130/lomax/-60",
      "https://api.adsb.lol/v2/lamin/10/lamax/50/lomin/45/lomax/100",
      "https://api.adsb.lol/v2/lamin/10/lamax/55/lomin/100/lomax/150"
    ];
    const results = await Promise.allSettled(regions.map(u => fetch(u).then(r => r.json())));
    const all = new Map();
    for (const r of results) {
      if (r.status === "fulfilled" && r.value && r.value.ac) {
        for (const a of r.value.ac) {
          if (a.hex && a.lat && a.lon) all.set(a.hex, a);
        }
      }
    }
    if (all.size > 0) {
      const states = Array.from(all.values()).map(a => [
        a.hex, a.flight, a.r, 0, 0, a.lon, a.lat,
        a.alt_baro, a.alt_baro === "ground",
        typeof a.gs === 'number' ? a.gs * 0.514444 : 0, a.track
      ]);
      processTelemetry({ states, provider: `Global-Direct (${all.size} unique)` });
      return;
    }
  } catch (e) { /* silent */ }

  addLog("error", "All uplinks failed. Retrying in 15s...");
}

function processTelemetry(data) {
  const count = data.states.length;
  document.getElementById("livePulse").innerText = count;
  addLog("info", `Mapped ${count} aircraft via ${data.provider || 'primary'}`);
  if (map) renderPlanes(data.states);

  fetch("/api/alerts").then(r => r.json()).then(alerts => {
    document.getElementById("anomalyCount").innerText = alerts.length;
    renderAlerts(alerts);
  }).catch(() => { });
}

// ---- RENDER PLANES (Smooth Movement) ----
function renderPlanes(states) {
  if (!planeGroup) return;

  const currentICAOs = new Set();
  const newMarkers = [];

  states.slice(0, 1500).forEach(s => {
    const [icao, call, country, , , lon, lat, , , vel, trk] = s;
    if (!lat || !lon || !icao) return;

    const key = icao.toLowerCase();
    currentICAOs.add(key);

    const angle = (trk || 0) - 45;
    const speed = typeof vel === 'number' ? vel : 0;
    const color = speed > 300 ? "#f43f5e" : "#22d3ee";
    const html = `<div class="plane-marker" style="transform:rotate(${angle}deg); color:${color}; filter:drop-shadow(0 0 6px ${color}); cursor:pointer;">✈</div>`;
    const icon = L.divIcon({ html, className: 'plane-icon-div', iconSize: [22, 22] });

    const popupContent = `
      <div style="min-width:140px; font-family:'Inter',sans-serif;">
        <div style="font-weight:800; font-size:1.1rem; color:var(--brand); margin-bottom:6px;">${(call || 'UNKNOWN').trim()}</div>
        <div style="font-size:0.8rem; line-height:1.7; border-top:1px solid var(--border); padding-top:6px;">
          <b>HEX:</b> ${(icao || '').toUpperCase()}<br>
          <b>SPEED:</b> ${Math.round(speed * 3.6)} km/h<br>
          <b>ORIGIN:</b> ${country || 'N/A'}
        </div>
      </div>`;

    if (planeMarkers.has(key)) {
      // EXISTING plane: smoothly slide to new position
      const existing = planeMarkers.get(key);
      existing.setLatLng([lat, lon]);
      existing.setIcon(icon);
      existing.setPopupContent(popupContent);
    } else {
      // NEW plane: create marker
      const marker = L.marker([lat, lon], { icon });
      marker.bindPopup(popupContent);
      newMarkers.push(marker);
      planeMarkers.set(key, marker);
    }
  });

  // Remove planes that disappeared from radar
  for (const [key, marker] of planeMarkers) {
    if (!currentICAOs.has(key)) {
      planeGroup.removeLayer(marker);
      planeMarkers.delete(key);
    }
  }

  // Batch add only NEW markers
  if (newMarkers.length > 0) {
    planeGroup.addLayers(newMarkers);
  }
}

// ---- RENDER ALERTS ----
function renderAlerts(alerts) {
  const el = document.getElementById("alertList");
  if (!el) return;

  if (!alerts || alerts.length === 0) {
    el.innerHTML = '<div class="log-line system">Airspace clear. No threats detected.</div>';
    return;
  }

  el.innerHTML = alerts.slice(0, 20).map(a => `
    <div class="alert-item ${a.severity === 'high' ? 'high' : ''}">
      <div class="alert-type">${a.type.replace(/_/g, ' ').toUpperCase()}</div>
      <div class="alert-meta">${a.icao24.toUpperCase()} · RISK ${a.risk_score}%</div>
    </div>
  `).join("");
}

// ---- LOGGING ----
function addLog(type, msg) {
  const el = document.getElementById("securityLogs");
  if (!el) return;
  const time = new Date().toLocaleTimeString();
  const prefix = { system: "SYS", info: "OK ", warn: "⚠ ", error: "ERR" }[type] || "---";
  const div = document.createElement("div");
  div.className = `log-line ${type}`;
  div.textContent = `[${time}] ${prefix} ${msg}`;
  el.prepend(div);
  // Keep max 50 log entries
  while (el.children.length > 50) el.removeChild(el.lastChild);
}

// ---- LOOKUP ----
async function searchICAO() {
  const icao = document.getElementById("icaoInput").value.trim().toLowerCase();
  if (icao.length !== 6) {
    addLog("warn", "ICAO must be 6-character HEX code.");
    return;
  }
  addLog("system", `Searching for target ${icao.toUpperCase()}...`);
  document.getElementById("detailsCard").style.display = "block";
  document.getElementById("detailsContent").innerHTML = `<div class="log-line system">Fetching intel for ${icao.toUpperCase()}...</div>`;
}
