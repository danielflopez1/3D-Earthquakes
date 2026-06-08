// USGS data access: fetch the CSV feed, parse it, and maintain a localStorage
// cache so repeat visits only download events newer than what we already have.
import { feedUrl, CACHE_KEY, CACHE_TTL_MS, YEARS } from './config.js';

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

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); }
  catch { return null; }
}

/**
 * Load quakes, using the cache when present.
 *
 * First visit: fetch the full YEARS-year window. Later visits: fetch only
 * events since the newest cached event (with 1h overlap to catch late edits),
 * merge with the cache (de-dup by id), drop anything older than the window, and
 * persist. The DOM is never touched here — the caller renders the result.
 *
 * @returns {Promise<{all, fetched, bytes, seconds, fromCache}>}
 */
export async function loadQuakes() {
  const cached = readCache();

  const now = new Date();
  let start;
  if (cached && cached.newest) {
    start = new Date(cached.newest - 60 * 60 * 1000);
  } else {
    start = new Date(); start.setFullYear(start.getFullYear() - YEARS);
  }

  const t0 = performance.now();
  const res = await fetch(feedUrl(start.toISOString(), now.toISOString()));
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`USGS ${res.status}: ${body.slice(0, 200)}`);
  }
  const text = await res.text();
  const fetched = parseUsgsCsv(text);
  const seconds = ((performance.now() - t0) / 1000).toFixed(1);

  // merge cached + fetched, de-dup by id (fresh wins), drop entries past the window
  const map = new Map();
  if (cached && Array.isArray(cached.quakes)) {
    for (const q of cached.quakes) map.set(q.id, q);
  }
  for (const q of fetched) map.set(q.id, q);
  const cutoff = Date.now() - CACHE_TTL_MS;
  const all = [...map.values()]
    .filter(q => q.time >= cutoff)
    .sort((a, b) => b.time - a.time);

  try {
    const newest = all.length ? all[0].time : Date.now();
    localStorage.setItem(CACHE_KEY, JSON.stringify({ newest, quakes: all }));
  } catch (e) { console.warn('cache save failed:', e); }

  return { all, fetched, bytes: text.length, seconds, fromCache: !!cached };
}
