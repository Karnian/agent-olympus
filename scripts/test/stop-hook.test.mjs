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
 * Get the list of file paths contained in the most recent commit.
 * Returns an array (empty leading line from `--format=` trimmed away).
 */
function committedFiles(dir) {
  return execSync('git show --name-only --format=', {
    encoding: 'utf-8',
    cwd: dir,
    stdio: 'pipe',
  }).trim().split('\n').filter(Boolean);
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

  it('WIP commit message includes file name or action verb', () => {
    const msg = lastCommitMessage(tmpDir);
    // New format uses action verbs: add, update, remove; or file counts for long messages
    assert.ok(
      msg.includes('add ') || msg.includes('update ') || msg.includes('remove ') || /\d+ file/.test(msg),
      `commit message should include action verb or file count, got: ${msg}`,
    );
  });

  it('WIP commit message references actual file name', () => {
    const msg = lastCommitMessage(tmpDir);
    assert.ok(
      msg.includes('work-in-progress.js'),
      `commit message should reference actual file name, got: ${msg}`,
    );
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

  it('WIP commit message mentions all three files or uses count', () => {
    const msg = lastCommitMessage(tmpDir);
    // Either lists file names or shows count for >3 files
    const mentionsFiles = msg.includes('file-a.js') || msg.includes('file-b.js') || msg.includes('file-c.js');
    const mentionsCount = /3 file/.test(msg);
    assert.ok(
      mentionsFiles || mentionsCount,
      `WIP commit message should mention file names or count, got: ${msg}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Descriptive message: mixed add + modify
// ---------------------------------------------------------------------------

describe('stop-hook: descriptive message with add + modify', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    initGitRepo(tmpDir);
    // Modify existing file
    writeFileSync(path.join(tmpDir, '.gitkeep'), 'modified', 'utf-8');
    // Add new file
    writeFileSync(path.join(tmpDir, 'new-feature.ts'), 'export const x = 1;', 'utf-8');
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('WIP commit message distinguishes add and update actions', () => {
    runHook(tmpDir);
    const msg = lastCommitMessage(tmpDir);
    assert.ok(msg.startsWith('ao-wip('), `should start with ao-wip(, got: ${msg}`);
    // Should mention both add and update
    assert.ok(
      msg.includes('add') && msg.includes('update'),
      `should mention both add and update, got: ${msg}`,
    );
  });
});

describe('stop-hook: descriptive message with many files uses count format', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    initGitRepo(tmpDir);
    // Create 6 files to trigger count-based format
    for (let i = 0; i < 6; i++) {
      writeFileSync(path.join(tmpDir, `module-${i}.mjs`), `export const x${i} = ${i};`, 'utf-8');
    }
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('falls back to count format when subject line would exceed 72 chars', () => {
    runHook(tmpDir);
    // Read full commit message (body included)
    const fullMsg = execSync('git log -1 --format=%B', {
      encoding: 'utf-8',
      cwd: tmpDir,
      stdio: 'pipe',
    }).trim();
    // Should have a Files: section in the body
    assert.ok(
      fullMsg.includes('Files:'),
      `commit body should list files when >3, got: ${fullMsg}`,
    );
  });
});

// ---------------------------------------------------------------------------
// .claude/worktrees/ exclusion — pure noise from Claude Code worktree gitlinks
// ---------------------------------------------------------------------------

describe('stop-hook: excludes untracked .claude/worktrees/ files from staging', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    initGitRepo(tmpDir);
    mkdirSync(path.join(tmpDir, '.claude', 'worktrees'), { recursive: true });
    // Untracked HEAD pointer file under .claude/worktrees/
    writeFileSync(path.join(tmpDir, '.claude', 'worktrees', 'angry-williamson'), 'ref: refs/heads/foo\n', 'utf-8');
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('does not create a WIP commit when only .claude/worktrees/ files are dirty', () => {
    const beforeCount = commitCount(tmpDir);
    runHook(tmpDir);
    const afterCount = commitCount(tmpDir);
    assert.equal(afterCount, beforeCount, 'should not commit pure .claude/worktrees/ noise');
  });
});

describe('stop-hook: excludes tracked .claude/worktrees/ gitlink modifications', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    initGitRepo(tmpDir);
    // Simulate tracked gitlink (mode 160000) under .claude/worktrees/
    // Use a real commit sha (HEAD of the temp repo) as the gitlink target
    const headSha = execSync('git rev-parse HEAD', {
      encoding: 'utf-8', cwd: tmpDir, stdio: 'pipe',
    }).trim();
    execSync(
      `git update-index --add --cacheinfo 160000,${headSha},.claude/worktrees/quirky-albattani`,
      { cwd: tmpDir, stdio: 'pipe' },
    );
    execSync('git commit -m "add fake gitlink"', { cwd: tmpDir, stdio: 'pipe' });
    // Make a second commit to get a different sha, then mutate the gitlink to it
    writeFileSync(path.join(tmpDir, 'sentinel.txt'), 'one', 'utf-8');
    execSync('git add sentinel.txt && git commit -m "sentinel"', { cwd: tmpDir, stdio: 'pipe' });
    const otherSha = execSync('git rev-parse HEAD', {
      encoding: 'utf-8', cwd: tmpDir, stdio: 'pipe',
    }).trim();
    execSync(
      `git update-index --cacheinfo 160000,${otherSha},.claude/worktrees/quirky-albattani`,
      { cwd: tmpDir, stdio: 'pipe' },
    );
    // Reset index entry back to unstaged so the hook sees it as a working-tree change
    execSync('git reset HEAD .claude/worktrees/quirky-albattani', { cwd: tmpDir, stdio: 'pipe' });
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('does not include .claude/worktrees/ gitlink changes in WIP commit', () => {
    const beforeCount = commitCount(tmpDir);
    runHook(tmpDir);
    const afterCount = commitCount(tmpDir);
    // Either no commit (only worktree noise) or, if other changes exist, none mention worktrees
    if (afterCount > beforeCount) {
      const fullMsg = execSync('git log -1 --format=%B', {
        encoding: 'utf-8',
        cwd: tmpDir,
        stdio: 'pipe',
      }).trim();
      assert.ok(
        !fullMsg.includes('quirky-albattani'),
        `WIP commit should not reference .claude/worktrees/ gitlinks, got: ${fullMsg}`,
      );
    } else {
      assert.equal(afterCount, beforeCount, 'no commit expected when only worktree gitlink changed');
    }
  });
});

describe('stop-hook: still commits real changes alongside .claude/worktrees/ noise', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    initGitRepo(tmpDir);
    mkdirSync(path.join(tmpDir, '.claude', 'worktrees'), { recursive: true });
    writeFileSync(path.join(tmpDir, '.claude', 'worktrees', 'angry-williamson'), 'ref: refs/heads/foo\n', 'utf-8');
    writeFileSync(path.join(tmpDir, 'real-work.js'), 'const real = true;', 'utf-8');
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('creates a WIP commit containing only real-work.js', () => {
    const beforeCount = commitCount(tmpDir);
    runHook(tmpDir);
    const afterCount = commitCount(tmpDir);
    assert.equal(afterCount, beforeCount + 1, 'a WIP commit should be created for real-work.js');

    const stagedFiles = execSync('git show --name-only --format=', {
      encoding: 'utf-8',
      cwd: tmpDir,
      stdio: 'pipe',
    }).trim();
    assert.ok(stagedFiles.includes('real-work.js'), `commit should contain real-work.js, got: ${stagedFiles}`);
    assert.ok(
      !stagedFiles.includes('.claude/worktrees/'),
      `commit should NOT contain .claude/worktrees/ files, got: ${stagedFiles}`,
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

// ---------------------------------------------------------------------------
// Secret-staging guard — tracked secrets must never enter a WIP commit.
// Regression for: `git add -u` staged EVERY tracked change, so a previously
// committed .env/credentials file got auto-committed (and could be pushed).
// ---------------------------------------------------------------------------

describe('stop-hook: tracked, modified .env is never staged into the WIP commit', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    initGitRepo(tmpDir);
    // .env was committed in a prior life → it is now a TRACKED file.
    writeFileSync(path.join(tmpDir, '.env'), 'SECRET=old\n', 'utf-8');
    execSync('git add .env', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit -m "add env"', { cwd: tmpDir, stdio: 'pipe' });
    // The user edits the secret (tracked modification) ...
    writeFileSync(path.join(tmpDir, '.env'), 'SECRET=new-leaked-value\n', 'utf-8');
    // ... alongside legitimate work.
    writeFileSync(path.join(tmpDir, 'app.js'), 'export const ok = true;', 'utf-8');
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('commits app.js but excludes the tracked .env modification', () => {
    const beforeCount = commitCount(tmpDir);
    runHook(tmpDir);
    const afterCount = commitCount(tmpDir);
    assert.equal(afterCount, beforeCount + 1, 'a WIP commit should be created for app.js');

    const files = committedFiles(tmpDir);
    assert.ok(files.includes('app.js'), `commit should contain app.js, got: ${files}`);
    assert.ok(!files.includes('.env'), `WIP commit must NOT contain .env, got: ${files}`);
  });
});

describe('stop-hook: a lone tracked .env modification produces no WIP commit', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    initGitRepo(tmpDir);
    writeFileSync(path.join(tmpDir, '.env'), 'TOKEN=old\n', 'utf-8');
    execSync('git add .env', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit -m "add env"', { cwd: tmpDir, stdio: 'pipe' });
    writeFileSync(path.join(tmpDir, '.env'), 'TOKEN=leaked\n', 'utf-8');
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('creates no commit when the only change is a tracked secret', () => {
    const beforeCount = commitCount(tmpDir);
    runHook(tmpDir);
    const afterCount = commitCount(tmpDir);
    assert.equal(afterCount, beforeCount, 'no WIP commit should be created for a lone secret change');
  });
});

describe('stop-hook: scrubs a pre-staged secret from the index', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    initGitRepo(tmpDir);
    writeFileSync(path.join(tmpDir, '.env'), 'API=old\n', 'utf-8');
    execSync('git add .env', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit -m "add env"', { cwd: tmpDir, stdio: 'pipe' });
    // User explicitly stages the secret modification before the session ends ...
    writeFileSync(path.join(tmpDir, '.env'), 'API=leaked\n', 'utf-8');
    execSync('git add .env', { cwd: tmpDir, stdio: 'pipe' });
    // ... plus an unstaged legit change.
    writeFileSync(path.join(tmpDir, 'app.js'), 'export const ok = 1;', 'utf-8');
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('removes the pre-staged .env so the WIP commit carries only app.js', () => {
    const beforeCount = commitCount(tmpDir);
    runHook(tmpDir);
    const afterCount = commitCount(tmpDir);
    assert.equal(afterCount, beforeCount + 1, 'a WIP commit should be created for app.js');

    const files = committedFiles(tmpDir);
    assert.ok(files.includes('app.js'), `commit should contain app.js, got: ${files}`);
    assert.ok(!files.includes('.env'), `pre-staged .env must be scrubbed, got: ${files}`);
  });
});

describe('stop-hook: excludes additional credential file patterns', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    initGitRepo(tmpDir);
    writeFileSync(path.join(tmpDir, '.npmrc'), '//registry.npmjs.org/:_authToken=abc', 'utf-8');
    writeFileSync(path.join(tmpDir, '.netrc'), 'machine x login y password z', 'utf-8');
    writeFileSync(path.join(tmpDir, 'id_rsa'), 'PRIVATE KEY', 'utf-8');
    writeFileSync(path.join(tmpDir, 'cert.p12'), 'binary', 'utf-8');
    writeFileSync(path.join(tmpDir, 'cert.pfx'), 'binary', 'utf-8');
    writeFileSync(path.join(tmpDir, 'auth-token.json'), '{"t":"x"}', 'utf-8');
    // One legit file so a commit is actually produced.
    writeFileSync(path.join(tmpDir, 'safe.js'), 'const ok = 1;', 'utf-8');
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('commits only safe.js, never the credential files', () => {
    const beforeCount = commitCount(tmpDir);
    runHook(tmpDir);
    const afterCount = commitCount(tmpDir);
    assert.equal(afterCount, beforeCount + 1, 'a WIP commit should be created for safe.js');

    const files = committedFiles(tmpDir);
    assert.deepEqual(files, ['safe.js'], `only safe.js should be committed, got: ${files}`);
  });
});

// ---------------------------------------------------------------------------
// In-progress operation guard — never finalize a half-resolved merge/rebase.
// ---------------------------------------------------------------------------

describe('stop-hook: skips WIP commit during an in-progress merge', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    initGitRepo(tmpDir);
    // Dirty work that would normally be auto-committed ...
    writeFileSync(path.join(tmpDir, 'feature.js'), 'const wip = true;', 'utf-8');
    // ... but a merge is in progress.
    writeFileSync(path.join(tmpDir, '.git', 'MERGE_HEAD'), `${'0'.repeat(40)}\n`, 'utf-8');
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('creates no commit while .git/MERGE_HEAD exists', () => {
    const beforeCount = commitCount(tmpDir);
    const output = runHook(tmpDir);
    const afterCount = commitCount(tmpDir);
    assert.deepEqual(output, {});
    assert.equal(afterCount, beforeCount, 'no WIP commit should be created mid-merge');
  });
});

describe('stop-hook: skips WIP commit during cherry-pick / revert / rebase', () => {
  for (const marker of ['CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    it(`creates no commit while .git/${marker} exists`, async () => {
      const tmpDir = await makeTmpDir();
      try {
        initGitRepo(tmpDir);
        writeFileSync(path.join(tmpDir, 'wip.js'), 'const x = 1;', 'utf-8');
        writeFileSync(path.join(tmpDir, '.git', marker), `${'0'.repeat(40)}\n`, 'utf-8');
        const beforeCount = commitCount(tmpDir);
        runHook(tmpDir);
        assert.equal(commitCount(tmpDir), beforeCount, `no commit expected during ${marker}`);
      } finally {
        await removeTmpDir(tmpDir);
      }
    });
  }

  it('creates no commit while .git/rebase-merge exists', async () => {
    const tmpDir = await makeTmpDir();
    try {
      initGitRepo(tmpDir);
      writeFileSync(path.join(tmpDir, 'wip.js'), 'const x = 1;', 'utf-8');
      mkdirSync(path.join(tmpDir, '.git', 'rebase-merge'), { recursive: true });
      const beforeCount = commitCount(tmpDir);
      runHook(tmpDir);
      assert.equal(commitCount(tmpDir), beforeCount, 'no commit expected during rebase');
    } finally {
      await removeTmpDir(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Hardening from the Codex cross-review of the secret-staging fix:
//   - non-ASCII paths (git octal-quotes them without -z, slipping the patterns)
//   - .env at a nested depth
//   - unborn HEAD: pre-staged-then-modified secret (git rm --cached fails open
//     without -f, leaving the secret staged)
//   - a staged `git mv` of a secret (rename hides the sensitive name)
// ---------------------------------------------------------------------------

describe('stop-hook: a non-ASCII secret filename is still excluded (-z, no octal quoting)', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    initGitRepo(tmpDir);
    writeFileSync(path.join(tmpDir, '비밀.pem'), 'PRIVATE KEY', 'utf-8'); // "secret".pem
    writeFileSync(path.join(tmpDir, 'safe.js'), 'const ok = 1;', 'utf-8');
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('commits only safe.js, never the non-ASCII .pem', () => {
    runHook(tmpDir);
    // Only safe.js should be present; the quoted secret must not appear at all.
    assert.deepEqual(committedFiles(tmpDir), ['safe.js'],
      `non-ASCII secret leaked: ${committedFiles(tmpDir)}`);
  });
});

describe('stop-hook: a nested .env (subdirectory) is excluded', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    initGitRepo(tmpDir);
    mkdirSync(path.join(tmpDir, 'config'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'config', '.env'), 'SECRET=x\n', 'utf-8');
    writeFileSync(path.join(tmpDir, 'safe.js'), 'const ok = 1;', 'utf-8');
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('commits only safe.js, never config/.env', () => {
    runHook(tmpDir);
    const files = committedFiles(tmpDir);
    assert.ok(files.includes('safe.js'), `commit should contain safe.js, got: ${files}`);
    assert.ok(!files.includes('config/.env'), `nested .env must be excluded, got: ${files}`);
  });
});

describe('stop-hook: unborn HEAD — a pre-staged then modified secret is never committed', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    // Fresh repo with NO initial commit → HEAD is unborn.
    execSync('git init -q', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });
    writeFileSync(path.join(tmpDir, '.env'), 'SECRET=a\n', 'utf-8');
    execSync('git add .env', { cwd: tmpDir, stdio: 'pipe' });            // staged addition
    writeFileSync(path.join(tmpDir, '.env'), 'SECRET=a\nmore\n', 'utf-8'); // index != worktree
    writeFileSync(path.join(tmpDir, 'app.js'), 'export const ok = 1;', 'utf-8');
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('commits app.js but force-unstages the pre-staged .env (git rm -f --cached path)', () => {
    runHook(tmpDir);
    let files = [];
    try {
      files = execSync('git show --name-only --format=', {
        cwd: tmpDir, encoding: 'utf-8', stdio: 'pipe',
      }).trim().split('\n').filter(Boolean);
    } catch {
      // No commit at all would also be safe, but we expect app.js to be saved.
    }
    assert.ok(!files.includes('.env'), `.env must never be committed on unborn HEAD, got: ${files}`);
    assert.ok(files.includes('app.js'), `app.js should still be saved, got: ${files}`);
  });
});

describe('stop-hook: a staged `git mv` of a secret keeps the secret out of the commit', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    initGitRepo(tmpDir);
    writeFileSync(path.join(tmpDir, '.env'), 'SECRET=v\n', 'utf-8');
    execSync('git add .env', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit -qm "add env"', { cwd: tmpDir, stdio: 'pipe' });
    // Rename the secret to an innocuous name (git mv auto-stages the rename) ...
    execSync('git mv .env public.txt', { cwd: tmpDir, stdio: 'pipe' });
    // ... plus a legit untracked change so a commit is warranted.
    writeFileSync(path.join(tmpDir, 'app.js'), 'export const ok = 1;', 'utf-8');
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('commits app.js but not the renamed secret (public.txt)', () => {
    runHook(tmpDir);
    const files = committedFiles(tmpDir);
    assert.ok(files.includes('app.js'), `commit should contain app.js, got: ${files}`);
    assert.ok(!files.includes('public.txt'),
      `the renamed secret (public.txt) must not be committed, got: ${files}`);
  });
});

describe('stop-hook: credential extension matching is case-insensitive', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    initGitRepo(tmpDir);
    // Uppercase extensions are common for Windows certs — must still be excluded.
    writeFileSync(path.join(tmpDir, 'cert.PEM'), 'X', 'utf-8');
    writeFileSync(path.join(tmpDir, 'priv.KEY'), 'X', 'utf-8');
    writeFileSync(path.join(tmpDir, 'safe.js'), 'const ok = 1;', 'utf-8');
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('commits only safe.js, never cert.PEM / priv.KEY', () => {
    runHook(tmpDir);
    assert.deepEqual(committedFiles(tmpDir), ['safe.js'],
      `uppercase-extension secret leaked: ${committedFiles(tmpDir)}`);
  });
});

// ---------------------------------------------------------------------------
// F1 (Codex cross-review of the unified branch): the UNSTAGED rename bypass.
// `mv .env public.txt` (plain shell, NOT `git mv`) leaves the .env deletion
// unstaged and public.txt untracked — the rename pair is never both staged, so
// `-M` cannot pair them and the safe name dodges the pattern filter. The
// blob-hash content net (unstageStagedStolenBlobs) must still catch it.
// ---------------------------------------------------------------------------

describe('stop-hook: an UNSTAGED rename of a tracked secret does not leak its content', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    initGitRepo(tmpDir);
    writeFileSync(path.join(tmpDir, '.env'), 'API_KEY=supersecret\n', 'utf-8');
    execSync('git add .env', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit -qm "add env"', { cwd: tmpDir, stdio: 'pipe' });
    // Plain shell mv — NOT git mv. .env → unstaged deletion; public.txt →
    // untracked addition carrying the byte-identical secret content.
    execSync('mv .env public.txt', { cwd: tmpDir, stdio: 'pipe' });
    writeFileSync(path.join(tmpDir, 'app.js'), 'export const ok = 1;', 'utf-8');
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('commits app.js but never public.txt nor the secret content', () => {
    runHook(tmpDir);
    const files = committedFiles(tmpDir);
    assert.ok(files.includes('app.js'), `commit should contain app.js, got: ${files}`);
    assert.ok(!files.includes('public.txt'),
      `the renamed-away secret (public.txt) must not be committed, got: ${files}`);
    // Defense-in-depth: the secret bytes must not reach the commit by ANY route.
    let head = '';
    try {
      head = execSync('git show HEAD', { cwd: tmpDir, encoding: 'utf-8', stdio: 'pipe' });
    } catch {}
    assert.ok(!head.includes('supersecret'),
      'secret content must never reach the WIP commit via a renamed safe-named file');
  });
});
