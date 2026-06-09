// Pointer interaction: hover tooltip, click-to-inspect (detail panel + cluster
// depth cross-section), and double-click-to-focus.
import * as THREE from 'three';
import { camera, earth, setFocus } from './scene.js';
import { getQuakeMeshes, getInstance, getCluster } from './quakeLayer.js';
import { timeColor } from './colors.js';
import { state } from './state.js';
import { fitOmori, drawAftershock } from './forecast.js';
import { startWavefront } from './wavefront.js';
import { showSelection, clearSelection, getGhostPoints, getGhostData, getGhostCount, selectGhostPrediction, setSinglePredictionMode } from './selectionLayer.js';
import { renderWindow } from './ui.js';
import { gcDistKm } from './geo.js';
import { CLUSTER_RECENT, MAX_LINK_DAYS, MAX_LINK_KM } from './config.js';

const ray = new THREE.Raycaster();
ray.params.Mesh = { threshold: 0 };
ray.params.Points = { threshold: 0.012 }; // ghost-aftershock pick radius (scene units)
const mouse = new THREE.Vector2();

// Translate a mouse event into normalized device coords and aim the raycaster.
function aim(e) {
  mouse.x = (e.clientX / innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / innerHeight) * 2 + 1;
  ray.setFromCamera(mouse, camera);
}

export function initInteraction() {
  const tooltip = document.getElementById('tooltip');
  const detailEl = document.getElementById('detail');
  const detailBody = document.getElementById('detail-body');
  const xsection = document.getElementById('xsection');

  // hover → tooltip
  addEventListener('pointermove', (e) => {
    aim(e);
    const hits = ray.intersectObjects(getQuakeMeshes(), false);
    const inst = hits.length ? getInstance(hits[0].instanceId) : null;
    if (inst) {
      const q = inst.quake;
      tooltip.style.display = 'block';
      tooltip.style.left = e.clientX + 'px';
      tooltip.style.top = e.clientY + 'px';
      tooltip.innerHTML =
        `<b>M ${q.mag.toFixed(1)}</b> — ${q.place}<br>` +
        `depth ${q.depth.toFixed(1)} km · ${fmtUtc(q.time)} UTC` + fmtErr(q);
      return;
    }
    // projected aftershock hover (only when a selection is active)
    const ghosts = getGhostPoints();
    if (ghosts) {
      const gh = ray.intersectObject(ghosts, true);
      if (gh.length) {
        const idx = gh[0].object.userData.ghostIndices?.[gh[0].index] ?? gh[0].index;
        const g = getGhostData(idx);
        tooltip.style.display = 'block';
        tooltip.style.left = e.clientX + 'px';
        tooltip.style.top = e.clientY + 'px';
        tooltip.innerHTML =
          `<b>projected aftershock</b><br>` +
          `${g.place || 'near the epicenter'}<br>` +
          `<span style="opacity:.75">in ~${fmtDur(g.days)} · M${g.mag.toFixed(1)} proxy · ${g.depth.toFixed(0)} km deep</span><br>` +
          `<span style="opacity:.75">possible shaking near epicenter: ~${g.intensity.text}</span>`;
        return;
      }
    }
    tooltip.style.display = 'none';
  });

  // click (not drag) → detail + cross-section
  let downX = 0, downY = 0;
  addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; });
  addEventListener('pointerup', (e) => {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return; // it was a drag
    aim(e);
    const hits = ray.intersectObjects(getQuakeMeshes(), false);
    if (!hits.length) return;
    const inst = getInstance(hits[0].instanceId);
    if (!inst) return;
    if (state.waveMode) startWavefront(inst.quake);
    showDetail(detailEl, detailBody, xsection, inst.quake, getCluster(inst.cluster), inst.isMainshock);
  });
  document.getElementById('detail-close').addEventListener('click', () => {
    detailEl.style.display = 'none';
    clearSelection();
  });

  initClusterSequenceControls();

  // right-click a quake → isolate its connected line run and step through it oldest→newest
  addEventListener('contextmenu', (e) => {
    aim(e);
    const hits = ray.intersectObjects(getQuakeMeshes(), false);
    if (!hits.length) return;
    e.preventDefault();
    const inst = getInstance(hits[0].instanceId);
    if (!inst) return;
    showConnectedSequence(inst.quake, getCluster(inst.cluster));
  });

  // double-click globe or quake → set the orbit pivot there
  addEventListener('dblclick', (e) => {
    aim(e);
    const hits = ray.intersectObjects([earth, ...getQuakeMeshes()], false);
    if (hits.length) setFocus(hits[0].point);
  });
}

function connectedRuns(cluster) {
  const recent = cluster.items.slice(0, CLUSTER_RECENT); // newest-first, matching drawn sequence lines
  const maxGapMs = MAX_LINK_DAYS * 86400000;
  const linkable = (a, b) => (a.time - b.time) <= maxGapMs && gcDistKm(a, b) <= MAX_LINK_KM;
  const runs = [];
  if (!recent.length) return runs;
  let run = [recent[0]];
  for (let i = 0; i < recent.length - 1; i++) {
    if (linkable(recent[i], recent[i + 1])) run.push(recent[i + 1]);
    else { runs.push(run); run = [recent[i + 1]]; }
  }
  runs.push(run);
  return runs;
}

function updateClusterSequencePanel() {
  const panel = document.getElementById('cluster-sequence');
  const head = document.getElementById('cluster-sequence-head');
  const info = document.getElementById('cluster-sequence-info');
  const slider = document.getElementById('cluster-sequence-slider');
  const val = document.getElementById('cluster-sequence-val');
  const seq = state.clusterSequence;
  if (!panel || !head || !info || !slider || !val || !seq) return;

  const items = seq.items;
  const q = items[Math.max(0, Math.min(items.length - 1, seq.step - 1))];
  panel.style.display = 'block';
  head.textContent = `Connected sequence · ${items.length} events`;
  slider.max = String(items.length);
  slider.value = String(seq.step);
  val.textContent = `${seq.step}/${items.length}`;
  info.innerHTML = q
    ? `<b>M ${q.mag.toFixed(1)}</b> · ${fmtUtc(q.time)} UTC<br>${q.place}`
    : 'No events';
}

function showConnectedSequence(clicked, cluster) {
  if (!cluster || !cluster.items.length) return;
  const run = connectedRuns(cluster).find(seq => seq.includes(clicked)) || [clicked];
  const items = run.slice().sort((a, b) => a.time - b.time); // play oldest→newest
  state.clusterSequence = { items, step: 1, total: items.length };
  updateClusterSequencePanel();
  renderWindow(state.tMin, state.tMax);
}

function initClusterSequenceControls() {
  const slider = document.getElementById('cluster-sequence-slider');
  const clear = document.getElementById('cluster-sequence-clear');
  if (!slider || !clear) return;
  slider.addEventListener('input', () => {
    const seq = state.clusterSequence;
    if (!seq) return;
    seq.step = +slider.value;
    updateClusterSequencePanel();
    renderWindow(state.tMin, state.tMax);
  });
  clear.addEventListener('click', () => {
    state.clusterSequence = null;
    document.getElementById('cluster-sequence').style.display = 'none';
    renderWindow(state.tMin, state.tMax);
  });
}

function fmtUtc(ms) {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

function fmtLocal(ms) {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(ms));
}

function fmtPredUtc(days) {
  if (!isFinite(days) || !state.tMax) return 'date n/a';
  return fmtLocal(state.tMax + days * 86400000);
}

// Human-friendly duration for the "when" forecast (hours / days / months).
function fmtDur(days) {
  if (!isFinite(days)) return 'n/a';
  const minutes = Math.round(days * 24 * 60);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  if (minutes < 48 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  if (days < 60) return `${days.toFixed(days < 10 ? 1 : 0)} d`;
  return `${(days / 30.44).toFixed(1)} mo`;
}

// Location-uncertainty suffix, e.g. " · ±3.2 km horiz · ±1.8 km depth".
function fmtErr(q) {
  if (q.hErr == null && q.dErr == null) return '';
  const parts = [];
  if (q.hErr != null) parts.push(`±${q.hErr.toFixed(1)} km horiz`);
  if (q.dErr != null) parts.push(`±${q.dErr.toFixed(1)} km depth`);
  return `<br><span style="opacity:0.7">location ${parts.join(' · ')}</span>`;
}

function fmtCount(n) {
  if (!isFinite(n)) return 'n/a';
  if (n < 0.05) return '<0.1';
  if (n < 10) return n.toFixed(1);
  return String(Math.round(n));
}

function fmt24hTimes(fit) {
  if (!fit || !isFinite(fit.f1) || fit.f1 < 0.5) return 'none likely';
  const times = [];
  const expected = Math.min(5, Math.floor(fit.f1));
  const solveDays = n => {
    const { K, c, p, T } = fit;
    if (!(K > 0)) return Infinity;
    if (p === 1) return (T + c) * Math.exp(n / K) - c - T;
    const base = Math.pow(T + c, 1 - p) + (n * (1 - p)) / K;
    return base > 0 ? Math.pow(base, 1 / (1 - p)) - c - T : Infinity;
  };
  for (let i = 1; i <= expected; i++) {
    const days = solveDays(i);
    if (days > 0 && days <= 1) times.push(fmtDur(days));
  }
  if (!times.length && fit.tau <= 1) times.push(fmtDur(fit.tau));
  if (!times.length) return 'none likely';
  const more = Math.max(0, Math.floor(fit.f1) - times.length);
  return more ? `${times.join(', ')} +${more} more` : times.join(', ');
}

function updatePredictionTimeline(index) {
  const slider = document.getElementById('prediction-slider');
  const label = document.getElementById('prediction-timeline-label');
  const count = getGhostCount();
  const i = Math.max(0, Math.min(count - 1, index));
  const g = getGhostData(i);
  if (!g) return;
  slider.value = String(i + 1);
  selectGhostPrediction(i);
  label.innerHTML =
    `<b>${i + 1}/${count}</b> · ${fmtPredUtc(g.days)}<br>` +
    `in ~${fmtDur(g.days)} · M${g.mag.toFixed(1)} · ${g.depth.toFixed(0)} km · ~${g.intensity.text}`;
}

function showPredictionTimeline() {
  const box = document.getElementById('prediction-timeline');
  const slider = document.getElementById('prediction-slider');
  const single = document.getElementById('prediction-single-toggle');
  const count = getGhostCount();
  if (!box || !slider || count < 1) {
    if (box) box.style.display = 'none';
    selectGhostPrediction(null);
    setSinglePredictionMode(false);
    return;
  }
  box.style.display = 'block';
  slider.min = '1';
  slider.max = String(count);
  slider.step = '1';
  slider.oninput = () => updatePredictionTimeline(+slider.value - 1);
  if (single) {
    single.checked = false;
    setSinglePredictionMode(false);
    single.onchange = () => {
      setSinglePredictionMode(single.checked);
      updatePredictionTimeline(+slider.value - 1);
    };
  }
  updatePredictionTimeline(0);
}

function showDetail(detailEl, detailBody, xsection, q, cluster, isMainshock) {
  detailEl.style.display = 'block';
  // Fit the Omori model once and drive both the forecast panel and the 3D
  // overlay (uncertainty ellipsoid + projected aftershocks + zone ring).
  const fit = fitOmori(cluster, state.tMax || Date.now());
  showSelection(q, cluster, fit, state.allQuakes);
  const xcap = document.getElementById('xsection-cap');

  if (!state.fullDetailMode) {
    detailBody.innerHTML = `<b>M ${q.mag.toFixed(1)}</b> — ${q.place}`;
    xsection.style.display = 'none';
    if (xcap) xcap.style.display = 'none';
    showForecast(fit, true);
    return;
  }

  detailBody.innerHTML =
    `<b>M ${q.mag.toFixed(1)}</b> — ${q.place}<br>` +
    `depth <b>${q.depth.toFixed(1)} km</b> · ${fmtUtc(q.time)} UTC<br>` +
    `<small style="opacity:0.85">cluster: ${cluster.items.length} events` +
    (isMainshock ? ' · <span style="color:#ffd24a;">mainshock</span>' : '') +
    (cluster.noise ? ' · isolated (noise)' : '') + '</small>' +
    fmtErr(q);
  xsection.style.display = 'block';
  if (xcap) xcap.style.display = 'block';
  drawCrossSection(xsection, cluster.items, q);
  showForecast(fit, false);
}

// Render the forecast text + cumulative chart from a precomputed Omori fit.
// Hidden for clusters too small to fit.
function showForecast(fit, compact = false) {
  const fc = document.getElementById('forecast');
  const cap = document.getElementById('aftershock-cap');
  const txt = document.getElementById('forecast-text');
  const canvas = document.getElementById('aftershock');
  if (!fit.ok) {
    if (!compact) { fc.style.display = 'none'; return; }
    fc.style.display = 'block';
    txt.innerHTML = `<span style="opacity:.7">forecast:</span> not enough recent sequence data`;
    canvas.style.display = 'none';
    cap.style.display = 'none';
    showPredictionTimeline();
    return;
  }
  fc.style.display = 'block';
  canvas.style.display = compact ? 'none' : 'block';
  cap.style.display = compact ? 'none' : 'block';
  cap.textContent = `aftershock rate · Omori–Utsu p=${fit.p.toFixed(2)} c=${fit.c.toFixed(2)}d`;
  const w = fit.where;
  const intensity = fit.intensity.projected || fit.intensity.observed;
  const intensitySource = fit.intensity.projected ? 'projected samples' : 'observed cluster events';
  const pct = x => x * 100 >= 99.5 ? '>99' : Math.round(x * 100);
  if (compact) {
    txt.innerHTML =
      `<span style="opacity:.7">next:</span> M3+ in ~<b>${fmtDur(fit.tau)}</b><br>` +
      `<span style="opacity:.7">24h times:</span> <b>${fmt24hTimes(fit)}</b><br>` +
      `<span style="opacity:.7">odds/count:</span> ` +
      `24h <b>${pct(fit.p1)}%</b>/${fmtCount(fit.f1)} · ` +
      `7d <b>${pct(fit.p7)}%</b>/${fmtCount(fit.f7)} · ` +
      `30d <b>${pct(fit.p30)}%</b>/${fmtCount(fit.f30)} ` +
      `<span style="opacity:.6">(≥1 more M3+)</span>`;
    showPredictionTimeline();
    return;
  }
  txt.innerHTML =
    `<b>${fit.n}</b> aftershocks since the M${fit.mainMag.toFixed(1)} mainshock<br>` +
    `<span style="opacity:.7">when:</span> next M3+ in ~<b>${fmtDur(fit.tau)}</b><br>` +
    `<span style="opacity:.7">24h predicted times:</span> <b>${fmt24hTimes(fit)}</b><br>` +
    `<span style="opacity:.7">how likely:</span> ` +
    `<b>${pct(fit.p1)}%</b> / ${fmtCount(fit.f1)} in 24h · ` +
    `<b>${pct(fit.p7)}%</b> / ${fmtCount(fit.f7)} in 7d · ` +
    `<b>${pct(fit.p30)}%</b> / ${fmtCount(fit.f30)} in 30d ` +
    `<span style="opacity:.6">(≥1 more M3+)</span><br>` +
    `<span style="opacity:.7">possible intensity:</span> median ~<b>${intensity.median.text}</b> · p90 ~<b>${intensity.p90.text}</b> ` +
    `<span style="opacity:.6">from ${intensity.n} ${intensitySource} near epicentral area</span><br>` +
    `<span style="opacity:.7">where:</span> within ~<b>${w.dist90.toFixed(0)} km</b> of the epicenter · ` +
    `${w.trend}-trending · ${w.depthMin.toFixed(0)}–${w.depthMax.toFixed(0)} km deep`;
  showPredictionTimeline();
  drawAftershock(canvas, fit);
}

// Project a cluster onto its principal horizontal axis and plot depth vs. that
// distance — a side view that reveals fault / subduction dip.
function drawCrossSection(canvas, items, clicked) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const padL = 34, padR = 10, padT = 10, padB = 22;

  let clat = 0, clon = 0;
  for (const q of items) { clat += q.lat; clon += q.lon; }
  clat /= items.length; clon /= items.length;
  const cosL = Math.cos(clat * Math.PI / 180);
  const pts = items.map(q => ({
    e: (q.lon - clon) * 111.32 * cosL, // km east
    n: (q.lat - clat) * 111.32,        // km north
    d: q.depth, q,
  }));

  // PCA on (e, n) → principal horizontal axis angle
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) { sxx += p.e * p.e; sxy += p.e * p.n; syy += p.n * p.n; }
  const ang = 0.5 * Math.atan2(2 * sxy, (sxx - syy) || 1e-9);
  const ax = Math.cos(ang), ay = Math.sin(ang);
  for (const p of pts) p.x = p.e * ax + p.n * ay; // along-strike distance

  let xmin = Infinity, xmax = -Infinity, dmax = 0;
  for (const p of pts) { xmin = Math.min(xmin, p.x); xmax = Math.max(xmax, p.x); dmax = Math.max(dmax, p.d); }
  const xspan = (xmax - xmin) || 1, dspan = dmax || 1;
  const sx = v => padL + (v - xmin) / xspan * (W - padL - padR);
  const sy = d => padT + d / dspan * (H - padT - padB);

  // axes
  ctx.strokeStyle = '#24365c'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, H - padB); ctx.lineTo(W - padR, H - padB); ctx.stroke();
  ctx.fillStyle = '#7f93c0'; ctx.font = '10px system-ui';
  ctx.fillText('0', 6, padT + 8);
  ctx.fillText(dmax.toFixed(0) + 'km', 2, H - padB);
  ctx.fillText(xspan.toFixed(0) + ' km along strike', padL + 4, H - 6);

  // location-uncertainty whiskers: ±horizontalError along strike, ±depthError in
  // depth — turns the scatter into an error-bar cloud (faint, behind the dots).
  ctx.strokeStyle = 'rgba(143,182,255,0.28)'; ctx.lineWidth = 1;
  for (const p of pts) {
    const h = p.q.hErr, d = p.q.dErr;
    if (h == null && d == null) continue;
    ctx.beginPath();
    if (h != null) { ctx.moveTo(sx(p.x - h), sy(p.d)); ctx.lineTo(sx(p.x + h), sy(p.d)); }
    if (d != null) { ctx.moveTo(sx(p.x), sy(Math.max(0, p.d - d))); ctx.lineTo(sx(p.x), sy(p.d + d)); }
    ctx.stroke();
  }

  // points, colored by recency within this cluster (newest-first)
  const newest = items[0].time, oldest = items[items.length - 1].time;
  const span = Math.max(1, newest - oldest);
  for (const p of pts) {
    const c = timeColor((newest - p.q.time) / span);
    const isClicked = p.q === clicked;
    ctx.beginPath();
    ctx.arc(sx(p.x), sy(p.d), isClicked ? 5 : 3, 0, Math.PI * 2);
    ctx.fillStyle = `rgb(${(c.r * 255) | 0},${(c.g * 255) | 0},${(c.b * 255) | 0})`;
    ctx.fill();
    if (isClicked) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); }
  }
}
