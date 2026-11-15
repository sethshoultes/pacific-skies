#!/usr/bin/env node
// Headless 2-seat AI match: node scripts/ai-vs-ai.mjs --seed N --level hard [--stages 6]
import { parseArgs } from 'node:util';
import { playAiMatch } from '../shared/ai/match.js';
import { LEVELS } from '../shared/ai/pilot.js';

const { values } = parseArgs({
  options: { seed: { type: 'string', default: '1' }, level: { type: 'string', default: 'hard' }, stages: { type: 'string', default: '6' } },
});
if (!LEVELS[values.level]) {
  console.error(`--level must be one of ${Object.keys(LEVELS).join(', ')}`);
  process.exit(2);
}
console.log(JSON.stringify(playAiMatch({ seed: values.seed, levels: [values.level, values.level], stageCount: Number(values.stages) })));
