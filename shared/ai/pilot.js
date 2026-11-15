// The AI pilot: try each legal move a few ticks ahead with the real `step`, then score the
// outcome by survival first, then aim, then pickups. Levels differ in look-ahead depth and in how
// often the pilot re-decides (`period`): easy reacts late, hard looks far and often.
import { legalActions, step, advance } from '../engine/index.js';
import { WORLD_H, PILOT_R, PILOT_SPEED, SPARK_R, ENEMY } from '../engine/rules.js';

export const LEVELS = {
  easy: { depth: 2, period: 12 },
  medium: { depth: 5, period: 8 },
  hard: { depth: 8, period: 5 },
};

const IDLE = { move: 0, fire: false, dash: false };
const MARGIN_CAP = 30; // clearance beyond this earns nothing more, so aim can decide

function dangerMargin(s, p) {
  let m = Infinity;
  for (const b of s.sparks) m = Math.min(m, Math.hypot(b.x - p.x, b.y - p.y) - SPARK_R - PILOT_R);
  for (const e of s.enemies) m = Math.min(m, Math.hypot(e.x - p.x, e.y - p.y) - ENEMY[e.kind].r - PILOT_R);
  return m;
}

// Can anything reach the pilot inside the look-ahead? If not, a 1-tick look is enough to aim.
function threatened(s, p, depth) {
  const reach = (b, r) => Math.hypot(b.x - p.x, b.y - p.y) - r - PILOT_R
    < depth * (Math.hypot(b.vx, b.vy) + 4 + PILOT_SPEED) + MARGIN_CAP;
  return s.sparks.some((b) => reach(b, SPARK_R)) || s.enemies.some((e) => reach(e, ENEMY[e.kind].r));
}

function score(state, seat, first, depth) {
  const hold = { ...first, dash: false };
  const others = state.pilots.map(() => ({ move: 0, fire: true, dash: false }));
  let s;
  let margin = Infinity;
  const lives = state.pilots[seat].lives;
  for (let t = 1; t <= depth; t++) {
    if (t === 1) {
      others[seat] = first;
      s = step(state, others).state; // our own copy from here on, so the rest can advance in place
      others[seat] = hold;
    } else {
      advance(s, others);
    }
    const p = s.pilots[seat];
    if (!p.alive || p.lives < lives) return -1e6 * (depth - t + 1);
    margin = Math.min(margin, dangerMargin(s, p));
  }
  const p = s.pilots[seat];
  let v = Math.min(margin, MARGIN_CAP) * 40;                             // survival
  let aim = Infinity;
  for (const e of s.enemies) if (e.y < p.y && e.y > 0) aim = Math.min(aim, Math.max(0, Math.abs(e.x - p.x) - ENEMY[e.kind].r));
  if (aim < Infinity) v -= aim * 4;                              // aim
  let pick = Infinity;
  for (const it of s.pickups) pick = Math.min(pick, Math.hypot(it.x - p.x, it.y - p.y));
  if (pick < 200) v -= pick;                                     // pickups
  v -= Math.max(0, WORLD_H * 0.55 - p.y) * 3;                    // stay in the lower half
  if (first.dash) v -= 300;                                      // keep the dash for emergencies
  return v;
}

/** Choose an Action for `seat`. Pure: same state, seat and level give the same action. */
export function pilotAction(state, seat, level = 'medium') {
  const cfg = LEVELS[level];
  if (!cfg) throw new Error(`unknown level ${level}`);
  if (!state.pilots[seat]?.alive || state.phase === 'over' || state.phase === 'won') return { ...IDLE };
  const legal = legalActions(state, seat).filter((a) => a.fire);
  const depth = threatened(state, state.pilots[seat], cfg.depth) ? cfg.depth : 1;
  let best = null;
  let bestV = -Infinity;
  const tryAll = (dash) => {
    for (const a of legal) {
      if (a.dash !== dash) continue;
      const v = score(state, seat, a, depth);
      if (v > bestV) { bestV = v; best = a; }
    }
  };
  tryAll(false);
  if (bestV <= -1e6) tryAll(true); // every plain move is hit inside the look-ahead: try a dash
  return { ...best };
}
