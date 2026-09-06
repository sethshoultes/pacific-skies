import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from '../server/game/sim.js';
import { WORLD_W, WORLD_H, LOOP_MS, DT, START_LOOPS, RESPAWN_LOOPS } from '../shared/constants.js';

function stepN(sim, n) { for (let i = 0; i < n; i++) sim.step(); }

test('addPlayer stores slot 0 as-is instead of treating it as unset', () => {
  const sim = new Sim({ seed: 'slot0' });
  const p = sim.addPlayer('p1', { slot: 0 });
  assert.equal(p.slot, 0, 'slot 0 is a legitimate value, not a falsy "unset"');
  assert.equal(p.x, WORLD_W / 2, 'slot 0 gets no left/right offset, same as any slot other than 1 or 2');
});

test('respawnPlayer restores the slot-based spawn lane instead of dead center for both players', () => {
  const sim = new Sim({ seed: 'respawn-slots' });
  const p1 = sim.addPlayer('p1', { slot: 1 });
  const p2 = sim.addPlayer('p2', { slot: 2 });
  const spawnX1 = p1.x, spawnX2 = p2.x;
  assert.notEqual(spawnX1, spawnX2, 'the two slots must not share a lane in the first place');

  p1.alive = false; p1.x = 12345;
  p2.alive = false; p2.x = 12345;
  sim.respawnPlayer(p1);
  sim.respawnPlayer(p2);
  assert.equal(p1.x, spawnX1, "p1 respawns back into p1's lane, not dead center");
  assert.equal(p2.x, spawnX2, "p2 respawns back into p2's lane, not p1's");
  assert.notEqual(p1.x, p2.x, 'the two players must not stack on top of each other after respawn');
});

test('_fire tracks the per-player bullet cap without re-scanning the bullets array per spawn', () => {
  const sim = new Sim({ seed: 'fire-cap' });
  const p = sim.addPlayer('p1');
  p.fourway = true; p.side = true; // up to 6 bullets in one _fire() call
  sim._fire(p);
  sim._fire(p);
  sim._fire(p);
  const owned = sim.bullets.filter((b) => b.owner === 'p1').length;
  assert.ok(owned <= 6, `per-player bullet cap must still be enforced across repeated fires, got ${owned}`);
});

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

test('loopDodges only counts bullets dodged while looping, not enemy-plane contact', () => {
  const sim = new Sim({ seed: 'loop-dodge' });
  sim.addPlayer('p1');
  const p = sim.players.get('p1');
  sim.setInput('p1', { loop: true });
  sim.step();
  assert.equal(p.looping, true);
  p.invulnUntil = -1;

  // Surviving contact with an enemy plane while looping must not count as a "loop dodge" --
  // that stat/achievement is specifically about dodging bullets (see shared/achievements.js),
  // and counting plane contact would let it be farmed by ramming enemies during a loop.
  const enemy = sim._mkSmall('straight', p.x, p.y, { vy: 0 });
  sim.enemies.push(enemy);
  sim._checkCollisions();
  assert.equal(p.alive, true);
  assert.equal(p.loopDodges, 0, 'plane contact must not increment loopDodges');

  // Dodging an actual enemy bullet while looping must count.
  sim.enemyBullets.push({ id: 'b1', x: p.x, y: p.y, vx: 0, vy: 0 });
  sim._checkCollisions();
  assert.equal(p.alive, true);
  assert.equal(p.loopDodges, 1, 'dodging a bullet while looping must increment loopDodges');
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

test('straight and medium waves are centered on baseX regardless of count (even or odd)', () => {
  for (const count of [4, 5]) {
    const sim = new Sim({ seed: `center-${count}` });
    sim._spawnWave({ at: 0, spawn: 'straight', count, x: 0.5 });
    const xs = sim.enemies.map((e) => e.x);
    const baseX = 0.5 * WORLD_W;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    assert.ok(Math.abs(mean - baseX) < 1e-6, `straight count=${count}: expected mean ${baseX}, got ${mean}`);
  }
  for (const count of [4, 5]) {
    const sim = new Sim({ seed: `center-med-${count}` });
    sim._spawnWave({ at: 0, spawn: 'medium', count, x: 0.5 });
    const xs = sim.enemies.map((e) => e.x);
    const baseX = 0.5 * WORLD_W;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    assert.ok(Math.abs(mean - baseX) < 1e-6, `medium count=${count}: expected mean ${baseX}, got ${mean}`);
  }
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

test('red-formation kills award the red-formation score, not the small-plane score', async () => {
  const { SCORE } = await import('../shared/constants.js');
  const sim = new Sim({ seed: 't-red' });
  sim.addPlayer('p1');
  const p = sim.players.get('p1');
  const mk = (isRed) => ({ type: 'small', isRed, x: 100, y: 100, hp: 1, dead: false });
  const before = p.score;
  const red = mk(true); sim.enemies.push(red); sim._killEnemy(red, 'p1');
  const gainedRed = p.score - before;
  const plain = mk(false); sim.enemies.push(plain); sim._killEnemy(plain, 'p1');
  const gainedSmall = p.score - before - gainedRed;
  assert.equal(gainedRed, SCORE.redFormation);
  assert.equal(gainedSmall, SCORE.small);
  assert.notEqual(SCORE.redFormation, SCORE.small);
});

test('shotsFired counts every bullet spawned so four-way volleys cannot exceed 100% accuracy', () => {
  const sim = new Sim({ seed: 'acc', stageNumber: 1, onEvent() {} });
  sim.addPlayer('p1', { slot: 0 });
  const p = sim.players.get('p1');
  p.fourway = true; p.side = true;
  sim._fire(p);
  assert.equal(p.shotsFired, 6);
  assert.equal(sim.stats.shotsFired, 6);
  assert.equal(sim.bullets.filter((b) => b.owner === 'p1').length, 6);
});

test('v-sweep formations fly as a chevron with the middle plane leading, not a vertical column', () => {
  const sim = new Sim({ seed: 'v' });
  sim._spawnWave({ at: 0, spawn: 'v-sweep', count: 5, x: 0.1, params: { dir: 1 } });
  const xs = sim.enemies.map((e) => e.x);
  assert.ok(new Set(xs).size > 1, 'planes must not share one x');
  const lead = Math.max(...xs);
  assert.equal(xs[2], lead, 'the middle plane leads when sweeping right');
  assert.ok(xs[0] < xs[1] && xs[1] < xs[2] && xs[3] < xs[2] && xs[4] < xs[3], 'wings trail symmetrically');
  const ys = sim.enemies.map((e) => e.y);
  assert.ok(new Set(ys).size === 5, 'each plane keeps its own row');
});

test('bosses and mid-bosses hold fire until they are on station (visible), then open up', () => {
  for (const spawn of ['midboss', 'boss']) {
    const sim = new Sim({ seed: 'b-' + spawn });
    sim.addPlayer('p1');
    sim._spawnWave({ at: 0, spawn, count: 1, x: 0.5 });
    const e = sim.enemies[0];
    // A few ticks in, still above the top edge: no shots yet.
    stepN(sim, 5);
    assert.ok(e.y < e.holdY, `${spawn} should still be flying in`);
    assert.equal(sim.enemyBullets.length, 0, `${spawn} must not fire while off station`);
    // It must reach its hold position in a handful of seconds, not 15+.
    stepN(sim, 30 * 5);
    assert.ok(e.y >= e.holdY, `${spawn} should be on station within 5s (y=${e.y}, holdY=${e.holdY})`);
    stepN(sim, 30 * 2);
    assert.ok(sim.enemyBullets.length > 0, `${spawn} fires once on station`);
  }
});

test('continueRun gives players who are out of lives a fresh set, resets their score, and clears enemy shots', () => {
  const sim = new Sim({ seed: 'cont' });
  const p = sim.addPlayer('p1');
  const q2 = sim.addPlayer('p2', { slot: 2 });
  p.score = 5000; p.lives = 1; p.side = true;
  sim.enemyBullets.push({ id: 1, x: 10, y: 10, vx: 0, vy: 1 });
  sim._killPlayer(p);
  assert.equal(p.lives, 0); assert.equal(p.alive, false);
  assert.ok(sim.allPlayersOut() === false, 'p2 is still alive');
  q2.score = 777;
  const events = [];
  sim.onEvent = (ev) => events.push(ev);
  const pids = sim.continueRun();
  assert.deepEqual(pids, ['p1']);
  assert.equal(p.alive, true); assert.equal(p.lives, 3); assert.equal(p.score, 0); assert.equal(p.side, false);
  assert.ok(sim.time < p.invulnUntil, 'respawn grants the usual invulnerability window');
  assert.equal(q2.score, 777, 'players still in the game are untouched');
  assert.equal(sim.enemyBullets.length, 0);
  assert.deepEqual(events.map((e) => e.t), ['continue']);
  assert.deepEqual(sim.continueRun(), [], 'nothing to continue when nobody is out');
});
