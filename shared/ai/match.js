// Headless AI vs AI: one pilot per level, on seeded stages, until the match ends or hits its cap.
// A pilot re-decides every LEVELS[level].period ticks and holds its move (without the dash) between.
import { createMatch, step, isOver, matchTickBound } from '../engine/index.js';
import { seedStage } from '../engine/stages-seed.js';
import { pilotAction, LEVELS } from './pilot.js';

export function playAiMatch({ seed, levels, stageCount = 6 }) {
  const stages = Array.from({ length: stageCount }, (_, depth) => seedStage(seed, depth));
  const cap = matchTickBound(stages);
  let state = createMatch({ seed, stages, seats: levels.length });
  const held = levels.map(() => ({ move: 0, fire: false, dash: false }));
  while (!isOver(state) && state.tick < cap) {
    const actions = levels.map((level, seat) => {
      held[seat] = state.tick % LEVELS[level].period === 0
        ? pilotAction(state, seat, level)
        : { ...held[seat], dash: false };
      return held[seat];
    });
    state = step(state, actions).state;
  }
  return {
    seed, levels, ticks: state.tick, cap, ended: isOver(state), result: state.phase,
    stageReached: state.stageIndex + 1, stageCount, scores: state.pilots.map((p) => p.score),
  };
}
