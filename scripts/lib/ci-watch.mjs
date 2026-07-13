/**
 * CI Watch — poll GitHub Actions for one pinned repository and commit.
 *
 * All execFileSync calls are wrapped in try/catch. No function ever throws.
 * Async polling uses a setTimeout-based Promise so the event loop remains free.
 */

import { execFileSync as nodeExecFileSync } from 'child_process';
import { isAbsolute } from 'path';

let _execFileSync = nodeExecFileSync;

/** @param {typeof nodeExecFileSync} fn */
export function __setExecFileSyncForTest(fn) {
  _execFileSync = fn;
}

export function __resetForTest() {
  _execFileSync = nodeExecFileSync;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a command with execFileSync and return trimmed stdout, or null on error.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string|null}
 */
function run(cmd, args, cwd) {
  try {
    return _execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: 30_000,
      cwd,
    }).trim();
  } catch {
    return null;
  }
}

/** @param {unknown} value @returns {value is string} */
function isExplicitCwd(value) {
  return typeof value === 'string'
    && value === value.trim()
    && value.length > 0
    && !value.includes('\0')
    && isAbsolute(value);
}

/**
 * Accept only HOST/OWNER/REPO selectors. Requiring the host prevents GH_HOST
 * and GH_REPO from changing which repository a CI operation observes.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
function isPinnedRepository(value) {
  try {
    if (typeof value !== 'string'
      || value !== value.trim()
      || !value
      || /[\s\0]/.test(value)) {
      return false;
    }
    const parts = value.split('/');
    if (parts.length !== 3
      || parts.some(part => !part || part === '.' || part === '..')) {
      return false;
    }
    const [host, owner, repo] = parts;
    if (!/^[A-Za-z0-9.-]+(?::\d+)?$/.test(host)
      || !/^[A-Za-z0-9_.-]+$/.test(owner)
      || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
      return false;
    }
    const parsed = new URL(`https://${value}`);
    return !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash
      && parsed.pathname === `/${owner}/${repo}`;
  } catch {
    return false;
  }
}

/** @param {unknown} value @returns {value is string} */
function isBranch(value) {
  return typeof value === 'string'
    && value === value.trim()
    && value.length > 0
    && !value.startsWith('-')
    && !/[\0-\x20\x7f~^:?*\\[]/.test(value)
    && !value.includes('..')
    && !value.includes('@{')
    && !value.endsWith('.')
    && !value.endsWith('/')
    && !value.startsWith('/');
}

/** @param {unknown} value @returns {value is string} */
function isFullCommitSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** @param {unknown} value @returns {value is string} */
function isRunId(value) {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value);
}

/**
 * Resolve after `ms` milliseconds without blocking.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Poll GitHub Actions until a run for exactly `expectedHeadSha` completes or
 * the cycle limit is reached. Runs from older commits on the same branch are
 * ignored, including previously successful runs.
 *
 * @param {{
 *   cwd: string,
 *   repository: string,
 *   branch: string,
 *   expectedHeadSha: string,
 *   maxCycles?: number,
 *   pollIntervalMs?: number
 * }} opts
 * @returns {Promise<{
 *   status: 'passed'|'failed'|'timeout'|'skipped',
 *   runId?: string,
 *   conclusion?: string
 * }>}
 */
export async function watchCI(opts) {
  try {
    const {
      cwd,
      repository,
      branch,
      expectedHeadSha,
      maxCycles = 60,
      pollIntervalMs = 10_000,
    } = opts ?? {};

    const validInputs = isExplicitCwd(cwd)
      && isPinnedRepository(repository)
      && isBranch(branch)
      && isFullCommitSha(expectedHeadSha)
      && Number.isInteger(maxCycles)
      && maxCycles >= 0
      && Number.isFinite(pollIntervalMs)
      && pollIntervalMs >= 0;
    if (!validInputs) {
      return { status: 'failed', conclusion: 'invalid-input' };
    }
    if (maxCycles === 0) return { status: 'skipped' };

    let cycles = 0;

    while (cycles < maxCycles) {
      const output = run('gh', [
        'run', 'list',
        '--repo', repository,
        '--branch', branch,
        '--commit', expectedHeadSha,
        '--json', 'databaseId,status,conclusion,headSha',
        '--limit', '1000',
      ], cwd);

      if (output !== null) {
        let parsed;
        try {
          parsed = JSON.parse(output);
        } catch {
          parsed = null;
        }

        if (Array.isArray(parsed) && parsed.length > 0) {
          const exactRuns = parsed.filter(run => run?.headSha === expectedHeadSha);
          const normalizedRuns = exactRuns.map(run => {
            const validDatabaseId = (typeof run?.databaseId === 'number'
              && Number.isSafeInteger(run.databaseId)
              && run.databaseId > 0)
              || isRunId(run?.databaseId);
            const validStatus = run?.status === 'completed'
              || run?.status === 'in_progress'
              || run?.status === 'queued'
              || run?.status === 'requested'
              || run?.status === 'waiting'
              || run?.status === 'pending';
            const validConclusion = run?.status !== 'completed'
              || (typeof run?.conclusion === 'string' && run.conclusion.length > 0);
            return validDatabaseId && validStatus && validConclusion
              ? {
                  runId: String(run.databaseId),
                  status: run.status,
                  conclusion: run.conclusion,
                }
              : null;
          });

          // One successful workflow never certifies a commit while another
          // workflow for that SHA is pending, failed, or malformed.
          if (exactRuns.length > 0
            && exactRuns.length < 1000
            && normalizedRuns.every(Boolean)
            && normalizedRuns.every(run => run.status === 'completed')) {
            const failedRun = normalizedRuns.find(run => !['success', 'skipped', 'neutral'].includes(run.conclusion));
            if (failedRun) {
              return {
                status: 'failed',
                runId: failedRun.runId,
                conclusion: failedRun.conclusion,
              };
            }
            const successfulRun = normalizedRuns.find(run => run.conclusion === 'success');
            if (successfulRun) {
              return {
                status: 'passed',
                runId: successfulRun.runId,
                conclusion: 'success',
              };
            }
            return {
              status: 'skipped',
              runId: normalizedRuns[0].runId,
              conclusion: normalizedRuns[0].conclusion,
            };
          }
          // A run for another commit, any pending/malformed run, or a result
          // set at the pagination cap cannot decide the expected commit.
          // Poll again.
        }
      }

      cycles++;
      if (cycles < maxCycles) await sleep(pollIntervalMs);
    }

    return { status: 'timeout' };
  } catch {
    return { status: 'timeout' };
  }
}

/**
 * Fetch the logs for failed steps of a completed workflow run in one pinned
 * repository.
 *
 * @param {{ cwd: string, repository: string, runId: string }} opts
 * @returns {string} Log output, or empty string on invalid input or any error
 */
export function getFailedLogs(opts) {
  try {
    const { cwd, repository, runId } = opts ?? {};
    if (!isExplicitCwd(cwd) || !isPinnedRepository(repository) || !isRunId(runId)) {
      return '';
    }
    const output = run('gh', [
      'run', 'view', runId,
      '--repo', repository,
      '--log-failed',
    ], cwd);
    return output ?? '';
  } catch {
    return '';
  }
}
