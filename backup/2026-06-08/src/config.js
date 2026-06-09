// Tunable constants and external endpoints for the whole app.
// Everything an operator might want to adjust lives here, in one place.

// --- geometry / scaling ---
export const EARTH_R = 1.0;                  // globe radius in scene units
export const EARTH_RADIUS_KM = 6371;         // real mean radius
export const DEPTH_SCALE = 1 / EARTH_RADIUS_KM; // depth maps to a true fraction of the radius

// --- data window ---
export const YEARS = 5;                       // how far back to fetch
export const MIN_MAG = 3.0;                   // M3+ over 5y is ~400-700k worldwide; USGS caps a single
                                              // query at 20k, so usgs.js time-bisects the fetch (see loadQuakes)

// Progressive load order: big-and-rare first so the globe paints in <1s, then
// fill in the long tail. Each band is a half-open [min,max) magnitude range
// (max:null = unbounded). usgs.js fetches them high→low and renders after each.
export const MAG_BANDS = [
  { min: 6, max: null },
  { min: 5, max: 6 },
  { min: 4, max: 5 },
  { min: 3, max: 4 },
];

// Magnitude levels exposed as visibility checkboxes. Each is a [n, n+1) bucket,
// except the top one (8) which means M8+. Purely a render filter — the data is
// loaded once (M3+) and these toggle what's drawn.
export const MAG_LEVELS = [3, 4, 5, 6, 7, 8];

// The baked snapshot (scripts/fetch-quakes.mjs) stays at M4+ so data/quakes.csv
// is ~a few MB, not the ~100MB an M3+ snapshot would be. First visit gets M4+
// instantly from the snapshot, then M3 streams in live and is cached for next time.
export const SNAPSHOT_MIN_MAG = 4.0;

// --- ST-DBSCAN clustering ---
export const CLUSTER_KM = 50;                 // spatial eps in km — fault/sequence scale (M3 data is dense enough to resolve this)
export const CLUSTER_DAYS = 90;               // temporal eps in days — neighbors must also be within this
export const DBSCAN_MIN_PTS = 4;              // density requirement: neighbors within both eps

// --- sequence linking (the blue→purple lines) ---
export const MAX_LINK_KM = 250;               // max length of a sequence segment — keeps links local
export const MAX_LINK_DAYS = 365;             // don't connect quakes more than this far apart in time
export const CLUSTER_RECENT = 100;            // connect up to this many most-recent quakes per cluster

// --- local cache (IndexedDB) ---
// The M3+ catalog (~500k events) is far too big for the ~5-10MB localStorage
// quota, so the cache lives in IndexedDB, which can hold hundreds of MB. The
// catalog and its cluster labels are two records in one key/value store.
export const IDB_NAME = 'eq_db';
export const IDB_STORE = 'kv';
export const IDB_CACHE_KEY = 'catalog_v3';  // { newest, quakes }
export const IDB_LABELS_KEY = 'clusters_v3'; // { sig, labels } — bump on any clustering-param change to discard stale labels
export const CACHE_TTL_MS = YEARS * 365.25 * 24 * 3600 * 1000;

// USGS FDSN event query, CSV format, ascending by time. minMag/maxMag default to
// the full M3+ window but the progressive loader passes a single band's range.
export function feedUrl(startISO, endISO, minMag = MIN_MAG, maxMag = null) {
  let url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=csv` +
            `&starttime=${startISO}&endtime=${endISO}` +
            `&minmagnitude=${minMag}&orderby=time`;
  if (maxMag != null) url += `&maxmagnitude=${maxMag}`;
  return url;
}

// Earth textures (served by the three.js examples CDN).
export const EARTH_TEX  = 'https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg';
export const EARTH_BUMP = 'https://threejs.org/examples/textures/planets/earth_normal_2048.jpg';
export const EARTH_SPEC = 'https://threejs.org/examples/textures/planets/earth_specular_2048.jpg';
