import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { reapReleasedGroup } from '../lib/codex-release-reaper.mjs';

const REAPER = fileURLToPath(new URL('../lib/codex-release-reaper.mjs', import.meta.url));

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test('reaper: SIGTERMs the group once the leader exits on its own', async () => {
  const clock = fakeClock();
  let polls = 0;
  const signals = [];
  const outcome = await reapReleasedGroup({
    pid: 4100,
    startId: 'a',
    alive: () => ++polls < 3,
    readStartId: () => 'a',
    killGroup: (pid, signal) => signals.push([pid, signal]),
    ...clock,
  });
  assert.equal(outcome, 'reaped');
  assert.deepEqual(signals, [[4100, 'SIGTERM']]);
});

test('reaper: terminates a teardown that outlives the deadline', async () => {
  const clock = fakeClock();
  const signals = [];
  const outcome = await reapReleasedGroup({
    pid: 4200,
    deadlineMs: 1000,
    alive: () => true,
    killGroup: (pid, signal) => signals.push([pid, signal]),
    ...clock,
  });
  assert.equal(outcome, 'terminated');
  assert.deepEqual(signals, [[4200, 'SIGTERM'], [4200, 'SIGKILL']]);
});

test('reaper: skips SIGKILL when the leader exits during the grace period', async () => {
  const clock = fakeClock();
  const signals = [];
  let terminated = false;
  const outcome = await reapReleasedGroup({
    pid: 4300,
    deadlineMs: 500,
    alive: () => !terminated,
    killGroup: (pid, signal) => { signals.push([pid, signal]); terminated = true; },
    ...clock,
  });
  assert.equal(outcome, 'terminated');
  assert.deepEqual(signals, [[4300, 'SIGTERM']]);
});

test('reaper: never signals a recycled PID', async () => {
  const clock = fakeClock();
  const signals = [];
  const outcome = await reapReleasedGroup({
    pid: 4400,
    startId: 'original',
    alive: () => true,
    readStartId: () => 'someone-else',
    killGroup: (pid, signal) => signals.push([pid, signal]),
    ...clock,
  });
  assert.equal(outcome, 'reused');
  assert.deepEqual(signals, []);
});

test('reaper: an unreadable start identity is not treated as reuse', async () => {
  const clock = fakeClock();
  let polls = 0;
  const signals = [];
  const outcome = await reapReleasedGroup({
    pid: 4500,
    startId: 'a',
    alive: () => ++polls < 2,
    readStartId: () => null,
    killGroup: (pid, signal) => signals.push([pid, signal]),
    ...clock,
  });
  assert.equal(outcome, 'reaped');
  assert.deepEqual(signals, [[4500, 'SIGTERM']]);
});

test('reaper CLI: reaps a descendant that outlives its detached group leader', { skip: process.platform === 'win32' }, async () => {
  // Leader exits after 0.3s, leaving a long `sleep` in the same process group:
  // the lingering tool-call descendant from issue #74.
  const leader = spawn('sh', ['-c', 'sleep 30 & echo $!; sleep 0.3'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const descendantPid = await new Promise((resolve) => {
    leader.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())));
  });
  assert.ok(Number.isInteger(descendantPid));

  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    // Run the reaper asynchronously so this process keeps reaping the exited
    // leader; a blocked event loop would leave it a zombie that looks alive.
    const status = await new Promise((resolve) => {
      const reaper = spawn(process.execPath, [REAPER, String(leader.pid)], { stdio: 'ignore' });
      reaper.on('exit', resolve);
    });
    assert.equal(status, 0);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(descendantPid), false, 'the lingering descendant was reaped');
  } finally {
    try { process.kill(descendantPid, 'SIGKILL'); } catch { /* already gone */ }
  }
});
