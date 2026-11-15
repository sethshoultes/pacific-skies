// The live WebSocket's public caps: chat rate, message flood, and quick-play room creation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { MAX_PLAYERS } from '../shared/constants.js';
import { startServer } from './helpers/server.mjs';

// Each test boots its own server, so one test's rate-limit counts never reach another.
let srv;
const fresh = (fn) => async () => { srv = await startServer(); try { await fn(); } finally { await srv.stop(); } };

function connect() {
  const ws = new WebSocket(srv.baseUrl.replace('http', 'ws') + '/ws');
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d)));
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({ ws, msgs, closed }));
    ws.on('error', reject);
  });
}
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

async function joinQuick() {
  const c = await connect();
  c.ws.send(JSON.stringify({ t: 'join', name: 'T' }));
  await settle(150);
  return c;
}

test('chat: the sixth message in ten seconds is refused, the first five go out', fresh(async () => {
  const c = await joinQuick();
  for (let i = 0; i < 6; i++) c.ws.send(JSON.stringify({ t: 'chat', text: 'hi ' + i }));
  await settle();
  assert.equal(c.msgs.filter((m) => m.t === 'chat').length, 5);
  assert.ok(c.msgs.some((m) => m.t === 'error' && /Slow down/.test(m.error)));
  c.ws.close();
}));

test('a socket that floods messages is closed with 1008', fresh(async () => {
  const c = await connect();
  for (let i = 0; i < 400; i++) c.ws.send('{"t":"noop"}');
  const timedOut = new Promise((r) => setTimeout(() => r('still open after 5 s'), 5000).unref());
  assert.equal(await Promise.race([c.closed, timedOut]), 1008);
  c.ws.terminate();
}));

test('quick play stops creating rooms after ten a minute from one address', fresh(async () => {
  const socks = [];
  for (let i = 0; i < 10 * MAX_PLAYERS; i++) socks.push(await joinQuick());
  assert.ok(socks.every((s) => s.msgs.some((m) => m.t === 'joined')), 'ten rooms fill');
  const late = await joinQuick();
  assert.ok(late.msgs.some((m) => m.t === 'error' && /too many rooms/.test(m.error)));
  assert.ok(!late.msgs.some((m) => m.t === 'joined'));
  for (const s of [...socks, late]) s.ws.close();
}));
