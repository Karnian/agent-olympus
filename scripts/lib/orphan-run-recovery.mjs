/**
 * Fail-closed recovery of an orphaned Atlas/Athena active-run pointer.
 *
 * A rich checkpoint is not run identity.  Before re-attaching it to a run we
 * prove that the run directory still contains a matching running summary and
 * a valid, existing phase ledger. Publication shares the complete-intent,
 * atomic no-replace active-pointer primitive used by createRun, so recovery
 * never overwrites a concurrent orchestrator or exposes a partial pointer.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import path from 'node:path';
import { validatePipelineLedgerIdentity } from './phase-runner.mjs';
import {
  acquireRunFinalizationLock,
  releaseRunFinalizationLock,
} from './run-finalization-lock.mjs';
import { bindRunFinalizationPaths, setActiveRunId } from './run-artifacts.mjs';

const MAX_JSON_BYTES = 64 * 1024;
const SAFE_RUN_ID = /^(atlas|athena)-[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const ORCHESTRATORS = new Set(['atlas', 'athena']);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function lstatOrMissing(filePath) {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function sameFile(left, right) {
  if (!left || !right) return false;
  if (left.dev !== undefined && right.dev !== undefined && left.ino && right.ino) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function sameFileGeneration(left, right) {
  return sameFile(left, right)
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function safeRegularJsonStat(stat) {
  return Boolean(stat)
    && stat.isFile()
    && !stat.isSymbolicLink()
    && stat.nlink === 1
    && stat.size > 0
    && stat.size <= MAX_JSON_BYTES
    && (process.platform === 'win32' || (stat.mode & 0o777) === 0o600);
}

function readRegularJson(filePath) {
  const before = lstatOrMissing(filePath);
  if (!safeRegularJsonStat(before)) return null;

  let fd;
  try {
    fd = openSync(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd);
    if (!safeRegularJsonStat(opened) || !sameFileGeneration(before, opened)) return null;
    const raw = readFileSync(fd, 'utf8');
    const after = fstatSync(fd);
    const pathAfter = lstatOrMissing(filePath);
    if (!safeRegularJsonStat(after)
      || !safeRegularJsonStat(pathAfter)
      || !sameFileGeneration(opened, after)
      || !sameFileGeneration(after, pathAfter)
      || Buffer.byteLength(raw, 'utf8') !== after.size) return null;
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

function validIsoTimestamp(value, maxFutureMs = 60_000) {
  if (typeof value !== 'string' || value.length === 0) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    && new Date(timestamp).toISOString() === value
    && timestamp <= Date.now() + maxFutureMs;
}

function validateRunningSummary(summary, runId, orchestrator) {
  return isPlainObject(summary)
    && summary.runId === runId
    && summary.orchestrator === orchestrator
    && summary.status === 'running'
    && validIsoTimestamp(summary.startedAt, 0);
}

function validateTerminalSummary(summary, runId, orchestrator) {
  if (!isPlainObject(summary)
    || summary.runId !== runId
    || summary.orchestrator !== orchestrator
    || summary.status !== 'completed'
    || !validIsoTimestamp(summary.startedAt, 0)
    || !validIsoTimestamp(summary.finishedAt)) return false;
  const startedAt = Date.parse(summary.startedAt);
  const finishedAt = Date.parse(summary.finishedAt);
  const resultValid = !Object.hasOwn(summary, 'result')
    || ['success', 'failure'].includes(summary.result);
  const failureFieldsValid = summary.result === 'failure'
    || (!Object.hasOwn(summary, 'failureCode') && !Object.hasOwn(summary, 'failedPhase'));
  return finishedAt >= startedAt
    && Number.isSafeInteger(summary.duration_ms)
    && summary.duration_ms >= 0
    && summary.duration_ms === finishedAt - startedAt
    && resultValid
    && failureFieldsValid;
}

function validatePointer(pointer, runId, orchestrator) {
  return isPlainObject(pointer)
    && Object.keys(pointer).length === 3
    && pointer.runId === runId
    && pointer.orchestrator === orchestrator
    && validIsoTimestamp(pointer.startedAt);
}

function proveRunArtifacts(runPath, runId, orchestrator) {
  const summary = readRegularJson(path.join(runPath, 'summary.json'));
  if (validateTerminalSummary(summary, runId, orchestrator)) {
    return { state: 'terminal', reason: 'run-already-terminal', summary };
  }
  if (!validateRunningSummary(summary, runId, orchestrator)) {
    return { state: 'unproven', reason: 'run-summary-unproven', summary: null };
  }
  const pipeline = readRegularJson(path.join(runPath, 'pipeline.json'));
  if (!validatePipelineLedgerIdentity(pipeline, {
    runId,
    orchestrator,
    requireRunId: true,
    requireOrdered: true,
  })) {
    return { state: 'unproven', reason: 'pipeline-identity-unproven', summary: null };
  }
  return { state: 'recoverable', reason: null, summary };
}

function hasSafeDirectoryAncestry(target, trustedRoot) {
  try {
    const root = path.resolve(trustedRoot);
    const resolved = path.resolve(target);
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return false;
    }
    let current = root;
    const components = relative === '' ? [] : relative.split(path.sep);
    const paths = [current];
    for (const component of components) {
      current = path.join(current, component);
      paths.push(current);
    }
    return paths.every((entry, index) => {
      const stat = lstatSync(entry);
      return stat.isDirectory()
        && !stat.isSymbolicLink()
        && (index !== paths.length - 1 || (stat.mode & 0o777) === 0o700);
    });
  } catch {
    return false;
  }
}

function inspectPointer(pointerPath, runId, orchestrator) {
  const stat = lstatOrMissing(pointerPath);
  if (!stat) return { state: 'missing' };
  const pointer = readRegularJson(pointerPath);
  return validatePointer(pointer, runId, orchestrator)
    ? { state: 'same' }
    : { state: 'conflict' };
}

function failed(reason, canCreateNewRun) {
  return {
    ok: false,
    recovered: false,
    runId: null,
    reason,
    canCreateNewRun,
  };
}

/**
 * Recover a missing active-run pointer only after artifact identity proof.
 *
 * `canCreateNewRun:true` is reserved for an exact terminal summary revalidated
 * under the shared run transition lock. Even a safely observed missing run
 * directory returns false: directory absence cannot prove native teams,
 * adapter supervisors, or external workers have stopped. Missing, corrupt,
 * linked, or identity-unproven artifacts preserve possible live workers.
 *
 * @param {'atlas'|'athena'} orchestrator
 * @param {string} checkpointRunId
 * @param {{cwd?:string,runsBase?:string,stateDir?:string,trustedRoot?:string,_beforeTransitionLock?:Function}} [opts]
 * @returns {{ok:boolean,recovered:boolean,runId:string|null,reason:string,canCreateNewRun:boolean}}
 */
export function recoverOrphanedRun(orchestrator, checkpointRunId, opts = {}) {
  let transitionOwner = null;
  let lockedRunPath = null;
  try {
    if (!ORCHESTRATORS.has(orchestrator)) {
      return failed('invalid-recovery-identity', false);
    }
    const cwd = opts.cwd || process.cwd();
    const runsBase = opts.runsBase || path.join(cwd, '.ao', 'artifacts', 'runs');
    const stateDir = opts.stateDir || path.join(cwd, '.ao', 'state');
    const pointerPath = path.join(stateDir, `ao-active-run-${orchestrator}.json`);

    const stateBefore = lstatOrMissing(stateDir);
    if (stateBefore && (!stateBefore.isDirectory() || stateBefore.isSymbolicLink()
      || (stateBefore.mode & 0o777) !== 0o700
      || !hasSafeDirectoryAncestry(stateDir, opts.trustedRoot || cwd))) {
      return failed('state-directory-unsafe', false);
    }

    if (typeof checkpointRunId !== 'string'
      || !SAFE_RUN_ID.test(checkpointRunId)
      || !checkpointRunId.startsWith(`${orchestrator}-`)) {
      return failed('invalid-recovery-identity', false);
    }

    const pointerBefore = inspectPointer(pointerPath, checkpointRunId, orchestrator);
    if (pointerBefore.state !== 'missing') {
      return failed('active-pointer-conflict', false);
    }

    const baseStat = lstatOrMissing(runsBase);
    const runPath = path.join(runsBase, checkpointRunId);
    const runStat = lstatOrMissing(runPath);
    const safeBase = baseStat?.isDirectory()
      && !baseStat.isSymbolicLink()
      && hasSafeDirectoryAncestry(runsBase, opts.trustedRoot || cwd);
    if (!safeBase) return failed('run-directory-unproven', false);
    if (!runStat) return failed('run-directory-absent', false);
    if (!runStat.isDirectory() || runStat.isSymbolicLink()) {
      return failed('run-directory-unproven', false);
    }
    let runGuard;
    try {
      runGuard = bindRunFinalizationPaths(checkpointRunId, {
        base: runsBase,
        trustedRoot: opts.trustedRoot || cwd,
      });
    } catch {
      return failed('run-directory-unproven', false);
    }

    const initialProof = proveRunArtifacts(runPath, checkpointRunId, orchestrator);
    if (initialProof.state === 'unproven') return failed(initialProof.reason, false);

    // The hook is deliberately private: it makes the exact artifact-proof to
    // transition-lock seam deterministic in tests without weakening locking.
    if (initialProof.state === 'recoverable'
      && typeof opts._beforeTransitionLock === 'function') opts._beforeTransitionLock();

    try {
      transitionOwner = acquireRunFinalizationLock(runPath);
      lockedRunPath = runPath;
    } catch {
      return failed('run-transition-in-progress', false);
    }

    // Finalization and recovery now linearize on the same per-run lock.  The
    // directory and pointer must still be the exact objects inspected before
    // lock acquisition, then all terminal-state proof happens while locked.
    const lockedBaseStat = lstatOrMissing(runsBase);
    const lockedRunStat = lstatOrMissing(runPath);
    try { runGuard.revalidate(); }
    catch { return failed('run-directory-changed', false); }
    if (!lockedBaseStat?.isDirectory() || lockedBaseStat.isSymbolicLink()
      || !lockedRunStat?.isDirectory() || lockedRunStat.isSymbolicLink()
      || !sameFile(baseStat, lockedBaseStat)
      || !sameFile(runStat, lockedRunStat)) {
      return failed('run-directory-changed', false);
    }

    const pointerLocked = inspectPointer(pointerPath, checkpointRunId, orchestrator);
    if (pointerLocked.state !== 'missing') {
      return failed('active-pointer-conflict', false);
    }

    const lockedProof = proveRunArtifacts(runPath, checkpointRunId, orchestrator);
    try { runGuard.revalidate(); }
    catch { return failed('run-directory-changed', false); }
    if (lockedProof.state === 'terminal') {
      return failed(lockedProof.reason, true);
    }
    if (lockedProof.state !== 'recoverable') return failed(lockedProof.reason, false);
    const summary = lockedProof.summary;

    const claimed = setActiveRunId(orchestrator, checkpointRunId, {
      stateDir,
      startedAt: summary.startedAt,
      trustedRoot: opts.trustedRoot,
    });
    if (!claimed.ok) {
      return failed(
        claimed.reason === 'active-run-exists'
          ? 'active-pointer-race'
          : 'active-pointer-write-failed',
        false,
      );
    }
    if (inspectPointer(pointerPath, checkpointRunId, orchestrator).state !== 'same') {
      return failed('active-pointer-verification-failed', false);
    }
    return {
      ok: true,
      recovered: true,
      runId: checkpointRunId,
      reason: 'orphan-recovered',
      canCreateNewRun: false,
    };
  } catch {
    return failed('orphan-recovery-failed', false);
  } finally {
    if (transitionOwner && lockedRunPath) {
      releaseRunFinalizationLock(lockedRunPath, transitionOwner);
    }
  }
}
