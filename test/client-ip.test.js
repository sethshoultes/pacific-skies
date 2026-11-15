// Who a request is, for the caps: only a header set by a hop we can trust is believed (pacific-skies#8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIp } from '../server/client-ip.js';

const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });
const trusted = { trustProxy: true };
const EDGE = '172.70.1.2'; // inside Cloudflare's 172.64.0.0/13

test('through Cloudflare and nginx: the player is CF-Connecting-IP', () => {
  const r = req('127.0.0.1', { 'x-real-ip': EDGE, 'x-forwarded-for': `203.0.113.7, ${EDGE}`, 'cf-connecting-ip': '203.0.113.7' });
  assert.equal(clientIp(r, trusted), '203.0.113.7');
});

test('IPv6 Cloudflare edge is recognised', () => {
  const r = req('::1', { 'x-real-ip': '2606:4700::1', 'cf-connecting-ip': '2001:db8::9' });
  assert.equal(clientIp(r, trusted), '2001:db8::9');
});

test('straight to the origin: a forged CF-Connecting-IP or X-Forwarded-For is ignored', () => {
  const r = req('127.0.0.1', { 'x-real-ip': '198.51.100.4', 'x-forwarded-for': `9.9.9.9, 198.51.100.4`, 'cf-connecting-ip': '9.9.9.9' });
  assert.equal(clientIp(r, trusted), '198.51.100.4');
});

test('a peer that is not nginx is never believed', () => {
  const r = req('198.51.100.4', { 'x-real-ip': EDGE, 'cf-connecting-ip': '9.9.9.9' });
  assert.equal(clientIp(r, trusted), '198.51.100.4');
});

test('without TRUST_PROXY the socket address is used', () => {
  const r = req('127.0.0.1', { 'x-real-ip': EDGE, 'cf-connecting-ip': '203.0.113.7' });
  assert.equal(clientIp(r, { trustProxy: false }), '127.0.0.1');
});

test('junk headers fall back safely', () => {
  assert.equal(clientIp(req('127.0.0.1', { 'x-real-ip': 'nope' }), trusted), '127.0.0.1');
  assert.equal(clientIp(req('127.0.0.1', { 'x-real-ip': EDGE, 'cf-connecting-ip': 'nope' }), trusted), EDGE);
});
