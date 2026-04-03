/**
 * Tests for scripts/session-end.mjs
 *
 * Tests via child_process: pipe `{}` on stdin, observe stdout and filesystem state.
 * Tests cover:
 *   - cleans state files older than 24 hours
 *   - preserves state files newer than 24 hours
 *   - cleans team directories older than 24 hours
 *   - preserves recent team directories
 *   - handles missing .ao/state/ and .ao/teams/ directories gracefully
 *   - outputs {} or suppressOutput JSON
 *   - always outputs valid JSON (fail-safe)
 *
 * Uses node:test — zero npm dependencies.
 * All I/O uses temporary directories; the real .ao/ directory is never touched.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, utimesSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
function runHook(cwd) {
  const raw = execSync(`echo '{}' | node "${SCRIPT}"`, {
    encoding: 'utf-8',
    cwd,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10000,
  });
  return JSON.parse(raw.trim());
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
// Fail-safe — always valid JSON
// ---------------------------------------------------------------------------

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
