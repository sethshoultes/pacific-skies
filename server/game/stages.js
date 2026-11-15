// One worker thread builds every room's stages, one room at a time, so a burst of new rooms never
// blocks the tick loop. A room that closed while it waited in the queue is skipped.
import { Worker } from 'node:worker_threads';

let worker = null;
let busy = null;
const queue = [];

function start() {
  worker = new Worker(new URL('./build-worker.js', import.meta.url));
  worker.on('message', (m) => {
    const job = busy;
    busy = null;
    if (m.error) job.reject(new Error(m.error)); else job.resolve(m.stages);
    pump();
  });
  worker.on('error', (e) => {
    const job = busy;
    busy = null;
    worker = null;
    job?.reject(e);
    pump();
  });
}

function pump() {
  while (!busy && queue.length) {
    const job = queue.shift();
    if (job.cancelled()) { job.resolve(null); continue; }
    if (!worker) start();
    busy = job;
    worker.ref();
    worker.postMessage({ seed: job.seed, count: job.count });
  }
  if (!busy && worker) worker.unref(); // an idle builder never holds the process open
}

/** Resolves to `count` built stages for `seed`, or null if `cancelled()` turned true first. */
export function buildStages(seed, count, cancelled = () => false) {
  return new Promise((resolve, reject) => {
    queue.push({ seed, count, cancelled, resolve, reject });
    pump();
  });
}
