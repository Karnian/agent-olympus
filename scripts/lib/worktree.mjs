/**
 * Git worktree isolation for Athena parallel workers.
 * Each worker gets an independent worktree so file changes never collide.
 * All functions are fail-safe: errors are caught and handled gracefully.
 *
 * Security: All git commands use execFileSync (no shell) to prevent injection.
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteFileSync } from './fs-atomic.mjs';

const WORKTREE_BASE = '.ao/worktrees';
const WORKTREE_REGISTRY = '.ao/state/worktree-registry.json';

/**
 * Read the persistent worktree registry.
 * @returns {Array<{ teamName: string, workerName: string, worktreePath: string, branchName: string, createdAt: string }>}
 */
function readRegistry() {
  try {
    return JSON.parse(readFileSync(WORKTREE_REGISTRY, 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * Write the worktree registry atomically.
 * @param {Array} entries
 */
function writeRegistry(entries) {
  try {
    mkdirSync(join('.ao', 'state'), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(WORKTREE_REGISTRY, JSON.stringify(entries, null, 2));
  } catch {
    // fail-safe
  }
}

/**
 * Register a worktree in the persistent registry for orphan tracking.
 */
function registerWorktree(teamName, workerName, worktreePath, branchName) {
  const entries = readRegistry();
  entries.push({ teamName, workerName, worktreePath, branchName, createdAt: new Date().toISOString() });
  writeRegistry(entries);
}

/**
 * Unregister a worktree from the persistent registry.
 */
function unregisterWorktree(worktreePath) {
  const entries = readRegistry().filter(e => e.worktreePath !== worktreePath);
  writeRegistry(entries);
}

/**
 * Clean up any orphaned worktrees found in the registry.
 * Only removes entries that were successfully cleaned; failed entries remain for retry.
 * @param {string} cwd - Project root
 * @returns {{ cleaned: number, errors: number }}
 */
export function cleanupOrphanWorktrees(cwd) {
  let cleaned = 0;
  let errors = 0;

  try {
    const entries = readRegistry();
    if (entries.length === 0) return { cleaned: 0, errors: 0 };

    const remaining = [];
    for (const entry of entries) {
      const result = removeWorkerWorktree(cwd, entry.worktreePath, entry.branchName);
      if (result.removed) cleaned++;
      else { errors++; remaining.push(entry); }
    }

    // Only clear successfully removed entries; keep failed ones for next attempt
    writeRegistry(remaining);
  } catch {
    errors++;
  }

  return { cleaned, errors };
}

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
        execFileSync('git', ['-C', cwd, 'worktree', 'remove', worktreePath, '--force'], { stdio: 'pipe' });
      } catch {
        try { rmSync(worktreePath, { recursive: true, force: true }); } catch {}
      }
    }

    // Delete branch if it already exists from a previous run
    try {
      execFileSync('git', ['-C', cwd, 'branch', '-D', branchName], { stdio: 'pipe' });
    } catch {
      // Branch does not exist — that is fine
    }

    // Create the worktree on a new branch based on HEAD
    execFileSync('git', ['-C', cwd, 'worktree', 'add', worktreePath, '-b', branchName], { stdio: 'pipe' });

    // Register in persistent registry for orphan tracking
    registerWorktree(teamName, workerName, worktreePath, branchName);

    return { worktreePath, branchName, created: true };
  } catch (err) {
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
 * Create isolated git worktrees for an entire team of workers in one batch.
 *
 * This helper was extracted from `tmux-session.createTeamSession` so that
 * worktree creation is decoupled from tmux session creation. The return
 * shape mirrors what `tmux-session.createTeamSession` already stores on
 * each worker (`worktreePath`, `branchName`, `worktreeCreated`), so existing
 * consumers can switch to this helper without touching their state schema.
 *
 * Failure semantics are inherited from `createWorkerWorktree`:
 *   - On git failure, `worktreePath` falls back to `cwd` and
 *     `worktreeCreated` is `false`. Consumers MUST check `worktreeCreated`
 *     if they need to distinguish a real isolated worktree from the
 *     fallback shared directory — this is a first-class field.
 *   - Errors are never thrown; each worker's entry is self-contained.
 *
 * @param {string} teamName
 * @param {Array<{ name: string }>} workers
 * @param {string} cwd - Project root (absolute path)
 * @returns {Array<{
 *   workerName: string,
 *   worktreePath: string,
 *   branchName: string,
 *   worktreeCreated: boolean,
 *   error?: string,
 * }>}
 */
export function createTeamWorktrees(teamName, workers, cwd) {
  const results = [];
  for (const worker of workers) {
    const info = createWorkerWorktree(cwd, teamName, worker.name);
    const entry = {
      workerName: worker.name,
      worktreePath: info.worktreePath,
      branchName: info.branchName,
      worktreeCreated: info.created,
    };
    if (info.error) entry.error = info.error;
    results.push(entry);
  }
  return results;
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
    try {
      execFileSync('git', ['-C', cwd, 'worktree', 'remove', worktreePath, '--force'], { stdio: 'pipe' });
    } catch {
      if (existsSync(worktreePath)) {
        try { rmSync(worktreePath, { recursive: true, force: true }); } catch {}
      }
    }

    try {
      execFileSync('git', ['-C', cwd, 'worktree', 'prune'], { stdio: 'pipe' });
    } catch {}

    if (branchName) {
      try {
        execFileSync('git', ['-C', cwd, 'branch', '-D', branchName], { stdio: 'pipe' });
      } catch {}
    }

    unregisterWorktree(worktreePath);

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

    const raw = execFileSync('git', ['-C', cwd, 'worktree', 'list', '--porcelain'], {
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim();

    if (!raw) return [];

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

    const mergeOutput = execFileSync('git', ['-C', cwd, 'merge', branchName, '--no-ff', '-m', message], {
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim();

    return { success: true, conflicts: [], mergeOutput };
  } catch (err) {
    let conflicts = [];
    try {
      const conflictOutput = execFileSync('git', ['-C', cwd, 'diff', '--name-only', '--diff-filter=U'], {
        stdio: 'pipe',
        encoding: 'utf-8',
      }).trim();
      conflicts = conflictOutput ? conflictOutput.split('\n').filter(Boolean) : [];
    } catch {}

    // Abort the failed merge so the repo is left in a clean state
    try { execFileSync('git', ['-C', cwd, 'merge', '--abort'], { stdio: 'pipe' }); } catch {}

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

    try {
      const slug = sanitizeName(teamName);
      const baseDir = join(cwd, WORKTREE_BASE, slug);
      if (existsSync(baseDir)) {
        rmSync(baseDir, { recursive: true, force: true });
      }
    } catch {}

    try {
      execFileSync('git', ['-C', cwd, 'worktree', 'prune'], { stdio: 'pipe' });
    } catch {}
  } catch {
    errors++;
  }

  return { cleaned, errors };
}
