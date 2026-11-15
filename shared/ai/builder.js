// The AI stage builder. `draftStage` lays out a Stormglass stage from a seed and a depth, out of a
// small vocabulary of figures; `checkStage` flies bot matches on a spec and accepts it only when it
// plays fair: medium clears it at a rate inside a band, hard always finds a line through without
// losing a life, and the boss arrives in time and hard can down it before it escapes.
// `buildStage` drafts until a check passes; the game plays only built stages.
import { seedToInt, rand } from '../engine/rng.js';
import { TICK_RATE } from '../engine/rules.js';
import { createMatch } from '../engine/index.js';
import { playAiMatch } from './match.js';

export const STAGE_NAMES = [
  'Gullwind Spire', 'Hollowcloud Reach', 'The Brass Anvil', 'Cirrus Steps', 'Thistledown Heights',
  'Ember Squall', 'Lanternfall', 'Vesper Cumulus', 'Quillstorm Tower', 'Saltlight Ridge',
  'The Copper Updraft', 'Mothwing Gate', 'Rimefeather Pass', 'Kettlethunder', 'The Pale Orrery',
  'Sorrel Downdraft',
];
export const BOSS_FORMS = ['anvilback', 'nimbus-maw'];

// A check flies RUNS matches per level. A medium clear is a stage finished without losing a life.
export const RUNS = 6;
export const MEDIUM_CLEAR_BAND = [1 / 3, 1];
export const BOSS_TICK_LIMIT = 40 * TICK_RATE;
export const MAX_ATTEMPTS = 8;

const r2 = (v) => Math.round(v * 100) / 100;

// Each figure returns the waves it adds at `tick`; x is 0..1 across the sky.
const FIGURES = {
  // a line of drones leaning in from one side
  rake: (r, tick) => [{ tick, kind: 'drone', path: rand(r) < 0.5 ? 'sweep-left' : 'sweep-right', x: r2(0.1 + rand(r) * 0.5), count: 4 + Math.floor(rand(r) * 3) }],
  // two weaving columns, mirrored about the middle
  braid: (r, tick) => {
    const x = r2(0.2 + rand(r) * 0.15);
    const count = 3 + Math.floor(rand(r) * 2);
    return [{ tick, kind: 'drone', path: 'sine', x, count }, { tick, kind: 'drone', path: 'sine', x: r2(1 - x), count }];
  },
  // a falling row
  curtain: (r, tick) => [{ tick, kind: 'drone', path: 'straight', x: r2(0.3 + rand(r) * 0.4), count: 4 + Math.floor(rand(r) * 3) }],
  // drones that hang, then stoop at the nearest kite
  stoop: (r, tick) => [{ tick, kind: 'drone', path: 'dive', x: r2(0.2 + rand(r) * 0.6), count: 3 + Math.floor(rand(r) * 2) }],
  // a thunderhead or two, slow and firing fans
  // (a pair only flies straight: two weaving thunderheads leave no line through)
  anvil: (r, tick, depth) => {
    const pair = depth >= 3 && rand(r) < 0.5;
    return [{ tick, kind: 'heavy', path: !pair && rand(r) < 0.4 ? 'sine' : 'straight', x: r2(0.2 + rand(r) * 0.6), count: pair ? 2 : 1 }];
  },
};
const DRONE_FIGURES = ['rake', 'braid', 'curtain', 'stoop'];

/** Draft a stage spec for the engine. Same seed, depth and attempt, same stage. */
export function draftStage({ seed, depth, attempt = 0 }) {
  if (!Number.isInteger(depth) || depth < 0) throw new Error('depth must be a non-negative integer');
  const r = { rng: seedToInt(`${seed}:draft:${depth}:${attempt}`) };
  const span = Math.min(30, 14 + depth * 2) * TICK_RATE;
  const heavyChance = Math.min(0.35, 0.1 + depth * 0.05);
  const waves = [];
  let last = '';
  for (let tick = 2 * TICK_RATE; tick < span; tick += Math.round((Math.max(1.6, 2.4 - depth * 0.15) + rand(r)) * TICK_RATE)) {
    // never two anvils running: a thunderhead's fans need a drone figure's gap to read
    const name = last !== 'anvil' && rand(r) < heavyChance ? 'anvil' : DRONE_FIGURES[Math.floor(rand(r) * DRONE_FIGURES.length)];
    waves.push(...FIGURES[name](r, tick, depth));
    last = name;
  }
  return {
    name: STAGE_NAMES[(seedToInt(seed) + depth) % STAGE_NAMES.length],
    waves,
    boss: { tick: span + 2 * TICK_RATE, hp: 20 + depth * 2, form: BOSS_FORMS[depth % BOSS_FORMS.length] },
    pace: r2(1 + depth * 0.08),
  };
}

/** Draft until `checkStage` accepts, and return the accepted spec with its check. */
export function buildStage({ seed, depth }) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const spec = draftStage({ seed, depth, attempt });
    const check = checkStage(spec);
    if (check.ok) return { spec, check, attempt };
  }
  throw new Error(`no fair stage for seed ${seed} depth ${depth} in ${MAX_ATTEMPTS} drafts`);
}

/** The stages a match plays: one built stage per depth. */
export const buildStages = (seed, count) => Array.from({ length: count }, (_, depth) => buildStage({ seed, depth }).spec);

/** Fly bot matches on `spec` and say whether it plays fair, with the numbers behind the verdict. */
export function checkStage(spec, { runs = RUNS } = {}) {
  try {
    createMatch({ seed: 0, stages: [spec], seats: 1 });
  } catch (e) {
    return { ok: false, reasons: [e.message] };
  }
  const key = seedToInt(JSON.stringify(spec));
  const fly = (level) => Array.from({ length: runs }, (_, i) => playAiMatch({ seed: `check:${key}:${level}:${i}`, levels: [level], stages: [spec] }));
  const medium = fly('medium');
  const hard = fly('hard');
  const mediumClear = medium.filter((m) => m.result === 'won' && m.deaths === 0).length / runs;
  const hardDeaths = hard.reduce((n, m) => n + m.deaths, 0);
  const bossDowns = hard.reduce((n, m) => n + m.bossesDowned, 0);
  const reasons = [];
  if (mediumClear < MEDIUM_CLEAR_BAND[0] || mediumClear > MEDIUM_CLEAR_BAND[1]) reasons.push(`medium clear rate ${mediumClear.toFixed(2)} is outside ${MEDIUM_CLEAR_BAND.map((v) => v.toFixed(2)).join('..')}`);
  if (hardDeaths > 0) reasons.push(`hard lost ${hardDeaths} lives in ${runs} runs`);
  if (spec.boss.tick > BOSS_TICK_LIMIT) reasons.push(`boss arrives at tick ${spec.boss.tick}, after ${BOSS_TICK_LIMIT}`);
  if (bossDowns === 0) reasons.push('hard never downed the boss before it escaped');
  return { ok: reasons.length === 0, mediumClear, hardDeaths, bossDowns, reasons };
}
