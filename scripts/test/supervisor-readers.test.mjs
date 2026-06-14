/**
 * Unit tests for the supervisor-reader helpers in worker-spawn.mjs (F1 — P3).
 * Direct, deterministic tests with hand-written snapshots (no chdir, no live
 * adapters). node:test, zero deps.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isSupervisorWorker,
  probePidLiveness,
  monitorSupervisorWorker,
  shutdownSupervisorWorker,
  monitorTeam,
  collectResults,
} from '../lib/worker-spawn.mjs';
import { writeSnapshot, snapshotPath, outputPath, HEARTBEAT_STALE_MS } from '../lib/supervisor-state.mjs';
import { atomicWriteFileSync } from '../lib/fs-atomic.mjs';
import { readProcStartId } from '../lib/proc-identity.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RUN = 'a1b2c3d4a1b2c3d4';
const WRK = 'b2c3d4e5b2c3d4e5';
const SELF = process.pid;
const SELF_ID = readProcStartId(SELF);

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'ao-supread-'));
  return Promise.resolve(fn(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

function mkWorker(over = {}) {
  return {
    name: 'w', type: 'codex', _adapterName: 'codex-exec',
    startedAt: new Date().toISOString(),
    _handle: { workerRunId: WRK, supervisorPid: SELF, supervisorStartId: SELF_ID, ...(over._handle || {}) },
    ...over,
  };
}
function mkState(root, over = {}) {
  return { runId: RUN, projectRoot: root, workers: [], ...over };
}
function putSnap(root, snap, now = Date.now()) {
  writeSnapshot(snapshotPath(root, RUN, WRK), { runId: RUN, workerRunId: WRK, supervisorPid: SELF, supervisorStartId: SELF_ID, ...snap }, now);
}

// ---------------------------------------------------------------------------
// isSupervisorWorker — the dormancy gate
// ---------------------------------------------------------------------------

test('isSupervisorWorker: true only with the full explicit descriptor', () => {
  const root = '/p';
  assert.equal(isSupervisorWorker(mkState(root), mkWorker()), true);
  // Each missing piece → false (so existing adapter/tmux workers stay dormant).
  assert.equal(isSupervisorWorker(mkState(root, { runId: undefined }), mkWorker()), false);
  assert.equal(isSupervisorWorker(mkState(root, { projectRoot: undefined }), mkWorker()), false);
  assert.equal(isSupervisorWorker(mkState(root), mkWorker({ _handle: { workerRunId: undefined, supervisorPid: SELF } })), false);
  assert.equal(isSupervisorWorker(mkState(root), mkWorker({ _handle: { workerRunId: WRK, supervisorPid: undefined } })), false);
  assert.equal(isSupervisorWorker(mkState(root), { name: 'w' }), false, 'no _handle');
});

// ---------------------------------------------------------------------------
// probePidLiveness — tri-state
// ---------------------------------------------------------------------------

test('probePidLiveness: identity match → alive; mismatch → dead; missing pid → dead', () => {
  if (SELF_ID) {
    assert.equal(probePidLiveness(SELF, SELF_ID), 'alive', 'matching identity');
    assert.equal(probePidLiveness(SELF, 'definitely-not-the-real-id'), 'dead', 'mismatched identity → reused/dead');
  }
  assert.equal(probePidLiveness(999999, 'x'), 'dead', 'nonexistent pid');
  assert.equal(probePidLiveness(1, 'x'), 'dead', 'pid<=1');
  // No recorded startId → existence probe → alive-unverified for a live pid.
  assert.equal(probePidLiveness(SELF, null), 'alive-unverified');
});

// ---------------------------------------------------------------------------
// monitorSupervisorWorker — snapshot → MonitorResult
// ---------------------------------------------------------------------------

test('monitor: completed snapshot → completed + output tail', async () => {
  await withRoot((root) => {
    putSnap(root, { status: 'completed', outputTail: 'DONE-OUTPUT' });
    const r = monitorSupervisorWorker(mkState(root), mkWorker(), Date.now());
    assert.equal(r.status, 'completed');
    assert.equal(r.output, 'DONE-OUTPUT');
  });
});

test('monitor: failed snapshot preserves the error category', async () => {
  await withRoot((root) => {
    putSnap(root, { status: 'failed', error: { category: 'auth_failed', message: 'bad key' } });
    const r = monitorSupervisorWorker(mkState(root), mkWorker(), Date.now());
    assert.equal(r.status, 'failed');
    assert.equal(r.error.category, 'auth_failed');
  });
});

test('monitor: cancelled snapshot → failed + category cancelled', async () => {
  await withRoot((root) => {
    putSnap(root, { status: 'cancelled', error: { category: 'cancelled', message: 'SIGTERM' } });
    const r = monitorSupervisorWorker(mkState(root), mkWorker(), Date.now());
    assert.equal(r.status, 'failed');
    assert.equal(r.error.category, 'cancelled');
  });
});

test('monitor: running + LIVE supervisor + fresh heartbeat → running', async () => {
  await withRoot((root) => {
    putSnap(root, { status: 'running', outputTail: 'working...' });
    const r = monitorSupervisorWorker(mkState(root), mkWorker(), Date.now());
    assert.equal(r.status, 'running');
  });
});

test('monitor: running + STALE heartbeat → running on poll 1, crash on poll 2 (2-poll confirm)', async () => {
  await withRoot((root) => {
    const old = Date.now() - (HEARTBEAT_STALE_MS + 5000);
    putSnap(root, { status: 'running' }, old); // alive pid, no recent heartbeat
    const worker = mkWorker();
    const r1 = monitorSupervisorWorker(mkState(root), worker, Date.now());
    assert.equal(r1.status, 'running', 'a single stale observation must not crash a maybe-paused worker');
    assert.equal(r1._staleSeen, true);
    worker._supStaleSeen = true; // monitorTeam latches this between polls
    const r2 = monitorSupervisorWorker(mkState(root), worker, Date.now());
    assert.equal(r2.status, 'failed');
    assert.equal(r2.error.category, 'crash');
  });
});

test('monitor: running + DEAD supervisor → failed (crash)', async () => {
  await withRoot((root) => {
    // Snapshot claims running but its supervisorPid is a dead pid with a
    // non-matching identity → the supervisor is gone.
    putSnap(root, { status: 'running', supervisorPid: 999999, supervisorStartId: 'gone' });
    const worker = mkWorker({ _handle: { workerRunId: WRK, supervisorPid: 999999, supervisorStartId: 'gone' } });
    const r = monitorSupervisorWorker(mkState(root), worker, Date.now());
    assert.equal(r.status, 'failed');
    assert.equal(r.error.category, 'crash');
  });
});

test('monitor: missing snapshot within startup grace → running', async () => {
  await withRoot((root) => {
    const r = monitorSupervisorWorker(mkState(root), mkWorker(), Date.now());
    assert.equal(r.status, 'running'); // started just now, no snapshot yet
  });
});

test('monitor: missing snapshot past grace → failed (crash) even if the pid is alive', async () => {
  await withRoot((root) => {
    // startedAt well past the startup grace, supervisorPid alive (SELF) — but no
    // snapshot was ever written, so the supervisor failed to come up.
    const worker = mkWorker({ startedAt: new Date(Date.now() - 60_000).toISOString() });
    const r = monitorSupervisorWorker(mkState(root), worker, Date.now());
    assert.equal(r.status, 'failed');
    assert.equal(r.error.category, 'crash');
  });
});

test('monitor: missing snapshot with a FUTURE startedAt → failed (no unbounded running)', async () => {
  await withRoot((root) => {
    // A future-dated startedAt makes age negative; that must NOT count as "within
    // startup grace" forever.
    const worker = mkWorker({ startedAt: new Date(Date.now() + 3_600_000).toISOString() });
    const r = monitorSupervisorWorker(mkState(root), worker, Date.now());
    assert.equal(r.status, 'failed');
    assert.equal(r.error.category, 'crash');
  });
});

test('monitor: snapshot for a DIFFERENT run (mismatch) → failed (not trusted)', async () => {
  await withRoot((root) => {
    // Snapshot written with a different runId → readSnapshot(expected) → mismatch.
    writeSnapshot(snapshotPath(root, RUN, WRK), { runId: 'ffffffffffffffff', workerRunId: WRK, supervisorPid: SELF, status: 'completed' }, Date.now());
    const r = monitorSupervisorWorker(mkState(root), mkWorker(), Date.now());
    assert.equal(r.status, 'failed');
  });
});

// ---------------------------------------------------------------------------
// shutdownSupervisorWorker — supervisor-first kill + adapter orphan reap
// ---------------------------------------------------------------------------

function spawnDetached() {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  c.unref();
  return c;
}
async function groupDead(pid) {
  for (let i = 0; i < 200; i++) {
    try { process.kill(-pid, 0); } catch { return true; }
    await sleep(20);
  }
  return false;
}

test('shutdownSupervisorWorker: kills the supervisor AND reaps a surviving adapter group', async () => {
  await withRoot(async (root) => {
    const sup = spawnDetached();   // stand-in supervisor (won't clean up its "adapter")
    const adp = spawnDetached();   // stand-in adapter that survives phase 1
    try {
      const worker = mkWorker({ _handle: { workerRunId: WRK, supervisorPid: sup.pid, supervisorStartId: readProcStartId(sup.pid) } });
      // Snapshot records the adapter pid the orchestrator must reap if the
      // supervisor didn't clean it up.
      writeSnapshot(snapshotPath(root, RUN, WRK), {
        runId: RUN, workerRunId: WRK, status: 'running',
        supervisorPid: sup.pid, supervisorStartId: readProcStartId(sup.pid),
        adapterPid: adp.pid, adapterStartId: readProcStartId(adp.pid),
      }, Date.now());

      assert.doesNotThrow(() => process.kill(-sup.pid, 0), 'supervisor alive before');
      assert.doesNotThrow(() => process.kill(-adp.pid, 0), 'adapter alive before');

      await shutdownSupervisorWorker(mkState(root), worker);

      assert.equal(await groupDead(sup.pid), true, 'supervisor group reaped');
      assert.equal(await groupDead(adp.pid), true, 'surviving adapter group reaped');
    } finally {
      for (const c of [sup, adp]) { try { process.kill(-c.pid, 'SIGKILL'); } catch {} }
    }
  });
});

test('shutdownSupervisorWorker (P5 launch race): kills the supervisor with NO snapshot yet', async () => {
  // shutdownTeam fires right after spawnTeam, before the supervisor wrote its
  // first snapshot. Phase 1 must still kill the supervisor by its recorded pid
  // (Phase 2's snapshot re-read is a no-op when missing). The supervisor's own
  // SIGTERM handler is what shuts the adapter down in this window.
  await withRoot(async (root) => {
    const sup = spawnDetached();
    try {
      const worker = mkWorker({ _handle: { workerRunId: WRK, supervisorPid: sup.pid, supervisorStartId: readProcStartId(sup.pid) } });
      // Deliberately NO writeSnapshot — the file does not exist yet.
      assert.doesNotThrow(() => process.kill(-sup.pid, 0), 'supervisor alive before');

      await shutdownSupervisorWorker(mkState(root), worker); // must not throw on the missing snapshot

      assert.equal(await groupDead(sup.pid), true, 'supervisor reaped via pid alone (no snapshot)');
    } finally {
      try { process.kill(-sup.pid, 'SIGKILL'); } catch {}
    }
  });
});

test('shutdownSupervisorWorker (P5): idempotent — a second call on an already-dead supervisor is a safe no-op', async () => {
  await withRoot(async (root) => {
    const sup = spawnDetached();
    const worker = mkWorker({ _handle: { workerRunId: WRK, supervisorPid: sup.pid, supervisorStartId: readProcStartId(sup.pid) } });
    writeSnapshot(snapshotPath(root, RUN, WRK), {
      runId: RUN, workerRunId: WRK, status: 'running',
      supervisorPid: sup.pid, supervisorStartId: readProcStartId(sup.pid),
    }, Date.now());

    await shutdownSupervisorWorker(mkState(root), worker);
    assert.equal(await groupDead(sup.pid), true, 'supervisor dead after first shutdown');

    // Second call: the pid is gone (and its identity no longer matches). Must not
    // throw, and must not signal a recycled pid (startId check protects it).
    await assert.doesNotReject(shutdownSupervisorWorker(mkState(root), worker),
      'a duplicate shutdown must be a safe no-op');
  });
});

// ---------------------------------------------------------------------------
// monitorTeam / collectResults wiring (disk team-state, fresh-process model)
// ---------------------------------------------------------------------------

test('monitorTeam + collectResults: read a supervisor worker via disk snapshot/output', async () => {
  await withRoot((root) => {
    const origCwd = process.cwd();
    process.chdir(root); // monitorTeam/collectResults use relative .ao/state
    try {
      const state = {
        teamName: 'sup', phase: 'running', runId: RUN, projectRoot: root,
        workers: [mkWorker({ status: 'running' })],
      };
      mkdirSync(join(root, '.ao', 'state'), { recursive: true });
      writeFileSync(join(root, '.ao', 'state', 'team-sup.json'), JSON.stringify(state));
      putSnap(root, { status: 'completed', outputTail: 'TAIL' });
      atomicWriteFileSync(outputPath(root, RUN, WRK), 'FULL-DURABLE-OUTPUT');

      const status = monitorTeam('sup');
      assert.equal(status.workers[0].status, 'completed', 'monitorTeam reads the snapshot');

      const results = collectResults('sup');
      assert.equal(results.w, 'FULL-DURABLE-OUTPUT', 'collectResults reads the durable output file');
    } finally {
      process.chdir(origCwd);
    }
  });
});
