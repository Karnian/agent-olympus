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

import { mkdirSync, readFileSync, existsSync, appendFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { getCurrentSessionId, linkRunToSession } from './session-registry.mjs';

const RUNS_BASE = join('.ao', 'artifacts', 'runs');
const STATE_DIR = join('.ao', 'state');

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

// ---------------------------------------------------------------------------
// Active Run Identity (US-001)
// ---------------------------------------------------------------------------

/**
 * Resolve the active-run file path for an orchestrator.
 * @param {string} orchestrator
 * @param {string} [stateDir]
 * @returns {string}
 */
function activeRunPath(orchestrator, stateDir = STATE_DIR) {
  return join(stateDir, `ao-active-run-${orchestrator}.json`);
}

/**
 * Get the active runId for an orchestrator.
 * Returns null if no active run exists. Never throws.
 *
 * @param {string} orchestrator - 'atlas' | 'athena'
 * @param {object} [opts]
 * @param {string} [opts.stateDir] - Override state directory (for testing)
 * @returns {string|null}
 */
export function getActiveRunId(orchestrator, opts = {}) {
  try {
    const sd = opts.stateDir || STATE_DIR;
    const raw = readFileSync(activeRunPath(orchestrator, sd), 'utf-8');
    const data = JSON.parse(raw);
    return data.runId || null;
  } catch {
    return null;
  }
}

/**
 * Set the active runId for an orchestrator.
 * Used by createRun internally and available for testing/recovery.
 *
 * @param {string} orchestrator
 * @param {string} runId
 * @param {object} [opts]
 * @param {string} [opts.stateDir] - Override state directory (for testing)
 */
export function setActiveRunId(orchestrator, runId, opts = {}) {
  try {
    const sd = opts.stateDir || STATE_DIR;
    mkdirSync(sd, { recursive: true, mode: 0o700 });
    const data = { runId, orchestrator, startedAt: new Date().toISOString() };
    atomicWriteFileSync(activeRunPath(orchestrator, sd), JSON.stringify(data, null, 2));
  } catch {
    // fail-safe: never throw
  }
}

/**
 * Clear the active run pointer for an orchestrator.
 * Only deletes if the current pointer matches the given runId (compare-and-delete).
 *
 * @param {string} orchestrator
 * @param {string} runId - Only clear if this matches the active runId
 * @param {object} [opts]
 * @param {string} [opts.stateDir] - Override state directory (for testing)
 */
function clearActiveRunId(orchestrator, runId, opts = {}) {
  try {
    const sd = opts.stateDir || STATE_DIR;
    const filePath = activeRunPath(orchestrator, sd);
    const raw = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    if (data.runId === runId) {
      unlinkSync(filePath);
    }
  } catch {
    // fail-safe: file may not exist
  }
}

/**
 * Discover which orchestrator has an active run.
 * Checks both atlas and athena; if both exist, returns the most recent.
 * Returns { orchestrator, runId } or null.
 *
 * @param {object} [opts]
 * @param {string} [opts.stateDir] - Override state directory (for testing)
 * @returns {{ orchestrator: string, runId: string }|null}
 */
export function discoverActiveRun(opts = {}) {
  try {
    const sd = opts.stateDir || STATE_DIR;
    const candidates = [];
    for (const orch of ['atlas', 'athena']) {
      try {
        const raw = readFileSync(activeRunPath(orch, sd), 'utf-8');
        const data = JSON.parse(raw);
        if (data.runId) {
          candidates.push({ orchestrator: orch, runId: data.runId, startedAt: data.startedAt || '' });
        }
      } catch {
        // not active for this orchestrator
      }
    }
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return { orchestrator: candidates[0].orchestrator, runId: candidates[0].runId };
    // Both active — pick the most recent
    candidates.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return { orchestrator: candidates[0].orchestrator, runId: candidates[0].runId };
  } catch {
    return null;
  }
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

    // Link to current Claude Code session if available
    const sessionId = getCurrentSessionId({ stateBase: opts.stateDir || STATE_DIR });

    const summary = {
      runId,
      orchestrator,
      task: taskDescription,
      startedAt: now.toISOString(),
      status: 'running',
      ...(sessionId ? { sessionId } : {}),
    };

    atomicWriteFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));

    // Write active-run pointer (US-001)
    setActiveRunId(orchestrator, runId, { stateDir: opts.stateDir || STATE_DIR });

    // Link run to session record (cross-reference)
    if (sessionId) {
      try { linkRunToSession(runId, { stateBase: opts.stateDir || STATE_DIR }); } catch {}
    }

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

    // Emit verification_result event with full payload (US-006)
    const activeRunId = getActiveRunId(result.orchestrator || opts.orchestrator || '', { stateDir: opts.stateDir || STATE_DIR });
    if (activeRunId && activeRunId === runId) {
      const criteria = result.criteria || [];
      const failCount = criteria.filter(c => c.verdict === 'fail').length;
      addEvent(runId, {
        type: 'verification_result',
        detail: {
          story_id: result.story_id,
          verdict: result.verdict,
          verifiedBy: result.verifiedBy,
          criteria: criteria.length > 0 ? criteria : undefined,
          criteriaCount: criteria.length,
          failCount,
        },
      }, { base });
    }
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

    // Emit run_finalized event (US-001)
    addEvent(runId, {
      type: 'run_finalized',
      detail: {
        status: 'completed',
        storiesCompleted: summary.storiesCompleted || null,
        duration_ms,
      },
    }, { base });

    // Clear active-run pointer with compare-and-delete (US-001 + Codex fix #6)
    const orchestrator = existing.orchestrator;
    if (orchestrator) {
      clearActiveRunId(orchestrator, runId, { stateDir: opts.stateDir || STATE_DIR });
    }
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

// ---------------------------------------------------------------------------
// US-004: Replay Events to Reconstruct Checkpoint
// ---------------------------------------------------------------------------

/**
 * Read events from a run's events.jsonl.
 * @param {string} runId
 * @param {object} [opts]
 * @param {string} [opts.base]
 * @returns {object[]}
 */
function readEvents(runId, opts = {}) {
  const base = opts.base || RUNS_BASE;
  const dir = runDir(runId, base);
  try {
    const raw = readFileSync(join(dir, 'events.jsonl'), 'utf-8');
    return raw
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Reconstruct checkpoint state from the event log.
 * Iterates events in order; checkpoint_saved events overwrite accumulated state;
 * verification_result events append to a verifications array.
 *
 * @param {string} runId
 * @param {object} [opts]
 * @param {string} [opts.base] - Override base directory (for testing)
 * @returns {object|null} Reconstructed checkpoint state, or null if no checkpoint_saved events
 */
export function replayEvents(runId, opts = {}) {
  try {
    const events = readEvents(runId, opts);
    if (events.length === 0) return null;

    let state = null;
    const verifications = [];

    for (const event of events) {
      if (event.type === 'checkpoint_saved' && event.detail) {
        state = { ...event.detail };
      } else if (event.type === 'verification_result' && event.detail) {
        verifications.push(event.detail);
      }
    }

    if (state === null) return null;

    if (verifications.length > 0) {
      state.verifications = verifications;
    }

    return state;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// US-006 + US-007: Criterion-Level Verification + Story Rollup
// ---------------------------------------------------------------------------

/**
 * Get verification results for a specific story, including criterion-level detail.
 * If multiple verification records exist for the same story, the last one wins.
 *
 * @param {string} runId
 * @param {string} storyId
 * @param {object} [opts]
 * @param {string} [opts.base] - Override base directory (for testing)
 * @returns {{ story_id: string, verdict: string, criteria: object[] }|null}
 */
export function verifyStory(runId, storyId, opts = {}) {
  try {
    const { verifications } = getRun(runId, opts);
    const matches = verifications.filter(v => v.story_id === storyId);
    if (matches.length === 0) return null;

    // Last record wins
    const latest = matches[matches.length - 1];
    const criteria = latest.criteria || [];

    // Compute aggregate verdict from criteria if present
    let verdict = latest.verdict;
    if (criteria.length > 0) {
      const hasFail = criteria.some(c => c.verdict === 'fail');
      const hasSkip = criteria.some(c => c.verdict === 'skip');
      if (hasFail) verdict = 'fail';
      else if (hasSkip) verdict = 'skip';
      else verdict = 'pass';
    }

    return { story_id: storyId, verdict, criteria };
  } catch {
    return null;
  }
}

/**
 * Get a summary of all story verifications for a run.
 *
 * @param {string} runId
 * @param {object} [opts]
 * @param {string} [opts.base] - Override base directory (for testing)
 * @returns {{ total: number, passed: number, failed: number, skipped: number, stories: object }}
 */
export function getRunVerificationSummary(runId, opts = {}) {
  try {
    const { verifications } = getRun(runId, opts);

    // Deduplicate: last record per story_id wins
    const byStory = new Map();
    for (const v of verifications) {
      if (v.story_id) {
        byStory.set(v.story_id, v);
      }
    }

    let passed = 0, failed = 0, skipped = 0;
    const stories = {};

    for (const [sid, v] of byStory) {
      const criteria = v.criteria || [];
      let verdict = v.verdict;
      if (criteria.length > 0) {
        const hasFail = criteria.some(c => c.verdict === 'fail');
        const hasSkip = criteria.some(c => c.verdict === 'skip');
        if (hasFail) verdict = 'fail';
        else if (hasSkip) verdict = 'skip';
        else verdict = 'pass';
      }

      stories[sid] = { verdict, criteria, verifiedBy: v.verifiedBy };
      if (verdict === 'pass') passed++;
      else if (verdict === 'fail') failed++;
      else skipped++;
    }

    return { total: byStory.size, passed, failed, skipped, stories };
  } catch {
    return { total: 0, passed: 0, failed: 0, skipped: 0, stories: {} };
  }
}

// ---------------------------------------------------------------------------
// US-008: Completion Notices
// ---------------------------------------------------------------------------

/**
 * Scan a finalized run for unresolved gaps and return actionable notices.
 * Returns string[] where each entry is prefixed with `[notice] <type>: `.
 * Never throws; returns [] on any error.
 *
 * @param {string} runId
 * @param {object} [opts]
 * @param {string} [opts.base] - Override base directory (for testing)
 * @returns {string[]}
 */
export function generateCompletionNotices(runId, opts = {}) {
  try {
    const { events, verifications } = getRun(runId, opts);
    const notices = [];

    // Deduplicate verifications: last per story_id
    const byStory = new Map();
    for (const v of verifications) {
      if (v.story_id) byStory.set(v.story_id, v);
    }

    for (const [sid, v] of byStory) {
      const allCriteria = v.criteria || [];

      // Story-level checks
      const evidence = (v.evidence || '').toLowerCase();

      if (v.verdict === 'skip' || v.verdict === 'fail') {
        if (evidence.includes('codex')) {
          notices.push(`[notice] codex_unavailable: ${sid} verification skipped — codex was not available for cross-validation`);
        }
        if (evidence.includes('test')) {
          notices.push(`[notice] tests_skipped: ${sid} verification skipped — tests were not executed`);
        }
        if (evidence.includes('preview') || evidence.includes('visual')) {
          notices.push(`[notice] preview_skipped: ${sid} verification skipped — visual preview was not checked`);
        }
        if (evidence.includes('manual') || evidence.includes('review')) {
          notices.push(`[notice] manual_review_needed: ${sid} requires manual review`);
        }
      }

      // Criterion-level checks
      for (const c of allCriteria) {
        if (c.verdict !== 'skip') continue;
        const cEvidence = (c.evidence || '').toLowerCase();
        if (cEvidence.includes('manual') || cEvidence.includes('review')) {
          notices.push(`[notice] manual_review_needed: ${sid} criterion ${c.criterion_index} requires manual review`);
        }
        if (cEvidence.includes('codex')) {
          notices.push(`[notice] codex_unavailable: ${sid} criterion ${c.criterion_index} skipped — codex unavailable`);
        }
        if (cEvidence.includes('preview') || cEvidence.includes('visual')) {
          notices.push(`[notice] preview_skipped: ${sid} criterion ${c.criterion_index} skipped — visual preview not checked`);
        }
        if (cEvidence.includes('test')) {
          notices.push(`[notice] tests_skipped: ${sid} criterion ${c.criterion_index} skipped — tests not executed`);
        }
      }
    }

    // Event-level checks
    for (const ev of events) {
      if (ev.type === 'warning') {
        const msg = ev.detail?.message || 'unknown warning';
        notices.push(`[notice] unresolved_warnings: ${msg}`);
      }
      if (ev.type === 'worker_failed') {
        const name = ev.detail?.workerName || 'unknown';
        const phase = ev.detail?.storyId || 'unknown phase';
        notices.push(`[notice] worker_failed: ${name} failed during ${phase}`);
      }
    }

    return notices;
  } catch {
    return [];
  }
}
