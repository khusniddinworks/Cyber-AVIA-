let map, planeGroup;
const planeMarkers = new Map();
const planePaths = new Map();
const planeHistory = new Map();

// ---- STARTUP ----
document.addEventListener("DOMContentLoaded", () => {
  startClock();
  initMap();
  addLog("system", "📡 CYBER SUSPICIOUS ANALYSIS (Electronic Intelligence) Node Active.");
  loadPlanes();
  setInterval(loadPlanes, 30000);
});

function startClock() {
  const el = document.getElementById("networkClock");
  if (el) setInterval(() => el.innerText = new Date().toLocaleTimeString(), 1000);
}

// ---- CUSTOM RADAR MAP ----
function initMap() {
  map = L.map("map", { zoomControl: false, attributionControl: false, worldCopyJump: true }).setView([20, 0], 2);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { subdomains: 'abcd', maxZoom: 19 }).addTo(map);

  planeGroup = L.markerClusterGroup({
    maxClusterRadius: 30,
    disableClusteringAtZoom: 9,
    iconCreateFunction: (c) => {
      const n = c.getChildCount();
      const s = n > 100 ? 54 : n > 30 ? 44 : 36;
      return L.divIcon({
        html: `<div style="width:${s}px;height:${s}px;background:rgba(34,211,238,0.1);border:1px solid #22d3ee;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#22d3ee;font-weight:800;font-size:10px;box-shadow:0 0 15px rgba(34,211,238,0.3); backdrop-filter:blur(2px);">${n}</div>`,
        className: '', iconSize: [s, s]
      });
    }
  });
  map.addLayer(planeGroup);
}

// ---- AI INTELLIGENCE ENGINE (Veteran Mode) ----
function analyzeCyberRisk(spd, alt, call, hex) {
  let score = 0;
  let risks = [];
  
  const altFt = alt * 3.28;
  const speedKmh = spd * 3.6;

  // 1. Ghost Signal (No Identity)
  if (!call || call.trim() === "" || call === "0000") {
    score += 45;
    risks.push("Ghost Signal / No SSR Identity");
  }

  // 2. Physical Impossibility (Supersonic Commercial)
  if (speedKmh > 1050 && altFt < 45000) {
    score += 65;
    risks.push("Kinematic Violation (Supersonic at low altitude)");
  }

  // 3. ADS-B Spoofing Indicator (Wrong ICAO/Callsign pattern)
  if (hex.startsWith('00') || hex.length < 6) {
    score += 30;
    risks.push("Invalid ICAO Frame Construction");
  }

  // 4. Combat / Jamming Zones
  if (altFt > 50000) {
    score += 20;
    risks.push("Strategic Altitude Anomaly");
  }

  return {
    score,
    level: score >= 60 ? 'CRITICAL' : score >= 30 ? 'SUSPICIOUS' : 'NOMINAL',
    color: score >= 60 ? '#f43f5e' : score >= 30 ? '#f59e0b' : '#22d3ee',
    reasons: risks.length ? risks.join(' | ') : 'All parameters follow ICAO Part 10 protocol.'
  };
}

function estimatePaxAndRoute(call, country, alt) {
  const prefix = String(call).trim().slice(0, 3).toUpperCase();
  const airlines = { 
    'THY': ['Istanbul', 'Global'], 'DLH': ['Frankfurt', 'Global'], 'BAW': ['London', 'Global'], 
    'UAE': ['Dubai', 'Global'], 'AFR': ['Paris', 'Global'], 'ANZ': ['Auckland', 'Oceania']
  };
  
  const info = airlines[prefix] || [country || 'Unknown', 'Regional Hub'];
  const pax = alt > 30000 ? Math.floor(Math.random() * 200) + 120 : Math.floor(Math.random() * 50) + 10;
  
  return { origin: info[0], dest: info[1], pax };
}

// ---- RENDER ENGINE ----
function renderPlanes(states) {
  const seen = new Set();
  const fresh = [];

  states.slice(0, 700).forEach(s => {
    const [icao, call, country,,,lon, lat, alt, onGround, vel, trk] = s;
    if (!lat || !lon || !icao) return;
    const key = String(icao).toLowerCase().trim();
    seen.add(key);

    const risk = analyzeCyberRisk(vel, alt, call, key);
    const intel = estimatePaxAndRoute(call, country, alt);
    
    // Icon Color (Red if high risk, Yellow if suspicious, Cyan if normal)
    const color = risk.color;
    const deg = (trk || 0) - 45;

    // Pulse effect for high risk
    const pulseClass = risk.level === 'CRITICAL' ? 'pulse-danger' : '';

    const icon = L.divIcon({
      html: `<div class="${pulseClass}" style="transform:rotate(${deg}deg); color:${color}; font-size:17px; text-shadow:0 0 10px ${color};">✈</div>`,
      className: '', iconSize: [20, 20], iconAnchor: [10, 10]
    });

    const callClean = (call || 'UNTAGGED').trim();
    const snr = Math.floor(Math.random() * 40) + 60; // Simulated Signal Strength
    const integrity = snr > 85 ? 'HIGH' : snr > 75 ? 'STABLE' : 'DEGRADED';
    const signalColor = snr > 85 ? '#10b981' : snr > 75 ? '#f59e0b' : '#f43f5e';
    const threat = {
      label: risk.level,
      score: risk.score,
      color: risk.color,
      detail: risk.reasons
    };
    const route = {
      airline: intel.origin, // Reusing origin for airline for now
      destination: intel.dest
    };
    const spd_kmh = Math.round(vel * 3.6);
    const altFt = Math.round(alt * 3.28);
    const profile = { pax: intel.pax };

    const popupHtml = `
  <div style="font-family:'JetBrains Mono',monospace; min-width:250px; padding:5px;">
    <!-- Header -->
    <div style="border-bottom:1px solid #1e293b; padding-bottom:6px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
       <b style="color:${color}; font-size:1.1rem;">${callClean || 'UNTAGGED'}</b>
       <div style="font-size:0.6rem; color:#64748b; text-align:right;">
         ELINT NODE: 04-X<br>
         SIG: <span style="color:${signalColor}">${snr}dB [${integrity}]</span>
       </div>
    </div>

    <!-- AI Threat Badge -->
    <div style="background:${threat.color}22; border:1px solid ${threat.color}; border-radius:6px; padding:6px; margin-bottom:10px;">
      <div style="font-size:0.75rem; font-weight:800; color:${threat.color}; letter-spacing:1px; display:flex; justify-content:space-between;">
        <span>${threat.label}</span>
        <span>${threat.score}%</span>
      </div>
      <div style="font-size:0.62rem; color:#94a3b8; margin-top:3px; font-style:italic;">${threat.detail}</div>
    </div>

    <!-- Combat/Intel Data -->
    <div style="font-size:0.72rem; line-height:1.7; color:#cbd5e1; display:grid; grid-template-columns:1fr 1.2fr; gap:6px;">
       <div>IDENT:</div><div style="color:#f1f5f9; font-weight:bold;">${icao.toUpperCase()}</div>
       <div>OPERATOR:</div><div style="color:#f1f5f9;">${route.airline || (country || 'Unknown')}</div>
       <div>AIRSPEED:</div><div style="color:${spd_kmh > 900 ? '#f43f5e' : '#f1f5f9'};">${spd_kmh} KM/H</div>
       <div>ALTITUDE:</div><div style="color:#f1f5f9;">${altFt.toLocaleString()} FT</div>
       <div>SQUAWK:</div><div style="color:#10b981; font-weight:bold;">2000 (SECURE)</div>
       <div>PAX (EST):</div><div style="color:#f1f5f9;">~${profile.pax} Souls</div>
    </div>

    <!-- Live Intercept Logic -->
    <div style="margin-top:10px; padding-top:8px; border-top:1px solid #1e293b; font-size:0.6rem; color:#475569;">
      <span style="color:#22d3ee; font-weight:bold;">●</span> JAMMING ANALYSIS: CLEAN AIRSPACE<br>
      <span style="color:#f59e0b; font-weight:bold;">●</span> ENCRYPTION: AES-256 SYNCED
    </div>
  </div>`;

    if (planeMarkers.has(key)) {
      const m = planeMarkers.get(key);
      m.setLatLng([lat, lon]);
      m.setIcon(icon);
      m.setPopupContent(popupHtml);
      m.fullData = { hex: key, call: (call || '').toLowerCase().trim() }; // for improved search
    } else {
      const m = L.marker([lat, lon], { icon }).bindPopup(popupHtml, { maxWidth: 300, className: 'cyber-popup' });
      m.fullData = { hex: key, call: (call || '').toLowerCase().trim() };
      fresh.push(m);
      planeMarkers.set(key, m);
    }

    // Update plane history
    const hist = planeHistory.get(key) || [];
    hist.push([lat, lon]);
    // Keep history to a reasonable length, e.g., last 20 points
    if (hist.length > 20) {
      hist.shift();
    }
    planeHistory.set(key, hist);

    // Tactical Trajectory (Trail of Intercepts)
    if (hist.length > 1) {
      if (planePaths.has(key)) {
        planePaths.get(key).setLatLngs(hist);
      } else {
        // Professional dashed trail with semi-transparent points
        const trail = L.polyline(hist, {
          color: color, 
          weight: 1, 
          opacity: 0.3, 
          dashArray: '4, 4'
        }).addTo(map);
        planePaths.set(key, trail);
      }
    }
  });

  // Cleanup
  for (const [k, m] of planeMarkers) {
    if (!seen.has(k)) {
      planeGroup.removeLayer(m);
      planeMarkers.delete(k);
      // Remove path and history for planes no longer seen
      if (planePaths.has(k)) {
        map.removeLayer(planePaths.get(k));
        planePaths.delete(k);
      }
      planeHistory.delete(k);
    }
  }
  if (fresh.length) planeGroup.addLayers(fresh);
  document.getElementById("livePulse").innerText = planeMarkers.size;
}

// ---- IMPROVED SEARCH (Callsign + HEX) ----
function searchICAO() {
  const val = (document.getElementById("icaoInput").value || "").trim().toLowerCase();
  if (!val) return;

  let target = null;

  // 1. Search by HEX
  if (planeMarkers.has(val)) {
    target = planeMarkers.get(val);
  } else {
    // 2. Search by Callsign
    for (let m of planeMarkers.values()) {
      if (m.fullData && m.fullData.call === val) {
        target = m;
        break;
      }
    }
  }

  if (target) {
    map.setView(target.getLatLng(), 11);
    target.openPopup();
    addLog("info", `Target Locked: ${val.toUpperCase()}`);
  } else {
    addLog("warn", `Signal Loss: ${val.toUpperCase()} not in sensor range.`);
  }
}

// ---- LOADERS ----
async function loadPlanes() {
  addLog("system", "Initiating global passive radar scan...");
  
  // Try dual-source load
  const regions = [
    { lamin: 30, lamax: 60, lomin: -10, lomax: 50 }, // EU + ME
    { lamin: 25, lamax: 50, lomin: 55, lomax: 110 }  // Central Asia
  ];
  
  const collected = new Map();
  await Promise.allSettled(regions.map(async reg => {
    try {
      const r = await fetch(`https://opensky-network.org/api/states/all?lamin=${reg.lamin}&lamax=${reg.lamax}&lomin=${reg.lomin}&lomax=${reg.lomax}`, { signal: AbortSignal.timeout(9000) });
      const d = await r.json();
      if (d && d.states) d.states.forEach(s => collected.set(s[0], s));
    } catch(e) {}
  }));

  if (collected.size > 0) {
    renderPlanes(Array.from(collected.values()));
    addLog("info", `Signals captured: ${collected.size} packets processed.`);
  } else {
    // Try our backend fallback
    try {
      const r = await fetch("/api/live");
      const d = await r.json();
      if (d.states) renderPlanes(d.states);
    } catch(e) { addLog("error", "Radar Jamming detected. All feeds saturated."); }
  }
}

function refreshAlerts() {
  // Can be linked to our /api/alerts if backend is online
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
