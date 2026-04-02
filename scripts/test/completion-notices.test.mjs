/**
 * Unit tests for US-004 (replayEvents), US-006/007 (verifyStory/getRunVerificationSummary),
 * US-008 (generateCompletionNotices), and US-001 extensions (finalizeRun compare-and-delete).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRun,
  addEvent,
  addVerification,
  finalizeRun,
  getRun,
  getActiveRunId,
  setActiveRunId,
  discoverActiveRun,
  replayEvents,
  verifyStory,
  getRunVerificationSummary,
  generateCompletionNotices,
  checkVerificationGate,
} from '../lib/run-artifacts.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'ao-notices-test-'));
}

async function removeTmpDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// US-001: finalizeRun compare-and-delete
// ---------------------------------------------------------------------------

test('finalizeRun: clears active run on finalize', async () => {
  const tmpDir = await makeTmpDir();
  const stateDir = path.join(tmpDir, 'state');
  await fsp.mkdir(stateDir, { recursive: true });
  try {
    const { runId } = createRun('atlas', 'test', { base: tmpDir, stateDir });
    assert.ok(getActiveRunId('atlas', { stateDir }), 'active run should exist after createRun');

    finalizeRun(runId, { storiesCompleted: 1 }, { base: tmpDir, stateDir });
    assert.equal(getActiveRunId('atlas', { stateDir }), null, 'active run should be cleared');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('finalizeRun: compare-and-delete — does NOT clear if runId mismatch', async () => {
  const tmpDir = await makeTmpDir();
  const stateDir = path.join(tmpDir, 'state');
  await fsp.mkdir(stateDir, { recursive: true });
  try {
    const { runId: run1 } = createRun('atlas', 'first run', { base: tmpDir, stateDir });
    // Overwrite active-run with a different runId (simulating a new run started)
    setActiveRunId('atlas', 'different-run-id', { stateDir });

    finalizeRun(run1, {}, { base: tmpDir, stateDir });
    // Active run should still point to 'different-run-id'
    assert.equal(getActiveRunId('atlas', { stateDir }), 'different-run-id');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('finalizeRun: emits run_finalized event', async () => {
  const tmpDir = await makeTmpDir();
  const stateDir = path.join(tmpDir, 'state');
  await fsp.mkdir(stateDir, { recursive: true });
  try {
    const { runId } = createRun('atlas', 'test', { base: tmpDir, stateDir });
    finalizeRun(runId, { storiesCompleted: 5 }, { base: tmpDir, stateDir });

    const run = getRun(runId, { base: tmpDir });
    const finalized = run.events.filter(e => e.type === 'run_finalized');
    assert.equal(finalized.length, 1);
    assert.equal(finalized[0].detail.status, 'completed');
    assert.equal(finalized[0].detail.storiesCompleted, 5);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// US-001: discoverActiveRun
// ---------------------------------------------------------------------------

test('discoverActiveRun: returns null when no active runs', async () => {
  const tmpDir = await makeTmpDir();
  const stateDir = path.join(tmpDir, 'state');
  await fsp.mkdir(stateDir, { recursive: true });
  try {
    const result = discoverActiveRun({ stateDir });
    assert.equal(result, null);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('discoverActiveRun: returns the single active run', async () => {
  const tmpDir = await makeTmpDir();
  const stateDir = path.join(tmpDir, 'state');
  await fsp.mkdir(stateDir, { recursive: true });
  try {
    setActiveRunId('atlas', 'atlas-run-1', { stateDir });
    const result = discoverActiveRun({ stateDir });
    assert.ok(result);
    assert.equal(result.orchestrator, 'atlas');
    assert.equal(result.runId, 'atlas-run-1');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('discoverActiveRun: returns most recent when both active', async () => {
  const tmpDir = await makeTmpDir();
  const stateDir = path.join(tmpDir, 'state');
  await fsp.mkdir(stateDir, { recursive: true });
  try {
    setActiveRunId('atlas', 'atlas-old', { stateDir });
    // Small delay to ensure different timestamps
    await new Promise(r => setTimeout(r, 10));
    setActiveRunId('athena', 'athena-new', { stateDir });

    const result = discoverActiveRun({ stateDir });
    assert.ok(result);
    assert.equal(result.orchestrator, 'athena');
    assert.equal(result.runId, 'athena-new');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// US-004: replayEvents
// ---------------------------------------------------------------------------

test('replayEvents: reconstructs state from checkpoint_saved events', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId } = createRun('atlas', 'test', { base: tmpDir });
    addEvent(runId, { type: 'phase_transition', detail: { from: null, to: 0 } }, { base: tmpDir });
    addEvent(runId, { type: 'checkpoint_saved', detail: { phase: 0, taskDescription: 'begin' } }, { base: tmpDir });
    addEvent(runId, { type: 'phase_transition', detail: { from: 0, to: 3 } }, { base: tmpDir });
    addEvent(runId, { type: 'checkpoint_saved', detail: { phase: 3, completedStories: ['S1', 'S2'] } }, { base: tmpDir });

    const state = replayEvents(runId, { base: tmpDir });
    assert.ok(state);
    assert.equal(state.phase, 3);
    assert.deepEqual(state.completedStories, ['S1', 'S2']);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('replayEvents: returns null when no checkpoint_saved events', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId } = createRun('atlas', 'test', { base: tmpDir });
    addEvent(runId, { type: 'phase_transition', detail: { from: null, to: 0 } }, { base: tmpDir });

    const state = replayEvents(runId, { base: tmpDir });
    assert.equal(state, null);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('replayEvents: includes verification results', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId } = createRun('atlas', 'test', { base: tmpDir });
    addEvent(runId, { type: 'checkpoint_saved', detail: { phase: 3 } }, { base: tmpDir });
    addEvent(runId, { type: 'verification_result', detail: { story_id: 'US-001', verdict: 'pass' } }, { base: tmpDir });
    addEvent(runId, { type: 'verification_result', detail: { story_id: 'US-002', verdict: 'fail' } }, { base: tmpDir });

    const state = replayEvents(runId, { base: tmpDir });
    assert.ok(state);
    assert.ok(state.verifications);
    assert.equal(state.verifications.length, 2);
    assert.equal(state.verifications[0].story_id, 'US-001');
    assert.equal(state.verifications[1].verdict, 'fail');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('replayEvents: returns null for nonexistent run', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const state = replayEvents('nonexistent-run', { base: tmpDir });
    assert.equal(state, null);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// US-006: Criterion-Level Verification
// ---------------------------------------------------------------------------

test('addVerification: accepts criteria array (new schema)', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId } = createRun('atlas', 'test', { base: tmpDir });

    addVerification(runId, {
      story_id: 'US-001',
      verdict: 'fail',
      verifiedBy: 'themis',
      criteria: [
        { criterion_index: 0, criterion_text: 'GIVEN...THEN pass', verdict: 'pass', evidence: 'ok' },
        { criterion_index: 1, criterion_text: 'GIVEN...THEN fail', verdict: 'fail', evidence: 'expected 200, got 404' },
      ],
    }, { base: tmpDir });

    const run = getRun(runId, { base: tmpDir });
    assert.equal(run.verifications.length, 1);
    assert.equal(run.verifications[0].criteria.length, 2);
    assert.equal(run.verifications[0].criteria[1].verdict, 'fail');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('addVerification: backward compat — works without criteria', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId } = createRun('atlas', 'test', { base: tmpDir });

    addVerification(runId, {
      story_id: 'US-001',
      verdict: 'pass',
      evidence: 'all green',
      verifiedBy: 'themis',
    }, { base: tmpDir });

    const run = getRun(runId, { base: tmpDir });
    assert.equal(run.verifications.length, 1);
    assert.equal(run.verifications[0].story_id, 'US-001');
    assert.equal(run.verifications[0].verdict, 'pass');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// US-006: verifyStory
// ---------------------------------------------------------------------------

test('verifyStory: returns aggregated result with criteria', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId } = createRun('atlas', 'test', { base: tmpDir });

    addVerification(runId, {
      story_id: 'US-001',
      verdict: 'fail',
      verifiedBy: 'themis',
      criteria: [
        { criterion_index: 0, verdict: 'pass', evidence: 'ok' },
        { criterion_index: 1, verdict: 'fail', evidence: 'broken' },
      ],
    }, { base: tmpDir });

    const result = verifyStory(runId, 'US-001', { base: tmpDir });
    assert.ok(result);
    assert.equal(result.story_id, 'US-001');
    assert.equal(result.verdict, 'fail'); // any fail → story fails
    assert.equal(result.criteria.length, 2);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('verifyStory: returns null for unverified story', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId } = createRun('atlas', 'test', { base: tmpDir });
    const result = verifyStory(runId, 'US-999', { base: tmpDir });
    assert.equal(result, null);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('verifyStory: verdict is pass only when all criteria pass', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId } = createRun('atlas', 'test', { base: tmpDir });

    addVerification(runId, {
      story_id: 'US-001',
      verdict: 'pass',
      verifiedBy: 'themis',
      criteria: [
        { criterion_index: 0, verdict: 'pass', evidence: 'ok' },
        { criterion_index: 1, verdict: 'pass', evidence: 'ok' },
      ],
    }, { base: tmpDir });

    const result = verifyStory(runId, 'US-001', { base: tmpDir });
    assert.equal(result.verdict, 'pass');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('verifyStory: skip verdict when any criterion is skip and none fail', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId } = createRun('atlas', 'test', { base: tmpDir });

    addVerification(runId, {
      story_id: 'US-001',
      verdict: 'skip',
      verifiedBy: 'themis',
      criteria: [
        { criterion_index: 0, verdict: 'pass', evidence: 'ok' },
        { criterion_index: 1, verdict: 'skip', evidence: 'codex unavailable' },
      ],
    }, { base: tmpDir });

    const result = verifyStory(runId, 'US-001', { base: tmpDir });
    assert.equal(result.verdict, 'skip');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// US-007: Story Verification Rollup
// ---------------------------------------------------------------------------

test('getRunVerificationSummary: aggregates all stories', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId } = createRun('atlas', 'test', { base: tmpDir });

    addVerification(runId, { story_id: 'US-001', verdict: 'pass', verifiedBy: 'themis' }, { base: tmpDir });
    addVerification(runId, { story_id: 'US-002', verdict: 'fail', evidence: 'broken', verifiedBy: 'momus' }, { base: tmpDir });
    addVerification(runId, { story_id: 'US-003', verdict: 'skip', evidence: 'codex unavailable', verifiedBy: 'codex' }, { base: tmpDir });

    const summary = getRunVerificationSummary(runId, { base: tmpDir });
    assert.equal(summary.total, 3);
    assert.equal(summary.passed, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.stories['US-001'].verdict, 'pass');
    assert.equal(summary.stories['US-002'].verdict, 'fail');
    assert.equal(summary.stories['US-003'].verdict, 'skip');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('getRunVerificationSummary: returns zeros when no verifications', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId } = createRun('atlas', 'test', { base: tmpDir });
    const summary = getRunVerificationSummary(runId, { base: tmpDir });
    assert.equal(summary.total, 0);
    assert.equal(summary.passed, 0);
    assert.equal(summary.failed, 0);
    assert.equal(summary.skipped, 0);
    assert.deepEqual(summary.stories, {});
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('getRunVerificationSummary: last record per story wins', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId } = createRun('atlas', 'test', { base: tmpDir });

    addVerification(runId, { story_id: 'US-001', verdict: 'fail', verifiedBy: 'themis' }, { base: tmpDir });
    addVerification(runId, { story_id: 'US-001', verdict: 'pass', verifiedBy: 'themis' }, { base: tmpDir });

    const summary = getRunVerificationSummary(runId, { base: tmpDir });
    assert.equal(summary.total, 1);
    assert.equal(summary.passed, 1);
    assert.equal(summary.stories['US-001'].verdict, 'pass');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// US-008: Completion Notices
// ---------------------------------------------------------------------------

test('generateCompletionNotices: empty when all pass', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId } = createRun('atlas', 'test', { base: tmpDir });
    addVerification(runId, { story_id: 'US-001', verdict: 'pass', verifiedBy: 'themis' }, { base: tmpDir });
    addVerification(runId, { story_id: 'US-002', verdict: 'pass', verifiedBy: 'themis' }, { base: tmpDir });

    const notices = generateCompletionNotices(runId, { base: tmpDir });
    assert.deepEqual(notices, []);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('generateCompletionNotices: detects codex_unavailable', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId } = createRun('atlas', 'test', { base: tmpDir });
    addVerification(runId, {
      story_id: 'US-002',
      verdict: 'skip',
      evidence: 'codex unavailable',
      verifiedBy: 'codex',
    }, { base: tmpDir });

    const notices = generateCompletionNotices(runId, { base: tmpDir });
    assert.ok(notices.some(n => n.includes('codex_unavailable')));
    assert.ok(notices.some(n => n.includes('US-002')));
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('generateCompletionNotices: detects manual_review_needed at criterion level', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId } = createRun('atlas', 'test', { base: tmpDir });
    addVerification(runId, {
      story_id: 'US-003',
      verdict: 'pass',
      verifiedBy: 'themis',
      criteria: [
        { criterion_index: 0, verdict: 'pass', evidence: 'ok' },
        { criterion_index: 1, verdict: 'skip', evidence: 'requires manual review' },
      ],
    }, { base: tmpDir });

    const notices = generateCompletionNotices(runId, { base: tmpDir });
    assert.ok(notices.some(n => n.includes('manual_review_needed') && n.includes('criterion 1')));
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('generateCompletionNotices: detects unresolved_warnings from events', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId } = createRun('atlas', 'test', { base: tmpDir });
    addEvent(runId, { type: 'warning', detail: { message: 'flaky test detected' } }, { base: tmpDir });
    addVerification(runId, { story_id: 'US-001', verdict: 'pass', verifiedBy: 'themis' }, { base: tmpDir });

    const notices = generateCompletionNotices(runId, { base: tmpDir });
    assert.ok(notices.some(n => n.includes('unresolved_warnings')));
    assert.ok(notices.some(n => n.includes('flaky test detected')));
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('generateCompletionNotices: detects worker_failed from events', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId } = createRun('atlas', 'test', { base: tmpDir });
    addEvent(runId, {
      type: 'worker_failed',
      detail: { workerName: 'worker-3', storyId: 'US-005' },
    }, { base: tmpDir });

    const notices = generateCompletionNotices(runId, { base: tmpDir });
    assert.ok(notices.some(n => n.includes('worker_failed')));
    assert.ok(notices.some(n => n.includes('worker-3')));
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('generateCompletionNotices: returns [] for nonexistent run', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const notices = generateCompletionNotices('nonexistent', { base: tmpDir });
    assert.deepEqual(notices, []);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('generateCompletionNotices: detects tests_skipped', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId } = createRun('atlas', 'test', { base: tmpDir });
    addVerification(runId, {
      story_id: 'US-004',
      verdict: 'skip',
      evidence: 'test execution failed due to sandbox',
      verifiedBy: 'themis',
    }, { base: tmpDir });

    const notices = generateCompletionNotices(runId, { base: tmpDir });
    assert.ok(notices.some(n => n.includes('tests_skipped')));
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('generateCompletionNotices: detects preview_skipped', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId } = createRun('atlas', 'test', { base: tmpDir });
    addVerification(runId, {
      story_id: 'US-006',
      verdict: 'skip',
      evidence: 'visual preview not available in CI',
      verifiedBy: 'aphrodite',
    }, { base: tmpDir });

    const notices = generateCompletionNotices(runId, { base: tmpDir });
    assert.ok(notices.some(n => n.includes('preview_skipped')));
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// checkVerificationGate
// ---------------------------------------------------------------------------

test('checkVerificationGate: passes when all stories have verification records', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId } = createRun('atlas', 'gate-test', { base: tmpDir });
    addVerification(runId, { story_id: 'US-001', verdict: 'pass', evidence: 'xval pass', verifiedBy: 'codex' }, { base: tmpDir });
    addVerification(runId, { story_id: 'US-002', verdict: 'pass', evidence: 'xval pass', verifiedBy: 'codex' }, { base: tmpDir });

    const gate = checkVerificationGate(runId, ['US-001', 'US-002'], { base: tmpDir });
    assert.equal(gate.gatePass, true);
    assert.deepEqual(gate.missing, []);
    assert.deepEqual(gate.skipped, []);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('checkVerificationGate: fails when stories are missing verification', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId } = createRun('atlas', 'gate-test', { base: tmpDir });
    addVerification(runId, { story_id: 'US-001', verdict: 'pass', evidence: 'xval pass', verifiedBy: 'codex' }, { base: tmpDir });

    const gate = checkVerificationGate(runId, ['US-001', 'US-002', 'US-003'], { base: tmpDir });
    assert.equal(gate.gatePass, false);
    assert.deepEqual(gate.missing, ['US-002', 'US-003']);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('checkVerificationGate: reports skipped stories separately', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId } = createRun('atlas', 'gate-test', { base: tmpDir });
    addVerification(runId, { story_id: 'US-001', verdict: 'pass', evidence: 'xval pass', verifiedBy: 'codex' }, { base: tmpDir });
    addVerification(runId, { story_id: 'US-002', verdict: 'skip', evidence: 'codex not_installed', verifiedBy: 'atlas' }, { base: tmpDir });

    const gate = checkVerificationGate(runId, ['US-001', 'US-002'], { base: tmpDir });
    assert.equal(gate.gatePass, true, 'gate passes because all stories have records');
    assert.deepEqual(gate.missing, []);
    assert.deepEqual(gate.skipped, ['US-002']);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('checkVerificationGate: returns safe defaults on invalid runId', () => {
  const gate = checkVerificationGate('nonexistent-run-id', ['US-001'], { base: '/tmp/no-such-dir' });
  assert.equal(gate.gatePass, false);
  assert.deepEqual(gate.missing, ['US-001']);
  assert.deepEqual(gate.skipped, []);
});

test('checkVerificationGate: empty storyIds always passes', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId } = createRun('atlas', 'gate-test', { base: tmpDir });
    const gate = checkVerificationGate(runId, [], { base: tmpDir });
    assert.equal(gate.gatePass, true);
    assert.deepEqual(gate.missing, []);
  } finally {
    await removeTmpDir(tmpDir);
  }
});
