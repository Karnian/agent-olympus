import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  createRun,
  finalizeRun,
  getActiveRunId,
} from '../../lib/run-artifacts.mjs';
import {
  beginAttempt,
  completePhase,
  enterPhase,
  getPhaseSequence,
  initPipeline,
  loopTick,
  recordPhaseOutputs,
  reopenPhase,
  skipPhase,
} from '../../lib/phase-runner.mjs';

/**
 * Create a production-shaped, fully completed pipeline ledger for a live-eval
 * test double. Every artifact and state pointer is rooted under `trialCwd`.
 *
 * @param {string} trialCwd Isolated eval trial working directory.
 * @param {'atlas'|'athena'} [orchestrator='atlas'] Phase sequence to complete.
 * @param {{trivial?:boolean, latePlanRewind?:boolean, backfillAttempt?:boolean}} [options]
 * @returns {Promise<{runId:string, runDir:string}>}
 */
export async function createFinalizedEvalPipelineFixture(
  trialCwd,
  orchestrator = 'atlas',
  options = {},
) {
  if (typeof trialCwd !== 'string' || trialCwd.trim() === '') {
    throw new TypeError('trialCwd must be a non-empty string');
  }

  const cwd = path.resolve(trialCwd);
  const runsBase = path.join(cwd, '.ao', 'artifacts', 'runs');
  const stateDir = path.join(cwd, '.ao', 'state');
  const phases = getPhaseSequence(orchestrator);
  if (phases.length === 0) {
    throw new Error(`Unsupported pipeline orchestrator: ${orchestrator}`);
  }

  const activeRunId = getActiveRunId(orchestrator, { stateDir });
  const { runId, runDir } = activeRunId
    ? { runId: activeRunId, runDir: path.join(runsBase, activeRunId) }
    : createRun(
      orchestrator,
      'Hermetic live-eval pipeline fixture',
      { base: runsBase, stateDir },
    );
  if (!runId || !runDir) {
    throw new Error('createRun did not create an eval pipeline run directory');
  }

  const initialized = initPipeline(runId, orchestrator, { cwd });
  if (!initialized.ok || initialized.degraded) {
    throw new Error(`initPipeline failed for eval fixture run ${runId}`);
  }

  const trivialPhaseIds = new Set(['context', 'spec', 'plan']);
  const athenaEvidence = {
    runId,
    teamSlug: 'athena-eval-fixture',
    intendedWorkers: 'api,test',
    spawnPath: 'adapter-only',
    baseCommit: 'a'.repeat(40),
    worktreeDigest: 'b'.repeat(64),
    adapterRunId: 'a1b2c3d4e5f60718',
  };
  for (const { id } of phases) {
    if (options.trivial && trivialPhaseIds.has(id)) {
      const skipped = skipPhase(runId, id, 'trivial', { cwd });
      if (!skipped.ok || skipped.degraded) {
        throw new Error(`skipPhase failed for eval fixture phase ${id}`);
      }
      continue;
    }
    const attemptPhase = orchestrator === 'atlas' ? 'execute' : 'integrate';
    if (id === attemptPhase) {
      const attempt = beginAttempt(runId, { cwd });
      if (!attempt.allowed || attempt.degraded || attempt.count !== 1) {
        throw new Error(`beginAttempt failed for eval fixture run ${runId}`);
      }
    }
    const entered = enterPhase(runId, id, { cwd });
    if (!entered.proceed || entered.skip || entered.degraded) {
      throw new Error(`enterPhase failed for eval fixture phase ${id}`);
    }

    if (orchestrator === 'athena' && id === 'spawn') {
      for (const launchState of ['not-started', 'started']) {
        const recorded = recordPhaseOutputs(runId, 'spawn', {
          runId: athenaEvidence.runId,
          teamSlug: athenaEvidence.teamSlug,
          intendedWorkers: athenaEvidence.intendedWorkers,
          spawnPath: athenaEvidence.spawnPath,
          launchState,
          baseCommit: athenaEvidence.baseCommit,
        }, { cwd });
        if (!recorded.ok || recorded.degraded) {
          throw new Error(`recordPhaseOutputs failed for Athena ${launchState}`);
        }
      }
    }

    if (id === 'review') {
      const review = loopTick(runId, 'review', { cwd });
      if (!review.allowed || review.degraded || review.count !== 1) {
        throw new Error('loopTick failed for eval fixture review round');
      }
    }
    if (id === 'monitor') {
      const monitor = loopTick(runId, 'monitor', { cwd });
      if (!monitor.allowed || monitor.degraded || monitor.count !== 1) {
        throw new Error('loopTick failed for eval fixture monitor iteration');
      }
    }
    if (id === 'ci') {
      const ci = loopTick(runId, 'ci', { cwd });
      if (!ci.allowed || ci.degraded || ci.count !== 1) {
        throw new Error('loopTick failed for eval fixture CI cycle');
      }
    }

    const outputs = orchestrator !== 'athena' ? undefined
      : id === 'spawn' ? {
        launchState: 'durable',
        worktreeDigest: athenaEvidence.worktreeDigest,
        adapterRunId: athenaEvidence.adapterRunId,
      }
        : id === 'monitor' ? {
          teamSlug: athenaEvidence.teamSlug,
          intendedWorkers: athenaEvidence.intendedWorkers,
          terminalWorkers: athenaEvidence.intendedWorkers,
          worktreeDigest: athenaEvidence.worktreeDigest,
          adapterRunId: athenaEvidence.adapterRunId,
        }
          : id === 'integrate' ? {
            teamSlug: athenaEvidence.teamSlug,
            intendedWorkers: athenaEvidence.intendedWorkers,
            isolatedWorkers: athenaEvidence.intendedWorkers,
            mergedWorkers: athenaEvidence.intendedWorkers,
            worktreeDigest: athenaEvidence.worktreeDigest,
            verificationPassed: true,
            integrationCommit: 'c'.repeat(40),
          }
            : id === 'complete' ? {
              teamSlug: athenaEvidence.teamSlug,
              worktreeDigest: athenaEvidence.worktreeDigest,
              cleanupState: 'done',
            }
            : undefined;
    const completed = await completePhase(runId, id, outputs, {
      cwd,
      saveCheckpoint: false,
    });
    if (!completed.ok || completed.degraded || completed.checkpointDegraded) {
      throw new Error(`completePhase failed for eval fixture phase ${id}`);
    }

    if (options.latePlanRewind && id === 'verify') {
      const reopened = reopenPhase(runId, 'plan', { reason: 'light_mode_rewind' }, { cwd });
      if (!reopened.ok || reopened.rejected || reopened.degraded) {
        throw new Error('reopenPhase failed for late eval fixture plan rewind');
      }
      const reentered = enterPhase(runId, 'plan', { cwd });
      if (!reentered.proceed || reentered.skip || reentered.degraded) {
        throw new Error('enterPhase failed for late eval fixture plan rewind');
      }
      const recompleted = await completePhase(runId, 'plan', undefined, {
        cwd,
        saveCheckpoint: false,
      });
      if (!recompleted.ok || recompleted.degraded || recompleted.checkpointDegraded) {
        throw new Error('completePhase failed for late eval fixture plan rewind');
      }
      for (const replayId of ['execute', 'verify']) {
        const replayEntry = enterPhase(runId, replayId, { cwd });
        if (!replayEntry.proceed || replayEntry.skip || replayEntry.degraded) {
          throw new Error(`enterPhase failed for late eval fixture ${replayId} replay`);
        }
        const replayed = await completePhase(runId, replayId, undefined, {
          cwd,
          saveCheckpoint: false,
        });
        if (!replayed.ok || replayed.degraded || replayed.checkpointDegraded) {
          throw new Error(`completePhase failed for late eval fixture ${replayId} replay`);
        }
      }
    }

  }

  if (options.backfillAttempt) {
    // The hardened runner rejects a late beginAttempt. Synthesize the same
    // invalid evidence by moving the canonical guard consultation after the
    // execute phase; the verifier must still fail it closed.
    const pipelinePath = path.join(runDir, 'pipeline.json');
    const guardPath = path.join(runDir, 'loop-guard.json');
    const pipeline = JSON.parse(readFileSync(pipelinePath, 'utf-8'));
    const guard = JSON.parse(readFileSync(guardPath, 'utf-8'));
    const late = new Date(Date.parse(pipeline.updatedAt) + 1).toISOString();
    guard.counters.iterations.firstAt = late;
    guard.counters.iterations.lastAt = late;
    pipeline.updatedAt = late;
    writeFileSync(pipelinePath, JSON.stringify(pipeline, null, 2));
    writeFileSync(guardPath, JSON.stringify(guard, null, 2));
    await new Promise(resolve => setTimeout(resolve, 2));
  }

  finalizeRun(runId, {
    storiesCompleted: 1,
    result: 'success',
  }, { base: runsBase, stateDir });

  return { runId, runDir };
}
