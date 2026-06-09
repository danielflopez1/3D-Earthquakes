// Selection layer: the 3D overlay that appears when you click a quake.
//
//   • uncertainty ellipsoid — a thin wireframe around the hypocenter sized by the
//     event's reported location error (horizontal semi-axes = horizontalError,
//     vertical = depthError), oriented so its short/long axes line up with the
//     local vertical. This is literally "where the quake could really be".
//   • ghost aftershocks — illustrative future events drawn from the Omori fit:
//     WHEN from the modeled rate (inverse-CDF over the next 30 days), WHERE
//     bootstrapped onto the real rupture. Colored by projected time (soon = red,
//     later = green), hoverable for place + ETA.
//   • zone ring — an oriented ellipse on the surface tracing the sequence's
//     footprint (major axis along the rupture strike, dist90 × dist50).
import * as THREE from 'three';
import { scene } from './scene.js';
import { latLonDepthToVec3 } from './geo.js';
import { DEPTH_SCALE } from './config.js';
import { timeColor } from './colors.js';
import { sampleCatalogInformedAftershocks, summarizeIntensity } from './forecast.js';

const KM = DEPTH_SCALE;   // km → scene units (1 / EARTH_RADIUS_KM)
const GHOST_COUNT = 80;
const GHOST_SPRITE_SIZE = 64;

const group = new THREE.Group();
scene.add(group);

let ghostSprite = null;
let ghostPoints = null;   // THREE.Points of projected aftershocks
let ghostData = [];       // parallel metadata: { place, days, depth }
let ellipsoid = null;     // wireframe uncertainty volume
let zoneRing = null;      // oriented footprint ellipse

function getGhostSprite() {
  if (ghostSprite) return ghostSprite;
  const canvas = document.createElement('canvas');
  canvas.width = GHOST_SPRITE_SIZE;
  canvas.height = GHOST_SPRITE_SIZE;
  const ctx = canvas.getContext('2d');
  const r = GHOST_SPRITE_SIZE / 2;
  const grad = ctx.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.62, 'rgba(255,255,255,0.95)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fill();
  ghostSprite = new THREE.CanvasTexture(canvas);
  return ghostSprite;
}

export function clearSelection() {
  group.clear();
  for (const o of [ghostPoints, ellipsoid, zoneRing]) {
    if (!o) continue;
    o.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    });
  }
  ghostPoints = ellipsoid = zoneRing = null;
  ghostData = [];
}

// Error ellipsoid at the hypocenter, drawn as three orthogonal rings (a clean
// "gyroscope" that reads as 3D, vs. a facet-grid sphere wireframe). Semi-axes:
// horizontal = horizontalError, vertical = depthError. Built as unit circles in
// the three coordinate planes; the object's non-uniform scale stretches them to
// the real km error, and the quaternion tips the vertical axis to local-up.
function buildEllipsoid(quake) {
  const hKm = quake.hErr || 5;
  const dKm = quake.dErr || hKm;
  const N = 64;
  const pts = [];
  // plane 0 → Y-Z, plane 1 → X-Z, plane 2 → X-Y; emit each ring as line segments
  for (let plane = 0; plane < 3; plane++) {
    for (let i = 0; i < N; i++) {
      for (const t of [(i / N) * Math.PI * 2, ((i + 1) / N) * Math.PI * 2]) {
        const c = Math.cos(t), s = Math.sin(t);
        if (plane === 0) pts.push(0, c, s);
        else if (plane === 1) pts.push(c, 0, s);
        else pts.push(c, s, 0);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
  const mat = new THREE.LineBasicMaterial({
    color: 0x8fb6ff, transparent: true, opacity: 0.6, depthWrite: false,
  });
  const mesh = new THREE.LineSegments(geo, mat);
  const pos = latLonDepthToVec3(quake.lat, quake.lon, quake.depth);
  mesh.position.copy(pos);
  // orient the local +Y (the depth axis) along the local vertical
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pos.clone().normalize());
  mesh.scale.set(hKm * KM, dKm * KM, hKm * KM);
  mesh.renderOrder = 9;
  return mesh;
}

// Ghost aftershocks: bootstrapped locations + Omori-sampled times, colored by
// projected time (tFrac 0→1 ≈ now→30d : red→green).
function buildGhosts(cluster, fit, catalog) {
  const samples = sampleCatalogInformedAftershocks(cluster, fit, GHOST_COUNT, catalog);
  if (!samples.length) return null;
  fit.intensity.projected = summarizeIntensity(samples);
  const buckets = [[], [], []];
  ghostData = [];
  samples.forEach((s, i) => {
    buckets[s.mag >= 5 ? 2 : (s.mag >= 4 ? 1 : 0)].push({ s, i });
    ghostData.push({ place: s.place, days: s.days, depth: s.depth, mag: s.mag, intensity: s.intensity });
  });
  const root = new THREE.Group();
  [0.011, 0.016, 0.024].forEach((size, bi) => {
    const bucket = buckets[bi];
    if (!bucket.length) return;
    const position = new Float32Array(bucket.length * 3);
    const color = new Float32Array(bucket.length * 3);
    bucket.forEach(({ s, i }, j) => {
      const p = latLonDepthToVec3(s.lat, s.lon, s.depth);
      position[j * 3] = p.x; position[j * 3 + 1] = p.y; position[j * 3 + 2] = p.z;
      const c = timeColor(s.tFrac);
      color[j * 3] = c.r; color[j * 3 + 1] = c.g; color[j * 3 + 2] = c.b;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
    const mat = new THREE.PointsMaterial({
      size,
      map: getGhostSprite(),
      vertexColors: true,
      transparent: true,
      opacity: 0.6,
      alphaTest: 0.05,
      sizeAttenuation: true,
      depthWrite: false,
    });
    const points = new THREE.Points(geo, mat);
    points.userData.ghostIndices = bucket.map(x => x.i);
    root.add(points);
  });
  return root;
}

// Oriented footprint ellipse on the surface: major axis along the rupture strike
// (where.az, compass degrees), semi-axes dist90 × dist50, lifted just above ground.
function buildZoneRing(where, main) {
  const az = (where.az || 0) * Math.PI / 180;
  const aMaj = Math.max(where.dist90, 5);   // km, along strike
  const aMin = Math.max(where.dist50, 2);   // km, across strike
  const cosL = Math.cos(main.lat * Math.PI / 180);
  const sinAz = Math.sin(az), cosAz = Math.cos(az);
  const N = 96;
  const arr = new Float32Array((N + 1) * 3);
  for (let i = 0; i <= N; i++) {
    const ph = (i / N) * Math.PI * 2;
    const ds = aMaj * Math.cos(ph), dc = aMin * Math.sin(ph);
    const east = ds * sinAz + dc * cosAz;   // azimuth measured from north, clockwise
    const north = ds * cosAz - dc * sinAz;
    const lat = main.lat + north / 111.32;
    const lon = main.lon + east / (111.32 * cosL);
    const p = latLonDepthToVec3(lat, lon, -1.5); // ~1.5 km above the surface
    arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0xffaa33, transparent: true, opacity: 0.55 });
  return new THREE.LineLoop(geo, mat);
}

// Show the overlay for a clicked quake. `fit` is the (shared) Omori fit for its
// cluster; ghosts + zone ring appear only when the fit succeeded.
export function showSelection(quake, cluster, fit, catalog) {
  clearSelection();
  if (quake.hErr != null || quake.dErr != null) {
    ellipsoid = buildEllipsoid(quake);
    group.add(ellipsoid);
  }
  if (fit && fit.ok) {
    ghostPoints = buildGhosts(cluster, fit, catalog);
    if (ghostPoints) group.add(ghostPoints);
    if (fit.where && cluster.mainshock) {
      zoneRing = buildZoneRing(fit.where, cluster.mainshock);
      group.add(zoneRing);
    }
  }
}

export function getGhostPoints() { return ghostPoints; }
export function getGhostData(i) { return ghostData[i]; }
