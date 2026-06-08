// Pointer interaction: hover tooltip, click-to-inspect (detail panel + cluster
// depth cross-section), and double-click-to-focus.
import * as THREE from 'three';
import { camera, earth, setFocus } from './scene.js';
import { getQuakeMeshes, getCluster } from './quakeLayer.js';
import { timeColor } from './colors.js';

const ray = new THREE.Raycaster();
ray.params.Mesh = { threshold: 0 };
const mouse = new THREE.Vector2();

// Translate a mouse event into normalized device coords and aim the raycaster.
function aim(e) {
  mouse.x = (e.clientX / innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / innerHeight) * 2 + 1;
  ray.setFromCamera(mouse, camera);
}

export function initInteraction() {
  const tooltip = document.getElementById('tooltip');
  const detailEl = document.getElementById('detail');
  const detailBody = document.getElementById('detail-body');
  const xsection = document.getElementById('xsection');

  // hover → tooltip
  addEventListener('pointermove', (e) => {
    aim(e);
    const hits = ray.intersectObjects(getQuakeMeshes(), false);
    if (hits.length) {
      const q = hits[0].object.userData.quake;
      tooltip.style.display = 'block';
      tooltip.style.left = e.clientX + 'px';
      tooltip.style.top = e.clientY + 'px';
      tooltip.innerHTML =
        `<b>M ${q.mag.toFixed(1)}</b> — ${q.place}<br>` +
        `depth ${q.depth.toFixed(1)} km · ${fmtUtc(q.time)} UTC`;
    } else {
      tooltip.style.display = 'none';
    }
  });

  // click (not drag) → detail + cross-section
  let downX = 0, downY = 0;
  addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; });
  addEventListener('pointerup', (e) => {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return; // it was a drag
    aim(e);
    const hits = ray.intersectObjects(getQuakeMeshes(), false);
    if (!hits.length) return;
    const u = hits[0].object.userData;
    showDetail(detailEl, detailBody, xsection, u.quake, getCluster(u.cluster), u.isMainshock);
  });
  document.getElementById('detail-close').addEventListener('click', () => {
    detailEl.style.display = 'none';
  });

  // double-click globe or quake → set the orbit pivot there
  addEventListener('dblclick', (e) => {
    aim(e);
    const hits = ray.intersectObjects([earth, ...getQuakeMeshes()], false);
    if (hits.length) setFocus(hits[0].point);
  });
}

function fmtUtc(ms) {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

function showDetail(detailEl, detailBody, xsection, q, cluster, isMainshock) {
  detailBody.innerHTML =
    `<b>M ${q.mag.toFixed(1)}</b> — ${q.place}<br>` +
    `depth <b>${q.depth.toFixed(1)} km</b> · ${fmtUtc(q.time)} UTC<br>` +
    `<small style="opacity:0.85">cluster: ${cluster.items.length} events` +
    (isMainshock ? ' · <span style="color:#ffd24a;">mainshock</span>' : '') +
    (cluster.noise ? ' · isolated (noise)' : '') + '</small>';
  detailEl.style.display = 'block';
  drawCrossSection(xsection, cluster.items, q);
}

// Project a cluster onto its principal horizontal axis and plot depth vs. that
// distance — a side view that reveals fault / subduction dip.
function drawCrossSection(canvas, items, clicked) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const padL = 34, padR = 10, padT = 10, padB = 22;

  let clat = 0, clon = 0;
  for (const q of items) { clat += q.lat; clon += q.lon; }
  clat /= items.length; clon /= items.length;
  const cosL = Math.cos(clat * Math.PI / 180);
  const pts = items.map(q => ({
    e: (q.lon - clon) * 111.32 * cosL, // km east
    n: (q.lat - clat) * 111.32,        // km north
    d: q.depth, q,
  }));

  // PCA on (e, n) → principal horizontal axis angle
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) { sxx += p.e * p.e; sxy += p.e * p.n; syy += p.n * p.n; }
  const ang = 0.5 * Math.atan2(2 * sxy, (sxx - syy) || 1e-9);
  const ax = Math.cos(ang), ay = Math.sin(ang);
  for (const p of pts) p.x = p.e * ax + p.n * ay; // along-strike distance

  let xmin = Infinity, xmax = -Infinity, dmax = 0;
  for (const p of pts) { xmin = Math.min(xmin, p.x); xmax = Math.max(xmax, p.x); dmax = Math.max(dmax, p.d); }
  const xspan = (xmax - xmin) || 1, dspan = dmax || 1;
  const sx = v => padL + (v - xmin) / xspan * (W - padL - padR);
  const sy = d => padT + d / dspan * (H - padT - padB);

  // axes
  ctx.strokeStyle = '#24365c'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, H - padB); ctx.lineTo(W - padR, H - padB); ctx.stroke();
  ctx.fillStyle = '#7f93c0'; ctx.font = '10px system-ui';
  ctx.fillText('0', 6, padT + 8);
  ctx.fillText(dmax.toFixed(0) + 'km', 2, H - padB);
  ctx.fillText(xspan.toFixed(0) + ' km along strike', padL + 4, H - 6);

  // points, colored by recency within this cluster (newest-first)
  const newest = items[0].time, oldest = items[items.length - 1].time;
  const span = Math.max(1, newest - oldest);
  for (const p of pts) {
    const c = timeColor((newest - p.q.time) / span);
    const isClicked = p.q === clicked;
    ctx.beginPath();
    ctx.arc(sx(p.x), sy(p.d), isClicked ? 5 : 3, 0, Math.PI * 2);
    ctx.fillStyle = `rgb(${(c.r * 255) | 0},${(c.g * 255) | 0},${(c.b * 255) | 0})`;
    ctx.fill();
    if (isClicked) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); }
  }
}
