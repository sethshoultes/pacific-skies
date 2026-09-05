#!/usr/bin/env node
// Fuller end-to-end pass: two browsers join the SAME room for co-op, force a stage clear via the
// SKIES_DEBUG=1 debug hook (a lightweight helper WebSocket, not one of the two player slots),
// see the tally screen and the next stage begin -- plus a check of the dashboard and settings
// pages. Not a node:test file, run via `npm run e2e`.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import WebSocket from 'ws';

function log(msg) { console.log(`[e2e] ${msg}`); }

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
    const attempt = () => { fetch(url).then(resolve).catch((err) => { if (Date.now() > deadline) return reject(err); setTimeout(attempt, 200); }); };
    attempt();
  });
}

async function main() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'pacific-skies-e2e-'));
  const port = await findFreePort();
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const baseUrl = `http://127.0.0.1:${port}`;

  log(`starting server on ${baseUrl} (SKIES_DEBUG=1)`);
  const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, SKIES_DEBUG: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  server.stdout.on('data', (d) => { serverOutput += d.toString(); });
  server.stderr.on('data', (d) => { serverOutput += d.toString(); });
  const serverExit = once(server, 'exit');
  let browserA = null, browserB = null, helperWs = null;
  let failed = false;

  try {
    await Promise.race([
      waitForServer(baseUrl),
      serverExit.then(([code]) => { throw new Error(`server exited early (code ${code}):\n${serverOutput}`); }),
    ]);
    log('server is listening');

    browserA = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
    browserB = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
    const pageA = await browserA.newPage();
    const pageB = await browserB.newPage();
    const pageErrors = [];
    for (const p of [pageA, pageB]) p.on('pageerror', (err) => pageErrors.push(String(err && err.stack || err)));

    log('player A creates a room');
    await pageA.goto(baseUrl + '/', { waitUntil: 'load' });
    await pageA.fill('#gname', 'PilotA');
    await pageA.click('#create');
    await pageA.waitForSelector('#roomscreen.on', { timeout: 15_000 });
    const roomId = await pageA.textContent('#rs-id').then((t) => t.replace('#', '').trim());
    log(`room id: ${roomId}`);

    log('player B joins via the invite link');
    // The invite-link auto-join (?room=ID) fires immediately on page load using whatever name is
    // already in #gname (empty -> "Guest"), so there is no window to fill the name field first.
    await pageB.goto(`${baseUrl}/?room=${roomId}`, { waitUntil: 'load' });
    await pageB.waitForSelector('#roomscreen.on', { timeout: 15_000 });

    log('both players ready up, host starts');
    await pageB.click('#rs-ready');
    await pageA.click('#rs-ready');
    await pageA.click('#rs-start').catch(() => {});
    await pageA.waitForSelector('#game.on', { timeout: 15_000 });
    await pageB.waitForSelector('#game.on', { timeout: 15_000 });
    log('both players are in the live game -- co-op confirmed');

    const stageBefore = await pageA.textContent('#hud-stage');
    log(`stage before forced clear: ${stageBefore}`);

    log('attaching a helper socket to force a stage clear via the debug hook');
    helperWs = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await once(helperWs, 'open');
    helperWs.send(JSON.stringify({ t: 'debug', roomId, action: 'clear-stage' }));

    log('waiting for the stage-clear tally overlay');
    await pageA.waitForFunction(() => {
      const el = document.querySelector('#game .overlay h2');
      return el && /STAGE .* CLEAR/.test(el.textContent);
    }, { timeout: 10_000 });
    await pageB.waitForFunction(() => {
      const el = document.querySelector('#game .overlay h2');
      return el && /STAGE .* CLEAR/.test(el.textContent);
    }, { timeout: 10_000 });
    log('tally screen confirmed on both browsers');

    log('waiting for the next stage to begin');
    await pageA.waitForFunction((before) => document.querySelector('#hud-stage')?.textContent !== before, stageBefore, { timeout: 15_000 });
    const stageAfter = await pageA.textContent('#hud-stage');
    if (Number(stageAfter) !== Number(stageBefore) - 1) throw new Error(`expected stage ${Number(stageBefore) - 1}, got ${stageAfter}`);
    log(`advanced to stage ${stageAfter}`);

    if (pageErrors.length) throw new Error(`page errors:\n${pageErrors.join('\n')}`);

    log('checking dashboard and settings pages');
    await pageA.goto(baseUrl + '/dashboard.html', { waitUntil: 'load' });
    await pageA.waitForSelector('.panel', { timeout: 10_000 });
    await pageA.goto(baseUrl + '/settings.html', { waitUntil: 'load' });
    await pageA.waitForSelector('#s-master', { timeout: 10_000 });

    log('E2E PASS: co-op join/ready/start, forced stage clear + tally + stage advance, dashboard/settings all OK');
  } catch (err) {
    failed = true;
    console.error('[e2e] FAILED:', err && err.stack || err);
    if (serverOutput) console.error('[e2e] server output:\n' + serverOutput);
  } finally {
    if (helperWs) try { helperWs.close(); } catch {}
    if (browserA) await browserA.close().catch(() => {});
    if (browserB) await browserB.close().catch(() => {});
    if (server.exitCode === null && server.pid) { try { process.kill(server.pid, 'SIGTERM'); } catch {} }
    await serverExit.catch(() => {});
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }

  process.exit(failed ? 1 : 0);
}

main();
