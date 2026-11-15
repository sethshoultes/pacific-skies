// Rooms over real WebSockets against the real server: every match type plays to its end, `act`
// is the only way in and is checked, and a dropped player resumes their seat.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from './helpers/server.mjs';

// One-stage matches; `fast` also ticks every millisecond, so a whole match is a few seconds.
let fast;
let live;
before(async () => {
  [fast, live] = await Promise.all([
    startServer({ env: { SKIES_STAGES: '1', SKIES_TICK_MS: '1' } }),
    startServer({ env: { SKIES_STAGES: '1' } }),
  ]);
});
after(async () => { await Promise.all([fast?.stop(), live?.stop()]); });

function connect(srv) {
  const ws = new WebSocket(srv.baseUrl.replace('http', 'ws') + '/ws');
  const msgs = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    msgs.push(m);
    for (const w of [...waiters]) if (w.ok(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  const c = {
    ws, msgs,
    send: (m) => ws.send(JSON.stringify(m)),
    /** The first message (already here or still to come) that passes `ok`. */
    next: (ok, ms = 60_000) => {
      const had = msgs.find(ok);
      if (had) return Promise.resolve(had);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out; last: ${JSON.stringify(msgs.slice(-3))}`)), ms);
        waiters.push({ ok, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      });
    },
  };
  return new Promise((resolve, reject) => { ws.on('open', () => resolve(c)); ws.on('error', reject); });
}
const is = (t) => (m) => m.t === t;
const FIRE = { move: 0, fire: true, dash: false };

/** A host makes a room of `type` (and `guests` join it), starts it, and everyone gets 'start'. */
async function room(srv, type, guests = 0) {
  const host = await connect(srv);
  host.send({ t: 'join', create: true, name: 'Host' });
  const { room: info } = await host.next(is('joined'));
  const others = [];
  for (let i = 0; i < guests; i++) {
    const g = await connect(srv);
    g.send({ t: 'join', roomId: info.id, name: 'Guest' + i });
    await g.next(is('joined'));
    others.push(g);
  }
  host.send({ t: 'type', type, level: 'easy' });
  await host.next((m) => m.t === 'roster' && m.room.type === type);
  host.send({ t: 'start' });
  const all = [host, ...others];
  const starts = await Promise.all(all.map((c) => c.next(is('start'))));
  return { all, start: starts[0], roomId: info.id };
}

const close = (all) => { for (const c of all) c.ws.close(); };

for (const [type, guests, kinds] of [
  ['coop', 1, ['human', 'human']],
  ['race', 1, ['human', 'human']],
  ['wingman', 0, ['human', 'ai']],
  ['rival', 0, ['human', 'ai']],
  ['watch', 0, ['ai', 'ai']],
]) {
  test(`${type}: plays to the end over real WebSockets`, async () => {
    const { all, start } = await room(fast, type, guests);
    assert.deepEqual(start.seats.map((s) => s.kind), kinds);
    if (kinds[0] === 'human') all.forEach((c) => c.send({ t: 'act', a: FIRE }));
    const overs = await Promise.all(all.map((c) => c.next(is('gameover'))));
    for (const o of overs) {
      assert.equal(o.type, type);
      assert.ok(['won', 'over'].includes(o.result), o.result);
      assert.equal(o.scores.length, kinds.length);
    }
    const snaps = all[0].msgs.filter(is('snap'));
    assert.ok(snaps.length > 100, `${snaps.length} snapshots`);
    assert.ok(snaps.at(-1).s.phase === overs[0].result, 'the last snapshot shows the end');
    assert.ok(snaps.every((m) => JSON.stringify(m).length < 16 * 1024), 'every snapshot is under 16 KB');
    if (kinds.includes('ai')) {
      const ai = kinds.indexOf('ai');
      const xs = new Set(snaps.map((m) => [m.s.self, ...m.s.others].find((p) => p.seat === ai).x));
      assert.ok(xs.size > 5, 'the AI kite flew');
    }
    close(all);
  });
}

test('an illegal or malformed act is refused, and nothing but act moves a kite', async () => {
  const { all: [host] } = await room(live, 'coop');
  await host.next(is('snap'));
  const refusals = () => host.msgs.filter((m) => m.t === 'error' && /Refused/.test(m.error)).length;
  const bad = [
    { t: 'act', a: { move: 9, fire: false, dash: false } },
    { t: 'act', a: { move: 1, fire: 1, dash: false } },
    { t: 'act', a: { move: 1, fire: true } },
    { t: 'act', a: 'up' },
    { t: 'act' },
    { t: 'input', up: true, fire: true },
  ];
  for (const m of bad) host.send(m);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(refusals(), bad.length);
  const x = host.msgs.filter(is('snap')).at(-1).s.self.x;
  assert.equal(x, 192, 'the kite has not moved');

  host.send({ t: 'act', a: { move: 3, fire: false, dash: false } });
  await host.next((m) => m.t === 'snap' && m.s.self.x > x + 20);
  host.send({ t: 'act', a: { move: 0, fire: false, dash: true } });
  await host.next((m) => m.t === 'snap' && m.s.self.dashCd > 0);
  host.send({ t: 'act', a: { move: 0, fire: false, dash: true } });
  await host.next((m) => m.t === 'error' && /not legal now/.test(m.error), 2000);
  close([host]);
});

test('a dropped player resumes their seat with the resume token and flies on', async () => {
  const { all: [host, guest], roomId } = await room(live, 'coop', 1);
  const { pid, resumeToken } = guest.msgs.find(is('joined'));
  guest.ws.terminate();
  await host.next((m) => m.t === 'roster' && m.room.players.some((p) => p.pid === pid && p.away));

  const back = await connect(live);
  back.send({ t: 'join', roomId, name: 'Guest0', resumePid: pid, resume: 'wrong-token-wrong-token-wrong-to' });
  await back.next(is('error'), 2000);
  back.send({ t: 'join', roomId, name: 'Guest0', resumePid: pid, resume: resumeToken });
  const joined = await back.next((m) => m.t === 'joined' && m.pid === pid);
  assert.equal(joined.room.players.find((p) => p.pid === pid).away, false);
  const start = await back.next(is('start'));
  assert.equal(start.stages.length, 1);
  const snap = await back.next(is('snap'));
  assert.equal(snap.s.self.seat, 1, 'the same seat');
  back.send({ t: 'act', a: { move: 7, fire: false, dash: false } });
  const x = snap.s.self.x;
  await back.next((m) => m.t === 'snap' && m.s.self.x < x - 20);
  close([host, back]);
});
