import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { createMatch, step, legalActions } from '../shared/engine/index.js';
import { seedStage } from '../shared/engine/stages-seed.js';
import { pilotAction, LEVELS } from '../shared/ai/pilot.js';

const QUIET = { waves: [], boss: { tick: 100000, hp: 5 } };
const SEEDS = 50;
const STAGES = 6;

function sweep(jobs) {
  const n = Math.max(1, Math.min(availableParallelism() - 1, 8));
  const slices = Array.from({ length: n }, (_, i) => jobs.filter((_, j) => j % n === i)).filter((s) => s.length);
  return Promise.all(slices.map((slice) => new Promise((resolve, reject) => {
    const w = new Worker(new URL('./helpers/ai-sweep-worker.mjs', import.meta.url), { workerData: { jobs: slice } });
    w.once('message', resolve);
    w.once('error', reject);
  }))).then((parts) => parts.flat());
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

test(`AI vs AI over ${SEEDS} seeds: hard's median stage >= medium's >= easy's, and every match ends within its cap`, async (t) => {
  const levels = Object.keys(LEVELS);
  const jobs = levels.flatMap((level) => Array.from({ length: SEEDS }, (_, i) => ({ seed: String(i), levels: [level, level], stageCount: STAGES })));
  const results = await sweep(jobs);
  assert.equal(results.length, jobs.length);
  for (const r of results) {
    assert.equal(r.ended, true, `seed ${r.seed} ${r.levels[0]} did not end`);
    assert.ok(r.ticks <= r.cap, `seed ${r.seed} ${r.levels[0]} ran ${r.ticks} ticks, cap ${r.cap}`);
  }
  const med = Object.fromEntries(levels.map((l) => [l, median(results.filter((r) => r.levels[0] === l).map((r) => r.stageReached))]));
  t.diagnostic(`median stage reached of ${STAGES}: ${JSON.stringify(med)}`);
  assert.ok(med.hard >= med.medium && med.medium >= med.easy, JSON.stringify(med));
});

test('pilotAction returns a legal action, is deterministic, and leaves the state alone', () => {
  const s = createMatch({ seed: 'p', stages: [seedStage('p', 2)], seats: 2 });
  let state = s;
  for (let i = 0; i < 200; i++) state = step(state, [pilotAction(state, 0, 'hard'), pilotAction(state, 1, 'easy')]).state;
  const before = JSON.stringify(state);
  for (const level of Object.keys(LEVELS)) {
    const a = pilotAction(state, 0, level);
    assert.ok(legalActions(state, 0).some((l) => JSON.stringify(l) === JSON.stringify(a)), level);
    assert.deepEqual(pilotAction(state, 0, level), a);
  }
  assert.equal(JSON.stringify(state), before);
  assert.throws(() => pilotAction(state, 0, 'expert'), /unknown level/);
});

test('the pilot steps out of a spark that an idle pilot would take', () => {
  const s = createMatch({ seed: 'd', stages: [QUIET], seats: 1 });
  s.pilots[0].invuln = 0;
  s.sparks.push({ id: s.nextId++, x: s.pilots[0].x, y: s.pilots[0].y - 40, vx: 0, vy: 4 });
  let idle = s;
  for (let i = 0; i < 12; i++) idle = step(idle, [{ move: 0, fire: false, dash: false }]).state;
  assert.equal(idle.pilots[0].alive, false, 'control: standing still is fatal');
  let ai = s;
  for (let i = 0; i < 12; i++) ai = step(ai, [pilotAction(ai, 0, 'hard')]).state;
  assert.equal(ai.pilots[0].alive, true);
});
