/**
 * Unit tests for scripts/lib/worker-spawn.mjs
 * Tests: detectCodexError(), selectAdapter(), adapter dispatch
 * Uses node:test — zero npm dependencies.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  completeClaudeFallback,
  demoteCodexWorkersIfNeeded,
  detectCodexError,
  detectProviderExhaustion,
  dispatchProviderFallback,
  pollProviderFallback,
  planProviderFailover,
  selectAdapter,
} from '../lib/worker-spawn.mjs';

// ---------------------------------------------------------------------------
// detectCodexError — no failure
// ---------------------------------------------------------------------------

test('detectCodexError: empty string → { failed: false }', () => {
  const result = detectCodexError('');
  assert.deepEqual(result, { failed: false });
});

test('detectCodexError: normal output → { failed: false }', () => {
  const result = detectCodexError('All tests passed. Build complete.\n$ ');
  assert.deepEqual(result, { failed: false });
});

test('detectCodexError: null → { failed: false }', () => {
  const result = detectCodexError(null);
  assert.deepEqual(result, { failed: false });
});

test('detectCodexError: undefined → { failed: false }', () => {
  const result = detectCodexError(undefined);
  assert.deepEqual(result, { failed: false });
});

// ---------------------------------------------------------------------------
// detectCodexError — auth_failed
// ---------------------------------------------------------------------------

test('detectCodexError: "authentication failed" → auth_failed', () => {
  const result = detectCodexError('Error: authentication failed for the provided token');
  assert.equal(result.failed, true);
  assert.equal(result.reason, 'auth_failed');
  assert.ok(typeof result.message === 'string' && result.message.length > 0);
});

test('detectCodexError: "unauthorized" → auth_failed', () => {
  const result = detectCodexError('401 Unauthorized: please provide a valid API key');
  assert.equal(result.failed, true);
  assert.equal(result.reason, 'auth_failed');
});

test('detectCodexError: "invalid api key" → auth_failed', () => {
  const result = detectCodexError('Request rejected: invalid api key supplied');
  assert.equal(result.failed, true);
  assert.equal(result.reason, 'auth_failed');
});

// ---------------------------------------------------------------------------
// detectCodexError — rate_limited
// ---------------------------------------------------------------------------

test('detectCodexError: "rate limit exceeded" → rate_limited', () => {
  const result = detectCodexError('rate limit exceeded, please slow down your requests');
  assert.equal(result.failed, true);
  assert.equal(result.reason, 'rate_limited');
});

test('detectCodexError: "429" status → rate_limited', () => {
  const result = detectCodexError('HTTP 429: too many requests, retry after 60s');
  assert.equal(result.failed, true);
  assert.equal(result.reason, 'rate_limited');
});

test('detectCodexError: "quota exceeded" → rate_limited', () => {
  const result = detectCodexError('quota exceeded for this billing period');
  assert.equal(result.failed, true);
  assert.equal(result.reason, 'rate_limited');
});

// ---------------------------------------------------------------------------
// detectCodexError — not_installed
// ---------------------------------------------------------------------------

test('detectCodexError: "command not found" → not_installed', () => {
  const result = detectCodexError('zsh: command not found: codex');
  assert.equal(result.failed, true);
  assert.equal(result.reason, 'not_installed');
});

test('detectCodexError: "ENOENT" → not_installed', () => {
  const result = detectCodexError("spawn ENOENT: no such file or directory '/usr/local/bin/codex'");
  assert.equal(result.failed, true);
  assert.equal(result.reason, 'not_installed');
});

// ---------------------------------------------------------------------------
// detectCodexError — network
// ---------------------------------------------------------------------------

test('detectCodexError: "ETIMEDOUT connection" → network', () => {
  const result = detectCodexError('Error: ETIMEDOUT connection to api.openai.com:443 timed out');
  assert.equal(result.failed, true);
  assert.equal(result.reason, 'network');
});

test('detectCodexError: "ECONNRESET" → network', () => {
  const result = detectCodexError('ECONNRESET: connection reset by peer');
  assert.equal(result.failed, true);
  assert.equal(result.reason, 'network');
});

test('detectCodexError: "socket hang up" → network', () => {
  const result = detectCodexError('socket hang up after 30s of inactivity');
  assert.equal(result.failed, true);
  assert.equal(result.reason, 'network');
});

// ---------------------------------------------------------------------------
// detectCodexError — crash
// ---------------------------------------------------------------------------

test('detectCodexError: "fatal error SIGSEGV" → crash', () => {
  const result = detectCodexError('fatal error: received signal SIGSEGV — process terminated');
  assert.equal(result.failed, true);
  assert.equal(result.reason, 'crash');
});

test('detectCodexError: "SIGABRT" → crash', () => {
  const result = detectCodexError('Process aborted with SIGABRT');
  assert.equal(result.failed, true);
  assert.equal(result.reason, 'crash');
});

test('detectCodexError: "unhandled exception" → crash', () => {
  const result = detectCodexError('unhandled exception: TypeError: Cannot read property');
  assert.equal(result.failed, true);
  assert.equal(result.reason, 'crash');
});

// ---------------------------------------------------------------------------
// detectCodexError — message truncation
// ---------------------------------------------------------------------------

test('detectCodexError: message is truncated to 200 chars', () => {
  const longLine = 'authentication failed: ' + 'x'.repeat(300);
  const result = detectCodexError(longLine);
  assert.equal(result.failed, true);
  assert.equal(result.reason, 'auth_failed');
  assert.ok(result.message.length <= 200, `message length ${result.message.length} exceeds 200`);
});

// ---------------------------------------------------------------------------
// provider exhaustion and failover planning
// ---------------------------------------------------------------------------

test('detectProviderExhaustion distinguishes quota from generic failure', () => {
  assert.deepEqual(
    detectProviderExhaustion({ category: 'rate_limited', message: 'HTTP 429' }),
    { exhausted: true, reason: 'rate_limited' },
  );
  assert.deepEqual(
    detectProviderExhaustion({ category: 'crash', message: 'process exited' }),
    { exhausted: false, reason: null },
  );
});

test('detectProviderExhaustion requires repeated network unavailability', () => {
  const error = { category: 'network', message: 'provider unavailable' };
  assert.equal(detectProviderExhaustion(error, 1).exhausted, false);
  assert.deepEqual(detectProviderExhaustion(error, 2), {
    exhausted: true,
    reason: 'repeated_unavailability',
  });
});

test('planProviderFailover sends exhausted Codex to available Gemini without losing task', () => {
  const plan = planProviderFailover({
    type: 'codex',
    name: 'deep-worker',
    prompt: 'implement the bounded goal',
    model: 'gpt-5',
    custom: 42,
    _adapterName: 'codex-appserver',
    _handle: { pid: 123 },
  }, { category: 'rate_limited', message: 'quota exceeded' }, {
    hasGeminiAcp: true,
    hasGeminiCli: true,
    hasClaudeCli: true,
  });

  assert.equal(plan.fallbackNeeded, true);
  assert.equal(plan.sourceProvider, 'codex');
  assert.equal(plan.targetProvider, 'gemini');
  assert.equal(plan.replacementWorker.type, 'gemini');
  assert.equal(plan.replacementWorker.name, 'deep-worker');
  assert.equal(plan.replacementWorker.prompt, 'implement the bounded goal');
  assert.equal(plan.replacementWorker.custom, 42);
  assert.equal(plan.replacementWorker.model, undefined);
  assert.equal(plan.replacementWorker._demotedModel, 'gpt-5');
  assert.equal(plan.replacementWorker._handle, undefined);
  assert.match(plan.replacementWorker._demotionReason, /provider exhaustion.*codex -> gemini/);
});

test('planProviderFailover completes Codex to Gemini to Claude priority chain', () => {
  const noGemini = planProviderFailover(
    { type: 'codex', name: 'worker', prompt: 'same task' },
    'rate_limited',
    { hasGeminiAcp: false, hasGeminiCli: false, hasClaudeCli: true },
  );
  assert.equal(noGemini.targetProvider, 'claude');

  const geminiExhausted = planProviderFailover(
    { type: 'gemini', name: 'worker', prompt: 'same task', model: 'gemini-2.5-pro' },
    { category: 'provider_exhausted', message: 'repeated unavailability' },
    { hasClaudeCli: true },
  );
  assert.equal(geminiExhausted.targetProvider, 'claude');
  assert.equal(geminiExhausted.replacementWorker.prompt, 'same task');
  assert.equal(geminiExhausted.replacementWorker.model, undefined);
  assert.equal(geminiExhausted.replacementWorker._demotedModel, 'gemini-2.5-pro');
});

test('provider unavailability retries once with attempt state before failover', () => {
  const legacyFirst = planProviderFailover(
    { type: 'codex', name: 'legacy', prompt: 'same task' },
    { category: 'timeout', message: 'timed out' },
    { hasGeminiCli: true },
  );
  assert.equal(legacyFirst.retry, true);
  assert.equal(legacyFirst.replacementWorker._providerUnavailableAttempts, 1);

  const first = planProviderFailover(
    { type: 'codex', name: 'worker', prompt: 'same task', _providerUnavailableAttempts: 1 },
    { category: 'network', message: 'temporarily unavailable' },
    { hasGeminiCli: true },
  );
  assert.equal(first.retry, true);
  assert.equal(first.targetProvider, 'codex');
  assert.equal(first.replacementWorker._providerUnavailableAttempts, 1);
  assert.match(first.replacementWorker._providerRetryReason, /attempt 2/);

  const second = planProviderFailover(
    { type: 'codex', name: 'worker', prompt: 'same task', _providerUnavailableAttempts: 2 },
    { category: 'network', message: 'still unavailable' },
    { hasGeminiCli: true },
  );
  assert.equal(second.retry, false);
  assert.equal(second.targetProvider, 'gemini');
  assert.equal(second.exhaustion.reason, 'repeated_unavailability');
});

test('planProviderFailover gives a switched provider a fresh retry budget', () => {
  // An exhausted Codex worker carries its own spent counters. The Gemini
  // replacement must NOT inherit them, or its documented retry-once-on-
  // unavailable would be denied on its very first network hiccup.
  const plan = planProviderFailover(
    {
      type: 'codex',
      name: 'worker',
      prompt: 'same task',
      _providerUnavailableAttempts: 2,
      _providerCrashAttempts: 1,
      _providerRetryReason: 'network: attempt 2',
    },
    { category: 'network', message: 'still unavailable' },
    { hasGeminiCli: true },
  );
  assert.equal(plan.targetProvider, 'gemini');
  assert.equal(plan.replacementWorker._providerUnavailableAttempts, undefined);
  assert.equal(plan.replacementWorker._providerCrashAttempts, undefined);
  assert.equal(plan.replacementWorker._providerRetryReason, undefined);

  const geminiPlan = planProviderFailover(
    { ...plan.replacementWorker },
    { category: 'network', message: 'gemini hiccup' },
    { hasGeminiCli: true },
  );
  assert.equal(geminiPlan.retry, true);
  assert.equal(geminiPlan.targetProvider, 'gemini');
});

test('provider crashes create one real same-provider retry before demotion', () => {
  const first = planProviderFailover(
    { type: 'codex', name: 'worker', prompt: 'same task' },
    { category: 'crash', message: 'process crashed' },
    { hasGeminiCli: true },
  );
  assert.equal(first.retry, true);
  assert.equal(first.targetProvider, 'codex');
  assert.equal(first.replacementWorker._providerCrashAttempts, 1);

  const second = planProviderFailover(
    { type: 'codex', name: 'worker', prompt: 'same task', _providerCrashAttempts: 1 },
    { category: 'crash', message: 'process crashed again' },
    { hasGeminiCli: true },
  );
  assert.equal(second.retry, false);
  assert.equal(second.targetProvider, 'claude');
});

test('dispatchProviderFallback spawns provider replacements and preserves Claude native handoff', async (t) => {
  const calls = [];
  let storedState = null;
  const geminiFallback = planProviderFailover(
    { type: 'codex', name: 'worker', prompt: 'same task', model: 'gpt-5' },
    'rate_limited',
    { hasGeminiCli: true },
  );
  const dispatched = await dispatchProviderFallback(
    { ...geminiFallback, workerName: 'worker' },
    '/workspace',
    { hasGeminiCli: true },
    {
      teamName: 'failover-gemini-test',
      loadTeamState: () => storedState,
      spawnTeam: async (...args) => {
        calls.push(args);
        storedState = { teamName: args[0], workers: args[1] };
        return storedState;
      },
    },
  );
  assert.equal(dispatched.dispatch, 'provider-team');
  assert.equal(dispatched.teamName, 'failover-gemini-test');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1][0].type, 'gemini');
  assert.equal(calls[0][1][0].prompt, 'same task');
  assert.equal(calls[0][1][0].model, undefined);
  const reused = await dispatchProviderFallback(
    { ...geminiFallback, workerName: 'worker' },
    '/workspace',
    { hasGeminiCli: true },
    {
      teamName: 'failover-gemini-test',
      loadTeamState: () => storedState,
      spawnTeam: async (...args) => { calls.push(args); return storedState; },
    },
  );
  assert.equal(reused.reused, true);
  assert.equal(calls.length, 1, 're-polling a failed parent must not spawn a duplicate child');

  const claudeStates = new Map();
  const claudeOutputs = new Map();
  const lockDir = mkdtempSync(join(tmpdir(), 'ao-claude-fallback-'));
  t.after(() => rmSync(lockDir, { recursive: true, force: true }));
  const claudeFallback = {
    fallbackNeeded: true,
    targetProvider: 'claude',
    workerName: 'worker',
    replacementWorker: { type: 'claude', name: 'worker', prompt: 'same task' },
  };
  const claudeOpts = {
    readState: async (id) => claudeStates.get(id) ?? null,
    readOutput: async (id) => claudeOutputs.get(id) ?? null,
    writeState: async (id, value) => claudeStates.set(id, {
      schemaVersion: 1,
      handoffId: id,
      ...value,
    }),
    lockDir,
    now: 100,
  };
  const claude = await dispatchProviderFallback(claudeFallback, '/workspace', {}, claudeOpts);
  assert.equal(claude.dispatch, 'claude-task');
  assert.equal(claude.prompt, 'same task');

  const pending = await dispatchProviderFallback(claudeFallback, '/workspace', {}, {
    ...claudeOpts,
    now: 101,
  });
  assert.equal(pending.dispatch, 'claude-pending');
  assert.equal(pending.handoffId, claude.handoffId);

  await completeClaudeFallback(claude, 'claude output', {
    readState: claudeOpts.readState,
    writeOutput: async (id, output, claimToken) => claudeOutputs.set(id, {
      output: String(output),
      claimToken,
    }),
    writeState: claudeOpts.writeState,
    lockDir,
    now: 200,
  });
  const completed = await dispatchProviderFallback(claudeFallback, '/workspace', {}, {
    ...claudeOpts,
    now: 201,
  });
  assert.equal(completed.dispatch, 'claude-completed');
  assert.equal(completed.output, 'claude output');
});

test('Claude fallback atomically claims one executor and fences expired owners', async (t) => {
  const states = new Map();
  const outputs = new Map();
  const lockDir = mkdtempSync(join(tmpdir(), 'ao-claude-fence-'));
  t.after(() => rmSync(lockDir, { recursive: true, force: true }));
  const fallback = {
    fallbackNeeded: true,
    targetProvider: 'claude',
    teamName: 'parent-team',
    workerName: 'worker',
    parentRunId: 'parent-run',
    parentWorkerRunId: 'parent-worker',
    replacementWorker: { type: 'claude', name: 'worker', prompt: 'same task' },
  };
  let tokenIndex = 0;
  const io = {
    lockDir,
    readState: async (id) => states.get(id) ?? null,
    readOutput: async (id) => outputs.get(id) ?? null,
    writeState: async (id, value) => states.set(id, { schemaVersion: 1, handoffId: id, ...value }),
    writeOutput: async (id, output, claimToken) => outputs.set(id, {
      output: String(output),
      claimToken,
    }),
    createClaimToken: () => `claim-${++tokenIndex}`,
  };

  const concurrent = await Promise.all([
    dispatchProviderFallback(fallback, '/workspace', {}, { ...io, now: 100 }),
    dispatchProviderFallback(fallback, '/workspace', {}, { ...io, now: 100 }),
  ]);
  assert.deepEqual(concurrent.map((item) => item.dispatch).sort(), ['claude-pending', 'claude-task']);
  assert.equal(tokenIndex, 1);
  const firstOwner = concurrent.find((item) => item.dispatch === 'claude-task');

  const nextOwner = await dispatchProviderFallback(fallback, '/workspace', {}, {
    ...io,
    now: 600_101,
  });
  assert.equal(nextOwner.dispatch, 'claude-task');
  assert.notEqual(nextOwner.claimToken, firstOwner.claimToken);

  await assert.rejects(
    completeClaudeFallback(firstOwner, 'stale output', { ...io, now: 600_102 }),
    /lease lost/,
  );
  await completeClaudeFallback(nextOwner, 'current output', { ...io, now: 600_103 });
  const completed = await dispatchProviderFallback(fallback, '/workspace', {}, {
    ...io,
    now: 600_104,
  });
  assert.equal(completed.dispatch, 'claude-completed');
  assert.equal(completed.output, 'current output');
});

test('dispatchProviderFallback replaces stale child state with mismatched task identity', async () => {
  let shutdownCount = 0;
  let spawnCount = 0;
  const fallback = {
    fallbackNeeded: true,
    targetProvider: 'gemini',
    workerName: 'worker',
    parentRunId: 'parent-run',
    parentWorkerRunId: 'parent-worker',
    replacementWorker: { type: 'gemini', name: 'worker', prompt: 'new task' },
  };
  const dispatched = await dispatchProviderFallback(fallback, '/workspace', { hasGeminiCli: true }, {
    teamName: 'failover-stale-child',
    loadTeamState: () => ({
      teamName: 'failover-stale-child',
      workers: [{ type: 'gemini', name: 'worker', prompt: 'old task' }],
    }),
    shutdownTeam: async () => { shutdownCount += 1; },
    spawnTeam: async (teamName, workers) => {
      spawnCount += 1;
      return { teamName, workers };
    },
  });
  assert.equal(shutdownCount, 1);
  assert.equal(spawnCount, 1);
  assert.equal(dispatched.reused, false);
  assert.equal(dispatched.state.workers[0].prompt, 'new task');
});

test('pollProviderFallback collects completed output and advances failed children to Claude', async () => {
  const completedClaude = await pollProviderFallback({
    dispatch: 'claude-completed',
    output: 'persisted claude output',
  }, '/workspace');
  assert.equal(completedClaude.status, 'completed');
  assert.equal(completedClaude.output, 'persisted claude output');

  const pendingClaude = await pollProviderFallback({
    dispatch: 'claude-pending',
  }, '/workspace');
  assert.equal(pendingClaude.status, 'running');

  const completed = await pollProviderFallback({
    dispatch: 'provider-team',
    teamName: 'child-complete',
    workerName: 'worker',
    prompt: 'same task',
  }, '/workspace', {}, {
    monitorTeam: () => ({ workers: [{ name: 'worker', status: 'completed' }] }),
    collectResults: () => ({ worker: 'finished output' }),
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.output, 'finished output');

  const claudeDispatch = {
    dispatch: 'claude-task',
    workerName: 'worker',
    replacementWorker: { type: 'claude', name: 'worker', prompt: 'same task' },
  };
  const failed = await pollProviderFallback({
    dispatch: 'provider-team',
    teamName: 'child-failed',
    workerName: 'worker',
    prompt: 'same task',
  }, '/workspace', {}, {
    monitorTeam: () => ({ workers: [{ name: 'worker', status: 'failed', errorReason: 'rate_limited' }] }),
    reassignProvider: async () => ({ fallbackNeeded: true, targetProvider: 'claude' }),
    dispatchProviderFallback: async () => claudeDispatch,
  });
  assert.equal(failed.status, 'claude-task');
  assert.equal(failed.dispatched.replacementWorker.prompt, 'same task');
});

test('repeated reassignProvider polls of one failure do not spam wisdom', () => {
  // The fresh-process monitor loop re-runs reassignProvider on every poll while
  // the parent worker stays 'failed' (that re-run makes dispatchProviderFallback
  // idempotent). addWisdom's built-in similarity dedup must absorb the
  // resulting near-identical lessons into a single entry.
  const tempRoot = mkdtempSync(join(tmpdir(), 'ao-wisdom-dedup-'));
  try {
    const script = `
      import { reassignProvider } from ${JSON.stringify(new URL('../lib/worker-spawn.mjs', import.meta.url).href)};
      import { readFileSync } from 'node:fs';
      const worker = { name: 'w1', type: 'codex', prompt: 'task', startedAt: 111 };
      const liveState = { workers: [worker], capabilities: {} };
      const failure = { category: 'crash', message: 'boom' };
      await reassignProvider('dedup-team', 'w1', 'task', failure, undefined, { liveState });
      await reassignProvider('dedup-team', 'w1', 'task', failure, undefined, { liveState });
      await reassignProvider('dedup-team', 'w1', 'task', failure, undefined, { liveState });
      const lines = readFileSync('.ao/wisdom.jsonl', 'utf-8').trim().split('\\n');
      console.log(JSON.stringify({ entries: lines.length }));
    `;
    const stdout = execFileSync('node', ['--input-type=module', '-e', script], {
      cwd: tempRoot,
      encoding: 'utf-8',
      timeout: 30_000,
    });
    const result = JSON.parse(stdout.trim().split('\n').pop());
    assert.equal(result.entries, 1, 'repeated polls of one failure must dedupe to one wisdom entry');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// selectAdapter — adapter selection
// ---------------------------------------------------------------------------

test('selectAdapter: codex worker + hasCodexExecJson → codex-exec', () => {
  const result = selectAdapter({ type: 'codex', name: 'w1' }, { hasCodexExecJson: true });
  assert.equal(result, 'codex-exec');
});

test('selectAdapter: codex worker + no hasCodexExecJson → tmux', () => {
  const result = selectAdapter({ type: 'codex', name: 'w1' }, { hasCodexExecJson: false });
  assert.equal(result, 'tmux');
});

test('selectAdapter: codex worker + empty capabilities → tmux', () => {
  const result = selectAdapter({ type: 'codex', name: 'w1' }, {});
  assert.equal(result, 'tmux');
});

test('selectAdapter: codex worker + no capabilities → tmux', () => {
  const result = selectAdapter({ type: 'codex', name: 'w1' });
  assert.equal(result, 'tmux');
});

test('selectAdapter: claude worker + hasCodexExecJson → tmux', () => {
  const result = selectAdapter({ type: 'claude', name: 'w1' }, { hasCodexExecJson: true });
  assert.equal(result, 'tmux');
});

test('selectAdapter: gemini worker with ACP → gemini-acp', () => {
  const result = selectAdapter({ type: 'gemini', name: 'w1' }, { hasGeminiAcp: true, hasGeminiCli: true });
  assert.equal(result, 'gemini-acp');
});

test('selectAdapter: gemini worker with CLI only → gemini-exec', () => {
  const result = selectAdapter({ type: 'gemini', name: 'w1' }, { hasGeminiCli: true });
  assert.equal(result, 'gemini-exec');
});

test('selectAdapter: gemini worker without capabilities → tmux', () => {
  const result = selectAdapter({ type: 'gemini', name: 'w1' }, { hasCodexExecJson: true });
  assert.equal(result, 'tmux');
});

test('selectAdapter: unknown worker type → tmux', () => {
  const result = selectAdapter({ type: 'unknown', name: 'w1' }, { hasCodexExecJson: true });
  assert.equal(result, 'tmux');
});

test('selectAdapter: is a pure function (no side effects)', () => {
  const caps = { hasCodexExecJson: true };
  const worker = { type: 'codex', name: 'w1' };
  selectAdapter(worker, caps);
  // Originals unchanged
  assert.equal(caps.hasCodexExecJson, true);
  assert.equal(worker.type, 'codex');
});

// ---------------------------------------------------------------------------
// demoteCodexWorkersIfNeeded — host permission too low → codex → claude
// ---------------------------------------------------------------------------

test('demoteCodexWorkersIfNeeded: suggest level demotes codex workers to claude', () => {
  const workers = [
    { type: 'codex', name: 'c1' },
    { type: 'claude', name: 'cl1' },
    { type: 'codex', name: 'c2' },
    { type: 'gemini', name: 'g1' },
  ];
  const count = demoteCodexWorkersIfNeeded(workers, 'suggest');
  assert.equal(count, 2);
  assert.equal(workers[0].type, 'claude');
  assert.equal(workers[0]._demotedFrom, 'codex');
  assert.match(workers[0]._demotionReason, /suggest/);
  assert.equal(workers[1].type, 'claude'); // unchanged (was already claude)
  assert.equal(workers[1]._demotedFrom, undefined);
  assert.equal(workers[2].type, 'claude');
  assert.equal(workers[2]._demotedFrom, 'codex');
  assert.equal(workers[3].type, 'gemini'); // unchanged (different type)
});

test('demoteCodexWorkersIfNeeded: full-auto level keeps codex workers', () => {
  const workers = [{ type: 'codex', name: 'c1' }];
  const count = demoteCodexWorkersIfNeeded(workers, 'full-auto');
  assert.equal(count, 0);
  assert.equal(workers[0].type, 'codex');
  assert.equal(workers[0]._demotedFrom, undefined);
});

test('demoteCodexWorkersIfNeeded: auto-edit level keeps codex workers', () => {
  const workers = [{ type: 'codex', name: 'c1' }];
  const count = demoteCodexWorkersIfNeeded(workers, 'auto-edit');
  assert.equal(count, 0);
  assert.equal(workers[0].type, 'codex');
});

test('demoteCodexWorkersIfNeeded: empty workers array is no-op', () => {
  const workers = [];
  const count = demoteCodexWorkersIfNeeded(workers, 'suggest');
  assert.equal(count, 0);
  assert.equal(workers.length, 0);
});

test('demoteCodexWorkersIfNeeded: preserves non-provider fields when demoting', () => {
  const workers = [{
    type: 'codex',
    name: 'c1',
    prompt: 'do the thing',
    custom: 42,
  }];
  demoteCodexWorkersIfNeeded(workers, 'suggest');
  assert.equal(workers[0].name, 'c1');
  assert.equal(workers[0].prompt, 'do the thing');
  assert.equal(workers[0].custom, 42);
});

test('demoteCodexWorkersIfNeeded: strips provider-specific model field on demotion', () => {
  // Codex model names like "gpt-5" would be forwarded to claude-cli --model
  // and crash the worker. The demotion must strip them so the Claude path
  // uses its own default model.
  const workers = [{
    type: 'codex',
    name: 'c1',
    prompt: 'analyze',
    model: 'gpt-5',
  }];
  demoteCodexWorkersIfNeeded(workers, 'suggest');
  assert.equal(workers[0].type, 'claude');
  assert.equal(workers[0].model, undefined, 'codex model must be stripped');
  // Original value preserved on _demotedModel for observability/debugging.
  assert.equal(workers[0]._demotedModel, 'gpt-5');
});

test('demoteCodexWorkersIfNeeded: full-auto level keeps original model field', () => {
  const workers = [{ type: 'codex', name: 'c1', model: 'gpt-5' }];
  demoteCodexWorkersIfNeeded(workers, 'full-auto');
  assert.equal(workers[0].model, 'gpt-5');
  assert.equal(workers[0]._demotedModel, undefined);
});

test('demoteCodexWorkersIfNeeded: tolerates null worker entries', () => {
  const workers = [null, { type: 'codex', name: 'c1' }, undefined];
  const count = demoteCodexWorkersIfNeeded(workers, 'suggest');
  assert.equal(count, 1);
  assert.equal(workers[1].type, 'claude');
});
