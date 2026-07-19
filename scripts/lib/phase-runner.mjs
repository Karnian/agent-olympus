/**
 * Phase Runner — deterministic phase ledger and loop-guard chokepoint for
 * Atlas/Athena orchestration.
 *
 * The runner owns phase order, per-phase completion state, and every structural
 * cap consult. It remains cooperative: the LLM-driven orchestrator still does
 * the work inside each phase, but the phase boundary and loop counters are
 * code-defined and durable.
 *
 * Persistence
 * -----------
 * One JSON file per run: .ao/artifacts/runs/<runId>/pipeline.json
 *   {
 *     "schemaVersion": 1,
 *     "runId": "atlas-...",
 *     "orchestrator": "atlas",
 *     "createdAt": "...",
 *     "updatedAt": "...",
 *     "attempt": 1,
 *     "phases": { "triage": { "status": "pending" }, ... }
 *   }
 *
 * `pipeline.json` is the phase authority. `loop-guard.json` remains the cap
 * authority; `ledger.attempt` is only a display mirror and is never consulted
 * for cap enforcement. General phases complete ledger -> event -> checkpoint.
 * Recover phases checkpoint -> ledger -> event so a failed rich checkpoint can
 * never strand external Athena work behind a false completed phase.
 *
 * Fail-safe contract
 * ------------------
 * Every exported function catches all errors and returns a safe default —
 * NEVER throws. Missing runId and unreadable/corrupt storage fail open for
 * operation calls with `degraded:true`; a valid ledger fails closed on illegal
 * traversal. Initialization never overwrites corrupt or future-schema bytes.
 */

import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import {
  appendRegularArtifact,
  ensureSafeDirectoryPath as ensureHardenedDirectoryPath,
  HARDENED_FS_VIOLATION_CODE,
  isWithinPath,
  lstatOrMissing,
  readRegularArtifact,
  readRegularArtifactRange,
  requireSafeDirectory,
  validateRegularArtifact,
} from './hardened-fs.mjs';
import {
  bindRunFinalizationPaths,
  finalizeRun,
  persistRunExecutionPrdSnapshot,
} from './run-artifacts.mjs';
import { readExecutionPrd } from './execution-prd-store.mjs';
import {
  acquireRunFinalizationLock,
  holdsRunFinalizationLock,
  releaseRunFinalizationLock,
} from './run-finalization-lock.mjs';
import { saveCheckpoint as realSaveCheckpoint } from './checkpoint.mjs';
import {
  registerIteration,
  registerReviewRound,
  registerCounter,
  getCounter,
  recordError,
  DEFAULT_ITERATION_CAP,
} from './loop-guard.mjs';

export const MONITOR_CAP = 10;
export const CI_CAP = 2;
export const QUALITY_CAP = 2;
export const FINAL_REVIEW_CAP = 3;
export const SCHEMA_VERSION = 1;

const LOG_FILE_NAME = 'pipeline.json';
const REATTEMPT_INTENT_SCHEMA_VERSION = 1;
const OUTPUTS_CAP_BYTES = 4096;
const PIPELINE_MAX_BYTES = 1024 * 1024;
const EVENTS_MAX_BYTES = 16 * 1024 * 1024;
const UNSAFE_PATH_CODE = 'AO_UNSAFE_PHASE_RUN_PATH';
const FAILURE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const TERMINAL_STATUSES = new Set(['completed', 'skipped']);
const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed', 'skipped', 'failed']);
const ATTEMPT_BOUND_LOOP_KEYS = new Set(['review', 'final-review']);
const REWIND_REASONS = Object.freeze({
  atlas: Object.freeze({
    plan: new Set(['light_mode_rewind']),
    execute: new Set(['quality_fail', 'light_mode_reexec']),
    verify: new Set([
      'quality_fail', 'review_reject', 'final_review_reject', 'light_mode_reexec',
    ]),
  }),
  athena: Object.freeze({
    plan: new Set(['light_mode_rewind']),
    integrate: new Set(['review_reject', 'final_review_reject']),
  }),
});

export const ATLAS_PHASES = Object.freeze([
  phase('triage', 'TRIAGE+ANALYZE', 'linear', 'plan', 0, null, null, 'reexecute'),
  phase('context', 'DEEP-DIVE/EXTERNAL', 'linear', 'plan', 1, null, null, 'skip-if-complete', ['trivial']),
  phase('spec', 'SPEC GATE', 'linear', 'plan', 2, null, null, 'skip-if-complete', ['trivial']),
  phase('plan', 'PLAN+VALIDATE', 'linear', 'decompose', 2, null, null, 'skip-if-complete', ['trivial'], ['light_mode_rewind']),
  phase('execute', 'EXECUTE', 'linear', 'execute', 3, null, null, 'reexecute'),
  phase('verify', 'VERIFY (+visual/quality sub-steps)', 'loop', 'verify', 4, null, null, 'reexecute'),
  phase('review', 'REVIEW', 'loop', 'review', 5, 'reviewRounds', 3, 'reexecute'),
  phase('finalize', 'SLOP+COMMIT+CHANGELOG+EXECPLAN', 'linear', 'finish', 6, null, null, 'reexecute'),
  phase('ship', 'SHIP (PR)', 'linear', 'finish', 7, null, null, 'skip-if-complete', ['preflight-unavailable', 'user-declined', 'not-applicable']),
  phase('ci', 'CI WATCH', 'loop', 'finish', 7, 'ci', CI_CAP, 'reexecute', ['watch-disabled', 'no-pr', 'not-applicable']),
  phase('complete', 'COMPLETION', 'linear', 'finish', 7, null, null, 'reexecute'),
]);

export const ATHENA_PHASES = Object.freeze([
  phase('triage', 'TRIAGE & TEAM DESIGN', 'linear', 'plan', 0, null, null, 'reexecute'),
  phase('context', 'DEEP-DIVE/EXTERNAL', 'linear', 'plan', 0, null, null, 'skip-if-complete', ['trivial']),
  phase('spec', 'SPEC GATE', 'linear', 'plan', 1, null, null, 'skip-if-complete'),
  phase('plan', 'PLAN', 'linear', 'decompose', 1, null, null, 'skip-if-complete', [], ['light_mode_rewind']),
  phase('spawn', 'SPAWN TEAM', 'linear', 'execute', 2, null, null, 'recover'),
  phase('monitor', 'MONITOR & COORDINATE', 'loop', 'execute', 3, 'monitor', MONITOR_CAP, 'recover'),
  phase('wisdom', 'WISDOM TRACKING', 'linear', 'execute', 3, null, null, 'reexecute'),
  phase('integrate', 'INTEGRATE & VERIFY (+visual/quality)', 'loop', 'verify', 4, null, null, 'recover'),
  phase('review', 'REVIEW', 'loop', 'review', 5, 'reviewRounds', 3, 'reexecute'),
  phase('finalize', 'SLOP+COMMIT+CHANGELOG+EXECPLAN', 'linear', 'finish', 6, null, null, 'reexecute'),
  phase('ship', 'SHIP (PR)', 'linear', 'finish', 7, null, null, 'skip-if-complete', ['preflight-unavailable', 'user-declined', 'not-applicable']),
  phase('ci', 'CI WATCH', 'loop', 'finish', 7, 'ci', CI_CAP, 'reexecute', ['watch-disabled', 'no-pr', 'not-applicable']),
  phase('complete', 'COMPLETION', 'linear', 'finish', 7, null, null, 'reexecute'),
]);

function phase(id, name, kind, pipeStage, checkpointIndex, loopGuard, loopCap, onResume, skippableWhen = [], reopenableFor = []) {
  return Object.freeze({
    id,
    name,
    kind,
    pipeStage,
    checkpointIndex,
    loopGuard,
    loopCap,
    onResume,
    skippableWhen,
    reopenableFor,
  });
}

function nowIso() {
  return new Date().toISOString();
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function unsafePath(error = null) {
  if (error?.code === UNSAFE_PATH_CODE) return error;
  const wrapped = new Error('phase run path is unsafe');
  wrapped.code = UNSAFE_PATH_CODE;
  wrapped.cause = error || undefined;
  return wrapped;
}

function isUnsafePath(error) {
  return error?.code === UNSAFE_PATH_CODE;
}

function isHardenedFsViolation(error) {
  return error?.code === HARDENED_FS_VIOLATION_CODE;
}

function revalidatePhaseRunContext(context) {
  try {
    return context.revalidate();
  } catch (error) {
    throw unsafePath(error);
  }
}

function requireSafePhaseDirectory(path, label, requirePrivateMode = false) {
  try {
    return requireSafeDirectory(path, label, { requirePrivateMode });
  } catch (error) {
    if (isHardenedFsViolation(error)) throw unsafePath(error);
    throw error;
  }
}

function runBase(cwd, base = null) {
  return base || join(cwd, '.ao', 'artifacts', 'runs');
}

function trustedRootFor(cwd, base, opts = {}, { allowHeldLockAnchor = false } = {}) {
  const explicit = opts.trustedRoot;
  if (explicit !== undefined && (typeof explicit !== 'string' || explicit.length === 0 || explicit.includes('\0'))) {
    throw unsafePath();
  }
  const resolvedBase = resolve(base);
  // finalizeFailedRun binds and revalidates its complete ancestry before
  // handing this module its already-held internal transition-lock owner. That
  // capability is the only compatibility bridge for a custom finalization base
  // whose explicit trustedRoot is intentionally not part of the public
  // failPhase() surface. Ordinary callers never get this anchor shortcut.
  const lockedInternalBase = allowHeldLockAnchor && explicit === undefined && opts._runLockOwner
    && typeof opts.base === 'string' && opts.base.length > 0
    ? resolve(base)
    : null;
  const candidates = explicit !== undefined
    ? [resolve(explicit)]
    : lockedInternalBase
      ? [lockedInternalBase]
      : [resolve(cwd), resolve(process.cwd()), resolve(tmpdir())];
  const matching = candidates.filter(root => isWithinPath(root, resolvedBase));
  if (matching.length === 0) throw unsafePath();
  const trustedRoot = matching.sort((left, right) => right.length - left.length)[0];
  requireSafePhaseDirectory(trustedRoot, 'phase run trusted root');
  return trustedRoot;
}

function ensureSafeDirectoryPath(target, trustedRoot, label, requirePrivateMode = true) {
  try {
    return ensureHardenedDirectoryPath(target, label, {
      trustedRoot,
      requirePrivateMode,
      requirePrivateAnchor: false,
    });
  } catch (error) {
    if (isHardenedFsViolation(error) || error?.syscall === 'mkdir') throw unsafePath(error);
    throw error;
  }
}

function phaseRunContext(runId, cwd, opts = {}, {
  create = false,
  allowMissing = false,
  allowHeldLockAnchor = false,
} = {}) {
  try {
    if (!SAFE_RUN_ID.test(runId || '')) throw unsafePath();
    if (typeof cwd !== 'string' || cwd.length === 0 || cwd.includes('\0')) throw unsafePath();
    const base = resolve(runBase(cwd, opts.base || null));
    const trustedRoot = trustedRootFor(cwd, base, opts, { allowHeldLockAnchor });
    const dir = join(base, runId);
    if (create) {
      ensureSafeDirectoryPath(base, trustedRoot, 'phase run base');
      ensureSafeDirectoryPath(dir, trustedRoot, 'phase run directory');
    } else if (!lstatOrMissing(dir)) {
      if (allowMissing) return null;
      throw unsafePath(new Error('phase run directory is missing'));
    }
    const binding = bindRunFinalizationPaths(runId, { base, trustedRoot });
    return Object.freeze({
      ...binding,
      cwd: resolve(cwd),
      trustedRoot,
    });
  } catch (error) {
    throw unsafePath(error);
  }
}

function artifactPath(context, name) {
  revalidatePhaseRunContext(context);
  return join(context.dir, name);
}

function readArtifactText(context, name, label, maxBytes, { allowMissing = false } = {}) {
  const path = artifactPath(context, name);
  try {
    return readRegularArtifact(path, label, maxBytes, {
      allowMissing,
      allowEmpty: true,
      generationPolicy: 'object-size',
      revalidateContext: () => revalidatePhaseRunContext(context),
    });
  } catch (error) {
    if (isUnsafePath(error) || isHardenedFsViolation(error)) throw unsafePath(error);
    throw error;
  }
}

function assertArtifactSafe(context, name, label, maxBytes, { allowMissing = true } = {}) {
  const path = artifactPath(context, name);
  const stat = lstatOrMissing(path);
  if (!stat) {
    if (allowMissing) return null;
    throw unsafePath(new Error(`${label} is missing`));
  }
  try {
    validateRegularArtifact(stat, label, maxBytes, { allowEmpty: true });
  } catch (error) {
    if (isHardenedFsViolation(error)) throw unsafePath(error);
    throw error;
  }
  return stat;
}

function appendArtifactText(context, name, label, text, maxBytes, {
  ensureLineBoundary = false,
  expectedStat = undefined,
} = {}) {
  const path = artifactPath(context, name);
  try {
    return appendRegularArtifact(path, label, text, maxBytes, {
      generationPolicy: 'object-size',
      ensureLineBoundary,
      expectedStat,
      revalidateContext: () => revalidatePhaseRunContext(context),
    });
  } catch (error) {
    if (isUnsafePath(error) || isHardenedFsViolation(error)) throw unsafePath(error);
    throw error;
  }
}

function readArtifactRange(context, name, label, maxBytes, appendResult) {
  const path = artifactPath(context, name);
  try {
    return readRegularArtifactRange(path, label, maxBytes, {
      ...appendResult,
      expectedStat: appendResult.stat,
      allowEmpty: true,
      generationPolicy: 'object-size',
      revalidateContext: () => revalidatePhaseRunContext(context),
    });
  } catch (error) {
    if (isUnsafePath(error) || isHardenedFsViolation(error)) throw unsafePath(error);
    throw error;
  }
}

function takeRunTransitionLock(context, providedOwner = null) {
  revalidatePhaseRunContext(context);
  if (providedOwner) {
    if (!holdsRunFinalizationLock(context.dir, providedOwner)) {
      throw unsafePath(new Error('run transition lock is not held'));
    }
    revalidatePhaseRunContext(context);
    return { dir: context.dir, owner: providedOwner, owned: false, context };
  }
  let owner;
  try {
    owner = acquireRunFinalizationLock(context.dir);
    revalidatePhaseRunContext(context);
    if (!holdsRunFinalizationLock(context.dir, owner)) {
      throw unsafePath(new Error('run transition lock was replaced'));
    }
    return { dir: context.dir, owner, owned: true, context };
  } catch (error) {
    if (owner) {
      try {
        revalidatePhaseRunContext(context);
        releaseRunFinalizationLock(context.dir, owner);
      } catch {}
    }
    if (isUnsafePath(error) || /unsafe/i.test(error?.message || '')) throw unsafePath(error);
    throw error;
  }
}

function maybeTakeRunTransitionLock(context) {
  return lstatOrMissing(context.dir) ? takeRunTransitionLock(context) : null;
}

function releaseRunTransitionLock(lock) {
  if (!lock?.owned) return false;
  try {
    revalidatePhaseRunContext(lock.context);
    return releaseRunFinalizationLock(lock.dir, lock.owner);
  } catch {
    return false;
  }
}

function runHasTerminalArtifact(context) {
  if (assertArtifactSafe(context, 'terminal-failure.json', 'terminal failure marker', PIPELINE_MAX_BYTES)) {
    return true;
  }
  try {
    const summary = readArtifactText(
      context, 'summary.json', 'run summary', PIPELINE_MAX_BYTES, { allowMissing: true },
    );
    return summary.present && JSON.parse(summary.text).status === 'completed';
  } catch (error) {
    if (isUnsafePath(error)) throw error;
    return false;
  }
}

function runSummaryStatus(context) {
  try {
    const summary = readArtifactText(
      context, 'summary.json', 'run summary', PIPELINE_MAX_BYTES, { allowMissing: true },
    );
    return summary.present ? JSON.parse(summary.text).status || null : null;
  } catch (error) {
    if (isUnsafePath(error)) throw error;
    return null;
  }
}

function parsePipelineEventLines(text) {
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A torn/invalid line cannot exact-match any well-formed event. Skipping
      // it therefore preserves the ensure* idempotency counting invariant while
      // allowing valid records before and after the damaged line to participate.
    }
  }
  return events;
}

function readPipelineEvents(context) {
  try {
    const file = readArtifactText(
      context, 'events.jsonl', 'pipeline events', EVENTS_MAX_BYTES, { allowMissing: true },
    );
    return {
      events: file.present ? parsePipelineEventLines(file.text) : [],
      stat: file.stat,
    };
  } catch (error) {
    if (isUnsafePath(error)) throw error;
    return null;
  }
}

function appendPipelineEvent(context, event, expectedStat) {
  try {
    return appendArtifactText(
      context,
      'events.jsonl',
      'pipeline events',
      `${JSON.stringify({ ...event, timestamp: nowIso() })}\n`,
      EVENTS_MAX_BYTES,
      { ensureLineBoundary: true, expectedStat },
    );
  } catch (error) {
    if (isUnsafePath(error)) throw error;
    return null;
  }
}

function appendedPipelineEvents(context, appendResult) {
  try {
    const tail = readArtifactRange(
      context, 'events.jsonl', 'pipeline events', EVENTS_MAX_BYTES, appendResult,
    );
    return parsePipelineEventLines(tail.text);
  } catch (error) {
    if (isUnsafePath(error)) throw error;
    return null;
  }
}

function assertSafeLoopGuard(context) {
  if (context.base !== resolve(runBase(context.cwd))) {
    throw unsafePath(new Error('custom pipeline base cannot use the default loop guard'));
  }
  return assertArtifactSafe(
    context, 'loop-guard.json', 'phase loop guard', PIPELINE_MAX_BYTES,
  );
}

function ensurePhaseFailedEvent(context, ledger, phaseId, failureCode) {
  const eventFile = readPipelineEvents(context);
  if (!eventFile) return false;
  const { events } = eventFile;
  const exact = event => event?.type === 'pipeline_phase_failed'
    && event.phase === phaseId
    && event.detail?.orchestrator === ledger.orchestrator
    && event.detail?.code === failureCode;
  const matches = events.filter(exact);
  if (matches.length > 1) return false;
  if (matches.length === 0) {
    const appended = appendPipelineEvent(context, {
      type: 'pipeline_phase_failed',
      phase: phaseId,
      detail: { orchestrator: ledger.orchestrator, code: failureCode },
    }, eventFile.stat);
    if (!appended) return false;
    const tail = appendedPipelineEvents(context, appended);
    if (!tail || tail.filter(exact).length !== 1) return false;
  }
  return true;
}

function ensurePhaseCompletedEvent(context, ledger, phaseId) {
  const entry = ledger.phases?.[phaseId];
  if (!entry || entry.status !== 'completed' || !Number.isInteger(entry.attempts)) return false;
  const eventFile = readPipelineEvents(context);
  if (!eventFile) return false;
  const { events } = eventFile;
  const exact = event => event?.type === 'pipeline_phase_completed'
    && event.phase === phaseId
    && event.detail?.orchestrator === ledger.orchestrator
    && event.detail?.attempt === entry.attempts;
  const matches = events.filter(exact);
  if (matches.length > 1) return false;
  if (matches.length === 0) {
    const sequence = getPhaseSequence(ledger.orchestrator);
    const phaseIndex = sequence.findIndex(item => item.id === phaseId);
    const hasLaterCompletion = events.some(event => event?.type === 'pipeline_phase_completed'
      && sequence.findIndex(item => item.id === event.phase) > phaseIndex);
    const declaredRewind = typeof entry.reason === 'string'
      && Object.values(REWIND_REASONS[ledger.orchestrator] || {})
        .some(reasons => reasons.has(entry.reason));
    if ((hasLaterCompletion && !declaredRewind)
      || events.some(event => event?.type === 'run_finalized')) return false;
    const next = safeNextAfter(ledger, phaseId);
    const appended = appendPipelineEvent(context, {
      type: 'pipeline_phase_completed',
      phase: phaseId,
      detail: {
        orchestrator: ledger.orchestrator,
        next,
        attempt: entry.attempts,
        ...(isPlainObject(entry.outputs) ? { outputs: entry.outputs } : {}),
      },
    }, eventFile.stat);
    if (!appended) return false;
    const tail = appendedPipelineEvents(context, appended);
    if (!tail || tail.filter(exact).length !== 1) return false;
  }
  return true;
}

function ensurePhaseOutputsEvent(context, ledger, phaseId, outputs) {
  const eventFile = readPipelineEvents(context);
  if (!eventFile) return false;
  const { events } = eventFile;
  const encoded = JSON.stringify(outputs);
  const exact = event => event?.type === 'pipeline_phase_outputs_recorded'
    && event.phase === phaseId
    && event.detail?.orchestrator === ledger.orchestrator
    && JSON.stringify(event.detail?.outputs) === encoded;
  const matches = events.filter(exact);
  if (matches.length > 1) return false;
  if (matches.length === 0) {
    const appended = appendPipelineEvent(context, {
      type: 'pipeline_phase_outputs_recorded',
      phase: phaseId,
      detail: { orchestrator: ledger.orchestrator, outputs },
    }, eventFile.stat);
    if (!appended) return false;
    const tail = appendedPipelineEvents(context, appended);
    if (!tail || tail.filter(exact).length !== 1) return false;
  }
  return true;
}

function freshLedger(orchestrator = null, runId = null) {
  const ts = nowIso();
  return {
    schemaVersion: SCHEMA_VERSION,
    ...(typeof runId === 'string' && runId.length > 0 ? { runId } : {}),
    orchestrator,
    createdAt: ts,
    updatedAt: ts,
    attempt: 0,
    phases: {},
  };
}

function freshLedgerFor(orchestrator, runId = null) {
  const ledger = freshLedger(orchestrator, runId);
  for (const desc of getPhaseSequence(orchestrator)) {
    ledger.phases[desc.id] = { status: 'pending' };
  }
  return ledger;
}

function descriptorById(orchestrator, phaseId) {
  return getPhaseSequence(orchestrator).find(p => p.id === phaseId) || null;
}

function normalizeStatus(status) {
  return VALID_STATUSES.has(status) ? status : 'pending';
}

function canonicalReopen(orchestrator, reopen) {
  if (!Array.isArray(reopen)) return [];
  const requested = new Set(reopen.filter(value => typeof value === 'string'));
  return getPhaseSequence(orchestrator)
    .map(({ id }) => id)
    .filter(id => requested.has(id));
}

function isValidPendingReattempt(pending, ledger) {
  if (pending === undefined) return true;
  if (!isPlainObject(pending)
    || pending.schemaVersion !== REATTEMPT_INTENT_SCHEMA_VERSION
    || pending.runId !== ledger.runId
    || pending.orchestrator !== ledger.orchestrator
    || typeof pending.reason !== 'string'
    || pending.reason.length > 64
    || typeof pending.currentPhase !== 'string'
    || !Number.isInteger(pending.baseAttempt)
    || pending.baseAttempt < 1
    || !Number.isInteger(pending.targetAttempt)
    || pending.baseAttempt !== ledger.attempt
    || pending.targetAttempt !== pending.baseAttempt + 1
    || pending.targetAttempt > DEFAULT_ITERATION_CAP
    || !Array.isArray(pending.reopen)
    || pending.reopen.length < 1) return false;

  const canonical = canonicalReopen(ledger.orchestrator, pending.reopen);
  if (canonical.length !== pending.reopen.length
    || canonical.some((phaseId, index) => phaseId !== pending.reopen[index])) return false;
  if (!descriptorById(ledger.orchestrator, pending.currentPhase)) return false;
  const current = firstNonTerminal(ledger);
  if (!current || current.id !== pending.currentPhase) return false;
  const sequence = getPhaseSequence(ledger.orchestrator);
  const currentIndex = sequence.findIndex(({ id }) => id === current.id);
  if (!pending.reopen.every(phaseId => {
    const targetIndex = sequence.findIndex(({ id }) => id === phaseId);
    const status = ledger.phases[phaseId]?.status || 'pending';
    return targetIndex >= 0 && targetIndex <= currentIndex
      && (TERMINAL_STATUSES.has(status) || phaseId === current.id);
  })) return false;

  if (pending.reason === 'quality_fail') {
    return Number.isInteger(pending.qualityBaseCount)
      && pending.qualityBaseCount >= 0
      && pending.qualityBaseCount < QUALITY_CAP;
  }
  return !Object.hasOwn(pending, 'qualityBaseCount');
}

function isValidReattemptReceipt(receipt, ledger) {
  if (receipt === undefined) return true;
  if (!isPlainObject(receipt)
    || receipt.schemaVersion !== REATTEMPT_INTENT_SCHEMA_VERSION
    || receipt.runId !== ledger.runId
    || receipt.orchestrator !== ledger.orchestrator
    || typeof receipt.reason !== 'string'
    || receipt.reason.length > 64
    || typeof receipt.currentPhase !== 'string'
    || !Number.isInteger(receipt.baseAttempt)
    || receipt.baseAttempt < 1
    || !Number.isInteger(receipt.targetAttempt)
    || receipt.targetAttempt !== receipt.baseAttempt + 1
    || receipt.targetAttempt > ledger.attempt
    || receipt.targetAttempt > DEFAULT_ITERATION_CAP
    || !Array.isArray(receipt.reopen)
    || receipt.reopen.length < 1) return false;
  const canonical = canonicalReopen(ledger.orchestrator, receipt.reopen);
  if (canonical.length !== receipt.reopen.length
    || canonical.some((phaseId, index) => phaseId !== receipt.reopen[index])) return false;
  if (!descriptorById(ledger.orchestrator, receipt.currentPhase)) return false;
  if (receipt.reason === 'quality_fail') {
    return Number.isInteger(receipt.qualityBaseCount)
      && receipt.qualityBaseCount >= 0
      && receipt.qualityBaseCount < QUALITY_CAP;
  }
  return !Object.hasOwn(receipt, 'qualityBaseCount');
}

function hasCoherentPhaseOrder(parsed) {
  const sequence = getPhaseSequence(parsed.orchestrator);
  const firstNonTerminalIndex = sequence.findIndex(({ id }) => (
    !TERMINAL_STATUSES.has(parsed.phases[id].status)
  ));
  if (firstNonTerminalIndex < 0) return true;

  const futureWasTouched = sequence.slice(firstNonTerminalIndex + 1).some(({ id }) => (
    parsed.phases[id].status !== 'pending'
  ));
  if (!futureWasTouched) return true;

  const currentId = sequence[firstNonTerminalIndex].id;
  const reason = parsed.phases[currentId].reason;
  return typeof reason === 'string'
    && REWIND_REASONS[parsed.orchestrator]?.[currentId]?.has(reason) === true;
}

/**
 * Validate a persisted pipeline ledger against its artifact path identity.
 * Legacy ledgers may omit runId for ordinary in-place operation; security
 * boundaries such as orphan-pointer recovery set requireRunId=true.
 *
 * @param {*} parsed
 * @param {{runId?:string, orchestrator?:string, requireRunId?:boolean, requireOrdered?:boolean}} [expected]
 * @returns {boolean}
 */
export function validatePipelineLedgerIdentity(parsed, expected = {}) {
  try {
    if (!isPlainObject(parsed) || parsed.schemaVersion !== SCHEMA_VERSION) return false;
    if (parsed.orchestrator !== 'atlas' && parsed.orchestrator !== 'athena') return false;
    if (expected.orchestrator && parsed.orchestrator !== expected.orchestrator) return false;
    if (Object.hasOwn(parsed, 'runId')
      && (typeof parsed.runId !== 'string' || parsed.runId.length === 0)) return false;
    if (expected.runId && Object.hasOwn(parsed, 'runId') && parsed.runId !== expected.runId) return false;
    if (expected.requireRunId && parsed.runId !== expected.runId) return false;
    if (!Number.isInteger(parsed.attempt) || parsed.attempt < 0) return false;
    if (!isPlainObject(parsed.phases)) return false;
    const phasesValid = getPhaseSequence(parsed.orchestrator).every(desc => {
      const entry = parsed.phases[desc.id];
      return isPlainObject(entry) && VALID_STATUSES.has(entry.status);
    });
    if (!phasesValid) return false;
    if (!isValidPendingReattempt(parsed.pendingReattempt, parsed)) return false;
    if (!isValidReattemptReceipt(parsed.reattemptReceipt, parsed)) return false;
    return expected.requireOrdered !== false ? hasCoherentPhaseOrder(parsed) : true;
  } catch {
    return false;
  }
}

function isValidPersistedLedger(parsed, expectedRunId = null) {
  return validatePipelineLedgerIdentity(parsed, {
    runId: expectedRunId,
    requireRunId: false,
    requireOrdered: true,
  });
}

function normalizeLedger(parsed, fallbackOrchestrator, expectedRunId = null) {
  const orchestrator = (parsed.orchestrator === 'atlas' || parsed.orchestrator === 'athena')
    ? parsed.orchestrator
    : fallbackOrchestrator;
  const ledger = {
    schemaVersion: SCHEMA_VERSION,
    ...((typeof parsed.runId === 'string' && parsed.runId.length > 0)
      ? { runId: parsed.runId }
      : (typeof expectedRunId === 'string' && expectedRunId.length > 0 ? { runId: expectedRunId } : {})),
    orchestrator,
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : nowIso(),
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : nowIso(),
    attempt: (typeof parsed.attempt === 'number' && Number.isFinite(parsed.attempt)) ? parsed.attempt : 0,
    phases: {},
    ...(isPlainObject(parsed.pendingReattempt)
      ? { pendingReattempt: structuredClone(parsed.pendingReattempt) }
      : {}),
    ...(isPlainObject(parsed.reattemptReceipt)
      ? { reattemptReceipt: structuredClone(parsed.reattemptReceipt) }
      : {}),
  };
  const rawPhases = isPlainObject(parsed.phases) ? parsed.phases : {};
  for (const desc of getPhaseSequence(orchestrator)) {
    const raw = isPlainObject(rawPhases[desc.id]) ? rawPhases[desc.id] : {};
    ledger.phases[desc.id] = {
      status: normalizeStatus(raw.status),
      ...(typeof raw.startedAt === 'string' ? { startedAt: raw.startedAt } : {}),
      ...(typeof raw.completedAt === 'string' ? { completedAt: raw.completedAt } : {}),
      ...(typeof raw.attempts === 'number' && Number.isFinite(raw.attempts) ? { attempts: raw.attempts } : {}),
      ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
      ...(typeof raw.failureCode === 'string' ? { failureCode: raw.failureCode } : {}),
      ...(typeof raw.failedAt === 'string' ? { failedAt: raw.failedAt } : {}),
      ...(isPlainObject(raw.outputs) ? { outputs: raw.outputs } : {}),
    };
  }
  return ledger;
}

function readLedgerWithStatus(context, runId, fallbackOrchestrator = null) {
  try {
    if (!runId) return { ledger: freshLedger(fallbackOrchestrator), degraded: true };
    const file = readArtifactText(
      context, LOG_FILE_NAME, 'pipeline ledger', PIPELINE_MAX_BYTES, { allowMissing: true },
    );
    if (!file.present) return { ledger: freshLedgerFor(fallbackOrchestrator, runId), degraded: false };
    const parsed = JSON.parse(file.text);
    if (!isPlainObject(parsed)) return { ledger: freshLedgerFor(fallbackOrchestrator, runId), degraded: true };
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      try {
        process.stderr.write(
          `[phase-runner] refusing pipeline.json schemaVersion ${parsed.schemaVersion} ` +
          `(supported: ${SCHEMA_VERSION}) — treating as empty\n`,
        );
      } catch { /* stderr unavailable */ }
      return { ledger: freshLedgerFor(fallbackOrchestrator, runId), degraded: true };
    }
    if (!isValidPersistedLedger(parsed, runId)) {
      return { ledger: freshLedgerFor(fallbackOrchestrator, runId), degraded: true };
    }
    return { ledger: normalizeLedger(parsed, fallbackOrchestrator, runId), degraded: false };
  } catch (error) {
    if (isUnsafePath(error)) throw error;
    return { ledger: freshLedgerFor(fallbackOrchestrator, runId), degraded: true };
  }
}

function writeLedger(context, ledger) {
  try {
    assertArtifactSafe(context, LOG_FILE_NAME, 'pipeline ledger', PIPELINE_MAX_BYTES);
    ledger.updatedAt = nowIso();
    revalidatePhaseRunContext(context);
    atomicWriteFileSync(
      artifactPath(context, LOG_FILE_NAME),
      JSON.stringify(ledger, null, 2),
      { mode: 0o600 },
    );
    assertArtifactSafe(context, LOG_FILE_NAME, 'pipeline ledger', PIPELINE_MAX_BYTES, {
      allowMissing: false,
    });
    revalidatePhaseRunContext(context);
    return true;
  } catch (error) {
    if (isUnsafePath(error)) throw error;
    return false;
  }
}

function firstNonTerminal(ledger) {
  try {
    for (const desc of getPhaseSequence(ledger.orchestrator)) {
      const status = ledger.phases[desc.id]?.status || 'pending';
      if (!TERMINAL_STATUSES.has(status)) return desc;
    }
    return null;
  } catch {
    return null;
  }
}

function currentPhaseId(ledger) {
  return firstNonTerminal(ledger)?.id || null;
}

function isKnownLedger(ledger) {
  return getPhaseSequence(ledger?.orchestrator).length > 0;
}

function attemptPhaseId(orchestrator) {
  if (orchestrator === 'atlas') return 'execute';
  if (orchestrator === 'athena') return 'integrate';
  return null;
}

function blockedAttempt(ledger, degraded = false) {
  return {
    allowed: false,
    count: Number.isFinite(ledger?.attempt) ? ledger.attempt : 0,
    cap: DEFAULT_ITERATION_CAP,
    degraded,
  };
}

function failOpenAttempt() {
  return { allowed: true, count: 0, cap: DEFAULT_ITERATION_CAP, degraded: true };
}

function completedIds(ledger) {
  try {
    return getPhaseSequence(ledger.orchestrator)
      .filter(desc => TERMINAL_STATUSES.has(ledger.phases[desc.id]?.status))
      .map(desc => desc.id);
  } catch {
    return [];
  }
}

function safeNextAfter(ledger, phaseId) {
  try {
    const seq = getPhaseSequence(ledger.orchestrator);
    const idx = seq.findIndex(p => p.id === phaseId);
    const tail = idx >= 0 ? seq.slice(idx + 1) : seq;
    for (const desc of tail) {
      const status = ledger.phases[desc.id]?.status || 'pending';
      if (!TERMINAL_STATUSES.has(status)) return desc.id;
    }
    return null;
  } catch {
    return null;
  }
}

function isScalar(v) {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

function sanitizeOutputs(outputs) {
  try {
    if (!isPlainObject(outputs)) return undefined;
    const tiny = {};
    for (const [key, value] of Object.entries(outputs)) {
      if (typeof key === 'string' && isScalar(value)) tiny[key] = value;
    }
    if (Object.keys(tiny).length === 0) return undefined;
    const serialized = JSON.stringify(tiny);
    if (Buffer.byteLength(serialized, 'utf-8') <= OUTPUTS_CAP_BYTES) return tiny;

    const suffix = '[TRUNCATED: outputs exceeded 4KB cap]\n';
    const source = Buffer.from(serialized, 'utf-8');
    let available = Math.max(0, OUTPUTS_CAP_BYTES - Buffer.byteLength(JSON.stringify({ truncated: true, tail: suffix }), 'utf-8'));
    const tailFor = n => (n > 0 ? source.slice(-n).toString('utf-8') : '');
    let capped = { truncated: true, tail: `${suffix}${tailFor(available)}` };
    while (available > 0 && Buffer.byteLength(JSON.stringify(capped), 'utf-8') > OUTPUTS_CAP_BYTES) {
      available = Math.max(0, available - 128);
      capped = { truncated: true, tail: `${suffix}${tailFor(available)}` };
    }
    return capped;
  } catch {
    return undefined;
  }
}

function sanitizeRecoveryOutputs(outputs) {
  try {
    if (!isPlainObject(outputs)) return undefined;
    const entries = Object.entries(outputs);
    if (entries.length === 0 || entries.some(([key, value]) => (
      typeof key !== 'string' || !isScalar(value)
    ))) return undefined;
    const copy = Object.fromEntries(entries);
    return Buffer.byteLength(JSON.stringify(copy), 'utf-8') <= OUTPUTS_CAP_BYTES
      ? copy
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeLoopKey(key) {
  if (key === 'reviewRounds' || key === 'review') return 'review';
  if (key === 'finalReviewRounds' || key === 'final-review') return 'final-review';
  if (key === 'monitor') return 'monitor';
  if (key === 'ci') return 'ci';
  if (key === 'quality') return 'quality';
  return null;
}

function loopCounterSpec(orchestrator, key) {
  if (key === 'review') return { phaseId: 'review', name: 'reviewRounds', cap: 3 };
  if (key === 'final-review') {
    return { phaseId: 'finalize', name: 'finalReviewRounds', cap: FINAL_REVIEW_CAP };
  }
  if (key === 'monitor' && orchestrator === 'athena') {
    return { phaseId: 'monitor', name: 'monitor-iterations', cap: MONITOR_CAP };
  }
  if (key === 'ci') return { phaseId: 'ci', name: 'ci-cycles', cap: CI_CAP };
  if (key === 'quality') {
    return {
      phaseId: orchestrator === 'athena' ? 'integrate' : 'verify',
      name: 'quality-cycles',
      cap: QUALITY_CAP,
    };
  }
  return null;
}

function completionLoopKey(orchestrator, desc) {
  if (!desc) return null;
  return desc.loopGuard || (desc.id === 'finalize' ? 'final-review' : null);
}

function currentAttemptHasLoopTick(prior, key, counter) {
  if (!Number.isInteger(counter?.count)
    || !Number.isInteger(counter?.cap)
    || counter.count < 1
    || counter.count > counter.cap) return false;
  if (!ATTEMPT_BOUND_LOOP_KEYS.has(key)) return true;
  return Number.isInteger(prior?.attempts) && counter.count === prior.attempts;
}

/**
 * Return the code-defined phase sequence for an orchestrator.
 *
 * @param {string} orchestrator - 'atlas' | 'athena'
 * @returns {Array<object>}
 */
export function getPhaseSequence(orchestrator) {
  try {
    if (orchestrator === 'atlas') return ATLAS_PHASES.map(p => ({ ...p, skippableWhen: [...p.skippableWhen], reopenableFor: [...p.reopenableFor] }));
    if (orchestrator === 'athena') return ATHENA_PHASES.map(p => ({ ...p, skippableWhen: [...p.skippableWhen], reopenableFor: [...p.reopenableFor] }));
    return [];
  } catch {
    return [];
  }
}

/**
 * Create or read a pipeline ledger and report the phase to resume.
 *
 * @param {string} runId
 * @param {string} orchestrator
 * @param {{ cwd?: string }} [opts]
 * @returns {{ ok: boolean, resumePhase: string|null, resumePolicy: string|null, completed: string[], degraded: boolean }}
 */
export function initPipeline(runId, orchestrator, opts = {}) {
  let transitionLock = null;
  try {
    const cwd = opts.cwd || process.cwd();
    if (!SAFE_RUN_ID.test(runId || '')) {
      return {
        ok: false,
        resumePhase: null,
        resumePolicy: null,
        completed: [],
        degraded: !runId,
      };
    }
    if (getPhaseSequence(orchestrator).length === 0) {
      return { ok: false, resumePhase: null, resumePolicy: null, completed: [], degraded: true };
    }
    const context = phaseRunContext(runId, cwd, opts, { create: true });
    transitionLock = maybeTakeRunTransitionLock(context);
    if (runHasTerminalArtifact(context)) {
      return { ok: false, resumePhase: null, resumePolicy: null, completed: [], degraded: false };
    }
    const exists = Boolean(assertArtifactSafe(
      context, LOG_FILE_NAME, 'pipeline ledger', PIPELINE_MAX_BYTES,
    ));
    const { ledger, degraded: readDegraded } = readLedgerWithStatus(context, runId, orchestrator);
    if (exists && (readDegraded || ledger.orchestrator !== orchestrator)) {
      return { ok: false, resumePhase: null, resumePolicy: null, completed: [], degraded: true };
    }

    const normalized = exists ? ledger : freshLedgerFor(orchestrator, runId);
    const writeOk = writeLedger(context, normalized);
    const completionEventsOk = writeOk && getPhaseSequence(orchestrator)
      .filter(desc => normalized.phases[desc.id]?.status === 'completed')
      .every(desc => ensurePhaseCompletedEvent(context, normalized, desc.id));
    const finalLedger = normalized;
    const resume = firstNonTerminal(finalLedger);
    return {
      ok: writeOk && completionEventsOk,
      resumePhase: resume?.id || null,
      resumePolicy: resume?.onResume || null,
      completed: completedIds(finalLedger),
      degraded: readDegraded || !writeOk || !completionEventsOk,
    };
  } catch (error) {
    if (isUnsafePath(error)) {
      return { ok: false, resumePhase: null, resumePolicy: null, completed: [], degraded: false };
    }
    return { ok: false, resumePhase: null, resumePolicy: null, completed: [], degraded: true };
  } finally {
    releaseRunTransitionLock(transitionLock);
  }
}

/**
 * Enter a phase, skipping terminal linear phases and surfacing recover resumes.
 *
 * @param {string} runId
 * @param {string} phaseId
 * @param {{ cwd?: string, _validateEntry?: Function }} [opts]
 * @param {Function} [opts._validateEntry] Trusted synchronous callback invoked
 * while the run transition lock is held, after current-phase validation and
 * before the phase is entered or resumed.
 * @returns {{ proceed: boolean, skip: boolean, reason?: string, status: string, degraded: boolean }}
 */
export function enterPhase(runId, phaseId, opts = {}) {
  let transitionLock = null;
  try {
    const cwd = opts.cwd || process.cwd();
    if (!runId || !phaseId) return { proceed: true, skip: false, reason: 'fail-open', status: 'pending', degraded: true };
    const context = phaseRunContext(runId, cwd, opts);
    transitionLock = takeRunTransitionLock(context);
    if (runHasTerminalArtifact(context)) {
      return { proceed: false, skip: false, reason: 'run-terminal', status: 'failed', degraded: false };
    }
    const { ledger, degraded: readDegraded } = readLedgerWithStatus(context, runId);
    if (readDegraded || !isKnownLedger(ledger)) {
      return { proceed: true, skip: false, reason: 'fail-open', status: 'pending', degraded: true };
    }
    const desc = descriptorById(ledger.orchestrator, phaseId);
    if (!desc) return { proceed: false, skip: false, reason: 'unknown-phase', status: 'pending', degraded: false };

    const entry = ledger.phases[phaseId] || { status: 'pending' };
    const current = firstNonTerminal(ledger);
    if (TERMINAL_STATUSES.has(entry.status)) {
      const sequence = getPhaseSequence(ledger.orchestrator);
      const requestedIndex = sequence.findIndex(item => item.id === phaseId);
      const currentIndex = current
        ? sequence.findIndex(item => item.id === current.id)
        : sequence.length;
      if (requestedIndex > currentIndex) {
        return { proceed: false, skip: false, reason: 'out-of-order', status: entry.status, degraded: false };
      }
      return { proceed: false, skip: true, reason: entry.reason, status: entry.status, degraded: readDegraded };
    }

    if (current?.id !== phaseId) {
      return { proceed: false, skip: false, reason: 'out-of-order', status: entry.status, degraded: false };
    }

    if (entry.status === 'failed' && typeof entry.failureCode === 'string') {
      return {
        proceed: false,
        skip: false,
        reason: 'terminal-failure',
        status: entry.status,
        degraded: false,
      };
    }

    if (opts._validateEntry !== undefined) {
      if (typeof opts._validateEntry !== 'function') {
        return { proceed: false, skip: false, reason: 'invalid-entry-boundary', status: entry.status, degraded: false };
      }
      const validation = opts._validateEntry(Object.freeze({
        runId,
        orchestrator: ledger.orchestrator,
        phaseId,
        phaseAttempt: typeof entry.attempts === 'number' ? entry.attempts : 0,
        pipeline: Object.freeze(structuredClone(ledger)),
        _runLockOwner: transitionLock.owner,
      }));
      if (validation && typeof validation.then === 'function') {
        return { proceed: false, skip: false, reason: 'async-entry-boundary-denied', status: entry.status, degraded: false };
      }
    }

    if (desc.onResume === 'recover' && (entry.status === 'in_progress' || entry.status === 'failed')) {
      return { proceed: true, skip: false, reason: 'recover', status: entry.status, degraded: readDegraded };
    }

    const ts = nowIso();
    ledger.phases[phaseId] = {
      ...entry,
      status: 'in_progress',
      startedAt: entry.startedAt || ts,
      attempts: (typeof entry.attempts === 'number' ? entry.attempts : 0) + 1,
    };
    const ok = writeLedger(context, ledger);
    return { proceed: true, skip: false, status: 'in_progress', degraded: readDegraded || !ok };
  } catch (error) {
    if (isUnsafePath(error)) {
      return { proceed: false, skip: false, reason: 'unsafe-run-path', status: 'pending', degraded: false };
    }
    return { proceed: false, skip: false, reason: 'transition-busy', status: 'pending', degraded: true };
  } finally {
    releaseRunTransitionLock(transitionLock);
  }
}

/**
 * Tick the outer attempt cap once and mirror the count into the ledger.
 *
 * @param {string} runId
 * @param {{ cwd?: string }} [opts]
 * @returns {{ allowed: boolean, count: number, cap: number, degraded: boolean }}
 */
export function beginAttempt(runId, opts = {}) {
  let transitionLock = null;
  try {
    const cwd = opts.cwd || process.cwd();
    if (!runId) return failOpenAttempt();
    const context = phaseRunContext(runId, cwd, opts);
    transitionLock = takeRunTransitionLock(context);
    if (runHasTerminalArtifact(context)) return blockedAttempt(null, false);
    const { ledger, degraded: readDegraded } = readLedgerWithStatus(context, runId);
    if (readDegraded || !isKnownLedger(ledger)) return failOpenAttempt();
    const attemptPhase = attemptPhaseId(ledger.orchestrator);
    if (currentPhaseId(ledger) !== attemptPhase || ledger.attempt !== 0) {
      return blockedAttempt(ledger, false);
    }
    assertSafeLoopGuard(context);
    const r = registerIteration(runId, { cwd: context.cwd });
    assertSafeLoopGuard(context);
    if (r.allowed) {
      ledger.attempt = r.count;
      const ok = writeLedger(context, ledger);
      return { ...r, degraded: r.degraded || readDegraded || !ok };
    }
    return r;
  } catch (error) {
    if (isUnsafePath(error)) return blockedAttempt(null, false);
    return { allowed: false, count: 0, cap: DEFAULT_ITERATION_CAP, degraded: true };
  } finally {
    releaseRunTransitionLock(transitionLock);
  }
}

function writeReattemptLedger(context, ledger, stage, opts) {
  if (opts._writeReattemptLedger === undefined) return writeLedger(context, ledger);
  if (typeof opts._writeReattemptLedger !== 'function') return false;
  try {
    return opts._writeReattemptLedger(
      Object.freeze({ stage, pipeline: Object.freeze(structuredClone(ledger)) }),
      () => writeLedger(context, ledger),
    ) === true;
  } catch {
    return false;
  }
}

function afterReattemptBoundary(opts, boundary) {
  if (opts._afterReattemptBoundary === undefined) return;
  if (typeof opts._afterReattemptBoundary !== 'function') {
    throw new TypeError('invalid reattempt durability callback');
  }
  opts._afterReattemptBoundary(boundary);
}

function matchingPendingRequest(pending, requested, reason) {
  return pending.reason === reason
    && pending.reopen.length === requested.length
    && pending.reopen.every((phaseId, index) => phaseId === requested[index]);
}

function replayCommittedReattempt(context, runId, ledger, requested, reason) {
  const receipt = ledger.reattemptReceipt;
  if (!isPlainObject(receipt)
    || !isValidReattemptReceipt(receipt, ledger)
    || ledger.attempt !== receipt.targetAttempt) return null;
  const current = firstNonTerminal(ledger);
  const firstReopened = receipt.reopen[0];
  const entry = ledger.phases[firstReopened];
  if (current?.id !== firstReopened
    || !['pending', 'in_progress'].includes(entry?.status)
    || (receipt.reason && entry.reason !== receipt.reason)) return null;
  if (!matchingPendingRequest(receipt, requested, reason)) {
    return entry.status === 'pending'
      ? {
          ...blockedAttempt(ledger, true),
          reopened: [],
          reason: 'committed-reattempt-conflict',
        }
      : null;
  }

  assertSafeLoopGuard(context);
  const iteration = getCounter(runId, 'iterations', {
    cwd: context.cwd,
    cap: DEFAULT_ITERATION_CAP,
  });
  assertSafeLoopGuard(context);
  if (iteration.count !== receipt.targetAttempt) {
    return {
      allowed: false,
      count: iteration.count,
      cap: iteration.cap,
      reopened: [],
      degraded: true,
      reason: 'committed-reattempt-counter-conflict',
    };
  }
  let quality = null;
  if (receipt.reason === 'quality_fail') {
    assertSafeLoopGuard(context);
    quality = getCounter(runId, 'quality-cycles', {
      cwd: context.cwd,
      cap: QUALITY_CAP,
    });
    assertSafeLoopGuard(context);
    if (quality.count !== receipt.qualityBaseCount + 1) {
      return {
        allowed: false,
        count: iteration.count,
        cap: iteration.cap,
        qualityCount: quality.count,
        qualityCap: quality.cap,
        reopened: [],
        degraded: true,
        reason: 'committed-reattempt-counter-conflict',
      };
    }
  }
  return {
    allowed: true,
    count: receipt.targetAttempt,
    cap: DEFAULT_ITERATION_CAP,
    ...(quality ? { qualityCount: quality.count, qualityCap: quality.cap } : {}),
    reopened: [...receipt.reopen],
    reused: true,
    degraded: false,
  };
}

function reconcilePendingCounter(context, runId, name, cap, baseCount, targetCount) {
  assertSafeLoopGuard(context);
  const before = getCounter(runId, name, { cwd: context.cwd, cap });
  assertSafeLoopGuard(context);
  if (!Number.isInteger(before.count)
    || before.count < 0
    || before.count > before.cap
    || (before.count !== baseCount && before.count !== targetCount)) {
    return { ok: false, counter: before, consumed: false, reason: 'counter-conflict' };
  }
  if (before.count === targetCount) {
    return { ok: true, counter: before, consumed: false };
  }
  const registered = name === 'iterations'
    ? registerIteration(runId, { cwd: context.cwd, cap })
    : registerCounter(runId, name, { cwd: context.cwd, cap });
  assertSafeLoopGuard(context);
  const after = getCounter(runId, name, { cwd: context.cwd, cap });
  assertSafeLoopGuard(context);
  if (registered.allowed !== true
    || registered.degraded === true
    || after.count !== targetCount) {
    return { ok: false, counter: after, consumed: true, reason: 'counter-write-failed' };
  }
  return { ok: true, counter: after, consumed: true };
}

function reconcilePendingReattempt(context, runId, ledger, requested, reason, opts) {
  const pending = ledger.pendingReattempt;
  if (!isValidPendingReattempt(pending, ledger)
    || !matchingPendingRequest(pending, requested, reason)) {
    return {
      ...blockedAttempt(ledger, true),
      reopened: [],
      reason: 'pending-reattempt-conflict',
    };
  }

  let quality = null;
  if (pending.reason === 'quality_fail') {
    quality = reconcilePendingCounter(
      context,
      runId,
      'quality-cycles',
      QUALITY_CAP,
      pending.qualityBaseCount,
      pending.qualityBaseCount + 1,
    );
    if (!quality.ok) {
      return {
        allowed: false,
        count: pending.baseAttempt,
        cap: DEFAULT_ITERATION_CAP,
        qualityCount: quality.counter.count,
        qualityCap: quality.counter.cap,
        reopened: [],
        degraded: true,
        reason: quality.reason,
      };
    }
    if (quality.consumed) afterReattemptBoundary(opts, 'quality');
  }

  const iteration = reconcilePendingCounter(
    context,
    runId,
    'iterations',
    DEFAULT_ITERATION_CAP,
    pending.baseAttempt,
    pending.targetAttempt,
  );
  if (!iteration.ok) {
    return {
      allowed: false,
      count: iteration.counter.count,
      cap: iteration.counter.cap,
      ...(quality
        ? { qualityCount: quality.counter.count, qualityCap: quality.counter.cap }
        : {}),
      reopened: [],
      degraded: true,
      reason: iteration.reason,
    };
  }
  if (iteration.consumed) afterReattemptBoundary(opts, 'iteration');

  const sequence = getPhaseSequence(ledger.orchestrator);
  const rewindIndex = Math.min(...pending.reopen.map(phaseId => (
    sequence.findIndex(desc => desc.id === phaseId)
  )));
  const reopened = [];
  // Rewinding invalidates the whole tail, including the currently in-progress
  // review. Keeping it in_progress would leave touched work after the new
  // current phase and let a later failure cut become ambiguous.
  for (let index = rewindIndex; index < sequence.length; index += 1) {
    const phaseId = sequence[index].id;
    const prior = ledger.phases[phaseId] || { status: 'pending' };
    ledger.phases[phaseId] = {
      status: 'pending',
      ...(typeof prior.attempts === 'number' ? { attempts: prior.attempts } : {}),
      ...(pending.reason ? { reason: pending.reason } : {}),
    };
    if (pending.reopen.includes(phaseId)) reopened.push(phaseId);
  }
  ledger.attempt = pending.targetAttempt;
  ledger.reattemptReceipt = structuredClone(pending);
  delete ledger.pendingReattempt;
  const committed = writeReattemptLedger(context, ledger, 'commit', opts);
  if (!committed) {
    return {
      allowed: false,
      count: pending.targetAttempt,
      cap: DEFAULT_ITERATION_CAP,
      ...(quality
        ? { qualityCount: quality.counter.count, qualityCap: quality.counter.cap }
        : {}),
      reopened: [],
      degraded: true,
      reason: 'pipeline-commit-failed',
    };
  }
  return {
    allowed: true,
    count: pending.targetAttempt,
    cap: DEFAULT_ITERATION_CAP,
    ...(quality
      ? { qualityCount: quality.counter.count, qualityCap: quality.counter.cap }
      : {}),
    reopened,
    degraded: false,
  };
}

/**
 * Crash-safely tick the outer attempt cap and reopen the requested phases.
 * A durable pending intent makes the quality counter, iteration counter, and
 * pipeline rewind replayable as one logical transition.
 *
 * @param {string} runId
 * @param {{ reopen?: string[], reason?: string }} request
 * @param {{ cwd?: string, _beforeRewind?: Function, _afterReattemptBoundary?: Function, _writeReattemptLedger?: Function }} [opts]
 * @param {Function} [opts._beforeRewind] Trusted synchronous callback invoked
 * only after traversal and cap preflight succeed, while the run transition
 * lock is held, and before the durable intent or either cap is mutated.
 * @param {Function} [opts._afterReattemptBoundary] Test-only synchronous fault
 * seam invoked after a newly consumed durable counter boundary.
 * @param {Function} [opts._writeReattemptLedger] Test-only pipeline writer seam.
 * @returns {{ allowed: boolean, count: number, cap: number, reopened: string[], degraded: boolean }}
 */
export function reattempt(runId, request = {}, opts = {}) {
  let transitionLock = null;
  try {
    const cwd = opts.cwd || process.cwd();
    if (!runId) return { ...failOpenAttempt(), reopened: [] };
    if ((opts._beforeRewind !== undefined && typeof opts._beforeRewind !== 'function')
      || (opts._afterReattemptBoundary !== undefined
        && typeof opts._afterReattemptBoundary !== 'function')
      || (opts._writeReattemptLedger !== undefined
        && typeof opts._writeReattemptLedger !== 'function')
      || (request.reason !== undefined && typeof request.reason !== 'string')) {
      return { ...blockedAttempt(null, true), reopened: [] };
    }
    const context = phaseRunContext(runId, cwd, opts);
    transitionLock = takeRunTransitionLock(context);
    if (runHasTerminalArtifact(context)) return { ...blockedAttempt(null, false), reopened: [] };
    const { ledger, degraded: readDegraded } = readLedgerWithStatus(context, runId);
    if (readDegraded || !isKnownLedger(ledger)) {
      return { ...failOpenAttempt(), reopened: [] };
    }
    const sequence = getPhaseSequence(ledger.orchestrator);
    const uniqueRequested = Array.isArray(request.reopen)
      ? [...new Set(request.reopen)]
      : [];
    const requested = canonicalReopen(ledger.orchestrator, uniqueRequested);
    const reason = request.reason || '';
    if (requested.length !== uniqueRequested.length) {
      return { ...blockedAttempt(ledger, false), reopened: [] };
    }

    if (ledger.pendingReattempt) {
      return reconcilePendingReattempt(context, runId, ledger, requested, reason, opts);
    }
    const committedReplay = replayCommittedReattempt(
      context, runId, ledger, requested, reason,
    );
    if (committedReplay) return committedReplay;

    const current = firstNonTerminal(ledger);
    const currentIndex = current
      ? sequence.findIndex(desc => desc.id === current.id)
      : -1;
    const validRewind = ledger.attempt >= 1 && currentIndex >= 0 && requested.length > 0 &&
      requested.every(phaseId => {
        const targetIndex = sequence.findIndex(desc => desc.id === phaseId);
        const status = ledger.phases[phaseId]?.status || 'pending';
        return targetIndex >= 0 && targetIndex <= currentIndex &&
          (TERMINAL_STATUSES.has(status) || phaseId === current.id);
      });
    if (!validRewind) return { ...blockedAttempt(ledger, false), reopened: [] };

    const currentDesc = descriptorById(ledger.orchestrator, current.id);
    const currentLoopKey = normalizeLoopKey(completionLoopKey(ledger.orchestrator, currentDesc));
    if (currentLoopKey && ATTEMPT_BOUND_LOOP_KEYS.has(currentLoopKey)) {
      const spec = loopCounterSpec(ledger.orchestrator, currentLoopKey);
      assertSafeLoopGuard(context);
      const counter = getCounter(runId, spec.name, { cwd: context.cwd, cap: spec.cap });
      assertSafeLoopGuard(context);
      if (!currentAttemptHasLoopTick(ledger.phases[current.id], currentLoopKey, counter)) {
        return { ...blockedAttempt(ledger, false), reopened: [] };
      }
    }

    assertSafeLoopGuard(context);
    const preflight = getCounter(runId, 'iterations', {
      cwd: context.cwd,
      cap: DEFAULT_ITERATION_CAP,
    });
    assertSafeLoopGuard(context);
    if (preflight.count !== ledger.attempt || preflight.count >= preflight.cap) {
      return {
        allowed: false,
        count: preflight.count,
        cap: preflight.cap,
        reopened: [],
        degraded: preflight.count !== ledger.attempt,
      };
    }
    let qualityPreflight = null;
    if (reason === 'quality_fail') {
      assertSafeLoopGuard(context);
      qualityPreflight = getCounter(runId, 'quality-cycles', {
        cwd: context.cwd,
        cap: QUALITY_CAP,
      });
      assertSafeLoopGuard(context);
      if (!qualityPreflight
        || !Number.isInteger(qualityPreflight.count)
        || qualityPreflight.count < 0
        || qualityPreflight.count >= qualityPreflight.cap) {
        return {
          allowed: false,
          count: preflight.count,
          cap: preflight.cap,
          qualityCount: qualityPreflight?.count ?? 0,
          qualityCap: qualityPreflight?.cap ?? QUALITY_CAP,
          reopened: [],
          degraded: !qualityPreflight,
        };
      }
    }
    if (opts._beforeRewind) {
      opts._beforeRewind(Object.freeze({
        runId,
        orchestrator: ledger.orchestrator,
        currentPhase: current.id,
        reopen: Object.freeze([...requested]),
        reason,
        nextAttempt: preflight.count + 1,
      }));
    }

    ledger.pendingReattempt = {
      schemaVersion: REATTEMPT_INTENT_SCHEMA_VERSION,
      runId: ledger.runId || runId,
      orchestrator: ledger.orchestrator,
      reason,
      currentPhase: current.id,
      reopen: [...requested],
      baseAttempt: preflight.count,
      targetAttempt: preflight.count + 1,
      ...(qualityPreflight ? { qualityBaseCount: qualityPreflight.count } : {}),
    };
    if (!writeReattemptLedger(context, ledger, 'prepare', opts)) {
      return {
        allowed: false,
        count: preflight.count,
        cap: preflight.cap,
        ...(qualityPreflight
          ? { qualityCount: qualityPreflight.count, qualityCap: qualityPreflight.cap }
          : {}),
        reopened: [],
        degraded: true,
        reason: 'reattempt-intent-write-failed',
      };
    }
    return reconcilePendingReattempt(context, runId, ledger, requested, reason, opts);
  } catch (error) {
    if (isUnsafePath(error)) return { ...blockedAttempt(null, false), reopened: [] };
    return { allowed: false, count: 0, cap: DEFAULT_ITERATION_CAP, reopened: [], degraded: true };
  } finally {
    releaseRunTransitionLock(transitionLock);
  }
}

/**
 * Tick a bounded phase/sub-loop counter through loop-guard.
 *
 * @param {string} runId
 * @param {string} keyOrPhaseId - 'review'|'monitor'|'ci'|'quality' or a phase id
 * @param {{ cwd?: string }} [opts]
 * @returns {{ allowed: boolean, count: number, cap: number, degraded: boolean }}
 */
export function loopTick(runId, keyOrPhaseId, opts = {}) {
  let transitionLock = null;
  try {
    const cwd = opts.cwd || process.cwd();
    if (!runId) return { allowed: true, count: 0, cap: 0, degraded: true };
    const context = phaseRunContext(runId, cwd, opts);
    transitionLock = takeRunTransitionLock(context);
    if (runHasTerminalArtifact(context)) {
      return { allowed: false, count: 0, cap: 0, degraded: false, reason: 'run-terminal' };
    }
    const { ledger, degraded: readDegraded } = readLedgerWithStatus(context, runId);
    if (readDegraded || !isKnownLedger(ledger)) {
      return { allowed: true, count: 0, cap: 0, degraded: true };
    }
    let key = normalizeLoopKey(keyOrPhaseId);
    if (!key && keyOrPhaseId) {
      const desc = descriptorById(ledger.orchestrator, keyOrPhaseId);
      key = normalizeLoopKey(desc?.loopGuard);
    }
    const spec = loopCounterSpec(ledger.orchestrator, key);
    if (!spec) return { allowed: false, count: 0, cap: 0, degraded: false };
    if (currentPhaseId(ledger) !== spec.phaseId
      || ledger.phases[spec.phaseId]?.status !== 'in_progress') {
      assertSafeLoopGuard(context);
      const existing = getCounter(runId, spec.name, { cwd: context.cwd, cap: spec.cap });
      assertSafeLoopGuard(context);
      return { allowed: false, ...existing, degraded: false, reason: 'phase-not-in-progress' };
    }
    assertSafeLoopGuard(context);
    const prior = ledger.phases[spec.phaseId];
    if (ATTEMPT_BOUND_LOOP_KEYS.has(key)) {
      const existing = getCounter(runId, spec.name, { cwd: context.cwd, cap: spec.cap });
      assertSafeLoopGuard(context);
      if (!Number.isInteger(prior?.attempts) || prior.attempts < 1
        || !Number.isInteger(existing.count)
        || existing.count < 0
        || existing.count > existing.cap) {
        return { allowed: false, ...existing, degraded: false, reason: 'attempt-counter-invalid' };
      }
      if (existing.count === prior.attempts) {
        return { allowed: true, ...existing, reused: true, degraded: false };
      }
      if (existing.count !== prior.attempts - 1) {
        return { allowed: false, ...existing, degraded: false, reason: 'attempt-counter-mismatch' };
      }
    }
    let result;
    if (key === 'review') result = registerReviewRound(runId, { cwd: context.cwd });
    else if (key === 'final-review') {
      result = registerCounter(runId, 'finalReviewRounds', {
        cwd: context.cwd,
        cap: FINAL_REVIEW_CAP,
      });
    }
    else if (key === 'monitor') result = registerCounter(runId, 'monitor-iterations', { cwd: context.cwd, cap: MONITOR_CAP });
    else if (key === 'ci') result = registerCounter(runId, 'ci-cycles', { cwd: context.cwd, cap: CI_CAP });
    else if (key === 'quality') result = registerCounter(runId, 'quality-cycles', { cwd: context.cwd, cap: QUALITY_CAP });
    if (result) {
      assertSafeLoopGuard(context);
      if (ATTEMPT_BOUND_LOOP_KEYS.has(key)
        && result.allowed === true
        && result.count !== prior.attempts) {
        return { ...result, allowed: false, degraded: true, reason: 'attempt-counter-write-mismatch' };
      }
      return result;
    }
    return { allowed: true, count: 0, cap: 0, degraded: true };
  } catch (error) {
    if (isUnsafePath(error)) {
      return { allowed: false, count: 0, cap: 0, degraded: false, reason: 'unsafe-run-path' };
    }
    return { allowed: false, count: 0, cap: 0, degraded: true };
  } finally {
    releaseRunTransitionLock(transitionLock);
  }
}

/**
 * Run one synchronous trusted boundary while proving that the exact current
 * phase attempt has consumed its code-owned review tick. The proof and the
 * callback share the run transition lock, so a concurrent rewind cannot make
 * a stale approval current between the check and its persistence.
 *
 * This boundary is intentionally limited to attempt-bound review loops. The
 * quality loop is enforced by completePhase(), while monitor/CI are ordinary
 * bounded work loops rather than approval capabilities.
 *
 * @param {string} runId
 * @param {string} phaseId
 * @param {'review'|'final-review'} keyOrPhaseId
 * @param {Function} operation trusted synchronous callback
 * @param {{ cwd?: string, base?: string, trustedRoot?: string }} [opts]
 * @returns {{ok:boolean,result?:*,reason?:string,degraded:boolean}}
 */
export function withCurrentPhaseLoopTick(
  runId,
  phaseId,
  keyOrPhaseId,
  operation,
  opts = {},
) {
  let transitionLock = null;
  try {
    const cwd = opts.cwd || process.cwd();
    if (!runId || !phaseId || typeof operation !== 'function') {
      return { ok: false, reason: 'invalid-loop-boundary', degraded: false };
    }
    const context = phaseRunContext(runId, cwd, opts);
    transitionLock = takeRunTransitionLock(context);
    if (runHasTerminalArtifact(context)) {
      return { ok: false, reason: 'run-terminal', degraded: false };
    }
    const { ledger, degraded } = readLedgerWithStatus(context, runId);
    if (degraded || !isKnownLedger(ledger)) {
      return { ok: false, reason: 'pipeline-unavailable', degraded: true };
    }
    const key = normalizeLoopKey(keyOrPhaseId);
    const spec = loopCounterSpec(ledger.orchestrator, key);
    const prior = ledger.phases[phaseId];
    if (!['review', 'final-review'].includes(key)
      || !spec
      || spec.phaseId !== phaseId
      || currentPhaseId(ledger) !== phaseId
      || prior?.status !== 'in_progress') {
      return { ok: false, reason: 'phase-loop-mismatch', degraded: false };
    }
    assertSafeLoopGuard(context);
    const counter = getCounter(runId, spec.name, { cwd: context.cwd, cap: spec.cap });
    assertSafeLoopGuard(context);
    if (!currentAttemptHasLoopTick(prior, key, counter)) {
      return { ok: false, reason: 'phase-loop-tick-required', degraded: false };
    }
    const result = operation(Object.freeze({
      runId,
      orchestrator: ledger.orchestrator,
      phaseId,
      phaseAttempt: prior.attempts,
      loopKey: key,
      loopCount: counter.count,
      pipeline: Object.freeze(structuredClone(ledger)),
      _runLockOwner: transitionLock.owner,
    }));
    if (result && typeof result.then === 'function') {
      return { ok: false, reason: 'async-loop-boundary-denied', degraded: false };
    }
    return { ok: true, result, degraded: false };
  } catch (error) {
    return {
      ok: false,
      reason: isUnsafePath(error) ? 'unsafe-run-path' : 'loop-boundary-operation-failed',
      degraded: !isUnsafePath(error),
    };
  } finally {
    releaseRunTransitionLock(transitionLock);
  }
}

/**
 * Inspect whether the current phase's loop marker is already sufficient for
 * completion and whether another code-owned tick is meaningful. Review,
 * final-review, and quality expose one idempotent marker per phase attempt;
 * monitor and CI remain genuine bounded multi-cycle loops.
 *
 * @param {string} runId
 * @param {string} keyOrPhaseId
 * @param {{ cwd?: string, base?: string, trustedRoot?: string }} [opts]
 * @returns {{ok:boolean,key?:string,phaseId?:string,count?:number,cap?:number,phaseAttempt?:number,satisfied?:boolean,canTick?:boolean,reason?:string,degraded:boolean}}
 */
export function inspectCurrentPhaseLoop(runId, keyOrPhaseId, opts = {}) {
  let transitionLock = null;
  try {
    const cwd = opts.cwd || process.cwd();
    if (!runId) return { ok: false, reason: 'invalid-loop-boundary', degraded: false };
    const context = phaseRunContext(runId, cwd, opts);
    transitionLock = takeRunTransitionLock(context);
    if (runHasTerminalArtifact(context)) {
      return { ok: false, reason: 'run-terminal', degraded: false };
    }
    const { ledger, degraded } = readLedgerWithStatus(context, runId);
    if (degraded || !isKnownLedger(ledger)) {
      return { ok: false, reason: 'pipeline-unavailable', degraded: true };
    }
    let key = normalizeLoopKey(keyOrPhaseId);
    if (!key && keyOrPhaseId) {
      key = normalizeLoopKey(descriptorById(ledger.orchestrator, keyOrPhaseId)?.loopGuard);
    }
    const spec = loopCounterSpec(ledger.orchestrator, key);
    const prior = spec ? ledger.phases[spec.phaseId] : null;
    if (!spec
      || currentPhaseId(ledger) !== spec.phaseId
      || prior?.status !== 'in_progress') {
      return { ok: false, reason: 'phase-loop-mismatch', degraded: false };
    }
    assertSafeLoopGuard(context);
    const counter = getCounter(runId, spec.name, { cwd: context.cwd, cap: spec.cap });
    assertSafeLoopGuard(context);
    const attemptBound = ATTEMPT_BOUND_LOOP_KEYS.has(key);
    const phaseAttempt = Number.isInteger(prior.attempts) ? prior.attempts : 0;
    const counterValid = Number.isInteger(counter.count)
      && Number.isInteger(counter.cap)
      && counter.count >= 0
      && counter.count <= counter.cap;
    const satisfied = counterValid && currentAttemptHasLoopTick(prior, key, counter);
    const canTick = counterValid && counter.count < counter.cap && (
      attemptBound ? counter.count === phaseAttempt - 1 : true
    );
    return {
      ok: counterValid,
      key,
      phaseId: spec.phaseId,
      count: counter.count,
      cap: counter.cap,
      phaseAttempt,
      satisfied,
      canTick,
      ...(counterValid ? {} : { reason: 'loop-counter-invalid' }),
      degraded: false,
    };
  } catch (error) {
    return {
      ok: false,
      reason: isUnsafePath(error) ? 'unsafe-run-path' : 'loop-inspection-failed',
      degraded: !isUnsafePath(error),
    };
  } finally {
    releaseRunTransitionLock(transitionLock);
  }
}

/**
 * Record a repeated phase error through loop-guard's signature tracker.
 *
 * @param {string} runId
 * @param {string} phaseId - caller clarity only; loop-guard owns the signature key
 * @param {*} errorSig
 * @param {{ cwd?: string }} [opts]
 * @returns {{ shouldEscalate: boolean, repeatCount: number, threshold: number, degraded: boolean }}
 */
export function recordPhaseError(runId, phaseId, errorSig, opts = {}) {
  let transitionLock = null;
  try {
    const cwd = opts.cwd || process.cwd();
    if (!runId) return recordError(runId, errorSig, { cwd });
    const context = phaseRunContext(runId, cwd, opts, { create: true });
    transitionLock = maybeTakeRunTransitionLock(context);
    if (runHasTerminalArtifact(context)) {
      return { shouldEscalate: false, repeatCount: 0, threshold: 3, degraded: false };
    }
    void phaseId;
    assertSafeLoopGuard(context);
    const result = recordError(runId, errorSig, { cwd: context.cwd });
    assertSafeLoopGuard(context);
    return result;
  } catch (error) {
    if (isUnsafePath(error)) {
      return {
        shouldEscalate: true,
        repeatCount: 3,
        threshold: 3,
        degraded: false,
        reason: 'unsafe-run-path',
      };
    }
    return { shouldEscalate: false, repeatCount: 0, threshold: 3, degraded: true };
  } finally {
    releaseRunTransitionLock(transitionLock);
  }
}

/**
 * Make the exact current phase durably terminal as a categorized failure.
 *
 * This is the only supported `in_progress -> failed` transition. It preserves
 * later phases as pending, so a terminal-failure artifact has an unambiguous
 * cut in the ordered ledger. Repeating the same phase/code is idempotent;
 * reclassification and every other traversal fail closed.
 *
 * @param {string} runId
 * @param {string} phaseId
 * @param {string} failureCode allowlisted by the caller's failure taxonomy
 * @param {{ cwd?: string, base?: string }} [opts]
 * @returns {{ ok: boolean, idempotent: boolean, degraded: boolean }}
 */
export function failPhase(runId, phaseId, failureCode, opts = {}) {
  let transitionLock = null;
  try {
    const cwd = opts.cwd || process.cwd();
    if (!runId || !phaseId || !FAILURE_CODE.test(failureCode || '')) {
      return { ok: false, idempotent: false, degraded: false };
    }
    const context = phaseRunContext(runId, cwd, opts, {
      allowHeldLockAnchor: Boolean(opts._runLockOwner),
    });
    transitionLock = takeRunTransitionLock(context, opts._runLockOwner || null);
    if (runHasTerminalArtifact(context)
      && !(opts._runLockOwner && runSummaryStatus(context) === 'running')) {
      return { ok: false, idempotent: false, degraded: false };
    }
    const { ledger, degraded } = readLedgerWithStatus(context, runId);
    if (degraded || !isKnownLedger(ledger)) {
      return { ok: false, idempotent: false, degraded: true };
    }
    const desc = descriptorById(ledger.orchestrator, phaseId);
    const prior = ledger.phases[phaseId];
    if (!desc || !prior || currentPhaseId(ledger) !== phaseId) {
      return { ok: false, idempotent: false, degraded: false };
    }
    if (prior.status === 'failed') {
      const exact = prior.failureCode === failureCode;
      const eventOk = exact
        && ensurePhaseFailedEvent(context, ledger, phaseId, failureCode);
      return {
        ok: eventOk,
        idempotent: eventOk,
        degraded: exact && !eventOk,
      };
    }
    if (prior.status !== 'in_progress') {
      return { ok: false, idempotent: false, degraded: false };
    }
    const failedAt = nowIso();
    ledger.phases[phaseId] = {
      ...prior,
      status: 'failed',
      failureCode,
      failedAt,
      completedAt: failedAt,
    };
    const ok = writeLedger(context, ledger);
    const eventOk = ok && ensurePhaseFailedEvent(
      context, ledger, phaseId, failureCode,
    );
    return { ok: eventOk, idempotent: false, degraded: !eventOk };
  } catch (error) {
    if (isUnsafePath(error)) return { ok: false, idempotent: false, degraded: false };
    return { ok: false, idempotent: false, degraded: true };
  } finally {
    releaseRunTransitionLock(transitionLock);
  }
}

/**
 * Persist tiny recovery metadata while a phase is still in progress.
 *
 * Recoverable Athena phases need to record identities such as `teamSlug`
 * before launching non-idempotent workers. This deliberately does not mark the
 * phase complete and accepts only the same bounded scalar output contract used
 * by completePhase().
 *
 * @param {string} runId
 * @param {string} phaseId
 * @param {object} outputs
 * @param {{ cwd?: string }} [opts]
 * @returns {{ ok: boolean, degraded: boolean }}
 */
export function recordPhaseOutputs(runId, phaseId, outputs, opts = {}) {
  let transitionLock = null;
  try {
    const cwd = opts.cwd || process.cwd();
    if (!runId || !phaseId) return { ok: false, degraded: true };
    const context = phaseRunContext(runId, cwd, opts);
    transitionLock = takeRunTransitionLock(context);
    if (runHasTerminalArtifact(context)) return { ok: false, degraded: false };
    const { ledger, degraded: readDegraded } = readLedgerWithStatus(context, runId);
    const desc = descriptorById(ledger.orchestrator, phaseId);
    const prior = ledger.phases[phaseId];
    const update = sanitizeRecoveryOutputs(outputs);
    if (readDegraded || !desc || desc.onResume !== 'recover' || currentPhaseId(ledger) !== phaseId ||
        !prior || prior.status !== 'in_progress' || !update) {
      return { ok: false, degraded: readDegraded };
    }
    const tinyOutputs = sanitizeRecoveryOutputs({
      ...(isPlainObject(prior.outputs) ? prior.outputs : {}),
      ...update,
    });
    if (!tinyOutputs) return { ok: false, degraded: readDegraded };
    ledger.phases[phaseId] = { ...prior, outputs: tinyOutputs };
    const ledgerOk = writeLedger(context, ledger);
    const eventOk = ledgerOk && ensurePhaseOutputsEvent(
      context, ledger, phaseId, tinyOutputs,
    );
    return { ok: ledgerOk && eventOk, degraded: readDegraded || !ledgerOk || !eventOk };
  } catch (error) {
    if (isUnsafePath(error)) return { ok: false, degraded: false };
    return { ok: false, degraded: true };
  } finally {
    releaseRunTransitionLock(transitionLock);
  }
}

/**
 * Complete a phase. Recoverable Athena phases durably checkpoint before their
 * ledger/event transition; all other phases retain ledger/event/checkpoint
 * ordering. Tests may inject `opts._saveCheckpoint`; production uses
 * checkpoint.mjs by default. Set `opts.saveCheckpoint=false` only when a
 * caller deliberately owns equivalent durability (for example hermetic tests).
 *
 * @param {string} runId
 * @param {string} phaseId
 * @param {object} [outputs]
 * @param {{ cwd?: string, sessionId?: string, saveCheckpoint?: boolean, _saveCheckpoint?: Function, checkpointData?: object, _deriveOutputs?: Function }} [opts]
 * @param {Function} [opts._deriveOutputs] Trusted synchronous evidence callback
 * invoked after phase/loop validation while the run transition lock is held.
 * It must return the bounded outputs that become authoritative for completion;
 * caller-supplied outputs and this callback are mutually exclusive.
 * @returns {Promise<{ ok: boolean, next: string|null, checkpointDegraded: boolean, degraded: boolean }>}
 */
export async function completePhase(runId, phaseId, outputs = undefined, opts = {}) {
  let transitionLock = null;
  try {
    const cwd = opts.cwd || process.cwd();
    if (!runId || !phaseId) return { ok: false, next: null, checkpointDegraded: false, degraded: true };
    const context = phaseRunContext(runId, cwd, opts);
    transitionLock = takeRunTransitionLock(context);
    if (runHasTerminalArtifact(context)) {
      return { ok: false, next: null, checkpointDegraded: false, degraded: false };
    }
    const { ledger, degraded: readDegraded } = readLedgerWithStatus(context, runId);
    if (readDegraded || !isKnownLedger(ledger)) {
      return { ok: true, next: null, checkpointDegraded: false, degraded: true };
    }
    const desc = descriptorById(ledger.orchestrator, phaseId);
    if (!desc) return { ok: false, next: currentPhaseId(ledger), checkpointDegraded: false, degraded: false };

    const prior = ledger.phases[phaseId] || { status: 'pending' };
    if (prior.status === 'completed') {
      const eventOk = ensurePhaseCompletedEvent(context, ledger, phaseId);
      return {
        ok: eventOk,
        next: safeNextAfter(ledger, phaseId),
        checkpointDegraded: false,
        degraded: !eventOk,
      };
    }
    const completableStatus = prior.status === 'in_progress' ||
      (desc.onResume === 'recover'
        && prior.status === 'failed'
        && typeof prior.failureCode !== 'string');
    if (currentPhaseId(ledger) !== phaseId || !completableStatus) {
      return {
        ok: false,
        next: currentPhaseId(ledger),
        checkpointDegraded: false,
        degraded: false,
      };
    }
    const requiredLoopKey = completionLoopKey(ledger.orchestrator, desc);
    if (requiredLoopKey) {
      const normalizedLoopKey = normalizeLoopKey(requiredLoopKey);
      const spec = loopCounterSpec(ledger.orchestrator, normalizedLoopKey);
      if (spec) assertSafeLoopGuard(context);
      const counter = spec ? getCounter(runId, spec.name, { cwd: context.cwd, cap: spec.cap }) : { count: 0 };
      if (spec) assertSafeLoopGuard(context);
      if (!spec || !currentAttemptHasLoopTick(prior, normalizedLoopKey, counter)) {
        return { ok: false, next: phaseId, checkpointDegraded: false, degraded: false };
      }
    }
    let completionOutputs = outputs;
    if (opts._deriveOutputs !== undefined) {
      if (outputs !== undefined || typeof opts._deriveOutputs !== 'function') {
        return { ok: false, next: phaseId, checkpointDegraded: false, degraded: false };
      }
      completionOutputs = opts._deriveOutputs(Object.freeze({
        runId,
        orchestrator: ledger.orchestrator,
        phaseId,
        attempt: ledger.attempt,
        phaseAttempt: prior.attempts,
        phaseStartedAt: prior.startedAt,
        _runLockOwner: transitionLock.owner,
      }));
    }
    const hasRecoveryOutputs = isPlainObject(prior.outputs);
    const mergedOutputs = {
      ...(hasRecoveryOutputs ? prior.outputs : {}),
      ...(isPlainObject(completionOutputs) ? completionOutputs : {}),
    };
    const hasCompletionOutputs = isPlainObject(completionOutputs);
    const requiresStrictOutputs = desc.onResume === 'recover' &&
      (hasRecoveryOutputs || hasCompletionOutputs);
    const tinyOutputs = requiresStrictOutputs
      ? sanitizeRecoveryOutputs(mergedOutputs)
      : sanitizeOutputs(completionOutputs);
    if (requiresStrictOutputs && !tinyOutputs) {
      return { ok: false, next: null, checkpointDegraded: false, degraded: false };
    }
    const completedLedger = {
      ...ledger,
      phases: {
        ...ledger.phases,
        [phaseId]: {
          ...prior,
          status: 'completed',
          completedAt: nowIso(),
          ...(tinyOutputs ? { outputs: tinyOutputs } : {}),
        },
      },
    };
    const next = safeNextAfter(completedLedger, phaseId);

    const checkpointEnabled = opts.saveCheckpoint !== false && typeof desc.checkpointIndex === 'number';
    const checkpointPayload = {
      ...(isPlainObject(opts.checkpointData) ? opts.checkpointData : {}),
      phase: desc.checkpointIndex,
      phaseId,
      runId,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    };

    const saveDurableCheckpoint = async () => {
      try {
        const saver = opts._saveCheckpoint || realSaveCheckpoint;
        const cp = await saver(ledger.orchestrator, checkpointPayload, {
          base: context.base,
          stateDir: join(context.cwd, '.ao', 'state'),
          trustedRoot: context.trustedRoot,
          _runLockOwner: transitionLock.owner,
        });
        return !cp || cp.ok === false || cp.degraded === true;
      } catch {
        return true;
      }
    };

    let checkpointDegraded = false;
    if (desc.onResume === 'recover' && checkpointEnabled) {
      checkpointDegraded = await saveDurableCheckpoint();
      if (checkpointDegraded) {
        return {
          ok: false,
          next: phaseId,
          checkpointDegraded: true,
          degraded: true,
        };
      }
    }

    const ledgerOk = writeLedger(context, completedLedger);
    const eventOk = ledgerOk && ensurePhaseCompletedEvent(
      context, completedLedger, phaseId,
    );
    const ok = ledgerOk && eventOk;

    if (ok && desc.onResume !== 'recover' && checkpointEnabled) {
      checkpointDegraded = await saveDurableCheckpoint();
    }

    return { ok, next, checkpointDegraded, degraded: readDegraded || !ok || checkpointDegraded };
  } catch (error) {
    if (isUnsafePath(error)) {
      return { ok: false, next: null, checkpointDegraded: false, degraded: false };
    }
    return { ok: false, next: null, checkpointDegraded: false, degraded: true };
  } finally {
    releaseRunTransitionLock(transitionLock);
  }
}

/**
 * Mark a phase skipped so resume never re-evaluates it.
 *
 * @param {string} runId
 * @param {string} phaseId
 * @param {string} reason
 * @param {{ cwd?: string, _validateSkip?: Function }} [opts]
 * @param {Function} [opts._validateSkip] Trusted synchronous callback invoked
 * after traversal and reason validation while the transition lock is held and
 * before the skip is persisted.
 * @returns {{ ok: boolean, next: string|null, degraded: boolean }}
 */
export function skipPhase(runId, phaseId, reason, opts = {}) {
  let transitionLock = null;
  try {
    const cwd = opts.cwd || process.cwd();
    if (!runId || !phaseId) return { ok: true, next: null, degraded: true };
    const context = phaseRunContext(runId, cwd, opts);
    transitionLock = takeRunTransitionLock(context);
    if (runHasTerminalArtifact(context)) return { ok: false, next: null, degraded: false };
    const { ledger, degraded: readDegraded } = readLedgerWithStatus(context, runId);
    if (readDegraded || !isKnownLedger(ledger)) return { ok: true, next: null, degraded: true };
    const desc = descriptorById(ledger.orchestrator, phaseId);
    if (!desc) {
      return { ok: false, next: currentPhaseId(ledger), degraded: false };
    }
    if (currentPhaseId(ledger) !== phaseId) {
      return { ok: false, next: currentPhaseId(ledger), degraded: false };
    }
    const skipReason = typeof reason === 'string' ? reason.trim() : '';
    if (!skipReason || !desc.skippableWhen.includes(skipReason)) {
      return { ok: false, next: phaseId, degraded: false };
    }
    if (opts._validateSkip !== undefined) {
      if (typeof opts._validateSkip !== 'function') {
        return { ok: false, next: phaseId, degraded: false };
      }
      const validation = opts._validateSkip(Object.freeze({
        runId,
        orchestrator: ledger.orchestrator,
        phaseId,
        reason: skipReason,
        pipeline: Object.freeze(structuredClone(ledger)),
        _runLockOwner: transitionLock.owner,
      }));
      if (validation && typeof validation.then === 'function') {
        return { ok: false, next: phaseId, degraded: false };
      }
    }
    ledger.phases[phaseId] = {
      ...(ledger.phases[phaseId] || {}),
      status: 'skipped',
      reason: skipReason,
      completedAt: nowIso(),
    };
    const next = safeNextAfter(ledger, phaseId);
    const ok = writeLedger(context, ledger);
    return { ok, next, degraded: readDegraded || !ok };
  } catch (error) {
    if (isUnsafePath(error)) return { ok: false, next: null, degraded: false };
    return { ok: false, next: null, degraded: true };
  } finally {
    releaseRunTransitionLock(transitionLock);
  }
}

/**
 * Reopen a phase for a descriptor-declared policy reason. This does not tick
 * loop-guard; policy rewinds carry their own budgets outside the 15-cap.
 *
 * @param {string} runId
 * @param {string} phaseId
 * @param {{ reason?: string }} request
 * @param {{ cwd?: string }} [opts]
 * @returns {{ ok: boolean, rejected: boolean, degraded: boolean }}
 */
export function reopenPhase(runId, phaseId, request = {}, opts = {}) {
  let transitionLock = null;
  try {
    const cwd = opts.cwd || process.cwd();
    if (!runId || !phaseId) return { ok: true, rejected: false, degraded: true };
    const context = phaseRunContext(runId, cwd, opts);
    transitionLock = takeRunTransitionLock(context);
    if (runHasTerminalArtifact(context)) return { ok: false, rejected: true, degraded: false };
    const { ledger, degraded: readDegraded } = readLedgerWithStatus(context, runId);
    if (readDegraded || !isKnownLedger(ledger)) return { ok: true, rejected: false, degraded: true };
    const desc = descriptorById(ledger.orchestrator, phaseId);
    const reason = request.reason || '';
    if (!desc) return { ok: false, rejected: true, degraded: false };
    if (!desc.reopenableFor.includes(reason)) return { ok: true, rejected: true, degraded: readDegraded };
    const prior = ledger.phases[phaseId] || { status: 'pending' };
    if (!TERMINAL_STATUSES.has(prior.status) && currentPhaseId(ledger) !== phaseId) {
      return { ok: true, rejected: true, degraded: false };
    }
    const sequence = getPhaseSequence(ledger.orchestrator);
    const reopenIndex = sequence.findIndex(desc => desc.id === phaseId);
    for (let index = reopenIndex; index < sequence.length; index += 1) {
      const id = sequence[index].id;
      const old = ledger.phases[id] || { status: 'pending' };
      ledger.phases[id] = {
        status: 'pending',
        ...(typeof old.attempts === 'number' ? { attempts: old.attempts } : {}),
        reason,
      };
    }
    const ok = writeLedger(context, ledger);
    return { ok, rejected: false, degraded: readDegraded || !ok };
  } catch (error) {
    if (isUnsafePath(error)) return { ok: false, rejected: true, degraded: false };
    return { ok: false, rejected: false, degraded: true };
  } finally {
    releaseRunTransitionLock(transitionLock);
  }
}

/**
 * Return the current first non-terminal phase id. Unsafe, missing, or linked
 * paths deliberately return null rather than following an external artifact.
 *
 * @param {string} runId
 * @param {{ cwd?: string, base?: string, trustedRoot?: string }} [opts]
 * @returns {string|null}
 */
export function nextPhase(runId, opts = {}) {
  try {
    const context = phaseRunContext(runId, opts.cwd || process.cwd(), opts, { allowMissing: true });
    if (!context) return null;
    const { ledger } = readLedgerWithStatus(context, runId);
    return firstNonTerminal(ledger)?.id || null;
  } catch {
    return null;
  }
}

/**
 * Read the pipeline ledger. Unsafe, missing, or linked paths return a fresh
 * default rather than exposing or trusting an external artifact.
 *
 * @param {string} runId
 * @param {{ cwd?: string, base?: string, trustedRoot?: string }} [opts]
 * @returns {object}
 */
export function getPipelineState(runId, opts = {}) {
  try {
    const context = phaseRunContext(runId, opts.cwd || process.cwd(), opts, { allowMissing: true });
    return context ? readLedgerWithStatus(context, runId).ledger : freshLedger();
  } catch {
    return freshLedger();
  }
}

/**
 * Report whether every required phase is terminal. Optional skippable phases
 * left pending do not block completion.
 *
 * @param {string} runId
 * @param {{ cwd?: string, base?: string, trustedRoot?: string }} [opts]
 * @returns {boolean}
 */
export function isComplete(runId, opts = {}) {
  try {
    const cwd = opts.cwd || process.cwd();
    const context = phaseRunContext(runId, cwd, opts, { allowMissing: true });
    if (!context) return false;
    const { ledger, degraded } = readLedgerWithStatus(context, runId);
    if (degraded || !isKnownLedger(ledger) || ledger.attempt < 1
      || Object.hasOwn(ledger, 'pendingReattempt')) return false;
    assertSafeLoopGuard(context);
    const iterations = getCounter(runId, 'iterations', { cwd: context.cwd, cap: DEFAULT_ITERATION_CAP });
    assertSafeLoopGuard(context);
    if (iterations.count !== ledger.attempt) return false;
    for (const desc of getPhaseSequence(ledger.orchestrator)) {
      const entry = ledger.phases[desc.id] || { status: 'pending' };
      if (entry.status === 'completed') {
        if (!Number.isInteger(entry.attempts) || entry.attempts < 1) return false;
        const requiredLoopKey = completionLoopKey(ledger.orchestrator, desc);
        if (requiredLoopKey) {
          const normalizedLoopKey = normalizeLoopKey(requiredLoopKey);
          const spec = loopCounterSpec(ledger.orchestrator, normalizedLoopKey);
          if (spec) assertSafeLoopGuard(context);
          const counter = spec
            ? getCounter(runId, spec.name, { cwd: context.cwd, cap: spec.cap })
            : { count: 0, cap: 0 };
          if (spec) assertSafeLoopGuard(context);
          if (!spec || !currentAttemptHasLoopTick(entry, normalizedLoopKey, counter)) return false;
        }
        continue;
      }
      if (entry.status === 'skipped'
        && typeof entry.reason === 'string'
        && desc.skippableWhen.includes(entry.reason)) continue;
      return false;
    }
    return getPhaseSequence(ledger.orchestrator).length > 0;
  } catch {
    return false;
  }
}

/**
 * Finalize a successful run while holding the same run lock used to prove the
 * pipeline is complete. This closes the check/finalize race and also replays
 * finalizeRun's idempotent event/pointer repair for an already-completed
 * success summary.
 *
 * @param {string} runId
 * @param {{ cwd?: string, base?: string, stateDir?: string, trustedRoot?: string, _validateCompletion?: Function }} [opts]
 * @param {Function} [opts._validateCompletion] Trusted synchronous final-tree
 * validator invoked after pipeline completeness is proven and while the same
 * run transition lock is held. Returning false or throwing denies finalization.
 * @returns {{ok:boolean,idempotent?:boolean,reason?:string,degraded:boolean}}
 */
export function finalizeCompletedPipeline(runId, opts = {}) {
  let transitionLock = null;
  try {
    const cwd = opts.cwd || process.cwd();
    const context = phaseRunContext(runId, cwd, opts);
    transitionLock = takeRunTransitionLock(context);
    if (assertArtifactSafe(
      context,
      'terminal-failure.json',
      'terminal failure marker',
      PIPELINE_MAX_BYTES,
    )) {
      return { ok: false, reason: 'terminal-failure-published', degraded: false };
    }

    const summaryArtifact = readArtifactText(
      context,
      'summary.json',
      'run summary',
      PIPELINE_MAX_BYTES,
    );
    let summary;
    try { summary = JSON.parse(summaryArtifact.text); }
    catch { return { ok: false, reason: 'run-summary-invalid', degraded: true }; }
    if (summary?.runId !== runId
      || !['atlas', 'athena'].includes(summary?.orchestrator)
      || !['running', 'completed'].includes(summary?.status)) {
      return { ok: false, reason: 'run-summary-invalid', degraded: false };
    }
    if (summary.status === 'completed' && summary.result !== 'success') {
      return { ok: false, reason: 'completed-run-is-not-success', degraded: false };
    }
    if (!isComplete(runId, {
      cwd: context.cwd,
      base: context.base,
      trustedRoot: context.trustedRoot,
    })) {
      return { ok: false, reason: 'pipeline-incomplete', degraded: false };
    }

    // A completed-success summary is the durable commit point. Replays exist
    // only to repair a missing run_finalized event or stale active pointer;
    // consulting today's mutable checkout here could permanently strand that
    // documented crash window after unrelated later work begins.
    let atlasPrdRecord = null;
    if (summary.status === 'running' && summary.orchestrator === 'atlas') {
      try {
        atlasPrdRecord = readExecutionPrd({
          cwd: context.cwd,
          trustedRoot: context.trustedRoot,
          orchestrator: 'atlas',
        });
      } catch {
        return { ok: false, reason: 'execution-prd-snapshot-unavailable', degraded: false };
      }
    }
    if (summary.status === 'running' && opts._validateCompletion !== undefined) {
      if (typeof opts._validateCompletion !== 'function') {
        return { ok: false, reason: 'completion-validator-invalid', degraded: false };
      }
      const { ledger, degraded } = readLedgerWithStatus(context, runId);
      const finalizeOutputs = ledger.phases?.finalize?.outputs;
      if (degraded || !isKnownLedger(ledger) || !isPlainObject(finalizeOutputs)) {
        return { ok: false, reason: 'completion-evidence-unavailable', degraded: false };
      }
      let validation;
      try {
        validation = opts._validateCompletion(Object.freeze({
          runId,
          orchestrator: ledger.orchestrator,
          finalizeOutputs: Object.freeze({ ...finalizeOutputs }),
          _runLockOwner: transitionLock.owner,
        }));
      } catch {
        return { ok: false, reason: 'completion-evidence-invalid', degraded: false };
      }
      if (validation && typeof validation.then === 'function') {
        return { ok: false, reason: 'async-completion-validator-denied', degraded: false };
      }
      if (validation === false) {
        return { ok: false, reason: 'completion-evidence-invalid', degraded: false };
      }
    }
    if (atlasPrdRecord !== null) {
      let currentPrd;
      try {
        currentPrd = readExecutionPrd({
          cwd: context.cwd,
          trustedRoot: context.trustedRoot,
          orchestrator: 'atlas',
        });
      } catch {
        return { ok: false, reason: 'execution-prd-changed-during-finalization', degraded: false };
      }
      if (currentPrd.generation !== atlasPrdRecord.generation) {
        return { ok: false, reason: 'execution-prd-changed-during-finalization', degraded: false };
      }
      const snapshotted = persistRunExecutionPrdSnapshot(runId, {
        prd: currentPrd.prd,
        generation: currentPrd.generation,
      }, {
        base: context.base,
        trustedRoot: context.trustedRoot,
        _runLockOwner: transitionLock.owner,
      });
      if (!snapshotted.ok) {
        return { ok: false, reason: 'execution-prd-snapshot-unavailable', degraded: false };
      }
      try {
        const afterSnapshot = readExecutionPrd({
          cwd: context.cwd,
          trustedRoot: context.trustedRoot,
          orchestrator: 'atlas',
        });
        if (afterSnapshot.generation !== currentPrd.generation) {
          return { ok: false, reason: 'execution-prd-changed-during-finalization', degraded: false };
        }
      } catch {
        return { ok: false, reason: 'execution-prd-changed-during-finalization', degraded: false };
      }
    }

    const finalized = finalizeRun(runId, { result: 'success' }, {
      base: context.base,
      stateDir: opts.stateDir || join(context.cwd, '.ao', 'state'),
      trustedRoot: context.trustedRoot,
      _finalizationLockOwner: transitionLock.owner,
    });
    return finalized?.ok === true
      ? { ...finalized, degraded: false }
      : {
          ok: false,
          reason: finalized?.reason || 'run-finalization-failed',
          degraded: false,
        };
  } catch (error) {
    return {
      ok: false,
      reason: isUnsafePath(error) ? 'unsafe-run-path' : 'run-finalization-failed',
      degraded: !isUnsafePath(error),
    };
  } finally {
    releaseRunTransitionLock(transitionLock);
  }
}
