import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';

test('static server rejects path traversal attempts', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const attempts = [
    '/../server/db.js',
    '/..%2f..%2fserver/db.js',
    '/shared/../../server/index.js',
    '/shared/..%2f..%2fserver%2findex.js',
  ];
  for (const path of attempts) {
    const res = await fetch(server.baseUrl + path);
    assert.ok(res.status === 403 || res.status === 404, `${path} -> expected 403/404, got ${res.status}`);
  }
});

test('static server rejects NUL bytes in the path', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const res = await fetch(server.baseUrl + '/index.html%00.js');
  assert.ok(res.status === 400 || res.status === 404);
});

test('static server serves the client and shared directories', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const index = await fetch(server.baseUrl + '/');
  assert.equal(index.status, 200);
  const shared = await fetch(server.baseUrl + '/shared/constants.js');
  assert.equal(shared.status, 200);
});

test('POST body over the size cap is rejected', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const huge = 'x'.repeat(300 * 1024);
  // The server destroys the connection once the body exceeds its cap (see readBody in
  // server/index.js), so the client either sees a non-200 response or the request itself
  // aborts -- both are the expected "rejected" outcome, never a successful 200.
  try {
    const res = await fetch(server.baseUrl + '/api/telemetry', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'pageview', data: { huge } }),
    });
    assert.notEqual(res.status, 200);
  } catch (e) {
    assert.ok(e, 'connection aborted, as expected for an oversized body');
  }
});
