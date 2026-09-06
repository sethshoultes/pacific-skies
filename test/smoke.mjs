#!/usr/bin/env node
// End-to-end smoke test: boots the real server, drives a real browser (Playwright/Chromium)
// through the title screen -> quick play -> a few seconds of live flight -- and checks the
// static pages and stage-data validation are clean. Not a node:test file, run via `npm run smoke`.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

function log(msg) { console.log(`[smoke] ${msg}`); }

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function waitForServer(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      fetch(url).then(resolve).catch((err) => { if (Date.now() > deadline) return reject(err); setTimeout(attempt, 200); });
    };
    attempt();
  });
}

// SIGTERM first, but if the child ignores it (or is wedged) escalate to SIGKILL after a bound so
// this script can never hang forever on a stuck server -- important for CI, which must not stall.
async function stopServer(server, serverExit, timeoutMs = 5000) {
  if (server.exitCode !== null || !server.pid) { await serverExit.catch(() => {}); return; }
  try { process.kill(server.pid, 'SIGTERM'); } catch { return; }
  const exited = await Promise.race([
    serverExit.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
  if (!exited && server.exitCode === null && server.pid) {
    try { process.kill(server.pid, 'SIGKILL'); } catch {}
    await serverExit.catch(() => {});
  }
}

async function main() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'pacific-skies-smoke-'));
  const port = await findFreePort();
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const baseUrl = `http://127.0.0.1:${port}`;

  log(`starting server on ${baseUrl} (DATA_DIR=${dataDir})`);
  const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  server.stdout.on('data', (d) => { serverOutput += d.toString(); });
  server.stderr.on('data', (d) => { serverOutput += d.toString(); });
  const serverExit = once(server, 'exit');
  let browser = null;
  let failed = false;

  try {
    await Promise.race([
      waitForServer(baseUrl),
      serverExit.then(([code]) => { throw new Error(`server exited early (code ${code}):\n${serverOutput}`); }),
    ]);
    log('server is listening');

    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
    const page = await browser.newPage();

    const pageErrors = [];
    const consoleErrors = [];
    const failedRequests = [];
    page.on('pageerror', (err) => pageErrors.push(String(err && err.stack || err)));
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('requestfailed', (req) => {
      const errorText = req.failure()?.errorText || 'failed';
      if (errorText === 'net::ERR_ABORTED') return;
      failedRequests.push(`${req.method()} ${req.url()} -> ${errorText}`);
    });
    page.on('response', (res) => { if (res.status() >= 500) failedRequests.push(`${res.request().method()} ${res.url()} -> HTTP ${res.status()}`); });

    for (const p of ['/', '/dashboard.html', '/settings.html']) {
      log(`loading ${p}`);
      const res = await page.goto(baseUrl + p, { waitUntil: 'load', timeout: 15_000 });
      if (!res || !res.ok()) throw new Error(`GET ${p} -> ${res ? res.status() : 'no response'}`);
    }

    await page.goto(baseUrl + '/', { waitUntil: 'load', timeout: 15_000 });
    log('title screen loaded, starting quick play');
    await page.fill('#gname', 'SmokeTest');
    await page.click('#quick');
    log('waiting for the pre-game room screen');
    await page.waitForSelector('#roomscreen.on', { timeout: 15_000 });
    log('solo host -- clicking Start');
    await page.click('#rs-start');
    await page.waitForSelector('#game.on', { timeout: 15_000 });
    log('in flight, holding "d" and Space for 3s');
    await page.keyboard.down('d');
    await page.keyboard.down('Space');
    await page.waitForTimeout(3000);
    await page.keyboard.up('d');
    await page.keyboard.up('Space');

    if (pageErrors.length) throw new Error(`page errors:\n${pageErrors.join('\n')}`);
    if (consoleErrors.length) throw new Error(`console errors:\n${consoleErrors.join('\n')}`);
    if (failedRequests.length) throw new Error(`failed requests:\n${failedRequests.join('\n')}`);
    log('browser session clean: no page errors, console errors, or failed requests');

    log('checking GET /api/health');
    const health = await fetch(baseUrl + '/api/health').then((r) => r.json());
    if (!health.ok) throw new Error('health check failed');

    log('SMOKE PASS: static pages, quick play, and 3s of live flight all OK');
  } catch (err) {
    failed = true;
    console.error('[smoke] FAILED:', err && err.stack || err);
    if (serverOutput) console.error('[smoke] server output:\n' + serverOutput);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopServer(server, serverExit);
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }

  process.exit(failed ? 1 : 0);
}

main();
