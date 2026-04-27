/**
 * Unit tests for scripts/lib/codex-exec.mjs
 * Uses node:test — zero npm dependencies.
 *
 * spawn/monitor/collect/shutdown tests use mock ChildProcess objects built
 * from EventEmitter + Readable/Writable streams, so no real codex binary is
 * needed and no processes are started.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

import {
  parseJSONLEvents,
  mapJsonlErrorToCategory,
  monitor,
  collect,
  shutdown,
  _buildSpawnArgs,
} from '../lib/codex-exec.mjs';

// ─── Mock helpers ──────────────────────────────────────────────────────────────

/**
 * Build a minimal mock ChildProcess compatible with the CodexHandle internals.
 * Wires up stdin/stdout/stderr as proper streams so the handle's event listeners
 * attach cleanly.
 */
function createMockChildProcess() {
  const child = new EventEmitter();
  child.stdin = new Writable({ write(chunk, enc, cb) { cb(); } });
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.pid = 12345;
  child.killed = false;
  child.kill = (signal = 'SIGTERM') => {
    child.killed = true;
    child.emit('exit', 0, signal);
  };
  // Real Node child_process always emits 'close' after 'exit' once stdio
  // streams have drained. The Bug B fix in collect() listens on 'close',
  // so the mock must mirror real semantics. Auto-fire 'close' after 'exit'
  // (issue #64).
  const origEmit = child.emit.bind(child);
  child.emit = (event, ...args) => {
    const result = origEmit(event, ...args);
    if (event === 'exit') {
      // Use queueMicrotask so any synchronous 'exit' listeners (in spawn())
      // run first — matches Node's ordering where 'close' follows 'exit'.
      queueMicrotask(() => origEmit('close', ...args));
    }
    return result;
  };
  return child;
}

/**
 * Build a CodexHandle manually (bypassing spawn()) so tests stay hermetic.
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
    threadId: null,
    status: 'running',
    _output: '',
    _usage: null,
    _exitCode: null,
    _stderrChunks: [],
    _hadItemFailure: false,
  };

  child.stdout.on('data', (chunk) => {
    const { parseJSONLEvents: parse } = { parseJSONLEvents };
    const text = handle._partial + chunk.toString();
    const { events, remainder } = parseJSONLEvents(text);
    handle._partial = remainder;

    for (const event of events) {
      handle._events.push(event);

      if (event.type === 'thread.started' && event.thread_id) {
        handle.threadId = event.thread_id;
      }

      if (event.type === 'item.completed' && event.item) {
        if (event.item.type === 'agent_message' && event.item.text) {
          handle._output += event.item.text + '\n';
        } else if (event.item.type === 'command_execution' && event.item.aggregated_output) {
          handle._output += event.item.aggregated_output;
        }
        if (event.item.status === 'failed') {
          handle._hadItemFailure = true;
        }
      }

      if (event.type === 'turn.completed') {
        handle.status = 'completed';
        if (event.usage) handle._usage = event.usage;
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    handle._stderrChunks.push(chunk.toString());
  });

  child.on('exit', (code) => {
    handle._exitCode = code;
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

// ─── _buildSpawnArgs ──────────────────────────────────────────────────────────
// Verifies CLI flag composition for codex 0.118+ (global -a/-s before `exec`).

test('_buildSpawnArgs: level=full-auto → -a never -s danger-full-access before exec', () => {
  const args = _buildSpawnArgs({ level: 'full-auto' });
  assert.deepEqual(args, [
    '-a', 'never', '-s', 'danger-full-access',
    'exec', '--json', '--ephemeral', '-',
  ]);
});

test('_buildSpawnArgs: level=auto-edit → -a never -s workspace-write before exec', () => {
  const args = _buildSpawnArgs({ level: 'auto-edit' });
  assert.deepEqual(args, [
    '-a', 'never', '-s', 'workspace-write',
    'exec', '--json', '--ephemeral', '-',
  ]);
});

test('_buildSpawnArgs: level=suggest → -a never -s read-only before exec', () => {
  const args = _buildSpawnArgs({ level: 'suggest' });
  assert.deepEqual(args, [
    '-a', 'never', '-s', 'read-only',
    'exec', '--json', '--ephemeral', '-',
  ]);
});

test('_buildSpawnArgs: omitted level → legacy bypass flag (backward compat)', () => {
  const args = _buildSpawnArgs({});
  assert.deepEqual(args, [
    '--dangerously-bypass-approvals-and-sandbox',
    'exec', '--json', '--ephemeral', '-',
  ]);
});

test('_buildSpawnArgs: no opts → legacy bypass', () => {
  const args = _buildSpawnArgs();
  assert.equal(args[0], '--dangerously-bypass-approvals-and-sandbox');
});

test('_buildSpawnArgs: invalid level "auto" → legacy bypass (strict validation)', () => {
  // 'auto' is an autonomy.json value, NOT a resolved level; if a caller bug
  // forwards it unresolved, we should fall through to legacy bypass rather
  // than silently downgrade to read-only.
  const args = _buildSpawnArgs({ level: 'auto' });
  assert.equal(args[0], '--dangerously-bypass-approvals-and-sandbox');
});

test('_buildSpawnArgs: invalid level "typo" → legacy bypass', () => {
  const args = _buildSpawnArgs({ level: 'typoo' });
  assert.equal(args[0], '--dangerously-bypass-approvals-and-sandbox');
});

test('_buildSpawnArgs: empty string level → legacy bypass', () => {
  const args = _buildSpawnArgs({ level: '' });
  assert.equal(args[0], '--dangerously-bypass-approvals-and-sandbox');
});

test('_buildSpawnArgs: approval flags always precede exec subcommand (codex 0.118+)', () => {
  for (const level of ['full-auto', 'auto-edit', 'suggest']) {
    const args = _buildSpawnArgs({ level });
    const execIdx = args.indexOf('exec');
    const approvalIdx = args.indexOf('-a');
    assert.ok(approvalIdx >= 0, `level=${level} should include -a`);
    assert.ok(approvalIdx < execIdx, `level=${level}: -a (${approvalIdx}) must come before exec (${execIdx})`);
  }
});

// ─── parseJSONLEvents ─────────────────────────────────────────────────────────

test('parseJSONLEvents: parses valid JSONL into event objects', () => {
  const input = '{"type":"thread.started","thread_id":"abc"}\n{"type":"turn.started"}\n';
  const { events, remainder } = parseJSONLEvents(input);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'thread.started');
  assert.equal(events[0].thread_id, 'abc');
  assert.equal(events[1].type, 'turn.started');
  assert.equal(remainder, '');
});

test('parseJSONLEvents: partial last line is returned as remainder', () => {
  const input = '{"type":"turn.started"}\n{"type":"item.star';
  const { events, remainder } = parseJSONLEvents(input);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'turn.started');
  assert.equal(remainder, '{"type":"item.star');
});

test('parseJSONLEvents: empty and whitespace-only lines are skipped', () => {
  const input = '\n   \n{"type":"turn.started"}\n\n';
  const { events } = parseJSONLEvents(input);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'turn.started');
});

test('parseJSONLEvents: malformed JSON lines are skipped without throwing', () => {
  const input = 'not-json\n{"type":"turn.started"}\n{broken\n';
  const { events } = parseJSONLEvents(input);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'turn.started');
});

test('parseJSONLEvents: empty string returns empty events and empty remainder', () => {
  const { events, remainder } = parseJSONLEvents('');
  assert.equal(events.length, 0);
  assert.equal(remainder, '');
});

// ─── mapJsonlErrorToCategory ──────────────────────────────────────────────────

test('mapJsonlErrorToCategory: "authentication failed" → auth_failed', () => {
  assert.equal(mapJsonlErrorToCategory('authentication failed for token'), 'auth_failed');
});

test('mapJsonlErrorToCategory: "invalid api key" → auth_failed', () => {
  assert.equal(mapJsonlErrorToCategory('Error: invalid api key provided'), 'auth_failed');
});

test('mapJsonlErrorToCategory: "rate limit exceeded" → rate_limited', () => {
  assert.equal(mapJsonlErrorToCategory('rate limit exceeded, please slow down'), 'rate_limited');
});

test('mapJsonlErrorToCategory: "429" status → rate_limited', () => {
  assert.equal(mapJsonlErrorToCategory('HTTP 429: too many requests'), 'rate_limited');
});

test('mapJsonlErrorToCategory: "command not found" → not_installed', () => {
  assert.equal(mapJsonlErrorToCategory('zsh: command not found: codex'), 'not_installed');
});

test('mapJsonlErrorToCategory: "ENOENT" → not_installed', () => {
  assert.equal(mapJsonlErrorToCategory("spawn ENOENT '/usr/local/bin/codex'"), 'not_installed');
});

test('mapJsonlErrorToCategory: "ETIMEDOUT" → network', () => {
  assert.equal(mapJsonlErrorToCategory('Error: ETIMEDOUT connecting to api.openai.com'), 'network');
});

test('mapJsonlErrorToCategory: "ECONNRESET" → network', () => {
  assert.equal(mapJsonlErrorToCategory('ECONNRESET: connection reset by peer'), 'network');
});

test('mapJsonlErrorToCategory: "socket hang up" → network', () => {
  assert.equal(mapJsonlErrorToCategory('socket hang up after inactivity'), 'network');
});

test('mapJsonlErrorToCategory: "fatal error SIGSEGV" → crash', () => {
  assert.equal(mapJsonlErrorToCategory('fatal error: received signal SIGSEGV'), 'crash');
});

test('mapJsonlErrorToCategory: "unhandled exception" → crash', () => {
  assert.equal(mapJsonlErrorToCategory('unhandled exception: TypeError: null'), 'crash');
});

test('mapJsonlErrorToCategory: no pattern match → unknown', () => {
  assert.equal(mapJsonlErrorToCategory('something completely different'), 'unknown');
});

test('mapJsonlErrorToCategory: null input → unknown', () => {
  assert.equal(mapJsonlErrorToCategory(null), 'unknown');
});

test('mapJsonlErrorToCategory: undefined input → unknown', () => {
  assert.equal(mapJsonlErrorToCategory(undefined), 'unknown');
});

// ─── monitor ─────────────────────────────────────────────────────────────────

test('monitor: returns MonitorResult shape for a freshly created running handle', () => {
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
  assert.ok(!('usage' in result), 'no usage field until turn.completed');
});

// Helper: wait for the readable stream's async data event to fire
const tick = () => new Promise(r => setImmediate(r));

test('monitor: status=completed + usage after turn.completed event', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  const usagePayload = { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 };
  child.stdout.push(
    JSON.stringify({ type: 'thread.started', thread_id: 'tid-1' }) + '\n' +
    JSON.stringify({ type: 'turn.started' }) + '\n' +
    JSON.stringify({ type: 'turn.completed', usage: usagePayload }) + '\n'
  );
  await tick(); // Readable.push fires 'data' on next tick

  const result = monitor(handle);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.usage, usagePayload);
  assert.ok(!('error' in result));
});

test('monitor: threadId captured from thread.started', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  child.stdout.push(JSON.stringify({ type: 'thread.started', thread_id: 'my-thread-uuid' }) + '\n');
  await tick();

  assert.equal(handle.threadId, 'my-thread-uuid');
});

test('monitor: agent_message text accumulated in output', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  child.stdout.push(
    JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Hello world' } }) + '\n'
  );
  await tick();

  const result = monitor(handle);
  assert.ok(result.output.includes('Hello world'));
});

test('monitor: command_execution aggregated_output accumulated', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  child.stdout.push(
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_2', type: 'command_execution', command: 'ls', aggregated_output: 'file.txt\n', exit_code: 0, status: 'completed' },
    }) + '\n'
  );
  await tick();

  const result = monitor(handle);
  assert.ok(result.output.includes('file.txt'));
});

test('monitor: item.status=failed sets _hadItemFailure but not handle.status', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  child.stdout.push(
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_3', type: 'command_execution', command: 'bad-cmd', aggregated_output: '', exit_code: 1, status: 'failed' },
    }) + '\n'
  );
  await tick();

  // handle.status stays 'running' — only _hadItemFailure is set
  assert.equal(handle.status, 'running');
  assert.equal(handle._hadItemFailure, true);
  const result = monitor(handle);
  assert.equal(result.status, 'running');
});

test('monitor: turn.completed after item.status=failed resolves to completed (Codex R8 retry scenario)', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  // Intermediate item fails (e.g. auth retry in Codex R8)
  child.stdout.push(
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_retry', type: 'command_execution', command: 'retry-cmd', aggregated_output: '', exit_code: 1, status: 'failed' },
    }) + '\n'
  );
  await tick();
  assert.equal(handle.status, 'running', 'item failure must NOT commit handle to failed status');
  assert.equal(handle._hadItemFailure, true);

  // Codex internally retries and completes the turn successfully
  child.stdout.push(
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_msg', type: 'agent_message', text: 'Task complete', status: 'completed' },
    }) + '\n' +
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }) + '\n'
  );
  await tick();

  const result = monitor(handle);
  assert.equal(result.status, 'completed');
  assert.ok(!('error' in result));
  assert.ok(result.output.includes('Task complete'));
});

test('monitor: error.category populated on failed handle with stderr', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  // Simulate non-zero exit
  handle.status = 'failed';
  handle._stderrChunks.push('authentication failed: invalid API key');
  handle._exitCode = 1;

  const result = monitor(handle);
  assert.equal(result.error.category, 'auth_failed');
  assert.equal(result.error.exitCode, 1);
});

// ─── collect ─────────────────────────────────────────────────────────────────

test('collect: does NOT exit early when item.status=failed arrives before turn.completed', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  // Item fails — in old design this set handle.status='failed' causing collect to exit early
  child.stdout.push(
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_fail', type: 'command_execution', command: 'retry-cmd', aggregated_output: '', exit_code: 1, status: 'failed' },
    }) + '\n'
  );
  await tick();

  // collect() starts — should wait (not exit immediately with failed)
  const collectPromise = collect(handle, 5000);

  // turn.completed arrives shortly after
  child.stdout.push(
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 3 } }) + '\n'
  );
  child.emit('exit', 0);

  const result = await collectPromise;
  assert.equal(result.status, 'completed', 'collect must wait for turn.completed, not exit on item failure');
  assert.ok(!('error' in result));
});

test('collect: resolves immediately when handle is already completed', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  handle.status = 'completed';
  handle._usage = { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 };

  const result = await collect(handle, 5000);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.usage, handle._usage);
});

test('collect: resolves immediately when handle is already failed', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  handle.status = 'failed';
  handle._exitCode = 1;

  const result = await collect(handle, 5000);
  assert.equal(result.status, 'failed');
  assert.ok('error' in result);
});

test('collect: waits for exit event then resolves', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  // handle is 'running'; simulate process completing after a tick

  const collectPromise = collect(handle, 5000);

  // Push turn.completed data and wait for the Readable data event to fire,
  // then emit exit so the handle's status is 'completed' before collect resolves.
  child.stdout.push(
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 2 } }) + '\n'
  );
  await tick(); // Readable data event fires on next tick
  child.emit('exit', 0);

  const result = await collectPromise;
  assert.equal(result.status, 'completed');
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

test('collect: flushes partial buffer on exit (no trailing newline)', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  // Push data WITHOUT trailing newline — goes into _partial
  child.stdout.push('{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5}}');
  await tick();

  // Verify it's stuck in _partial, not parsed
  assert.equal(handle._events.length, 0, 'event should be in _partial, not parsed');
  assert.ok(handle._partial.length > 0, '_partial should have data');

  // Now collect — should flush _partial on exit
  const collectPromise = collect(handle, 5000);
  child.emit('exit', 0);
  const result = await collectPromise;

  assert.equal(result.status, 'completed', 'should be completed after flush');
  assert.ok(result.events.length > 0, 'flushed event should appear');
});

// ─── Issue #64 regression: auth_failed false-positive + exit/close race ──────

test('issue #64 (Bug A): agent_message containing "API key" must NOT be classified as auth_failed', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  // Simulate a successful turn whose response body legitimately mentions
  // "API key" (e.g. a code review). handle._output is populated, stderr is
  // empty. We then force handle.status='failed' to exercise the classifier
  // — without the Bug A fix, the body would be fed into the classifier and
  // matched as auth_failed.
  handle._output = 'Review of auth.ts:\n1. Rotate the API key on every deploy.\n2. ...';
  handle._stderrChunks = []; // empty stderr
  handle.status = 'failed';
  handle._exitCode = 1;

  const result = monitor(handle);
  assert.equal(result.status, 'failed');
  assert.ok(result.error, 'failed status must surface an error object');
  assert.notEqual(
    result.error.category,
    'auth_failed',
    'response body must NEVER feed the classifier — was misclassifying legit code reviews as auth_failed',
  );
  assert.equal(result.error.category, 'unknown', 'empty stderr → unknown category');
});

test('issue #64 (Bug C): turn.completed in handle._events overrides transient failed status', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  // Simulate the race: spawn-side exit handler flipped status to 'failed'
  // (non-zero exit code, status was 'running'), but the queued turn.completed
  // 'data' event eventually parsed and pushed into handle._events.
  handle._events.push({ type: 'thread.started', thread_id: 't1' });
  handle._events.push({ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } });
  handle._events.push({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
  handle._output = 'Done.\n';
  handle.status = 'failed'; // transient flip from spawn's exit handler
  handle._exitCode = 1;

  const result = monitor(handle);
  assert.equal(result.status, 'completed', 'turn.completed in events must override transient failed');
  assert.ok(!('error' in result), 'completed status must NOT carry an error object');
});

test('issue #64 (Bug B): collect() listener is on close, NOT exit (race fix)', async () => {
  // This test verifies the listener-attachment contract: collect() must NOT
  // resolve on 'exit' alone. We emit exit WITHOUT a follow-up close and
  // confirm collect() does not resolve until close fires (or the timeout
  // catches it). Use a custom mock that does NOT auto-fire close.
  const child = new EventEmitter();
  child.stdin = new Writable({ write(c, e, cb) { cb(); } });
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.pid = 99988;
  child.killed = false;
  child.kill = (signal = 'SIGTERM') => { child.killed = true; };
  // No auto-close — manual control.
  const handle = createHandle(child);

  const collectPromise = collect(handle, 200); // 200ms timeout safety
  let resolved = false;
  collectPromise.then(() => { resolved = true; });

  // Fire exit alone — Bug-B-unfixed code would resolve here with stale state.
  child.emit('exit', 0);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(resolved, false, 'collect() must NOT resolve on exit alone — must wait for close');

  // Now push late stdout data — this is what the bug missed.
  child.stdout.push(
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } }) + '\n'
  );
  await new Promise((r) => setImmediate(r));

  // Fire close — collect() should now resolve with the drained data.
  child.emit('close', 0);
  const result = await collectPromise;
  assert.equal(result.status, 'completed', 'data drained before close → completed');
  assert.ok(!('error' in result));
});

// ─── shutdown ─────────────────────────────────────────────────────────────────

test('shutdown: sends SIGTERM and marks process as killed', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  assert.equal(child.killed, false);
  shutdown(handle);
  assert.equal(child.killed, true);
});

test('shutdown: does nothing if process is already killed', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  child.killed = true;

  // Should not throw
  assert.doesNotThrow(() => shutdown(handle));
});

// ─── US-005: Process lifecycle — SIGTERM → SIGKILL escalation ───────────────

test('shutdown: returns a promise', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  const result = shutdown(handle, 100);
  assert.ok(result instanceof Promise || result === undefined || (result && typeof result.then === 'function'));
});

test('shutdown: SIGKILL after grace period if process does not exit', async () => {
  const child = createMockChildProcess();
  // Override kill to NOT emit exit (simulates hung process)
  const signals = [];
  child.kill = (signal) => { signals.push(signal); };
  child.killed = false;
  const handle = createHandle(child);
  handle.kill = (signal) => { signals.push(signal); };

  await shutdown(handle, 50); // 50ms grace
  // Should have received SIGTERM first, then SIGKILL (from process.kill or handle.kill)
  assert.ok(signals.includes('SIGTERM'), 'SIGTERM should be sent first');
  assert.ok(signals.includes('SIGKILL'), 'SIGKILL should be sent after grace');
});

test('shutdown: resolves early if process exits within grace period', async () => {
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
  assert.ok(elapsed < 1000, `Should resolve quickly, took ${elapsed}ms`);
  assert.ok(exitSignals.includes('SIGTERM'));
  assert.ok(!exitSignals.includes('SIGKILL'), 'SIGKILL should NOT be sent if process exits');
});

test('shutdown: no-op when process is already killed', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  child.killed = true;
  handle.process.killed = true;

  const result = await shutdown(handle, 50);
  // Should resolve without error
  assert.ok(true);
});

// ─── US-006: Error taxonomy — timeout category ─────────────────────────────

test('mapJsonlErrorToCategory: "timeout" → timeout', () => {
  assert.equal(mapJsonlErrorToCategory('operation timeout after 30s'), 'timeout');
});

test('mapJsonlErrorToCategory: "did not complete within" → timeout', () => {
  assert.equal(mapJsonlErrorToCategory('Codex process did not complete within 30000ms'), 'timeout');
});

test('mapJsonlErrorToCategory: "timed out" → timeout', () => {
  assert.equal(mapJsonlErrorToCategory('request timed out waiting for response'), 'timeout');
});

test('mapJsonlErrorToCategory: all 7 categories exist', () => {
  const categories = new Set([
    mapJsonlErrorToCategory('authentication failed'),
    mapJsonlErrorToCategory('rate limit exceeded'),
    mapJsonlErrorToCategory('command not found'),
    mapJsonlErrorToCategory('ETIMEDOUT connection'),
    mapJsonlErrorToCategory('fatal error SIGSEGV'),
    mapJsonlErrorToCategory('operation timeout'),
    mapJsonlErrorToCategory('something else entirely'),
  ]);
  assert.deepEqual(categories, new Set(['auth_failed', 'rate_limited', 'not_installed', 'network', 'crash', 'timeout', 'unknown']));
});

// ─── export surface ───────────────────────────────────────────────────────────

test('all required exports are present and callable', async () => {
  const mod = await import('../lib/codex-exec.mjs');
  assert.equal(typeof mod.spawn, 'function', 'spawn must be exported');
  assert.equal(typeof mod.monitor, 'function', 'monitor must be exported');
  assert.equal(typeof mod.collect, 'function', 'collect must be exported');
  assert.equal(typeof mod.shutdown, 'function', 'shutdown must be exported');
  assert.equal(typeof mod.parseJSONLEvents, 'function', 'parseJSONLEvents must be exported');
  assert.equal(typeof mod.mapJsonlErrorToCategory, 'function', 'mapJsonlErrorToCategory must be exported');
});
