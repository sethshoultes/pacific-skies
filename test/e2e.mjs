#!/usr/bin/env node
// Fuller end-to-end pass: two browsers join the SAME room for co-op, the host picks the match
// type, both ready up and fly, one reloads mid-match and resumes its seat, and both see the other's
// kite; plus a check of the dashboard and settings pages. Not a node:test file, run via `npm run e2e`.
//
// Set E2E_BASE_URL to point the whole sweep at an already-running server (e.g. the live site)
// instead of spawning one locally. Set E2E_SHOTS to a directory to save screenshots of the room
// lobby and the co-op match at 390 and 1280 wide (skies-s3-{lobby,coop}-{390,1280}.png).
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { stubAnalytics } from './stub-analytics.mjs';

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

// SIGTERM first, but if the child ignores it (or is wedged) escalate to SIGKILL after a bound so
// this script can never hang forever on a stuck server -- important for CI, which must not stall.
async function stopServer(server, serverExit, timeoutMs = 5000) {
  if (!server) return;
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

const externalBaseUrl = process.env.E2E_BASE_URL ? process.env.E2E_BASE_URL.replace(/\/+$/, '') : null;

async function main() {
  const external = Boolean(externalBaseUrl);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  let dataDir = null;
  let server = null;
  let serverExit = null;
  let serverOutput = '';
  let baseUrl;

  if (external) {
    baseUrl = externalBaseUrl;
  } else {
    dataDir = await mkdtemp(path.join(tmpdir(), 'pacific-skies-e2e-'));
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    log(`starting server on ${baseUrl}`);
    server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'server/index.js'], {
      cwd: root,
      env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (d) => { serverOutput += d.toString(); });
    server.stderr.on('data', (d) => { serverOutput += d.toString(); });
    serverExit = once(server, 'exit');
  }
  const shots = process.env.E2E_SHOTS || null;
  const WIDTHS = [[390, 844], [1280, 800]];
  async function shoot(page, name) {
    if (!shots) return;
    for (const [width, height] of WIDTHS) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(400);
      const file = path.join(shots, `skies-s3-${name}-${width}.png`);
      await page.screenshot({ path: file });
      if (!(await stat(file)).size) throw new Error(`empty screenshot ${file}`);
      log(`saved ${file}`);
    }
  }

  let browserA = null, browserB = null;
  let failed = false;

  try {
    if (external) {
      log(`targeting external server at ${baseUrl} (E2E_BASE_URL set; not starting a local server)`);
      await waitForServer(baseUrl);
    } else {
      await Promise.race([
        waitForServer(baseUrl),
        serverExit.then(([code]) => { throw new Error(`server exited early (code ${code}):\n${serverOutput}`); }),
      ]);
    }
    log('server is listening');

    const launch = () => chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--mute-audio'] });
    browserA = stubAnalytics(await launch());
    browserB = stubAnalytics(await launch());
    const muted = (ctx) => ctx.addInitScript(() => { try { localStorage.setItem('stormglass.mute', '1'); } catch {} });
    const ctxA = await browserA.newContext({ viewport: { width: 1280, height: 800 } });
    const ctxB = await browserB.newContext({ viewport: { width: 1280, height: 800 } });
    await muted(ctxA); await muted(ctxB);
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    const pageErrors = [];
    for (const p of [pageA, pageB]) p.on('pageerror', (err) => pageErrors.push(String(err && err.stack || err)));
    const shown = (page, id) => page.waitForSelector(`#${id}:not([hidden])`, { timeout: 15_000 });
    const flying = (page) => page.waitForSelector('body[data-screen="playing"]', { timeout: 30_000 });

    log('player A creates a room');
    await pageA.goto(baseUrl + '/', { waitUntil: 'load' });
    await pageA.fill('#callsign', 'Tinder');
    await pageA.click('#create');
    await shown(pageA, 'room');
    const roomId = (await pageA.textContent('#rs-id')).trim();
    log(`room code: ${roomId}`);

    log('player B joins by code');
    await pageB.goto(baseUrl + '/', { waitUntil: 'load' });
    await pageB.fill('#callsign', 'Quill');
    await pageB.fill('#code', roomId);
    await pageB.click('#join');
    await shown(pageB, 'room');
    await pageA.waitForFunction(() => document.querySelectorAll('#rs-roster li').length === 2, null, { timeout: 10_000 });

    log('the host picks the match type; the guest sees it and cannot change it');
    await pageA.selectOption('#rs-type', 'race');
    await pageB.waitForFunction(() => document.querySelector('#rs-type').value === 'race', null, { timeout: 10_000 });
    if (!(await pageB.isDisabled('#rs-type'))) throw new Error('the guest can change the match type');
    await pageA.selectOption('#rs-type', 'coop');
    await pageB.waitForFunction(() => document.querySelector('#rs-type').value === 'coop', null, { timeout: 10_000 });
    await shoot(pageA, 'lobby');

    log('both players ready up, the countdown starts the match');
    await pageB.click('#rs-ready');
    await pageA.click('#rs-ready');
    await Promise.all([flying(pageA), flying(pageB)]);
    log('both players are flying -- co-op confirmed');
    await pageA.keyboard.down('Space');
    await pageB.keyboard.down('Space');
    await pageB.keyboard.down('a');
    await pageA.waitForTimeout(1500);

    log('player B reloads mid-match -- must resume the same seat');
    await pageB.goto(`${baseUrl}/?room=${roomId}`, { waitUntil: 'load' });
    await flying(pageB);
    await pageB.keyboard.down('Space');
    await pageB.waitForTimeout(1500);
    log('player B resumed the live match via the stored resume token');

    await shoot(pageA, 'coop');
    await pageA.keyboard.up('Space');

    if (pageErrors.length) throw new Error(`page errors:\n${pageErrors.join('\n')}`);

    log('checking dashboard and settings pages');
    await pageA.goto(baseUrl + '/dashboard.html', { waitUntil: 'load' });
    await pageA.waitForSelector('.panel', { timeout: 10_000 });
    await pageA.goto(baseUrl + '/settings.html', { waitUntil: 'load' });
    await pageA.waitForSelector('#s-master', { timeout: 10_000 });

    log('E2E PASS: co-op create/join/type/ready, resume mid-match, dashboard/settings all OK');
  } catch (err) {
    failed = true;
    console.error('[e2e] FAILED:', err && err.stack || err);
    if (serverOutput) console.error('[e2e] server output:\n' + serverOutput);
  } finally {
    if (browserA) await browserA.close().catch(() => {});
    if (browserB) await browserB.close().catch(() => {});
    if (server) await stopServer(server, serverExit);
    if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }

  process.exit(failed ? 1 : 0);
}

main();
