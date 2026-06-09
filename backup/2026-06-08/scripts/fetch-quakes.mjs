// Build-time data snapshot generator (run by .github/workflows/update-data.yml).
//
// Performs the same time-bisected USGS fetch the browser would, then writes a
// slim CSV snapshot to data/quakes.csv. The deployed page loads that snapshot
// for a fast first paint instead of every visitor re-running the ~30s live
// fetch (see tryLoadBaked() in src/usgs.js). Runs in Node 18+ (global fetch).
//
//   node scripts/fetch-quakes.mjs
//
// Imports the pure helpers from the app so the fetch/parse logic stays in one
// place. No npm dependencies — only Node built-ins.

import { mkdir, writeFile } from 'node:fs/promises';
import { feedUrl, SNAPSHOT_MIN_MAG, YEARS } from '../src/config.js';
import { parseUsgsCsv } from '../src/usgs.js';

const MIN_SPLIT_MS = 24 * 3600 * 1000; // don't bisect below a single day

// Fetch one window, halving it (in parallel) whenever USGS rejects the query for
// exceeding its 20k-row cap. Mirrors fetchRange() in src/usgs.js. The snapshot is
// kept at M4+ (SNAPSHOT_MIN_MAG) so data/quakes.csv stays small — the browser
// fills the M3 long tail in live on first visit and caches it (see src/usgs.js).
async function fetchRange(startMs, endMs) {
  const url = feedUrl(new Date(startMs).toISOString(), new Date(endMs).toISOString(), SNAPSHOT_MIN_MAG);
  const res = await fetch(url);
  if (res.ok) return parseUsgsCsv(await res.text());
  if (res.status === 400 && endMs - startMs > MIN_SPLIT_MS) {
    const mid = Math.floor((startMs + endMs) / 2);
    const [a, b] = await Promise.all([fetchRange(startMs, mid), fetchRange(mid + 1, endMs)]);
    return a.concat(b);
  }
  throw new Error(`USGS ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// Quote a CSV field only when it contains a comma, quote, or newline.
function csvField(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function main() {
  const now = Date.now();
  const start = new Date();
  start.setFullYear(start.getFullYear() - YEARS);

  console.log(`Fetching M${SNAPSHOT_MIN_MAG}+ from ${start.toISOString()} to ${new Date(now).toISOString()} …`);
  const fetched = await fetchRange(start.getTime(), now);

  // de-dup by id, drop anything past the window, newest first
  const byId = new Map();
  for (const q of fetched) byId.set(q.id, q);
  const cutoff = now - YEARS * 365.25 * 24 * 3600 * 1000;
  const all = [...byId.values()].filter(q => q.time >= cutoff).sort((a, b) => b.time - a.time);

  // slim CSV: only the columns the browser parser reads (src/usgs.js parseUsgsCsv)
  const header = 'time,latitude,longitude,depth,mag,id,place';
  const rows = all.map(q => [
    new Date(q.time).toISOString(),
    q.lat, q.lon, q.depth, q.mag,
    csvField(q.id), csvField(q.place),
  ].join(','));

  await mkdir('data', { recursive: true });
  await writeFile('data/quakes.csv', header + '\n' + rows.join('\n') + '\n');
  console.log(`Wrote data/quakes.csv — ${all.length} events.`);
}

main().catch(err => { console.error(err); process.exit(1); });
