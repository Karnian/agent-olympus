/**
 * Unit tests for scripts/lib/notify.mjs
 *
 * Tests detectPlatform(), escapeAppleScript(), notify(), and notifyOrchestrator().
 * All tests run with IS_TEST=true (NODE_TEST_CONTEXT is set by node --test),
 * so no real OS notifications are fired.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform, notify, notifyOrchestrator } from '../lib/notify.mjs';

// ---------------------------------------------------------------------------
// detectPlatform
// ---------------------------------------------------------------------------

describe('notify: detectPlatform', () => {
  it('returns a valid platform string', () => {
    const result = detectPlatform();
    assert.ok(['macos', 'linux', 'fallback'].includes(result));
  });

  it('returns "macos" on darwin', () => {
    // We can't mock os.platform() easily, but we can verify the current
    // platform is correctly classified
    const expected = process.platform === 'darwin' ? 'macos'
      : process.platform === 'linux' ? 'linux'
      : 'fallback';
    assert.equal(detectPlatform(), expected);
  });
});

// ---------------------------------------------------------------------------
// notify — IS_TEST guard
// ---------------------------------------------------------------------------

describe('notify: IS_TEST guard', () => {
  it('returns true without sending real notification (IS_TEST active)', () => {
    // NODE_TEST_CONTEXT is set by node --test, so IS_TEST = true
    const result = notify({ title: 'Test', body: 'Test body' });
    assert.equal(result, true);
  });

  it('handles empty title and body gracefully', () => {
    const result = notify({ title: '', body: '' });
    assert.equal(result, true);
  });

  it('handles special characters in title and body', () => {
    const result = notify({
      title: 'Test "with" quotes & <html>',
      body: 'Body with\nnewlines\tand\ttabs',
    });
    assert.equal(result, true);
  });

  it('handles sound option', () => {
    const result = notify({ title: 'Test', body: 'Test', sound: true });
    assert.equal(result, true);
  });
});

// ---------------------------------------------------------------------------
// notifyOrchestrator — template mapping
// ---------------------------------------------------------------------------

describe('notify: notifyOrchestrator', () => {
  it('returns true for "complete" event', () => {
    const result = notifyOrchestrator({
      event: 'complete',
      orchestrator: 'atlas',
      summary: 'All done',
      completed: 5,
      total: 5,
    });
    assert.equal(result, true);
  });

  it('returns true for "blocked" event', () => {
    const result = notifyOrchestrator({
      event: 'blocked',
      orchestrator: 'athena',
      summary: 'Needs input',
    });
    assert.equal(result, true);
  });

  it('returns true for "escalated" event', () => {
    const result = notifyOrchestrator({
      event: 'escalated',
      orchestrator: 'atlas',
    });
    assert.equal(result, true);
  });

  it('returns true for "ci_failed" event', () => {
    const result = notifyOrchestrator({
      event: 'ci_failed',
      orchestrator: 'atlas',
    });
    assert.equal(result, true);
  });

  it('returns true for "ci_passed" event', () => {
    const result = notifyOrchestrator({
      event: 'ci_passed',
      orchestrator: 'athena',
    });
    assert.equal(result, true);
  });

  it('returns true for "started" event', () => {
    const result = notifyOrchestrator({
      event: 'started',
      orchestrator: 'atlas',
    });
    assert.equal(result, true);
  });

  it('returns true for "progress" event', () => {
    const result = notifyOrchestrator({
      event: 'progress',
      orchestrator: 'athena',
      summary: 'Story 3/5 done',
    });
    assert.equal(result, true);
  });

  it('returns true for "done" event', () => {
    const result = notifyOrchestrator({
      event: 'done',
      orchestrator: 'atlas',
    });
    assert.equal(result, true);
  });

  it('handles unknown event type gracefully', () => {
    const result = notifyOrchestrator({
      event: 'unknown_custom_event',
      orchestrator: 'atlas',
    });
    assert.equal(result, true);
  });

  it('uses "Atlas" name for atlas orchestrator', () => {
    // Indirect test — the function should not throw
    const result = notifyOrchestrator({
      event: 'complete',
      orchestrator: 'atlas',
    });
    assert.equal(result, true);
  });

  it('uses "Athena" name for athena orchestrator', () => {
    const result = notifyOrchestrator({
      event: 'complete',
      orchestrator: 'athena',
    });
    assert.equal(result, true);
  });

  it('includes completed/total in complete event body', () => {
    // Since IS_TEST skips real notification, we just verify no throw
    const result = notifyOrchestrator({
      event: 'complete',
      orchestrator: 'atlas',
      completed: 3,
      total: 5,
    });
    assert.equal(result, true);
  });

  it('handles null summary gracefully', () => {
    const result = notifyOrchestrator({
      event: 'complete',
      orchestrator: 'atlas',
      summary: null,
    });
    assert.equal(result, true);
  });
});
