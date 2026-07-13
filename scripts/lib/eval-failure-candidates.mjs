/**
 * HU-17 local eval-failure review queue.
 *
 * This module deliberately does not turn a failed production run directly into
 * an eval fixture. It stores a small, local, review-only candidate containing
 * allowlisted run metadata and hashes/counts of known run artifacts. Raw task
 * text, evidence, errors, provider output, and filesystem paths never cross the
 * ingestion boundary.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { readProcStartId } from './proc-identity.mjs';
import { acquireRecoveryClaim, statGeneration } from './recovery-claim.mjs';
import {
  FAILURE_CODES_BY_CLASS,
  FAILURE_PHASES,
  RUN_FAILURE_SCHEMA_VERSION,
} from './run-failure.mjs';
import { getPhaseSequence } from './phase-runner.mjs';

export const FAILURE_CANDIDATE_SCHEMA_VERSION = 1;
export const FAILURE_CANDIDATE_PENDING_CAP = 500;
export const FAILURE_CANDIDATE_TOTAL_CAP = 2_000;
export const FAILURE_CANDIDATE_CLASSES = Object.freeze([
  'task-outcome',
  'orchestration',
]);
export const FAILURE_CANDIDATE_REVIEW_DECISIONS = Object.freeze([
  'approve',
  'reject',
]);

const DEFAULT_RUNS_BASE = path.join('.ao', 'artifacts', 'runs');
const DEFAULT_CANDIDATE_BASE = path.join('.ao', 'eval-candidates');
const DEFAULT_STATE_DIR = path.join('.ao', 'state');
const RECORDS_DIR = 'records';
const LOCK_DIR = '.queue-lock';
const LOCK_OWNER_FILE = 'owner.json';
const LOCK_OWNER_SCHEMA_VERSION = 1;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRIES = 500;
const LOCK_WAIT_MS = 4;
const MAX_FUTURE_SKEW_MS = 60_000;
const MAX_SUMMARY_BYTES = 256 * 1024;
const MAX_FAILURE_MARKER_BYTES = 64 * 1024;
const MAX_EVENTS_BYTES = 16 * 1024 * 1024;
const MAX_VERIFICATION_BYTES = 8 * 1024 * 1024;
const MAX_PIPELINE_BYTES = 256 * 1024;
const MAX_LOOP_GUARD_BYTES = 256 * 1024;
const MAX_POINTER_BYTES = 64 * 1024;
const MAX_CANDIDATE_BYTES = 64 * 1024;
const MAX_LOCK_OWNER_BYTES = 4 * 1024;
const MAX_JSONL_RECORDS = 100_000;
const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const CANDIDATE_ID_PATTERN = /^efc-[a-f0-9]{64}$/;
const TASK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LOCK_TOKEN_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ORCHESTRATORS = new Set(['atlas', 'athena']);
const FAILURE_CLASSES = new Set(FAILURE_CANDIDATE_CLASSES);
const FAILURE_PHASE_SET = new Set(FAILURE_PHASES);
const REVIEW_DECISIONS = new Set(FAILURE_CANDIDATE_REVIEW_DECISIONS);
const CANDIDATE_STATUSES = new Set(['pending', 'approved', 'rejected']);
const PIPELINE_STATUSES = new Set(['pending', 'in_progress', 'completed', 'skipped', 'failed']);

const ROOT_KEYS = ['schemaVersion', 'candidateId', 'status', 'run', 'signals', 'review', 'link'];
const RUN_KEYS = [
  'runId',
  'orchestrator',
  'failureClass',
  'failureCode',
  'failurePhase',
  'failedAt',
  'startedAt',
  'finishedAt',
  'durationMs',
];
const SIGNAL_KEYS = [
  'summary',
  'terminalFailure',
  'events',
  'verification',
  'pipeline',
  'loopGuard',
];
const BASIC_FILE_KEYS = ['sha256', 'bytes'];
const RECORD_FILE_KEYS = ['present', 'sha256', 'bytes', 'records'];
const PIPELINE_FILE_KEYS = ['present', 'sha256', 'bytes', 'phases'];
const LOOP_GUARD_FILE_KEYS = ['present', 'sha256', 'bytes', 'counters', 'errorSignatures'];
const REVIEW_KEYS = ['decision', 'reviewedAt'];
const LINK_KEYS = ['taskId', 'linkedAt'];
const LOCK_OWNER_KEYS = ['schemaVersion', 'token', 'pid', 'startId', 'createdAt'];

class CandidateQueueError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'CandidateQueueError';
    this.reason = reason;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasExactKeys(value, expected) {
  return isPlainObject(value)
    && Object.keys(value).length === expected.length
    && expected.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function isSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isCanonicalIso(value) {
  if (typeof value !== 'string' || value.length < 20 || value.length > 30) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function nullableCanonicalIso(value) {
  return value === null || isCanonicalIso(value);
}

function sha256(bufferOrString) {
  return createHash('sha256').update(bufferOrString).digest('hex');
}

function fail(reason) {
  return { ok: false, reason };
}

function deadlineExceeded(opts = {}) {
  return Number.isFinite(opts.deadlineMs) && Date.now() >= opts.deadlineMs;
}

function requireWithinDeadline(opts = {}) {
  if (deadlineExceeded(opts)) throw new CandidateQueueError('collection-deadline-exceeded');
}

function nowIso(opts) {
  try {
    const supplied = typeof opts?.now === 'function' ? opts.now() : opts?.now;
    if (supplied !== undefined) {
      const value = supplied instanceof Date ? supplied.toISOString() : supplied;
      if (!isCanonicalIso(value)) throw new CandidateQueueError('invalid-now');
      return value;
    }
    return new Date().toISOString();
  } catch (error) {
    if (error instanceof CandidateQueueError) throw error;
    throw new CandidateQueueError('invalid-now');
  }
}

function resolveRunsBase(opts = {}) {
  return path.resolve(opts.runsBase || opts.runBase || opts.base || DEFAULT_RUNS_BASE);
}

function resolveCandidateBase(opts = {}) {
  return path.resolve(opts.candidateBase || opts.queueBase || opts.base || DEFAULT_CANDIDATE_BASE);
}

function normalizeCollectionOpts(opts) {
  return {
    ...opts,
    runsBase: opts.runsBase || opts.runBase || opts.base || DEFAULT_RUNS_BASE,
    candidateBase: opts.candidateBase || opts.queueBase || DEFAULT_CANDIDATE_BASE,
  };
}

function deriveStateDir(runsBase, opts = {}) {
  if (opts.stateDir) return path.resolve(opts.stateDir);
  const parent = path.dirname(runsBase);
  if (path.basename(runsBase) === 'runs' && path.basename(parent) === 'artifacts') {
    return path.join(path.dirname(parent), 'state');
  }
  if (runsBase === path.resolve(DEFAULT_RUNS_BASE)) return path.resolve(DEFAULT_STATE_DIR);
  throw new CandidateQueueError('state-dir-required');
}

function secureDirectory(dirPath, create) {
  let stats;
  try {
    stats = lstatSync(dirPath);
  } catch (error) {
    if (error?.code !== 'ENOENT' || !create) {
      throw new CandidateQueueError('unsafe-directory');
    }
    try {
      mkdirSync(dirPath, { recursive: true, mode: 0o700 });
      stats = lstatSync(dirPath);
    } catch {
      throw new CandidateQueueError('unsafe-directory');
    }
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new CandidateQueueError('unsafe-directory');
  }
  if (create) {
    try { chmodSync(dirPath, 0o700); }
    catch { throw new CandidateQueueError('unsafe-directory'); }
  }
  return dirPath;
}

function queuePaths(opts = {}) {
  const base = resolveCandidateBase(opts);
  secureDirectory(base, true);
  const records = path.join(base, RECORDS_DIR);
  secureDirectory(records, true);
  return { base, records, lock: path.join(base, LOCK_DIR) };
}

const waitArray = new Int32Array(new SharedArrayBuffer(4));

function waitBriefly(waitMs = LOCK_WAIT_MS) {
  if (waitMs <= 0) return;
  try { Atomics.wait(waitArray, 0, 0, waitMs); }
  catch {
    const until = Date.now() + waitMs;
    while (Date.now() < until) { /* bounded fallback */ }
  }
}

function newLockOwner() {
  return {
    schemaVersion: LOCK_OWNER_SCHEMA_VERSION,
    token: randomUUID(),
    pid: process.pid,
    startId: readProcStartId(process.pid),
    createdAt: new Date().toISOString(),
  };
}

function readLockOwner(lockPath) {
  const file = readRegularFile(path.join(lockPath, LOCK_OWNER_FILE), MAX_LOCK_OWNER_BYTES, true);
  if (!file.ok) throw new CandidateQueueError('unsafe-queue-lock');
  if (!file.present) return null;
  if (process.platform !== 'win32' && (file.stats.mode & 0o777) !== 0o600) {
    throw new CandidateQueueError('unsafe-queue-lock');
  }
  const parsed = parseJson(file.buffer);
  if (!parsed.ok) throw new CandidateQueueError('unsafe-queue-lock');
  const owner = parsed.value;
  if (!hasExactKeys(owner, LOCK_OWNER_KEYS)
    || owner.schemaVersion !== LOCK_OWNER_SCHEMA_VERSION
    || !LOCK_TOKEN_PATTERN.test(owner.token)
    || !Number.isSafeInteger(owner.pid)
    || owner.pid < 1
    || !(owner.startId === null || (
      typeof owner.startId === 'string'
      && owner.startId.length > 0
      && owner.startId.length <= 512
    ))
    || !isCanonicalIso(owner.createdAt)
    || Date.parse(owner.createdAt) > Date.now() + MAX_FUTURE_SKEW_MS) {
    throw new CandidateQueueError('unsafe-queue-lock');
  }
  return owner;
}

function sameLockOwner(left, right) {
  return Boolean(left && right)
    && left.token === right.token
    && left.pid === right.pid
    && left.startId === right.startId;
}

function ownerIsDefinitelyStale(owner) {
  if (Date.now() - Date.parse(owner.createdAt) <= LOCK_STALE_MS) return false;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') return true;
    return false;
  }
  const currentStartId = readProcStartId(owner.pid);
  return owner.startId !== null
    && currentStartId !== null
    && currentStartId !== owner.startId;
}

function releaseQueueLock(lockPath, expectedOwner) {
  try {
    const currentOwner = readLockOwner(lockPath);
    if (!sameLockOwner(currentOwner, expectedOwner)) return false;
    unlinkSync(path.join(lockPath, LOCK_OWNER_FILE));
    rmdirSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function prepareQueueLockIntent(lockPath) {
  const owner = newLockOwner();
  const intentPath = path.join(
    path.dirname(lockPath),
    `.queue-lock-intent-${owner.token}`,
  );
  try {
    mkdirSync(intentPath, { mode: 0o700 });
    chmodSync(intentPath, 0o700);
    atomicWriteFileSync(
      path.join(intentPath, LOCK_OWNER_FILE),
      `${JSON.stringify(owner)}\n`,
      { mode: 0o600 },
    );
    chmodSync(path.join(intentPath, LOCK_OWNER_FILE), 0o600);
    return { owner, intentPath };
  } catch {
    try { unlinkSync(path.join(intentPath, LOCK_OWNER_FILE)); } catch {}
    try { rmdirSync(intentPath); } catch {}
    throw new CandidateQueueError('queue-lock-failed');
  }
}

function acquireQueueLock(lockPath, opts = {}) {
  const prepared = prepareQueueLockIntent(lockPath);
  const confirmedLiveOwners = new Set();
  const retries = Number.isSafeInteger(opts.lockRetries)
    ? Math.max(1, Math.min(LOCK_RETRIES, opts.lockRetries))
    : LOCK_RETRIES;
  const waitMs = Number.isFinite(opts.lockWaitMs)
    ? Math.max(0, Math.min(LOCK_WAIT_MS, opts.lockWaitMs))
    : LOCK_WAIT_MS;
  try {
    for (let attempt = 0; attempt < retries; attempt += 1) {
      try {
        // Publish only a fully initialized owner directory. rename(2) is the
        // ownership linearization point; a crash beforehand leaves an ignored
        // intent directory, never an ownerless `.queue-lock`.
        renameSync(prepared.intentPath, lockPath);
        return prepared.owner;
      } catch {
        // A competing published lock is expected. Inspect the destination
        // rather than relying on platform-specific rename error codes.
      }

      let stats;
      try { stats = lstatSync(lockPath); }
      catch {
        waitBriefly(waitMs);
        continue;
      }
      if (!stats.isDirectory()
        || stats.isSymbolicLink()
        || (process.platform !== 'win32' && (stats.mode & 0o777) !== 0o700)) {
        throw new CandidateQueueError('unsafe-queue-lock');
      }

      let existingOwner;
      try { existingOwner = readLockOwner(lockPath); }
      catch (error) {
        // The owner can atomically release between our directory lstat and file
        // open, and another owner can acquire immediately afterward. A stable
        // malformed owner remains fail-closed; a missing or newly valid owner
        // is ordinary contention and must be retried.
        try {
          const currentLock = lstatSync(lockPath);
          if (!currentLock.isDirectory() || currentLock.isSymbolicLink()) throw error;
          readLockOwner(lockPath);
          waitBriefly(waitMs);
          continue;
        } catch (recheckError) {
          if (recheckError?.code === 'ENOENT') {
            waitBriefly(waitMs);
            continue;
          }
        }
        if (error instanceof CandidateQueueError) throw error;
        throw new CandidateQueueError('unsafe-queue-lock');
      }

      if (!existingOwner
        && Date.now() - stats.mtimeMs > LOCK_STALE_MS
        && readdirSync(lockPath).length === 0) {
        const generation = statGeneration(stats);
        const claim = acquireRecoveryClaim(
          path.dirname(lockPath),
          'candidate-queue-ownerless',
          generation,
          {
            isGenerationCurrent: () => {
              try {
                return statGeneration(lstatSync(lockPath)) === generation
                  && readdirSync(lockPath).length === 0;
              } catch {
                return false;
              }
            },
          },
        );
        if (!claim.won) throw new CandidateQueueError('queue-busy');
        const current = lstatSync(lockPath);
        if (statGeneration(current) === generation) {
          try { rmdirSync(lockPath); } catch {}
        }
        continue;
      }

      if (existingOwner
        && Date.now() - Date.parse(existingOwner.createdAt) > LOCK_STALE_MS
        && !confirmedLiveOwners.has(existingOwner.token)) {
        if (ownerIsDefinitelyStale(existingOwner)) {
          const claim = acquireRecoveryClaim(
            path.dirname(lockPath),
            'candidate-queue',
            existingOwner.token,
            {
              isGenerationCurrent: () => {
                try {
                  const current = readLockOwner(lockPath);
                  return sameLockOwner(current, existingOwner)
                    && ownerIsDefinitelyStale(current);
                } catch {
                  return false;
                }
              },
            },
          );
          if (!claim.won) throw new CandidateQueueError('queue-busy');
          const current = readLockOwner(lockPath);
          if (!sameLockOwner(current, existingOwner) || !ownerIsDefinitelyStale(current)) {
            throw new CandidateQueueError('queue-busy');
          }
          if (!releaseQueueLock(lockPath, current)) throw new CandidateQueueError('queue-busy');
          continue;
        }
        confirmedLiveOwners.add(existingOwner.token);
      }
      if (attempt + 1 < retries) waitBriefly(waitMs);
    }
    throw new CandidateQueueError('queue-busy');
  } catch (error) {
    releaseQueueLock(prepared.intentPath, prepared.owner);
    if (error instanceof CandidateQueueError) throw error;
    throw new CandidateQueueError('queue-lock-failed');
  }
}

function withQueueLock(opts, operation) {
  const paths = queuePaths(opts);
  const owner = acquireQueueLock(paths.lock, opts);
  try {
    return operation(paths);
  } finally {
    releaseQueueLock(paths.lock, owner);
  }
}

function readRegularFile(filePath, maxBytes, optional = false) {
  let before;
  let fd;
  try {
    before = lstatSync(filePath);
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return { ok: true, present: false };
    return { ok: false, reason: 'missing-or-unreadable-artifact' };
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    return { ok: false, reason: 'unsafe-artifact-type' };
  }
  if (before.size > maxBytes) return { ok: false, reason: 'oversized-artifact' };
  try {
    fd = openSync(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd);
    if (!opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.size > maxBytes) {
      return { ok: false, reason: 'artifact-race' };
    }

    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const remaining = maxBytes + 1 - total;
      if (remaining <= 0) break;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) return { ok: false, reason: 'oversized-artifact' };

    const after = fstatSync(fd);
    if (after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.dev !== opened.dev
      || after.ino !== opened.ino) {
      return { ok: false, reason: 'artifact-race' };
    }
    return {
      ok: true,
      present: true,
      stats: after,
      buffer: Buffer.concat(chunks, total),
    };
  } catch {
    return { ok: false, reason: 'missing-or-unreadable-artifact' };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

function parseJson(buffer) {
  try {
    const value = JSON.parse(buffer.toString('utf-8'));
    return isPlainObject(value)
      ? { ok: true, value }
      : { ok: false, reason: 'invalid-json-shape' };
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
}

function parseJsonl(buffer, { skipInvalid = false } = {}) {
  const lines = buffer.toString('utf-8').split('\n');
  const values = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    if (values.length >= MAX_JSONL_RECORDS) return { ok: false, reason: 'too-many-records' };
    let value;
    try { value = JSON.parse(line); }
    catch {
      if (skipInvalid) continue;
      return { ok: false, reason: 'invalid-jsonl' };
    }
    if (!isPlainObject(value)) return { ok: false, reason: 'invalid-jsonl-shape' };
    values.push(value);
  }
  return { ok: true, values };
}

function validateFailureMarker(marker, runId, opts) {
  const markerKeys = [
    'schemaVersion',
    'runId',
    'orchestrator',
    'failureClass',
    'code',
    'phase',
    'failedAt',
  ];
  if (!isPlainObject(marker) || !Number.isSafeInteger(marker.schemaVersion)) {
    return { ok: false, reason: 'invalid-terminal-failure-marker' };
  }
  if (marker.schemaVersion > RUN_FAILURE_SCHEMA_VERSION) {
    return { ok: false, reason: 'unsupported-terminal-failure-schema' };
  }
  const allowedCodes = FAILURE_CODES_BY_CLASS[marker.failureClass];
  if (marker.schemaVersion !== RUN_FAILURE_SCHEMA_VERSION
    || !hasExactKeys(marker, markerKeys)
    || marker.runId !== runId
    || !ORCHESTRATORS.has(marker.orchestrator)
    || !FAILURE_CLASSES.has(marker.failureClass)
    || !Array.isArray(allowedCodes)
    || !allowedCodes.includes(marker.code)
    || !FAILURE_PHASE_SET.has(marker.phase)
    || !isCanonicalIso(marker.failedAt)
    || Date.parse(marker.failedAt) > Date.now() + MAX_FUTURE_SKEW_MS
    || (opts.failureClass !== undefined && opts.failureClass !== marker.failureClass)) {
    return { ok: false, reason: 'invalid-terminal-failure-marker' };
  }
  return { ok: true };
}

function validateSummary(summary, marker) {
  if (!isPlainObject(summary)) return { ok: false, reason: 'invalid-summary' };
  if (summary.schemaVersion !== undefined && summary.schemaVersion !== 1) {
    return { ok: false, reason: 'unsupported-summary-schema' };
  }
  if (summary.runId !== marker.runId
    || summary.orchestrator !== marker.orchestrator
    || summary.status !== 'completed'
    || summary.result !== 'failure'
    || summary.failureCode !== marker.code
    || summary.failedPhase !== marker.phase
    || !isCanonicalIso(summary.startedAt)
    || !isCanonicalIso(summary.finishedAt)
    || Date.parse(summary.finishedAt) < Date.parse(summary.startedAt)
    || Date.parse(marker.failedAt) < Date.parse(summary.startedAt)
    || Date.parse(marker.failedAt) > Date.parse(summary.finishedAt)
    || Date.parse(summary.finishedAt) > Date.now() + MAX_FUTURE_SKEW_MS
    || !isSafeInteger(summary.duration_ms)) {
    return { ok: false, reason: 'run-not-terminal-failure' };
  }
  const elapsed = Date.parse(summary.finishedAt) - Date.parse(summary.startedAt);
  if (Math.abs(elapsed - summary.duration_ms) > 2_000) {
    return { ok: false, reason: 'invalid-run-duration' };
  }
  return { ok: true };
}

function validateFinalization(events, summary, marker) {
  if (!Array.isArray(events) || events.length === 0) return false;
  const finalized = events.filter(event => event.type === 'run_finalized');
  if (finalized.length !== 1 || events.at(-1) !== finalized[0]) return false;
  const failed = events.filter(event => event.type === 'pipeline_phase_failed');
  if (failed.length !== 1) return false;
  const failureEvent = failed[0];
  const terminal = finalized[0];
  return failureEvent.phase === marker.phase
    && isPlainObject(failureEvent.detail)
    && failureEvent.detail.orchestrator === marker.orchestrator
    && failureEvent.detail.code === marker.code
    && isCanonicalIso(failureEvent.timestamp)
    && Date.parse(failureEvent.timestamp) >= Date.parse(marker.failedAt) - MAX_FUTURE_SKEW_MS
    && Date.parse(failureEvent.timestamp) <= Date.parse(marker.failedAt)
    && events.indexOf(failureEvent) < events.indexOf(terminal)
    && isPlainObject(terminal.detail)
    && terminal.detail.status === 'completed'
    && isCanonicalIso(terminal.timestamp)
    && Date.parse(terminal.timestamp) >= Date.parse(summary.finishedAt)
    && Date.parse(terminal.timestamp) <= Date.now() + MAX_FUTURE_SKEW_MS;
}

function validateActivePointer(runId, orchestrator, stateDir) {
  if (!stateDir) return { ok: true };
  let stateStats;
  try { stateStats = lstatSync(stateDir); }
  catch (error) {
    return error?.code === 'ENOENT'
      ? { ok: true }
      : { ok: false, reason: 'unsafe-state-directory' };
  }
  if (!stateStats.isDirectory() || stateStats.isSymbolicLink()) {
    return { ok: false, reason: 'unsafe-state-directory' };
  }
  const pointerPath = path.join(stateDir, `ao-active-run-${orchestrator}.json`);
  const pointerFile = readRegularFile(pointerPath, MAX_POINTER_BYTES, true);
  if (!pointerFile.ok) return pointerFile;
  if (!pointerFile.present) return { ok: true };
  const parsed = parseJson(pointerFile.buffer);
  if (!parsed.ok || typeof parsed.value.runId !== 'string') {
    return { ok: false, reason: 'invalid-active-run-pointer' };
  }
  return parsed.value.runId === runId
    ? { ok: false, reason: 'run-still-active' }
    : { ok: true };
}

function optionalJsonlSignal(runDir, name, maxBytes) {
  const file = readRegularFile(path.join(runDir, name), maxBytes, true);
  if (!file.ok) return file;
  if (!file.present) {
    return {
      ok: true,
      signal: { present: false, sha256: null, bytes: 0, records: 0 },
    };
  }
  const parsed = parseJsonl(file.buffer);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    signal: {
      present: true,
      sha256: sha256(file.buffer),
      bytes: file.buffer.length,
      records: parsed.values.length,
    },
  };
}

function optionalPipelineSignal(runDir, marker) {
  const file = readRegularFile(path.join(runDir, 'pipeline.json'), MAX_PIPELINE_BYTES, true);
  if (!file.ok) return file;
  if (!file.present) {
    return { ok: false, reason: 'missing-pipeline-artifact' };
  }
  const parsed = parseJson(file.buffer);
  if (!parsed.ok) return parsed;
  const pipeline = parsed.value;
  const sequence = getPhaseSequence(marker.orchestrator);
  const ids = sequence.map(item => item.id);
  const cut = ids.indexOf(marker.phase);
  if (pipeline.schemaVersion !== 1
    || pipeline.runId !== marker.runId
    || pipeline.orchestrator !== marker.orchestrator
    || !isPlainObject(pipeline.phases)
    || cut < 0
    || JSON.stringify(Object.keys(pipeline.phases).sort()) !== JSON.stringify([...ids].sort())) {
    return { ok: false, reason: 'invalid-pipeline-artifact' };
  }
  for (let index = 0; index < ids.length; index += 1) {
    const phase = pipeline.phases[ids[index]];
    if (!isPlainObject(phase) || !PIPELINE_STATUSES.has(phase.status)) {
      return { ok: false, reason: 'invalid-pipeline-artifact' };
    }
    if (index < cut) {
      const validSkip = phase.status === 'skipped'
        && typeof phase.reason === 'string'
        && sequence[index].skippableWhen.includes(phase.reason);
      if (phase.status !== 'completed' && !validSkip) {
        return { ok: false, reason: 'invalid-pipeline-failure-cut' };
      }
    }
    if (index === cut && (phase.status !== 'failed'
      || phase.failureCode !== marker.code
      || !isCanonicalIso(phase.failedAt)
      || phase.completedAt !== phase.failedAt
      || Date.parse(phase.failedAt) > Date.parse(marker.failedAt))) {
      return { ok: false, reason: 'invalid-pipeline-failure-cut' };
    }
    if (index > cut && phase.status !== 'pending') {
      return { ok: false, reason: 'invalid-pipeline-failure-cut' };
    }
  }
  return {
    ok: true,
    signal: {
      present: true,
      sha256: sha256(file.buffer),
      bytes: file.buffer.length,
      phases: ids.length,
    },
  };
}

function optionalLoopGuardSignal(runDir) {
  const file = readRegularFile(path.join(runDir, 'loop-guard.json'), MAX_LOOP_GUARD_BYTES, true);
  if (!file.ok) return file;
  if (!file.present) {
    return {
      ok: true,
      signal: {
        present: false,
        sha256: null,
        bytes: 0,
        counters: 0,
        errorSignatures: 0,
      },
    };
  }
  const parsed = parseJson(file.buffer);
  if (!parsed.ok) return parsed;
  const guard = parsed.value;
  if (guard.schemaVersion !== 1 || !isPlainObject(guard.counters) || !isPlainObject(guard.errors)) {
    return { ok: false, reason: 'invalid-loop-guard-artifact' };
  }
  return {
    ok: true,
    signal: {
      present: true,
      sha256: sha256(file.buffer),
      bytes: file.buffer.length,
      counters: Object.keys(guard.counters).length,
      errorSignatures: Object.keys(guard.errors).length,
    },
  };
}

function immutableCandidateCore(run, signals) {
  return {
    schemaVersion: FAILURE_CANDIDATE_SCHEMA_VERSION,
    run,
    signals,
  };
}

function candidateIdFor(run, signals) {
  return `efc-${sha256(JSON.stringify(immutableCandidateCore(run, signals)))}`;
}

function basicFileSignalValid(value) {
  return hasExactKeys(value, BASIC_FILE_KEYS)
    && SHA256_PATTERN.test(value.sha256)
    && isSafeInteger(value.bytes)
    && value.bytes > 0;
}

function optionalRecordSignalValid(value) {
  return hasExactKeys(value, RECORD_FILE_KEYS)
    && typeof value.present === 'boolean'
    && (value.present ? SHA256_PATTERN.test(value.sha256) : value.sha256 === null)
    && isSafeInteger(value.bytes)
    && isSafeInteger(value.records)
    && (value.present || (value.bytes === 0 && value.records === 0));
}

function optionalPipelineSignalValid(value) {
  return hasExactKeys(value, PIPELINE_FILE_KEYS)
    && typeof value.present === 'boolean'
    && (value.present ? SHA256_PATTERN.test(value.sha256) : value.sha256 === null)
    && isSafeInteger(value.bytes)
    && isSafeInteger(value.phases)
    && (value.present
      ? value.bytes > 0 && value.phases > 0
      : value.bytes === 0 && value.phases === 0);
}

function optionalLoopGuardSignalValid(value) {
  return hasExactKeys(value, LOOP_GUARD_FILE_KEYS)
    && typeof value.present === 'boolean'
    && (value.present ? SHA256_PATTERN.test(value.sha256) : value.sha256 === null)
    && isSafeInteger(value.bytes)
    && isSafeInteger(value.counters)
    && isSafeInteger(value.errorSignatures)
    && (value.present
      ? value.bytes > 0
      : value.bytes === 0 && value.counters === 0 && value.errorSignatures === 0);
}

function validateCandidate(candidate) {
  if (!hasExactKeys(candidate, ROOT_KEYS)
    || candidate.schemaVersion !== FAILURE_CANDIDATE_SCHEMA_VERSION
    || !CANDIDATE_ID_PATTERN.test(candidate.candidateId)
    || !CANDIDATE_STATUSES.has(candidate.status)
    || !hasExactKeys(candidate.run, RUN_KEYS)
    || !RUN_ID_PATTERN.test(candidate.run.runId)
    || !ORCHESTRATORS.has(candidate.run.orchestrator)
    || !FAILURE_CLASSES.has(candidate.run.failureClass)
    || !Array.isArray(FAILURE_CODES_BY_CLASS[candidate.run.failureClass])
    || !FAILURE_CODES_BY_CLASS[candidate.run.failureClass].includes(candidate.run.failureCode)
    || !FAILURE_PHASE_SET.has(candidate.run.failurePhase)
    || !isCanonicalIso(candidate.run.failedAt)
    || !isCanonicalIso(candidate.run.startedAt)
    || !isCanonicalIso(candidate.run.finishedAt)
    || Date.parse(candidate.run.failedAt) < Date.parse(candidate.run.startedAt)
    || Date.parse(candidate.run.failedAt) > Date.parse(candidate.run.finishedAt)
    || Date.parse(candidate.run.finishedAt) < Date.parse(candidate.run.startedAt)
    || Date.parse(candidate.run.finishedAt) > Date.now() + MAX_FUTURE_SKEW_MS
    || !isSafeInteger(candidate.run.durationMs)
    || Math.abs(
      Date.parse(candidate.run.finishedAt)
      - Date.parse(candidate.run.startedAt)
      - candidate.run.durationMs
    ) > 2_000
    || !hasExactKeys(candidate.signals, SIGNAL_KEYS)
    || !basicFileSignalValid(candidate.signals.summary)
    || !basicFileSignalValid(candidate.signals.terminalFailure)
    || !optionalRecordSignalValid(candidate.signals.events)
    || candidate.signals.events.present !== true
    || candidate.signals.events.bytes === 0
    || candidate.signals.events.records === 0
    || !optionalRecordSignalValid(candidate.signals.verification)
    || !optionalPipelineSignalValid(candidate.signals.pipeline)
    || !optionalLoopGuardSignalValid(candidate.signals.loopGuard)
    || !hasExactKeys(candidate.review, REVIEW_KEYS)
    || !hasExactKeys(candidate.link, LINK_KEYS)
    || !nullableCanonicalIso(candidate.review.reviewedAt)
    || !nullableCanonicalIso(candidate.link.linkedAt)) {
    return false;
  }

  const expectedId = candidateIdFor(candidate.run, candidate.signals);
  if (candidate.candidateId !== expectedId) return false;

  const reviewValid = (
    candidate.status === 'pending'
      ? candidate.review.decision === null && candidate.review.reviewedAt === null
      : candidate.status === 'approved'
        ? candidate.review.decision === 'approve' && candidate.review.reviewedAt !== null
        : candidate.review.decision === 'reject' && candidate.review.reviewedAt !== null
  );
  if (!reviewValid) return false;

  const unlinked = candidate.link.taskId === null && candidate.link.linkedAt === null;
  const linked = candidate.status === 'approved'
    && TASK_ID_PATTERN.test(candidate.link.taskId)
    && candidate.link.linkedAt !== null;
  return unlinked || linked;
}

function candidateFile(recordsDir, candidateId) {
  return path.join(recordsDir, `${candidateId}.json`);
}

function readCandidate(filePath) {
  const file = readRegularFile(filePath, MAX_CANDIDATE_BYTES);
  if (!file.ok) return file;
  if (process.platform !== 'win32' && (file.stats.mode & 0o777) !== 0o600) {
    return { ok: false, reason: 'unsafe-candidate-permissions' };
  }
  const parsed = parseJson(file.buffer);
  if (!parsed.ok || !validateCandidate(parsed.value)) {
    return { ok: false, reason: 'invalid-candidate' };
  }
  return { ok: true, candidate: parsed.value };
}

function readAllCandidates(recordsDir, opts = {}) {
  requireWithinDeadline(opts);
  let entries;
  try {
    entries = readdirSync(recordsDir, { withFileTypes: true })
      .filter(entry => entry.name.endsWith('.json'))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    throw new CandidateQueueError('queue-read-failed');
  }
  if (entries.length > FAILURE_CANDIDATE_TOTAL_CAP) {
    throw new CandidateQueueError('total-cap-reached');
  }
  const candidates = [];
  const runIds = new Set();
  for (const entry of entries) {
    requireWithinDeadline(opts);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new CandidateQueueError('queue-corrupt');
    const id = entry.name.slice(0, -'.json'.length);
    if (!CANDIDATE_ID_PATTERN.test(id)) throw new CandidateQueueError('queue-corrupt');
    const read = readCandidate(path.join(recordsDir, entry.name));
    if (!read.ok || read.candidate.candidateId !== id) throw new CandidateQueueError('queue-corrupt');
    if (runIds.has(read.candidate.run.runId)) throw new CandidateQueueError('queue-corrupt');
    runIds.add(read.candidate.run.runId);
    candidates.push(read.candidate);
  }
  return candidates;
}

function writeCandidate(filePath, candidate) {
  if (!validateCandidate(candidate)) throw new CandidateQueueError('invalid-candidate');
  try {
    atomicWriteFileSync(filePath, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 });
    chmodSync(filePath, 0o600);
  } catch {
    throw new CandidateQueueError('candidate-write-failed');
  }
}

function buildCandidate(runId, runDir, opts) {
  if (deadlineExceeded(opts)) return fail('collection-deadline-exceeded');
  const markerFile = readRegularFile(
    path.join(runDir, 'terminal-failure.json'),
    MAX_FAILURE_MARKER_BYTES,
  );
  if (!markerFile.ok) return markerFile;
  const markerParsed = parseJson(markerFile.buffer);
  if (!markerParsed.ok) return markerParsed;
  const marker = markerParsed.value;
  const markerValid = validateFailureMarker(marker, runId, opts);
  if (!markerValid.ok) return markerValid;
  if (deadlineExceeded(opts)) return fail('collection-deadline-exceeded');

  const summaryFile = readRegularFile(path.join(runDir, 'summary.json'), MAX_SUMMARY_BYTES);
  if (!summaryFile.ok) return summaryFile;
  const summaryParsed = parseJson(summaryFile.buffer);
  if (!summaryParsed.ok) return summaryParsed;
  const summary = summaryParsed.value;
  const summaryValid = validateSummary(summary, marker);
  if (!summaryValid.ok) return summaryValid;
  if (deadlineExceeded(opts)) return fail('collection-deadline-exceeded');

  const eventsFile = readRegularFile(path.join(runDir, 'events.jsonl'), MAX_EVENTS_BYTES);
  if (!eventsFile.ok) return eventsFile;
  // Run finalization treats syntactically torn event records as absent. Keep
  // candidate ingestion aligned: valid events after a damaged line remain
  // authoritative, while parseable non-object records still fail closed.
  const eventsParsed = parseJsonl(eventsFile.buffer, { skipInvalid: true });
  if (!eventsParsed.ok) return eventsParsed;
  if (!validateFinalization(eventsParsed.values, summary, marker)) {
    return { ok: false, reason: 'run-not-finalized' };
  }
  if (deadlineExceeded(opts)) return fail('collection-deadline-exceeded');

  const pointer = validateActivePointer(
    runId,
    summary.orchestrator,
    deriveStateDir(resolveRunsBase(opts), opts),
  );
  if (!pointer.ok) return pointer;

  const verification = optionalJsonlSignal(runDir, 'verification.jsonl', MAX_VERIFICATION_BYTES);
  if (!verification.ok) return verification;
  const pipeline = optionalPipelineSignal(runDir, marker);
  if (!pipeline.ok) return pipeline;
  const loopGuard = optionalLoopGuardSignal(runDir);
  if (!loopGuard.ok) return loopGuard;

  const run = {
    runId: summary.runId,
    orchestrator: summary.orchestrator,
    failureClass: marker.failureClass,
    failureCode: marker.code,
    failurePhase: marker.phase,
    failedAt: marker.failedAt,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    durationMs: summary.duration_ms,
  };
  const signals = {
    summary: {
      sha256: sha256(summaryFile.buffer),
      bytes: summaryFile.buffer.length,
    },
    terminalFailure: {
      sha256: sha256(markerFile.buffer),
      bytes: markerFile.buffer.length,
    },
    events: {
      present: true,
      sha256: sha256(eventsFile.buffer),
      bytes: eventsFile.buffer.length,
      records: eventsParsed.values.length,
    },
    verification: verification.signal,
    pipeline: pipeline.signal,
    loopGuard: loopGuard.signal,
  };
  const candidateId = candidateIdFor(run, signals);
  return {
    ok: true,
    candidate: {
      schemaVersion: FAILURE_CANDIDATE_SCHEMA_VERSION,
      candidateId,
      status: 'pending',
      run,
      signals,
      review: { decision: null, reviewedAt: null },
      link: { taskId: null, linkedAt: null },
    },
  };
}

function sameCandidateSnapshot(left, right) {
  return Boolean(left?.ok && right?.ok)
    && JSON.stringify(left.candidate) === JSON.stringify(right.candidate);
}

/**
 * Collect one fully finalized, explicitly failed Atlas/Athena run for local
 * human review. Returns `{ok, created, candidate}` on success and a stable
 * reason code on refusal. Existing raw artifacts are never copied.
 *
 * Supported opts: `runsBase`/`runBase`/`base`,
 * `candidateBase`/`queueBase`, `stateDir`, and an optional `failureClass`
 * assertion that must match the durable marker.
 */
export function collectRunFailureCandidate(runId, opts = {}) {
  try {
    if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) return fail('invalid-run-id');
    const effectiveOpts = normalizeCollectionOpts(opts);
    const runsBase = resolveRunsBase(effectiveOpts);
    secureDirectory(runsBase, false);
    const runDir = path.join(runsBase, runId);
    secureDirectory(runDir, false);
    if (path.dirname(runDir) !== runsBase) return fail('invalid-run-id');

    // Do the expensive eligibility read before queue contention. The snapshot
    // is rebuilt twice under the lock before commit, so this optimization does
    // not weaken the source-race boundary.
    const preflight = buildCandidate(runId, runDir, effectiveOpts);
    if (!preflight.ok) return fail(preflight.reason || 'ineligible-run');
    if (deadlineExceeded(effectiveOpts)) return fail('collection-deadline-exceeded');

    return withQueueLock(effectiveOpts, ({ records }) => {
      requireWithinDeadline(effectiveOpts);
      const built = buildCandidate(runId, runDir, effectiveOpts);
      if (!built.ok) return fail(built.reason || 'ineligible-run');
      const all = readAllCandidates(records, effectiveOpts);
      const confirmed = buildCandidate(runId, runDir, effectiveOpts);
      if (!sameCandidateSnapshot(built, confirmed)) return fail('source-artifacts-changed');

      const exact = all.find(item => item.candidateId === built.candidate.candidateId);
      if (exact) {
        return { ok: true, created: false, candidate: exact };
      }
      if (all.some(item => item.run.runId === runId)) return fail('run-already-collected');
      if (all.length >= FAILURE_CANDIDATE_TOTAL_CAP) return fail('total-cap-reached');
      if (all.filter(item => item.status === 'pending').length >= FAILURE_CANDIDATE_PENDING_CAP) {
        return fail('pending-cap-reached');
      }
      const filePath = candidateFile(records, built.candidate.candidateId);
      writeCandidate(filePath, built.candidate);
      const committed = buildCandidate(runId, runDir, effectiveOpts);
      if (!sameCandidateSnapshot(built, committed)) {
        try { unlinkSync(filePath); }
        catch { return fail('candidate-rollback-failed'); }
        return fail('source-artifacts-changed');
      }
      return { ok: true, created: true, candidate: built.candidate };
    });
  } catch (error) {
    return fail(error instanceof CandidateQueueError ? error.reason : 'collection-failed');
  }
}

/**
 * List validated candidates. Default status is `pending`; pass
 * `{status:'all'}` to include every lifecycle state. A corrupt/future/unsafe
 * record fails closed and returns an empty list rather than a partial view.
 */
export function listFailureCandidates(opts = {}) {
  try {
    const status = opts.status ?? 'pending';
    if (status !== 'all' && !CANDIDATE_STATUSES.has(status)) return [];
    const limit = opts.limit === undefined
      ? FAILURE_CANDIDATE_PENDING_CAP
      : Math.min(FAILURE_CANDIDATE_PENDING_CAP, Math.max(0, Number(opts.limit) || 0));
    const { records } = queuePaths(opts);
    const candidates = readAllCandidates(records)
      .filter(candidate => status === 'all' || candidate.status === status)
      .sort((a, b) => (
        b.run.finishedAt.localeCompare(a.run.finishedAt)
        || a.candidateId.localeCompare(b.candidateId)
      ));
    return candidates.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Atomically record one human review decision (`approve` or `reject`). Repeating
 * the same decision is idempotent; changing an existing decision is refused.
 */
export function reviewFailureCandidate(candidateId, decision, opts = {}) {
  try {
    if (typeof candidateId !== 'string' || !CANDIDATE_ID_PATTERN.test(candidateId)) {
      return fail('invalid-candidate-id');
    }
    if (!REVIEW_DECISIONS.has(decision)) return fail('invalid-review-decision');
    return withQueueLock(opts, ({ records }) => {
      const candidate = readAllCandidates(records)
        .find(item => item.candidateId === candidateId);
      if (!candidate) return fail('candidate-not-found');
      const filePath = candidateFile(records, candidateId);
      const targetStatus = decision === 'approve' ? 'approved' : 'rejected';
      if (candidate.status === targetStatus && candidate.review.decision === decision) {
        return { ok: true, changed: false, candidate };
      }
      if (candidate.status !== 'pending') return fail('candidate-already-reviewed');
      const updated = {
        ...candidate,
        status: targetStatus,
        review: { decision, reviewedAt: nowIso(opts) },
      };
      writeCandidate(filePath, updated);
      return { ok: true, changed: true, candidate: updated };
    });
  } catch (error) {
    return fail(error instanceof CandidateQueueError ? error.reason : 'review-failed');
  }
}

/**
 * Link an approved candidate to one reviewed golden-task identifier. Raw task
 * content and task paths are deliberately outside this API. The same link is
 * idempotent; relinking to a different task is refused.
 */
export function linkFailureCandidate(candidateId, taskId, opts = {}) {
  try {
    if (typeof candidateId !== 'string' || !CANDIDATE_ID_PATTERN.test(candidateId)) {
      return fail('invalid-candidate-id');
    }
    if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) return fail('invalid-task-id');
    return withQueueLock(opts, ({ records }) => {
      const candidate = readAllCandidates(records)
        .find(item => item.candidateId === candidateId);
      if (!candidate) return fail('candidate-not-found');
      const filePath = candidateFile(records, candidateId);
      if (candidate.status !== 'approved') return fail('candidate-not-approved');
      if (candidate.link.taskId === taskId) {
        return { ok: true, changed: false, candidate };
      }
      if (candidate.link.taskId !== null) return fail('candidate-already-linked');
      const updated = {
        ...candidate,
        link: { taskId, linkedAt: nowIso(opts) },
      };
      writeCandidate(filePath, updated);
      return { ok: true, changed: true, candidate: updated };
    });
  } catch (error) {
    return fail(error instanceof CandidateQueueError ? error.reason : 'link-failed');
  }
}
