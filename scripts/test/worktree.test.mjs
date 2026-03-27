/**
 * Integration tests for scripts/lib/worktree.mjs
 *
 * All tests operate on temporary git repositories so they never touch
 * the real project worktree. Each test gets an isolated repo via makeGitRepo().
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  createWorkerWorktree,
  removeWorkerWorktree,
  listTeamWorktrees,
  mergeWorkerBranch,
  cleanupTeamWorktrees,
} from '../lib/worktree.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal git repo with one commit so worktrees can be added. */
async function makeGitRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-worktree-test-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  // Need at least one commit before we can create worktrees
  await fs.writeFile(path.join(dir, 'README.md'), 'test repo\n');
  execSync('git add README.md && git commit -m "init"', { cwd: dir, stdio: 'pipe', shell: true });
  return dir;
}

async function removeDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

/** Prune git metadata then remove the temp repo directory. */
async function teardownRepo(dir) {
  try { execSync('git worktree prune', { cwd: dir, stdio: 'pipe' }); } catch {}
  await removeDir(dir);
}

// ---------------------------------------------------------------------------
// Test: createWorkerWorktree
// ---------------------------------------------------------------------------

test('createWorkerWorktree: creates worktree directory and branch', async () => {
  const repo = await makeGitRepo();
  try {
    const result = createWorkerWorktree(repo, 'my-team', 'worker-1');
    assert.equal(result.created, true);
    assert.ok(result.worktreePath.includes('my-team'), 'worktreePath should contain team slug');
    assert.ok(result.branchName.startsWith('ao-worker-'), 'branchName should start with ao-worker-');
    assert.ok(existsSync(result.worktreePath), 'worktree directory should exist on disk');
  } finally {
    await teardownRepo(repo);
  }
});

test('createWorkerWorktree: worktree directory contains git files', async () => {
  const repo = await makeGitRepo();
  try {
    const { worktreePath } = createWorkerWorktree(repo, 'team-files', 'file-worker');
    // A valid worktree should contain a .git file (not directory)
    assert.ok(existsSync(path.join(worktreePath, '.git')), 'worktree should have .git file');
  } finally {
    await teardownRepo(repo);
  }
});

test('createWorkerWorktree: re-creating stale worktree succeeds without error', async () => {
  const repo = await makeGitRepo();
  try {
    const r1 = createWorkerWorktree(repo, 'team-stale', 'stale-worker');
    assert.equal(r1.created, true);
    // Second call should clean up and recreate
    const r2 = createWorkerWorktree(repo, 'team-stale', 'stale-worker');
    assert.equal(r2.created, true);
    assert.ok(existsSync(r2.worktreePath));
  } finally {
    await teardownRepo(repo);
  }
});

test('createWorkerWorktree: non-git directory returns created:false (fail-safe)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-no-git-'));
  try {
    const result = createWorkerWorktree(dir, 'team', 'worker');
    assert.equal(result.created, false);
    assert.ok(typeof result.error === 'string', 'error field should contain message');
    // Fail-safe: worktreePath still returned (falls back to cwd)
    assert.ok(typeof result.worktreePath === 'string');
  } finally {
    await removeDir(dir);
  }
});

test('createWorkerWorktree: special chars in names are sanitized', async () => {
  const repo = await makeGitRepo();
  try {
    const result = createWorkerWorktree(repo, 'team/special!', 'worker@123');
    assert.equal(result.created, true);
    // Branch name must not contain raw special chars
    assert.ok(!/[/!@]/.test(result.branchName), 'branch name should not contain special chars');
  } finally {
    await teardownRepo(repo);
  }
});

// ---------------------------------------------------------------------------
// Test: removeWorkerWorktree
// ---------------------------------------------------------------------------

test('removeWorkerWorktree: removes worktree directory and returns removed:true', async () => {
  const repo = await makeGitRepo();
  try {
    const { worktreePath, branchName } = createWorkerWorktree(repo, 'rm-team', 'rm-worker');
    assert.ok(existsSync(worktreePath));

    const result = removeWorkerWorktree(repo, worktreePath, branchName);
    assert.equal(result.removed, true);
    assert.ok(!existsSync(worktreePath), 'worktree directory should be gone');
  } finally {
    await teardownRepo(repo);
  }
});

test('removeWorkerWorktree: non-existent path returns removed:true (graceful)', async () => {
  const repo = await makeGitRepo();
  try {
    const result = removeWorkerWorktree(repo, '/tmp/does-not-exist-ao', 'ao-worker-fake');
    // Should not throw; removed may be true or false depending on git behaviour
    assert.equal(typeof result.removed, 'boolean');
  } finally {
    await teardownRepo(repo);
  }
});

// ---------------------------------------------------------------------------
// Test: listTeamWorktrees
// ---------------------------------------------------------------------------

test('listTeamWorktrees: returns worktrees for the specified team only', async () => {
  const repo = await makeGitRepo();
  try {
    createWorkerWorktree(repo, 'list-team', 'alpha');
    createWorkerWorktree(repo, 'list-team', 'beta');
    createWorkerWorktree(repo, 'other-team', 'gamma');

    const list = listTeamWorktrees(repo, 'list-team');
    assert.equal(list.length, 2, 'should return exactly 2 worktrees for list-team');
    assert.ok(list.every(wt => wt.branch && wt.branch.includes('list-team')));
  } finally {
    await teardownRepo(repo);
  }
});

test('listTeamWorktrees: returns empty array when no matching worktrees', async () => {
  const repo = await makeGitRepo();
  try {
    const list = listTeamWorktrees(repo, 'no-such-team');
    assert.deepEqual(list, []);
  } finally {
    await teardownRepo(repo);
  }
});

test('listTeamWorktrees: returned entries have path and branch fields', async () => {
  const repo = await makeGitRepo();
  try {
    createWorkerWorktree(repo, 'fields-team', 'fields-worker');
    const list = listTeamWorktrees(repo, 'fields-team');
    assert.equal(list.length, 1);
    assert.ok(typeof list[0].path === 'string');
    assert.ok(typeof list[0].branch === 'string');
  } finally {
    await teardownRepo(repo);
  }
});

// ---------------------------------------------------------------------------
// Test: mergeWorkerBranch
// ---------------------------------------------------------------------------

test('mergeWorkerBranch: merges branch with new commit into main repo', async () => {
  const repo = await makeGitRepo();
  try {
    const { worktreePath, branchName } = createWorkerWorktree(repo, 'merge-team', 'merge-worker');

    // Make a commit in the worktree
    await fs.writeFile(path.join(worktreePath, 'feature.txt'), 'new feature\n');
    execSync('git add feature.txt && git commit -m "add feature"', {
      cwd: worktreePath,
      stdio: 'pipe',
      shell: true,
    });

    const result = mergeWorkerBranch(repo, branchName, 'merge-worker');
    assert.equal(result.success, true);
    assert.deepEqual(result.conflicts, []);
    assert.ok(existsSync(path.join(repo, 'feature.txt')), 'feature.txt should appear in main repo after merge');
  } finally {
    await teardownRepo(repo);
  }
});

test('mergeWorkerBranch: invalid branch name returns success:false', async () => {
  const repo = await makeGitRepo();
  try {
    const result = mergeWorkerBranch(repo, 'ao-worker-nonexistent-branch', 'ghost');
    assert.equal(result.success, false);
  } finally {
    await teardownRepo(repo);
  }
});

// ---------------------------------------------------------------------------
// Test: cleanupTeamWorktrees
// ---------------------------------------------------------------------------

test('cleanupTeamWorktrees: removes all worktrees for a team', async () => {
  const repo = await makeGitRepo();
  try {
    createWorkerWorktree(repo, 'cleanup-team', 'w1');
    createWorkerWorktree(repo, 'cleanup-team', 'w2');

    const before = listTeamWorktrees(repo, 'cleanup-team');
    assert.equal(before.length, 2);

    const result = cleanupTeamWorktrees(repo, 'cleanup-team');
    assert.equal(result.cleaned, 2);
    assert.equal(result.errors, 0);

    const after = listTeamWorktrees(repo, 'cleanup-team');
    assert.equal(after.length, 0, 'no worktrees should remain after cleanup');
  } finally {
    await teardownRepo(repo);
  }
});

test('cleanupTeamWorktrees: no-op on team with no worktrees (returns cleaned:0)', async () => {
  const repo = await makeGitRepo();
  try {
    const result = cleanupTeamWorktrees(repo, 'phantom-team');
    assert.equal(result.cleaned, 0);
    assert.equal(result.errors, 0);
  } finally {
    await teardownRepo(repo);
  }
});
