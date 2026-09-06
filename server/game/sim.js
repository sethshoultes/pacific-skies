// Authoritative game simulation. Pure logic, no networking -- server/game/room.js drives it at
// TICK_RATE and turns events into WS broadcasts. Mirrors the structure of the sibling project's
// server/game/sim.js (see README "Architecture").
import {
  WORLD_W, WORLD_H, PLANE_SPEED, PLANE_HALF, DT, SHOT_SPEED, SHOT_COOLDOWN_MS, SHOT_COOLDOWN_MS_4WAY,
  ENEMY_SHOT_SPEED, MAX_PLAYER_SHOTS, START_LIVES, START_LOOPS, LOOP_MS, LOOP_COOLDOWN_MS,
  RESPAWN_INVULN_MS, RESPAWN_LOOPS, POW_CYCLE, POW_FALL_SPEED, POW_BONUS_POINTS,
  ENEMY_SMALL_HP, ENEMY_MEDIUM_HP, ENEMY_MIDBOSS_HP, ENEMY_BOSS_HP, SCORE, EXTRA_LIFE_SCORES,
  difficultyFor, STAGE_COUNT,
} from '../../shared/constants.js';
import { stageFor, isBossStage, stageSeconds } from '../../shared/stages.js';
import { makeRng } from '../../shared/rng.js';

let nextId = 1;
const uid = () => nextId++;

const dist2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;

export class Sim {
  /** @param {object} opts @param {(ev:object)=>void} [opts.onEvent] @param {string} [opts.seed] */
  constructor(opts = {}) {
    this.onEvent = opts.onEvent || (() => {});
    this.seed = opts.seed || String(Date.now());
    this.rng = makeRng(this.seed);
    this.players = new Map();     // pid -> player
    this.bullets = [];             // player shots
    this.enemyBullets = [];
    this.enemies = [];
    this.powItems = [];
    this.time = 0;                 // total sim time, seconds
    this.stageNumber = STAGE_COUNT; // counts down 32 -> 1
    this.stageTime = 0;
    this.stage = stageFor(this.stageNumber);
    this.waveCursor = 0;
    this.stagePhase = 'playing';   // 'playing' | 'clear' | 'gameover' | 'victory'
    this.phaseTimer = 0;
    this.stats = { shotsFired: 0, hits: 0 };
    this.powCount = 0;             // pickups so far, drives POW_CYCLE index
    this.redGroupSeq = 0;
    this.ended = false;
  }

  addPlayer(pid, opts = {}) {
    const p = {
      pid, x: WORLD_W / 2 + (opts.slot === 1 ? 40 : opts.slot === 2 ? -40 : 0), y: WORLD_H - 80,
      alive: true, lives: START_LIVES, score: 0, loops: START_LOOPS,
      looping: false, loopEndAt: 0, loopCooldownUntil: 0, invulnUntil: this.time + RESPAWN_INVULN_MS / 1000,
      shotCooldown: 0, side: false, fourway: false,
      input: { up: false, down: false, left: false, right: false, fire: false, loop: false },
      prevLoopInput: false,
      kills: 0, shotsFired: 0, hits: 0, hitThisStage: false, loopDodges: 0,
      slot: opts.slot || 1,
    };
    this.players.set(pid, p);
    return p;
  }

  removePlayer(pid) { this.players.delete(pid); }

  setInput(pid, input) {
    const p = this.players.get(pid);
    if (!p) return;
    p.input = { up: !!input.up, down: !!input.down, left: !!input.left, right: !!input.right, fire: !!input.fire, loop: !!input.loop };
  }

  playerCount() { return this.players.size; }
  alivePlayers() { return [...this.players.values()].filter((p) => p.alive); }

  /** Advance the sim by one fixed tick (DT seconds). */
  step() {
    if (this.ended) return;
    this.time += DT;

    if (this.stagePhase === 'clear' || this.stagePhase === 'gameover' || this.stagePhase === 'victory') {
      this.phaseTimer -= DT;
      if (this.stagePhase === 'clear' && this.phaseTimer <= 0) this._advanceStage();
      return;
    }

    this.stageTime += DT;
    this._spawnWaves();
    for (const p of this.players.values()) this._stepPlayer(p);
    this._stepBullets();
    this._stepEnemies();
    this._stepEnemyBullets();
    this._stepPow();
    this._checkCollisions();
    this._checkStageEnd();
  }

  difficulty() { return difficultyFor(this.stageNumber); }

  // ---------------- players ----------------
  _stepPlayer(p) {
    if (!p.alive) return;
    const diff = this.difficulty();
    let dx = 0, dy = 0;
    if (p.input.up) dy -= 1;
    if (p.input.down) dy += 1;
    if (p.input.left) dx -= 1;
    if (p.input.right) dx += 1;
    if (dx && dy) { dx *= Math.SQRT1_2; dy *= Math.SQRT1_2; }
    p.x += dx * PLANE_SPEED * DT;
    p.y += dy * PLANE_SPEED * DT;
    p.x = Math.max(PLANE_HALF, Math.min(WORLD_W - PLANE_HALF, p.x));
    p.y = Math.max(PLANE_HALF, Math.min(WORLD_H - PLANE_HALF, p.y));

    // loop-the-loop: edge-triggered on the `loop` input
    if (p.looping && this.time >= p.loopEndAt) {
      p.looping = false;
      p.loopCooldownUntil = this.time + LOOP_COOLDOWN_MS / 1000;
    }
    if (p.input.loop && !p.prevLoopInput && !p.looping && this.time >= p.loopCooldownUntil && p.loops > 0) {
      p.looping = true;
      p.loopEndAt = this.time + LOOP_MS / 1000;
      p.loops -= 1;
      this.onEvent({ t: 'loop', pid: p.pid });
    }
    p.prevLoopInput = p.input.loop;

    // fire (autofire while held, rate-capped; cannot fire while looping)
    p.shotCooldown -= DT * 1000;
    if (p.input.fire && !p.looping && p.shotCooldown <= 0) {
      this._fire(p);
      p.shotCooldown = p.fourway ? SHOT_COOLDOWN_MS_4WAY : SHOT_COOLDOWN_MS;
    }
    void diff;
  }

  _fire(p) {
    const spawn = (vx, vy, x = p.x) => {
      if (this.bullets.filter((b) => b.owner === p.pid).length >= MAX_PLAYER_SHOTS) return;
      this.bullets.push({ id: uid(), x, y: p.y - 10, vx, vy, owner: p.pid });
    };
    p.shotsFired++; p.stats = p.stats || {}; this.stats.shotsFired++;
    if (p.fourway) {
      spawn(-90, -SHOT_SPEED); spawn(-30, -SHOT_SPEED); spawn(30, -SHOT_SPEED); spawn(90, -SHOT_SPEED);
    } else {
      spawn(0, -SHOT_SPEED);
    }
    if (p.side) { spawn(0, -SHOT_SPEED, p.x - 14); spawn(0, -SHOT_SPEED, p.x + 14); }
    this.onEvent({ t: 'shot', pid: p.pid });
  }

  // ---------------- waves ----------------
  _spawnWaves() {
    while (this.waveCursor < this.stage.waves.length && this.stage.waves[this.waveCursor].at <= this.stageTime) {
      this._spawnWave(this.stage.waves[this.waveCursor]);
      this.waveCursor++;
    }
  }

  _spawnWave(w) {
    const diff = this.difficulty();
    const baseX = w.x * WORLD_W;
    switch (w.spawn) {
      case 'straight':
        for (let i = 0; i < w.count; i++) {
          this.enemies.push(this._mkSmall('straight', baseX + (i - w.count / 2) * 24, -20 - i * 30, { vx: 0, vy: 55 * diff.speedMul }));
        }
        break;
      case 'sine':
        for (let i = 0; i < w.count; i++) {
          this.enemies.push(this._mkSmall('sine', baseX, -20 - i * 26, { vy: 50 * diff.speedMul, amp: 60, freq: 1.4, phase: i * 0.6, baseX }));
        }
        break;
      case 'v-sweep': {
        const dir = w.params?.dir ?? 1;
        for (let i = 0; i < w.count; i++) {
          const off = (i - (w.count - 1) / 2) * 22;
          this.enemies.push(this._mkSmall('v-sweep', dir > 0 ? -20 : WORLD_W + 20, 40 + off, { vx: dir * 70 * diff.speedMul, vy: 30 * diff.speedMul }));
        }
        break;
      }
      case 'red-formation': {
        const groupId = ++this.redGroupSeq;
        const members = [];
        for (let i = 0; i < w.count; i++) {
          const e = this._mkSmall('red-formation', baseX + (i - (w.count - 1) / 2) * 26, -20 - i * 10, {
            vy: 45 * diff.speedMul, groupId, loopT: i * 0.3, baseX: baseX + (i - (w.count - 1) / 2) * 26, baseY: 90,
          });
          e.isRed = true;
          members.push(e.id);
          this.enemies.push(e);
        }
        break;
      }
      case 'medium':
        for (let i = 0; i < w.count; i++) {
          this.enemies.push(this._mkMedium(baseX + (i - w.count / 2) * 40, -30 - i * 40, diff));
        }
        break;
      case 'midboss':
        this.enemies.push(this._mkMidboss(baseX, -50, diff));
        this.onEvent({ t: 'midboss-appear' });
        break;
      case 'boss':
        this.enemies.push(this._mkBoss(baseX, -80, diff));
        this.onEvent({ t: 'boss-appear' });
        break;
      default: break;
    }
  }

  _mkSmall(kind, x, y, extra) {
    return { id: uid(), kind, type: 'small', x, y, hp: ENEMY_SMALL_HP, maxHp: ENEMY_SMALL_HP, age: 0, ...extra };
  }
  _mkMedium(x, y, diff) {
    return { id: uid(), kind: 'medium', type: 'medium', x, y, vy: 40 * diff.speedMul, hp: ENEMY_MEDIUM_HP, maxHp: ENEMY_MEDIUM_HP, age: 0, fireCooldown: 1.5 / diff.fireRateMul };
  }
  _mkMidboss(x, y, diff) {
    return { id: uid(), kind: 'midboss', type: 'midboss', x, y, vy: 18 * diff.speedMul, vx: 30, hp: ENEMY_MIDBOSS_HP, maxHp: ENEMY_MIDBOSS_HP, age: 0, fireCooldown: 1, dir: 1, holdY: 110 };
  }
  _mkBoss(x, y, diff) {
    return { id: uid(), kind: 'boss', type: 'boss', x, y, vy: 12 * diff.speedMul, vx: 40, hp: ENEMY_BOSS_HP, maxHp: ENEMY_BOSS_HP, age: 0, fireCooldown: 1, dir: 1, holdY: 130, turrets: 3 };
  }

  // ---------------- enemies ----------------
  _stepEnemies() {
    const diff = this.difficulty();
    for (const e of this.enemies) {
      e.age += DT;
      switch (e.kind) {
        case 'straight':
          e.y += e.vy * DT;
          break;
        case 'sine':
          e.y += e.vy * DT;
          e.x = e.baseX + Math.sin(e.age * e.freq + e.phase) * e.amp;
          break;
        case 'v-sweep':
          e.x += e.vx * DT; e.y += e.vy * DT;
          break;
        case 'red-formation':
          // flies a small loop pattern while drifting down
          e.loopT += DT * 2.2;
          e.baseY += e.vy * DT;
          e.x = e.baseX + Math.sin(e.loopT) * 28;
          e.y = e.baseY + Math.cos(e.loopT) * 18;
          break;
        case 'medium':
          e.y += e.vy * DT;
          e.fireCooldown -= DT;
          if (e.fireCooldown <= 0 && e.y > 0 && e.y < WORLD_H - 60) {
            this._enemyAimedShot(e, diff);
            e.fireCooldown = 1.6 / diff.fireRateMul;
          }
          break;
        case 'midboss':
          if (e.y < e.holdY) e.y += e.vy * DT;
          else { e.x += e.dir * 30 * DT; if (e.x < 40 || e.x > WORLD_W - 40) e.dir *= -1; }
          e.fireCooldown -= DT;
          if (e.fireCooldown <= 0) { this._enemyAimedShot(e, diff); e.fireCooldown = 1.1 / diff.fireRateMul; }
          break;
        case 'boss':
          if (e.y < e.holdY) e.y += e.vy * DT;
          else { e.x += e.dir * 25 * DT; if (e.x < 50 || e.x > WORLD_W - 50) e.dir *= -1; }
          e.fireCooldown -= DT;
          if (e.fireCooldown <= 0) {
            for (let k = 0; k < e.turrets; k++) {
              const spread = (k - (e.turrets - 1) / 2) * 26;
              this.enemyBullets.push({ id: uid(), x: e.x + spread, y: e.y + 20, vx: 0, vy: ENEMY_SHOT_SPEED * diff.speedMul });
            }
            e.fireCooldown = 0.9 / diff.fireRateMul;
          }
          break;
        default: break;
      }
    }
    // cull offscreen enemies (not bosses -- they stay on screen once they arrive)
    this.enemies = this.enemies.filter((e) => {
      if (e.kind === 'boss' || e.kind === 'midboss') return true;
      return e.y < WORLD_H + 60 && e.y > -400 && e.x > -80 && e.x < WORLD_W + 80;
    });
  }

  _enemyAimedShot(e, diff) {
    const targets = this.alivePlayers();
    if (!targets.length) return;
    const target = targets[Math.floor(this.rng() * targets.length)];
    const dx = target.x - e.x, dy = target.y - e.y;
    const len = Math.hypot(dx, dy) || 1;
    const speed = ENEMY_SHOT_SPEED * diff.speedMul;
    this.enemyBullets.push({ id: uid(), x: e.x, y: e.y + 10, vx: (dx / len) * speed, vy: (dy / len) * speed });
  }

  _stepBullets() {
    for (const b of this.bullets) { b.x += b.vx * DT; b.y += b.vy * DT; }
    this.bullets = this.bullets.filter((b) => b.y > -20 && b.y < WORLD_H + 20 && b.x > -20 && b.x < WORLD_W + 20);
  }
  _stepEnemyBullets() {
    for (const b of this.enemyBullets) { b.x += b.vx * DT; b.y += b.vy * DT; }
    this.enemyBullets = this.enemyBullets.filter((b) => b.y > -20 && b.y < WORLD_H + 20 && b.x > -20 && b.x < WORLD_W + 20);
  }
  _stepPow() {
    for (const it of this.powItems) it.y += POW_FALL_SPEED * DT;
    this.powItems = this.powItems.filter((it) => it.y < WORLD_H + 20);
  }

  // ---------------- collisions ----------------
  _checkCollisions() {
    // player bullets vs enemies
    for (const b of this.bullets) {
      if (b.dead) continue;
      for (const e of this.enemies) {
        if (e.dead) continue;
        const r = e.type === 'boss' ? 26 : e.type === 'midboss' ? 20 : 10;
        if (dist2(b.x, b.y, e.x, e.y) < r * r) {
          b.dead = true; e.hp -= 1;
          const owner = this.players.get(b.owner);
          if (owner) { owner.hits++; this.stats.hits++; }
          this.onEvent({ t: 'hit', enemy: e.kind });
          if (e.hp <= 0 && !e.dead) this._killEnemy(e, b.owner);
          break;
        }
      }
    }
    this.bullets = this.bullets.filter((b) => !b.dead);
    this.enemies = this.enemies.filter((e) => !e.dead);

    // players vs enemies / enemy bullets / pow
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const invuln = p.looping || this.time < p.invulnUntil;
      for (const e of this.enemies) {
        if (e.dead) continue;
        const r = e.type === 'boss' ? 20 : e.type === 'midboss' ? 16 : 8;
        if (dist2(p.x, p.y, e.x, e.y) < r * r) {
          if (invuln) { if (p.looping) p.loopDodges++; continue; }
          this._killPlayer(p);
          if (e.type === 'small') { e.dead = true; }
          break;
        }
      }
      for (const b of this.enemyBullets) {
        if (b.dead) continue;
        if (dist2(p.x, p.y, b.x, b.y) < 8 * 8) {
          if (invuln) { if (p.looping) p.loopDodges++; b.dead = true; continue; }
          b.dead = true;
          this._killPlayer(p);
        }
      }
      for (const it of this.powItems) {
        if (it.dead) continue;
        if (dist2(p.x, p.y, it.x, it.y) < 12 * 12) { it.dead = true; this._applyPow(p, it.type); }
      }
    }
    this.enemies = this.enemies.filter((e) => !e.dead);
    this.enemyBullets = this.enemyBullets.filter((b) => !b.dead);
    this.powItems = this.powItems.filter((it) => !it.dead);
  }

  _killEnemy(e, ownerPid) {
    e.dead = true;
    const owner = this.players.get(ownerPid);
    let score = e.type === 'boss' ? SCORE.boss
      : e.type === 'midboss' ? SCORE.midboss
      : e.type === 'medium' ? SCORE.medium
      : e.isRed ? SCORE.redFormation
      : SCORE.small;
    if (owner) this._awardScore(owner, score);
    if (owner) owner.kills++;
    this.onEvent({ t: 'kill', enemy: e.kind, pid: ownerPid });
    if (e.type === 'boss') this.onEvent({ t: 'boss-down' });
    if (e.type === 'midboss') this.onEvent({ t: 'midboss-down' });

    if (e.isRed) {
      // red formation drop rule: when the last member of a red formation group dies, drop a POW.
      const alive = this.enemies.filter((x) => x.groupId === e.groupId && x !== e && !x.dead).length;
      if (alive === 0) {
        this._spawnPow(e.x, e.y);
        this.onEvent({ t: 'red-formation-clear' });
      }
    }
  }

  _killPlayer(p) {
    p.alive = false;
    p.hitThisStage = true;
    this.onEvent({ t: 'player-death', pid: p.pid });
    p.lives -= 1;
    if (p.lives <= 0) {
      p.alive = false;
      this.onEvent({ t: 'player-out', pid: p.pid });
    } else {
      // respawn after a short delay handled by room.js calling respawnPlayer(); here we just mark it
      p.respawnAt = this.time + 1.2;
      p.side = false; p.fourway = false;
      p.loops = RESPAWN_LOOPS; // "replenished on death"
    }
  }

  respawnDue() {
    const out = [];
    for (const p of this.players.values()) {
      if (!p.alive && p.lives > 0 && p.respawnAt && this.time >= p.respawnAt) out.push(p);
    }
    return out;
  }
  respawnPlayer(p) {
    p.alive = true; p.x = WORLD_W / 2; p.y = WORLD_H - 80;
    p.invulnUntil = this.time + RESPAWN_INVULN_MS / 1000;
    p.respawnAt = null;
  }

  _spawnPow(x, y) {
    const type = POW_CYCLE[this.powCount % POW_CYCLE.length];
    this.powCount++;
    this.powItems.push({ id: uid(), x, y, type });
  }

  _applyPow(p, type) {
    this.onEvent({ t: 'pow', pid: p.pid, powType: type });
    switch (type) {
      case 'side': p.side = true; break;
      case 'fourway': p.fourway = true; break;
      case 'bomb':
        for (const e of this.enemies) {
          if (e.dead) continue;
          if (e.type === 'small') { this._killEnemy(e, p.pid); continue; }
          e.hp -= 10;
          if (e.hp <= 0) this._killEnemy(e, p.pid);
        }
        this.onEvent({ t: 'bomb' });
        break;
      case 'loop': p.loops += 1; break;
      case 'bonus': this._awardScore(p, POW_BONUS_POINTS); break;
      case 'life': p.lives += 1; this.onEvent({ t: '1up', pid: p.pid }); break;
      default: break;
    }
  }

  _awardScore(p, amount) {
    const before = p.score;
    p.score += amount;
    for (const th of EXTRA_LIFE_SCORES) {
      if (before < th && p.score >= th) { p.lives += 1; this.onEvent({ t: '1up', pid: p.pid, reason: 'score' }); }
    }
  }

  // ---------------- stage flow ----------------
  _checkStageEnd() {
    if (this.stagePhase !== 'playing') return;
    const allWavesIssued = this.waveCursor >= this.stage.waves.length;
    if (!allWavesIssued) return;
    if (isBossStage(this.stageNumber)) {
      const bossAlive = this.enemies.some((e) => e.type === 'boss');
      const safetyTimeout = this.stageTime > stageSeconds(this.stageNumber) * 3 + 90;
      if (bossAlive && !safetyTimeout) return;
    } else {
      const lastAt = this.stage.waves[this.stage.waves.length - 1]?.at || 0;
      if (this.stageTime < lastAt + 5) return;
    }
    this._clearStage();
  }

  _clearStage() {
    const tally = [];
    for (const p of this.players.values()) {
      const acc = p.shotsFired ? Math.round((p.hits / p.shotsFired) * 100) : 0;
      const bonus = acc * SCORE.stageBonusPerAccuracy;
      this._awardScore(p, bonus);
      tally.push({ pid: p.pid, shotsFired: p.shotsFired, hits: p.hits, accuracy: acc, bonus, untouched: !p.hitThisStage, score: p.score, lives: p.lives });
      p.shotsFired = 0; p.hits = 0; p.hitThisStage = false;
    }
    this.onEvent({ t: 'stage-clear', stage: this.stageNumber, tally, coop: this.players.size > 1 });
    if (this.stageNumber <= 1) {
      this.stagePhase = 'victory';
      this.onEvent({ t: 'victory' });
      return;
    }
    this.stagePhase = 'clear';
    this.phaseTimer = 4;
  }

  _advanceStage() {
    this.stageNumber -= 1;
    this.stageTime = 0;
    this.waveCursor = 0;
    this.stage = stageFor(this.stageNumber);
    this.enemies = []; this.enemyBullets = []; this.bullets = []; this.powItems = [];
    this.stagePhase = 'playing';
    this.onEvent({ t: 'stage-start', stage: this.stageNumber, name: this.stage.name });
  }

  allPlayersOut() { return this.players.size > 0 && [...this.players.values()].every((p) => !p.alive && p.lives <= 0); }

  /** Serializable snapshot for the client renderer. */
  snapshot() {
    return {
      time: this.time, stageNumber: this.stageNumber, stageName: this.stage.name, stagePhase: this.stagePhase,
      players: [...this.players.values()].map((p) => ({
        pid: p.pid, x: p.x, y: p.y, alive: p.alive, lives: p.lives, score: p.score, loops: p.loops,
        looping: p.looping, invuln: this.time < p.invulnUntil, side: p.side, fourway: p.fourway, slot: p.slot,
      })),
      bullets: this.bullets.map((b) => ({ x: b.x, y: b.y })),
      enemyBullets: this.enemyBullets.map((b) => ({ x: b.x, y: b.y })),
      enemies: this.enemies.map((e) => ({ id: e.id, kind: e.kind, type: e.type, x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp })),
      powItems: this.powItems.map((it) => ({ x: it.x, y: it.y, type: it.type })),
    };
  }
}
