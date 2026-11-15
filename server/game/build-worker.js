// Builds a room's stages off the server's event loop: each one is drafted and bot-checked.
import { parentPort } from 'node:worker_threads';
import { buildStages } from '../../shared/ai/builder.js';

parentPort.on('message', ({ seed, count }) => {
  try { parentPort.postMessage({ stages: buildStages(seed, count) }); }
  catch (e) { parentPort.postMessage({ error: e.message }); }
});
