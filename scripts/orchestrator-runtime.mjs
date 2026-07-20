#!/usr/bin/env node

/**
 * Code-owned Atlas/Athena phase control.
 *
 * This CLI intentionally exposes a very small, positional command surface.
 * It never accepts a cwd, artifact base, state directory, arbitrary output
 * object, or free-form transition name. All storage is rooted at process.cwd()
 * and all identities are checked against the existing run record before a
 * mutation is attempted.
 */

import { fileURLToPath } from 'node:url';
import { lstatSync, realpathSync } from 'node:fs';
import { execFileSync as nodeExecFileSync } from 'node:child_process';
import { join, posix, resolve } from 'node:path';
import {
  getActiveRunId,
  getRun,
  getUserTaskUpdates,
  getVerificationGenerationProgress,
  pinRunReviewBase,
} from './lib/run-artifacts.mjs';
import {
  beginAttempt,
  completePhase,
  enterPhase,
  finalizeCompletedPipeline,
  getPhaseSequence,
  getPipelineState,
  inspectCurrentPhaseLoop,
  isComplete,
  loopTick,
  reattempt,
  recordPhaseError,
  reopenPhase,
  skipPhase,
  withCurrentPhaseLoopTick,
} from './lib/phase-runner.mjs';
import {
  enrichExecutionPrd,
  readExecutionPrd,
  readPlanningPrdForExecution,
  setExecutionStoryPasses,
} from './lib/execution-prd-store.mjs';
import { writeHermesSpecArtifacts } from './lib/spec-artifact.mjs';
import { registerEscalation } from './lib/stage-escalation.mjs';
import { resolveReviewBase } from './lib/review-package.mjs';
import { finalizeFailedRun } from './lib/run-failure.mjs';
import { loadAutonomyConfig, resolveRunShipMode } from './lib/autonomy.mjs';
import {
  detectBaseBranch,
  detectRepositoryIdentity,
  repositoryIdentitiesEqual,
} from './lib/pr-create.mjs';
import { watchCI } from './lib/ci-watch.mjs';
import {
  resolveTrustedVcsBinary,
  sanitizedVcsEnvironment,
} from './lib/trusted-vcs.mjs';
import {
  approveBoundReview,
  recordBoundVerification,
  sealBoundVerification,
  startBoundVerification,
  validateFinalizePhaseCompletion,
  validateReviewPhaseCompletion,
} from './lib/orchestrator-review-evidence.mjs';

const COMMANDS = new Set([
  'status',
  'enter',
  'complete',
  'skip',
  'attempt',
  'tick',
  'record-error',
  'reattempt',
  'policy-rewind',
  'init-trivial-prd',
  'story-pass',
  'verification-start',
  'verification-record',
  'verification-seal',
  'complete-verification',
  'approve-review',
  'complete-review',
  'complete-finalize',
  'complete-ci',
  'terminal-fail',
  'finalize',
]);
const ACTIVE_EVIDENCE_COMMANDS = new Set([
  'verification-start',
  'verification-record',
  'verification-seal',
  'complete-verification',
  'approve-review',
  'complete-review',
  'complete-finalize',
  'complete-ci',
]);
const ORCHESTRATORS = new Set(['atlas', 'athena']);
const SAFE_RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const TERMINAL_PHASE_STATUSES = new Set(['completed', 'skipped']);
const LOOP_KEYS = Object.freeze({
  atlas: new Set(['review', 'final-review', 'ci']),
  athena: new Set(['review', 'final-review', 'monitor', 'ci']),
});
const LOOP_PHASES = Object.freeze({
  atlas: Object.freeze({
    review: 'review',
    'final-review': 'finalize',
    ci: 'ci',
  }),
  athena: Object.freeze({
    review: 'review',
    'final-review': 'finalize',
    monitor: 'monitor',
    ci: 'ci',
  }),
});
const SAFE_ERROR_CODE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/;
const SAFE_OUTPUT_TEXT = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,2047}$/;
const SAFE_SCOPE = /^[a-zA-Z0-9][a-zA-Z0-9._/@+-]{0,511}$/;
const SAFE_STORY_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ATLAS_FINALIZE_OUTPUT_KEYS = Object.freeze([
  'finalReviewDigest', 'finalReviewTreeOid', 'finalCommit',
]);
const VERIFICATION_GENERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVIDENCE_PHASE_PIPELINE_PHASE = Object.freeze({
  review: 'verify',
  'final-review': 'finalize',
});
const APPROVAL_PHASE_PIPELINE_PHASE = Object.freeze({
  review: 'review',
  'final-review': 'finalize',
});
const MAX_VERIFICATION_INPUT_BYTES = 128 * 1024;
const MAX_REVIEW_INPUT_BYTES = 1024 * 1024;
const SHIP_COMMAND_TIMEOUT_MS = 15_000;
const SHIP_COMMAND_MAX_BUFFER = 1024 * 1024;
let _execFileSync = nodeExecFileSync;

export function __setRuntimeExecFileSyncForTest(fn) {
  _execFileSync = fn;
}

export function __resetRuntimeExecFileSyncForTest() {
  _execFileSync = nodeExecFileSync;
}
const TERMINAL_FAILURE_CODES = Object.freeze({
  verification_exhausted: Object.freeze({
    failureClass: 'task-outcome',
    phases: new Set(['verify', 'integrate']),
  }),
  review_exhausted: Object.freeze({
    failureClass: 'task-outcome',
    phases: new Set(['review', 'finalize']),
  }),
  acceptance_criteria_unmet: Object.freeze({
    failureClass: 'task-outcome',
    phases: new Set(['execute', 'verify', 'integrate']),
  }),
  test_regression_unresolved: Object.freeze({
    failureClass: 'task-outcome',
    phases: new Set(['verify', 'integrate']),
  }),
  phase_guard_exhausted: Object.freeze({
    failureClass: 'orchestration',
    phases: null,
  }),
  worker_integration_failed: Object.freeze({
    failureClass: 'orchestration',
    phases: new Set(['spawn', 'monitor', 'integrate']),
  }),
  recovery_state_invalid: Object.freeze({
    failureClass: 'orchestration',
    phases: null,
  }),
  plan_validation_failed: Object.freeze({
    failureClass: 'orchestration',
    phases: new Set(['plan']),
  }),
});
const REATTEMPT_POLICIES = Object.freeze({
  atlas: Object.freeze({
    quality_fail: Object.freeze(['execute', 'verify']),
    review_reject: Object.freeze(['verify']),
    final_review_reject: Object.freeze(['verify']),
    light_mode_reexec: Object.freeze(['execute', 'verify']),
  }),
  athena: Object.freeze({
    review_reject: Object.freeze(['integrate']),
    final_review_reject: Object.freeze(['integrate']),
  }),
});
const POLICY_REWINDS = Object.freeze({
  atlas: Object.freeze({
    light_mode_rewind: Object.freeze({ phaseId: 'plan', counter: 'light-mode-rewind', cap: 2 }),
  }),
  athena: Object.freeze({
    light_mode_rewind: Object.freeze({ phaseId: 'plan', counter: 'light-mode-rewind', cap: 2 }),
  }),
});
const ERROR_PHASES = Object.freeze({
  atlas: new Set(['verify']),
  athena: new Set(['integrate']),
});
const COMPLETION_OUTPUT_FIELDS = Object.freeze({
  atlas: Object.freeze({
    triage: new Set(['reviewBaseRef', 'reviewBaseCommit', 'reviewBaseSource']),
    ship: new Set([
      'pushPerformed',
      'createdPrUrl',
      'branchName',
      'baseBranch',
      'headCommit',
      'repoOriginUrl',
      'repoPushUrl',
      'repoRepository',
      'repoDefaultBranch',
    ]),
    ci: new Set(['ciHeadCommit']),
  }),
  athena: Object.freeze({}),
});
const REQUIRED_COMPLETION_OUTPUT_FIELDS = Object.freeze({
  atlas: Object.freeze({
    triage: COMPLETION_OUTPUT_FIELDS.atlas.triage,
    ship: COMPLETION_OUTPUT_FIELDS.atlas.ship,
  }),
  athena: Object.freeze({}),
});
const BOOLEAN_OUTPUT_FIELDS = new Set(['pushPerformed']);
const NULLABLE_OUTPUT_FIELDS = new Set(['createdPrUrl', 'ciHeadCommit']);
const OBJECT_ID_OUTPUT_FIELDS = new Set([
  'reviewBaseCommit',
  'approvedReviewTreeOid',
  'finalReviewTreeOid',
  'finalCommit',
  'headCommit',
  'ciHeadCommit',
]);
const DIGEST_OUTPUT_FIELDS = new Set(['approvedReviewDigest', 'finalReviewDigest']);

class RuntimeCommandError extends Error {
  constructor(code, message, detail = undefined) {
    super(message);
    this.name = 'RuntimeCommandError';
    this.code = code;
    this.detail = detail;
  }
}

function reject(code, message, detail = undefined) {
  throw new RuntimeCommandError(code, message, detail);
}

function requireArgumentCount(command, args, min, max = min) {
  if (args.length < min || args.length > max) {
    const expected = min === max ? String(min) : `${min}-${max}`;
    reject(
      'invalid-arguments',
      `${command} expects ${expected} argument(s) after the orchestrator`,
    );
  }
}

function requireOrchestrator(value) {
  if (!ORCHESTRATORS.has(value)) {
    reject('invalid-orchestrator', 'orchestrator must be atlas or athena');
  }
  return value;
}

function requireRunId(value) {
  if (typeof value !== 'string' || !SAFE_RUN_ID.test(value)) {
    reject('invalid-run-id', 'runId is not a safe run identity');
  }
  return value;
}

function phaseDescriptor(orchestrator, phaseId) {
  const descriptor = getPhaseSequence(orchestrator).find(({ id }) => id === phaseId);
  if (!descriptor) {
    reject('invalid-phase', `phase is not allowed for ${orchestrator}`);
  }
  return descriptor;
}

function requireCurrentInProgressPhase(orchestrator, pipeline, phaseId) {
  const current = getPhaseSequence(orchestrator).find(({ id }) => (
    !TERMINAL_PHASE_STATUSES.has(pipeline.phases?.[id]?.status)
  ));
  if (current?.id !== phaseId || pipeline.phases?.[phaseId]?.status !== 'in_progress') {
    reject('phase-not-in-progress', `${phaseId} must be the current in-progress phase`);
  }
}

function requireLoopKey(orchestrator, key) {
  if (!LOOP_KEYS[orchestrator]?.has(key)) {
    reject('invalid-loop', `loop is not allowed for ${orchestrator}`);
  }
  return key;
}

function parseOutputValue(key, raw) {
  if (raw === 'null' && NULLABLE_OUTPUT_FIELDS.has(key)) return null;
  if (BOOLEAN_OUTPUT_FIELDS.has(key)) {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    reject('invalid-output-value', `${key} must be true or false`);
  }
  if (OBJECT_ID_OUTPUT_FIELDS.has(key)) {
    if (!OBJECT_ID.test(raw)) reject('invalid-output-value', `${key} must be a Git object id`);
    return raw;
  }
  if (DIGEST_OUTPUT_FIELDS.has(key)) {
    if (!DIGEST.test(raw)) reject('invalid-output-value', `${key} must be a sha256 digest`);
    return raw;
  }
  if (!SAFE_OUTPUT_TEXT.test(raw)) {
    reject('invalid-output-value', `${key} must use the bounded shell-safe scalar alphabet`);
  }
  return raw;
}

function parseCompletionOutputs(orchestrator, phaseId, tokens) {
  const allowlist = COMPLETION_OUTPUT_FIELDS[orchestrator]?.[phaseId];
  const required = REQUIRED_COMPLETION_OUTPUT_FIELDS[orchestrator]?.[phaseId];
  if (tokens.length === 0) {
    if (required?.size > 0) {
      reject(
        'required-outputs-missing',
        `${phaseId} requires outputs: ${[...required].join(', ')}`,
      );
    }
    return undefined;
  }
  if (!allowlist || allowlist.size === 0) {
    reject('outputs-not-allowed', `completion outputs are not accepted for ${phaseId}`);
  }
  if (tokens.length > allowlist.size) {
    reject('too-many-outputs', `too many completion outputs for ${phaseId}`);
  }
  const outputs = {};
  for (const token of tokens) {
    if (typeof token !== 'string' || token.length > 4096) {
      reject('invalid-output', 'completion output must be a bounded key=value token');
    }
    const separator = token.indexOf('=');
    if (separator <= 0) reject('invalid-output', 'completion output must use key=value');
    const key = token.slice(0, separator);
    const raw = token.slice(separator + 1);
    if (!allowlist.has(key)) {
      reject('output-key-not-allowed', `${key} is not an allowlisted output for ${phaseId}`);
    }
    if (Object.hasOwn(outputs, key)) reject('duplicate-output', `${key} was supplied more than once`);
    outputs[key] = parseOutputValue(key, raw);
  }
  const missing = required ? [...required].filter(key => !Object.hasOwn(outputs, key)) : [];
  if (missing.length > 0) {
    reject('required-outputs-missing', `${phaseId} is missing outputs: ${missing.join(', ')}`);
  }
  if (Buffer.byteLength(JSON.stringify(outputs), 'utf8') > 4096) {
    reject('outputs-too-large', 'completion outputs exceed the phase-runner scalar cap');
  }
  return outputs;
}

function runShipCommand(command, args) {
  try {
    return _execFileSync(
      _execFileSync === nodeExecFileSync ? resolveTrustedVcsBinary(command) : command,
      args,
      {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: SHIP_COMMAND_TIMEOUT_MS,
      maxBuffer: SHIP_COMMAND_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(_execFileSync === nodeExecFileSync
        ? { env: sanitizedVcsEnvironment({ git: command === 'git' }) }
        : {}),
      },
    ).trim();
  } catch {
    reject(
      'ship-evidence-unavailable',
      `code-owned ${command} shipping evidence could not be read`,
    );
  }
}

function readDurableAtlasShipPolicy(runId, { allowNever = false } = {}) {
  const cwd = process.cwd();
  const run = getRun(runId, { trustedRoot: cwd });
  const updates = getUserTaskUpdates(runId, { trustedRoot: cwd });
  if (run.summary?.runId !== runId
    || run.summary?.orchestrator !== 'atlas'
    || typeof run.summary?.task !== 'string'
    || !run.summary.task.trim()
    || updates?.ok !== true
    || !Array.isArray(updates.updates)
    || updates.updates.length < 1
    || updates.updates.some((update, index) => (
      update?.sequence !== index + 1
      || typeof update?.task !== 'string'
      || !update.task.trim()
    ))) {
    reject(
      'ship-policy-unavailable',
      'Atlas shipping requires the intact durable user-task ledger',
    );
  }
  const config = loadAutonomyConfig(cwd);
  const policy = resolveRunShipMode(config, [
    run.summary.task,
    ...updates.updates.map(update => update.task),
  ]);
  if (!allowNever && policy.effectiveMode === 'never') {
    reject(
      'ship-policy-denied',
      policy.taskForbidsShipping
        ? 'a durable user instruction forbids shipping this run'
        : 'the durable autonomy policy forbids shipping this run',
      policy,
    );
  }
  if (!['never', 'ask', 'auto'].includes(policy.effectiveMode)) {
    reject('ship-policy-unavailable', 'Atlas ship policy is not valid');
  }
  return { config, policy, run };
}

function readCurrentAtlasShipContext(config) {
  const repositoryRoot = runShipCommand('git', ['rev-parse', '--show-toplevel']);
  let canonicalCwd;
  let canonicalRoot;
  try {
    canonicalCwd = realpathSync(process.cwd());
    canonicalRoot = realpathSync(repositoryRoot);
  } catch {
    reject('ship-repository-unavailable', 'shipping repository root could not be resolved');
  }
  if (canonicalCwd !== canonicalRoot) {
    reject(
      'ship-repository-unavailable',
      'shipping requires the exact canonical Git worktree root',
    );
  }
  const branchName = runShipCommand('git', ['branch', '--show-current']);
  const headCommit = runShipCommand('git', ['rev-parse', '--verify', 'HEAD']);
  if (!branchName || !OBJECT_ID.test(headCommit)) {
    reject('ship-evidence-unavailable', 'shipping requires an attached Git branch and HEAD');
  }
  runShipCommand('git', ['check-ref-format', '--branch', branchName]);
  const repoIdentity = detectRepositoryIdentity(process.cwd());
  if (!repoIdentity) {
    reject(
      'ship-repository-unavailable',
      'shipping requires a code-owned, canonical origin repository identity',
    );
  }
  const baseBranch = detectBaseBranch(process.cwd(), config?.ship?.baseBranch ?? null);
  if (typeof baseBranch !== 'string' || !baseBranch.trim()) {
    reject('ship-repository-unavailable', 'shipping base branch could not be resolved');
  }
  runShipCommand('git', ['check-ref-format', '--branch', baseBranch]);
  return {
    branchName,
    baseBranch,
    headCommit,
    repoIdentity,
  };
}

function requireAtlasFinalizeBinding(pipeline, context) {
  const finalize = pipeline?.phases?.finalize;
  const outputs = finalize?.outputs;
  if (finalize?.status !== 'completed'
    || !outputs
    || typeof outputs !== 'object'
    || Array.isArray(outputs)
    || Object.keys(outputs).length !== ATLAS_FINALIZE_OUTPUT_KEYS.length
    || !ATLAS_FINALIZE_OUTPUT_KEYS.every(key => Object.hasOwn(outputs, key))
    || !DIGEST.test(outputs.finalReviewDigest || '')
    || !OBJECT_ID.test(outputs.finalReviewTreeOid || '')
    || !OBJECT_ID.test(outputs.finalCommit || '')) {
    reject(
      'ship-finalize-evidence-unavailable',
      'shipping requires exact outputs from the completed code-owned final-review boundary',
    );
  }
  if (context.headCommit !== outputs.finalCommit) {
    reject(
      'ship-finalize-head-mismatch',
      'current HEAD no longer matches the reviewer-approved finalize commit',
      { approvedFinalCommit: outputs.finalCommit, currentHeadCommit: context.headCommit },
    );
  }
  return outputs;
}

function requireAtlasShipAuthorization(runId, { pipeline = null } = {}) {
  const durable = readDurableAtlasShipPolicy(runId);
  // A run event is writable by the same cooperative orchestrator and cannot
  // attest that Claude Code actually displayed AskUserQuestion or that a human
  // selected an answer. Until the host provides a nonce-bound receipt channel,
  // executable shipping fails closed in ask mode instead of accepting a
  // caller-authored `source:"AskUserQuestion"` string.
  if (durable.policy.effectiveMode === 'ask') {
    reject(
      'ship-approval-unattested',
      'ask-mode outward shipping requires a host-attested approval receipt; keep the branch local or ship manually',
    );
  }
  const context = readCurrentAtlasShipContext(durable.config);
  const finalize = requireAtlasFinalizeBinding(
    pipeline || readPipeline('atlas', runId),
    context,
  );
  return { ...durable, context, finalize };
}

function parseRemoteHead(output, branchName) {
  const expectedRef = `refs/heads/${branchName}`;
  const lines = output.split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) return null;
  const [oid, ref, ...extra] = lines[0].split(/\s+/);
  return extra.length === 0 && ref === expectedRef && OBJECT_ID.test(oid || '')
    ? oid
    : null;
}

function validateAtlasShipCompletion(runId, suppliedOutputs, { pipeline = null } = {}) {
  const { context } = requireAtlasShipAuthorization(runId, { pipeline });
  const suppliedIdentity = {
    originUrl: suppliedOutputs?.repoOriginUrl,
    pushUrl: suppliedOutputs?.repoPushUrl,
    repository: suppliedOutputs?.repoRepository,
    defaultBranch: suppliedOutputs?.repoDefaultBranch,
  };
  if (suppliedOutputs?.pushPerformed !== true
    || typeof suppliedOutputs?.createdPrUrl !== 'string'
    || !suppliedOutputs.createdPrUrl.trim()
    || suppliedOutputs.branchName !== context.branchName
    || suppliedOutputs.baseBranch !== context.baseBranch
    || suppliedOutputs.headCommit !== context.headCommit
    || !repositoryIdentitiesEqual(suppliedIdentity, context.repoIdentity)) {
    reject(
      'ship-evidence-mismatch',
      'caller ship outputs do not match the code-owned repository, branch, base, and HEAD',
    );
  }

  const remoteOutput = runShipCommand('git', [
    'ls-remote', '--refs', context.repoIdentity.pushUrl, `refs/heads/${context.branchName}`,
  ]);
  if (parseRemoteHead(remoteOutput, context.branchName) !== context.headCommit) {
    reject(
      'ship-remote-head-mismatch',
      'the canonical origin push endpoint does not contain the approved branch at the approved HEAD',
    );
  }

  let pr;
  try {
    pr = JSON.parse(runShipCommand('gh', [
      'pr', 'view', suppliedOutputs.createdPrUrl,
      '--repo', context.repoIdentity.repository,
      '--json', 'url,headRefName,headRefOid,baseRefName,isCrossRepository',
    ]));
  } catch (error) {
    if (error instanceof RuntimeCommandError) throw error;
    reject('ship-pr-evidence-invalid', 'pull-request evidence is not valid JSON');
  }
  if (pr?.url !== suppliedOutputs.createdPrUrl
    || pr?.headRefName !== context.branchName
    || pr?.headRefOid !== context.headCommit
    || pr?.baseRefName !== context.baseBranch
    || pr?.isCrossRepository !== false) {
    reject(
      'ship-pr-evidence-mismatch',
      'the observed pull request is not bound to the approved branch and base',
    );
  }

  return {
    pushPerformed: true,
    createdPrUrl: pr.url,
    branchName: context.branchName,
    baseBranch: context.baseBranch,
    headCommit: context.headCommit,
    repoOriginUrl: context.repoIdentity.originUrl,
    repoPushUrl: context.repoIdentity.pushUrl,
    repoRepository: context.repoIdentity.repository,
    repoDefaultBranch: context.repoIdentity.defaultBranch,
  };
}

function validateAtlasShipSkip(runId, reason) {
  const { config, policy } = readDurableAtlasShipPolicy(runId, { allowNever: true });
  if (reason === 'not-applicable' && policy.effectiveMode === 'never') {
    return { policy, reason };
  }
  if (reason === 'user-declined' && policy.effectiveMode === 'ask') {
    return { policy, reason };
  }
  if (reason === 'preflight-unavailable' && policy.effectiveMode === 'auto') {
    try {
      readCurrentAtlasShipContext(config);
    } catch (error) {
      if (error instanceof RuntimeCommandError
        && new Set([
          'ship-evidence-unavailable',
          'ship-repository-unavailable',
        ]).has(error.code)) {
        return { policy, reason, evidence: error.code };
      }
      throw error;
    }
    reject(
      'ship-skip-evidence-mismatch',
      'preflight-unavailable cannot skip a currently available auto-shipping target',
    );
  }
  reject(
    'ship-skip-policy-mismatch',
    `ship skip reason ${reason} does not match the durable Atlas ship policy`,
    policy,
  );
}

function validateAtlasCiSkip(runId, reason, pipeline) {
  const ship = pipeline.phases?.ship;
  const { config, policy } = readDurableAtlasShipPolicy(runId, { allowNever: true });
  if (reason === 'no-pr' && ship?.status === 'skipped') {
    return { policy, reason, shipStatus: ship.status };
  }
  if (reason === 'watch-disabled'
    && ship?.status === 'completed'
    && ship.outputs?.pushPerformed === true
    && typeof ship.outputs?.createdPrUrl === 'string'
    && ship.outputs.createdPrUrl.trim()
    && config.ci?.watchEnabled === false) {
    return { policy, reason, shipStatus: ship.status };
  }
  if (reason === 'not-applicable'
    && ship?.status === 'skipped'
    && policy.effectiveMode === 'never') {
    return { policy, reason, shipStatus: ship.status };
  }
  reject(
    'ci-skip-evidence-mismatch',
    `CI skip reason ${reason} does not match the code-owned ship outcome and CI policy`,
  );
}

function validateAtlasCiTarget(runId, pipeline) {
  const ship = pipeline.phases?.ship;
  if (ship?.status !== 'completed'
    || !ship.outputs
    || typeof ship.outputs !== 'object'
    || Array.isArray(ship.outputs)) {
    reject('ci-ship-evidence-unavailable', 'CI requires one completed code-owned ship outcome');
  }
  const { config } = readDurableAtlasShipPolicy(runId);
  if (config.ci?.watchEnabled !== true) {
    reject('ci-watch-disabled', 'CI completion is unavailable while ci.watchEnabled is false');
  }
  const authoritative = validateAtlasShipCompletion(runId, ship.outputs, { pipeline });
  return { config, ship: authoritative };
}

async function completeAtlasCiPhase(runId, pipeline) {
  const loop = inspectCurrentPhaseLoop(runId, 'ci', { cwd: process.cwd() });
  if (loop?.ok !== true || loop.satisfied !== true) {
    reject('ci-loop-unsatisfied', 'CI completion requires the code-owned CI loop tick first', loop);
  }
  const target = validateAtlasCiTarget(runId, pipeline);
  const configuredCycles = target.config.ci.maxCycles;
  const pollIntervalMs = target.config.ci.pollIntervalMs;
  const timeoutCycles = Math.max(1, Math.floor(target.config.ci.timeoutMs / pollIntervalMs));
  const observed = await watchCI({
    cwd: process.cwd(),
    repository: target.ship.repoRepository,
    branch: target.ship.branchName,
    expectedHeadSha: target.ship.headCommit,
    maxCycles: Math.min(configuredCycles, timeoutCycles),
    pollIntervalMs,
  });
  if (observed?.status !== 'passed'
    || observed.conclusion !== 'success'
    || !/^[1-9]\d*$/.test(observed.runId || '')) {
    reject(
      observed?.status === 'failed' ? 'ci-quality-failed' : 'ci-evidence-unavailable',
      'CI did not produce one code-owned successful result for the exact pushed HEAD',
      observed,
    );
  }

  const checkpointData = { runId, ciHeadCommit: target.ship.headCommit };
  let boundaryError = null;
  const result = await completePhase(runId, 'ci', undefined, {
    cwd: process.cwd(),
    checkpointData,
    _deriveOutputs: () => {
      try {
        const currentPipeline = readPipeline('atlas', runId);
        const current = validateAtlasCiTarget(runId, currentPipeline);
        if (current.ship.headCommit !== target.ship.headCommit
          || current.ship.branchName !== target.ship.branchName
          || current.ship.repoRepository !== target.ship.repoRepository) {
          reject('ci-target-changed', 'the pushed CI target changed after observation');
        }
        return { ciHeadCommit: current.ship.headCommit };
      } catch (error) {
        boundaryError = error;
        throw error;
      }
    },
  });
  if (boundaryError) throw boundaryError;
  requireSafeResult(
    result?.ok === true && result?.checkpointDegraded !== true,
    'ci-completion-denied',
    'CI success could not be durably completed',
    result,
  );
  return { ...result, observation: observed };
}

function executionCheckpoint(orchestrator, phaseId) {
  if (phaseId !== 'plan' && phaseId !== 'execute') return undefined;
  let record;
  try {
    record = readExecutionPrd({ cwd: process.cwd(), orchestrator });
  } catch {
    reject(
      'execution-prd-unavailable',
      `${phaseId} completion requires the hardened project execution PRD`,
    );
  }
  const stories = record?.prd?.userStories;
  if (!Array.isArray(stories) || stories.length === 0) {
    reject('execution-prd-unavailable', 'execution PRD has no user stories');
  }
  const completedStories = stories
    .filter(story => story?.passes === true)
    .map(story => story.id);
  if (phaseId === 'execute' && completedStories.length !== stories.length) {
    reject('execution-prd-incomplete', 'execute cannot complete while a PRD story is not passing');
  }
  return {
    prdSnapshot: record.prd,
    ...(phaseId === 'execute' ? { completedStories } : {}),
  };
}

function completionCheckpoint(orchestrator, runId, phaseId, outputs, pipeline) {
  const execution = executionCheckpoint(orchestrator, phaseId);
  if (execution) return { runId, ...execution };

  if (phaseId === 'ci') {
    const shipOutputs = pipeline.phases?.ship?.outputs;
    if (shipOutputs && (typeof shipOutputs !== 'object' || Array.isArray(shipOutputs))) {
      reject('ship-outputs-unavailable', 'CI checkpoint cannot trust persisted ship outputs');
    }
    return {
      runId,
      ...(shipOutputs || {}),
      ...(outputs || {}),
    };
  }

  return outputs ? { runId, ...outputs } : undefined;
}

function pinTriageReviewBase(orchestrator, runId, phaseId, outputs) {
  if (orchestrator !== 'atlas' || phaseId !== 'triage') return null;
  let resolvedBase;
  try {
    resolvedBase = outputs.reviewBaseSource === 'explicit'
      ? resolveReviewBase({ cwd: process.cwd(), baseRef: outputs.reviewBaseRef })
      : resolveReviewBase({ cwd: process.cwd() });
  } catch {
    reject(
      'review-base-resolution-failed',
      'triage review base could not be resolved from the current Git repository',
    );
  }
  if (resolvedBase.baseRef !== outputs.reviewBaseRef
    || resolvedBase.baseRefCommit !== outputs.reviewBaseCommit
    || (outputs.reviewBaseSource !== 'explicit'
      && resolvedBase.source !== outputs.reviewBaseSource)) {
    reject(
      'review-base-evidence-mismatch',
      'triage outputs do not match the review base resolved from Git evidence',
      resolvedBase,
    );
  }
  const pinned = pinRunReviewBase(runId, {
    baseRef: resolvedBase.baseRef,
    baseRefCommit: resolvedBase.baseRefCommit,
    source: outputs.reviewBaseSource === 'explicit' ? 'explicit' : resolvedBase.source,
  }, { trustedRoot: process.cwd() });
  if (pinned?.ok !== true) {
    reject(
      'review-base-pin-failed',
      'triage cannot complete without the immutable review-base pin',
      pinned,
    );
  }
  return pinned.pin;
}

function requireSafeScopes(tokens) {
  if (tokens.length < 1 || tokens.length > 32) {
    reject('invalid-trivial-scope', 'init-trivial-prd requires 1-32 explicit scope paths');
  }
  const canonical = new Set();
  for (const scope of tokens) {
    if (!SAFE_SCOPE.test(scope)
      || scope.includes('\\')
      || scope.endsWith('/')
      || posix.isAbsolute(scope)
      || posix.normalize(scope) !== scope
      || scope === '.'
      || scope.startsWith('../')) {
      reject('invalid-trivial-scope', 'scope must be an explicit shell-safe repo-relative path');
    }
    const key = scope.toLowerCase();
    if (canonical.has(key)) reject('invalid-trivial-scope', 'scope paths must be case-portably unique');
    canonical.add(key);
  }
  return [...tokens];
}

function trivialProjectName(runId) {
  return `atlas-trivial-${runId.slice(-48).toLowerCase()}`;
}

function trivialPlanningPrd(runId) {
  return {
    projectName: trivialProjectName(runId),
    mode: 'engineering-change',
    scale: 'S',
    goals: ['Complete the active Atlas request recorded in the durable task ledger.'],
    nonGoals: [],
    constraints: ['Use the single scoped story and the normal execute, verify, and review gates.'],
    risks: ['A trivial classification can be wrong, so downstream verification remains mandatory.'],
    openQuestions: [],
    userStories: [{
      id: 'US-001',
      title: 'Complete the active scoped request',
      acceptanceCriteria: [
        'GIVEN the durable active request WHEN the scoped change is implemented and all required checks pass THEN fresh passing verification is recorded before final review',
      ],
      passes: false,
    }],
  };
}

function matchesTrivialBase(prd, runId) {
  const story = prd?.userStories?.[0];
  return prd?.projectName === trivialProjectName(runId)
    && prd?.mode === 'engineering-change'
    && prd?.scale === 'S'
    && Array.isArray(prd.userStories)
    && prd.userStories.length === 1
    && story?.id === 'US-001'
    && story?.title === 'Complete the active scoped request';
}

function matchesTrivialExecution(prd, runId, scopes = undefined) {
  const story = prd?.userStories?.[0];
  return matchesTrivialBase(prd, runId)
    && story?.assignTo === 'claude'
    && story?.model === 'sonnet'
    && story?.agentType === 'executor'
    && story?.parallelGroup === 'A'
    && Array.isArray(story?.scope)
    && (scopes === undefined || JSON.stringify(story.scope) === JSON.stringify(scopes));
}

function fixedArtifactExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    reject('trivial-prd-path-unavailable', 'fixed trivial PRD artifact path is unsafe');
  }
}

function initializeTrivialPrd(runId, scopes) {
  const cwd = process.cwd();
  const prdPath = join(cwd, '.ao', 'prd.json');
  const specPath = join(cwd, '.ao', 'spec.md');
  const hasPrd = fixedArtifactExists(prdPath);
  const hasSpec = fixedArtifactExists(specPath);
  if (hasPrd !== hasSpec) {
    reject('trivial-prd-pair-incomplete', 'existing spec.md/prd.json pair is incomplete');
  }

  if (hasPrd) {
    try {
      const existing = readExecutionPrd({ cwd, orchestrator: 'atlas' });
      if (!matchesTrivialExecution(existing.prd, runId, scopes)) {
        reject('prd-already-exists', 'existing execution PRD is not this run\'s trivial PRD');
      }
      return { ...existing, storyId: 'US-001', idempotent: true };
    } catch (error) {
      if (error instanceof RuntimeCommandError) throw error;
      // A valid planning-only artifact is the recoverable crash window between
      // spec creation and assignment enrichment. Anything else fails below.
    }
  }

  let planning;
  if (hasPrd) {
    try {
      planning = readPlanningPrdForExecution({ cwd });
    } catch {
      reject('prd-already-exists', 'existing PRD is invalid or unsafe');
    }
    if (!matchesTrivialBase(planning.prd, runId)) {
      reject('prd-already-exists', 'existing planning PRD is not this run\'s trivial PRD');
    }
  } else {
    const basePrd = trivialPlanningPrd(runId);
    const envelope = {
      schemaVersion: 1,
      verdict: 'CREATE',
      summary: 'Created the code-owned one-story Atlas trivial PRD.',
      specMarkdown: [
        '# Atlas Trivial Execution Spec',
        '',
        `Run: ${runId}`,
        `Scope: ${scopes.join(', ')}`,
        '',
        'The normal execute, verify, review, and final-review gates remain mandatory.',
      ].join('\n'),
      prd: basePrd,
    };
    try {
      writeHermesSpecArtifacts(JSON.stringify(envelope), { cwd, trustedRoot: cwd });
      planning = readPlanningPrdForExecution({ cwd });
    } catch {
      reject('trivial-prd-create-failed', 'hardened trivial spec artifact creation failed');
    }
  }

  const candidate = structuredClone(planning.prd);
  Object.assign(candidate.userStories[0], {
    parallelGroup: 'A',
    assignTo: 'claude',
    model: 'sonnet',
    agentType: 'executor',
    scope: scopes,
    dependsOn: [],
    requiresTDD: false,
  });
  let enriched;
  try {
    enriched = enrichExecutionPrd(candidate, {
      cwd,
      orchestrator: 'atlas',
      expectedGeneration: planning.generation,
    });
  } catch {
    reject('trivial-prd-enrichment-failed', 'trivial PRD assignment enrichment failed closed');
  }
  if (!matchesTrivialExecution(enriched.prd, runId, scopes)) {
    reject('trivial-prd-verification-failed', 'persisted trivial execution PRD did not match');
  }
  return { ...enriched, storyId: 'US-001', idempotent: false };
}

function passTrivialStory(runId, storyId) {
  if (!SAFE_STORY_ID.test(storyId) || storyId !== 'US-001') {
    reject('invalid-trivial-story', 'story-pass accepts only US-001 for a trivial PRD');
  }
  let current;
  try {
    current = readExecutionPrd({ cwd: process.cwd(), orchestrator: 'atlas' });
  } catch {
    reject('execution-prd-unavailable', 'trivial execution PRD is unavailable');
  }
  if (!matchesTrivialExecution(current.prd, runId)) {
    reject('not-trivial-prd', 'story-pass requires this run\'s code-owned trivial PRD');
  }
  let updated;
  try {
    updated = setExecutionStoryPasses([storyId], true, {
      cwd: process.cwd(),
      orchestrator: 'atlas',
      expectedGeneration: current.generation,
    });
  } catch {
    reject('story-pass-failed', 'hardened story pass transition failed');
  }
  return {
    changed: updated.changed,
    generation: updated.generation,
    storyId,
    passes: updated.prd.userStories[0].passes,
  };
}

function rollbackPassingExecutionStories(orchestrator) {
  let current;
  try {
    current = readExecutionPrd({ cwd: process.cwd(), orchestrator });
  } catch {
    reject('execution-prd-unavailable', 'reattempt cannot safely read the execution PRD');
  }
  const passingIds = current.prd.userStories
    .filter(story => story.passes === true)
    .map(story => story.id);
  if (passingIds.length === 0) {
    return { changed: false, generation: current.generation, storyIds: [] };
  }
  let rolledBack;
  try {
    rolledBack = setExecutionStoryPasses(passingIds, false, {
      cwd: process.cwd(),
      orchestrator,
      expectedGeneration: current.generation,
    });
  } catch {
    reject('execution-prd-rollback-failed', 'reattempt could not invalidate passing stories');
  }
  return {
    changed: rolledBack.changed,
    generation: rolledBack.generation,
    storyIds: passingIds,
  };
}

function readRunIdentity(orchestrator, runId, { requireActive = false } = {}) {
  const record = getRun(runId);
  const summary = record?.summary;
  if (summary?.runId !== runId || summary?.orchestrator !== orchestrator) {
    reject('run-not-found', 'run does not exist for the requested orchestrator');
  }
  if (requireActive) {
    const activeRunId = getActiveRunId(orchestrator);
    if (activeRunId !== runId || summary.status !== 'running') {
      reject('run-not-active', 'mutation requires the exact active running run');
    }
  }
  return summary;
}

function readPipeline(orchestrator, runId) {
  const pipeline = getPipelineState(runId, { cwd: process.cwd() });
  if (pipeline?.runId !== runId || pipeline?.orchestrator !== orchestrator) {
    reject('pipeline-unavailable', 'pipeline is missing, corrupt, or has the wrong identity');
  }
  return pipeline;
}

function pipelineStatus(orchestrator, runId, summary) {
  const pipeline = readPipeline(orchestrator, runId);
  const sequence = getPhaseSequence(orchestrator);
  const current = sequence.find(({ id }) => (
    !TERMINAL_PHASE_STATUSES.has(pipeline.phases?.[id]?.status)
  ));
  const currentPhaseStatus = current
    ? pipeline.phases?.[current.id]?.status ?? 'pending'
    : null;
  const complete = isComplete(runId, { cwd: process.cwd() });
  const loopStates = current && currentPhaseStatus === 'in_progress'
    ? Object.entries(LOOP_PHASES[orchestrator] || {})
      .filter(([, phaseId]) => phaseId === current.id)
      .map(([key]) => [key, inspectCurrentPhaseLoop(runId, key, { cwd: process.cwd() })])
    : [];
  const allowedLoops = loopStates
    .filter(([, state]) => state?.ok === true && state.canTick === true)
    .map(([key]) => key);
  const satisfiedLoops = loopStates
    .filter(([, state]) => state?.ok === true && state.satisfied === true)
    .map(([key]) => key);
  const exhaustedLoops = loopStates
    .filter(([, state]) => state?.ok === true
      && state.satisfied !== true
      && state.canTick !== true
      && state.count >= state.cap)
    .map(([key]) => key);
  const allCurrentLoopsSatisfied = loopStates.length > 0
    && loopStates.every(([, state]) => state?.ok === true && state.satisfied === true);
  const nextAction = summary.status === 'completed'
    ? 'done'
    : complete
      ? 'finalize'
      : currentPhaseStatus === 'in_progress'
        ? (allCurrentLoopsSatisfied
          ? 'complete'
          : exhaustedLoops.length > 0 ? 'terminal-fail'
          : allowedLoops.length > 0 ? 'tick-or-complete' : 'complete')
        : currentPhaseStatus === 'failed'
          ? 'recover'
          : 'enter';
  return {
    runStatus: summary.status,
    currentPhase: current?.id ?? null,
    currentPhaseStatus,
    nextAction,
    allowedSkips: current ? [...current.skippableWhen] : [],
    allowedLoops,
    satisfiedLoops,
    exhaustedLoops,
    completionOutputKeys: current
      ? [...(COMPLETION_OUTPUT_FIELDS[orchestrator]?.[current.id] || [])]
      : [],
    allowedReattemptReasons: Object.keys(REATTEMPT_POLICIES[orchestrator] || {}),
    allowedPolicyRewinds: Object.keys(POLICY_REWINDS[orchestrator] || {}),
    attempt: pipeline.attempt,
    complete,
    phases: Object.fromEntries(sequence.map(({ id }) => [
      id,
      pipeline.phases?.[id]?.status ?? 'pending',
    ])),
  };
}

function requireSafeResult(condition, code, message, result) {
  if (!condition || result?.degraded === true) {
    reject(code, message, result);
  }
  return result;
}

function currentPipelinePhase(orchestrator, pipeline) {
  return getPhaseSequence(orchestrator).find(({ id }) => (
    !TERMINAL_PHASE_STATUSES.has(pipeline.phases?.[id]?.status)
  ))?.id ?? null;
}

function requireAtlasEvidencePhase(orchestrator, pipeline, phase, mode = 'verification') {
  if (orchestrator !== 'atlas') {
    reject('evidence-orchestrator-denied', 'code-owned review evidence is Atlas-only');
  }
  const mapping = mode === 'approval'
    ? APPROVAL_PHASE_PIPELINE_PHASE
    : EVIDENCE_PHASE_PIPELINE_PHASE;
  const requiredPhase = typeof phase === 'string' && Object.hasOwn(mapping, phase)
    ? mapping[phase]
    : null;
  if (!requiredPhase) {
    reject('invalid-evidence-phase', 'evidence phase must be review or final-review');
  }
  requireCurrentInProgressPhase(orchestrator, pipeline, requiredPhase);
  return requiredPhase;
}

function requireGenerationId(value) {
  if (!VERIFICATION_GENERATION_ID.test(value || '')) {
    reject('invalid-verification-generation', 'verification generation id is invalid');
  }
  return value;
}

function requireGenerationForPipelinePhase(
  runId,
  generationId,
  evidencePhase,
  pipelinePhase,
) {
  const progress = getVerificationGenerationProgress(runId, generationId, {
    trustedRoot: process.cwd(),
  });
  const phaseStartedAt = Date.parse(pipelinePhase?.startedAt || '');
  const generationStartedAt = Date.parse(progress?.generation?.startedAt || '');
  if (progress?.ok !== true
    || progress.generation?.phase !== evidencePhase
    || !Number.isFinite(phaseStartedAt)
    || !Number.isFinite(generationStartedAt)
    || generationStartedAt < phaseStartedAt) {
    reject(
      'verification-generation-mismatch',
      'verification generation is stale or does not belong to the current phase attempt',
    );
  }
  return progress;
}

function requireReviewDigest(value) {
  if (!DIGEST.test(value || '')) {
    reject('invalid-review-digest', 'review digest must be a lowercase sha256 digest');
  }
  return value;
}

function parseEvidenceInput(rawInput, maxBytes, label) {
  if (typeof rawInput !== 'string'
    || rawInput.trim().length === 0
    || Buffer.byteLength(rawInput, 'utf8') > maxBytes) {
    reject('invalid-evidence-input', `${label} stdin is empty or exceeds its byte cap`);
  }
  try {
    const parsed = JSON.parse(rawInput);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      reject('invalid-evidence-input', `${label} stdin must be exactly one JSON object`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof RuntimeCommandError) throw error;
    reject('invalid-evidence-input', `${label} stdin must be exactly one JSON object`);
  }
}

function callEvidenceBoundary(code, operation) {
  try {
    return operation();
  } catch (error) {
    const message = typeof error?.message === 'string' && error.message.length <= 500
      ? error.message
      : 'code-owned review evidence validation failed';
    reject(code, message);
  }
}

function callTickBoundEvidenceBoundary(
  runId,
  phaseId,
  loopKey,
  evidenceCode,
  operation,
) {
  let evidenceError = null;
  const guarded = withCurrentPhaseLoopTick(
    runId,
    phaseId,
    loopKey,
    ({ _runLockOwner, pipeline }) => {
      try {
        return operation(_runLockOwner, pipeline);
      } catch (error) {
        evidenceError = error;
        throw error;
      }
    },
    { cwd: process.cwd() },
  );
  if (evidenceError) {
    callEvidenceBoundary(evidenceCode, () => { throw evidenceError; });
  }
  requireSafeResult(
    guarded?.ok === true,
    'phase-loop-tick-required',
    `${loopKey} must be ticked for the current ${phaseId} attempt before evidence approval`,
    guarded,
  );
  return guarded.result;
}

async function completeEvidencePhase(orchestrator, runId, pipeline, phaseId, digest) {
  requireAtlasEvidencePhase(
    orchestrator,
    pipeline,
    phaseId === 'review' ? 'review' : 'final-review',
    'approval',
  );
  let evidenceError = null;
  const result = await completePhase(runId, phaseId, undefined, {
    cwd: process.cwd(),
    _deriveOutputs: ({ _runLockOwner }) => {
      try {
        return phaseId === 'review'
          ? validateReviewPhaseCompletion(runId, digest, {
            cwd: process.cwd(),
            trustedRoot: process.cwd(),
            _runLockOwner,
            })
          : validateFinalizePhaseCompletion(runId, digest, {
              cwd: process.cwd(),
              trustedRoot: process.cwd(),
              _runLockOwner,
            });
      } catch (error) {
        evidenceError = error;
        throw error;
      }
    },
  });
  if (evidenceError) {
    callEvidenceBoundary('review-evidence-denied', () => { throw evidenceError; });
  }
  requireSafeResult(
    result?.ok === true && result?.checkpointDegraded !== true,
    'phase-completion-denied',
    `cannot complete ${phaseId}`,
    result,
  );
  return result;
}

async function completeVerificationPhase(orchestrator, runId, pipeline, generationId) {
  requireAtlasEvidencePhase(orchestrator, pipeline, 'review');
  requireGenerationForPipelinePhase(
    runId,
    generationId,
    'review',
    pipeline.phases.verify,
  );
  let evidenceError = null;
  const result = await completePhase(runId, 'verify', undefined, {
    cwd: process.cwd(),
    _deriveOutputs: ({ _runLockOwner, phaseStartedAt }) => {
      try {
        requireGenerationForPipelinePhase(
          runId,
          generationId,
          'review',
          { startedAt: phaseStartedAt },
        );
        const sealed = sealBoundVerification(runId, 'review', generationId, {
          cwd: process.cwd(),
          trustedRoot: process.cwd(),
          _runLockOwner,
        });
        return {
          verificationGenerationId: generationId,
          verificationReviewDigest: sealed.reviewDigest,
          verificationReviewTreeOid: sealed.reviewTreeOid,
        };
      } catch (error) {
        evidenceError = error;
        throw error;
      }
    },
  });
  if (evidenceError) {
    callEvidenceBoundary('verification-evidence-denied', () => { throw evidenceError; });
  }
  requireSafeResult(
    result?.ok === true && result?.checkpointDegraded !== true,
    'phase-completion-denied',
    'cannot complete verify',
    result,
  );
  return result;
}

function terminalFailureFor(code, phaseId) {
  // Own-property lookups only: `__proto__`/`constructor` must read as absent
  // from every argument-keyed allowlist instead of surfacing Object.prototype.
  const policy = typeof code === 'string' && Object.hasOwn(TERMINAL_FAILURE_CODES, code)
    ? TERMINAL_FAILURE_CODES[code]
    : null;
  if (!policy || !phaseId || (policy.phases && !policy.phases.has(phaseId))) {
    reject(
      'terminal-failure-not-allowed',
      'terminal failure code is not allowlisted for the current phase',
    );
  }
  return {
    failureClass: policy.failureClass,
    code,
    phase: phaseId,
  };
}

function terminalizeRun(orchestrator, runId, code, summary, pipeline) {
  let phaseId;
  if (summary.status === 'completed') {
    if (summary.result !== 'failure'
      || summary.failureCode !== code
      || typeof summary.failedPhase !== 'string') {
      reject(
        'terminal-failure-replay-mismatch',
        'completed run does not contain the same terminal failure tuple',
      );
    }
    phaseId = summary.failedPhase;
  } else {
    if (summary.status !== 'running' || getActiveRunId(orchestrator) !== runId) {
      reject('run-not-active', 'terminal failure requires the exact active run');
    }
    phaseId = currentPipelinePhase(orchestrator, pipeline);
    const status = phaseId ? pipeline.phases?.[phaseId]?.status : null;
    if (!['in_progress', 'failed'].includes(status)) {
      reject(
        'terminal-failure-phase-not-active',
        'terminal failure requires the current phase to be in progress or already failed',
      );
    }
  }
  const failure = terminalFailureFor(code, phaseId);
  let finalized;
  try {
    finalized = finalizeFailedRun(runId, { orchestrator, ...failure }, {
      cwd: process.cwd(),
      trustedRoot: process.cwd(),
    });
  } catch {
    reject(
      'terminal-failure-finalization-denied',
      'terminal failure evidence could not be durably finalized',
    );
  }
  if (finalized?.ok !== true) {
    reject(
      'terminal-failure-finalization-denied',
      'terminal failure evidence could not be durably finalized',
      finalized,
    );
  }
  return finalized;
}

/**
 * Execute one fixed runtime command. The caller is responsible only for JSON
 * rendering; errors are typed so the CLI can fail closed with a non-zero code.
 *
 * Syntax:
 *   status   <atlas|athena> [runId]
 *   enter    <atlas|athena> <runId> <phase>
 *   complete <atlas|athena> <runId> <phase> [allowlisted-key=value ...]
 *   skip     <atlas|athena> <runId> <phase> <allowlisted-reason>
 *   attempt  <atlas|athena> <runId>
 *   tick     <atlas|athena> <runId> <allowlisted-loop>
 *   record-error <atlas|athena> <runId> <allowlisted-phase> <safe-error-code>
 *   reattempt <atlas|athena> <runId> <allowlisted-reason>
 *   policy-rewind <atlas|athena> <runId> <allowlisted-reason>
 *   init-trivial-prd atlas <runId> <safe-scope> [safe-scope ...]
 *   story-pass atlas <runId> US-001
 *   verification-start atlas <runId> <review|final-review> [superseded-generation-id]
 *   verification-record atlas <runId> <review|final-review> <generation-id> < JSON
 *   verification-seal atlas <runId> <review|final-review> <generation-id>
 *   complete-verification atlas <runId> <generation-id>
 *   approve-review atlas <runId> <review|final-review> <generation-id> < JSON
 *   complete-review atlas <runId> <approved-review-digest>
 *   complete-finalize atlas <runId> <approved-final-review-digest>
 *   complete-ci atlas <runId>
 *   terminal-fail <atlas|athena> <runId> <allowlisted-code>
 *   finalize <atlas|athena> <runId>
 *
 * @param {string[]} argv
 * @param {string|undefined} rawInput Bounded JSON stdin for evidence commands.
 * @returns {Promise<object>}
 */
export async function executeRuntimeCommand(argv, rawInput = undefined) {
  if (!Array.isArray(argv)) reject('invalid-arguments', 'arguments must be an array');
  const [command, orchestratorValue, ...args] = argv;
  if (!COMMANDS.has(command)) {
    reject(
      'invalid-command',
      'command is not in the fixed orchestrator runtime allowlist',
    );
  }
  const orchestrator = requireOrchestrator(orchestratorValue);

  if (command === 'status') {
    requireArgumentCount(command, args, 0, 1);
    const runId = args[0]
      ? requireRunId(args[0])
      : getActiveRunId(orchestrator);
    if (!runId) reject('active-run-not-found', `no active ${orchestrator} run exists`);
    const summary = readRunIdentity(orchestrator, runId);
    return {
      ok: true,
      command,
      orchestrator,
      runId,
      ...pipelineStatus(orchestrator, runId, summary),
    };
  }

  const expectedAfterOrchestrator = {
    enter: 2,
    skip: 3,
    attempt: 1,
    tick: 2,
    'record-error': 3,
    reattempt: 2,
    'policy-rewind': 2,
    'story-pass': 2,
    'verification-record': 3,
    'verification-seal': 3,
    'complete-verification': 2,
    'approve-review': 3,
    'complete-review': 2,
    'complete-finalize': 2,
    'complete-ci': 1,
    'terminal-fail': 2,
    finalize: 1,
  }[command];
  if (command === 'complete') requireArgumentCount(command, args, 2, 18);
  else if (command === 'init-trivial-prd') requireArgumentCount(command, args, 2, 33);
  else if (command === 'verification-start') requireArgumentCount(command, args, 2, 3);
  else requireArgumentCount(command, args, expectedAfterOrchestrator);
  const runId = requireRunId(args[0]);
  const summary = readRunIdentity(orchestrator, runId);
  const pipeline = readPipeline(orchestrator, runId);
  if (ACTIVE_EVIDENCE_COMMANDS.has(command)) {
    readRunIdentity(orchestrator, runId, { requireActive: true });
  }

  if (command === 'verification-start') {
    const phase = args[1];
    requireAtlasEvidencePhase(orchestrator, pipeline, phase);
    const start = _runLockOwner => startBoundVerification(runId, phase, {
      cwd: process.cwd(),
      trustedRoot: process.cwd(),
      ...(_runLockOwner ? { _runLockOwner } : {}),
      ...(args[2] ? { supersedeGenerationId: requireGenerationId(args[2]) } : {}),
    });
    const result = phase === 'final-review'
      ? callTickBoundEvidenceBoundary(
        runId,
        'finalize',
        'final-review',
        'verification-evidence-denied',
        start,
      )
      : callEvidenceBoundary('verification-evidence-denied', () => start());
    return { ok: true, command, orchestrator, runId, result };
  }

  if (command === 'verification-record') {
    const phase = args[1];
    requireAtlasEvidencePhase(orchestrator, pipeline, phase);
    const generationId = requireGenerationId(args[2]);
    const record = parseEvidenceInput(
      rawInput,
      MAX_VERIFICATION_INPUT_BYTES,
      'verification record',
    );
    const persist = _runLockOwner => {
      const progress = getVerificationGenerationProgress(runId, generationId, {
        trustedRoot: process.cwd(),
        ...(_runLockOwner ? { _runLockOwner } : {}),
      });
      if (progress?.ok !== true || progress.generation?.phase !== phase) {
        reject(
          'verification-generation-mismatch',
          'verification generation does not belong to the requested evidence phase',
        );
      }
      return recordBoundVerification(runId, generationId, record, {
        cwd: process.cwd(),
        trustedRoot: process.cwd(),
        ...(_runLockOwner ? { _runLockOwner } : {}),
      });
    };
    const result = phase === 'final-review'
      ? callTickBoundEvidenceBoundary(
        runId,
        'finalize',
        'final-review',
        'verification-evidence-denied',
        persist,
      )
      : callEvidenceBoundary('verification-evidence-denied', () => persist());
    return { ok: true, command, orchestrator, runId, result };
  }

  if (command === 'verification-seal') {
    const phase = args[1];
    requireAtlasEvidencePhase(orchestrator, pipeline, phase);
    const generationId = requireGenerationId(args[2]);
    const seal = _runLockOwner => sealBoundVerification(runId, phase, generationId, {
      cwd: process.cwd(),
      trustedRoot: process.cwd(),
      ...(_runLockOwner ? { _runLockOwner } : {}),
    });
    const result = phase === 'final-review'
      ? callTickBoundEvidenceBoundary(
        runId,
        'finalize',
        'final-review',
        'verification-evidence-denied',
        seal,
      )
      : callEvidenceBoundary('verification-evidence-denied', () => seal());
    return { ok: true, command, orchestrator, runId, result };
  }

  if (command === 'complete-verification') {
    const generationId = requireGenerationId(args[1]);
    const result = await completeVerificationPhase(
      orchestrator,
      runId,
      pipeline,
      generationId,
    );
    return { ok: true, command, orchestrator, runId, result };
  }

  if (command === 'approve-review') {
    const phase = args[1];
    requireAtlasEvidencePhase(orchestrator, pipeline, phase, 'approval');
    const generationId = requireGenerationId(args[2]);
    const payload = parseEvidenceInput(rawInput, MAX_REVIEW_INPUT_BYTES, 'review results');
    const phaseId = phase === 'review' ? 'review' : 'finalize';
    const result = callTickBoundEvidenceBoundary(
      runId,
      phaseId,
      phase,
      'review-evidence-denied',
      (_runLockOwner, lockedPipeline) => {
        const ownerPhase = phase === 'review' ? 'verify' : 'finalize';
        const generationProgress = requireGenerationForPipelinePhase(
          runId,
          generationId,
          phase,
          lockedPipeline.phases[ownerPhase],
        );
        if (phase === 'review'
          && lockedPipeline.phases.verify?.outputs?.verificationGenerationId !== generationId) {
          reject(
            'verification-generation-mismatch',
            'review approval must use the generation that completed the current verify attempt',
          );
        }
        if (generationProgress.generation.status !== 'sealed') {
          reject('verification-generation-unsealed', 'review approval requires sealed verification');
        }
        return approveBoundReview(runId, phase, generationId, payload, {
          cwd: process.cwd(),
          trustedRoot: process.cwd(),
          _runLockOwner,
        });
      },
    );
    return { ok: true, command, orchestrator, runId, result };
  }

  if (command === 'complete-review' || command === 'complete-finalize') {
    const phaseId = command === 'complete-review' ? 'review' : 'finalize';
    const digest = requireReviewDigest(args[1]);
    const result = await completeEvidencePhase(
      orchestrator,
      runId,
      pipeline,
      phaseId,
      digest,
    );
    return { ok: true, command, orchestrator, runId, result };
  }

  if (command === 'complete-ci') {
    if (orchestrator !== 'atlas') {
      reject('ci-orchestrator-denied', 'complete-ci is Atlas-only');
    }
    requireCurrentInProgressPhase(orchestrator, pipeline, 'ci');
    const result = await completeAtlasCiPhase(runId, pipeline);
    return { ok: true, command, orchestrator, runId, result };
  }

  if (command === 'terminal-fail') {
    const result = terminalizeRun(orchestrator, runId, args[1], summary, pipeline);
    return { ok: true, command, orchestrator, runId, result };
  }

  if (command === 'finalize') {
    let result;
    if (summary.status === 'completed' && summary.result === 'failure') {
      result = terminalizeRun(
        orchestrator,
        runId,
        summary.failureCode,
        summary,
        pipeline,
      );
    } else {
      if (summary.status === 'running' && getActiveRunId(orchestrator) !== runId) {
        reject('run-not-active', 'finalization requires the exact active running run');
      }
      result = finalizeCompletedPipeline(runId, {
        cwd: process.cwd(),
        ...(orchestrator === 'atlas'
          ? {
              _validateCompletion: ({ finalizeOutputs, _runLockOwner }) => {
                const digest = finalizeOutputs?.finalReviewDigest;
                if (!DIGEST.test(digest || '')) {
                  throw new Error('stored final review digest is unavailable');
                }
                const current = validateFinalizePhaseCompletion(runId, digest, {
                  cwd: process.cwd(),
                  trustedRoot: process.cwd(),
                  _runLockOwner,
                });
                if (current.finalReviewDigest !== finalizeOutputs.finalReviewDigest
                  || current.finalReviewTreeOid !== finalizeOutputs.finalReviewTreeOid
                  || current.finalCommit !== finalizeOutputs.finalCommit) {
                  throw new Error('stored final approval no longer matches current HEAD');
                }
                return true;
              },
            }
          : {}),
      });
      requireSafeResult(
        result?.ok === true,
        result?.reason === 'pipeline-incomplete' ? 'pipeline-incomplete' : 'run-finalization-denied',
        result?.reason === 'pipeline-incomplete'
          ? 'all required phases must be terminal before finalization'
          : 'run finalization failed',
        result,
      );
    }
    return { ok: true, command, orchestrator, runId, result };
  }

  readRunIdentity(orchestrator, runId, { requireActive: true });

  let result;
  if (command === 'enter') {
    const phaseId = args[1];
    phaseDescriptor(orchestrator, phaseId);
    let entryBoundaryError = null;
    const validateAtlasEntry = orchestrator === 'atlas'
      && ['ship', 'ci'].includes(phaseId)
      ? ({ pipeline: lockedPipeline }) => {
          try {
            if (phaseId === 'ship') {
              requireAtlasShipAuthorization(runId, { pipeline: lockedPipeline });
            } else {
              validateAtlasCiTarget(runId, lockedPipeline);
            }
          } catch (error) {
            entryBoundaryError = error;
            throw error;
          }
        }
      : null;
    result = enterPhase(runId, phaseId, {
      cwd: process.cwd(),
      ...(validateAtlasEntry ? { _validateEntry: validateAtlasEntry } : {}),
    });
    if (entryBoundaryError) throw entryBoundaryError;
    requireSafeResult(
      result?.proceed === true || result?.skip === true,
      'phase-entry-denied',
      `cannot enter ${phaseId}`,
      result,
    );
  } else if (command === 'complete') {
    const phaseId = args[1];
    phaseDescriptor(orchestrator, phaseId);
    requireCurrentInProgressPhase(orchestrator, pipeline, phaseId);
    if (orchestrator === 'atlas' && ['verify', 'review', 'finalize', 'ci'].includes(phaseId)) {
      reject(
        'evidence-completion-required',
        `${phaseId} must use its code-owned evidence completion command`,
      );
    }
    const outputs = parseCompletionOutputs(orchestrator, phaseId, args.slice(2));
    const reviewBasePin = pinTriageReviewBase(
      orchestrator,
      runId,
      phaseId,
      outputs,
    );
    if (orchestrator === 'atlas' && phaseId === 'ship') {
      const checkpointData = { runId };
      let shipBoundaryError = null;
      result = await completePhase(runId, phaseId, undefined, {
        cwd: process.cwd(),
        checkpointData,
        _deriveOutputs: () => {
          try {
            const currentPipeline = readPipeline('atlas', runId);
            const authoritative = validateAtlasShipCompletion(runId, outputs, {
              pipeline: currentPipeline,
            });
            Object.assign(checkpointData, authoritative);
            return authoritative;
          } catch (error) {
            shipBoundaryError = error;
            throw error;
          }
        },
      });
      if (shipBoundaryError) throw shipBoundaryError;
    } else {
      const checkpointData = completionCheckpoint(
        orchestrator,
        runId,
        phaseId,
        outputs,
        pipeline,
      );
      result = await completePhase(runId, phaseId, outputs, {
        cwd: process.cwd(),
        ...(checkpointData ? { checkpointData } : {}),
      });
    }
    requireSafeResult(
      result?.ok === true && result?.checkpointDegraded !== true,
      'phase-completion-denied',
      `cannot complete ${phaseId}`,
      result,
    );
    if (reviewBasePin) result = { ...result, reviewBasePin };
  } else if (command === 'skip') {
    const phaseId = args[1];
    const reason = args[2];
    const descriptor = phaseDescriptor(orchestrator, phaseId);
    if (!descriptor.skippableWhen.includes(reason)) {
      reject('invalid-skip-reason', `skip reason is not allowed for ${phaseId}`);
    }
    let skipBoundaryError = null;
    const validateAtlasSkip = orchestrator === 'atlas' && ['ship', 'ci'].includes(phaseId)
      ? ({ pipeline: lockedPipeline }) => {
          try {
            if (phaseId === 'ship') validateAtlasShipSkip(runId, reason);
            else validateAtlasCiSkip(runId, reason, lockedPipeline);
          } catch (error) {
            skipBoundaryError = error;
            throw error;
          }
        }
      : null;
    result = skipPhase(runId, phaseId, reason, {
      cwd: process.cwd(),
      ...(validateAtlasSkip ? { _validateSkip: validateAtlasSkip } : {}),
    });
    if (skipBoundaryError) throw skipBoundaryError;
    requireSafeResult(
      result?.ok === true,
      'phase-skip-denied',
      `cannot skip ${phaseId}`,
      result,
    );
  } else if (command === 'attempt') {
    result = beginAttempt(runId, { cwd: process.cwd() });
    requireSafeResult(
      result?.allowed === true,
      'attempt-denied',
      'attempt counter cannot advance in the current phase',
      result,
    );
  } else if (command === 'tick') {
    const loop = requireLoopKey(orchestrator, args[1]);
    result = loopTick(runId, loop, { cwd: process.cwd() });
    requireSafeResult(
      result?.allowed === true,
      'loop-denied',
      `loop ${loop} cannot advance in the current phase`,
      result,
    );
  } else if (command === 'record-error') {
    const phaseId = args[1];
    phaseDescriptor(orchestrator, phaseId);
    if (!ERROR_PHASES[orchestrator]?.has(phaseId)) {
      reject('error-phase-not-allowed', `error signatures are not accepted for ${phaseId}`);
    }
    const currentStatus = pipeline.phases?.[phaseId]?.status;
    const currentPhase = getPhaseSequence(orchestrator).find(({ id }) => (
      !TERMINAL_PHASE_STATUSES.has(pipeline.phases?.[id]?.status)
    ))?.id;
    if (currentPhase !== phaseId || currentStatus !== 'in_progress') {
      reject('error-phase-not-active', `${phaseId} must be the in-progress phase`);
    }
    const errorCode = args[2];
    if (!SAFE_ERROR_CODE.test(errorCode)) {
      reject('invalid-error-code', 'error code must use the bounded safe token format');
    }
    result = recordPhaseError(runId, phaseId, errorCode, { cwd: process.cwd() });
    requireSafeResult(
      result && result.degraded !== true,
      'error-record-denied',
      'phase error signature could not be recorded',
      result,
    );
  } else if (command === 'reattempt') {
    const reason = args[1];
    const reopen = typeof reason === 'string'
      && Object.hasOwn(REATTEMPT_POLICIES[orchestrator], reason)
      ? REATTEMPT_POLICIES[orchestrator][reason]
      : null;
    if (!reopen) {
      reject('invalid-reattempt-reason', `reattempt reason is not allowed for ${orchestrator}`);
    }
    let prdRollback = null;
    result = reattempt(runId, { reopen: [...reopen], reason }, {
      cwd: process.cwd(),
      ...(reopen.includes('execute')
        ? {
            _beforeRewind: () => {
              prdRollback = rollbackPassingExecutionStories(orchestrator);
            },
          }
        : {}),
    });
    requireSafeResult(
      result?.allowed === true
        && reopen.every(phaseId => result.reopened?.includes(phaseId)),
      'reattempt-denied',
      `reattempt ${reason} could not reopen its fixed phase set`,
      result,
    );
    result = { ...result, ...(prdRollback ? { prdRollback } : {}) };
  } else if (command === 'policy-rewind') {
    const reason = args[1];
    const policy = typeof reason === 'string'
      && Object.hasOwn(POLICY_REWINDS[orchestrator], reason)
      ? POLICY_REWINDS[orchestrator][reason]
      : null;
    if (!policy) {
      reject('invalid-rewind-policy', `policy rewind ${reason} is not allowlisted`);
    }
    const budget = registerEscalation(runId, policy.counter, {
      cwd: process.cwd(),
      cap: policy.cap,
    });
    if (budget.allowed !== true) {
      reject('policy-rewind-cap-reached', `${reason} exhausted its fixed rewind cap`, budget);
    }
    result = reopenPhase(runId, policy.phaseId, { reason }, { cwd: process.cwd() });
    requireSafeResult(
      result?.ok === true && result?.rejected !== true,
      'phase-reopen-denied',
      `${policy.phaseId} could not be reopened for ${reason}`,
      { ...result, budget },
    );
    result = { ...result, budget, reopened: [policy.phaseId] };
  } else if (command === 'init-trivial-prd') {
    if (orchestrator !== 'atlas') {
      reject('trivial-prd-orchestrator-denied', 'init-trivial-prd is Atlas-only');
    }
    const currentPhase = getPhaseSequence(orchestrator).find(({ id }) => (
      !TERMINAL_PHASE_STATUSES.has(pipeline.phases?.[id]?.status)
    ))?.id;
    if (!['context', 'spec', 'plan', 'execute'].includes(currentPhase)) {
      reject('trivial-prd-phase-denied', 'trivial PRD initialization is only allowed before execute completes');
    }
    result = initializeTrivialPrd(runId, requireSafeScopes(args.slice(1)));
  } else if (command === 'story-pass') {
    if (orchestrator !== 'atlas') {
      reject('trivial-story-orchestrator-denied', 'story-pass is Atlas-only');
    }
    const currentPhase = getPhaseSequence(orchestrator).find(({ id }) => (
      !TERMINAL_PHASE_STATUSES.has(pipeline.phases?.[id]?.status)
    ))?.id;
    if (currentPhase !== 'execute' || pipeline.phases?.execute?.status !== 'in_progress') {
      reject('story-pass-phase-denied', 'story-pass requires the in-progress execute phase');
    }
    result = passTrivialStory(runId, args[1]);
  }

  return {
    ok: true,
    command,
    orchestrator,
    runId,
    result,
  };
}

function renderFailure(error) {
  if (error instanceof RuntimeCommandError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.detail === undefined ? {} : { detail: error.detail }),
      },
    };
  }
  return {
    ok: false,
    error: {
      code: 'runtime-failure',
      message: 'orchestrator runtime failed closed',
    },
  };
}

function readBoundedStdin(maxBytes, timeoutMs = 5000) {
  return new Promise((resolveInput, rejectInput) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onError);
      operation(value);
    };
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        process.stdin.pause();
        finish(
          rejectInput,
          new RuntimeCommandError('evidence-input-too-large', 'evidence stdin exceeds its byte cap'),
        );
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => finish(resolveInput, Buffer.concat(chunks).toString('utf8'));
    const onError = () => finish(
      rejectInput,
      new RuntimeCommandError('evidence-input-unavailable', 'evidence stdin could not be read'),
    );
    const timer = setTimeout(() => finish(
      rejectInput,
      new RuntimeCommandError('evidence-input-timeout', 'evidence stdin did not finish in time'),
    ), timeoutMs);
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
    if (process.stdin.readableEnded) onEnd();
  });
}

export async function main(argv = process.argv.slice(2), rawInputOverride = undefined) {
  try {
    let rawInput = rawInputOverride;
    if (rawInput === undefined && argv[0] === 'verification-record') {
      rawInput = await readBoundedStdin(MAX_VERIFICATION_INPUT_BYTES);
    } else if (rawInput === undefined && argv[0] === 'approve-review') {
      rawInput = await readBoundedStdin(MAX_REVIEW_INPUT_BYTES);
    }
    const output = await executeRuntimeCommand(argv, rawInput);
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return 0;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(renderFailure(error))}\n`);
    return 2;
  }
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  process.exitCode = await main();
}
