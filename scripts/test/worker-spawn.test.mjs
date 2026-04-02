/**
 * Unit tests for scripts/lib/worker-spawn.mjs
 * Tests: detectCodexError(), selectAdapter(), adapter dispatch
 * Uses node:test — zero npm dependencies.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCodexError, selectAdapter } from '../lib/worker-spawn.mjs';

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

test('selectAdapter: gemini worker → tmux', () => {
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
