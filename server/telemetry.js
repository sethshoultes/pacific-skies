// First-party analytics: a single `events` table fed two ways --
//  1. server/index.js calls recordEvent() directly at a few WebSocket-protocol boundaries
//     (join/leave/start/gameover) without this module ever touching server/game/*.
//  2. the browser posts small beacons to POST /api/telemetry (see client/common.js `track()`),
//     which server/index.js forwards here via recordClient() after its own rate limiting.
//
// Privacy: raw IPs are never stored. Every event's IP is SHA-256 hashed together with a salt: an
// explicitly configured SKIES_SALT always takes precedence (and is persisted to the `meta` table
// so a later restart without the env var set still sees the same value); otherwise the salt is
// read back from `meta`, or generated once and persisted there on first run.
import crypto from 'node:crypto';
import { db, now } from './db.js';

function loadOrCreateSalt() {
  const envSalt = process.env.SKIES_SALT;
  if (envSalt) {
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('telemetry_salt', envSalt);
    return envSalt;
  }
  const row = db.prepare("SELECT value FROM meta WHERE key = 'telemetry_salt'").get();
  if (row) return row.value;
  const salt = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('telemetry_salt', salt);
  return salt;
}
let SALT = null;
function salt() { if (!SALT) SALT = loadOrCreateSalt(); return SALT; }

function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHash('sha256').update(String(ip) + ':' + salt()).digest('hex');
}

const insertEvent = db.prepare('INSERT INTO events (ts, user_id, guest_id, kind, data, ip_hash) VALUES (?, ?, ?, ?, ?, ?)');

const EVENT_DATA_MAX = 4000; // bytes, not characters -- see Buffer.byteLength below
// Slicing a JSON string at a byte cap can leave invalid/truncated JSON in the column (and if
// JSON.stringify itself throws -- e.g. a BigInt or circular structure -- the whole event used to
// be dropped). This always returns either the original valid JSON or a small, always-valid
// sentinel object, never a mangled partial string. The cap is checked in bytes (Buffer.byteLength),
// not JS string length/UTF-16 code units, since non-ASCII payloads would otherwise slip past a
// 4000-character check while exceeding 4000 bytes.
function safeEventJson(data) {
  if (data === null || data === undefined) return null;
  let s;
  try { s = JSON.stringify(data); } catch { return JSON.stringify({ truncated: true, reason: 'unserializable' }); }
  if (Buffer.byteLength(s, 'utf8') <= EVENT_DATA_MAX) return s;
  return JSON.stringify({ truncated: true, originalByteLength: Buffer.byteLength(s, 'utf8') });
}

/** Record one event. Best-effort: telemetry must never be able to break the request/WS handler
 *  that calls it. */
export function recordEvent({ kind, userId = null, guestId = null, data = null, ip = null } = {}) {
  if (!kind) return;
  try {
    insertEvent.run(
      now(),
      userId || null,
      guestId ? String(guestId).slice(0, 64) : null,
      String(kind).slice(0, 40),
      safeEventJson(data),
      ip ? hashIp(ip) : null,
    );
  } catch { /* never throw from telemetry */ }
}

const CLIENT_KINDS = new Set(['pageview', 'session_start', 'stage_reached', 'run_end', 'error']);

/** Handle a POST /api/telemetry body. Throws a 400-tagged error for an unrecognized kind; the
 *  caller (server/index.js) is expected to have already rate-limited by IP. */
export function recordClient(body, { user, ip } = {}) {
  const kind = body && CLIENT_KINDS.has(body.kind) ? body.kind : null;
  if (!kind) throw Object.assign(new Error('Unknown telemetry kind'), { status: 400 });
  const guestId = !user && typeof body.guestId === 'string' ? body.guestId : null;
  const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : null;
  recordEvent({ kind, userId: user?.id || null, guestId, data, ip });
}

/** Aggregations backing the admin analytics tab. */
export function analytics() {
  const since30 = now() - 30 * 86400;
  const activeKinds = ['pageview', 'session_start'];
  const placeholders = activeKinds.map(() => '?').join(',');
  const dau = db.prepare(
    `SELECT date(ts, 'unixepoch') AS day, COUNT(DISTINCT user_id) AS n FROM events
     WHERE user_id IS NOT NULL AND ts >= ? AND kind IN (${placeholders}) GROUP BY day ORDER BY day`
  ).all(since30, ...activeKinds);
  const guestDau = db.prepare(
    `SELECT date(ts, 'unixepoch') AS day, COUNT(DISTINCT guest_id) AS n FROM events
     WHERE guest_id IS NOT NULL AND ts >= ? AND kind IN (${placeholders}) GROUP BY day ORDER BY day`
  ).all(since30, ...activeKinds);
  const runsPerDay = db.prepare(
    `SELECT date(ended_at, 'unixepoch') AS day, COUNT(*) AS n FROM runs WHERE ended_at >= ? GROUP BY day ORDER BY day`
  ).all(since30);
  const avgRunLength = db.prepare('SELECT AVG(seconds) AS avg FROM runs').get().avg || 0;
  const depthHist = db.prepare(
    `SELECT CAST(stage_reached / 4 AS INTEGER) * 4 AS bucket, COUNT(*) AS n FROM runs GROUP BY bucket ORDER BY bucket`
  ).all();
  const modePickRates = db.prepare('SELECT mode, COUNT(*) AS n FROM runs GROUP BY mode ORDER BY n DESC').all();
  return { dau, guestDau, runsPerDay, avgRunLength, depthHist, modePickRates };
}

let retentionTimer = null;
export function startRetentionJob(days = 90) {
  if (retentionTimer) return retentionTimer;
  const sweep = () => { try { db.prepare('DELETE FROM events WHERE ts < ?').run(now() - days * 86400); } catch {} };
  sweep();
  retentionTimer = setInterval(sweep, 24 * 60 * 60 * 1000);
  retentionTimer.unref?.();
  return retentionTimer;
}
