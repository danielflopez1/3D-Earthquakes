// Application entry point. Wires the modules together and kicks off the load.
import { startRenderLoop } from './scene.js';
import { state } from './state.js';
import { loadQuakes, persistClusterLabels } from './usgs.js';
import { setCatalog } from './quakeLayer.js';
import { initInteraction } from './interaction.js';
import { initUI, onDataLoaded, renderWindow } from './ui.js';

initUI();
initInteraction();
startRenderLoop();

// Render one batch from the progressive loader: re-cluster the catalog we have so
// far (reusing/patching saved labels when possible), then render the full window.
// Big-and-rare bands arrive first, so the globe paints in well under a second and
// fills in as M5/M4/M3 stream in. Cluster labels are persisted only on the final
// batch, so a reload reuses the saved clustering instead of recomputing it.
function renderBatch(res) {
  if (!res.all.length) return;
  state.allQuakes = res.all;
  state.tMin = res.all[res.all.length - 1].time; // oldest
  state.tMax = res.all[0].time;                  // newest
  onDataLoaded(res);

  const { labels } = setCatalog(res.all, res.seedLabels);
  if (res.isFinal) persistClusterLabels(res.all, labels);
  renderWindow(state.tMin, state.tMax);
}

loadQuakes({ onBatch: renderBatch })
  .catch(err => {
    const loading = document.getElementById('loading');
    if (loading) loading.textContent = 'Failed to load USGS feed: ' + err.message;
  });
