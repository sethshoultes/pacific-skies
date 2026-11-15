import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { createMatch } from '../shared/engine/index.js';
import { TICK_RATE } from '../shared/engine/rules.js';
import { draftStage, checkStage, STAGE_NAMES, BOSS_FORMS, BOSS_TICK_LIMIT } from '../shared/ai/builder.js';

const SEEDS = 200;
const DEPTHS = 6;

function sweep(jobs) {
  const n = Math.max(1, Math.min(availableParallelism() - 1, 8));
  const slices = Array.from({ length: n }, (_, i) => jobs.filter((_, j) => j % n === i)).filter((s) => s.length);
  return Promise.all(slices.map((slice) => new Promise((resolve, reject) => {
    const w = new Worker(new URL('./helpers/build-sweep-worker.mjs', import.meta.url), { workerData: { jobs: slice } });
    w.once('message', resolve);
    w.once('error', reject);
  }))).then((parts) => parts.flat());
}

test(`built stages over ${SEEDS} seeds all pass checkStage, and most first drafts already do`, async (t) => {
  const jobs = Array.from({ length: SEEDS }, (_, i) => ({ seed: String(i), depth: i % DEPTHS }));
  const results = await sweep(jobs);
  assert.equal(results.length, SEEDS);
  for (const r of results) assert.equal(r.check.ok, true, `seed ${r.seed} depth ${r.depth}: ${r.check.reasons}`);
  const firstDraft = results.filter((r) => r.attempt === 0).length;
  t.diagnostic(`first drafts accepted: ${firstDraft}/${SEEDS}; most drafts for one stage: ${Math.max(...results.map((r) => r.attempt + 1))}`);
  assert.ok(firstDraft >= SEEDS * 0.95, `${firstDraft}/${SEEDS} first drafts accepted`);
});

test('draftStage is deterministic, valid, named, and harder with depth', () => {
  assert.deepEqual(draftStage({ seed: 's', depth: 3 }), draftStage({ seed: 's', depth: 3 }));
  assert.notDeepEqual(draftStage({ seed: 's', depth: 3 }), draftStage({ seed: 't', depth: 3 }));
  assert.notDeepEqual(draftStage({ seed: 's', depth: 3 }), draftStage({ seed: 's', depth: 3, attempt: 1 }));
  const stages = Array.from({ length: 8 }, (_, depth) => draftStage({ seed: 's', depth }));
  createMatch({ seed: 's', stages, seats: 1 }); // throws if any stage is malformed
  for (let d = 1; d < 8; d++) {
    assert.ok(stages[d].pace > stages[d - 1].pace);
    assert.ok(stages[d].boss.hp > stages[d - 1].boss.hp);
    assert.notEqual(stages[d].boss.form, stages[d - 1].boss.form, 'the two bosses take turns');
  }
  for (const s of stages) {
    assert.ok(STAGE_NAMES.includes(s.name));
    assert.ok(BOSS_FORMS.includes(s.boss.form));
  }
  assert.throws(() => draftStage({ seed: 's', depth: -1 }), /depth/);
});

test('checkStage rejects an unavoidable wall of sparks', () => {
  // full-width rows of thunderheads, each firing a fan, one after another
  const waves = [];
  for (let tick = 20; tick <= 200; tick += 20) {
    for (const x of [0.1, 0.5, 0.9]) waves.push({ tick, kind: 'heavy', path: 'straight', x, count: 12 });
  }
  const check = checkStage({ waves, boss: { tick: 300, hp: 20 }, pace: 3 });
  assert.equal(check.ok, false);
  assert.ok(check.hardDeaths > 0, 'hard finds no line through');
  assert.ok(check.reasons.some((r) => /hard lost/.test(r)), check.reasons.join('; '));
});

test('checkStage rejects a boss that arrives too late or cannot be downed, and a malformed spec', () => {
  const late = checkStage({ waves: [], boss: { tick: BOSS_TICK_LIMIT + TICK_RATE, hp: 20 } }, { runs: 1 });
  assert.ok(late.reasons.some((r) => /boss arrives/.test(r)), late.reasons.join('; '));
  const tank = checkStage({ waves: [], boss: { tick: 60, hp: 100000 } }, { runs: 1 });
  assert.ok(tank.reasons.some((r) => /never downed the boss/.test(r)), tank.reasons.join('; '));
  assert.deepEqual(checkStage({ waves: 'none' }).ok, false);
});

test('checkStage accepts a fair stage', () => {
  const fair = { waves: [{ tick: 60, kind: 'drone', path: 'straight', x: 0.5, count: 4 }], boss: { tick: 150, hp: 20 } };
  assert.equal(checkStage(fair).ok, true);
});
