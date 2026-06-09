// The quake layer.
//
// Clustering is the expensive step, so it runs ONCE per catalog (setCatalog),
// not on every time-window change. The time window is then a cheap show/hide:
// applyWindow() picks the visible subset of the already-clustered catalog and
// rebuilds only the lightweight render geometry (instance matrices + lines) —
// no DBSCAN. That makes scrubbing and playback smooth even at 80k events.
//
// A cluster keeps its identity as you scrub: membership is decided on the full
// catalog, and the window only chooses which members are drawn (rather than
// re-clustering a subset, which would make clusters fragment as points drop out).
import * as THREE from 'three';
import { scene } from './scene.js';
import { state } from './state.js';
import { latLonDepthToVec3, gcDistKm } from './geo.js';
import { timeColor, clusterLineColor } from './colors.js';
import { clusterLabels, incrementalLabels, labelsToClusters } from './clustering.js';
import {
  CLUSTER_KM, CLUSTER_DAYS, DBSCAN_MIN_PTS,
  MAX_LINK_KM, MAX_LINK_DAYS, CLUSTER_RECENT,
} from './config.js';

const quakeGroup = new THREE.Group();
scene.add(quakeGroup);

// All quakes render as ONE InstancedMesh (a single draw call). It's allocated to
// the full catalog size in setCatalog; applyWindow writes the visible prefix and
// sets `.count` so only those instances draw. `instances` holds the per-quake
// render record for the *currently visible* set, in instanceId order, so a
// raycast hit's instanceId maps straight back to its record.
let quakePoints = null;     // THREE.InstancedMesh | null
const instances = [];       // visible-only: [{ quake, cluster, color, baseSize, isMainshock, pos }]

// Full-catalog clustering — the source of truth, computed once per load.
let clusters = [];          // [{ items (newest-first), noise, center, mainshock }] sorted by size
let catalogSize = 0;
let lastClusterMs = 0;

// toggleable line layers, rebuilt each window
let depthLines = null, seqLines = null, arrowLines = null;

const _dummy = new THREE.Object3D(); // scratch for composing instance matrices

// expose live references to the interaction layer
export function getQuakeMeshes() { return quakePoints ? [quakePoints] : []; }
export function getInstance(id) { return instances[id]; }
export function getCluster(i) { return clusters[i]; }

// sphere radius from magnitude (gentle curve)
function magBaseSize(mag) {
  return (0.0018 + Math.pow(Math.max(0, mag), 1.6) * 0.0016) / 25;
}

// Magnitude bucket for the visibility checkboxes: floor(mag) clamped to [3,8],
// so the top bucket (8) means M8+. Used to test against state.visMags.
function magBand(mag) {
  const b = Math.floor(mag);
  return b < 3 ? 3 : (b > 8 ? 8 : b);
}

// Remap non-negative cluster ids to a dense 0..k-1 range in place (noise stays
// -1). Incremental relabeling assigns ids above the previous max, so without this
// the ids — and the persisted label array's footprint — would creep upward and
// labelsToClusters would allocate empty slots for the gaps.
function compactLabels(labels) {
  const remap = new Map();
  let next = 0;
  for (let i = 0; i < labels.length; i++) {
    const v = labels[i];
    if (v >= 0 && !remap.has(v)) remap.set(v, next++);
  }
  for (let i = 0; i < labels.length; i++) {
    const v = labels[i];
    if (v >= 0) labels[i] = remap.get(v);
  }
  return labels;
}

function disposeObj(o) {
  if (!o) return;
  quakeGroup.remove(o);
  if (o.geometry) o.geometry.dispose();
  if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
}

/**
 * Establish (or refresh) the clustered catalog. Runs clustering ONCE, allocates
 * the InstancedMesh, and precomputes per-cluster data. Does not draw — call
 * applyWindow() afterward to render a time slice.
 *
 * Label strategy, cheapest first:
 *   - seedLabels fully known (no new events)  → reuse, zero clustering.
 *   - seedLabels known + some new (-2 slots)  → incremental: re-cluster only the
 *                                               region the new events touch.
 *   - no seedLabels                           → full clustering (also the safe
 *                                               backstop for the removal caveat).
 *
 * @param {Array} quakes  full catalog, newest-first
 * @param {Int32Array|number[]|null} seedLabels  per-quake labels aligned to `quakes`;
 *        -2 marks a newly added event, -1 noise, >=0 a cluster id. null = unknown.
 * @returns {{labels: Int32Array, clusterCount, noiseCount, clusterMs}}
 */
export function setCatalog(quakes, seedLabels) {
  const n = quakes.length;
  catalogSize = n;

  const t0 = performance.now();
  let labels;
  if (seedLabels && seedLabels.length === n) {
    const addedIdx = [];
    for (let i = 0; i < n; i++) if (seedLabels[i] === -2) addedIdx.push(i);
    if (!addedIdx.length) {
      labels = Int32Array.from(seedLabels);                       // nothing new
    } else if (addedIdx.length > n * 0.25) {
      // Too much is new for incremental to pay off (e.g. a whole magnitude band
      // arrived) — its ε-closure would cover most of the catalog anyway, and
      // building per-point adjacency for that is the costly path. Full cluster.
      labels = clusterLabels(quakes, CLUSTER_KM, CLUSTER_DAYS, DBSCAN_MIN_PTS);
    } else {
      try {
        const prev = Int32Array.from(seedLabels, v => (v === -2 ? -1 : v));
        labels = incrementalLabels(quakes, prev, addedIdx, CLUSTER_KM, CLUSTER_DAYS, DBSCAN_MIN_PTS);
      } catch (e) {
        console.warn('incremental cluster failed, full re-cluster:', e);
        labels = clusterLabels(quakes, CLUSTER_KM, CLUSTER_DAYS, DBSCAN_MIN_PTS);
      }
    }
  } else {
    labels = clusterLabels(quakes, CLUSTER_KM, CLUSTER_DAYS, DBSCAN_MIN_PTS);
  }
  compactLabels(labels); // dense ids — incremental relabeling leaves gaps/high ids
  const { clusters: cls, clusterCount, noiseCount } = labelsToClusters(quakes, labels);
  lastClusterMs = +(performance.now() - t0).toFixed(0);

  // Largest first, and presort each cluster's items newest-first + tag the
  // mainshock — all the per-cluster work that doesn't depend on the time window.
  cls.sort((a, b) => b.items.length - a.items.length);
  for (const c of cls) {
    c.items.sort((a, b) => b.time - a.time);
    let mainMag = -Infinity, mainQ = null;
    for (const q of c.items) if (q.mag > mainMag) { mainMag = q.mag; mainQ = q; }
    c.mainshock = mainQ;
  }
  clusters = cls;

  // (Re)allocate the InstancedMesh to hold the whole catalog.
  disposeObj(quakePoints);
  disposeObj(depthLines); disposeObj(seqLines); disposeObj(arrowLines);
  depthLines = seqLines = arrowLines = null;
  instances.length = 0;
  if (!n) { quakePoints = null; return { labels, clusterCount, noiseCount, clusterMs: lastClusterMs }; }

  const sphereGeo = new THREE.SphereGeometry(1, 8, 6); // low poly — many spheres
  const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95 });
  quakePoints = new THREE.InstancedMesh(sphereGeo, mat, n);
  quakePoints.frustumCulled = false; // instances span the whole globe
  quakePoints.count = 0;             // applyWindow fills this in
  quakeGroup.add(quakePoints);

  return { labels, clusterCount, noiseCount, clusterMs: lastClusterMs };
}

/**
 * Render the quakes whose time is within [fromT, toT], reusing the precomputed
 * clusters (no clustering here). Builds the visible instance records + merged
 * line geometry, then writes instance matrices/colors via applyVisualModes.
 *
 * @returns {null | {count, clusterCount, noiseCount, windowMs, clusterMs}}
 */
export function applyWindow(fromT, toT) {
  if (!quakePoints) return null;
  const t0 = performance.now();
  const seq = state.clusterSequence;
  const seqVisible = seq ? new Set(seq.items.slice(0, seq.step)) : null;

  disposeObj(depthLines); disposeObj(seqLines); disposeObj(arrowLines);
  depthLines = seqLines = arrowLines = null;
  instances.length = 0;

  // A quake is drawn only if it's inside the time window AND its magnitude band
  // is checked on (state.visMags). visMags absent => show everything.
  const mags = state.visMags;
  const visible = (q, cluster, ci) => {
    if (seq) {
      return seqVisible ? seqVisible.has(q) : false;
    }
    return q.time >= fromT && q.time <= toT && (!mags || mags.has(magBand(q.mag)));
  };

  // recency in [0..1] over the VISIBLE set: 0 = newest, 1 = oldest. Window-
  // relative so the newest visible quake always reads red as you scrub.
  let vNewest = -Infinity, vOldest = Infinity, visTotal = 0;
  for (let ci = 0; ci < clusters.length; ci++) for (const q of clusters[ci].items) {
    if (!visible(q, clusters[ci], ci)) continue;
    if (q.time > vNewest) vNewest = q.time;
    if (q.time < vOldest) vOldest = q.time;
    visTotal++;
  }
  if (!visTotal) {
    quakePoints.count = 0;
    quakePoints.instanceMatrix.needsUpdate = true;
    return { count: 0, clusterCount: 0, noiseCount: 0, windowMs: 0, clusterMs: lastClusterMs };
  }
  const span = Math.max(1, vNewest - vOldest);
  const recency = q => (vNewest - q.time) / span;

  const depthPos = [], depthCol = [];
  const seqPos = [], seqCol = [];
  const arrowPos = [], arrowCol = [];
  let visibleClusters = 0, visibleNoise = 0;

  clusters.forEach((cluster, ci) => {
    // visible members of this cluster (items already sorted newest-first)
    const vis = cluster.items.length === 1
      ? (visible(cluster.items[0], cluster, ci) ? cluster.items : null)
      : cluster.items.filter(q => visible(q, cluster, ci));
    if (!vis || !vis.length) return;

    if (cluster.noise) visibleNoise += vis.length; else visibleClusters++;

    for (const q of vis) {
      const color = timeColor(recency(q));
      const pos = latLonDepthToVec3(q.lat, q.lon, q.depth);
      const surfacePos = latLonDepthToVec3(q.lat, q.lon, 0);

      // instanceId is the push order; applyVisualModes writes matrix + color.
      // Noise points are singleton "clusters" — they're not mainshocks, so only a
      // real cluster's largest event gets the focus emphasis.
      instances.push({ quake: q, cluster: ci, color, baseSize: magBaseSize(q.mag), isMainshock: !cluster.noise && q === cluster.mainshock, pos });

      depthPos.push(surfacePos.x, surfacePos.y, surfacePos.z, pos.x, pos.y, pos.z);
      depthCol.push(color.r, color.g, color.b, color.r, color.g, color.b);
    }

    buildSequences(vis, seqPos, seqCol, arrowPos, arrowCol);
  });

  quakePoints.count = instances.length;

  depthLines = addLineSegments(depthPos, depthCol, 0.7);
  depthLines.visible = state.depthVisible;
  seqLines = addLineSegments(seqPos, seqCol, 0.9);
  arrowLines = addLineSegments(arrowPos, arrowCol, 0.95);
  arrowLines.visible = state.arrowMode;

  applyVisualModes(); // writes every visible instance matrix + color

  const windowMs = +(performance.now() - t0).toFixed(0);
  return { count: instances.length, clusterCount: visibleClusters, noiseCount: visibleNoise, windowMs, clusterMs: lastClusterMs };
}

// Split a set of (newest-first) cluster events into maximal time-ordered
// sequences and emit one polyline per sequence (purple oldest → blue newest)
// plus a direction chevron at each segment midpoint. Each event links only to
// the one immediately before it in time, and only if close enough in space/time.
function buildSequences(items, seqPos, seqCol, arrowPos, arrowCol) {
  if (items.length < 2) return;
  const recent = items.slice(0, CLUSTER_RECENT); // newest-first
  const maxGapMs = MAX_LINK_DAYS * 86400000;
  const linkable = (a, b) => (a.time - b.time) <= maxGapMs && gcDistKm(a, b) <= MAX_LINK_KM;

  const runs = [];
  let run = [recent[0]];
  for (let i = 0; i < recent.length - 1; i++) {
    if (linkable(recent[i], recent[i + 1])) run.push(recent[i + 1]);
    else { runs.push(run); run = [recent[i + 1]]; }
  }
  runs.push(run);

  for (const seq of runs) {
    if (seq.length < 2) continue;
    const sNewest = seq[0].time, sOldest = seq[seq.length - 1].time;
    const sSpan = Math.max(1, sNewest - sOldest);
    const sRecency = x => (sNewest - x.time) / sSpan; // newest=0 blue, oldest=1 purple

    for (let i = 0; i < seq.length - 1; i++) {
      const a = seq[i], b = seq[i + 1];
      const pa = latLonDepthToVec3(a.lat, a.lon, a.depth);
      const pb = latLonDepthToVec3(b.lat, b.lon, b.depth);
      const ca = clusterLineColor(sRecency(a));
      const cb = clusterLineColor(sRecency(b));
      seqPos.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
      seqCol.push(ca.r, ca.g, ca.b, cb.r, cb.g, cb.b);

      const mid = pa.clone().add(pb).multiplyScalar(0.5);
      const dhat = pa.clone().sub(pb).normalize();
      const sideV = dhat.clone().cross(mid.clone().normalize()).normalize();
      const w = Math.min(0.012, pa.distanceTo(pb) * 0.28) / 5;
      const tip = mid.clone().addScaledVector(dhat, w * 0.6);
      const back = mid.clone().addScaledVector(dhat, -w * 0.6);
      const left = back.clone().addScaledVector(sideV, w);
      const right = back.clone().addScaledVector(sideV, -w);
      arrowPos.push(tip.x, tip.y, tip.z, left.x, left.y, left.z,
                    tip.x, tip.y, tip.z, right.x, right.y, right.z);
      for (let k = 0; k < 4; k++) arrowCol.push(ca.r, ca.g, ca.b); // match newer end
    }
  }
}

// Helper: build a vertex-colored LineSegments from flat arrays and add it.
function addLineSegments(positions, colors, opacity) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const seg = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity })
  );
  quakeGroup.add(seg);
  return seg;
}

// Apply size / mainshock emphasis to the visible instances without a rebuild.
// Size rides the per-instance matrix; "mainshock focus" dims everyone else by
// darkening their instance color (a single material can't vary opacity).
const _col = new THREE.Color();
export function applyVisualModes() {
  if (!quakePoints) return;
  for (let i = 0; i < instances.length; i++) {
    const u = instances[i];
    let s = u.baseSize * state.sizeMult;
    _col.copy(u.color);
    if (state.mainshockMode) {
      if (u.isMainshock) s *= 2.8;                  // make the mainshock clearly dominate
      else { s *= 0.55; _col.multiplyScalar(0.22); } // shrink AND fade the swarm back
    }
    _dummy.position.copy(u.pos);
    _dummy.scale.setScalar(s);
    _dummy.updateMatrix();
    quakePoints.setMatrixAt(i, _dummy.matrix);
    quakePoints.setColorAt(i, _col);
  }
  quakePoints.instanceMatrix.needsUpdate = true;
  if (quakePoints.instanceColor) quakePoints.instanceColor.needsUpdate = true;
}

// Toggle visibility of the toggleable line layers (called by the UI).
export function setDepthVisible(v) { state.depthVisible = v; if (depthLines) depthLines.visible = v; }
export function setArrowVisible(v) { state.arrowMode = v; if (arrowLines) arrowLines.visible = v; }
