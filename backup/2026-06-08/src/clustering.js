// Spatio-temporal DBSCAN (ST-DBSCAN), factored so the clustering is computed
// ONCE over the full catalog and then reused. The layer no longer re-clusters
// on every time-window change — it just shows/hides already-labeled points.
//
// Three entry points:
//   clusterLabels()      — full clustering of a catalog → per-quake labels.
//   incrementalLabels()  — reuse old labels, recompute only the region touched
//                          by newly added events (for delta-fetch reloads).
//   labelsToClusters()   — turn a labels array into the {clusters,...} shape the
//                          render layer consumes.
import { gcDistKm } from './geo.js';

const DEG2KM = 111.32;          // km per degree of latitude
const DEG = Math.PI / 180;

// label sentinels used internally by the DBSCAN expansion
const UNVISITED = -1, NOISE = -2;

/**
 * Cluster quakes that are close in BOTH space and time, returning a per-quake
 * label array: labels[i] >= 0 is a cluster id, labels[i] === -1 is noise.
 *
 * Two quakes are neighbors only if great-circle distance <= epsKm AND
 * |dt| <= epsDays. Clusters grow transitively from dense cores (>= minPts
 * neighbors). Neighbors are found via a spatio-temporal hash grid, but the exact
 * temporal + great-circle tests still decide every edge, so results match a
 * brute-force O(n^2) pass.
 *
 * @returns {Int32Array} labels aligned to `quakes` (cluster id, or -1 for noise)
 */
export function clusterLabels(quakes, epsKm, epsDays, minPts) {
  const n = quakes.length;
  if (n <= 1) return new Int32Array(n).fill(-1);
  // Grid-based DBSCAN with on-demand neighbor queries. We deliberately do NOT
  // materialize a full adjacency list: at M3 scale a dense aftershock sequence
  // (tens of thousands of events in one 300km/90day box) has O(k^2) edges, which
  // would be gigabytes. Querying neighbors on demand keeps memory at O(n).
  const grid = buildGrid(quakes, n, epsKm, epsDays * 86400000);
  return dbscanGrid(grid, n, minPts);
}

/**
 * Incrementally refresh labels after `addedIdx` (indices into `quakes`) appeared
 * since `prevLabels` was computed. Only the spatio-temporal neighborhood reached
 * from the new events is re-clustered; every other point keeps its old label.
 *
 * Correctness: we grow an ε-closure from the added points — the set of points
 * reachable by following neighbor edges. By construction no ε-edge crosses out of
 * that set, so the points outside it cluster independently and their old labels
 * stay exact; the points inside it are re-clustered from scratch (their full
 * neighbor counts all lie inside the closed set, so core/border decisions are
 * exact too). Untouched clusters are therefore untouched; only clusters a new
 * event can actually reach get rebuilt, and bridged clusters merge correctly.
 *
 * Caveat: this handles ADDED events, not removals. Dropping an old event can in
 * principle split a cluster; callers should do a periodic full re-cluster as the
 * correctness backstop (we do one whenever no prior labels exist).
 *
 * @param {Array} quakes        current full catalog
 * @param {Int32Array|Array} prevLabels  old labels aligned to `quakes` (added slots ignored)
 * @param {number[]} addedIdx   indices of the newly added events
 * @returns {Int32Array} fresh labels aligned to `quakes`
 */
export function incrementalLabels(quakes, prevLabels, addedIdx, epsKm, epsDays, minPts) {
  const n = quakes.length;
  if (!addedIdx.length) return Int32Array.from(prevLabels);

  const epsMs = epsDays * 86400000;
  const grid = buildGrid(quakes, n, epsKm, epsMs);

  // ε-closure BFS from the added events → the affected region.
  const affected = new Uint8Array(n);
  const stack = [];
  for (const i of addedIdx) if (!affected[i]) { affected[i] = 1; stack.push(i); }
  while (stack.length) {
    const i = stack.pop();
    const nb = grid.query(i);
    for (let k = 0; k < nb.length; k++) {
      const j = nb[k];
      if (!affected[j]) { affected[j] = 1; stack.push(j); }
    }
  }

  const idx = [];
  for (let i = 0; i < n; i++) if (affected[i]) idx.push(i);

  // If the closure ballooned, incremental no longer pays off. Because the
  // temporal eps chains events 90 days apart, a new event in a continuously
  // active region (e.g. California) can reach that region's whole multi-year
  // catalog — tens of thousands of points — and building O(k^2) local adjacency
  // for them costs MORE than a clean full pass. So bail to the bounded, O(n)
  // grid clustering, which re-labels everything correctly from scratch.
  if (idx.length > 4000) return dbscanGrid(grid, n, minPts);

  // Re-cluster just the affected points. Build local adjacency among them; by
  // closure every neighbor of an affected point is itself affected, so this is
  // an exact DBSCAN restricted to a self-contained sub-catalog.
  const local = new Map();
  idx.forEach((g, l) => local.set(g, l));
  const adj = Array.from({ length: idx.length }, () => []);
  for (let l = 0; l < idx.length; l++) {
    const nb = grid.query(idx[l]);
    for (let k = 0; k < nb.length; k++) {
      const lj = local.get(nb[k]);
      if (lj !== undefined && lj > l) { adj[l].push(lj); adj[lj].push(l); }
    }
  }
  const localLabels = dbscan(adj, idx.length, minPts);

  // Splice back: untouched points keep prevLabels; affected points get fresh ids
  // placed above the highest surviving untouched id so nothing collides.
  let maxUntouched = -1;
  for (let i = 0; i < n; i++) if (!affected[i] && prevLabels[i] > maxUntouched) maxUntouched = prevLabels[i];
  const out = Int32Array.from(prevLabels);
  const base = maxUntouched + 1;
  for (let l = 0; l < idx.length; l++) {
    const lab = localLabels[l];
    out[idx[l]] = lab < 0 ? -1 : base + lab;
  }
  return out;
}

/**
 * Group a labels array into the cluster objects the render layer wants. Noise
 * points (label -1) become singleton clusters flagged `noise:true` so they still
 * render. `clusterCount` counts real (non-noise) clusters only.
 *
 * @returns {{clusters: Array<{items, noise, center}>, clusterCount, noiseCount}}
 */
export function labelsToClusters(quakes, labels) {
  const n = quakes.length;
  let maxId = -1;
  for (let i = 0; i < n; i++) if (labels[i] > maxId) maxId = labels[i];

  const clusters = Array.from({ length: maxId + 1 }, () => ({ items: [], noise: false }));
  let noiseCount = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] >= 0) clusters[labels[i]].items.push(quakes[i]);
    else { clusters.push({ items: [quakes[i]], noise: true }); noiseCount++; }
  }
  const clusterCount = maxId + 1;

  // mean lat/lon center per cluster (handy for labels / debugging)
  for (const c of clusters) {
    let sLat = 0, sLon = 0;
    for (const q of c.items) { sLat += q.lat; sLon += q.lon; }
    c.center = { lat: sLat / c.items.length, lon: sLon / c.items.length };
  }
  return { clusters, clusterCount, noiseCount };
}

/**
 * DBSCAN over a grid that answers neighbor queries on demand (grid.query(i)),
 * without ever storing the full adjacency list. Memory is O(n): a label array, a
 * "queued" bitmap, and one reused frontier queue that holds at most the current
 * cluster's points (the bitmap dedups, so each point is enqueued once). This is
 * what lets full clustering scale to the M3 catalog without exhausting memory.
 *
 * minPts counts a point's OTHER neighbors (self excluded), matching query()'s
 * output and the old adjacency-based path.
 */
function dbscanGrid(grid, n, minPts) {
  const labels = new Int32Array(n).fill(UNVISITED);
  const queued = new Uint8Array(n);
  const queue = [];
  let cid = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] !== UNVISITED) continue;
    const seeds = grid.query(i);
    if (seeds.length < minPts) { labels[i] = NOISE; continue; } // not a core point
    labels[i] = cid;
    queue.length = 0;
    for (let k = 0; k < seeds.length; k++) {
      const j = seeds[k];
      if (!queued[j]) { queued[j] = 1; queue.push(j); }
    }
    for (let qi = 0; qi < queue.length; qi++) {
      const j = queue[qi];
      if (labels[j] === NOISE) { labels[j] = cid; continue; } // border point
      if (labels[j] !== UNVISITED) continue;
      labels[j] = cid;
      const nbj = grid.query(j);
      if (nbj.length >= minPts) {                              // core → expand
        for (let k = 0; k < nbj.length; k++) {
          const m = nbj[k];
          if (!queued[m] && labels[m] === UNVISITED) { queued[m] = 1; queue.push(m); }
        }
      }
    }
    cid++;
  }
  for (let i = 0; i < n; i++) if (labels[i] === NOISE) labels[i] = -1; // normalize
  return labels;
}

// Core DBSCAN expansion over a prebuilt adjacency list → labels (-1 = noise).
// Used by the incremental path, which builds adjacency for a small affected
// subset where the O(k^2) memory of a full list is a non-issue.
function dbscan(adj, n, minPts) {
  const labels = new Int32Array(n).fill(UNVISITED);
  let cid = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] !== UNVISITED) continue;
    if (adj[i].length < minPts) { labels[i] = NOISE; continue; }
    labels[i] = cid;
    const queue = adj[i].slice();
    while (queue.length) {
      const j = queue.pop();
      if (labels[j] === NOISE) { labels[j] = cid; continue; } // border point
      if (labels[j] !== UNVISITED) continue;
      labels[j] = cid;
      if (adj[j].length >= minPts) for (const k of adj[j]) queue.push(k);
    }
    cid++;
  }
  for (let i = 0; i < n; i++) if (labels[i] === NOISE) labels[i] = -1; // normalize
  return labels;
}

/**
 * Build a spatio-temporal hash grid and return a `query(i)` that lists the exact
 * spatio-temporal neighbors of one point. Both full clustering (dbscanGrid) and
 * the incremental path probe neighbors through this, so neither has to scan the
 * whole catalog.
 *
 * Quakes are binned into cells of ~epsKm in latitude/longitude and epsDays in
 * time. A true neighbor (≤ epsKm AND ≤ epsDays) can only fall in the same or an
 * adjacent cell. Longitude cells get physically narrower toward the poles, so the
 * longitude search width is widened by 1/cos(lat) (worst-case latitude in the
 * band) and wraps across the ±180° antimeridian. The exact tests guarantee
 * correctness; the grid only prunes.
 */
function buildGrid(quakes, n, epsKm, epsMs) {
  const cellDeg = epsKm / DEG2KM;
  const nLon = Math.max(1, Math.ceil(360 / cellDeg));

  let tMin = Infinity;
  for (let i = 0; i < n; i++) if (quakes[i].time < tMin) tMin = quakes[i].time;

  const latIdx  = lat => Math.floor((lat + 90) / cellDeg);
  const lonIdx  = lon => (((Math.floor((lon + 180) / cellDeg)) % nLon) + nLon) % nLon;
  const timeIdx = t   => Math.floor((t - tMin) / epsMs);
  const key = (ti, li, loi) => ti + ':' + li + ':' + loi;

  const grid = new Map();
  for (let i = 0; i < n; i++) {
    const q = quakes[i];
    const k = key(timeIdx(q.time), latIdx(q.lat), lonIdx(q.lon));
    let bucket = grid.get(k);
    if (!bucket) grid.set(k, (bucket = []));
    bucket.push(i);
  }

  const half = nLon >> 1;
  function query(i) {
    const q = quakes[i];
    const li = latIdx(q.lat), loi = lonIdx(q.lon), ti = timeIdx(q.time);

    const bandMaxAbsLat = Math.min(89.9, Math.max(
      Math.abs((li - 1) * cellDeg - 90),
      Math.abs((li + 2) * cellDeg - 90)
    ));
    const cosMin = Math.max(0.02, Math.cos(bandMaxAbsLat * DEG));
    let lonRange = Math.ceil(1 / cosMin) + 1;
    if (lonRange > half) lonRange = half;

    const out = [];
    const seen = new Set();
    for (let dt = -1; dt <= 1; dt++) {
      for (let dl = -1; dl <= 1; dl++) {
        for (let dn = -lonRange; dn <= lonRange; dn++) {
          const loj = (((loi + dn) % nLon) + nLon) % nLon;
          const k = key(ti + dt, li + dl, loj);
          if (seen.has(k)) continue;
          seen.add(k);
          const bucket = grid.get(k);
          if (!bucket) continue;
          for (const j of bucket) {
            if (j === i) continue;
            const o = quakes[j];
            if (Math.abs(q.time - o.time) <= epsMs && gcDistKm(q, o) <= epsKm) out.push(j);
          }
        }
      }
    }
    return out;
  }
  return { query };
}
