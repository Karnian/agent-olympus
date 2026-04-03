/**
 * CI Watch — poll GitHub Actions run status for a branch and surface results.
 *
 * All execFileSync calls are wrapped in try/catch. No function ever throws.
 * Async polling uses a setTimeout-based Promise so the event loop remains free.
 */

import { execFileSync } from 'child_process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a command with execFileSync and return trimmed stdout, or null on error.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @returns {string|null}
 */
function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 30_000 }).trim();
  } catch {
    return null;
  }
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
 * Poll GitHub Actions until the latest run on `branch` completes or the cycle
 * limit is reached.
 *
 * @param {{
 *   branch: string,
 *   maxCycles?: number,
 *   pollIntervalMs?: number
 * }} opts
 * @returns {Promise<{
 *   status: 'passed'|'failed'|'timeout'|'skipped',
 *   runId?: string,
 *   conclusion?: string
 * }>}
 */
export async function watchCI({ branch, maxCycles = 60, pollIntervalMs = 10_000 }) {
  try {
    if (maxCycles <= 0) return { status: 'skipped' };

    let cycles = 0;

    while (cycles < maxCycles) {
      const output = run('gh', [
        'run', 'list',
        '--branch', branch,
        '--json', 'databaseId,status,conclusion',
        '--limit', '1',
      ]);

      if (output !== null) {
        let parsed;
        try {
          parsed = JSON.parse(output);
        } catch {
          parsed = null;
        }

        if (Array.isArray(parsed) && parsed.length > 0) {
          const { databaseId, status, conclusion } = parsed[0];
          const runId = String(databaseId);

          if (status === 'completed') {
            return {
              status: conclusion === 'success' ? 'passed' : 'failed',
              runId,
              conclusion,
            };
          }
          // Not yet completed — fall through to sleep and retry
        }
      }

      await sleep(pollIntervalMs);
      cycles++;
    }

    return { status: 'timeout' };
  } catch {
    return { status: 'timeout' };
  }
}

/**
 * Fetch the logs for failed steps of a completed workflow run.
 *
 * @param {string} runId - GitHub Actions run ID (numeric string)
 * @returns {string} Log output, or empty string on any error
 */
export function getFailedLogs(runId) {
  try {
    const output = run('gh', ['run', 'view', runId, '--log-failed']);
    return output ?? '';
  } catch {
    return '';
  }
}
