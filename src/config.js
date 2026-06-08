// Tunable constants and external endpoints for the whole app.
// Everything an operator might want to adjust lives here, in one place.

// --- geometry / scaling ---
export const EARTH_R = 1.0;                  // globe radius in scene units
export const EARTH_RADIUS_KM = 6371;         // real mean radius
export const DEPTH_SCALE = 1 / EARTH_RADIUS_KM; // depth maps to a true fraction of the radius

// --- data window ---
export const YEARS = 5;                       // how far back to fetch
export const MIN_MAG = 5.0;                   // USGS caps queries at 20k events; M5+ over 5y is ~7-8k worldwide

// --- ST-DBSCAN clustering ---
export const CLUSTER_KM = 300;                // spatial eps in km — regional
export const CLUSTER_DAYS = 90;               // temporal eps in days — neighbors must also be within this
export const DBSCAN_MIN_PTS = 4;              // density requirement: neighbors within both eps

// --- sequence linking (the blue→purple lines) ---
export const MAX_LINK_KM = 250;               // max length of a sequence segment — keeps links local
export const MAX_LINK_DAYS = 365;             // don't connect quakes more than this far apart in time
export const CLUSTER_RECENT = 100;            // connect up to this many most-recent quakes per cluster

// --- local cache ---
export const CACHE_KEY = 'eq_cache_v1';
export const CACHE_TTL_MS = YEARS * 365.25 * 24 * 3600 * 1000;

// USGS FDSN event query, CSV format, ascending by time.
export function feedUrl(startISO, endISO) {
  return `https://earthquake.usgs.gov/fdsnws/event/1/query?format=csv` +
         `&starttime=${startISO}&endtime=${endISO}` +
         `&minmagnitude=${MIN_MAG}&orderby=time`;
}

// Earth textures (served by the three.js examples CDN).
export const EARTH_TEX  = 'https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg';
export const EARTH_BUMP = 'https://threejs.org/examples/textures/planets/earth_normal_2048.jpg';
export const EARTH_SPEC = 'https://threejs.org/examples/textures/planets/earth_specular_2048.jpg';
