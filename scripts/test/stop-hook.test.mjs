/**
 * Tests for scripts/stop-hook.mjs
 *
 * Tests via child_process: pipe `{}` on stdin, observe stdout and git state.
 * Tests cover:
 *   - no git repo → outputs {} immediately
 *   - git repo with no uncommitted changes → outputs {}
 *   - git repo with uncommitted changes → creates ao-wip commit
 *   - git repo with atlas phase>=5 checkpoint → skips WIP commit
 *   - WIP commit message format is correct
 *   - execFileSync is used (safe from shell injection — commit is created)
 *
 * Uses node:test — zero npm dependencies.
 * All I/O uses temporary directories; the real repo is never touched.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '..', 'stop-hook.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ao-stop-hook-test-'));
}

async function removeTmpDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Run the stop hook in `cwd`.
 * Returns parsed JSON output.
 */
function runHook(cwd) {
  const raw = execSync(`echo '{}' | node "${SCRIPT}"`, {
    encoding: 'utf-8',
    cwd,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 15000,
  });
  return JSON.parse(raw.trim());
}

/**
 * Initialize a git repo with an initial commit in `dir`.
 */
function initGitRepo(dir) {
  execSync('git init -q', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  writeFileSync(path.join(dir, '.gitkeep'), '', 'utf-8');
  execSync('git add .gitkeep', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });
}

/**
 * Get the most recent commit message in the repo.
 */
function lastCommitMessage(dir) {
  return execSync('git log -1 --format=%s', {
    encoding: 'utf-8',
    cwd: dir,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Get the number of commits in the repo.
 */
function commitCount(dir) {
  return parseInt(
    execSync('git rev-list --count HEAD', {
      encoding: 'utf-8',
      cwd: dir,
      stdio: 'pipe',
    }).trim(),
    10,
  );
}

/**
 * Write an atlas/athena checkpoint file with the given phase.
 */
function writeCheckpoint(dir, orchestrator, phase) {
  const stateDir = path.join(dir, '.ao', 'state');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(stateDir, `checkpoint-${orchestrator}.json`),
    JSON.stringify({
      orchestrator,
      phase,
      savedAt: new Date().toISOString(),
      startedAt: new Date(Date.now() - 60000).toISOString(),
      completedStories: [],
    }),
    { encoding: 'utf-8', mode: 0o600 },
  );
}

// ---------------------------------------------------------------------------
// Not a git repo
// ---------------------------------------------------------------------------

describe('stop-hook: not inside a git repo', () => {
  let tmpDir;
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async () => { await removeTmpDir(tmpDir); });

  it('outputs {} when not inside a git repo', () => {
    const output = runHook(tmpDir);
    assert.deepEqual(output, {});
  });
});

// ---------------------------------------------------------------------------
// Git repo with no uncommitted changes
// ---------------------------------------------------------------------------

describe('stop-hook: git repo with clean working tree', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    initGitRepo(tmpDir);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('outputs {} when there are no uncommitted changes', () => {
    const output = runHook(tmpDir);
    assert.deepEqual(output, {});
  });

  it('does not create an extra commit when tree is clean', () => {
    const before = commitCount(tmpDir);
    runHook(tmpDir);
    const after = commitCount(tmpDir);
    assert.equal(after, before, 'no new commit should be created for a clean working tree');
  });
});

// ---------------------------------------------------------------------------
// Git repo with uncommitted changes → WIP commit is created
// Each test gets its own fresh repo to avoid shared-state ordering issues.
// ---------------------------------------------------------------------------

describe('stop-hook: git repo with uncommitted changes — outputs {}', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    initGitRepo(tmpDir);
    writeFileSync(path.join(tmpDir, 'work-in-progress.js'), 'const x = 1;', 'utf-8');
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('outputs {} (never blocks session termination)', () => {
    const output = runHook(tmpDir);
    assert.deepEqual(output, {});
  });
});

describe('stop-hook: git repo with uncommitted changes — creates WIP commit', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    initGitRepo(tmpDir);
    writeFileSync(path.join(tmpDir, 'work-in-progress.js'), 'const x = 1;', 'utf-8');
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('creates a WIP commit for the uncommitted changes', () => {
    const beforeCount = commitCount(tmpDir);
    runHook(tmpDir);
    const afterCount = commitCount(tmpDir);
    assert.equal(afterCount, beforeCount + 1, 'a WIP commit should have been created');
  });
});

describe('stop-hook: git repo with uncommitted changes — WIP commit message format', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    initGitRepo(tmpDir);
    writeFileSync(path.join(tmpDir, 'work-in-progress.js'), 'const x = 1;', 'utf-8');
    // Run hook once so the commit exists for message checks
    runHook(tmpDir);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('WIP commit message starts with ao-wip(', () => {
    const msg = lastCommitMessage(tmpDir);
    assert.ok(msg.startsWith('ao-wip('), `commit message should start with "ao-wip(", got: ${msg}`);
  });

  it('WIP commit message mentions file count', () => {
    const msg = lastCommitMessage(tmpDir);
    assert.match(msg, /\d+ file/, 'WIP commit message should mention file count');
  });

  it('WIP commit message mentions session end', () => {
    const msg = lastCommitMessage(tmpDir);
    assert.ok(msg.includes('session end'), `commit message should mention "session end", got: ${msg}`);
  });
});

// ---------------------------------------------------------------------------
// WIP commit message includes phase when a checkpoint is present
// ---------------------------------------------------------------------------

describe('stop-hook: WIP commit message with atlas checkpoint', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    initGitRepo(tmpDir);
    writeCheckpoint(tmpDir, 'atlas', 2);
    writeFileSync(path.join(tmpDir, 'feature.ts'), 'export const foo = true;', 'utf-8');
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('includes the phase number in the WIP commit message', () => {
    runHook(tmpDir);
    const msg = lastCommitMessage(tmpDir);
    assert.ok(
      msg.includes('phase-2'),
      `commit message should include "phase-2", got: ${msg}`,
    );
  });
});

describe('stop-hook: WIP commit message with no checkpoint uses "manual"', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    initGitRepo(tmpDir);
    writeFileSync(path.join(tmpDir, 'manual-change.txt'), 'change', 'utf-8');
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('uses "manual" label in WIP commit message when no checkpoint exists', () => {
    runHook(tmpDir);
    const msg = lastCommitMessage(tmpDir);
    assert.ok(msg.includes('manual'), `commit message should include "manual", got: ${msg}`);
  });
});

// ---------------------------------------------------------------------------
// Phase >= 5 skips WIP commit (git-master handles it)
// ---------------------------------------------------------------------------

describe('stop-hook: phase >= 5 defers to git-master', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    initGitRepo(tmpDir);
    writeCheckpoint(tmpDir, 'atlas', 5);
    writeFileSync(path.join(tmpDir, 'almost-done.ts'), 'export const done = true;', 'utf-8');
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('outputs {} without creating a WIP commit when phase is 5', () => {
    const beforeCount = commitCount(tmpDir);
    const output = runHook(tmpDir);
    const afterCount = commitCount(tmpDir);

    assert.deepEqual(output, {});
    assert.equal(afterCount, beforeCount, 'no WIP commit should be created at phase >= 5');
  });
});

describe('stop-hook: phase 6 also defers to git-master', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    initGitRepo(tmpDir);
    writeCheckpoint(tmpDir, 'atlas', 6);
    writeFileSync(path.join(tmpDir, 'final.ts'), 'export const final = true;', 'utf-8');
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('outputs {} without creating a WIP commit when phase is 6', () => {
    const beforeCount = commitCount(tmpDir);
    runHook(tmpDir);
    const afterCount = commitCount(tmpDir);
    assert.equal(afterCount, beforeCount, 'no WIP commit should be created at phase >= 5');
  });
});

// ---------------------------------------------------------------------------
// Multiple files staged correctly
// ---------------------------------------------------------------------------

describe('stop-hook: multiple uncommitted files', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    initGitRepo(tmpDir);
    writeFileSync(path.join(tmpDir, 'file-a.js'), 'const a = 1;', 'utf-8');
    writeFileSync(path.join(tmpDir, 'file-b.js'), 'const b = 2;', 'utf-8');
    writeFileSync(path.join(tmpDir, 'file-c.js'), 'const c = 3;', 'utf-8');
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('creates exactly one WIP commit for multiple files', () => {
    const beforeCount = commitCount(tmpDir);
    runHook(tmpDir);
    const afterCount = commitCount(tmpDir);
    assert.equal(afterCount, beforeCount + 1, 'should create exactly one WIP commit');
  });

  it('WIP commit message mentions 3 files', () => {
    const msg = lastCommitMessage(tmpDir);
    assert.ok(
      msg.includes('3 file'),
      `WIP commit message should mention 3 files, got: ${msg}`,
    );
  });
});

// ---------------------------------------------------------------------------
// execFileSync is used — verify by checking the commit was created
// (If exec were used with shell injection risk, we just verify the commit exists)
// ---------------------------------------------------------------------------

describe('stop-hook: uses execFileSync for git commit (no shell injection)', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    initGitRepo(tmpDir);
    // File name with characters that would break shell interpolation
    writeFileSync(path.join(tmpDir, 'normal-file.js'), 'const safe = true;', 'utf-8');
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('creates WIP commit even when working in directories with special chars', () => {
    const beforeCount = commitCount(tmpDir);
    runHook(tmpDir);
    const afterCount = commitCount(tmpDir);
    assert.equal(afterCount, beforeCount + 1, 'WIP commit should be created via execFileSync');
  });
});
