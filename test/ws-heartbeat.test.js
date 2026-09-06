import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heartbeat } from '../server/ws-heartbeat.js';

function fakeSocket(isAlive) {
  return {
    isAlive,
    terminated: false,
    pinged: false,
    terminate() { this.terminated = true; },
    ping() { this.pinged = true; },
  };
}

test('heartbeat terminates a client that never ponged since the last sweep', () => {
  const dead = fakeSocket(false);
  heartbeat([dead]);
  assert.equal(dead.terminated, true);
  assert.equal(dead.pinged, false, 'a terminated client should not also be pinged');
});

test('heartbeat pings a live client and resets isAlive to false for the next sweep', () => {
  const alive = fakeSocket(true);
  heartbeat([alive]);
  assert.equal(alive.terminated, false);
  assert.equal(alive.pinged, true);
  assert.equal(alive.isAlive, false, 'isAlive must reset so a missed pong next sweep terminates it');
});

test('one throwing socket does not abort the sweep for the rest of the clients', () => {
  const throwsOnTerminate = fakeSocket(false);
  throwsOnTerminate.terminate = () => { throw new Error('socket already closed'); };
  const throwsOnPing = fakeSocket(true);
  throwsOnPing.ping = () => { throw new Error('socket already closed'); };
  const healthyAfter = fakeSocket(true);

  assert.doesNotThrow(() => heartbeat([throwsOnTerminate, throwsOnPing, healthyAfter]));
  assert.equal(healthyAfter.pinged, true, 'a client after a throwing one must still be swept');
});

test('an empty client list is a no-op', () => {
  assert.doesNotThrow(() => heartbeat([]));
});
