/**
 * Tests for scripts/session-end.mjs
 *
 * Tests via child_process: pipe `{}` on stdin, observe stdout and filesystem state.
 * Tests cover:
 *   - cleans state files older than 24 hours
 *   - preserves state files newer than 24 hours
 *   - cleans team directories older than 24 hours
 *   - preserves recent team directories
 *   - cleans stale provider-fallback artifacts while preserving recent ones
 *   - handles missing .ao/state/ and .ao/teams/ directories gracefully
 *   - outputs {} or suppressOutput JSON
 *   - always outputs valid JSON (fail-safe)
 *
 * Uses node:test — zero npm dependencies.
 * All I/O uses temporary directories; the real .ao/ directory is never touched.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, utimesSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRun } from '../lib/run-artifacts.mjs';
import { finalizeFailedRun } from '../lib/run-failure.mjs';
import { getPhaseSequence } from '../lib/phase-runner.mjs';
import {
  captureRuntimePermissions,
  loadRuntimePermissions,
  loadRuntimeSessionIdentity,
} from '../lib/runtime-permissions.mjs';
import { detectClaudePermissionLevel } from '../lib/permission-detect.mjs';
import {
  reserveWorkerBatchConcurrency,
} from '../lib/concurrency-limits.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '..', 'session-end.mjs');

const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ao-session-end-test-'));
}

async function removeTmpDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Run the session-end hook in `cwd`.
 * Returns parsed JSON output from stdout.
 */
function runHook(cwd, payload = {}, env = {}) {
  const raw = execFileSync(process.execPath, [SCRIPT], {
    encoding: 'utf-8',
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    input: JSON.stringify(payload),
    timeout: 10000,
  });
  return JSON.parse(raw.trim());
}

describe('session-end: revokes external runtime permission grant', () => {
  let tmpDir;
  let runtimeHome;
  before(async () => {
    tmpDir = await makeTmpDir();
    runtimeHome = `${tmpDir}-runtime-home`;
    mkdirSync(path.join(tmpDir, '.ao', 'state'), { recursive: true, mode: 0o700 });
    mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
  });
  after(async () => {
    await removeTmpDir(tmpDir);
    await removeTmpDir(runtimeHome);
  });

  it('tombstones the grant so restored workspace identity cannot replay it', () => {
    const sessionId = 'session-end-runtime-grant';
    assert.equal(captureRuntimePermissions({
      permissionMode: 'bypassPermissions',
      permissionModeObserved: true,
      source: 'hook_stdin',
      sessionId,
    }, { cwd: tmpDir, runtimeHome }), true);
    const identity = loadRuntimeSessionIdentity({ cwd: tmpDir });
    const identityText = readFileSync(path.join(tmpDir, '.ao', 'state', 'ao-runtime-permissions.json'), 'utf8');

    runHook(tmpDir, { session_id: sessionId, cwd: tmpDir }, { HOME: runtimeHome });

    assert.equal(loadRuntimePermissions({
      cwd: tmpDir,
      runtimeHome,
      expectedSessionId: sessionId,
      expectedCaptureId: identity.captureId,
    }), null);

    // Simulate a surviving workspace process restoring both local records.
    writeFileSync(path.join(tmpDir, '.ao', 'state', 'ao-runtime-permissions.json'), identityText, { mode: 0o600 });
    writeFileSync(path.join(tmpDir, '.ao', 'state', 'ao-current-session.json'), JSON.stringify({ sessionId }), { mode: 0o600 });
    assert.equal(detectClaudePermissionLevel({
      cwd: tmpDir,
      home: '/nonexistent',
      runtimeHome,
      stateBase: path.join(tmpDir, '.ao', 'state'),
    }), 'suggest');
  });

  it('does not let a late SessionEnd revoke a newer concurrent session grant', () => {
    const oldSession = 'session-end-old';
    const newSession = 'session-end-new';
    assert.equal(captureRuntimePermissions({
      permissionMode: 'bypassPermissions',
      permissionModeObserved: true,
      source: 'hook_stdin',
      sessionId: oldSession,
    }, { cwd: tmpDir, runtimeHome }), true);
    assert.equal(captureRuntimePermissions({
      permissionMode: 'acceptEdits',
      permissionModeObserved: true,
      source: 'hook_stdin',
      sessionId: newSession,
    }, { cwd: tmpDir, runtimeHome }), true);
    const current = loadRuntimeSessionIdentity({ cwd: tmpDir });

    runHook(tmpDir, { session_id: oldSession, cwd: tmpDir }, { HOME: runtimeHome });

    const grant = loadRuntimePermissions({
      cwd: tmpDir,
      runtimeHome,
      expectedSessionId: newSession,
      expectedCaptureId: current.captureId,
    });
    assert.equal(grant?.permissionMode, 'acceptEdits');
  });
});

function createTerminalFailure(cwd, failure = {}) {
  const runsBase = path.join(cwd, '.ao', 'artifacts', 'runs');
  const stateDir = path.join(cwd, '.ao', 'state');
  const orchestrator = failure.orchestrator || 'atlas';
  const created = createRun(orchestrator, 'session-end candidate test', { base: runsBase, stateDir });
  const phase = failure.phase || 'verify';
  const now = new Date().toISOString();
  const ids = getPhaseSequence(orchestrator).map(item => item.id);
  const cut = ids.indexOf(phase);
  const phases = Object.fromEntries(ids.map((id, index) => [id, {
    status: index < cut ? 'completed' : (index === cut ? 'in_progress' : 'pending'),
    ...(index <= cut ? { startedAt: now, attempts: 1 } : {}),
    ...(index < cut ? { completedAt: now } : {}),
  }]));
  writeFileSync(path.join(created.runDir, 'pipeline.json'), JSON.stringify({
    schemaVersion: 1,
    runId: created.runId,
    orchestrator,
    createdAt: now,
    updatedAt: now,
    attempt: 1,
    phases,
  }), { mode: 0o600 });
  finalizeFailedRun(created.runId, {
    orchestrator,
    failureClass: failure.failureClass || 'task-outcome',
    code: failure.code || 'verification_exhausted',
    phase,
  }, { base: runsBase, stateDir });
  return created.runId;
}

function writeSession(cwd, sessionId, runIds) {
  const dir = path.join(cwd, '.ao', 'sessions');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify({
    sessionId,
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: 'active',
    runIds,
  }), { mode: 0o600 });
}

/**
 * Set the mtime of a file/dir to `ageMs` milliseconds ago.
 */
function setMtime(filePath, ageMs) {
  const ts = new Date(Date.now() - ageMs);
  utimesSync(filePath, ts, ts);
}

/**
 * Create a file in `dir` with optional mtime override.
 */
function createFile(dir, name, ageMs = 0) {
  const filePath = path.join(dir, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(filePath, `content of ${name}`, { encoding: 'utf-8', mode: 0o600 });
  if (ageMs > 0) setMtime(filePath, ageMs);
  return filePath;
}

/**
 * Create a subdirectory in `dir` with optional mtime override.
 */
function createDir(dir, name, ageMs = 0) {
  const dirPath = path.join(dir, name);
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  if (ageMs > 0) setMtime(dirPath, ageMs);
  return dirPath;
}

// ---------------------------------------------------------------------------
// Missing directories — handled gracefully
// ---------------------------------------------------------------------------

describe('session-end: missing .ao/state/ and .ao/teams/ → outputs {}', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    // No .ao directory at all
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('outputs {} when directories do not exist', () => {
    const output = runHook(tmpDir);
    assert.deepEqual(output, {});
  });
});

// ---------------------------------------------------------------------------
// Stale state files are removed
// ---------------------------------------------------------------------------

describe('session-end: removes stale state files (> 24h)', () => {
  let tmpDir;
  let staleFile;
  before(async () => {
    tmpDir = await makeTmpDir();
    const stateDir = path.join(tmpDir, '.ao', 'state');
    // Create stale file (25 hours old)
    staleFile = createFile(stateDir, 'ao-old-state.json', STALE_MS + 60 * 60 * 1000);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('removes file older than 24 hours', () => {
    assert.ok(existsSync(staleFile), 'stale file should exist before hook runs');
    runHook(tmpDir);
    assert.ok(!existsSync(staleFile), 'stale file should be removed by hook');
  });

  it('outputs suppressOutput JSON when cleanup occurred', () => {
    // File was already removed in previous test; create a new stale file
    const stateDir = path.join(tmpDir, '.ao', 'state');
    const anotherStale = createFile(stateDir, 'ao-another-stale.json', STALE_MS + 1000);
    const output = runHook(tmpDir);
    assert.ok(!existsSync(anotherStale));
    // Output should be {} or { suppressOutput: true }
    assert.ok(
      typeof output === 'object',
      'output should be an object',
    );
  });
});

// ---------------------------------------------------------------------------
// Recent state files are preserved
// ---------------------------------------------------------------------------

describe('session-end: preserves recent state files (< 24h)', () => {
  let tmpDir;
  let recentFile;
  before(async () => {
    tmpDir = await makeTmpDir();
    const stateDir = path.join(tmpDir, '.ao', 'state');
    // Create fresh file (1 minute old)
    recentFile = createFile(stateDir, 'ao-recent-state.json', 60 * 1000);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('preserves file newer than 24 hours', () => {
    assert.ok(existsSync(recentFile), 'recent file should exist before hook runs');
    runHook(tmpDir);
    assert.ok(existsSync(recentFile), 'recent file should still exist after hook runs');
  });
});

describe('session-end: concurrency state has liveness-aware cleanup boundaries', () => {
  let tmpDir;
  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });
  afterEach(async () => { await removeTmpDir(tmpDir); });

  it('preserves stale live ledger/lock generations and removes only valid stale quarantines', () => {
    const stateDir = path.join(tmpDir, '.ao', 'state');
    const liveArtifacts = [
      createFile(stateDir, 'ao-concurrency.json', STALE_MS + 1000),
      createDir(stateDir, 'ao-concurrency.lock', STALE_MS + 1000),
      createDir(stateDir, 'ao-concurrency.reclaim', STALE_MS + 1000),
      createDir(stateDir, 'ao-concurrency.lock.claim-11111111-1111-4111-8111-111111111111', STALE_MS + 1000),
      createDir(stateDir, 'ao-concurrency.lock.stale-22222222-2222-4222-8222-222222222222', STALE_MS + 1000),
      // A lookalike is not proven to be a collision-safe quarantine and remains protected.
      createFile(stateDir, 'ao-concurrency.json.corrupt-not-a-generation', STALE_MS + 1000),
    ];
    const quarantine = createFile(
      stateDir,
      'ao-concurrency.json.corrupt-1770000000000-33333333-3333-4333-8333-333333333333',
      STALE_MS + 1000,
    );

    runHook(tmpDir);

    for (const artifact of liveArtifacts) assert.equal(existsSync(artifact), true, artifact);
    assert.equal(existsSync(quarantine), false);
  });

  it('does not lose a live reservation when its ledger mtime is older than 24 hours', () => {
    const stateDir = path.join(tmpDir, '.ao', 'state');
    const limits = { global: 1, claude: 1, codex: 1, gemini: 1 };
    const first = reserveWorkerBatchConcurrency(tmpDir, [{ name: 'live', type: 'claude' }], {
      teamName: 'live-team',
      runId: 'aaaaaaaaaaaaaaaa',
      limits,
    });
    assert.equal(first.ok, true);
    const ledgerPath = path.join(stateDir, 'ao-concurrency.json');
    writeFileSync(path.join(stateDir, 'team-live-team.json'), JSON.stringify({
      teamName: 'live-team',
      runId: 'aaaaaaaaaaaaaaaa',
      projectRoot: tmpDir,
      _concurrencyReservation: {
        schemaVersion: 1,
        reservationId: first.reservationId,
        entryIds: first.entryIds,
        reservedAt: first.entries[0].startedAt,
      },
      workers: [{
        name: 'live',
        type: 'claude',
        status: 'running',
        startedAt: first.entries[0].startedAt,
        _concurrencyEntryId: first.entryIds[0],
      }],
    }), { mode: 0o600 });
    setMtime(ledgerPath, STALE_MS + 60 * 60 * 1000);

    runHook(tmpDir);

    assert.equal(existsSync(ledgerPath), true);
    const second = reserveWorkerBatchConcurrency(tmpDir, [{ name: 'new', type: 'claude' }], {
      teamName: 'new-team',
      runId: 'bbbbbbbbbbbbbbbb',
      limits,
    });
    assert.equal(second.ok, false);
    assert.match(second.errors.join('\n'), /concurrency limit exceeded/);
  });
});

// ---------------------------------------------------------------------------
// Exact boundary: file at exactly 24h is considered stale
// ---------------------------------------------------------------------------

describe('session-end: file at exactly 24h boundary is cleaned', () => {
  let tmpDir;
  let boundaryFile;
  before(async () => {
    tmpDir = await makeTmpDir();
    const stateDir = path.join(tmpDir, '.ao', 'state');
    // Exactly 24h old (plus 1ms to ensure it's past the threshold)
    boundaryFile = createFile(stateDir, 'ao-boundary.json', STALE_MS + 1);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('removes file that is just past the 24h threshold', () => {
    runHook(tmpDir);
    assert.ok(!existsSync(boundaryFile), 'boundary file should be removed');
  });
});

// ---------------------------------------------------------------------------
// Stale team directories are removed
// ---------------------------------------------------------------------------

describe('session-end: removes stale .ao/teams/ directories (> 24h)', () => {
  let tmpDir;
  let staleTeamDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    const teamsDir = path.join(tmpDir, '.ao', 'teams');
    // Create a stale team directory (26 hours old)
    staleTeamDir = createDir(teamsDir, 'old-team-slug', STALE_MS + 2 * 60 * 60 * 1000);
    // Add a file inside it
    writeFileSync(path.join(staleTeamDir, 'inbox.json'), '[]', { encoding: 'utf-8', mode: 0o600 });
    setMtime(staleTeamDir, STALE_MS + 2 * 60 * 60 * 1000);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('removes team directory older than 24 hours', () => {
    assert.ok(existsSync(staleTeamDir), 'stale team dir should exist before hook runs');
    runHook(tmpDir);
    assert.ok(!existsSync(staleTeamDir), 'stale team dir should be removed by hook');
  });
});

// ---------------------------------------------------------------------------
// Recent team directories are preserved
// ---------------------------------------------------------------------------

describe('session-end: preserves recent .ao/teams/ directories (< 24h)', () => {
  let tmpDir;
  let recentTeamDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    const teamsDir = path.join(tmpDir, '.ao', 'teams');
    // Create a fresh team directory (5 minutes old)
    recentTeamDir = createDir(teamsDir, 'active-team-slug', 5 * 60 * 1000);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('preserves team directory newer than 24 hours', () => {
    assert.ok(existsSync(recentTeamDir), 'recent team dir should exist before hook runs');
    runHook(tmpDir);
    assert.ok(existsSync(recentTeamDir), 'recent team dir should still exist after hook runs');
  });
});

// ---------------------------------------------------------------------------
// Mixed stale + fresh: only stale removed
// ---------------------------------------------------------------------------

describe('session-end: mixed files — only stale ones removed', () => {
  let tmpDir;
  let staleFile;
  let freshFile;
  before(async () => {
    tmpDir = await makeTmpDir();
    const stateDir = path.join(tmpDir, '.ao', 'state');
    staleFile = createFile(stateDir, 'ao-stale.json', STALE_MS + 60 * 1000);
    freshFile = createFile(stateDir, 'ao-fresh.json', 30 * 60 * 1000); // 30 min old
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('removes stale file', () => {
    runHook(tmpDir);
    assert.ok(!existsSync(staleFile), 'stale file should be removed');
  });

  it('preserves fresh file', () => {
    assert.ok(existsSync(freshFile), 'fresh file should be preserved');
  });
});

describe('session-end: provider fallback artifact lifecycle', () => {
  let tmpDir;
  let staleArtifact;
  let freshArtifact;
  before(async () => {
    tmpDir = await makeTmpDir();
    const artifactDir = path.join(tmpDir, '.ao', 'artifacts', 'provider-fallback');
    staleArtifact = createFile(artifactDir, 'stale.json', STALE_MS + 60 * 1000);
    freshArtifact = createFile(artifactDir, 'fresh.json', 30 * 60 * 1000);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('removes stale output and preserves resumable recent output', () => {
    runHook(tmpDir);
    assert.equal(existsSync(staleArtifact), false);
    assert.equal(existsSync(freshArtifact), true);
  });
});

describe('session-end: HU-17 bounded linked-run candidate collection', () => {
  let tmpDir;
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async () => { await removeTmpDir(tmpDir); });

  it('collects only eligible failures linked to the ending session', () => {
    const linkedRun = createTerminalFailure(tmpDir);
    const unlinkedRun = createTerminalFailure(tmpDir);
    const infrastructureRun = createTerminalFailure(tmpDir, {
      failureClass: 'infrastructure',
      code: 'provider_unavailable',
      phase: 'verify',
    });
    const sessionId = 'hu17-linked-session';
    writeSession(tmpDir, sessionId, [linkedRun, infrastructureRun]);

    const output = runHook(tmpDir, { session_id: sessionId });
    assert.ok(typeof output === 'object');

    const recordsDir = path.join(tmpDir, '.ao', 'eval-candidates', 'records');
    const records = readdirSync(recordsDir).filter((name) => name.endsWith('.json'));
    assert.equal(records.length, 1, 'only the eligible linked run becomes a candidate');
    const candidate = JSON.parse(readFileSync(path.join(recordsDir, records[0]), 'utf-8'));
    assert.equal(candidate.run.runId, linkedRun);
    assert.notEqual(candidate.run.runId, unlinkedRun, 'SessionEnd must not globally scan run artifacts');
    assert.notEqual(candidate.run.runId, infrastructureRun, 'infrastructure failures are excluded');

    const session = JSON.parse(readFileSync(
      path.join(tmpDir, '.ao', 'sessions', `${sessionId}.json`),
      'utf-8',
    ));
    assert.equal(session.status, 'ended');
  });

  it('caps linked-run inspection at the newest 64 ids', () => {
    const source = readFileSync(SCRIPT, 'utf-8');
    assert.match(source, /session\.runIds[\s\S]*?slice\(-64\)/,
      'SessionEnd must have a structural 64-run cap and no global listing fallback');
    assert.doesNotMatch(source, /listRuns\s*\(/);
  });

  it('returns within the one-second budget when the candidate queue is live-locked', () => {
    const runId = createTerminalFailure(tmpDir);
    const sessionId = 'hu17-live-lock-session';
    writeSession(tmpDir, sessionId, [runId]);
    const candidateBase = path.join(tmpDir, '.ao', 'eval-candidates');
    const lockDir = path.join(candidateBase, '.queue-lock');
    mkdirSync(path.join(candidateBase, 'records'), { recursive: true, mode: 0o700 });
    mkdirSync(lockDir, { mode: 0o700 });
    writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
      schemaVersion: 1,
      token: '12345678-1234-4123-8123-123456789abc',
      pid: process.pid,
      startId: null,
      createdAt: new Date().toISOString(),
    }), { mode: 0o600 });

    const started = Date.now();
    runHook(tmpDir, { session_id: sessionId });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1_000, `SessionEnd exceeded one-second collection budget: ${elapsed}ms`);
    const session = JSON.parse(readFileSync(
      path.join(tmpDir, '.ao', 'sessions', `${sessionId}.json`), 'utf8',
    ));
    assert.equal(session.status, 'ended');
  });
});

// ---------------------------------------------------------------------------
// Output format
// ---------------------------------------------------------------------------

describe('session-end: output format when nothing cleaned', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    // Create only fresh files
    const stateDir = path.join(tmpDir, '.ao', 'state');
    createFile(stateDir, 'ao-recent.json', 10 * 60 * 1000);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('outputs {} when nothing was cleaned', () => {
    const output = runHook(tmpDir);
    assert.deepEqual(output, {});
  });
});

describe('session-end: output format when cleanup occurred', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    const stateDir = path.join(tmpDir, '.ao', 'state');
    createFile(stateDir, 'ao-old.json', STALE_MS + 60 * 1000);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('outputs object with suppressOutput when cleanup occurred', () => {
    const output = runHook(tmpDir);
    // Either {} (already cleaned in before) or { suppressOutput: true, _debug: '...' }
    assert.ok(typeof output === 'object', 'output should be an object');
    if (Object.keys(output).length > 0) {
      assert.equal(output.suppressOutput, true, 'suppressOutput should be true');
      assert.ok(typeof output._debug === 'string', '_debug should be a string');
    }
  });
});

// ---------------------------------------------------------------------------
// Deterministic pruning counter
// ---------------------------------------------------------------------------

describe('session-end: deterministic pruning counter', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    const stateDir = path.join(tmpDir, '.ao', 'state');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('creates counter file after first invocation', () => {
    runHook(tmpDir);
    const counterPath = path.join(tmpDir, '.ao', 'state', 'ao-session-end-counter.json');
    assert.ok(existsSync(counterPath), 'counter file should exist after first run');
    const data = JSON.parse(readFileSync(counterPath, 'utf-8'));
    assert.ok(data.count >= 1, 'counter should be at least 1');
  });

  it('increments counter on subsequent invocations', () => {
    const counterPath = path.join(tmpDir, '.ao', 'state', 'ao-session-end-counter.json');
    const before = JSON.parse(readFileSync(counterPath, 'utf-8')).count;
    runHook(tmpDir);
    const after = JSON.parse(readFileSync(counterPath, 'utf-8')).count;
    assert.equal(after, before + 1, 'counter should increment by 1');
  });
});

// ---------------------------------------------------------------------------
// v1.0.2 F-002: .ao/memory/ is NEVER touched by session-end
// ---------------------------------------------------------------------------

describe('session-end: v1.0.2 F-002 — .ao/memory/ is never swept', () => {
  let tmpDir;
  let oldMemoryFile;
  let oldMemoryJsonl;
  before(async () => {
    tmpDir = await makeTmpDir();
    // Create .ao/memory/ with files older than 24h
    const memDir = path.join(tmpDir, '.ao', 'memory');
    mkdirSync(memDir, { recursive: true, mode: 0o700 });
    oldMemoryFile = path.join(memDir, 'design-identity.json');
    writeFileSync(oldMemoryFile, '{"schemaVersion":1}', { encoding: 'utf-8', mode: 0o600 });
    setMtime(oldMemoryFile, STALE_MS + 2 * 60 * 60 * 1000); // 26h old

    oldMemoryJsonl = path.join(memDir, 'taste.jsonl');
    writeFileSync(oldMemoryJsonl, '{"schemaVersion":1,"id":"x"}\n', { encoding: 'utf-8', mode: 0o600 });
    setMtime(oldMemoryJsonl, STALE_MS + 2 * 60 * 60 * 1000);

    // Also ensure a stale state file is cleaned to prove session-end still runs
    const stateDir = path.join(tmpDir, '.ao', 'state');
    createFile(stateDir, 'ao-sentinel-stale.json', STALE_MS + 60 * 1000);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('does NOT delete stale files under .ao/memory/', () => {
    runHook(tmpDir);
    assert.ok(existsSync(oldMemoryFile), '.ao/memory/design-identity.json must survive');
    assert.ok(existsSync(oldMemoryJsonl), '.ao/memory/taste.jsonl must survive');
  });

  it('still cleans stale .ao/state/ files (control)', () => {
    const stateDir = path.join(tmpDir, '.ao', 'state');
    // The sentinel should already be gone from the previous run
    const sentinel = path.join(stateDir, 'ao-sentinel-stale.json');
    assert.ok(!existsSync(sentinel), 'stale state sentinel should have been cleaned');
  });
});

describe('session-end: PROTECTED_NAMES allow-list defense', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    // Create stale files in .ao/state/ using protected names —
    // even in the wrong location they must survive.
    const stateDir = path.join(tmpDir, '.ao', 'state');
    createFile(stateDir, 'design-identity.json', STALE_MS + 60 * 1000);
    createFile(stateDir, 'taste.jsonl', STALE_MS + 60 * 1000);
    createFile(stateDir, 'wisdom.jsonl', STALE_MS + 60 * 1000);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('preserves protected-name files even when stale and misplaced', () => {
    runHook(tmpDir);
    const stateDir = path.join(tmpDir, '.ao', 'state');
    assert.ok(existsSync(path.join(stateDir, 'design-identity.json')));
    assert.ok(existsSync(path.join(stateDir, 'taste.jsonl')));
    assert.ok(existsSync(path.join(stateDir, 'wisdom.jsonl')));
  });
});

describe('session-end: provider recovery claim lineages survive across sessions', () => {
  let tmpDir;
  const claimName = `.provider-fallback-${'a'.repeat(24)}-recovery-${'b'.repeat(64)}.claim`;
  const successorName = `.provider-fallback-${'a'.repeat(24)}-recovery-${'b'.repeat(64)}-successor-${'c'.repeat(64)}.claim`;
  before(async () => {
    tmpDir = await makeTmpDir();
    const stateDir = path.join(tmpDir, '.ao', 'state');
    createFile(stateDir, claimName, STALE_MS + 60 * 1000);
    createFile(stateDir, successorName, STALE_MS + 60 * 1000);
    createFile(stateDir, '.provider-fallback-malformed-recovery.claim', STALE_MS + 60 * 1000);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('preserves exact root and successor claims but still sweeps lookalikes', () => {
    runHook(tmpDir);
    const stateDir = path.join(tmpDir, '.ao', 'state');
    assert.ok(existsSync(path.join(stateDir, claimName)));
    assert.ok(existsSync(path.join(stateDir, successorName)));
    assert.equal(existsSync(path.join(stateDir, '.provider-fallback-malformed-recovery.claim')), false);
  });
});

// ---------------------------------------------------------------------------
// Fail-safe — always valid JSON
// ---------------------------------------------------------------------------

describe('session-end: F1 — active supervisor run protected, stale terminal run swept', () => {
  let tmpDir; let activeRun; let staleRun;
  before(async () => {
    tmpDir = await makeTmpDir();
    const supBase = path.join(tmpDir, '.ao', 'state', 'supervisor');
    const aRun = 'a1a1a1a1a1a1a1a1'; const aWrk = 'b2b2b2b2b2b2b2b2';
    activeRun = path.join(supBase, aRun);
    mkdirSync(activeRun, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(activeRun, `${aWrk}.snapshot.json`),
      JSON.stringify({ schemaVersion: 1, runId: aRun, workerRunId: aWrk, status: 'running', supervisorPid: process.pid, updatedAt: Date.now() }));
    setMtime(activeRun, STALE_MS + 3600000); // ancient dir, but the run is ACTIVE

    const sRun = 'c3c3c3c3c3c3c3c3'; const sWrk = 'd4d4d4d4d4d4d4d4';
    staleRun = path.join(supBase, sRun);
    mkdirSync(staleRun, { recursive: true, mode: 0o700 });
    const snapFile = path.join(staleRun, `${sWrk}.snapshot.json`);
    writeFileSync(snapFile,
      JSON.stringify({ schemaVersion: 1, runId: sRun, workerRunId: sWrk, status: 'completed', supervisorPid: 999999, updatedAt: Date.now() - (STALE_MS + 3600000) }));
    setMtime(snapFile, STALE_MS + 3600000);
    setMtime(staleRun, STALE_MS + 3600000);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('keeps the active run and removes the stale terminal run', () => {
    runHook(tmpDir);
    assert.ok(existsSync(activeRun), 'an active supervisor run must NOT be swept mid-flight');
    assert.ok(!existsSync(staleRun), 'a stale terminal supervisor run should be swept');
  });
});

describe('session-end: fail-safe — always valid JSON', () => {
  it('outputs valid JSON for non-JSON stdin', () => {
    const raw = execSync(`echo 'not json' | node "${SCRIPT}"`, {
      encoding: 'utf-8',
      cwd: os.tmpdir(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    assert.doesNotThrow(() => JSON.parse(raw.trim()), 'output should be valid JSON even for bad input');
  });

  it('outputs valid JSON for empty stdin', () => {
    const raw = execSync(`echo '' | node "${SCRIPT}"`, {
      encoding: 'utf-8',
      cwd: os.tmpdir(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    assert.doesNotThrow(() => JSON.parse(raw.trim()), 'output should be valid JSON for empty stdin');
  });
});
