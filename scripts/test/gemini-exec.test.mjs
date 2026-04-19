/**
 * Unit tests for scripts/lib/gemini-exec.mjs
 * Uses node:test — zero npm dependencies.
 *
 * spawn/monitor/collect/shutdown tests use mock ChildProcess objects built
 * from EventEmitter + Readable/Writable streams, so no real gemini binary is
 * needed and no processes are started.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

import {
  parseGeminiJsonOutput,
  mapGeminiExecError,
  monitor,
  collect,
  shutdown,
} from '../lib/gemini-exec.mjs';
import { buildEnhancedPath } from '../lib/resolve-binary.mjs';

// ─── Mock helpers ──────────────────────────────────────────────────────────────

/**
 * Build a minimal mock ChildProcess compatible with GeminiHandle internals.
 * Wires up stdin/stdout/stderr as proper streams so the handle's event listeners
 * attach cleanly.
 */
function createMockChildProcess() {
  const child = new EventEmitter();
  child.stdin = new Writable({ write(chunk, enc, cb) { cb(); } });
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.pid = 54321;
  child.killed = false;
  child.kill = (signal = 'SIGTERM') => {
    child.killed = true;
    child.emit('exit', signal === 'SIGKILL' ? 137 : 0, signal);
  };
  return child;
}

/**
 * Build a GeminiHandle manually (bypassing spawn()) so tests stay hermetic.
 * Attaches the same data/exit/error listeners that spawn() would attach.
 */
function createHandle(child) {
  const handle = {
    pid: child.pid,
    process: child,
    stdout: child.stdout,
    kill: (signal = 'SIGTERM') => {
      try { child.kill(signal); } catch {}
    },
    _events: [],
    _partial: '',
    status: 'running',
    _output: '',
    _usage: null,
    _exitCode: null,
    _stderrChunks: [],
  };

  // Accumulate stdout — Gemini emits single JSON object at the end
  child.stdout.on('data', (chunk) => {
    handle._partial += chunk.toString();
  });

  // Accumulate stderr (capped at 100)
  child.stderr.on('data', (chunk) => {
    if (handle._stderrChunks.length < 100) {
      handle._stderrChunks.push(chunk.toString());
    }
  });

  // On exit: flush accumulated stdout, parse JSON, set final status
  child.on('exit', (code) => {
    handle._exitCode = code;
    _flushOutput(handle);
    if (code !== 0 && handle.status === 'running') {
      handle.status = 'failed';
    }
  });

  child.on('error', (err) => {
    handle._stderrChunks.push(err.message);
    handle.status = 'failed';
  });

  return handle;
}

/**
 * Local copy of _flushOutput for use in test handle (mirrors production logic).
 */
function _flushOutput(handle) {
  const raw = handle._partial;
  if (!raw || !raw.trim()) return;

  const { output, usage, error } = parseGeminiJsonOutput(raw);
  handle._output = output;
  handle._usage = usage;
  handle._partial = '';

  const event = { type: 'gemini.result', output, usage, error };
  handle._events.push(event);

  if (error) {
    handle.status = 'failed';
    handle._stderrChunks.push(error);
  } else if (handle.status === 'running') {
    handle.status = 'completed';
  }
}

/** Wait one microtask tick for stream data events to propagate */
const tick = () => new Promise(r => setImmediate(r));

// ─── parseGeminiJsonOutput ────────────────────────────────────────────────────

test('parseGeminiJsonOutput: parses normal response', () => {
  const raw = JSON.stringify({ response: 'Hello world', stats: { tokensUsed: 42 }, error: null });
  const result = parseGeminiJsonOutput(raw);
  assert.equal(result.output, 'Hello world');
  assert.deepEqual(result.usage, { tokensUsed: 42 });
  assert.equal(result.error, null);
});

test('parseGeminiJsonOutput: returns error message when error field is present', () => {
  const raw = JSON.stringify({ response: null, stats: null, error: { message: 'API key invalid', code: 'AUTH_FAILED' } });
  const result = parseGeminiJsonOutput(raw);
  assert.equal(result.output, '');
  assert.equal(result.error, 'API key invalid');
});

test('parseGeminiJsonOutput: handles null response field', () => {
  const raw = JSON.stringify({ response: null, stats: { tokensUsed: 0 }, error: null });
  const result = parseGeminiJsonOutput(raw);
  assert.equal(result.output, '');
  assert.equal(result.error, null);
});

test('parseGeminiJsonOutput: empty string returns error', () => {
  const result = parseGeminiJsonOutput('');
  assert.equal(result.output, '');
  assert.ok(result.error !== null, 'should have an error for empty input');
});

test('parseGeminiJsonOutput: null input returns error', () => {
  const result = parseGeminiJsonOutput(null);
  assert.equal(result.output, '');
  assert.ok(result.error !== null);
});

test('parseGeminiJsonOutput: malformed JSON returns error', () => {
  const result = parseGeminiJsonOutput('{not valid json}');
  assert.equal(result.output, '');
  assert.ok(result.error !== null);
  assert.ok(result.error.includes('Malformed JSON'));
});

test('parseGeminiJsonOutput: preserves usage stats alongside error', () => {
  const raw = JSON.stringify({ response: null, stats: { tokensUsed: 10 }, error: { message: 'quota exceeded', code: 'QUOTA' } });
  const result = parseGeminiJsonOutput(raw);
  assert.deepEqual(result.usage, { tokensUsed: 10 });
  assert.equal(result.error, 'quota exceeded');
});

test('parseGeminiJsonOutput: response with stats and no error', () => {
  const raw = JSON.stringify({
    response: 'Generated code here',
    stats: { tokensUsed: 150, toolCalls: 3 },
    error: null,
  });
  const result = parseGeminiJsonOutput(raw);
  assert.equal(result.output, 'Generated code here');
  assert.equal(result.usage.tokensUsed, 150);
  assert.equal(result.usage.toolCalls, 3);
  assert.equal(result.error, null);
});

// ─── mapGeminiExecError ────────────────────────────────────────────────────────

test('mapGeminiExecError: "authentication" → auth_failed', () => {
  assert.equal(mapGeminiExecError('authentication failed'), 'auth_failed');
});

test('mapGeminiExecError: "API key" → auth_failed', () => {
  assert.equal(mapGeminiExecError('Invalid API key provided'), 'auth_failed');
});

test('mapGeminiExecError: "login" text via not logged in → auth_failed', () => {
  assert.equal(mapGeminiExecError('not logged in, please authenticate'), 'auth_failed');
});

test('mapGeminiExecError: "rate limit" → rate_limited', () => {
  assert.equal(mapGeminiExecError('rate limit exceeded'), 'rate_limited');
});

test('mapGeminiExecError: "429" → rate_limited', () => {
  assert.equal(mapGeminiExecError('HTTP 429: Too Many Requests'), 'rate_limited');
});

test('mapGeminiExecError: "quota" → rate_limited', () => {
  assert.equal(mapGeminiExecError('quota exceeded for this project'), 'rate_limited');
});

test('mapGeminiExecError: "command not found" → not_installed', () => {
  assert.equal(mapGeminiExecError('zsh: command not found: gemini'), 'not_installed');
});

test('mapGeminiExecError: "ENOENT" → not_installed', () => {
  assert.equal(mapGeminiExecError('spawn ENOENT: gemini binary not found'), 'not_installed');
});

test('mapGeminiExecError: "not found" → not_installed', () => {
  assert.equal(mapGeminiExecError('gemini: not found in PATH'), 'not_installed');
});

test('mapGeminiExecError: "ETIMEDOUT" → network', () => {
  assert.equal(mapGeminiExecError('ETIMEDOUT connecting to generativelanguage.googleapis.com'), 'network');
});

test('mapGeminiExecError: "ECONNREFUSED" → network', () => {
  assert.equal(mapGeminiExecError('ECONNREFUSED 127.0.0.1:443'), 'network');
});

test('mapGeminiExecError: "network error" → network', () => {
  assert.equal(mapGeminiExecError('network error: request failed'), 'network');
});

test('mapGeminiExecError: "context" → context_exceeded', () => {
  assert.equal(mapGeminiExecError('context window exceeded'), 'context_exceeded');
});

test('mapGeminiExecError: "too long" → context_exceeded', () => {
  assert.equal(mapGeminiExecError('prompt is too long for this model'), 'context_exceeded');
});

test('mapGeminiExecError: "token limit" → context_exceeded', () => {
  assert.equal(mapGeminiExecError('token limit reached for model'), 'context_exceeded');
});

test('mapGeminiExecError: "signal" → crash', () => {
  assert.equal(mapGeminiExecError('process killed by signal'), 'crash');
});

test('mapGeminiExecError: "SIGSEGV" → crash', () => {
  assert.equal(mapGeminiExecError('Segmentation fault (SIGSEGV)'), 'crash');
});

test('mapGeminiExecError: "SIGABRT" → crash', () => {
  assert.equal(mapGeminiExecError('Aborted (SIGABRT)'), 'crash');
});

test('mapGeminiExecError: unrecognized text → unknown', () => {
  assert.equal(mapGeminiExecError('something completely unrecognized'), 'unknown');
});

test('mapGeminiExecError: null → unknown', () => {
  assert.equal(mapGeminiExecError(null), 'unknown');
});

test('mapGeminiExecError: undefined → unknown', () => {
  assert.equal(mapGeminiExecError(undefined), 'unknown');
});

// ─── buildEnhancedPath ────────────────────────────────────────────────────────

test('buildEnhancedPath: returns a non-empty string', () => {
  const path = buildEnhancedPath();
  assert.equal(typeof path, 'string');
  assert.ok(path.length > 0);
});

test('buildEnhancedPath: contains known search paths', () => {
  const path = buildEnhancedPath();
  // Should include at least one of the well-known directories
  assert.ok(
    path.includes('/opt/homebrew/bin') || path.includes('/usr/local/bin') || path.includes('/usr/bin'),
    'should include at least one known binary path'
  );
});

test('buildEnhancedPath: no duplicate entries', () => {
  const path = buildEnhancedPath();
  const parts = path.split(':');
  const unique = new Set(parts);
  assert.equal(parts.length, unique.size, 'PATH should have no duplicate entries');
});

// ─── monitor ─────────────────────────────────────────────────────────────────

test('monitor: returns correct shape for a fresh running handle', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  const result = monitor(handle);

  assert.ok('status' in result, 'result must have status');
  assert.ok('output' in result, 'result must have output');
  assert.ok('events' in result, 'result must have events');
  assert.ok(Array.isArray(result.events), 'events must be an array');
  assert.equal(result.status, 'running');
  assert.equal(result.output, '');
  assert.equal(result.events.length, 0);
  assert.ok(!('error' in result), 'no error field on running handle');
  assert.ok(!('usage' in result), 'no usage field until process completes');
});

test('monitor: status=completed and usage after exit with valid JSON', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  const payload = JSON.stringify({ response: 'Answer here', stats: { tokensUsed: 25 }, error: null });
  child.stdout.push(payload);
  await tick();
  child.emit('exit', 0);
  await tick();

  const result = monitor(handle);
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'Answer here');
  assert.deepEqual(result.usage, { tokensUsed: 25 });
  assert.ok(!('error' in result));
});

test('monitor: status=failed when process exits non-zero', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  child.stdout.push('');
  await tick();
  // Simulate non-zero exit directly
  handle.status = 'failed';
  handle._exitCode = 1;
  handle._stderrChunks.push('rate limit exceeded');

  const result = monitor(handle);
  assert.equal(result.status, 'failed');
  assert.ok('error' in result);
  assert.equal(result.error.category, 'rate_limited');
});

test('monitor: error.category is populated from stderr', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  handle.status = 'failed';
  handle._stderrChunks.push('authentication failed: API key invalid');
  handle._exitCode = 1;

  const result = monitor(handle);
  assert.equal(result.error.category, 'auth_failed');
  assert.equal(result.error.exitCode, 1);
});

test('monitor: events array includes gemini.result event after exit', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  child.stdout.push(JSON.stringify({ response: 'ok', stats: null, error: null }));
  await tick();
  child.emit('exit', 0);
  await tick();

  const result = monitor(handle);
  assert.ok(result.events.length > 0);
  assert.equal(result.events[0].type, 'gemini.result');
});

// ─── collect ─────────────────────────────────────────────────────────────────

test('collect: resolves immediately when handle is already completed', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  handle.status = 'completed';
  handle._output = 'pre-resolved output';
  handle._usage = { tokensUsed: 5 };

  const result = await collect(handle, 5000);
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'pre-resolved output');
  assert.deepEqual(result.usage, { tokensUsed: 5 });
});

test('collect: resolves immediately when handle is already failed', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  handle.status = 'failed';
  handle._exitCode = 2;
  handle._stderrChunks.push('command not found: gemini');

  const result = await collect(handle, 5000);
  assert.equal(result.status, 'failed');
  assert.ok('error' in result);
  assert.equal(result.error.category, 'not_installed');
});

test('collect: waits for exit event then resolves with parsed JSON', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  const collectPromise = collect(handle, 5000);

  child.stdout.push(JSON.stringify({ response: 'async answer', stats: { tokensUsed: 10 }, error: null }));
  await tick();
  child.emit('exit', 0);

  const result = await collectPromise;
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'async answer');
});

test('collect: resolves with timeout error when process hangs', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  // Do NOT emit exit — let it time out

  const result = await collect(handle, 50); // 50ms timeout
  assert.equal(result.status, 'failed');
  assert.equal(result.error.category, 'timeout');
  assert.ok(result.error.message.includes('50ms'));
});

test('collect: resolves when _exitCode is set before attaching listener', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  // Simulate exit already happened (race condition guard)
  handle._exitCode = 0;
  handle.status = 'completed';
  handle._output = 'already done';

  const result = await collect(handle, 5000);
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'already done');
});

// ─── shutdown ─────────────────────────────────────────────────────────────────

test('shutdown: sends SIGTERM and marks process as killed', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  assert.equal(child.killed, false);
  shutdown(handle);
  assert.equal(child.killed, true);
});

test('shutdown: does nothing if process is already killed', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  child.killed = true;
  handle.process.killed = true;

  // Should not throw
  const result = await shutdown(handle, 50);
  assert.ok(true, 'should resolve without error');
});

test('shutdown: resolves immediately when process already has _exitCode', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  handle._exitCode = 0;

  const start = Date.now();
  await shutdown(handle, 5000);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `should resolve quickly, took ${elapsed}ms`);
});

test('shutdown: returns a Promise', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  const result = shutdown(handle, 100);
  assert.ok(result instanceof Promise || (result && typeof result.then === 'function'));
});

test('shutdown: SIGKILL sent after grace period if process does not exit', async () => {
  const child = createMockChildProcess();
  const signals = [];
  // Override kill so it does NOT auto-emit exit (simulates a hung process)
  child.kill = (signal) => { signals.push(signal); };
  child.killed = false;
  const handle = createHandle(child);
  handle.kill = (signal) => { signals.push(signal); };

  await shutdown(handle, 50); // 50ms grace
  assert.ok(signals.includes('SIGTERM'), 'SIGTERM should be sent first');
  assert.ok(signals.includes('SIGKILL'), 'SIGKILL should be sent after grace period');
});

test('shutdown: resolves early without SIGKILL when process exits in time', async () => {
  const child = createMockChildProcess();
  const exitSignals = [];
  child.kill = (signal) => {
    exitSignals.push(signal);
    // Simulate normal exit on SIGTERM
    setImmediate(() => child.emit('exit', 0, signal));
  };
  child.killed = false;
  const handle = createHandle(child);

  const start = Date.now();
  await shutdown(handle, 5000);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `should resolve quickly, took ${elapsed}ms`);
  assert.ok(exitSignals.includes('SIGTERM'));
  assert.ok(!exitSignals.includes('SIGKILL'), 'SIGKILL should NOT be sent if process exits in time');
});

// ─── stderr capping ───────────────────────────────────────────────────────────

test('stderr capping: more than 100 entries are discarded after cap', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  for (let i = 0; i < 110; i++) {
    child.stderr.push(`error line ${i}\n`);
  }
  await tick();

  assert.equal(handle._stderrChunks.length, 100, 'stderr should be capped at 100 entries');
});

// ─── export surface ───────────────────────────────────────────────────────────

test('all required exports are present and callable', async () => {
  const mod = await import('../lib/gemini-exec.mjs');
  assert.equal(typeof mod.spawn, 'function', 'spawn must be exported');
  assert.equal(typeof mod.monitor, 'function', 'monitor must be exported');
  assert.equal(typeof mod.collect, 'function', 'collect must be exported');
  assert.equal(typeof mod.shutdown, 'function', 'shutdown must be exported');
  assert.equal(typeof mod.mapGeminiExecError, 'function', 'mapGeminiExecError must be exported');
  assert.equal(typeof mod.parseGeminiJsonOutput, 'function', 'parseGeminiJsonOutput must be exported');
  // buildEnhancedPath is now imported from resolve-binary.mjs, not gemini-exec.mjs
});

// ─── Credential invalidation on auth_failed ───────────────────────────────────

test('collect(): auth_failed category triggers invalidateCache for handle._credentialAccount', async () => {
  const mod = await import('../lib/gemini-exec.mjs');
  const credMod = await import('../lib/gemini-credential.mjs');

  // Populate cache with a fake entry for account 'test-acct'
  credMod.__resetForTest();
  credMod.__setExecFileSyncForTest(() => 'populated-key\n');
  // Resolve once to populate
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  try {
    const pre = credMod.resolveGeminiApiKey({ account: 'test-acct' });
    assert.equal(pre, 'populated-key');

    // Build a failed handle WITH _credentialAccount set, simulating an auth rejection
    const handle = {
      status: 'failed',
      _output: '',
      _events: [],
      _stderrChunks: ['Error: authentication failed: invalid API key\n'],
      _exitCode: 1,
      _credentialAccount: 'test-acct',
    };

    // Swap the mock so any re-read would produce a different key —
    // we'll verify the resolver refetches, proving cache was invalidated.
    credMod.__setExecFileSyncForTest(() => 'rotated-key\n');

    // Silence stderr during collect (invalidation event log)
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      const result = await mod.collect(handle);
      assert.equal(result.error?.category, 'auth_failed');
    } finally {
      process.stderr.write = origWrite;
    }

    // After invalidation, next resolve for same account should hit execFileSync
    // and return the new mock value.
    const post = credMod.resolveGeminiApiKey({ account: 'test-acct' });
    assert.equal(post, 'rotated-key', 'cache must have been invalidated by auth_failed');
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    credMod.__resetForTest();
  }
});

test('collect(): non-auth errors do NOT invalidate cache', async () => {
  const mod = await import('../lib/gemini-exec.mjs');
  const credMod = await import('../lib/gemini-credential.mjs');

  credMod.__resetForTest();
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  let callCount = 0;
  credMod.__setExecFileSyncForTest(() => { callCount++; return 'stable-key\n'; });
  try {
    credMod.resolveGeminiApiKey({ account: 'stable-acct' });
    assert.equal(callCount, 1);

    // Simulate a rate_limited error
    const handle = {
      status: 'failed',
      _output: '',
      _events: [],
      _stderrChunks: ['Error: rate limit exceeded (429)\n'],
      _exitCode: 1,
      _credentialAccount: 'stable-acct',
    };
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      const r = await mod.collect(handle);
      assert.equal(r.error?.category, 'rate_limited');
    } finally {
      process.stderr.write = origWrite;
    }

    // Cache must still be intact — second resolve should NOT refetch
    credMod.resolveGeminiApiKey({ account: 'stable-acct' });
    assert.equal(callCount, 1, 'rate_limited must not invalidate credential cache');
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    credMod.__resetForTest();
  }
});

// ─── Stale-warning emission (PR 5 — codex adapter-level coverage) ─────────────

function _captureStderrEventName(fn, eventName) {
  const origWrite = process.stderr.write.bind(process.stderr);
  const captured = [];
  process.stderr.write = (chunk) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    if (text.includes(eventName)) captured.push(text);
    return true;
  };
  try { return fn().then(() => captured); }
  finally { process.stderr.write = origWrite; }
}

async function _runAuthFailedCollect(credentialService) {
  const mod = await import('../lib/gemini-exec.mjs');
  const handle = {
    status: 'failed',
    _output: '',
    _events: [],
    _stderrChunks: ['Error: authentication failed: invalid API key\n'],
    _exitCode: 1,
    _credentialAccount: 'test-acct',
    _credentialService: credentialService,
  };
  const origWrite = process.stderr.write.bind(process.stderr);
  const captured = [];
  process.stderr.write = (chunk) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    captured.push(text);
    return true;
  };
  try {
    await mod.collect(handle);
  } finally {
    process.stderr.write = origWrite;
  }
  return captured.join('');
}

test('collect(): auth_failed + handle._credentialService === AO_KEYCHAIN_SERVICE → emits stale warning', async () => {
  const stderr = await _runAuthFailedCollect('agent-olympus.gemini-api-key');
  assert.ok(
    stderr.includes('gemini_cred_stale_ao_keychain'),
    `expected stale warning in stderr, got: ${stderr}`
  );
});

test('collect(): auth_failed + handle._credentialService === gemini-cli-api-key → does NOT emit stale warning', async () => {
  const stderr = await _runAuthFailedCollect('gemini-cli-api-key');
  assert.ok(
    !stderr.includes('gemini_cred_stale_ao_keychain'),
    `shared-keychain must not fire ao-keychain-specific warning; got: ${stderr}`
  );
});

test('collect(): auth_failed + handle._credentialService unset → does NOT emit stale warning', async () => {
  const stderr = await _runAuthFailedCollect(undefined);
  assert.ok(
    !stderr.includes('gemini_cred_stale_ao_keychain'),
    `missing service field must be safe (no warning); got: ${stderr}`
  );
});
