// Aftershock forecasting via the Modified Omori–Utsu law.
//
// A mainshock's aftershocks decay in rate as  λ(t) = K / (t + c)^p , where t is
// time since the mainshock. We fit (K, c, p) by maximum likelihood on the cluster
// the user clicked, then integrate λ forward to forecast how many more M3+ events
// to expect in the next day / week / month. This is the same family of model the
// USGS uses for its operational aftershock forecasts — applied here to whatever
// cluster you inspect, using only the event times we already have.
import { gcDistKm } from './geo.js';

const DAY = 86400000;

const MMI_ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const forecastModels = [];
let triggerModel = null;

async function loadJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) return null;
  return res.json();
}

export async function loadForecastModel() {
  forecastModels.length = 0;
  const specs = [
    { url: './data/forecast_model_m4.json', role: 'balanced', weight: 1.0 },
    { url: './data/forecast_model_m3.json', role: 'dense', weight: 0.75 },
    { url: './data/forecast_model_m5.json', role: 'strong-context', weight: 0.55 },
  ];
  await Promise.all(specs.map(async spec => {
    try {
      const model = await loadJson(spec.url);
      if (model && Array.isArray(model.cells)) forecastModels.push({ ...spec, model });
    } catch {}
  }));
  try {
    const model = await loadJson('./data/trigger_model.json');
    triggerModel = model && Array.isArray(model.effects) ? model : null;
  } catch {
    triggerModel = null;
  }
  return { forecastModels, triggerModel };
}

function pct(sorted, f) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))] : 0;
}

export function estimateIntensity(mag, depth) {
  // Approximate peak shaking near the epicentral area. This is intentionally a
  // simple MMI proxy; true shaking needs distance, fault geometry, and site soils.
  const raw = 1.4 * mag - 1.6 - Math.log10(Math.max(1, depth)) * 0.45;
  const value = Math.max(1, Math.min(10, raw));
  const rounded = Math.max(1, Math.min(10, Math.round(value)));
  return {
    value,
    label: MMI_ROMAN[rounded - 1],
    text: `MMI ${MMI_ROMAN[rounded - 1]}`,
  };
}

function intensityFromValue(value) {
  const rounded = Math.max(1, Math.min(10, Math.round(value)));
  return {
    value,
    label: MMI_ROMAN[rounded - 1],
    text: `MMI ${MMI_ROMAN[rounded - 1]}`,
  };
}

export function summarizeIntensity(events) {
  const vals = events
    .filter(q => q && q.mag != null && q.depth != null)
    .map(q => estimateIntensity(q.mag, Math.max(1, q.depth)).value)
    .sort((a, b) => a - b);
  return {
    n: vals.length,
    median: intensityFromValue(pct(vals, 0.5)),
    p90: intensityFromValue(pct(vals, 0.9)),
  };
}

// Summarize WHERE future aftershocks are likely: the spatial footprint of the
// sequence relative to its mainshock — typical/outer radius, dominant trend
// (the rupture's strike, from a PCA of epicenters), and depth range.
function aftershockZone(events, main) {
  const cosL = Math.cos(main.lat * Math.PI / 180);
  let sxx = 0, sxy = 0, syy = 0, dMin = Infinity, dMax = -Infinity;
  const dists = [];
  for (const q of events) {
    const e = (q.lon - main.lon) * 111.32 * cosL; // km east of mainshock
    const n = (q.lat - main.lat) * 111.32;        // km north
    sxx += e * e; sxy += e * n; syy += n * n;
    dists.push(gcDistKm(main, q));
    if (q.depth < dMin) dMin = q.depth;
    if (q.depth > dMax) dMax = q.depth;
  }
  dists.sort((a, b) => a - b);
  const pct = f => dists.length ? dists[Math.min(dists.length - 1, Math.floor(f * dists.length))] : 0;
  // major-axis angle of the epicenter cloud → compass azimuth (0–180, bidirectional)
  const ang = 0.5 * Math.atan2(2 * sxy, (sxx - syy) || 1e-9);
  let az = (90 - ang * 180 / Math.PI) % 180; if (az < 0) az += 180;
  const trend = ['N–S', 'NE–SW', 'E–W', 'NW–SE'][Math.round(az / 45) % 4];
  return { dist50: pct(0.5), dist90: pct(0.9), depthMin: dMin, depthMax: dMax, trend, az };
}

// Standard normal via Box–Muller — for spatial jitter of projected aftershocks.
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Draw `count` PLAUSIBLE future aftershocks for a fitted sequence:
//   • time — sampled from the Omori rate over the next 30 days (inverse-CDF), so
//     more land soon after now, tapering off, exactly as the model predicts;
//   • place — bootstrapped from where the real aftershocks fell (pick one, jitter
//     it by a few km), so the synthetic events sit on the actual rupture, not in
//     a fabricated blob. These are illustrative scenarios, not specific predictions.
export function sampleAftershocks(cluster, fit, count) {
  if (!fit || !fit.ok) return [];
  const triggerCount = triggerVisualCount(cluster, fit);
  const sampleCount = Math.min(count, Math.ceil(Math.max(fit.f30 * 12, triggerCount)));
  if (sampleCount < 1) return [];
  const t0 = fit.t0, main = cluster.mainshock;
  const after = cluster.items.filter(q => q.time > t0);
  if (!after.length) return [];

  const { c, p, T } = fit, W = 30; // forecast horizon, days
  const a0 = Math.pow(T + c, 1 - p), a1 = Math.pow(T + W + c, 1 - p);
  const invTime = u => {
    if (p === 1) {
      const lo = Math.log(T + c), hi = Math.log(T + W + c);
      return Math.exp(lo + u * (hi - lo)) - c;
    }
    return Math.pow(a0 + u * (a1 - a0), 1 / (1 - p)) - c;
  };

  const cosL = Math.cos(main.lat * Math.PI / 180);
  const out = [];
  for (let i = 0; i < sampleCount; i++) {
    const t = invTime(Math.random());     // days since mainshock
    const days = Math.max(0, t - T);       // days from catalog-current "now"
    const parent = after[(Math.random() * after.length) | 0];
    const jit = (parent.hErr || 5) * 0.6;  // km
    const intensity = estimateIntensity(parent.mag, Math.max(1, parent.depth));
    out.push({
      lat: parent.lat + (gauss() * jit) / 111.32,
      lon: parent.lon + (gauss() * jit) / (111.32 * cosL),
      depth: Math.max(0, parent.depth),
      mag: parent.mag,
      intensity,
      days,
      tFrac: Math.min(1, days / W),
      place: parent.place,
    });
  }
  out.sort((a, b) => a.days - b.days);
  return out;
}

function regionalAnalogs(cluster, catalog) {
  if (!catalog || !catalog.length || !cluster.mainshock) return [];
  const main = cluster.mainshock;
  const ids = new Set(cluster.items.map(q => q.id));
  const radius = Math.max(250, (fitRadius(cluster) || 50) * 3);
  const out = [];
  for (const q of catalog) {
    if (ids.has(q.id) || q.time >= main.time || q.mag == null) continue;
    const dist = gcDistKm(main, q);
    if (dist <= radius) out.push({ q, dist });
  }
  out.sort((a, b) => a.dist - b.dist || b.q.time - a.q.time);
  return out.slice(0, 300).map(x => x.q);
}

function fitRadius(cluster) {
  if (!cluster.mainshock || cluster.items.length < 2) return 0;
  const dists = cluster.items.map(q => gcDistKm(cluster.mainshock, q)).sort((a, b) => a - b);
  return pct(dists, 0.9);
}

function triggerVisualCount(cluster, fit) {
  const main = cluster.mainshock;
  if (!triggerModel || !main || fit.T > 30 || main.mag < 5) return 0;
  const effect = triggerModel.effects.find(e => e.targetMag === 3 && e.horizonDays === 30);
  if (!effect) return 0;
  let best = null;
  for (const bucket of effect.buckets) {
    if (main.mag >= bucket.initMag && (!best || bucket.initMag > best.initMag)) best = bucket;
  }
  if (!best || !best.p50) return 0;
  return 8 + Math.log1p(best.p50) * 8;
}

function nearbyModelCells(cluster) {
  if (!forecastModels.length || !cluster.mainshock) return [];
  const radius = Math.max(300, (fitRadius(cluster) || 50) * 4);
  const cells = [];
  for (const source of forecastModels) {
    for (const cell of source.model.cells) {
      const dist = gcDistKm(cluster.mainshock, cell);
      if (dist > radius) continue;
      const rate = cell.forecastScore ?? cell.rate30P50 ?? cell.rate30 ?? 0;
      const weight = source.weight * Math.max(0, rate) / Math.pow(1 + dist / 120, 2);
      if (weight > 0) cells.push({ cell, dist, weight, source: source.role });
    }
  }
  cells.sort((a, b) => b.weight - a.weight);
  return cells.slice(0, 160);
}

function weightedPick(items) {
  let total = 0;
  for (const item of items) total += item.weight;
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

export function sampleCatalogInformedAftershocks(cluster, fit, count, catalog) {
  const base = sampleAftershocks(cluster, fit, count);
  if (!base.length) return base;

  const main = cluster.mainshock;
  const after = cluster.items.filter(q => q.time > fit.t0);
  const analogs = regionalAnalogs(cluster, catalog);
  const modelCells = nearbyModelCells(cluster);
  if (!analogs.length && !modelCells.length) return base;

  const cosL = Math.cos(main.lat * Math.PI / 180);
  const combined = after.concat(analogs);
  const mags = combined.map(q => q.mag).sort((a, b) => a - b);
  const magFromDistribution = () => mags.length ? pct(mags, Math.pow(Math.random(), 1.8)) : (main.mag || 3);

  for (const s of base) {
    if (modelCells.length && Math.random() < 0.45) {
      const pickedModel = weightedPick(modelCells);
      const picked = pickedModel.cell;
      const jitterDeg = (picked.cellDeg || 4) * 0.35;
      s.lat = picked.lat + gauss() * jitterDeg;
      s.lon = picked.lon + gauss() * jitterDeg / Math.max(0.2, Math.cos(picked.lat * Math.PI / 180));
      s.depth = Math.max(0, Math.random() < 0.75 ? picked.depth50 : picked.depth90);
      s.place = `${pickedModel.source} model-favored regional cell`;
      s.mag = picked.mag50 + Math.random() * Math.max(0, picked.mag90 - picked.mag50);
    } else if (analogs.length && Math.random() < 0.35) {
      const parent = analogs[(Math.random() * analogs.length) | 0];
      const dist = gcDistKm(main, parent);
      const pull = Math.min(1, 80 / Math.max(1, dist));
      const jit = (parent.hErr || 8) * 0.8;
      s.lat = main.lat + (parent.lat - main.lat) * pull + (gauss() * jit) / 111.32;
      s.lon = main.lon + (parent.lon - main.lon) * pull + (gauss() * jit) / (111.32 * cosL);
      s.depth = Math.max(0, parent.depth);
      s.place = parent.place;
      s.mag = magFromDistribution();
    } else {
      continue;
    }
    s.intensity = estimateIntensity(s.mag, Math.max(1, s.depth));
  }
  return base.sort((a, b) => a.days - b.days);
}

// Fit the Omori–Utsu parameters to one cluster's aftershock sequence.
// `cluster.items` is newest-first; `cluster.mainshock` is its largest event.
// Returns { ok:false } when there aren't enough aftershocks to fit.
export function fitOmori(cluster, nowMs = Date.now()) {
  const main = cluster.mainshock;
  if (!main) return { ok: false, reason: 'no mainshock' };
  const t0 = main.time;

  // aftershocks = events strictly after the mainshock, as days-since-mainshock
  const ts = [];
  for (const q of cluster.items) {
    const dt = (q.time - t0) / DAY;
    if (dt > 0) ts.push(dt);
  }
  if (ts.length < 8) return { ok: false, reason: 'too few aftershocks', n: ts.length };

  ts.sort((a, b) => a - b);
  const n = ts.length;
  const Tobs = ts[n - 1]; // last observed aftershock, in days since mainshock
  const T = Math.max(Tobs, (nowMs - t0) / DAY); // forecast starts from now, not the last event

  // Grid-search (c, p); K is solved analytically for each pair from
  // ∂logL/∂K = 0  ⇒  K = n / ∫₀ᵀ (t+c)^-p dt.
  const integ = (c, p) => p === 1
    ? Math.log((T + c) / c)
    : (Math.pow(T + c, 1 - p) - Math.pow(c, 1 - p)) / (1 - p);

  let best = null;
  for (let pi = 0; pi <= 18; pi++) {
    const p = 0.7 + pi * 0.05; // 0.70 .. 1.60
    for (let ci = 0; ci <= 24; ci++) {
      const c = 0.001 * Math.pow(3 / 0.001, ci / 24); // 0.001 .. 3 days, log-spaced
      const A = integ(c, p);
      if (!(A > 0)) continue;
      const K = n / A;
      // logL = n·ln K − p·Σln(tᵢ+c) − K·A,  and K·A = n
      let sumLn = 0;
      for (const t of ts) sumLn += Math.log(t + c);
      const logL = n * Math.log(K) - p * sumLn - n;
      if (!best || logL > best.logL) best = { K, c, p, logL };
    }
  }
  if (!best) return { ok: false, reason: 'fit failed', n };

  // Expected additional events in (T, T+Δ] = ∫ λ dt over that window.
  const expect = dDays => {
    const { K, c, p } = best;
    const lo = T, hi = T + dDays;
    const I = p === 1
      ? Math.log((hi + c) / (lo + c))
      : (Math.pow(hi + c, 1 - p) - Math.pow(lo + c, 1 - p)) / (1 - p);
    return K * I;
  };

  // WHEN: instantaneous rate at the end of the observed window gives the expected
  // wait to the next event (τ ≈ 1/λ). HOW LIKELY: Poisson P(≥1)=1−e^−N per window.
  const rateNow = best.K / Math.pow(T + best.c, best.p); // events/day
  const tau = rateNow > 0 ? 1 / rateNow : Infinity;      // days to next event
  const f1 = expect(1), f7 = expect(7), f30 = expect(30);
  const prob = N => 1 - Math.exp(-N);

  // WHERE: footprint of the events after the mainshock (fall back to all members).
  const after = cluster.items.filter(q => q.time > t0);
  const basis = after.length ? after : cluster.items;
  const where = aftershockZone(basis, main);
  const intensity = { observed: summarizeIntensity(basis), projected: null };

  return {
    ok: true, n, T, t0, K: best.K, c: best.c, p: best.p, times: ts,
    f1, f7, f30, tau, p1: prob(f1), p7: prob(f7), p30: prob(f30), where, intensity, mainMag: main.mag,
  };
}

// Cumulative model count from the mainshock to time t (days). Used to draw the
// fitted curve and its forward (forecast) extension.
function modelCum(fit, t) {
  const { K, c, p } = fit;
  return p === 1
    ? K * Math.log((t + c) / c)
    : K * (Math.pow(t + c, 1 - p) - Math.pow(c, 1 - p)) / (1 - p);
}

// Draw observed cumulative aftershock count (stepped) against the Omori fit, with
// the fit extended 7 days past the data as a dashed forecast.
export function drawAftershock(canvas, fit) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const padL = 30, padR = 8, padT = 8, padB = 18;

  if (!fit.ok) {
    ctx.fillStyle = '#7f93c0'; ctx.font = '11px system-ui';
    ctx.fillText('not enough aftershocks to fit', padL, H / 2);
    return;
  }

  const horizon = fit.T + 7;              // show 7-day forecast tail
  const yMax = Math.max(fit.n, modelCum(fit, horizon)) * 1.05 || 1;
  const sx = t => padL + (t / horizon) * (W - padL - padR);
  const sy = c => H - padB - (c / yMax) * (H - padT - padB);

  // axes
  ctx.strokeStyle = '#24365c'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, H - padB); ctx.lineTo(W - padR, H - padB); ctx.stroke();
  ctx.fillStyle = '#7f93c0'; ctx.font = '10px system-ui';
  ctx.fillText(String(Math.round(yMax)), 2, padT + 8);
  ctx.fillText('events', 2, padT + 20);
  ctx.fillText(fit.T.toFixed(0) + 'd', sx(fit.T) - 6, H - 5);
  ctx.fillText(horizon.toFixed(0) + 'd', W - padR - 16, H - 5);

  // boundary between observed and forecast
  ctx.strokeStyle = '#33406a'; ctx.setLineDash([2, 3]);
  ctx.beginPath(); ctx.moveTo(sx(fit.T), padT); ctx.lineTo(sx(fit.T), H - padB); ctx.stroke();
  ctx.setLineDash([]);

  // observed cumulative step line
  ctx.strokeStyle = '#cfe0ff'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(sx(0), sy(0));
  fit.times.forEach((t, i) => { ctx.lineTo(sx(t), sy(i)); ctx.lineTo(sx(t), sy(i + 1)); });
  ctx.stroke();

  // Omori model curve: solid over the data, dashed over the forecast window
  const drawCurve = (t0, t1, dash) => {
    ctx.setLineDash(dash); ctx.strokeStyle = '#ffaa33'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i <= 60; i++) {
      const t = t0 + (t1 - t0) * i / 60;
      const x = sx(t), y = sy(modelCum(fit, t));
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke(); ctx.setLineDash([]);
  };
  drawCurve(0, fit.T, []);
  drawCurve(fit.T, horizon, [4, 3]);
}
