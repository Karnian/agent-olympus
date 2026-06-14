#!/usr/bin/env node
/**
 * SessionEnd hook — cleans up stale state files on session termination.
 * Removes .ao/state/ files and .ao/teams/ directories older than 24 hours.
 * Complement to stop-hook.mjs (which handles WIP commits).
 * Never blocks: always exits 0.
 */

import { readStdin } from './lib/stdin.mjs';
import { readFileSync, readdirSync, statSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from './lib/fs-atomic.mjs';
import { finalizeSession, getCurrentSessionId, pruneSessions } from './lib/session-registry.mjs';
import { readSnapshot as readSupSnapshot, isHeartbeatFresh as supHeartbeatFresh } from './lib/supervisor-state.mjs';
import { readProcStartId } from './lib/proc-identity.mjs';

const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

// v1.0.2 B-X1 + AC-X2 fix: Names under .ao/state/ or .ao/teams/ that must
// NEVER be swept, even if stale. These are durable memory / telemetry files
// that live outside .ao/state/ in v1.0.2+ (.ao/memory/) but we also keep an
// explicit allow-list here as belt-and-suspenders in case future features
// drop files into .ao/state/ with durable intent.
//
// Durable memory (v1.0.2+) lives under .ao/memory/ which is a SEPARATE
// directory NOT scanned by cleanStaleFiles; see resolveMemoryDir() in
// scripts/lib/memory.mjs. The allow-list below guards against regressions
// where a future hook writes into .ao/state/ by accident.
const PROTECTED_NAMES = new Set([
  // Never delete durable memory filenames even if found in .ao/state/
  'design-identity.json',
  'taste.jsonl',
  'tthw-history.jsonl',       // reserved for v1.0.3
  // Wisdom lives at .ao/wisdom.jsonl (outside .ao/state/) but guard the name
  // in case anyone ever writes a legacy copy under .ao/state/.
  'wisdom.jsonl',
]);

/**
 * Remove entries in `dir` whose mtime exceeds STALE_MS.
 * Directories are removed recursively; files are unlinked.
 * Returns count of entries removed.
 *
 * @param {string} dir
 * @param {number} now - current timestamp (ms)
 * @returns {number}
 */
/**
 * True if a supervisor run dir holds a still-ACTIVE worker — a `running`
 * snapshot with a fresh heartbeat, or whose supervisorPid is still alive. Such a
 * run must NOT be swept mid-flight (F1).
 */
function isSupervisorRunActive(runDir, now) {
  try {
    for (const f of readdirSync(runDir)) {
      if (!f.endsWith('.snapshot.json')) continue;
      const r = readSupSnapshot(join(runDir, f));
      if (r.kind !== 'ok' || r.snapshot.status !== 'running') continue;
      if (supHeartbeatFresh(r.snapshot, now)) return true;
      const pid = r.snapshot.supervisorPid;
      if (Number.isInteger(pid) && pid > 1) {
        // Verify IDENTITY so a reused PID can't keep a dead run alive forever:
        // if we recorded a startId and can read the live one, they must match.
        const recorded = r.snapshot.supervisorStartId;
        if (recorded) {
          const cur = readProcStartId(pid);
          if (cur !== null) { if (cur === recorded) return true; continue; }
        }
        try { process.kill(pid, 0); return true; }
        catch (e) { if (e && e.code === 'EPERM') return true; }
      }
    }
  } catch { /* unreadable → not provably active */ }
  return false;
}

function cleanStaleFiles(dir, now) {
  let cleaned = 0;
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      // v1.0.2 B-X1: protect durable-memory filenames even if they somehow
      // end up in .ao/state/ (defensive; primary storage is .ao/memory/).
      if (PROTECTED_NAMES.has(entry)) continue;
      const fullPath = join(dir, entry);
      // F1: the supervisor tree is run-scoped — NEVER wholesale-delete it by its
      // own mtime. Sweep per-run, skipping runs that are still active.
      if (entry === 'supervisor') {
        try {
          if (statSync(fullPath).isDirectory()) {
            for (const runId of readdirSync(fullPath)) {
              const runDir = join(fullPath, runId);
              try {
                const rstat = statSync(runDir);
                if (!rstat.isDirectory()) continue;
                if (isSupervisorRunActive(runDir, now)) continue;
                if (now - rstat.mtimeMs > STALE_MS) { rmSync(runDir, { recursive: true, force: true }); cleaned++; }
              } catch { /* skip */ }
            }
            continue;
          }
        } catch { /* fall through to default handling */ }
      }
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

    // Prune old session records every 10th invocation (deterministic)
    const counterFile = join(stateDir, 'ao-session-end-counter.json');
    let counter = 0;
    try {
      counter = JSON.parse(readFileSync(counterFile, 'utf-8')).count || 0;
    } catch { /* first run or corrupt — start at 0 */ }
    counter++;
    try { atomicWriteFileSync(counterFile, JSON.stringify({ count: counter })); } catch {}
    if (counter % 10 === 0) {
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
