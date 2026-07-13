/**
 * Durable terminal-failure marker for Atlas/Athena runs.
 *
 * This is deliberately a narrow, fail-closed boundary. Callers may persist only
 * a categorized failure tuple; raw errors, prompts, reasons, and arbitrary
 * metadata are rejected. A marker is immutable once written so a later retry
 * cannot silently reclassify historical evidence.
 */

import {
  chmodSync,
  lstatSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import {
  bindRunFinalizationPaths,
  bindRunFinalizationPointer,
  finalizeRun,
} from './run-artifacts.mjs';
import { failPhase, getPhaseSequence } from './phase-runner.mjs';
import {
  acquireRunFinalizationLock,
  releaseRunFinalizationLock,
} from './run-finalization-lock.mjs';

export const RUN_FAILURE_SCHEMA_VERSION = 1;

export const FAILURE_CODES_BY_CLASS = Object.freeze({
  'task-outcome': Object.freeze([
    'verification_exhausted',
    'review_exhausted',
    'acceptance_criteria_unmet',
    'test_regression_unresolved',
  ]),
  orchestration: Object.freeze([
    'phase_guard_exhausted',
    'worker_integration_failed',
    'recovery_state_invalid',
    'plan_validation_failed',
  ]),
  infrastructure: Object.freeze([
    'provider_unavailable',
    'permission_denied',
    'environment_unavailable',
    'timeout',
  ]),
  cancelled: Object.freeze([
    'user_cancelled',
  ]),
});

export const FAILURE_PHASES = Object.freeze([
  'preflight',
  'triage',
  'context',
  'spec',
  'plan',
  'execute',
  'verify',
  'spawn',
  'monitor',
  'wisdom',
  'integrate',
  'review',
  'finalize',
  'ship',
  'ci',
  'complete',
]);

const ORCHESTRATORS = new Set(['atlas', 'athena']);
const PHASES = new Set(FAILURE_PHASES);
const INPUT_KEYS = Object.freeze(['orchestrator', 'failureClass', 'code', 'phase']);
const MARKER_KEYS = Object.freeze([
  'schemaVersion',
  'runId',
  'orchestrator',
  'failureClass',
  'code',
  'phase',
  'failedAt',
]);
const RUNS_BASE = join('.ao', 'artifacts', 'runs');
const STATE_DIR = join('.ao', 'state');
const MARKER_FILE = 'terminal-failure.json';
const MAX_JSON_BYTES = 64 * 1024;
const MAX_FUTURE_SKEW_MS = 60_000;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactDataKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expectedKeys.length) return false;
  const expected = new Set(expectedKeys);
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !expected.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false;
  }
  return true;
}

function requireSafeRunId(runId) {
  if (typeof runId !== 'string' || !SAFE_RUN_ID.test(runId)) {
    throw new TypeError(`invalid runId: ${JSON.stringify(runId)}`);
  }
  return runId;
}

function requireDirectoryOption(value, label, fallback) {
  const resolved = value === undefined ? fallback : value;
  if (typeof resolved !== 'string' || resolved.length === 0 || resolved.includes('\0')) {
    throw new TypeError(`${label} must be a non-empty path string`);
  }
  return resolved;
}

function validateFailureInput(failure) {
  if (!hasExactDataKeys(failure, INPUT_KEYS)) {
    throw new TypeError(`failure must contain exactly: ${INPUT_KEYS.join(', ')}`);
  }
  if (!ORCHESTRATORS.has(failure.orchestrator)) {
    throw new TypeError(`invalid orchestrator: ${JSON.stringify(failure.orchestrator)}`);
  }
  const allowedCodes = FAILURE_CODES_BY_CLASS[failure.failureClass];
  if (!allowedCodes) {
    throw new TypeError(`invalid failureClass: ${JSON.stringify(failure.failureClass)}`);
  }
  if (!allowedCodes.includes(failure.code)) {
    throw new TypeError(
      `code ${JSON.stringify(failure.code)} is not allowed for failureClass ${JSON.stringify(failure.failureClass)}`,
    );
  }
  if (!PHASES.has(failure.phase)) {
    throw new TypeError(`invalid failure phase: ${JSON.stringify(failure.phase)}`);
  }
}

function lstatOrMissing(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function requireRegularFile(path, label) {
  const stat = lstatOrMissing(path);
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_JSON_BYTES) {
    throw new Error(`${label} is missing, unsafe, or corrupt`);
  }
  return stat;
}

function readJsonObject(path, label) {
  requireRegularFile(path, label);
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!isPlainObject(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new Error(`${label} is corrupt`);
  }
}

function hardenRunDirectory(path) {
  const stat = lstatOrMissing(path);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('run directory is missing or unsafe');
  }
  chmodSync(path, 0o700);
  const secured = lstatSync(path);
  if ((secured.mode & 0o777) !== 0o700) {
    throw new Error('run directory permissions are not 0700');
  }
}

function validateRunSummary(summary, runId, orchestrator) {
  if (summary.runId !== runId || summary.orchestrator !== orchestrator) {
    throw new Error('run summary identity mismatch');
  }
  const startedAt = Date.parse(summary.startedAt);
  if (!Number.isFinite(startedAt)
    || new Date(startedAt).toISOString() !== summary.startedAt
    || startedAt > Date.now()) {
    throw new Error('run summary startedAt is invalid');
  }
}

function activeRunPath(orchestrator, stateDir) {
  return join(stateDir, `ao-active-run-${orchestrator}.json`);
}

function validateExistingMarker(path, expectedRunId, now) {
  const marker = readJsonObject(path, 'terminal-failure marker');
  if (!Number.isSafeInteger(marker.schemaVersion)) {
    throw new Error('terminal-failure marker is corrupt');
  }
  if (marker.schemaVersion > RUN_FAILURE_SCHEMA_VERSION) {
    throw new Error('terminal-failure marker uses an unsupported future schema');
  }
  if (marker.schemaVersion !== RUN_FAILURE_SCHEMA_VERSION || !hasExactDataKeys(marker, MARKER_KEYS)) {
    throw new Error('terminal-failure marker is corrupt');
  }
  const failedAt = Date.parse(marker.failedAt);
  if (!Number.isFinite(failedAt) || new Date(failedAt).toISOString() !== marker.failedAt) {
    throw new Error('terminal-failure marker is corrupt');
  }
  if (failedAt > now + MAX_FUTURE_SKEW_MS) {
    throw new Error('terminal-failure marker timestamp is in the future');
  }
  if (marker.runId !== expectedRunId) {
    throw new Error('terminal-failure marker identity mismatch');
  }
  validateFailureInput({
    orchestrator: marker.orchestrator,
    failureClass: marker.failureClass,
    code: marker.code,
    phase: marker.phase,
  });
  return marker;
}

function readExistingMarker(path, runId, now) {
  return lstatOrMissing(path) ? validateExistingMarker(path, runId, now) : null;
}

function sameFailure(marker, failure) {
  return marker.orchestrator === failure.orchestrator
    && marker.failureClass === failure.failureClass
    && marker.code === failure.code
    && marker.phase === failure.phase;
}

function validateAdapterTeamTerminalState(stateDir, spawnOutputs) {
  const teamSlug = spawnOutputs?.teamSlug;
  const intended = spawnOutputs?.intendedWorkers;
  if (typeof teamSlug !== 'string'
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(teamSlug)
    || typeof intended !== 'string') {
    throw new Error('Athena adapter team identity is invalid');
  }
  const expected = intended.split(',');
  if (expected.length === 0
    || expected.some(name => !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name))
    || [...new Set(expected)].sort().join(',') !== intended) {
    throw new Error('Athena intended worker roster is invalid');
  }
  const state = readJsonObject(join(stateDir, `team-${teamSlug}.json`), 'Athena adapter team state');
  if (!/^[a-f0-9]{16}$/.test(spawnOutputs.adapterRunId || '')
    || state.teamName !== teamSlug
    || state.runId !== spawnOutputs.adapterRunId
    || !Array.isArray(state.workers)) {
    throw new Error('Athena adapter team state identity mismatch');
  }
  const observed = state.workers.map(worker => {
    if (!isPlainObject(worker)
      || typeof worker.name !== 'string'
      || worker.status !== 'completed') {
      throw new Error('Athena adapter team has a live or invalid worker');
    }
    if (worker._providerFallback?.provider === 'claude') {
      throw new Error('Athena native fallback liveness is not code-verifiable');
    }
    return worker.name;
  });
  if ([...new Set(observed)].sort().join(',') !== intended || observed.length !== expected.length) {
    throw new Error('Athena adapter team roster mismatch');
  }
}

function validatePipelineCut(dir, stateDir, runId, failure) {
  const pipeline = readJsonObject(join(dir, 'pipeline.json'), 'pipeline ledger');
  const sequence = getPhaseSequence(failure.orchestrator);
  const expectedIds = sequence.map(item => item.id);
  if (pipeline.schemaVersion !== 1
    || pipeline.runId !== runId
    || pipeline.orchestrator !== failure.orchestrator
    || !isPlainObject(pipeline.phases)
    || JSON.stringify(Object.keys(pipeline.phases).sort()) !== JSON.stringify([...expectedIds].sort())) {
    throw new Error('pipeline ledger identity or schema mismatch');
  }
  const failureIndex = expectedIds.indexOf(failure.phase);
  if (failureIndex < 0) throw new Error('failure phase does not belong to the orchestrator pipeline');
  for (let index = 0; index < sequence.length; index += 1) {
    const entry = pipeline.phases[sequence[index].id];
    if (!isPlainObject(entry)) throw new Error('pipeline ledger is corrupt');
    if (index < failureIndex) {
      const validSkip = entry.status === 'skipped'
        && typeof entry.reason === 'string'
        && sequence[index].skippableWhen.includes(entry.reason);
      if (entry.status !== 'completed' && !validSkip) {
        throw new Error('pipeline ledger has a nonterminal or unauthorized predecessor');
      }
    }
    if (index === failureIndex) {
      const resumable = entry.status === 'in_progress';
      const exactFailure = entry.status === 'failed' && entry.failureCode === failure.code;
      if (!resumable && !exactFailure) throw new Error('failure phase is not the exact active pipeline phase');
    }
    if (index > failureIndex && entry.status !== 'pending') {
      throw new Error('pipeline ledger has work after the failure cut');
    }
  }

  if (failure.orchestrator === 'athena') {
    const spawnIndex = expectedIds.indexOf('spawn');
    const monitorIndex = expectedIds.indexOf('monitor');
    if (failureIndex === spawnIndex || failureIndex === monitorIndex) {
      throw new Error('Athena spawn/monitor state remains recoverable or worker liveness is ambiguous');
    }
    if (failureIndex > monitorIndex) {
      const spawn = pipeline.phases.spawn;
      const monitor = pipeline.phases.monitor;
      const intended = spawn.outputs?.intendedWorkers;
      if (spawn.status !== 'completed'
        || monitor.status !== 'completed'
        || typeof intended !== 'string'
        || intended.length === 0
        || monitor.outputs?.teamSlug !== spawn.outputs?.teamSlug
        || monitor.outputs?.intendedWorkers !== intended
        || monitor.outputs?.terminalWorkers !== intended
        || monitor.outputs?.worktreeDigest !== spawn.outputs?.worktreeDigest
        || monitor.outputs?.adapterRunId !== spawn.outputs?.adapterRunId) {
        throw new Error('Athena terminal worker roster is not durably proven');
      }
      if (spawn.outputs?.spawnPath !== 'adapter-only') {
        throw new Error('Athena native or mixed worker liveness is not code-verifiable');
      }
      validateAdapterTeamTerminalState(stateDir, spawn.outputs);
    }
  }
  return pipeline;
}

function verifyFinalizedSummary(path, runId, failure) {
  const summary = readJsonObject(path, 'finalized run summary');
  const startedAt = Date.parse(summary.startedAt);
  const finishedAt = Date.parse(summary.finishedAt);
  if (summary.runId !== runId ||
      summary.orchestrator !== failure.orchestrator ||
      summary.status !== 'completed' ||
      summary.result !== 'failure' ||
      summary.failureCode !== failure.code ||
      summary.failedPhase !== failure.phase ||
      !Number.isFinite(startedAt) ||
      !Number.isFinite(finishedAt) ||
      new Date(finishedAt).toISOString() !== summary.finishedAt ||
      finishedAt < startedAt ||
      !Number.isSafeInteger(summary.duration_ms) ||
      summary.duration_ms < 0 ||
      Math.abs((finishedAt - startedAt) - summary.duration_ms) > 2_000) {
    throw new Error('run failure finalization did not persist the required summary');
  }
}

/**
 * Persist an immutable terminal failure marker, then finalize its run.
 *
 * Throws on invalid input, unsafe paths, stale/corrupt evidence, duplicate
 * finalization, or an unconfirmed summary/pointer transition. Once the marker
 * is written, a downstream finalization error remains fail-closed: retrying
 * cannot overwrite or reclassify the marker.
 *
 * @param {string} runId
 * @param {{orchestrator:'atlas'|'athena',failureClass:string,code:string,phase:string}} failure
 * @param {object} [opts]
 * @param {string} [opts.base]
 * @param {string} [opts.stateDir]
 * @param {string} [opts.trustedRoot]
 * @returns {{ok:true, markerPath:string, marker:object}}
 */
export function finalizeFailedRun(runId, failure, opts = {}) {
  requireSafeRunId(runId);
  validateFailureInput(failure);
  if (!isPlainObject(opts)) throw new TypeError('opts must be an object');

  const requestedBase = requireDirectoryOption(opts.base, 'opts.base', RUNS_BASE);
  const requestedStateDir = requireDirectoryOption(opts.stateDir, 'opts.stateDir', STATE_DIR);
  const trustOpts = {
    base: requestedBase,
    stateDir: requestedStateDir,
    trustedRoot: opts.trustedRoot,
  };
  // First bind every ancestor without requiring the legacy run-directory mode;
  // only after that no-symlink proof may we harden the leaf to 0700. Re-bind
  // strictly before the first terminal write.
  const ancestryGuard = bindRunFinalizationPaths(runId, trustOpts, {
    requirePrivateRunDir: false,
  });
  const pointerGuard = bindRunFinalizationPointer(runId, failure.orchestrator, trustOpts);
  ancestryGuard.revalidate();
  hardenRunDirectory(ancestryGuard.dir);
  const pathGuard = bindRunFinalizationPaths(runId, trustOpts);
  const { base, dir } = pathGuard;
  const stateDir = pointerGuard.stateDir;
  const summaryPath = join(dir, 'summary.json');
  const markerPath = join(dir, MARKER_FILE);
  const pointerPath = activeRunPath(failure.orchestrator, stateDir);

  pathGuard.revalidate();
  const lockOwner = acquireRunFinalizationLock(dir);
  try {
    pathGuard.revalidate();
    const now = Date.now();
    const summary = readJsonObject(summaryPath, 'run summary');
    validateRunSummary(summary, runId, failure.orchestrator);
    let marker = readExistingMarker(markerPath, runId, now);
    if (marker && !sameFailure(marker, failure)) {
      throw new Error('terminal-failure marker already exists with a different classification');
    }
    if (marker && Date.parse(summary.startedAt) > Date.parse(marker.failedAt)) {
      throw new Error('terminal-failure marker predates the run summary');
    }

    if (summary.status !== 'running' && summary.status !== 'completed') {
      throw new Error('run is not active or terminal');
    }
    pointerGuard.revalidate({ required: summary.status === 'running' });
    if (summary.status === 'running') {
      const pipeline = validatePipelineCut(dir, stateDir, runId, failure);
      if (marker && pipeline.phases[failure.phase]?.status !== 'failed') {
        throw new Error('terminal-failure marker is not backed by a failed pipeline phase');
      }
      pathGuard.revalidate();
      pointerGuard.revalidate({ required: true });
      const failed = failPhase(runId, failure.phase, failure.code, {
        cwd: opts.cwd || process.cwd(),
        base,
        _runLockOwner: lockOwner,
      });
      if (!failed.ok || failed.degraded) {
        throw new Error('pipeline failure transition was not durable');
      }
      pathGuard.revalidate();
      pointerGuard.revalidate({ required: true });
      const failedPipeline = validatePipelineCut(dir, stateDir, runId, failure);
      if (failedPipeline.phases[failure.phase]?.status !== 'failed') {
        throw new Error('pipeline failure transition was not persisted');
      }
      if (!marker) {
        pathGuard.revalidate();
        pointerGuard.revalidate({ required: true });
        marker = {
          schemaVersion: RUN_FAILURE_SCHEMA_VERSION,
          runId,
          orchestrator: failure.orchestrator,
          failureClass: failure.failureClass,
          code: failure.code,
          phase: failure.phase,
          failedAt: new Date().toISOString(),
        };
        atomicWriteFileSync(markerPath, JSON.stringify(marker, null, 2), { mode: 0o600 });
        chmodSync(markerPath, 0o600);
      }
    } else {
      if (!marker) throw new Error('completed run has no terminal-failure marker');
      pathGuard.revalidate();
      validatePipelineCut(dir, stateDir, runId, failure);
    }

    pathGuard.revalidate();
    pointerGuard.revalidate({ required: summary.status === 'running' });
    const finalized = finalizeRun(runId, {
      result: 'failure',
      failureCode: failure.code,
      failedPhase: failure.phase,
    }, {
      base,
      stateDir,
      trustedRoot: opts.trustedRoot,
      _finalizationLockOwner: lockOwner,
    });
    if (!finalized?.ok) {
      throw new Error(`run failure finalization failed: ${finalized?.reason || 'unknown'}`);
    }

    pathGuard.revalidate();
    verifyFinalizedSummary(summaryPath, runId, failure);
    if (!pointerGuard.verifyRemoved() || lstatOrMissing(pointerPath)) {
      throw new Error('active-run pointer was not removed');
    }

    return { ok: true, markerPath, marker };
  } finally {
    releaseRunFinalizationLock(dir, lockOwner);
  }
}
