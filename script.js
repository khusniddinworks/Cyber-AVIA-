let map, planeGroup;
const planeMarkers = new Map();
const planePaths = new Map();
const planeHistory = new Map();

// ---- STARTUP ----
document.addEventListener("DOMContentLoaded", () => {
  startClock();
  initMap();
  addLog("system", "Cyber-AVIA Intelligence Core initializing...");
  loadPlanes(); // immediate first load
  setInterval(loadPlanes, 15000); // refresh every 15s
});

function startClock() {
  const el = document.getElementById("networkClock");
  if (el) setInterval(() => el.innerText = new Date().toLocaleTimeString(), 1000);
}

// ---- MAP ----
function initMap() {
  map = L.map("map", { zoomControl: false, attributionControl: false, worldCopyJump: true }).setView([35, 15], 3);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { subdomains: 'abcd', maxZoom: 19 }).addTo(map);

  planeGroup = L.markerClusterGroup({
    maxClusterRadius: 40,
    disableClusteringAtZoom: 8,
    chunkedLoading: true,
    iconCreateFunction: (c) => {
      const n = c.getChildCount();
      const s = n > 100 ? 52 : n > 30 ? 42 : 34;
      return L.divIcon({
        html: `<div style="width:${s}px;height:${s}px;background:rgba(34,211,238,0.15);border:1.5px solid #22d3ee;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#22d3ee;font-weight:800;font-size:11px;box-shadow:0 0 14px rgba(34,211,238,0.5);">${n}</div>`,
        className: '', iconSize: [s, s]
      });
    }
  });
  map.addLayer(planeGroup);
}

// ---- DATA LOADING ----
async function loadPlanes() {
  addLog("system", "Scanning global airspace...");

  // Strategy 1: Try our own backend first
  try {
    const r = await fetch("/api/live", { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const data = await r.json();
      if (data && data.states && data.states.length > 0) {
        renderPlanes(data.states);
        addLog("info", `Backend: ${data.states.length} targets acquired`);
        refreshAlerts();
        return;
      }
    }
  } catch(e) {}

  // Strategy 2: OpenSky (public, no CORS issues, proven working)
  const regions = [
    // Europe
    { lamin: 35, lamax: 70, lomin: -10, lomax: 40 },
    // Middle East + Asia
    { lamin: 10, lamax: 50, lomin: 40, lomax: 100 },
    // Americas
    { lamin: 20, lamax: 65, lomin: -130, lomax: -60 },
    // East Asia + Pacific
    { lamin: -10, lamax: 50, lomin: 100, lomax: 180 },
  ];

  const collected = new Map();

  await Promise.allSettled(regions.map(async (reg) => {
    const url = `https://opensky-network.org/api/states/all?lamin=${reg.lamin}&lamax=${reg.lamax}&lomin=${reg.lomin}&lomax=${reg.lomax}`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) return;
      const d = await r.json();
      if (d && d.states) {
        d.states.forEach(s => { if (s[0] && s[5] && s[6]) collected.set(s[0], s); });
      }
    } catch(e) {}
  }));

  if (collected.size > 0) {
    const states = Array.from(collected.values());
    renderPlanes(states);
    addLog("info", `OpenSky: ${states.length} targets acquired`);
    refreshAlerts();
    return;
  }

  // Strategy 3: ADSB.lol fallback
  try {
    const adsbZones = [
      "https://api.adsb.lol/v2/lat/48/lon/11/dist/500",
      "https://api.adsb.lol/v2/lat/40/lon/-100/dist/500",
      "https://api.adsb.lol/v2/lat/25/lon/55/dist/500",
    ];
    const all = new Map();
    const results = await Promise.allSettled(adsbZones.map(u => fetch(u, { signal: AbortSignal.timeout(8000) }).then(r => r.json())));
    results.forEach(r => {
      if (r.status === "fulfilled" && r.value?.ac) {
        r.value.ac.forEach(a => { if (a.hex && a.lat && a.lon) all.set(a.hex, a); });
      }
    });
    if (all.size > 0) {
      const states = Array.from(all.values()).map(a => [a.hex, a.flight||"", a.r||"", 0, 0, a.lon, a.lat, typeof a.alt_baro === 'number' ? a.alt_baro : 0, a.alt_baro === "ground", a.gs||0, a.track||0]);
      renderPlanes(states);
      addLog("info", `ADSB Direct: ${states.length} targets acquired`);
      return;
    }
  } catch(e) {}

  addLog("warn", "All feeds temporarily offline. Retrying...");
}

// ---- RENDER ----
function renderPlanes(states) {
  const seen = new Set();
  const fresh = [];

  // Limit to 600 for performance, max variety
  const toRender = states.slice(0, 600);

  toRender.forEach(s => {
    const [icao, call, country,,,lon, lat, alt, onGround, vel, trk] = s;
    if (!lat || !lon || !icao) return;
    const key = String(icao).toLowerCase().trim();
    seen.add(key);

    // Trajectory history
    if (!planeHistory.has(key)) planeHistory.set(key, []);
    const hist = planeHistory.get(key);
    const last = hist[hist.length - 1];
    if (!last || Math.abs(last[0] - lat) > 0.005 || Math.abs(last[1] - lon) > 0.005) {
      hist.push([lat, lon]);
      if (hist.length > 8) hist.shift();
    }

    const spd = typeof vel === 'number' ? vel * 3.6 : 0;
    const altFt = typeof alt === 'number' ? Math.round(alt * 3.28084) : 0;
    const color = spd > 900 ? "#f43f5e" : spd > 500 ? "#f59e0b" : "#22d3ee";
    const deg = (trk || 0) - 45;

    const icon = L.divIcon({
      html: `<span style="display:block;transform:rotate(${deg}deg);color:${color};text-shadow:0 0 8px ${color};font-size:16px;line-height:1;">✈</span>`,
      className: '', iconSize: [18, 18], iconAnchor: [9, 9]
    });

    const popup = `
      <div style="font-family:'JetBrains Mono',monospace;min-width:170px;padding:2px;">
        <div style="font-size:1rem;font-weight:700;color:#22d3ee;border-bottom:1px solid #334155;padding-bottom:4px;margin-bottom:6px;">
          ${(String(call||'').trim()) || 'UNTAGGED'}
        </div>
        <div style="font-size:0.76rem;line-height:1.75;color:#cbd5e1;">
          🔷 HEX: <b>${key.toUpperCase()}</b><br>
          🌍 REG: ${country || 'N/A'}<br>
          🚀 SPD: <b>${Math.round(spd)} km/h</b><br>
          📡 ALT: <b>${altFt.toLocaleString()} ft</b><br>
          🛣 HDG: ${Math.round(trk || 0)}°
        </div>
      </div>`;

    if (planeMarkers.has(key)) {
      const m = planeMarkers.get(key);
      m.setLatLng([lat, lon]);
      m.setIcon(icon);
      m.setPopupContent(popup);
    } else {
      const m = L.marker([lat, lon], { icon }).bindPopup(popup, { maxWidth: 220 });
      fresh.push(m);
      planeMarkers.set(key, m);
    }

    // Trajectory polyline
    if (hist.length > 1) {
      if (planePaths.has(key)) {
        planePaths.get(key).setLatLngs(hist);
      } else {
        const path = L.polyline(hist, { color, weight: 1.5, opacity: 0.4, dashArray: '5,5' }).addTo(map);
        planePaths.set(key, path);
      }
    }
  });

  // Remove stale markers
  for (const [k, m] of planeMarkers) {
    if (!seen.has(k)) {
      planeGroup.removeLayer(m);
      if (planePaths.has(k)) { map.removeLayer(planePaths.get(k)); planePaths.delete(k); }
      planeMarkers.delete(k);
      planeHistory.delete(k);
    }
  }

  if (fresh.length) planeGroup.addLayers(fresh);
  document.getElementById("livePulse").innerText = planeMarkers.size;
}

// ---- ALERTS ----
function refreshAlerts() {
  fetch("/api/alerts").then(r => r.json()).then(arr => {
    document.getElementById("anomalyCount").innerText = arr.length;
    const el = document.getElementById("alertList");
    if (!el) return;
    el.innerHTML = arr.length
      ? arr.slice(0, 15).map(a =>
          `<div class="alert-item ${a.severity}">
            <div class="alert-type">${a.type}</div>
            <div class="alert-meta">${a.icao24} · Risk ${a.risk_score}%</div>
          </div>`).join("")
      : '<div class="log-line system">Sensors clean.</div>';
  }).catch(() => {});
}

// ---- ICAO SEARCH ----
function searchICAO() {
  const val = (document.getElementById("icaoInput")?.value || "").trim().toLowerCase();
  if (!val) return;
  if (planeMarkers.has(val)) {
    map.setView(planeMarkers.get(val).getLatLng(), 10);
    planeMarkers.get(val).openPopup();
    addLog("info", `▶ Target ${val.toUpperCase()} locked on radar.`);
  } else {
    addLog("warn", `Target ${val.toUpperCase()} not detected in current scan zone.`);
  }
}

// ---- LOG ----
function addLog(type, msg) {
  const el = document.getElementById("securityLogs");
  if (!el) return;
  const d = document.createElement("div");
  d.className = `log-line ${type}`;
  d.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.prepend(d);
  while (el.children.length > 60) el.removeChild(el.lastChild);
}
