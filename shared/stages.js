// Stage scripts: 32 stages, counting DOWN from 32 (displayed "STAGE 32") to 1. Each stage is an
// ordered list of timed spawn events plus flavour metadata. A stage lasts STAGE_SECONDS(stage)
// seconds of scripted waves; a boss appears on stage 32, 28, 24, ... (every 4th, counting down
// from 32) and a mid-boss appears halfway through the other stages.
//
// Stage numbers 32..29 are hand-authored below (STAGE_32..STAGE_29). Stages 28..1 are produced
// deterministically by generateStage(n) -- a seeded escalation of the same wave vocabulary -- so
// every stage is playable end to end even though only the first four are hand-tuned for now.
//
// A wave entry: { at: seconds-from-stage-start, spawn: formationType, count, x, params }
//   spawn one of: 'straight', 'sine', 'v-sweep', 'red-formation', 'medium', 'midboss', 'boss'
import { makeRng } from './rng.js';
import { STAGE_COUNT, STAGE_SECONDS_MIN, STAGE_SECONDS_MAX } from './constants.js';

export const STAGE_NAMES = {
  32: 'Midway', 31: 'Marshall Islands', 30: 'Attu', 29: 'Rabaul',
  28: 'Leyte', 27: 'Coral Sea', 26: 'Guadalcanal', 25: 'New Guinea',
  24: 'Saipan', 23: 'Tinian', 22: 'Palau', 21: 'Truk',
  20: 'Iwo Jima', 19: 'Peleliu', 18: 'Formosa', 17: 'Luzon',
  16: 'Okinawa', 15: 'Ie Shima', 14: 'Kyushu', 13: 'Shikoku',
  12: 'Tokyo Bay', 11: 'Yokosuka', 10: 'Osaka', 9: 'Nagoya',
  8: 'Kobe', 7: 'Kure', 6: 'Sasebo', 5: 'Hiroshima',
  4: 'Kagoshima', 3: 'Yokohama', 2: 'Chiba', 1: 'Tokyo',
};

export function stageName(n) { return STAGE_NAMES[n] || `Sector ${n}`; }
export function isBossStage(n) { return n % 4 === 0; } // 32,28,24,...,4 -- stage 1 gets the ending, handled separately
export function isFinalStage(n) { return n === 1; }
export function stageSeconds(n) {
  // Slightly longer stages early in the run (higher stage number), per spec's 60-90s range.
  const t = (STAGE_COUNT - n) / (STAGE_COUNT - 1);
  return Math.round(STAGE_SECONDS_MAX - t * (STAGE_SECONDS_MAX - STAGE_SECONDS_MIN));
}

const STAGE_32 = {
  number: 32, name: stageName(32),
  waves: [
    { at: 2, spawn: 'straight', count: 4, x: 0.2 },
    { at: 6, spawn: 'straight', count: 4, x: 0.7 },
    { at: 11, spawn: 'sine', count: 5, x: 0.5 },
    { at: 17, spawn: 'v-sweep', count: 5, x: 0.1, params: { dir: 1 } },
    { at: 24, spawn: 'red-formation', count: 5, x: 0.5 },
    { at: 32, spawn: 'medium', count: 2, x: 0.3 },
    { at: 38, spawn: 'sine', count: 6, x: 0.5 },
    { at: 45, spawn: 'v-sweep', count: 5, x: 0.9, params: { dir: -1 } },
    { at: 52, spawn: 'medium', count: 3, x: 0.5 },
    { at: 60, spawn: 'boss', count: 1, x: 0.5 },
  ],
};

const STAGE_31 = {
  number: 31, name: stageName(31),
  waves: [
    { at: 2, spawn: 'straight', count: 5, x: 0.15 },
    { at: 7, spawn: 'sine', count: 5, x: 0.5 },
    { at: 13, spawn: 'v-sweep', count: 6, x: 0.05, params: { dir: 1 } },
    { at: 19, spawn: 'red-formation', count: 5, x: 0.4 },
    { at: 26, spawn: 'medium', count: 2, x: 0.6 },
    { at: 32, spawn: 'straight', count: 6, x: 0.5 },
    { at: 38, spawn: 'midboss', count: 1, x: 0.5 },
    { at: 48, spawn: 'sine', count: 6, x: 0.5 },
    { at: 55, spawn: 'v-sweep', count: 6, x: 0.95, params: { dir: -1 } },
    { at: 62, spawn: 'medium', count: 3, x: 0.5 },
  ],
};

const STAGE_30 = {
  number: 30, name: stageName(30),
  waves: [
    { at: 2, spawn: 'sine', count: 5, x: 0.3 },
    { at: 8, spawn: 'straight', count: 6, x: 0.5 },
    { at: 14, spawn: 'red-formation', count: 5, x: 0.6 },
    { at: 21, spawn: 'v-sweep', count: 6, x: 0.1, params: { dir: 1 } },
    { at: 28, spawn: 'medium', count: 3, x: 0.4 },
    { at: 35, spawn: 'midboss', count: 1, x: 0.5 },
    { at: 45, spawn: 'sine', count: 7, x: 0.5 },
    { at: 51, spawn: 'red-formation', count: 5, x: 0.3 },
    { at: 58, spawn: 'v-sweep', count: 6, x: 0.9, params: { dir: -1 } },
    { at: 58, spawn: 'medium', count: 3, x: 0.6 },
    { at: 66, spawn: 'straight', count: 8, x: 0.5 },
  ],
};

const STAGE_29 = {
  number: 29, name: stageName(29),
  waves: [
    { at: 2, spawn: 'straight', count: 6, x: 0.5 },
    { at: 8, spawn: 'sine', count: 6, x: 0.25 },
    { at: 14, spawn: 'v-sweep', count: 6, x: 0.05, params: { dir: 1 } },
    { at: 20, spawn: 'medium', count: 3, x: 0.5 },
    { at: 27, spawn: 'red-formation', count: 5, x: 0.5 },
    { at: 34, spawn: 'midboss', count: 1, x: 0.5 },
    { at: 44, spawn: 'sine', count: 7, x: 0.75 },
    { at: 51, spawn: 'v-sweep', count: 6, x: 0.95, params: { dir: -1 } },
    { at: 58, spawn: 'red-formation', count: 5, x: 0.4 },
    { at: 65, spawn: 'medium', count: 4, x: 0.5 },
  ],
};

const AUTHORED = { 32: STAGE_32, 31: STAGE_31, 30: STAGE_30, 29: STAGE_29 };

/** Deterministic escalation for stages that aren't hand-authored (28..1), seeded by stage number
 *  so the same stage always plays out identically. */
export function generateStage(n) {
  if (AUTHORED[n]) return AUTHORED[n];
  const rng = makeRng(`stage-${n}`);
  const seconds = stageSeconds(n);
  const boss = isBossStage(n);
  const waves = [];
  let t = 2;
  const depth = STAGE_COUNT - n; // how far into the run, drives density
  const pool = ['straight', 'sine', 'v-sweep', 'red-formation', 'medium'];
  const budget = boss ? seconds - 12 : (n === 1 ? seconds - 6 : seconds - 8);
  let placedRed = false;
  let placedMid = boss; // non-boss stages get exactly one mid-boss (placedMid starts false); boss stages get the real boss instead, so start "already placed"
  while (t < budget) {
    let type = pool[Math.floor(rng() * pool.length)];
    if (type === 'red-formation' && placedRed && rng() < 0.6) type = 'straight';
    if (type === 'red-formation') placedRed = true;
    const count = 3 + Math.min(5, Math.floor(depth / 4)) + Math.floor(rng() * 2);
    waves.push({ at: t, spawn: type, count, x: Math.round(rng() * 100) / 100, params: type === 'v-sweep' ? { dir: rng() < 0.5 ? 1 : -1 } : undefined });
    t += 5 + Math.floor(rng() * 4);
    if (!placedMid && t > budget * 0.45) {
      waves.push({ at: t, spawn: 'midboss', count: 1, x: 0.5 });
      placedMid = true;
      t += 10;
    }
  }
  if (boss) waves.push({ at: seconds, spawn: 'boss', count: 1, x: 0.5 });
  return { number: n, name: stageName(n), waves, generated: true };
}

export function stageFor(n) { return AUTHORED[n] || generateStage(n); }

/** Validate a stage script: waves sorted by `at`, has a boss iff isBossStage(n), has exactly one
 *  mid-boss iff it's not a boss stage (final stage 1 is exempt from the mid-boss requirement so
 *  it can end in a pure victory run). Returns an array of problem strings (empty = valid). */
export function validateStage(stage) {
  const problems = [];
  const n = stage.number;
  let lastAt = -Infinity;
  let bossCount = 0, midBossCount = 0;
  for (const w of stage.waves) {
    if (w.at < lastAt) problems.push(`stage ${n}: waves out of order at t=${w.at}`);
    lastAt = w.at;
    if (w.spawn === 'boss') bossCount++;
    if (w.spawn === 'midboss') midBossCount++;
  }
  if (isBossStage(n) && bossCount !== 1) problems.push(`stage ${n}: expected exactly one boss, got ${bossCount}`);
  if (!isBossStage(n) && n !== 1 && midBossCount !== 1) problems.push(`stage ${n}: expected exactly one mid-boss, got ${midBossCount}`);
  if (stage.waves.length === 0) problems.push(`stage ${n}: no waves`);
  return problems;
}

export function validateAllStages() {
  const problems = [];
  for (let n = 1; n <= STAGE_COUNT; n++) problems.push(...validateStage(stageFor(n)));
  return problems;
}
