// Builds a slice of stages off the main thread for test/builder.test.js's 200-seed sweep.
import { parentPort, workerData } from 'node:worker_threads';
import { buildStage } from '../../shared/ai/builder.js';

parentPort.postMessage(workerData.jobs.map(({ seed, depth }) => {
  const { check, attempt } = buildStage({ seed, depth });
  return { seed, depth, check, attempt };
}));
