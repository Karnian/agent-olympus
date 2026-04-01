/**
 * Unit tests for scripts/lib/stuck-recovery.mjs
 * Uses node:test and node:assert — zero npm dependencies.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRecoveryStrategy,
  formatRecoveryLog,
  RECOVERY_STRATEGIES,
} from '../lib/stuck-recovery.mjs';

// ---------------------------------------------------------------------------
// Helper: minimal stalled-worker and context fixtures
// ---------------------------------------------------------------------------

function makeWorker(overrides = {}) {
  return {
    name: 'worker-1',
    type: 'executor',
    status: 'running',
    lastOutput: 'Compiling... Error: cannot find module "foo"',
    stalledMs: 360000,
    recoveryAttempts: 0,
    ...overrides,
  };
}

function makeContext(overrides = {}) {
  return {
    teamName: 'test-team',
    orchestrator: 'athena',
    availableAgents: ['executor', 'debugger'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. reframe strategy on attempt 0
// ---------------------------------------------------------------------------

test('buildRecoveryStrategy: attempt 0 → action reframe', async () => {
  const result = await buildRecoveryStrategy(makeWorker({ recoveryAttempts: 0 }), makeContext());
  assert.equal(result.action, 'reframe');
  assert.ok(typeof result.prompt === 'string' && result.prompt.length > 0);
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
});

// ---------------------------------------------------------------------------
// 2. switch-agent strategy on attempt 1
// ---------------------------------------------------------------------------

test('buildRecoveryStrategy: attempt 1 → action switch-agent', async () => {
  const result = await buildRecoveryStrategy(makeWorker({ recoveryAttempts: 1 }), makeContext());
  assert.equal(result.action, 'switch-agent');
  assert.ok(typeof result.prompt === 'string' && result.prompt.length > 0);
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
});

// ---------------------------------------------------------------------------
// 3. escalate strategy on attempt 2
// ---------------------------------------------------------------------------

test('buildRecoveryStrategy: attempt 2 → action escalate', async () => {
  const result = await buildRecoveryStrategy(makeWorker({ recoveryAttempts: 2 }), makeContext());
  assert.equal(result.action, 'escalate');
  assert.ok(typeof result.prompt === 'string' && result.prompt.length > 0);
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
});

// ---------------------------------------------------------------------------
// 4. escalate strategy on attempt 5 (high count)
// ---------------------------------------------------------------------------

test('buildRecoveryStrategy: attempt 5 → action still escalate', async () => {
  const result = await buildRecoveryStrategy(makeWorker({ recoveryAttempts: 5 }), makeContext());
  assert.equal(result.action, 'escalate');
  // reason should mention the attempt count
  assert.ok(result.reason.includes('5'), `reason should reference attempt count: ${result.reason}`);
});

// ---------------------------------------------------------------------------
// 5. reframe extracts context from lastOutput
// ---------------------------------------------------------------------------

test('buildRecoveryStrategy: reframe extracts error line from lastOutput', async () => {
  const lastOutput = 'Starting build...\nError: ENOENT file not found\nDone';
  const result = await buildRecoveryStrategy(
    makeWorker({ recoveryAttempts: 0, lastOutput }),
    makeContext()
  );
  assert.equal(result.action, 'reframe');
  // The reason or prompt should reference the extracted hint
  const combined = result.reason + result.prompt;
  assert.ok(
    combined.includes('ENOENT') || combined.includes('Error'),
    `Expected extracted error hint in output: ${combined}`
  );
});

// ---------------------------------------------------------------------------
// 6. switch-agent maps executor → debugger
// ---------------------------------------------------------------------------

test('buildRecoveryStrategy: switch-agent maps executor → debugger', async () => {
  const result = await buildRecoveryStrategy(
    makeWorker({ recoveryAttempts: 1, type: 'executor' }),
    makeContext()
  );
  assert.equal(result.action, 'switch-agent');
  assert.ok(
    result.reason.includes('debugger') || result.prompt.includes('debugger'),
    `Expected "debugger" in switch-agent output: ${result.reason} / ${result.prompt}`
  );
});

// ---------------------------------------------------------------------------
// 7. switch-agent maps debugger → hephaestus
// ---------------------------------------------------------------------------

test('buildRecoveryStrategy: switch-agent maps debugger → hephaestus', async () => {
  const result = await buildRecoveryStrategy(
    makeWorker({ recoveryAttempts: 1, type: 'debugger' }),
    makeContext()
  );
  assert.equal(result.action, 'switch-agent');
  assert.ok(
    result.reason.includes('hephaestus') || result.prompt.includes('hephaestus'),
    `Expected "hephaestus" in switch-agent output: ${result.reason} / ${result.prompt}`
  );
});

// ---------------------------------------------------------------------------
// 8. switch-agent maps unknown type to executor
// ---------------------------------------------------------------------------

test('buildRecoveryStrategy: switch-agent maps unknown type → executor', async () => {
  const result = await buildRecoveryStrategy(
    makeWorker({ recoveryAttempts: 1, type: 'unknown-type' }),
    makeContext()
  );
  assert.equal(result.action, 'switch-agent');
  assert.ok(
    result.reason.includes('executor') || result.prompt.includes('executor'),
    `Expected "executor" fallback in switch-agent output: ${result.reason} / ${result.prompt}`
  );
});

// ---------------------------------------------------------------------------
// 9. formatRecoveryLog returns readable string
// ---------------------------------------------------------------------------

test('formatRecoveryLog: returns a non-empty string with key fields', () => {
  const strategy = { action: 'reframe', reason: 'Extracted error from output.' };
  const worker = { name: 'worker-1', type: 'executor', stalledMs: 360000, recoveryAttempts: 0 };
  const log = formatRecoveryLog(strategy, worker);
  assert.ok(typeof log === 'string' && log.length > 0);
  assert.ok(log.includes('worker-1'), `Expected worker name in log: ${log}`);
  assert.ok(log.includes('reframe'), `Expected action in log: ${log}`);
  assert.ok(log.includes('executor'), `Expected worker type in log: ${log}`);
});

// ---------------------------------------------------------------------------
// 10. RECOVERY_STRATEGIES has all 3 keys
// ---------------------------------------------------------------------------

test('RECOVERY_STRATEGIES: exports reframe, switch-agent, and escalate keys', () => {
  assert.ok(typeof RECOVERY_STRATEGIES === 'object' && RECOVERY_STRATEGIES !== null);
  assert.ok('reframe' in RECOVERY_STRATEGIES, 'Missing "reframe" key');
  assert.ok('switch-agent' in RECOVERY_STRATEGIES, 'Missing "switch-agent" key');
  assert.ok('escalate' in RECOVERY_STRATEGIES, 'Missing "escalate" key');
});

// ---------------------------------------------------------------------------
// 11. handles null/undefined lastOutput gracefully
// ---------------------------------------------------------------------------

test('buildRecoveryStrategy: handles null lastOutput without throwing', async () => {
  const result = await buildRecoveryStrategy(
    makeWorker({ recoveryAttempts: 0, lastOutput: null }),
    makeContext()
  );
  assert.ok(['reframe', 'switch-agent', 'escalate'].includes(result.action));
  assert.ok(typeof result.prompt === 'string');
  assert.ok(typeof result.reason === 'string');
});

test('buildRecoveryStrategy: handles undefined lastOutput without throwing', async () => {
  const worker = makeWorker({ recoveryAttempts: 0 });
  delete worker.lastOutput;
  const result = await buildRecoveryStrategy(worker, makeContext());
  assert.ok(['reframe', 'switch-agent', 'escalate'].includes(result.action));
});

// ---------------------------------------------------------------------------
// 12. handles missing recoveryAttempts (defaults to 0 → reframe)
// ---------------------------------------------------------------------------

test('buildRecoveryStrategy: missing recoveryAttempts defaults to 0 → reframe', async () => {
  const worker = makeWorker();
  delete worker.recoveryAttempts;
  const result = await buildRecoveryStrategy(worker, makeContext());
  assert.equal(result.action, 'reframe');
});
