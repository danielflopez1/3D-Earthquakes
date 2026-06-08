// Application entry point. Wires the modules together and kicks off the load.
import { startRenderLoop } from './scene.js';
import { state } from './state.js';
import { loadQuakes } from './usgs.js';
import { initInteraction } from './interaction.js';
import { initUI, onDataLoaded, rebuild } from './ui.js';

initUI();
initInteraction();
startRenderLoop();

loadQuakes()
  .then(res => {
    state.allQuakes = res.all;
    state.tMin = res.all[res.all.length - 1].time; // oldest
    state.tMax = res.all[0].time;                  // newest
    onDataLoaded(res);
    rebuild(res.all);
  })
  .catch(err => {
    const loading = document.getElementById('loading');
    if (loading) loading.textContent = 'Failed to load USGS feed: ' + err.message;
  });
