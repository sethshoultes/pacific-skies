import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createMatch, step } from '../shared/engine/index.js';
import { WORLD_W, WORLD_H } from '../shared/engine/rules.js';
import { draftStage } from '../shared/ai/builder.js';
import { pilotAction } from '../shared/ai/pilot.js';
import { drawFrame, layout } from '../client/render.js';
import { moveFromVector, keysToAction, dragToAction } from '../client/input.js';
import { lookOf, LOOKS } from '../client/lore.js';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

function filesUnder(rel) {
  const dir = new URL(`../${rel}/`, import.meta.url);
  return readdirSync(dir).flatMap((n) => (statSync(new URL(n, dir)).isDirectory() ? filesUnder(`${rel}/${n}`) : [`${rel}/${n}`]));
}

/** A 2D context that accepts every call and records the method names. */
function fakeContext() {
  const calls = [];
  const gradient = { addColorStop() {} };
  const store = {};
  return {
    calls,
    ctx: new Proxy(store, {
      get: (o, k) => (k in o ? o[k] : (...args) => { calls.push(k); return k.startsWith('create') ? gradient : undefined; }),
      set: (o, k, v) => { o[k] = v; return true; },
    }),
  };
}

function midStage() {
  let s = createMatch({ seed: 'r', stages: [draftStage({ seed: 'r', depth: 2 }), draftStage({ seed: 'r', depth: 3 })], seats: 2 });
  for (let i = 0; i < 400; i++) s = step(s, [pilotAction(s, 0, 'hard'), pilotAction(s, 1, 'medium')]).state;
  return s;
}

test('banned names appear nowhere in client/, server/ or shared/', () => {
  const banned = /\b(1942|Capcom|P-38|Ayako|Tokyo|Midway|Super Ace|POW|Insert Coin)\b/;
  const files = ['client', 'server', 'shared'].flatMap(filesUnder);
  assert.ok(files.length >= 30, files.join());
  for (const f of files) assert.doesNotMatch(read(f), banned, f);
});

test('the renderer never steps the match or draws a random number, in its source', () => {
  for (const f of ['client/render.js', 'client/lore.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /\bstep\b|\badvance\b|engine\/index\.js|Math\.random/, f);
  }
});

test('drawing a frame leaves the state untouched and calls no Math.random', (t) => {
  const s = midStage();
  assert.ok(s.enemies.length || s.sparks.length, 'control: the field has something on it');
  const before = JSON.stringify(s);
  t.mock.method(Math, 'random', () => { throw new Error('the renderer drew a random number'); });
  for (const [w, h] of [[390, 844], [1280, 800]]) {
    const { ctx, calls } = fakeContext();
    drawFrame(ctx, { w, h, state: s, bursts: [{ x: 10, y: 10, r: 14, tick: s.tick - 2 }], labels: ['a', 'b'] });
    drawFrame(ctx, { w, h, state: null, tick: 99 });
    assert.ok(calls.filter((c) => c === 'arc').length > 50, 'it drew the sky and the field');
  }
  assert.equal(JSON.stringify(s), before);
});

test('layout fits the whole world on a phone and a laptop, with a HUD strip on the phone', () => {
  for (const [w, h] of [[390, 844], [1280, 800]]) {
    const { scale, ox, oy } = layout(w, h);
    assert.ok(ox >= 0 && oy >= 0 && ox + WORLD_W * scale <= w + 1e-9 && oy + WORLD_H * scale <= h + 1e-9, `${w}x${h}`);
  }
  assert.ok(layout(390, 844).oy >= 34);
  assert.equal(layout(1280, 800).oy, 0);
});

test('every enemy look has a name, and bosses take their stage form', () => {
  const stage = { boss: { form: 'nimbus-maw' } };
  assert.equal(lookOf({ kind: 'boss' }, stage), 'nimbus-maw');
  assert.equal(lookOf({ kind: 'heavy', path: 'sine' }, stage), 'thunderhead');
  assert.deepEqual(['straight', 'dive', 'sine', 'sweep-left', 'sweep-right'].map((path) => lookOf({ kind: 'drone', path })),
    ['fizzlet', 'fizzlet', 'arcwisp', 'shearling', 'shearling']);
  for (const k of Object.keys(LOOKS)) assert.ok(LOOKS[k].name);
});

test('input: vectors and keys map to the eight moves, fire and a legal-only dash', () => {
  assert.deepEqual([[0, 0], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]].map(([x, y]) => moveFromVector(x, y)),
    [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(moveFromVector(2, 1, 3), 0, 'inside the dead zone');
  const k = (...codes) => new Set(codes);
  assert.deepEqual(keysToAction(k(), true), { move: 0, fire: false, dash: false });
  assert.deepEqual(keysToAction(k('ArrowUp', 'KeyD', 'Space'), true), { move: 2, fire: true, dash: false });
  assert.deepEqual(keysToAction(k('KeyS', 'KeyA'), true), { move: 6, fire: false, dash: false });
  assert.equal(keysToAction(k('ArrowLeft', 'ArrowRight'), true).move, 0, 'opposite keys cancel');
  assert.equal(keysToAction(k('ShiftLeft'), true).dash, true);
  assert.equal(keysToAction(k('ShiftLeft'), false).dash, false, 'no dash on cooldown');
  const p = { x: 100, y: 100 };
  assert.deepEqual(dragToAction(p, { x: 100, y: 60 }, false, true), { move: 1, fire: true, dash: false });
  assert.deepEqual(dragToAction(p, { x: 101, y: 101 }, true, true), { move: 0, fire: true, dash: true });
  assert.equal(dragToAction(p, { x: 140, y: 100 }, true, false).dash, false);
});
