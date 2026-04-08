/**
 * Unit tests for scripts/lib/worker-spawn.mjs
 * Tests: detectCodexError(), selectAdapter(), adapter dispatch
 * Uses node:test — zero npm dependencies.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCodexError, selectAdapter, demoteCodexWorkersIfNeeded } from '../lib/worker-spawn.mjs';

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
