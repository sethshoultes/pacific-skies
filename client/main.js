// Squallkite in the browser. Solo and Watch run the pure engine right here, on stages the AI built
// and checked off the main thread; online, the server runs the match and this page sends Actions
// and draws its snapshots. This file owns the clock, the input and the screens; the engine owns the
// rules and render.js owns the pixels.
import { createMatch, step, isOver } from '../shared/engine/index.js';
import { TICK_RATE } from '../shared/engine/rules.js';
import { pilotAction, LEVELS } from '../shared/ai/pilot.js';
import { drawFrame, layout } from './render.js';
import { keysToAction, dragToAction, GAME_KEYS } from './input.js';
import { armAudio, playEvent, isMuted, setMuted } from './audio.js';
import { KITES } from './lore.js';
import { createOnline, paintRoom, addChat, callsign, setCallsign } from './online.js';

const STAGE_COUNT = 6;
const TICK_MS = 1000 / TICK_RATE;
const WATCH = ['hard', 'medium'];

const $ = (s) => document.querySelector(s);
const canvas = $('#sky');
const ctx = canvas.getContext('2d');
const ui = {
  title: $('#title'), room: $('#room'), over: $('#over'), fly: $('#fly'), watch: $('#watch'), again: $('#again'),
  cont: $('#continue'), status: $('#status'), dash: $('#dash'), mute: $('#mute'), note: $('#note'), name: $('#callsign'),
};

// ---------------- stages, built off the main thread ----------------

const worker = new Worker(new URL('./build-worker.js', import.meta.url), { type: 'module' });
const params = new URLSearchParams(location.search);
let built = null; // { seed, stages } ready for the next offline match
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

// ---------------- the match: offline on the engine, or online from snapshots ----------------

let screen = 'title';
let online = false;
let view = null;  // what is drawn: the engine state offline, a state rebuilt from snapshots online
let seats = [];   // offline: 'human' or an AI level per seat; online: the server's seat list
let mySeat = 0;   // the seat this page steers, or -1 when watching
let held = [];
let bursts = [];
let titleTick = 0;
let overAt = 0;
let stages = null; // online: the room's stages
let lastSent = '';
let overMsg = null;

function show(next = screen) {
  screen = next;
  ui.title.hidden = screen !== 'title';
  ui.room.hidden = screen !== 'room';
  ui.over.hidden = screen !== 'over';
  document.body.dataset.screen = screen;
  if (screen === 'over') paintOver();
}

let noteTimer = null;
function note(text) {
  ui.note.textContent = text;
  ui.note.hidden = false;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { ui.note.hidden = true; }, 4000);
}

function startOffline(mode) {
  if (!built) return;
  online = false;
  seats = mode === 'watch' ? WATCH : ['human'];
  mySeat = mode === 'watch' ? -1 : 0;
  view = createMatch({ seed: built.seed, stages: built.stages, seats: seats.length });
  held = seats.map(() => ({ move: 0, fire: false, dash: false }));
  bursts = [];
  overAt = 0;
  show('playing');
  prebuild(newSeed()); // the next match's stages build while this one flies
}

const canDash = (p) => !isOver(view) && p.alive && p.dashCd === 0;

function humanAction(p) {
  if (touch.on) return dragToAction(p, touch.target, touch.dash, canDash(p));
  return keysToAction(keys, canDash(p));
}

/** Rings for kills and deaths, placed from the state before the events. */
function burstsFor(before, events) {
  for (const e of events) {
    playEvent(e);
    if (e.t === 'kill') {
      const was = before.enemies.find((x) => x.id === e.id);
      if (was) bursts.push({ x: was.x, y: was.y, r: was.kind === 'boss' ? 40 : 14, tick: view.tick });
    } else if (e.t === 'death') {
      const p = before.pilots.find((x) => x.seat === e.seat);
      if (p) bursts.push({ x: p.x, y: p.y, r: 22, tick: view.tick });
    }
  }
  bursts = bursts.filter((b) => view.tick - b.tick < 14);
}

function tickOffline() {
  const actions = seats.map((who, seat) => {
    if (who === 'human') return humanAction(view.pilots[seat]);
    held[seat] = view.tick % LEVELS[who].period === 0 ? pilotAction(view, seat, who) : { ...held[seat], dash: false };
    return held[seat];
  });
  const before = view;
  const r = step(view, actions);
  view = r.state;
  burstsFor(before, r.events);
  if (isOver(view) && !overAt) overAt = view.tick;
  if (overAt && view.tick - overAt > TICK_RATE * 1.5 && screen === 'playing') show('over');
}

/** Online: send this page's Action whenever it changes. */
function sendAction() {
  if (!view || mySeat < 0 || screen !== 'playing') return;
  const a = humanAction(view.pilots[mySeat]);
  const key = JSON.stringify(a);
  if (key === lastSent) return;
  lastSent = key;
  net.send({ t: 'act', a });
}

const fromSnap = (s) => ({
  tick: s.tick, stageIndex: s.stage, stages, phase: s.phase, stageTick: s.stageTick,
  pilots: [s.self, ...s.others].sort((a, b) => a.seat - b.seat),
  enemies: s.enemies, sparks: s.sparks, shots: s.shots, pickups: s.pickups,
});

function labels() {
  if (!online) return seats.map((who, i) => (who === 'human' ? KITES[i] : `${KITES[i]} · ${who} AI`));
  return seats.map((s, i) => (s.kind === 'human' ? s.name || KITES[i] : `${KITES[i]} · ${s.level} AI`));
}

const fmt = (n) => n.toLocaleString('en-US');

function paintOver() {
  const names = labels();
  if (!online) {
    $('#over-head').textContent = view.phase === 'won' ? 'Every storm sealed' : 'The sky took the kites';
    $('#over-line').textContent = view.pilots.map((p, i) => `${names[i]}: ${fmt(p.score)}`).join(' · ')
      + ` — stage ${view.stageIndex + 1} of ${view.stages.length}, ${view.stages[view.stageIndex].name}`;
    ui.again.hidden = false;
    ui.cont.hidden = true;
    return;
  }
  const m = overMsg;
  const race = m.type === 'race' || m.type === 'rival' || m.type === 'watch';
  let head = m.result === 'won' ? 'Every storm sealed' : 'The sky took the kites';
  let line = m.scores.map((s, i) => `${names[i]}: ${fmt(s)}`).join(' · ');
  if (race && m.scores.length > 1) {
    const best = Math.max(...m.scores);
    const top = m.scores.map((s, i) => (s === best ? names[i] : null)).filter(Boolean);
    head = top.length > 1 ? 'Dead level' : `${top[0]} wins`;
  } else if (m.scores.length > 1) {
    line = `Together: ${fmt(m.scores.reduce((a, b) => a + b, 0))} — ${line}`;
  }
  $('#over-head').textContent = head;
  $('#over-line').textContent = `${line} — stage ${m.stage} of ${m.stageCount}`;
  ui.again.hidden = true;
  ui.cont.hidden = !(m.result === 'over' && m.continuesLeft > 0);
  ui.cont.textContent = `Continue (${m.continuesLeft} left)`;
}

// ---------------- online ----------------

const net = createOnline({
  joined: () => { online = true; paintRoom(net); if (screen !== 'playing') show('room'); },
  roster: () => paintRoom(net),
  countdown: ({ seconds }) => { $('#rs-countdown').textContent = seconds ? `Starting in ${seconds}…` : ''; },
  starting: () => { $('#rs-countdown').textContent = 'Charting the storms…'; },
  start: (m) => {
    online = true;
    stages = m.stages;
    seats = m.seats;
    mySeat = seats.findIndex((s) => s.kind === 'human' && s.pid === net.me);
    view = null;
    bursts = [];
    lastSent = '';
    $('#rs-countdown').textContent = '';
    show('playing');
  },
  snap: ({ s, ev }) => {
    if (!stages) return;
    const before = view;
    view = fromSnap(s);
    if (before) burstsFor(before, ev); else ev.forEach(playEvent);
  },
  gameover: (m) => { overMsg = m; setTimeout(() => { if (screen === 'playing') show('over'); }, 1500); },
  continued: () => { overMsg = null; },
  chat: ({ name, text }) => addChat(name, text),
  achievement: ({ achievement }) => note(`Achievement: ${achievement.name}`),
  kicked: () => { net.leave(); online = false; show('title'); note('The host removed you from the room'); },
  error: ({ error }) => { if (!/^Refused/.test(error)) note(error); },
  lost: () => { online = false; show('title'); note('Lost the connection to the room'); },
});

const nameNow = () => { const n = ui.name.value.trim(); setCallsign(n); return n || 'Guest'; };
$('#quick').addEventListener('click', () => net.quick(nameNow()));
$('#create').addEventListener('click', () => net.create(nameNow()));
$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('#code').value.trim().toLowerCase();
  if (code) net.join(nameNow(), code);
});
$('#rs-ready').addEventListener('click', () => {
  const mine = net.room?.players.find((p) => p.pid === net.me);
  net.send({ t: 'ready', ready: !mine?.ready });
});
$('#rs-start').addEventListener('click', () => net.send({ t: 'start' }));
$('#rs-leave').addEventListener('click', () => { net.leave(); online = false; show('title'); });
const pickType = () => net.send({ t: 'type', type: $('#rs-type').value, level: $('#rs-level').value });
$('#rs-type').addEventListener('change', pickType);
$('#rs-level').addEventListener('change', pickType);
$('#rs-chatform').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#rs-chat').value.trim();
  if (text) net.send({ t: 'chat', text });
  $('#rs-chat').value = '';
});
$('#rs-link').addEventListener('click', (e) => {
  e.preventDefault();
  navigator.clipboard?.writeText(e.currentTarget.href).then(() => note('Invite link copied'), () => note(e.currentTarget.href));
});

// ---------------- input ----------------

const keys = new Set();
const touch = { on: false, id: null, from: null, start: null, target: { x: 0, y: 0 }, dash: false };
const typing = (e) => e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;

addEventListener('keydown', (e) => {
  if (typing(e)) return;
  if (e.code === 'KeyM') { toggleMute(); return; }
  if (e.code === 'Enter' && (screen === 'title' || (screen === 'over' && !online))) { startOffline('solo'); return; }
  if (e.code === 'Escape' && screen === 'over') { home(); return; }
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
  if (screen !== 'playing' || mySeat < 0 || !view) return;
  const p = view.pilots[mySeat];
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
function home() { if (online) { net.leave(); online = false; } show('title'); }
ui.mute.addEventListener('click', toggleMute);
ui.fly.addEventListener('click', () => startOffline('solo'));
ui.watch.addEventListener('click', () => startOffline('watch'));
ui.again.addEventListener('click', () => startOffline(seats[0] === 'human' ? 'solo' : 'watch'));
ui.cont.addEventListener('click', () => net.send({ t: 'continue' }));
$('#home').addEventListener('click', home);

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
    if (!online && view && screen !== 'title') tickOffline(); else titleTick++;
  }
  if (online) sendAction();
  const drawing = screen === 'playing' || screen === 'over' ? view : null;
  drawFrame(ctx, { w: innerWidth, h: innerHeight, state: drawing, tick: titleTick, bursts, labels: labels() });
  requestAnimationFrame(frame);
}

ui.name.value = callsign();
armAudio();
paintMute();
fit();
show();
prebuild(params.get('seed') || newSeed());
if (params.get('room')) net.join(callsign() || 'Guest', params.get('room'));
requestAnimationFrame(frame);
