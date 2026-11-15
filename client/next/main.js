// Stormglass in the browser, on the pure engine with no server: fly solo through the AI's built
// stages, or watch two AI kites fly them. This file owns the clock, the input and the screens; the
// engine owns the rules and render.js owns the pixels.
import { createMatch, step, isOver } from '../../shared/engine/index.js';
import { TICK_RATE } from '../../shared/engine/rules.js';
import { pilotAction, LEVELS } from '../../shared/ai/pilot.js';
import { drawFrame, layout } from './render.js';
import { keysToAction, dragToAction, GAME_KEYS } from './input.js';
import { armAudio, playEvent, isMuted, setMuted } from './audio.js';
import { KITES } from './lore.js';

const STAGE_COUNT = 6;
const TICK_MS = 1000 / TICK_RATE;
const WATCH = ['hard', 'medium'];

const $ = (s) => document.querySelector(s);
const canvas = $('#sky');
const ctx = canvas.getContext('2d');
const ui = { title: $('#title'), over: $('#over'), fly: $('#fly'), watch: $('#watch'), again: $('#again'), status: $('#status'), dash: $('#dash'), mute: $('#mute') };

// ---------------- stages, built off the main thread ----------------

const worker = new Worker(new URL('./build-worker.js', import.meta.url), { type: 'module' });
const params = new URLSearchParams(location.search);
let built = null; // { seed, stages } ready for the next match
let building = null;

function newSeed() {
  const [n] = crypto.getRandomValues(new Uint32Array(1));
  return n.toString(36);
}
function prebuild(seed) {
  building = seed;
  built = null;
  ready(false);
  worker.postMessage({ seed, count: STAGE_COUNT });
}
worker.onmessage = ({ data }) => {
  if (data.seed !== building) return;
  if (data.stages) { built = { seed: data.seed, stages: data.stages }; ready(true); return; }
  ui.status.textContent = `Charting the storms… ${data.done}/${data.count}`;
};
function ready(ok) {
  ui.fly.disabled = ui.watch.disabled = ui.again.disabled = !ok;
  if (ok) ui.status.textContent = `${STAGE_COUNT} stages charted and checked by the AI`;
}

// ---------------- the match ----------------

let screen = 'title';
let match = null;
let seats = []; // per seat: 'human' or an AI level
let held = [];
let bursts = [];
let titleTick = 0;
let overAt = 0;

function start(mode) {
  if (!built) return;
  seats = mode === 'watch' ? WATCH : ['human'];
  match = createMatch({ seed: built.seed, stages: built.stages, seats: seats.length });
  held = seats.map(() => ({ move: 0, fire: false, dash: false }));
  bursts = [];
  screen = 'playing';
  overAt = 0;
  show();
  prebuild(newSeed()); // the next match's stages build while this one flies
}

const canDash = (p) => !isOver(match) && p.alive && p.dashCd === 0;

function humanAction(p) {
  if (touch.on) return dragToAction(p, touch.target, touch.dash, canDash(p));
  return keysToAction(keys, canDash(p));
}

function tick() {
  const actions = seats.map((who, seat) => {
    const p = match.pilots[seat];
    if (who === 'human') return humanAction(p);
    held[seat] = match.tick % LEVELS[who].period === 0 ? pilotAction(match, seat, who) : { ...held[seat], dash: false };
    return held[seat];
  });
  const before = match;
  const r = step(match, actions);
  match = r.state;
  for (const e of r.events) {
    playEvent(e);
    if (e.t === 'kill') {
      const was = before.enemies.find((x) => x.id === e.id);
      if (was) bursts.push({ x: was.x, y: was.y, r: was.kind === 'boss' ? 40 : 14, tick: match.tick });
    } else if (e.t === 'death') {
      const p = before.pilots[e.seat];
      bursts.push({ x: p.x, y: p.y, r: 22, tick: match.tick });
    }
  }
  bursts = bursts.filter((b) => match.tick - b.tick < 14);
  if (isOver(match) && !overAt) overAt = match.tick;
  if (overAt && match.tick - overAt > TICK_RATE * 1.5 && screen === 'playing') { screen = 'over'; show(); }
}

function labels() {
  return seats.map((who, i) => (who === 'human' ? KITES[i] : `${KITES[i]} · ${who} AI`));
}

function show() {
  ui.title.hidden = screen !== 'title';
  ui.over.hidden = screen !== 'over';
  document.body.dataset.screen = screen;
  if (screen === 'over') {
    const won = match.phase === 'won';
    $('#over-head').textContent = won ? 'Every storm sealed' : 'The sky took the kites';
    $('#over-line').textContent = match.pilots.map((p, i) => `${labels()[i]}: ${p.score.toLocaleString('en-US')}`).join(' · ')
      + ` — stage ${match.stageIndex + 1} of ${match.stages.length}, ${match.stages[match.stageIndex].name}`;
  }
}

// ---------------- input ----------------

const keys = new Set();
const touch = { on: false, id: null, from: null, start: null, target: { x: 0, y: 0 }, dash: false };

addEventListener('keydown', (e) => {
  if (e.code === 'KeyM') { toggleMute(); return; }
  if (e.code === 'Enter' && screen !== 'playing') { start('solo'); return; }
  if (e.code === 'Escape' && screen === 'over') { screen = 'title'; show(); return; }
  if (GAME_KEYS.includes(e.code)) { keys.add(e.code); e.preventDefault(); }
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

function worldPoint(e) {
  const r = canvas.getBoundingClientRect();
  const { scale } = layout(r.width, r.height);
  return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
}
canvas.addEventListener('pointerdown', (e) => {
  if (screen !== 'playing' || seats[0] !== 'human') return;
  const p = match.pilots[0];
  Object.assign(touch, { on: true, id: e.pointerId, from: worldPoint(e), start: { x: p.x, y: p.y }, target: { x: p.x, y: p.y } });
  canvas.setPointerCapture(e.pointerId);
  if (e.pointerType === 'touch') document.body.classList.add('touch');
});
canvas.addEventListener('pointermove', (e) => {
  if (!touch.on || e.pointerId !== touch.id) return;
  const at = worldPoint(e);
  touch.target = { x: touch.start.x + at.x - touch.from.x, y: touch.start.y + at.y - touch.from.y };
});
const lift = (e) => { if (e.pointerId === touch.id) touch.on = false; };
canvas.addEventListener('pointerup', lift);
canvas.addEventListener('pointercancel', lift);
ui.dash.addEventListener('pointerdown', (e) => { e.preventDefault(); touch.dash = true; keys.add('ShiftLeft'); });
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) ui.dash.addEventListener(ev, () => { touch.dash = false; keys.delete('ShiftLeft'); });

function toggleMute() { setMuted(!isMuted()); paintMute(); }
function paintMute() { ui.mute.textContent = isMuted() ? 'Sound off' : 'Sound on'; ui.mute.setAttribute('aria-pressed', String(isMuted())); }
ui.mute.addEventListener('click', toggleMute);
ui.fly.addEventListener('click', () => start('solo'));
ui.watch.addEventListener('click', () => start('watch'));
ui.again.addEventListener('click', () => start(seats[0] === 'human' ? 'solo' : 'watch'));
$('#home').addEventListener('click', () => { screen = 'title'; show(); });

// ---------------- the clock and the canvas ----------------

function fit() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', fit);

let last = 0;
let acc = 0;
function frame(now) {
  acc = Math.min(acc + (last ? now - last : 0), TICK_MS * 5);
  last = now;
  while (acc >= TICK_MS) {
    acc -= TICK_MS;
    if (match && screen !== 'title') tick(); else titleTick++;
  }
  drawFrame(ctx, { w: innerWidth, h: innerHeight, state: screen === 'title' ? null : match, tick: titleTick, bursts, labels: labels() });
  requestAnimationFrame(frame);
}

armAudio();
paintMute();
fit();
show();
prebuild(params.get('seed') || newSeed());
requestAnimationFrame(frame);
