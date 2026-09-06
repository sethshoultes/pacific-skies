import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Always a fresh temp dir -- falling back to an existing DATA_DIR could share a SQLite DB with
// another test file's run and make assertions order-dependent/flaky.
const dataDir = mkdtempSync(path.join(tmpdir(), 'skies-telemetry-test-'));
process.env.DATA_DIR = dataDir;
const telemetry = await import('../server/telemetry.js');
const { db } = await import('../server/db.js');

// Belt-and-suspenders cleanup: `after` handles the normal exit path, `process.on('exit')` covers
// a crash/early-exit that skips node:test's hooks. Both are guarded by an explicit assertion that
// the path is really the one mkdtempSync just created under os.tmpdir() -- never anything else --
// before ever calling an rm with recursive:true.
function cleanupDataDir() {
  if (!dataDir.startsWith(tmpdir())) return; // never rm a path we didn't just create ourselves
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanupDataDir);
after(async () => {
  try { db.close(); } catch {}
  if (dataDir.startsWith(tmpdir())) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

function lastEvent() {
  return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1').get();
}

test('recordEvent stores valid, parseable JSON for a normal payload', () => {
  telemetry.recordEvent({ kind: 'test_kind', data: { a: 1, b: 'two' } });
  const row = lastEvent();
  assert.equal(row.kind, 'test_kind');
  assert.deepEqual(JSON.parse(row.data), { a: 1, b: 'two' });
});

test('recordEvent never stores truncated/invalid JSON for an oversized payload', () => {
  const huge = { blob: 'x'.repeat(10_000) };
  telemetry.recordEvent({ kind: 'oversized', data: huge });
  const row = lastEvent();
  assert.equal(row.kind, 'oversized');
  // Must still be valid JSON -- a naive string.slice() truncation would break this.
  const parsed = JSON.parse(row.data);
  assert.equal(parsed.truncated, true);
});

test('recordEvent never throws even if the data cannot be JSON-serialized', () => {
  const circular = {};
  circular.self = circular;
  assert.doesNotThrow(() => telemetry.recordEvent({ kind: 'circular', data: circular }));
  const row = lastEvent();
  assert.equal(row.kind, 'circular');
  assert.doesNotThrow(() => JSON.parse(row.data));
});

test('the oversized-payload cap is measured in bytes, not UTF-16 characters', () => {
  // Each of these multi-byte characters is 1 JS string character but 3 UTF-8 bytes, so ~2000 of
  // them is under the 4000-*character* mark but well over the 4000-*byte* mark -- this must still
  // be caught as oversized.
  const multiByte = { blob: '☃'.repeat(2000) };
  const jsonLength = JSON.stringify(multiByte).length;
  assert.ok(jsonLength < 4000, 'sanity check: character length must stay under 4000 for this test to be meaningful');
  telemetry.recordEvent({ kind: 'multibyte_oversized', data: multiByte });
  const row = lastEvent();
  assert.equal(row.kind, 'multibyte_oversized');
  const parsed = JSON.parse(row.data);
  assert.equal(parsed.truncated, true, 'a byte-oversized, character-undersized payload must still be flagged as truncated');
});
