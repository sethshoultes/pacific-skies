import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageFor, validateAllStages, isBossStage, stageName, STAGE_NAMES } from '../shared/stages.js';
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

test('every stage number has a flavour name and unknown stages fall back to a sector name', () => {
  for (let n = 1; n <= STAGE_COUNT; n++) {
    assert.equal(typeof STAGE_NAMES[n], 'string', `stage ${n} should have an authored name`);
    assert.ok(STAGE_NAMES[n].length > 0, `stage ${n} name should not be empty`);
    assert.equal(stageFor(n).name, stageName(n));
  }
  assert.equal(stageName(99), 'Sector 99');
});

test('the final stage is a pure victory run with no mid-boss', () => {
  assert.equal(stageFor(1).waves.filter((w) => w.spawn === 'midboss').length, 0);
});
