#!/usr/bin/env node
/** Bootstrap the native Athena pipeline in the caller's project directory. */
import { readFileSync } from 'node:fs';
import { loadCheckpoint } from './lib/checkpoint.mjs';
import { recoverOrphanedRun } from './lib/orphan-run-recovery.mjs';
import { resolveAthenaShipPolicy } from './lib/athena-ship-policy.mjs';
import { initPipeline } from './lib/phase-runner.mjs';
import { appendUserTaskUpdate } from './lib/run-artifacts.mjs';
import { admitOrchestratorRun } from './orchestrator-skill-init.mjs';

async function bootstrap(currentAthenaRequest) {
  const cwd = process.cwd();
  if (typeof currentAthenaRequest !== 'string' || !currentAthenaRequest.trim()) {
    throw new Error('Athena current user request is unavailable; stop before creating or resuming a run');
  }
  const pendingCheckpoint = await loadCheckpoint('athena');
  const initialAthenaAdmission = admitOrchestratorRun('athena', currentAthenaRequest, {
    cwd,
    createIfMissing: false,
  });
  if (!initialAthenaAdmission.ok) {
    throw new Error(`Athena orchestrator admission conflict: ${initialAthenaAdmission.reason}; preserve all artifacts and stop`);
  }
  const activeAthenaRunId = initialAthenaAdmission.runId;
  if (activeAthenaRunId && pendingCheckpoint?.runId
    && pendingCheckpoint.runId !== activeAthenaRunId) {
    throw new Error('Athena checkpoint belongs to a different active run; preserve both and stop');
  }
  // canCreateNewRun is true only for an exact terminal summary revalidated under
  // the transition lock. A missing run directory is not worker-liveness proof.
  // Unknown, absent, corrupt, linked, or identity-unproven evidence stops here;
  // no Task/Agent dispatch, adapter spawn, or native teammate launch may follow.
  let orphanRecovery = null;
  const athenaAdmission = admitOrchestratorRun('athena', currentAthenaRequest, {
    cwd,
    expectedRunId: activeAthenaRunId,
    // Recovery publishes an active pointer, so it executes inside the same
    // project-global admission lock as a fresh Atlas/Athena claim.
    recoverMissing: () => {
      if (!pendingCheckpoint?.runId) return null;
      orphanRecovery = recoverOrphanedRun('athena', pendingCheckpoint.runId);
      return orphanRecovery;
    },
  });
  if (!athenaAdmission.ok || !athenaAdmission.runId || !athenaAdmission.pointerGuard) {
    throw new Error(`Athena orchestrator admission was not durably claimed: ${athenaAdmission.reason}; preserve all artifacts and stop`);
  }
  const runId = athenaAdmission.runId;
  athenaAdmission.pointerGuard.revalidate({ required: true });
  // Every invocation, including a follow-up that resumes an active/recovered
  // run, must atomically append the current user-authored constraint to the
  // strict task ledger before the pipeline can continue. The best-effort event
  // JSONL remains audit-only and is never a shipping-policy source.
  const appendedTaskUpdate = appendUserTaskUpdate(runId, currentAthenaRequest, {
    allowCreate: athenaAdmission.created === true,
  });
  if (!appendedTaskUpdate.ok
    || appendedTaskUpdate.updates?.at(-1)?.task !== currentAthenaRequest) {
    throw new Error('Athena current user request was not durably appended; preserve the run and stop');
  }
  athenaAdmission.pointerGuard.revalidate({ required: true });
  resolveAthenaShipPolicy(runId, 'pipeline resume');
  const pipelineInit = initPipeline(runId, 'athena');
  if (!pipelineInit.ok || pipelineInit.degraded) {
    throw new Error('Athena pipeline ledger is unavailable or corrupt; preserve all teams/worktrees and stop');
  }
  athenaAdmission.pointerGuard.revalidate({ required: true });
  const { resumePhase, resumePolicy } = pipelineInit;
  return { runId, created: athenaAdmission.created, pendingCheckpoint, orphanRecovery, resumePhase, resumePolicy };
}

try {
  const admission = await bootstrap(readFileSync(0, 'utf8'));
  process.stdout.write(JSON.stringify(admission) + '\n');
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
