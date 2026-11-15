// Builds a match's stages off the main thread: each one is drafted and bot-checked before it ships.
import { buildStage } from '../shared/ai/builder.js';

self.onmessage = ({ data: { seed, count } }) => {
  const stages = [];
  for (let depth = 0; depth < count; depth++) {
    stages.push(buildStage({ seed, depth }).spec);
    self.postMessage({ seed, done: depth + 1, count });
  }
  self.postMessage({ seed, stages });
};
