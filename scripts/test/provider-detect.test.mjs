/**
 * Unit tests for the detectProvider logic from scripts/concurrency-gate.mjs.
 *
 * detectProvider is a private (non-exported) function in concurrency-gate.mjs.
 * Rather than modifying the source to export it, these tests replicate the
 * function verbatim and verify the contract documented in the source.
 * Any future change to detectProvider should be reflected here.
 *
 * Source reference: scripts/concurrency-gate.mjs @ detectProvider()
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Replicated implementation (must stay in sync with concurrency-gate.mjs)
// ---------------------------------------------------------------------------

function detectProvider(toolInput) {
  const subagentType = toolInput?.subagent_type ?? '';
  const model = (toolInput?.model ?? '').toLowerCase();

  if (subagentType.includes('claude') || model.includes('claude') || model.includes('anthropic')) {
    return 'claude';
  }
  if (subagentType.includes('codex') || model.includes('codex') || model.includes('openai') || model.includes('gpt')) {
    return 'codex';
  }
  if (subagentType.includes('gemini') || model.includes('gemini') || model.includes('google')) {
    return 'gemini';
  }
  // Default: treat as claude if subagent_type contains 'agent-olympus' or similar
  if (subagentType) {
    return 'claude';
  }
  return 'claude';
}

// ---------------------------------------------------------------------------
// claude detection
// ---------------------------------------------------------------------------

test('detectProvider: subagent_type "claude-3-sonnet" → claude', () => {
  assert.equal(detectProvider({ subagent_type: 'claude-3-sonnet' }), 'claude');
});

test('detectProvider: model "claude-3-5-sonnet-20241022" → claude', () => {
  assert.equal(detectProvider({ subagent_type: '', model: 'claude-3-5-sonnet-20241022' }), 'claude');
});

test('detectProvider: model "anthropic/claude-haiku" → claude', () => {
  assert.equal(detectProvider({ subagent_type: '', model: 'anthropic/claude-haiku' }), 'claude');
});

test('detectProvider: subagent_type "agent-olympus:atlas" → claude (default agent-olympus namespace)', () => {
  assert.equal(detectProvider({ subagent_type: 'agent-olympus:atlas' }), 'claude');
});

test('detectProvider: subagent_type "agent-olympus:athena" → claude', () => {
  assert.equal(detectProvider({ subagent_type: 'agent-olympus:athena' }), 'claude');
});

// ---------------------------------------------------------------------------
// codex detection
// ---------------------------------------------------------------------------

test('detectProvider: subagent_type "codex-mini" → codex', () => {
  assert.equal(detectProvider({ subagent_type: 'codex-mini' }), 'codex');
});

test('detectProvider: model "codex" → codex', () => {
  assert.equal(detectProvider({ subagent_type: '', model: 'codex' }), 'codex');
});

test('detectProvider: model "openai/gpt-4o" → codex', () => {
  assert.equal(detectProvider({ subagent_type: '', model: 'openai/gpt-4o' }), 'codex');
});

test('detectProvider: model "gpt-3.5-turbo" → codex', () => {
  assert.equal(detectProvider({ subagent_type: '', model: 'gpt-3.5-turbo' }), 'codex');
});

// ---------------------------------------------------------------------------
// gemini detection
// ---------------------------------------------------------------------------

test('detectProvider: subagent_type "gemini-pro" → gemini', () => {
  assert.equal(detectProvider({ subagent_type: 'gemini-pro' }), 'gemini');
});

test('detectProvider: model "gemini-1.5-flash" → gemini', () => {
  assert.equal(detectProvider({ subagent_type: '', model: 'gemini-1.5-flash' }), 'gemini');
});

test('detectProvider: model "google/gemini-ultra" → gemini', () => {
  assert.equal(detectProvider({ subagent_type: '', model: 'google/gemini-ultra' }), 'gemini');
});

// ---------------------------------------------------------------------------
// Default / fallback
// ---------------------------------------------------------------------------

test('detectProvider: empty toolInput → claude (final default)', () => {
  assert.equal(detectProvider({}), 'claude');
});

test('detectProvider: null toolInput → claude (final default)', () => {
  assert.equal(detectProvider(null), 'claude');
});

test('detectProvider: undefined toolInput → claude (final default)', () => {
  assert.equal(detectProvider(undefined), 'claude');
});

test('detectProvider: unknown subagent_type with no model → claude (non-empty subagent_type fallback)', () => {
  assert.equal(detectProvider({ subagent_type: 'some-custom-agent' }), 'claude');
});

test('detectProvider: model case-insensitivity — "Claude-3-OPUS" → claude', () => {
  assert.equal(detectProvider({ subagent_type: '', model: 'Claude-3-OPUS' }), 'claude');
});

test('detectProvider: model case-insensitivity — "GEMINI-PRO" → gemini', () => {
  assert.equal(detectProvider({ subagent_type: '', model: 'GEMINI-PRO' }), 'gemini');
});
