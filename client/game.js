// Main client controller: title/attract screen, lobby -> room -> live game -> tally/gameover,
// all driven by the /ws protocol from server/index.js. The authoritative sim runs on the server;
// this file just sends input and renders the latest snapshot (client/render.js).
import { renderNav, api, token, toast, esc } from './common.js';
import { initAudio, sfx, setMuted, isMuted } from './audio.js';
import { createOcean, drawBackground, drawEntities, drawExplosions } from './render.js';
import { WORLD_W, WORLD_H } from '../shared/constants.js';

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
  // Scale world space (WORLD_W x WORLD_H = 384x576) down to the attract canvas's own pixel size.
  actx.scale(attractCanvas.width / 384, attractCanvas.height / 576);
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
let lastJoined = null; // { roomId, pid, resumeToken } -- re-saved after a continue

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

// Reconnect support: the server hands out a private resumeToken (distinct from pid, which is
// broadcast to every player via snapshots) so a dropped connection can rejoin its own slot rather
// than being rejected as "Game already in progress". Persisted in sessionStorage (not
// localStorage) so it only survives a refresh/reconnect within the same tab session, not forever.
const RESUME_KEY = 'ps_resume';
function saveResume(roomId, pid, resumeToken) {
  if (!roomId || !pid || !resumeToken) return;
  try { sessionStorage.setItem(RESUME_KEY, JSON.stringify({ roomId, pid, resumeToken })); } catch { /* ignore */ }
}
function loadResume(roomId) {
  try {
    const r = JSON.parse(sessionStorage.getItem(RESUME_KEY) || 'null');
    if (r && r.roomId === roomId && r.pid && r.resumeToken) return r;
  } catch { /* ignore */ }
  return null;
}
function clearResume() {
  try { sessionStorage.removeItem(RESUME_KEY); } catch { /* ignore */ }
}

function handleMessage(msg) {
  switch (msg.t) {
    case 'joined':
      myPid = msg.pid; roomState = msg.room;
      lastJoined = { roomId: msg.room.id, pid: msg.pid, resumeToken: msg.resumeToken };
      saveResume(msg.room.id, msg.pid, msg.resumeToken);
      if (msg.room.state === 'playing') {
        // Resumed back into a game already in progress -- go straight to the live view instead
        // of the pre-game lobby, which no 'start' broadcast will ever arrive to dismiss.
        show('game'); attractRunning = false; beginGameLoop();
      } else {
        renderRoom(); show('room');
      }
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
    case 'continued': onContinued(msg); break;
    case 'kicked': clearResume(); toast('Kicked', 'You were removed from the room.'); location.href = '/'; break;
    case 'error': toast('Error', msg.error); break;
    default: break;
  }
}

let ocean = createOcean(3);
let scrollY = 0;
let explosions = [];
let prevEnemies = new Map(); // id -> {x, y, type}
let prevAlive = new Map();   // pid -> {x, y}
const onScreen = (x, y) => x > 0 && x < WORLD_W && y > 0 && y < WORLD_H;
function trackExplosions(s) {
  const now = performance.now();
  const seen = new Map();
  for (const e of s.enemies) seen.set(e.id, e);
  // An enemy that was on screen last snapshot and is gone now was shot down (off-screen culls
  // happen well past the world edge, so they never qualify).
  for (const [id, e] of prevEnemies) {
    if (!seen.has(id) && onScreen(e.x, e.y)) {
      explosions.push({ x: e.x, y: e.y, size: e.type === 'boss' ? 34 : e.type === 'midboss' ? 24 : e.type === 'medium' ? 16 : 10, t0: now });
    }
  }
  prevEnemies = seen;
  const aliveNow = new Map();
  for (const p of s.players) {
    if (p.alive) aliveNow.set(p.pid, { x: p.x, y: p.y });
    else if (prevAlive.has(p.pid)) { const at = prevAlive.get(p.pid); explosions.push({ x: at.x, y: at.y, size: 18, t0: now }); }
  }
  prevAlive = aliveNow;
}
function onSnap(s) {
  trackExplosions(s);
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
    case 'hit': sfx('hit'); break;
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
  // The room is over -- a stale resume here would make the next page load try to rejoin/resume a
  // room that's already ended or been deleted, producing an avoidable "room no longer exists".
  clearResume();
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.id = 'gameover';
  const title = msg.reason === 'victory' ? 'VICTORY — TOKYO SECURED' : 'GAME OVER';
  const canContinue = msg.reason === 'gameover' && msg.continuesLeft > 0;
  overlay.innerHTML = `<h2>${title}</h2><p class="muted">Thanks for flying with Pacific Skies.</p>
    ${canContinue ? `<div class="continue"><div class="blink">CONTINUE? <b id="go-count">9</b></div>
      <button class="primary" id="go-continue">Insert Coin (${msg.continuesLeft} left)</button></div>` : ''}
    <button id="go-again">Play Again</button>`;
  q('#game').appendChild(overlay);
  overlay.querySelector('#go-again').onclick = () => location.href = '/';
  if (canContinue) {
    // Arcade-style: the offer counts down from 9; when it hits 0 only Play Again remains.
    let n = 9;
    const timer = setInterval(() => {
      n -= 1;
      const el = overlay.querySelector('#go-count');
      if (!el) { clearInterval(timer); return; }
      el.textContent = n;
      if (n <= 0) { clearInterval(timer); overlay.querySelector('.continue')?.remove(); }
    }, 1000);
    overlay.querySelector('#go-continue').onclick = () => { clearInterval(timer); send({ t: 'continue' }); };
  }
  sfx(msg.reason === 'victory' ? 'victory' : 'gameover');
}

function onContinued(msg) {
  roomState = msg.room;
  q('#gameover')?.remove();
  // The run is live again, so the resume credentials matter again too.
  if (lastJoined) saveResume(lastJoined.roomId, lastJoined.pid, lastJoined.resumeToken);
  sfx('coin');
  toast('Credit accepted', msg.continuesLeft > 0 ? `${msg.continuesLeft} continue${msg.continuesLeft === 1 ? '' : 's'} left.` : 'Last credit. Make it count.');
  beginGameLoop();
}

// ---------------- room screen ----------------
function renderRoom() {
  if (!roomState) return;
  q('#rs-name').textContent = roomState.name;
  q('#rs-id').textContent = '#' + roomState.id;
  q('#rs-link').textContent = location.origin + '/?room=' + roomState.id;
  q('#rs-link').href = '/?room=' + roomState.id;
  q('#rs-roster').innerHTML = roomState.players.map((p) => `<div class="roster-row"><span>${esc(p.name)}${p.host ? ' <span class="muted">(host)</span>' : ''}${p.away ? ' <span class="muted">(away)</span>' : ''}</span><span class="${p.ready ? 'ready' : 'notready'}">${p.ready ? 'READY' : 'waiting'}</span></div>`).join('');
  // The server only honours a direct start from the host (everyone else starts via ready-up and
  // the countdown), so only show the button to the player it will actually work for.
  const me = roomState.players.find((p) => p.pid === myPid);
  const isHost = !me || me.host || roomState.players.length <= 1;
  q('#rs-start').hidden = !isHost;
  q('#rs-hint').textContent = isHost ? '' : 'Ready up -- the host starts, or the game auto-starts when everyone is ready.';
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
// Builds the {t:'join', ...} payload for a known target room, including resume credentials when
// sessionStorage has a matching one for this exact room -- so a refresh/reconnect rejoins the
// same slot instead of being rejected as "Game already in progress".
function joinRoomMsg(roomId) {
  const resume = loadResume(roomId);
  return {
    t: 'join', token: token(), name: guestName(), roomId,
    ...(resume ? { resumePid: resume.pid, resume: resume.resumeToken } : {}),
  };
}

q('#join-link').addEventListener('click', () => {
  const id = prompt('Room code?');
  if (!id) return;
  connect().addEventListener('open', () => send(joinRoomMsg(id)));
});

const params = new URLSearchParams(location.search);
if (params.get('room')) {
  connect().addEventListener('open', () => send(joinRoomMsg(params.get('room'))));
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

// ---- touch: drag anywhere on the canvas to fly toward the finger (autofire while touching);
// a second finger triggers a loop-the-loop. Canvas pixels map back to world units because the
// canvas may be scaled down by CSS on small screens.
const touch = { active: false, x: 0, y: 0, loop: false };
function canvasPoint(t) {
  const r = canvas.getBoundingClientRect();
  return { x: (t.clientX - r.left) * (WORLD_W / r.width), y: (t.clientY - r.top) * (WORLD_H / r.height) };
}
function onTouch(e) {
  if (!screens.game.classList.contains('on')) return;
  e.preventDefault();
  if (e.touches.length === 0) { touch.active = false; return; }
  const p = canvasPoint(e.touches[0]);
  // Fly a little above the finger so the thumb doesn't cover the plane.
  touch.active = true; touch.x = p.x; touch.y = p.y - 40;
  if (e.type === 'touchstart' && e.touches.length >= 2) touch.loop = true;
}
for (const ev of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) canvas.addEventListener(ev, onTouch, { passive: false });

function currentInput() {
  const input = {
    up: keys.has('KeyW') || keys.has('ArrowUp'),
    down: keys.has('KeyS') || keys.has('ArrowDown'),
    left: keys.has('KeyA') || keys.has('ArrowLeft'),
    right: keys.has('KeyD') || keys.has('ArrowRight'),
    fire: keys.has('Space'),
    loop: keys.has('ShiftLeft') || keys.has('ShiftRight') || keys.has('KeyQ'),
  };
  if (touch.active) {
    const me = latestSnap?.players.find((p) => p.pid === myPid);
    if (me) {
      const dead = 6;
      if (touch.x < me.x - dead) input.left = true; else if (touch.x > me.x + dead) input.right = true;
      if (touch.y < me.y - dead) input.up = true; else if (touch.y > me.y + dead) input.down = true;
    }
    input.fire = true;
  }
  if (touch.loop) { input.loop = true; touch.loop = false; }
  return input;
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
    if (explosions.length) explosions = drawExplosions(ctx, explosions, performance.now());
  }
  requestAnimationFrame(renderFrame);
}
