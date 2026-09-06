// Unit tests for waitExit() in server.mjs -- specifically the "child already exited before we
// started waiting" case that motivated extracting it as its own exported function (see the
// docstring on waitExit in server.mjs). These exercise it directly with fake child/exited
// objects, without ever booting the real game server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitExit } from './server.mjs';

test('waitExit resolves promptly when the child already exited before waitExit was called', async () => {
  // Simulates the exact bug this function fixes: the exit-tracking promise settled earlier (e.g.
  // a startup failure, or a crash mid-test), so waitExit must not hang waiting on a fresh
  // subscription to an event that already fired.
  const exited = Promise.resolve([0, null]);
  const fakeChild = { exitCode: 0, pid: 12345 };
  const start = Date.now();
  await waitExit(fakeChild, exited, 5000);
  assert.ok(Date.now() - start < 1000, 'must resolve almost immediately, not wait for the full timeout');
});

test('waitExit escalates to SIGKILL if the child is still alive after the grace period', async () => {
  const originalKill = process.kill;
  let killedPid = null;
  let resolveExited;
  const exited = new Promise((resolve) => { resolveExited = resolve; });
  process.kill = (pid, signal) => {
    killedPid = pid;
    assert.equal(signal, 'SIGKILL');
    resolveExited([137, 'SIGKILL']); // simulate the process actually dying once killed
  };
  try {
    const fakeChild = { exitCode: null, pid: 99999 };
    await waitExit(fakeChild, exited, 20);
    assert.equal(killedPid, 99999, 'must escalate to SIGKILL for the still-alive child');
  } finally {
    process.kill = originalKill;
  }
});

test('waitExit does not attempt to kill a child that has no pid (already gone)', async () => {
  const originalKill = process.kill;
  let killCalled = false;
  process.kill = () => { killCalled = true; };
  try {
    const exited = new Promise(() => {}); // deliberately never resolves
    const fakeChild = { exitCode: null, pid: null };
    await waitExit(fakeChild, exited, 20);
    assert.equal(killCalled, false, 'no pid means nothing to kill -- must not call process.kill');
  } finally {
    process.kill = originalKill;
  }
});
