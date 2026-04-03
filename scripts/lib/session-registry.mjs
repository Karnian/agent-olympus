/**
 * Session Registry — lightweight cross-session tracking for Agent Olympus.
 *
 * Records which Claude Code sessions ran in this project, what branch they
 * were on, and whether they are still resumable. Data lives at the project
 * root (not worktree-local) so all worktrees share the same registry.
 *
 * Storage: .ao/sessions/<sessionId>.json  (one file per session)
 * Pointer: .ao/state/ao-current-session.json (active session marker)
 *
 * All functions are fail-safe — they never throw. They return empty defaults
 * on any error, following the same pattern as run-artifacts.mjs.
 */

import { readFileSync, readdirSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { atomicWriteFileSync } from './fs-atomic.mjs';

const SESSIONS_DIR = join('.ao', 'sessions');
const STATE_DIR = join('.ao', 'state');
const CURRENT_SESSION_FILE = join(STATE_DIR, 'ao-current-session.json');
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the project root — walks up from cwd to find the real .git directory
 * (not a worktree .git file). Falls back to cwd.
 * @returns {string}
 */
function resolveProjectRoot() {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // commonDir is e.g. /project/.git → parent is project root
    return dirname(commonDir);
  } catch {
    return process.cwd();
  }
}

/**
 * Get the current git branch name.
 * @returns {string|null}
 */
function getCurrentBranch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get the current HEAD commit SHA (short).
 * @returns {string|null}
 */
function getHeadSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve sessions directory path, optionally overridden for testing.
 * @param {string} [base] - Override base directory
 * @returns {string}
 */
function sessionsDir(base) {
  if (base) return join(base, 'sessions');
  return join(resolveProjectRoot(), SESSIONS_DIR);
}

/**
 * Resolve current-session pointer path, optionally overridden for testing.
 * @param {string} [stateBase] - Override state directory
 * @returns {string}
 */
function currentSessionPath(stateBase) {
  if (stateBase) return join(stateBase, 'ao-current-session.json');
  return join(resolveProjectRoot(), CURRENT_SESSION_FILE);
}

// ---------------------------------------------------------------------------
// Register / Finalize
// ---------------------------------------------------------------------------

/**
 * Register a new session at session start. Writes the session record and
 * sets the current-session pointer.
 *
 * @param {string} sessionId - Claude Code session ID from hook stdin
 * @param {object} data
 * @param {string} [data.cwd] - Working directory
 * @param {string} [data.transcriptPath] - Path to session transcript
 * @param {string} [data.base] - Override sessions directory (testing)
 * @param {string} [data.stateBase] - Override state directory (testing)
 */
export function registerSession(sessionId, data = {}) {
  try {
    if (!sessionId) return;

    const record = {
      sessionId,
      startedAt: new Date().toISOString(),
      endedAt: null,
      branch: getCurrentBranch(),
      cwd: data.cwd || process.cwd(),
      transcriptPath: data.transcriptPath || null,
      status: 'active',
      runIds: [],
      headSha: getHeadSha(),
    };

    const dir = sessionsDir(data.base);
    atomicWriteFileSync(join(dir, `${sessionId}.json`), JSON.stringify(record, null, 2));

    // Set current-session pointer
    const pointer = { sessionId, startedAt: record.startedAt };
    atomicWriteFileSync(currentSessionPath(data.stateBase), JSON.stringify(pointer));
  } catch {
    // fail-safe
  }
}

/**
 * Finalize a session at session end. Updates status and endedAt.
 *
 * @param {string} sessionId
 * @param {object} [data]
 * @param {string} [data.status] - 'ended' | 'crashed'
 * @param {string} [data.base] - Override sessions directory (testing)
 * @param {string} [data.stateBase] - Override state directory (testing)
 */
export function finalizeSession(sessionId, data = {}) {
  try {
    if (!sessionId) return;

    const dir = sessionsDir(data.base);
    const filePath = join(dir, `${sessionId}.json`);

    let record;
    try {
      record = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      // Session file missing — create a minimal record
      record = { sessionId, startedAt: null, runIds: [] };
    }

    record.endedAt = new Date().toISOString();
    record.status = data.status || 'ended';
    record.headSha = getHeadSha();

    atomicWriteFileSync(filePath, JSON.stringify(record, null, 2));

    // Clear current-session pointer
    try { unlinkSync(currentSessionPath(data.stateBase)); } catch {}
  } catch {
    // fail-safe
  }
}

/**
 * Recover from a crash: if the current-session pointer still exists at
 * the next SessionStart, mark the previous session as 'crashed'.
 *
 * @param {object} [opts]
 * @param {string} [opts.base] - Override sessions directory (testing)
 * @param {string} [opts.stateBase] - Override state directory (testing)
 * @returns {string|null} The crashed session ID, or null
 */
export function recoverCrashedSession(opts = {}) {
  try {
    const pointerPath = currentSessionPath(opts.stateBase);
    if (!existsSync(pointerPath)) return null;

    const pointer = JSON.parse(readFileSync(pointerPath, 'utf-8'));
    if (!pointer.sessionId) {
      try { unlinkSync(pointerPath); } catch {}
      return null;
    }

    // If the old session is still alive in Claude Code, don't mark it crashed —
    // this can happen with concurrent sessions in the same project.
    if (isSessionAlive(pointer.sessionId)) {
      // Clear the pointer so we don't keep checking, but don't finalize
      try { unlinkSync(pointerPath); } catch {}
      return null;
    }

    // Mark the old session as crashed
    finalizeSession(pointer.sessionId, { status: 'crashed', base: opts.base, stateBase: opts.stateBase });
    return pointer.sessionId;
  } catch {
    // Clean up broken pointer
    try { unlinkSync(currentSessionPath(opts.stateBase)); } catch {}
    return null;
  }
}

// ---------------------------------------------------------------------------
// Link a run to the current session
// ---------------------------------------------------------------------------

/**
 * Add a run ID to the current session's record.
 *
 * @param {string} runId
 * @param {object} [opts]
 * @param {string} [opts.base] - Override sessions directory (testing)
 * @param {string} [opts.stateBase] - Override state directory (testing)
 */
export function linkRunToSession(runId, opts = {}) {
  try {
    const pointerPath = currentSessionPath(opts.stateBase);
    if (!existsSync(pointerPath)) return;

    const pointer = JSON.parse(readFileSync(pointerPath, 'utf-8'));
    if (!pointer.sessionId) return;

    const dir = sessionsDir(opts.base);
    const filePath = join(dir, `${pointer.sessionId}.json`);

    let record;
    try {
      record = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch { return; }

    if (!Array.isArray(record.runIds)) record.runIds = [];
    if (!record.runIds.includes(runId)) {
      record.runIds.push(runId);
      atomicWriteFileSync(filePath, JSON.stringify(record, null, 2));
    }
  } catch {
    // fail-safe
  }
}

/**
 * Get the current session ID from the pointer file.
 *
 * @param {object} [opts]
 * @param {string} [opts.stateBase] - Override state directory (testing)
 * @returns {string|null}
 */
export function getCurrentSessionId(opts = {}) {
  try {
    const pointerPath = currentSessionPath(opts.stateBase);
    const pointer = JSON.parse(readFileSync(pointerPath, 'utf-8'));
    return pointer.sessionId || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * List all recorded sessions, newest first.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit] - Max results (default 20)
 * @param {string} [opts.branch] - Filter by branch name
 * @param {string} [opts.status] - Filter by status
 * @param {string} [opts.base] - Override sessions directory (testing)
 * @returns {Array<object>}
 */
export function listSessions(opts = {}) {
  try {
    const dir = sessionsDir(opts.base);
    if (!existsSync(dir)) return [];

    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    let records = [];

    for (const file of files) {
      try {
        const record = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
        records.push(record);
      } catch { /* skip corrupt files */ }
    }

    // Apply filters
    if (opts.branch) {
      records = records.filter(r => r.branch && r.branch.includes(opts.branch));
    }
    if (opts.status) {
      records = records.filter(r => r.status === opts.status);
    }

    // Sort by startedAt descending (newest first)
    records.sort((a, b) => {
      const ta = a.startedAt ? new Date(a.startedAt).getTime() : 0;
      const tb = b.startedAt ? new Date(b.startedAt).getTime() : 0;
      return tb - ta;
    });

    const limit = opts.limit || 20;
    return records.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Get a single session record by ID.
 *
 * @param {string} sessionId
 * @param {object} [opts]
 * @param {string} [opts.base] - Override sessions directory (testing)
 * @returns {object|null}
 */
export function getSession(sessionId, opts = {}) {
  try {
    if (!sessionId) return null;
    const dir = sessionsDir(opts.base);
    const filePath = join(dir, `${sessionId}.json`);
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Check if a session is still alive (resumable) by checking if Claude Code
 * still has the session in its sessions directory.
 *
 * @param {string} sessionId
 * @returns {boolean}
 */
export function isSessionAlive(sessionId) {
  try {
    if (!sessionId) return false;
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const sessionsGlob = join(home, '.claude', 'sessions');
    if (!existsSync(sessionsGlob)) return false;

    // Claude stores sessions as <pid>.json with sessionId inside
    const files = readdirSync(sessionsGlob).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(sessionsGlob, file), 'utf-8'));
        if (data.sessionId === sessionId) return true;
      } catch { /* skip */ }
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/**
 * Remove session records older than maxAgeDays.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxAgeDays] - Default 90
 * @param {string} [opts.base] - Override sessions directory (testing)
 * @returns {number} Count of pruned sessions
 */
export function pruneSessions(opts = {}) {
  try {
    const maxAge = (opts.maxAgeDays || 90) * 24 * 60 * 60 * 1000;
    const dir = sessionsDir(opts.base);
    if (!existsSync(dir)) return 0;

    const now = Date.now();
    let pruned = 0;

    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const filePath = join(dir, file);
        const record = JSON.parse(readFileSync(filePath, 'utf-8'));
        // Never prune active sessions
        if (record.status === 'active') continue;
        const startedAt = record.startedAt ? new Date(record.startedAt).getTime() : 0;
        if (startedAt > 0 && (now - startedAt) > maxAge) {
          unlinkSync(filePath);
          pruned++;
        }
      } catch { /* skip */ }
    }
    return pruned;
  } catch {
    return 0;
  }
}
