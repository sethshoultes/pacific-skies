// A simple seeded wave generator, so matches can run before S2's AI stage builder replaces it.
// Deeper stages run longer, send more heavies, and move and fire faster.
import { seedToInt, rand } from './rng.js';
import { TICK_RATE, PATHS } from './rules.js';

export function seedStage(seed, depth) {
  const r = { rng: seedToInt(`${seed}:stage:${depth}`) };
  const pick = (list) => list[Math.floor(rand(r) * list.length)];
  const span = Math.min(30, 12 + depth * 2) * TICK_RATE;
  const waves = [];
  for (let tick = TICK_RATE * 2; tick < span; tick += Math.round((1.4 + rand(r)) * TICK_RATE)) {
    const heavy = rand(r) < Math.min(0.6, 0.15 + depth * 0.08);
    waves.push({
      tick,
      kind: heavy ? 'heavy' : 'drone',
      path: heavy ? pick(['straight', 'sine']) : pick(PATHS),
      x: Math.round((0.15 + rand(r) * 0.7) * 100) / 100,
      count: heavy ? 1 + Math.floor(rand(r) * Math.min(3, 1 + depth / 3)) : 3 + Math.floor(rand(r) * 4),
    });
  }
  return { waves, boss: { tick: span + 3 * TICK_RATE, hp: 30 + depth * 10 }, pace: 1 + depth * 0.4 };
}
