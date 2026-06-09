// UI controller: wires the DOM panels (sliders, toggles, time window, playback,
// orbit wheel) to the scene and quake layer, and renders the info/status text.
import { state } from './state.js';
import { earthMat, orbitAroundTarget } from './scene.js';
import { applyWindow, applyVisualModes, setDepthVisible, setArrowVisible } from './quakeLayer.js';
import { clearWavefront } from './wavefront.js';
import { MIN_MAG, YEARS } from './config.js';

// DOM references, populated in initUI().
let el = {};

// From/To sliders run 0..SLIDER_MAX. 10000 steps over the 5-year span is ~4h per
// step, fine enough that preset boundaries (e.g. Jan 1) don't visibly round off.
// Must match the max= on #from-slider / #to-slider in index.html.
const SLIDER_MAX = 10000;

const fmtDate = ms => new Date(ms).toISOString().slice(0, 10);
const sliderToTime = v => state.tMin + (state.tMax - state.tMin) * (v / SLIDER_MAX);
// Inverse of sliderToTime: map an absolute time to a slider position, clamped to
// the loaded range. Used by the quick-range preset buttons. Rounds up so the
// resulting time never falls before `t` — keeps a start-of-day preset (e.g. Jun 1)
// from displaying the previous day when it lands between step boundaries.
const timeToSlider = t => {
  const span = state.tMax - state.tMin;
  if (span <= 0) return 0;
  return Math.max(0, Math.min(SLIDER_MAX, Math.ceil((t - state.tMin) / span * SLIDER_MAX)));
};

// Start-of-period for the quick-range presets, computed in UTC so the boundary
// matches the UTC dates shown everywhere else in the UI (fmtDate). The "To" edge
// always snaps to the newest loaded event (slider 1000); these set "From".
function presetStart(range) {
  const d = new Date();
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  if (range === 'today') return Date.UTC(y, m, day);
  if (range === 'week')  return Date.UTC(y, m, day) - ((d.getUTCDay() + 6) % 7) * 86400000; // back to Monday
  if (range === 'month') return Date.UTC(y, m, 1);
  if (range === 'year')  return Date.UTC(y, 0, 1);
  return state.tMin; // 'all'
}

function setTrack(slider, pct) { slider.style.setProperty('--pct', pct + '%'); }

// Render a time window over the already-clustered catalog and refresh the status
// line. Single funnel for the initial load, the time filter, and playback ticks.
// No clustering happens here — that ran once in setCatalog — so this is cheap.
export function renderWindow(fromT, toT) {
  const stats = applyWindow(fromT, toT);
  if (!el.status) return;
  el.status.innerHTML = stats && stats.count
    ? `<small style="opacity:0.85">showing <b>${stats.count}</b> · ` +
      `${stats.clusterCount} clusters · ${stats.noiseCount} noise · ` +
      `cluster ${stats.clusterMs}ms · window ${stats.windowMs}ms</small>`
    : `<small style="opacity:0.85">0 quakes in selected range</small>`;
}

// Fill the info panel + time labels once data has loaded.
export function onDataLoaded(res) {
  const loading = document.getElementById('loading');
  if (loading) loading.remove();

  const kb = (res.bytes / 1024).toFixed(0);
  const source = res.fromBaked ? 'hourly snapshot' : 'cache';
  const mode = res.fromCache
    ? `${source} + <b>${res.fetched}</b> new · ${kb} KB in ${res.seconds}s · ${res.all.length} total`
    : `first load: <b>${res.fetched}</b> quakes · ${kb} KB CSV in ${res.seconds}s (cached for next visit)`;
  const progress = res.isFinal ? '' : ' <span style="color:#ffcc44;">· loading more…</span>';
  document.getElementById('meta').innerHTML =
    `<b>${res.all.length}</b> quakes · M${MIN_MAG}+ · last ${YEARS}y (USGS CSV)<br>` +
    `range: ${fmtDate(state.tMin)} → ${fmtDate(state.tMax)}<br>` +
    `<small style="opacity:0.85">${mode}${progress}</small><br>` +
    `<span style="color:#ff5050;">●</span> newest &nbsp; <span style="color:#33cc66;">●</span> oldest`;

  document.getElementById('time-range').textContent = `${fmtDate(state.tMin)} → ${fmtDate(state.tMax)}`;
  updateTimeLabels();
}

function updateTimeLabels() {
  el.fromVal.textContent = fmtDate(sliderToTime(+el.fromSlider.value));
  el.toVal.textContent = fmtDate(sliderToTime(+el.toSlider.value));
}

function applyTimeFilter() {
  renderWindow(sliderToTime(+el.fromSlider.value), sliderToTime(+el.toSlider.value));
}

// Attach every control listener. Call once, after the DOM exists.
export function initUI() {
  el = {
    status:     document.getElementById('status'),
    opacity:    document.getElementById('opacity-slider'),
    opacityVal: document.getElementById('opacity-val'),
    size:       document.getElementById('size-slider'),
    sizeVal:    document.getElementById('size-val'),
    orbit:      document.getElementById('orbit-slider'),
    orbitVal:   document.getElementById('orbit-val'),
    fromSlider: document.getElementById('from-slider'),
    toSlider:   document.getElementById('to-slider'),
    fromVal:    document.getElementById('from-val'),
    toVal:      document.getElementById('to-val'),
    play:       document.getElementById('play-btn'),
    speed:      document.getElementById('speed-slider'),
  };

  initRenderSliders();
  initToggles();
  initMagFilters();
  initTimePresets();
  initTimeWindow();
  initPlayback();
  initOrbitWheel();
}

// --- quick time-range presets (Today / This week / This month / This year / All) ---
function clearPresetActive() {
  document.querySelectorAll('#preset-row .btn.active').forEach(b => b.classList.remove('active'));
}
function initTimePresets() {
  const row = document.getElementById('preset-row');
  if (!row) return;
  row.addEventListener('click', e => {
    const btn = e.target.closest('button[data-range]');
    if (!btn) return;
    const fromT = btn.dataset.range === 'all' ? state.tMin : presetStart(btn.dataset.range);
    el.fromSlider.value = timeToSlider(fromT);
    el.toSlider.value = SLIDER_MAX;
    clearPresetActive();
    btn.classList.add('active');
    stopPlayback();          // a preset cancels any running playback
    updateTimeLabels();
    applyTimeFilter();
  });
}

// --- magnitude band checkboxes (M3..M8+): pure visibility filter ---
function initMagFilters() {
  const box = document.getElementById('mag-filters');
  if (!box) return;
  box.addEventListener('change', e => {
    const cb = e.target;
    if (!cb.dataset || cb.dataset.mag === undefined) return;
    const band = +cb.dataset.mag;
    if (cb.checked) state.visMags.add(band); else state.visMags.delete(band);
    applyTimeFilter(); // re-render the current window with the new filter
  });
}

// --- globe opacity + quake size ---
function initRenderSliders() {
  el.opacity.addEventListener('input', () => {
    earthMat.opacity = el.opacity.value / 100;
    setTrack(el.opacity, el.opacity.value);
    el.opacityVal.textContent = el.opacity.value + '%';
  });
  setTrack(el.opacity, el.opacity.value);

  // 1 => ~point, 50 => baseline, 100 => 2x baseline
  el.size.addEventListener('input', () => {
    state.sizeMult = el.size.value / 50;
    applyVisualModes();
    setTrack(el.size, el.size.value);
    el.sizeVal.textContent = el.size.value;
  });
  setTrack(el.size, el.size.value);
}

// --- depth lines / mainshock focus / direction arrows ---
function initToggles() {
  document.getElementById('depth-toggle').addEventListener('change', e => setDepthVisible(e.target.checked));
  document.getElementById('mainshock-toggle').addEventListener('change', e => {
    state.mainshockMode = e.target.checked;
    applyVisualModes();
  });
  document.getElementById('arrow-toggle').addEventListener('change', e => setArrowVisible(e.target.checked));
  document.getElementById('wave-toggle').addEventListener('change', e => {
    state.waveMode = e.target.checked;
    if (!e.target.checked) clearWavefront(); // turning it off stops any running sweep
  });
  document.getElementById('detail-toggle').addEventListener('change', e => {
    state.fullDetailMode = e.target.checked;
  });
}

// --- from/to time window (re-render on release; no clustering, just show/hide) ---
function initTimeWindow() {
  [el.fromSlider, el.toSlider].forEach(s => {
    s.addEventListener('input', () => {
      if (+el.fromSlider.value > +el.toSlider.value) {     // keep handles from crossing
        if (s === el.fromSlider) el.toSlider.value = el.fromSlider.value;
        else el.fromSlider.value = el.toSlider.value;
      }
      updateTimeLabels();
      clearPresetActive(); // manual drag means we're no longer on a preset
      stopPlayback();      // dragging cancels playback
    });
    s.addEventListener('change', applyTimeFilter);
  });
}

// --- time-lapse playback: sweep the "To" edge forward across the window ---
let playTimer = null;
function stopPlayback() {
  if (playTimer) { clearInterval(playTimer); playTimer = null; }
  el.play.textContent = '▶ Play';
  el.play.classList.remove('active');
}
function startPlayback() {
  const startV = +el.fromSlider.value;
  let endV = +el.toSlider.value;
  if (endV <= startV) endV = SLIDER_MAX;
  el.toSlider.value = startV;
  updateTimeLabels(); applyTimeFilter();
  el.play.textContent = '❚❚ Pause';
  el.play.classList.add('active');
  playTimer = setInterval(() => {
    const v = Math.min(endV, +el.toSlider.value + (4 + (+el.speed.value)) * 10);
    el.toSlider.value = v;
    updateTimeLabels(); applyTimeFilter();
    if (v >= endV) stopPlayback();
  }, 110);
}
function initPlayback() {
  el.play.addEventListener('click', () => { playTimer ? stopPlayback() : startPlayback(); });
}

// --- orbit jog-wheel: spin around the focus point, re-center on release ---
function initOrbitWheel() {
  let last = 0;
  el.orbit.addEventListener('input', () => {
    const v = +el.orbit.value;
    orbitAroundTarget((v - last) * Math.PI / 180);
    last = v;
    setTrack(el.orbit, (v + 180) / 360 * 100);
    el.orbitVal.textContent = v + '°';
  });
  el.orbit.addEventListener('change', () => {
    el.orbit.value = 0; last = 0;
    setTrack(el.orbit, 50);
    el.orbitVal.textContent = 'dbl-click to focus';
  });
  setTrack(el.orbit, 50);
}
