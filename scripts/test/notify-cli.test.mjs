/**
 * Unit tests for scripts/lib/notify.mjs
 * Tests detectPlatform(), notify(), and notifyOrchestrator().
 *
 * Because desktop notifications require OS-level facilities, tests verify
 * that each function returns the correct type without throwing — they do
 * NOT assert that a visible notification was displayed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notify, notifyOrchestrator, detectPlatform } from '../lib/notify.mjs';

// ---------------------------------------------------------------------------
// Test: detectPlatform
// ---------------------------------------------------------------------------

test('detectPlatform: returns one of "macos", "linux", or "fallback"', () => {
  const platform = detectPlatform();
  const allowed = ['macos', 'linux', 'fallback'];
  assert.ok(
    allowed.includes(platform),
    `detectPlatform must return one of ${allowed.join(', ')}, got "${platform}"`,
  );
});

test('detectPlatform: returns a non-empty string', () => {
  const platform = detectPlatform();
  assert.equal(typeof platform, 'string');
  assert.ok(platform.length > 0, 'platform string must not be empty');
});

// ---------------------------------------------------------------------------
// Test: notify
// ---------------------------------------------------------------------------

test('notify: returns boolean for valid title and body', async () => {
  const result = await notify({ title: 'Test notification', body: 'This is a test.' });
  assert.equal(typeof result, 'boolean', 'notify must return a boolean');
});

test('notify: does not throw for empty title and body', async () => {
  let threw = false;
  try {
    await notify({ title: '', body: '' });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'notify must not throw for empty title/body');
});

test('notify: returns boolean for empty title and body', async () => {
  const result = await notify({ title: '', body: '' });
  assert.equal(typeof result, 'boolean', 'notify must return a boolean even for empty inputs');
});

// ---------------------------------------------------------------------------
// Test: notifyOrchestrator
// ---------------------------------------------------------------------------

test('notifyOrchestrator: event=complete, orchestrator=atlas → returns boolean', async () => {
  const result = await notifyOrchestrator({ event: 'complete', orchestrator: 'atlas' });
  assert.equal(typeof result, 'boolean', 'notifyOrchestrator must return a boolean');
});

test('notifyOrchestrator: event=blocked, orchestrator=athena, with summary → returns boolean', async () => {
  const result = await notifyOrchestrator({
    event: 'blocked',
    orchestrator: 'athena',
    summary: 'Waiting for CI to complete on branch feature/x',
  });
  assert.equal(typeof result, 'boolean', 'notifyOrchestrator must return a boolean');
});

test('notifyOrchestrator: event=ci_failed → returns boolean without throwing', async () => {
  let threw = false;
  let result;
  try {
    result = await notifyOrchestrator({ event: 'ci_failed', orchestrator: 'atlas' });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'notifyOrchestrator must not throw');
  assert.equal(typeof result, 'boolean', 'must return a boolean');
});

test('notifyOrchestrator: unknown event → returns boolean without throwing', async () => {
  let threw = false;
  let result;
  try {
    result = await notifyOrchestrator({ event: 'unknown-event', orchestrator: 'atlas' });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'notifyOrchestrator must not throw for unknown events');
  assert.equal(typeof result, 'boolean', 'must return a boolean for unknown events');
});
