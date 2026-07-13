/**
 * Git worktree isolation for Athena parallel workers.
 * Each worker gets an independent worktree so file changes never collide.
 * All functions are fail-safe: errors are caught and handled gracefully.
 *
 * Security: All git commands use execFileSync (no shell) to prevent injection.
 */

import { execFileSync } from 'child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, rmSync, readFileSync } from 'fs';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import { atomicWriteFileSync } from './fs-atomic.mjs';

const WORKTREE_BASE = '.ao/worktrees';
const WORKTREE_REGISTRY = '.ao/state/worktree-registry.json';

/**
 * Read the persistent worktree registry.
 * @param {string} cwd - Project root that owns the registry
 * @returns {Array<{ teamName: string, workerName: string, worktreePath: string, branchName: string, createdAt: string }>}
 */
function readRegistry(cwd) {
  try {
    return JSON.parse(readFileSync(join(cwd, WORKTREE_REGISTRY), 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * Write the worktree registry atomically.
 * @param {string} cwd - Project root that owns the registry
 * @param {Array} entries
 */
function writeRegistry(cwd, entries) {
  try {
    mkdirSync(join(cwd, '.ao', 'state'), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(join(cwd, WORKTREE_REGISTRY), JSON.stringify(entries, null, 2));
  } catch {
    // fail-safe
  }
}

/**
 * Register a worktree in the persistent registry for orphan tracking.
 */
function registerWorktree(cwd, teamName, workerName, worktreePath, branchName) {
  const entries = readRegistry(cwd).filter((entry) => entry.worktreePath !== worktreePath);
  entries.push({ teamName, workerName, worktreePath, branchName, createdAt: new Date().toISOString() });
  writeRegistry(cwd, entries);
}

/**
 * Unregister a worktree from the persistent registry.
 */
function unregisterWorktree(cwd, worktreePath) {
  const entries = readRegistry(cwd).filter(e => e.worktreePath !== worktreePath);
  writeRegistry(cwd, entries);
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
    const entries = readRegistry(cwd);
    if (entries.length === 0) return { cleaned: 0, errors: 0 };

    const remaining = [];
    for (const entry of entries) {
      const result = removeWorkerWorktree(cwd, entry.worktreePath, entry.branchName);
      if (result.removed) cleaned++;
      else { errors++; remaining.push(entry); }
    }

    // Only clear successfully removed entries; keep failed ones for next attempt
    writeRegistry(cwd, remaining);
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
 * Build a stable, collision-resistant path/ref component from a raw identity.
 *
 * Normalization alone is not an identity function: `api.v1` and `api-v1`
 * normalize to the same value, as do long names that differ after character
 * 50. Keep a short readable prefix, but always bind it to the complete raw
 * value (and its role) with a full SHA-256 digest. Always hashing also prevents
 * an already-safe raw name from impersonating the generated form of a lossy
 * name. The resulting component is at most 97 characters, keeping the full
 * worker branch below the common 255-byte filesystem component limit.
 *
 * @param {string} name
 * @param {'team'|'worker'} role
 * @returns {string}
 */
function managedIdentityName(name, role) {
  const raw = String(name);
  const readable = raw.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32) || 'unnamed';
  const digest = createHash('sha256')
    .update(role)
    .update('\0')
    .update(raw)
    .digest('hex');
  return `${readable}-${digest}`;
}

/**
 * Check whether an exact local branch ref exists.
 * Unexpected git failures are surfaced so callers fail closed.
 *
 * @param {string} cwd
 * @param {string} branchName
 * @returns {boolean}
 */
function localBranchExists(cwd, branchName) {
  try {
    execFileSync(
      'git',
      ['-C', cwd, 'show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
      { stdio: 'pipe' },
    );
    return true;
  } catch (err) {
    if (err?.status === 1) return false;
    throw err;
  }
}

/**
 * Check whether a branch is fully reachable from the current HEAD.
 * A status other than the documented 0/1 result is an unsafe probe failure.
 *
 * @param {string} cwd
 * @param {string} branchName
 * @returns {boolean}
 */
function branchIsAncestorOfHead(cwd, branchName) {
  try {
    execFileSync(
      'git',
      ['-C', cwd, 'merge-base', '--is-ancestor', branchName, 'HEAD'],
      { stdio: 'pipe' },
    );
    return true;
  } catch (err) {
    if (err?.status === 1) return false;
    throw err;
  }
}

/**
 * Pick a local branch name that preserves an unmerged worker branch.
 *
 * @param {string} cwd
 * @param {string} branchName
 * @returns {string}
 */
function nextPreservedBranchName(cwd, branchName) {
  const base = `${branchName}-orphan-${Math.floor(Date.now() / 1000)}`;
  let candidate = base;
  let suffix = 1;
  while (localBranchExists(cwd, candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/**
 * Create a git worktree for an Athena worker.
 * Worktree path: .ao/worktrees/<teamSlug>/<workerName>/
 * Branch name:   ao-worker-<teamSlug>-<workerName>
 *
 * Collision semantics:
 *   - `onExisting: 'fail'` returns the intended colliding path/ref without
 *     mutating either artifact.
 *   - `onExisting: 'replace'` keeps the legacy replacement behavior, but
 *     preserves branches not reachable from HEAD under an orphan name.
 *   - Other operational failures retain the legacy `cwd` fallback path.
 *
 * @param {string} cwd        - Project root (absolute path)
 * @param {string} teamName   - Athena team slug
 * @param {string} workerName - Worker name
 * @param {{ onExisting?: 'replace'|'fail' }} [opts] - Existing-artifact policy
 * @returns {{
 *   worktreePath: string,
 *   branchName: string,
 *   created: boolean,
 *   error?: string,
 *   preservedBranch?: string,
 * }}
 */
export function createWorkerWorktree(cwd, teamName, workerName, opts = {}) {
  let branchName = 'ao-worker-unavailable';
  let worktreePath = cwd;
  let preservedBranch;

  try {
    const slug = managedIdentityName(teamName, 'team');
    const worker = managedIdentityName(workerName, 'worker');
    branchName = `ao-worker-${slug}-${worker}`;
    worktreePath = join(cwd, WORKTREE_BASE, slug, worker);

    const onExisting = opts?.onExisting ?? 'replace';
    if (onExisting !== 'replace' && onExisting !== 'fail') {
      throw new Error(`Unsupported onExisting mode: ${onExisting}`);
    }

    const worktreeExists = existsSync(worktreePath);
    const branchExists = localBranchExists(cwd, branchName);

    if (onExisting === 'fail' && (worktreeExists || branchExists)) {
      const collisions = [];
      if (worktreeExists) collisions.push(`worktree path ${worktreePath}`);
      if (branchExists) collisions.push(`branch ${branchName}`);
      return {
        worktreePath,
        branchName,
        created: false,
        error: `Refusing to replace existing ${collisions.join(' and ')}`,
      };
    }

    const branchWasAncestor = branchExists
      ? branchIsAncestorOfHead(cwd, branchName)
      : false;

    // Ensure parent directory exists with restricted permissions before any
    // branch rename or stale-worktree removal can mutate existing state.
    mkdirSync(join(cwd, WORKTREE_BASE, slug), { recursive: true, mode: 0o700 });

    // Remove stale worktree if it exists (e.g. from a previous cancelled run)
    if (worktreeExists) {
      try {
        execFileSync('git', ['-C', cwd, 'worktree', 'remove', worktreePath, '--force'], { stdio: 'pipe' });
      } catch {
        try { rmSync(worktreePath, { recursive: true, force: true }); } catch {}
        try { execFileSync('git', ['-C', cwd, 'worktree', 'prune'], { stdio: 'pipe' }); } catch {}
      }
      if (existsSync(worktreePath)) {
        throw new Error(`Worktree path still exists after replacement cleanup: ${worktreePath}`);
      }
    }

    // Once the linked worktree is gone, rename its unmerged branch for
    // preservation. This works on Git versions that cannot rename a branch
    // while it is checked out in another worktree.
    if (branchExists && !branchWasAncestor) {
      preservedBranch = nextPreservedBranchName(cwd, branchName);
      execFileSync(
        'git',
        ['-C', cwd, 'branch', '-m', branchName, preservedBranch],
        { stdio: 'pipe' },
      );
    }

    // Delete only a branch that Git still considers fully merged into HEAD.
    // `-d` closes the probe-to-delete race by refusing a newly advanced ref.
    if (branchExists && branchWasAncestor) {
      execFileSync('git', ['-C', cwd, 'branch', '-d', branchName], { stdio: 'pipe' });
    }

    // Create the worktree on a new branch based on HEAD
    execFileSync('git', ['-C', cwd, 'worktree', 'add', worktreePath, '-b', branchName], { stdio: 'pipe' });

    // Register in persistent registry for orphan tracking
    registerWorktree(cwd, teamName, workerName, worktreePath, branchName);

    const result = { worktreePath, branchName, created: true };
    if (preservedBranch) result.preservedBranch = preservedBranch;
    return result;
  } catch (err) {
    const result = {
      worktreePath: cwd,
      branchName,
      created: false,
      error: err?.message,
    };
    if (preservedBranch) result.preservedBranch = preservedBranch;
    return result;
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
 *   - With the default replacement policy, branches not reachable from HEAD
 *     are renamed with an `-orphan-<timestamp>` suffix instead of deleted.
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
  // Never let fail-safe cleanup turn a failed worktree allocation (whose
  // fallback path is `cwd`) into recursive deletion of the project root. All
  // worktrees created by this module live strictly below .ao/worktrees/.
  const canonical = (value) => {
    try { return realpathSync(value); } catch { return resolve(value); }
  };
  const projectRoot = canonical(cwd);
  const worktreeRoot = canonical(join(projectRoot, WORKTREE_BASE));
  const target = canonical(worktreePath);
  const relativeTarget = relative(worktreeRoot, target);
  const safeTarget = relativeTarget !== ''
    && relativeTarget !== '..'
    && !relativeTarget.startsWith(`..${sep}`)
    && !isAbsolute(relativeTarget);
  if (!safeTarget || target === projectRoot) {
    return { removed: false, error: `Refusing to remove unsafe worktree path: ${target}` };
  }
  try {
    try {
      execFileSync('git', ['-C', cwd, 'worktree', 'remove', worktreePath, '--force'], { stdio: 'pipe' });
    } catch {
      if (existsSync(worktreePath)) {
        try { rmSync(worktreePath, { recursive: true, force: true }); } catch {}
      }
    }
    if (existsSync(worktreePath)) {
      return { removed: false, error: `Worktree path still exists after removal: ${worktreePath}` };
    }

    try {
      execFileSync('git', ['-C', cwd, 'worktree', 'prune'], { stdio: 'pipe' });
    } catch {}

    if (branchName) {
      try {
        execFileSync('git', ['-C', cwd, 'branch', '-D', branchName], { stdio: 'pipe' });
      } catch (deleteError) {
        let branchStillExists = null;
        try {
          execFileSync('git', ['-C', cwd, 'show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], { stdio: 'pipe' });
          branchStillExists = true;
        } catch (probeError) {
          branchStillExists = probeError?.status === 1 ? false : null;
        }
        if (branchStillExists !== false) {
          return {
            removed: false,
            error: deleteError?.message || `Unable to delete worker branch: ${branchName}`,
          };
        }
      }
    }

    unregisterWorktree(cwd, worktreePath);

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
    const slug = managedIdentityName(teamName, 'team');
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
      const slug = managedIdentityName(teamName, 'team');
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
