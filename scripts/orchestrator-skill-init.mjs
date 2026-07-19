#!/usr/bin/env node

/**
 * Bootstrap for direct Atlas slash expansion and Skill-tool delegation.
 *
 * The hook adopts the eval harness' preallocated Atlas run when present, or
 * creates exactly one active run otherwise. `command_args` is treated only as
 * opaque user data: it is never passed to a shell or interpolated into a
 * command string.
 */

import { lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { readStdin } from './lib/stdin.mjs';
import {
  appendUserTaskUpdate,
  bindRunFinalizationPointer,
  createRun,
  getActiveRunId,
  getRun,
  getUserTaskUpdates,
} from './lib/run-artifacts.mjs';
import {
  ensureSafeDirectoryPath,
  readRegularArtifact,
  revalidateDirectoryBinding,
} from './lib/hardened-fs.mjs';
import {
  acquireRunFinalizationLock,
  releaseRunFinalizationLock,
} from './lib/run-finalization-lock.mjs';
import { getReviewWorktreeState } from './lib/review-package.mjs';
import {
  getPipelineState,
  initPipeline,
  isComplete,
} from './lib/phase-runner.mjs';

const ATLAS_COMMAND_NAMES = new Set(['atlas', 'agent-olympus:atlas']);
const ORCHESTRATORS = Object.freeze(['atlas', 'athena']);
const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_POINTER_BYTES = 64 * 1024;
const RUNTIME = '"${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator-runtime.mjs"';

function noOutput() {
  return {};
}

function blocked(reason, hookEventName = 'UserPromptExpansion') {
  const message = `Atlas executable bootstrap failed closed: ${reason}`;
  if (hookEventName === 'PreToolUse') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: message,
      },
    };
  }
  return {
    decision: 'block',
    reason: message,
  };
}

function atlasInvocation(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const expansionEvent = data.hook_event_name === undefined
    || data.hook_event_name === 'UserPromptExpansion';
  if (expansionEvent && ATLAS_COMMAND_NAMES.has(data.command_name)) {
    if (data.expansion_type !== undefined && data.expansion_type !== 'slash_command') return null;
    if (data.command_source !== undefined && data.command_source !== 'plugin') return null;
    return {
      hookEventName: 'UserPromptExpansion',
      requestValue: data.command_args,
      requestField: 'command_args',
    };
  }

  if (data.hook_event_name === 'PreToolUse'
    && data.tool_name === 'Skill'
    && data.tool_input
    && typeof data.tool_input === 'object'
    && !Array.isArray(data.tool_input)
    && data.tool_input.skill === 'agent-olympus:atlas') {
    return {
      hookEventName: 'PreToolUse',
      requestValue: data.tool_input.args,
      requestField: 'tool_input.args',
    };
  }
  return null;
}

function normalizeRequest(value) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, request: null };
  }
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, request: null };
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_REQUEST_BYTES) {
    return { ok: false, request: null };
  }
  return { ok: true, request: value };
}

function admissionContext(opts = {}) {
  const cwd = resolve(opts.cwd || process.cwd());
  return {
    cwd,
    base: resolve(opts.base || join(cwd, '.ao', 'artifacts', 'runs')),
    stateDir: resolve(opts.stateDir || join(cwd, '.ao', 'state')),
    trustedRoot: resolve(opts.trustedRoot || cwd),
  };
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? timestamp
    : null;
}

function pointerPath(context, orchestrator) {
  return join(context.stateDir, `ao-active-run-${orchestrator}.json`);
}

function pipelinePath(context, runId) {
  return join(context.base, runId, 'pipeline.json');
}

function artifactPresent(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function inspectActivePointer(orchestrator, context, stateBinding) {
  const artifact = readRegularArtifact(
    pointerPath(context, orchestrator),
    `${orchestrator} active-run pointer`,
    MAX_POINTER_BYTES,
    {
      allowMissing: true,
      revalidateContext: () => revalidateDirectoryBinding(
        stateBinding,
        'orchestrator admission state directory',
      ),
    },
  );
  if (!artifact.present) return { status: 'absent', runId: null };

  let pointer;
  try { pointer = JSON.parse(artifact.text); }
  catch { return { status: 'invalid', runId: null, reason: 'invalid-json' }; }
  const fields = ['runId', 'orchestrator', 'startedAt'];
  const startedAt = canonicalTimestamp(pointer?.startedAt);
  if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer)
    || Object.keys(pointer).length !== fields.length
    || fields.some(field => !Object.hasOwn(pointer, field))
    || pointer.orchestrator !== orchestrator
    || !RUN_ID_PATTERN.test(pointer.runId || '')
    || !pointer.runId.startsWith(`${orchestrator}-`)
    || startedAt === null
    || startedAt > Date.now() + 60_000) {
    return { status: 'invalid', runId: null, reason: 'identity-mismatch' };
  }

  const activeRunId = getActiveRunId(orchestrator, {
    stateDir: context.stateDir,
    trustedRoot: context.trustedRoot,
  });
  if (activeRunId !== pointer.runId) {
    return { status: 'invalid', runId: null, reason: 'reader-mismatch' };
  }
  const record = getRun(pointer.runId, {
    base: context.base,
    trustedRoot: context.trustedRoot,
  });
  if (record.summary?.runId !== pointer.runId
    || record.summary?.orchestrator !== orchestrator
    || record.summary?.startedAt !== pointer.startedAt
    || typeof record.summary?.task !== 'string'
    || !record.summary.task.trim()
    || record.summary?.status !== 'running') {
    return { status: 'stale', runId: pointer.runId, reason: 'run-identity-mismatch' };
  }

  const hasPipeline = artifactPresent(pipelinePath(context, pointer.runId));
  if (hasPipeline) {
    const pipeline = getPipelineState(pointer.runId, {
      cwd: context.cwd,
      base: context.base,
      trustedRoot: context.trustedRoot,
    });
    if (pipeline?.runId !== pointer.runId || pipeline?.orchestrator !== orchestrator) {
      return { status: 'invalid', runId: pointer.runId, reason: 'pipeline-identity-mismatch' };
    }
  }

  let pointerGuard;
  try {
    pointerGuard = bindRunFinalizationPointer(pointer.runId, orchestrator, {
      stateDir: context.stateDir,
      trustedRoot: context.trustedRoot,
    });
    pointerGuard.revalidate({ required: true });
  } catch {
    return { status: 'invalid', runId: pointer.runId, reason: 'pointer-generation-mismatch' };
  }
  return {
    status: 'active',
    runId: pointer.runId,
    pipelineInitialized: hasPipeline,
    pointerGuard,
  };
}

/**
 * Atomically admit one project-global orchestrator run.
 *
 * Atlas and Athena share the root worktree and `.ao/prd.json`, so their
 * independent active-run pointers are serialized by one crash-reclaimable
 * admission lock. An exact same-orchestrator pointer may be adopted; any
 * opposite, malformed, stale, or unexpectedly replaced pointer fails closed.
 *
 * Passing `expectedRunId` (including explicit null) fences a prior preflight:
 * a caller may resume only the pointer it observed, while null proves that no
 * same-orchestrator run appeared before the claim.
 */
export function admitOrchestratorRun(orchestrator, request, opts = {}) {
  if (!ORCHESTRATORS.includes(orchestrator)) {
    return { ok: false, reason: 'invalid-orchestrator' };
  }
  const context = admissionContext(opts);
  let stateBinding;
  let lockOwner;
  let result;
  try {
    stateBinding = ensureSafeDirectoryPath(
      context.stateDir,
      'orchestrator admission state directory',
      { trustedRoot: context.trustedRoot, requirePrivateMode: true },
    );
    lockOwner = acquireRunFinalizationLock(context.stateDir);
    revalidateDirectoryBinding(stateBinding, 'orchestrator admission state directory');

    const own = inspectActivePointer(orchestrator, context, stateBinding);
    const otherOrchestrator = orchestrator === 'atlas' ? 'athena' : 'atlas';
    const other = inspectActivePointer(otherOrchestrator, context, stateBinding);
    if (other.status !== 'absent') {
      result = {
        ok: false,
        reason: other.status === 'active'
          ? `other-orchestrator-active:${otherOrchestrator}:${other.runId}`
          : `other-orchestrator-pointer-${other.status}:${otherOrchestrator}`,
      };
    } else if (!['absent', 'active'].includes(own.status)) {
      result = { ok: false, reason: `own-pointer-${own.status}:${orchestrator}` };
    } else if (Object.hasOwn(opts, 'expectedRunId')
      && own.runId !== opts.expectedRunId) {
      result = { ok: false, reason: 'same-orchestrator-pointer-changed' };
    } else if (own.status === 'active') {
      result = {
        ok: true,
        runId: own.runId,
        created: false,
        pipelineInitialized: own.pipelineInitialized,
        pointerGuard: own.pointerGuard,
      };
    } else if (opts.createIfMissing === false) {
      result = {
        ok: true,
        runId: null,
        created: false,
        pipelineInitialized: false,
        pointerGuard: null,
      };
    } else {
      let recovery = null;
      if (typeof opts.recoverMissing === 'function') {
        recovery = opts.recoverMissing();
        if (recovery !== null && recovery !== undefined
          && (!recovery || typeof recovery !== 'object' || Array.isArray(recovery))) {
          result = { ok: false, reason: 'invalid-orchestrator-recovery-result' };
        } else if (recovery?.ok === true) {
          const recovered = inspectActivePointer(orchestrator, context, stateBinding);
          const postRecoveryOther = inspectActivePointer(
            otherOrchestrator,
            context,
            stateBinding,
          );
          if (recovered.status !== 'active' || recovered.runId !== recovery.runId) {
            result = { ok: false, reason: 'recovered-run-pointer-mismatch' };
          } else if (postRecoveryOther.status !== 'absent') {
            result = {
              ok: false,
              reason: `post-recovery-cross-orchestrator-conflict:${otherOrchestrator}`,
            };
          } else {
            result = {
              ok: true,
              runId: recovered.runId,
              created: false,
              recovered: true,
              pipelineInitialized: recovered.pipelineInitialized,
              pointerGuard: recovered.pointerGuard,
            };
          }
        } else if (recovery && recovery.canCreateNewRun !== true) {
          result = {
            ok: false,
            reason: `orchestrator-recovery-conflict:${recovery.reason || 'unproven-recovery'}`,
          };
        }
      }

      if (!result && (typeof request !== 'string' || !request.trim())) {
        result = { ok: false, reason: 'fresh-run-request-required' };
      }
      if (!result) {
        const created = createRun(orchestrator, request, {
          base: context.base,
          stateDir: context.stateDir,
          trustedRoot: context.trustedRoot,
        });
        if (!created.ok || !created.runId) {
          result = { ok: false, reason: created.reason || 'run-creation-failed' };
        } else {
          const claimed = inspectActivePointer(orchestrator, context, stateBinding);
          const postClaimOther = inspectActivePointer(otherOrchestrator, context, stateBinding);
          if (claimed.status !== 'active' || claimed.runId !== created.runId) {
            result = { ok: false, reason: 'created-run-pointer-mismatch' };
          } else if (postClaimOther.status !== 'absent') {
            result = { ok: false, reason: `post-claim-cross-orchestrator-conflict:${otherOrchestrator}` };
          } else {
            result = {
              ok: true,
              runId: created.runId,
              created: true,
              recovered: false,
              pipelineInitialized: false,
              pointerGuard: claimed.pointerGuard,
            };
          }
        }
      }
    }
    revalidateDirectoryBinding(stateBinding, 'orchestrator admission state directory');
  } catch (error) {
    result = {
      ok: false,
      reason: error?.message === 'run finalization is already in progress'
        ? 'orchestrator-admission-lock-busy'
        : (error?.message || 'orchestrator-admission-failed'),
    };
  }

  if (lockOwner && !releaseRunFinalizationLock(context.stateDir, lockOwner)) {
    return { ok: false, reason: 'orchestrator-admission-lock-release-failed' };
  }
  return result || { ok: false, reason: 'orchestrator-admission-failed' };
}

function runtimeContext(runId, currentPhase, created, appended, hookEventName) {
  return `[ATLAS EXECUTABLE CONTROL — MANDATORY]
The ${hookEventName} hook ${created ? 'created' : 'adopted'} exactly one Atlas run${appended ? ' and durably appended this invocation\'s request argument as user data' : ' without appending an empty resume argument'}.
runId: ${runId}
current phase: ${currentPhase}
Do not create another run and do not repeat the task-update append. Use only the fixed runtime CLI for ordinary phase transitions (cwd is the current project):
${RUNTIME} status atlas ${runId}
${RUNTIME} enter atlas ${runId} <phase>
${RUNTIME} complete atlas ${runId} <phase> [allowlisted-key=value ...]
${RUNTIME} skip atlas ${runId} <phase> <allowlisted-reason>
${RUNTIME} attempt atlas ${runId}
${RUNTIME} tick atlas ${runId} <allowlisted-loop>
${RUNTIME} record-error atlas ${runId} verify <safe-error-code>
${RUNTIME} reattempt atlas ${runId} <quality_fail|review_reject|final_review_reject|light_mode_reexec>
${RUNTIME} policy-rewind atlas ${runId} light_mode_rewind
${RUNTIME} init-trivial-prd atlas ${runId} <safe-repo-relative-scope> [scope ...]
${RUNTIME} story-pass atlas ${runId} US-001
${RUNTIME} finalize atlas ${runId}
For a trivial run, init-trivial-prd creates the fixed one-story passes:false PRD through the hardened spec/store APIs; call story-pass only after execution checks pass. Plan/execute completion then loads the fixed hardened .ao/prd.json itself. No storage path or arbitrary JSON input is accepted.
Every command emits JSON. A non-zero exit or {"ok":false} is a hard stop; preserve the run artifacts and report the failure.`;
}

/**
 * Handle a parsed UserPromptExpansion or PreToolUse:Skill payload.
 *
 * @param {unknown} data
 * @returns {object}
 */
export function handleAtlasExpansion(data) {
  const invocation = atlasInvocation(data);
  if (!invocation) return noOutput();

  const normalized = normalizeRequest(invocation.requestValue);
  if (!normalized.ok) {
    return blocked(
      `${invocation.requestField} must be empty or a non-empty string of at most 64 KiB`,
      invocation.hookEventName,
    );
  }
  const request = normalized.request;

  const initialAdmission = admitOrchestratorRun('atlas', request, {
    cwd: process.cwd(),
    createIfMissing: false,
  });
  if (!initialAdmission.ok) {
    return blocked(
      `orchestrator admission was denied (${initialAdmission.reason})`,
      invocation.hookEventName,
    );
  }
  const activeRunId = initialAdmission.runId;
  if (!activeRunId && request === null) {
    return blocked(
      'a fresh Atlas run requires a non-empty request argument',
      invocation.hookEventName,
    );
  }
  const resumingInitializedRun = initialAdmission.pipelineInitialized === true;
  if (!resumingInitializedRun) {
    let state;
    try {
      state = getReviewWorktreeState({ cwd: process.cwd() });
    } catch (error) {
      return blocked(
        `a fresh Atlas run requires a clean Git worktree with a real HEAD (${error?.code || 'Git precondition failed'})`,
        invocation.hookEventName,
      );
    }
    if (state.dirty) {
      const detail = state.paths.slice(0, 8).join(', ');
      return blocked(
        `a fresh Atlas run refuses pre-existing user changes; commit or stash first (${detail}${state.paths.length > 8 ? ', …' : ''})`,
        invocation.hookEventName,
      );
    }
  }
  const admission = admitOrchestratorRun('atlas', request, {
    cwd: process.cwd(),
    expectedRunId: activeRunId,
  });
  if (!admission.ok || !admission.runId || !admission.pointerGuard) {
    return blocked(
      `orchestrator admission was not durably claimed (${admission.reason || 'missing pointer guard'})`,
      invocation.hookEventName,
    );
  }
  const runId = admission.runId;

  let appended = false;
  if (request !== null) {
    const update = appendUserTaskUpdate(runId, request, {
      allowCreate: admission.created === true,
    });
    if (update.ok !== true || update.updates?.at(-1)?.task !== request) {
      return blocked(
        update.reason || 'current request was not durably appended',
        invocation.hookEventName,
      );
    }
    appended = true;
  } else {
    const updates = getUserTaskUpdates(runId);
    if (updates.ok !== true || updates.updates.length < 1) {
      return blocked(
        updates.reason || 'no-argument resume requires an existing durable task ledger',
        invocation.hookEventName,
      );
    }
  }

  try {
    admission.pointerGuard.revalidate({ required: true });
  } catch {
    return blocked('active-run pointer changed after task admission', invocation.hookEventName);
  }

  const pipeline = initPipeline(runId, 'atlas', { cwd: process.cwd() });
  if (pipeline.ok !== true || pipeline.degraded === true) {
    return blocked('pipeline initialization or adoption failed', invocation.hookEventName);
  }
  try {
    admission.pointerGuard.revalidate({ required: true });
  } catch {
    return blocked('active-run pointer changed during pipeline admission', invocation.hookEventName);
  }
  const currentPhase = pipeline.resumePhase
    ?? (isComplete(runId, { cwd: process.cwd() }) ? 'finalize-run' : 'unavailable');

  return {
    hookSpecificOutput: {
      hookEventName: invocation.hookEventName,
      additionalContext: runtimeContext(
        runId,
        currentPhase,
        admission.created === true,
        appended,
        invocation.hookEventName,
      ),
    },
  };
}

export const handleAtlasInvocation = handleAtlasExpansion;

export async function main() {
  if (process.env.DISABLE_AO === '1') {
    process.stdout.write('{}\n');
    return 0;
  }

  let data;
  try {
    const raw = await readStdin(3000);
    data = JSON.parse(raw);
  } catch {
    process.stdout.write(`${JSON.stringify(blocked('hook input was not valid JSON'))}\n`);
    return 0;
  }

  let output;
  try {
    output = handleAtlasExpansion(data);
  } catch {
    output = blocked(
      'unexpected initialization failure',
      data?.hook_event_name === 'PreToolUse' ? 'PreToolUse' : 'UserPromptExpansion',
    );
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  return 0;
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  process.exitCode = await main();
}
