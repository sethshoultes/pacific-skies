// A running flight: one Room per game, owning a Sim, the tick loop, the pre-game lobby screen
// (roster/ready/chat/start), and the stats/achievement hooks that fire as players play.
import crypto from 'node:crypto';
import { Sim } from './sim.js';
import { TICK_RATE, MAX_PLAYERS, STAGE_COUNT } from '../../shared/constants.js';
import * as stats from '../stats.js';

const AWAY_GRACE_MS = 30000;   // how long a disconnected player's slot is held before a real leave
const COUNTDOWN_SECONDS = 5;   // auto-start countdown once everyone readies up
const CHAT_MAX = 200;

export class Room {
  constructor({ id, name, seed, isPublic = true, onEmpty }) {
    this.id = id;
    this.name = name;
    this.isPublic = isPublic;
    this.onEmpty = onEmpty || (() => {});
    this.state = 'lobby'; // 'lobby' | 'playing' | 'over'
    this.clients = new Map(); // pid -> { ws, user, name, ready, away, guestId }
    this.sim = new Sim({ seed, onEvent: (ev) => this._onSimEvent(ev) });
    this.countdown = null;
    this.tickTimer = null;
    this.startedAt = null;
    this._telemetryHooked = false;
  }

  get playerCount() { return this.clients.size; }
  get full() { return this.playerCount >= MAX_PLAYERS; }

  info() {
    return {
      id: this.id, name: this.name, isPublic: this.isPublic, state: this.state,
      playerCount: this.playerCount, maxPlayers: MAX_PLAYERS,
      players: [...this.clients.values()].map((c) => ({ name: c.name, ready: c.ready, away: c.away })),
    };
  }

  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const c of this.clients.values()) { if (c.ws && c.ws.readyState === 1) c.ws.send(s); }
  }
  sendTo(pid, msg) {
    const c = this.clients.get(pid);
    if (c && c.ws && c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
  }

  join(ws, { pid, user, name, guestId }) {
    // Late join mid-game isn't supported (co-op is 1-2 players decided at start): once playing,
    // only a player already in the room (reconnecting) may join again.
    if (this.state !== 'lobby' && !this.clients.has(pid)) throw new Error('Game already in progress');
    if (this.full && !this.clients.has(pid)) throw new Error('Room is full');
    const finalGuestId = guestId || (user ? null : crypto.randomBytes(4).toString('hex'));
    this.clients.set(pid, { ws, user, name, ready: false, away: false, awayTimer: null, guestId: finalGuestId });
    if (!this.sim.players.has(pid)) this.sim.addPlayer(pid, { slot: this.clients.size });
    // The stats/achievements hooks key off the sim player's account; guests stay null.
    this.sim.players.get(pid).user = user || null;
    this.sendTo(pid, { t: 'joined', room: this.info(), pid, you: { name } });
    this.broadcast({ t: 'roster', room: this.info() });
    return { pid, guestId: finalGuestId };
  }

  resume(ws, resumeToken) {
    const c = this.clients.get(resumeToken);
    if (!c || !c.away) return null;
    c.ws = ws; c.away = false;
    if (c.awayTimer) { clearTimeout(c.awayTimer); c.awayTimer = null; }
    this.sendTo(resumeToken, { t: 'joined', room: this.info(), pid: resumeToken, you: { name: c.name } });
    this.broadcast({ t: 'roster', room: this.info() });
    return { pid: resumeToken };
  }

  setReady(pid, ready) {
    const c = this.clients.get(pid); if (!c) return;
    c.ready = ready;
    this.broadcast({ t: 'roster', room: this.info() });
    this._maybeAutoStart();
  }

  chat(pid, text) {
    const c = this.clients.get(pid); if (!c) return;
    const clean = String(text || '').slice(0, CHAT_MAX);
    if (!clean.trim()) return;
    this.broadcast({ t: 'chat', pid, name: c.name, text: clean });
  }

  kick(pid, targetPid) {
    // Only the first-joined client (host) may kick.
    const hostPid = [...this.clients.keys()][0];
    if (pid !== hostPid || targetPid === hostPid) return;
    const c = this.clients.get(targetPid);
    if (!c) return;
    this.sendTo(targetPid, { t: 'kicked' });
    this.leave(targetPid);
  }

  _maybeAutoStart() {
    if (this.state !== 'lobby') return;
    const all = [...this.clients.values()];
    if (all.length && all.every((c) => c.ready)) {
      if (this.countdown) return;
      let n = COUNTDOWN_SECONDS;
      this.broadcast({ t: 'countdown', seconds: n });
      this.countdown = setInterval(() => {
        n -= 1;
        if (n <= 0) { clearInterval(this.countdown); this.countdown = null; this.start(); }
        else this.broadcast({ t: 'countdown', seconds: n });
      }, 1000);
    } else if (this.countdown) {
      clearInterval(this.countdown); this.countdown = null;
      this.broadcast({ t: 'countdown', seconds: null });
    }
  }

  /** Start the game. Only the host may start a co-op room directly (a solo player is always the
   *  host); anyone else gets an error. Returns true only when the game actually started. */
  start(pid) {
    const hostPid = [...this.clients.keys()][0];
    if (pid && pid !== hostPid && this.clients.size > 1) {
      this.sendTo(pid, { t: 'error', error: 'Only the host can start the game' });
      return false;
    }
    if (this.state !== 'lobby') return false;
    if (this.countdown) { clearInterval(this.countdown); this.countdown = null; }
    this.state = 'playing';
    this.startedAt = Date.now();
    this.broadcast({ t: 'start', room: this.info() });
    this.tickTimer = setInterval(() => this._tick(), 1000 / TICK_RATE);
    return true;
  }

  handleInput(pid, msg) { this.sim.setInput(pid, msg); }

  debugAction(action) {
    if (action === 'clear-stage') { this.sim._clearStage(); }
    if (action === 'win-game') { this.sim.stageNumber = 1; this.sim._clearStage(); }
    if (action === 'jump-to-boss') {
      // Test/manual-QA hook: skip straight to the stage's final wave (the boss, on boss stages)
      // without spawning everything in between.
      const lastIdx = this.sim.stage.waves.length - 1;
      this.sim.waveCursor = lastIdx;
      this.sim.stageTime = this.sim.stage.waves[lastIdx].at;
    }
  }

  _tick() {
    this.sim.step();
    for (const p of this.sim.respawnDue()) this.sim.respawnPlayer(p);
    this.broadcast({ t: 'snap', s: this.sim.snapshot() });
    if (this.sim.stagePhase === 'victory' || this.sim.allPlayersOut()) this._endGame(this.sim.stagePhase === 'victory' ? 'victory' : 'gameover');
  }

  _onSimEvent(ev) {
    switch (ev.t) {
      case 'kill': {
        const p = this.sim.players.get(ev.pid);
        if (p?.user) {
          const fresh = stats.bump(p.user.id, 'kills', 1);
          this._announceAchievements(ev.pid, fresh);
        }
        break;
      }
      case 'red-formation-clear': {
        for (const p of this.sim.players.values()) {
          if (p.user) this._announceAchievements(p.pid, stats.bump(p.user.id, 'red_formations', 1));
        }
        break;
      }
      case 'boss-down': {
        for (const p of this.sim.players.values()) {
          if (p.user) this._announceAchievements(p.pid, stats.bump(p.user.id, 'bosses', 1));
        }
        break;
      }
      case 'stage-clear': {
        this._stagesClearedRun = (this._stagesClearedRun || 0) + 1;
        for (const p of this.sim.players.values()) {
          if (!p.user) continue;
          this._announceAchievements(p.pid, stats.raise(p.user.id, 'stages_cleared_run_max', this._stagesClearedRun));
          // stageNumber is still the stage just cleared here, so "stages cleared" is 32 - stage + 1
          // (clearing stage 32 = 1 cleared; clearing stage 2 = 31 = reached stage 1).
          this._announceAchievements(p.pid, stats.raise(p.user.id, 'deepest_stage_reached', STAGE_COUNT - this.sim.stageNumber + 1));
          if (ev.coop) this._announceAchievements(p.pid, stats.bump(p.user.id, 'coop_stage_clears', 1));
          const t = ev.tally.find((x) => x.pid === p.pid);
          if (t && t.untouched) this._announceAchievements(p.pid, stats.bump(p.user.id, 'untouched_stages', 1));
        }
        break;
      }
      case '1up': break;
      default: break;
    }
    this.broadcast({ t: 'event', event: ev });
  }

  _announceAchievements(pid, fresh) {
    for (const a of fresh) this.sendTo(pid, { t: 'achievement', achievement: a });
  }

  _endGame(reason) {
    if (this.state === 'over') return;
    this.state = 'over';
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    for (const p of this.sim.players.values()) {
      if (!p.user) continue;
      stats.recordRun(p.user.id, {
        score: p.score, stageReached: STAGE_COUNT - this.sim.stageNumber + (reason === 'victory' ? 1 : 0),
        kills: p.kills, seconds: Math.round(this.sim.time), mode: this.sim.players.size > 1 ? 'coop' : 'solo',
      });
    }
    this.broadcast({ t: 'gameover', reason, snapshot: this.sim.snapshot() });
  }

  disconnect(pid) {
    const c = this.clients.get(pid);
    if (!c) return;
    if (this.state !== 'playing') { this.leave(pid); return; }
    c.away = true;
    c.awayTimer = setTimeout(() => this.leave(pid), AWAY_GRACE_MS);
    this.broadcast({ t: 'roster', room: this.info() });
  }

  leave(pid) {
    const c = this.clients.get(pid);
    if (!c) return;
    if (c.awayTimer) clearTimeout(c.awayTimer);
    this.clients.delete(pid);
    this.sim.removePlayer(pid);
    this.broadcast({ t: 'roster', room: this.info() });
    if (this.clients.size === 0) this.close();
  }

  close() {
    if (this.countdown) clearInterval(this.countdown);
    if (this.tickTimer) clearInterval(this.tickTimer);
    for (const c of this.clients.values()) { try { c.ws?.close(); } catch {} }
    this.onEmpty(this);
  }
}
