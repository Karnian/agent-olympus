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
 *     "orchestrator": "atlas",
 *     "createdAt": "...",
 *     "updatedAt": "...",
 *     "attempt": 1,
 *     "phases": { "triage": { "status": "pending" }, ... }
 *   }
 *
 * `pipeline.json` is the phase authority. `loop-guard.json` remains the cap
 * authority; `ledger.attempt` is only a display mirror and is never consulted
 * for enforcement. `completePhase()` writes the ledger first, emits
 * `pipeline_phase_completed`, and only then saves the richer checkpoint payload.
 *
 * Fail-safe contract
 * ------------------
 * Every exported function catches all errors and returns a safe default —
 * NEVER throws. Missing runId, corrupt JSON, FS errors, and future
 * schemaVersion values fail OPEN with `degraded:true`, matching loop-guard's
 * polarity so tracking failure never halts legitimate work.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { addEvent } from './run-artifacts.mjs';
import { saveCheckpoint as realSaveCheckpoint } from './checkpoint.mjs';
import {
  registerIteration,
  registerReviewRound,
  registerCounter,
  recordError,
  DEFAULT_ITERATION_CAP,
} from './loop-guard.mjs';

export const MONITOR_CAP = 10;
export const CI_CAP = 2;
export const QUALITY_CAP = 2;
export const SCHEMA_VERSION = 1;

const LOG_FILE_NAME = 'pipeline.json';
const OUTPUTS_CAP_BYTES = 4096;
const TERMINAL_STATUSES = new Set(['completed', 'skipped']);
const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed', 'skipped', 'failed']);

export const ATLAS_PHASES = Object.freeze([
  phase('triage', 'TRIAGE+ANALYZE', 'linear', 'plan', 0, null, null, 'reexecute'),
  phase('context', 'DEEP-DIVE/EXTERNAL', 'linear', 'plan', 1, null, null, 'skip-if-complete', ['trivial']),
  phase('spec', 'SPEC GATE', 'linear', 'plan', 2, null, null, 'skip-if-complete', ['trivial']),
  phase('plan', 'PLAN+VALIDATE', 'linear', 'decompose', 2, null, null, 'skip-if-complete', ['trivial'], ['light_mode_rewind']),
  phase('execute', 'EXECUTE', 'linear', 'execute', 3, null, null, 'reexecute'),
  phase('verify', 'VERIFY (+visual/quality sub-steps)', 'loop', 'verify', 4, null, null, 'reexecute'),
  phase('review', 'REVIEW', 'loop', 'review', 5, 'reviewRounds', 3, 'reexecute'),
  phase('finalize', 'SLOP+COMMIT+CHANGELOG+EXECPLAN', 'linear', 'finish', 6, null, null, 'reexecute'),
  phase('ship', 'SHIP (PR)', 'linear', 'finish', 7, null, null, 'skip-if-complete'),
  phase('ci', 'CI WATCH', 'loop', 'finish', 7, 'ci', CI_CAP, 'reexecute'),
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
  phase('ship', 'SHIP (PR)', 'linear', 'finish', 7, null, null, 'skip-if-complete'),
  phase('ci', 'CI WATCH', 'loop', 'finish', 7, 'ci', CI_CAP, 'reexecute'),
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

function logPath(runId, cwd) {
  return join(cwd, '.ao', 'artifacts', 'runs', runId, LOG_FILE_NAME);
}

function runBase(cwd) {
  return join(cwd, '.ao', 'artifacts', 'runs');
}

function freshLedger(orchestrator = null) {
  const ts = nowIso();
  return {
    schemaVersion: SCHEMA_VERSION,
    orchestrator,
    createdAt: ts,
    updatedAt: ts,
    attempt: 0,
    phases: {},
  };
}

function freshLedgerFor(orchestrator) {
  const ledger = freshLedger(orchestrator);
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

function normalizeLedger(parsed, fallbackOrchestrator) {
  const orchestrator = (parsed.orchestrator === 'atlas' || parsed.orchestrator === 'athena')
    ? parsed.orchestrator
    : fallbackOrchestrator;
  const ledger = {
    schemaVersion: SCHEMA_VERSION,
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
      ...(isPlainObject(raw.outputs) ? { outputs: raw.outputs } : {}),
    };
  }
  return ledger;
}

function readLedgerWithStatus(runId, cwd, fallbackOrchestrator = null) {
  try {
    if (!runId) return { ledger: freshLedger(fallbackOrchestrator), degraded: true };
    const path = logPath(runId, cwd);
    if (!existsSync(path)) return { ledger: freshLedgerFor(fallbackOrchestrator), degraded: false };
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (!isPlainObject(parsed)) return { ledger: freshLedgerFor(fallbackOrchestrator), degraded: true };
    if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== SCHEMA_VERSION) {
      try {
        process.stderr.write(
          `[phase-runner] refusing pipeline.json schemaVersion ${parsed.schemaVersion} ` +
          `(supported: ${SCHEMA_VERSION}) — treating as empty\n`,
        );
      } catch { /* stderr unavailable */ }
      return { ledger: freshLedgerFor(fallbackOrchestrator), degraded: true };
    }
    return { ledger: normalizeLedger(parsed, fallbackOrchestrator), degraded: false };
  } catch {
    return { ledger: freshLedgerFor(fallbackOrchestrator), degraded: true };
  }
}

function writeLedger(runId, cwd, ledger) {
  try {
    ledger.updatedAt = nowIso();
    atomicWriteFileSync(logPath(runId, cwd), JSON.stringify(ledger, null, 2));
    return true;
  } catch {
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

function normalizeLoopKey(key) {
  if (key === 'reviewRounds' || key === 'review') return 'review';
  if (key === 'monitor') return 'monitor';
  if (key === 'ci') return 'ci';
  if (key === 'quality') return 'quality';
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
  try {
    const cwd = opts.cwd || process.cwd();
    if (!runId || getPhaseSequence(orchestrator).length === 0) {
      return { ok: false, resumePhase: null, resumePolicy: null, completed: [], degraded: true };
    }
    const path = logPath(runId, cwd);
    const exists = existsSync(path);
    const { ledger, degraded: readDegraded } = readLedgerWithStatus(runId, cwd, orchestrator);
    const normalized = ledger.orchestrator ? ledger : freshLedgerFor(orchestrator);
    const writeOk = exists ? writeLedger(runId, cwd, normalized) : writeLedger(runId, cwd, freshLedgerFor(orchestrator));
    const finalLedger = exists ? normalized : readLedgerWithStatus(runId, cwd, orchestrator).ledger;
    const resume = firstNonTerminal(finalLedger);
    return {
      ok: writeOk,
      resumePhase: resume?.id || null,
      resumePolicy: resume?.onResume || null,
      completed: completedIds(finalLedger),
      degraded: readDegraded || !writeOk,
    };
  } catch {
    return { ok: false, resumePhase: null, resumePolicy: null, completed: [], degraded: true };
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
  try {
    const cwd = opts.cwd || process.cwd();
    if (!runId || !phaseId) return { proceed: true, skip: false, reason: 'fail-open', status: 'pending', degraded: true };
    const { ledger, degraded: readDegraded } = readLedgerWithStatus(runId, cwd);
    const desc = descriptorById(ledger.orchestrator, phaseId);
    if (!desc) return { proceed: true, skip: false, reason: 'unknown-phase', status: 'pending', degraded: true };

    const entry = ledger.phases[phaseId] || { status: 'pending' };
    if (TERMINAL_STATUSES.has(entry.status)) {
      return { proceed: false, skip: true, reason: entry.reason, status: entry.status, degraded: readDegraded };
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
    const ok = writeLedger(runId, cwd, ledger);
    return { proceed: true, skip: false, status: 'in_progress', degraded: readDegraded || !ok };
  } catch {
    return { proceed: true, skip: false, reason: 'fail-open', status: 'pending', degraded: true };
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
  try {
    const cwd = opts.cwd || process.cwd();
    const r = registerIteration(runId, { cwd });
    if (runId && r.allowed) {
      const { ledger, degraded: readDegraded } = readLedgerWithStatus(runId, cwd);
      ledger.attempt = r.count;
      const ok = writeLedger(runId, cwd, ledger);
      return { ...r, degraded: r.degraded || readDegraded || !ok };
    }
    return r;
  } catch {
    return { allowed: true, count: 0, cap: DEFAULT_ITERATION_CAP, degraded: true };
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
  try {
    const cwd = opts.cwd || process.cwd();
    const r = registerIteration(runId, { cwd });
    if (!r.allowed) return { ...r, reopened: [] };
    const { ledger, degraded: readDegraded } = readLedgerWithStatus(runId, cwd);
    const reopened = [];
    for (const phaseId of Array.isArray(request.reopen) ? request.reopen : []) {
      if (!descriptorById(ledger.orchestrator, phaseId)) continue;
      const prior = ledger.phases[phaseId] || { status: 'pending' };
      ledger.phases[phaseId] = {
        status: 'pending',
        ...(typeof prior.attempts === 'number' ? { attempts: prior.attempts } : {}),
        ...(request.reason ? { reason: request.reason } : {}),
      };
      reopened.push(phaseId);
    }
    ledger.attempt = r.count;
    const ok = writeLedger(runId, cwd, ledger);
    return { ...r, reopened, degraded: r.degraded || readDegraded || !ok };
  } catch {
    return { allowed: true, count: 0, cap: DEFAULT_ITERATION_CAP, reopened: [], degraded: true };
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
  try {
    const cwd = opts.cwd || process.cwd();
    let key = normalizeLoopKey(keyOrPhaseId);
    if (!key && runId && keyOrPhaseId) {
      const { ledger } = readLedgerWithStatus(runId, cwd);
      const desc = descriptorById(ledger.orchestrator, keyOrPhaseId);
      key = normalizeLoopKey(desc?.loopGuard);
    }
    if (key === 'review') return registerReviewRound(runId, { cwd });
    if (key === 'monitor') return registerCounter(runId, 'monitor-iterations', { cwd, cap: MONITOR_CAP });
    if (key === 'ci') return registerCounter(runId, 'ci-cycles', { cwd, cap: CI_CAP });
    if (key === 'quality') return registerCounter(runId, 'quality-cycles', { cwd, cap: QUALITY_CAP });
    return { allowed: true, count: 0, cap: 0, degraded: true };
  } catch {
    return { allowed: true, count: 0, cap: 0, degraded: true };
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
  try {
    void phaseId;
    return recordError(runId, errorSig, { cwd: opts.cwd || process.cwd() });
  } catch {
    return { shouldEscalate: false, repeatCount: 0, threshold: 3, degraded: true };
  }
}

/**
 * Complete a phase. The ledger write and pipeline event happen before the
 * checkpoint call. Tests may inject `opts._saveCheckpoint`; production uses
 * checkpoint.mjs by default. Set `opts.saveCheckpoint=false` to skip the
 * checkpoint write entirely.
 *
 * @param {string} runId
 * @param {string} phaseId
 * @param {object} [outputs]
 * @param {{ cwd?: string, sessionId?: string, saveCheckpoint?: boolean, _saveCheckpoint?: Function, checkpointData?: object }} [opts]
 * @returns {Promise<{ ok: boolean, next: string|null, checkpointDegraded: boolean, degraded: boolean }>}
 */
export async function completePhase(runId, phaseId, outputs = undefined, opts = {}) {
  try {
    const cwd = opts.cwd || process.cwd();
    if (!runId || !phaseId) return { ok: false, next: null, checkpointDegraded: false, degraded: true };
    const { ledger, degraded: readDegraded } = readLedgerWithStatus(runId, cwd);
    const desc = descriptorById(ledger.orchestrator, phaseId);
    if (!desc) return { ok: false, next: null, checkpointDegraded: false, degraded: true };

    const prior = ledger.phases[phaseId] || { status: 'pending' };
    const tinyOutputs = sanitizeOutputs(outputs);
    ledger.phases[phaseId] = {
      ...prior,
      status: 'completed',
      completedAt: nowIso(),
      ...(tinyOutputs ? { outputs: tinyOutputs } : {}),
    };
    const next = safeNextAfter(ledger, phaseId);
    const ok = writeLedger(runId, cwd, ledger);
    addEvent(runId, {
      type: 'pipeline_phase_completed',
      phase: phaseId,
      detail: {
        orchestrator: ledger.orchestrator,
        next,
        ...(tinyOutputs ? { outputs: tinyOutputs } : {}),
      },
    }, { base: runBase(cwd) });

    let checkpointDegraded = false;
    if (ok && opts.saveCheckpoint !== false && typeof desc.checkpointIndex === 'number') {
      try {
        const saver = opts._saveCheckpoint || realSaveCheckpoint;
        const payload = {
          ...(isPlainObject(opts.checkpointData) ? opts.checkpointData : {}),
          phase: desc.checkpointIndex,
          phaseId,
          runId,
          ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        };
        const cp = await saver(ledger.orchestrator, payload);
        checkpointDegraded = !cp || cp.ok === false || cp.degraded === true;
      } catch {
        checkpointDegraded = true;
      }
    }

    return { ok, next, checkpointDegraded, degraded: readDegraded || !ok || checkpointDegraded };
  } catch {
    return { ok: false, next: null, checkpointDegraded: false, degraded: true };
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
  try {
    const cwd = opts.cwd || process.cwd();
    const { ledger, degraded: readDegraded } = readLedgerWithStatus(runId, cwd);
    if (!runId || !descriptorById(ledger.orchestrator, phaseId)) return { ok: false, next: null, degraded: true };
    ledger.phases[phaseId] = {
      ...(ledger.phases[phaseId] || {}),
      status: 'skipped',
      reason: typeof reason === 'string' ? reason : 'skipped',
      completedAt: nowIso(),
    };
    const next = safeNextAfter(ledger, phaseId);
    const ok = writeLedger(runId, cwd, ledger);
    return { ok, next, degraded: readDegraded || !ok };
  } catch {
    return { ok: false, next: null, degraded: true };
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
  try {
    const cwd = opts.cwd || process.cwd();
    const { ledger, degraded: readDegraded } = readLedgerWithStatus(runId, cwd);
    const desc = descriptorById(ledger.orchestrator, phaseId);
    const reason = request.reason || '';
    if (!runId || !desc) return { ok: false, rejected: true, degraded: true };
    if (!desc.reopenableFor.includes(reason)) return { ok: true, rejected: true, degraded: readDegraded };
    const prior = ledger.phases[phaseId] || { status: 'pending' };
    ledger.phases[phaseId] = {
      status: 'pending',
      ...(typeof prior.attempts === 'number' ? { attempts: prior.attempts } : {}),
      reason,
    };
    const ok = writeLedger(runId, cwd, ledger);
    return { ok, rejected: false, degraded: readDegraded || !ok };
  } catch {
    return { ok: false, rejected: false, degraded: true };
  }
}

/**
 * Return the current first non-terminal phase id.
 *
 * @param {string} runId
 * @param {{ cwd?: string }} [opts]
 * @returns {string|null}
 */
export function nextPhase(runId, opts = {}) {
  try {
    const { ledger } = readLedgerWithStatus(runId, opts.cwd || process.cwd());
    return firstNonTerminal(ledger)?.id || null;
  } catch {
    return null;
  }
}

/**
 * Read the pipeline ledger. Returns a fresh default on any error.
 *
 * @param {string} runId
 * @param {{ cwd?: string }} [opts]
 * @returns {object}
 */
export function getPipelineState(runId, opts = {}) {
  try {
    return readLedgerWithStatus(runId, opts.cwd || process.cwd()).ledger;
  } catch {
    return freshLedger();
  }
}

/**
 * Report whether every required phase is terminal. Optional skippable phases
 * left pending do not block completion.
 *
 * @param {string} runId
 * @param {{ cwd?: string }} [opts]
 * @returns {boolean}
 */
export function isComplete(runId, opts = {}) {
  try {
    const { ledger } = readLedgerWithStatus(runId, opts.cwd || process.cwd());
    for (const desc of getPhaseSequence(ledger.orchestrator)) {
      const status = ledger.phases[desc.id]?.status || 'pending';
      if (TERMINAL_STATUSES.has(status)) continue;
      if (status === 'pending' && desc.skippableWhen.length > 0) continue;
      return false;
    }
    return getPhaseSequence(ledger.orchestrator).length > 0;
  } catch {
    return false;
  }
}
