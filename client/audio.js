// Stormglass sounds, all synthesised: glassy sine chimes, filtered-noise thunder, a rising gust.
// Silent until the first key or touch (browsers want a gesture), and the mute choice is remembered.
const MUTE_KEY = 'stormglass.mute';

let ctx = null;
let out = null;
let muted = (() => { try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; } })();

export const isMuted = () => muted;
export function setMuted(v) {
  muted = !!v;
  try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* private mode: not remembered */ }
}

// The master volume from the settings page, 0..1.
function masterVolume() {
  try { const v = Number(localStorage.getItem('ps_vol_master') ?? 100); return Number.isFinite(v) ? Math.max(0, Math.min(1, v / 100)) : 1; } catch { return 1; }
}

/** Open the audio graph on the first gesture; before that every sound is a no-op. */
export function armAudio() {
  const open = () => {
    if (!ctx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; }
      out = ctx.createGain(); out.gain.value = 0.5 * masterVolume(); out.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
  };
  window.addEventListener('pointerdown', open, { once: true });
  window.addEventListener('keydown', open, { once: true });
}

function chime(freq, dur, gain = 0.06, at = 0, type = 'sine') {
  if (!ctx || muted) return;
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(out); o.start(t); o.stop(t + dur + 0.02);
}

function rumble(dur, gain, from, to) {
  if (!ctx || muted) return;
  const t = ctx.currentTime;
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource(); src.buffer = buf;
  const f = ctx.createBiquadFilter(); f.type = 'lowpass';
  f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = ctx.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(out); src.start(t);
}

const SOUNDS = {
  shot: () => chime(1560, 0.05, 0.015, 0, 'triangle'),
  hit: () => chime(2200, 0.04, 0.02),
  kill: () => { chime(880, 0.18, 0.05); chime(1320, 0.22, 0.035, 0.03); },
  'boss-down': () => { rumble(1.2, 0.3, 900, 60); [523, 784, 1047, 1568].forEach((f, i) => chime(f, 0.6, 0.05, 0.15 * i)); },
  death: () => { rumble(0.7, 0.25, 1800, 80); chime(330, 0.5, 0.05, 0, 'triangle'); },
  dash: () => rumble(0.25, 0.12, 400, 3200),
  pickup: () => [988, 1319, 1760].forEach((f, i) => chime(f, 0.2, 0.04, 0.05 * i)),
  'boss-appear': () => { rumble(1.6, 0.28, 300, 40); chime(110, 1.2, 0.05, 0.2, 'triangle'); },
  'stage-clear': () => [659, 880, 988, 1319].forEach((f, i) => chime(f, 0.5, 0.05, 0.12 * i)),
  'match-over': () => [440, 392, 330, 262].forEach((f, i) => chime(f, 0.7, 0.05, 0.2 * i, 'triangle')),
};

const last = {};

/** Play the sound for an engine event, if it has one; one of a kind per 60 ms, so volleys don't pile up. */
export function playEvent(e) {
  if (!ctx || muted || !SOUNDS[e.t]) return;
  if (ctx.currentTime - (last[e.t] ?? -1) < 0.06) return;
  last[e.t] = ctx.currentTime;
  SOUNDS[e.t]();
}
