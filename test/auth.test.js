import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Always a fresh temp dir -- falling back to an existing DATA_DIR could share a SQLite DB with
// another test file's run and make assertions order-dependent/flaky.
const dataDir = mkdtempSync(path.join(tmpdir(), 'skies-auth-test-'));
process.env.DATA_DIR = dataDir;
const auth = await import('../server/auth.js');
const { db } = await import('../server/db.js');

after(async () => {
  try { db.close(); } catch {}
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

test('login fails cleanly (not a crash) if the stored password hash is a different length', () => {
  auth.register('len_mismatch_usr', 'correcthorse');
  // Simulate a corrupted/unexpected stored hash -- timingSafeEqual throws on a length mismatch,
  // so login() must guard the length itself rather than letting that throw become a 500.
  db.prepare('UPDATE users SET pass_hash = ? WHERE username = ?').run('deadbeef', 'len_mismatch_usr');
  assert.throws(
    () => auth.login('len_mismatch_usr', 'correcthorse'),
    /Unknown user or wrong password/,
    'a length-mismatched stored hash must fail login cleanly, not throw a crypto error',
  );
});
