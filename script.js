let map, planeGroup;
let updateInterval;

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

  planeGroup = L.layerGroup().addTo(map);
}

// ---- TELEMETRY ----
function startUpdates() {
  updateStatus();
  updateInterval = setInterval(updateStatus, 15000);
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
    addLog("warn", "Server uplink blocked → engaging direct satellite link...");
  }

  // Fallback: Client-side direct fetch
  try {
    const res = await fetch("https://api.adsb.lol/v2/lamin/30/lamax/60/lomin/-10/lomax/40");
    const data = await res.json();
    if (data && data.ac) {
      const states = data.ac.map(a => [
        a.hex, a.flight, a.r, 0, 0, a.lon, a.lat,
        a.alt_baro, a.alt_baro === "ground", a.gs, a.track
      ]);
      processTelemetry({ states, provider: "Direct-Client-Link" });
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

  // Alerts
  fetch("/api/alerts").then(r => r.json()).then(alerts => {
    document.getElementById("anomalyCount").innerText = alerts.length;
    renderAlerts(alerts);
  }).catch(() => { });
}

// ---- RENDER PLANES ----
function renderPlanes(states) {
  if (!planeGroup) return;
  planeGroup.clearLayers();

  states.slice(0, 200).forEach(s => {
    const [icao, call, country, , , lon, lat, , , vel, trk] = s;
    if (!lat || !lon) return;

    const angle = (trk || 0) - 45;
    const speed = typeof vel === 'number' ? vel : 0;
    const color = speed > 300 ? "#f43f5e" : "#22d3ee"; // Red if supersonic

    const html = `<div class="plane-marker" style="transform:rotate(${angle}deg); color:${color}; filter:drop-shadow(0 0 6px ${color}); cursor:pointer;">✈</div>`;
    const icon = L.divIcon({ html, className: 'plane-icon-div', iconSize: [22, 22] });

    L.marker([lat, lon], { icon })
      .bindPopup(`
        <div style="min-width:140px; font-family:'Inter',sans-serif;">
          <div style="font-weight:800; font-size:1.1rem; color:var(--brand); margin-bottom:6px;">${(call || 'UNKNOWN').trim()}</div>
          <div style="font-size:0.8rem; line-height:1.7; border-top:1px solid var(--border); padding-top:6px;">
            <b>HEX:</b> ${(icao || '').toUpperCase()}<br>
            <b>SPEED:</b> ${Math.round(speed * 3.6)} km/h<br>
            <b>ORIGIN:</b> ${country || 'N/A'}
          </div>
        </div>
      `)
      .addTo(planeGroup);
  });
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
