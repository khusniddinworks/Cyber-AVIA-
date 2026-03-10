const ui = {
  statusText: document.getElementById("statusText"),
  updatedText: document.getElementById("updatedText"),
  countPill: document.getElementById("countPill"),
  visibleCount: document.getElementById("visibleCount"),
  avgSpeed: document.getElementById("avgSpeed"),
  topList: document.getElementById("topList"),
  refreshBtn: document.getElementById("refreshBtn"),
  focusBtn: document.getElementById("focusBtn"),
  navHome: document.getElementById("navHome"),
  navAlerts: document.getElementById("navAlerts"),
  navStats: document.getElementById("navStats"),
  icaoInput: document.getElementById("icaoInput"),
  fromInput: document.getElementById("fromInput"),
  toInput: document.getElementById("toInput"),
  recordBtn: document.getElementById("recordBtn"),
  recordStatus: document.getElementById("recordStatus"),
  recordCount: document.getElementById("recordCount"),
  recordBody: document.getElementById("recordBody"),
};

const CONFIG = {
  MAX_MARKERS: 320,
  AUTO_REFRESH_MS: 60000,
};

const state = {
  map: null,
  markerLayer: null,
  busyLive: false,
  moveRefreshTimer: null,
  autoRefreshTimer: null,
  lastLiveFetchAt: 0,
  knownAlertIds: new Set(),
  charts: {
    type: null,
    severity: null
  }
};

boot();

function boot() {
  initDatetimeInputs();
  initMap();
  bindEvents();
  refreshLive(true);
  state.autoRefreshTimer = setInterval(refreshLive, CONFIG.AUTO_REFRESH_MS);

  // Real-time alert checker (polling simulation)
  setInterval(checkNewAlerts, 10000);

  showView('homeView');
}

function showToast(title, msg, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<h4>${title}</h4><p>${msg}</p>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 500);
  }, 5000);
}

async function checkNewAlerts() {
  try {
    const res = await fetch('/api/alerts');
    const data = await res.json();
    if (!data.length) return;

    document.getElementById('suspiciousCount').textContent = data.filter(a => a.severity !== 'low').length;

    // Check for the very latest alert
    const latest = data[0];
    const alertId = `${latest.icao24}_${latest.detected_at}`;

    if (!state.knownAlertIds.has(alertId)) {
      if (state.knownAlertIds.size > 0) { // Don't toast on first load
        showToast(`Security Alert: ${latest.type.toUpperCase()}`, `Aircraft ${latest.icao24}: ${latest.details}`, latest.severity === 'high' ? 'danger' : 'warning');
      }
      state.knownAlertIds.add(alertId);
    }
  } catch (e) {
    console.error('Alert checker error:', e);
  }
}

// simple view switching
function showView(viewId) {
  ['homeView', 'alertsView', 'statsView'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', id !== viewId);
  });
  ['navHome', 'navAlerts', 'navStats'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('active', id === 'nav' + viewId.charAt(0).toUpperCase() + viewId.slice(1));
  });
}


function initDatetimeInputs() {
  const now = new Date();
  const before = new Date(now.getTime() - 24 * 3600 * 1000);
  ui.fromInput.value = toLocalInput(before);
  ui.toInput.value = toLocalInput(now);
}

function toLocalInput(d) {
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`;
}

function initMap() {
  state.map = L.map("map", {
    zoomControl: true,
    worldCopyJump: true,
    preferCanvas: true,
  }).setView([48, 10], 5); // Focus on Europe where air traffic is dense

  // Using Esri Satellite - Military/Cyber Intelligence look
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EBP, and the GIS User Community',
  }).addTo(state.map);

  state.markerLayer = L.layerGroup().addTo(state.map);

  state.map.on("moveend", () => {
    if (state.moveRefreshTimer) {
      clearTimeout(state.moveRefreshTimer);
    }
    state.moveRefreshTimer = setTimeout(() => refreshLive(false), 350);
  });
}

function bindEvents() {
  ui.recordBtn.addEventListener("click", fetchRecords);

  // navigation
  ui.navHome.addEventListener('click', () => showView('homeView'));
  ui.navAlerts.addEventListener('click', () => {
    showView('alertsView');
    fetchAlerts();
  });
  ui.navStats.addEventListener('click', () => {
    showView('statsView');
    fetchStats();
  });
}

function setStatus(text, level = "ok") {
  ui.statusText.textContent = text;
  ui.statusText.style.color = level === "ok" ? "var(--ok)" : "var(--warn)";
}

function getBoundsQuery() {
  const b = state.map.getBounds().pad(0.2);
  return {
    lamin: clamp(b.getSouth(), -85, 85),
    lamax: clamp(b.getNorth(), -85, 85),
    lomin: clamp(b.getWest(), -180, 180),
    lomax: clamp(b.getEast(), -180, 180),
  };
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

async function refreshLive(force = false) {
  if (!force && Date.now() - state.lastLiveFetchAt < 15000) return;
  if (state.busyLive) return;
  state.busyLive = true;

  try {
    const { flights, provider } = await fetchLiveFromBackend();
    state.lastLiveFetchAt = Date.now();
    renderFlights(flights);
    renderSummary(flights);
    ui.updatedText.textContent = new Date().toLocaleTimeString();
    setStatus(`Connected (${provider}) real data`, "ok");
  } catch (err) {
    console.error(err);
    renderFlights([]);
    renderSummary([]);
    ui.updatedText.textContent = new Date().toLocaleTimeString();
    setStatus("Real data unavailable. Backend/API error.", "warn");
  } finally {
    state.busyLive = false;
  }
}

async function fetchLiveFromBackend() {
  const url = new URL("/api/live", window.location.origin);
  const box = getBoundsQuery();
  Object.entries(box).forEach(([k, v]) => url.searchParams.set(k, String(v)));

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`/api/live HTTP ${res.status}: ${text}`);
  }

  const payload = await res.json();
  const rows = Array.isArray(payload.states) ? payload.states : [];
  const provider = typeof payload.provider === "string" ? payload.provider : "unknown";

  const flights = rows
    .map((r) => ({
      icao24: (r[0] || "").trim(),
      callsign: (r[1] || "").trim(),
      country: r[2] || "Unknown",
      lon: r[5],
      lat: r[6],
      onGround: Boolean(r[8]),
      velocity: r[9],
      track: r[10],
      altitude: r[13] ?? r[7],
    }))
    .filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lon));

  return { flights, provider };
}

function createPlaneIcon(trackDeg, onGround) {
  return L.divIcon({
    className: "",
    html: `<div class="plane-icon ${onGround ? "ground" : "air"}" style="transform: rotate(${trackDeg || 0}deg)">✈</div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function renderFlights(flights) {
  state.markerLayer.clearLayers();

  const renderList = flights
    .slice()
    .sort((a, b) => (toKmh(b.velocity) || 0) - (toKmh(a.velocity) || 0))
    .slice(0, CONFIG.MAX_MARKERS);

  for (const f of renderList) {
    const marker = L.marker([f.lat, f.lon], {
      icon: createPlaneIcon(f.track, f.onGround),
      keyboard: false,
    });

    const speed = toKmh(f.velocity);
    marker.bindPopup(`
      <strong>${escapeHtml((f.callsign || f.icao24 || "Unknown").trim())}</strong><br>
      ICAO24: ${escapeHtml(f.icao24 || "--")}<br>
      Country: ${escapeHtml(f.country)}<br>
      Speed: ${speed ? `${speed} km/h` : "--"}<br>
      Altitude: ${Number.isFinite(f.altitude) ? Math.round(f.altitude) + " m" : "--"}
    `);

    state.markerLayer.addLayer(marker);
  }
}

function renderSummary(flights) {
  ui.countPill.textContent = String(flights.length);
  ui.visibleCount.textContent = String(flights.length);

  const speeds = flights.map((f) => toKmh(f.velocity)).filter(Boolean);
  const avg = speeds.length ? Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length) : null;
  ui.avgSpeed.textContent = avg ? `${avg} km/h` : "--";

  const top = flights
    .slice()
    .sort((a, b) => (toKmh(b.velocity) || 0) - (toKmh(a.velocity) || 0))
    .slice(0, 8);

  if (!top.length) {
    ui.topList.innerHTML = "<li>No real flights in current view</li>";
    return;
  }

  ui.topList.innerHTML = top
    .map((f) => {
      const cs = escapeHtml((f.callsign || f.icao24 || "Unknown").trim());
      const sp = toKmh(f.velocity);
      return `<li><strong>${cs}</strong> - ${sp ? sp + " km/h" : "--"}</li>`;
    })
    .join("");
}

function toKmh(v) {
  return Number.isFinite(v) ? Math.round(v * 3.6) : null;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function fetchRecords() {
  const icao24 = ui.icaoInput.value.trim().toLowerCase();
  const fromValue = ui.fromInput.value;
  const toValue = ui.toInput.value;

  if (!/^[0-9a-f]{6}$/.test(icao24)) {
    ui.recordStatus.textContent = "ICAO24 6 ta hex bo'lishi kerak. Masalan: 4ca123";
    ui.recordStatus.style.color = "var(--warn)";
    return;
  }

  if (!fromValue || !toValue) {
    ui.recordStatus.textContent = "From/To vaqtini kiriting.";
    ui.recordStatus.style.color = "var(--warn)";
    return;
  }

  const begin = Math.floor(new Date(fromValue).getTime() / 1000);
  const end = Math.floor(new Date(toValue).getTime() / 1000);

  if (!Number.isFinite(begin) || !Number.isFinite(end) || begin >= end) {
    ui.recordStatus.textContent = "Vaqt oralig'i noto'g'ri.";
    ui.recordStatus.style.color = "var(--warn)";
    return;
  }

  ui.recordStatus.textContent = "Loading records...";
  ui.recordStatus.style.color = "var(--muted)";

  try {
    const records = await fetchRecordsFromBackend(icao24, begin, end);
    renderRecords(records);
    ui.recordStatus.textContent = `Found ${records.length} real record(s).`;
    ui.recordStatus.style.color = "var(--ok)";
  } catch (err) {
    console.error(err);
    renderRecords([]);
    ui.recordStatus.textContent = "Record API error.";
    ui.recordStatus.style.color = "var(--warn)";
  }
}

async function fetchRecordsFromBackend(icao24, begin, end) {
  const url = new URL("/api/records", window.location.origin);
  url.searchParams.set("icao24", icao24);
  url.searchParams.set("begin", String(begin));
  url.searchParams.set("end", String(end));

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`/api/records HTTP ${res.status}: ${text}`);
  }

  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

function renderRecords(records) {
  ui.recordCount.textContent = String(records.length);

  if (!records.length) {
    ui.recordBody.innerHTML = '<tr><td colspan="3" class="muted">No records</td></tr>';
    return;
  }

  ui.recordBody.innerHTML = records
    .slice(0, 120)
    .map((r) => {
      const callsign = escapeHtml((r.callsign || "--").trim() || "--");
      const dep = escapeHtml(r.estDepartureAirport || "N/A");
      const arr = escapeHtml(r.estArrivalAirport || "N/A");
      const route = `${dep} -> ${arr}`;
      const duration = Number.isFinite(r.lastSeen) && Number.isFinite(r.firstSeen)
        ? `${Math.max(1, Math.round((r.lastSeen - r.firstSeen) / 60))} min`
        : "--";

      return `
        <tr>
          <td>${callsign}</td>
          <td>${route}</td>
          <td>${duration}</td>
        </tr>
      `;
    })
    .join("");
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 160);
  } catch {
    return "";
  }
}

// alerts & stats
async function fetchAlerts() {
  try {
    const res = await fetch('/api/alerts');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    renderAlerts(data);
  } catch (e) {
    console.error('alert fetch', e);
  }
}

function renderAlerts(items) {
  const tbody = document.querySelector('#alertsTable tbody');
  document.getElementById('alertTotalPill').textContent = `${items.length} alerts`;
  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">No alerts</td></tr>';
    return;
  }
  tbody.innerHTML = items.map(a => `
    <tr class="severity-${a.severity}">
      <td>${escapeHtml(a.icao24)}</td>
      <td><span class="type-pill">${escapeHtml(a.type)}</span></td>
      <td><span class="severity-pill ${a.severity}">${escapeHtml(a.severity)}</span></td>
      <td><strong>${a.risk_score || 0}%</strong></td>
      <td>${escapeHtml(a.details)}</td>
      <td>${new Date(a.detected_at * 1000).toLocaleTimeString()}</td>
    </tr>
  `).join('');
}

async function fetchStats() {
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    renderStatsCharts(data);
  } catch (e) {
    console.error('stats fetch', e);
  }
}

function renderStatsCharts(data) {
  const typeCtx = document.getElementById('typeChart').getContext('2d');
  const severityCtx = document.getElementById('severityChart').getContext('2d');

  if (state.charts.type) state.charts.type.destroy();
  if (state.charts.severity) state.charts.severity.destroy();

  // Type Chart
  const typeLabels = data.by_type.map(item => item[0]);
  const typeValues = data.by_type.map(item => item[1]);

  state.charts.type = new Chart(typeCtx, {
    type: 'doughnut',
    data: {
      labels: typeLabels,
      datasets: [{
        data: typeValues,
        backgroundColor: ['#f43f5e', '#fbbf24', '#3b82f6', '#10b981', '#8b5cf6'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#94a3b8' } }
      }
    }
  });

  // Severity Chart (mocking severity data as it's not in the API yet, but let's assume it might be or fallback)
  const severityLabels = ['Low', 'Medium', 'High'];
  const severityValues = [0, 0, 0];
  // Calculate from by_type or wait for backend update? 
  // Let's assume backend might return by_severity soon, for now use mock or empty.

  state.charts.severity = new Chart(severityCtx, {
    type: 'bar',
    data: {
      labels: severityLabels,
      datasets: [{
        label: 'Anomalies',
        data: [12, 19, 7], // Mock for now
        backgroundColor: ['#10b981', '#fbbf24', '#f43f5e']
      }]
    },
    options: {
      responsive: true,
      scales: {
        y: { beginAtZero: true, grid: { color: '#334155' }, ticks: { color: '#94a3b8' } },
        x: { ticks: { color: '#94a3b8' } }
      },
      plugins: {
        legend: { display: false }
      }
    }
  });
}


