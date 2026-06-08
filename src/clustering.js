// Spatio-temporal DBSCAN (ST-DBSCAN).
import { gcDistKm } from './geo.js';

/**
 * Cluster quakes that are close in BOTH space and time.
 *
 * Two quakes are neighbors only if great-circle distance <= epsKm AND
 * |dt| <= epsDays. Clusters grow transitively from dense cores (>= minPts
 * neighbors), so continuous seismicity stays grouped while a region that goes
 * quiet for > epsDays and reactivates forms a separate cluster. Points that are
 * never density-reachable are "noise" and returned as singleton clusters so
 * they still render.
 *
 * @returns {{clusters: Array<{items, noise, center}>, clusterCount: number, noiseCount: number}}
 */
export function stDbscanCluster(quakes, epsKm, epsDays, minPts) {
  const n = quakes.length;
  const epsMs = epsDays * 86400000;

  // Adjacency in one O(n^2/2) pass — fine for ~8k points. Cheap temporal test
  // first, then the costlier great-circle distance.
  const adj = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(quakes[i].time - quakes[j].time) <= epsMs &&
          gcDistKm(quakes[i], quakes[j]) <= epsKm) {
        adj[i].push(j); adj[j].push(i);
      }
    }
  }

  const UNVISITED = -1, NOISE = -2;
  const labels = new Array(n).fill(UNVISITED);
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

  const clusters = Array.from({ length: cid }, () => ({ items: [], noise: false }));
  const noiseItems = [];
  for (let i = 0; i < n; i++) {
    if (labels[i] >= 0) clusters[labels[i]].items.push(quakes[i]);
    else noiseItems.push(quakes[i]);
  }
  for (const q of noiseItems) clusters.push({ items: [q], noise: true });

  // mean lat/lon center per cluster (handy for labels / debugging)
  for (const c of clusters) {
    let sLat = 0, sLon = 0;
    for (const q of c.items) { sLat += q.lat; sLon += q.lon; }
    c.center = { lat: sLat / c.items.length, lon: sLon / c.items.length };
  }

  return { clusters, clusterCount: cid, noiseCount: noiseItems.length };
}
