import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import {
  createRun,
} from '../../scripts/lib/run-artifacts.mjs';
import { getPhaseSequence } from '../../scripts/lib/phase-runner.mjs';

export const PIPELINE_EVIDENCE_POLICY_VERSION = 1;

const TRUST = 'candidate-asserted';
const CLOCK_TOLERANCE_MS = 2_000;
const MAX_PIPELINE_BYTES = 256 * 1024;
const MAX_SUMMARY_BYTES = 256 * 1024;
const MAX_GUARD_BYTES = 256 * 1024;
const MAX_EVENTS_BYTES = 16 * 1024 * 1024;
const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const ROOT_KEYS = ['schemaVersion', 'runId', 'orchestrator', 'createdAt', 'updatedAt', 'attempt', 'phases'];
const PHASE_KEYS = new Set(['status', 'startedAt', 'completedAt', 'attempts', 'reason', 'outputs']);
const CORE_PHASES = {
  atlas: new Set(['triage', 'execute', 'verify', 'review', 'finalize', 'complete']),
  athena: new Set([
    'triage', 'context', 'spec', 'plan', 'spawn', 'monitor', 'wisdom',
    'integrate', 'review', 'finalize', 'complete',
  ]),
};
const TRIVIAL_PHASES = new Set(['context', 'spec', 'plan']);
const DYNAMIC_SKIP_PHASES = new Set(['ship', 'ci']);
const WORKER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const TEAM_SLUG = /^athena-[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const SHA = /^[a-f0-9]{40,64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ATHENA_SPAWN_OUTPUT_KEYS = [
  'runId', 'teamSlug', 'intendedWorkers', 'spawnPath', 'launchState',
  'baseCommit', 'worktreeDigest', 'adapterRunId',
];
const ATHENA_MONITOR_OUTPUT_KEYS = [
  'teamSlug', 'intendedWorkers', 'terminalWorkers', 'worktreeDigest', 'adapterRunId',
];
const ATHENA_INTEGRATE_OUTPUT_KEYS = [
  'teamSlug', 'intendedWorkers', 'isolatedWorkers', 'mergedWorkers',
  'worktreeDigest', 'verificationPassed', 'integrationCommit',
];
const ATHENA_COMPLETE_OUTPUT_KEYS = ['teamSlug', 'worktreeDigest', 'cleanupState'];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isoMs(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString() === value ? parsed : null;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function existsNoFollow(filePath) {
  try { lstatSync(filePath); return true; }
  catch { return false; }
}

function hasExactKeys(value, expected) {
  return isPlainObject(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function canonicalWorkerList(value, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') return null;
  if (value === '') return allowEmpty ? '' : null;
  if (value.length > 4096) return null;
  const names = value.split(',');
  if (names.some((name) => !WORKER_NAME.test(name))) return null;
  const canonical = [...new Set(names)].sort();
  return canonical.length === names.length && canonical.join(',') === value ? value : null;
}

function validateAthenaPhaseOutputs(handle, ledger) {
  const spawn = ledger.phases.spawn?.outputs;
  const monitor = ledger.phases.monitor?.outputs;
  const integrate = ledger.phases.integrate?.outputs;
  const complete = ledger.phases.complete?.outputs;
  if (!hasExactKeys(spawn, ATHENA_SPAWN_OUTPUT_KEYS)
    || spawn.runId !== handle.pipelineRunId
    || !TEAM_SLUG.test(spawn.teamSlug || '')
    || canonicalWorkerList(spawn.intendedWorkers) === null
    || !['adapter-only', 'native-or-mixed', 'fallback-or-mixed'].includes(spawn.spawnPath)
    || spawn.launchState !== 'durable'
    || (spawn.spawnPath === 'adapter-only'
      ? !/^[a-f0-9]{16}$/.test(spawn.adapterRunId || '')
      : spawn.adapterRunId !== 'none' && !/^[a-f0-9]{16}$/.test(spawn.adapterRunId || ''))
    || !SHA.test(spawn.baseCommit || '')
    || !SHA256.test(spawn.worktreeDigest || '')) {
    return { ok: false, reason: 'athena-spawn-evidence', detail: 'Athena spawn outputs lack exact durable team/worktree identity.' };
  }
  if (!hasExactKeys(monitor, ATHENA_MONITOR_OUTPUT_KEYS)
    || monitor.teamSlug !== spawn.teamSlug
    || monitor.intendedWorkers !== spawn.intendedWorkers
    || monitor.terminalWorkers !== spawn.intendedWorkers
    || monitor.worktreeDigest !== spawn.worktreeDigest
    || monitor.adapterRunId !== spawn.adapterRunId) {
    return { ok: false, reason: 'athena-monitor-evidence', detail: 'Athena monitor outputs do not prove every intended worker reached a terminal state.' };
  }
  if (!hasExactKeys(integrate, ATHENA_INTEGRATE_OUTPUT_KEYS)
    || integrate.teamSlug !== spawn.teamSlug
    || integrate.intendedWorkers !== spawn.intendedWorkers
    || integrate.worktreeDigest !== spawn.worktreeDigest
    || canonicalWorkerList(integrate.isolatedWorkers, { allowEmpty: true }) === null
    || canonicalWorkerList(integrate.mergedWorkers, { allowEmpty: true }) === null
    || integrate.mergedWorkers !== integrate.isolatedWorkers
    || integrate.verificationPassed !== true
    || !SHA.test(integrate.integrationCommit || '')) {
    return { ok: false, reason: 'athena-integrate-evidence', detail: 'Athena integrate outputs do not prove complete merges and verification.' };
  }
  const intended = new Set(spawn.intendedWorkers.split(','));
  if (integrate.isolatedWorkers !== ''
    && integrate.isolatedWorkers.split(',').some((worker) => !intended.has(worker))) {
    return { ok: false, reason: 'athena-integrate-evidence', detail: 'Athena isolated workers must be a subset of the intended roster.' };
  }
  if (intended.size > 1 && integrate.isolatedWorkers !== spawn.intendedWorkers) {
    return { ok: false, reason: 'athena-integrate-evidence', detail: 'Multi-worker Athena runs must isolate and merge the complete intended roster.' };
  }
  if (!hasExactKeys(complete, ATHENA_COMPLETE_OUTPUT_KEYS)
    || complete.teamSlug !== spawn.teamSlug
    || complete.worktreeDigest !== spawn.worktreeDigest
    || complete.cleanupState !== 'done') {
    return { ok: false, reason: 'athena-cleanup-evidence', detail: 'Athena completion must bind a successful cleanup marker to the spawn identity.' };
  }
  return { ok: true, spawn, monitor, integrate, complete };
}

function relativePipelinePath(runId) {
  return path.posix.join('.ao', 'artifacts', 'runs', runId, 'pipeline.json');
}

function fail(handle, reason, detail, extra = {}) {
  return {
    policyVersion: PIPELINE_EVIDENCE_POLICY_VERSION,
    trust: TRUST,
    required: true,
    pass: false,
    reason,
    detail,
    pipelineRunId: handle?.pipelineRunId ?? null,
    relativePath: handle?.pipelineRunId ? relativePipelinePath(handle.pipelineRunId) : null,
    ...extra,
  };
}

export function pipelineEvidenceNotApplicable(reason = 'fixture-mode') {
  return {
    policyVersion: PIPELINE_EVIDENCE_POLICY_VERSION,
    trust: 'not-applicable',
    required: false,
    pass: null,
    reason,
    detail: 'Pipeline evidence is required only for supported live Atlas/Athena orchestration.',
    pipelineRunId: null,
    relativePath: null,
  };
}

function readRegularFile(filePath, maxBytes) {
  let before;
  let fd;
  try {
    before = lstatSync(filePath);
  } catch {
    return { ok: false, reason: 'missing-file', detail: `${path.basename(filePath)} is missing` };
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    return { ok: false, reason: 'unsafe-file-type', detail: `${path.basename(filePath)} is not a regular file` };
  }
  if (before.size > maxBytes) {
    return { ok: false, reason: 'oversized-file', detail: `${path.basename(filePath)} exceeds its evidence size limit` };
  }
  try {
    fd = openSync(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd);
    if (!opened.isFile()
      || opened.size > maxBytes
      || opened.dev !== before.dev
      || opened.ino !== before.ino) {
      return { ok: false, reason: 'unsafe-file-race', detail: `${path.basename(filePath)} changed while evidence was opened` };
    }
    const chunks = [];
    let totalBytes = 0;
    while (totalBytes <= maxBytes) {
      const remaining = (maxBytes + 1) - totalBytes;
      if (remaining <= 0) break;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    if (totalBytes > maxBytes) {
      return { ok: false, reason: 'oversized-file', detail: `${path.basename(filePath)} exceeds its evidence size limit` };
    }
    const buffer = Buffer.concat(chunks, totalBytes);
    const after = fstatSync(fd);
    if (!after.isFile() || buffer.length > maxBytes || after.size > maxBytes) {
      return { ok: false, reason: 'oversized-file', detail: `${path.basename(filePath)} exceeds its evidence size limit` };
    }
    return { ok: true, stats: after, buffer };
  } catch {
    return { ok: false, reason: 'unreadable-file', detail: `${path.basename(filePath)} could not be read` };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

function parseJson(buffer, label) {
  try {
    const value = JSON.parse(buffer.toString('utf-8'));
    return isPlainObject(value)
      ? { ok: true, value }
      : { ok: false, reason: 'invalid-json-shape', detail: `${label} must contain a JSON object` };
  } catch {
    return { ok: false, reason: 'invalid-json', detail: `${label} is not valid JSON` };
  }
}

function withinWindow(value, startMs, endMs) {
  const parsed = isoMs(value);
  return parsed !== null
    && parsed >= startMs - CLOCK_TOLERANCE_MS
    && parsed <= endMs + CLOCK_TOLERANCE_MS;
}

function mtimeWithinWindow(stats, startMs, endMs) {
  return Number.isFinite(stats?.mtimeMs)
    && stats.mtimeMs >= startMs - CLOCK_TOLERANCE_MS
    && stats.mtimeMs <= endMs + CLOCK_TOLERANCE_MS;
}

function activePointerPath(workdir, orchestrator) {
  return path.join(workdir, '.ao', 'state', `ao-active-run-${orchestrator}.json`);
}

/**
 * Pre-allocate the production Atlas/Athena run identity in the isolated trial.
 * The orchestrator must adopt this active-run pointer and finalize the same run.
 */
export function beginPipelineEvidence({
  workdir,
  orchestrator,
  evalRunId,
  taskId,
  trial,
}) {
  if (!['atlas', 'athena'].includes(orchestrator)) {
    return {
      ...pipelineEvidenceNotApplicable(`${orchestrator || 'unknown'}-orchestrator`),
      ready: true,
    };
  }

  const cwd = path.resolve(workdir);
  const aoRoot = path.join(cwd, '.ao');
  const startedAtMs = Date.now();
  if (existsNoFollow(aoRoot)) {
    return {
      policyVersion: PIPELINE_EVIDENCE_POLICY_VERSION,
      trust: TRUST,
      required: true,
      ready: false,
      reason: 'preexisting-ao-state',
      detail: 'Live eval trial must start without a pre-existing .ao directory',
      pipelineRunId: null,
      relativePath: null,
    };
  }

  const runsBase = path.join(cwd, '.ao', 'artifacts', 'runs');
  const stateDir = path.join(cwd, '.ao', 'state');
  const description = `eval=${evalRunId}; task=${taskId}; trial=${trial}`;
  const created = createRun(orchestrator, description, { base: runsBase, stateDir });
  const expectedRunDir = path.join(runsBase, created.runId || '');
  const expectedPipelinePath = path.join(expectedRunDir, 'pipeline.json');
  const expectedSummaryPath = path.join(expectedRunDir, 'summary.json');
  const pointer = readRegularFile(activePointerPath(cwd, orchestrator), MAX_SUMMARY_BYTES);
  const pointerJson = pointer.ok ? parseJson(pointer.buffer, 'active-run pointer') : pointer;
  const initialSummaryFile = readRegularFile(expectedSummaryPath, MAX_SUMMARY_BYTES);
  const initialSummary = initialSummaryFile.ok
    ? parseJson(initialSummaryFile.buffer, 'initial summary.json')
    : initialSummaryFile;
  const ready = Boolean(
    created.runId
    && RUN_ID_PATTERN.test(created.runId)
    && created.runDir
    && path.resolve(created.runDir) === path.resolve(expectedRunDir)
    && !existsNoFollow(expectedPipelinePath)
    && pointerJson.ok
    && pointerJson.value.runId === created.runId
    && pointerJson.value.orchestrator === orchestrator
    && initialSummary.ok
    && initialSummary.value.runId === created.runId
    && initialSummary.value.orchestrator === orchestrator
    && initialSummary.value.task === description
    && initialSummary.value.status === 'running'
    && withinWindow(initialSummary.value.startedAt, startedAtMs, Date.now())
  );

  return {
    policyVersion: PIPELINE_EVIDENCE_POLICY_VERSION,
    trust: TRUST,
    required: true,
    ready,
    reason: ready ? null : 'preallocation-failed',
    detail: ready
      ? 'Harness pre-allocated one clean orchestration run identity.'
      : 'Harness could not pre-allocate an unambiguous orchestration run identity.',
    pipelineRunId: created.runId || null,
    relativePath: created.runId ? relativePipelinePath(created.runId) : null,
    workdir: cwd,
    runsBase,
    stateDir,
    runDir: expectedRunDir,
    pipelinePath: expectedPipelinePath,
    taskDescription: description,
    summaryStartedAt: initialSummary.ok ? initialSummary.value.startedAt : null,
    startedAtMs,
    orchestrator,
  };
}

/** Strict, fail-closed validation of one finalized phase-runner ledger. */
export function verifyPipelineEvidence(handle, endedAtMs = Date.now()) {
  if (!handle?.required) return pipelineEvidenceNotApplicable(handle?.reason || 'not-required');
  if (!handle.ready) return fail(handle, handle.reason || 'preallocation-failed', handle.detail || 'Pipeline evidence was not initialized.');

  let runEntries;
  try {
    const rootStats = lstatSync(handle.runsBase);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      return fail(handle, 'unsafe-runs-root', 'The run-artifact root is not a regular directory.');
    }
    runEntries = readdirSync(handle.runsBase, { withFileTypes: true });
  } catch {
    return fail(handle, 'missing-runs-root', 'The run-artifact root is missing or unreadable.');
  }
  if (runEntries.length !== 1
    || runEntries[0].name !== handle.pipelineRunId
    || !runEntries[0].isDirectory()
    || runEntries[0].isSymbolicLink()) {
    return fail(handle, 'ambiguous-run-identity', 'Expected exactly one direct run directory matching the pre-allocated identity.');
  }

  if (existsNoFollow(activePointerPath(handle.workdir, handle.orchestrator))) {
    return fail(handle, 'active-run-not-finalized', 'The orchestrator left its active-run pointer behind.');
  }

  const pipelineFile = readRegularFile(handle.pipelinePath, MAX_PIPELINE_BYTES);
  if (!pipelineFile.ok) return fail(handle, pipelineFile.reason, pipelineFile.detail);
  const summaryPath = path.join(handle.runDir, 'summary.json');
  const eventsPath = path.join(handle.runDir, 'events.jsonl');
  const summaryFile = readRegularFile(summaryPath, MAX_SUMMARY_BYTES);
  if (!summaryFile.ok) return fail(handle, summaryFile.reason, summaryFile.detail);
  const eventsFile = readRegularFile(eventsPath, MAX_EVENTS_BYTES);
  if (!eventsFile.ok) return fail(handle, eventsFile.reason, eventsFile.detail);
  const guardPath = path.join(handle.runDir, 'loop-guard.json');
  const guardFile = readRegularFile(guardPath, MAX_GUARD_BYTES);
  if (!guardFile.ok) return fail(handle, guardFile.reason, guardFile.detail);
  for (const [label, file] of [
    ['pipeline.json', pipelineFile],
    ['summary.json', summaryFile],
    ['events.jsonl', eventsFile],
    ['loop-guard.json', guardFile],
  ]) {
    if (!mtimeWithinWindow(file.stats, handle.startedAtMs, endedAtMs)) {
      return fail(handle, 'stale-evidence-file', `${label} was not written during this live trial.`);
    }
  }

  const parsedPipeline = parseJson(pipelineFile.buffer, 'pipeline.json');
  if (!parsedPipeline.ok) return fail(handle, parsedPipeline.reason, parsedPipeline.detail);
  const parsedSummary = parseJson(summaryFile.buffer, 'summary.json');
  if (!parsedSummary.ok) return fail(handle, parsedSummary.reason, parsedSummary.detail);
  const parsedGuard = parseJson(guardFile.buffer, 'loop-guard.json');
  if (!parsedGuard.ok) return fail(handle, parsedGuard.reason, parsedGuard.detail);
  const ledger = parsedPipeline.value;
  const summary = parsedSummary.value;
  const guard = parsedGuard.value;

  if (!hasExactKeys(ledger, ROOT_KEYS)) {
    return fail(handle, 'pipeline-schema-mismatch', 'pipeline.json must contain the exact schemaVersion 1 root contract.');
  }
  if (ledger.schemaVersion !== 1
    || ledger.runId !== handle.pipelineRunId
    || ledger.orchestrator !== handle.orchestrator) {
    return fail(handle, 'pipeline-identity-mismatch', 'Pipeline run, schema, or orchestrator does not match the live task.');
  }
  if (!Number.isInteger(ledger.attempt) || ledger.attempt < 1 || ledger.attempt > 15) {
    return fail(handle, 'invalid-attempt', 'Pipeline attempt must be an integer from 1 through 15.');
  }
  if (!withinWindow(ledger.createdAt, handle.startedAtMs, endedAtMs)
    || !withinWindow(ledger.updatedAt, handle.startedAtMs, endedAtMs)
    || isoMs(ledger.createdAt) > isoMs(ledger.updatedAt)) {
    return fail(handle, 'pipeline-time-window', 'Pipeline timestamps are invalid, stale, or outside this live trial.');
  }
  if (summary.runId !== handle.pipelineRunId
    || summary.orchestrator !== handle.orchestrator
    || summary.task !== handle.taskDescription
    || summary.startedAt !== handle.summaryStartedAt
    || summary.status !== 'completed'
    || summary.result !== 'success') {
    return fail(handle, 'summary-identity-mismatch', 'Final summary must match the pre-allocated run and have status completed.');
  }
  if (!withinWindow(summary.startedAt, handle.startedAtMs, endedAtMs)
    || !withinWindow(summary.finishedAt, handle.startedAtMs, endedAtMs)
    || isoMs(summary.startedAt) > isoMs(summary.finishedAt)
    || isoMs(summary.startedAt) > isoMs(ledger.createdAt)
    || isoMs(summary.finishedAt) < isoMs(ledger.updatedAt)) {
    return fail(handle, 'summary-time-window', 'Final summary timestamps do not bound the completed pipeline.');
  }

  const sequence = getPhaseSequence(handle.orchestrator);
  const expectedIds = sequence.map((phase) => phase.id);
  if (!isPlainObject(ledger.phases)
    || !hasExactKeys(ledger.phases, expectedIds)) {
    return fail(handle, 'phase-key-mismatch', 'Pipeline phase keys must exactly match the code-defined sequence.');
  }

  if (!hasExactKeys(guard, ['schemaVersion', 'counters', 'errors'])
    || guard.schemaVersion !== 1
    || !isPlainObject(guard.counters)
    || !isPlainObject(guard.errors)) {
    return fail(handle, 'loop-guard-schema-mismatch', 'loop-guard.json must contain the exact schemaVersion 1 counter contract.');
  }
  const validateCounter = (name, cap, expectedCount = null) => {
    const counter = guard.counters[name];
    if (!hasExactKeys(counter, ['count', 'firstAt', 'lastAt'])
      || !Number.isInteger(counter.count)
      || counter.count < 1
      || counter.count > cap
      || (expectedCount !== null && counter.count !== expectedCount)
      || !withinWindow(counter.firstAt, handle.startedAtMs, endedAtMs)
      || !withinWindow(counter.lastAt, handle.startedAtMs, endedAtMs)
      || isoMs(counter.firstAt) > isoMs(counter.lastAt)) {
      return false;
    }
    return true;
  };
  if (!validateCounter('iterations', 15, ledger.attempt)) {
    return fail(handle, 'iteration-guard-mismatch', 'The loop-guard iteration counter must match the pipeline attempt.');
  }
  if (isoMs(guard.counters.iterations.firstAt) < isoMs(ledger.createdAt)
    || isoMs(guard.counters.iterations.lastAt) > isoMs(ledger.updatedAt)) {
    return fail(handle, 'iteration-guard-time-mismatch', 'The iteration guard must be consulted during the recorded pipeline.');
  }

  const phaseStatuses = {};
  const completionTimes = new Map();
  const ledgerCreatedAt = isoMs(ledger.createdAt);
  const ledgerUpdatedAt = isoMs(ledger.updatedAt);
  for (const descriptor of sequence) {
    const entry = ledger.phases[descriptor.id];
    if (!isPlainObject(entry) || Object.keys(entry).some((key) => !PHASE_KEYS.has(key))) {
      return fail(handle, 'phase-schema-mismatch', `Phase ${descriptor.id} contains an invalid entry.`);
    }
    phaseStatuses[descriptor.id] = entry.status;
    if (!['completed', 'skipped'].includes(entry.status)) {
      return fail(handle, 'phase-not-terminal', `Phase ${descriptor.id} is not explicitly terminal.`, { phaseStatuses });
    }
    if (CORE_PHASES[handle.orchestrator].has(descriptor.id) && entry.status !== 'completed') {
      return fail(handle, 'core-phase-not-completed', `Core phase ${descriptor.id} must be completed.`, { phaseStatuses });
    }
    const trivialSkipAllowed = handle.orchestrator === 'atlas' && TRIVIAL_PHASES.has(descriptor.id);
    if (entry.status === 'skipped'
      && !trivialSkipAllowed
      && !DYNAMIC_SKIP_PHASES.has(descriptor.id)) {
      return fail(handle, 'unauthorized-phase-skip', `Phase ${descriptor.id} may not be skipped.`, { phaseStatuses });
    }

    const completedAt = isoMs(entry.completedAt);
    if (completedAt === null
      || !withinWindow(entry.completedAt, handle.startedAtMs, endedAtMs)
      || completedAt < ledgerCreatedAt
      || completedAt > ledgerUpdatedAt) {
      return fail(handle, 'phase-time-window', `Phase ${descriptor.id} has an invalid completion time.`, { phaseStatuses });
    }
    completionTimes.set(descriptor.id, completedAt);

    if (entry.status === 'completed') {
      const startedAt = isoMs(entry.startedAt);
      if (startedAt === null
        || !withinWindow(entry.startedAt, handle.startedAtMs, endedAtMs)
        || startedAt < ledgerCreatedAt
        || startedAt > completedAt
        || !Number.isInteger(entry.attempts)
        || entry.attempts < 1) {
        return fail(handle, 'phase-execution-metadata', `Completed phase ${descriptor.id} lacks valid entry evidence.`, { phaseStatuses });
      }
      if (Object.hasOwn(entry, 'outputs')) {
        const outputBytes = Buffer.byteLength(JSON.stringify(entry.outputs), 'utf-8');
        if (!isPlainObject(entry.outputs)
          || Object.values(entry.outputs).some((value) => (
            value !== null && !['string', 'number', 'boolean'].includes(typeof value)
          ))
          || outputBytes > 4 * 1024) {
          return fail(handle, 'phase-output-contract', `Phase ${descriptor.id} has invalid bounded scalar outputs.`, { phaseStatuses });
        }
      }
    } else if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      return fail(handle, 'missing-skip-reason', `Skipped phase ${descriptor.id} requires an explicit reason.`, { phaseStatuses });
    }
  }

  if (handle.orchestrator === 'atlas') {
    const trivialEntries = [...TRIVIAL_PHASES].map((id) => ledger.phases[id]);
    if (trivialEntries.some((entry) => entry.status === 'skipped')
      && !trivialEntries.every((entry) => entry.status === 'skipped' && entry.reason === 'trivial')) {
      return fail(handle, 'invalid-trivial-skip', 'context/spec/plan must be skipped together with reason trivial.', { phaseStatuses });
    }
  }
  if (ledger.phases.complete.status !== 'completed') {
    return fail(handle, 'pipeline-not-complete', 'The final complete phase was not completed.', { phaseStatuses });
  }
  const attemptPhaseId = handle.orchestrator === 'atlas' ? 'execute' : 'integrate';
  const finalAttemptPhaseId = handle.orchestrator === 'atlas' ? 'verify' : 'integrate';
  if (isoMs(guard.counters.iterations.firstAt) > isoMs(ledger.phases[attemptPhaseId].startedAt)
    || isoMs(guard.counters.iterations.lastAt) > isoMs(ledger.phases[finalAttemptPhaseId].startedAt)) {
    return fail(handle, 'iteration-guard-phase-order', 'Iteration guard ticks must open the execute loop after planning and precede the final verify attempt.');
  }
  if (!validateCounter('reviewRounds', 3, ledger.phases.review.attempts)) {
    return fail(handle, 'review-guard-mismatch', 'Every recorded review attempt requires exactly one bounded loop-guard review round.');
  }
  if (isoMs(guard.counters.reviewRounds.firstAt) < isoMs(ledger.phases.review.startedAt)
    || isoMs(guard.counters.reviewRounds.lastAt) > isoMs(ledger.phases.review.completedAt)) {
    return fail(handle, 'review-guard-time-mismatch', 'Review guard ticks must occur inside the recorded review phase.');
  }
  if (ledger.phases.ci.status === 'completed' && !validateCounter('ci-cycles', 2)) {
    return fail(handle, 'ci-guard-mismatch', 'A completed CI phase requires a bounded loop-guard CI cycle.');
  }
  if (ledger.phases.ci.status === 'completed'
    && (isoMs(guard.counters['ci-cycles'].firstAt) < isoMs(ledger.phases.ci.startedAt)
      || isoMs(guard.counters['ci-cycles'].lastAt) > isoMs(ledger.phases.ci.completedAt))) {
    return fail(handle, 'ci-guard-time-mismatch', 'CI guard ticks must occur inside the recorded CI phase.');
  }
  if (handle.orchestrator === 'athena' && !validateCounter('monitor-iterations', 10)) {
    return fail(handle, 'monitor-guard-mismatch', 'A completed Athena monitor phase requires a bounded monitor loop tick.');
  }
  if (handle.orchestrator === 'athena'
    && (isoMs(guard.counters['monitor-iterations'].firstAt) < isoMs(ledger.phases.monitor.startedAt)
      || isoMs(guard.counters['monitor-iterations'].lastAt) > isoMs(ledger.phases.monitor.completedAt))) {
    return fail(handle, 'monitor-guard-time-mismatch', 'Monitor guard ticks must occur inside the recorded monitor phase.');
  }

  const athenaOutputs = handle.orchestrator === 'athena'
    ? validateAthenaPhaseOutputs(handle, ledger)
    : null;
  if (athenaOutputs && !athenaOutputs.ok) {
    return fail(handle, athenaOutputs.reason, athenaOutputs.detail, { phaseStatuses });
  }

  const eventLines = eventsFile.buffer.toString('utf-8').split(/\r?\n/).filter((line) => line.trim() !== '');
  const events = [];
  for (const line of eventLines) {
    try {
      const event = JSON.parse(line);
      if (!isPlainObject(event)) throw new Error('invalid event');
      events.push(event);
    } catch {
      return fail(handle, 'invalid-events-jsonl', 'Every events.jsonl record must be a JSON object.', { phaseStatuses });
    }
  }
  const phaseEvents = events.filter((event) => event.type === 'pipeline_phase_completed');
  if (phaseEvents.some((event) => (
    !expectedIds.includes(event.phase)
    || event.detail?.orchestrator !== handle.orchestrator
    || ledger.phases[event.phase]?.status !== 'completed'
  ))) {
    return fail(handle, 'invalid-phase-event', 'events.jsonl contains a mismatched pipeline completion event.', { phaseStatuses });
  }

  if (handle.orchestrator === 'athena') {
    const spawnProgressEvents = events.filter((event) => (
      event.type === 'pipeline_phase_outputs_recorded'
      && event.phase === 'spawn'
      && event.detail?.orchestrator === 'athena'
      && isPlainObject(event.detail?.outputs)
    ));
    const stableKeys = ['runId', 'teamSlug', 'intendedWorkers', 'spawnPath', 'baseCommit'];
    const matchingProgress = spawnProgressEvents.filter((event) => (
      stableKeys.every((key) => event.detail.outputs[key] === athenaOutputs.spawn[key])
      && withinWindow(event.timestamp, handle.startedAtMs, endedAtMs)
      && isoMs(event.timestamp) >= isoMs(ledger.phases.spawn.startedAt)
      && isoMs(event.timestamp) <= isoMs(ledger.phases.spawn.completedAt)
    ));
    const prelaunchIndex = matchingProgress.findIndex((event) => event.detail.outputs.launchState === 'not-started');
    const startedIndex = matchingProgress.findIndex((event, index) => (
      index > prelaunchIndex && event.detail.outputs.launchState === 'started'
    ));
    if (prelaunchIndex < 0 || startedIndex < 0) {
      return fail(handle, 'athena-spawn-progress-evidence', 'Athena must persist matching pre-launch and launch-started identities before spawn completion.', { phaseStatuses });
    }
  }

  // Prove that at least one canonical forward traversal occurred. Later policy
  // rewinds may legitimately append another plan/execute/verify completion, so
  // ordering each phase's *last* event would reject a valid Atlas run.
  let canonicalCursor = 0;
  const canonicalEvents = new Map();
  for (const descriptor of sequence) {
    if (ledger.phases[descriptor.id].status !== 'completed') continue;
    while (canonicalCursor < phaseEvents.length
      && phaseEvents[canonicalCursor].phase !== descriptor.id) {
      canonicalCursor += 1;
    }
    if (canonicalCursor >= phaseEvents.length) {
      return fail(handle, 'phase-event-order-mismatch', `No ordered completion event proves phase ${descriptor.id}.`, { phaseStatuses });
    }
    canonicalEvents.set(descriptor.id, phaseEvents[canonicalCursor]);
    canonicalCursor += 1;
  }
  const planningAnchorId = handle.orchestrator === 'atlas'
    ? ['plan', 'spec', 'context', 'triage'].find((id) => ledger.phases[id].status === 'completed')
    : 'wisdom';
  if (!planningAnchorId
    || isoMs(guard.counters.iterations.firstAt) < isoMs(canonicalEvents.get(planningAnchorId)?.timestamp)) {
    return fail(handle, 'iteration-guard-phase-order', 'The first iteration guard tick must follow the canonical planning traversal.', { phaseStatuses });
  }

  // Bind the final ledger state for each completed phase to its latest event,
  // independently of rewind order.
  for (const descriptor of sequence) {
    if (ledger.phases[descriptor.id].status !== 'completed') continue;
    const latest = phaseEvents.findLast((event) => (
      event.phase === descriptor.id
      && event.detail?.orchestrator === handle.orchestrator
    ));
    const eventTime = isoMs(latest?.timestamp);
    if (eventTime === null
      || eventTime < completionTimes.get(descriptor.id)
      || !withinWindow(latest.timestamp, handle.startedAtMs, endedAtMs)) {
      return fail(handle, 'phase-event-time-mismatch', `Completion event for ${descriptor.id} is invalid.`, { phaseStatuses });
    }
    if (handle.orchestrator === 'athena'
      && ['spawn', 'monitor', 'integrate', 'complete'].includes(descriptor.id)
      && JSON.stringify(latest.detail?.outputs) !== JSON.stringify(ledger.phases[descriptor.id].outputs)) {
      return fail(handle, 'athena-phase-event-output-mismatch', `Completion event for ${descriptor.id} does not bind the final Athena outputs.`, { phaseStatuses });
    }
  }

  // File order is the durable transition order. Require its timestamps to agree
  // so a forged future event cannot precede older completion records.
  let previousEventTime = null;
  const summaryFinishedAt = isoMs(summary.finishedAt);
  for (const event of phaseEvents) {
    const eventTime = isoMs(event.timestamp);
    if (eventTime === null
      || !withinWindow(event.timestamp, handle.startedAtMs, endedAtMs)
      || (previousEventTime !== null && eventTime < previousEventTime)) {
      return fail(handle, 'phase-event-time-order-mismatch', 'Pipeline completion event timestamps contradict their durable file order.', { phaseStatuses });
    }
    if (eventTime > summaryFinishedAt) {
      return fail(handle, 'phase-event-after-summary', 'Pipeline completion events must precede run summary finalization.', { phaseStatuses });
    }
    previousEventTime = eventTime;
  }
  if (phaseEvents.at(-1)?.phase !== 'complete') {
    return fail(handle, 'missing-final-completion-event', 'The last pipeline completion event must be complete.', { phaseStatuses });
  }
  const finalizedIndex = events.findLastIndex((event) => event.type === 'run_finalized');
  const completeEventIndex = events.findLastIndex((event) => event.type === 'pipeline_phase_completed' && event.phase === 'complete');
  const finalized = finalizedIndex >= 0 ? events[finalizedIndex] : null;
  if (!finalized
    || finalizedIndex <= completeEventIndex
    || finalized.detail?.status !== 'completed'
    || !withinWindow(finalized.timestamp, handle.startedAtMs, endedAtMs)
    || isoMs(finalized.timestamp) < isoMs(events[completeEventIndex]?.timestamp)
    || isoMs(finalized.timestamp) < summaryFinishedAt) {
    return fail(handle, 'missing-run-finalization', 'A completed run_finalized event must follow the complete phase.', { phaseStatuses });
  }

  return {
    policyVersion: PIPELINE_EVIDENCE_POLICY_VERSION,
    trust: TRUST,
    required: true,
    pass: true,
    reason: null,
    detail: `Validated finalized ${handle.orchestrator} pipeline ${handle.pipelineRunId}.`,
    pipelineRunId: handle.pipelineRunId,
    relativePath: relativePipelinePath(handle.pipelineRunId),
    orchestrator: handle.orchestrator,
    attempt: ledger.attempt,
    createdAt: ledger.createdAt,
    updatedAt: ledger.updatedAt,
    phaseStatuses,
    ledgerSha256: sha256(pipelineFile.buffer),
    summarySha256: sha256(summaryFile.buffer),
    eventsSha256: sha256(eventsFile.buffer),
    guardSha256: sha256(guardFile.buffer),
  };
}
