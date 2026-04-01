/**
 * Unit tests for scripts/lib/run-artifacts.mjs
 * Uses node:test — zero npm dependencies.
 *
 * All file I/O is isolated in per-test temp directories so tests are
 * fully independent and self-cleaning.
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
  listRuns,
  getRun,
} from '../lib/run-artifacts.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'ao-artifacts-test-'));
}

async function removeTmpDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

/** Read and parse a JSON file synchronously. */
function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

/** Read and parse a JSONL file synchronously — returns array of objects. */
function readJsonl(filePath) {
  return readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Test 1: createRun returns { runId, runDir } with correct format
// ---------------------------------------------------------------------------

test('createRun: returns { runId, runDir } with correct ID format', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId, runDir } = createRun('atlas', 'test task', { base: tmpDir });

    // Format: <orchestrator>-<YYYYMMDD>-<HHmmss>-<random4chars>
    assert.match(runId, /^atlas-\d{8}-\d{6}-[a-f0-9]{4}$/);
    assert.ok(runDir.endsWith(runId), `runDir should end with runId, got: ${runDir}`);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test 2: createRun creates directory and initial summary.json
// ---------------------------------------------------------------------------

test('createRun: creates the run directory and writes initial summary.json', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId, runDir } = createRun('athena', 'build the feature', { base: tmpDir });

    assert.ok(existsSync(runDir), 'run directory must exist');

    const summaryPath = path.join(runDir, 'summary.json');
    assert.ok(existsSync(summaryPath), 'summary.json must be created');

    const summary = readJson(summaryPath);
    assert.equal(summary.runId, runId);
    assert.equal(summary.orchestrator, 'athena');
    assert.equal(summary.task, 'build the feature');
    assert.equal(summary.status, 'running');
    assert.ok(typeof summary.startedAt === 'string', 'startedAt must be a string');
    // Confirm it is a valid ISO date
    assert.ok(!isNaN(new Date(summary.startedAt).getTime()), 'startedAt must be a valid ISO date');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test 3: addEvent appends to events.jsonl
// ---------------------------------------------------------------------------

test('addEvent: appends a line to events.jsonl', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId, runDir } = createRun('atlas', 'task', { base: tmpDir });

    addEvent(runId, { phase: 'plan', type: 'phase_start', detail: 'starting' }, { base: tmpDir });

    const eventsPath = path.join(runDir, 'events.jsonl');
    assert.ok(existsSync(eventsPath), 'events.jsonl must exist after addEvent');

    const raw = readFileSync(eventsPath, 'utf-8').trim();
    const lines = raw.split('\n');
    assert.equal(lines.length, 1, 'expected exactly one line');

    const ev = JSON.parse(lines[0]);
    assert.equal(ev.phase, 'plan');
    assert.equal(ev.type, 'phase_start');
    assert.equal(ev.detail, 'starting');
    assert.ok(typeof ev.timestamp === 'string', 'timestamp must be added automatically');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test 4: addEvent multiple calls produce multiple lines
// ---------------------------------------------------------------------------

test('addEvent: multiple calls produce multiple JSONL lines', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId, runDir } = createRun('atlas', 'task', { base: tmpDir });

    addEvent(runId, { phase: 'plan', type: 'phase_start', detail: null }, { base: tmpDir });
    addEvent(runId, { phase: 'execute', type: 'worker_spawn', detail: 'worker-1' }, { base: tmpDir });
    addEvent(runId, { phase: 'execute', type: 'worker_complete', detail: 'worker-1' }, { base: tmpDir });

    const eventsPath = path.join(runDir, 'events.jsonl');
    const lines = readFileSync(eventsPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 3, 'expected 3 event lines');

    const types = lines.map(l => JSON.parse(l).type);
    assert.deepEqual(types, ['phase_start', 'worker_spawn', 'worker_complete']);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test 5: addVerification creates verification.jsonl with first result
// ---------------------------------------------------------------------------

test('addVerification: creates verification.jsonl with the first result', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId, runDir } = createRun('atlas', 'task', { base: tmpDir });

    const result = {
      story_id: 'US-001',
      verdict: 'pass',
      evidence: 'all tests green',
      verifiedBy: 'themis',
      timestamp: new Date().toISOString(),
    };
    addVerification(runId, result, { base: tmpDir });

    const verPath = path.join(runDir, 'verification.jsonl');
    assert.ok(existsSync(verPath), 'verification.jsonl must be created');

    const data = readJsonl(verPath);
    assert.ok(Array.isArray(data), 'verification.jsonl must be an array');
    assert.equal(data.length, 1);
    assert.equal(data[0].story_id, 'US-001');
    assert.equal(data[0].verdict, 'pass');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test 6: addVerification appends to existing results
// ---------------------------------------------------------------------------

test('addVerification: appends a second result to existing verification.jsonl', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId, runDir } = createRun('athena', 'task', { base: tmpDir });

    addVerification(runId, { story_id: 'US-001', verdict: 'pass', evidence: 'ok', verifiedBy: 'themis', timestamp: new Date().toISOString() }, { base: tmpDir });
    addVerification(runId, { story_id: 'US-002', verdict: 'fail', evidence: 'test failed', verifiedBy: 'momus', timestamp: new Date().toISOString() }, { base: tmpDir });

    const data = readJsonl(path.join(runDir, 'verification.jsonl'));
    assert.equal(data.length, 2);
    assert.equal(data[0].story_id, 'US-001');
    assert.equal(data[1].story_id, 'US-002');
    assert.equal(data[1].verdict, 'fail');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test 7: finalizeRun updates summary with finishedAt and duration_ms
// ---------------------------------------------------------------------------

test('finalizeRun: adds finishedAt and duration_ms to summary.json', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId, runDir } = createRun('atlas', 'task', { base: tmpDir });

    // Small delay so duration_ms > 0
    await new Promise(r => setTimeout(r, 10));

    finalizeRun(runId, { storiesCompleted: 3 }, { base: tmpDir });

    const summary = readJson(path.join(runDir, 'summary.json'));
    assert.ok(typeof summary.finishedAt === 'string', 'finishedAt must be set');
    assert.ok(!isNaN(new Date(summary.finishedAt).getTime()), 'finishedAt must be a valid date');
    assert.ok(typeof summary.duration_ms === 'number', 'duration_ms must be a number');
    assert.ok(summary.duration_ms >= 0, 'duration_ms must be non-negative');
    assert.equal(summary.storiesCompleted, 3, 'merged fields must be present');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test 8: finalizeRun sets status to 'completed'
// ---------------------------------------------------------------------------

test('finalizeRun: sets status to "completed"', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId, runDir } = createRun('atlas', 'task', { base: tmpDir });
    finalizeRun(runId, {}, { base: tmpDir });

    const summary = readJson(path.join(runDir, 'summary.json'));
    assert.equal(summary.status, 'completed');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test 9: listRuns returns all runs sorted by startedAt
// ---------------------------------------------------------------------------

test('listRuns: returns all runs sorted by startedAt descending (most recent first)', async () => {
  const tmpDir = await makeTmpDir();
  try {
    // Create three runs with small delays to ensure distinct timestamps
    const r1 = createRun('atlas', 'first task', { base: tmpDir });
    await new Promise(r => setTimeout(r, 20));
    const r2 = createRun('atlas', 'second task', { base: tmpDir });
    await new Promise(r => setTimeout(r, 20));
    const r3 = createRun('athena', 'third task', { base: tmpDir });

    const runs = listRuns({ base: tmpDir });
    assert.equal(runs.length, 3);

    // Verify sorted descending by startedAt (most recent first)
    assert.ok(
      new Date(runs[0].startedAt) >= new Date(runs[1].startedAt),
      'first entry must be most recent',
    );
    assert.ok(
      new Date(runs[1].startedAt) >= new Date(runs[2].startedAt),
      'second entry must come before third (descending)',
    );

    const ids = runs.map(r => r.runId);
    assert.ok(ids.includes(r1.runId));
    assert.ok(ids.includes(r2.runId));
    assert.ok(ids.includes(r3.runId));
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test 10: listRuns filters by orchestrator
// ---------------------------------------------------------------------------

test('listRuns: filters results by orchestrator', async () => {
  const tmpDir = await makeTmpDir();
  try {
    createRun('atlas', 'atlas run 1', { base: tmpDir });
    await new Promise(r => setTimeout(r, 5));
    createRun('athena', 'athena run 1', { base: tmpDir });
    await new Promise(r => setTimeout(r, 5));
    createRun('atlas', 'atlas run 2', { base: tmpDir });

    const atlasRuns = listRuns({ orchestrator: 'atlas', base: tmpDir });
    assert.equal(atlasRuns.length, 2, 'expected 2 atlas runs');
    for (const run of atlasRuns) {
      assert.equal(run.orchestrator, 'atlas');
    }

    const athenaRuns = listRuns({ orchestrator: 'athena', base: tmpDir });
    assert.equal(athenaRuns.length, 1, 'expected 1 athena run');
    assert.equal(athenaRuns[0].orchestrator, 'athena');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test 11: getRun returns summary + events + verifications
// ---------------------------------------------------------------------------

test('getRun: returns summary, events, and verifications for a completed run', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId } = createRun('atlas', 'full run test', { base: tmpDir });

    addEvent(runId, { phase: 'execute', type: 'worker_spawn', detail: 'w1' }, { base: tmpDir });
    addEvent(runId, { phase: 'execute', type: 'worker_complete', detail: 'w1' }, { base: tmpDir });

    addVerification(runId, {
      story_id: 'US-001',
      verdict: 'pass',
      evidence: 'all green',
      verifiedBy: 'themis',
      timestamp: new Date().toISOString(),
    }, { base: tmpDir });

    finalizeRun(runId, { result: 'success' }, { base: tmpDir });

    const run = getRun(runId, { base: tmpDir });

    assert.equal(run.summary.runId, runId);
    assert.equal(run.summary.status, 'completed');
    assert.equal(run.summary.result, 'success');

    // 2 manually added events + 1 run_finalized event from finalizeRun
    assert.equal(run.events.length, 3);
    assert.equal(run.events[0].type, 'worker_spawn');
    assert.equal(run.events[1].type, 'worker_complete');
    assert.equal(run.events[2].type, 'run_finalized');

    assert.equal(run.verifications.length, 1);
    assert.equal(run.verifications[0].story_id, 'US-001');
    assert.equal(run.verifications[0].verdict, 'pass');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test 12: getRun returns empty arrays for missing events/verifications
// ---------------------------------------------------------------------------

test('getRun: returns empty arrays when events.jsonl and verification.jsonl are absent', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId } = createRun('atlas', 'minimal run', { base: tmpDir });

    // Do NOT call addEvent or addVerification
    const run = getRun(runId, { base: tmpDir });

    assert.ok(Array.isArray(run.events), 'events must be an array');
    assert.equal(run.events.length, 0, 'events must be empty when no events were added');

    assert.ok(Array.isArray(run.verifications), 'verifications must be an array');
    assert.equal(run.verifications.length, 0, 'verifications must be empty when none were added');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test 13: listRuns respects limit option
// ---------------------------------------------------------------------------

test('listRuns: limit option caps the number of returned runs', async () => {
  const tmpDir = await makeTmpDir();
  try {
    for (let i = 0; i < 5; i++) {
      createRun('atlas', `task ${i}`, { base: tmpDir });
      await new Promise(r => setTimeout(r, 5));
    }

    const limited = listRuns({ limit: 3, base: tmpDir });
    assert.equal(limited.length, 3, 'limit of 3 should return only 3 runs');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test 14: listRuns returns empty array when base directory does not exist
// ---------------------------------------------------------------------------

test('listRuns: returns empty array when base directory does not exist', async () => {
  const tmpDir = await makeTmpDir();
  await removeTmpDir(tmpDir); // ensure it does not exist

  const runs = listRuns({ base: tmpDir });
  assert.ok(Array.isArray(runs), 'must return an array');
  assert.equal(runs.length, 0, 'must return empty array for missing base dir');
});
