// UI controller: wires the DOM panels (sliders, toggles, time window, playback,
// orbit wheel) to the scene and quake layer, and renders the info/status text.
import { state } from './state.js';
import { earthMat, orbitAroundTarget } from './scene.js';
import { build, applyVisualModes, setDepthVisible, setArrowVisible } from './quakeLayer.js';
import { MIN_MAG, YEARS } from './config.js';

// DOM references, populated in initUI().
let el = {};

const fmtDate = ms => new Date(ms).toISOString().slice(0, 10);
const sliderToTime = v => state.tMin + (state.tMax - state.tMin) * (v / 1000);

function setTrack(slider, pct) { slider.style.setProperty('--pct', pct + '%'); }

// Rebuild the quake layer for a set of quakes and refresh the status line.
// Single funnel for the initial load, the time filter, and playback ticks.
export function rebuild(quakes) {
  const stats = build(quakes);
  if (!el.status) return;
  el.status.innerHTML = stats
    ? `<small style="opacity:0.85">showing <b>${stats.count}</b> · ` +
      `ST-DBSCAN: ${stats.clusterCount} clusters · ${stats.noiseCount} noise · ${stats.dbscanMs}ms</small>`
    : `<small style="opacity:0.85">0 quakes in selected range</small>`;
}

// Fill the info panel + time labels once data has loaded.
export function onDataLoaded(res) {
  const loading = document.getElementById('loading');
  if (loading) loading.remove();

  const kb = (res.bytes / 1024).toFixed(0);
  const mode = res.fromCache
    ? `delta fetch: <b>${res.fetched.length}</b> new · ${kb} KB in ${res.seconds}s · ${res.all.length} total cached`
    : `first load: <b>${res.fetched.length}</b> quakes · ${kb} KB CSV in ${res.seconds}s (cached for next visit)`;
  document.getElementById('meta').innerHTML =
    `<b>${res.all.length}</b> quakes · M${MIN_MAG}+ · last ${YEARS}y (USGS CSV)<br>` +
    `range: ${fmtDate(state.tMin)} → ${fmtDate(state.tMax)}<br>` +
    `<small style="opacity:0.85">${mode}</small><br>` +
    `<span style="color:#ff5050;">●</span> newest &nbsp; <span style="color:#33cc66;">●</span> oldest`;

  document.getElementById('time-range').textContent = `${fmtDate(state.tMin)} → ${fmtDate(state.tMax)}`;
  updateTimeLabels();
}

function updateTimeLabels() {
  el.fromVal.textContent = fmtDate(sliderToTime(+el.fromSlider.value));
  el.toVal.textContent = fmtDate(sliderToTime(+el.toSlider.value));
}

function applyTimeFilter() {
  const fromT = sliderToTime(+el.fromSlider.value);
  const toT = sliderToTime(+el.toSlider.value);
  rebuild(state.allQuakes.filter(q => q.time >= fromT && q.time <= toT));
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
  initTimeWindow();
  initPlayback();
  initOrbitWheel();
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
}

// --- from/to time window (rebuild on release; DBSCAN is heavy) ---
function initTimeWindow() {
  [el.fromSlider, el.toSlider].forEach(s => {
    s.addEventListener('input', () => {
      if (+el.fromSlider.value > +el.toSlider.value) {     // keep handles from crossing
        if (s === el.fromSlider) el.toSlider.value = el.fromSlider.value;
        else el.fromSlider.value = el.toSlider.value;
      }
      updateTimeLabels();
      stopPlayback(); // dragging cancels playback
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
  if (endV <= startV) endV = 1000;
  el.toSlider.value = startV;
  updateTimeLabels(); applyTimeFilter();
  el.play.textContent = '❚❚ Pause';
  el.play.classList.add('active');
  playTimer = setInterval(() => {
    const v = Math.min(endV, +el.toSlider.value + 4 + (+el.speed.value));
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
