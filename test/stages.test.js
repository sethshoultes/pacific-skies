import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageFor, validateAllStages, isBossStage, STAGE_NAMES } from '../shared/stages.js';
import { STAGE_COUNT } from '../shared/constants.js';

test('all 32 stages validate cleanly (boss every 4th, mid-boss otherwise, sorted waves)', () => {
  const problems = validateAllStages();
  assert.deepEqual(problems, []);
});

test('stage 32 has a boss and stage 1 is the final stage', () => {
  const s32 = stageFor(32);
  assert.ok(s32.waves.some((w) => w.spawn === 'boss'));
  assert.equal(isBossStage(32), true);
  assert.equal(isBossStage(1), false);
});

test('boss stages occur exactly every 4th, counting down from 32', () => {
  for (let n = 1; n <= STAGE_COUNT; n++) {
    assert.equal(isBossStage(n), n % 4 === 0);
  }
});

test('stages 32..29 are hand-authored (not the generated fallback)', () => {
  for (const n of [32, 31, 30, 29]) {
    const s = stageFor(n);
    assert.ok(!s.generated, `stage ${n} should be authored`);
    assert.ok(s.waves.length >= 8);
  }
});

test('stages 28..1 are playable via the deterministic generator and reproducible', () => {
  for (const n of [28, 20, 10, 1]) {
    const a = stageFor(n);
    const b = stageFor(n);
    assert.deepEqual(a.waves, b.waves, `stage ${n} should be deterministic across calls`);
  }
});

test('every stage number has a flavour name', () => {
  for (let n = 1; n <= STAGE_COUNT; n++) assert.ok(typeof STAGE_NAMES[n] === 'string' && STAGE_NAMES[n].length > 0, `stage ${n} needs a name`);
});

test('stage 1 has no mid-boss so the finale is a pure victory run, and still validates', () => {
  const s1 = stageFor(1);
  assert.equal(s1.waves.filter((w) => w.spawn === 'midboss').length, 0);
  assert.equal(s1.waves.filter((w) => w.spawn === 'boss').length, 0);
});

test('stageName falls back to a generated sector name for unknown stages', async () => {
  const { stageName } = await import('../shared/stages.js');
  assert.match(stageName(999), /Sector 999/);
});
