/**
 * supervisor-state.mjs — run-scoped paths + atomic snapshot I/O for the adapter
 * worker supervisor (F1). The supervisor process WRITES snapshots/output here;
 * a later fresh orchestrator process READS them to learn a worker's terminal
 * state without the (stripped, in-memory) live handle.
 *
 * Design constraints (from the Codex plan reviews):
 *  - Paths are DERIVED from validated hex run IDs + an ABSOLUTE projectRoot —
 *    NEVER taken from the (untrusted, same-UID-writable) manifest. Hex-only ID
 *    validation is the path-containment guard (no `/` or `..` can appear); an
 *    absolute root is required so a detached supervisor with a different cwd
 *    can't misresolve.
 *  - Snapshots live under `.ao/state/` (transient, heartbeat-refreshed); durable
 *    terminal OUTPUT lives under `.ao/artifacts/team/` (survives for collect).
 *  - `readSnapshot` returns a 5-way result and fully validates the snapshot
 *    CONTRACT (identity + liveness + status fields), so a starting supervisor
 *    (missing) is never confused with a real failure (corrupt), a stale other-run
 *    file is rejected (mismatch), and a shape-incomplete file can't satisfy the
 *    stale-generation / PID-reuse guarantees.
 *
 * Zero npm deps; Node built-ins only.
 */

import { readFileSync } from 'fs';
import { join, isAbsolute } from 'path';
import { atomicWriteFileSync } from './fs-atomic.mjs';

export const SUPERVISOR_SCHEMA_VERSION = 1;

/** Heartbeat cadence the supervisor writes while a worker is running (ms). */
export const HEARTBEAT_INTERVAL_MS = 10_000;
/**
 * A `running` snapshot whose `updatedAt` is older than this is suspect — the
 * monitor should confirm across two polls (and check supervisor liveness)
 * before declaring a crash. Distinct from the 5-min output STALL_THRESHOLD_MS
 * in worker-spawn (that detects worker inactivity, not supervisor health).
 */
export const HEARTBEAT_STALE_MS = 90_000;
/** Grace for the supervisor to write its FIRST snapshot before "missing" = crash. */
export const STARTUP_GRACE_MS = 10_000;
/** Tolerance for a writer clock ahead of the reader before a heartbeat is suspect. */
export const FUTURE_SKEW_MS = 60_000;
/** Hard cap on the inline output tail persisted in a snapshot (full output → artifact). */
export const MAX_OUTPUT_TAIL_BYTES = 2048;

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const ALL_STATUSES = new Set(['running', ...TERMINAL_STATUSES]);

// The ONLY fields persisted in a snapshot. writeSnapshot whitelists to these so
// P2 can't accidentally leak the prompt, full output, or path capabilities.
const SNAPSHOT_FIELDS = [
  'runId', 'workerRunId', 'teamName', 'workerName', 'adapterName',
  'status', 'startedAt', 'completedAt',
  'supervisorPid', 'supervisorStartId', 'adapterPid', 'adapterStartId',
  'error', 'outputTail', 'outputBytes', 'workerMeta',
];

/** Caps for the adapter-provided `workerMeta` bag (flat scalars only). */
const WORKER_META_MAX_KEYS = 16;
const WORKER_META_MAX_KEY_LENGTH = 40;
const WORKER_META_MAX_STRING = 120;
const WORKER_META_RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainWorkerMetaBag(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const proto = Object.getPrototypeOf(meta);
  return proto === Object.prototype || proto === null;
}

function isValidWorkerMetaKey(key) {
  return key.length > 0 &&
    key.length <= WORKER_META_MAX_KEY_LENGTH &&
    !WORKER_META_RESERVED_KEYS.has(key);
}

function isWorkerMetaScalar(value) {
  return typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    typeof value === 'boolean' ||
    value === null;
}

function isValidWorkerMetaValue(value) {
  return isWorkerMetaScalar(value) &&
    (typeof value !== 'string' || value.length <= WORKER_META_MAX_STRING);
}

function isValidWorkerMetaBag(meta) {
  if (!isPlainWorkerMetaBag(meta)) return false;
  const entries = Object.entries(meta);
  if (entries.length > WORKER_META_MAX_KEYS) return false;
  return entries.every(([key, value]) => isValidWorkerMetaKey(key) && isValidWorkerMetaValue(value));
}

/**
 * Sanitize an adapter-provided `workerMeta` object for snapshot persistence.
 * Keeps the SNAPSHOT_FIELDS whitelist promise: only a FLAT bag of small
 * scalars survives (no nested objects/arrays, no long strings), so a
 * misbehaving adapter cannot leak the prompt or path capabilities through
 * metadata. Returns undefined when the input is not a plain object or when
 * nothing safe remains.
 * @param {unknown} meta
 * @returns {Record<string, string|number|boolean|null>|undefined}
 */
export function sanitizeWorkerMeta(meta) {
  if (!isPlainWorkerMetaBag(meta)) return undefined;
  const out = Object.create(null);
  let kept = 0;
  for (const [k, v] of Object.entries(meta)) {
    if (kept >= WORKER_META_MAX_KEYS) break;
    if (!isValidWorkerMetaKey(k)) continue;
    if (!isWorkerMetaScalar(v)) continue;
    if (typeof v === 'string') {
      out[k] = v.length > WORKER_META_MAX_STRING ? v.slice(0, WORKER_META_MAX_STRING) : v;
    } else {
      out[k] = v;
    }
    kept += 1;
  }
  return kept > 0 && isValidWorkerMetaBag(out) ? out : undefined;
}

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

/**
 * A run / worker-run identifier (`randomBytes(N).toString('hex')`): hex-only, so
 * safe to interpolate into a path (no separators, no `..`). 8–64 hex chars.
 */
export function isValidId(id) {
  return typeof id === 'string' && /^[0-9a-f]{8,64}$/.test(id);
}

/** A real epoch-ms timestamp: nonnegative safe integer (rejects Infinity/NaN/neg/fraction). */
export function isValidTimestamp(t) {
  return Number.isSafeInteger(t) && t >= 0;
}

function requireId(id, label) {
  if (!isValidId(id)) throw new Error(`invalid ${label}: ${JSON.stringify(id)}`);
  return id;
}

function requireAbsoluteRoot(projectRoot) {
  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot)) {
    throw new Error(`projectRoot must be an absolute path: ${JSON.stringify(projectRoot)}`);
  }
  return projectRoot;
}

/** Absolute run-scoped state dir (transient, swept by SessionEnd when inactive). */
export function supervisorRunDir(projectRoot, runId) {
  return join(requireAbsoluteRoot(projectRoot), '.ao', 'state', 'supervisor', requireId(runId, 'runId'));
}

export function manifestPath(projectRoot, runId, workerRunId) {
  return join(supervisorRunDir(projectRoot, runId), `${requireId(workerRunId, 'workerRunId')}.manifest.json`);
}

export function snapshotPath(projectRoot, runId, workerRunId) {
  return join(supervisorRunDir(projectRoot, runId), `${requireId(workerRunId, 'workerRunId')}.snapshot.json`);
}

/** Absolute DURABLE output path (under artifacts so it survives for collect). */
export function outputPath(projectRoot, runId, workerRunId) {
  requireAbsoluteRoot(projectRoot);
  requireId(runId, 'runId');
  return join(projectRoot, '.ao', 'artifacts', 'team', runId, `${requireId(workerRunId, 'workerRunId')}.output`);
}

/** Clamp an inline output tail to the byte cap (keep the END — most recent). */
export function clampOutputTail(str) {
  if (typeof str !== 'string') return '';
  const buf = Buffer.from(str, 'utf-8');
  if (buf.length <= MAX_OUTPUT_TAIL_BYTES) return str;
  // Slice from the end; tolerate a split multibyte char at the cut.
  return buf.slice(buf.length - MAX_OUTPUT_TAIL_BYTES).toString('utf-8');
}

/**
 * Atomically write a snapshot (tmp+rename, 0600). WHITELISTS fields (drops prompt
 * / full output / path capabilities), clamps `outputTail`, and stamps
 * `schemaVersion` + `updatedAt` (the heartbeat) — callers must NOT set those.
 * @param {string} path
 * @param {object} snapshot
 * @param {number} [now] - epoch ms (injectable for tests)
 */
export function writeSnapshot(path, snapshot, now = Date.now()) {
  const out = { schemaVersion: SUPERVISOR_SCHEMA_VERSION, updatedAt: now };
  for (const k of SNAPSHOT_FIELDS) {
    if (snapshot[k] === undefined) continue;
    if (k === 'outputTail') { out[k] = clampOutputTail(snapshot[k]); continue; }
    if (k === 'workerMeta') {
      const meta = sanitizeWorkerMeta(snapshot[k]);
      if (meta !== undefined) out[k] = meta;
      continue;
    }
    out[k] = snapshot[k];
  }
  atomicWriteFileSync(path, JSON.stringify(out, null, 2));
}

function isValidSnapshotShape(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  if (!isValidTimestamp(o.updatedAt)) return false;
  if (!isValidId(o.runId) || !isValidId(o.workerRunId)) return false;
  if (!ALL_STATUSES.has(o.status)) return false;
  if (!(Number.isSafeInteger(o.supervisorPid) && o.supervisorPid > 0)) return false;
  // Nullable identity/liveness fields, but if present must be the right type.
  if (o.supervisorStartId != null && typeof o.supervisorStartId !== 'string') return false;
  if (o.adapterPid != null && !(Number.isSafeInteger(o.adapterPid) && o.adapterPid > 0)) return false;
  if (o.adapterStartId != null && typeof o.adapterStartId !== 'string') return false;
  if (o.workerMeta !== undefined && !isValidWorkerMetaBag(o.workerMeta)) return false;
  // A failure must carry a categorized error.
  if (o.status === 'failed') {
    if (!o.error || typeof o.error !== 'object' || typeof o.error.category !== 'string') return false;
  }
  return true;
}

/**
 * Read a snapshot, distinguishing FIVE outcomes:
 *   { kind: 'missing' }      — no file yet (supervisor starting)
 *   { kind: 'corrupt' }      — unreadable / bad JSON / fails the contract
 *   { kind: 'unsupported' }  — schemaVersion from the future
 *   { kind: 'mismatch' }     — valid, but a DIFFERENT run (stale generation)
 *   { kind: 'ok', snapshot } — valid + (if `expected` given) identity matches
 * Never throws.
 * @param {string} path
 * @param {{runId?:string, workerRunId?:string}} [expected] - reject other-run files
 * @returns {{kind:string, snapshot?:object}}
 */
export function readSnapshot(path, expected = null) {
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (e) {
    return { kind: e && e.code === 'ENOENT' ? 'missing' : 'corrupt' };
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt' };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { kind: 'corrupt' };
  if (!Number.isSafeInteger(obj.schemaVersion)) return { kind: 'corrupt' };
  if (obj.schemaVersion > SUPERVISOR_SCHEMA_VERSION) return { kind: 'unsupported' };
  if (obj.schemaVersion < SUPERVISOR_SCHEMA_VERSION) return { kind: 'corrupt' };
  if (!isValidSnapshotShape(obj)) return { kind: 'corrupt' };
  if (expected) {
    if ((expected.runId && obj.runId !== expected.runId) ||
        (expected.workerRunId && obj.workerRunId !== expected.workerRunId)) {
      return { kind: 'mismatch' };
    }
  }
  return { kind: 'ok', snapshot: obj };
}

/**
 * True if a `running` snapshot's heartbeat is recent enough to trust as alive.
 * Rejects invalid and implausibly-future timestamps (a far-future `updatedAt`
 * must NOT read as fresh forever).
 * @param {object} snapshot
 * @param {number} [now]
 * @param {number} [staleMs]
 */
export function isHeartbeatFresh(snapshot, now = Date.now(), staleMs = HEARTBEAT_STALE_MS) {
  if (!snapshot || !isValidTimestamp(snapshot.updatedAt)) return false;
  if (snapshot.updatedAt > now + FUTURE_SKEW_MS) return false; // clock ahead → suspect
  return (now - snapshot.updatedAt) <= staleMs;
}
