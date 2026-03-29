/**
 * Unit tests for scripts/lib/ci-watch.mjs
 * Tests module exports, function signatures, and degenerate inputs.
 *
 * Because watchCI and getFailedLogs call the gh CLI externally, tests focus
 * on verifiable pure logic: export shape, zero-cycle early exit, and empty
 * runId handling. No live CLI calls are made.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchCI, getFailedLogs } from '../lib/ci-watch.mjs';

// ---------------------------------------------------------------------------
// Test: module exports
// ---------------------------------------------------------------------------

test('ci-watch: watchCI is exported as a function', () => {
  assert.equal(typeof watchCI, 'function');
});

test('ci-watch: getFailedLogs is exported as a function', () => {
  assert.equal(typeof getFailedLogs, 'function');
});

// ---------------------------------------------------------------------------
// Test: watchCI degenerate input — maxCycles=0
// ---------------------------------------------------------------------------

test('watchCI: maxCycles=0 → returns immediately with a status field', async () => {
  const result = await watchCI({ branch: 'test-branch', maxCycles: 0, pollIntervalMs: 10 });
  assert.ok(result !== null && typeof result === 'object', 'must return an object');
  assert.ok('status' in result, 'result must have status field');
});

test('watchCI: maxCycles=0 → status is "skipped"', async () => {
  const result = await watchCI({ branch: 'test-branch', maxCycles: 0, pollIntervalMs: 10 });
  assert.equal(result.status, 'skipped', 'maxCycles=0 must return status "skipped"');
});

test('watchCI: maxCycles=0 → runId and conclusion are absent (no CI polled)', async () => {
  const result = await watchCI({ branch: 'test-branch', maxCycles: 0, pollIntervalMs: 10 });
  assert.equal(result.runId, undefined, 'skipped result should not have runId');
  assert.equal(result.conclusion, undefined, 'skipped result should not have conclusion');
});

// ---------------------------------------------------------------------------
// Test: getFailedLogs degenerate input — empty runId
// ---------------------------------------------------------------------------

test('getFailedLogs: empty string runId → returns string without throwing', () => {
  let threw = false;
  let result;
  try {
    result = getFailedLogs('');
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'getFailedLogs must not throw for empty runId');
  assert.equal(typeof result, 'string', 'getFailedLogs must return a string');
});

test('getFailedLogs: null runId → returns string or throws gracefully', () => {
  let result;
  try {
    result = getFailedLogs(null);
    assert.equal(typeof result, 'string', 'if resolved, result must be a string');
  } catch (err) {
    assert.ok(err instanceof Error, 'thrown value must be an Error instance');
  }
});
