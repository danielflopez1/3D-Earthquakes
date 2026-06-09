// USGS data access: fetch the CSV feed, parse it, and maintain an IndexedDB
// cache so repeat visits only download events newer than what we already have.
//
// The catalog now reaches M3+ (~500k events over 5y), which is too big for
// localStorage, so the cache lives in IndexedDB (see idb.js). The first visit
// loads progressively — big-and-rare bands first (M6+, then M5, M4, M3) — so the
// globe paints in under a second and fills in. Each band is emitted via onBatch.
import {
  feedUrl, MIN_MAG, YEARS, CACHE_TTL_MS,
  MAG_BANDS, SNAPSHOT_MIN_MAG, IDB_CACHE_KEY, IDB_LABELS_KEY,
} from './config.js';
import { idbGet, idbSet } from './idb.js';

// Minimal CSV parser that respects quoted fields (USGS place names contain commas).
function parseCsvRow(line) {
  const out = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else {
      if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '"') inQ = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

// Parse a USGS CSV payload into quake records, skipping malformed rows.
export function parseUsgsCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.length);
  if (!lines.length) return [];
  const header = parseCsvRow(lines[0]);
  const ix = name => header.indexOf(name);
  const iT = ix('time'), iLa = ix('latitude'), iLo = ix('longitude'),
        iD = ix('depth'), iM = ix('mag'), iI = ix('id'), iP = ix('place');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const f = parseCsvRow(lines[i]);
    const mag = +f[iM]; if (!isFinite(mag)) continue;
    const lat = +f[iLa], lon = +f[iLo];
    if (!isFinite(lat) || !isFinite(lon)) continue;
    out.push({
      lon, lat,
      depth: Math.max(0, +f[iD] || 0),
      mag,
      time: Date.parse(f[iT]),
      place: f[iP] || 'unknown',
      id: f[iI],
    });
  }
  return out;
}

// --- cluster-label cache (aligned to the cached quakes array) ----------------
// We persist the clustering so a reload doesn't re-analyze unchanged data. The
// signature ties a label array to the exact quakes array it was computed for; a
// mismatch (different length / different newest event) means "don't trust it".
function labelSig(quakes) {
  return quakes.length + ':' + (quakes.length ? quakes[0].id : '0');
}

/**
 * Save cluster labels for a catalog into IndexedDB. Best-effort: a failure just
 * means the next load re-clusters. `labels` must align to `quakes` (the array
 * loadQuakes persisted), so next session's seed lines up by index.
 */
export async function persistClusterLabels(quakes, labels) {
  await idbSet(IDB_LABELS_KEY, { sig: labelSig(quakes), labels: Array.from(labels) });
}

// Path to the pre-baked snapshot produced by scripts/fetch-quakes.mjs and
// refreshed hourly by the deploy workflow. It holds M4+ (SNAPSHOT_MIN_MAG) so the
// file stays small; M3 is filled in live on first visit and cached for next time.
const BAKED_URL = './data/quakes.csv';

/**
 * Try to load the baked snapshot. Returns parsed quakes (newest first) or null
 * if the file isn't there (e.g. running locally before the workflow has run, or
 * a plain static checkout) — in which case the caller falls back to live USGS.
 */
async function tryLoadBaked() {
  try {
    const res = await fetch(BAKED_URL, { cache: 'no-cache' }); // revalidate for freshness
    if (!res.ok) return null;
    const quakes = parseUsgsCsv(await res.text());
    if (!quakes.length) return null;
    quakes.sort((a, b) => b.time - a.time);
    return quakes;
  } catch {
    return null;
  }
}

// Smallest window we'll ever bisect down to before giving up. A single day at
// M3+ globally is well under USGS's 20k-row cap, so this is just a safety floor.
const MIN_SPLIT_MS = 24 * 3600 * 1000;

/**
 * Fetch one time window for one magnitude band, splitting it when USGS rejects
 * the query for exceeding its 20,000-row cap.
 *
 * USGS responds 400 ("would return too many results") when a window matches more
 * than 20k events, so we bisect in time and recurse until each piece fits. Halves
 * run in parallel. Boundary duplicates are harmless — callers de-dup by event id.
 */
async function fetchRange(startMs, endMs, acc, minMag, maxMag) {
  const res = await fetch(feedUrl(
    new Date(startMs).toISOString(), new Date(endMs).toISOString(), minMag, maxMag));
  if (res.ok) {
    const text = await res.text();
    acc.bytes += text.length;
    return parseUsgsCsv(text);
  }
  if (res.status === 400 && endMs - startMs > MIN_SPLIT_MS) {
    const mid = Math.floor((startMs + endMs) / 2);
    const [a, b] = await Promise.all([
      fetchRange(startMs, mid, acc, minMag, maxMag),
      fetchRange(mid + 1, endMs, acc, minMag, maxMag),
    ]);
    return a.concat(b);
  }
  const body = await res.text();
  throw new Error(`USGS ${res.status}: ${body.slice(0, 200)}`);
}

/**
 * Load quakes, preferring local data and topping up to "now", emitting partial
 * results as they arrive so the UI can paint progressively.
 *
 * Coverage model: the cache records the lowest magnitude it fully covers
 * (`minMag`) and its newest event. Anything missing is (a) the historical gap —
 * bands below the cached coverage over the whole window — and (b) the delta —
 * all M3+ events newer than the cache. We fetch the historical bands high→low
 * (big quakes paint first) then the delta, calling `onBatch` after each step.
 *
 * Each batch carries `seedLabels` aligned to its `all` array: a cluster id (>=0)
 * or -1 (noise) for events we'd clustered before, -2 for newly added events, so
 * setCatalog can skip or incrementally patch clustering instead of re-running it.
 *
 * @param {{onBatch?: (res) => void}} [opts]
 * @returns {Promise<{all, fetched, bytes, seconds, fromCache, fromBaked, seedLabels, isFinal}>}
 */
export async function loadQuakes({ onBatch } = {}) {
  let seed = await idbGet(IDB_CACHE_KEY); // { newest, quakes, minMag } | null
  let fromBaked = false;
  if (!seed) {
    const baked = await tryLoadBaked();
    if (baked) seed = { newest: baked[0].time, quakes: baked, minMag: SNAPSHOT_MIN_MAG };
    fromBaked = !!baked;
  }
  const coverageMinMag = seed ? (seed.minMag ?? MIN_MAG) : Infinity;

  // Saved labels carry over only from the real IDB cache; a baked snapshot has none.
  let labelMap = null;
  if (seed && !fromBaked && Array.isArray(seed.quakes) && seed.quakes.length) {
    const lc = await idbGet(IDB_LABELS_KEY);
    if (lc && lc.sig === labelSig(seed.quakes) && Array.isArray(lc.labels) && lc.labels.length === seed.quakes.length) {
      labelMap = new Map();
      for (let i = 0; i < seed.quakes.length; i++) labelMap.set(seed.quakes[i].id, lc.labels[i]);
    }
  }

  const map = new Map();
  if (seed && Array.isArray(seed.quakes)) for (const q of seed.quakes) map.set(q.id, q);

  const now = Date.now();
  const cutoff = now - CACHE_TTL_MS;
  const t0 = performance.now();
  const acc = { bytes: 0 };
  let fetchedCount = 0;

  function emit(isFinal) {
    const all = [...map.values()].filter(q => q.time >= cutoff).sort((a, b) => b.time - a.time);
    let seedLabels = null;
    if (labelMap) {
      seedLabels = new Array(all.length);
      for (let i = 0; i < all.length; i++) {
        const l = labelMap.get(all[i].id);
        seedLabels[i] = (l === undefined) ? -2 : l;
      }
    }
    const seconds = ((performance.now() - t0) / 1000).toFixed(1);
    const res = {
      all, fetched: fetchedCount, bytes: acc.bytes, seconds,
      fromCache: !!seed, fromBaked, seedLabels, isFinal,
    };
    if (onBatch) onBatch(res);
    return res;
  }

  // 0) Paint whatever we already have, instantly.
  if (seed) emit(false);

  // 1) Historical gap: bands below the cached coverage, over the full window.
  //    Fresh visit (no seed) => all bands; baked M4+ seed => just the M3 band.
  const histStart = cutoff;
  const histEnd = seed ? seed.newest : now;
  for (const band of MAG_BANDS) {
    if (band.min >= coverageMinMag) continue; // already covered by the seed
    const got = await fetchRange(histStart, histEnd, acc, band.min, band.max);
    fetchedCount += got.length;
    for (const q of got) map.set(q.id, q);
    emit(false);
  }

  // 2) Delta: everything M3+ newer than the cache (1h overlap catches late edits).
  //    Skipped on a fresh visit — the bands above already cover [cutoff, now].
  if (seed) {
    const deltaStart = (seed.newest || now) - 60 * 60 * 1000;
    const delta = await fetchRange(deltaStart, now, acc, MIN_MAG, null);
    fetchedCount += delta.length;
    for (const q of delta) map.set(q.id, q);
  }

  const final = emit(true);

  // Persist the full catalog; cluster labels are saved by the caller afterward.
  try {
    const newest = final.all.length ? final.all[0].time : now;
    await idbSet(IDB_CACHE_KEY, { newest, quakes: final.all, minMag: MIN_MAG });
  } catch (e) {
    console.warn('cache save failed:', e);
  }

  return final;
}
