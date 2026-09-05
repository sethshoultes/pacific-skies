// Achievement catalogue + unlock-checking, mirrored from the sibling project's shared/achievements.js.
// A stat crossing a threshold (or a one-shot event bumping a counter to >=1) unlocks an achievement.
export const ACHIEVEMENTS = [
  { id: 'first_kill', name: 'First Kill', desc: 'Shoot down your first enemy plane.', stat: 'kills', threshold: 1 },
  { id: 'ace', name: 'Ace', desc: 'Shoot down 100 enemy planes.', stat: 'kills', threshold: 100 },
  { id: 'formation_breaker', name: 'Formation Breaker', desc: 'Wipe out 10 red formations.', stat: 'red_formations', threshold: 10 },
  { id: 'loop_master', name: 'Loop Master', desc: 'Dodge 50 bullets while looping.', stat: 'loop_dodges', threshold: 50 },
  { id: 'untouchable', name: 'Untouchable', desc: 'Clear a stage without being hit.', stat: 'untouched_stages', threshold: 1 },
  { id: 'ayako_down', name: 'Ayako Down', desc: 'Destroy your first boss bomber.', stat: 'bosses', threshold: 1 },
  { id: 'wingman', name: 'Wingman', desc: 'Clear a stage in co-op.', stat: 'coop_stage_clears', threshold: 1 },
  { id: 'marathon', name: 'Marathon', desc: 'Clear 10 stages in a single run.', stat: 'stages_cleared_run_max', threshold: 10 },
  { id: 'insert_coin', name: 'Insert Coin', desc: 'Use a continue.', stat: 'continues', threshold: 1 },
  { id: 'deep_run_24', name: 'Deep Run: Saipan', desc: 'Reach stage 24.', stat: 'deepest_stage_reached', threshold: 8 }, // stored as "stages cleared" = 32-24
  { id: 'deep_run_16', name: 'Deep Run: Okinawa', desc: 'Reach stage 16.', stat: 'deepest_stage_reached', threshold: 16 },
  { id: 'deep_run_8', name: 'Deep Run: Kobe', desc: 'Reach stage 8.', stat: 'deepest_stage_reached', threshold: 24 },
  { id: 'deep_run_1', name: 'Deep Run: Tokyo', desc: 'Reach stage 1 (win the game).', stat: 'deepest_stage_reached', threshold: 31 },
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
