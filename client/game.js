// Main client controller: title/attract screen, lobby -> room -> live game -> tally/gameover,
// all driven by the /ws protocol from server/index.js. The authoritative sim runs on the server;
// this file just sends input and renders the latest snapshot (client/render.js).
import { renderNav, api, token, toast, esc } from './common.js';
import { initAudio, sfx, setMuted, isMuted } from './audio.js';
import { createOcean, drawBackground, drawEntities } from './render.js';
import { WORLD_H } from '../shared/constants.js';

renderNav('play');
initAudio();

// ---------------- screens ----------------
const screens = { title: q('#title'), room: q('#roomscreen'), game: q('#game') };
function show(name) { for (const k in screens) screens[k].classList.toggle('on', k === name); }
function q(sel) { return document.querySelector(sel); }

// ---------------- attract mode demo flight (title screen) ----------------
const attractCanvas = q('#attract');
const actx = attractCanvas.getContext('2d');
const attractOcean = createOcean(7);
let attractScroll = 0;
let attractRunning = true;
function attractFrame(ts) {
  if (!attractRunning) return;
  const t = ts / 1000;
  attractScroll += 1.2;
  actx.save();
  actx.scale(attractCanvas.width / 384, attractCanvas.height / 576 * (576 / 360));
  drawBackground(actx, attractOcean, attractScroll, t);
  const demoPlayer = { pid: 'demo', x: 192 + Math.sin(t * 0.7) * 90, y: 260 + Math.sin(t * 1.3) * 40, alive: true, side: false, invuln: false, looping: Math.floor(t) % 6 === 0 };
  const enemies = [];
  for (let i = 0; i < 4; i++) {
    const ey = ((t * 60 + i * 140) % 500) - 40;
    enemies.push({ id: i, type: 'small', kind: 'sine', x: 100 + i * 60 + Math.sin(t * 2 + i) * 30, y: ey, hp: 1, maxHp: 1 });
  }
  drawEntities(actx, { players: [demoPlayer], enemies, bullets: [], enemyBullets: [], powItems: [] });
  actx.restore();
  requestAnimationFrame(attractFrame);
}
requestAnimationFrame(attractFrame);

api('/api/leaderboard').then((lb) => {
  const best = lb.scores?.[0];
  q('#hiscore').textContent = best ? `HI-SCORE ${best.score.toLocaleString()} — ${best.username}` : 'HI-SCORE 0';
}).catch(() => {});

// ---------------- networking ----------------
let ws = null;
let myPid = null;
let roomState = null;
let latestSnap = null;

function connect() {
  // A double-click on quick/create/join would otherwise leak the previous socket (and a ghost
  // server-side client); drop it quietly before opening a fresh one.
  if (ws) { const old = ws; ws = null; old.onclose = null; try { old.close(); } catch { /* already closed */ } }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/ws`);
  ws = sock;
  sock.addEventListener('message', (ev) => {
    if (ws !== sock) return; // superseded by a newer connection
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    handleMessage(msg);
  });
  sock.addEventListener('close', () => { if (ws === sock) toast('Disconnected', 'Connection to server lost.'); });
  return sock;
}
function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function handleMessage(msg) {
  switch (msg.t) {
    case 'joined':
      myPid = msg.pid; roomState = msg.room;
      renderRoom(); show('room');
      break;
    case 'roster': roomState = msg.room; renderRoom(); break;
    case 'countdown':
      q('#rs-countdown').textContent = msg.seconds != null ? `Starting in ${msg.seconds}...` : '';
      break;
    case 'start':
      roomState = msg.room; show('game'); attractRunning = false; beginGameLoop();
      break;
    case 'chat': {
      const log = q('#rs-chatlog');
      const line = document.createElement('div'); line.textContent = `${msg.name}: ${msg.text}`;
      log.appendChild(line); log.scrollTop = log.scrollHeight;
      break;
    }
    case 'snap': latestSnap = msg.s; onSnap(msg.s); break;
    case 'event': onEvent(msg.event); break;
    case 'achievement': toast('Achievement unlocked', msg.achievement.name, 'ach'); sfx('1up'); break;
    case 'gameover': onGameOver(msg); break;
    case 'kicked': toast('Kicked', 'You were removed from the room.'); location.href = '/'; break;
    case 'error': toast('Error', msg.error); break;
    default: break;
  }
}

let ocean = createOcean(3);
let scrollY = 0;
function onSnap(s) {
  q('#hud-stage').textContent = s.stageNumber;
  q('#hud-stagename').textContent = s.stageName || '';
  const me = s.players.find((p) => p.pid === myPid);
  if (me) {
    q('#hud-lives').textContent = me.lives;
    q('#hud-loops').textContent = me.loops;
    q('#hud-score').textContent = me.score.toLocaleString();
  }
}

function onEvent(ev) {
  switch (ev.t) {
    case 'shot': sfx('shoot'); break;
    case 'kill': sfx('kill'); break;
    case 'boss-down': case 'midboss-down': sfx('explosion'); break;
    case 'boss-appear': case 'midboss-appear': sfx('boss-alarm'); break;
    case 'loop': sfx('loop'); break;
    case 'pow': sfx('pow'); break;
    case 'bomb': sfx('bomb'); break;
    case '1up': sfx('1up'); break;
    case 'player-death': sfx('death'); break;
    case 'stage-clear': sfx('stage-clear'); showTally(ev); break;
    case 'red-formation-clear': break;
    case 'victory': sfx('victory'); break;
    default: break;
  }
}

function showTally(ev) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  const mine = ev.tally.find((t) => t.pid === myPid) || ev.tally[0];
  overlay.innerHTML = `<h2>STAGE ${ev.stage} CLEAR</h2>
    <table>
      <tr><th>Shots</th><td>${mine.shotsFired}</td></tr>
      <tr><th>Hits</th><td>${mine.hits}</td></tr>
      <tr><th>Accuracy</th><td>${mine.accuracy}%</td></tr>
      <tr><th>Bonus</th><td>${mine.bonus.toLocaleString()}</td></tr>
      <tr><th>Untouched</th><td>${mine.untouched ? 'YES' : 'no'}</td></tr>
    </table>`;
  q('#game').appendChild(overlay);
  setTimeout(() => overlay.remove(), 3600);
}

function onGameOver(msg) {
  running = false;
  if (inputTimer) { clearInterval(inputTimer); inputTimer = null; } // nothing to send once the run is over
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  const title = msg.reason === 'victory' ? 'VICTORY — TOKYO SECURED' : 'GAME OVER';
  overlay.innerHTML = `<h2>${title}</h2><p class="muted">Thanks for flying with Pacific Skies.</p>
    <button class="primary" id="go-again">Play Again</button>`;
  q('#game').appendChild(overlay);
  overlay.querySelector('#go-again').onclick = () => location.href = '/';
  sfx(msg.reason === 'victory' ? 'victory' : 'gameover');
}

// ---------------- room screen ----------------
function renderRoom() {
  if (!roomState) return;
  q('#rs-name').textContent = roomState.name;
  q('#rs-id').textContent = '#' + roomState.id;
  q('#rs-link').textContent = location.origin + '/?room=' + roomState.id;
  q('#rs-link').href = '/?room=' + roomState.id;
  q('#rs-roster').innerHTML = roomState.players.map((p) => `<div class="roster-row"><span>${esc(p.name)}</span><span class="${p.ready ? 'ready' : 'notready'}">${p.ready ? 'READY' : 'waiting'}</span></div>`).join('');
}

q('#rs-ready').addEventListener('click', function () {
  const ready = this.textContent === 'Ready';
  this.textContent = ready ? 'Cancel' : 'Ready';
  send({ t: 'ready', ready });
});
q('#rs-start').addEventListener('click', () => send({ t: 'start' }));
q('#rs-chat').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.value.trim()) { send({ t: 'chat', text: e.target.value.trim() }); e.target.value = ''; }
});

// ---------------- lobby actions ----------------
function guestName() { return q('#gname').value.trim() || 'Guest'; }

q('#quick').addEventListener('click', () => {
  connect().addEventListener('open', () => send({ t: 'join', token: token(), name: guestName() }));
  sfx('coin');
});
q('#create').addEventListener('click', () => {
  connect().addEventListener('open', () => send({ t: 'join', token: token(), name: guestName(), create: true }));
  sfx('coin');
});
q('#join-link').addEventListener('click', () => {
  const id = prompt('Room code?');
  if (!id) return;
  connect().addEventListener('open', () => send({ t: 'join', token: token(), name: guestName(), roomId: id }));
});

const params = new URLSearchParams(location.search);
if (params.get('room')) {
  connect().addEventListener('open', () => send({ t: 'join', token: token(), name: guestName(), roomId: params.get('room') }));
}

// ---------------- game loop: input + render ----------------
const canvas = q('#view');
const ctx = canvas.getContext('2d');
const keys = new Set();
window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'KeyM') setMuted(!isMuted());
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));

function currentInput() {
  return {
    up: keys.has('KeyW') || keys.has('ArrowUp'),
    down: keys.has('KeyS') || keys.has('ArrowDown'),
    left: keys.has('KeyA') || keys.has('ArrowLeft'),
    right: keys.has('KeyD') || keys.has('ArrowRight'),
    fire: keys.has('Space'),
    loop: keys.has('ShiftLeft') || keys.has('ShiftRight') || keys.has('KeyQ'),
  };
}

let running = false;
let inputTimer = null;
function beginGameLoop() {
  running = true;
  if (inputTimer) clearInterval(inputTimer);
  inputTimer = setInterval(() => { if (running) send({ t: 'input', ...currentInput() }); }, 1000 / 30);
  requestAnimationFrame(renderFrame);
}
function renderFrame(ts) {
  if (screens.game.classList.contains('on')) {
    scrollY += 2;
    drawBackground(ctx, ocean, scrollY, ts / 1000);
    if (latestSnap) drawEntities(ctx, latestSnap);
  }
  requestAnimationFrame(renderFrame);
}
void WORLD_H;
