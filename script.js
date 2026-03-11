let map, planeGroup;
const planeMarkers = new Map();
const planePaths = new Map();
const planeHistory = new Map();

// ---- STARTUP ----
document.addEventListener("DOMContentLoaded", () => {
  startClock();
  initMap();
  addLog("system", "Cyber-AVIA v3.0 Intelligence Core initializing...");
  loadPlanes();
  setInterval(loadPlanes, 15000);
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
    maxClusterRadius: 40, disableClusteringAtZoom: 8, chunkedLoading: true,
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

  // Strategy 1: Backend
  try {
    const r = await fetch("/api/live", { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const data = await r.json();
      if (data && data.states && data.states.length > 0) {
        renderPlanes(data.states);
        addLog("info", `Backend Feed: ${data.states.length} targets`);
        refreshAlerts();
        return;
      }
    }
  } catch(e) {}

  // Strategy 2: OpenSky (from browser - works, cloud blocks don't apply)
  const regions = [
    { lamin: 35, lamax: 70, lomin: -10, lomax: 40 },
    { lamin: 10, lamax: 50, lomin: 40, lomax: 100 },
    { lamin: 20, lamax: 65, lomin: -130, lomax: -60 },
    { lamin: -10, lamax: 50, lomin: 100, lomax: 180 },
  ];
  const collected = new Map();
  await Promise.allSettled(regions.map(async (reg) => {
    try {
      const url = `https://opensky-network.org/api/states/all?lamin=${reg.lamin}&lamax=${reg.lamax}&lomin=${reg.lomin}&lomax=${reg.lomax}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) return;
      const d = await r.json();
      if (d && d.states) d.states.forEach(s => { if (s[0] && s[5] && s[6]) collected.set(s[0], s); });
    } catch(e) {}
  }));
  if (collected.size > 0) {
    const states = Array.from(collected.values());
    renderPlanes(states);
    addLog("info", `OpenSky: ${states.length} targets acquired`);
    refreshAlerts();
    return;
  }

  // Strategy 3: ADSB.lol direct
  try {
    const zones = [
      "https://api.adsb.lol/v2/lat/48/lon/11/dist/500",
      "https://api.adsb.lol/v2/lat/40/lon/-100/dist/500",
      "https://api.adsb.lol/v2/lat/25/lon/55/dist/500",
    ];
    const all = new Map();
    const res = await Promise.allSettled(zones.map(u => fetch(u, { signal: AbortSignal.timeout(8000) }).then(r => r.json())));
    res.forEach(r => {
      if (r.status === "fulfilled" && r.value?.ac) {
        r.value.ac.forEach(a => { if (a.hex && a.lat && a.lon) all.set(a.hex, a); });
      }
    });
    if (all.size > 0) {
      const states = Array.from(all.values()).map(a => [a.hex, a.flight||"", a.r||"", 0, 0, a.lon, a.lat,
        typeof a.alt_baro === 'number' ? a.alt_baro : 0, a.alt_baro === "ground", a.gs||0, a.track||0]);
      renderPlanes(states);
      addLog("info", `ADSB Direct: ${states.length} targets`);
      return;
    }
  } catch(e) {}
  addLog("warn", "All feeds temporarily offline. Retrying...");
}

// ================================================================
// AI ANALYSIS ENGINE
// ================================================================

// Estimate origin/destination from callsign prefix
const AIRLINE_DB = {
  'THY':'Turkish Airlines', 'DLH':'Lufthansa', 'BAW':'British Airways',
  'AFR':'Air France', 'KLM':'KLM Royal Dutch', 'SWR':'Swiss Air',
  'UAE':'Emirates', 'ETD':'Etihad', 'QTR':'Qatar Airways',
  'SIA':'Singapore Airlines', 'CCA':'Air China', 'CSN':'China Southern',
  'AIC':'Air India', 'THA':'Thai Airways', 'QFA':'Qantas',
  'AAL':'American Airlines','UAL':'United Airlines','DAL':'Delta Air Lines',
  'SWA':'Southwest','FDX':'FedEx','UPS':'UPS Airlines',
  'PGT':'Pegasus Airlines','ROT':'TAROM','LOT':'LOT Polish',
  'AUA':'Austrian Airlines','BCS':'European Air Charter',
  'ETH':'Ethiopian Airlines','MSR':'EgyptAir','RAM':'Royal Air Maroc',
  'HVN':'Vietnam Airlines','EVA':'EVA Air','CAL':'China Airlines',
};

// Estimate plane type & passengers from speed/altitude
function estimatePlaneProfile(vel_ms, alt, callsign) {
  const spd = (vel_ms || 0) * 3.6;
  const altFt = (alt || 0) * 3.28084;
  
  if (altFt < 500) return { type: 'Ground/Taxiing', pax: 0, category: 'GROUND' };
  if (spd < 150 && altFt < 5000) return { type: 'Small Prop / Helicopter', pax: '2–6', category: 'GA' };
  if (spd < 400) return { type: 'Regional Turboprop', pax: '30–70', category: 'REGIONAL' };
  if (spd < 700 && altFt < 20000) return { type: 'Private Jet', pax: '8–16', category: 'BIZJET' };
  if (spd >= 700 && spd <= 950 && altFt > 25000) return { type: 'Commercial Airliner', pax: '120–400', category: 'COMMERCIAL' };
  if (spd > 950) return { type: '🔴 SUPERSONIC / MILITARY', pax: 'Unknown', category: 'ANOMALY' };
  return { type: 'Commercial Airliner', pax: '80–250', category: 'COMMERCIAL' };
}

// Estimate from/to based on heading & country
function estimateRoute(trk, country, callsign) {
  const hdg = trk || 0;
  const prefix = (callsign || '').trim().slice(0, 3).toUpperCase();
  const airline = AIRLINE_DB[prefix] || null;
  
  const dir = hdg < 45 ? 'North' : hdg < 90 ? 'Northeast' : hdg < 135 ? 'East' :
              hdg < 180 ? 'Southeast' : hdg < 225 ? 'South' : hdg < 270 ? 'Southwest' :
              hdg < 315 ? 'West' : 'Northwest';
  
  return { airline, heading_dir: dir };
}

// AI threat scoring
function aiThreatScore(spd_kmh, alt, callsign, country, onGround) {
  if (onGround) return { score: 0, label: '🟢 GROUND', color: '#64748b', detail: 'Aircraft on ground.' };
  
  let score = 0;
  const reasons = [];

  // Speed check
  if (spd_kmh > 1200) { score += 60; reasons.push('SUPERSONIC SPEED'); }
  else if (spd_kmh > 950) { score += 40; reasons.push('Abnormal speed'); }
  else if (spd_kmh > 800) { score += 10; }

  // No callsign = unidentified
  if (!callsign || callsign.trim() === '' || callsign.trim() === '0000') {
    score += 30; reasons.push('NO CALLSIGN (Ghost signal)');
  }

  // High altitude with high speed (could be military)
  const altFt = (alt || 0) * 3.28084;
  if (altFt > 45000 && spd_kmh > 800) { score += 20; reasons.push('Extreme altitude+speed'); }

  // Low altitude at high speed (terrain-hugging)
  if (altFt > 0 && altFt < 3000 && spd_kmh > 400) { score += 25; reasons.push('Low-altitude high-speed'); }

  // Score classification
  if (score >= 60) return { score, label: '🔴 HIGH THREAT', color: '#f43f5e', detail: reasons.join(' · ') };
  if (score >= 30) return { score, label: '🟡 SUSPICIOUS', color: '#f59e0b', detail: reasons.join(' · ') };
  if (score >= 10) return { score, label: '🔵 MONITOR', color: '#38bdf8', detail: reasons.join(' · ') || 'Elevated parameters.' };
  return { score, label: '🟢 NORMAL', color: '#10b981', detail: 'All parameters nominal.' };
}

// Build full AI popup HTML
function buildPopup(icao, call, country, lon, lat, alt, onGround, vel, trk) {
  const spd_kmh = Math.round((vel || 0) * 3.6);
  const altFt = Math.round((typeof alt === 'number' ? alt : 0) * 3.28084);
  const callClean = (call || '').trim();
  const profile = estimatePlaneProfile(vel, alt, callClean);
  const route = estimateRoute(trk, country, callClean);
  const threat = aiThreatScore(spd_kmh, alt, callClean, country, onGround);
  
  const osMapsLink = `https://www.openstreetmap.org/?mlat=${lat.toFixed(4)}&mlon=${lon.toFixed(4)}&zoom=8`;

  return `
  <div style="font-family:'Inter',sans-serif;min-width:230px;max-width:260px;padding:2px;">
    <!-- Header -->
    <div style="display:flex;align-items:center;gap:8px;border-bottom:1px solid #1e293b;padding-bottom:6px;margin-bottom:8px;">
      <div style="font-size:1.4rem;">${onGround ? '🅿️' : '✈️'}</div>
      <div>
        <div style="font-size:1rem;font-weight:800;color:#22d3ee;">${callClean || 'UNTAGGED'}</div>
        <div style="font-size:0.7rem;color:#64748b;">${route.airline || (country || 'Unknown Operator')}</div>
      </div>
    </div>

    <!-- AI Threat Badge -->
    <div style="background:${threat.color}22;border:1px solid ${threat.color};border-radius:6px;padding:5px 8px;margin-bottom:8px;text-align:center;">
      <div style="font-size:0.78rem;font-weight:700;color:${threat.color};">${threat.label}</div>
      <div style="font-size:0.65rem;color:#94a3b8;margin-top:2px;">${threat.detail}</div>
    </div>

    <!-- Flight Data -->
    <div style="font-size:0.75rem;line-height:1.9;color:#cbd5e1;">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">
        <div>🔷 <b>HEX</b></div><div style="color:#f1f5f9;">${icao.toUpperCase()}</div>
        <div>🌍 <b>REG</b></div><div style="color:#f1f5f9;">${country || 'N/A'}</div>
        <div>🚀 <b>SPEED</b></div><div style="color:${spd_kmh > 950 ? '#f43f5e' : spd_kmh > 700 ? '#f59e0b' : '#10b981'};">${spd_kmh} km/h</div>
        <div>📡 <b>ALT</b></div><div style="color:#f1f5f9;">${altFt.toLocaleString()} ft</div>
        <div>🧭 <b>HDG</b></div><div style="color:#f1f5f9;">${Math.round(trk || 0)}° ${route.heading_dir}</div>
        <div>✈️ <b>TYPE</b></div><div style="color:#f1f5f9;">${profile.type}</div>
        <div>👥 <b>PAX EST</b></div><div style="color:#f1f5f9;">${profile.pax}</div>
        <div>📍 <b>STATUS</b></div><div style="color:#f1f5f9;">${onGround ? 'On Ground' : 'Airborne'}</div>
      </div>
    </div>

    <!-- Footer -->
    <div style="margin-top:8px;padding-top:6px;border-top:1px solid #1e293b;display:flex;justify-content:space-between;align-items:center;">
      <span style="font-size:0.62rem;color:#475569;">AI Risk Score: ${threat.score}/100</span>
      <a href="${osMapsLink}" target="_blank" style="font-size:0.65rem;color:#22d3ee;text-decoration:none;">📌 View Map</a>
    </div>
  </div>`;
}

// ---- RENDER ENGINE ----
function renderPlanes(states) {
  const seen = new Set();
  const fresh = [];

  states.slice(0, 600).forEach(s => {
    const [icao, call, country,,,lon, lat, alt, onGround, vel, trk] = s;
    if (!lat || !lon || !icao) return;
    const key = String(icao).toLowerCase().trim();
    seen.add(key);

    // History
    if (!planeHistory.has(key)) planeHistory.set(key, []);
    const hist = planeHistory.get(key);
    const last = hist[hist.length - 1];
    if (!last || Math.abs(last[0] - lat) > 0.005 || Math.abs(last[1] - lon) > 0.005) {
      hist.push([lat, lon]);
      if (hist.length > 8) hist.shift();
    }

    const spd_kmh = (vel || 0) * 3.6;
    // Color logic:
    // 🔴 RED = > 950 km/h (anomalous = possibly military/spoofed/supersonic)
    // 🟡 YELLOW = 700-950 km/h (fast commercial)
    // 🔵 CYAN = normal flight
    const color = spd_kmh > 950 ? "#f43f5e" : spd_kmh > 700 ? "#f59e0b" : "#22d3ee";
    const deg = (trk || 0) - 45;

    const icon = L.divIcon({
      html: `<span style="display:block;transform:rotate(${deg}deg);color:${color};text-shadow:0 0 8px ${color};font-size:16px;line-height:1;">✈</span>`,
      className: '', iconSize: [18, 18], iconAnchor: [9, 9]
    });

    const popup = buildPopup(key, call, country, lon, lat, alt, onGround, vel, trk);

    if (planeMarkers.has(key)) {
      const m = planeMarkers.get(key);
      m.setLatLng([lat, lon]);
      m.setIcon(icon);
      m.setPopupContent(popup);
    } else {
      const m = L.marker([lat, lon], { icon }).bindPopup(popup, { maxWidth: 270, className: 'cyber-popup' });
      fresh.push(m);
      planeMarkers.set(key, m);
    }

    // Trajectory
    if (hist.length > 1) {
      if (planePaths.has(key)) planePaths.get(key).setLatLngs(hist);
      else planePaths.set(key, L.polyline(hist, { color, weight: 1.5, opacity: 0.4, dashArray: '5,5' }).addTo(map));
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
      : '<div class="log-line system">Sensors clean. No threats detected.</div>';
  }).catch(() => {});
}

// ---- SEARCH ----
function searchICAO() {
  const val = (document.getElementById("icaoInput")?.value || "").trim().toLowerCase();
  if (!val) return;
  if (planeMarkers.has(val)) {
    map.setView(planeMarkers.get(val).getLatLng(), 10);
    planeMarkers.get(val).openPopup();
    addLog("info", `▶ Target ${val.toUpperCase()} locked on radar.`);
  } else {
    addLog("warn", `Target ${val.toUpperCase()} not in sensor range.`);
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
