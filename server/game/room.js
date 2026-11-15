// A running flight: one Room per game. It owns the room lobby (roster, ready, countdown, chat, kick,
// match type), then a match on the pure engine: each tick it gathers one Action per seat (humans
// send theirs over the socket, AI seats ask the pilot) and steps the match. It also owns the
// stats/achievement hooks that fire as players play.
import crypto from 'node:crypto';
import { createMatch, step, observe, isOver, isAction, legalActions } from '../../shared/engine/index.js';
import { TICK_RATE } from '../../shared/engine/rules.js';
import { pilotAction, LEVELS } from '../../shared/ai/pilot.js';
import { MAX_PLAYERS } from '../../shared/constants.js';
import { buildStages } from './stages.js';
import * as stats from '../stats.js';

const AWAY_GRACE_MS = 30000;   // how long a disconnected player's slot is held before a real leave
const COUNTDOWN_SECONDS = 5;   // auto-start countdown once everyone readies up
const CHAT_MAX = 200;
const MAX_CONTINUES = 3;       // credits per run
export const STAGE_COUNT = 6;

// What the host can pick. `humans` seats go to players in join order; extra players watch.
// `team` scoring sums the kites; `race` ranks them.
export const MATCH_TYPES = {
  coop: { label: 'Co-op', humans: 2, ai: 0, scoring: 'team' },
  race: { label: 'Race', humans: 2, ai: 0, scoring: 'race', minHumans: 2 },
  wingman: { label: 'AI wingman', humans: 1, ai: 1, scoring: 'team' },
  rival: { label: 'AI rival', humans: 1, ai: 1, scoring: 'race' },
  watch: { label: 'Watch AI vs AI', humans: 0, ai: 2, scoring: 'race' },
};
const IDLE = Object.freeze({ move: 0, fire: false, dash: false });
const same = (a, b) => a.move === b.move && a.fire === b.fire && a.dash === b.dash;
// Positions go out to one decimal: a snapshot stays a few KB, far under the socket's 16 KB.
const round1 = (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 10) / 10 : v);

export class Room {
  constructor({ id, name, seed, isPublic = true, onEmpty, onStart, stageCount = STAGE_COUNT, tickMs = 1000 / TICK_RATE }) {
    this.id = id;
    this.name = name;
    this.seed = seed;
    this.isPublic = isPublic;
    this.onEmpty = onEmpty || (() => {});
    // Fired exactly once, right as the match actually starts -- whether from an explicit start or
    // the ready-countdown auto-start -- so callers (telemetry) see every game start.
    this.onStart = onStart || (() => {});
    this.stageCount = stageCount;
    this.tickMs = tickMs;
    this.state = 'lobby'; // 'lobby' | 'starting' | 'playing' | 'over'
    this.type = 'coop';
    this.level = 'medium';
    this.clients = new Map(); // pid -> { ws, user, name, ready, away, guestId, resumeToken }
    this.countdown = null;
    this.tickTimer = null;
    this.startedAt = null;
    this.closed = false;
    this.stages = null;   // built on the first join, in the builder's worker
    this.built = null;
    this.match = null;
    this.seats = [];      // per seat: { kind: 'human', pid } or { kind: 'ai', level }
    this.inputs = [];     // per seat: the human's held Action
    this.held = [];       // per seat: the AI's held Action between decisions
    this.offset = 0;      // stages flown before this credit's match began
    this.scoreBase = [];  // per seat: score banked from earlier credits
    this.result = null;   // 'won' | 'over' once state === 'over'
    this.continuesUsed = 0;
    this.stagesClearedRun = 0;
    this.hitThisStage = [];
    this._telemetryHooked = false;
  }

  get continuesLeft() { return Math.max(0, MAX_CONTINUES - this.continuesUsed); }
  get playerCount() { return this.clients.size; }
  get full() { return this.playerCount >= MAX_PLAYERS; }
  get hostPid() { return [...this.clients.keys()][0]; }

  info() {
    return {
      id: this.id, name: this.name, isPublic: this.isPublic, state: this.state,
      playerCount: this.playerCount, maxPlayers: MAX_PLAYERS, type: this.type, level: this.level,
      // pid is already known to room members (it keys their seats), so exposing it here leaks
      // nothing new to them; `host` lets the client offer Start and the match type only to the one
      // player the server will honour. The room list anyone can fetch uses publicInfo().
      players: [...this.clients.entries()].map(([pid, c], i) => ({ pid, name: c.name, ready: c.ready, away: c.away, host: i === 0 })),
    };
  }

  /** The room as shown in the public lobby list (GET /api/rooms): same summary as info(), but the
   *  roster carries only display fields -- no per-player ids, which non-members have no use for. */
  publicInfo() {
    const info = this.info();
    return { ...info, players: info.players.map(({ name, ready, away }) => ({ name, ready, away })) };
  }

  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const c of this.clients.values()) { if (c.ws && c.ws.readyState === 1) c.ws.send(s); }
  }
  sendTo(pid, msg) {
    const c = this.clients.get(pid);
    if (c && c.ws && c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
  }

  _build() {
    if (this.built) return this.built;
    this.built = buildStages(this.seed, this.stageCount, () => this.closed).then((stages) => { this.stages = stages; });
    this.built.catch(() => {}); // a failed build is reported when a start waits on it
    return this.built;
  }

  join(ws, { pid, user, name, guestId }) {
    // Once a match is under way only a player already in the room (reconnecting) may join again.
    if (this.state !== 'lobby' && !this.clients.has(pid)) throw new Error('Game already in progress');
    if (this.full && !this.clients.has(pid)) throw new Error('Room is full');
    // A stale awayTimer from a previous disconnect must not survive this rejoin -- otherwise it
    // fires later and evicts the player who just came back (see `disconnect`/`leave`).
    const existing = this.clients.get(pid);
    if (existing && existing.awayTimer) clearTimeout(existing.awayTimer);
    // guestId is client-controlled (the WS join message), so it must never be stored as-is: cap
    // its length and charset, and ignore it entirely for a logged-in user.
    const suppliedGuestId = !user && typeof guestId === 'string' ? guestId.slice(0, 64).replace(/[^A-Za-z0-9_-]/g, '') : '';
    const finalGuestId = suppliedGuestId || (user ? null : crypto.randomBytes(4).toString('hex'));
    // resumeToken is a private secret handed only to this client, distinct from `pid` -- pid is
    // shared with every player in the room, so it must never itself be usable to resume a slot.
    const resumeToken = crypto.randomBytes(16).toString('hex');
    this.clients.set(pid, { ws, user: user || null, name, ready: false, away: false, awayTimer: null, guestId: finalGuestId, resumeToken });
    this._build();
    this.sendTo(pid, { t: 'joined', room: this.info(), pid, you: { name }, resumeToken });
    this.broadcast({ t: 'roster', room: this.info() });
    if (this.match) this.sendTo(pid, this._startMsg());
    return { pid, guestId: finalGuestId };
  }

  resume(ws, pid, resumeToken) {
    const c = this.clients.get(pid);
    if (!c || !c.away) return null;
    const known = Buffer.from(String(c.resumeToken || ''), 'utf8');
    const presented = Buffer.from(String(resumeToken || ''), 'utf8');
    if (known.length === 0 || known.length !== presented.length || !crypto.timingSafeEqual(known, presented)) return null;
    c.ws = ws; c.away = false;
    if (c.awayTimer) { clearTimeout(c.awayTimer); c.awayTimer = null; }
    this.sendTo(pid, { t: 'joined', room: this.info(), pid, you: { name: c.name }, resumeToken: c.resumeToken });
    this.broadcast({ t: 'roster', room: this.info() });
    if (this.match) this.sendTo(pid, this._startMsg());
    return { pid };
  }

  setReady(pid, ready) {
    const c = this.clients.get(pid); if (!c) return;
    c.ready = ready;
    this.broadcast({ t: 'roster', room: this.info() });
    this._maybeAutoStart();
  }

  /** The host picks the match type and the AI level, in the room lobby only. */
  setType(pid, type, level = this.level) {
    if (pid !== this.hostPid) throw new Error('Only the host can pick the match type');
    if (this.state !== 'lobby') throw new Error('The match has started');
    if (!Object.hasOwn(MATCH_TYPES, type)) throw new Error('Unknown match type');
    if (!Object.hasOwn(LEVELS, level)) throw new Error('Unknown AI level');
    this.type = type;
    this.level = level;
    this.broadcast({ t: 'roster', room: this.info() });
  }

  chat(pid, text) {
    const c = this.clients.get(pid); if (!c) return;
    const clean = String(text || '').slice(0, CHAT_MAX);
    if (!clean.trim()) return;
    this.broadcast({ t: 'chat', pid, name: c.name, text: clean });
  }

  kick(pid, targetPid) {
    // Only the first-joined client (host) may kick.
    const hostPid = this.hostPid;
    if (pid !== hostPid || targetPid === hostPid) return;
    if (!this.clients.has(targetPid)) return;
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

  /** The seats a match of the current type gets, from the players here now. */
  seatPlan() {
    const t = MATCH_TYPES[this.type];
    const pids = [...this.clients.keys()];
    if (pids.length < (t.minHumans ?? 0)) throw new Error(`${t.label} needs ${t.minHumans} players`);
    const humans = pids.slice(0, t.humans).map((pid) => ({ kind: 'human', pid }));
    return [...humans, ...Array.from({ length: t.ai }, () => ({ kind: 'ai', level: this.level }))];
  }

  /** Start the match. Only the host may start a room with two players in it; anyone else gets an
   *  error. Returns true when the start is accepted: the match begins once the stages are built. */
  start(pid) {
    const hostPid = this.hostPid;
    if (pid && pid !== hostPid && this.clients.size > 1) {
      this.sendTo(pid, { t: 'error', error: 'Only the host can start the game' });
      return false;
    }
    if (this.state !== 'lobby') return false;
    let seats;
    try { seats = this.seatPlan(); } catch (e) { this.sendTo(pid || hostPid, { t: 'error', error: e.message }); return false; }
    if (this.countdown) { clearInterval(this.countdown); this.countdown = null; }
    this.state = 'starting';
    this.seats = seats;
    this.scoreBase = seats.map(() => 0);
    this.broadcast({ t: 'starting', room: this.info() });
    this._build().then(() => {
      if (this.closed) return;
      this._newMatch();
      this.startedAt = Date.now();
      this.onStart(hostPid);
    }).catch((e) => {
      this.broadcast({ t: 'error', error: `The storms could not be charted: ${e.message}` });
      this.close();
    });
    return true;
  }

  _newMatch() {
    const stages = this.stages.slice(this.offset);
    this.match = createMatch({ seed: `${this.seed}:${this.continuesUsed}`, stages, seats: this.seats.length });
    this.inputs = this.seats.map(() => ({ ...IDLE }));
    this.held = this.seats.map(() => ({ ...IDLE }));
    this.hitThisStage = this.seats.map(() => false);
    this.state = 'playing';
    this.broadcast(this._startMsg());
    this.tickTimer = setInterval(() => this._tick(), this.tickMs);
  }

  _startMsg() {
    return {
      t: 'start', room: this.info(), stages: this.stages, offset: this.offset,
      seats: this.seats.map((s) => (s.kind === 'ai' ? { kind: 'ai', level: s.level } : { kind: 'human', pid: s.pid, name: this.clients.get(s.pid)?.name ?? '' })),
    };
  }

  seatOf(pid) { return this.seats.findIndex((s) => s.kind === 'human' && s.pid === pid); }

  /** A human's Action for the next tick. It must be an Action that is legal for its seat right now;
   *  anything else is refused. A dash is one tick long, so the held action keeps only move and fire. */
  act(pid, a) {
    if (this.state !== 'playing') throw new Error('No match is running');
    const seat = this.seatOf(pid);
    if (seat < 0) throw new Error('You are watching this match');
    if (!isAction(a)) throw new Error('Refused: not an Action');
    if (!legalActions(this.match, seat).some((l) => same(l, a))) throw new Error('Refused: not legal now');
    this.inputs[seat] = { ...a };
  }

  /** One Action per seat for this tick: humans' held input, AI seats re-deciding on their period. */
  actionsFor() {
    return this.seats.map((s, seat) => {
      if (s.kind === 'human') {
        const a = this.clients.get(s.pid)?.away === false ? this.inputs[seat] : IDLE;
        this.inputs[seat] = { ...a, dash: false };
        return a;
      }
      this.held[seat] = this.match.tick % LEVELS[s.level].period === 0
        ? pilotAction(this.match, seat, s.level)
        : { ...this.held[seat], dash: false };
      return this.held[seat];
    });
  }

  /** What `seat` sees (a watcher sees seat 0), with stages and scores counted across continues. */
  snapshot(seat) {
    const o = observe(this.match, Math.max(0, seat));
    for (const p of [o.self, ...o.others]) p.score += this.scoreBase[p.seat];
    return JSON.parse(JSON.stringify({ ...o, stage: this.offset + o.stage, stageCount: this.stages.length, stageTick: this.match.stageTick }, round1));
  }

  _tick() {
    const r = step(this.match, this.actionsFor());
    this.match = r.state;
    this._onEvents(r.events);
    for (const [pid, c] of this.clients) {
      if (c.ws && c.ws.readyState === 1) c.ws.send(JSON.stringify({ t: 'snap', s: this.snapshot(this.seatOf(pid)), ev: r.events }));
    }
    if (isOver(this.match)) this._endGame(this.match.phase);
  }

  _user(seat) {
    const s = this.seats[seat];
    return s?.kind === 'human' ? this.clients.get(s.pid)?.user ?? null : null;
  }

  _accountSeats() { return this.seats.map((s, i) => i).filter((i) => this._user(i)); }

  _award(seat, fresh) {
    for (const a of fresh) this.sendTo(this.seats[seat].pid, { t: 'achievement', achievement: a });
  }

  _onEvents(events) {
    for (const ev of events) {
      const user = Number.isInteger(ev.seat) ? this._user(ev.seat) : null;
      if (ev.t === 'kill' && user) {
        this._award(ev.seat, stats.bump(user.id, 'kills', 1));
        if (ev.kind === 'heavy') this._award(ev.seat, stats.bump(user.id, 'thunderheads', 1));
      } else if (ev.t === 'dash' && user) {
        this._award(ev.seat, stats.bump(user.id, 'dashes', 1));
      } else if (ev.t === 'death') {
        this.hitThisStage[ev.seat] = true;
      } else if (ev.t === 'boss-down') {
        for (const i of this._accountSeats()) this._award(i, stats.bump(this._user(i).id, 'bosses', 1));
      } else if (ev.t === 'stage-clear') {
        this.stagesClearedRun++;
        const together = this.seats.length > 1 && MATCH_TYPES[this.type].scoring === 'team';
        for (const i of this._accountSeats()) {
          const id = this._user(i).id;
          this._award(i, stats.raise(id, 'stages_cleared_run_max', this.stagesClearedRun));
          this._award(i, stats.raise(id, 'deepest_stage', this.offset + ev.stage + 1));
          if (together) this._award(i, stats.bump(id, 'coop_stage_clears', 1));
          if (!this.hitThisStage[i]) this._award(i, stats.bump(id, 'untouched_stages', 1));
        }
        this.hitThisStage = this.seats.map(() => false);
      }
    }
  }

  /** A continue after the kites are lost: any player in the room may take it; a fresh match starts
   *  on the stage where they fell, with the score so far banked. Limited to MAX_CONTINUES a room. */
  continueGame(pid) {
    if (this.state !== 'over' || this.result !== 'over') return false;
    if (!this.clients.has(pid)) return false;
    if (this.continuesUsed >= MAX_CONTINUES) { this.sendTo(pid, { t: 'error', error: 'No continues left' }); return false; }
    this.match.pilots.forEach((p, i) => { this.scoreBase[i] += p.score; });
    this.offset += this.match.stageIndex;
    this.continuesUsed++;
    this.result = null;
    for (const i of this._accountSeats()) this._award(i, stats.bump(this._user(i).id, 'continues', 1));
    this.broadcast({ t: 'continued', by: pid, continuesLeft: this.continuesLeft });
    this._newMatch();
    return true;
  }

  _endGame(result) {
    if (this.state === 'over') return;
    this.state = 'over';
    this.result = result;
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    const scores = this.match.pilots.map((p, i) => this.scoreBase[i] + p.score);
    const stage = this.offset + this.match.stageIndex + 1;
    for (const i of this._accountSeats()) {
      const p = this.match.pilots[i];
      // A credit that ended with nothing to show would only clutter the boards with zero rows.
      if (scores[i] === 0 && p.kills === 0) continue;
      stats.recordRun(this._user(i).id, {
        score: scores[i], stageReached: stage, kills: p.kills,
        seconds: Math.round(this.match.tick / TICK_RATE), mode: this.type,
      });
    }
    this.broadcast({
      t: 'gameover', result, type: this.type, scores, stage, stageCount: this.stages.length,
      continuesLeft: result === 'over' ? this.continuesLeft : 0,
    });
  }

  disconnect(pid) {
    const c = this.clients.get(pid);
    if (!c) return;
    if (this.state === 'lobby') { this.leave(pid); return; }
    c.away = true;
    c.awayTimer = setTimeout(() => this.leave(pid), AWAY_GRACE_MS);
    this.broadcast({ t: 'roster', room: this.info() });
  }

  leave(pid) {
    const c = this.clients.get(pid);
    if (!c) return;
    if (c.awayTimer) clearTimeout(c.awayTimer);
    this.clients.delete(pid);
    this.broadcast({ t: 'roster', room: this.info() });
    if (this.clients.size === 0) this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.countdown) clearInterval(this.countdown);
    if (this.tickTimer) clearInterval(this.tickTimer);
    for (const c of this.clients.values()) { if (c.awayTimer) clearTimeout(c.awayTimer); try { c.ws?.close(); } catch {} }
    this.onEmpty(this);
  }
}
