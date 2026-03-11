let map, planeGroup;
let updateInterval;
const planeMarkers = new Map();
const planePaths = new Map();
const planeHistory = new Map();

// ---- STARTUP ----
document.addEventListener("DOMContentLoaded", () => {
  startClock();
  try { initMap(); } catch (e) { addLog("error", "Map init error: " + e.message); }
  addLog("system", "Cyber-AVIA v3.0 initializing...");
  updateStatus(); // First fetch immediately
  updateInterval = setInterval(updateStatus, 12000); // Then every 12s
});

function startClock() {
  const el = document.getElementById("networkClock");
  if (el) setInterval(() => { el.innerText = new Date().toLocaleTimeString(); }, 1000);
}

// ---- MAP ----
function initMap() {
  if (typeof L === 'undefined') throw new Error("Leaflet missing");
  map = L.map("map", { zoomControl: false, attributionControl: false, worldCopyJump: true }).setView([30, 20], 3);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { subdomains: 'abcd', maxZoom: 19 }).addTo(map);
  planeGroup = L.markerClusterGroup({
    maxClusterRadius: 45, disableClusteringAtZoom: 8, chunkedLoading: true,
    iconCreateFunction: (c) => {
      const n = c.getChildCount();
      const s = n > 100 ? 52 : n > 30 ? 42 : 34;
      return L.divIcon({
        html: `<div style="width:${s}px;height:${s}px;background:rgba(34,211,238,0.12);border:2px solid #22d3ee;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#22d3ee;font-weight:800;font-family:'JetBrains Mono';box-shadow:0 0 18px rgba(34,211,238,0.4);">${n}</div>`,
        className: 'cyber-cluster', iconSize: [s, s]
      });
    }
  });
  map.addLayer(planeGroup);
}

// ---- DATA FETCH ----
async function updateStatus() {
  // 1. Try our backend
  try {
    const res = await fetch("/api/live");
    if (res.ok) {
      const data = await res.json();
      if (data && data.states && data.states.length > 0) {
        addLog("info", `Backend Feed: ${data.provider || 'active'} (${data.states.length} targets)`);
        renderPlanes(data.states);
        document.getElementById("livePulse").innerText = data.states.length;
        fetchAlerts();
        return;
      }
    }
  } catch (e) { /* continue to fallback */ }

  // 2. Direct client-side ADSB fetch (correct lat/lon/dist format)
  addLog("system", "Direct-Link protocol engaged...");
  try {
    const zones = [
      "https://api.adsb.lol/v2/lat/48.0/lon/11.0/dist/500",
      "https://api.adsb.lol/v2/lat/40.0/lon/-100.0/dist/500",
      "https://api.adsb.lol/v2/lat/25.0/lon/55.0/dist/500",
      "https://api.adsb.lol/v2/lat/35.0/lon/105.0/dist/500",
      "https://api.adsb.lol/v2/lat/-25.0/lon/135.0/dist/500",
      "https://api.adsb.lol/v2/lat/5.0/lon/25.0/dist/500"
    ];
    const results = await Promise.allSettled(zones.map(u => fetch(u).then(r => r.json())));
    const all = new Map();
    results.forEach(r => {
      if (r.status === "fulfilled" && r.value && r.value.ac) {
        r.value.ac.forEach(a => { if (a.hex && a.lat && a.lon) all.set(a.hex, a); });
      }
    });
    if (all.size > 0) {
      const states = Array.from(all.values()).map(a => [
        a.hex, a.flight || "", a.r || "", 0, 0, a.lon, a.lat,
        typeof a.alt_baro === 'number' ? a.alt_baro : 0, 
        a.alt_baro === "ground", a.gs || 0, a.track || 0
      ]);
      addLog("info", `Global-Sat Feed (${states.length} targets)`);
      renderPlanes(states);
      document.getElementById("livePulse").innerText = states.length;
    } else {
      addLog("warn", "No aircraft data received from any source.");
    }
  } catch (e) { addLog("error", "All feeds offline."); }
}

function fetchAlerts() {
  fetch("/api/alerts").then(r => r.json()).then(arr => {
    document.getElementById("anomalyCount").innerText = arr.length;
    renderAlerts(arr);
  }).catch(() => {});
}

// ---- RENDER ----
function renderPlanes(states) {
  if (!planeGroup) return;
  const seen = new Set();
  const fresh = [];

  states.slice(0, 1500).forEach(s => {
    const [icao, call, country, , , lon, lat, alt, onGround, vel, trk] = s;
    if (!lat || !lon || !icao) return;
    const key = (icao + "").toLowerCase().trim();
    if (!key) return;
    seen.add(key);

    // History for trajectory
    if (!planeHistory.has(key)) planeHistory.set(key, []);
    const hist = planeHistory.get(key);
    const lastPt = hist.length > 0 ? hist[hist.length - 1] : null;
    if (!lastPt || Math.abs(lastPt[0] - lat) > 0.001 || Math.abs(lastPt[1] - lon) > 0.001) {
      hist.push([lat, lon]);
      if (hist.length > 10) hist.shift();
    }

    const speed = typeof vel === 'number' ? vel : 0;
    const color = speed > 300 ? "#f43f5e" : "#22d3ee";
    const angle = (trk || 0) - 45;
    const icon = L.divIcon({
      html: `<div style="transform:rotate(${angle}deg);color:${color};filter:drop-shadow(0 0 6px ${color});font-size:18px;cursor:pointer;">✈</div>`,
      className: 'plane-icon-div', iconSize: [22, 22]
    });

    const popup = `<div style="min-width:160px;font-family:'Inter',sans-serif;">
      <div style="font-weight:800;font-size:1.1rem;color:#22d3ee;margin-bottom:4px;">${(call||'').trim()||'UNKNOWN'}</div>
      <div style="font-size:0.78rem;line-height:1.7;border-top:1px solid #334155;padding-top:4px;">
        <b>HEX:</b> ${key.toUpperCase()}<br>
        <b>SPD:</b> ${Math.round(speed*3.6)} km/h<br>
        <b>ALT:</b> ${typeof alt === 'number' ? alt.toLocaleString() : alt} ft<br>
        <b>CTR:</b> ${country||'N/A'}
      </div></div>`;

    if (planeMarkers.has(key)) {
      const m = planeMarkers.get(key);
      m.setLatLng([lat, lon]);
      m.setIcon(icon);
      m.setPopupContent(popup);
    } else {
      const m = L.marker([lat, lon], { icon }).bindPopup(popup);
      fresh.push(m);
      planeMarkers.set(key, m);
    }

    // Trajectory
    if (hist.length > 1) {
      if (planePaths.has(key)) {
        planePaths.get(key).setLatLngs(hist);
      } else {
        planePaths.set(key, L.polyline(hist, { color, weight: 1.5, opacity: 0.35, dashArray: '4,4' }).addTo(map));
      }
    }
  });

  // Cleanup
  for (const [k, m] of planeMarkers) {
    if (!seen.has(k)) {
      planeGroup.removeLayer(m);
      if (planePaths.has(k)) { map.removeLayer(planePaths.get(k)); planePaths.delete(k); }
      planeMarkers.delete(k);
      planeHistory.delete(k);
    }
  }
  if (fresh.length) planeGroup.addLayers(fresh);
}

// ---- UI ----
function searchICAO() {
  const val = (document.getElementById("icaoInput").value || "").trim().toLowerCase();
  if (planeMarkers.has(val)) {
    map.setView(planeMarkers.get(val).getLatLng(), 11);
    planeMarkers.get(val).openPopup();
    addLog("info", `Target ${val.toUpperCase()} locked.`);
  } else {
    addLog("warn", `Target ${val.toUpperCase()} not in sensor range.`);
  }
}

function renderAlerts(alerts) {
  const el = document.getElementById("alertList");
  if (!el) return;
  el.innerHTML = alerts.length
    ? alerts.slice(0, 20).map(a =>
      `<div class="alert-item ${a.severity}"><div class="alert-type">${a.type}</div><div class="alert-meta">${a.icao24} · Risk ${a.risk_score}%</div></div>`
    ).join("")
    : '<div class="log-line system">Sensors clean. No threats.</div>';
}

function addLog(type, msg) {
  const el = document.getElementById("securityLogs");
  if (!el) return;
  const d = document.createElement("div");
  d.className = `log-line ${type}`;
  d.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.prepend(d);
  if (el.children.length > 50) el.removeChild(el.lastChild);
}
