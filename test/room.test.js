import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Room pulls in the stats module, which opens the SQLite database on import: point it at a
// throwaway directory so the tests never touch ./data.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'pacific-skies-test-'));
const { Room } = await import('../server/game/room.js');

function fakeWs() { return { readyState: 1, sent: [], send(s) { this.sent.push(JSON.parse(s)); } }; }

function coopRoom() {
  const room = new Room({ id: 'r1', name: 'Test', seed: 'seed' });
  const host = fakeWs(), guest = fakeWs();
  room.join(host, { pid: 'host', user: null, name: 'Host' });
  room.join(guest, { pid: 'guest', user: null, name: 'Guest' });
  return { room, host, guest };
}

test('only the host can start a multi-player room directly', (t) => {
  const { room, guest } = coopRoom();
  t.after(() => room.close());
  assert.equal(room.start('guest'), false, 'guest start should be a no-op');
  assert.equal(room.state, 'lobby');
  assert.ok(!guest.sent.some((m) => m.t === 'start'), 'no start broadcast for a guest request');
  assert.equal(room.start('host'), true);
  assert.equal(room.state, 'playing');
  assert.ok(guest.sent.some((m) => m.t === 'start'));
  assert.equal(room.start('host'), false, 'a second start is a no-op');
});

test('a solo player is the host and can start', (t) => {
  const room = new Room({ id: 'r2', name: 'Solo', seed: 'seed' });
  t.after(() => room.close());
  room.join(fakeWs(), { pid: 'only', user: null, name: 'Only' });
  assert.equal(room.start('only'), true);
  assert.equal(room.state, 'playing');
});

test('room info marks the host and carries player ids', () => {
  const { room } = coopRoom();
  const info = room.info();
  assert.deepEqual(info.players.map((p) => [p.pid, p.host]), [['host', true], ['guest', false]]);
});
