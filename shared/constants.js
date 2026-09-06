// Shared tuning constants for the authoritative simulation (server/game/sim.js) and the client
// renderer (client/game.js, client/sprites.js). Nothing here touches the DOM or the network.

export const TICK_RATE = 30;           // server sim ticks/sec -- shooters need tighter timing than a dungeon crawler
export const DT = 1 / TICK_RATE;

// World / viewport. The player's screen is fixed size (no camera pan side to side); only the
// background scrolls vertically. Units are pixels, drawn on an 8x8/16x16 pixel-tile grid.
export const WORLD_W = 384;   // 24 tiles of 16px
export const WORLD_H = 576;   // 36 tiles of 16px
export const TILE = 16;

export const SCROLL_BASE = 60;         // px/sec the ocean scrolls at on stage 1
export const SCROLL_STAGE_STEP = 1.1;  // px/sec added per stage of difficulty (see difficultyFor())

// ---- player (Super Ace, P-38-style twin-boom fighter) ----
export const PLANE_W = 14;
export const PLANE_H = 16;
export const PLANE_SPEED = 150;        // px/sec, 8-directional
export const PLANE_HALF = 7;

export const START_LIVES = 3;
export const EXTRA_LIFE_SCORES = [30000, 100000, 200000, 400000]; // score thresholds for a 1UP
export const START_LOOPS = 3;
export const LOOP_MS = 1200;           // duration of a loop-the-loop
export const LOOP_COOLDOWN_MS = 300;   // can't re-trigger instantly after one ends
export const RESPAWN_INVULN_MS = 1800; // brief invulnerability after dying
export const RESPAWN_LOOPS = 3;        // loops replenished on death (per spec)

// ---- weapons ----
export const SHOT_SPEED = 340;
export const SHOT_COOLDOWN_MS = 160;   // autofire rate cap (base, single shot)
export const SHOT_COOLDOWN_MS_4WAY = 190;
export const ENEMY_SHOT_SPEED = 110;   // slow round shots
export const MAX_PLAYER_SHOTS = 6;

// ---- POW item cycle (cycles by pickup count, arcade-style) ----
// side: two escort fighters that flank and fire alongside you
// fourway: double/4-way spread shot
// bomb: destroys every enemy currently on screen
// loop: +1 loop charge
// life: 1UP
// bonus: flat points
export const POW_CYCLE = ['side', 'fourway', 'bomb', 'loop', 'bonus', 'life'];
export const POW_FALL_SPEED = 70;
export const POW_BONUS_POINTS = 2000;

// ---- enemies ----
export const ENEMY_SMALL_HP = 1;
export const ENEMY_MEDIUM_HP = 4;
export const ENEMY_MIDBOSS_HP = 40;
export const ENEMY_BOSS_HP = 120;
export const ENEMY_TOUCH_DAMAGE = 1; // contact with a plane or bullet = death for the player

export const SCORE = {
  small: 100,
  medium: 300,
  redFormation: 150,
  midboss: 3000,
  boss: 10000,
  stageBonusPerAccuracy: 50, // multiplied by accuracy% at stage clear
};

export const STAGE_COUNT = 32;
export const STAGE_SECONDS_MIN = 60;
export const STAGE_SECONDS_MAX = 90;

// Difficulty ramp: higher stage number displayed but LOWER remaining count means harder (we
// count down from 32 to 1). Internally we key everything by `stageIndex` = stages remaining
// (32..1), and difficulty scales with (STAGE_COUNT - stageIndex), i.e. how far into the run.
export function difficultyFor(stageIndex) {
  const depth = STAGE_COUNT - stageIndex; // 0 on stage 32, 31 on stage 1
  return {
    speedMul: 1 + depth * 0.035,
    shotMul: 1 + depth * 0.05,
    fireRateMul: Math.max(0.35, 1 - depth * 0.02),
  };
}

export const MAX_PLAYERS = 2;
