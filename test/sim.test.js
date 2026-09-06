import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from '../server/game/sim.js';
import { WORLD_W, WORLD_H, LOOP_MS, DT, START_LOOPS, RESPAWN_LOOPS, SCORE } from '../shared/constants.js';

function stepN(sim, n) { for (let i = 0; i < n; i++) sim.step(); }

test('movement stays within world bounds', () => {
  const sim = new Sim({ seed: 't1' });
  sim.addPlayer('p1');
  const p = sim.players.get('p1');
  sim.setInput('p1', { up: true, left: true });
  stepN(sim, 2000); // far more than enough to hit the wall
  assert.ok(p.x >= 0 && p.x <= WORLD_W);
  assert.ok(p.y >= 0 && p.y <= WORLD_H);
});

test('firing spawns a bullet that travels upward and is capped by rate', () => {
  const sim = new Sim({ seed: 't2' });
  sim.addPlayer('p1');
  sim.setInput('p1', { fire: true });
  sim.step();
  assert.equal(sim.bullets.length, 1);
  const y0 = sim.bullets[0].y;
  sim.step();
  assert.ok(sim.bullets[0].y < y0, 'bullet moves up (decreasing y)');
  // autofire is rate-capped: stepping for under the cooldown shouldn't add a second bullet
  stepN(sim, 2);
  assert.equal(sim.bullets.length, 1);
});

test('bullet kills a small enemy on contact and awards score', () => {
  const sim = new Sim({ seed: 't3' });
  sim.addPlayer('p1');
  const p = sim.players.get('p1');
  const enemy = sim._mkSmall('straight', p.x, p.y - 20, { vy: 0 });
  sim.enemies.push(enemy);
  sim.bullets.push({ id: 999, x: p.x, y: p.y - 20, vx: 0, vy: -300, owner: 'p1' });
  sim._checkCollisions();
  assert.equal(sim.enemies.length, 0);
  assert.ok(p.score > 0);
  assert.equal(p.kills, 1);
});

test('enemy contact kills the player unless invulnerable', () => {
  const sim = new Sim({ seed: 't4' });
  sim.addPlayer('p1');
  const p = sim.players.get('p1');
  p.invulnUntil = -1; // not invulnerable
  const enemy = sim._mkSmall('straight', p.x, p.y, { vy: 0 });
  sim.enemies.push(enemy);
  sim._checkCollisions();
  assert.equal(p.alive, false);
  assert.equal(p.lives, 2);
});

test('loop-the-loop grants temporary invulnerability and consumes a charge', () => {
  const sim = new Sim({ seed: 't5' });
  sim.addPlayer('p1');
  const p = sim.players.get('p1');
  assert.equal(p.loops, START_LOOPS);
  sim.setInput('p1', { loop: true });
  sim.step();
  assert.equal(p.looping, true);
  assert.equal(p.loops, START_LOOPS - 1);
  p.invulnUntil = -1;
  const enemy = sim._mkSmall('straight', p.x, p.y, { vy: 0 });
  sim.enemies.push(enemy);
  sim._checkCollisions();
  assert.equal(p.alive, true, 'looping player survives contact');
  // loop ends after LOOP_MS
  stepN(sim, Math.ceil(LOOP_MS / 1000 / DT) + 2);
  assert.equal(p.looping, false);
});

test('player cannot fire while looping', () => {
  const sim = new Sim({ seed: 't6' });
  sim.addPlayer('p1');
  const p = sim.players.get('p1');
  sim.setInput('p1', { loop: true, fire: true });
  sim.step();
  assert.equal(p.looping, true);
  sim.setInput('p1', { loop: false, fire: true });
  sim.step();
  assert.equal(sim.bullets.length, 0, 'no shot fired while looping');
});

test('death replenishes loop charges (per spec)', () => {
  const sim = new Sim({ seed: 't7' });
  sim.addPlayer('p1');
  const p = sim.players.get('p1');
  p.loops = 0;
  p.invulnUntil = -1;
  const enemy = sim._mkSmall('straight', p.x, p.y, { vy: 0 });
  sim.enemies.push(enemy);
  sim._checkCollisions();
  assert.equal(p.loops, RESPAWN_LOOPS);
});

test('POW cycle: side, fourway, bomb, loop, bonus, life in order', () => {
  const sim = new Sim({ seed: 't8' });
  sim.addPlayer('p1');
  const p = sim.players.get('p1');
  const types = [];
  for (let i = 0; i < 6; i++) {
    sim._spawnPow(0, 0);
    const item = sim.powItems.pop();
    types.push(item.type);
  }
  assert.deepEqual(types, ['side', 'fourway', 'bomb', 'loop', 'bonus', 'life']);
  // applying each has the expected effect
  sim._applyPow(p, 'side'); assert.equal(p.side, true);
  sim._applyPow(p, 'fourway'); assert.equal(p.fourway, true);
  const livesBefore = p.lives;
  sim._applyPow(p, 'life'); assert.equal(p.lives, livesBefore + 1);
  const loopsBefore = p.loops;
  sim._applyPow(p, 'loop'); assert.equal(p.loops, loopsBefore + 1);
});

test('red formation drops a POW only when all 5 members are destroyed', () => {
  const sim = new Sim({ seed: 't9' });
  sim.addPlayer('p1');
  sim._spawnWave({ at: 0, spawn: 'red-formation', count: 5, x: 0.5 });
  assert.equal(sim.enemies.length, 5);
  const group = sim.enemies[0].groupId;
  assert.ok(sim.enemies.every((e) => e.groupId === group));
  // kill 4 of 5 -- no POW yet
  for (let i = 0; i < 4; i++) sim._killEnemy(sim.enemies.find((e) => !e.dead), 'p1');
  sim.enemies = sim.enemies.filter((e) => !e.dead);
  assert.equal(sim.powItems.length, 0);
  // kill the last one -- POW drops
  sim._killEnemy(sim.enemies[0], 'p1');
  assert.equal(sim.powItems.length, 1);
  // red-formation planes score their own (higher) value, not the plain small-fighter value
  assert.equal(sim.players.get('p1').score, 5 * SCORE.redFormation);
});

test('boss has multiple hit points and requires several hits', () => {
  const sim = new Sim({ seed: 't10' });
  sim.addPlayer('p1');
  const boss = sim._mkBoss(WORLD_W / 2, 100, sim.difficulty());
  sim.enemies.push(boss);
  assert.ok(boss.maxHp > 1);
  for (let i = 0; i < boss.maxHp - 1; i++) {
    sim.bullets.push({ id: i, x: boss.x, y: boss.y, vx: 0, vy: 0, owner: 'p1' });
    sim._checkCollisions();
  }
  assert.ok(sim.enemies.some((e) => e.type === 'boss'), 'boss survives until final hit');
  sim.bullets.push({ id: 999, x: boss.x, y: boss.y, vx: 0, vy: 0, owner: 'p1' });
  sim._checkCollisions();
  assert.ok(!sim.enemies.some((e) => e.type === 'boss'), 'boss destroyed on final hit');
});

test('stage script advances waves over time and reaches stage clear', () => {
  const sim = new Sim({ seed: 't11' });
  sim.addPlayer('p1');
  // force a short, simple, non-boss stage so the test runs fast
  sim.stageNumber = 31;
  sim.stage = { number: 31, name: 'Test', waves: [{ at: 0.1, spawn: 'straight', count: 1, x: 0.5 }] };
  sim.waveCursor = 0;
  stepN(sim, 10); // past t=0.1s
  assert.equal(sim.waveCursor, 1);
  assert.equal(sim.enemies.length, 1);
  stepN(sim, Math.ceil(6 / DT)); // past the +5s grace after the last wave
  assert.equal(sim.stagePhase, 'clear');
});

test('co-op keeps scores and lives separate per player', () => {
  const sim = new Sim({ seed: 't12' });
  sim.addPlayer('p1', { slot: 1 });
  sim.addPlayer('p2', { slot: 2 });
  const p1 = sim.players.get('p1');
  const p2 = sim.players.get('p2');
  sim._awardScore(p1, 500);
  assert.equal(p1.score, 500);
  assert.equal(p2.score, 0);
  p2.invulnUntil = -1;
  const enemy = sim._mkSmall('straight', p2.x, p2.y, { vy: 0 });
  sim.enemies.push(enemy);
  sim._checkCollisions();
  assert.equal(p2.lives, 2);
  assert.equal(p1.lives, 3);
});
