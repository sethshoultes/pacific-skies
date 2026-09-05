// WebAudio synth: every sound is generated at runtime (square/triangle/noise voices), no audio
// assets are shipped. Small master/SFX volume mixer persisted to localStorage, `M` mutes.
const VOL_KEYS = { master: 'ps_vol_master', sfx: 'ps_vol_sfx' };
function readVol(key) { try { const v = localStorage.getItem(key); const n = v == null ? 100 : Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) / 100 : 1; } catch { return 1; } }
function readMuted() { try { return localStorage.getItem('ps_mute') === '1'; } catch { return false; } }

const vol = { master: readVol(VOL_KEYS.master), sfx: readVol(VOL_KEYS.sfx) };
let muted = readMuted();
let AC = null, masterGain = null, sfxBus = null;

function build() {
  if (AC) return AC;
  try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
  masterGain = AC.createGain(); masterGain.gain.value = vol.master; masterGain.connect(AC.destination);
  sfxBus = AC.createGain(); sfxBus.gain.value = vol.sfx; sfxBus.connect(masterGain);
  return AC;
}
function ac() { return build(); }

export function initAudio() {
  const resume = () => { const a = build(); if (a && a.state === 'suspended') a.resume(); };
  window.addEventListener('pointerdown', resume, { once: true });
  window.addEventListener('keydown', resume, { once: true });
}
export function setMuted(v) { muted = !!v; try { localStorage.setItem('ps_mute', muted ? '1' : '0'); } catch {} }
export function isMuted() { return muted; }

function tone(freq, dur, type = 'square', gain = 0.08, slide = 0) {
  const a = ac(); if (!a || muted) return;
  const o = a.createOscillator(); const g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, a.currentTime);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), a.currentTime + dur);
  g.gain.setValueAtTime(gain, a.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
  o.connect(g).connect(sfxBus || a.destination); o.start(); o.stop(a.currentTime + dur);
}
function noise(dur, gain = 0.08, filter) {
  const a = ac(); if (!a || muted) return;
  const buf = a.createBuffer(1, Math.max(1, Math.floor(a.sampleRate * dur)), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const s = a.createBufferSource(); s.buffer = buf;
  const g = a.createGain(); g.gain.value = gain;
  let node = s;
  if (filter) { const f = a.createBiquadFilter(); f.type = filter; f.frequency.value = 800; node.connect(f); node = f; }
  node.connect(g).connect(sfxBus || a.destination);
  s.start();
}
function chord(freqs, dur, type, gain, gap = 0) { freqs.forEach((f, i) => setTimeout(() => tone(f, dur, type, gain), i * gap)); }

const sfxLast = {};
export function sfx(name) {
  const now = performance.now();
  if (sfxLast[name] && now - sfxLast[name] < 40) return;
  sfxLast[name] = now;
  switch (name) {
    case 'shoot': tone(900, 0.05, 'square', 0.035, -500); break;
    case 'hit': noise(0.04, 0.05); break;
    case 'kill': tone(220, 0.12, 'sawtooth', 0.06, -150); noise(0.08, 0.04); break;
    case 'explosion': noise(0.35, 0.13); tone(70, 0.32, 'sawtooth', 0.1, -50); break;
    case 'loop': tone(440, 0.3, 'sine', 0.06, 600); break;
    case 'pow': tone(660, 0.08, 'triangle', 0.07); setTimeout(() => tone(880, 0.1, 'triangle', 0.07), 70); setTimeout(() => tone(1100, 0.12, 'triangle', 0.07), 140); break;
    case 'bomb': noise(0.5, 0.16); tone(60, 0.5, 'sawtooth', 0.12, -30); break;
    case '1up': chord([659, 784, 988, 1319], 0.2, 'square', 0.08, 100); break;
    case 'death': tone(440, 0.7, 'sawtooth', 0.1, -400); break;
    case 'boss-alarm': tone(300, 0.4, 'square', 0.08, -80); setTimeout(() => tone(300, 0.4, 'square', 0.08, -80), 500); break;
    case 'stage-clear': chord([523, 659, 784, 1047, 1319], 0.2, 'square', 0.07, 130); break;
    case 'gameover': chord([440, 349, 293, 220], 0.4, 'sawtooth', 0.08, 220); break;
    case 'victory': chord([523, 659, 784, 1047, 1319, 1568, 2093], 0.22, 'square', 0.08, 120); break;
    case 'coin': tone(988, 0.08, 'square', 0.06); setTimeout(() => tone(1319, 0.15, 'square', 0.06), 80); break;
    default: break;
  }
}
