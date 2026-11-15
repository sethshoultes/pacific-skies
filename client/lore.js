// Squallkite names. Weather-courier kites carry sealed storms between the glass towers of a sky
// archipelago; rogue lightning drones and cloud-eating dreadnoughts want the storms back.

export const KITES = ['Tinderwing', 'Quillfeather'];

// The engine knows two enemy kinds and five paths; a drone's look follows its path.
export const LOOKS = {
  fizzlet: { name: 'Fizzlet', about: 'a spark-burr that falls in rows and stoops' },
  arcwisp: { name: 'Arcwisp', about: 'a violet curl that weaves in braids' },
  shearling: { name: 'Shearling', about: 'a crescent that rakes in from the edge' },
  thunderhead: { name: 'Thunderhead', about: 'a slow, sullen cloud that fires fans of sparks' },
  anvilback: { name: 'The Anvilback', about: 'a cloud-eating dreadnought with a forge for a heart' },
  'nimbus-maw': { name: 'The Nimbus Maw', about: 'a dreadnought that swallows whole weather fronts' },
};

const DRONE_LOOK = { straight: 'fizzlet', dive: 'fizzlet', sine: 'arcwisp', 'sweep-left': 'shearling', 'sweep-right': 'shearling' };

/** Which look an engine enemy wears; a boss takes its stage's form. */
export function lookOf(enemy, stage) {
  if (enemy.kind === 'boss') return stage?.boss?.form ?? 'anvilback';
  if (enemy.kind === 'heavy') return 'thunderhead';
  return DRONE_LOOK[enemy.path] ?? 'fizzlet';
}

export const PICKUP_GLYPH = { power: '+', dash: '»', points: '◆', life: '♥' };
