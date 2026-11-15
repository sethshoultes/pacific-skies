// Runs a slice of AI vs AI matches off the main thread for test/ai.test.js's 50-seed sweep.
import { parentPort, workerData } from 'node:worker_threads';
import { playAiMatch } from '../../shared/ai/match.js';

parentPort.postMessage(workerData.jobs.map((job) => playAiMatch(job)));
