// Shared renderer: draws the scrolling ocean/island/cloud background and every entity from a
// snapshot-shaped object. Used both by the live game (real server snapshots) and the title
// screen's attract-mode demo flight (a locally scripted fake "snapshot"), so both look identical.
import {
  drawPixels, patternSize, PLAYER_UP, ESCORT, ENEMY_SMALL, ENEMY_MEDIUM, BOSS, POW_ICON,
  playerPalette, enemySmallPalette, enemyMediumPalette, bossPalette, powPalette,
  drawWaveTile, drawIslandTile, drawCarrierTile, drawCloud, PALETTE,
} from './sprites.js';
import { WORLD_W, WORLD_H } from '../shared/constants.js';

const TILE = 32;

export function createOcean(seed = 1) {
  // A tall deterministic strip of tile kinds (wave/island/carrier) the background layer scrolls
  // through, tall enough to loop seamlessly for a long demo/run.
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const cols = Math.ceil(WORLD_W / TILE);
  const rows = 60;
  const tiles = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      let kind = 'wave';
      if (rand() < 0.02) kind = 'island';
      row.push(kind);
    }
    tiles.push(row);
  }
  return { tiles, cols, rows };
}

export function drawBackground(ctx, ocean, scrollY, time) {
  ctx.clearRect(0, 0, WORLD_W, WORLD_H);
  const startRow = Math.floor(scrollY / TILE) % ocean.rows;
  const offsetY = -(scrollY % TILE);
  for (let r = -1; r * TILE + offsetY < WORLD_H; r++) {
    const rowIdx = ((startRow + r) % ocean.rows + ocean.rows) % ocean.rows;
    const row = ocean.tiles[rowIdx];
    for (let c = 0; c < ocean.cols; c++) {
      const x = c * TILE, y = r * TILE + offsetY;
      if (row[c] === 'island') drawIslandTile(ctx, x, y, TILE);
      else drawWaveTile(ctx, x, y, TILE, time * 2 + r * 0.6 + c * 0.3);
    }
  }
  // cloud parallax layer (drifts slower than the wave scroll, purely decorative)
  for (let i = 0; i < 5; i++) {
    const cx = ((i * 97 + time * 8) % (WORLD_W + 120)) - 60;
    const cy = (i * 130 + scrollY * 0.4) % (WORLD_H + 100) - 50;
    ctx.globalAlpha = 0.5;
    drawCloud(ctx, cx, cy, 26);
    ctx.globalAlpha = 1;
  }
}

export function drawCarrierDeck(ctx, scrollY, time) {
  drawCarrierTile(ctx, WORLD_W / 2 - 60, WORLD_H - 140 - (scrollY % 40), 120, 220);
}

function drawPlane(ctx, x, y, scale = 2) {
  const size = patternSize(PLAYER_UP, scale);
  drawPixels(ctx, PLAYER_UP, playerPalette(), x - size.w / 2, y - size.h / 2, scale);
}
function drawEscort(ctx, x, y, scale = 1.6) {
  const size = patternSize(ESCORT, scale);
  drawPixels(ctx, ESCORT, playerPalette(), x - size.w / 2, y - size.h / 2, scale);
}
function drawEnemySmall(ctx, x, y, scale = 2) {
  const size = patternSize(ENEMY_SMALL, scale);
  drawPixels(ctx, ENEMY_SMALL, enemySmallPalette(), x - size.w / 2, y - size.h / 2, scale);
}
function drawEnemyMedium(ctx, x, y, scale = 2.1) {
  const size = patternSize(ENEMY_MEDIUM, scale);
  drawPixels(ctx, ENEMY_MEDIUM, enemyMediumPalette(), x - size.w / 2, y - size.h / 2, scale);
}
function drawBoss(ctx, x, y, scale) {
  const size = patternSize(BOSS, scale);
  drawPixels(ctx, BOSS, bossPalette(), x - size.w / 2, y - size.h / 2, scale);
}
function drawPow(ctx, x, y) {
  const size = patternSize(POW_ICON, 2.2);
  drawPixels(ctx, POW_ICON, powPalette(), x - size.w / 2, y - size.h / 2, 2.2);
}

export function drawEntities(ctx, snap, blinkPlayers = new Set()) {
  for (const it of snap.powItems || []) drawPow(ctx, it.x, it.y);
  for (const b of snap.bullets || []) { ctx.fillStyle = PALETTE.shot; ctx.fillRect(b.x - 2, b.y - 5, 4, 8); }
  for (const b of snap.enemyBullets || []) { ctx.fillStyle = PALETTE.enemyShot; ctx.beginPath(); ctx.arc(b.x, b.y, 3.5, 0, Math.PI * 2); ctx.fill(); }
  for (const e of snap.enemies || []) {
    if (e.type === 'boss') { drawBoss(ctx, e.x, e.y, 2.4); drawHealthBar(ctx, e.x, e.y - 44, e.hp, e.maxHp, 60); }
    else if (e.type === 'midboss') { drawEnemyMedium(ctx, e.x, e.y, 2.8); drawHealthBar(ctx, e.x, e.y - 32, e.hp, e.maxHp, 40); }
    else if (e.type === 'medium') drawEnemyMedium(ctx, e.x, e.y);
    else drawEnemySmall(ctx, e.x, e.y);
  }
  for (const p of snap.players || []) {
    if (!p.alive) continue;
    if (blinkPlayers.has(p.pid) && Math.floor(performance.now() / 100) % 2 === 0) continue;
    if (p.side) { drawEscort(ctx, p.x - 20, p.y + 6); drawEscort(ctx, p.x + 20, p.y + 6); }
    ctx.save();
    if (p.looping) ctx.globalAlpha = 0.55;
    drawPlane(ctx, p.x, p.y);
    ctx.restore();
    if (p.invuln && !p.looping) {
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.beginPath(); ctx.arc(p.x, p.y, 14, 0, Math.PI * 2); ctx.stroke();
    }
  }
}

/** Client-side explosion effects. Each entry is { x, y, size, t0 } (t0 in ms from performance.now());
 *  an expanding flash ring plus pixel debris flung outward, all over about 450ms. Pure eye candy --
 *  the authoritative sim doesn't know about them -- so they are derived by the client from entities
 *  that vanished between two snapshots (see client/game.js). Returns the list minus finished ones. */
export function drawExplosions(ctx, explosions, now) {
  const DUR = 450;
  const live = [];
  for (const ex of explosions) {
    const k = (now - ex.t0) / DUR;
    if (k >= 1) continue;
    live.push(ex);
    const r = ex.size * (0.4 + k * 1.4);
    ctx.save();
    ctx.globalAlpha = 1 - k;
    ctx.fillStyle = k < 0.35 ? '#ffffff' : PALETTE.flame;
    ctx.beginPath(); ctx.arc(ex.x, ex.y, r * 0.55, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = PALETTE.enemyShot; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(ex.x, ex.y, r, 0, Math.PI * 2); ctx.stroke();
    // debris: deterministic per explosion so it doesn't jitter frame to frame
    ctx.fillStyle = k < 0.5 ? PALETTE.flame : PALETTE.hullDark;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + ex.x * 0.01;
      const d = r * (1.1 + ((i * 7) % 3) * 0.25);
      ctx.fillRect(Math.round(ex.x + Math.cos(a) * d) - 1, Math.round(ex.y + Math.sin(a) * d) - 1, 3, 3);
    }
    ctx.restore();
  }
  return live;
}

function drawHealthBar(ctx, x, y, hp, maxHp, w) {
  ctx.fillStyle = '#222'; ctx.fillRect(x - w / 2, y, w, 4);
  ctx.fillStyle = PALETTE.redA; ctx.fillRect(x - w / 2, y, w * Math.max(0, hp / maxHp), 4);
}
