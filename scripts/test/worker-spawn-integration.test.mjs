/**
 * Integration tests for scripts/lib/worker-spawn.mjs spawnTeam().
 *
 * Uses the `_inject` parameter on spawnTeam to supply fake adapter modules
 * (bypassing dynamic imports) and fake tmux session creation. Verifies the
 * end-to-end wiring:
 *   1. permission resolution (host sandbox intersection)
 *   2. codex worker demotion when level = 'suggest'
 *   3. `level` forwarding to codex-exec and codex-appserver spawn calls
 *   4. adapter selection routes post-demotion
 *   5. team state shape after spawn
 *
 * Unit tests for each helper live in `worker-spawn.test.mjs`; this file is
 * specifically for end-to-end `spawnTeam()` invocations.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnTeam } from '../lib/worker-spawn.mjs';

// ─── Fake adapter factory ─────────────────────────────────────────────────────

/**
 * Build a set of fake adapter modules that record every call. Tests inject
 * the returned `modules` map via `_inject.adapters` and then assert on
 * `calls` to verify the wiring.
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

  const modules = {
    'codex-exec': {
      spawn: (prompt, opts) => {
        calls.codexExecSpawn.push({ prompt, opts: { ...opts } });
        return { pid: 1001, _output: '', status: 'running', _adapterName: 'codex-exec' };
      },
      monitor: () => ({ status: 'running', output: '' }),
      shutdown: () => {},
    },
    'codex-appserver': {
      startServer: (opts) => {
        calls.codexAppServerStart.push({ opts: { ...opts } });
        // Mirror production invariants — handle starts uninitialized.
        return {
          pid: 2001,
          threadId: null,
          turnId: null,
          status: 'starting',
          _initialized: false,
          _adapterName: 'codex-appserver',
        };
      },
      initializeServer: async (handle) => {
        calls.codexAppServerInit.push({ handle });
        // Production contract: initializeServer sets _initialized=true and
        // flips status to 'ready'. Tests that skip this can't call
        // createThread (production throws on !handle._initialized).
        handle._initialized = true;
        handle.status = 'ready';
        return {};
      },
      createThread: async (handle, opts) => {
        calls.codexAppServerCreateThread.push({ opts: { ...opts } });
        // Enforce the production invariant instead of silently succeeding.
        if (!handle._initialized) {
          return { error: { code: -10, message: 'Server not initialized' } };
        }
        handle.threadId = 'th-fake-1';
        return { threadId: 'th-fake-1' };
      },
      startTurn: async (handle, prompt) => {
        calls.codexAppServerStartTurn.push({ prompt });
        if (!handle.threadId) {
          return { error: { code: -10, message: 'No active thread' } };
        }
        handle.turnId = 'tu-fake-1';
        return { turnId: 'tu-fake-1' };
      },
      shutdownServer: async () => {},
      monitor: () => ({ status: 'running', output: '' }),
    },
    'claude-cli': {
      spawn: (prompt, opts) => {
        calls.claudeCliSpawn.push({ prompt, opts: { ...opts } });
        return { pid: 3001, _output: '', status: 'running' };
      },
      monitor: () => ({ status: 'running', output: '' }),
      shutdown: () => {},
    },
    'gemini-exec': {
      spawn: (prompt, opts) => {
        calls.geminiExecSpawn.push({ prompt, opts: { ...opts } });
        return { pid: 4001, _output: '', status: 'running' };
      },
      monitor: () => ({ status: 'running', output: '' }),
      shutdown: () => {},
    },
    'gemini-acp': {
      startServer: (opts) => {
        calls.geminiAcpStart.push({ opts: { ...opts } });
        return { pid: 5001, _sessionId: null, _initialized: false, _warnings: [] };
      },
      initializeServer: async (handle) => {
        calls.geminiAcpInit.push({ handle });
        handle._initialized = true;
        return {};
      },
      createSession: async (handle, opts) => {
        calls.geminiAcpCreateSession.push({ opts: { ...opts } });
        if (!handle._initialized) {
          return { error: { code: -10, message: 'Server not initialized' } };
        }
        handle._sessionId = 'sess-fake';
        return {};
      },
      sendPrompt: async (handle, prompt) => {
        calls.geminiAcpSendPrompt.push({ prompt });
        if (!handle._sessionId) {
          return { error: { code: -10, message: 'No active session' } };
        }
        return {};
      },
      shutdownServer: async () => {},
      monitor: () => ({ status: 'running', output: '' }),
    },
  };

  return { modules, calls };
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
    const { modules, calls } = makeFakeAdapters();
    const workers = [{ type: 'codex', name: 'c1', prompt: 'do it' }];
    const caps = { hasCodexExecJson: true, hasCodexAppServer: false };

    const state = await spawnTeam('team-1', workers, ws.cwd, caps, {
      adapters: modules,
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
    const { modules, calls } = makeFakeAdapters();
    const workers = [{ type: 'codex', name: 'c1', prompt: 'do it' }];
    const caps = { hasCodexExecJson: true };

    await spawnTeam('team-2', workers, ws.cwd, caps, { adapters: modules });

    assert.equal(calls.codexExecSpawn[0].opts.level, 'auto-edit');
  } finally {
    ws.cleanup();
  }
});

test('spawnTeam integration: codex worker with suggest host → DEMOTED to claude-cli', async () => {
  const ws = makeWorkspace(['Read(*)']); // no Bash, no Write, no Edit → suggest
  try {
    const { modules, calls } = makeFakeAdapters();
    const workers = [{ type: 'codex', name: 'c1', prompt: 'analyze', model: 'gpt-5' }];
    const caps = { hasCodexExecJson: true, hasClaudeCli: true };

    const state = await spawnTeam('team-3', workers, ws.cwd, caps, { adapters: modules });

    // Codex path should NOT be called — worker was demoted before adapter selection
    assert.equal(calls.codexExecSpawn.length, 0, 'codex-exec should NOT be called on demoted worker');
    assert.equal(calls.codexAppServerStart.length, 0);
    // Claude-cli should receive the demoted worker
    assert.equal(calls.claudeCliSpawn.length, 1);
    // The provider-specific `model` field must be stripped
    assert.equal(calls.claudeCliSpawn[0].opts.model, undefined,
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
    const { modules, calls } = makeFakeAdapters();
    const workers = [{ type: 'codex', name: 'c1', prompt: 'ship it' }];
    const caps = { hasCodexExecJson: true, hasCodexAppServer: true };

    await spawnTeam('team-4', workers, ws.cwd, caps, { adapters: modules });

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
    const { modules, calls } = makeFakeAdapters();
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
      adapters: modules,
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

test('spawnTeam integration: AO_HOST_SANDBOX_LEVEL=read-only downgrades codex to suggest → demote', async () => {
  const ws = makeWorkspace(['Bash(*)', 'Write(*)']);
  try {
    // Explicit host override → read-only → intersection forces 'suggest' →
    // demoteCodexWorkersIfNeeded routes everything to claude-cli.
    process.env.AO_HOST_SANDBOX_LEVEL = 'read-only';

    const { modules, calls } = makeFakeAdapters();
    const workers = [{ type: 'codex', name: 'c1', prompt: 'do it' }];
    const caps = { hasCodexExecJson: true, hasCodexAppServer: true, hasClaudeCli: true };

    await spawnTeam('team-6', workers, ws.cwd, caps, { adapters: modules });

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
    const { modules, calls } = makeFakeAdapters();
    const workers = [{ type: 'codex', name: 'c1', prompt: 'do' }];
    const caps = { hasCodexExecJson: true };

    await spawnTeam('team-7', workers, ws.cwd, caps, { adapters: modules });

    // autonomy sets the ceiling to auto-edit → host unknown → effective stays auto-edit
    assert.equal(calls.codexExecSpawn[0].opts.level, 'auto-edit');
  } finally {
    ws.cleanup();
  }
});

test('spawnTeam integration: workers state has _adapterName after spawn', async () => {
  const ws = makeWorkspace(['Bash(*)', 'Write(*)']);
  try {
    const { modules } = makeFakeAdapters();
    const workers = [
      { type: 'codex', name: 'c1', prompt: 'a' },
      { type: 'claude', name: 'cl1', prompt: 'b' },
    ];
    const caps = { hasCodexExecJson: true, hasClaudeCli: true };

    const state = await spawnTeam('team-8', workers, ws.cwd, caps, { adapters: modules });

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
    const { modules, calls } = makeFakeAdapters();
    const workers = [{ type: 'codex', name: 'c1', prompt: 'a' }];
    const caps = { hasCodexExecJson: true };

    const state = await spawnTeam('team-9', workers, ws.cwd, caps, { adapters: modules });

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
    const { modules } = makeFakeAdapters();
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
        adapters: modules,
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
    const { modules } = makeFakeAdapters();
    const workers = [{ type: 'codex', name: 'c1', prompt: 'a' }];
    const caps = {}; // empty caps → tmux path

    let err;
    try {
      await spawnTeam('team-notmux', workers, ws.cwd, caps, {
        adapters: modules,
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

test('spawnTeam integration: appserver initializeServer failure yields failed worker + shutdown', async () => {
  const ws = makeWorkspace(['Bash(*)', 'Write(*)']);
  try {
    const { modules, calls } = makeFakeAdapters();
    modules['codex-appserver'].initializeServer = async (handle) => {
      calls.codexAppServerInit.push({ handle });
      return { error: { code: -1, message: 'init boom' } };
    };
    let shutdownCalled = false;
    modules['codex-appserver'].shutdownServer = async () => { shutdownCalled = true; };

    const workers = [{ type: 'codex', name: 'c1', prompt: 'a' }];
    const caps = { hasCodexAppServer: true, hasCodexExecJson: true };

    const state = await spawnTeam('team-fail', workers, ws.cwd, caps, { adapters: modules });

    assert.equal(state.workers[0].status, 'failed');
    assert.match(state.workers[0].error || '', /init boom/);
    assert.equal(shutdownCalled, true, 'failed appserver must be shutdown to prevent orphaned process');
  } finally {
    ws.cleanup();
  }
});

test('spawnTeam integration: appserver createThread failure yields failed worker', async () => {
  const ws = makeWorkspace(['Bash(*)', 'Write(*)']);
  try {
    const { modules } = makeFakeAdapters();
    modules['codex-appserver'].createThread = async () => ({
      error: { code: -1, message: 'create thread boom' },
    });

    const workers = [{ type: 'codex', name: 'c1', prompt: 'a' }];
    const caps = { hasCodexAppServer: true, hasCodexExecJson: true };

    const state = await spawnTeam('team-fail2', workers, ws.cwd, caps, { adapters: modules });

    assert.equal(state.workers[0].status, 'failed');
    assert.match(state.workers[0].error || '', /create thread boom/);
  } finally {
    ws.cleanup();
  }
});

test('spawnTeam integration: codex-exec spawn throw yields failed worker', async () => {
  const ws = makeWorkspace(['Bash(*)', 'Write(*)']);
  try {
    const { modules } = makeFakeAdapters();
    modules['codex-exec'].spawn = () => { throw new Error('exec spawn boom'); };

    const workers = [{ type: 'codex', name: 'c1', prompt: 'a' }];
    const caps = { hasCodexExecJson: true };

    const state = await spawnTeam('team-fail3', workers, ws.cwd, caps, { adapters: modules });

    assert.equal(state.workers[0].status, 'failed');
    assert.match(state.workers[0].error || '', /exec spawn boom/);
  } finally {
    ws.cleanup();
  }
});
