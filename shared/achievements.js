// Achievement catalogue + unlock-checking. A stat crossing a threshold (or a one-shot event bumping
// a counter to >=1) unlocks an achievement.
export const ACHIEVEMENTS = [
  { id: 'first_kill', name: 'First Spark', desc: 'Bring down your first drone.', stat: 'kills', threshold: 1 },
  { id: 'ace', name: 'Stormbreaker', desc: 'Bring down 100 drones.', stat: 'kills', threshold: 100 },
  { id: 'thunder_tamer', name: 'Thunder Tamer', desc: 'Bring down 10 thunderheads.', stat: 'thunderheads', threshold: 10 },
  { id: 'slipstream', name: 'Slipstream', desc: 'Dash 50 times.', stat: 'dashes', threshold: 50 },
  { id: 'untouchable', name: 'Untouchable', desc: 'Clear a stage without being hit.', stat: 'untouched_stages', threshold: 1 },
  { id: 'dreadnought_down', name: 'Dreadnought Down', desc: 'Bring down your first dreadnought.', stat: 'bosses', threshold: 1 },
  { id: 'wingman', name: 'Wingman', desc: 'Clear a stage flying together, with a friend or an AI wingman.', stat: 'coop_stage_clears', threshold: 1 },
  { id: 'every_storm', name: 'Every Storm Sealed', desc: 'Clear six stages in a single run.', stat: 'stages_cleared_run_max', threshold: 6 },
  { id: 'second_wind', name: 'Second Wind', desc: 'Take a continue.', stat: 'continues', threshold: 1 },
  { id: 'into_the_squall', name: 'Into the Squall', desc: 'Reach stage 3.', stat: 'deepest_stage', threshold: 3 },
  { id: 'eye_of_the_storm', name: 'Eye of the Storm', desc: 'Reach stage 6.', stat: 'deepest_stage', threshold: 6 },
];

/** Given a stat key just bumped to `value`, and the set of achievement ids already unlocked,
 *  return the achievement defs newly crossed (in catalogue order). */
export function newlyUnlocked(key, value, already) {
  const out = [];
  for (const a of ACHIEVEMENTS) {
    if (a.stat !== key) continue;
    if (already.has(a.id)) continue;
    if (value >= a.threshold) out.push(a);
  }
  return out;
}
