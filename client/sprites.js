// Every sprite is an 8x8 or 16x16 pixel-pattern drawn in code -- no image assets, 1984-arcade
// style. A pattern is an array of equal-length strings; each character indexes into a palette
// (`.` = transparent). drawPixels() blits one pattern at an integer pixel scale so it stays crisp.
export function drawPixels(ctx, pattern, palette, x, y, scale = 2) {
  for (let row = 0; row < pattern.length; row++) {
    const line = pattern[row];
    for (let col = 0; col < line.length; col++) {
      const ch = line[col];
      if (ch === '.') continue;
      const color = palette[ch];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(x + col * scale), Math.round(y + row * scale), scale, scale);
    }
  }
}
export function patternSize(pattern, scale = 2) {
  return { w: (pattern[0]?.length || 0) * scale, h: pattern.length * scale };
}

// ---- palette (limited, arcade-era) ----
export const PALETTE = {
  hull: '#c9c9c9', hullDark: '#7d7d7d', canopy: '#5ad1ff', prop: '#333333',
  redA: '#e8402c', redB: '#8f1f14', tanA: '#d8b46a', tanB: '#8c6a34',
  bomberA: '#5c6b7a', bomberB: '#33404a', bossA: '#8a3ab5', bossB: '#4a1c66',
  flame: '#ffcc33', shot: '#ffe75a', enemyShot: '#ff5a5a',
  pow: '#ffffff', powBg: '#1c60c9', wave1: '#1c60c9', wave2: '#1547a0', wave3: '#0e3070',
  island: '#4a7c3a', islandDark: '#2f5024', sand: '#d8c17a', cloud: '#f4f8ff', cloudDark: '#c9d6ea',
  carrier: '#4a4f57', carrierDeck: '#8a8f96',
};

// 16x16 P-38-style twin-boom fighter, nose up. `.` transparent, 'h' hull, 'd' hull shadow,
// 'c' canopy, 'p' prop disc.
export const PLAYER_UP = [
  '.......hh.......',
  '......hhhh......',
  '......hcch......',
  '.h....hcch....h.',
  '.hh...hhhh...hh.',
  '.hhh..hddh..hhh.',
  '.hhhh.hddh.hhhh.',
  'hhhhhhhddhhhhhhh',
  '.hh.h.hddh.h.hh.',
  '.hh.hh.dd.hh.hh.',
  '.hh..hhhhhh..hh.',
  '.hh...hhhh...hh.',
  '.pp....dd....pp.',
  '.pp....dd....pp.',
  '........dd......',
  '........dd......',
];
export const PLAYER_BANK_L = PLAYER_UP.map((row) => row.split('').reverse().join(''));
export const PLAYER_BANK_R = PLAYER_UP;

// side-fighter escort: smaller single-prop plane
export const ESCORT = [
  '....hh....',
  '...hchh...',
  '.h..hh..h.',
  'hhh.hh.hhh',
  '.hh.hh.hh.',
  '..h.dd.h..',
  '....dd....',
  '....dd....',
];

// small enemy fighter (Zero-like), red/tan roundel
export const ENEMY_SMALL = [
  '.......h........',
  '......hhh.......',
  '.h....hch....h..',
  '.hh...hhh...hh..',
  '.hhh.hRRh.hhh...',
  'hhhhhhRRhhhhhh..',
  '.hh.h.hh.h.hh...',
  '.hh.hhhhhh.hh...',
  '.hh..hhhh..hh...',
  '......dd........',
  '......dd........',
];

// medium twin-engine bomber
export const ENEMY_MEDIUM = [
  '.......BB.......',
  '......BBBB......',
  '.BB...BccB...BB.',
  'BBBB..BBBB..BBBB',
  'BBBBBBBBBBBBBBBB',
  '.BB.BBbbBB.BB...',
  '.BB..bbbb..BB...',
  '......bb........',
];

// boss bomber (large, multi-turret) drawn at bigger scale by the caller
export const BOSS = [
  '.......OOOO.......',
  '......OOOOOO......',
  '..OO..OOccOO..OO..',
  '.OOOO.OOOOOO.OOOO.',
  'OOOOOOOOOOOOOOOOOO',
  'OOOOOOOoooOOOOOOOO',
  '.OO.OO.ooo.OO.OO..',
  '.OO.OOOOOOOO.OO...',
  '.OO..OO..OO..OO...',
  '......OOOO........',
];

export const POW_ICON = [
  '.pppppp.',
  'p.wwww.p',
  'pw.ww.wp',
  'pw.....p',
  'pw.....p',
  'pw.ww.wp',
  'p.wwww.p',
  '.pppppp.',
];

export function playerPalette() {
  return { h: PALETTE.hull, d: PALETTE.hullDark, c: PALETTE.canopy, p: PALETTE.prop };
}
export function enemySmallPalette() {
  return { h: PALETTE.tanA, d: PALETTE.tanB, c: PALETTE.canopy, R: PALETTE.redA };
}
export function enemyMediumPalette() {
  return { B: PALETTE.bomberA, b: PALETTE.bomberB, c: PALETTE.canopy };
}
export function bossPalette() {
  return { O: PALETTE.bossA, o: PALETTE.bossB, c: PALETTE.canopy };
}
export function powPalette() {
  return { p: PALETTE.pow, w: PALETTE.powBg };
}

// ---- background tiles (16x16), used to build the scrolling ocean/island/cloud layers ----
export function drawWaveTile(ctx, x, y, size, phase) {
  ctx.fillStyle = PALETTE.wave1;
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = PALETTE.wave2;
  const off = Math.sin(phase) * 2;
  ctx.fillRect(x, y + size / 2 + off, size, 2);
  ctx.fillStyle = PALETTE.wave3;
  ctx.fillRect(x, y + size - 2, size, 2);
}
export function drawIslandTile(ctx, x, y, size) {
  ctx.fillStyle = PALETTE.wave1; ctx.fillRect(x, y, size, size);
  ctx.fillStyle = PALETTE.sand;
  ctx.beginPath(); ctx.ellipse(x + size / 2, y + size / 2, size * 0.42, size * 0.34, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = PALETTE.island;
  ctx.beginPath(); ctx.ellipse(x + size / 2, y + size / 2 - 2, size * 0.3, size * 0.22, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = PALETTE.islandDark;
  ctx.fillRect(x + size * 0.4, y + size * 0.4, size * 0.2, size * 0.2);
}
export function drawCarrierTile(ctx, x, y, w, h) {
  ctx.fillStyle = PALETTE.wave1; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = PALETTE.carrier; ctx.fillRect(x + w * 0.1, y, w * 0.8, h);
  ctx.fillStyle = PALETTE.carrierDeck; ctx.fillRect(x + w * 0.15, y + h * 0.1, w * 0.7, h * 0.8);
  ctx.strokeStyle = PALETTE.hullDark; ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.moveTo(x + w * 0.15, y + h * (0.2 + i * 0.2)); ctx.lineTo(x + w * 0.85, y + h * (0.2 + i * 0.2)); ctx.stroke(); }
}
export function drawCloud(ctx, x, y, s) {
  ctx.fillStyle = PALETTE.cloud;
  ctx.beginPath();
  ctx.ellipse(x, y, s, s * 0.6, 0, 0, Math.PI * 2);
  ctx.ellipse(x + s * 0.7, y + s * 0.1, s * 0.7, s * 0.45, 0, 0, Math.PI * 2);
  ctx.ellipse(x - s * 0.7, y + s * 0.15, s * 0.6, s * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();
}
