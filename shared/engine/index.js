// The pure engine: plain-JSON state in, plain-JSON state and events out. Humans and the AI pilot
// call it the same way, through a typed Action. No DOM, no clock, no outside randomness: the RNG state
// and the entity id counter live in the match state, so two matches never touch each other.
import {
  WORLD_W, WORLD_H, MOVES, PILOT_SPEED, PILOT_R, START_LIVES, MAX_LIVES, RESPAWN_TICKS,
  SPAWN_INVULN_TICKS, SPAWN_Y, DASH_TICKS, DASH_SPEED, DASH_COOLDOWN_TICKS, FIRE_COOLDOWN_TICKS,
  SHOT_SPEED, SHOT_R, MAX_SHOTS, MAX_POWER, SPARK_SPEED, SPARK_R, ENEMY, ENEMY_KINDS, PATHS,
  PICKUP_R, PICKUP_FALL, PICKUP_POINTS, DRONE_DROP_CHANCE, PICKUP_TABLE, STAGE_CLEAR_BONUS,
  BOSS_TIMEOUT_TICKS, CLEAR_TICKS,
} from './rules.js';
import { seedToInt, rand } from './rng.js';

const ACTION_KEYS = ['dash', 'fire', 'move'];
const IDLE = Object.freeze({ move: 0, fire: false, dash: false });

// ---------------- the Action type ----------------

export function isAction(a) {
  return !!a && typeof a === 'object' && !Array.isArray(a)
    && Object.keys(a).sort().join() === ACTION_KEYS.join()
    && Number.isInteger(a.move) && a.move >= 0 && a.move <= 8
    && typeof a.fire === 'boolean' && typeof a.dash === 'boolean';
}

const canDash = (state, p) => isLive(state) && p.alive && p.dashCd === 0;

export function legalActions(state, seat) {
  const p = pilotAt(state, seat);
  const dashes = canDash(state, p) ? [false, true] : [false];
  const out = [];
  for (let move = 0; move <= 8; move++) {
    for (const fire of [false, true]) for (const dash of dashes) out.push({ move, fire, dash });
  }
  return out;
}

// ---------------- match setup ----------------

function checkStage(s, i) {
  const bad = (why) => { throw new Error(`stage ${i}: ${why}`); };
  if (!s || typeof s !== 'object' || !Array.isArray(s.waves)) bad('needs a waves array');
  if (s.pace !== undefined && !(typeof s.pace === 'number' && s.pace > 0)) bad('pace must be a positive number');
  let last = 0;
  s.waves.forEach((w, j) => {
    if (!Number.isInteger(w?.tick) || w.tick < last) bad(`wave ${j} tick must be an integer, in order`);
    if (!ENEMY_KINDS.includes(w.kind)) bad(`wave ${j} kind must be one of ${ENEMY_KINDS}`);
    if (!PATHS.includes(w.path)) bad(`wave ${j} path must be one of ${PATHS}`);
    if (!Number.isInteger(w.count) || w.count < 1 || w.count > 12) bad(`wave ${j} count must be 1..12`);
    if (!(typeof w.x === 'number' && w.x >= 0 && w.x <= 1)) bad(`wave ${j} x must be in 0..1`);
    last = w.tick;
  });
  const b = s.boss;
  if (!b || !Number.isInteger(b.tick) || b.tick < last) bad('boss tick must be an integer at or after the last wave');
  if (!Number.isInteger(b.hp) || b.hp < 1) bad('boss hp must be a positive integer');
}

const spawnX = (seat, seats) => (seats === 1 ? WORLD_W / 2 : WORLD_W / 2 + (seat === 0 ? -40 : 40));

export function createMatch({ seed, stages, seats } = {}) {
  if (typeof seed !== 'string' && !Number.isFinite(seed)) throw new Error('seed must be a string or number');
  if (!Number.isInteger(seats) || seats < 1 || seats > 2) throw new Error('seats must be 1 or 2');
  if (!Array.isArray(stages) || !stages.length) throw new Error('stages must be a non-empty array');
  stages.forEach(checkStage);
  return {
    seed: String(seed), rng: seedToInt(seed), nextId: 1, tick: 0,
    stages: JSON.parse(JSON.stringify(stages)), stageIndex: 0, stageTick: 0, waveCursor: 0, bossSpawned: false,
    phase: 'playing', phaseTicks: 0,
    pilots: Array.from({ length: seats }, (_, seat) => ({
      seat, x: spawnX(seat, seats), y: SPAWN_Y, alive: true, lives: START_LIVES, score: 0, kills: 0, power: 0,
      invuln: SPAWN_INVULN_TICKS, dashTicks: 0, dashDir: 0, dashCd: 0, fireCd: 0, respawnIn: 0,
    })),
    enemies: [], sparks: [], shots: [], pickups: [],
  };
}

export const isOver = (state) => state.phase === 'over' || state.phase === 'won';
const isLive = (state) => !isOver(state);

/** The most ticks a match on these stages can last: every stage ends by its boss timeout. */
export function matchTickBound(stages) {
  return stages.reduce((n, s) => n + s.boss.tick + BOSS_TIMEOUT_TICKS + CLEAR_TICKS + 1, 0);
}

function pilotAt(state, seat) {
  const p = Number.isInteger(seat) ? state.pilots[seat] : undefined;
  if (!p) throw new Error(`no seat ${seat}`);
  return p;
}

// ---------------- step ----------------

const copy = (o) => ({ ...o });
const clone = (s) => ({
  ...s, pilots: s.pilots.map(copy), enemies: s.enemies.map(copy), sparks: s.sparks.map(copy),
  shots: s.shots.map(copy), pickups: s.pickups.map(copy),
});
const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const touching = (a, b, r) => dist2(a, b) < r * r;

/** Advance one tick. Returns a new state (the input is not mutated) and the tick's events. */
export function step(state, actionsBySeat = []) {
  for (const key of Object.keys(actionsBySeat)) pilotAt(state, Number(key));
  const actions = state.pilots.map((p) => {
    const a = actionsBySeat[p.seat] ?? IDLE;
    if (!isAction(a)) throw new Error(`seat ${p.seat}: not an Action: ${JSON.stringify(a)}`);
    if (a.dash && !canDash(state, p)) throw new Error(`seat ${p.seat}: dash is not legal now`);
    return a;
  });
  const s = clone(state);
  return { state: s, events: advance(s, actions) };
}

/** `step` without its checks or its copy: mutates `s` in place with already-legal actions (one
 *  per seat) and returns the events. For look-ahead on a state the caller owns, after a `step`. */
export function advance(s, actions) {
  const events = [];
  if (isOver(s)) return events;

  s.tick++;
  const stage = s.stages[s.stageIndex];
  for (const p of s.pilots) stepPilot(s, p, actions[p.seat], events);
  if (s.phase === 'playing') {
    s.stageTick++;
    spawn(s, stage, events);
  }
  moveEnemies(s);
  moveProjectiles(s);
  collide(s, events);

  if (s.pilots.every((p) => !p.alive && p.lives <= 0)) {
    s.phase = 'over';
    events.push({ t: 'match-over', result: 'over', stage: s.stageIndex });
  } else if (s.phase === 'playing') {
    checkStageEnd(s, stage, events);
  } else if (s.phase === 'clear' && --s.phaseTicks <= 0) {
    nextStage(s, events);
  }
  return events;
}

function stepPilot(s, p, a, events) {
  if (!p.alive) {
    if (p.lives > 0 && --p.respawnIn <= 0) {
      Object.assign(p, {
        alive: true, x: spawnX(p.seat, s.pilots.length), y: SPAWN_Y, invuln: SPAWN_INVULN_TICKS,
        dashTicks: 0, dashCd: 0, fireCd: 0, respawnIn: 0,
      });
      events.push({ t: 'respawn', seat: p.seat });
    }
    return;
  }
  if (p.invuln > 0) p.invuln--;
  if (p.dashCd > 0) p.dashCd--;
  if (p.fireCd > 0) p.fireCd--;
  if (p.dashTicks > 0) p.dashTicks--;
  if (a.dash) {
    p.dashTicks = DASH_TICKS; p.dashCd = DASH_COOLDOWN_TICKS; p.dashDir = a.move;
    events.push({ t: 'dash', seat: p.seat });
  }
  const dashing = p.dashTicks > 0;
  const [dx, dy] = MOVES[dashing ? p.dashDir : a.move];
  const speed = (dashing ? DASH_SPEED : PILOT_SPEED) * (dx && dy ? Math.SQRT1_2 : 1);
  p.x = Math.max(PILOT_R, Math.min(WORLD_W - PILOT_R, p.x + dx * speed));
  p.y = Math.max(PILOT_R, Math.min(WORLD_H - PILOT_R, p.y + dy * speed));
  if (a.fire && !dashing && p.fireCd === 0) fire(s, p, events);
}

const VOLLEYS = [[[0, 0]], [[-6, 0], [6, 0]], [[0, 0], [-8, -2], [8, 2]]]; // [x offset, vx] per power

function fire(s, p, events) {
  let own = s.shots.reduce((n, b) => n + (b.seat === p.seat ? 1 : 0), 0);
  for (const [off, vx] of VOLLEYS[p.power]) {
    if (own >= MAX_SHOTS) break;
    s.shots.push({ id: s.nextId++, seat: p.seat, x: p.x + off, y: p.y - 10, vx, vy: -SHOT_SPEED });
    own++;
  }
  p.fireCd = FIRE_COOLDOWN_TICKS;
  events.push({ t: 'shot', seat: p.seat });
}

// ---------------- waves and enemies ----------------

function spawn(s, stage, events) {
  const pace = stage.pace ?? 1;
  while (s.waveCursor < stage.waves.length && stage.waves[s.waveCursor].tick <= s.stageTick) {
    spawnWave(s, stage.waves[s.waveCursor++], pace);
  }
  if (!s.bossSpawned && stage.boss.tick <= s.stageTick) {
    s.bossSpawned = true;
    s.enemies.push({
      id: s.nextId++, kind: 'boss', path: 'boss', x: WORLD_W / 2, y: -60, vx: 0, vy: ENEMY.boss.speed * pace,
      hp: stage.boss.hp, age: 0, dir: 1, fireIn: Math.round(ENEMY.boss.fireEvery / pace), pace,
    });
    events.push({ t: 'boss-appear', stage: s.stageIndex });
  }
}

function spawnWave(s, w, pace) {
  const def = ENEMY[w.kind];
  const sp = def.speed * pace;
  for (let i = 0; i < w.count; i++) {
    const off = i - (w.count - 1) / 2;
    const e = { id: s.nextId++, kind: w.kind, path: w.path, hp: def.hp, age: 0, x: 0, y: 0, vx: 0, vy: sp, pace };
    if (w.path === 'straight' || w.path === 'dive') {
      e.x = w.x * WORLD_W + off * 26; e.y = -20 - Math.abs(off) * 14;
    } else if (w.path === 'sine') {
      e.x = e.baseX = w.x * WORLD_W; e.y = -20 - i * 28; e.vy = sp * 0.9; e.phase = i * 0.6;
    } else {
      const dir = w.path === 'sweep-left' ? 1 : -1; // sweep-left enters from the left edge
      e.x = dir > 0 ? -20 - i * 28 : WORLD_W + 20 + i * 28; e.y = 40 + w.x * 160 + i * 6;
      e.vx = dir * sp * 1.3; e.vy = sp * 0.5;
    }
    if (def.fireEvery) e.fireIn = Math.round(def.fireEvery / pace) + i * 7;
    s.enemies.push(e);
  }
}

function nearestPilot(s, from) {
  let best = null;
  for (const p of s.pilots) if (p.alive && (!best || dist2(p, from) < dist2(best, from))) best = p;
  return best;
}

// n sparks, `gap` radians apart, centred on `angle` (PI/2 is straight down).
function fan(s, e, n, angle, gap) {
  const sp = SPARK_SPEED * (1 + (e.pace - 1) * 0.6);
  for (let k = 0; k < n; k++) {
    const a = angle + (k - (n - 1) / 2) * gap;
    s.sparks.push({ id: s.nextId++, x: e.x, y: e.y + 10, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp });
  }
}

function aimedFan(s, e, n) {
  const t = nearestPilot(s, e);
  if (t) fan(s, e, n, Math.atan2(t.y - e.y, t.x - e.x), 0.3);
}

function moveEnemies(s) {
  for (const e of s.enemies) {
    e.age++;
    if (e.kind === 'boss') { moveBoss(s, e); continue; }
    if (e.path === 'sine') {
      e.y += e.vy; e.x = e.baseX + Math.sin(e.age * 0.07 + e.phase) * 50;
    } else {
      if (e.path === 'dive' && e.age === 40) {
        const t = nearestPilot(s, e);
        if (t) e.vx = Math.max(-2.5, Math.min(2.5, (t.x - e.x) / 60));
        e.vy *= 1.6;
      }
      e.x += e.vx; e.y += e.vy;
    }
    if (e.fireIn !== undefined && e.y > 0 && e.y < WORLD_H - 80 && --e.fireIn <= 0) {
      aimedFan(s, e, e.kind === 'heavy' ? 1 + 2 * Math.floor(e.pace) : 1);
      e.fireIn = Math.round(ENEMY[e.kind].fireEvery / e.pace);
    }
  }
  s.enemies = s.enemies.filter((e) => e.kind === 'boss'
    || !(e.y > WORLD_H + 40 || (e.vx > 0 && e.x > WORLD_W + 60) || (e.vx < 0 && e.x < -60)));
}

function moveBoss(s, e) {
  if (e.y < ENEMY.boss.holdY) { e.y += e.vy; return; }
  e.x += e.dir * 1.2 * e.pace;
  if (e.x < 50 || e.x > WORLD_W - 50) e.dir *= -1;
  if (--e.fireIn > 0) return;
  fan(s, e, 1 + 2 * Math.round(e.pace * 1.5), Math.PI / 2, 0.16);
  if (rand(s) < 0.5) aimedFan(s, e, 1);
  e.fireIn = Math.round(ENEMY.boss.fireEvery / e.pace);
}

function moveProjectiles(s) {
  const inside = (b, m) => b.x > -m && b.x < WORLD_W + m && b.y > -m && b.y < WORLD_H + m;
  for (const b of s.shots) { b.x += b.vx; b.y += b.vy; }
  for (const b of s.sparks) { b.x += b.vx; b.y += b.vy; }
  for (const it of s.pickups) it.y += PICKUP_FALL;
  s.shots = s.shots.filter((b) => inside(b, 20));
  s.sparks = s.sparks.filter((b) => inside(b, 20));
  s.pickups = s.pickups.filter((it) => it.y < WORLD_H + 20);
}

// ---------------- collisions, lives, pickups ----------------

function collide(s, events) {
  for (const b of s.shots) {
    for (const e of s.enemies) {
      if (e.dead || (e.kind === 'boss' && e.y < 0)) continue;
      if (!touching(b, e, ENEMY[e.kind].r + SHOT_R)) continue;
      b.dead = true;
      events.push({ t: 'hit', id: e.id, kind: e.kind, seat: b.seat });
      if (--e.hp <= 0) killEnemy(s, e, b.seat, events);
      break;
    }
  }
  for (const p of s.pilots) {
    if (!p.alive) continue;
    const safe = p.invuln > 0 || p.dashTicks > 0;
    for (const e of s.enemies) {
      if (e.dead || safe || !touching(p, e, ENEMY[e.kind].r + PILOT_R)) continue;
      if (e.kind === 'drone') e.dead = true;
      killPilot(p, events);
      break;
    }
    for (const b of s.sparks) {
      if (!p.alive || safe || b.dead || !touching(p, b, SPARK_R + PILOT_R)) continue;
      b.dead = true;
      killPilot(p, events);
    }
    for (const it of s.pickups) {
      if (!p.alive || it.dead || !touching(p, it, PICKUP_R + PILOT_R)) continue;
      it.dead = true;
      applyPickup(p, it.kind, events);
    }
  }
  const live = (x) => !x.dead;
  s.shots = s.shots.filter(live);
  s.enemies = s.enemies.filter(live);
  s.sparks = s.sparks.filter(live);
  s.pickups = s.pickups.filter(live);
}

function killEnemy(s, e, seat, events) {
  e.dead = true;
  const p = s.pilots[seat];
  p.score += ENEMY[e.kind].score;
  p.kills++;
  events.push({ t: 'kill', id: e.id, kind: e.kind, seat });
  if (e.kind === 'boss') {
    events.push({ t: 'boss-down', seat });
    dropPickup(s, e, PICKUP_TABLE.find(([, w]) => rand(s) < w)[0]);
  } else if (e.kind === 'heavy' || rand(s) < DRONE_DROP_CHANCE) {
    const r = rand(s);
    dropPickup(s, e, PICKUP_TABLE.find(([, w]) => r < w)[0]);
  }
}

function dropPickup(s, at, kind) {
  s.pickups.push({ id: s.nextId++, kind, x: at.x, y: Math.max(0, at.y) });
}

function killPilot(p, events) {
  p.alive = false; p.lives--; p.power = 0; p.dashTicks = 0;
  events.push({ t: 'death', seat: p.seat });
  if (p.lives > 0) p.respawnIn = RESPAWN_TICKS;
  else events.push({ t: 'out', seat: p.seat });
}

function applyPickup(p, kind, events) {
  if (kind === 'power') p.power = Math.min(MAX_POWER, p.power + 1);
  else if (kind === 'dash') p.dashCd = 0;
  else if (kind === 'points') p.score += PICKUP_POINTS;
  else if (kind === 'life') p.lives = Math.min(MAX_LIVES, p.lives + 1);
  events.push({ t: 'pickup', seat: p.seat, kind });
}

// ---------------- stage flow ----------------

function checkStageEnd(s, stage, events) {
  if (!s.bossSpawned) return;
  const boss = s.enemies.find((e) => e.kind === 'boss');
  if (boss && s.stageTick < stage.boss.tick + BOSS_TIMEOUT_TICKS) return;
  if (boss) {
    s.enemies = s.enemies.filter((e) => e !== boss);
    events.push({ t: 'boss-escape', stage: s.stageIndex });
  }
  for (const p of s.pilots) if (p.lives > 0) p.score += STAGE_CLEAR_BONUS;
  s.sparks = [];
  events.push({ t: 'stage-clear', stage: s.stageIndex });
  if (s.stageIndex === s.stages.length - 1) {
    s.phase = 'won';
    events.push({ t: 'match-over', result: 'won', stage: s.stageIndex });
  } else {
    s.phase = 'clear';
    s.phaseTicks = CLEAR_TICKS;
  }
}

function nextStage(s, events) {
  Object.assign(s, {
    stageIndex: s.stageIndex + 1, stageTick: 0, waveCursor: 0, bossSpawned: false, phase: 'playing',
    phaseTicks: 0, enemies: [], sparks: [], shots: [], pickups: [],
  });
  events.push({ t: 'stage-start', stage: s.stageIndex });
}

// ---------------- observation ----------------

/** What the pilot in `seat` may see: its own ship, the other pilot, enemies, sparks, shots, pickups. */
export function observe(state, seat) {
  const self = pilotAt(state, seat);
  return JSON.parse(JSON.stringify({
    tick: state.tick, stage: state.stageIndex, stageCount: state.stages.length, phase: state.phase,
    self, others: state.pilots.filter((p) => p !== self),
    enemies: state.enemies.map(({ id, kind, x, y, vx, vy, hp }) => ({ id, kind, x, y, vx, vy, hp })),
    sparks: state.sparks, shots: state.shots, pickups: state.pickups,
  }));
}
