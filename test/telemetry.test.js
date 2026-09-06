import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = process.env.DATA_DIR || mkdtempSync(path.join(tmpdir(), 'skies-telemetry-test-'));
const telemetry = await import('../server/telemetry.js');
const { db } = await import('../server/db.js');

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
