// Entry point: static file serving, the REST API (/api/*) and the WebSocket protocol (/ws) that
// drives live rooms. Wires together every other server/* module; see README.md "Architecture".
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { db, now } from './db.js';
import * as auth from './auth.js';
import * as stats from './stats.js';
import { Lobby } from './game/lobby.js';
import { clientIp } from './client-ip.js';
import { validateAllStages } from '../shared/stages.js';
import * as admin from './admin.js';
import * as account from './account.js';
import * as telemetry from './telemetry.js';
import * as log from './log.js';
import { heartbeat } from './ws-heartbeat.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const PORT = Number(process.env.PORT || 3001);
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lobby = new Lobby();
admin.init(lobby);
telemetry.startRetentionJob(90);

const stageProblems = validateAllStages();
if (stageProblems.length) log.warn('stage data validation issues at startup', { problems: stageProblems });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.map': 'application/json',
};

function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}
function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { const v = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const t = Date.now(); const b = buckets.get(key) || [];
  const recent = b.filter((x) => t - x < windowMs);
  if (recent.length >= max) { buckets.set(key, recent); return false; }
  recent.push(t); buckets.set(key, recent); return true;
}
function roomCreateKey(user, ip) { return 'createroom:' + (user ? 'u' + user.id : ip); }
setInterval(() => {
  const t = Date.now();
  for (const [key, times] of buckets) if (!times.length || t - times[times.length - 1] > 10 * 60_000) buckets.delete(key);
}, 5 * 60_000).unref();

function serveStatic(req, res, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch { res.writeHead(400); return res.end(); }
  if (rel.includes('\0')) { res.writeHead(400); return res.end(); }
  if (rel === '/') rel = '/index.html';
  const isShared = rel.startsWith('/shared/');
  const base = isShared ? path.join(ROOT, 'shared') : path.join(ROOT, 'client');
  const subPath = isShared ? rel.slice('/shared'.length) : rel;
  const file = path.normalize(path.join(base, subPath));
  const relToBase = path.relative(base, file);
  if (relToBase.startsWith('..') || path.isAbsolute(relToBase)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

async function api(req, res, url) {
  const user = auth.userFromToken(auth.bearer(req));
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const m = req.method;
  const need = () => { if (!user) throw Object.assign(new Error('Login required'), { status: 401 }); return user; };

  if (url.pathname.startsWith('/api/admin/')) return admin.handle(req, res, url, user);

  if (m === 'GET' && url.pathname === '/api/health') {
    const rooms = [...lobby.rooms.values()];
    return json(res, 200, { ok: true, uptime: process.uptime(), rooms: rooms.length, players: rooms.reduce((n, r) => n + r.playerCount, 0), version: PKG.version });
  }

  if (m === 'POST' && url.pathname === '/api/register') {
    const ip = clientIp(req);
    if (!rateLimit('register:' + ip, 10, 60_000)) return json(res, 429, { error: 'Slow down: 10 registrations per minute' });
    const b = await readBody(req); return json(res, 200, auth.register(b.username, b.password));
  }
  if (m === 'POST' && url.pathname === '/api/login') {
    const ip = clientIp(req);
    if (!rateLimit('login:' + ip, 20, 60_000)) return json(res, 429, { error: 'Slow down: 20 login attempts per minute' });
    const b = await readBody(req); return json(res, 200, auth.login(b.username, b.password));
  }
  if (m === 'POST' && url.pathname === '/api/logout') { auth.logout(auth.bearer(req)); return json(res, 200, { ok: true }); }
  if (m === 'GET' && url.pathname === '/api/me') {
    if (!user) return json(res, 200, { user: null, isAdmin: false });
    const s = stats.getStats(user.id);
    return json(res, 200, { user, stats: s, achievements: stats.getAchievements(user.id), runs: stats.recentRuns(user.id), isAdmin: admin.isAdmin(user) });
  }
  if (m === 'POST' && url.pathname === '/api/me/password') {
    const u = need();
    if (!rateLimit('pw:' + u.id, 10, 60_000)) return json(res, 429, { error: 'Slow down: 10 password changes per minute' });
    const b = await readBody(req);
    return json(res, 200, account.changePassword(u.id, auth.bearer(req), b.current, b.next));
  }
  if (m === 'DELETE' && url.pathname === '/api/me') {
    const u = need();
    if (!rateLimit('delacct:' + u.id, 5, 60_000)) return json(res, 429, { error: 'Slow down' });
    const b = await readBody(req).catch(() => ({}));
    return json(res, 200, account.deleteAccount(u.id, b.password));
  }
  if (m === 'GET' && url.pathname === '/api/me/prefs') { const u = need(); return json(res, 200, { prefs: account.getPrefs(u.id) }); }
  if (m === 'PUT' && url.pathname === '/api/me/prefs') { const u = need(); const b = await readBody(req); return json(res, 200, { prefs: account.setPrefs(u.id, b) }); }
  if (m === 'GET' && url.pathname === '/api/me/export') { const u = need(); return json(res, 200, account.exportData(u.id)); }
  if (m === 'POST' && url.pathname === '/api/telemetry') {
    const ip = clientIp(req);
    if (!rateLimit('telemetry:' + ip, 60, 60_000)) return json(res, 429, { error: 'Slow down' });
    const b = await readBody(req, 8 * 1024);
    telemetry.recordClient(b, { user, ip });
    return json(res, 200, { ok: true });
  }
  if (m === 'POST' && url.pathname === '/api/client-errors') {
    const ip = clientIp(req);
    if (!rateLimit('clienterr:' + ip, 20, 60_000)) return json(res, 429, { error: 'Slow down' });
    const b = await readBody(req, 32 * 1024);
    log.recordClientError({ message: b.message, stack: b.stack, url: b.url, ua: req.headers['user-agent'] }, user?.id);
    return json(res, 200, { ok: true });
  }
  if (m === 'GET' && url.pathname === '/api/leaderboard') return json(res, 200, stats.leaderboard(20));
  if (m === 'GET' && url.pathname === '/api/rooms') return json(res, 200, { rooms: lobby.list() });

  if (m === 'POST' && url.pathname === '/api/rooms') {
    const ip = clientIp(req);
    if (!rateLimit(roomCreateKey(user, ip), 10, 60_000)) return json(res, 429, { error: 'Slow down: too many rooms created' });
    const b = await readBody(req);
    const room = lobby.create({ name: b.name, isPublic: b.public !== false });
    return json(res, 200, { room: room.info() });
  }
  json(res, 404, { error: 'No such endpoint' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      try { await api(req, res, url); }
      catch (e) { json(res, e.status || 400, { error: e.message }); }
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (e) {
    log.error('http request failed', { url: req.url, stack: e.stack });
    if (!res.headersSent) { try { res.writeHead(500); } catch {} }
    try { res.end(); } catch {}
  }
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
wss.on('connection', (ws, req) => {
  let pid = crypto.randomBytes(4).toString('hex');
  let room = null;
  const ip = clientIp(req);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const send = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    try {
      switch (msg.t) {
        case 'join': {
          if (room) { room.leave(pid); room = null; }
          const user = auth.userFromToken(msg.token);
          const name = user ? user.username : String(msg.name || 'Guest').replace(/[^\w ]/g, '').slice(0, 12) || 'Guest';
          let target = msg.roomId ? lobby.get(msg.roomId) : null;
          if (msg.roomId && !target) throw new Error('That room no longer exists');
          if (msg.resume && target) {
            const resumed = target.resume(ws, msg.resume);
            if (resumed) { pid = resumed.pid; room = target; break; }
          }
          if (!target && msg.create) {
            if (!rateLimit(roomCreateKey(user, ip), 10, 60_000)) throw new Error('Slow down: too many rooms created');
            target = lobby.create({ name: msg.roomName, isPublic: msg.public !== false });
          } else if (!target) target = lobby.quick();
          const joined = target.join(ws, { pid, user, name, guestId: msg.guestId || null });
          room = target;
          telemetry.recordEvent({ kind: 'join', userId: user?.id || null, guestId: joined?.guestId || null, ip, data: { roomId: target.id } });
          if (!target._telemetryHooked) {
            target._telemetryHooked = true;
            const origBroadcast = target.broadcast.bind(target);
            target.broadcast = (out) => {
              if (out && out.t === 'gameover') telemetry.recordEvent({ kind: 'run_end', data: { roomId: target.id, stage: out.snapshot?.stageNumber, reason: out.reason } });
              return origBroadcast(out);
            };
          }
          break;
        }
        case 'input': if (room) room.handleInput(pid, msg); break;
        case 'chat': if (room) room.chat(pid, msg.text); break;
        case 'debug': {
          // Test-only hook (SKIES_DEBUG=1) so e2e scripts can force a stage clear without
          // playing the whole stage. Usable either from a connection that has already joined
          // the room, or -- so a lightweight helper socket can drive it without occupying one of
          // the room's two player slots -- by naming the room directly via msg.roomId.
          if (process.env.SKIES_DEBUG !== '1') break;
          const target = room || (msg.roomId ? lobby.get(msg.roomId) : null);
          if (target) target.debugAction(msg.action);
          break;
        }
        case 'ready': if (room) room.setReady(pid, !!msg.ready); break;
        case 'start':
          if (room) {
            const uid = room.clients.get(pid)?.user?.id || null;
            const started = room.start(pid);
            if (started) telemetry.recordEvent({ kind: 'start', userId: uid, ip, data: { roomId: room.id } });
          }
          break;
        case 'kick': if (room) room.kick(pid, msg.pid); break;
        case 'leave':
          if (room) {
            const uid = room.clients.get(pid)?.user?.id || null;
            const roomId = room.id;
            room.leave(pid); room = null; send({ t: 'left' });
            telemetry.recordEvent({ kind: 'leave', userId: uid, ip, data: { roomId } });
          }
          break;
      }
    } catch (e) { send({ t: 'error', error: e.message }); }
  });
  ws.on('close', () => { if (room) room.disconnect(pid); });
});
setInterval(() => heartbeat(wss.clients), 30000);

server.listen(PORT, () => {
  console.log(`Pacific Skies listening on http://localhost:${PORT}`);
});

// re-export a couple of small helpers `db`/`now` might be imported for by scripts/tests
export { db, now };
