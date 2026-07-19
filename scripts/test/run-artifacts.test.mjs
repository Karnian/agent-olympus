/**
 * Unit tests for scripts/lib/run-artifacts.mjs
 * Uses node:test — zero npm dependencies.
 *
 * All file I/O is isolated in per-test temp directories so tests are
 * fully independent and self-cleaning.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  promises as fsp,
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRun as createRunArtifact,
  discoverActiveRun,
  addEvent,
  appendUserTaskUpdate,
  bindRunToCurrentSession,
  addVerification,
  finalizeRun,
  getActiveRunId,
  listRuns,
  getRun,
  getRunVerificationsStrict,
  getRunExecutionPrdSnapshot,
  getUserTaskUpdates,
  replayEvents,
  verifyStory,
  getRunVerificationSummary,
  checkVerificationGate,
  generateCompletionNotices,
  setActiveRunId,
  persistRunExecutionPrdSnapshot,
} from '../lib/run-artifacts.mjs';
import { registerSession } from '../lib/session-registry.mjs';

const RUN_ARTIFACTS_URL = new URL('../lib/run-artifacts.mjs', import.meta.url).href;

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

function readValidJsonl(filePath) {
  const values = [];
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { values.push(JSON.parse(line)); } catch {}
  }
  return values;
}

function assertEmptyRunRecord(record) {
  assert.deepEqual(record, { summary: {}, events: [], verifications: [] });
}

function createRun(orchestrator, taskDescription, opts = {}) {
  const isolated = opts.base && !opts.stateDir && opts.activate === undefined
    ? { ...opts, activate: false }
    : opts;
  return createRunArtifact(orchestrator, taskDescription, isolated);
}

function collectChild(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function waitForFiles(paths, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (paths.some(file => !existsSync(file))) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${paths.join(', ')}`);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 5));
  }
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

test('bindRunToCurrentSession: safely adopts a sessionless preallocated run once', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const base = path.join(tmpDir, '.ao', 'artifacts', 'runs');
    const stateDir = path.join(tmpDir, '.ao', 'state');
    const sessionsBase = path.join(tmpDir, '.ao', 'sessions');
    const created = createRunArtifact('athena', 'preallocated task', {
      base,
      stateDir,
      trustedRoot: tmpDir,
    });
    assert.equal(created.ok, true);
    assert.equal(readJson(path.join(created.runDir, 'summary.json')).sessionId, undefined);

    registerSession('session-live-1', { base: sessionsBase, stateBase: stateDir });
    const bound = bindRunToCurrentSession(created.runId, {
      base,
      stateDir,
      sessionsBase,
      trustedRoot: tmpDir,
    });
    assert.deepEqual(bound, { ok: true, sessionId: 'session-live-1', idempotent: false });
    assert.equal(readJson(path.join(created.runDir, 'summary.json')).sessionId, 'session-live-1');
    assert.equal(bindRunToCurrentSession(created.runId, {
      base, stateDir, sessionsBase, trustedRoot: tmpDir,
    }).idempotent, true);

    registerSession('session-live-2', { base: sessionsBase, stateBase: stateDir });
    assert.equal(bindRunToCurrentSession(created.runId, {
      base, stateDir, sessionsBase, trustedRoot: tmpDir,
    }).reason, 'run-session-conflict');
    assert.equal(readJson(path.join(created.runDir, 'summary.json')).sessionId, 'session-live-1');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('createRun: explicit failure envelope rejects unsafe identities and ambiguous custom state', async () => {
  const tmpDir = await makeTmpDir();
  try {
    assert.deepEqual(createRunArtifact('../escape', 'unsafe', {
      base: path.join(tmpDir, 'runs'),
      stateDir: path.join(tmpDir, 'state'),
      trustedRoot: tmpDir,
    }), {
      ok: false,
      runId: null,
      runDir: '',
      reason: 'invalid-orchestrator',
    });
    assert.deepEqual(createRunArtifact('atlas', 'ambiguous custom base', {
      base: path.join(tmpDir, 'runs'),
      trustedRoot: tmpDir,
    }), {
      ok: false,
      runId: null,
      runDir: '',
      reason: 'custom-state-dir-required',
    });
    assert.equal(existsSync(path.join(tmpDir, 'runs')), false);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('createRun: safe custom orchestrator remains finalizable', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const base = path.join(tmpDir, 'runs');
    const stateDir = path.join(tmpDir, 'state');
    const created = createRunArtifact('custom-worker', 'safe custom orchestrator', {
      base,
      stateDir,
      trustedRoot: tmpDir,
    });
    assert.equal(created.ok, true);
    assert.equal(getActiveRunId('custom-worker', { stateDir, trustedRoot: tmpDir }), created.runId);
    assert.deepEqual(finalizeRun(created.runId, { result: 'success' }, {
      base,
      stateDir,
      trustedRoot: tmpDir,
    }), { ok: true, idempotent: false });
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('Atlas execution PRD snapshot is immutable, generation-bound, and idempotent', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const base = path.join(tmpDir, 'runs');
    const stateDir = path.join(tmpDir, 'state');
    const created = createRunArtifact('atlas', 'snapshot final PRD', {
      base,
      stateDir,
      trustedRoot: tmpDir,
    });
    assert.equal(created.ok, true);
    const prd = {
      projectName: 'snapshot-test',
      userStories: [{ id: 'US-001', title: 'Done', passes: true }],
    };
    const generation = createHash('sha256')
      .update(JSON.stringify(prd), 'utf8')
      .digest('hex');
    const first = persistRunExecutionPrdSnapshot(created.runId, { prd, generation }, {
      base,
      trustedRoot: tmpDir,
    });
    assert.equal(first.ok, true);
    assert.equal(first.created, true);

    const replay = persistRunExecutionPrdSnapshot(created.runId, { prd, generation }, {
      base,
      trustedRoot: tmpDir,
    });
    assert.equal(replay.ok, true);
    assert.equal(replay.created, false);
    assert.deepEqual(
      getRunExecutionPrdSnapshot(created.runId, { base, trustedRoot: tmpDir }).snapshot.prd,
      prd,
    );

    const conflictingPrd = structuredClone(prd);
    conflictingPrd.userStories[0].title = 'Changed';
    const conflictingGeneration = createHash('sha256')
      .update(JSON.stringify(conflictingPrd), 'utf8')
      .digest('hex');
    assert.equal(
      persistRunExecutionPrdSnapshot(created.runId, {
        prd: conflictingPrd,
        generation: conflictingGeneration,
      }, { base, trustedRoot: tmpDir }).reason,
      'execution-prd-snapshot-conflict',
    );
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('createRun: linked run/state ancestry is rejected without retained run artifacts', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const realBase = path.join(tmpDir, 'real-runs');
    const linkedBase = path.join(tmpDir, 'linked-runs');
    const stateDir = path.join(tmpDir, 'state');
    mkdirSync(realBase, { mode: 0o700 });
    mkdirSync(stateDir, { mode: 0o700 });
    symlinkSync(realBase, linkedBase);
    const linkedRunResult = createRunArtifact('atlas', 'linked base', {
      base: linkedBase,
      stateDir,
      trustedRoot: tmpDir,
    });
    assert.equal(linkedRunResult.ok, false);
    assert.equal(linkedRunResult.reason, 'unsafe-run-base');
    assert.deepEqual(await fsp.readdir(realBase), []);

    const safeBase = path.join(tmpDir, 'safe-runs');
    const realState = path.join(tmpDir, 'real-state');
    const linkedState = path.join(tmpDir, 'linked-state');
    mkdirSync(safeBase, { mode: 0o700 });
    mkdirSync(realState, { mode: 0o700 });
    symlinkSync(realState, linkedState);
    const linkedStateResult = createRunArtifact('atlas', 'linked state', {
      base: safeBase,
      stateDir: linkedState,
      trustedRoot: tmpDir,
    });
    assert.deepEqual(linkedStateResult, {
      ok: false,
      runId: null,
      runDir: '',
      reason: 'active-run-write-failed',
    });
    assert.deepEqual(await fsp.readdir(safeBase), []);
    assert.deepEqual(await fsp.readdir(realState), []);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('active pointer readers reject forged, mismatched, extra, and linked identities', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const stateDir = path.join(tmpDir, 'state');
    const pointerPath = path.join(stateDir, 'ao-active-run-atlas.json');
    mkdirSync(stateDir, { mode: 0o700 });
    const startedAt = new Date().toISOString();
    const assertRejected = data => {
      try { unlinkSync(pointerPath); } catch {}
      writeFileSync(pointerPath, JSON.stringify(data), { mode: 0o600 });
      assert.equal(getActiveRunId('atlas', { stateDir, trustedRoot: tmpDir }), null);
      assert.equal(discoverActiveRun({ stateDir, trustedRoot: tmpDir }), null);
    };
    assertRejected({ runId: '../../../escaped-run', orchestrator: 'atlas', startedAt });
    assertRejected({ runId: 'atlas-safe-run', orchestrator: 'athena', startedAt });
    assertRejected({ runId: 'atlas-safe-run', orchestrator: 'atlas', startedAt, extra: true });

    unlinkSync(pointerPath);
    const outside = path.join(tmpDir, 'outside-pointer.json');
    writeFileSync(outside, JSON.stringify({
      runId: 'atlas-linked-run', orchestrator: 'atlas', startedAt,
    }), { mode: 0o600 });
    symlinkSync(outside, pointerPath);
    assert.equal(getActiveRunId('atlas', { stateDir, trustedRoot: tmpDir }), null);
    assert.equal(discoverActiveRun({ stateDir, trustedRoot: tmpDir }), null);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('createRun: sequential active claims never overwrite or orphan the first run', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const base = path.join(tmpDir, 'runs');
    const stateDir = path.join(tmpDir, 'state');
    const first = createRunArtifact('atlas', 'first', { base, stateDir, trustedRoot: tmpDir });
    assert.equal(first.ok, true);
    const second = createRunArtifact('atlas', 'second', { base, stateDir, trustedRoot: tmpDir });
    assert.deepEqual(second, {
      ok: false,
      runId: null,
      runDir: '',
      reason: 'active-run-exists',
    });
    assert.equal(getActiveRunId('atlas', { stateDir, trustedRoot: tmpDir }), first.runId);
    assert.deepEqual((await fsp.readdir(base)).sort(), [first.runId]);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('createRun: concurrent active claims elect exactly one no-replace winner', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const base = path.join(tmpDir, 'runs');
    const stateDir = path.join(tmpDir, 'state');
    const gate = path.join(tmpDir, 'gate');
    const ready1 = path.join(tmpDir, 'ready-1');
    const ready2 = path.join(tmpDir, 'ready-2');
    mkdirSync(base, { mode: 0o700 });
    mkdirSync(stateDir, { mode: 0o700 });
    const childSource = [
      `import { createRun } from ${JSON.stringify(RUN_ARTIFACTS_URL)};`,
      `import { existsSync, writeFileSync } from 'node:fs';`,
      `writeFileSync(process.env.AO_READY, 'ready');`,
      `while (!existsSync(process.env.AO_GATE)) await new Promise(r => setTimeout(r, 2));`,
      `console.log(JSON.stringify(createRun('atlas', process.env.AO_TASK, {`,
      `  base: process.env.AO_BASE, stateDir: process.env.AO_STATE, trustedRoot: process.env.AO_ROOT,`,
      `})));`,
    ].join('\n');
    const launch = (ready, task) => spawn(process.execPath, [
      '--input-type=module', '-e', childSource,
    ], {
      env: {
        ...process.env,
        AO_BASE: base,
        AO_GATE: gate,
        AO_READY: ready,
        AO_ROOT: tmpDir,
        AO_STATE: stateDir,
        AO_TASK: task,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const child1 = launch(ready1, 'concurrent-one');
    const child2 = launch(ready2, 'concurrent-two');
    const done1 = collectChild(child1);
    const done2 = collectChild(child2);
    await waitForFiles([ready1, ready2]);
    writeFileSync(gate, 'go');
    const children = await Promise.all([done1, done2]);
    assert.deepEqual(children.map(child => child.code), [0, 0], children.map(c => c.stderr).join('\n'));
    const results = children.map(child => JSON.parse(child.stdout.trim()));
    const winners = results.filter(result => result.ok);
    const losers = results.filter(result => !result.ok);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal(losers[0].reason, 'active-run-exists');
    assert.equal(getActiveRunId('atlas', { stateDir, trustedRoot: tmpDir }), winners[0].runId);
    assert.deepEqual((await fsp.readdir(base)).sort(), [winners[0].runId]);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('active pointer CAS uses complete intent publication and recovers link cleanup crashes', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const stateDir = path.join(tmpDir, 'state');
    mkdirSync(stateDir, { mode: 0o700 });
    const crashSource = [
      `import { setActiveRunId } from ${JSON.stringify(RUN_ARTIFACTS_URL)};`,
      `const stage = process.env.AO_STAGE;`,
      `setActiveRunId('atlas', process.env.AO_RUN_ID, {`,
      `  stateDir: process.env.AO_STATE, trustedRoot: process.env.AO_ROOT,`,
      `  _beforeActivePointerPublish: stage === 'before' ? () => process.exit(23) : undefined,`,
      `  _afterActivePointerLink: stage === 'after' ? () => process.exit(24) : undefined,`,
      `});`,
    ].join('\n');
    const crash = (stage, runId) => spawnSync(process.execPath, [
      '--input-type=module', '-e', crashSource,
    ], {
      env: {
        ...process.env,
        AO_ROOT: tmpDir,
        AO_RUN_ID: runId,
        AO_STAGE: stage,
        AO_STATE: stateDir,
      },
      encoding: 'utf8',
    });

    assert.equal(crash('before', 'atlas-before-crash').status, 23);
    assert.equal(getActiveRunId('atlas', { stateDir, trustedRoot: tmpDir }), null);
    assert.equal(setActiveRunId('atlas', 'atlas-after-before-crash', {
      stateDir,
      trustedRoot: tmpDir,
    }).ok, true, 'a fully-written unpublished intent must never block a later claim');
    assert.equal(setActiveRunId('atlas', 'atlas-reset', {
      stateDir,
      trustedRoot: tmpDir,
      replace: true,
    }).ok, true);
    unlinkSync(path.join(stateDir, 'ao-active-run-atlas.json'));

    assert.equal(crash('after', 'atlas-after-link-crash').status, 24);
    assert.equal(getActiveRunId('atlas', { stateDir, trustedRoot: tmpDir }), 'atlas-after-link-crash');
    assert.equal(
      (await fsp.lstat(path.join(stateDir, 'ao-active-run-atlas.json'))).nlink,
      1,
      'reader recovery must remove the exact linked intent left by a publication crash',
    );
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

test('addEvent repairs a missing LF and getRun preserves valid records after damaged JSONL', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId, runDir } = createRun('atlas', 'torn event log', { base: tmpDir });
    const eventsPath = path.join(runDir, 'events.jsonl');
    const before = { type: 'before_damage', detail: 'kept' };
    writeFileSync(eventsPath, `${JSON.stringify(before)}\n{"type":"torn"`, { mode: 0o600 });

    addEvent(runId, { type: 'after_damage', detail: 'also kept' }, { base: tmpDir });

    const raw = readFileSync(eventsPath, 'utf8');
    assert.match(raw, /\{"type":"torn"\n\{"type":"after_damage"/);
    assert.deepEqual(getRun(runId, { base: tmpDir }).events.map(event => event.type), [
      'before_damage',
      'after_damage',
    ]);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('user task updates: strict atomic ledger round-trips ordered follow-ups', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId, runDir } = createRun('atlas', 'original task', { base: tmpDir });
    const first = appendUserTaskUpdate(runId, 'original task', {
      base: tmpDir,
      allowCreate: true,
    });
    assert.equal(first.ok, true);
    const second = appendUserTaskUpdate(runId, 'do not push this', { base: tmpDir });
    assert.equal(second.ok, true);

    const strict = getUserTaskUpdates(runId, { base: tmpDir });
    assert.equal(strict.ok, true);
    assert.deepEqual(strict.updates.map(update => [update.sequence, update.task]), [
      [1, 'original task'],
      [2, 'do not push this'],
    ]);
    assert.equal(readJson(path.join(runDir, 'task-updates.json')).schemaVersion, 1);
    assert.deepEqual(
      readValidJsonl(path.join(runDir, 'events.jsonl'))
        .filter(event => event.type === 'user_task_update')
        .map(event => event.detail.sequence),
      [1, 2],
    );
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('user task updates: a missing resume ledger fails closed', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId } = createRun('atlas', 'task', { base: tmpDir });
    assert.deepEqual(getUserTaskUpdates(runId, { base: tmpDir }).ok, false);
    const resumed = appendUserTaskUpdate(runId, 'later constraint', { base: tmpDir });
    assert.equal(resumed.ok, false);
    assert.match(resumed.reason, /missing/i);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('user task updates: malformed or torn history is never skipped or overwritten', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId, runDir } = createRun('athena', 'task', { base: tmpDir });
    assert.equal(appendUserTaskUpdate(runId, 'task', {
      base: tmpDir,
      allowCreate: true,
    }).ok, true);
    const ledgerPath = path.join(runDir, 'task-updates.json');
    writeFileSync(ledgerPath, '{"schemaVersion":1,"updates":[', { mode: 0o600 });

    assert.equal(getUserTaskUpdates(runId, { base: tmpDir }).ok, false);
    const append = appendUserTaskUpdate(runId, 'do not ship', { base: tmpDir });
    assert.equal(append.ok, false);
    assert.equal(readFileSync(ledgerPath, 'utf8'), '{"schemaVersion":1,"updates":[');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('user task updates: damaged audit JSONL cannot erase strict policy history', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId, runDir } = createRun('atlas', 'task', { base: tmpDir });
    assert.equal(appendUserTaskUpdate(runId, 'task', {
      base: tmpDir,
      allowCreate: true,
    }).ok, true);
    writeFileSync(
      path.join(runDir, 'events.jsonl'),
      '{"type":"torn-user_task_update"',
      { mode: 0o600 },
    );
    assert.equal(appendUserTaskUpdate(runId, 'never push', { base: tmpDir }).ok, true);
    const strict = getUserTaskUpdates(runId, { base: tmpDir });
    assert.equal(strict.ok, true);
    assert.deepEqual(strict.updates.map(update => update.task), ['task', 'never push']);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('user task updates: a valid older ledger prefix cannot roll back a no-ship follow-up', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId, runDir } = createRun('atlas', 'task', { base: tmpDir });
    assert.equal(appendUserTaskUpdate(runId, 'task', {
      base: tmpDir,
      allowCreate: true,
    }).ok, true);
    const ledgerPath = path.join(runDir, 'task-updates.json');
    const oldValidPrefix = readFileSync(ledgerPath, 'utf8');

    assert.equal(appendUserTaskUpdate(runId, 'do not push this', { base: tmpDir }).ok, true);
    writeFileSync(ledgerPath, oldValidPrefix, { mode: 0o600 });

    const strict = getUserTaskUpdates(runId, { base: tmpDir });
    assert.equal(strict.ok, false);
    assert.match(strict.reason, /rollback|anchor/i);
    const resumed = appendUserTaskUpdate(runId, 'continue', { base: tmpDir });
    assert.equal(resumed.ok, false);
    assert.match(resumed.reason, /rollback|anchor/i);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('user task updates: a crash between ledger and anchor publication recovers one proven append', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId, runDir } = createRun('atlas', 'task', { base: tmpDir });
    assert.equal(appendUserTaskUpdate(runId, 'task', {
      base: tmpDir,
      allowCreate: true,
    }).ok, true);
    const anchorPath = path.join(runDir, 'task-updates.anchor.json');
    const priorAnchor = readFileSync(anchorPath, 'utf8');
    assert.equal(appendUserTaskUpdate(runId, 'do not push this', { base: tmpDir }).ok, true);

    // Simulate a crash after the durable ledger rename but before the matching
    // anchor rename became visible.
    writeFileSync(anchorPath, priorAnchor, { mode: 0o600 });
    assert.equal(getUserTaskUpdates(runId, { base: tmpDir }).ok, false);

    const resumed = appendUserTaskUpdate(runId, 'continue locally', { base: tmpDir });
    assert.equal(resumed.ok, true);
    assert.deepEqual(resumed.updates.map(update => update.task), [
      'task',
      'do not push this',
      'continue locally',
    ]);
    assert.equal(getUserTaskUpdates(runId, { base: tmpDir }).ok, true);
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
    assert.deepEqual(addVerification(runId, result, { base: tmpDir }), { ok: true });

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

test('getRunVerificationsStrict rejects every malformed row while getRun stays compatible', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId, runDir } = createRun('atlas', 'strict verification read', { base: tmpDir });
    addVerification(runId, {
      story_id: 'US-001',
      verdict: 'pass',
      evidence: 'tests passed',
      verifiedBy: 'themis',
    }, { base: tmpDir });
    const verificationPath = path.join(runDir, 'verification.jsonl');
    const clean = getRunVerificationsStrict(runId, { base: tmpDir });
    assert.equal(clean.ok, true);
    assert.equal(clean.verifications.length, 1);
    assert.equal(clean.verifications[0].story_id, 'US-001');

    writeFileSync(verificationPath, `${readFileSync(verificationPath, 'utf8')}{broken-json}\n`, {
      mode: 0o600,
    });

    assert.equal(getRun(runId, { base: tmpDir }).verifications.length, 1,
      'the compatibility reader must retain its historical skip-invalid projection');
    const strict = getRunVerificationsStrict(runId, { base: tmpDir });
    assert.equal(strict.ok, false);
    assert.deepEqual(strict.verifications, []);
    assert.match(strict.reason, /line 2.*invalid JSON/i);

    writeFileSync(verificationPath, '{"story_id":"US-001"}\n42\n', { mode: 0o600 });
    const scalar = getRunVerificationsStrict(runId, { base: tmpDir });
    assert.equal(scalar.ok, false);
    assert.match(scalar.reason, /line 2.*not an object/i);

    writeFileSync(verificationPath, '{"story_id":"US-001"}\n\n', { mode: 0o600 });
    const blank = getRunVerificationsStrict(runId, { base: tmpDir });
    assert.equal(blank.ok, false);
    assert.match(blank.reason, /line 2.*blank/i);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('getRunVerificationsStrict fails closed for missing, linked, and permission-unsafe evidence', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const missing = createRun('atlas', 'missing verification', { base: tmpDir });
    assert.equal(getRunVerificationsStrict(missing.runId, { base: tmpDir }).ok, false);

    const linked = createRun('atlas', 'linked verification', { base: tmpDir });
    const outside = path.join(tmpDir, 'outside-verification.jsonl');
    writeFileSync(outside, '{"story_id":"US-LINK"}\n', { mode: 0o600 });
    symlinkSync(outside, path.join(linked.runDir, 'verification.jsonl'));
    assert.equal(getRunVerificationsStrict(linked.runId, { base: tmpDir }).ok, false);

    const hardLinked = createRun('atlas', 'hard-linked verification', { base: tmpDir });
    linkSync(outside, path.join(hardLinked.runDir, 'verification.jsonl'));
    assert.equal(getRunVerificationsStrict(hardLinked.runId, { base: tmpDir }).ok, false);

    const unsafe = createRun('atlas', 'unsafe verification', { base: tmpDir });
    const unsafePath = path.join(unsafe.runDir, 'verification.jsonl');
    writeFileSync(unsafePath, '{"story_id":"US-UNSAFE"}\n', { mode: 0o600 });
    if (process.platform !== 'win32') {
      chmodSync(unsafePath, 0o644);
      assert.equal(getRunVerificationsStrict(unsafe.runId, { base: tmpDir }).ok, false);
    }
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('getRunVerificationsStrict rejects evidence replaced after its descriptor read', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId } = createRun('athena', 'verification replacement race', { base: tmpDir });
    addVerification(runId, {
      story_id: 'US-001',
      verdict: 'pass',
      evidence: 'original evidence',
      verifiedBy: 'themis',
    }, { base: tmpDir });

    const strict = getRunVerificationsStrict(runId, {
      base: tmpDir,
      _afterVerificationRead(filePath) {
        unlinkSync(filePath);
        writeFileSync(filePath, JSON.stringify({
          story_id: 'US-001',
          verdict: 'pass',
          evidence: 'replacement evidence',
          verifiedBy: 'attacker',
        }) + '\n', { mode: 0o600 });
      },
    });
    assert.equal(strict.ok, false);
    assert.deepEqual(strict.verifications, []);
    assert.match(strict.reason, /changed/i);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('addEvent and addVerification reject traversal and no-follow linked artifacts', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const base = path.join(tmpDir, 'runs');
    const stateDir = path.join(tmpDir, 'state');
    await fsp.mkdir(base, { recursive: true, mode: 0o700 });
    await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const escapedDir = path.join(tmpDir, 'escaped');
    await fsp.mkdir(escapedDir, { mode: 0o700 });

    addEvent('../escaped', { type: 'escape', detail: 'blocked' }, {
      base,
      trustedRoot: tmpDir,
    });
    const escapedVerification = addVerification('../escaped', { story_id: 'escape', verdict: 'pass' }, {
      base,
      trustedRoot: tmpDir,
    });
    assert.equal(escapedVerification.ok, false);
    assert.equal(existsSync(path.join(escapedDir, 'events.jsonl')), false);
    assert.equal(existsSync(path.join(escapedDir, 'verification.jsonl')), false);

    const { runId, runDir } = createRun('atlas', 'linked artifacts', { base, stateDir });
    const outsideEvents = path.join(tmpDir, 'outside-events.jsonl');
    const outsideVerifications = path.join(tmpDir, 'outside-verifications.jsonl');
    writeFileSync(outsideEvents, 'event-sentinel\n', { mode: 0o600 });
    writeFileSync(outsideVerifications, 'verification-sentinel\n', { mode: 0o600 });
    symlinkSync(outsideEvents, path.join(runDir, 'events.jsonl'));
    symlinkSync(outsideVerifications, path.join(runDir, 'verification.jsonl'));

    addEvent(runId, { type: 'linked-event', detail: 'blocked' }, {
      base,
      stateDir,
      trustedRoot: tmpDir,
    });
    const linkedVerification = addVerification(runId, { story_id: 'US-LINK', verdict: 'pass', verifiedBy: 'themis' }, {
      base,
      stateDir,
      trustedRoot: tmpDir,
    });
    assert.equal(linkedVerification.ok, false);
    assert.equal(readFileSync(outsideEvents, 'utf8'), 'event-sentinel\n');
    assert.equal(readFileSync(outsideVerifications, 'utf8'), 'verification-sentinel\n');

    const realBase = path.join(tmpDir, 'real-runs');
    const linkedBase = path.join(tmpDir, 'linked-runs');
    const linkedState = path.join(tmpDir, 'linked-state');
    await fsp.mkdir(realBase, { mode: 0o700 });
    await fsp.mkdir(linkedState, { mode: 0o700 });
    const linkedRun = createRun('athena', 'linked ancestry', {
      base: realBase,
      stateDir: linkedState,
    });
    symlinkSync(realBase, linkedBase);
    addEvent(linkedRun.runId, { type: 'linked-ancestry', detail: 'blocked' }, {
      base: linkedBase,
      trustedRoot: tmpDir,
    });
    addVerification(linkedRun.runId, {
      story_id: 'US-ANCESTRY',
      verdict: 'pass',
      verifiedBy: 'themis',
    }, {
      base: linkedBase,
      stateDir: linkedState,
      trustedRoot: tmpDir,
    });
    assert.equal(existsSync(path.join(linkedRun.runDir, 'events.jsonl')), false);
    assert.equal(existsSync(path.join(linkedRun.runDir, 'verification.jsonl')), false);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('terminal run rejects late events and verifications while keeping run_finalized last', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const stateDir = path.join(tmpDir, 'state');
    await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const { runId, runDir } = createRun('atlas', 'terminal append gate', {
      base: tmpDir,
      stateDir,
    });

    addVerification(runId, {
      story_id: 'US-001',
      verdict: 'pass',
      evidence: 'verified while running',
      verifiedBy: 'themis',
    }, { base: tmpDir, stateDir });
    let events = readJsonl(path.join(runDir, 'events.jsonl'));
    assert.equal(events.filter(event => event.type === 'verification_result').length, 1,
      'orchestrator must be derived from the validated running summary');

    addEvent(runId, { type: 'run_finalized', detail: { forged: true } }, { base: tmpDir });
    assert.equal(readJsonl(path.join(runDir, 'events.jsonl')).length, events.length,
      'run_finalized is reserved for the internal finalizer path');

    assert.deepEqual(finalizeRun(runId, { result: 'success' }, {
      base: tmpDir,
      stateDir,
    }), { ok: true, idempotent: false });
    const eventsPath = path.join(runDir, 'events.jsonl');
    const verificationPath = path.join(runDir, 'verification.jsonl');
    const terminalEvents = readFileSync(eventsPath);
    const terminalVerifications = readFileSync(verificationPath);

    addEvent(runId, { type: 'late-output', detail: 'must not append' }, { base: tmpDir });
    const lateVerification = addVerification(runId, {
      story_id: 'US-LATE',
      verdict: 'fail',
      evidence: 'must not append',
      verifiedBy: 'late-writer',
    }, { base: tmpDir, stateDir });
    assert.equal(lateVerification.ok, false);

    assert.deepEqual(readFileSync(eventsPath), terminalEvents);
    assert.deepEqual(readFileSync(verificationPath), terminalVerifications);
    events = readJsonl(eventsPath);
    assert.equal(events.at(-1).type, 'run_finalized');
    assert.equal(events.filter(event => event.type === 'run_finalized').length, 1);
    assert.deepEqual(finalizeRun(runId, { result: 'success' }, {
      base: tmpDir,
      stateDir,
    }), { ok: true, idempotent: true });
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('finalizeRun skips torn events, repairs EOF, and remains idempotent with run_finalized last', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { runId, runDir } = createRun('atlas', 'torn finalization log', { base: tmpDir });
    const eventsPath = path.join(runDir, 'events.jsonl');
    writeFileSync(eventsPath, [
      JSON.stringify({ type: 'before_damage', detail: 1 }),
      '{"type":broken}',
      JSON.stringify({ type: 'after_damage', detail: 2 }),
      '{"type":"trailing"',
    ].join('\n'), { mode: 0o600 });

    assert.deepEqual(finalizeRun(runId, { result: 'success' }, { base: tmpDir }), {
      ok: true, idempotent: false,
    });
    assert.deepEqual(finalizeRun(runId, { result: 'success' }, { base: tmpDir }), {
      ok: true, idempotent: true,
    });

    const events = readValidJsonl(eventsPath);
    assert.deepEqual(events.map(event => event.type), [
      'before_damage',
      'after_damage',
      'run_finalized',
    ]);
    assert.equal(events.filter(event => event.type === 'run_finalized').length, 1);
    assert.equal(events.at(-1).type, 'run_finalized');
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

test('finalizeRun: rejects invalid or future start times before mutation', async () => {
  for (const startedAt of ['garbage', new Date(Date.now() + 60_000).toISOString()]) {
    const tmpDir = await makeTmpDir();
    try {
      const stateDir = path.join(tmpDir, 'state');
      const { runId, runDir } = createRun('atlas', 'task', { base: tmpDir, stateDir });
      const summaryPath = path.join(runDir, 'summary.json');
      const existing = { ...readJson(summaryPath), startedAt };
      const before = JSON.stringify(existing, null, 2);
      writeFileSync(summaryPath, before);

      const result = finalizeRun(runId, { result: 'success' }, { base: tmpDir, stateDir });
      assert.deepEqual(result, { ok: false, reason: 'running-run-summary-invalid' });
      assert.equal(readFileSync(summaryPath, 'utf8'), before);
    } finally {
      await removeTmpDir(tmpDir);
    }
  }
});

test('finalizeRun: caller cannot override persisted core identity or timing', async () => {
  const protectedFields = {
    runId: 'other-run',
    orchestrator: 'athena',
    task: 'replacement task',
    sessionId: 'replacement-session',
    startedAt: 'garbage',
    status: 'completed',
    finishedAt: new Date().toISOString(),
    duration_ms: -1,
  };
  for (const [field, value] of Object.entries(protectedFields)) {
    const tmpDir = await makeTmpDir();
    try {
      const stateDir = path.join(tmpDir, 'state');
      const { runId, runDir } = createRun('atlas', 'task', { base: tmpDir, stateDir });
      const summaryPath = path.join(runDir, 'summary.json');
      const before = readFileSync(summaryPath, 'utf8');

      const result = finalizeRun(runId, { result: 'success', [field]: value }, { base: tmpDir, stateDir });
      assert.deepEqual(result, { ok: false, reason: 'core-summary-field-override' }, field);
      assert.equal(readFileSync(summaryPath, 'utf8'), before, field);
    } finally {
      await removeTmpDir(tmpDir);
    }
  }
});

test('finalizeRun: direct failure classification requires the marker-owning finalizer', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const stateDir = path.join(tmpDir, 'state');
    const { runId, runDir } = createRun('atlas', 'task', { base: tmpDir, stateDir });
    const summaryPath = path.join(runDir, 'summary.json');
    const before = readFileSync(summaryPath, 'utf8');

    const result = finalizeRun(runId, {
      result: 'failure',
      failureCode: 'verification_exhausted',
      failedPhase: 'verify',
    }, { base: tmpDir, stateDir });
    assert.deepEqual(result, { ok: false, reason: 'failure-finalization-not-authorized' });
    assert.equal(readFileSync(summaryPath, 'utf8'), before);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('finalizeRun: cannot repair an unmarked completed failure through the success API', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const stateDir = path.join(tmpDir, 'state');
    const { runId, runDir } = createRun('atlas', 'task', { base: tmpDir, stateDir });
    const summaryPath = path.join(runDir, 'summary.json');
    const existing = readJson(summaryPath);
    const finishedAt = new Date().toISOString();
    const forged = {
      ...existing,
      status: 'completed',
      result: 'failure',
      failureCode: 'verification_exhausted',
      failedPhase: 'verify',
      finishedAt,
      duration_ms: Date.parse(finishedAt) - Date.parse(existing.startedAt),
    };
    const before = JSON.stringify(forged, null, 2);
    writeFileSync(summaryPath, before);

    const result = finalizeRun(runId, {}, { base: tmpDir, stateDir });
    assert.deepEqual(result, { ok: false, reason: 'failure-finalization-not-authorized' });
    assert.equal(readFileSync(summaryPath, 'utf8'), before);
    assert.equal(existsSync(path.join(runDir, 'events.jsonl')), false);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('finalizeRun: rejects a symlinked run directory without touching its target', {
  skip: process.platform === 'win32',
}, async () => {
  const tmpDir = await makeTmpDir();
  try {
    const base = path.join(tmpDir, 'runs');
    const outside = path.join(tmpDir, 'outside');
    mkdirSync(base, { mode: 0o700 });
    mkdirSync(outside, { mode: 0o700 });
    const runId = 'atlas-20260712-120000-abcd';
    const summaryPath = path.join(outside, 'summary.json');
    const before = JSON.stringify({
      runId,
      orchestrator: 'atlas',
      task: 'outside',
      startedAt: new Date().toISOString(),
      status: 'running',
    }, null, 2);
    writeFileSync(summaryPath, before, { mode: 0o600 });
    symlinkSync(outside, path.join(base, runId), 'dir');

    const result = finalizeRun(runId, { result: 'success' }, {
      base,
      stateDir: path.join(tmpDir, 'state'),
    });
    assert.equal(result.ok, false);
    assert.equal(readFileSync(summaryPath, 'utf8'), before);
    assert.equal(existsSync(path.join(outside, 'events.jsonl')), false);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('finalizeRun: rejects a symlinked summary without trusting or replacing it', {
  skip: process.platform === 'win32',
}, async () => {
  const tmpDir = await makeTmpDir();
  try {
    const base = path.join(tmpDir, 'runs');
    const stateDir = path.join(tmpDir, 'state');
    const { runId, runDir } = createRun('atlas', 'task', { base, stateDir });
    const localSummary = path.join(runDir, 'summary.json');
    const outsideSummary = path.join(tmpDir, 'outside-summary.json');
    const before = readFileSync(localSummary, 'utf8');
    writeFileSync(outsideSummary, before, { mode: 0o600 });
    unlinkSync(localSummary);
    symlinkSync(outsideSummary, localSummary);

    const result = finalizeRun(runId, { result: 'success' }, { base, stateDir });
    assert.equal(result.ok, false);
    assert.equal(readFileSync(outsideSummary, 'utf8'), before);
    assert.equal(existsSync(localSummary), true);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('finalizeRun: rejects a symlinked events file before summary mutation', {
  skip: process.platform === 'win32',
}, async () => {
  const tmpDir = await makeTmpDir();
  try {
    const base = path.join(tmpDir, 'runs');
    const stateDir = path.join(tmpDir, 'state');
    const { runId, runDir } = createRun('atlas', 'task', { base, stateDir });
    const summaryPath = path.join(runDir, 'summary.json');
    const before = readFileSync(summaryPath, 'utf8');
    const outsideEvents = path.join(tmpDir, 'outside-events.jsonl');
    writeFileSync(outsideEvents, '', { mode: 0o600 });
    symlinkSync(outsideEvents, path.join(runDir, 'events.jsonl'));

    const result = finalizeRun(runId, { result: 'success' }, { base, stateDir });
    assert.deepEqual(result, { ok: false, reason: 'run-events-invalid' });
    assert.equal(readFileSync(summaryPath, 'utf8'), before);
    assert.equal(readFileSync(outsideEvents, 'utf8'), '');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('finalizeRun: rejects a symlink in the run-base ancestry', {
  skip: process.platform === 'win32',
}, async () => {
  const tmpDir = await makeTmpDir();
  try {
    const project = path.join(tmpDir, 'project');
    const outsideRoot = path.join(tmpDir, 'outside-root');
    const runId = 'atlas-20260712-120000-baad';
    const outsideRun = path.join(outsideRoot, 'artifacts', 'runs', runId);
    mkdirSync(project, { mode: 0o700 });
    mkdirSync(outsideRun, { recursive: true, mode: 0o700 });
    const summaryPath = path.join(outsideRun, 'summary.json');
    const before = JSON.stringify({
      runId,
      orchestrator: 'atlas',
      task: 'outside',
      startedAt: new Date().toISOString(),
      status: 'running',
    }, null, 2);
    writeFileSync(summaryPath, before, { mode: 0o600 });
    symlinkSync(outsideRoot, path.join(project, 'redirect'), 'dir');
    const base = path.join(project, 'redirect', 'artifacts', 'runs');

    const result = finalizeRun(runId, { result: 'success' }, {
      base,
      stateDir: path.join(tmpDir, 'state'),
    });
    assert.equal(result.ok, false);
    assert.equal(readFileSync(summaryPath, 'utf8'), before);
    assert.equal(existsSync(path.join(outsideRun, 'events.jsonl')), false);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('finalizeRun: production default rejects a linked .ao ancestor', {
  skip: process.platform === 'win32',
}, async () => {
  const tmpDir = await makeTmpDir();
  try {
    const outsideAo = path.join(tmpDir, 'outside-ao');
    const runId = 'atlas-20260712-120000-cafe';
    const outsideRun = path.join(outsideAo, 'artifacts', 'runs', runId);
    mkdirSync(outsideRun, { recursive: true, mode: 0o700 });
    const summaryPath = path.join(outsideRun, 'summary.json');
    const before = JSON.stringify({
      runId,
      orchestrator: 'atlas',
      task: 'outside',
      startedAt: new Date().toISOString(),
      status: 'running',
    }, null, 2);
    writeFileSync(summaryPath, before, { mode: 0o600 });
    symlinkSync(outsideAo, path.join(tmpDir, '.ao'), 'dir');
    const program = [
      `import { finalizeRun } from ${JSON.stringify(RUN_ARTIFACTS_URL)};`,
      `console.log(JSON.stringify(finalizeRun(${JSON.stringify(runId)}, { result: 'success' })));`,
    ].join('\n');
    const result = JSON.parse(execFileSync(process.execPath, [
      '--input-type=module',
      '--eval',
      program,
    ], { cwd: tmpDir, encoding: 'utf8' }));

    assert.equal(result.ok, false);
    assert.equal(readFileSync(summaryPath, 'utf8'), before);
    assert.equal(existsSync(path.join(outsideRun, 'events.jsonl')), false);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('finalizeRun: rejects a symlinked state directory before pointer deletion', {
  skip: process.platform === 'win32',
}, async () => {
  const tmpDir = await makeTmpDir();
  try {
    const base = path.join(tmpDir, 'runs');
    const stateDir = path.join(tmpDir, 'state');
    const { runId, runDir } = createRun('atlas', 'task', { base, stateDir });
    const summaryPath = path.join(runDir, 'summary.json');
    const before = readFileSync(summaryPath, 'utf8');
    await fsp.rm(stateDir, { recursive: true, force: true });
    const outsideState = path.join(tmpDir, 'outside-state');
    mkdirSync(outsideState, { mode: 0o700 });
    const outsidePointer = path.join(outsideState, 'ao-active-run-atlas.json');
    const pointerBytes = JSON.stringify({
      runId,
      orchestrator: 'atlas',
      startedAt: new Date().toISOString(),
    }, null, 2);
    writeFileSync(outsidePointer, pointerBytes, { mode: 0o600 });
    symlinkSync(outsideState, stateDir, 'dir');

    const result = finalizeRun(runId, { result: 'success' }, { base, stateDir });
    assert.equal(result.ok, false);
    assert.equal(readFileSync(summaryPath, 'utf8'), before);
    assert.equal(readFileSync(outsidePointer, 'utf8'), pointerBytes);
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

    // 2 manual events + run_finalized (this historical test run is inactive).
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

// ---------------------------------------------------------------------------
// Read-path hardening: public inspection helpers must never dereference an
// attacker-selected run id, linked directory chain, or linked artifact leaf.
// ---------------------------------------------------------------------------

test('read APIs: traversal and linked run/base ancestry fail closed without disclosure', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const base = path.join(tmpDir, 'runs');
    const escaped = path.join(tmpDir, 'escaped');
    await fsp.mkdir(base, { mode: 0o700 });
    await fsp.mkdir(escaped, { mode: 0o700 });
    writeFileSync(path.join(escaped, 'summary.json'), JSON.stringify({
      runId: 'atlas-escaped',
      topSecret: 'TOP_SECRET',
    }), { mode: 0o600 });
    writeFileSync(path.join(escaped, 'events.jsonl'), `${JSON.stringify({
      type: 'checkpoint_saved', detail: { secret: 'EVENT_SECRET' },
    })}\n`, { mode: 0o600 });

    const traversal = getRun('../escaped', { base, trustedRoot: tmpDir });
    assertEmptyRunRecord(traversal);
    assert.equal(JSON.stringify(traversal).includes('TOP_SECRET'), false);
    assert.equal(replayEvents('../escaped', { base, trustedRoot: tmpDir }), null);
    assert.equal(verifyStory('../escaped', 'US-001', { base, trustedRoot: tmpDir }), null);
    assert.deepEqual(getRunVerificationSummary('../escaped', { base, trustedRoot: tmpDir }), {
      total: 0, passed: 0, failed: 0, skipped: 0, stories: {},
    });
    assert.deepEqual(generateCompletionNotices('../escaped', { base, trustedRoot: tmpDir }), []);
    assert.deepEqual(checkVerificationGate('../escaped', ['US-001'], {
      base, trustedRoot: tmpDir,
    }).missing, ['US-001']);

    const realRoot = path.join(tmpDir, 'real-root');
    const realBase = path.join(realRoot, 'runs');
    const linkedRoot = path.join(tmpDir, 'linked-root');
    await fsp.mkdir(realBase, { recursive: true, mode: 0o700 });
    const created = createRun('atlas', 'linked ancestor reader', { base: realBase });
    symlinkSync(realRoot, linkedRoot, 'dir');
    const linkedBase = path.join(linkedRoot, 'runs');

    assertEmptyRunRecord(getRun(created.runId, {
      base: linkedBase,
      trustedRoot: tmpDir,
    }));
    assert.equal(replayEvents(created.runId, { base: linkedBase, trustedRoot: tmpDir }), null);
    assert.deepEqual(listRuns({ base: linkedBase, trustedRoot: tmpDir }), []);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('read APIs: summary/event symlinks and hardlinks return only fail-safe values', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const base = path.join(tmpDir, 'runs');
    await fsp.mkdir(base, { mode: 0o700 });
    const summarySecret = path.join(tmpDir, 'summary-secret.json');
    const eventSecret = path.join(tmpDir, 'event-secret.jsonl');
    writeFileSync(summarySecret, JSON.stringify({ topSecret: 'TOP_SECRET' }), { mode: 0o600 });
    writeFileSync(eventSecret, `${JSON.stringify({
      type: 'checkpoint_saved', detail: { secret: 'EVENT_SECRET' },
    })}\n`, { mode: 0o600 });

    const summaryLinked = createRun('atlas', 'summary link reader', { base });
    unlinkSync(path.join(summaryLinked.runDir, 'summary.json'));
    symlinkSync(summarySecret, path.join(summaryLinked.runDir, 'summary.json'));
    const linkedSummaryRecord = getRun(summaryLinked.runId, { base, trustedRoot: tmpDir });
    assertEmptyRunRecord(linkedSummaryRecord);
    assert.equal(JSON.stringify(linkedSummaryRecord).includes('TOP_SECRET'), false);
    assert.equal(listRuns({ base, trustedRoot: tmpDir })
      .some(run => run.runId === summaryLinked.runId), false);

    const eventLinked = createRun('atlas', 'event link reader', { base });
    addEvent(eventLinked.runId, {
      type: 'checkpoint_saved', detail: { phase: 'safe-before-link' },
    }, { base, trustedRoot: tmpDir });
    unlinkSync(path.join(eventLinked.runDir, 'events.jsonl'));
    symlinkSync(eventSecret, path.join(eventLinked.runDir, 'events.jsonl'));
    const linkedEventRecord = getRun(eventLinked.runId, { base, trustedRoot: tmpDir });
    assertEmptyRunRecord(linkedEventRecord);
    assert.equal(JSON.stringify(linkedEventRecord).includes('EVENT_SECRET'), false);
    assert.equal(replayEvents(eventLinked.runId, { base, trustedRoot: tmpDir }), null);
    assert.equal(verifyStory(eventLinked.runId, 'US-001', { base, trustedRoot: tmpDir }), null);
    assert.deepEqual(generateCompletionNotices(eventLinked.runId, {
      base, trustedRoot: tmpDir,
    }), []);

    const hardLinked = createRun('atlas', 'summary hardlink reader', { base });
    unlinkSync(path.join(hardLinked.runDir, 'summary.json'));
    linkSync(summarySecret, path.join(hardLinked.runDir, 'summary.json'));
    const hardlinkedSummaryRecord = getRun(hardLinked.runId, { base, trustedRoot: tmpDir });
    assertEmptyRunRecord(hardlinkedSummaryRecord);
    assert.equal(JSON.stringify(hardlinkedSummaryRecord).includes('TOP_SECRET'), false);
    assert.equal(listRuns({ base, trustedRoot: tmpDir })
      .some(run => run.runId === hardLinked.runId), false);

    // A valid summary remains listable even if a different artifact is unsafe;
    // listRuns reads only the bounded, no-follow summary leaf.
    assert.equal(listRuns({ base, trustedRoot: tmpDir })
      .some(run => run.runId === eventLinked.runId), true);
  } finally {
    await removeTmpDir(tmpDir);
  }
});
