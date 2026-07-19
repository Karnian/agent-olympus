import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  appendUserTaskUpdate,
  createRun,
  getActiveRunId,
  getUserTaskUpdates,
  pinRunReviewBase,
} from '../../lib/run-artifacts.mjs';
import {
  beginAttempt,
  completePhase,
  enterPhase,
  finalizeCompletedPipeline,
  getPipelineState,
  getPhaseSequence,
  initPipeline,
  loopTick,
  recordPhaseOutputs,
  reattempt,
  reopenPhase,
  skipPhase,
} from '../../lib/phase-runner.mjs';
import {
  enrichExecutionPrd,
  readExecutionPrd,
  readPlanningPrdForExecution,
  setExecutionStoryPasses,
} from '../../lib/execution-prd-store.mjs';
import {
  approveBoundReview,
  recordBoundVerification,
  sealBoundVerification,
  startBoundVerification,
  validateFinalizePhaseCompletion,
  validateReviewPhaseCompletion,
} from '../../lib/orchestrator-review-evidence.mjs';
import { buildReviewPackage, resolveReviewBase } from '../../lib/review-package.mjs';
import { writeHermesSpecArtifacts } from '../../lib/spec-artifact.mjs';

const ATLAS_INIT = path.resolve(
  new URL('../../orchestrator-skill-init.mjs', import.meta.url).pathname,
);

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function prepareAtlasRepository(cwd) {
  try {
    git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
  } catch {
    git(cwd, ['init', '--initial-branch=main']);
    writeFileSync(path.join(cwd, '.gitignore'), '.ao/\n');
    writeFileSync(path.join(cwd, 'README.md'), '# Atlas eval fixture\n');
    git(cwd, ['config', 'user.name', 'Atlas Eval Fixture']);
    git(cwd, ['config', 'user.email', 'atlas-eval-fixture@example.test']);
    git(cwd, ['add', '.gitignore', 'README.md']);
    git(cwd, ['commit', '-m', 'seed Atlas eval fixture']);
  }
  git(cwd, ['config', 'user.name', 'Atlas Eval Fixture']);
  git(cwd, ['config', 'user.email', 'atlas-eval-fixture@example.test']);

  // Real eval workdirs already ignore harness state through Git metadata. The
  // standalone evidence tests need the same invariant so review-tree hashing
  // cannot recursively absorb its own `.ao` evidence artifacts.
  const excludePathRaw = git(cwd, ['rev-parse', '--git-path', 'info/exclude']);
  const excludePath = path.isAbsolute(excludePathRaw)
    ? excludePathRaw
    : path.resolve(cwd, excludePathRaw);
  mkdirSync(path.dirname(excludePath), { recursive: true });
  let excludes = '';
  try { excludes = readFileSync(excludePath, 'utf8'); } catch {}
  if (!excludes.split(/\r?\n/).includes('.ao/')) {
    writeFileSync(excludePath, `${excludes}${excludes && !excludes.endsWith('\n') ? '\n' : ''}.ao/\n`);
  }

  return git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
}

function ensureAtlasFixtureChange(cwd) {
  if (git(cwd, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=no']) === '') {
    writeFileSync(
      path.join(cwd, 'eval-fixture-change.txt'),
      'Authentic Atlas review evidence fixture.\n',
    );
  }
}

function createAtlasExecutionPrd(cwd, runId, scope) {
  const planningPrd = {
    projectName: `atlas-eval-${runId.slice(-40).toLowerCase()}`,
    mode: 'engineering-change',
    scale: 'S',
    goals: ['Produce one authentic, reviewable Atlas eval fixture change.'],
    nonGoals: [],
    constraints: ['Use the production verification and review evidence boundary.'],
    risks: ['Fixture evidence must remain bound to the exact Git tree.'],
    openQuestions: [],
    userStories: [{
      id: 'US-001',
      title: 'Complete the eval fixture change',
      acceptanceCriteria: [
        'GIVEN the isolated eval worktree WHEN the fixture change is complete THEN fresh verification and unanimous routed review approve the exact final tree',
      ],
      passes: false,
    }],
  };
  writeHermesSpecArtifacts(JSON.stringify({
    schemaVersion: 1,
    verdict: 'CREATE',
    summary: 'Created the Atlas eval fixture execution contract.',
    specMarkdown: '# Atlas Eval Fixture\n\nExercise the production evidence boundary.',
    prd: planningPrd,
  }), { cwd, trustedRoot: cwd });
  const planning = readPlanningPrdForExecution({ cwd });
  const executionPrd = structuredClone(planning.prd);
  Object.assign(executionPrd.userStories[0], {
    parallelGroup: 'A',
    assignTo: 'claude',
    model: 'sonnet',
    agentType: 'executor',
    scope,
    dependsOn: [],
    requiresTDD: false,
  });
  return enrichExecutionPrd(executionPrd, {
    cwd,
    orchestrator: 'atlas',
    expectedGeneration: planning.generation,
  });
}

/** Invoke the real Atlas bootstrap while the preallocated eval tree is clean. */
export function invokeAtlasEvalBootstrap(cwd) {
  const stateDir = path.join(cwd, '.ao', 'state');
  const runsBase = path.join(cwd, '.ao', 'artifacts', 'runs');
  const runId = getActiveRunId('atlas', { stateDir });
  if (!runId) throw new Error('Atlas eval bootstrap requires a preallocated active run');
  const pipeline = getPipelineState(runId, { cwd });
  if (pipeline?.orchestrator === 'atlas' && pipeline?.runId === runId) return runId;
  const updates = getUserTaskUpdates(runId, { base: runsBase, trustedRoot: cwd });
  if (!updates.ok || updates.updates.length !== 1 || !updates.updates[0]?.task) {
    throw new Error('Atlas eval bootstrap requires exactly one preallocated task update');
  }
  const env = { ...process.env };
  delete env.DISABLE_AO;
  const stdout = execFileSync(process.execPath, [ATLAS_INIT], {
    cwd,
    encoding: 'utf8',
    input: JSON.stringify({
      hook_event_name: 'UserPromptExpansion',
      expansion_type: 'slash_command',
      command_name: 'agent-olympus:atlas',
      command_args: updates.updates[0].task,
      command_source: 'plugin',
    }),
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = JSON.parse(stdout);
  const context = output?.hookSpecificOutput?.additionalContext || '';
  if (!context.includes(`runId: ${runId}`)) {
    throw new Error(`real Atlas eval bootstrap did not adopt the preallocated run: ${stdout}`);
  }
  return runId;
}

/** Model the real Athena skill entry, which appends the adopted eval task once. */
export function invokeAthenaEvalBootstrap(cwd) {
  const stateDir = path.join(cwd, '.ao', 'state');
  const runsBase = path.join(cwd, '.ao', 'artifacts', 'runs');
  const runId = getActiveRunId('athena', { stateDir });
  if (!runId) throw new Error('Athena eval bootstrap requires a preallocated active run');
  const updates = getUserTaskUpdates(runId, { base: runsBase, trustedRoot: cwd });
  if (!updates.ok || ![1, 2].includes(updates.updates.length)
    || !updates.updates[0]?.task) {
    throw new Error('Athena eval bootstrap requires one preallocated task update');
  }
  if (updates.updates.length === 1) {
    const appended = appendUserTaskUpdate(runId, updates.updates[0].task, {
      base: runsBase,
      trustedRoot: cwd,
    });
    if (!appended.ok || appended.updates.length !== 2) {
      throw new Error('Athena eval skill invocation did not append the adopted task');
    }
  }
  return runId;
}

function approvalResults(sealed) {
  return Object.fromEntries(sealed.reviewers.map(reviewer => [reviewer, {
    schemaVersion: 1,
    reviewer,
    reviewDigest: sealed.reviewDigest,
    verdict: 'APPROVE',
    findings: [],
    escalations: [],
  }]));
}

function verificationRecord(criterion, phase) {
  return {
    story_id: 'US-001',
    verdict: 'pass',
    evidence: `${phase} fixture verification passed on the bound Git tree.`,
    verifiedBy: 'atlas',
    criteria: [{
      criterion_index: 0,
      criterion_text: criterion,
      verdict: 'pass',
      evidence: `The exact ${phase} tree satisfies the persisted acceptance criterion.`,
    }],
  };
}

/**
 * Create a production-shaped, fully completed pipeline ledger for a live-eval
 * test double. Every artifact and state pointer is rooted under `trialCwd`.
 *
 * @param {string} trialCwd Isolated eval trial working directory.
 * @param {'atlas'|'athena'} [orchestrator='atlas'] Phase sequence to complete.
 * @param {{trivial?:boolean, latePlanRewind?:boolean, qualityReattempt?:boolean, lightModeReattempt?:boolean, backfillAttempt?:boolean, skipBootstrap?:boolean}} [options]
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

  let atlasBaseCommit = null;
  if (orchestrator === 'atlas') {
    atlasBaseCommit = prepareAtlasRepository(cwd);
    if (!options.skipBootstrap) invokeAtlasEvalBootstrap(cwd);
  } else if (!options.skipBootstrap) {
    invokeAthenaEvalBootstrap(cwd);
  }

  const initialized = initPipeline(runId, orchestrator, { cwd });
  if (!initialized.ok || initialized.degraded) {
    throw new Error(`initPipeline failed for eval fixture run ${runId}`);
  }

  const evidenceOpts = { cwd, base: runsBase, stateDir, trustedRoot: cwd };
  let atlasCriterion = null;
  let sealedReview = null;
  let atlasFinalCommit = null;
  if (orchestrator === 'atlas') {
    writeFileSync(path.join(cwd, '.ao', 'autonomy.json'), `${JSON.stringify({
      version: '1',
      ship: { mode: options.shipMode ?? 'auto' },
      ci: { watchEnabled: options.ciWatchEnabled ?? true },
    })}\n`);
    ensureAtlasFixtureChange(cwd);
    const resolvedBase = resolveReviewBase({ cwd, baseRef: 'HEAD' });
    if (resolvedBase.baseRefCommit !== atlasBaseCommit) {
      throw new Error('Atlas eval fixture review base did not resolve to HEAD');
    }
    const pinned = pinRunReviewBase(runId, {
      baseRef: 'HEAD',
      baseRefCommit: atlasBaseCommit,
      source: 'explicit',
    }, evidenceOpts);
    if (!pinned.ok) throw new Error(`Atlas eval fixture review-base pin failed: ${pinned.reason}`);
    const candidate = buildReviewPackage({ cwd, baseRef: atlasBaseCommit });
    const execution = createAtlasExecutionPrd(cwd, runId, candidate.diffPaths);
    atlasCriterion = execution.prd.userStories[0].acceptanceCriteria[0];
  }

  const completeAtlasVerification = async (supersedeGenerationId = null) => {
    const generation = startBoundVerification(runId, 'review', {
      ...evidenceOpts,
      ...(supersedeGenerationId ? { supersedeGenerationId } : {}),
    });
    recordBoundVerification(
      runId,
      generation.generationId,
      verificationRecord(atlasCriterion, 'review'),
      evidenceOpts,
    );
    let sealed = null;
    const completed = await completePhase(runId, 'verify', undefined, {
      cwd,
      saveCheckpoint: false,
      _deriveOutputs: ({ _runLockOwner }) => {
        sealed = sealBoundVerification(runId, 'review', generation.generationId, {
          ...evidenceOpts,
          _runLockOwner,
        });
        return {
          verificationGenerationId: sealed.generationId,
          verificationReviewDigest: sealed.reviewDigest,
          verificationReviewTreeOid: sealed.reviewTreeOid,
        };
      },
    });
    sealedReview = sealed;
    return completed;
  };

  const trivialPhaseIds = new Set(['context', 'spec', 'plan']);
  const athenaEvidence = {
    runId,
    teamSlug: 'athena-eval-fixture',
    intendedWorkers: 'api,test',
    spawnPath: 'adapter-only',
    baseCommit: 'a'.repeat(40),
    worktreeDigest: 'b'.repeat(64),
    adapterRunId: 'a1b2c3d4e5f60718',
    nativeSessionId: 'none',
    prdGeneration: 'd'.repeat(64),
  };
  for (const { id } of phases) {
    const dynamicSkipReason = orchestrator === 'atlas'
      ? id === 'ship'
        ? options.shipSkipReason
        : id === 'ci'
          ? options.ciSkipReason
          : null
      : null;
    if (dynamicSkipReason) {
      const skipped = skipPhase(runId, id, dynamicSkipReason, { cwd });
      if (!skipped.ok || skipped.degraded) {
        throw new Error(`skipPhase failed for eval fixture phase ${id}`);
      }
      continue;
    }
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
          adapterRunId: athenaEvidence.adapterRunId,
          nativeSessionId: athenaEvidence.nativeSessionId,
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
    if (id === 'finalize') {
      const finalReview = loopTick(runId, 'final-review', { cwd });
      if (!finalReview.allowed || finalReview.degraded || finalReview.count !== 1) {
        throw new Error('loopTick failed for eval fixture final review round');
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

    if (orchestrator === 'atlas' && id === 'review' && options.lightModeReattempt) {
      const supersededGenerationId = sealedReview?.generationId;
      let rolledBack = false;
      const retried = reattempt(runId, {
        reopen: ['execute', 'verify'],
        reason: 'light_mode_reexec',
      }, {
        cwd,
        _beforeRewind: () => {
          const current = readExecutionPrd({ cwd, orchestrator: 'atlas' });
          setExecutionStoryPasses(['US-001'], false, {
            cwd,
            orchestrator: 'atlas',
            expectedGeneration: current.generation,
          });
          rolledBack = true;
        },
      });
      if (!retried.allowed || retried.degraded || retried.count !== 2 || !rolledBack
        || !supersededGenerationId) {
        throw new Error('light-mode reattempt failed for eval fixture review phase');
      }
      const replayExecute = enterPhase(runId, 'execute', { cwd });
      if (!replayExecute.proceed || replayExecute.skip || replayExecute.degraded) {
        throw new Error('enterPhase failed for eval fixture light-mode execute replay');
      }
      const current = readExecutionPrd({ cwd, orchestrator: 'atlas' });
      setExecutionStoryPasses(['US-001'], true, {
        cwd,
        orchestrator: 'atlas',
        expectedGeneration: current.generation,
      });
      const executed = await completePhase(runId, 'execute', undefined, {
        cwd,
        saveCheckpoint: false,
      });
      if (!executed.ok || executed.degraded || executed.checkpointDegraded) {
        throw new Error('completePhase failed for eval fixture light-mode execute replay');
      }
      const replayVerify = enterPhase(runId, 'verify', { cwd });
      if (!replayVerify.proceed || replayVerify.skip || replayVerify.degraded) {
        throw new Error('enterPhase failed for eval fixture light-mode verify replay');
      }
      const verified = await completeAtlasVerification(supersededGenerationId);
      if (!verified.ok || verified.degraded || verified.checkpointDegraded) {
        throw new Error('completePhase failed for eval fixture light-mode verify replay');
      }
      const replayReview = enterPhase(runId, 'review', { cwd });
      if (!replayReview.proceed || replayReview.skip || replayReview.degraded) {
        throw new Error('enterPhase failed for eval fixture light-mode review replay');
      }
      const review = loopTick(runId, 'review', { cwd });
      if (!review.allowed || review.degraded || review.count !== 2) {
        throw new Error('loopTick failed for eval fixture light-mode review replay');
      }
    }

    const outputs = orchestrator === 'atlas' && id === 'triage' ? {
      reviewBaseRef: 'HEAD',
      reviewBaseCommit: atlasBaseCommit,
      reviewBaseSource: 'explicit',
    }
      : orchestrator === 'atlas' && id === 'ship' ? {
        pushPerformed: true,
        createdPrUrl: 'https://github.com/acme/atlas-eval-fixture/pull/1',
        branchName: 'eval-fixture',
        baseBranch: 'main',
        headCommit: atlasFinalCommit,
        repoOriginUrl: 'https://github.com/acme/atlas-eval-fixture.git',
        repoPushUrl: 'git@github.com:acme/atlas-eval-fixture.git',
        repoRepository: 'github.com/acme/atlas-eval-fixture',
        repoDefaultBranch: 'main',
      }
        : orchestrator === 'atlas' && id === 'ci' ? {
          ciHeadCommit: atlasFinalCommit,
        }
      : orchestrator !== 'athena' ? undefined
      : id === 'spawn' ? {
        launchState: 'durable',
        worktreeDigest: athenaEvidence.worktreeDigest,
        adapterRunId: athenaEvidence.adapterRunId,
        nativeSessionId: athenaEvidence.nativeSessionId,
        prdGeneration: athenaEvidence.prdGeneration,
      }
        : id === 'monitor' ? {
          teamSlug: athenaEvidence.teamSlug,
          intendedWorkers: athenaEvidence.intendedWorkers,
          terminalWorkers: athenaEvidence.intendedWorkers,
          worktreeDigest: athenaEvidence.worktreeDigest,
          adapterRunId: athenaEvidence.adapterRunId,
          nativeSessionId: athenaEvidence.nativeSessionId,
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
    if (orchestrator === 'atlas' && id === 'execute') {
      const current = readExecutionPrd({ cwd, orchestrator: 'atlas' });
      if (current.prd.userStories[0].passes !== true) {
        setExecutionStoryPasses(['US-001'], true, {
          cwd,
          orchestrator: 'atlas',
          expectedGeneration: current.generation,
        });
      }
    }

    let completed;
    if (orchestrator === 'atlas' && id === 'verify') {
      if (options.qualityReattempt) {
        let rolledBack = false;
        const retried = reattempt(runId, {
          reopen: ['execute', 'verify'],
          reason: 'quality_fail',
        }, {
          cwd,
          _beforeRewind: () => {
            const current = readExecutionPrd({ cwd, orchestrator: 'atlas' });
            setExecutionStoryPasses(['US-001'], false, {
              cwd,
              orchestrator: 'atlas',
              expectedGeneration: current.generation,
            });
            rolledBack = true;
          },
        });
        if (!retried.allowed || retried.degraded || retried.count !== 2
          || retried.qualityCount !== 1 || !rolledBack) {
          throw new Error('quality reattempt failed for eval fixture verify phase');
        }
        const replayExecute = enterPhase(runId, 'execute', { cwd });
        if (!replayExecute.proceed || replayExecute.skip || replayExecute.degraded) {
          throw new Error('enterPhase failed for eval fixture quality execute replay');
        }
        const current = readExecutionPrd({ cwd, orchestrator: 'atlas' });
        setExecutionStoryPasses(['US-001'], true, {
          cwd,
          orchestrator: 'atlas',
          expectedGeneration: current.generation,
        });
        const executed = await completePhase(runId, 'execute', undefined, {
          cwd,
          saveCheckpoint: false,
        });
        if (!executed.ok || executed.degraded || executed.checkpointDegraded) {
          throw new Error('completePhase failed for eval fixture quality execute replay');
        }
        const replayVerify = enterPhase(runId, 'verify', { cwd });
        if (!replayVerify.proceed || replayVerify.skip || replayVerify.degraded) {
          throw new Error('enterPhase failed for eval fixture quality verify replay');
        }
      }
      completed = await completeAtlasVerification();
    } else if (orchestrator === 'atlas' && id === 'review') {
      if (!sealedReview) throw new Error('Atlas eval fixture review has no sealed verification');
      const approval = approveBoundReview(
        runId,
        'review',
        sealedReview.generationId,
        approvalResults(sealedReview),
        evidenceOpts,
      );
      completed = await completePhase(runId, 'review', undefined, {
        cwd,
        saveCheckpoint: false,
        _deriveOutputs: ({ _runLockOwner }) => validateReviewPhaseCompletion(
          runId,
          approval.reviewDigest,
          { ...evidenceOpts, _runLockOwner },
        ),
      });
    } else if (orchestrator === 'atlas' && id === 'finalize') {
      const generation = startBoundVerification(runId, 'final-review', evidenceOpts);
      recordBoundVerification(
        runId,
        generation.generationId,
        verificationRecord(atlasCriterion, 'final-review'),
        evidenceOpts,
      );
      const sealedFinal = sealBoundVerification(
        runId,
        'final-review',
        generation.generationId,
        evidenceOpts,
      );
      const approval = approveBoundReview(
        runId,
        'final-review',
        generation.generationId,
        approvalResults(sealedFinal),
        evidenceOpts,
      );
      completed = await completePhase(runId, 'finalize', undefined, {
        cwd,
        saveCheckpoint: false,
        _deriveOutputs: ({ _runLockOwner }) => validateFinalizePhaseCompletion(
          runId,
          approval.reviewDigest,
          { ...evidenceOpts, _runLockOwner },
        ),
      });
    } else {
      completed = await completePhase(runId, id, outputs, {
        cwd,
        saveCheckpoint: false,
      });
    }
    if (!completed.ok || completed.degraded || completed.checkpointDegraded) {
      throw new Error(`completePhase failed for eval fixture phase ${id}`);
    }
    if (orchestrator === 'atlas' && id === 'finalize') {
      atlasFinalCommit = getPipelineState(runId, { cwd }).phases.finalize.outputs?.finalCommit;
      if (!atlasFinalCommit) throw new Error('Atlas eval fixture finalize commit is unavailable');
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
        const replayed = replayId === 'verify'
          ? await completeAtlasVerification()
          : await completePhase(runId, replayId, undefined, { cwd, saveCheckpoint: false });
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

  const finalized = finalizeCompletedPipeline(runId, { cwd, stateDir });
  if (!finalized.ok || finalized.degraded) {
    throw new Error(`finalizeCompletedPipeline failed for eval fixture: ${finalized.reason}`);
  }

  return { runId, runDir };
}
