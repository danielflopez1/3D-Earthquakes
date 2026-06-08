// The quake layer: everything that gets rebuilt when the data or time filter
// changes — sphere meshes, depth lines, sequence polylines, and direction
// arrows. All of it lives in one Group so a rebuild is a single clear + refill.
import * as THREE from 'three';
import { scene } from './scene.js';
import { state } from './state.js';
import { latLonDepthToVec3, gcDistKm } from './geo.js';
import { timeColor, clusterLineColor } from './colors.js';
import { stDbscanCluster } from './clustering.js';
import {
  CLUSTER_KM, CLUSTER_DAYS, DBSCAN_MIN_PTS,
  MAX_LINK_KM, MAX_LINK_DAYS, CLUSTER_RECENT,
} from './config.js';

const quakeGroup = new THREE.Group();
scene.add(quakeGroup);

const quakeMeshes = [];   // sphere meshes, for raycasting
let lastClusters = [];    // clusters from the most recent build, for cross-sections
let depthLines = null;    // merged surface→hypocenter lines
let arrowLines = null;    // merged direction chevrons

// expose live references to the interaction layer
export function getQuakeMeshes() { return quakeMeshes; }
export function getCluster(i) { return lastClusters[i]; }

// sphere radius from magnitude (gentle curve)
function magBaseSize(mag) {
  return (0.0018 + Math.pow(Math.max(0, mag), 1.6) * 0.0016) / 25;
}

// dispose geometry + materials before dropping a group's children
function clearGroup(g) {
  for (let i = g.children.length - 1; i >= 0; i--) {
    const c = g.children[i];
    g.remove(c);
    if (c.geometry) c.geometry.dispose();
    if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach(m => m.dispose());
  }
}

/**
 * Rebuild the whole layer for a set of quakes.
 * @returns {null | {count, clusterCount, noiseCount, dbscanMs}} stats, or null if empty.
 */
export function build(quakes) {
  clearGroup(quakeGroup);
  quakeMeshes.length = 0;
  depthLines = null;
  if (!quakes.length) { lastClusters = []; return null; }

  // recency in [0..1]: 0 = newest, 1 = oldest (normalized within the shown set)
  const newest = quakes[0].time;
  const oldest = quakes[quakes.length - 1].time;
  const span = Math.max(1, newest - oldest);
  const recency = q => (newest - q.time) / span;

  const t0 = performance.now();
  const { clusters, clusterCount, noiseCount } =
    stDbscanCluster(quakes, CLUSTER_KM, CLUSTER_DAYS, DBSCAN_MIN_PTS);
  const dbscanMs = +(performance.now() - t0).toFixed(0);
  clusters.sort((a, b) => b.items.length - a.items.length);
  lastClusters = clusters;

  const sphereGeo = new THREE.SphereGeometry(1, 8, 6); // low poly — many spheres

  // accumulators for merged geometry (one draw call each)
  const depthPos = [], depthCol = [];
  const seqPos = [], seqCol = [];
  const arrowPos = [], arrowCol = [];

  clusters.forEach((cluster, ci) => {
    cluster.items.sort((a, b) => b.time - a.time); // latest first

    // the cluster's largest event is its mainshock (for "mainshock focus")
    let mainMag = -Infinity, mainQ = null;
    for (const q of cluster.items) if (q.mag > mainMag) { mainMag = q.mag; mainQ = q; }

    for (const q of cluster.items) {
      const color = timeColor(recency(q));
      const pos = latLonDepthToVec3(q.lat, q.lon, q.depth);
      const surfacePos = latLonDepthToVec3(q.lat, q.lon, 0);

      const mat = new THREE.MeshPhongMaterial({
        color, emissive: color.clone().multiplyScalar(0.5),
        transparent: true, opacity: 0.95,
      });
      const m = new THREE.Mesh(sphereGeo, mat);
      m.position.copy(pos);
      m.userData = { quake: q, cluster: ci, color, baseSize: magBaseSize(q.mag), isMainshock: q === mainQ };
      quakeGroup.add(m);
      quakeMeshes.push(m);

      // depth indicator (merged): surface → hypocenter, colored by recency
      depthPos.push(surfacePos.x, surfacePos.y, surfacePos.z, pos.x, pos.y, pos.z);
      depthCol.push(color.r, color.g, color.b, color.r, color.g, color.b);
    }

    buildSequences(cluster, seqPos, seqCol, arrowPos, arrowCol);
  });

  depthLines = addLineSegments(depthPos, depthCol, 0.7);
  depthLines.visible = state.depthVisible;
  addLineSegments(seqPos, seqCol, 0.9); // sequence polylines

  arrowLines = addLineSegments(arrowPos, arrowCol, 0.95);
  arrowLines.visible = state.arrowMode;

  applyVisualModes();
  return { count: quakes.length, clusterCount, noiseCount, dbscanMs };
}

// Split a cluster's events into maximal time-ordered sequences and emit one
// polyline per sequence (purple oldest → blue newest) plus a direction chevron
// at each segment midpoint. Each event links only to the one immediately before
// it in time, and only if close enough in space and time.
function buildSequences(cluster, seqPos, seqCol, arrowPos, arrowCol) {
  if (cluster.items.length < 2) return;
  const recent = cluster.items.slice(0, CLUSTER_RECENT); // newest-first
  const maxGapMs = MAX_LINK_DAYS * 86400000;
  const linkable = (a, b) => (a.time - b.time) <= maxGapMs && gcDistKm(a, b) <= MAX_LINK_KM;

  // maximal runs of consecutive linkable events
  const runs = [];
  let run = [recent[0]];
  for (let i = 0; i < recent.length - 1; i++) {
    if (linkable(recent[i], recent[i + 1])) run.push(recent[i + 1]);
    else { runs.push(run); run = [recent[i + 1]]; }
  }
  runs.push(run);

  for (const seq of runs) {
    if (seq.length < 2) continue;
    // each sequence gets its OWN gradient: oldest end purple, newest end blue
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

      // direction chevron at the midpoint, pointing older→newer (b→a)
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

// Apply size / mainshock emphasis to existing meshes without a rebuild.
export function applyVisualModes() {
  for (const m of quakeMeshes) {
    const u = m.userData;
    let s = u.baseSize * state.sizeMult;
    if (state.mainshockMode) {
      if (u.isMainshock) {
        s *= 1.8;
        m.material.opacity = 1.0;
        m.material.emissive.copy(u.color);
      } else {
        m.material.opacity = 0.3;
        m.material.emissive.copy(u.color).multiplyScalar(0.35);
      }
    } else {
      m.material.opacity = 0.95;
      m.material.emissive.copy(u.color).multiplyScalar(0.5);
    }
    m.scale.setScalar(s);
  }
}

// Toggle visibility of the toggleable line layers (called by the UI).
export function setDepthVisible(v) { state.depthVisible = v; if (depthLines) depthLines.visible = v; }
export function setArrowVisible(v) { state.arrowMode = v; if (arrowLines) arrowLines.visible = v; }
