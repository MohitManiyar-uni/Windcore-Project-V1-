// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const API_BASE = "http://localhost:3001/api";

// ─────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────
function login() {
  const email    = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const err      = document.getElementById("loginErr");

  if (!email || !password) {
    err.textContent = "Please enter both fields.";
    err.style.display = "block";
    return;
  }
  err.style.display = "none";
  localStorage.setItem("wc_user", email);
  window.location.href = "dashboard.html";
}

function checkAuth() {
  if (!localStorage.getItem("wc_user")) {
    window.location.href = "index.html";
  }
}

function logout() {
  localStorage.removeItem("wc_user");
  window.location.href = "index.html";
}

function getUsername() {
  const u = localStorage.getItem("wc_user") || "user";
  return u.includes("@") ? u.split("@")[0] : u;
}

// ─────────────────────────────────────────────
// PHYSICS MODEL  (mirrored from backend)
// ─────────────────────────────────────────────
const RHO  = 1.225;
const AREA = Math.PI;
const CP   = 0.35;

function computePower(v) {
  if (v < 2.5 || v > 25) return 0;
  if (v > 15) return 3500;
  return parseFloat((0.5 * RHO * AREA * CP * Math.pow(v, 3)).toFixed(1));
}

function computeEff(v) {
  if (v < 2.5) return 0;
  if (v >= 12) return 59;
  return Math.min(59, parseFloat((CP / 0.593 * 100 * (1 - Math.exp(-v / 5))).toFixed(1)));
}

function getTurbineStatus(v) {
  if (v < 2.5)  return "idle";
  if (v > 25)   return "shutdown";
  if (v >= 12)  return "rated";
  return "active";
}

function windDirName(deg) {
  const dirs = ["N","NE","E","SE","S","SW","W","NW"];
  return dirs[Math.round(deg / 45) % 8];
}

// ─────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────
let refreshTimer    = null;
let currentLat      = 13.08;
let currentLon      = 80.27;
let currentLocation = "Chennai";

// Shared live values — read by ROI accumulator
let _livePower = 0;
let _liveEff   = 0;

function initDashboard() {
  checkAuth();
  setText("usernameLabel", getUsername());

  const savedLat = localStorage.getItem("wc_lat");
  const savedLon = localStorage.getItem("wc_lon");
  const savedLoc = localStorage.getItem("wc_loc");
  if (savedLat) {
    currentLat      = parseFloat(savedLat);
    currentLon      = parseFloat(savedLon);
    currentLocation = savedLoc || "Custom";
    document.getElementById("latInput").value = currentLat;
    document.getElementById("lonInput").value = currentLon;
  }

  displayHistory();
  fetchWeather();
  refreshTimer = setInterval(fetchWeather, 30000);

  roiInit();   // start energy accumulator
}

async function fetchWeather() {
  const url = `${API_BASE}/wind?lat=${currentLat}&lon=${currentLon}&location=${encodeURIComponent(currentLocation)}`;

  try {
    const res  = await fetch(url);
    const data = await res.json();

    if (!data.success) throw new Error(data.error);

    const { weather, turbine, location } = data;

    // Stat cards
    setText("statWind",  weather.windSpeed.toFixed(1));
    setText("statTemp",  weather.temperature.toFixed(1));
    setText("statPower", turbine.power.toFixed(0));
    setText("statEff",   turbine.efficiency.toFixed(1));

    // Weather panel
    setText("tempVal",    weather.temperature.toFixed(1) + " °C");
    setText("humidVal",   weather.humidity + "%");
    setText("pressVal",   weather.pressure + " hPa");
    setText("visVal",     weather.visibility ? weather.visibility + " km" : "–");
    setText("descVal",    weather.description);
    setText("windDirVal", windDirName(weather.windDirection) + " · " + weather.windDirection + "°");
    if (weather.windGusts) setText("gustVal", weather.windGusts.toFixed(1) + " m/s");

    // Turbine panel
    setText("powerDisplay", turbine.power.toFixed(0));
    updateTurbineStatus(turbine.status, weather.windSpeed);

    // Gauge + efficiency bar
    updateGauge(weather.windSpeed);
    updateEffBar(turbine.efficiency);

    // Alerts
    updateAlerts(weather.windSpeed, weather.temperature, turbine.power);

    // Timestamp
    const now = new Date();
    setText("lastUpdated", "Updated " + now.toLocaleTimeString());

    // Expose live values to ROI accumulator
    _livePower = turbine.power;
    _liveEff   = turbine.efficiency;
    roiRefreshBars();       // update ROI bars immediately on each fetch
    roiRefreshProjections();

    // Measurement history
    saveHistory({
      wind:   weather.windSpeed,
      temp:   weather.temperature,
      power:  turbine.power,
      eff:    turbine.efficiency,
      status: turbine.status,
      time:   now.toLocaleTimeString(),
      date:   now.toLocaleDateString(),
    });

  } catch (err) {
    console.error("Fetch failed:", err.message);
    setText("lastUpdated", "Failed to fetch · retrying...");
    const alertBox = document.getElementById("alertBox");
    if (alertBox) {
      alertBox.innerHTML = `<div class="alert warn">⚠ Could not reach backend. Make sure the server is running on port 3001.</div>`;
    }
  }
}

function updateTurbineStatus(status, wind) {
  const badge = document.getElementById("statusBadge");
  if (!badge) return;
  const labels = { idle:"IDLE", active:"ACTIVE", rated:"RATED POWER", shutdown:"SHUTDOWN" };
  badge.textContent = labels[status] || status.toUpperCase();
  badge.className   = "status-badge status-" + status;

  const blades = document.getElementById("blades");
  if (blades) {
    const dur = wind > 0.5 ? Math.max(0.4, 5 / wind).toFixed(2) : 20;
    blades.style.animationDuration = dur + "s";
  }
}

function updateAlerts(wind, temp, power) {
  const box = document.getElementById("alertBox");
  if (!box) return;
  const alerts = [];
  if (wind < 2.5)
    alerts.push({ type:"warn", msg:"Wind below cut-in speed (2.5 m/s) — turbine is idle" });
  else if (wind > 25)
    alerts.push({ type:"err",  msg:"Wind above cut-out speed (25 m/s) — turbine shut down for safety" });
  else
    alerts.push({ type:"ok",   msg:`Turbine operational · wind at ${wind.toFixed(1)} m/s` });
  if (temp > 38)
    alerts.push({ type:"warn", msg:"High ambient temperature — may affect air density" });
  if (power >= 3000)
    alerts.push({ type:"ok",   msg:"Near rated power — generator running at full capacity" });
  box.innerHTML = alerts.map(a =>
    `<div class="alert ${a.type}">${a.type === "ok" ? "✓" : "⚠"} ${a.msg}</div>`
  ).join("");
}

// ─────────────────────────────────────────────
// GAUGE
// ─────────────────────────────────────────────
function updateGauge(wind) {
  const maxWind = 20;
  const pct     = Math.min(wind / maxWind, 1);
  const angle   = pct * 180 - 90;

  const needle = document.getElementById("gaugeNeedle");
  if (needle) needle.setAttribute("transform", `rotate(${angle}, 80, 80)`);

  const arc = document.getElementById("gaugeArc");
  if (arc) {
    const r = 65, cx = 80, cy = 80;
    const startX = cx - r;
    const startY = cy;
    const rad  = ((pct * 180) - 180) * Math.PI / 180;
    const endX = cx + r * Math.cos(rad);
    const endY = cy + r * Math.sin(rad);
    const large = pct > 0.5 ? 1 : 0;
    if (pct > 0.01) {
      arc.setAttribute("d", `M ${startX} ${startY} A ${r} ${r} 0 ${large} 1 ${endX} ${endY}`);
      arc.setAttribute("stroke", wind < 10 ? "#34d399" : wind < 15 ? "#fbbf24" : "#f87171");
    } else {
      arc.setAttribute("d", "");
    }
  }
  setText("gaugeWindVal", wind.toFixed(1));
}

function updateEffBar(eff) {
  const bar = document.getElementById("effBar");
  if (bar) bar.style.width = eff + "%";
  setText("effVal", eff + "%");
}

// ─────────────────────────────────────────────
// MEASUREMENT HISTORY
// ─────────────────────────────────────────────
function saveHistory(entry) {
  const history = JSON.parse(localStorage.getItem("wc_history") || "[]");
  history.push(entry);
  if (history.length > 50) history.splice(0, history.length - 50);
  localStorage.setItem("wc_history", JSON.stringify(history));
  displayHistory();
}

function displayHistory() {
  const tbody = document.getElementById("historyBody");
  if (!tbody) return;
  const history = JSON.parse(localStorage.getItem("wc_history") || "[]");
  if (!history.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:20px;">No data yet.</td></tr>`;
    return;
  }
  const rows = [...history].reverse().slice(0, 20);
  tbody.innerHTML = rows.map(d => {
    const badgeCls = d.power < 100 ? "amber" : d.power >= 2500 ? "blue" : "green";
    const badgeLbl = d.power < 100 ? "LOW"   : d.power >= 2500 ? "HIGH" : "MED";
    return `<tr>
      <td>${d.date}</td>
      <td>${d.time}</td>
      <td>${d.wind} m/s</td>
      <td>${d.temp} °C</td>
      <td><strong>${typeof d.power === "number" ? d.power.toFixed(0) : d.power} W</strong></td>
      <td>${d.eff}%</td>
      <td><span class="badge ${badgeCls}">${badgeLbl}</span></td>
    </tr>`;
  }).join("");
}

function clearHistory() {
  if (!confirm("Clear all history?")) return;
  localStorage.removeItem("wc_history");
  displayHistory();
}

function exportCSV() {
  const history = JSON.parse(localStorage.getItem("wc_history") || "[]");
  if (!history.length) { alert("No data to export."); return; }
  const header = ["Date","Time","Wind (m/s)","Temp (°C)","Power (W)","Efficiency (%)"];
  const rows   = history.map(d => [d.date, d.time, d.wind, d.temp, d.power, d.eff]);
  const csv    = [header, ...rows].map(r => r.join(",")).join("\n");
  const a      = document.createElement("a");
  a.href       = URL.createObjectURL(new Blob([csv], { type:"text/csv" }));
  a.download   = "windcore_data.csv";
  a.click();
}

// ─────────────────────────────────────────────
// LOCATION CHANGE
// ─────────────────────────────────────────────
function updateLocation() {
  const lat = parseFloat(document.getElementById("latInput").value);
  const lon = parseFloat(document.getElementById("lonInput").value);
  if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    alert("Invalid coordinates.");
    return;
  }
  currentLat      = lat;
  currentLon      = lon;
  currentLocation = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  localStorage.setItem("wc_lat", lat);
  localStorage.setItem("wc_lon", lon);
  localStorage.setItem("wc_loc", currentLocation);
  fetchWeather();
}

// ─────────────────────────────────────────────
// ANALYTICS PAGE
// ─────────────────────────────────────────────
function initAnalytics() {
  checkAuth();
  setText("usernameLabel", getUsername());
  let history = JSON.parse(localStorage.getItem("wc_history") || "[]");
  if (!history.length) {
    history = generateDemoData();
    localStorage.setItem("wc_history", JSON.stringify(history));
  }
  renderSummary(history);
  renderCharts(history);
}

function generateDemoData() {
  const data = [];
  for (let i = 0; i < 16; i++) {
    const wind = parseFloat((2 + Math.random() * 14).toFixed(2));
    const temp = parseFloat((26 + Math.random() * 8 - 2).toFixed(1));
    data.push({
      wind, temp,
      power:  computePower(wind),
      eff:    computeEff(wind),
      status: getTurbineStatus(wind),
      time:   `${String(7 + i).padStart(2, "0")}:00`,
      date:   new Date().toLocaleDateString(),
    });
  }
  return data;
}

function renderSummary(history) {
  const powers = history.map(d => parseFloat(d.power) || 0);
  const winds  = history.map(d => parseFloat(d.wind)  || 0);
  const avg    = v => v.reduce((a, b) => a + b, 0) / v.length;
  setText("summAvgPower",  avg(powers).toFixed(0) + " W");
  setText("summPeakPower", Math.max(...powers).toFixed(0) + " W");
  setText("summAvgWind",   avg(winds).toFixed(1) + " m/s");
  setText("summPoints",    history.length);
}

let charts = {};

function renderCharts(history) {
  const labels    = history.map((d, i) => d.time || `#${i + 1}`);
  const powerData = history.map(d => parseFloat(d.power) || 0);
  const windData  = history.map(d => parseFloat(d.wind)  || 0);
  const tempData  = history.map(d => parseFloat(d.temp)  || 0);
  const effData   = history.map(d => parseFloat(d.eff)   || 0);

  const tickColor = "#64748b";
  const gridColor = "rgba(255,255,255,0.05)";
  const baseScales = {
    x: { ticks:{ color:tickColor, font:{ family:"DM Mono", size:10 } }, grid:{ color:gridColor } },
    y: { ticks:{ color:tickColor, font:{ family:"DM Mono", size:10 } }, grid:{ color:gridColor } },
  };
  const baseLegend = { labels:{ color:"#94a3b8", font:{ family:"DM Sans", size:11 }, boxWidth:10 } };

  const ctx1 = document.getElementById("powerChart");
  if (ctx1) {
    if (charts.power) charts.power.destroy();
    charts.power = new Chart(ctx1, {
      type: "line",
      data: {
        labels,
        datasets: [
          { label:"Power (W)",       data:powerData, borderColor:"#4f8ef7", backgroundColor:"rgba(79,142,247,0.08)", fill:true, tension:0.4, pointRadius:3, pointBackgroundColor:"#4f8ef7" },
          { label:"Efficiency (%)",  data:effData,   borderColor:"#34d399", backgroundColor:"transparent",           tension:0.4, pointRadius:3, pointBackgroundColor:"#34d399", yAxisID:"y2" },
        ],
      },
      options: {
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:baseLegend },
        scales:{ ...baseScales, y2:{ position:"right", ticks:{ color:"#34d399", font:{ family:"DM Mono", size:10 } }, grid:{ drawOnChartArea:false } } },
      },
    });
  }

  const ctx2 = document.getElementById("scatterChart");
  if (ctx2) {
    if (charts.scatter) charts.scatter.destroy();
    charts.scatter = new Chart(ctx2, {
      type: "scatter",
      data: { datasets:[{ label:"Wind vs Power", data:history.map(d => ({ x:parseFloat(d.wind), y:parseFloat(d.power)||0 })), backgroundColor:"rgba(79,142,247,0.5)", pointRadius:5 }] },
      options: {
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:baseLegend },
        scales: {
          x:{ ...baseScales.x, title:{ display:true, text:"Wind (m/s)", color:tickColor, font:{ size:11 } } },
          y:{ ...baseScales.y, title:{ display:true, text:"Power (W)",  color:tickColor, font:{ size:11 } } },
        },
      },
    });
  }

  const ctx3 = document.getElementById("tempWindChart");
  if (ctx3) {
    if (charts.bar) charts.bar.destroy();
    charts.bar = new Chart(ctx3, {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label:"Temp (°C)",  data:tempData, backgroundColor:"rgba(251,191,36,0.25)", borderColor:"#fbbf24", borderWidth:1, borderRadius:3 },
          { label:"Wind (m/s)", data:windData, backgroundColor:"rgba(79,142,247,0.25)", borderColor:"#4f8ef7", borderWidth:1, borderRadius:3 },
        ],
      },
      options: { responsive:true, maintainAspectRatio:false, plugins:{ legend:baseLegend }, scales:baseScales },
    });
  }
}

// ─────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

document.addEventListener("DOMContentLoaded", () => {
  const pw = document.getElementById("password");
  if (pw) pw.addEventListener("keydown", e => { if (e.key === "Enter") login(); });
});


// ═════════════════════════════════════════════════════════════════════
//  ENERGY ACCUMULATOR & ROI CALCULATOR
//
//  How it works:
//  • roiInit()  — called by initDashboard(), builds the Chart.js chart
//                 and starts a 2-second interval timer (roiTick).
//  • roiTick()  — every 2 s, reads _livePower (updated by fetchWeather),
//                 calculates kWh and revenue for that slice, accumulates
//                 totals, updates every card/chart/log in the UI.
//  • Controls   — tariff slider, turbines slider, and 4 scenario buttons
//                 all call helpers that update roiTariff / roiTurbines
//                 and refresh projections immediately.
//  • resetROI() — clears all accumulators and resets the UI.
// ═════════════════════════════════════════════════════════════════════

const ROI_CO2_KG_PER_KWH = 0.71;   // India grid average
const ROI_TICK_MS         = 2000;   // accumulation interval

// Mutable ROI state
let roiTariff      = 6.5;   // ₹ per kWh  (default: Commercial)
let roiTurbines    = 1;
let roiTotalKwh    = 0;
let roiTotalRev    = 0;
let roiActiveTicks = 0;
let roiTotalTicks  = 0;
let roiTickTimer   = null;
let roiChartInst   = null;
let roiRevSeries   = [];    // last 60 cumulative revenue values
let roiTimeSeries  = [];    // matching HH:MM:SS labels

function roiInit() {
  const canvas = document.getElementById("roiChart");
  if (!canvas) return;

  roiChartInst = new Chart(canvas, {
    type: "line",
    data: {
      labels: [],
      datasets: [{
        label: "Revenue (₹)",
        data:  [],
        borderColor:     "#34d399",
        backgroundColor: "rgba(52,211,153,0.07)",
        fill:    true,
        tension: 0.4,
        pointRadius:  0,
        borderWidth:  2,
      }],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: { color:"#64748b", font:{ family:"DM Mono", size:10 }, maxTicksLimit:6 },
          grid:  { color:"rgba(255,255,255,0.05)" },
        },
        y: {
          ticks: {
            color: "#64748b",
            font:  { family:"DM Mono", size:10 },
            callback: v => "₹" + v.toFixed(2),
          },
          grid: { color:"rgba(255,255,255,0.05)" },
        },
      },
    },
  });

  // Start ticking
  roiTickTimer = setInterval(roiTick, ROI_TICK_MS);
}

function roiTick() {
  roiTotalTicks++;
  const power = _livePower || 0;           // Watts, single turbine
  if (power > 0) roiActiveTicks++;

  // Energy (kWh) = Power(W) × turbines × time(h)
  const kwhSlice = (power * roiTurbines / 1000) * (ROI_TICK_MS / 3_600_000);
  const revSlice = kwhSlice * roiTariff;

  roiTotalKwh += kwhSlice;
  roiTotalRev += revSlice;

  // Time label
  const now = new Date();
  const ts  = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(n => String(n).padStart(2, "0")).join(":");

  roiRevSeries.push(parseFloat(roiTotalRev.toFixed(4)));
  roiTimeSeries.push(ts);
  if (roiRevSeries.length > 60) { roiRevSeries.shift(); roiTimeSeries.shift(); }

  // Update all UI
  roiUpdateCards();
  roiUpdateChart();

  // Session log entry every 5 ticks (~10 s)
  if (roiTotalTicks % 5 === 0) roiAddLogRow(power, revSlice, ts);
}

// ── Card updates ──────────────────────────────
function roiUpdateCards() {
  setText("roiKwh",     roiTotalKwh.toFixed(3));
  setText("roiTicker",  roiTotalRev.toFixed(2));
  setText("roiRevenue", "₹" + roiTotalRev.toFixed(2));
  setText("roiCo2",     (roiTotalKwh * ROI_CO2_KG_PER_KWH).toFixed(3));

  const pct = roiTotalTicks > 0
    ? Math.round(roiActiveTicks / roiTotalTicks * 100) : 0;
  setText("roiUptime",    pct + "%");
  setText("roiUptimeSub", roiActiveTicks + " of " + roiTotalTicks + " readings");
}

// ── Chart update ──────────────────────────────
function roiUpdateChart() {
  if (!roiChartInst) return;
  roiChartInst.data.labels              = [...roiTimeSeries];
  roiChartInst.data.datasets[0].data    = [...roiRevSeries];
  roiChartInst.update("none");
}

// ── Power bars (called on each weather fetch) ─
function roiRefreshBars() {
  const power  = _livePower || 0;
  const eff    = _liveEff   || 0;
  const maxPow = 3500 * roiTurbines;
  const pPct   = Math.min(power * roiTurbines / maxPow * 100, 100);

  const barP = document.getElementById("roiBarPower");
  const barE = document.getElementById("roiBarEff");
  if (barP) barP.style.width = pPct.toFixed(1) + "%";
  if (barE) barE.style.width = Math.min(eff, 100) + "%";

  setText("roiLblPower", Math.round(power * roiTurbines) + " W");
  setText("roiLblEff",   eff.toFixed(1) + "%");
}

// ── Projections ───────────────────────────────
function roiRefreshProjections() {
  const wPerH = (_livePower || 0) * roiTurbines / 1000 * roiTariff;  // ₹/hour
  setText("roiProj1h",  "₹" + wPerH.toFixed(2));
  setText("roiProj24h", "₹" + (wPerH * 24).toFixed(2));
  setText("roiProj30d", "₹" + (wPerH * 24 * 30).toFixed(0));
  setText("roiProj1y",  "₹" + (wPerH * 24 * 365).toFixed(0));
}

// ── Session log ───────────────────────────────
function roiAddLogRow(power, revSlice, ts) {
  const log = document.getElementById("roiLog");
  if (!log) return;

  // Remove empty placeholder
  const empty = log.querySelector(".roi-log-empty");
  if (empty) empty.remove();

  const tagCls = power > 2000 ? "badge green" : power > 500 ? "badge blue" : "badge amber";
  const tagLbl = power > 2000 ? "HIGH"        : power > 500 ? "MED"        : "LOW";
  const total  = roiTurbines * power;

  const row = document.createElement("div");
  row.className = "roi-log-row";
  row.innerHTML =
    `<span class="roi-log-time">${ts}</span>` +
    `<span class="roi-log-power">${Math.round(total)} W</span>` +
    `<span class="${tagCls}">${tagLbl}</span>` +
    `<span class="roi-log-rev">+₹${revSlice.toFixed(4)}</span>`;
  log.prepend(row);

  // Keep max 10 rows
  while (log.children.length > 10) log.removeChild(log.lastChild);
}

// ── Control handlers (called from HTML) ───────

function roiOnTariffSlide(val) {
  roiTariff = parseFloat(val);
  setText("roiTariffVal",   "₹" + roiTariff.toFixed(2));
  setText("roiTariffLabel", "@ ₹" + roiTariff.toFixed(2) + " / kWh");
  // Deactivate all scenario buttons when slider is moved manually
  document.querySelectorAll(".roi-seg").forEach(b => b.classList.remove("roi-seg-on"));
  roiRefreshProjections();
}

function roiOnTurbinesSlide(val) {
  roiTurbines = parseInt(val);
  setText("roiTurbinesVal", "×" + roiTurbines);
  roiRefreshBars();
  roiRefreshProjections();
}

function roiPickScenario(el, tariff) {
  roiTariff = tariff;
  document.getElementById("roiTariffSlider").value = tariff;
  setText("roiTariffVal",   "₹" + tariff.toFixed(2));
  setText("roiTariffLabel", "@ ₹" + tariff.toFixed(2) + " / kWh");
  document.querySelectorAll(".roi-seg").forEach(b => b.classList.remove("roi-seg-on"));
  el.classList.add("roi-seg-on");
  roiRefreshProjections();
}

function resetROI() {
  if (!confirm("Reset the energy accumulator for this session?")) return;
  roiTotalKwh    = 0;
  roiTotalRev    = 0;
  roiActiveTicks = 0;
  roiTotalTicks  = 0;
  roiRevSeries   = [];
  roiTimeSeries  = [];
  roiUpdateCards();
  roiUpdateChart();
  const log = document.getElementById("roiLog");
  if (log) log.innerHTML = '<div class="roi-log-empty">Waiting for live data...</div>';
}
