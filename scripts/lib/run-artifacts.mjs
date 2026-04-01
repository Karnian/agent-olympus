/**
 * Run Artifacts — structured execution records for Atlas/Athena orchestrations.
 *
 * Each run produces:
 * - events.jsonl — timeline of orchestration events (append-only)
 * - summary.json — final execution metadata (written at completion)
 * - verification.json — per-story verification results
 *
 * Artifacts live at .ao/artifacts/runs/<runId>/
 */

import { mkdirSync, readFileSync, existsSync, appendFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { atomicWriteFileSync } from './fs-atomic.mjs';

const RUNS_BASE = join('.ao', 'artifacts', 'runs');

/**
 * Format a Date as YYYYMMDD.
 * @param {Date} d
 * @returns {string}
 */
function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * Format a Date as HHmmss.
 * @param {Date} d
 * @returns {string}
 */
function formatTime(d) {
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}${min}${s}`;
}

/**
 * Generate a 4-character random hex suffix from a UUID.
 * @returns {string}
 */
function rand4() {
  return randomUUID().replace(/-/g, '').slice(0, 4);
}

/**
 * Resolve the run directory path for a given runId.
 * @param {string} runId
 * @param {string} [base] - Override base directory (for testing)
 * @returns {string}
 */
function runDir(runId, base = RUNS_BASE) {
  return join(base, runId);
}

/**
 * Create a new run artifact directory and write the initial summary.
 *
 * @param {string} orchestrator - 'atlas' | 'athena' or any orchestrator name
 * @param {string} taskDescription - Human-readable description of the task
 * @param {object} [opts]
 * @param {string} [opts.base] - Override base directory (for testing)
 * @returns {{ runId: string, runDir: string }}
 */
export function createRun(orchestrator, taskDescription, opts = {}) {
  try {
    const base = opts.base || RUNS_BASE;
    const now = new Date();
    const runId = `${orchestrator}-${formatDate(now)}-${formatTime(now)}-${rand4()}`;
    const dir = runDir(runId, base);

    mkdirSync(dir, { recursive: true, mode: 0o700 });

    const summary = {
      runId,
      orchestrator,
      task: taskDescription,
      startedAt: now.toISOString(),
      status: 'running',
    };

    atomicWriteFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));

    return { runId, runDir: dir };
  } catch {
    const fallbackId = `${orchestrator || 'unknown'}-fallback-${rand4()}`;
    return { runId: fallbackId, runDir: '' };
  }
}

/**
 * Append a timestamped event to events.jsonl for the given run.
 *
 * @param {string} runId
 * @param {{ phase: string, type: string, detail: * }} event
 * @param {object} [opts]
 * @param {string} [opts.base] - Override base directory (for testing)
 */
export function addEvent(runId, event, opts = {}) {
  try {
    const base = opts.base || RUNS_BASE;
    const dir = runDir(runId, base);
    const line = JSON.stringify({ ...event, timestamp: new Date().toISOString() });
    appendFileSync(join(dir, 'events.jsonl'), line + '\n', { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // fail-safe: event loss is acceptable, never throw
  }
}

/**
 * Append a verification result to verification.json for the given run.
 * Creates the file if it does not exist.
 *
 * @param {string} runId
 * @param {{ story_id: string, verdict: 'pass'|'fail'|'skip', evidence: *, verifiedBy: string, timestamp: string }} result
 * @param {object} [opts]
 * @param {string} [opts.base] - Override base directory (for testing)
 */
export function addVerification(runId, result, opts = {}) {
  try {
    const base = opts.base || RUNS_BASE;
    const dir = runDir(runId, base);
    const filePath = join(dir, 'verification.jsonl');
    const line = JSON.stringify({ ...result, timestamp: result.timestamp || new Date().toISOString() });
    appendFileSync(filePath, line + '\n', { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // fail-safe: verification loss is acceptable, never throw
  }
}

/**
 * Finalize a run by merging summary data and recording finish time/duration.
 *
 * @param {string} runId
 * @param {object} summary - Additional fields to merge (e.g. storiesCompleted, errors)
 * @param {object} [opts]
 * @param {string} [opts.base] - Override base directory (for testing)
 */
export function finalizeRun(runId, summary, opts = {}) {
  try {
    const base = opts.base || RUNS_BASE;
    const dir = runDir(runId, base);
    const filePath = join(dir, 'summary.json');

    let existing = {};
    try {
      existing = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      existing = { runId };
    }

    const finishedAt = new Date().toISOString();
    const startedAt = existing.startedAt;
    const duration_ms = startedAt
      ? new Date(finishedAt).getTime() - new Date(startedAt).getTime()
      : null;

    const updated = {
      ...existing,
      ...summary,
      finishedAt,
      duration_ms,
      status: 'completed',
    };

    atomicWriteFileSync(filePath, JSON.stringify(updated, null, 2));
  } catch {
    // fail-safe: finalization failure is logged but never throws
  }
}

/**
 * List all run directories, optionally filtered by orchestrator.
 *
 * @param {object} [opts]
 * @param {string} [opts.orchestrator] - Filter to only runs from this orchestrator
 * @param {number} [opts.limit] - Maximum number of results to return
 * @param {string} [opts.base] - Override base directory (for testing)
 * @returns {Array<{ runId: string, orchestrator: string, startedAt: string, status: string }>}
 */
export function listRuns(opts = {}) {
  const base = opts.base || RUNS_BASE;
  const { orchestrator, limit } = opts;

  let entries = [];
  try {
    entries = readdirSync(base, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return [];
  }

  const results = [];
  for (const name of entries) {
    const summaryPath = join(base, name, 'summary.json');
    try {
      const s = JSON.parse(readFileSync(summaryPath, 'utf-8'));
      if (orchestrator && s.orchestrator !== orchestrator) continue;
      results.push({
        runId: s.runId,
        orchestrator: s.orchestrator,
        startedAt: s.startedAt,
        status: s.status,
      });
    } catch {
      // skip runs with unreadable summaries
    }
  }

  // Sort by startedAt descending (most recent first) for replay/audit use cases
  results.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  if (limit != null && limit > 0) {
    return results.slice(0, limit);
  }
  return results;
}

/**
 * Read a complete run record: summary, events, and verifications.
 *
 * @param {string} runId
 * @param {object} [opts]
 * @param {string} [opts.base] - Override base directory (for testing)
 * @returns {{ summary: object, events: object[], verifications: object[] }}
 */
export function getRun(runId, opts = {}) {
  const base = opts.base || RUNS_BASE;
  const dir = runDir(runId, base);

  // summary
  let summary = {};
  try {
    summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf-8'));
  } catch {
    summary = {};
  }

  // events (JSONL — one JSON object per line)
  let events = [];
  try {
    const raw = readFileSync(join(dir, 'events.jsonl'), 'utf-8');
    events = raw
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line));
  } catch {
    events = [];
  }

  // verifications (JSONL — one JSON object per line)
  let verifications = [];
  try {
    const raw = readFileSync(join(dir, 'verification.jsonl'), 'utf-8');
    verifications = raw
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    verifications = [];
  }

  return { summary, events, verifications };
}
