// Headless AI vs AI: one pilot per level, on the given stages, until the match ends or hits its cap.
// A pilot re-decides every LEVELS[level].period ticks and holds its move (without the dash) between.
import { createMatch, step, isOver, matchTickBound } from '../engine/index.js';
import { pilotAction, LEVELS } from './pilot.js';

export function playAiMatch({ seed, levels, stages }) {
  const cap = matchTickBound(stages);
  let state = createMatch({ seed, stages, seats: levels.length });
  const held = levels.map(() => ({ move: 0, fire: false, dash: false }));
  let deaths = 0;
  let bossesDowned = 0;
  while (!isOver(state) && state.tick < cap) {
    const actions = levels.map((level, seat) => {
      held[seat] = state.tick % LEVELS[level].period === 0
        ? pilotAction(state, seat, level)
        : { ...held[seat], dash: false };
      return held[seat];
    });
    const r = step(state, actions);
    state = r.state;
    for (const e of r.events) {
      if (e.t === 'death') deaths++;
      else if (e.t === 'boss-down') bossesDowned++;
    }
  }
  return {
    seed, levels, ticks: state.tick, cap, ended: isOver(state), result: state.phase,
    stageReached: state.stageIndex + 1, stageCount: stages.length, scores: state.pilots.map((p) => p.score),
    deaths, bossesDowned,
  };
}
