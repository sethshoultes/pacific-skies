import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Always a fresh temp dir -- falling back to an existing DATA_DIR could share a SQLite DB with
// another test file's run and make assertions order-dependent/flaky.
const dataDir = mkdtempSync(path.join(tmpdir(), 'skies-room-test-'));
process.env.DATA_DIR = dataDir;
const { Room, MATCH_TYPES } = await import('../server/game/room.js');
const { isAction } = await import('../shared/engine/index.js');
const { Lobby, MAX_ROOMS, MAX_LISTED, EMPTY_ROOM_MS } = await import('../server/game/lobby.js');
const { db } = await import('../server/db.js');

// Belt-and-suspenders cleanup: `after` handles the normal exit path, `process.on('exit')` covers
// a crash/early-exit that skips node:test's hooks. Both are guarded by an explicit assertion that
// the path is really the one mkdtempSync just created under os.tmpdir() -- never anything else --
// before ever calling an rm with recursive:true.
function cleanupDataDir() {
  if (!dataDir.startsWith(tmpdir())) return; // never rm a path we didn't just create ourselves
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanupDataDir);
after(async () => {
  try { db.close(); } catch {}
  if (dataDir.startsWith(tmpdir())) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

function fakeClient() {
  const sent = [];
  return { ws: { readyState: 1, send: (s) => sent.push(JSON.parse(s)) }, sent, user: null, name: 'x', ready: false, away: false, guestId: null };
}

// Rooms in these tests build one stage, so a start is a fraction of a second.
const makeRoom = (opts) => new Room({ seed: 's', name: 'Test', stageCount: 1, ...opts });
const playing = async (room) => { await room.built; await new Promise((r) => setImmediate(r)); assert.equal(room.state, 'playing'); };
const stop = (room) => { clearInterval(room.tickTimer); room.tickTimer = null; };
const IDLE = { move: 0, fire: false, dash: false };

test('only the host can start a co-op room directly; start() reports whether it was accepted', async () => {
  const room = makeRoom({ id: 'r1' });
  const host = fakeClient(); const guest = fakeClient();
  room.join(host.ws, { pid: 'host', user: null, name: 'H' });
  room.join(guest.ws, { pid: 'guest', user: null, name: 'G' });
  assert.equal(room.start('guest'), false, 'non-host start must be refused');
  assert.equal(room.state, 'lobby');
  assert.ok(guest.sent.some((m) => m.t === 'error' && /host/i.test(m.error)), 'guest gets an error');
  assert.equal(room.start('host'), true);
  assert.equal(room.state, 'starting');
  assert.equal(room.start('host'), false, 'a second start is a no-op');
  await playing(room);
  const start = host.sent.find((m) => m.t === 'start');
  assert.equal(start.stages.length, 1);
  assert.deepEqual(start.seats.map((s) => s.kind), ['human', 'human']);
  room.close();
});

test('a solo player is the host and can start', async () => {
  const room = makeRoom({ id: 'r2' });
  room.join(fakeClient().ws, { pid: 'solo', user: null, name: 'S' });
  assert.equal(room.start('solo'), true);
  await playing(room);
  assert.equal(room.match.pilots.length, 1, 'co-op with one player flies one kite');
  room.close();
});

test('nobody new can join once the match is starting, but an existing player may rejoin', () => {
  const room = makeRoom({ id: 'r3' });
  const host = fakeClient();
  room.join(host.ws, { pid: 'host', user: null, name: 'x' });
  assert.equal(room.start('host'), true);
  const late = fakeClient();
  assert.throws(() => room.join(late.ws, { pid: 'late', user: null, name: 'late', guestId: null }), /in progress/i);
  assert.equal(room.clients.size, 1);
  assert.doesNotThrow(() => room.join(host.ws, { pid: 'host', user: null, name: 'x', guestId: null }));
  room.close();
});

test('every match type seats the right pilots, and the host alone picks it in the lobby', () => {
  const room = makeRoom({ id: 'r-types' });
  room.join(fakeClient().ws, { pid: 'a', user: null, name: 'A' });
  room.join(fakeClient().ws, { pid: 'b', user: null, name: 'B' });
  const plan = (type, level = 'medium') => { room.setType('a', type, level); return room.seatPlan().map((s) => s.pid ?? s.level); };
  assert.deepEqual(plan('coop'), ['a', 'b']);
  assert.deepEqual(plan('race'), ['a', 'b']);
  assert.deepEqual(plan('wingman', 'easy'), ['a', 'easy'], 'b watches');
  assert.deepEqual(plan('rival', 'hard'), ['a', 'hard']);
  assert.deepEqual(plan('watch'), ['medium', 'medium']);
  assert.deepEqual(Object.keys(MATCH_TYPES), ['coop', 'race', 'wingman', 'rival', 'watch']);
  assert.throws(() => room.setType('b', 'coop'), /host/);
  assert.throws(() => room.setType('a', 'deathmatch'), /Unknown match type/);
  assert.throws(() => room.setType('a', 'coop', 'godlike'), /Unknown AI level/);
  assert.throws(() => room.setType('a', 'toString'), /Unknown match type/);
  room.leave('b');
  room.setType('a', 'race');
  assert.throws(() => room.seatPlan(), /needs 2 players/);
  assert.equal(room.start('a'), false, 'a race needs two players');
  room.close();
});

test('act: a legal Action is taken; malformed, illegal or off-seat ones are refused', async () => {
  const room = makeRoom({ id: 'r-act' });
  room.join(fakeClient().ws, { pid: 'a', user: null, name: 'A' });
  room.join(fakeClient().ws, { pid: 'b', user: null, name: 'B' });
  assert.throws(() => room.act('a', IDLE), /No match/);
  room.setType('a', 'wingman');
  room.start('a');
  await playing(room);
  stop(room);
  room.act('a', { move: 3, fire: true, dash: true });
  assert.deepEqual(room.inputs[0], { move: 3, fire: true, dash: true });
  for (const bad of [null, 'x', 7, [], {}, { move: 9, fire: true, dash: false }, { move: 1.5, fire: true, dash: false },
    { move: 1, fire: 'yes', dash: false }, { move: 1, fire: true }, { move: 1, fire: true, dash: false, x: 1 }]) {
    assert.throws(() => room.act('a', bad), /not an Action/, JSON.stringify(bad));
  }
  assert.throws(() => room.act('b', IDLE), /watching/, 'the extra player in a wingman room watches');
  const [first] = room.actionsFor();
  assert.equal(first.dash, true, 'the dash goes out on the next tick');
  assert.deepEqual(room.inputs[0], { move: 3, fire: true, dash: false }, 'and only that tick');
  room._tick();
  room.match.pilots[0].dashCd = 5;
  assert.throws(() => room.act('a', { move: 0, fire: false, dash: true }), /not legal now/);
  room.close();
});

test('an AI seat acts every tick: one legal Action each tick, and its kite flies', async (t) => {
  const room = makeRoom({ id: 'r-ai' });
  room.join(fakeClient().ws, { pid: 'a', user: null, name: 'A' });
  room.setType('a', 'watch', 'easy');
  room.start('a');
  await playing(room);
  stop(room);
  const seen = [];
  const real = room.actionsFor.bind(room);
  t.mock.method(room, 'actionsFor', () => { const acts = real(); seen.push(acts); return acts; });
  const x0 = room.match.pilots.map((p) => p.x);
  for (let i = 0; i < 120; i++) room._tick();
  assert.equal(seen.length, 120);
  for (const acts of seen) {
    assert.equal(acts.length, 2);
    for (const a of acts) assert.ok(isAction(a), JSON.stringify(a));
  }
  assert.ok(seen.every((acts) => acts.every((a) => a.fire)), 'the pilot fires every tick');
  assert.ok(room.match.pilots.some((p, i) => p.x !== x0[i]), 'an AI kite moved');
  assert.equal(room.match.tick, 120);
  room.close();
});

test('snapshots are what a seat observes, rounded, and far under the 16 KB socket cap', async () => {
  const room = makeRoom({ id: 'r-snap' });
  const c = fakeClient();
  room.join(c.ws, { pid: 'a', user: null, name: 'A' });
  room.setType('a', 'rival', 'easy');
  room.start('a');
  await playing(room);
  stop(room);
  for (let i = 0; i < 300; i++) room._tick();
  const snaps = c.sent.filter((m) => m.t === 'snap');
  assert.equal(snaps.length, 300);
  const last = snaps.at(-1).s;
  assert.equal(last.self.seat, 0);
  assert.deepEqual(last.others.map((p) => p.seat), [1]);
  assert.equal(last.stageCount, 1);
  assert.ok(Math.max(...snaps.map((m) => JSON.stringify(m).length)) < 16 * 1024);
  room.close();
});

test('resume() requires the client-private resumeToken, and the resumed player gets the match again', async () => {
  const room = makeRoom({ id: 'r5' });
  const host = fakeClient();
  room.join(host.ws, { pid: 'host', user: null, name: 'x', guestId: null });
  assert.equal(room.start('host'), true);
  await playing(room);
  const { resumeToken } = host.sent.find((m) => m.t === 'joined');
  assert.ok(resumeToken && resumeToken.length >= 16, 'a private resume token is issued on join');

  room.disconnect('host');
  assert.equal(room.clients.get('host').away, true);
  assert.deepEqual(room.actionsFor()[0], IDLE, 'an away seat idles');

  // Guessing the token as the pid itself must fail.
  assert.equal(room.resume({ readyState: 1, send: () => {} }, 'host', 'host'), null);
  assert.equal(room.clients.get('host').away, true, 'a wrong token must not resume the slot');

  const back = fakeClient();
  assert.deepEqual(room.resume(back.ws, 'host', resumeToken), { pid: 'host' });
  assert.equal(room.clients.get('host').away, false);
  assert.ok(back.sent.some((m) => m.t === 'start' && m.stages.length === 1), 'the stages come again');
  room.close();
});

test('rejoining with the same pid clears a stale awayTimer instead of leaking it', async () => {
  const room = makeRoom({ id: 'r6' });
  const host = fakeClient();
  room.join(host.ws, { pid: 'host', user: null, name: 'x', guestId: null });
  room.start('host');
  room.disconnect('host');
  const staleTimer = room.clients.get('host').awayTimer;
  assert.ok(staleTimer, 'disconnect schedules an awayTimer');
  room.join(host.ws, { pid: 'host', user: null, name: 'x', guestId: null });
  assert.equal(staleTimer._destroyed, true, 'the old awayTimer must be cleared on rejoin');
  assert.equal(room.clients.get('host').awayTimer, null);
  room.close();
});

test('a client-supplied guestId is capped and sanitized', () => {
  const room = makeRoom({ id: 'r8' });
  const huge = 'a'.repeat(500) + '<script>';
  const r1 = room.join(fakeClient().ws, { pid: 'evil', user: null, name: 'x', guestId: huge });
  assert.ok(r1.guestId.length <= 64, 'guestId must be capped in length');
  assert.doesNotMatch(r1.guestId, /[^A-Za-z0-9_-]/, 'guestId must only contain safe characters');
  room.close();
});

test('a non-string guestId is not trusted as-is', () => {
  const room = makeRoom({ id: 'r9' });
  const r = room.join(fakeClient().ws, { pid: 'weird', user: null, name: 'x', guestId: { toString: () => 'nope' } });
  assert.notEqual(r.guestId, undefined);
  assert.doesNotMatch(String(r.guestId), /[^A-Za-z0-9_-]/, 'a non-string guestId must not be trusted as-is');
  room.close();
});

test('guestId is ignored entirely for a logged-in user', () => {
  const room = makeRoom({ id: 'r10' });
  const r = room.join(fakeClient().ws, { pid: 'acct', user: { id: 1, username: 'ace' }, name: 'ace', guestId: 'sneaky-override' });
  assert.equal(r.guestId, null, 'guestId must be ignored entirely for a logged-in user');
  room.close();
});

test('onStart fires once the match is flying after an explicit host start', async () => {
  let fired = 0;
  const room = makeRoom({ id: 'r11', onStart: () => { fired++; } });
  room.join(fakeClient().ws, { pid: 'host', user: null, name: 'x', guestId: null });
  assert.equal(room.start('host'), true);
  assert.equal(fired, 0, 'not while the stages are still building');
  await playing(room);
  assert.equal(fired, 1);
  room.close();
});

test('onStart also fires for the ready-countdown auto-start, not just an explicit start message', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let fired = 0;
  const room = makeRoom({ id: 'r12', onStart: () => { fired++; } });
  room.join(fakeClient().ws, { pid: 'host', user: null, name: 'x', guestId: null });
  room.setReady('host', true); // solo player ready -> countdown starts
  t.mock.timers.tick(4000);
  assert.equal(room.state, 'lobby', 'must not start before the countdown elapses');
  t.mock.timers.tick(1000); // COUNTDOWN_SECONDS
  await playing(room);
  assert.equal(fired, 1, 'must fire once the auto-start countdown elapses');
  room.close();
});

test('room info marks the host, the match type and each player pid so the client can gate Start', () => {
  const room = makeRoom({ id: 'r-host' });
  room.join(fakeClient().ws, { pid: 'a', user: null, name: 'A', guestId: null });
  room.join(fakeClient().ws, { pid: 'b', user: null, name: 'B', guestId: null });
  assert.deepEqual(room.info().players.map((p) => [p.pid, p.host]), [['a', true], ['b', false]]);
  assert.deepEqual([room.info().type, room.info().level], ['coop', 'medium']);
  room.close();
});

// The kites are lost: every pilot out, on the stage the match is on.
function loseOn(room, stageIndex) {
  room.match.stageIndex = stageIndex;
  for (const p of room.match.pilots) Object.assign(p, { alive: false, lives: 0 });
  room.match.phase = 'over';
  room._tick();
}

test('a continue after the kites are lost flies on from the same stage with the score banked, three times', async () => {
  const room = makeRoom({ id: 'r-cont', stageCount: 2 });
  const c = fakeClient();
  room.join(c.ws, { pid: 'p', user: null, name: 'P', guestId: null });
  assert.equal(room.continueGame('p'), false, 'no continue before the game is even over');
  room.start('p');
  await playing(room);
  stop(room);
  room.match.pilots[0].score = 700;
  loseOn(room, 1);
  assert.equal(room.state, 'over');
  const over = c.sent.filter((m) => m.t === 'gameover').at(-1);
  assert.deepEqual([over.result, over.stage, over.scores, over.continuesLeft], ['over', 2, [700], 3]);

  assert.equal(room.continueGame('nobody'), false, 'only a player in the room can continue');
  assert.equal(room.continueGame('p'), true);
  stop(room);
  assert.equal(room.state, 'playing');
  assert.equal(room.match.stages.length, 1, 'the new match starts on the stage where they fell');
  assert.equal(room.snapshot(0).stage, 1, 'and counts it as stage 2 of 2');
  assert.equal(room.snapshot(0).self.score, 700, 'the score is banked');
  assert.equal(c.sent.filter((m) => m.t === 'continued').at(-1).continuesLeft, 2);
  assert.equal(room.continueGame('p'), false, 'cannot continue while playing');

  loseOn(room, 0); assert.equal(room.continueGame('p'), true); stop(room);
  loseOn(room, 0); assert.equal(room.continueGame('p'), true); stop(room);
  loseOn(room, 0);
  assert.equal(c.sent.filter((m) => m.t === 'gameover').at(-1).continuesLeft, 0);
  assert.equal(room.continueGame('p'), false, 'no fourth credit');
  assert.ok(c.sent.some((m) => m.t === 'error' && /continues/i.test(m.error)));
  room.close();
});

test('a won match cannot be continued', async () => {
  const room = makeRoom({ id: 'r-vic' });
  const c = fakeClient();
  room.join(c.ws, { pid: 'p', user: null, name: 'P', guestId: null });
  room.start('p');
  await playing(room);
  stop(room);
  room.match.phase = 'won';
  room._tick();
  assert.equal(room.state, 'over');
  assert.equal(c.sent.filter((m) => m.t === 'gameover').at(-1).continuesLeft, 0);
  assert.equal(room.continueGame('p'), false);
  room.close();
});

test('a run that scored nothing is not recorded as a leaderboard row', async () => {
  const room = makeRoom({ id: 'r-zero' });
  room.join(fakeClient().ws, { pid: 'p', user: { id: 4242, username: 'zero' }, name: 'zero', guestId: null });
  room.start('p');
  await playing(room);
  stop(room);
  const runsFor = () => db.prepare('SELECT COUNT(*) AS n FROM runs WHERE user_id = 4242').get().n;
  loseOn(room, 0);
  assert.equal(runsFor(), 0, 'zero score, zero kills: nothing worth recording');
  room.continueGame('p');
  stop(room);
  Object.assign(room.match.pilots[0], { score: 300, kills: 1 });
  loseOn(room, 0);
  assert.equal(runsFor(), 1, 'a credit that scored is recorded');
  room.close();
});

test('engine events feed the stats: kills by seat, and an untouched stage clear', async () => {
  const room = makeRoom({ id: 'r-stats' });
  room.join(fakeClient().ws, { pid: 'p', user: { id: 77, username: 'stat' }, name: 'stat', guestId: null });
  room.setType('p', 'wingman');
  room.start('p');
  await playing(room);
  stop(room);
  room._onEvents([{ t: 'kill', seat: 0, kind: 'heavy' }, { t: 'kill', seat: 1, kind: 'drone' }, { t: 'stage-clear', stage: 0 }]);
  const stat = (k) => db.prepare('SELECT value FROM stats WHERE user_id = 77 AND key = ?').get(k)?.value;
  assert.deepEqual([stat('kills'), stat('thunderheads'), stat('untouched_stages'), stat('coop_stage_clears'), stat('deepest_stage')], [1, 1, 1, 1, 1],
    'the AI seat\'s kill is not the player\'s');
  room._onEvents([{ t: 'death', seat: 0 }, { t: 'stage-clear', stage: 0 }]);
  assert.equal(stat('untouched_stages'), 1, 'a hit stage is not untouched');
  room.close();
});

test('the public room list omits per-player ids and the host flag; in-room info keeps them', () => {
  const lobby = new Lobby();
  const room = lobby.create({ name: 'Public', isPublic: true });
  room.join(fakeClient().ws, { pid: 'a', user: null, name: 'A', guestId: null });
  room.join(fakeClient().ws, { pid: 'b', user: null, name: 'B', guestId: null });
  const listed = lobby.list().find((r) => r.id === room.id);
  assert.ok(listed, 'a public lobby room is listed');
  assert.deepEqual(listed.players, [{ name: 'A', ready: false, away: false }, { name: 'B', ready: false, away: false }]);
  for (const p of listed.players) { assert.equal('pid' in p, false); assert.equal('host' in p, false); }
  assert.deepEqual(room.info().players.map((p) => [p.pid, p.host]), [['a', true], ['b', false]]);
  room.close();
});

test('the lobby refuses a room past MAX_ROOMS and lists at most MAX_LISTED', () => {
  const lobby = new Lobby();
  for (let i = 0; i < MAX_ROOMS; i++) lobby.create({ name: 'R' + i });
  assert.throws(() => lobby.create({}), /busy/);
  assert.equal(lobby.rooms.size, MAX_ROOMS);
  assert.equal(lobby.list().length, MAX_LISTED);
  for (const r of [...lobby.rooms.values()]) r.close();
});

test('quick play finds an open room but never creates one', () => {
  const lobby = new Lobby();
  assert.equal(lobby.open(), null);
  assert.equal(lobby.rooms.size, 0);
  const room = lobby.create({ name: 'Open' });
  assert.equal(lobby.open(), room);
  room.close();
});

test('a room nobody joins is closed after EMPTY_ROOM_MS; a joined one stays', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const lobby = new Lobby();
    const empty = lobby.create({ name: 'Empty' });
    const used = lobby.create({ name: 'Used' });
    used.join(fakeClient().ws, { pid: 'a', user: null, name: 'A', guestId: null });
    mock.timers.tick(EMPTY_ROOM_MS);
    assert.equal(lobby.get(empty.id), null);
    assert.equal(lobby.get(used.id), used);
    used.close();
  } finally { mock.timers.reset(); }
});
