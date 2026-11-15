// Tuning for the pure engine. Every duration is in ticks and every speed in px per tick, so the
// engine never reads a clock. Neutral names; the Stormglass art and names arrive in S2.

export const TICK_RATE = 30;
export const WORLD_W = 384;
export const WORLD_H = 576;

// move index -> unit direction: none, then N, NE, E, SE, S, SW, W, NW
export const MOVES = [[0, 0], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];

export const PILOT_SPEED = 5;
export const PILOT_R = 5;
export const START_LIVES = 3;
export const MAX_LIVES = 5;
export const RESPAWN_TICKS = 36;
export const SPAWN_INVULN_TICKS = 54;
export const SPAWN_Y = WORLD_H - 80;

// dash: a short invulnerable sidestep on a cooldown
export const DASH_TICKS = 6;
export const DASH_SPEED = 13;
export const DASH_COOLDOWN_TICKS = 75;

export const FIRE_COOLDOWN_TICKS = 5;
export const SHOT_SPEED = 14;
export const SHOT_R = 3;
export const MAX_SHOTS = 12;
export const MAX_POWER = 2;

export const SPARK_SPEED = 3.6;
export const SPARK_R = 3;

export const ENEMY = {
  drone: { hp: 1, r: 9, speed: 1.9, score: 100, fireEvery: 110 },
  heavy: { hp: 4, r: 12, speed: 1.3, score: 300, fireEvery: 40 },
  boss: { r: 28, speed: 1.5, score: 5000, fireEvery: 24, holdY: 120 },
};
export const ENEMY_KINDS = ['drone', 'heavy'];
export const PATHS = ['straight', 'sine', 'sweep-left', 'sweep-right', 'dive'];

export const PICKUP_R = 10;
export const PICKUP_FALL = 2.2;
export const PICKUP_POINTS = 500;
export const DRONE_DROP_CHANCE = 0.08;
// cumulative weights for a dropped pickup's kind
export const PICKUP_TABLE = [['power', 0.4], ['dash', 0.65], ['points', 0.95], ['life', 1]];

export const STAGE_CLEAR_BONUS = 1000;
export const BOSS_TIMEOUT_TICKS = 20 * TICK_RATE; // a boss not downed by then escapes
export const CLEAR_TICKS = 60;
