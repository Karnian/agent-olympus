/**
 * Git worktree isolation for Athena parallel workers.
 * Each worker gets an independent worktree so file changes never collide.
 * All functions are fail-safe: errors are caught and handled gracefully.
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

const WORKTREE_BASE = '.ao/worktrees';

/**
 * Sanitize a name for use in branch names and directory paths.
 * Mirrors the logic in tmux-session.mjs sanitizeName().
 * @param {string} name
 * @returns {string}
 */
function sanitizeName(name) {
  return String(name).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 50);
}

/**
 * Create a git worktree for an Athena worker.
 * Worktree path: .ao/worktrees/<teamSlug>/<workerName>/
 * Branch name:   ao-worker-<teamSlug>-<workerName>
 *
 * @param {string} cwd        - Project root (absolute path)
 * @param {string} teamName   - Athena team slug
 * @param {string} workerName - Worker name
 * @returns {{ worktreePath: string, branchName: string, created: boolean }}
 */
export function createWorkerWorktree(cwd, teamName, workerName) {
  try {
    const slug = sanitizeName(teamName);
    const worker = sanitizeName(workerName);
    const branchName = `ao-worker-${slug}-${worker}`;
    const worktreePath = join(cwd, WORKTREE_BASE, slug, worker);

    // Ensure parent directory exists with restricted permissions
    mkdirSync(join(cwd, WORKTREE_BASE, slug), { recursive: true, mode: 0o700 });

    // Remove stale worktree if it exists (e.g. from a previous cancelled run)
    if (existsSync(worktreePath)) {
      try {
        execSync(`git -C "${cwd}" worktree remove "${worktreePath}" --force`, { stdio: 'pipe' });
      } catch {
        // Directory may exist but not be registered — try rmSync as fallback
        try { rmSync(worktreePath, { recursive: true, force: true }); } catch {}
      }
    }

    // Delete branch if it already exists from a previous run
    try {
      execSync(`git -C "${cwd}" branch -D "${branchName}"`, { stdio: 'pipe' });
    } catch {
      // Branch does not exist — that is fine
    }

    // Create the worktree on a new branch based on HEAD
    execSync(
      `git -C "${cwd}" worktree add "${worktreePath}" -b "${branchName}"`,
      { stdio: 'pipe' }
    );

    return { worktreePath, branchName, created: true };
  } catch (err) {
    // Fail-safe: return a descriptor that signals creation failed
    // The caller must handle created:false and fall back to cwd
    const slug = sanitizeName(teamName);
    const worker = sanitizeName(workerName);
    return {
      worktreePath: cwd,
      branchName: `ao-worker-${slug}-${worker}`,
      created: false,
      error: err?.message,
    };
  }
}

/**
 * Remove a worker's worktree and delete its branch.
 *
 * @param {string} cwd           - Project root
 * @param {string} worktreePath  - Absolute path to the worktree
 * @param {string} branchName    - Branch to delete after removal
 * @returns {{ removed: boolean }}
 */
export function removeWorkerWorktree(cwd, worktreePath, branchName) {
  try {
    // Remove registered worktree entry (prune if needed)
    try {
      execSync(`git -C "${cwd}" worktree remove "${worktreePath}" --force`, { stdio: 'pipe' });
    } catch {
      // If unregistered, remove directory directly
      if (existsSync(worktreePath)) {
        try { rmSync(worktreePath, { recursive: true, force: true }); } catch {}
      }
    }

    // Prune stale worktree references
    try {
      execSync(`git -C "${cwd}" worktree prune`, { stdio: 'pipe' });
    } catch {}

    // Delete the branch
    if (branchName) {
      try {
        execSync(`git -C "${cwd}" branch -D "${branchName}"`, { stdio: 'pipe' });
      } catch {}
    }

    return { removed: true };
  } catch {
    return { removed: false };
  }
}

/**
 * List all active worktrees for a team.
 * Parses `git worktree list --porcelain` output.
 *
 * @param {string} cwd      - Project root
 * @param {string} teamName - Team slug to filter by
 * @returns {Array<{ path: string, branch: string, head: string }>}
 */
export function listTeamWorktrees(cwd, teamName) {
  try {
    const slug = sanitizeName(teamName);
    const prefix = `ao-worker-${slug}-`;

    const raw = execSync(`git -C "${cwd}" worktree list --porcelain`, {
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim();

    if (!raw) return [];

    // Each worktree block is separated by a blank line
    const blocks = raw.split(/\n\n+/);
    const results = [];

    for (const block of blocks) {
      const lines = block.split('\n');
      const entry = {};
      for (const line of lines) {
        if (line.startsWith('worktree ')) entry.path = line.slice('worktree '.length);
        else if (line.startsWith('HEAD '))    entry.head = line.slice('HEAD '.length);
        else if (line.startsWith('branch '))  entry.branch = line.slice('branch refs/heads/'.length);
      }
      if (entry.branch && entry.branch.startsWith(prefix)) {
        results.push(entry);
      }
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * Merge a worker's branch into the current branch (sequential integration).
 * Uses --no-ff to always produce a merge commit so history is clear.
 *
 * @param {string} cwd        - Project root
 * @param {string} branchName - Worker branch to merge
 * @param {string} workerName - Human-readable worker name (for commit message)
 * @returns {{ success: boolean, conflicts: string[], mergeOutput: string }}
 */
export function mergeWorkerBranch(cwd, branchName, workerName) {
  try {
    const message = `integrate: ${sanitizeName(workerName)} changes`;

    const mergeOutput = execSync(
      `git -C "${cwd}" merge "${branchName}" --no-ff -m "${message}"`,
      { stdio: 'pipe', encoding: 'utf-8' }
    ).trim();

    return { success: true, conflicts: [], mergeOutput };
  } catch (err) {
    // Merge failed — likely a conflict; collect conflicting files
    let conflicts = [];
    try {
      const conflictOutput = execSync(
        `git -C "${cwd}" diff --name-only --diff-filter=U`,
        { stdio: 'pipe', encoding: 'utf-8' }
      ).trim();
      conflicts = conflictOutput ? conflictOutput.split('\n').filter(Boolean) : [];
    } catch {}

    return {
      success: false,
      conflicts,
      mergeOutput: err?.stdout?.toString() || err?.message || '',
    };
  }
}

/**
 * Clean up all worktrees for a team (used on cancel/completion).
 * Removes each worktree directory and its branch, then prunes.
 *
 * @param {string} cwd      - Project root
 * @param {string} teamName - Team slug
 * @returns {{ cleaned: number, errors: number }}
 */
export function cleanupTeamWorktrees(cwd, teamName) {
  let cleaned = 0;
  let errors = 0;

  try {
    const worktrees = listTeamWorktrees(cwd, teamName);

    for (const wt of worktrees) {
      const result = removeWorkerWorktree(cwd, wt.path, wt.branch);
      if (result.removed) cleaned++;
      else errors++;
    }

    // Also prune the base directory if it is empty
    try {
      const slug = sanitizeName(teamName);
      const baseDir = join(cwd, WORKTREE_BASE, slug);
      if (existsSync(baseDir)) {
        rmSync(baseDir, { recursive: true, force: true });
      }
    } catch {}

    // Final prune to clear git's internal references
    try {
      execSync(`git -C "${cwd}" worktree prune`, { stdio: 'pipe' });
    } catch {}
  } catch {
    errors++;
  }

  return { cleaned, errors };
}
