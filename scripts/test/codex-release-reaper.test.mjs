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

function run(overrides) {
  const signals = [];
  const clock = fakeClock();
  const promise = reapReleasedGroup({
    pid: 4100,
    startId: 'a',
    readStartId: () => 'a',
    groupAlive: () => false,
    killGroup: (pid, signal) => signals.push([pid, signal]),
    ...clock,
    ...overrides,
  });
  return promise.then((outcome) => ({ outcome, signals }));
}

test('reaper: SIGTERMs the group once the leader exits on its own', async () => {
  let polls = 0;
  const { outcome, signals } = await run({ alive: () => ++polls < 3 });
  assert.equal(outcome, 'reaped');
  assert.deepEqual(signals, [[4100, 'SIGTERM']], 'no SIGKILL once the group is empty');
});

test('reaper: SIGKILLs a descendant that survives the group SIGTERM', async () => {
  const { outcome, signals } = await run({ alive: () => false, groupAlive: () => true });
  assert.equal(outcome, 'reaped');
  assert.deepEqual(signals, [[4100, 'SIGTERM'], [4100, 'SIGKILL']]);
});

test('reaper: terminates a teardown that outlives the deadline', async () => {
  const { outcome, signals } = await run({
    deadlineMs: 1000,
    alive: () => true,
    groupAlive: () => true,
  });
  assert.equal(outcome, 'terminated');
  assert.deepEqual(signals, [[4100, 'SIGTERM'], [4100, 'SIGKILL']]);
});

test('reaper: escalates on the group even after the leader dies to SIGTERM', async () => {
  let leaderAlive = true;
  const signals = [];
  const { outcome } = await run({
    deadlineMs: 500,
    alive: () => leaderAlive,
    readStartId: () => (leaderAlive ? 'a' : null),
    groupAlive: () => true, // a descendant ignores SIGTERM
    killGroup: (pid, signal) => { signals.push([pid, signal]); leaderAlive = false; },
  });
  assert.equal(outcome, 'terminated');
  assert.deepEqual(signals, [[4100, 'SIGTERM'], [4100, 'SIGKILL']]);
});

test('reaper: never signals a recycled PID', async () => {
  const { outcome, signals } = await run({ alive: () => true, readStartId: () => 'someone-else' });
  assert.equal(outcome, 'reused');
  assert.deepEqual(signals, []);
});

test('reaper: without a start identity it never terminates a live PID at the deadline', async () => {
  const { outcome, signals } = await run({
    startId: null,
    deadlineMs: 500,
    alive: () => true,
    readStartId: () => null,
    groupAlive: () => true,
  });
  assert.equal(outcome, 'unverified');
  assert.deepEqual(signals, []);
});

test('reaper: reads the start identity itself when launched without one', async () => {
  const reads = [];
  const { outcome, signals } = await run({
    startId: null,
    alive: () => true,
    readStartId: () => { reads.push(1); return reads.length === 1 ? 'a' : 'someone-else'; },
  });
  assert.equal(outcome, 'reused');
  assert.deepEqual(signals, []);
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

test('reaper CLI: SIGKILLs a descendant that ignores SIGTERM', { skip: process.platform === 'win32' }, async () => {
  const leader = spawn('sh', ['-c', "sh -c 'trap \"\" TERM; while :; do sleep 1; done' & echo $!; sleep 0.3"], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const descendantPid = await new Promise((resolve) => {
    leader.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())));
  });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    const status = await new Promise((resolve) => {
      const reaper = spawn(process.execPath, [REAPER, String(leader.pid)], { stdio: 'ignore' });
      reaper.on('exit', resolve);
    });
    assert.equal(status, 0);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(descendantPid), false, 'the SIGTERM-resistant descendant was killed');
  } finally {
    try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});
