/**
 * Run Artifacts — structured execution records for Atlas/Athena orchestrations.
 *
 * Each run produces:
 * - events.jsonl — timeline of orchestration events (append-only)
 * - task-updates.json + task-updates.anchor.json — strict user follow-up ledger
 * - summary.json — final execution metadata (written at completion)
 * - verification.json — per-story verification results
 *
 * Artifacts live at .ao/artifacts/runs/<runId>/
 */

import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { createHash, randomUUID } from 'crypto';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import {
  appendRegularArtifact,
  bindSafeDirectoryPath,
  ensureSafeDirectoryPath,
  lstatOrMissing,
  readRegularArtifact,
  readRegularArtifactRange,
  revalidateDirectoryBinding,
  revalidateRegularArtifact,
  sameFileGeneration,
  sameFsObject,
  writeExclusiveRegularArtifact,
} from './hardened-fs.mjs';
import { getCurrentSessionId, linkRunToSession } from './session-registry.mjs';
import {
  acquireRunFinalizationLock,
  holdsRunFinalizationLock,
  releaseRunFinalizationLock,
} from './run-finalization-lock.mjs';

const RUNS_BASE = join('.ao', 'artifacts', 'runs');
const STATE_DIR = join('.ao', 'state');
const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const ORCHESTRATOR_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MAX_SUMMARY_BYTES = 256 * 1024;
const MAX_EVENTS_BYTES = 16 * 1024 * 1024;
const MAX_TASK_UPDATES_BYTES = 1024 * 1024;
const MAX_TASK_UPDATES = 1000;
const MAX_POINTER_BYTES = 64 * 1024;
// Listing is an audit convenience, not an unbounded filesystem dump.  Keep
// the normal small-run behavior while preventing a poisoned artifact root from
// turning a status call into an arbitrarily large response.
const MAX_RUN_LIST_ENTRIES = 10_000;
const ACTIVE_POINTER_INTENT_PREFIX = '.active-run-intent-';
const FINALIZATION_CORE_FIELDS = new Set([
  'runId',
  'orchestrator',
  'task',
  'sessionId',
  'startedAt',
  'status',
  'finishedAt',
  'duration_ms',
]);

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? timestamp
    : null;
}

/**
 * Bind the trusted, no-symlink ancestry used by all terminal run finalizers.
 * The returned guard intentionally exposes only resolved paths and a
 * revalidation closure; filesystem identity snapshots remain module-private.
 *
 * @param {string} runId
 * @param {object} [opts]
 * @param {string} [opts.base]
 * @param {string} [opts.trustedRoot]
 * @param {object} [_policy] - Internal pre-hardening policy
 * @param {boolean} [_policy.requirePrivateRunDir=true]
 * @returns {{base:string,dir:string,revalidate:()=>true}}
 */
export function bindRunFinalizationPaths(runId, opts = {}, _policy = {}) {
  if (!RUN_ID_PATTERN.test(runId || '')) throw new Error('invalid run id');
  const base = resolve(opts.base || RUNS_BASE);
  const baseBinding = bindSafeDirectoryPath(base, 'run artifacts base', {
    trustedRoot: opts.trustedRoot,
    requirePrivateMode: true,
  });
  const dir = runDir(runId, base);
  const dirBinding = bindSafeDirectoryPath(dir, 'run directory', {
    trustedRoot: opts.trustedRoot,
    requirePrivateMode: _policy.requirePrivateRunDir !== false,
  });
  const revalidate = () => {
    revalidateDirectoryBinding(baseBinding, 'run artifacts base');
    revalidateDirectoryBinding(dirBinding, 'run directory');
    return true;
  };
  revalidate();
  return Object.freeze({ base, dir, revalidate });
}

function recoverActivePointerPublication(pointerPath) {
  let pointerStat = lstatSync(pointerPath);
  if (pointerStat.nlink === 1) return pointerStat;
  if (!pointerStat.isFile() || pointerStat.isSymbolicLink() || pointerStat.nlink !== 2) {
    throw new Error('active-run pointer publication is unsafe');
  }
  const stateDir = dirname(pointerPath);
  const matches = [];
  for (const name of readdirSync(stateDir)) {
    if (!name.startsWith(ACTIVE_POINTER_INTENT_PREFIX)) continue;
    try {
      const intentPath = join(stateDir, name);
      const stat = lstatSync(intentPath);
      if (stat.isFile() && !stat.isSymbolicLink()
        && (process.platform === 'win32' || (stat.mode & 0o777) === 0o600)
        && sameFsObject(pointerStat, stat)) {
        matches.push(intentPath);
      }
    } catch {}
  }
  if (matches.length !== 1) {
    pointerStat = lstatSync(pointerPath);
    if (pointerStat.nlink === 1) return pointerStat;
    throw new Error('active-run pointer publication is ambiguous');
  }
  try { unlinkSync(matches[0]); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const recovered = lstatSync(pointerPath);
  if (!sameFsObject(pointerStat, recovered) || recovered.nlink !== 1) {
    throw new Error('active-run pointer publication recovery failed');
  }
  return recovered;
}

function publishExclusiveActivePointer(pointerPath, payload, opts = {}) {
  const stateDir = dirname(pointerPath);
  const intentPath = join(stateDir, `${ACTIVE_POINTER_INTENT_PREFIX}${randomUUID()}`);
  const intentStat = writeExclusiveRegularArtifact(
    intentPath, 'active-run pointer intent', payload, MAX_POINTER_BYTES,
  );
  let linked = false;
  try {
    if (typeof opts._beforeActivePointerPublish === 'function') {
      opts._beforeActivePointerPublish(intentPath);
    }
    linkSync(intentPath, pointerPath);
    linked = true;
    const published = lstatSync(pointerPath);
    if (!sameFsObject(intentStat, published) || published.nlink !== 2) {
      throw new Error('active-run pointer publication verification failed');
    }
    if (typeof opts._afterActivePointerLink === 'function') {
      opts._afterActivePointerLink(intentPath);
    }
    try { unlinkSync(intentPath); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return recoverActivePointerPublication(pointerPath);
  } catch (error) {
    if (linked) {
      try {
        const recovered = recoverActivePointerPublication(pointerPath);
        if (sameFsObject(intentStat, recovered)) return recovered;
      } catch {}
    }
    try { unlinkSync(intentPath); } catch {}
    throw error;
  }
}

function validateFinalizationInput(runId, summary) {
  if (!RUN_ID_PATTERN.test(runId || '')) return 'invalid-run-id';
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return 'invalid-finalization-summary';
  if (Object.keys(summary).some(key => FINALIZATION_CORE_FIELDS.has(key))) {
    return 'core-summary-field-override';
  }
  if (Object.hasOwn(summary, 'result') && !['success', 'failure'].includes(summary.result)) {
    return 'invalid-finalization-result';
  }
  if (summary.result !== 'failure'
    && (Object.hasOwn(summary, 'failureCode') || Object.hasOwn(summary, 'failedPhase'))) {
    return 'failure-fields-without-failure-result';
  }
  return null;
}

function validateRunSummaryIdentity(existing, runId, now = Date.now()) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return null;
  if (existing.runId !== runId
    || typeof existing.orchestrator !== 'string'
    || !ORCHESTRATOR_PATTERN.test(existing.orchestrator)) return null;
  const startedAt = canonicalTimestamp(existing.startedAt);
  if (startedAt === null || startedAt > now) return null;
  return { startedAt };
}

function validateCompletedRunSummary(existing, runId, now = Date.now()) {
  const identity = validateRunSummaryIdentity(existing, runId, now);
  if (!identity || existing.status !== 'completed') return false;
  const finishedAt = canonicalTimestamp(existing.finishedAt);
  const resultValid = !Object.hasOwn(existing, 'result') || ['success', 'failure'].includes(existing.result);
  const failureFieldsValid = existing.result === 'failure'
    || (!Object.hasOwn(existing, 'failureCode') && !Object.hasOwn(existing, 'failedPhase'));
  return resultValid
    && failureFieldsValid
    && finishedAt !== null
    && finishedAt >= identity.startedAt
    && finishedAt <= now + 60_000
    && Number.isSafeInteger(existing.duration_ms)
    && existing.duration_ms >= 0
    && existing.duration_ms === finishedAt - identity.startedAt;
}

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
  if (!RUN_ID_PATTERN.test(runId || '')) throw new Error('invalid run id');
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

function isSafeActiveIdentity(orchestrator, runId) {
  return ORCHESTRATOR_PATTERN.test(orchestrator || '')
    && RUN_ID_PATTERN.test(runId || '')
    && runId.startsWith(`${orchestrator}-`);
}

function validateActivePointerData(data, orchestrator) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const keys = ['runId', 'orchestrator', 'startedAt'];
  if (Object.keys(data).length !== keys.length || !keys.every(key => Object.hasOwn(data, key))) {
    return false;
  }
  const startedAt = canonicalTimestamp(data.startedAt);
  return data.orchestrator === orchestrator
    && isSafeActiveIdentity(orchestrator, data.runId)
    && startedAt !== null
    && startedAt <= Date.now() + 60_000;
}

/**
 * Get the active runId for an orchestrator.
 * Returns null if no active run exists. Never throws.
 *
 * @param {string} orchestrator - 'atlas' | 'athena'
 * @param {object} [opts]
 * @param {string} [opts.stateDir] - Override state directory (for testing)
 * @param {string} [opts.trustedRoot] - Explicit ancestry anchor for custom paths
 * @returns {string|null}
 */
export function getActiveRunId(orchestrator, opts = {}) {
  try {
    if (!ORCHESTRATOR_PATTERN.test(orchestrator || '')) return null;
    const stateDir = resolve(opts.stateDir || STATE_DIR);
    const binding = bindOptionalStateDirectory(stateDir, opts.trustedRoot);
    if (!binding) return null;
    const pointer = readActivePointer(binding, orchestrator);
    return pointer.present && validateActivePointerData(pointer.data, orchestrator)
      ? pointer.data.runId
      : null;
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
 * @param {string} [opts.trustedRoot] - Explicit ancestry anchor for custom paths
 * @param {boolean} [opts.replace=false] - Explicit admin/test pointer replacement
 * @param {string} [opts.startedAt] - Exact run start timestamp used by createRun
 * @returns {{ok:boolean,created?:boolean,replaced?:boolean,reason?:string}}
 */
export function setActiveRunId(orchestrator, runId, opts = {}) {
  try {
    if (!isSafeActiveIdentity(orchestrator, runId)) {
      return { ok: false, reason: 'invalid-active-run-identity' };
    }
    const startedAt = opts.startedAt || new Date().toISOString();
    if (canonicalTimestamp(startedAt) === null || Date.parse(startedAt) > Date.now() + 60_000) {
      return { ok: false, reason: 'invalid-active-run-timestamp' };
    }
    const stateDir = resolve(opts.stateDir || STATE_DIR);
    const binding = ensureSafeDirectoryPath(stateDir, 'run state directory', {
      trustedRoot: opts.trustedRoot,
      requirePrivateMode: true,
    });
    const pointerPath = activeRunPath(orchestrator, stateDir);
    const data = { runId, orchestrator, startedAt };
    const payload = JSON.stringify(data, null, 2);
    revalidateDirectoryBinding(binding, 'run state directory');

    if (opts.replace === true) {
      const before = readActivePointer(binding, orchestrator);
      if (!before.present) {
        const createdStat = publishExclusiveActivePointer(pointerPath, payload, opts);
        const current = readActivePointer(binding, orchestrator);
        if (!current.present || !sameFileGeneration(createdStat, current.stat)
          || !validateActivePointerData(current.data, orchestrator)
          || current.data.runId !== runId) {
          throw new Error('active-run pointer claim verification failed');
        }
        return { ok: true, created: true, replaced: false };
      }
      revalidateDirectoryBinding(binding, 'run state directory');
      revalidateRegularArtifact(
        pointerPath, before.stat, 'active-run pointer', MAX_POINTER_BYTES,
      );
      atomicWriteFileSync(pointerPath, payload, { mode: 0o600 });
      const current = readActivePointer(binding, orchestrator);
      if (!current.present || !validateActivePointerData(current.data, orchestrator)
        || current.data.runId !== runId) {
        throw new Error('active-run pointer replacement verification failed');
      }
      return { ok: true, created: false, replaced: true };
    }

    let claimed;
    try {
      claimed = publishExclusiveActivePointer(pointerPath, payload, opts);
    } catch (error) {
      if (error?.code === 'EEXIST') return { ok: false, reason: 'active-run-exists' };
      throw error;
    }
    revalidateDirectoryBinding(binding, 'run state directory');
    const current = readActivePointer(binding, orchestrator);
    if (!current.present || !sameFileGeneration(claimed, current.stat)
      || !validateActivePointerData(current.data, orchestrator)
      || current.data.runId !== runId) {
      try {
        const stat = lstatSync(pointerPath);
        if (!stat.isSymbolicLink() && sameFsObject(claimed, stat)) unlinkSync(pointerPath);
      } catch {}
      return { ok: false, reason: 'active-run-claim-verification-failed' };
    }
    return { ok: true, created: true, replaced: false };
  } catch {
    return { ok: false, reason: 'active-run-write-failed' };
  }
}

function bindOptionalStateDirectory(stateDir, trustedRoot) {
  try {
    return bindSafeDirectoryPath(stateDir, 'run state directory', {
      trustedRoot,
      // Legacy projects may have a 0755 .ao/state directory. The ancestry and
      // pointer file are still no-follow and identity-bound; new state writes
      // continue to use the documented private modes.
      requirePrivateMode: false,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function readActivePointer(binding, orchestrator) {
  if (!binding) return { present: false, data: null, stat: null };
  revalidateDirectoryBinding(binding, 'run state directory');
  const pointerPath = activeRunPath(orchestrator, binding.path);
  if (lstatOrMissing(pointerPath)) recoverActivePointerPublication(pointerPath);
  const file = readRegularArtifact(
    pointerPath,
    'active-run pointer',
    MAX_POINTER_BYTES,
    { allowMissing: true },
  );
  if (!file.present) return { present: false, data: null, stat: null };
  let data;
  try { data = JSON.parse(file.text); }
  catch { throw new Error('active-run pointer is invalid'); }
  if (!validateActivePointerData(data, orchestrator)) {
    throw new Error('active-run pointer identity mismatch');
  }
  return { present: true, data, stat: file.stat };
}

function preflightActiveRunPointer(orchestrator, opts = {}) {
  const stateDir = resolve(opts.stateDir || STATE_DIR);
  const binding = bindOptionalStateDirectory(stateDir, opts.trustedRoot);
  return {
    stateDir,
    binding,
    pointer: readActivePointer(binding, orchestrator),
  };
}

/**
 * Bind an active-run pointer without following either its state-directory
 * ancestry or the pointer leaf. `required:true` additionally proves that the
 * exact run/orchestrator pointer generation is still present.
 *
 * @param {string} runId
 * @param {string} orchestrator
 * @param {object} [opts]
 * @returns {{stateDir:string,revalidate:(options?:{required?:boolean})=>boolean,verifyRemoved:()=>boolean}}
 */
export function bindRunFinalizationPointer(runId, orchestrator, opts = {}) {
  if (!RUN_ID_PATTERN.test(runId || '') || !ORCHESTRATOR_PATTERN.test(orchestrator || '')) {
    throw new Error('invalid active-run pointer identity');
  }
  const preflight = preflightActiveRunPointer(orchestrator, opts);
  const revalidate = ({ required = false } = {}) => {
    if (!preflight.binding) {
      if (bindOptionalStateDirectory(preflight.stateDir, opts.trustedRoot)
        || required || preflight.pointer.present) {
        throw new Error('active-run pointer is missing or unsafe');
      }
      return false;
    }
    revalidateDirectoryBinding(preflight.binding, 'run state directory');
    const current = readActivePointer(preflight.binding, orchestrator);
    if (!current.present) {
      if (required || preflight.pointer.present) throw new Error('active-run pointer changed');
      return false;
    }
    if (!preflight.pointer.present
      || preflight.pointer.data.runId !== runId
      || preflight.pointer.data.orchestrator !== orchestrator
      || current.data.runId !== runId
      || current.data.orchestrator !== orchestrator
      || !sameFileGeneration(current.stat, preflight.pointer.stat)) {
      throw new Error('active-run pointer identity mismatch');
    }
    return true;
  };
  const verifyRemoved = () => {
    if (!preflight.binding) {
      return bindOptionalStateDirectory(preflight.stateDir, opts.trustedRoot) === null;
    }
    revalidateDirectoryBinding(preflight.binding, 'run state directory');
    return lstatOrMissing(activeRunPath(orchestrator, preflight.stateDir)) === null;
  };
  return Object.freeze({ stateDir: preflight.stateDir, revalidate, verifyRemoved });
}

/** Compare-and-delete a preflighted pointer without following linked paths. */
function clearActiveRunId(orchestrator, runId, preflight, opts = {}) {
  try {
    let binding = preflight.binding;
    if (!binding) {
      binding = bindOptionalStateDirectory(preflight.stateDir, opts.trustedRoot);
      if (!binding) return true;
    } else {
      revalidateDirectoryBinding(binding, 'run state directory');
    }
    const current = readActivePointer(binding, orchestrator);
    if (!current.present) return true;
    if (current.data.runId !== runId || current.data.orchestrator !== orchestrator) return true;
    if (!preflight.pointer.present
      || preflight.pointer.data.runId !== runId
      || preflight.pointer.data.orchestrator !== orchestrator
      || !sameFileGeneration(current.stat, preflight.pointer.stat)) return false;
    const filePath = activeRunPath(orchestrator, binding.path);
    revalidateDirectoryBinding(binding, 'run state directory');
    revalidateRegularArtifact(filePath, current.stat, 'active-run pointer', MAX_POINTER_BYTES);
    unlinkSync(filePath);
    return lstatOrMissing(filePath) === null;
  } catch { return false; }
}

function readRunEventFile(eventsPath) {
  try {
    const file = readRegularArtifact(eventsPath, 'run events', MAX_EVENTS_BYTES, {
      allowMissing: true,
      allowEmpty: true,
    });
    return {
      // Event logs are append-only audit trails. A torn record is ignored, but
      // valid records after it remain authoritative and visible to finalizers.
      events: file.present ? parseJsonLines(file.text, { skipInvalid: true }) : [],
      stat: file.stat,
    };
  } catch { return null; }
}

function readRunEvents(eventsPath) {
  return readRunEventFile(eventsPath)?.events ?? null;
}

function ensureRunFinalizedEvent(runId, dir, summary) {
  const eventsPath = join(dir, 'events.jsonl');
  const eventFile = readRunEventFile(eventsPath);
  if (!eventFile) return false;
  let { events } = eventFile;
  let eofStat = eventFile.stat;
  let finalized = events.filter(event => event?.type === 'run_finalized');
  if (finalized.length === 0) {
    const event = {
      type: 'run_finalized',
      detail: {
        status: 'completed',
        storiesCompleted: summary.storiesCompleted ?? null,
        duration_ms: summary.duration_ms,
      },
      timestamp: new Date().toISOString(),
    };
    try {
      const appended = appendRegularArtifact(
        eventsPath,
        'run events',
        `${JSON.stringify(event)}\n`,
        MAX_EVENTS_BYTES,
        {
          ensureLineBoundary: true,
          expectedStat: eventFile.stat,
        },
      );
      const tail = readRegularArtifactRange(eventsPath, 'run events', MAX_EVENTS_BYTES, {
        ...appended,
        expectedStat: appended.stat,
        allowEmpty: true,
        requireEof: true,
      });
      const appendedEvents = parseJsonLines(tail.text);
      if (appendedEvents.length !== 1 || appendedEvents[0]?.type !== 'run_finalized') {
        return false;
      }
      events = [...events, appendedEvents[0]];
      eofStat = tail.stat;
    } catch {
      return false;
    }
    finalized = events.filter(item => item?.type === 'run_finalized');
  }
  if (finalized.length !== 1 || events.at(-1) !== finalized[0]) return false;
  try {
    revalidateRegularArtifact(eventsPath, eofStat, 'run events', MAX_EVENTS_BYTES, {
      allowEmpty: true,
    });
  } catch {
    return false;
  }
  const event = finalized[0];
  const timestamp = Date.parse(event.timestamp);
  return event.detail?.status === 'completed'
    && event.detail.duration_ms === summary.duration_ms
    && event.detail.storiesCompleted === (summary.storiesCompleted ?? null)
    && Number.isFinite(timestamp)
    && timestamp >= Date.parse(summary.finishedAt);
}

function acquireRunningRunMutation(runId, opts = {}) {
  let owner = null;
  let owned = false;
  let dir = null;
  try {
    if (!RUN_ID_PATTERN.test(runId || '')) throw new Error('invalid run id');
    const base = resolve(opts.base || RUNS_BASE);
    const baseBinding = bindSafeDirectoryPath(base, 'run artifacts base', {
      trustedRoot: opts.trustedRoot,
      requirePrivateMode: false,
    });
    dir = runDir(runId, base);
    const dirBinding = bindSafeDirectoryPath(dir, 'run directory', {
      trustedRoot: opts.trustedRoot,
      requirePrivateMode: true,
    });

    if (opts._runLockOwner) {
      if (!holdsRunFinalizationLock(dir, opts._runLockOwner)) {
        throw new Error('run transition lock is not held');
      }
      owner = opts._runLockOwner;
    } else {
      owner = acquireRunFinalizationLock(dir);
      owned = true;
    }

    revalidateDirectoryBinding(baseBinding, 'run artifacts base');
    revalidateDirectoryBinding(dirBinding, 'run directory');
    const summaryPath = join(dir, 'summary.json');
    const summaryFile = readRegularArtifact(summaryPath, 'run summary', MAX_SUMMARY_BYTES);
    let summary;
    try { summary = JSON.parse(summaryFile.text); }
    catch { throw new Error('run summary is invalid'); }
    if (!validateRunSummaryIdentity(summary, runId) || summary.status !== 'running') {
      throw new Error('run is not active');
    }
    return {
      baseBinding,
      dir,
      dirBinding,
      owned,
      owner,
      summary,
      summaryFile,
      summaryPath,
    };
  } catch (error) {
    if (owned && owner && dir) releaseRunFinalizationLock(dir, owner);
    throw error;
  }
}

function revalidateRunningRunMutation(mutation) {
  revalidateDirectoryBinding(mutation.baseBinding, 'run artifacts base');
  revalidateDirectoryBinding(mutation.dirBinding, 'run directory');
  revalidateRegularArtifact(
    mutation.summaryPath,
    mutation.summaryFile.stat,
    'run summary',
    MAX_SUMMARY_BYTES,
  );
}

function releaseRunningRunMutation(mutation) {
  if (mutation?.owned && mutation.owner && mutation.dir) {
    releaseRunFinalizationLock(mutation.dir, mutation.owner);
  }
}

/**
 * Discover which orchestrator has an active run.
 * Checks both atlas and athena; if both exist, returns the most recent.
 * Returns { orchestrator, runId } or null.
 *
 * @param {object} [opts]
 * @param {string} [opts.stateDir] - Override state directory (for testing)
 * @param {string} [opts.trustedRoot] - Explicit ancestry anchor for custom paths
 * @returns {{ orchestrator: string, runId: string }|null}
 */
export function discoverActiveRun(opts = {}) {
  try {
    const stateDir = resolve(opts.stateDir || STATE_DIR);
    const candidates = [];
    for (const orch of ['atlas', 'athena']) {
      try {
        const binding = bindOptionalStateDirectory(stateDir, opts.trustedRoot);
        if (!binding) continue;
        const pointer = readActivePointer(binding, orch);
        if (pointer.present && validateActivePointerData(pointer.data, orch)) {
          candidates.push({
            orchestrator: orch,
            runId: pointer.data.runId,
            startedAt: pointer.data.startedAt,
          });
        }
      } catch {
        // Invalid, linked, or absent pointers are never active.
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
 * @param {string} [opts.stateDir] - Required with a custom base when activate is true
 * @param {string} [opts.trustedRoot] - Explicit ancestry anchor for custom paths
 * @param {boolean} [opts.activate=true] - Set false for isolated historical/test runs
 * @returns {{ok:true,runId:string,runDir:string}|{ok:false,runId:null,runDir:'',reason:string}}
 */
export function createRun(orchestrator, taskDescription, opts = {}) {
  let dir = null;
  let summaryStat = null;
  const failed = reason => ({ ok: false, runId: null, runDir: '', reason });
  const cleanup = () => {
    if (!dir) return;
    const summaryPath = join(dir, 'summary.json');
    if (summaryStat) {
      try {
        const current = lstatSync(summaryPath);
        if (!current.isSymbolicLink() && sameFsObject(summaryStat, current)) unlinkSync(summaryPath);
      } catch {}
    }
    try { rmdirSync(dir); } catch {}
  };
  try {
    if (!ORCHESTRATOR_PATTERN.test(orchestrator || '')) return failed('invalid-orchestrator');
    if (typeof taskDescription !== 'string') return failed('invalid-task-description');
    const base = resolve(opts.base || RUNS_BASE);
    const customBase = Object.hasOwn(opts, 'base') && base !== resolve(RUNS_BASE);
    const activate = opts.activate !== false;
    if (customBase && activate && !opts.stateDir) return failed('custom-state-dir-required');

    let baseBinding;
    try {
      baseBinding = ensureSafeDirectoryPath(base, 'run artifacts base', {
        trustedRoot: opts.trustedRoot,
        requirePrivateMode: true,
      });
    } catch {
      return failed('unsafe-run-base');
    }
    const now = new Date();
    const runId = `${orchestrator}-${formatDate(now)}-${formatTime(now)}-${rand4()}`;
    if (!isSafeActiveIdentity(orchestrator, runId)) return failed('invalid-run-identity');
    dir = runDir(runId, base);

    try { mkdirSync(dir, { mode: 0o700 }); }
    catch { return failed('run-directory-create-failed'); }
    let runBinding;
    try {
      revalidateDirectoryBinding(baseBinding, 'run artifacts base');
      runBinding = bindSafeDirectoryPath(dir, 'run directory', {
        trustedRoot: opts.trustedRoot,
        requirePrivateMode: true,
      });
    } catch {
      cleanup();
      return failed('unsafe-run-directory');
    }

    // Link to current Claude Code session if available
    const stateDir = opts.stateDir ? resolve(opts.stateDir) : resolve(STATE_DIR);
    const sessionId = (!customBase || opts.stateDir)
      ? getCurrentSessionId({ stateBase: stateDir })
      : null;

    const summary = {
      runId,
      orchestrator,
      task: taskDescription,
      startedAt: now.toISOString(),
      status: 'running',
      ...(sessionId ? { sessionId } : {}),
    };

    try {
      revalidateDirectoryBinding(baseBinding, 'run artifacts base');
      revalidateDirectoryBinding(runBinding, 'run directory');
      summaryStat = writeExclusiveRegularArtifact(
        join(dir, 'summary.json'),
        'run summary',
        JSON.stringify(summary, null, 2),
        MAX_SUMMARY_BYTES,
      );
    } catch {
      cleanup();
      return failed('summary-write-failed');
    }

    // Write active-run pointer (US-001)
    if (activate) {
      const claimed = setActiveRunId(orchestrator, runId, {
        stateDir,
        trustedRoot: opts.trustedRoot,
        startedAt: summary.startedAt,
      });
      if (!claimed.ok) {
        cleanup();
        return failed(claimed.reason || 'active-run-claim-failed');
      }
    }

    // Link run to session record (cross-reference)
    if (sessionId) {
      try { linkRunToSession(runId, { stateBase: stateDir }); } catch {}
    }

    return { ok: true, runId, runDir: dir };
  } catch {
    cleanup();
    return failed('create-run-failed');
  }
}

/**
 * Append a timestamped event to events.jsonl for the given run.
 *
 * @param {string} runId
 * @param {{ phase: string, type: string, detail: * }} event
 * @param {object} [opts]
 * @param {string} [opts.base] - Override base directory (for testing)
 * @param {string} [opts.trustedRoot] - Explicit ancestry anchor for custom paths
 * @param {object} [opts._runLockOwner] - Existing shared transition-lock owner
 */
export function addEvent(runId, event, opts = {}) {
  let mutation = null;
  try {
    if (!event || typeof event !== 'object' || Array.isArray(event)
      || event.type === 'run_finalized') return;
    mutation = acquireRunningRunMutation(runId, opts);
    const line = JSON.stringify({ ...event, timestamp: new Date().toISOString() });
    revalidateRunningRunMutation(mutation);
    appendRegularArtifact(
      join(mutation.dir, 'events.jsonl'),
      'run events',
      `${line}\n`,
      MAX_EVENTS_BYTES,
      { ensureLineBoundary: true },
    );
  } catch {
    // fail-safe: event loss is acceptable, never throw
  } finally {
    releaseRunningRunMutation(mutation);
  }
}

function validateTaskUpdateLedger(value, summary) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1
    || value.runId !== summary?.runId
    || value.orchestrator !== summary?.orchestrator
    || !Array.isArray(value.updates)
    || value.updates.length === 0
    || value.updates.length > MAX_TASK_UPDATES) {
    return false;
  }
  return value.updates.every((update, index) => (
    update
    && typeof update === 'object'
    && !Array.isArray(update)
    && Object.keys(update).length === 3
    && update.sequence === index + 1
    && typeof update.task === 'string'
    && update.task.trim().length > 0
    && Buffer.byteLength(update.task, 'utf8') <= 64 * 1024
    && canonicalTimestamp(update.timestamp) !== null
  ));
}

function taskUpdateLedgerHash(ledger) {
  return createHash('sha256').update(JSON.stringify(ledger)).digest('hex');
}

function validateTaskUpdateAnchor(value, summary, ledger) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 5
    && value.schemaVersion === 1
    && value.runId === summary?.runId
    && value.orchestrator === summary?.orchestrator
    && value.sequence === ledger.updates.length
    && typeof value.ledgerHash === 'string'
    && /^[a-f0-9]{64}$/.test(value.ledgerHash)
    && value.ledgerHash === taskUpdateLedgerHash(ledger);
}

function buildTaskUpdateAnchor(summary, ledger) {
  return {
    schemaVersion: 1,
    runId: summary.runId,
    orchestrator: summary.orchestrator,
    sequence: ledger.updates.length,
    ledgerHash: taskUpdateLedgerHash(ledger),
  };
}

function recoverPendingTaskUpdateAnchor(paths, summary, ledger, anchor) {
  const prefixLedger = {
    ...ledger,
    updates: ledger.updates.slice(0, -1),
  };
  const isRecoverableFirstAppend = anchor === null
    && ledger.updates.length === 1
    && ledger.updates[0].task === summary.task;
  const isRecoverableLaterAppend = anchor !== null
    && ledger.updates.length > 1
    && validateTaskUpdateAnchor(anchor, summary, prefixLedger);
  if (!isRecoverableFirstAppend && !isRecoverableLaterAppend) return false;

  paths.revalidate();
  atomicWriteFileSync(
    join(paths.dir, 'task-updates.anchor.json'),
    JSON.stringify(buildTaskUpdateAnchor(summary, ledger), null, 2),
    { mode: 0o600, durable: true },
  );
  paths.revalidate();
  const repairedArtifact = readBoundRunArtifact(
    paths,
    'task-updates.anchor.json',
    'run task updates anchor',
    MAX_POINTER_BYTES,
  );
  let repaired;
  try { repaired = JSON.parse(repairedArtifact.text); }
  catch { return false; }
  return validateTaskUpdateAnchor(repaired, summary, ledger);
}

function readTaskUpdateLedger(paths, summary, {
  allowMissing = false,
  recoverPendingAppend = false,
} = {}) {
  const artifact = readBoundRunArtifact(
    paths,
    'task-updates.json',
    'run task updates',
    MAX_TASK_UPDATES_BYTES,
    { allowMissing: true },
  );
  const anchorArtifact = readBoundRunArtifact(
    paths,
    'task-updates.anchor.json',
    'run task updates anchor',
    MAX_POINTER_BYTES,
    { allowMissing: true },
  );
  if (!artifact.present && !anchorArtifact.present && allowMissing) return null;
  if (!artifact.present) throw new Error('run task updates ledger is missing');
  let ledger;
  try { ledger = JSON.parse(artifact.text); }
  catch { throw new Error('run task updates are invalid JSON'); }
  if (!validateTaskUpdateLedger(ledger, summary)) {
    throw new Error('run task updates are malformed');
  }
  let anchor = null;
  if (anchorArtifact.present) {
    try { anchor = JSON.parse(anchorArtifact.text); }
    catch { throw new Error('run task updates anchor is invalid JSON'); }
  }
  if (!validateTaskUpdateAnchor(anchor, summary, ledger)) {
    if (recoverPendingAppend
      && recoverPendingTaskUpdateAnchor(paths, summary, ledger, anchor)) {
      return ledger;
    }
    if (!anchorArtifact.present) {
      throw new Error('run task updates anchor is missing');
    }
    throw new Error('run task updates rollback or anchor mismatch detected');
  }
  return ledger;
}

/**
 * Atomically append one user-authored task update to a dedicated strict
 * ledger. Shipping policy reads this file instead of the best-effort event
 * stream, whose audit-oriented parser intentionally skips torn JSONL records.
 *
 * `allowCreate` must be true only on the same invocation that created the run.
 * A missing ledger on resume fails closed so lost history cannot silently
 * re-enable release side effects.
 *
 * @param {string} runId
 * @param {string} task
 * @param {object} [opts]
 * @param {string} [opts.base]
 * @param {string} [opts.trustedRoot]
 * @param {boolean} [opts.allowCreate=false]
 * @returns {{ok:boolean,updates?:object[],reason?:string}}
 */
export function appendUserTaskUpdate(runId, task, opts = {}) {
  let mutation = null;
  try {
    if (typeof task !== 'string' || !task.trim()
      || Buffer.byteLength(task, 'utf8') > 64 * 1024) {
      return { ok: false, reason: 'invalid-task-update' };
    }
    mutation = acquireRunningRunMutation(runId, opts);
    const paths = {
      dir: mutation.dir,
      revalidate: () => {
        revalidateRunningRunMutation(mutation);
        return true;
      },
    };
    const existing = readTaskUpdateLedger(paths, mutation.summary, {
      allowMissing: opts.allowCreate === true,
      recoverPendingAppend: true,
    });
    if (!existing && opts.allowCreate !== true) {
      return { ok: false, reason: 'task-update-ledger-missing' };
    }
    const updates = existing?.updates ?? [];
    if (updates.length >= MAX_TASK_UPDATES) {
      return { ok: false, reason: 'task-update-limit-reached' };
    }
    const next = {
      sequence: updates.length + 1,
      task,
      timestamp: new Date().toISOString(),
    };
    const ledger = {
      schemaVersion: 1,
      runId,
      orchestrator: mutation.summary.orchestrator,
      updates: [...updates, next],
    };
    const payload = JSON.stringify(ledger, null, 2);
    if (Buffer.byteLength(payload, 'utf8') > MAX_TASK_UPDATES_BYTES) {
      return { ok: false, reason: 'task-update-ledger-too-large' };
    }
    const anchor = buildTaskUpdateAnchor(mutation.summary, ledger);
    revalidateRunningRunMutation(mutation);
    atomicWriteFileSync(join(mutation.dir, 'task-updates.json'), payload, {
      mode: 0o600,
      durable: true,
    });
    revalidateRunningRunMutation(mutation);
    atomicWriteFileSync(
      join(mutation.dir, 'task-updates.anchor.json'),
      JSON.stringify(anchor, null, 2),
      { mode: 0o600, durable: true },
    );
    revalidateRunningRunMutation(mutation);
    const persisted = readTaskUpdateLedger(paths, mutation.summary);
    if (!persisted
      || persisted.updates.length !== updates.length + 1
      || persisted.updates.at(-1)?.sequence !== next.sequence
      || persisted.updates.at(-1)?.task !== task) {
      return { ok: false, reason: 'task-update-verification-failed' };
    }

    // Keep the general event stream useful for diagnostics, but never rely on
    // it for release policy. A torn audit append cannot erase the strict ledger.
    try {
      appendRegularArtifact(
        join(mutation.dir, 'events.jsonl'),
        'run events',
        `${JSON.stringify({
          phase: 'run',
          type: 'user_task_update',
          detail: { sequence: next.sequence, task },
          timestamp: next.timestamp,
        })}\n`,
        MAX_EVENTS_BYTES,
        {
          ensureLineBoundary: true,
          revalidateContext: paths.revalidate,
        },
      );
    } catch {}
    return { ok: true, updates: persisted.updates };
  } catch (error) {
    return { ok: false, reason: error?.message || 'task-update-append-failed' };
  } finally {
    releaseRunningRunMutation(mutation);
  }
}

/**
 * Strictly read the atomic user-task ledger used by shipping policy.
 * Missing, linked, malformed, oversized, or identity-mismatched data fails
 * closed instead of being projected to an empty history.
 *
 * @param {string} runId
 * @param {object} [opts]
 * @returns {{ok:boolean,updates:object[],reason?:string}}
 */
export function getUserTaskUpdates(runId, opts = {}) {
  try {
    const paths = bindRunReadPaths(runId, opts);
    const summaryArtifact = readBoundRunArtifact(
      paths,
      'summary.json',
      'run summary',
      MAX_SUMMARY_BYTES,
    );
    const summary = JSON.parse(summaryArtifact.text);
    if (!validateRunSummaryIdentity(summary, runId)) {
      return { ok: false, updates: [], reason: 'run-summary-invalid' };
    }
    const ledger = readTaskUpdateLedger(paths, summary);
    return { ok: true, updates: ledger.updates };
  } catch (error) {
    return {
      ok: false,
      updates: [],
      reason: error?.message || 'task-update-read-failed',
    };
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
 * @param {string} [opts.trustedRoot] - Explicit ancestry anchor for custom paths
 * @param {object} [opts._runLockOwner] - Existing shared transition-lock owner
 */
export function addVerification(runId, result, opts = {}) {
  let mutation = null;
  try {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return;
    mutation = acquireRunningRunMutation(runId, opts);
    const filePath = join(mutation.dir, 'verification.jsonl');
    const line = JSON.stringify({ ...result, timestamp: result.timestamp || new Date().toISOString() });
    revalidateRunningRunMutation(mutation);
    appendRegularArtifact(filePath, 'run verifications', `${line}\n`, MAX_EVENTS_BYTES);

    // Emit verification_result event with full payload (US-006)
    const activeRunId = getActiveRunId(mutation.summary.orchestrator, {
      stateDir: opts.stateDir || STATE_DIR,
    });
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
      }, {
        base: opts.base || RUNS_BASE,
        trustedRoot: opts.trustedRoot,
        _runLockOwner: mutation.owner,
      });
    }
  } catch {
    // fail-safe: verification loss is acceptable, never throw
  } finally {
    releaseRunningRunMutation(mutation);
  }
}

/**
 * Finalize a run by merging summary data and recording finish time/duration.
 *
 * @param {string} runId
 * @param {object} summary - Additional fields to merge (e.g. storiesCompleted, errors)
 * @param {object} [opts]
 * @param {string} [opts.base] - Override base directory (for testing)
 * @param {string} [opts.stateDir] - Override active-run state directory
 * @param {string} [opts.trustedRoot] - Explicit ancestry anchor for custom paths outside cwd/tmp
 */
export function finalizeRun(runId, summary, opts = {}) {
  let finalizationOwner = null;
  let ownsFinalizationLock = false;
  let dir = null;
  try {
    const inputError = validateFinalizationInput(runId, summary);
    if (inputError) return { ok: false, reason: inputError };
    const pathGuard = bindRunFinalizationPaths(runId, opts);
    dir = pathGuard.dir;
    const filePath = join(dir, 'summary.json');

    if (opts._finalizationLockOwner) {
      if (!holdsRunFinalizationLock(dir, opts._finalizationLockOwner)) {
        return { ok: false, reason: 'finalization-lock-not-held' };
      }
      finalizationOwner = opts._finalizationLockOwner;
    } else {
      finalizationOwner = acquireRunFinalizationLock(dir);
      ownsFinalizationLock = true;
    }
    pathGuard.revalidate();

    const summaryFile = readRegularArtifact(filePath, 'run summary', MAX_SUMMARY_BYTES);
    let existing;
    try { existing = JSON.parse(summaryFile.text); }
    catch { return { ok: false, reason: 'run-summary-invalid' }; }
    if (readRunEvents(join(dir, 'events.jsonl')) === null) {
      return { ok: false, reason: 'run-events-invalid' };
    }

    if (existing.status === 'completed') {
      if (!validateCompletedRunSummary(existing, runId)) {
        return { ok: false, reason: 'completed-run-summary-invalid' };
      }
      if ((existing.result === 'failure' || summary.result === 'failure')
        && (!opts._finalizationLockOwner || !existsSync(join(dir, 'terminal-failure.json')))) {
        return { ok: false, reason: 'failure-finalization-not-authorized' };
      }
      const pointerPreflight = preflightActiveRunPointer(existing.orchestrator, opts);
      const sameResult = Object.entries(summary || {}).every(([key, value]) => existing[key] === value);
      pathGuard.revalidate();
      revalidateRegularArtifact(filePath, summaryFile.stat, 'run summary', MAX_SUMMARY_BYTES);
      if (sameResult && !ensureRunFinalizedEvent(runId, dir, existing)) {
        return { ok: false, reason: 'finalization-event-not-durable' };
      }
      pathGuard.revalidate();
      if (sameResult && existing.orchestrator) {
        if (!clearActiveRunId(existing.orchestrator, runId, pointerPreflight, opts)) {
          return { ok: false, reason: 'active-run-pointer-not-cleared' };
        }
      }
      return sameResult
        ? { ok: true, idempotent: true }
        : { ok: false, reason: 'run-already-finalized' };
    }
    if (existing.status !== 'running') {
      return { ok: false, reason: 'run-not-active' };
    }
    const identity = validateRunSummaryIdentity(existing, runId);
    if (!identity) {
      return { ok: false, reason: 'running-run-summary-invalid' };
    }
    const pointerPreflight = preflightActiveRunPointer(existing.orchestrator, opts);
    if (summary.result === 'failure'
      && (!opts._finalizationLockOwner || !existsSync(join(dir, 'terminal-failure.json')))) {
      return { ok: false, reason: 'failure-finalization-not-authorized' };
    }
    // A published failure marker owns result classification. A concurrent
    // success path must not overwrite it.
    if (summary?.result !== 'failure' && existsSync(join(dir, 'terminal-failure.json'))) {
      return { ok: false, reason: 'terminal-failure-published' };
    }

    const finishedAt = new Date().toISOString();
    const duration_ms = Date.parse(finishedAt) - identity.startedAt;
    if (!Number.isSafeInteger(duration_ms) || duration_ms < 0) {
      return { ok: false, reason: 'run-duration-invalid' };
    }

    const updated = {
      ...existing,
      ...summary,
      finishedAt,
      duration_ms,
      status: 'completed',
    };

    pathGuard.revalidate();
    revalidateRegularArtifact(filePath, summaryFile.stat, 'run summary', MAX_SUMMARY_BYTES);
    atomicWriteFileSync(filePath, JSON.stringify(updated, null, 2));
    pathGuard.revalidate();
    const persistedFile = readRegularArtifact(filePath, 'run summary', MAX_SUMMARY_BYTES);
    let persisted;
    try { persisted = JSON.parse(persistedFile.text); }
    catch { return { ok: false, reason: 'finalized-summary-not-durable' }; }
    if (JSON.stringify(persisted) !== JSON.stringify(updated)) {
      return { ok: false, reason: 'finalized-summary-not-durable' };
    }

    if (!ensureRunFinalizedEvent(runId, dir, updated)) {
      return { ok: false, reason: 'finalization-event-not-durable' };
    }
    pathGuard.revalidate();

    // Clear active-run pointer with compare-and-delete (US-001 + Codex fix #6)
    const orchestrator = existing.orchestrator;
    if (orchestrator) {
      if (!clearActiveRunId(orchestrator, runId, pointerPreflight, opts)) {
        return { ok: false, reason: 'active-run-pointer-not-cleared' };
      }
    }
    return { ok: true, idempotent: false };
  } catch {
    // fail-safe: finalization failure is logged but never throws
    return { ok: false, reason: 'finalization-failed' };
  } finally {
    if (ownsFinalizationLock && finalizationOwner && dir) {
      releaseRunFinalizationLock(dir, finalizationOwner);
    }
  }
}

function emptyRunRecord() {
  return { summary: {}, events: [], verifications: [] };
}

/**
 * Bind a run read to its intended, non-linked artifact tree.  Read callers
 * deliberately accept legacy directory modes, but never linked ancestry: a
 * status/replay request must not be able to follow an attacker-controlled
 * redirect outside the artifact root.
 */
function bindRunReadPaths(runId, opts = {}) {
  if (!RUN_ID_PATTERN.test(runId || '')) throw new Error('invalid run id');
  const base = resolve(opts.base || RUNS_BASE);
  const baseBinding = bindSafeDirectoryPath(base, 'run artifacts base', {
    trustedRoot: opts.trustedRoot,
    requirePrivateMode: false,
  });
  const dir = runDir(runId, base);
  const dirBinding = bindSafeDirectoryPath(dir, 'run directory', {
    trustedRoot: opts.trustedRoot,
    requirePrivateMode: false,
  });
  const revalidate = () => {
    revalidateDirectoryBinding(baseBinding, 'run artifacts base');
    revalidateDirectoryBinding(dirBinding, 'run directory');
    return true;
  };
  revalidate();
  return Object.freeze({ base, dir, revalidate });
}

/** Read a fixed artifact leaf after proving/re-proving its directory chain. */
function readBoundRunArtifact(paths, fileName, label, maxBytes, options = {}) {
  paths.revalidate();
  const filePath = join(paths.dir, fileName);
  const artifact = readRegularArtifact(filePath, label, maxBytes, options);
  // The no-follow read protects the leaf; repeat both checks before exposing
  // data so a directory/leaf replacement race fails closed instead of leaking
  // a value read through a redirected path.
  paths.revalidate();
  if (artifact.present) {
    revalidateRegularArtifact(
      filePath,
      artifact.stat,
      label,
      maxBytes,
      { allowEmpty: options.allowEmpty === true },
    );
    paths.revalidate();
  }
  return artifact;
}

function parseJsonLines(text, { skipInvalid = false } = {}) {
  const parsed = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {
      if (!skipInvalid) return [];
    }
  }
  return parsed;
}

function readRunRecord(runId, opts = {}) {
  const paths = bindRunReadPaths(runId, opts);
  const summaryArtifact = readBoundRunArtifact(
    paths,
    'summary.json',
    'run summary',
    MAX_SUMMARY_BYTES,
    { allowMissing: true },
  );
  // A run without its identity record is not a readable run.  This also keeps
  // callers from combining event data from a partially replaced directory.
  if (!summaryArtifact.present) return emptyRunRecord();

  let summary;
  try { summary = JSON.parse(summaryArtifact.text); }
  catch { return emptyRunRecord(); }
  if (!validateRunSummaryIdentity(summary, runId)) return emptyRunRecord();

  const eventsArtifact = readBoundRunArtifact(
    paths,
    'events.jsonl',
    'run events',
    MAX_EVENTS_BYTES,
    { allowMissing: true, allowEmpty: true },
  );
  const verificationsArtifact = readBoundRunArtifact(
    paths,
    'verification.jsonl',
    'run verifications',
    MAX_EVENTS_BYTES,
    { allowMissing: true, allowEmpty: true },
  );
  return {
    summary,
    events: eventsArtifact.present
      ? parseJsonLines(eventsArtifact.text, { skipInvalid: true })
      : [],
    verifications: verificationsArtifact.present
      ? parseJsonLines(verificationsArtifact.text, { skipInvalid: true })
      : [],
  };
}

function normalizedListLimit(limit) {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return MAX_RUN_LIST_ENTRIES;
  }
  return Math.min(Math.floor(limit), MAX_RUN_LIST_ENTRIES);
}

function readBoundRunDirectoryNames(baseBinding) {
  revalidateDirectoryBinding(baseBinding, 'run artifacts base');
  const directory = opendirSync(baseBinding.path);
  const names = [];
  try {
    let scanned = 0;
    let entry;
    while (scanned < MAX_RUN_LIST_ENTRIES && (entry = directory.readSync()) !== null) {
      scanned += 1;
      if (entry.isDirectory() && RUN_ID_PATTERN.test(entry.name)) names.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  revalidateDirectoryBinding(baseBinding, 'run artifacts base');
  return names;
}

/**
 * List all run directories, optionally filtered by orchestrator.
 *
 * @param {object} [opts]
 * @param {string} [opts.orchestrator] - Filter to only runs from this orchestrator
 * @param {number} [opts.limit] - Maximum number of results to return
 * @param {string} [opts.base] - Override base directory (for testing)
 * @param {string} [opts.trustedRoot] - Explicit ancestry anchor for custom paths
 * @returns {Array<{ runId: string, orchestrator: string, startedAt: string, status: string }>}
 */
export function listRuns(opts = {}) {
  try {
    const base = resolve(opts.base || RUNS_BASE);
    const { orchestrator } = opts;
    if (orchestrator != null && !ORCHESTRATOR_PATTERN.test(orchestrator)) return [];
    const baseBinding = bindSafeDirectoryPath(base, 'run artifacts base', {
      trustedRoot: opts.trustedRoot,
      requirePrivateMode: false,
    });
    const names = readBoundRunDirectoryNames(baseBinding);

    const results = [];
    for (const name of names) {
      try {
        // Rebind every directory entry rather than trusting Dirent metadata,
        // which can be stale or represent a link swapped after readdir().
        revalidateDirectoryBinding(baseBinding, 'run artifacts base');
        const paths = bindRunReadPaths(name, {
          base,
          trustedRoot: opts.trustedRoot,
        });
        const summaryArtifact = readBoundRunArtifact(
          paths,
          'summary.json',
          'run summary',
          MAX_SUMMARY_BYTES,
        );
        const summary = JSON.parse(summaryArtifact.text);
        if (!validateRunSummaryIdentity(summary, name) || typeof summary.status !== 'string') continue;
        if (orchestrator && summary.orchestrator !== orchestrator) continue;
        // `bindRunReadPaths` protects the candidate itself.  Preserve the
        // identity of the directory that was originally enumerated too, so a
        // rename to another ordinary (non-symlink) base cannot feed a mixed
        // listing through this audit call.
        revalidateDirectoryBinding(baseBinding, 'run artifacts base');
        results.push({
          runId: summary.runId,
          orchestrator: summary.orchestrator,
          startedAt: summary.startedAt,
          status: summary.status,
        });
      } catch {
        // An unreadable, linked, oversized, or replaced entry is simply not a
        // run.  Listing must never dereference it or fail the whole audit.
      }
    }

    // Sort by startedAt descending (most recent first) for replay/audit use cases.
    revalidateDirectoryBinding(baseBinding, 'run artifacts base');
    results.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return results.slice(0, normalizedListLimit(opts.limit));
  } catch {
    return [];
  }
}

/**
 * Read a complete run record: summary, events, and verifications.
 * Invalid, missing, linked, oversized, or changed artifacts deliberately map
 * to the public empty-record contract rather than exposing an error or data.
 *
 * @param {string} runId
 * @param {object} [opts]
 * @param {string} [opts.base] - Override base directory (for testing)
 * @param {string} [opts.trustedRoot] - Explicit ancestry anchor for custom paths
 * @returns {{ summary: object, events: object[], verifications: object[] }}
 */
export function getRun(runId, opts = {}) {
  try {
    return readRunRecord(runId, opts);
  } catch {
    return emptyRunRecord();
  }
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
  try {
    const paths = bindRunReadPaths(runId, opts);
    const artifact = readBoundRunArtifact(
      paths,
      'events.jsonl',
      'run events',
      MAX_EVENTS_BYTES,
      { allowMissing: true, allowEmpty: true },
    );
    return artifact.present ? parseJsonLines(artifact.text, { skipInvalid: true }) : [];
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
// Verification Gate — ensures every story has a verification record before PR
// ---------------------------------------------------------------------------

/**
 * Check whether all expected stories have a verification record (pass, fail, or skip).
 * Orchestrators call this before PR creation to enforce cross-validation.
 *
 * @param {string} runId
 * @param {string[]} storyIds - all story IDs that should have verification
 * @param {object} [opts]
 * @param {string} [opts.base] - Override base directory (for testing)
 * @returns {{ gatePass: boolean, missing: string[], skipped: string[], summary: object }}
 */
export function checkVerificationGate(runId, storyIds, opts = {}) {
  const expectedStoryIds = Array.isArray(storyIds) ? storyIds : [];
  try {
    const summary = getRunVerificationSummary(runId, opts);
    const verifiedIds = new Set(Object.keys(summary.stories));
    const missing = expectedStoryIds.filter(id => !verifiedIds.has(id));
    const skipped = Object.entries(summary.stories)
      .filter(([, s]) => s.verdict === 'skip')
      .map(([id]) => id);

    return {
      gatePass: missing.length === 0,
      missing,
      skipped,
      summary,
    };
  } catch {
    return {
      gatePass: false,
      missing: [...expectedStoryIds],
      skipped: [],
      summary: { total: 0, passed: 0, failed: 0, skipped: 0, stories: {} },
    };
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
