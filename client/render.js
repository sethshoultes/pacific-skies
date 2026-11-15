// The Stormglass renderer: draws a frame from match state and nothing else. It never advances the
// match and draws no random numbers: every cloud, raindrop and bolt comes from a hash of the tick,
// so the same state always paints the same picture.
import { WORLD_W, WORLD_H, DASH_COOLDOWN_TICKS } from '../shared/engine/rules.js';
import { KITES, LOOKS, lookOf, PICKUP_GLYPH } from './lore.js';

const TAU = Math.PI * 2;
const HUD_H = 34; // reserved above the sky window on a tall screen
const C = {
  ink: '#f6ecd9', dim: 'rgba(246,236,217,0.62)', spark: '#cfe9ff', shot: '#ffd27a',
  kites: [['#ff8a5c', '#ffe2b8'], ['#5fd3c4', '#d9fff6']],
  fizzlet: '#ffe066', arcwisp: '#c08cff', shearling: '#7fe3ff', thunder: '#4a4566', boss: '#2e2943',
};

/** Fit the world into a w x h canvas: the biggest whole-world box, centred, below the HUD strip. */
export function layout(w, h) {
  const top = h - WORLD_H * Math.min(w / WORLD_W, h / WORLD_H) >= HUD_H * 2 ? HUD_H : 0;
  const scale = Math.min(w / WORLD_W, (h - top) / WORLD_H);
  return { scale, ox: (w - WORLD_W * scale) / 2, oy: top + (h - top - WORLD_H * scale) / 2 };
}

// a stable pseudo-random number in [0, 1) for an integer
function hash(n) {
  let x = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

// ---------------- the sky ----------------

function blob(ctx, x, y, r, puffs, seed, fill) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  for (let i = 0; i < puffs; i++) {
    const a = hash(seed * 31 + i) * TAU;
    const d = r * 0.6 * hash(seed * 17 + i);
    ctx.moveTo(x + Math.cos(a) * d + r * 0.7, y + Math.sin(a) * d * 0.5);
    ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.5, r * (0.45 + 0.35 * hash(seed * 7 + i)), 0, TAU);
  }
  ctx.fill();
}

function tower(ctx, x, base, w, hgt, lit) {
  ctx.fillStyle = '#2a2b4d';
  ctx.beginPath();
  ctx.moveTo(x - w / 2, base); ctx.lineTo(x - w * 0.18, base - hgt); ctx.lineTo(x + w * 0.18, base - hgt); ctx.lineTo(x + w / 2, base);
  ctx.fill();
  ctx.fillStyle = `rgba(150,220,255,${0.25 + lit * 0.5})`; // the glass that holds a storm
  for (let k = 1; k < 6; k++) ctx.fillRect(x - w * 0.08, base - hgt * (k / 6), w * 0.16, hgt * 0.05);
  ctx.beginPath(); ctx.arc(x, base - hgt - 6, 5 + lit * 3, 0, TAU); ctx.fill();
}

function bolt(ctx, x, y0, y1, seed) {
  ctx.strokeStyle = 'rgba(235,245,255,0.9)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, y0);
  for (let y = y0, i = 0; y < y1; i++) { y += 18 + 20 * hash(seed + i); ctx.lineTo(x + (hash(seed * 3 + i) - 0.5) * 40, y); }
  ctx.stroke();
}

/** The painterly backdrop over the whole canvas: gradient, towers, three cloud banks, rain, lightning. */
export function drawSky(ctx, w, h, tick) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#171a36'); g.addColorStop(0.4, '#353a6b'); g.addColorStop(0.72, '#7a6f98'); g.addColorStop(1, '#e0a57c');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);

  const era = Math.floor(tick / 75);
  const flash = hash(era) < 0.45 ? Math.max(0, 1 - (tick % 75) / 9) : 0;

  const n = Math.ceil(w / 160) + 1;
  for (let i = 0; i < n; i++) {
    const x = ((i * 160 + hash(i) * 90 - tick * 0.15) % (n * 160) + n * 160) % (n * 160) - 60;
    tower(ctx, x, h, 46 + hash(i + 9) * 30, h * (0.35 + hash(i + 3) * 0.3), flash * hash(era + i));
  }
  if (flash > 0.3) bolt(ctx, w * hash(era * 5), 0, h * 0.55, era);

  const banks = [[0.25, 70, 'rgba(70,74,120,0.55)'], [0.6, 52, 'rgba(120,112,160,0.45)'], [1.1, 38, 'rgba(232,214,230,0.30)']];
  banks.forEach(([speed, r, fill], layer) => {
    const span = h + r * 4;
    for (let i = 0; i < 9; i++) {
      const id = layer * 100 + i;
      const y = ((hash(id) * span + tick * speed) % span) - r * 2;
      blob(ctx, hash(id + 50) * w, y, r * (0.8 + hash(id + 7) * 0.6), 6, id, fill);
    }
  });

  ctx.strokeStyle = 'rgba(200,215,255,0.22)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < 70; i++) {
    const x = (hash(i + 700) * (w + 80) - tick * 1.5 + w * 4) % (w + 80);
    const y = (hash(i + 900) * (h + 40) + tick * 9) % (h + 40) - 20;
    ctx.moveTo(x, y); ctx.lineTo(x - 4, y + 14);
  }
  ctx.stroke();
  if (flash) { ctx.fillStyle = `rgba(230,240,255,${flash * 0.28})`; ctx.fillRect(0, 0, w, h); }
}

// ---------------- the field ----------------

function kite(ctx, p, tick) {
  const [body, trim] = C.kites[p.seat % 2];
  const blink = p.invuln > 0 && Math.floor(tick / 3) % 2 === 0;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.scale(1.3, 1.3);
  ctx.globalAlpha = blink ? 0.35 : 1;
  ctx.strokeStyle = trim; ctx.lineWidth = 1.5; // the tail of bows
  ctx.beginPath(); ctx.moveTo(0, 12);
  for (let k = 1; k <= 4; k++) ctx.lineTo(Math.sin(tick * 0.3 + k) * 4, 12 + k * 6);
  ctx.stroke();
  if (p.dashTicks > 0) { ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.beginPath(); ctx.ellipse(0, 0, 18, 14, 0, 0, TAU); ctx.fill(); }
  ctx.fillStyle = body;
  ctx.beginPath(); ctx.moveTo(0, -13); ctx.lineTo(10, -2); ctx.lineTo(0, 12); ctx.lineTo(-10, -2); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = trim; ctx.beginPath(); ctx.moveTo(0, -13); ctx.lineTo(0, 12); ctx.moveTo(-10, -2); ctx.lineTo(10, -2); ctx.stroke();
  ctx.restore();
}

function glow(ctx, x, y, r, color) {
  ctx.fillStyle = color; ctx.globalAlpha = 0.25;
  ctx.beginPath(); ctx.arc(x, y, r * 1.8, 0, TAU); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
}

const DRAW = {
  fizzlet(ctx, e, t) {
    glow(ctx, e.x, e.y, 6, C.fizzlet);
    ctx.strokeStyle = C.fizzlet; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let k = 0; k < 6; k++) { const a = k / 6 * TAU + t * 0.2; ctx.moveTo(e.x, e.y); ctx.lineTo(e.x + Math.cos(a) * 11, e.y + Math.sin(a) * 11); }
    ctx.stroke();
  },
  arcwisp(ctx, e, t) {
    glow(ctx, e.x, e.y, 6, C.arcwisp);
    ctx.strokeStyle = '#efdcff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(e.x, e.y, 9, t * 0.25, t * 0.25 + 4); ctx.stroke();
  },
  shearling(ctx, e) {
    const dir = e.vx >= 0 ? 1 : -1;
    ctx.fillStyle = C.shearling; ctx.beginPath();
    ctx.arc(e.x, e.y, 10, -Math.PI / 2, Math.PI / 2, dir < 0);
    ctx.arc(e.x - dir * 4, e.y, 7, Math.PI / 2, -Math.PI / 2, dir > 0);
    ctx.fill();
  },
  thunderhead(ctx, e, t) {
    blob(ctx, e.x, e.y, 13, 5, e.id, C.thunder);
    ctx.fillStyle = '#ffe9a8'; ctx.beginPath(); ctx.arc(e.x, e.y + 2, 3 + (t % 20 < 4 ? 2 : 0), 0, TAU); ctx.fill();
  },
  anvilback(ctx, e, t) {
    ctx.fillStyle = C.boss; ctx.beginPath();
    ctx.moveTo(e.x - 46, e.y - 18); ctx.lineTo(e.x + 46, e.y - 18); ctx.lineTo(e.x + 22, e.y + 6); ctx.lineTo(e.x + 30, e.y + 26);
    ctx.lineTo(e.x - 30, e.y + 26); ctx.lineTo(e.x - 22, e.y + 6); ctx.closePath(); ctx.fill();
    blob(ctx, e.x, e.y - 22, 22, 7, 404, 'rgba(90,86,130,0.9)');
    glow(ctx, e.x, e.y + 8, 7 + Math.sin(t * 0.2) * 2, '#ff9a4a'); // the forge
  },
  'nimbus-maw'(ctx, e, t) {
    blob(ctx, e.x, e.y, 34, 9, 808, '#3b3557');
    ctx.fillStyle = '#120f22'; ctx.beginPath(); ctx.ellipse(e.x, e.y + 6, 16, 9 + Math.sin(t * 0.15) * 4, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = C.spark;
    for (let k = -2; k <= 2; k++) { ctx.beginPath(); ctx.moveTo(e.x + k * 6 - 2, e.y); ctx.lineTo(e.x + k * 6 + 2, e.y); ctx.lineTo(e.x + k * 6, e.y + 5); ctx.fill(); }
  },
};

function bar(ctx, x, y, w, frac, color) {
  ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(x, y, w, 5);
  ctx.fillStyle = color; ctx.fillRect(x, y, w * Math.max(0, Math.min(1, frac)), 5);
}

function field(ctx, state, bursts) {
  const t = state.tick;
  const stage = state.stages[state.stageIndex];
  for (const it of state.pickups) {
    glow(ctx, it.x, it.y, 7, 'rgba(180,240,255,0.9)');
    ctx.fillStyle = '#1b2240'; ctx.font = 'bold 10px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(PICKUP_GLYPH[it.kind] ?? '?', it.x, it.y + 0.5);
  }
  ctx.fillStyle = C.shot;
  for (const b of state.shots) ctx.fillRect(b.x - 1.5, b.y - 6, 3, 10);
  for (const e of state.enemies) DRAW[lookOf(e, stage)](ctx, e, t);
  for (const b of state.sparks) glow(ctx, b.x, b.y, 3, C.spark);
  for (const p of state.pilots) if (p.alive) kite(ctx, p, t);
  for (const b of bursts) {
    const k = (t - b.tick) / 14;
    if (k < 0 || k >= 1) continue;
    ctx.strokeStyle = `rgba(255,236,190,${1 - k})`; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r * (0.5 + k * 1.5), 0, TAU); ctx.stroke();
  }
}

function hud(ctx, state, w, top, labels) {
  ctx.fillStyle = 'rgba(10,12,30,0.5)'; ctx.fillRect(0, 0, w, top);
  ctx.textBaseline = 'middle'; ctx.font = '600 13px system-ui, sans-serif';
  const stage = state.stages[state.stageIndex];
  state.pilots.forEach((p, i) => {
    ctx.fillStyle = C.kites[p.seat % 2][0];
    ctx.textAlign = i === 0 ? 'left' : 'right';
    const x = i === 0 ? 10 : w - 10;
    ctx.fillText(`${labels[i] ?? KITES[p.seat % 2]}  ${p.score.toLocaleString('en-US')}  ${'♦'.repeat(Math.max(0, p.lives))}`, x, top / 2);
  });
  if (state.pilots.length === 1) {
    ctx.textAlign = 'right'; ctx.fillStyle = C.dim;
    ctx.fillText(`${state.stageIndex + 1}/${state.stages.length} ${stage.name ?? ''}`, w - 10, top / 2);
  }
}

/**
 * Draw one frame. `view` is { w, h } in CSS pixels, `state` is the match (or null on the title),
 * `tick` drives the sky when there is no match, `bursts` are { x, y, r, tick } rings that the caller
 * makes from kill events, and `labels` names each seat.
 */
export function drawFrame(ctx, { w, h, state = null, tick = 0, bursts = [], labels = [] }) {
  const t = state ? state.tick : tick;
  drawSky(ctx, w, h, t);
  if (!state) return;
  const { scale, ox, oy } = layout(w, h);
  ctx.save();
  ctx.translate(ox, oy); ctx.scale(scale, scale);
  ctx.beginPath(); ctx.rect(0, 0, WORLD_W, WORLD_H); ctx.clip();
  ctx.fillStyle = 'rgba(12,14,34,0.18)'; ctx.fillRect(0, 0, WORLD_W, WORLD_H);
  field(ctx, state, bursts);

  const boss = state.enemies.find((e) => e.kind === 'boss');
  const stage = state.stages[state.stageIndex];
  if (boss) {
    ctx.fillStyle = C.ink; ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(LOOKS[lookOf(boss, stage)].name, WORLD_W / 2, 8);
    bar(ctx, WORLD_W / 2 - 80, 24, 160, boss.hp / stage.boss.hp, '#ff9a4a');
  }
  state.pilots.forEach((p, i) => bar(ctx, 10, WORLD_H - 14 - i * 9, 60, 1 - p.dashCd / DASH_COOLDOWN_TICKS, C.kites[p.seat % 2][0]));
  if (state.phase === 'clear' || state.stageTick < 60) {
    const title = state.phase === 'clear' ? 'Storm sealed' : `Stage ${state.stageIndex + 1}`;
    ctx.fillStyle = 'rgba(10,12,30,0.55)'; ctx.fillRect(0, WORLD_H / 2 - 44, WORLD_W, 88);
    ctx.fillStyle = C.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '700 26px Georgia, serif'; ctx.fillText(title, WORLD_W / 2, WORLD_H / 2 - 12);
    ctx.font = 'italic 15px Georgia, serif'; ctx.fillStyle = C.dim; ctx.fillText(stage.name ?? '', WORLD_W / 2, WORLD_H / 2 + 18);
  }
  ctx.restore();

  const top = oy >= HUD_H ? HUD_H : 0;
  ctx.save();
  if (top) hud(ctx, state, w, top, labels);
  else { ctx.translate(ox, oy); ctx.scale(scale, scale); hud(ctx, state, WORLD_W, HUD_H, labels); }
  ctx.restore();
}
