import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = process.env.DATA_DIR || mkdtempSync(path.join(tmpdir(), 'skies-room-test-'));
const { Room } = await import('../server/game/room.js');

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
