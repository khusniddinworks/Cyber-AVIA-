let map, planeGroup, socket;
let updateInterval;
const planeMarkers = new Map(); // Track markers by ICAO
const planePaths = new Map();   // Track polylines by ICAO
const planeHistory = new Map(); // Track coordinates history

// ---- STARTUP ----
document.addEventListener("DOMContentLoaded", () => {
  startClock();
  try { initMap(); } catch (e) { addLog("error", "Map subsystem failure: " + e.message); }
  startUpdates();
  addLog("system", "Cyber-AVIA Intelligence Core engaged.");
});

function startClock() {
  const el = document.getElementById("networkClock");
  if (el) setInterval(() => { el.innerText = new Date().toLocaleTimeString(); }, 1000);
}

// ---- MAP SETUP ----
function initMap() {
  if (typeof L === 'undefined') return;
  map = L.map("map", { zoomControl: false, attributionControl: false, worldCopyJump: true }).setView([20, 0], 3);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { subdomains: 'abcd', maxZoom: 19 }).addTo(map);

  planeGroup = L.markerClusterGroup({
    maxClusterRadius: 50,
    disableClusteringAtZoom: 9,
    chunkedLoading: true,
    iconCreateFunction: (cluster) => {
      const count = cluster.getChildCount();
      let r = count > 100 ? 50 : count > 30 ? 40 : 32;
      return L.divIcon({
        html: `<div style="width:${r}px; height:${r}px; background:rgba(34,211,238,0.15); border:2px solid var(--brand); border-radius:50%; display:flex; align-items:center; justify-content:center; color:var(--brand); font-weight:800; font-family:'JetBrains Mono'; box-shadow:0 0 15px var(--brand-glow);">${count}</div>`,
        className: 'cyber-cluster', iconSize: [r, r]
      });
    }
  });
  map.addLayer(planeGroup);
}

// ---- WebSocket ENGINE ----
function startUpdates() {
  socket = io();

  socket.on('connect', () => {
    addLog("info", "Secure-Socket link established.");
  });

  socket.on('plane_update', (data) => {
    if (data && data.states) {
      processTelemetry(data);
    }
  });

  socket.on('system_log', (data) => {
    addLog("system", data.msg);
  });

  socket.on('disconnect', () => {
    addLog("error", "Socket link severed. Attempting rejoin...");
  });
}

// updateStatus kept only as one-time initialization if needed
async function updateStatus() {
  try {
    const res = await fetch("/api/live");
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (data && data.states) { processTelemetry(data); return; }
  } catch (e) { /* silent */ }

  // Multi-region Global Fetch (Client-side)
  try {
    const zones = [
      "https://api.adsb.lol/v2/lamin/35/lamax/65/lomin/-15/lomax/45",
      "https://api.adsb.lol/v2/lamin/10/lamax/55/lomin/-130/lomax/-60",
      "https://api.adsb.lol/v2/lamin/10/lamax/50/lomin/45/lomax/100"
    ];
    const resSet = await Promise.allSettled(zones.map(u => fetch(u).then(r => r.json())));
    const all = new Map();
    resSet.forEach(r => {
      if (r.status === "fulfilled" && r.value.ac) r.value.ac.forEach(a => { if (a.hex) all.set(a.hex, a); });
    });
    const states = Array.from(all.values()).map(a => [a.hex, a.flight, a.r, 0, 0, a.lon, a.lat, a.alt_baro, 0, a.gs, a.track]);
    processTelemetry({ states, provider: `Global-Sat (${all.size} targets)` });
  } catch (e) { addLog("error", "Link saturated. Retrying..."); }
}

function processTelemetry(data) {
  document.getElementById("livePulse").innerText = data.states.length;
  renderPlanes(data.states);
  addLog("info", `Intelligence Feed: ${data.provider || 'Ready'}`);
  fetch("/api/alerts").then(r => r.json()).then(arr => {
    document.getElementById("anomalyCount").innerText = arr.length;
    renderAlerts(arr);
  }).catch(() => { });
}

// ---- RENDER ENGINE ----
function renderPlanes(states) {
  const currentICAOs = new Set();
  const newMarkers = [];

  states.slice(0, 1200).forEach(s => {
    const [icao, call, country, , , lon, lat, alt, , vel, trk] = s;
    if (!lat || !lon || !icao) return;
    const key = icao.toLowerCase().trim();
    currentICAOs.add(key);

    // Update History for Trajectory
    if (!planeHistory.has(key)) planeHistory.set(key, []);
    const history = planeHistory.get(key);
    history.push([lat, lon]);
    if (history.length > 8) history.shift();

    const color = (vel > 300) ? "var(--danger)" : "var(--brand)";
    const iconHtml = `<div class="plane-marker" style="transform:rotate(${(trk || 0) - 45}deg); color:${color}; filter:drop-shadow(0 0 5px ${color});">✈</div>`;
    const icon = L.divIcon({ html: iconHtml, className: 'plane-icon-div', iconSize: [22, 22] });

    const popupContent = `<div style="min-width:150px; font-family:'Inter';"><b style="color:var(--brand); font-size:1.1rem;">${(call || 'UNTITLED')}</b><hr style="margin:5px 0; border:0; border-top:1px solid #333;">ICAO: ${key.toUpperCase()}<br>SPD: ${Math.round(vel * 3.6 || 0)} km/h<br>ALT: ${alt || 0} ft</div>`;

    if (planeMarkers.has(key)) {
      const m = planeMarkers.get(key);
      m.setLatLng([lat, lon]);
      m.setIcon(icon);
      m.setPopupContent(popupContent);
    } else {
      const m = L.marker([lat, lon], { icon }).bindPopup(popupContent);
      newMarkers.push(m);
      planeMarkers.set(key, m);
    }

    // Draw/Update Trajectory
    if (history.length > 1) {
      if (planePaths.has(key)) {
        planePaths.get(key).setLatLngs(history);
      } else {
        const path = L.polyline(history, { color: color, weight: 1.5, opacity: 0.4, dashArray: '4, 4' }).addTo(map);
        planePaths.set(key, path);
      }
    }
  });

  // Cleanup
  for (const [k, m] of planeMarkers) {
    if (!currentICAOs.has(k)) {
      planeGroup.removeLayer(m);
      if (planePaths.has(k)) { map.removeLayer(planePaths.get(k)); planePaths.delete(k); }
      planeMarkers.delete(k);
      planeHistory.delete(k);
    }
  }
  if (newMarkers.length > 0) planeGroup.addLayers(newMarkers);
}

// ---- INTERFACE ----
function searchICAO() {
  const val = document.getElementById("icaoInput").value.trim().toLowerCase();
  if (planeMarkers.has(val)) {
    const m = planeMarkers.get(val);
    map.setView(m.getLatLng(), 11);
    m.openPopup();
    addLog("info", `Target ${val.toUpperCase()} locked and tracked.`);
  } else {
    addLog("warn", "Target out of sensor range.");
  }
}

function renderAlerts(alerts) {
  const el = document.getElementById("alertList");
  if (!el) return;
  el.innerHTML = alerts.length ? alerts.slice(0, 15).map(a => `<div class="alert-item ${a.severity}"><div class="alert-type">${a.type.toUpperCase()}</div><div class="alert-meta">${a.icao24} · RISK ${a.risk_score}%</div></div>`).join("") : '<div class="log-line system">Sensors clean.</div>';
}

function addLog(type, msg) {
  const el = document.getElementById("securityLogs");
  if (!el) return;
  const div = document.createElement("div");
  div.className = `log-line ${type}`;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.prepend(div);
  if (el.children.length > 40) el.removeChild(el.lastChild);
}
