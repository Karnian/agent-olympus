import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { reapReleasedGroup } from '../lib/codex-release-reaper.mjs';

const REAPER = fileURLToPath(new URL('../lib/codex-release-reaper.mjs', import.meta.url));

/**
 * Drive reapReleasedGroup() against a simulated leader. While the leader is
 * alive its PID reports `liveIdentity`; once it is gone the PID reports null.
 */
function scenario({
  startId = 'a',
  liveIdentity = 'a',
  leaderExitsAt = Infinity,
  killEndsLeader = false,
  groupSurvives = false,
  deadlineMs = 1000,
} = {}) {
  let t = 0;
  let killed = false;
  const signals = [];
  const leaderAlive = () => !killed && t < leaderExitsAt;
  return reapReleasedGroup({
    pid: 4100,
    startId,
    deadlineMs,
    pollMs: 50,
    graceMs: 100,
    now: () => t,
    sleep: async (ms) => { t += ms; },
    alive: leaderAlive,
    readStartId: () => (leaderAlive() ? liveIdentity : null),
    groupAlive: () => groupSurvives,
    killGroup: (pid, signal) => {
      signals.push(signal);
      if (killEndsLeader) killed = true;
    },
  }).then((outcome) => ({ outcome, signals }));
}

test('reaper: SIGTERMs the group once the leader exits on its own', async () => {
  const { outcome, signals } = await scenario({ leaderExitsAt: 200 });
  assert.equal(outcome, 'reaped');
  assert.deepEqual(signals, ['SIGTERM'], 'no SIGKILL once the group is empty');
});

test('reaper: SIGKILLs a descendant that survives the group SIGTERM', async () => {
  const { outcome, signals } = await scenario({ leaderExitsAt: 200, groupSurvives: true });
  assert.equal(outcome, 'reaped');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('reaper: reaps survivors after a natural exit even without a start identity', async () => {
  const { outcome, signals } = await scenario({ startId: null, leaderExitsAt: 200 });
  assert.equal(outcome, 'reaped');
  assert.deepEqual(signals, ['SIGTERM']);
});

test('reaper: terminates a verified teardown that outlives the deadline', async () => {
  const { outcome, signals } = await scenario({ groupSurvives: true });
  assert.equal(outcome, 'terminated');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('reaper: escalates on the group even after the leader dies to SIGTERM', async () => {
  const { outcome, signals } = await scenario({ killEndsLeader: true, groupSurvives: true });
  assert.equal(outcome, 'terminated');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('reaper: never signals a recycled PID', async () => {
  const { outcome, signals } = await scenario({ liveIdentity: 'someone-else', groupSurvives: true });
  assert.equal(outcome, 'reused');
  assert.deepEqual(signals, []);
});

test('reaper: without a parent-captured identity it never adopts the live PID (review on 5678e87)', async () => {
  // Codex exited and its PID now belongs to another process before the reaper
  // could see it. The reaper must not treat that process as the original.
  const { outcome, signals } = await scenario({
    startId: null,
    liveIdentity: 'replacement-process',
    groupSurvives: true,
  });
  assert.equal(outcome, 'unverified');
  assert.deepEqual(signals, []);
});

test('reaper: an unreadable current identity blocks deadline termination (review on 5678e87)', async () => {
  const { outcome, signals } = await scenario({
    startId: 'original-process',
    liveIdentity: null,
    groupSurvives: true,
  });
  assert.equal(outcome, 'unverified');
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
