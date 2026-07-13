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

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { bindRunFinalizationPaths } from './run-artifacts.mjs';
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
export const SCHEMA_VERSION = 1;

const LOG_FILE_NAME = 'pipeline.json';
const OUTPUTS_CAP_BYTES = 4096;
const PIPELINE_MAX_BYTES = 1024 * 1024;
const EVENTS_MAX_BYTES = 16 * 1024 * 1024;
const NO_FOLLOW = fsConstants.O_NOFOLLOW || 0;
const UNSAFE_PATH_CODE = 'AO_UNSAFE_PHASE_RUN_PATH';
const FAILURE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const TERMINAL_STATUSES = new Set(['completed', 'skipped']);
const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed', 'skipped', 'failed']);
const REWIND_REASONS = Object.freeze({
  atlas: Object.freeze({
    plan: new Set(['light_mode_rewind']),
    execute: new Set(['quality_fail']),
    verify: new Set(['quality_fail', 'review_reject']),
  }),
  athena: Object.freeze({
    plan: new Set(['light_mode_rewind']),
    integrate: new Set(['review_reject']),
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

function revalidatePhaseRunContext(context) {
  try {
    return context.revalidate();
  } catch (error) {
    throw unsafePath(error);
  }
}

function isWithinPath(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sameFsObject(left, right) {
  return Boolean(left && right) && left.dev === right.dev && left.ino === right.ino;
}

function lstatOrMissing(path) {
  try { return lstatSync(path); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function requireSafeDirectory(path, label, requirePrivateMode = false) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (requirePrivateMode && process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700)) {
    throw unsafePath(new Error(`${label} is unsafe`));
  }
  return stat;
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
  requireSafeDirectory(trustedRoot, 'phase run trusted root');
  return trustedRoot;
}

function ensureSafeDirectoryPath(target, trustedRoot, label, requirePrivateMode = true) {
  const absoluteTarget = resolve(target);
  if (!isWithinPath(trustedRoot, absoluteTarget)) throw unsafePath();
  const rel = relative(trustedRoot, absoluteTarget);
  const components = rel === '' ? [] : rel.split(sep);
  let current = trustedRoot;
  requireSafeDirectory(current, `${label} trusted root`);
  for (let index = 0; index < components.length; index += 1) {
    current = join(current, components[index]);
    try { mkdirSync(current, { mode: 0o700 }); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw unsafePath(error);
    }
    requireSafeDirectory(
      current,
      label,
      requirePrivateMode && index === components.length - 1,
    );
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

function validateRegularArtifact(stat, label, maxBytes, allowEmpty = true) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.size > maxBytes || (!allowEmpty && stat.size <= 0)
    || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)) {
    throw unsafePath(new Error(`${label} is unsafe`));
  }
}

function readArtifactText(context, name, label, maxBytes, { allowMissing = false } = {}) {
  const path = artifactPath(context, name);
  const before = lstatOrMissing(path);
  if (!before) {
    if (allowMissing) return { present: false, text: '' };
    throw unsafePath(new Error(`${label} is missing`));
  }
  validateRegularArtifact(before, label, maxBytes);
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | NO_FOLLOW);
    const opened = fstatSync(fd);
    validateRegularArtifact(opened, label, maxBytes);
    if (!sameFsObject(before, opened) || before.size !== opened.size) {
      throw unsafePath(new Error(`${label} changed before read`));
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw unsafePath(new Error(`${label} was truncated during read`));
      offset += count;
    }
    const after = fstatSync(fd);
    if (!sameFsObject(opened, after) || after.size !== opened.size) {
      throw unsafePath(new Error(`${label} changed during read`));
    }
    revalidatePhaseRunContext(context);
    return { present: true, text: bytes.toString('utf8') };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertArtifactSafe(context, name, label, maxBytes, { allowMissing = true } = {}) {
  const path = artifactPath(context, name);
  const stat = lstatOrMissing(path);
  if (!stat) {
    if (allowMissing) return null;
    throw unsafePath(new Error(`${label} is missing`));
  }
  validateRegularArtifact(stat, label, maxBytes);
  return stat;
}

function appendArtifactText(context, name, label, text, maxBytes) {
  const path = artifactPath(context, name);
  const before = assertArtifactSafe(context, name, label, maxBytes);
  const bytes = Buffer.from(text, 'utf8');
  let fd;
  try {
    fd = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | NO_FOLLOW,
      0o600,
    );
    const opened = fstatSync(fd);
    validateRegularArtifact(opened, label, maxBytes);
    if (before && (!sameFsObject(before, opened) || before.size !== opened.size)) {
      throw unsafePath(new Error(`${label} changed before append`));
    }
    if (opened.size + bytes.length > maxBytes) {
      throw unsafePath(new Error(`${label} exceeds size bound`));
    }
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset);
      if (count <= 0) throw unsafePath(new Error(`${label} could not be appended`));
      offset += count;
    }
    revalidatePhaseRunContext(context);
  } finally {
    if (fd !== undefined) closeSync(fd);
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

function readPipelineEvents(context) {
  try {
    const events = readArtifactText(
      context, 'events.jsonl', 'pipeline events', EVENTS_MAX_BYTES, { allowMissing: true },
    );
    return events.present ? events.text.split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  } catch (error) {
    if (isUnsafePath(error)) throw error;
    return null;
  }
}

function appendPipelineEvent(context, event) {
  try {
    appendArtifactText(
      context,
      'events.jsonl',
      'pipeline events',
      `${JSON.stringify({ ...event, timestamp: nowIso() })}\n`,
      EVENTS_MAX_BYTES,
    );
    return true;
  } catch (error) {
    if (isUnsafePath(error)) throw error;
    return false;
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
  let events = readPipelineEvents(context);
  if (!events) return false;
  const exact = event => event?.type === 'pipeline_phase_failed'
    && event.phase === phaseId
    && event.detail?.orchestrator === ledger.orchestrator
    && event.detail?.code === failureCode;
  const matches = events.filter(exact);
  if (matches.length > 1) return false;
  if (matches.length === 0) {
    if (!appendPipelineEvent(context, {
      type: 'pipeline_phase_failed',
      phase: phaseId,
      detail: { orchestrator: ledger.orchestrator, code: failureCode },
    })) return false;
    events = readPipelineEvents(context);
    if (!events || events.filter(exact).length !== 1) return false;
  }
  return true;
}

function ensurePhaseCompletedEvent(context, ledger, phaseId) {
  const entry = ledger.phases?.[phaseId];
  if (!entry || entry.status !== 'completed' || !Number.isInteger(entry.attempts)) return false;
  let events = readPipelineEvents(context);
  if (!events) return false;
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
    if (!appendPipelineEvent(context, {
      type: 'pipeline_phase_completed',
      phase: phaseId,
      detail: {
        orchestrator: ledger.orchestrator,
        next,
        attempt: entry.attempts,
        ...(isPlainObject(entry.outputs) ? { outputs: entry.outputs } : {}),
      },
    })) return false;
    events = readPipelineEvents(context);
    if (!events || events.filter(exact).length !== 1) return false;
  }
  return true;
}

function ensurePhaseOutputsEvent(context, ledger, phaseId, outputs) {
  let events = readPipelineEvents(context);
  if (!events) return false;
  const encoded = JSON.stringify(outputs);
  const exact = event => event?.type === 'pipeline_phase_outputs_recorded'
    && event.phase === phaseId
    && event.detail?.orchestrator === ledger.orchestrator
    && JSON.stringify(event.detail?.outputs) === encoded;
  const matches = events.filter(exact);
  if (matches.length > 1) return false;
  if (matches.length === 0) {
    if (!appendPipelineEvent(context, {
      type: 'pipeline_phase_outputs_recorded',
      phase: phaseId,
      detail: { orchestrator: ledger.orchestrator, outputs },
    })) return false;
    events = readPipelineEvents(context);
    if (!events || events.filter(exact).length !== 1) return false;
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
  if (key === 'monitor') return 'monitor';
  if (key === 'ci') return 'ci';
  if (key === 'quality') return 'quality';
  return null;
}

function loopCounterSpec(orchestrator, key) {
  if (key === 'review') return { phaseId: 'review', name: 'reviewRounds', cap: 3 };
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
 * @param {{ cwd?: string }} [opts]
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

/**
 * Atomically tick the outer attempt cap and reopen the requested phases.
 *
 * @param {string} runId
 * @param {{ reopen?: string[], reason?: string }} request
 * @param {{ cwd?: string }} [opts]
 * @returns {{ allowed: boolean, count: number, cap: number, reopened: string[], degraded: boolean }}
 */
export function reattempt(runId, request = {}, opts = {}) {
  let transitionLock = null;
  try {
    const cwd = opts.cwd || process.cwd();
    if (!runId) return { ...failOpenAttempt(), reopened: [] };
    const context = phaseRunContext(runId, cwd, opts);
    transitionLock = takeRunTransitionLock(context);
    if (runHasTerminalArtifact(context)) return { ...blockedAttempt(null, false), reopened: [] };
    const { ledger, degraded: readDegraded } = readLedgerWithStatus(context, runId);
    if (readDegraded || !isKnownLedger(ledger)) {
      return { ...failOpenAttempt(), reopened: [] };
    }
    const sequence = getPhaseSequence(ledger.orchestrator);
    const current = firstNonTerminal(ledger);
    const requested = Array.isArray(request.reopen)
      ? [...new Set(request.reopen)]
      : [];
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

    assertSafeLoopGuard(context);
    const r = registerIteration(runId, { cwd: context.cwd });
    assertSafeLoopGuard(context);
    if (!r.allowed) return { ...r, reopened: [] };
    const reopened = [];
    const rewindIndex = Math.min(...requested.map(phaseId => (
      sequence.findIndex(desc => desc.id === phaseId)
    )));
    // Rewinding invalidates the whole tail, including the currently in-progress
    // review. Keeping it in_progress would leave touched work after the new
    // current phase and let a later failure cut become ambiguous.
    for (let index = rewindIndex; index < sequence.length; index += 1) {
      const phaseId = sequence[index].id;
      const prior = ledger.phases[phaseId] || { status: 'pending' };
      ledger.phases[phaseId] = {
        status: 'pending',
        ...(typeof prior.attempts === 'number' ? { attempts: prior.attempts } : {}),
        ...(request.reason ? { reason: request.reason } : {}),
      };
      if (requested.includes(phaseId)) reopened.push(phaseId);
    }
    ledger.attempt = r.count;
    const ok = writeLedger(context, ledger);
    return { ...r, reopened, degraded: r.degraded || readDegraded || !ok };
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
    let result;
    if (key === 'review') result = registerReviewRound(runId, { cwd: context.cwd });
    else if (key === 'monitor') result = registerCounter(runId, 'monitor-iterations', { cwd: context.cwd, cap: MONITOR_CAP });
    else if (key === 'ci') result = registerCounter(runId, 'ci-cycles', { cwd: context.cwd, cap: CI_CAP });
    else if (key === 'quality') result = registerCounter(runId, 'quality-cycles', { cwd: context.cwd, cap: QUALITY_CAP });
    if (result) {
      assertSafeLoopGuard(context);
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
 * @param {{ cwd?: string, sessionId?: string, saveCheckpoint?: boolean, _saveCheckpoint?: Function, checkpointData?: object }} [opts]
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
    if (desc.loopGuard) {
      const spec = loopCounterSpec(ledger.orchestrator, normalizeLoopKey(desc.loopGuard));
      if (spec) assertSafeLoopGuard(context);
      const counter = spec ? getCounter(runId, spec.name, { cwd: context.cwd, cap: spec.cap }) : { count: 0 };
      if (spec) assertSafeLoopGuard(context);
      const everyReviewAttemptWasTicked = desc.id !== 'review'
        || (Number.isInteger(prior.attempts) && counter.count === prior.attempts);
      if (!spec || counter.count < 1 || !everyReviewAttemptWasTicked) {
        return { ok: false, next: phaseId, checkpointDegraded: false, degraded: false };
      }
    }
    const hasRecoveryOutputs = isPlainObject(prior.outputs);
    const mergedOutputs = {
      ...(hasRecoveryOutputs ? prior.outputs : {}),
      ...(isPlainObject(outputs) ? outputs : {}),
    };
    const hasCompletionOutputs = isPlainObject(outputs);
    const requiresStrictOutputs = desc.onResume === 'recover' &&
      (hasRecoveryOutputs || hasCompletionOutputs);
    const tinyOutputs = requiresStrictOutputs
      ? sanitizeRecoveryOutputs(mergedOutputs)
      : sanitizeOutputs(outputs);
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
 * @param {{ cwd?: string }} [opts]
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
    if (degraded || !isKnownLedger(ledger) || ledger.attempt < 1) return false;
    assertSafeLoopGuard(context);
    const iterations = getCounter(runId, 'iterations', { cwd: context.cwd, cap: DEFAULT_ITERATION_CAP });
    assertSafeLoopGuard(context);
    if (iterations.count !== ledger.attempt) return false;
    for (const desc of getPhaseSequence(ledger.orchestrator)) {
      const entry = ledger.phases[desc.id] || { status: 'pending' };
      if (entry.status === 'completed') {
        if (!Number.isInteger(entry.attempts) || entry.attempts < 1) return false;
        if (desc.loopGuard) {
          const spec = loopCounterSpec(ledger.orchestrator, normalizeLoopKey(desc.loopGuard));
          if (spec) assertSafeLoopGuard(context);
          const count = spec ? getCounter(runId, spec.name, { cwd: context.cwd, cap: spec.cap }).count : 0;
          if (spec) assertSafeLoopGuard(context);
          if (!spec || count < 1 || (desc.id === 'review' && count !== entry.attempts)) return false;
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
