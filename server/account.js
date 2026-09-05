// Settings-page account operations: password change (keeps the current session, revokes all
// others), account deletion (with cascading cleanup), and a small JSON preferences blob.
import crypto from 'node:crypto';
import { db, now } from './db.js';

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password ?? ''), salt, 32).toString('hex');
}

function passwordMatches(userRow, password) {
  try {
    const candidate = Buffer.from(hashPassword(password, userRow.salt));
    const stored = Buffer.from(userRow.pass_hash);
    return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
  } catch { return false; }
}

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

export function changePassword(userId, currentToken, current, next) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!row) throw httpError(404, 'User not found');
  if (!passwordMatches(row, current)) throw httpError(400, 'Current password is incorrect');
  if (typeof next !== 'string' || next.length < 6) throw httpError(400, 'New password must be at least 6 characters');
  const newSalt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?').run(hashPassword(next, newSalt), newSalt, userId);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(userId, currentToken || '');
  return { ok: true };
}

/** Delete the account and everything that points at it. `events`/`errors` are de-identified
 *  (user_id -> NULL) rather than deleted -- see the sibling project's account.js for the reasoning
 *  (aggregate analytics/error history must not be quietly corrupted by a deleted account). */
export function deleteAccount(userId, password) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!row) throw httpError(404, 'User not found');
  if (!passwordMatches(row, password)) throw httpError(400, 'Password is incorrect');
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM stats WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM achievements WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM runs WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM prefs WHERE user_id = ?').run(userId);
    db.prepare('UPDATE events SET user_id = NULL WHERE user_id = ?').run(userId);
    db.prepare('UPDATE errors SET user_id = NULL WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
  return { ok: true };
}

export function getPrefs(userId) {
  const row = db.prepare('SELECT json FROM prefs WHERE user_id = ?').get(userId);
  if (!row) return {};
  try { return JSON.parse(row.json); } catch { return {}; }
}

const PREF_KEYS = ['soundVolume', 'sfxVolume', 'narrator', 'reducedMotion'];
const PREF_MAX_JSON_BYTES = 8000;

function isVolume(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100; }
function isBool(v) { return typeof v === 'boolean'; }

const PREF_VALIDATORS = { soundVolume: isVolume, sfxVolume: isVolume, narrator: isBool, reducedMotion: isBool };

export function setPrefs(userId, body) {
  const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (Buffer.byteLength(JSON.stringify(src), 'utf8') > PREF_MAX_JSON_BYTES) throw httpError(400, 'Preferences payload is too large');
  const clean = {};
  for (const k of PREF_KEYS) {
    if (!(k in src)) continue;
    const validate = PREF_VALIDATORS[k];
    if (validate && !validate(src[k])) throw httpError(400, `Invalid value for preference "${k}"`);
    clean[k] = src[k];
  }
  const json = JSON.stringify(clean);
  db.prepare(`INSERT INTO prefs (user_id, json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`).run(userId, json, now());
  return clean;
}

export function exportData(userId) {
  const user = db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(userId);
  const stats = Object.fromEntries(db.prepare('SELECT key, value FROM stats WHERE user_id = ?').all(userId).map((r) => [r.key, r.value]));
  const achievements = db.prepare('SELECT ach_id, unlocked_at FROM achievements WHERE user_id = ?').all(userId);
  const runs = db.prepare('SELECT score, stage_reached, kills, seconds, mode, ended_at FROM runs WHERE user_id = ?').all(userId);
  const prefs = getPrefs(userId);
  return { user, stats, achievements, runs, prefs, exportedAt: now() };
}
