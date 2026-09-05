import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';

test('register, login, and stats/achievements roundtrip through the REST API', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const reg = await fetch(server.baseUrl + '/api/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'ace_pilot', password: 'secretpass' }),
  });
  assert.equal(reg.status, 200);
  const { token } = await reg.json();
  assert.ok(token);

  const me1 = await fetch(server.baseUrl + '/api/me', { headers: { Authorization: 'Bearer ' + token } }).then((r) => r.json());
  assert.equal(me1.user.username, 'ace_pilot');
  assert.deepEqual(me1.stats, {});

  const login = await fetch(server.baseUrl + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'ace_pilot', password: 'secretpass' }),
  }).then((r) => r.json());
  assert.ok(login.token);

  const badLogin = await fetch(server.baseUrl + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'ace_pilot', password: 'wrong' }),
  });
  assert.equal(badLogin.status, 400);
  const badBody = await badLogin.json();
  assert.ok(badBody.error);
});

test('health endpoint reports ok', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const res = await fetch(server.baseUrl + '/api/health').then((r) => r.json());
  assert.equal(res.ok, true);
  assert.equal(typeof res.uptime, 'number');
});

test('rate limiting kicks in on rapid registration attempts', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  let sawLimit = false;
  for (let i = 0; i < 15; i++) {
    const res = await fetch(server.baseUrl + '/api/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'user' + i, password: 'password1' }),
    });
    if (res.status === 429) sawLimit = true;
  }
  assert.equal(sawLimit, true);
});
