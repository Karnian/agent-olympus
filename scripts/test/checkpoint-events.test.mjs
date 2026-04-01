/**
 * Unit tests for event emission from checkpoint.mjs (US-002, US-003)
 * Verifies that saveCheckpoint/clearCheckpoint emit events to active runs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRun,
  getRun,
  getActiveRunId,
  setActiveRunId,
} from '../lib/run-artifacts.mjs';
import {
  saveCheckpoint,
  loadCheckpoint,
  clearCheckpoint,
  formatCheckpoint,
  PHASE_NAMES,
} from '../lib/checkpoint.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'ao-cp-events-test-'));
}

async function removeTmpDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

/**
 * Create a test environment with both runs base and state directories,
 * plus set up CWD-relative .ao/state for checkpoint.mjs (which uses hardcoded path).
 */
async function setupTestEnv() {
  const tmpDir = await makeTmpDir();
  const runsBase = path.join(tmpDir, 'runs');
  const stateDir = path.join(tmpDir, 'state');
  await fsp.mkdir(runsBase, { recursive: true });
  await fsp.mkdir(stateDir, { recursive: true });
  return { tmpDir, runsBase, stateDir };
}

function readJsonl(filePath) {
  return readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// US-001: Active Run Identity
// ---------------------------------------------------------------------------

test('getActiveRunId: returns null when no active run', async () => {
  const { tmpDir, stateDir } = await setupTestEnv();
  try {
    const result = getActiveRunId('atlas', { stateDir });
    assert.equal(result, null);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('setActiveRunId + getActiveRunId: round-trip', async () => {
  const { tmpDir, stateDir } = await setupTestEnv();
  try {
    setActiveRunId('atlas', 'test-run-001', { stateDir });
    const result = getActiveRunId('atlas', { stateDir });
    assert.equal(result, 'test-run-001');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('createRun: sets active run automatically', async () => {
  const { tmpDir, runsBase, stateDir } = await setupTestEnv();
  try {
    const { runId } = createRun('atlas', 'test task', { base: runsBase, stateDir });
    const activeId = getActiveRunId('atlas', { stateDir });
    assert.equal(activeId, runId);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('getActiveRunId: different orchestrators are independent', async () => {
  const { tmpDir, stateDir } = await setupTestEnv();
  try {
    setActiveRunId('atlas', 'atlas-run-1', { stateDir });
    setActiveRunId('athena', 'athena-run-1', { stateDir });

    assert.equal(getActiveRunId('atlas', { stateDir }), 'atlas-run-1');
    assert.equal(getActiveRunId('athena', { stateDir }), 'athena-run-1');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// US-002: Event-Backed Checkpoint (saveCheckpoint emits events)
// ---------------------------------------------------------------------------

test('saveCheckpoint: emits checkpoint_saved event when active run exists', async () => {
  const { tmpDir, runsBase, stateDir } = await setupTestEnv();
  // checkpoint.mjs uses hardcoded .ao/state, so we need to work in tmpDir
  const origCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    // Create .ao/state in tmpDir for checkpoint.mjs
    await fsp.mkdir(path.join(tmpDir, '.ao', 'state'), { recursive: true });
    // Create .ao/artifacts/runs in tmpDir for run-artifacts.mjs
    await fsp.mkdir(path.join(tmpDir, '.ao', 'artifacts', 'runs'), { recursive: true });

    const { runId } = createRun('atlas', 'test task');
    await saveCheckpoint('atlas', { phase: 0, taskDescription: 'test' });

    const run = getRun(runId);
    const cpEvents = run.events.filter(e => e.type === 'checkpoint_saved');
    assert.equal(cpEvents.length, 1, 'expected 1 checkpoint_saved event');
    assert.equal(cpEvents[0].detail.phase, 0);
    assert.equal(cpEvents[0].detail.taskDescription, 'test');
  } finally {
    process.chdir(origCwd);
    await removeTmpDir(tmpDir);
  }
});

test('saveCheckpoint: no event when no active run', async () => {
  const { tmpDir } = await setupTestEnv();
  const origCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    await fsp.mkdir(path.join(tmpDir, '.ao', 'state'), { recursive: true });
    await fsp.mkdir(path.join(tmpDir, '.ao', 'artifacts', 'runs'), { recursive: true });

    // No createRun call — no active run
    await saveCheckpoint('atlas', { phase: 0, taskDescription: 'test' });

    // Checkpoint file should still be written
    const cp = await loadCheckpoint('atlas');
    assert.ok(cp, 'checkpoint must be saved even without active run');
    assert.equal(cp.phase, 0);
  } finally {
    process.chdir(origCwd);
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// US-003: Phase Transition Events
// ---------------------------------------------------------------------------

test('saveCheckpoint: emits phase_transition on phase change', async () => {
  const { tmpDir } = await setupTestEnv();
  const origCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    await fsp.mkdir(path.join(tmpDir, '.ao', 'state'), { recursive: true });
    await fsp.mkdir(path.join(tmpDir, '.ao', 'artifacts', 'runs'), { recursive: true });

    const { runId } = createRun('atlas', 'test task');
    await saveCheckpoint('atlas', { phase: 0, taskDescription: 'test' });
    await saveCheckpoint('atlas', { phase: 3, taskDescription: 'test', completedStories: ['S1'] });

    const run = getRun(runId);
    const transitions = run.events.filter(e => e.type === 'phase_transition');
    assert.equal(transitions.length, 2, 'expected 2 phase_transition events');

    // First: null → 0
    assert.equal(transitions[0].detail.from, null);
    assert.equal(transitions[0].detail.to, 0);
    assert.equal(transitions[0].detail.toName, 'TRIAGE');

    // Second: 0 → 3
    assert.equal(transitions[1].detail.from, 0);
    assert.equal(transitions[1].detail.to, 3);
    assert.equal(transitions[1].detail.fromName, 'TRIAGE');
    assert.equal(transitions[1].detail.toName, 'EXECUTE');
  } finally {
    process.chdir(origCwd);
    await removeTmpDir(tmpDir);
  }
});

test('saveCheckpoint: no phase_transition when phase unchanged', async () => {
  const { tmpDir } = await setupTestEnv();
  const origCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    await fsp.mkdir(path.join(tmpDir, '.ao', 'state'), { recursive: true });
    await fsp.mkdir(path.join(tmpDir, '.ao', 'artifacts', 'runs'), { recursive: true });

    const { runId } = createRun('atlas', 'test task');
    await saveCheckpoint('atlas', { phase: 3, taskDescription: 'test' });
    await saveCheckpoint('atlas', { phase: 3, taskDescription: 'test updated' });

    const run = getRun(runId);
    const transitions = run.events.filter(e => e.type === 'phase_transition');
    // Only one transition: null → 3 (first save)
    assert.equal(transitions.length, 1, 'no extra phase_transition for same phase');
    assert.equal(transitions[0].detail.from, null);
    assert.equal(transitions[0].detail.to, 3);

    const cpSaved = run.events.filter(e => e.type === 'checkpoint_saved');
    assert.equal(cpSaved.length, 2, 'both checkpoint_saved events still emitted');
  } finally {
    process.chdir(origCwd);
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// clearCheckpoint emits event
// ---------------------------------------------------------------------------

test('clearCheckpoint: emits checkpoint_cleared event', async () => {
  const { tmpDir } = await setupTestEnv();
  const origCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    await fsp.mkdir(path.join(tmpDir, '.ao', 'state'), { recursive: true });
    await fsp.mkdir(path.join(tmpDir, '.ao', 'artifacts', 'runs'), { recursive: true });

    const { runId } = createRun('atlas', 'test task');
    await saveCheckpoint('atlas', { phase: 0 });
    await clearCheckpoint('atlas');

    const run = getRun(runId);
    const cleared = run.events.filter(e => e.type === 'checkpoint_cleared');
    assert.equal(cleared.length, 1, 'expected 1 checkpoint_cleared event');
  } finally {
    process.chdir(origCwd);
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// PHASE_NAMES export
// ---------------------------------------------------------------------------

test('PHASE_NAMES: is exported and contains atlas and athena', () => {
  assert.ok(PHASE_NAMES.atlas, 'atlas phase names must exist');
  assert.ok(PHASE_NAMES.athena, 'athena phase names must exist');
  assert.ok(Array.isArray(PHASE_NAMES.atlas));
  assert.ok(PHASE_NAMES.atlas.includes('TRIAGE'));
  assert.ok(PHASE_NAMES.atlas.includes('EXECUTE'));
});

// ---------------------------------------------------------------------------
// Backward compatibility: existing API signatures unchanged
// ---------------------------------------------------------------------------

test('saveCheckpoint + loadCheckpoint: backward compat — signatures unchanged', async () => {
  const { tmpDir } = await setupTestEnv();
  const origCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    await fsp.mkdir(path.join(tmpDir, '.ao', 'state'), { recursive: true });

    // Classic call pattern from SKILL.md — no run involved
    await saveCheckpoint('atlas', {
      phase: 2,
      completedStories: ['US-001'],
      taskDescription: 'implement feature',
    });

    const cp = await loadCheckpoint('atlas');
    assert.ok(cp);
    assert.equal(cp.orchestrator, 'atlas');
    assert.equal(cp.phase, 2);
    assert.deepEqual(cp.completedStories, ['US-001']);

    const formatted = formatCheckpoint(cp);
    assert.ok(formatted.includes('Phase 2'));
    assert.ok(formatted.includes('PLAN'));
  } finally {
    process.chdir(origCwd);
    await removeTmpDir(tmpDir);
  }
});
