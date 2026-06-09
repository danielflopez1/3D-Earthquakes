// Color ramps. Both take a normalized t in [0, 1] (0 = newest, 1 = oldest).
import * as THREE from 'three';

// Quake spheres: red (newest) → green (oldest).
export function timeColor(t) {
  const tt = Math.min(1, Math.max(0, t));
  const hue = tt * 0.33;        // 0 red → 0.33 green
  const sat = 0.85;
  const lit = 0.55 - tt * 0.05;
  return new THREE.Color().setHSL(hue, sat, lit);
}

// Sequence lines: blue (most recent) → purple (oldest).
export function clusterLineColor(t) {
  const tt = Math.min(1, Math.max(0, t));
  const hue = 0.60 + tt * 0.20; // 0.60 blue → 0.80 purple
  const sat = 0.90;
  const lit = 0.58 + tt * 0.04; // kept bright so the line stays visible
  return new THREE.Color().setHSL(hue, sat, lit);
}
