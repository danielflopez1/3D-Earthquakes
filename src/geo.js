// Geospatial helpers: turn earthquake coordinates into scene positions and
// measure surface distances.
import * as THREE from 'three';
import { EARTH_R, DEPTH_SCALE, EARTH_RADIUS_KM } from './config.js';

// Convert (latitude, longitude, depth) into a 3D point. Depth is subtracted from
// the radius at true scale, so a hypocenter sits proportionally below the surface.
export function latLonDepthToVec3(lat, lon, depthKm) {
  const r = EARTH_R - depthKm * DEPTH_SCALE;
  const phi = (90 - lat) * Math.PI / 180;
  const theta = (lon + 180) * Math.PI / 180;
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
     r * Math.cos(phi),
     r * Math.sin(phi) * Math.sin(theta)
  );
}

// Great-circle (haversine) distance in km between two {lat, lon} points.
// Used for clustering on the surface; depth is ignored.
export function gcDistKm(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const la1 = a.lat * toRad, la2 = b.lat * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}
