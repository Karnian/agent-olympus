import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  loadConcurrencyLimits,
  readActiveConcurrencyCounts,
  releaseConcurrencyReservation,
  releaseHookConcurrency,
  reserveWorkerBatchConcurrency,
  validateWorkerBatchConcurrency,
} from '../lib/concurrency-limits.mjs';
import { spawnTeam } from '../lib/worker-spawn.mjs';
import { snapshotPath, writeSnapshot } from '../lib/supervisor-state.mjs';

function temporaryDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), 'ao-concurrency-limits-'));
}

const LEDGER_CHILD = fileURLToPath(new URL('./fixtures/concurrency-ledger-child.mjs', import.meta.url));
const CONCURRENCY_GATE = fileURLToPath(new URL('../concurrency-gate.mjs', import.meta.url));

async function waitForFiles(files, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!files.every(file => existsSync(file))) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for: ${files.join(', ')}`);
    await sleep(10);
  }
}

function waitForExit(child) {
  if (child.exitCode != null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit, rejectExit) => {
    child.once('exit', resolveExit);
    child.once('error', rejectExit);
  });
}

function runGate(cwd, toolName) {
  const result = spawnSync(process.execPath, [CONCURRENCY_GATE], {
    cwd,
    input: JSON.stringify({
      tool_name: toolName,
      tool_input: { subagent_type: 'agent-olympus:executor' },
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      AO_CONCURRENCY_GLOBAL: '1',
      AO_CONCURRENCY_CLAUDE: '1',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

describe('shared concurrency limits', () => {
  it('loads JSONC configuration and applies environment overrides', () => {
    const root = temporaryDirectory();
    try {
      mkdirSync(path.join(root, 'config'));
      writeFileSync(path.join(root, 'config', 'model-routing.jsonc'), `{
        // shared by hooks and adapter batches
        "concurrency": {
          "maxParallelTasks": 7,
          "maxClaudeWorkers": 6,
          "maxCodexWorkers": 4,
          "maxGeminiWorkers": 3
        }
      }`);
      assert.deepEqual(loadConcurrencyLimits({
        pluginRoot: root,
        env: { AO_CONCURRENCY_CODEX: '2' },
      }), { global: 7, claude: 6, codex: 2, gemini: 3 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts only fresh provider tasks and fails closed on corrupt state', () => {
    const root = temporaryDirectory();
    try {
      const stateDir = path.join(root, '.ao', 'state');
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const now = Date.now();
      writeFileSync(path.join(stateDir, 'ao-concurrency.json'), JSON.stringify({
        activeTasks: [
          { id: 'fresh', provider: 'claude', startedAt: new Date(now - 1000).toISOString() },
          { id: 'stale', provider: 'codex', startedAt: new Date(now - 10 * 60 * 1000).toISOString() },
        ],
      }), { mode: 0o600 });
      assert.deepEqual(readActiveConcurrencyCounts(root, { now }), {
        global: 1, claude: 1, codex: 0, gemini: 0,
      });
      writeFileSync(path.join(stateDir, 'ao-concurrency.json'), '{broken', { mode: 0o600 });
      assert.equal(readActiveConcurrencyCounts(root).global, Infinity);
      const denied = reserveWorkerBatchConcurrency(root, [{ name: 'unsafe', type: 'claude' }], {
        teamName: 'unsafe-team',
        runId: 'cccccccccccccccc',
        limits: { global: 10, claude: 10, codex: 10, gemini: 10 },
      });
      assert.equal(denied.ok, false);
      assert.equal(denied.unsafe, true);
      assert.match(denied.errors.join('\n'), /malformed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('checks global and post-demotion provider batch counts', () => {
    const result = validateWorkerBatchConcurrency([
      { type: 'claude' },
      { type: 'claude' },
    ], {
      limits: { global: 2, claude: 2, codex: 1, gemini: 1 },
      active: { global: 1, claude: 0, codex: 1, gemini: 0 },
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /global concurrency limit exceeded/);
  });

  it('fails closed on an unsafe ledger artifact', () => {
    const root = temporaryDirectory();
    try {
      const limits = { global: 2, claude: 2, codex: 2, gemini: 2 };
      const first = reserveWorkerBatchConcurrency(root, [{ name: 'one', type: 'claude' }], {
        teamName: 'unsafe-mode', runId: 'ffffffffffffffff', limits,
      });
      assert.equal(first.ok, true);
      chmodSync(path.join(root, '.ao', 'state', 'ao-concurrency.json'), 0o644);
      assert.equal(readActiveConcurrencyCounts(root).global, Infinity);
      const second = reserveWorkerBatchConcurrency(root, [{ name: 'two', type: 'claude' }], {
        teamName: 'unsafe-mode-two', runId: 'eeeeeeeeeeeeeeee', limits,
      });
      assert.equal(second.ok, false);
      assert.equal(second.unsafe, true);
      assert.match(second.errors.join('\n'), /unsafe/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('spawnTeam denies an oversized adapter batch before any launch', async () => {
    const root = temporaryDirectory();
    try {
      await assert.rejects(
        spawnTeam('bounded-team', [
          { name: 'one', type: 'claude', prompt: 'one' },
          { name: 'two', type: 'claude', prompt: 'two' },
        ], root, { hasClaudeCli: true }, {
          runId: '0123456789abcdef',
          env: { AO_CONCURRENCY_GLOBAL: '1', AO_CONCURRENCY_CLAUDE: '1' },
          activeConcurrency: { global: 0, claude: 0, codex: 0, gemini: 0 },
          spawnSupervisor() {
            throw new Error('must not launch');
          },
        }),
        /spawnTeam concurrency denied/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('atomically admits only one of two concurrent processes and releases it cross-process', async () => {
    const root = temporaryDirectory();
    const start = path.join(root, 'start');
    const finish = path.join(root, 'finish');
    const readyA = path.join(root, 'ready-a');
    const readyB = path.join(root, 'ready-b');
    const resultA = path.join(root, 'result-a.json');
    const resultB = path.join(root, 'result-b.json');
    const releaseResult = path.join(root, 'release.json');
    let childA;
    let childB;
    try {
      childA = spawn(process.execPath, [
        LEDGER_CHILD, 'reserve', root, 'racer-a', readyA, start, resultA, finish,
      ], { stdio: 'ignore' });
      childB = spawn(process.execPath, [
        LEDGER_CHILD, 'reserve', root, 'racer-b', readyB, start, resultB, finish,
      ], { stdio: 'ignore' });
      await waitForFiles([readyA, readyB]);
      writeFileSync(start, 'go', { mode: 0o600 });
      await waitForFiles([resultA, resultB]);

      const results = [resultA, resultB].map(file => JSON.parse(readFileSync(file, 'utf8')));
      assert.equal(results.filter(result => result.ok).length, 1);
      assert.equal(results.filter(result => !result.ok).length, 1);
      const ledgerPath = path.join(root, '.ao', 'state', 'ao-concurrency.json');
      assert.equal(JSON.parse(readFileSync(ledgerPath, 'utf8')).activeTasks.length, 1);

      const winner = results.find(result => result.ok);
      const releaser = spawn(process.execPath, [
        LEDGER_CHILD, 'release', root, winner.reservationId, '', '', releaseResult, '',
      ], { stdio: 'ignore' });
      await waitForFiles([releaseResult]);
      assert.equal(await waitForExit(releaser), 0);
      const released = JSON.parse(readFileSync(releaseResult, 'utf8'));
      assert.deepEqual({ ok: released.ok, released: released.released }, { ok: true, released: 1 });
      assert.equal(JSON.parse(readFileSync(ledgerPath, 'utf8')).activeTasks.length, 0);
    } finally {
      try { writeFileSync(finish, 'done', { mode: 0o600 }); } catch {}
      if (childA) await waitForExit(childA).catch(() => {});
      if (childB) await waitForExit(childB).catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('shares atomic admission between Task/Agent hooks and detached workers', () => {
    const root = temporaryDirectory();
    try {
      assert.deepEqual(runGate(root, 'Task'), {});
      const blockedAgent = runGate(root, 'Agent');
      assert.equal(blockedAgent.decision, 'block');
      assert.match(blockedAgent.reason, /concurrency limit exceeded/);

      const detached = reserveWorkerBatchConcurrency(root, [{ name: 'detached', type: 'claude' }], {
        teamName: 'detached-team',
        runId: 'dddddddddddddddd',
        limits: { global: 1, claude: 1, codex: 1, gemini: 1 },
      });
      assert.equal(detached.ok, false);

      assert.equal(releaseHookConcurrency(root, { provider: 'claude' }).released, 1);
      const admitted = reserveWorkerBatchConcurrency(root, [{ name: 'detached', type: 'claude' }], {
        teamName: 'detached-team',
        runId: 'dddddddddddddddd',
        limits: { global: 1, claude: 1, codex: 1, gemini: 1 },
      });
      assert.equal(admitted.ok, true, admitted.errors?.join('; '));
      assert.equal(releaseConcurrencyReservation(root, admitted.reservationId).released, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reclaims a detached reservation only after durable worker terminal state', () => {
    const root = temporaryDirectory();
    try {
      const limits = { global: 1, claude: 1, codex: 1, gemini: 1 };
      const first = reserveWorkerBatchConcurrency(root, [{ name: 'worker-a', type: 'claude' }], {
        teamName: 'team-a', runId: 'aaaaaaaaaaaaaaaa', limits,
      });
      assert.equal(first.ok, true);
      const teamPath = path.join(root, '.ao', 'state', 'team-team-a.json');
      writeFileSync(teamPath, JSON.stringify({
        runId: 'aaaaaaaaaaaaaaaa',
        workers: [{
          name: 'worker-a',
          status: 'completed',
          _concurrencyEntryId: first.entryIds[0],
        }],
      }), { mode: 0o600 });

      const second = reserveWorkerBatchConcurrency(root, [{ name: 'worker-b', type: 'claude' }], {
        teamName: 'team-b', runId: 'bbbbbbbbbbbbbbbb', limits,
      });
      assert.equal(second.ok, true, second.errors?.join('; '));
      assert.equal(readActiveConcurrencyCounts(root).global, 1);
      assert.equal(releaseConcurrencyReservation(root, second.reservationId).released, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reclaims from a generation-bound terminal supervisor snapshot before team polling', () => {
    const root = temporaryDirectory();
    try {
      const limits = { global: 1, claude: 1, codex: 1, gemini: 1 };
      const runId = 'aaaaaaaaaaaaaaaa';
      const workerRunId = 'eeeeeeeeeeeeeeee';
      const first = reserveWorkerBatchConcurrency(root, [{ name: 'worker-a', type: 'claude' }], {
        teamName: 'team-a', runId, limits,
      });
      assert.equal(first.ok, true);
      writeFileSync(path.join(root, '.ao', 'state', 'team-team-a.json'), JSON.stringify({
        runId,
        projectRoot: root,
        workers: [{
          name: 'worker-a',
          status: 'running',
          _concurrencyEntryId: first.entryIds[0],
          _handle: { workerRunId },
        }],
      }), { mode: 0o600 });
      writeSnapshot(snapshotPath(root, runId, workerRunId), {
        runId,
        workerRunId,
        status: 'completed',
        supervisorPid: process.pid,
      });

      const second = reserveWorkerBatchConcurrency(root, [{ name: 'worker-b', type: 'claude' }], {
        teamName: 'team-b', runId: 'bbbbbbbbbbbbbbbb', limits,
      });
      assert.equal(second.ok, true, second.errors?.join('; '));
      assert.equal(releaseConcurrencyReservation(root, second.reservationId).released, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when durable team liveness is malformed and hook release cannot steal its slot', () => {
    const root = temporaryDirectory();
    try {
      const limits = { global: 1, claude: 1, codex: 1, gemini: 1 };
      const first = reserveWorkerBatchConcurrency(root, [{ name: 'worker-a', type: 'claude' }], {
        teamName: 'team-a', runId: 'aaaaaaaaaaaaaaaa', limits,
      });
      assert.equal(first.ok, true);
      writeFileSync(path.join(root, '.ao', 'state', 'team-team-a.json'), '{broken', { mode: 0o600 });

      const hookRelease = releaseHookConcurrency(root, { provider: 'claude', isSubagentStop: true });
      assert.deepEqual({ ok: hookRelease.ok, released: hookRelease.released }, { ok: true, released: 0 });
      const denied = reserveWorkerBatchConcurrency(root, [{ name: 'worker-b', type: 'claude' }], {
        teamName: 'team-b', runId: 'bbbbbbbbbbbbbbbb', limits,
      });
      assert.equal(denied.ok, false);
      assert.match(denied.errors.join('\n'), /concurrency limit exceeded/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
