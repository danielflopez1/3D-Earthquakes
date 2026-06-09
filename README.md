# 3D Earthquake Visualizer

An interactive 3D globe that plots magnitude 3.0+ earthquakes from the last five
years (USGS data) at their true geographic location and real depth below the
surface. It groups quakes into spatio-temporal clusters, draws the sequence of
each aftershock series, lets you scrub through time, and shows probabilistic
aftershock / post-tremor scenarios from trained offline models.

**Live demo:** https://danielflopez1.github.io/3D-Earthquakes/

Built with [Three.js](https://threejs.org/) and native ES modules — no build
step, no dependencies to install. It runs as static files.

---

## What you're looking at

Each earthquake is a sphere placed on (or below) the globe:

| Visual encoding | Meaning |
| --- | --- |
| **Sphere position** | Real latitude / longitude |
| **Depth below the surface** | Real focal depth, scaled to the Earth's 6371 km radius |
| **Sphere size** | Magnitude |
| **Sphere color** | Recency — red (newest) → green (oldest) |
| **Lines between quakes** | A local sequence (one cluster), colored blue (recent) → purple (older) |
| **Vertical lines** | Depth lines dropping each quake to its surface point |
| **Ghost dots** | Projected post-tremor scenarios for the selected active sequence |

The globe itself is semi-transparent so you can see quakes on the far side and
those that sit deep inside the mantle.

---

## How to use it

### Camera
- **Drag** to rotate the globe
- **Scroll** to zoom (zooms toward the cursor)
- **Double-click** a quake or the globe to set the orbit focus point there

### Controls (top-right: time · bottom-right: display)

**Time window**
- **From / To sliders** — restrict the visible range to a slice of the 5 years
- **▶ Play** — time-lapse: sweeps the *To* edge forward so quakes appear in the
  order they happened. The **speed** slider sets the pace.

**Display**
- **Globe** — globe opacity (turn it down to see interior structure)
- **Quakes** — overall sphere size multiplier
- **Orbit** — a jog-wheel: drag it to swing the camera around the focus point to
  a new diagonal, then release to recenter. Pair it with double-click-to-focus
  for a close-up turntable on any cluster.
- **Depth lines** — toggle the vertical drop-lines
- **Mainshock focus** — dim the swarm and highlight the largest event in each
  cluster, so the mainshock/aftershock structure stands out
- **Direction arrows** — chevrons along each sequence showing the migration
  direction of the rupture over time

### Inspecting a quake
- **Hover** a sphere for a tooltip (magnitude, place, depth, time)
- **Click** a sphere to open the detail panel. It shows the event and a
  **cross-section** of its whole cluster — depth plotted against distance along
  the cluster's principal axis (a side view that reveals fault dip or
  subduction geometry). If the sequence is active enough, it also shows an
  Omori aftershock fit, possible intensity, and projected post-tremor ghost dots.

---

## How it works

### Data pipeline
On load, `usgs.js` queries the [USGS FDSN event API](https://earthquake.usgs.gov/fdsnws/event/1/)
for M3+ events over the last 5 years as CSV. USGS rejects any single query that
would return more than 20,000 rows, so the fetcher **bisects the time window**
recursively until each slice fits under the cap, then merges the pieces.

The cache lives in IndexedDB because the M3+ catalog is too large for
`localStorage`. A deployed site can also serve `data/quakes.csv` as a baked M4+
snapshot for fast first paint; the client then fills M3 and new events live and
caches the result.

### Clustering
`clustering.js` runs **ST-DBSCAN** (spatio-temporal DBSCAN): two quakes are
neighbors if they're within the configured spatial radius and temporal window
(great-circle distance via the haversine formula). A naive all-pairs scan is O(n²) — fatal at
M3 scale — so neighbors are found with a **spatio-temporal hash grid** (cells
of ~epsKm in lat/lon and ~epsDays in time, with longitude widened toward the
poles and wrapped across the antimeridian). The grid only prunes the candidate
set; the exact distance/time tests still decide every edge, so results are
identical to brute force. Dense groups become clusters; isolated events are
marked as noise. Each cluster is what gets drawn as a connected sequence.

### Forecasting

Forecasting is split into two layers.

The first layer is a sequence-local aftershock model. When you click a cluster,
`forecast.js` fits a Modified Omori-Utsu decay curve to aftershock times:

```text
lambda(t) = K / (t + c)^p
```

That fit controls *when* ghost events are allowed. Forecasts start from the
catalog-current time, not from the last event in an old sequence, so stale
clusters decay toward no visible predictions.

The second layer is an offline machine-learning background/trigger system. The
browser loads compact JSON artifacts from `data/`:

| Artifact | Role |
| --- | --- |
| `forecast_model_m3.json` | Dense M3+ background model for fuller tremor clouds |
| `forecast_model_m4.json` | Best balanced M4+ model; highest weight in the app |
| `forecast_model_m5.json` | Sparse M5+ strong-event context model |
| `trigger_model.json` | Empirical M5/M6/M7/M8 initializer effects on M3/M4 post-tremors |
| `forecast_sweep.json` | Validation comparison across magnitude floors |
| `forecast_backtest.json` | Latest single-model backtest report, when generated |

The app blends these models as follows:

| Model | Weight | Use |
| --- | ---: | --- |
| M4+ | 1.00 | Primary balanced hotspot/risk-ranking signal |
| M3+ | 0.75 | Denser spatial detail for small post-tremors |
| M5+ | 0.55 | Strong-earthquake context |
| Trigger table | conditional | Boosts only recent M5+ mainshock sequences |

The ghost dots are therefore not fixed-size duplicates. Their locations are a
blend of Omori timing, observed local sequence geometry, nearby historical
analogs, and weighted model-favored cells. Their magnitudes, sizes, and possible
intensity are sampled from the learned/local distributions.

Important limitation: this is a probabilistic hotspot and aftershock-scenario
model. It is not deterministic earthquake prediction and should not be used for
safety-critical decisions.

### Rendering
`quakeLayer.js` builds the scene geometry. All quakes render as a single
**`InstancedMesh`** — one draw call for the whole catalog, with per-instance
position, size, and color — which is what makes 80k spheres run at full frame
rate. A raycast hit reports an `instanceId` that maps straight back to the
quake. Depth lines, sequence polylines, and direction chevrons are likewise
merged into single `LineSegments` objects with per-vertex colors. Depth is
proportional to the real Earth radius, and the globe uses an ocean alpha mask so
transparency reads correctly from any angle.

### Project structure
No bundler — the browser loads ES modules directly, which is also why it deploys
to GitHub Pages unchanged.

```
index.html        markup + import map + entry <script type="module">
styles.css        all UI styling
src/
  main.js         entry point — wires modules together, kicks off the load
  config.js       tunable constants (magnitude floor, cluster radius, URLs…)
  state.js        shared mutable app state
  geo.js          lat/lon/depth → 3D vector, haversine distance
  colors.js       recency + sequence color ramps
  clustering.js   ST-DBSCAN spatio-temporal clustering
  usgs.js         load order: cache → baked snapshot → live USGS, + delta top-up
  scene.js        renderer, camera, controls, earth, starfield, focus/orbit
  quakeLayer.js   quake spheres, depth lines, sequences, arrows, visual modes
  interaction.js  hover tooltip, click detail, cross-section, focus
  ui.js           panel / slider / toggle / playback wiring
scripts/
  fetch-quakes.mjs        Node build-time USGS fetch → data/quakes.csv
  train_forecast_model.py Python ML forecast/backtest artifact generator
  train_trigger_model.py  Python strong-initializer post-tremor model
data/
  forecast_model_m3.json  trained M3+ background model
  forecast_model_m4.json  trained M4+ background model
  forecast_model_m5.json  trained M5+ background model
  trigger_model.json      M5-M8 initializer effect table/model report
  forecast_sweep.json     validation sweep report
.github/workflows/
  update-data.yml         hourly cron: rebuild snapshot + deploy to Pages
```

The module graph has no cycles: `config` and `state` are leaves, everything
flows up to `main`. DOM access lives only in `ui.js` and `interaction.js`,
keeping the render layer DOM-free.

---

## Running locally

The app is static files, but ES modules require a server (opening `index.html`
via `file://` won't work). Any static server does:

```bash
# Python
python -m http.server 8123

# or Node
npx serve
```

Then open `http://localhost:8123`.

---

## Training The Models

The browser does not train models. Training is offline Python, and the output is
plain JSON that GitHub Pages can serve statically.

Required Python packages:

```bash
pip install numpy pandas scikit-learn
```

`xgboost` is optional. If installed, `train_forecast_model.py` uses it for the
point model; otherwise it falls back to scikit-learn Random Forest. Quantile
intervals use scikit-learn gradient boosting.

### Comprehensive Sweep

This evaluates where the model works across M3+ through M8+ targets and writes
`data/forecast_sweep.json`:

```bash
python scripts/train_forecast_model.py --min-mag 3 --top-cells 900 --max-rows 120000 --backtest-days 365 --backtest-top-k 100 --sweep-min-mags 3,4,5,6,7,8
```

Most recent sweep results:

| Target | Catalog events | P10-P90 coverage | Top-100 capture | Interpretation |
| --- | ---: | ---: | ---: | --- |
| M3+ | 103,461 | 90.7% | 69.7% | Works, dense but noisy |
| M4+ | 80,397 | 92.2% | 75.4% | Best overall balance |
| M5+ | 9,062 | 90.5% | 72.2% | Good sparse high-magnitude context |
| M6+ | 659 | 93.9% | 100% | Too sparse for broad ranking metrics |
| M7+ | 73 | n/a | n/a | Too sparse to train reliably |
| M8+ | 3 | n/a | n/a | Scenario bucket only |

### Final Background Artifacts

These are the model files the app currently loads:

```bash
python scripts/train_forecast_model.py --min-mag 3 --top-cells 900 --max-rows 120000 --out data/forecast_model_m3.json --skip-backtest
python scripts/train_forecast_model.py --min-mag 4 --top-cells 700 --max-rows 100000 --out data/forecast_model_m4.json --skip-backtest
python scripts/train_forecast_model.py --min-mag 5 --top-cells 400 --max-rows 60000 --out data/forecast_model_m5.json --skip-backtest
```

Each forecast cell stores:

| Field | Meaning |
| --- | --- |
| `rate30P10`, `rate30P50`, `rate30P90` | 10/50/90% quantile estimates for 30-day event count |
| `rate30Point` | Point model estimate |
| `forecastScore` | Ranking/visual weighting score used by the browser |
| `mag50`, `mag90` | Recent cell magnitude distribution |
| `depth50`, `depth90` | Recent cell depth distribution |
| `mmi50`, `mmi90` | Approximate near-epicentral intensity buckets |

Because earthquake counts are sparse, `rate30P50` can legitimately be zero even
when the upper quantile is nonzero. The browser uses `forecastScore` for ranking
and visual sampling, not raw median alone.

### Trigger/Repercussion Model

This model asks: if an M5/M6/M7/M8 event occurs, what M3/M4 post-tremor activity
usually follows nearby?

```bash
python scripts/train_trigger_model.py --holdout-days 365
```

It writes `data/trigger_model.json`. The latest empirical 30-day effects were:

| Initializer | M3+ median | M3+ p90 | M4+ median | M4+ p90 |
| --- | ---: | ---: | ---: | ---: |
| M5+ | 5 | 122 | 5 | 110 |
| M6+ | 17 | 175 | 15 | 145 |
| M7+ | 76 | 487 | 61 | 463 |
| M8+ | 1027 | 1921 | 1027 | 1921 |

`M8+` has only a few examples, so it is treated as an empirical scenario bucket,
not a reliable trainable model.

---

## Deploying (auto-updating)

The site deploys to **GitHub Pages via GitHub Actions**, and the earthquake data
refreshes itself **hourly** — no manual steps after the one-time setup.

How it works (`.github/workflows/update-data.yml`):

1. On an hourly `cron` (and on every push to `main`), the workflow runs
   `scripts/fetch-quakes.mjs`, which does the same time-bisected USGS fetch and
   writes a slim snapshot to `data/quakes.csv`.
2. It bundles the code + that snapshot and deploys them straight to Pages as an
   artifact. The frequently changing earthquake snapshot can stay generated by
   Actions, while the compact model JSON files can be committed or generated as
   part of the deploy artifact.
3. Visitors load `data/quakes.csv` (one fast CDN fetch, ~1h stale at most), then
    the client delta-fetches only the handful of events since — so the map is
    current to the minute on every load.

The forecast model JSON files are static assets. GitHub Pages serves them like
any other file, and the app loads them with `fetch('./data/...')`. Make sure the
deployment artifact includes:

```text
data/forecast_model_m3.json
data/forecast_model_m4.json
data/forecast_model_m5.json
data/trigger_model.json
```

If those files are missing, the visualization still works, but forecast ghost
dots fall back to the local Omori/sequence logic without the ML background layer.

One-time setup:

- **Settings → Pages → Source: GitHub Actions** (instead of "Deploy from a
  branch"). After that, pushing code still deploys, and the hourly job keeps the
  data fresh on its own.

Notes:

- The repo must be **public** for unlimited free Actions minutes (each run is
  ~1–2 min). GitHub auto-pauses scheduled workflows after 60 days of repo
  inactivity — any push resumes them.
- If `data/quakes.csv` is absent (e.g. a plain local checkout), the client
  transparently falls back to fetching live from USGS.

Tuning knobs (magnitude floor, year range, cluster thresholds) live in
`src/config.js`; the refresh interval is the `cron` line in the workflow.

---

## Data source

Earthquake data from the U.S. Geological Survey
[Earthquake Hazards Program](https://earthquake.usgs.gov/). USGS data is in the
public domain.
