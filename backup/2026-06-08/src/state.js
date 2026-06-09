// Shared, mutable application state.
//
// A single object that the UI writes to and the render/data layers read from.
// Keeping it in one module avoids threading the same handful of values through
// every function signature. Only genuinely cross-cutting state lives here;
// module-internal details (Three.js meshes, DOM nodes) stay in their owners.
export const state = {
  // --- loaded data ---
  allQuakes: [], // every quake in the cache window, newest-first
  tMin: 0,       // oldest loaded event time (ms)
  tMax: 0,       // newest loaded event time (ms)

  // --- render flags (set by the UI, read by the quake layer) ---
  sizeMult: 1.0,        // quake-size slider: 50 on the slider => 1.0 => baseline size
  mainshockMode: false, // emphasize each cluster's largest event
  arrowMode: false,     // show propagation-direction arrows
  depthVisible: true,   // surface→hypocenter depth lines

  // Magnitude bands currently shown (floor(mag), 8 = M8+). The quake layer draws
  // a quake only if its band is in this set. All on by default.
  visMags: new Set([3, 4, 5, 6, 7, 8]),
};
