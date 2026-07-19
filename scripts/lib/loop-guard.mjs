/**
 * Loop Guard — persistent, cooperative termination guard for the Atlas/Athena
 * autonomous orchestration loop.
 *
 * Background
 * ----------
 * The orchestration loop bounds — "max 15 total iterations", "same error 3x =
 * stop", "max 3 review rounds" — historically lived ONLY as prose in
 * skills/atlas/reference.md and agents/atlas.md and were self-enforced by the LLM
 * orchestrator. There was no code-level counter, so the termination guarantee
 * was prompt-dependent (an LLM that miscounts can loop indefinitely). The only
 * real code guard was `registerEscalation()` in stage-escalation.mjs, which
 * gates opt-in Sonnet→Opus re-runs (a different concern).
 *
 * This module yields a deterministic STOP result once consulted, and its
 * counters survive context compaction / fresh-process polling. It is still
 * cooperative at this layer: the code-owned orchestrator runtime is the sole
 * caller, and the Atlas Stop hook blocks premature termination while a run is
 * active.
 *
 *   registerIteration(runId)              → { allowed, count, cap }
 *     Call once per outer orchestration iteration. allowed=false ⇒ the hard
 *     cap (default 15) is reached; the orchestrator MUST stop and escalate.
 *
 *   recordError(runId, errorSignature)    → { repeatCount, shouldEscalate }
 *     Call on every verify/build/test failure. shouldEscalate=true ⇒ the same
 *     error has now occurred `threshold` times (default 3); stop and escalate.
 *
 *   registerReviewRound(runId)            → { allowed, count, cap }
 *     Call once per Phase 5 review round. allowed=false ⇒ the review-round cap
 *     (default 3) is reached.
 *
 *   registerCounter(runId, name, {cap})   → { allowed, count, cap }
 *     Generic primitive for any other bounded sub-loop (e.g. Phase 4 fix
 *     cycles). The named helpers above delegate to it.
 *
 * Read-only queries (do NOT mutate): getIterationCount, getReviewRoundCount,
 * getCounter, getErrorCount, readLoopGuardState.
 *
 * Persistence
 * -----------
 * One JSON file per run: .ao/artifacts/runs/<runId>/loop-guard.json
 *   {
 *     "schemaVersion": 1,
 *     "counters": { "iterations": { count, firstAt, lastAt }, ... },
 *     "errors":   { "<sigKey>":  { count, sample, firstAt, lastAt }, ... }
 *   }
 * Atomic temp+rename write (mode 0600). Lives alongside escalation-log.json /
 * summary.json / events.jsonl — no collisions.
 *
 * Fail-safe contract
 * ------------------
 * Every function catches all errors and returns a safe default — NEVER throws.
 * The polarity is deliberate and DIFFERS from registerEscalation():
 *
 *   - A genuine cap/threshold hit on healthy storage returns the STOP signal
 *     (allowed:false / shouldEscalate:true). This result is deterministic once
 *     the guard is consulted.
 *   - An INTERNAL error (corrupt file, FS glitch) or a missing runId fails
 *     OPEN — allowed:true / shouldEscalate:false plus `degraded:true`. A
 *     tracking glitch must never halt legitimate work mid-run; the LLM prose
 *     bounds remain the backstop in that degraded case. (registerEscalation
 *     fails CLOSED because there `allowed` gates EXTRA spend, so failing toward
 *     "don't escalate" is the conservative choice. Here `allowed` gates
 *     continuing real work, so failing toward "keep working" is conservative.)
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteFileSync } from './fs-atomic.mjs';

const SCHEMA_VERSION = 1;
const LOG_FILE_NAME = 'loop-guard.json';

// Default bounds — mirror the prose limits they replace.
export const DEFAULT_ITERATION_CAP = 15;     // "max 15 total iterations"
export const DEFAULT_REVIEW_ROUND_CAP = 3;    // "max 3 review rounds"
export const DEFAULT_ERROR_THRESHOLD = 3;     // "same error 3x = stop"
const DEFAULT_COUNTER_CAP = 5;                // generic sub-loops (e.g. Phase 4 fix cycles)

const MAX_SIGNATURE_SAMPLE = 200;             // stored diagnostic sample length
const MAX_ERROR_KEYS = 200;                   // bound the errors map (oldest-by-lastAt pruned)

// ───────────────────────────────────────────────────────────────────────────
// Paths + (de)serialization
// ───────────────────────────────────────────────────────────────────────────

function logPath(runId, cwd) {
  return join(cwd, '.ao', 'artifacts', 'runs', runId, LOG_FILE_NAME);
}

function freshLog() {
  return { schemaVersion: SCHEMA_VERSION, counters: {}, errors: {} };
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Read + normalize the loop-guard log. Fail-safe: missing files return a clean
 * fresh log; corrupt files, non-object payloads, and unknown future
 * schemaVersion values return a degraded fresh log (schemaVersion loader rule —
 * never throw, never block).
 *
 * @param {string} path
 * @returns {{ log: { schemaVersion: number, counters: object, errors: object }, degraded: boolean }}
 */
function readLogWithStatus(path) {
  try {
    if (!existsSync(path)) return { log: freshLog(), degraded: false };
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (!isPlainObject(parsed)) return { log: freshLog(), degraded: true };
    // Loader rule: a newer on-disk format we don't understand → safe default.
    if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== SCHEMA_VERSION) {
      try {
        process.stderr.write(
          `[loop-guard] refusing loop-guard.json schemaVersion ${parsed.schemaVersion} ` +
          `(supported: ${SCHEMA_VERSION}) — treating as empty\n`,
        );
      } catch { /* stderr unavailable */ }
      return { log: freshLog(), degraded: true };
    }
    return {
      log: {
        schemaVersion: SCHEMA_VERSION,
        counters: isPlainObject(parsed.counters) ? parsed.counters : {},
        errors: isPlainObject(parsed.errors) ? parsed.errors : {},
      },
      degraded: false,
    };
  } catch {
    return { log: freshLog(), degraded: true };
  }
}

/**
 * Read-only convenience wrapper for callers that do not surface degraded state.
 *
 * @param {string} path
 * @returns {{ schemaVersion: number, counters: object, errors: object }}
 */
function readLog(path) {
  try {
    return readLogWithStatus(path).log;
  } catch {
    return freshLog();
  }
}

/**
 * Atomic write. Returns true on success, false on failure (caller surfaces a
 * `degraded` flag rather than throwing).
 *
 * @param {string} path
 * @param {object} data
 * @returns {boolean}
 */
function writeLog(path, data) {
  try {
    atomicWriteFileSync(path, JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeCap(value, fallback) {
  return (typeof value === 'number' && Number.isFinite(value) && value > 0) ? Math.floor(value) : fallback;
}

// ───────────────────────────────────────────────────────────────────────────
// Named counters (iterations / review rounds / generic)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Register one tick of a named bounded loop and report whether the caller may
 * continue. Increments only while under cap; once `count >= cap` the call is
 * blocked WITHOUT further increment (count stays pinned at cap), mirroring
 * registerEscalation()'s semantics — `cap` successful ticks are allowed, the
 * (cap+1)th is denied.
 *
 * @param {string} runId
 * @param {string} name - counter key (e.g. 'iterations', 'reviewRounds', 'fix-cycles')
 * @param {object} [opts]
 * @param {string} [opts.cwd=process.cwd()]
 * @param {number} [opts.cap=5]
 * @returns {{ allowed: boolean, count: number, cap: number, degraded: boolean }}
 */
export function registerCounter(runId, name, opts = {}) {
  const cap = normalizeCap(opts.cap, DEFAULT_COUNTER_CAP);
  try {
    const cwd = opts.cwd || process.cwd();
    // Missing identity → can't track. Fail OPEN so work is never halted by a
    // wiring gap; flag degraded so callers/telemetry can notice.
    if (!runId || !name) return { allowed: true, count: 0, cap, degraded: true };

    const path = logPath(runId, cwd);
    const { log, degraded: readDegraded } = readLogWithStatus(path);
    const existing = isPlainObject(log.counters[name])
      ? log.counters[name]
      : { count: 0, firstAt: null, lastAt: null };
    const current = typeof existing.count === 'number' ? existing.count : 0;

    if (current >= cap) {
      return { allowed: false, count: current, cap, degraded: readDegraded };
    }

    const ts = nowIso();
    log.counters[name] = {
      count: current + 1,
      firstAt: existing.firstAt || ts,
      lastAt: ts,
    };
    const ok = writeLog(path, log);
    return { allowed: true, count: current + 1, cap, degraded: readDegraded || !ok };
  } catch {
    return { allowed: true, count: 0, cap, degraded: true };
  }
}

/**
 * Register one outer orchestration iteration. allowed=false ⇒ the hard cap
 * (default 15) is reached and the orchestrator MUST stop + escalate.
 *
 * @param {string} runId
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {number} [opts.cap=15]
 * @returns {{ allowed: boolean, count: number, cap: number, degraded: boolean }}
 */
export function registerIteration(runId, opts = {}) {
  return registerCounter(runId, 'iterations', {
    cwd: opts.cwd,
    cap: normalizeCap(opts.cap, DEFAULT_ITERATION_CAP),
  });
}

/**
 * Register one Phase 5 review round. allowed=false ⇒ the review-round cap
 * (default 3) is reached.
 *
 * @param {string} runId
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {number} [opts.cap=3]
 * @returns {{ allowed: boolean, count: number, cap: number, degraded: boolean }}
 */
export function registerReviewRound(runId, opts = {}) {
  return registerCounter(runId, 'reviewRounds', {
    cwd: opts.cwd,
    cap: normalizeCap(opts.cap, DEFAULT_REVIEW_ROUND_CAP),
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Read-only counter queries (never mutate)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Report a named counter's current value without incrementing.
 *
 * @param {string} runId
 * @param {string} name
 * @param {object} [opts]
 * @returns {{ count: number, cap: number }}
 */
export function getCounter(runId, name, opts = {}) {
  const cap = normalizeCap(opts.cap, DEFAULT_COUNTER_CAP);
  try {
    const cwd = opts.cwd || process.cwd();
    if (!runId || !name) return { count: 0, cap };
    const log = readLog(logPath(runId, cwd));
    const entry = log.counters[name];
    return { count: (isPlainObject(entry) && typeof entry.count === 'number') ? entry.count : 0, cap };
  } catch {
    return { count: 0, cap };
  }
}

export function getIterationCount(runId, opts = {}) {
  return getCounter(runId, 'iterations', { cwd: opts.cwd, cap: normalizeCap(opts.cap, DEFAULT_ITERATION_CAP) });
}

export function getReviewRoundCount(runId, opts = {}) {
  return getCounter(runId, 'reviewRounds', { cwd: opts.cwd, cap: normalizeCap(opts.cap, DEFAULT_REVIEW_ROUND_CAP) });
}

// ───────────────────────────────────────────────────────────────────────────
// Error-signature repeat tracking
// ───────────────────────────────────────────────────────────────────────────

/**
 * Normalize a raw error blob into a stable signature so that "the same error"
 * is detected robustly across fix attempts. Volatile bits that shift between
 * retries — line/column numbers, file positions, hex addresses, ISO-8601
 * timestamps, durations, long numeric IDs, ANSI colour codes, whitespace, and
 * case — are stripped or masked. Short standalone numbers are preserved because
 * they often carry semantics (exit/status codes, errno, versions, small counts,
 * test indices). The CALLER should still pass a focused signature (e.g. the
 * first error line or an error code) rather than a whole multi-thousand-line
 * log; this only sands off incidental variation.
 *
 * Idempotent: normalize(normalize(x)) === normalize(x).
 *
 * @param {*} sig
 * @returns {string} normalized signature ('' for non-strings / empty input)
 */
export function normalizeErrorSignature(sig) {
  try {
    if (typeof sig !== 'string') return '';
    let s = sig;
    // Strip ANSI / CSI escape sequences (colour codes, cursor moves).
    s = s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
    // Mask volatile numeric forms only. Placeholders are intentionally
    // digit-free and contain no "0x" so re-normalizing an already-normalized
    // string is a no-op (idempotency the key relies on).
    // "0x1f3a"→"HEXADDR", "app.js:42"→"app.js:POS", "line 42"→"line POS".
    s = s.replace(/\b\d{4}-\d{2}-\d{2}[Tt ][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, 'TIMESTAMP');
    s = s.replace(/\b0x[0-9a-f]+\b/gi, 'HEXADDR');
    s = s.replace(/(\b[^\s:()[\]{}"'`]+?\.[A-Za-z0-9]{1,12}):\d+(?::\d+)?\b/g, '$1:POS');
    s = s.replace(/\b(line|col|column)\s+\d+\b/gi, '$1 POS');
    s = s.replace(/\b\d+(?:\.\d+)?(?:ms|s)\b/gi, 'DURATION');
    s = s.replace(/\b\d{5,}\b/g, 'LONGNUM');
    // Collapse all whitespace (incl. newlines) and normalize case.
    s = s.replace(/\s+/g, ' ').trim().toLowerCase();
    return s;
  } catch {
    return '';
  }
}

/**
 * Stable short key for an error signature (sha256 → first 16 hex chars).
 * Normalizes defensively so callers may pass raw or pre-normalized input.
 *
 * @param {*} sig
 * @returns {string} 16-char hex key, or '' for empty/non-string input
 */
export function errorSignatureKey(sig) {
  return normAndKey(sig).key;
}

function normAndKey(sig) {
  const normalized = normalizeErrorSignature(sig);
  if (!normalized) return { normalized: '', key: '' };
  const key = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return { normalized, key };
}

/**
 * Drop the oldest entries (by lastAt) when the errors map outgrows its cap, so
 * an orchestrator that emits many distinct signatures cannot grow the file
 * without bound. The just-touched entry always has the newest lastAt, so it is
 * never the one pruned.
 *
 * @param {object} errors
 */
function pruneErrors(errors) {
  try {
    const keys = Object.keys(errors);
    if (keys.length <= MAX_ERROR_KEYS) return;
    keys.sort((a, b) => String(errors[a]?.lastAt || '').localeCompare(String(errors[b]?.lastAt || '')));
    const dropCount = keys.length - MAX_ERROR_KEYS;
    for (let i = 0; i < dropCount; i++) delete errors[keys[i]];
  } catch { /* fail-safe */ }
}

/**
 * Record one occurrence of an error and report whether the repeat threshold is
 * reached. ALWAYS increments (it logs an occurrence) — unlike the counters,
 * there is no "block without increment" path. shouldEscalate becomes true on
 * the `threshold`-th (default 3rd) occurrence of the same normalized signature.
 *
 * @param {string} runId
 * @param {*} errorSignature - raw error text or a focused signature
 * @param {object} [opts]
 * @param {string} [opts.cwd=process.cwd()]
 * @param {number} [opts.threshold=3]
 * @returns {{ repeatCount: number, shouldEscalate: boolean, threshold: number, degraded: boolean }}
 */
export function recordError(runId, errorSignature, opts = {}) {
  const threshold = normalizeCap(opts.threshold, DEFAULT_ERROR_THRESHOLD);
  try {
    const cwd = opts.cwd || process.cwd();
    const { normalized, key } = normAndKey(errorSignature);
    // No identity or no extractable signature → can't track. Fail OPEN
    // (shouldEscalate:false) so a blank/garbage signature never forces a stop.
    if (!runId || !key) {
      return { repeatCount: 0, shouldEscalate: false, threshold, degraded: true };
    }

    const path = logPath(runId, cwd);
    const { log, degraded: readDegraded } = readLogWithStatus(path);
    const existing = isPlainObject(log.errors[key]) ? log.errors[key] : null;
    const current = (existing && typeof existing.count === 'number') ? existing.count : 0;
    const ts = nowIso();

    log.errors[key] = {
      count: current + 1,
      sample: (existing && existing.sample) || normalized.slice(0, MAX_SIGNATURE_SAMPLE),
      firstAt: (existing && existing.firstAt) || ts,
      lastAt: ts,
    };
    pruneErrors(log.errors);
    const ok = writeLog(path, log);

    const repeatCount = current + 1;
    return { repeatCount, shouldEscalate: repeatCount >= threshold, threshold, degraded: readDegraded || !ok };
  } catch {
    return { repeatCount: 0, shouldEscalate: false, threshold, degraded: true };
  }
}

/**
 * Report how many times an error signature has been recorded, without
 * incrementing. Use to populate dedup / "already seen" decisions.
 *
 * @param {string} runId
 * @param {*} errorSignature
 * @param {object} [opts]
 * @returns {{ repeatCount: number, threshold: number }}
 */
export function getErrorCount(runId, errorSignature, opts = {}) {
  const threshold = normalizeCap(opts.threshold, DEFAULT_ERROR_THRESHOLD);
  try {
    const cwd = opts.cwd || process.cwd();
    const { key } = normAndKey(errorSignature);
    if (!runId || !key) return { repeatCount: 0, threshold };
    const log = readLog(logPath(runId, cwd));
    const entry = log.errors[key];
    return { repeatCount: (isPlainObject(entry) && typeof entry.count === 'number') ? entry.count : 0, threshold };
  } catch {
    return { repeatCount: 0, threshold };
  }
}

/**
 * Read the full loop-guard state for a run (diagnostics / status display).
 * Read-only; returns a fresh empty log on any error or missing run.
 *
 * @param {string} runId
 * @param {object} [opts]
 * @returns {{ schemaVersion: number, counters: object, errors: object }}
 */
export function readLoopGuardState(runId, opts = {}) {
  try {
    const cwd = opts.cwd || process.cwd();
    if (!runId) return freshLog();
    return readLog(logPath(runId, cwd));
  } catch {
    return freshLog();
  }
}
