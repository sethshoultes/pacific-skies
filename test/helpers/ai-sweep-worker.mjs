// Runs a slice of AI vs AI matches off the main thread for test/ai.test.js's 50-seed sweep, on raw
// drafts (the sweep measures the pilots, not the builder, and building would multiply its cost).
import { parentPort, workerData } from 'node:worker_threads';
import { playAiMatch } from '../../shared/ai/match.js';
import { draftStage } from '../../shared/ai/builder.js';

parentPort.postMessage(workerData.jobs.map(({ seed, levels, stageCount }) => playAiMatch({
  seed, levels, stages: Array.from({ length: stageCount }, (_, depth) => draftStage({ seed, depth })),
})));
