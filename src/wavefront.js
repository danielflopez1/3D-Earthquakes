// Seismic wavefront layer (educational).
//
// When "Seismic waves" is on, clicking a quake launches expanding P and S
// wavefronts from its epicenter, drawn as small circles (constant great-circle
// radius) sweeping across the globe. The geometry is pure spherical kinematics,
// not a real wavefield — it exists to make two textbook phenomena visible:
//   • P-wave shadow zone (104°–140°): direct P is refracted away by the liquid
//     outer core, so the P front dims through that band and re-emerges past 140°.
//   • S-wave core shadow (beyond ~104°): S can't traverse the liquid core at all,
//     so the S front fades out there and never reaches the far side.
// Angular speeds are scaled for viewing, but their ratio (~√3) is realistic.
import * as THREE from 'three';
import { scene } from './scene.js';
import { EARTH_R } from './config.js';

const DEG = Math.PI / 180;
const SEG = 160;                 // ring resolution
const R = EARTH_R * 1.003;       // sit just above the surface
const W_P = Math.PI / 7000;      // P sweeps to the antipode in ~7s (rad/ms)
const W_S = W_P / 1.73;          // S slower by ~√3
const SHADOW_IN = 104 * DEG, SHADOW_OUT = 140 * DEG; // P shadow band
const S_MAX = 104 * DEG;         // S blocked beyond the core shadow
const FADE = 0.18;               // rad of trailing fade-out

const group = new THREE.Group();
scene.add(group);

let raf = null, t0 = 0;
let center = null, u = null, v = null; // epicenter unit vector + perpendicular basis
let pLine = null, sLine = null;

function ringLine(color) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((SEG + 1) * 3), 3));
  return new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
}

// Write the small-circle at angular radius `alpha` (rad) into a ring's buffer.
function writeRing(line, alpha) {
  const pos = line.geometry.attributes.position.array;
  const ca = Math.cos(alpha), sa = Math.sin(alpha);
  for (let i = 0; i <= SEG; i++) {
    const th = (i / SEG) * Math.PI * 2;
    const cu = Math.cos(th), su = Math.sin(th);
    pos[i * 3]     = (ca * center.x + sa * (cu * u.x + su * v.x)) * R;
    pos[i * 3 + 1] = (ca * center.y + sa * (cu * u.y + su * v.y)) * R;
    pos[i * 3 + 2] = (ca * center.z + sa * (cu * u.z + su * v.z)) * R;
  }
  line.geometry.attributes.position.needsUpdate = true;
}

// Unit vector for (lat, lon) on the surface — matches geo.latLonDepthToVec3(.,.,0).
function latLonToUnit(lat, lon) {
  const phi = (90 - lat) * DEG, theta = (lon + 180) * DEG;
  return new THREE.Vector3(
    -Math.sin(phi) * Math.cos(theta),
     Math.cos(phi),
     Math.sin(phi) * Math.sin(theta),
  );
}

export function clearWavefront() {
  if (raf) { cancelAnimationFrame(raf); raf = null; }
  group.clear();
  for (const l of [pLine, sLine]) if (l) { l.geometry.dispose(); l.material.dispose(); }
  pLine = sLine = null;
}

export function startWavefront(quake) {
  clearWavefront();
  center = latLonToUnit(quake.lat, quake.lon);
  const ref = Math.abs(center.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  u = new THREE.Vector3().crossVectors(center, ref).normalize();
  v = new THREE.Vector3().crossVectors(center, u).normalize();
  pLine = ringLine(0xffd24a); // P: warm yellow
  sLine = ringLine(0x49d6ff); // S: cyan
  group.add(pLine, sLine);
  t0 = performance.now();
  tick();
}

function tick() {
  const el = performance.now() - t0;
  const aP = W_P * el, aS = W_S * el;
  let alive = false;

  // P: full sweep to the antipode, dimming through the shadow band.
  if (aP <= Math.PI + FADE) {
    alive = true;
    const a = Math.min(aP, Math.PI);
    writeRing(pLine, a);
    const inShadow = a > SHADOW_IN && a < SHADOW_OUT;
    const tail = aP > Math.PI ? 1 - (aP - Math.PI) / FADE : 1;
    pLine.material.opacity = (inShadow ? 0.12 : 0.9) * Math.max(0, tail);
    pLine.visible = true;
  } else pLine.visible = false;

  // S: stops at the core shadow, then fades.
  if (aS <= S_MAX + FADE) {
    alive = true;
    const a = Math.min(aS, S_MAX);
    writeRing(sLine, a);
    const tail = aS > S_MAX ? 1 - (aS - S_MAX) / FADE : 1;
    sLine.material.opacity = 0.9 * Math.max(0, tail);
    sLine.visible = true;
  } else sLine.visible = false;

  if (alive) raf = requestAnimationFrame(tick);
  else clearWavefront();
}
