import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createMatch, step, legalActions, isAction, observe, isOver } from '../shared/engine/index.js';
import { seedStage } from '../shared/engine/stages-seed.js';
import { seedToInt, rand } from '../shared/engine/rng.js';
import {
  WORLD_W, WORLD_H, START_LIVES, RESPAWN_TICKS, SPAWN_INVULN_TICKS, DASH_TICKS, DASH_COOLDOWN_TICKS,
  FIRE_COOLDOWN_TICKS, ENEMY, CLEAR_TICKS, BOSS_TIMEOUT_TICKS, STAGE_CLEAR_BONUS, PILOT_SPEED, DASH_SPEED,
} from '../shared/engine/rules.js';

const IDLE = { move: 0, fire: false, dash: false };
const QUIET = { waves: [], boss: { tick: 100000, hp: 5 } }; // a stage where nothing spawns
const seededStages = (seed, n) => Array.from({ length: n }, (_, d) => seedStage(seed, d));

/** A match with nothing on the field and no spawn invulnerability, for hand-placed collisions. */
function quietMatch(seats = 1, stages = [QUIET]) {
  const s = createMatch({ seed: 'quiet', stages, seats });
  for (const p of s.pilots) p.invuln = 0;
  return s;
}
const put = (s, list, obj) => { s[list].push({ id: s.nextId++, ...obj }); return s; };
const enemy = (kind, x, y, extra = {}) => ({ kind, path: 'straight', x, y, vx: 0, vy: 0, hp: ENEMY[kind].hp, age: 0, pace: 1, ...extra });
const run = (s, n, actions = []) => {
  const events = [];
  for (let i = 0; i < n; i++) { const r = step(s, actions); s = r.state; events.push(...r.events); }
  return { state: s, events };
};

/** Seeded legal actions for every seat, drawn from their own RNG so a run is replayable. */
function playScripted(seed, ticks) {
  let s = createMatch({ seed, stages: seededStages(seed, 3), seats: 2 });
  const pick = { rng: seedToInt(`actions:${seed}`) };
  const trace = [];
  for (let i = 0; i < ticks; i++) {
    const acts = s.pilots.map((p) => { const l = legalActions(s, p.seat); return l[Math.floor(rand(pick) * l.length)]; });
    const r = step(s, acts);
    s = r.state;
    trace.push(JSON.stringify(r));
  }
  return { state: s, trace };
}

test('the same seed and actions give byte-identical states and events over 600 ticks', () => {
  const a = playScripted('replay', 600);
  const b = playScripted('replay', 600);
  assert.equal(a.trace.length, 600);
  assert.deepEqual(a.trace, b.trace);
  assert.ok(a.state.nextId > 10, 'the run spawned entities, so ids were exercised');
});

test('two matches in one process do not interfere (ids and RNG live in the state)', () => {
  const alone = playScripted('one', 600).state;
  let a = createMatch({ seed: 'one', stages: seededStages('one', 3), seats: 2 });
  let b = createMatch({ seed: 'two', stages: seededStages('two', 3), seats: 2 });
  const pickA = { rng: seedToInt('actions:one') };
  const pickB = { rng: seedToInt('actions:two') };
  const choose = (s, pick) => s.pilots.map((p) => { const l = legalActions(s, p.seat); return l[Math.floor(rand(pick) * l.length)]; });
  for (let i = 0; i < 600; i++) {
    b = step(b, choose(b, pickB)).state;
    a = step(a, choose(a, pickA)).state;
  }
  assert.equal(JSON.stringify(a), JSON.stringify(alone));
});

test('step does not mutate its input state', () => {
  const s = createMatch({ seed: 'pure', stages: seededStages('pure', 1), seats: 2 });
  const before = JSON.stringify(s);
  run(s, 1, [{ move: 3, fire: true, dash: true }, { move: 7, fire: true, dash: false }]);
  assert.equal(JSON.stringify(s), before);
});

test('isAction accepts exactly {move: 0..8, fire: bool, dash: bool}', () => {
  assert.equal(isAction({ move: 0, fire: false, dash: false }), true);
  assert.equal(isAction({ move: 8, fire: true, dash: true }), true);
  for (const bad of [null, [], 'up', { move: 9, fire: false, dash: false }, { move: -1, fire: false, dash: false },
    { move: 1.5, fire: false, dash: false }, { move: 1, fire: 'yes', dash: false }, { move: 1, fire: true },
    { move: 1, fire: true, dash: false, extra: 1 }]) {
    assert.equal(isAction(bad), false, JSON.stringify(bad));
  }
});

test('step throws on an illegal action, an unknown seat, or dash on cooldown', () => {
  const s = quietMatch();
  assert.throws(() => step(s, [{ move: 9, fire: false, dash: false }]), /not an Action/);
  assert.throws(() => step(s, [{ up: true }]), /not an Action/);
  assert.throws(() => step(s, [IDLE, IDLE]), /no seat 1/);
  const dashed = step(s, [{ move: 3, fire: false, dash: true }]).state;
  assert.throws(() => step(dashed, [{ move: 3, fire: false, dash: true }]), /dash is not legal/);
});

test('legalActions offers every move and fire, and dash only off cooldown', () => {
  let s = quietMatch();
  const fresh = legalActions(s, 0);
  assert.equal(fresh.length, 36);
  assert.ok(fresh.every(isAction));
  assert.ok(fresh.some((a) => a.dash));
  s = step(s, [{ move: 3, fire: false, dash: true }]).state;
  for (let t = 0; t < DASH_COOLDOWN_TICKS; t++) {
    const legal = legalActions(s, 0);
    assert.equal(legal.length, 18);
    assert.ok(legal.every((a) => !a.dash), `dash offered ${t + 1} ticks into its cooldown`);
    s = step(s, [legal[0]]).state;
  }
  assert.ok(legalActions(s, 0).some((a) => a.dash), 'dash is back once the cooldown runs out');
  assert.throws(() => legalActions(s, 1), /no seat 1/);
});

test('dash is a fast invulnerable sidestep for DASH_TICKS', () => {
  let s = quietMatch();
  const x0 = s.pilots[0].x;
  s = step(s, [{ move: 3, fire: false, dash: true }]).state;
  assert.equal(s.pilots[0].x, x0 + DASH_SPEED);
  put(s, 'sparks', { x: s.pilots[0].x, y: s.pilots[0].y, vx: 0, vy: 0 });
  s = step(s, [IDLE]).state;
  assert.equal(s.pilots[0].alive, true, 'invulnerable while dashing');
  s = run(s, DASH_TICKS, [IDLE]).state;
  const x1 = s.pilots[0].x;
  s = step(s, [{ move: 3, fire: false, dash: false }]).state;
  assert.equal(s.pilots[0].x, x1 + PILOT_SPEED, 'back to normal speed after the dash');
});

test('movement stays inside the world', () => {
  const { state } = run(quietMatch(), 400, [{ move: 8, fire: false, dash: false }]);
  const p = state.pilots[0];
  assert.ok(p.x > 0 && p.x < WORLD_W && p.y > 0 && p.y < WORLD_H);
});

test('firing is rate-capped by FIRE_COOLDOWN_TICKS', () => {
  const { state, events } = run(quietMatch(), FIRE_COOLDOWN_TICKS * 3, [{ move: 0, fire: true, dash: false }]);
  assert.equal(events.filter((e) => e.t === 'shot').length, 3);
  assert.ok(state.shots.every((b) => b.vy < 0), 'shots fly up');
});

test('a shot kills a drone and scores for the seat that fired it', () => {
  const s = quietMatch(2);
  put(s, 'enemies', enemy('drone', 100, 100));
  put(s, 'shots', { seat: 1, x: 100, y: 114, vx: 0, vy: -14 });
  const { state, events } = run(s, 1);
  assert.equal(state.enemies.length, 0);
  assert.equal(state.pilots[1].score, ENEMY.drone.score);
  assert.equal(state.pilots[1].kills, 1);
  assert.equal(state.pilots[0].score, 0, 'co-op scores stay separate');
  assert.ok(events.some((e) => e.t === 'kill' && e.seat === 1));
});

test('a spark kills the pilot, costs a life, and the pilot respawns invulnerable', () => {
  let s = quietMatch();
  s.pilots[0].power = 2;
  put(s, 'sparks', { x: s.pilots[0].x, y: s.pilots[0].y, vx: 0, vy: 0 });
  let r = run(s, 1);
  s = r.state;
  assert.equal(s.pilots[0].alive, false);
  assert.equal(s.pilots[0].lives, START_LIVES - 1);
  assert.equal(s.pilots[0].power, 0, 'power is lost on death');
  assert.ok(r.events.some((e) => e.t === 'death'));
  assert.equal(s.sparks.length, 0, 'the spark is spent');
  r = run(s, RESPAWN_TICKS - 1);
  assert.equal(r.state.pilots[0].alive, false, 'still waiting to respawn');
  r = run(r.state, 1);
  assert.equal(r.state.pilots[0].alive, true);
  assert.equal(r.state.pilots[0].invuln, SPAWN_INVULN_TICKS);
  assert.ok(r.events.some((e) => e.t === 'respawn'));
  put(r.state, 'sparks', { x: r.state.pilots[0].x, y: r.state.pilots[0].y, vx: 0, vy: 0 });
  assert.equal(run(r.state, 1).state.pilots[0].alive, true, 'invulnerable just after respawn');
});

test('touching an enemy kills the pilot; a pilot is invulnerable at match start', () => {
  const s = quietMatch();
  put(s, 'enemies', enemy('heavy', s.pilots[0].x, s.pilots[0].y));
  assert.equal(run(s, 1).state.pilots[0].alive, false);
  const start = createMatch({ seed: 'x', stages: [QUIET], seats: 1 });
  put(start, 'enemies', enemy('heavy', start.pilots[0].x, start.pilots[0].y));
  assert.equal(run(start, 1).state.pilots[0].alive, true);
});

test('losing the last life puts the pilot out and ends the match', () => {
  let s = quietMatch();
  s.pilots[0].lives = 1;
  put(s, 'sparks', { x: s.pilots[0].x, y: s.pilots[0].y, vx: 0, vy: 0 });
  const r = run(s, 1);
  assert.ok(r.events.some((e) => e.t === 'out'));
  assert.ok(r.events.some((e) => e.t === 'match-over' && e.result === 'over'));
  assert.equal(isOver(r.state), true);
  assert.deepEqual(run(r.state, 5).events, [], 'a finished match does not move');
});

test('one pilot out does not end a co-op match', () => {
  const s = quietMatch(2);
  s.pilots[0].lives = 1;
  put(s, 'sparks', { x: s.pilots[0].x, y: s.pilots[0].y, vx: 0, vy: 0 });
  const r = run(s, 1);
  assert.equal(r.state.phase, 'playing');
  assert.equal(r.state.pilots[1].lives, START_LIVES);
});

test('pickups: power, dash, points and life each apply to the pilot who takes them', () => {
  for (const [kind, check] of [
    ['power', (p) => p.power === 1],
    ['dash', (p) => p.dashCd === 0],
    ['points', (p) => p.score === 500],
    ['life', (p) => p.lives === START_LIVES + 1],
  ]) {
    const s = quietMatch();
    s.pilots[0].dashCd = 40;
    put(s, 'pickups', { kind, x: s.pilots[0].x, y: s.pilots[0].y });
    const r = run(s, 1);
    assert.equal(r.state.pickups.length, 0, kind);
    assert.ok(check(r.state.pilots[0]), kind);
    assert.ok(r.events.some((e) => e.t === 'pickup' && e.kind === kind));
  }
});

test('a downed heavy always drops a pickup', () => {
  const s = quietMatch();
  put(s, 'enemies', enemy('heavy', 100, 100, { hp: 1 }));
  put(s, 'shots', { seat: 0, x: 100, y: 114, vx: 0, vy: -14 });
  const r = run(s, 1);
  assert.equal(r.state.pickups.length, 1);
  assert.equal(r.state.pilots[0].score, ENEMY.heavy.score);
});

test('downing the boss clears the stage and the next one starts; the last stage wins', () => {
  const stages = [{ waves: [], boss: { tick: 1, hp: 1 } }, { waves: [], boss: { tick: 1, hp: 1 } }];
  let s = quietMatch(1, stages);
  s = step(s, [IDLE]).state;
  const boss = s.enemies.find((e) => e.kind === 'boss');
  assert.ok(boss);
  boss.y = 200; boss.fireIn = 1000;
  put(s, 'shots', { seat: 0, x: boss.x, y: 214, vx: 0, vy: -14 });
  let r = run(s, 1);
  assert.ok(r.events.some((e) => e.t === 'boss-down'));
  assert.ok(r.events.some((e) => e.t === 'stage-clear' && e.stage === 0));
  assert.equal(r.state.phase, 'clear');
  assert.equal(r.state.pilots[0].score, ENEMY.boss.score + STAGE_CLEAR_BONUS);
  r = run(r.state, CLEAR_TICKS);
  assert.ok(r.events.some((e) => e.t === 'stage-start' && e.stage === 1));
  assert.equal(r.state.stageIndex, 1);
  s = step(r.state, [IDLE]).state;
  const boss2 = s.enemies.find((e) => e.kind === 'boss');
  boss2.y = 200; boss2.fireIn = 1000;
  put(s, 'shots', { seat: 0, x: boss2.x, y: 214, vx: 0, vy: -14 });
  r = run(s, 1);
  assert.equal(r.state.phase, 'won');
  assert.ok(r.events.some((e) => e.t === 'match-over' && e.result === 'won'));
});

test('a boss not downed in time escapes and the stage still ends', () => {
  const s = createMatch({ seed: 'esc', stages: [{ waves: [], boss: { tick: 1, hp: 999 } }, QUIET], seats: 1 });
  s.pilots[0].lives = 99;
  const r = run(s, BOSS_TIMEOUT_TICKS + 1);
  assert.ok(r.events.some((e) => e.t === 'boss-escape'));
  assert.ok(r.events.some((e) => e.t === 'stage-clear'));
});

test('waves spawn on their tick with their kind, path and count', () => {
  const stage = { waves: [{ tick: 3, kind: 'drone', path: 'sine', x: 0.5, count: 4 }, { tick: 5, kind: 'heavy', path: 'straight', x: 0.2, count: 2 }], boss: { tick: 1000, hp: 5 } };
  let s = quietMatch(1, [stage]);
  s = run(s, 2).state;
  assert.equal(s.enemies.length, 0);
  s = run(s, 1).state;
  assert.equal(s.enemies.filter((e) => e.kind === 'drone' && e.path === 'sine').length, 4);
  s = run(s, 2).state;
  assert.equal(s.enemies.filter((e) => e.kind === 'heavy').length, 2);
});

test('createMatch refuses bad seats and bad stage specs', () => {
  assert.throws(() => createMatch({ seed: 1, stages: [QUIET], seats: 3 }), /seats/);
  assert.throws(() => createMatch({ seed: 1, stages: [], seats: 1 }), /stages/);
  assert.throws(() => createMatch({ stages: [QUIET], seats: 1 }), /seed/);
  const bad = (w) => createMatch({ seed: 1, stages: [{ waves: [w], boss: { tick: 50, hp: 5 } }], seats: 1 });
  assert.throws(() => bad({ tick: 1, kind: 'zero', path: 'straight', x: 0.5, count: 3 }), /kind/);
  assert.throws(() => bad({ tick: 1, kind: 'drone', path: 'loop', x: 0.5, count: 3 }), /path/);
  assert.throws(() => bad({ tick: 1, kind: 'drone', path: 'straight', x: 2, count: 3 }), /x must/);
  assert.throws(() => bad({ tick: 99, kind: 'drone', path: 'straight', x: 0.5, count: 3 }), /boss tick/);
});

test('observe gives a seat its own ship, the others, and the field, as detached JSON', () => {
  const s = quietMatch(2);
  put(s, 'enemies', enemy('drone', 50, 50));
  put(s, 'sparks', { x: 60, y: 60, vx: 0, vy: 1 });
  const o = observe(s, 1);
  assert.equal(o.self.seat, 1);
  assert.deepEqual(o.others.map((p) => p.seat), [0]);
  assert.equal(o.enemies.length, 1);
  assert.equal(o.sparks.length, 1);
  o.self.x = -999;
  assert.notEqual(s.pilots[1].x, -999, 'mutating an observation does not touch the match');
  assert.deepEqual(observe(s, 1), JSON.parse(JSON.stringify(observe(s, 1))), 'plain JSON');
  assert.throws(() => observe(s, 2), /no seat 2/);
});

test('seedStage is deterministic, valid, and harder with depth', () => {
  assert.deepEqual(seedStage('s', 3), seedStage('s', 3));
  assert.notDeepEqual(seedStage('s', 3), seedStage('t', 3));
  const stages = seededStages('s', 8);
  createMatch({ seed: 's', stages, seats: 1 }); // throws if any stage is malformed
  for (let d = 1; d < 8; d++) assert.ok(stages[d].pace > stages[d - 1].pace);
  assert.ok(stages[7].boss.hp > stages[0].boss.hp);
});

test('purity: no Math.random, Date or performance in shared/engine or shared/ai', () => {
  for (const dir of ['shared/engine', 'shared/ai']) {
    const url = new URL(`../${dir}/`, import.meta.url);
    for (const f of readdirSync(url).filter((n) => n.endsWith('.js'))) {
      const src = readFileSync(new URL(f, url), 'utf8');
      assert.doesNotMatch(src, /Math\.random|\bDate\b|\bperformance\b/, `${dir}/${f}`);
    }
  }
});
