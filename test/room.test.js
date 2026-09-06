import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Always a fresh temp dir -- falling back to an existing DATA_DIR could share a SQLite DB with
// another test file's run and make assertions order-dependent/flaky.
const dataDir = mkdtempSync(path.join(tmpdir(), 'skies-room-test-'));
process.env.DATA_DIR = dataDir;
const { Room } = await import('../server/game/room.js');
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

test('only the host can start a co-op room directly; start() reports whether it started', () => {
  const room = new Room({ id: 'r1', name: 'Test', seed: 's' });
  const host = fakeClient(); const guest = fakeClient();
  room.clients.set('host', host); room.clients.set('guest', guest);
  assert.equal(room.start('guest'), false, 'non-host start must be refused');
  assert.equal(room.state, 'lobby');
  assert.ok(guest.sent.some((m) => m.t === 'error' && /host/i.test(m.error)), 'guest gets an error');
  assert.equal(room.start('host'), true);
  assert.equal(room.state, 'playing');
  assert.equal(room.start('host'), false, 'a second start is a no-op');
  clearInterval(room.tickTimer);
});

test('a solo player is the host and can start', () => {
  const room = new Room({ id: 'r2', name: 'Solo', seed: 's' });
  const solo = fakeClient(); room.clients.set('solo', solo);
  assert.equal(room.start('solo'), true);
  clearInterval(room.tickTimer);
});

test('nobody new can join once the game is playing, but an existing player may rejoin', () => {
  const room = new Room({ id: 'r3', name: 'Live', seed: 's' });
  const host = fakeClient(); room.clients.set('host', host);
  assert.equal(room.start('host'), true);
  const late = fakeClient();
  assert.throws(() => room.join(late.ws, { pid: 'late', user: null, name: 'late', guestId: null }), /in progress/i);
  assert.equal(room.clients.size, 1);
  assert.doesNotThrow(() => room.join(host.ws, { pid: 'host', user: null, name: 'x', guestId: null }));
  clearInterval(room.tickTimer);
});

test('joining attaches the account to the sim player so stats hooks can record for logged-in users', () => {
  const room = new Room({ id: 'r4', name: 'Stats', seed: 's' });
  const c = fakeClient();
  room.join(c.ws, { pid: 'u1', user: { id: 42, username: 'ace' }, name: 'ace', guestId: null });
  assert.equal(room.sim.players.get('u1').user?.id, 42);
  const g = fakeClient();
  room.join(g.ws, { pid: 'g1', user: null, name: 'guest', guestId: null });
  assert.equal(room.sim.players.get('g1').user, null);
});

test('resume() requires the client-private resumeToken, not the (broadcast, guessable) pid', () => {
  const room = new Room({ id: 'r5', name: 'Resume', seed: 's' });
  const host = fakeClient();
  room.join(host.ws, { pid: 'host', user: null, name: 'x', guestId: null });
  assert.equal(room.start('host'), true);
  const joinedMsg = host.sent.find((m) => m.t === 'joined');
  const { resumeToken } = joinedMsg;
  assert.ok(resumeToken && resumeToken.length >= 16, 'a private resume token is issued on join');

  room.disconnect('host');
  assert.equal(room.clients.get('host').away, true);

  // Guessing the token as the pid itself (what the old, vulnerable protocol used) must fail.
  assert.equal(room.resume({ readyState: 1, send: () => {} }, 'host', 'host'), null);
  assert.equal(room.clients.get('host').away, true, 'a wrong token must not resume the slot');

  // The real token succeeds.
  const resumed = room.resume({ readyState: 1, send: () => {} }, 'host', resumeToken);
  assert.deepEqual(resumed, { pid: 'host' });
  assert.equal(room.clients.get('host').away, false);
  clearInterval(room.tickTimer);
});

test('rejoining with the same pid clears a stale awayTimer instead of leaking it', () => {
  const room = new Room({ id: 'r6', name: 'Rejoin', seed: 's' });
  const host = fakeClient();
  room.join(host.ws, { pid: 'host', user: null, name: 'x', guestId: null });
  assert.equal(room.start('host'), true);

  room.disconnect('host');
  const staleTimer = room.clients.get('host').awayTimer;
  assert.ok(staleTimer, 'disconnect schedules an awayTimer');

  room.join(host.ws, { pid: 'host', user: null, name: 'x', guestId: null });
  assert.equal(staleTimer._destroyed, true, 'the old awayTimer must be cleared on rejoin');
  assert.equal(room.clients.get('host').awayTimer, null);
  clearInterval(room.tickTimer);
});

test('slot assignment does not collide when the original slot-1 player leaves and a new one joins', () => {
  const room = new Room({ id: 'r7', name: 'Slots', seed: 's' });
  const p1 = fakeClient(); const p2 = fakeClient(); const p3 = fakeClient();
  room.join(p1.ws, { pid: 'p1', user: null, name: 'p1', guestId: null });
  room.join(p2.ws, { pid: 'p2', user: null, name: 'p2', guestId: null });
  assert.equal(room.sim.players.get('p1').slot, 1);
  assert.equal(room.sim.players.get('p2').slot, 2);

  room.leave('p1'); // slot 1 is now free; clients.size alone would mislead the next join
  room.join(p3.ws, { pid: 'p3', user: null, name: 'p3', guestId: null });
  assert.equal(room.sim.players.get('p3').slot, 1, 'the new player takes the now-free slot 1');
  assert.notEqual(
    room.sim.players.get('p3').slot, room.sim.players.get('p2').slot,
    'must not collide with the still-present slot-2 player',
  );
});

test('a client-supplied guestId is capped and sanitized', () => {
  const room = new Room({ id: 'r8', name: 'GuestId', seed: 's' });
  const evil = fakeClient();
  const huge = 'a'.repeat(500) + '<script>';
  const r1 = room.join(evil.ws, { pid: 'evil', user: null, name: 'x', guestId: huge });
  assert.ok(r1.guestId.length <= 64, 'guestId must be capped in length');
  assert.doesNotMatch(r1.guestId, /[^A-Za-z0-9_-]/, 'guestId must only contain safe characters');
});

test('a non-string guestId is not trusted as-is', () => {
  const room = new Room({ id: 'r9', name: 'GuestId2', seed: 's' });
  const weird = fakeClient();
  const r = room.join(weird.ws, { pid: 'weird', user: null, name: 'x', guestId: { toString: () => 'nope' } });
  assert.notEqual(r.guestId, undefined);
  assert.doesNotMatch(String(r.guestId), /[^A-Za-z0-9_-]/, 'a non-string guestId must not be trusted as-is');
});

test('guestId is ignored entirely for a logged-in user', () => {
  const room = new Room({ id: 'r10', name: 'GuestId3', seed: 's' });
  const loggedIn = fakeClient();
  const r = room.join(loggedIn.ws, { pid: 'acct', user: { id: 1, username: 'ace' }, name: 'ace', guestId: 'sneaky-override' });
  assert.equal(r.guestId, null, 'guestId must be ignored entirely for a logged-in user');
});

test('onStart fires for an explicit host start', () => {
  let fired = 0;
  const room = new Room({ id: 'r11', name: 'OnStartExplicit', seed: 's', onStart: () => { fired++; } });
  const host = fakeClient();
  room.join(host.ws, { pid: 'host', user: null, name: 'x', guestId: null });
  assert.equal(room.start('host'), true);
  assert.equal(fired, 1);
  clearInterval(room.tickTimer);
});

test('onStart also fires for the ready-countdown auto-start, not just an explicit start message', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let fired = 0;
  const room = new Room({ id: 'r12', name: 'OnStartAuto', seed: 's', onStart: () => { fired++; } });
  const host = fakeClient();
  room.join(host.ws, { pid: 'host', user: null, name: 'x', guestId: null });
  room.setReady('host', true); // solo player ready -> countdown starts
  assert.equal(fired, 0, 'must not fire before the countdown elapses');
  t.mock.timers.tick(5000); // COUNTDOWN_SECONDS
  assert.equal(fired, 1, 'must fire once the auto-start countdown elapses');
  assert.equal(room.state, 'playing');
  clearInterval(room.tickTimer);
});
