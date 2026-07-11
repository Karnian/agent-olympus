/**
 * Integration tests for scripts/lib/worker-spawn.mjs spawnTeam().
 *
 * Uses the `_inject` parameter on spawnTeam to supply a fake `spawnSupervisor`
 * (recording the detached-supervisor launch instead of spawning a real child)
 * and fake tmux session creation. Verifies the end-to-end wiring:
 *   1. permission resolution (host sandbox intersection)
 *   2. codex worker demotion when level = 'suggest'
 *   3. `level`/`model` forwarding into the supervisor manifest
 *   4. adapter selection routes post-demotion
 *   5. team state shape after spawn (serializable supervisor descriptor)
 *
 * Unit tests for each helper live in `worker-spawn.test.mjs`; this file is
 * specifically for end-to-end `spawnTeam()` invocations.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  collectResults,
  dispatchProviderFallback,
  monitorTeam,
  planProviderFailover,
  readProcStartId,
  shutdownTeam,
  spawnTeam,
} from '../lib/worker-spawn.mjs';
import { manifestPath as supManifestPath, snapshotPath as supSnapshotPath, outputPath as supOutputPath, writeSnapshot as supWriteSnapshot, readSnapshot as supReadSnapshot } from '../lib/supervisor-state.mjs';

const WORKER_SPAWN_PATH = fileURLToPath(new URL('../lib/worker-spawn.mjs', import.meta.url));

// ─── Fake adapter factory ─────────────────────────────────────────────────────

/**
 * Build a fake `spawnSupervisor` that records every launch. Tests inject the
 * returned `spawnSupervisor` via `_inject.spawnSupervisor`; it reads the DATA
 * manifest spawnTeam wrote and records into `calls` (mapping adapterName +
 * level/model) so the wiring can be asserted without spawning real processes.
 */
function makeFakeAdapters() {
  const calls = {
    codexExecSpawn: [],
    codexAppServerStart: [],
    codexAppServerInit: [],
    codexAppServerCreateThread: [],
    codexAppServerStartTurn: [],
    claudeCliSpawn: [],
    geminiExecSpawn: [],
    geminiAcpStart: [],
    geminiAcpInit: [],
    geminiAcpCreateSession: [],
    geminiAcpSendPrompt: [],
  };

  // FLIP (P4): spawnTeam now launches a DETACHED supervisor instead of spawning
  // adapters in-process. This recorder stands in for that launch — it reads the
  // DATA manifest spawnTeam wrote and records the SAME `calls` shape (mapping
  // adapterName + level/model), so the existing wiring assertions still hold
  // without spawning real processes or real adapters.
  let _supPid = 900000;
  const spawnSupervisor = (_script, manifestPath, _opts) => {
    let m = {};
    try { m = JSON.parse(readFileSync(manifestPath, 'utf-8')); } catch { /* leave empty */ }
    const rec = { prompt: m.prompt, opts: { level: m.level, model: m.model, approvalMode: m.approvalMode } };
    switch (m.adapterName) {
      case 'codex-exec': calls.codexExecSpawn.push(rec); break;
      case 'codex-appserver':
        calls.codexAppServerStart.push({ opts: {} });
        calls.codexAppServerCreateThread.push({ opts: { level: m.level } });
        calls.codexAppServerStartTurn.push({ prompt: m.prompt });
        break;
      case 'claude-cli': calls.claudeCliSpawn.push(rec); break;
      case 'gemini-exec': calls.geminiExecSpawn.push(rec); break;
      case 'gemini-acp':
        calls.geminiAcpStart.push({ opts: {} });
        calls.geminiAcpCreateSession.push({ opts: { approvalMode: m.approvalMode, model: m.model } });
        calls.geminiAcpSendPrompt.push({ prompt: m.prompt });
        break;
      default: break;
    }
    return { pid: ++_supPid };
  };

  return { calls, spawnSupervisor };
}

// ─── Temp workspace helper ────────────────────────────────────────────────────

/**
 * Build an isolated workspace so:
 *   - permission detection is hermetic (cwd + HOME redirected)
 *   - wisdom.mjs writes go to <tmp>/.ao/wisdom.jsonl, NOT the repo's
 *     (wisdom.mjs and worker-spawn.mjs use process.cwd()-relative paths,
 *     so we MUST process.chdir() into the temp dir for the duration of
 *     the test)
 *   - AO_HOST_SANDBOX_LEVEL env is cleared
 *
 * Returns { cwd, cleanup, writeAutonomy(...) }.
 */
function makeWorkspace(allow = ['Bash(*)', 'Write(*)']) {
  const cwd = mkdtempSync(join(tmpdir(), 'ao-spawn-it-'));
  const home = mkdtempSync(join(tmpdir(), 'ao-spawn-it-home-'));
  const origCwd = process.cwd();
  const origHome = process.env.HOME;
  const origAoLevel = process.env.AO_HOST_SANDBOX_LEVEL;

  // Redirect cwd BEFORE any code reads .ao/state or wisdom paths
  process.chdir(cwd);
  process.env.HOME = home;
  delete process.env.AO_HOST_SANDBOX_LEVEL;

  // Seed permissions.allow
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  writeFileSync(
    join(cwd, '.claude', 'settings.local.json'),
    JSON.stringify({ permissions: { allow: allow } }),
  );

  // Isolated .ao so wisdom writes don't pollute the repo
  mkdirSync(join(cwd, '.ao'), { recursive: true });

  return {
    cwd,
    cleanup() {
      // Restore state BEFORE removing the directory to avoid EBUSY
      process.chdir(origCwd);
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      if (origAoLevel === undefined) delete process.env.AO_HOST_SANDBOX_LEVEL;
      else process.env.AO_HOST_SANDBOX_LEVEL = origAoLevel;
      try { rmSync(cwd, { recursive: true, force: true }); } catch {}
      try { rmSync(home, { recursive: true, force: true }); } catch {}
    },
    writeAutonomy(cfg) {
      writeFileSync(join(cwd, '.ao', 'autonomy.json'), JSON.stringify(cfg));
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('spawnTeam integration: codex worker with full-auto host → codex-exec receives level=full-auto', async () => {
  const ws = makeWorkspace(['Bash(*)', 'Write(*)']);
  try {
    const { calls, spawnSupervisor } = makeFakeAdapters();
    const workers = [{ type: 'codex', name: 'c1', prompt: 'do it' }];
    const caps = { hasCodexExecJson: true, hasCodexAppServer: false };

    const state = await spawnTeam('team-1', workers, ws.cwd, caps, {
      spawnSupervisor,
    });

    assert.equal(calls.codexExecSpawn.length, 1, 'codex-exec.spawn should be called exactly once');
    assert.equal(calls.codexExecSpawn[0].opts.level, 'full-auto',
      'level should be full-auto because host has Bash(*)+Write(*)');
    assert.equal(state.workers[0].status, 'running');
    assert.equal(state.workers[0]._adapterName, 'codex-exec');
  } finally {
    ws.cleanup();
  }
});

test('spawnTeam integration: codex worker with Write(*) only host → level=auto-edit', async () => {
  const ws = makeWorkspace(['Write(*)']);
  try {
    const { calls, spawnSupervisor } = makeFakeAdapters();
    const workers = [{ type: 'codex', name: 'c1', prompt: 'do it' }];
    const caps = { hasCodexExecJson: true };

    await spawnTeam('team-2', workers, ws.cwd, caps, { spawnSupervisor });

    assert.equal(calls.codexExecSpawn[0].opts.level, 'auto-edit');
  } finally {
    ws.cleanup();
  }
});

test('spawnTeam integration: codex worker with suggest host → DEMOTED to claude-cli', async () => {
  const ws = makeWorkspace(['Read(*)']); // no Bash, no Write, no Edit → suggest
  try {
    const { calls, spawnSupervisor } = makeFakeAdapters();
    const workers = [{ type: 'codex', name: 'c1', prompt: 'analyze', model: 'gpt-5' }];
    const caps = { hasCodexExecJson: true, hasClaudeCli: true };

    const state = await spawnTeam('team-3', workers, ws.cwd, caps, { spawnSupervisor });

    // Codex path should NOT be called — worker was demoted before adapter selection
    assert.equal(calls.codexExecSpawn.length, 0, 'codex-exec should NOT be called on demoted worker');
    assert.equal(calls.codexAppServerStart.length, 0);
    // Claude-cli should receive the demoted worker
    assert.equal(calls.claudeCliSpawn.length, 1);
    // The provider-specific `model` field must be stripped (the supervisor
    // manifest carries `model: null` for a demoted worker, never the codex name).
    assert.ok(!calls.claudeCliSpawn[0].opts.model,
      'demoted worker must not carry codex model name into claude-cli');

    assert.equal(state.workers[0].type, 'claude');
    assert.equal(state.workers[0]._demotedFrom, 'codex');
    assert.equal(state.workers[0]._demotedModel, 'gpt-5');
    assert.match(state.workers[0]._demotionReason, /suggest/);
  } finally {
    ws.cleanup();
  }
});

test('spawnTeam integration: codex-appserver receives level via createThread', async () => {
  const ws = makeWorkspace(['Bash(*)', 'Write(*)']);
  try {
    const { calls, spawnSupervisor } = makeFakeAdapters();
    const workers = [{ type: 'codex', name: 'c1', prompt: 'ship it' }];
    const caps = { hasCodexExecJson: true, hasCodexAppServer: true };

    await spawnTeam('team-4', workers, ws.cwd, caps, { spawnSupervisor });

    // appserver should win over exec because caps says both
    assert.equal(calls.codexAppServerStart.length, 1);
    assert.equal(calls.codexAppServerCreateThread.length, 1);
    assert.equal(calls.codexAppServerCreateThread[0].opts.level, 'full-auto',
      'createThread should receive level=full-auto for the permission-mirroring path');
    assert.equal(calls.codexAppServerStartTurn.length, 1);
    assert.equal(calls.codexExecSpawn.length, 0);
  } finally {
    ws.cleanup();
  }
});

test('spawnTeam integration: mixed team with codex + claude + gemini', async () => {
  const ws = makeWorkspace(['Bash(*)', 'Write(*)']);
  try {
    const { calls, spawnSupervisor } = makeFakeAdapters();
    const workers = [
      { type: 'codex', name: 'c1', prompt: 'task-1' },
      { type: 'claude', name: 'cl1', prompt: 'task-2' },
      { type: 'gemini', name: 'g1', prompt: 'task-3' },
    ];
    const caps = {
      hasCodexExecJson: true,
      hasClaudeCli: true,
      hasGeminiCli: true,
    };

    const state = await spawnTeam('team-5', workers, ws.cwd, caps, {
      spawnSupervisor,
    });

    assert.equal(calls.codexExecSpawn.length, 1);
    assert.equal(calls.claudeCliSpawn.length, 1);
    assert.equal(calls.geminiExecSpawn.length, 1);
    assert.equal(state.workers.length, 3);
    assert.ok(state.workers.every(w => w.status === 'running'));
  } finally {
    ws.cleanup();
  }
});

test('provider failover integration: exhausted Codex descriptor dispatches Gemini via spawnTeam', async () => {
  const ws = makeWorkspace(['Bash(*)', 'Write(*)']);
  try {
    const { calls, spawnSupervisor } = makeFakeAdapters();
    const capabilities = { hasGeminiCli: true, hasClaudeCli: true };
    const plan = planProviderFailover({
      type: 'codex',
      name: 'retry-worker',
      prompt: 'preserve this exact task',
      model: 'gpt-5',
    }, { category: 'rate_limited', message: 'HTTP 429' }, capabilities);

    const dispatched = await dispatchProviderFallback(
      { ...plan, workerName: 'retry-worker' },
      ws.cwd,
      capabilities,
      {
        teamName: 'failover-gemini-integration',
        spawnInject: { spawnSupervisor },
      },
    );

    assert.equal(dispatched.dispatch, 'provider-team');
    assert.equal(dispatched.state.workers[0]._adapterName, 'gemini-exec');
    assert.equal(calls.geminiExecSpawn.length, 1);
    assert.equal(calls.geminiExecSpawn[0].prompt, 'preserve this exact task');
    assert.equal(calls.geminiExecSpawn[0].opts.model, null);
  } finally {
    ws.cleanup();
  }
});

test('spawnTeam integration: AO_HOST_SANDBOX_LEVEL=read-only downgrades codex to suggest → demote', async () => {
  const ws = makeWorkspace(['Bash(*)', 'Write(*)']);
  try {
    // Explicit host override → read-only → intersection forces 'suggest' →
    // demoteCodexWorkersIfNeeded routes everything to claude-cli.
    process.env.AO_HOST_SANDBOX_LEVEL = 'read-only';

    const { calls, spawnSupervisor } = makeFakeAdapters();
    const workers = [{ type: 'codex', name: 'c1', prompt: 'do it' }];
    const caps = { hasCodexExecJson: true, hasCodexAppServer: true, hasClaudeCli: true };

    await spawnTeam('team-6', workers, ws.cwd, caps, { spawnSupervisor });

    // Codex paths must NOT be called because demotion happens before adapter selection
    assert.equal(calls.codexExecSpawn.length, 0);
    assert.equal(calls.codexAppServerStart.length, 0);
    assert.equal(calls.claudeCliSpawn.length, 1,
      'demoted worker must reach claude-cli');
  } finally {
    ws.cleanup();
  }
});

test('spawnTeam integration: autonomy.codex.approval=auto-edit is intersected with host', async () => {
  const ws = makeWorkspace(['Bash(*)', 'Write(*)']); // would be full-auto
  try {
    ws.writeAutonomy({ codex: { approval: 'auto-edit' } });
    const { calls, spawnSupervisor } = makeFakeAdapters();
    const workers = [{ type: 'codex', name: 'c1', prompt: 'do' }];
    const caps = { hasCodexExecJson: true };

    await spawnTeam('team-7', workers, ws.cwd, caps, { spawnSupervisor });

    // autonomy sets the ceiling to auto-edit → host unknown → effective stays auto-edit
    assert.equal(calls.codexExecSpawn[0].opts.level, 'auto-edit');
  } finally {
    ws.cleanup();
  }
});

test('spawnTeam integration: workers state has _adapterName after spawn', async () => {
  const ws = makeWorkspace(['Bash(*)', 'Write(*)']);
  try {
    const { spawnSupervisor } = makeFakeAdapters();
    const workers = [
      { type: 'codex', name: 'c1', prompt: 'a' },
      { type: 'claude', name: 'cl1', prompt: 'b' },
    ];
    const caps = { hasCodexExecJson: true, hasClaudeCli: true };

    const state = await spawnTeam('team-8', workers, ws.cwd, caps, { spawnSupervisor });

    assert.equal(state.workers[0]._adapterName, 'codex-exec');
    assert.equal(state.workers[1]._adapterName, 'claude-cli');
  } finally {
    ws.cleanup();
  }
});

test('spawnTeam integration: fire-and-forget wisdom warning does not block spawn', async () => {
  // This test just verifies that spawnTeam completes even when host detection
  // signals would trigger a wisdom warning. The warning itself is fire-and-
  // forget and best-effort.
  const ws = makeWorkspace(['Bash(*)', 'Write(*)']);
  try {
    const { calls, spawnSupervisor } = makeFakeAdapters();
    const workers = [{ type: 'codex', name: 'c1', prompt: 'a' }];
    const caps = { hasCodexExecJson: true };

    const state = await spawnTeam('team-9', workers, ws.cwd, caps, { spawnSupervisor });

    assert.equal(state.workers[0].status, 'running');
    assert.equal(calls.codexExecSpawn.length, 1);
  } finally {
    ws.cleanup();
  }
});

// ─── tmux fallback path ────────────────────────────────────────────────────

test('spawnTeam integration: tmux fallback uses injected createTeamSession', async () => {
  const ws = makeWorkspace(['Bash(*)', 'Write(*)']);
  try {
    const { spawnSupervisor } = makeFakeAdapters();
    const tmuxCalls = [];
    const fakeCreateTeamSession = (teamName, tmuxWorkers, cwd) => {
      tmuxCalls.push({ teamName, count: tmuxWorkers.length, cwd });
      return tmuxWorkers.map((w, i) => ({
        session: `ao-fake-${i}`,
        status: 'created',
        worktreePath: `${cwd}/wt-${i}`,
        branchName: `br-${i}`,
        worktreeCreated: true,
      }));
    };
    // When caps says no adapter is available, selectAdapter falls back to tmux.
    const workers = [{ type: 'codex', name: 'c1', prompt: 'fallback' }];
    const caps = {}; // no hasCodexExecJson, no hasCodexAppServer → tmux

    // Downstream tmux spawn may fail without real tmux — we only assert
    // that our injected createTeamSession was called with the right shape.
    try {
      await spawnTeam('team-tmux', workers, ws.cwd, caps, {
        spawnSupervisor,
        validateTmux: () => true,
        createTeamSession: fakeCreateTeamSession,
      });
    } catch {
      // Real tmux binary may not be available; the assertion below still
      // verifies our injection point was reached.
    }

    assert.equal(tmuxCalls.length, 1, 'createTeamSession should be called exactly once');
    assert.equal(tmuxCalls[0].count, 1);
    assert.equal(tmuxCalls[0].teamName, 'team-tmux');
  } finally {
    ws.cleanup();
  }
});

test('spawnTeam integration: validateTmux failure throws clear error', async () => {
  const ws = makeWorkspace(['Bash(*)', 'Write(*)']);
  try {
    const { spawnSupervisor } = makeFakeAdapters();
    const workers = [{ type: 'codex', name: 'c1', prompt: 'a' }];
    const caps = {}; // empty caps → tmux path

    let err;
    try {
      await spawnTeam('team-notmux', workers, ws.cwd, caps, {
        spawnSupervisor,
        validateTmux: () => false,
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'spawnTeam should throw when tmux required but not installed');
    assert.match(err.message, /tmux is not installed/);
  } finally {
    ws.cleanup();
  }
});

// ─── Failure / cleanup paths ───────────────────────────────────────────────
// Adapter-internal failures (init / createThread / spawn errors) now occur
// INSIDE the detached supervisor and surface via the snapshot — covered in
// adapter-worker-supervisor.test.mjs. Here we cover spawnTeam's OWN launch failure.

test('spawnTeam integration: a supervisor launch failure marks the worker failed', async () => {
  const ws = makeWorkspace(['Bash(*)', 'Write(*)']);
  try {
    const workers = [{ type: 'codex', name: 'c1', prompt: 'a' }];
    const caps = { hasCodexExecJson: true };
    const spawnSupervisor = () => { throw new Error('launch boom'); };
    const state = await spawnTeam('team-launchfail', workers, ws.cwd, caps, { spawnSupervisor });
    assert.equal(state.workers[0].status, 'failed');
    assert.match(state.workers[0].error || '', /launch boom/);
  } finally {
    ws.cleanup();
  }
});

test('spawnTeam integration (P5): a spawn handle with no pid is treated as a launch failure', async () => {
  // A real async spawn failure (ENOENT/EAGAIN) returns a handle with
  // pid === undefined. The synchronous pid guard must fail the worker rather
  // than persist an unmonitorable "running" worker with supervisorPid undefined.
  const ws = makeWorkspace(['Bash(*)', 'Write(*)']);
  try {
    const workers = [{ type: 'codex', name: 'c1', prompt: 'a' }];
    const caps = { hasCodexExecJson: true };
    const spawnSupervisor = () => ({ pid: undefined }); // no synchronous throw, but no pid
    const state = await spawnTeam('team-nopid', workers, ws.cwd, caps, { spawnSupervisor });
    assert.equal(state.workers[0].status, 'failed');
    assert.match(state.workers[0].error || '', /no pid/);
    // The pid guard throws BEFORE the _handle assignment, so no unmonitorable
    // supervisor descriptor is persisted.
    assert.equal(state.workers[0]._handle?.supervisorPid, undefined);

    // The prompt-bearing manifest must NOT be left behind on a launch failure
    // (the supervisor never started to clear it).
    const runDir = dirname(supManifestPath(ws.cwd, state.runId, '0'.repeat(16)));
    const leftover = readdirSync(runDir).filter((f) => f.endsWith('.manifest.json'));
    assert.deepEqual(leftover, [], 'a failed launch must clean up its manifest');
  } finally {
    ws.cleanup();
  }
});

// ─── State-serialization regression (_liveHandle strip, upgrade path) ───────
//
// POST-FLIP (P4): spawnTeam launches a DETACHED supervisor and persists only a
// serializable `_handle` ({supervisorPid, supervisorStartId, runId, workerRunId})
// — it never creates an in-process `_liveHandle` anymore. The `_liveHandle`
// strip in saveTeamState (NON_SERIALIZABLE_WORKER_KEYS) is now an UPGRADE
// safety net: a team-*.json written by an OLD version still carries a husk on
// `_liveHandle`, and re-saving it must drop that husk so its leaked `spawnargs`
// (the full prompt) + stream buffers never re-reach disk and a fresh process can
// still kill the real detached group via the serializable `_handle.pid`.

test('spawnTeam regression: persists only a serializable supervisor descriptor (no _liveHandle)', async () => {
  const ws = makeWorkspace(['Bash(*)', 'Write(*)']);
  try {
    const { spawnSupervisor } = makeFakeAdapters();
    const workers = [{ type: 'codex', name: 'c1', prompt: 'benign worker prompt' }];
    const caps = { hasCodexExecJson: true };

    await spawnTeam('rt', workers, ws.cwd, caps, { spawnSupervisor });

    // Re-load exactly as a fresh orchestrator process (separate node invocation) would.
    const loaded = JSON.parse(
      readFileSync(join(ws.cwd, '.ao', 'state', 'team-rt.json'), 'utf-8'),
    );

    // Post-flip there is no in-process live handle to strip — the invariant is
    // that none is ever persisted, and the handle that IS persisted is fully
    // serializable (PIDs + run ids), which is what the fresh-process
    // monitor/shutdown path relies on.
    assert.equal(loaded.workers[0]._liveHandle, undefined,
      '_liveHandle must never be persisted (documented invariant)');
    assert.equal(typeof loaded.workers[0]._handle.supervisorPid, 'number',
      '_handle.supervisorPid must survive for the fresh-process monitor/shutdown path');
    assert.equal(typeof loaded.workers[0]._handle.workerRunId, 'string',
      '_handle.workerRunId must survive to locate the supervisor snapshot/output');
    // The prompt is preserved as a deliberate field (originalPrompt), not lost.
    assert.equal(loaded.workers[0].originalPrompt, 'benign worker prompt');
  } finally {
    ws.cleanup();
  }
});

test('saveTeamState regression: re-saving a legacy _liveHandle husk strips it (upgrade path)', async () => {
  const ws = makeWorkspace(['Bash(*)', 'Write(*)']);
  try {
    const secret = 'LIVEHANDLE_ONLY_SECRET_noleak';
    // A team-*.json written by the OLD in-process spawn path: a JSON husk on
    // _liveHandle carrying spawnargs/stream-buffer secrets (its .kill was already
    // dropped by the original round-trip). The worker's own prompt is deliberately
    // distinct from the secret, so any match in the re-saved file can only come
    // from the leaked husk.
    mkdirSync(join(ws.cwd, '.ao', 'state'), { recursive: true });
    writeFileSync(
      join(ws.cwd, '.ao', 'state', 'team-noleak.json'),
      JSON.stringify({
        teamName: 'noleak', phase: 'running', cwd: ws.cwd,
        workers: [{
          name: 'c1', type: 'codex', status: 'running', _adapterName: 'codex-exec',
          originalPrompt: 'do the benign task',
          _handle: { pid: 999001 },
          _liveHandle: {
            pid: 999001, status: 'running',
            _output: `stream-buffer ${secret}`,
            spawnargs: ['codex', 'exec', '--json', secret],
            process: { pid: 999001, spawnargs: ['codex', 'exec', '--json', secret] },
          },
        }],
      }),
    );

    // monitorTeam loads the legacy state and re-saves it (a running worker flips
    // lastActivityAt → stateChanged), which is the public trigger of the strip.
    monitorTeam('noleak');

    const raw = readFileSync(join(ws.cwd, '.ao', 'state', 'team-noleak.json'), 'utf-8');
    assert.equal(raw.includes(secret), false,
      'live-handle-only content (spawnargs / stream buffer) must not survive a re-save');
    assert.equal(raw.includes('_liveHandle'), false,
      'the _liveHandle key itself must be stripped on re-save');
    // Sanity: we did not over-strip — the legitimate worker prompt is still kept.
    assert.equal(raw.includes('do the benign task'), true,
      'the worker prompt (originalPrompt) is a deliberate field and must survive');
  } finally {
    ws.cleanup();
  }
});

test('shutdownTeam regression: a PRE-FIX husk _liveHandle does not block the _handle.pid fallback', async () => {
  // Upgrade path (codex cross-review finding): a team-*.json written by the OLD
  // no-replacer saveTeamState still carries a truthy but function-less husk on
  // _liveHandle. shutdownTeam must NOT prefer that husk (its adapter shutdown
  // would no-op) and must still signal the detached group via _handle.pid.
  const ws = makeWorkspace(['Bash(*)', 'Write(*)']);
  const children = [];
  try {
    const child = nodeSpawn(
      process.execPath,
      ['-e', 'setTimeout(() => process.exit(0), 15000); setInterval(() => {}, 1000)'],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    children.push(child);
    const pid = child.pid;

    // Hand-write a legacy state file: a JSON-serialized ChildProcess husk (all
    // methods dropped) on _liveHandle, plus the serializable _handle.pid.
    mkdirSync(join(ws.cwd, '.ao', 'state'), { recursive: true });
    writeFileSync(
      join(ws.cwd, '.ao', 'state', 'team-legacy.json'),
      JSON.stringify({
        teamName: 'legacy', phase: 'running', cwd: ws.cwd,
        workers: [{
          name: 'c1', type: 'codex', status: 'running', _adapterName: 'codex-exec',
          _handle: { pid },
          _liveHandle: {
            pid,
            status: 'running',
            _output: '',
            spawnargs: ['codex', 'exec', '--json'],
            // .process survives as a plain object — NO .kill function (husk).
            process: { pid, spawnargs: ['codex', 'exec', '--json'] },
          },
        }],
      }),
    );

    assert.doesNotThrow(() => process.kill(pid, 0), 'fixture alive before shutdown');

    await shutdownTeam('legacy', ws.cwd);

    let dead = false;
    for (let i = 0; i < 150; i++) {
      try { process.kill(pid, 0); } catch { dead = true; break; }
      await sleep(20);
    }
    assert.equal(dead, true,
      'a function-less husk _liveHandle must fall through to the _handle.pid group kill');
  } finally {
    for (const c of children) {
      try { process.kill(-c.pid, 'SIGKILL'); } catch {}
      try { c.kill('SIGKILL'); } catch {}
    }
    ws.cleanup();
  }
});

// ─── F3: PID-reuse identity validation in the disk-loaded shutdown fallback ──
// killProcessGroups records a process START-TIME identity (_handle.startId) at
// spawn and re-checks it before signaling — so a recycled pid (its number reused
// by an unrelated process) is NOT signaled. When the identity can't be read it
// FAILS OPEN to the documented group-signal.

const START_ID_SUPPORTED = readProcStartId(process.pid) !== null;

test('readProcStartId: stable for a live pid, null for bogus / pid<=1', () => {
  const a = readProcStartId(process.pid);
  const b = readProcStartId(process.pid);
  assert.equal(a, b, 'same live process must yield a stable identity');
  if (a !== null) assert.equal(typeof a, 'string');
  assert.equal(readProcStartId(999999), null, 'a non-existent pid has no identity');
  assert.equal(readProcStartId(1), null, 'pid<=1 is never a worker');
  assert.equal(readProcStartId('x'), null, 'non-integer is rejected');
});

test('readProcStartId (F3): identity is timezone-invariant', { skip: START_ID_SUPPORTED ? false : 'start-time identity unavailable on this platform' }, () => {
  // The macOS `ps -o lstart=` path renders local time; without forcing TZ=UTC the
  // SAME process yields different strings under different ambient TZ → a false
  // "recycled" verdict between spawn and shutdown. Identity must be TZ-stable.
  const orig = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Seoul';
    const a = readProcStartId(process.pid);
    process.env.TZ = 'UTC';
    const b = readProcStartId(process.pid);
    assert.equal(a, b, 'start-time identity must not vary with ambient TZ');
  } finally {
    if (orig === undefined) delete process.env.TZ; else process.env.TZ = orig;
  }
});

test('shutdownTeam (F3): a RECYCLED pid (startId mismatch) is NOT signaled', { skip: START_ID_SUPPORTED ? false : 'start-time identity unavailable on this platform' }, async () => {
  // Recorded startId ≠ the live process's identity → killProcessGroups must
  // treat the pid as recycled and protect the (unrelated) live process.
  const ws = makeWorkspace(['Bash(*)', 'Write(*)']);
  const children = [];
  try {
    const child = nodeSpawn(process.execPath,
      ['-e', 'setTimeout(() => process.exit(0), 15000); setInterval(() => {}, 1000)'],
      { detached: true, stdio: 'ignore' });
    child.unref();
    children.push(child);
    const pid = child.pid;

    mkdirSync(join(ws.cwd, '.ao', 'state'), { recursive: true });
    writeFileSync(
      join(ws.cwd, '.ao', 'state', 'team-recycled.json'),
      JSON.stringify({
        teamName: 'recycled', phase: 'running', cwd: ws.cwd,
        workers: [{
          name: 'c1', type: 'codex', status: 'running', _adapterName: 'codex-exec',
          _handle: { pid, startId: 'recorded-at-spawn-DIFFERENT-from-live' },
        }],
      }),
    );

    assert.doesNotThrow(() => process.kill(pid, 0), 'fixture alive before shutdown');
    await shutdownTeam('recycled', ws.cwd);

    // The mismatch must spare the process — still alive after the grace window.
    await sleep(300);
    assert.doesNotThrow(() => process.kill(pid, 0),
      'a recycled pid (startId mismatch) must NOT be signaled');
  } finally {
    for (const c of children) {
      try { process.kill(-c.pid, 'SIGKILL'); } catch {}
      try { c.kill('SIGKILL'); } catch {}
    }
    ws.cleanup();
  }
});

test('shutdownTeam (F3): a MATCHING startId still kills the orphaned group', { skip: START_ID_SUPPORTED ? false : 'start-time identity unavailable on this platform' }, async () => {
  const ws = makeWorkspace(['Bash(*)', 'Write(*)']);
  const children = [];
  try {
    const child = nodeSpawn(process.execPath,
      ['-e', 'setTimeout(() => process.exit(0), 15000); setInterval(() => {}, 1000)'],
      { detached: true, stdio: 'ignore' });
    child.unref();
    children.push(child);
    const pid = child.pid;
    const startId = readProcStartId(pid); // the REAL identity, as recorded at spawn

    mkdirSync(join(ws.cwd, '.ao', 'state'), { recursive: true });
    writeFileSync(
      join(ws.cwd, '.ao', 'state', 'team-match.json'),
      JSON.stringify({
        teamName: 'match', phase: 'running', cwd: ws.cwd,
        workers: [{
          name: 'c1', type: 'codex', status: 'running', _adapterName: 'codex-exec',
          _handle: { pid, startId },
        }],
      }),
    );

    assert.doesNotThrow(() => process.kill(pid, 0), 'fixture alive before shutdown');
    await shutdownTeam('match', ws.cwd);

    let dead = false;
    for (let i = 0; i < 150; i++) {
      try { process.kill(pid, 0); } catch { dead = true; break; }
      await sleep(20);
    }
    assert.equal(dead, true, 'a matching startId must NOT block the group kill');
  } finally {
    for (const c of children) {
      try { process.kill(-c.pid, 'SIGKILL'); } catch {}
      try { c.kill('SIGKILL'); } catch {}
    }
    ws.cleanup();
  }
});

// ─── P4 crown acceptance: the FLIP end-to-end through a REAL detached supervisor ─
// Not a fake recorder — spawnTeam launches the actual adapter-worker-supervisor.mjs
// as a detached child against the env-gated `fixture` adapter, the supervisor
// writes its snapshot/output to disk, and a FRESH monitorTeam/collectResults call
// (the fresh-process-per-poll model) reads completion + durable output back. This
// is the whole point of P4: adapter workers now report across the process boundary.

test('spawnTeam E2E: a real detached fixture supervisor reports completion + durable output to disk', async () => {
  const ws = makeWorkspace(['Bash(*)', 'Write(*)']); // full-auto host → no demotion
  let supervisorPid = null;
  try {
    // No injected spawnSupervisor → the REAL detached spawn path runs. We only
    // redirect the manifest's adapter to the fixture and unlock it in the child
    // env (production strips AO_SUPERVISOR_ALLOW_FIXTURE, so this is test-only).
    const workers = [{
      type: 'codex', name: 'w', prompt: 'compute the answer',
      fixture: { exitCode: 0, output: 'E2E-DURABLE-OUTPUT', delayMs: 50 },
    }];
    const caps = { hasCodexExecJson: true }; // → codex-exec → non-tmux → launchSupervisor

    const state = await spawnTeam('e2e', workers, ws.cwd, caps, {
      supervisor: { adapterName: 'fixture', env: { AO_SUPERVISOR_ALLOW_FIXTURE: '1' } },
    });
    supervisorPid = state.workers[0]?._handle?.supervisorPid || null;
    assert.equal(state.workers[0].status, 'running', 'worker is running right after launch');
    assert.equal(typeof supervisorPid, 'number', 'a real supervisor pid was recorded');

    // Fresh-process model: poll monitorTeam (re-reads disk every call) until the
    // supervisor's terminal snapshot lands.
    let status = null;
    for (let i = 0; i < 200; i++) {
      status = monitorTeam('e2e');
      if (status?.workers?.[0]?.status === 'completed') break;
      if (status?.workers?.[0]?.status === 'failed') break;
      await sleep(25);
    }
    assert.equal(status.workers[0].status, 'completed',
      'monitorTeam must observe the detached supervisor completion across the process boundary');

    // collectResults reads the durable output file the supervisor wrote.
    const results = collectResults('e2e');
    assert.equal(results.w, 'E2E-DURABLE-OUTPUT',
      'collectResults must return the supervisor-written durable output');
  } finally {
    if (supervisorPid) { try { process.kill(-supervisorPid, 'SIGKILL'); } catch {} }
    ws.cleanup();
  }
});

// ─── P5 hardening ───────────────────────────────────────────────────────────

test('spawnTeam (P5 stale generation): a re-spawn under the same team name ignores the prior run snapshot', async () => {
  const ws = makeWorkspace(['Bash(*)', 'Write(*)']);
  try {
    const caps = { hasCodexExecJson: true };

    // Run 1 launches and (pretend) its supervisor completed — a snapshot is on disk.
    const { spawnSupervisor: rec1 } = makeFakeAdapters();
    const s1 = await spawnTeam('regen', [{ type: 'codex', name: 'w', prompt: 'first' }], ws.cwd, caps, { spawnSupervisor: rec1 });
    const run1 = s1.runId, wrk1 = s1.workers[0]._handle.workerRunId;
    supWriteSnapshot(supSnapshotPath(ws.cwd, run1, wrk1),
      { runId: run1, workerRunId: wrk1, supervisorPid: process.pid, status: 'completed', outputTail: 'STALE-RUN-1' }, Date.now());

    // Run 2 re-uses the team NAME but gets a fresh runId — it overwrites team-regen.json.
    const { spawnSupervisor: rec2 } = makeFakeAdapters();
    const s2 = await spawnTeam('regen', [{ type: 'codex', name: 'w', prompt: 'second' }], ws.cwd, caps, { spawnSupervisor: rec2 });
    assert.notEqual(s2.runId, run1, 'each spawn must scope a fresh run identity');

    // monitorTeam reads run 2's state; run 2 has no snapshot yet (within startup
    // grace) → running. The stale run-1 "completed" snapshot must NOT leak in.
    const status = monitorTeam('regen');
    assert.equal(status.workers[0].status, 'running',
      "a prior run's completed snapshot must not be read as the current run's result");
  } finally {
    ws.cleanup();
  }
});

test('shutdownTeam (P5): a duplicate shutdown of a real fixture team is a safe no-op', async () => {
  const ws = makeWorkspace(['Bash(*)', 'Write(*)']);
  let supervisorPid = null;
  try {
    const workers = [{ type: 'codex', name: 'w', prompt: 'long', fixture: { exitCode: 0, output: 'x', delayMs: 8000 } }];
    const state = await spawnTeam('dupshut', workers, ws.cwd, { hasCodexExecJson: true }, {
      supervisor: { adapterName: 'fixture', env: { AO_SUPERVISOR_ALLOW_FIXTURE: '1' } },
    });
    supervisorPid = state.workers[0]?._handle?.supervisorPid || null;
    assert.equal(typeof supervisorPid, 'number');

    await shutdownTeam('dupshut', ws.cwd);
    let dead = false;
    for (let i = 0; i < 150; i++) {
      try { process.kill(supervisorPid, 0); } catch { dead = true; break; }
      await sleep(20);
    }
    assert.equal(dead, true, 'first shutdown reaps the supervisor');

    // Second shutdown: supervisor pid is gone (identity no longer matches). Must
    // not throw and must not signal an unrelated recycled pid.
    await assert.doesNotReject(shutdownTeam('dupshut', ws.cwd), 'a duplicate shutdownTeam is idempotent');
  } finally {
    if (supervisorPid) { try { process.kill(-supervisorPid, 'SIGKILL'); } catch {} }
    ws.cleanup();
  }
});

test('spawnTeam (P5 orphan survival): the detached supervisor completes AFTER its launcher process exits', async () => {
  const ws = makeWorkspace(['Bash(*)', 'Write(*)']);
  let supervisorPid = null;
  try {
    // DETERMINISTIC ordering proof (no timing race): the fixture blocks on a gate
    // file that this test creates ONLY after it has confirmed the launcher exited
    // AND observed a live "running" snapshot. So completion provably happens after
    // the launcher died — not by a lucky delay.
    const gatePath = join(ws.cwd, 'gate.release');
    const launcher = `
      const { spawnTeam } = await import(${JSON.stringify(pathToFileURL(WORKER_SPAWN_PATH).href)});
      const { writeFileSync } = await import('fs');
      const workers = [{ type: 'codex', name: 'w', prompt: 'x', fixture: { exitCode: 0, output: 'ORPHAN-SURVIVES', waitForFile: ${JSON.stringify(gatePath)} } }];
      const state = await spawnTeam('orphan', workers, process.cwd(), { hasCodexExecJson: true }, {
        supervisor: { adapterName: 'fixture', env: { AO_SUPERVISOR_ALLOW_FIXTURE: '1' } },
      });
      writeFileSync('ids.json', JSON.stringify({ runId: state.runId, workerRunId: state.workers[0]._handle.workerRunId, supervisorPid: state.workers[0]._handle.supervisorPid }));
      process.exit(0);
    `;
    writeFileSync(join(ws.cwd, 'launcher.mjs'), `(async () => {${launcher}})();`);

    // Run the launcher and WAIT for it to fully exit before we look for results.
    const child = nodeSpawn(process.execPath, [join(ws.cwd, 'launcher.mjs')], { cwd: ws.cwd, stdio: 'ignore' });
    const launcherExit = await new Promise((res) => child.on('exit', (code) => res(code)));
    assert.equal(launcherExit, 0, 'launcher exited cleanly');

    const ids = JSON.parse(readFileSync(join(ws.cwd, 'ids.json'), 'utf-8'));
    supervisorPid = ids.supervisorPid;

    // The launcher is DEAD. Confirm the orphaned supervisor is alive and blocked
    // on the gate (a "running" snapshot) — this is the survival proof: it outlived
    // its parent and is still working, deterministically (gate not yet created).
    let running = false;
    for (let i = 0; i < 200; i++) {
      const r = supReadSnapshot(supSnapshotPath(ws.cwd, ids.runId, ids.workerRunId), { runId: ids.runId, workerRunId: ids.workerRunId });
      if (r.kind === 'ok' && r.snapshot.status === 'running') { running = true; break; }
      if (r.kind === 'ok' && r.snapshot.status !== 'running') break; // would mean it finished before the gate — fail below
      await sleep(25);
    }
    assert.equal(running, true, 'the orphaned supervisor must be alive and running after its launcher died (gate still closed)');

    // Release the gate; only NOW can the supervisor complete.
    writeFileSync(gatePath, '');
    let snap = null;
    for (let i = 0; i < 200; i++) {
      const r = supReadSnapshot(supSnapshotPath(ws.cwd, ids.runId, ids.workerRunId), { runId: ids.runId, workerRunId: ids.workerRunId });
      if (r.kind === 'ok' && (r.snapshot.status === 'completed' || r.snapshot.status === 'failed')) { snap = r.snapshot; break; }
      await sleep(25);
    }
    assert.ok(snap, 'the orphaned supervisor must write a terminal snapshot once the gate opens');
    assert.equal(snap.status, 'completed', 'the orphan supervisor ran to completion after its launcher died');
    assert.equal(readFileSync(supOutputPath(ws.cwd, ids.runId, ids.workerRunId), 'utf-8'), 'ORPHAN-SURVIVES');
  } finally {
    if (supervisorPid) { try { process.kill(-supervisorPid, 'SIGKILL'); } catch {} }
    ws.cleanup();
  }
});
