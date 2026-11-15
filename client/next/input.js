// Input mapping, kept pure so it is tested: keys and drags become the engine's Action.
// Move indexes follow rules.js MOVES: 0 none, then N, NE, E, SE, S, SW, W, NW.

const KEY_DIR = {
  ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1],
  ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0],
};
export const FIRE_KEYS = ['Space'];
export const DASH_KEYS = ['ShiftLeft', 'ShiftRight'];
export const GAME_KEYS = [...Object.keys(KEY_DIR), ...FIRE_KEYS, ...DASH_KEYS];

/** The 8-way move nearest a vector; 0 inside the dead zone. */
export function moveFromVector(dx, dy, dead = 0) {
  if (Math.hypot(dx, dy) <= dead) return 0;
  const a = Math.atan2(dx, -dy); // 0 is north, clockwise
  return ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8 + 1;
}

/** Held key codes (a Set of KeyboardEvent.code) to an Action. Dash only when `canDash`. */
export function keysToAction(held, canDash) {
  let dx = 0;
  let dy = 0;
  for (const code of held) {
    const d = KEY_DIR[code];
    if (d) { dx += d[0]; dy += d[1]; }
  }
  return {
    move: moveFromVector(Math.sign(dx), Math.sign(dy)),
    fire: FIRE_KEYS.some((k) => held.has(k)),
    dash: canDash && DASH_KEYS.some((k) => held.has(k)),
  };
}

/**
 * A touch drag to an Action. The kite chases the point the finger has dragged it to (its position
 * when the touch began plus the finger's travel, in world units), so the thumb never covers it;
 * a touch auto-fires.
 */
export function dragToAction(pilot, target, dashPressed, canDash) {
  return {
    move: moveFromVector(target.x - pilot.x, target.y - pilot.y, 3),
    fire: true,
    dash: canDash && dashPressed,
  };
}
