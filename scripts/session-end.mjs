#!/usr/bin/env node
/**
 * SessionEnd hook — cleans up stale state files on session termination.
 * Removes .ao/state/ files and .ao/teams/ directories older than 24 hours.
 * Complement to stop-hook.mjs (which handles WIP commits).
 * Never blocks: always exits 0.
 */

import { readStdin } from './lib/stdin.mjs';
import { readdirSync, statSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { finalizeSession, getCurrentSessionId, pruneSessions } from './lib/session-registry.mjs';

const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Remove entries in `dir` whose mtime exceeds STALE_MS.
 * Directories are removed recursively; files are unlinked.
 * Returns count of entries removed.
 *
 * @param {string} dir
 * @param {number} now - current timestamp (ms)
 * @returns {number}
 */
function cleanStaleFiles(dir, now) {
  let cleaned = 0;
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (now - stat.mtimeMs > STALE_MS) {
          if (stat.isDirectory()) {
            rmSync(fullPath, { recursive: true, force: true });
          } else {
            unlinkSync(fullPath);
          }
          cleaned++;
        }
      } catch { /* skip inaccessible entries */ }
    }
  } catch { /* dir doesn't exist or is unreadable — fine */ }
  return cleaned;
}

async function main() {
  try {
    const raw = await readStdin(3000);
    let _data = {};
    try { _data = JSON.parse(raw); } catch { /* non-fatal */ }

    const now = Date.now();
    const stateDir = join(process.cwd(), '.ao', 'state');
    const teamsDir = join(process.cwd(), '.ao', 'teams');

    // Finalize session record — use session_id from stdin or pointer file
    const sessionId = _data.session_id || getCurrentSessionId();
    if (sessionId) {
      finalizeSession(sessionId, { status: 'ended' });
    }

    // Prune old session records (10% chance per run to avoid overhead)
    if (Math.random() < 0.1) {
      pruneSessions();
    }

    const cleanedState = cleanStaleFiles(stateDir, now);
    const cleanedTeams = cleanStaleFiles(teamsDir, now);

    // Include a debug note when cleanup happened (suppressOutput keeps it invisible to the user)
    if (cleanedState > 0 || cleanedTeams > 0) {
      process.stdout.write(JSON.stringify({
        suppressOutput: true,
        _debug: `Cleaned ${cleanedState} stale state files, ${cleanedTeams} stale team dirs`,
      }));
    } else {
      process.stdout.write('{}');
    }
  } catch {
    process.stdout.write('{}');
  }
  process.exit(0);
}

main();
