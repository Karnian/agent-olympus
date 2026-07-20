/**
 * Unit tests for scripts/lib/phase-runner.mjs
 *
 * Covers the runner contract: canonical phase traversal, durable pipeline
 * ledger, loop-guard absorption, recovery checkpoint ordering, fail-open
 * storage polarity, and strict completion semantics.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  promises as fsp,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MONITOR_CAP,
  CI_CAP,
  QUALITY_CAP,
  FINAL_REVIEW_CAP,
  SCHEMA_VERSION,
  validatePipelineLedgerIdentity,
  getPhaseSequence,
  initPipeline,
  enterPhase,
  beginAttempt,
  reattempt,
  loopTick,
  recordPhaseError,
  failPhase,
  recordPhaseOutputs,
  completePhase,
  skipPhase,
  reopenPhase,
  nextPhase,
  getPipelineState,
  isComplete,
  finalizeCompletedPipeline,
  inspectCurrentPhaseLoop,
  withCurrentPhaseLoopTick,
} from '../lib/phase-runner.mjs';
import {
  createRun,
  getActiveRunId,
  getRunExecutionPrdSnapshot,
} from '../lib/run-artifacts.mjs';

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'ao-phase-runner-test-'));
}

async function removeTmpDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

function pipelinePath(cwd, runId) {
  return path.join(cwd, '.ao', 'artifacts', 'runs', runId, 'pipeline.json');
}

function guardPath(cwd, runId) {
  return path.join(cwd, '.ao', 'artifacts', 'runs', runId, 'loop-guard.json');
}

function eventsPath(cwd, runId) {
  return path.join(cwd, '.ao', 'artifacts', 'runs', runId, 'events.jsonl');
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function readEvents(cwd, runId) {
  const file = eventsPath(cwd, runId);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function writeCompletedAtlasPrd(cwd) {
  const prd = {
    projectName: 'phase-runner-finalization',
    mode: 'engineering-change',
    scale: 'S',
    goals: ['Finalize one test run.'],
    nonGoals: [],
    constraints: [],
    risks: [],
    openQuestions: [],
    userStories: [{
      id: 'US-001',
      title: 'Finalize the run',
      acceptanceCriteria: [
        'GIVEN a complete pipeline WHEN finalization runs THEN the final PRD is preserved',
      ],
      passes: true,
      parallelGroup: 'A',
      assignTo: 'claude',
      model: 'sonnet',
      agentType: 'executor',
      scope: ['README.md'],
      dependsOn: [],
      requiresTDD: false,
    }],
  };
  mkdirSync(path.join(cwd, '.ao'), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(cwd, '.ao', 'prd.json'), `${JSON.stringify(prd, null, 2)}\n`, {
    mode: 0o600,
  });
  return prd;
}

function readValidEvents(cwd, runId) {
  const file = eventsPath(cwd, runId);
  if (!existsSync(file)) return [];
  const events = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch {}
  }
  return events;
}

async function completeNoCheckpoint(runId, phaseId, cwd, outputs = undefined) {
  return completePhase(runId, phaseId, outputs, { cwd, saveCheckpoint: false });
}

async function completeThrough(runId, cwd, phaseIds) {
  for (const phaseId of phaseIds) {
    const entered = enterPhase(runId, phaseId, { cwd });
    assert.equal(entered.proceed, true, `enter ${phaseId}`);
    if (['review', 'finalize', 'monitor', 'ci'].includes(phaseId)) {
      const loopKey = phaseId === 'finalize' ? 'final-review' : phaseId;
      const loopState = inspectCurrentPhaseLoop(runId, loopKey, { cwd });
      if (loopState.satisfied !== true) {
        const ticked = loopTick(runId, loopKey, { cwd });
        assert.equal(ticked.allowed, true, `tick ${phaseId}`);
      }
    }
    const completed = await completeNoCheckpoint(runId, phaseId, cwd);
    assert.equal(completed.ok, true, `complete ${phaseId}`);
  }
}

async function advanceToAttemptPhase(runId, orchestrator, cwd) {
  const prior = orchestrator === 'atlas'
    ? ['triage', 'context', 'spec', 'plan']
    : ['triage', 'context', 'spec', 'plan', 'spawn', 'monitor', 'wisdom'];
  await completeThrough(runId, cwd, prior);
}

// ---------------------------------------------------------------------------
// Phase sequence shape
// ---------------------------------------------------------------------------

describe('phase sequence well-formedness', () => {
  test('exports constants from the HU-06.1 contract', () => {
    assert.equal(MONITOR_CAP, 10);
    assert.equal(CI_CAP, 2);
    assert.equal(QUALITY_CAP, 2);
    assert.equal(FINAL_REVIEW_CAP, 3);
    assert.equal(SCHEMA_VERSION, 1);
  });

  test('atlas and athena descriptors match the plan constraints', () => {
    const validGuards = new Set([null, 'reviewRounds', 'monitor', 'ci', 'quality']);
    for (const orchestrator of ['atlas', 'athena']) {
      const seq = getPhaseSequence(orchestrator);
      assert.ok(seq.length > 0, `${orchestrator} sequence must exist`);
      assert.deepEqual(new Set(seq.map(p => p.id)).size, seq.length, `${orchestrator} ids must be unique`);
      let lastCheckpoint = -1;
      for (const desc of seq) {
        assert.ok(validGuards.has(desc.loopGuard), `invalid loopGuard ${desc.loopGuard}`);
        assert.notEqual(desc.loopGuard, 'iterations');
        assert.ok(desc.checkpointIndex >= lastCheckpoint, `${orchestrator} checkpointIndex must be monotonic`);
        lastCheckpoint = desc.checkpointIndex;
      }
    }
  });

  test('unknown orchestrator returns an empty sequence', () => {
    assert.deepEqual(getPhaseSequence('unknown'), []);
  });

  test('persisted identity binds runId and rejects out-of-order state except declared rewinds', () => {
    const phases = Object.fromEntries(
      getPhaseSequence('athena').map(({ id }) => [id, { status: 'pending' }]),
    );
    const ledger = {
      schemaVersion: SCHEMA_VERSION,
      runId: 'athena-bound-run',
      orchestrator: 'athena',
      attempt: 0,
      phases,
    };
    assert.equal(validatePipelineLedgerIdentity(ledger, {
      runId: ledger.runId,
      orchestrator: 'athena',
      requireRunId: true,
      requireOrdered: true,
    }), true);
    assert.equal(validatePipelineLedgerIdentity({ ...ledger, runId: 'athena-copied-run' }, {
      runId: ledger.runId,
      orchestrator: 'athena',
      requireRunId: true,
      requireOrdered: true,
    }), false);

    const outOfOrder = structuredClone(ledger);
    outOfOrder.phases.context.status = 'completed';
    assert.equal(validatePipelineLedgerIdentity(outOfOrder, {
      runId: ledger.runId,
      orchestrator: 'athena',
      requireRunId: true,
      requireOrdered: true,
    }), false);

    const legitimateRewind = structuredClone(outOfOrder);
    legitimateRewind.phases.plan.reason = 'light_mode_rewind';
    legitimateRewind.phases.triage.status = 'completed';
    legitimateRewind.phases.context.status = 'completed';
    legitimateRewind.phases.spec.status = 'completed';
    legitimateRewind.phases.plan.status = 'pending';
    legitimateRewind.phases.spawn.status = 'completed';
    assert.equal(validatePipelineLedgerIdentity(legitimateRewind, {
      runId: ledger.runId,
      orchestrator: 'athena',
      requireRunId: true,
      requireOrdered: true,
    }), true);
  });
});

test('direct traversal run ids cannot escape the run artifacts base', async () => {
  const cwd = await makeTmpDir();
  try {
    const escapedDir = path.join(cwd, 'escaped');
    const escapedPipeline = path.join(escapedDir, 'pipeline.json');
    mkdirSync(escapedDir, { mode: 0o700 });
    writeFileSync(escapedPipeline, 'PIPELINE_SENTINEL', { mode: 0o600 });

    const result = initPipeline('../../../escaped', 'atlas', { cwd });
    assert.deepEqual(result, {
      ok: false,
      resumePhase: null,
      resumePolicy: null,
      completed: [],
      degraded: false,
    });
    assert.equal(readFileSync(escapedPipeline, 'utf8'), 'PIPELINE_SENTINEL');
    assert.equal(existsSync(path.join(escapedDir, '.terminal-failure.lock')), false);
    assert.equal(nextPhase('../../../escaped', { cwd }), null);
    assert.equal(isComplete('../../../escaped', { cwd }), false);
  } finally {
    await removeTmpDir(cwd);
  }
});

test('safe run ids cannot follow linked run directories or linked run ancestors', async () => {
  const runId = 'atlas-linked-run';
  const cases = ['run-directory', 'runs-base', 'ao-ancestor'];
  for (const kind of cases) {
    const cwd = await makeTmpDir();
    try {
      const outside = path.join(cwd, `outside-${kind}`);
      const outsideRun = kind === 'ao-ancestor'
        ? path.join(outside, 'artifacts', 'runs', runId)
        : kind === 'runs-base'
          ? path.join(outside, runId)
          : outside;
      mkdirSync(outsideRun, { recursive: true, mode: 0o700 });
      const outsidePipeline = path.join(outsideRun, 'pipeline.json');
      writeFileSync(outsidePipeline, `OUTSIDE_${kind}`, { mode: 0o600 });

      const artifacts = path.join(cwd, '.ao', 'artifacts');
      if (kind === 'run-directory') {
        const base = path.join(artifacts, 'runs');
        mkdirSync(base, { recursive: true, mode: 0o700 });
        symlinkSync(outside, path.join(base, runId), 'dir');
      } else if (kind === 'runs-base') {
        mkdirSync(artifacts, { recursive: true, mode: 0o700 });
        symlinkSync(outside, path.join(artifacts, 'runs'), 'dir');
      } else {
        symlinkSync(outside, path.join(cwd, '.ao'), 'dir');
      }

      const init = initPipeline(runId, 'atlas', { cwd });
      assert.equal(init.ok, false, kind);
      assert.equal(init.degraded, false, kind);
      assert.deepEqual(enterPhase(runId, 'triage', { cwd }), {
        proceed: false,
        skip: false,
        reason: 'unsafe-run-path',
        status: 'pending',
        degraded: false,
      });
      assert.equal(beginAttempt(runId, { cwd }).allowed, false);
      assert.equal(loopTick(runId, 'review', { cwd }).reason, 'unsafe-run-path');
      assert.equal(recordPhaseError(runId, 'triage', 'unsafe', { cwd }).shouldEscalate, true);
      assert.equal(failPhase(runId, 'triage', 'plan_validation_failed', { cwd }).ok, false);
      assert.equal(recordPhaseOutputs(runId, 'spawn', { teamSlug: 'outside' }, { cwd }).ok, false);
      assert.equal((await completeNoCheckpoint(runId, 'triage', cwd)).ok, false);
      assert.equal(skipPhase(runId, 'triage', 'trivial', { cwd }).ok, false);
      assert.equal(reopenPhase(runId, 'plan', { reason: 'light_mode_rewind' }, { cwd }).ok, false);
      assert.equal(nextPhase(runId, { cwd }), null);
      assert.deepEqual(getPipelineState(runId, { cwd }).phases, {});
      assert.equal(isComplete(runId, { cwd }), false);

      assert.equal(readFileSync(outsidePipeline, 'utf8'), `OUTSIDE_${kind}`);
      assert.equal(existsSync(path.join(outsideRun, 'events.jsonl')), false);
      assert.equal(existsSync(path.join(outsideRun, 'loop-guard.json')), false);
      assert.equal(existsSync(path.join(outsideRun, '.terminal-failure.lock')), false);
    } finally {
      await removeTmpDir(cwd);
    }
  }
});

test('linked pipeline, events, and transition-lock leaves fail closed without touching targets', async () => {
  const cwd = await makeTmpDir();
  try {
    const runId = 'atlas-linked-leaves';
    const runDir = path.join(cwd, '.ao', 'artifacts', 'runs', runId);
    assert.equal(initPipeline(runId, 'atlas', { cwd }).ok, true);

    const outsidePipeline = path.join(cwd, 'outside-pipeline.json');
    writeFileSync(outsidePipeline, 'PIPELINE_TARGET', { mode: 0o600 });
    unlinkSync(path.join(runDir, 'pipeline.json'));
    symlinkSync(outsidePipeline, path.join(runDir, 'pipeline.json'));
    assert.equal(enterPhase(runId, 'triage', { cwd }).reason, 'unsafe-run-path');
    assert.equal(readFileSync(outsidePipeline, 'utf8'), 'PIPELINE_TARGET');

    unlinkSync(path.join(runDir, 'pipeline.json'));
    assert.equal(initPipeline(runId, 'atlas', { cwd }).ok, true);
    assert.equal(enterPhase(runId, 'triage', { cwd }).proceed, true);
    const outsideEvents = path.join(cwd, 'outside-events.jsonl');
    writeFileSync(outsideEvents, 'EVENT_TARGET\n', { mode: 0o600 });
    symlinkSync(outsideEvents, path.join(runDir, 'events.jsonl'));
    const completion = await completeNoCheckpoint(runId, 'triage', cwd);
    assert.equal(completion.ok, false);
    assert.equal(completion.degraded, false);
    assert.equal(readFileSync(outsideEvents, 'utf8'), 'EVENT_TARGET\n');

    unlinkSync(path.join(runDir, 'events.jsonl'));
    const lockTarget = path.join(cwd, 'outside-lock');
    writeFileSync(lockTarget, 'LOCK_TARGET', { mode: 0o600 });
    symlinkSync(lockTarget, path.join(runDir, '.terminal-failure.lock'));
    assert.deepEqual(enterPhase(runId, 'triage', { cwd }), {
      proceed: false,
      skip: false,
      reason: 'unsafe-run-path',
      status: 'pending',
      degraded: false,
    });
    assert.equal(readFileSync(lockTarget, 'utf8'), 'LOCK_TARGET');
  } finally {
    await removeTmpDir(cwd);
  }
});

test('permissive pipeline and loop-guard files are rejected before use', async () => {
  const cwd = await makeTmpDir();
  try {
    const pipelineRun = 'atlas-permissive-pipeline';
    const pipeline = pipelinePath(cwd, pipelineRun);
    assert.equal(initPipeline(pipelineRun, 'atlas', { cwd }).ok, true);
    const ledger = readFileSync(pipeline, 'utf8');
    unlinkSync(pipeline);
    writeFileSync(pipeline, ledger, { mode: 0o644 });
    assert.equal(enterPhase(pipelineRun, 'triage', { cwd }).reason, 'unsafe-run-path');

    const guardRun = 'atlas-permissive-loop-guard';
    assert.equal(initPipeline(guardRun, 'atlas', { cwd }).ok, true);
    await advanceToAttemptPhase(guardRun, 'atlas', cwd);
    assert.equal(beginAttempt(guardRun, { cwd }).allowed, true);
    chmodSync(guardPath(cwd, guardRun), 0o644);
    assert.equal(loopTick(guardRun, 'review', { cwd }).reason, 'unsafe-run-path');
  } finally {
    await removeTmpDir(cwd);
  }
});

// ---------------------------------------------------------------------------
// Enter / resume
// ---------------------------------------------------------------------------

describe('enterPhase', () => {
  test('runs a synchronous entry boundary under the transition lock before mutation', async () => {
    const cwd = await makeTmpDir();
    try {
      const runId = 'run-entry-boundary';
      initPipeline(runId, 'atlas', { cwd });
      const before = readJson(pipelinePath(cwd, runId));
      let observed = null;
      const denied = enterPhase(runId, 'triage', {
        cwd,
        _validateEntry: (boundary) => {
          observed = boundary;
          throw new Error('deny entry');
        },
      });
      assert.deepEqual(denied, {
        proceed: false,
        skip: false,
        reason: 'transition-busy',
        status: 'pending',
        degraded: true,
      });
      assert.equal(observed.runId, runId);
      assert.equal(observed.phaseId, 'triage');
      assert.equal(observed.pipeline.phases.triage.status, 'pending');
      assert.equal(Object.isFrozen(observed.pipeline), true);
      assert.ok(observed._runLockOwner);
      assert.deepEqual(readJson(pipelinePath(cwd, runId)), before);

      const entered = enterPhase(runId, 'triage', {
        cwd,
        _validateEntry: ({ pipeline }) => {
          assert.equal(pipeline.phases.triage.status, 'pending');
          return true;
        },
      });
      assert.equal(entered.proceed, true);
      assert.equal(getPipelineState(runId, { cwd }).phases.triage.status, 'in_progress');
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('rejects future traversal on a valid ledger without mutating it', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-enter-order', 'atlas', { cwd });
      const before = readJson(pipelinePath(cwd, 'run-enter-order'));
      assert.deepEqual(
        enterPhase('run-enter-order', 'context', { cwd }),
        { proceed: false, skip: false, reason: 'out-of-order', status: 'pending', degraded: false },
      );
      assert.deepEqual(readJson(pipelinePath(cwd, 'run-enter-order')), before);
      assert.equal(readEvents(cwd, 'run-enter-order').length, 0);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('unknown phase ids fail closed when the ledger itself is valid', async () => {
    const cwd = await makeTmpDir();
    try {
      const runId = 'run-unknown-phase';
      initPipeline(runId, 'atlas', { cwd });
      assert.deepEqual(enterPhase(runId, 'typo', { cwd }), {
        proceed: false,
        skip: false,
        reason: 'unknown-phase',
        status: 'pending',
        degraded: false,
      });
      assert.deepEqual(await completeNoCheckpoint(runId, 'typo', cwd), {
        ok: false,
        next: 'triage',
        checkpointDegraded: false,
        degraded: false,
      });
      assert.deepEqual(skipPhase(runId, 'typo', 'invalid', { cwd }), {
        ok: false,
        next: 'triage',
        degraded: false,
      });
      assert.equal(nextPhase(runId, { cwd }), 'triage');
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('a completed future phase is not treated as a harmless resume skip after rewind', async () => {
    const cwd = await makeTmpDir();
    try {
      const runId = 'run-enter-rewind-order';
      initPipeline(runId, 'atlas', { cwd });
      await advanceToAttemptPhase(runId, 'atlas', cwd);
      assert.equal(beginAttempt(runId, { cwd }).allowed, true);
      await completeThrough(runId, cwd, ['execute', 'verify']);
      assert.equal(reopenPhase(runId, 'plan', { reason: 'light_mode_rewind' }, { cwd }).rejected, false);

      assert.deepEqual(enterPhase(runId, 'execute', { cwd }), {
        proceed: false,
        skip: false,
        reason: 'out-of-order',
        status: 'pending',
        degraded: false,
      });
      assert.equal(nextPhase(runId, { cwd }), 'plan');
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('skips completed and skipped phases', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-enter', 'atlas', { cwd });
      enterPhase('run-enter', 'triage', { cwd });
      await completeNoCheckpoint('run-enter', 'triage', cwd);
      assert.deepEqual(
        enterPhase('run-enter', 'triage', { cwd }),
        { proceed: false, skip: true, reason: undefined, status: 'completed', degraded: false },
      );

      skipPhase('run-enter', 'context', 'trivial', { cwd });
      const skipped = enterPhase('run-enter', 'context', { cwd });
      assert.equal(skipped.proceed, false);
      assert.equal(skipped.skip, true);
      assert.equal(skipped.status, 'skipped');
      assert.equal(skipped.reason, 'trivial');
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('recover phases return reason recover on in_progress resume', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-recover', 'athena', { cwd });
      await completeThrough('run-recover', cwd, ['triage', 'context', 'spec', 'plan']);
      const first = enterPhase('run-recover', 'spawn', { cwd });
      assert.equal(first.proceed, true);
      assert.equal(first.status, 'in_progress');

      const second = enterPhase('run-recover', 'spawn', { cwd });
      assert.equal(second.proceed, true);
      assert.equal(second.reason, 'recover');
      assert.equal(second.status, 'in_progress');
    } finally {
      await removeTmpDir(cwd);
    }
  });
});

// ---------------------------------------------------------------------------
// Attempts and loop caps
// ---------------------------------------------------------------------------

describe('beginAttempt + reattempt', () => {
  test('quality-fail reattempt atomically consumes its own cap without taxing review retries', async () => {
    const cwd = await makeTmpDir();
    try {
      const runId = 'run-quality-fail-budget';
      initPipeline(runId, 'atlas', { cwd });
      await advanceToAttemptPhase(runId, 'atlas', cwd);
      assert.equal(beginAttempt(runId, { cwd }).count, 1);
      await completeThrough(runId, cwd, ['execute']);
      assert.equal(enterPhase(runId, 'verify', { cwd }).proceed, true);

      const firstQualityRetry = reattempt(runId, {
        reopen: ['execute', 'verify'], reason: 'quality_fail',
      }, { cwd });
      assert.equal(firstQualityRetry.allowed, true);
      assert.equal(readJson(guardPath(cwd, runId)).counters['quality-cycles'].count, 1);

      await completeThrough(runId, cwd, ['execute', 'verify']);
      assert.equal(enterPhase(runId, 'review', { cwd }).proceed, true);
      assert.equal(loopTick(runId, 'review', { cwd }).count, 1);
      const reviewRetry = reattempt(runId, {
        reopen: ['verify'], reason: 'review_reject',
      }, { cwd });
      assert.equal(reviewRetry.allowed, true);
      assert.equal(readJson(guardPath(cwd, runId)).counters['quality-cycles'].count, 1,
        'review rejection must not consume the quality-failure budget');

      assert.equal(enterPhase(runId, 'verify', { cwd }).proceed, true);
      const secondQualityRetry = reattempt(runId, {
        reopen: ['execute', 'verify'], reason: 'quality_fail',
      }, { cwd });
      assert.equal(secondQualityRetry.allowed, true);
      assert.equal(readJson(guardPath(cwd, runId)).counters['quality-cycles'].count, QUALITY_CAP);

      await completeThrough(runId, cwd, ['execute']);
      assert.equal(enterPhase(runId, 'verify', { cwd }).proceed, true);
      const exhausted = reattempt(runId, {
        reopen: ['execute', 'verify'], reason: 'quality_fail',
      }, { cwd });
      assert.equal(exhausted.allowed, false);
      assert.equal(exhausted.qualityCount, QUALITY_CAP);
      assert.equal(getPipelineState(runId, { cwd }).phases.verify.status, 'in_progress');
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('review markers are attempt-bound, idempotent, and gate trusted approval callbacks', async () => {
    const cwd = await makeTmpDir();
    try {
      const runId = 'run-review-marker-idempotent';
      initPipeline(runId, 'atlas', { cwd });
      await advanceToAttemptPhase(runId, 'atlas', cwd);
      assert.equal(beginAttempt(runId, { cwd }).allowed, true);
      await completeThrough(runId, cwd, ['execute', 'verify']);
      assert.equal(enterPhase(runId, 'review', { cwd }).proceed, true);

      let approvals = 0;
      const denied = withCurrentPhaseLoopTick(
        runId,
        'review',
        'review',
        () => { approvals += 1; },
        { cwd },
      );
      assert.equal(denied.ok, false);
      assert.equal(denied.reason, 'phase-loop-tick-required');
      assert.equal(approvals, 0);

      const first = loopTick(runId, 'review', { cwd });
      const duplicate = loopTick(runId, 'review', { cwd });
      assert.equal(first.allowed, true);
      assert.equal(first.count, 1);
      assert.equal(first.reused, undefined);
      assert.equal(duplicate.allowed, true);
      assert.equal(duplicate.count, 1);
      assert.equal(duplicate.reused, true);
      assert.equal(inspectCurrentPhaseLoop(runId, 'review', { cwd }).canTick, false);
      const approved = withCurrentPhaseLoopTick(
        runId,
        'review',
        'review',
        ({ _runLockOwner, pipeline }) => {
          approvals += 1;
          assert.equal(typeof _runLockOwner?.token, 'string');
          assert.equal(pipeline.phases.review.attempts, 1);
          return 'approved';
        },
        { cwd },
      );
      assert.equal(approved.ok, true);
      assert.equal(approved.result, 'approved');
      assert.equal(approvals, 1);
      assert.equal((await completeNoCheckpoint(runId, 'review', cwd)).ok, true);

      assert.equal(enterPhase(runId, 'finalize', { cwd }).proceed, true);
      const finalFirst = loopTick(runId, 'final-review', { cwd });
      const finalDuplicate = loopTick(runId, 'final-review', { cwd });
      assert.equal(finalFirst.count, 1);
      assert.equal(finalDuplicate.count, 1);
      assert.equal(finalDuplicate.reused, true);
      assert.equal((await completeNoCheckpoint(runId, 'finalize', cwd)).ok, true);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('every review re-entry must consume its own review-round tick', async () => {
    for (const orchestrator of ['atlas', 'athena']) {
      const cwd = await makeTmpDir();
      try {
        const runId = `run-review-tick-${orchestrator}`;
        initPipeline(runId, orchestrator, { cwd });
        await advanceToAttemptPhase(runId, orchestrator, cwd);
        assert.equal(beginAttempt(runId, { cwd }).allowed, true);
        const attemptPhase = orchestrator === 'atlas' ? 'execute' : 'integrate';
        enterPhase(runId, attemptPhase, { cwd });
        assert.equal((await completeNoCheckpoint(runId, attemptPhase, cwd)).ok, true);
        if (orchestrator === 'atlas') {
          enterPhase(runId, 'verify', { cwd });
          assert.equal((await completeNoCheckpoint(runId, 'verify', cwd)).ok, true);
        }
        enterPhase(runId, 'review', { cwd });
        const deniedBeforeTick = reattempt(runId, {
          reopen: [orchestrator === 'atlas' ? 'verify' : 'integrate'],
          reason: 'review_reject',
        }, { cwd });
        assert.equal(deniedBeforeTick.allowed, false);
        assert.equal(deniedBeforeTick.count, 1);
        assert.equal(loopTick(runId, 'review', { cwd }).count, 1);
        const reopenedPhase = orchestrator === 'atlas' ? 'verify' : 'integrate';
        assert.equal(reattempt(runId, {
          reopen: [reopenedPhase], reason: 'review_reject',
        }, { cwd }).allowed, true);
        enterPhase(runId, reopenedPhase, { cwd });
        assert.equal((await completeNoCheckpoint(runId, reopenedPhase, cwd)).ok, true);
        enterPhase(runId, 'review', { cwd });
        assert.equal(
          (await completeNoCheckpoint(runId, 'review', cwd)).ok,
          false,
          `${orchestrator} must not complete a second review attempt on the first round's tick`,
        );
        assert.equal(loopTick(runId, 'review', { cwd }).count, 2);
        assert.equal((await completeNoCheckpoint(runId, 'review', cwd)).ok, true);
      } finally {
        await removeTmpDir(cwd);
      }
    }
  });

  test('final review rejection rewinds through the orchestrator attempt phase', async () => {
    for (const orchestrator of ['atlas', 'athena']) {
      const cwd = await makeTmpDir();
      try {
        const runId = `run-final-reject-${orchestrator}`;
        const attemptPhase = orchestrator === 'atlas' ? 'execute' : 'integrate';
        const rewindPhase = orchestrator === 'atlas' ? 'verify' : 'integrate';
        initPipeline(runId, orchestrator, { cwd });
        await advanceToAttemptPhase(runId, orchestrator, cwd);
        assert.equal(beginAttempt(runId, { cwd }).allowed, true);
        const tail = orchestrator === 'atlas'
          ? [attemptPhase, 'verify', 'review']
          : [attemptPhase, 'review'];
        await completeThrough(runId, cwd, tail);
        enterPhase(runId, 'finalize', { cwd });
        const deniedBeforeTick = reattempt(runId, {
          reopen: [rewindPhase],
          reason: 'final_review_reject',
        }, { cwd });
        assert.equal(deniedBeforeTick.allowed, false, orchestrator);
        assert.equal(deniedBeforeTick.count, 1, orchestrator);
        assert.equal(loopTick(runId, 'final-review', { cwd }).allowed, true);

        const retry = reattempt(runId, {
          reopen: [rewindPhase],
          reason: 'final_review_reject',
        }, { cwd });
        assert.equal(retry.allowed, true, orchestrator);
        assert.deepEqual(retry.reopened, [rewindPhase], orchestrator);
        assert.equal(nextPhase(runId, { cwd }), rewindPhase, orchestrator);
      } finally {
        await removeTmpDir(cwd);
      }
    }
  });

  test('light-mode review reexecution durably recompletes execute and verify events', async () => {
    const cwd = await makeTmpDir();
    try {
      const runId = 'run-light-mode-review-reexec';
      initPipeline(runId, 'atlas', { cwd });
      await advanceToAttemptPhase(runId, 'atlas', cwd);
      assert.equal(beginAttempt(runId, { cwd }).count, 1);
      await completeThrough(runId, cwd, ['execute', 'verify']);
      assert.equal(enterPhase(runId, 'review', { cwd }).proceed, true);
      assert.equal(loopTick(runId, 'review', { cwd }).count, 1);

      const retried = reattempt(runId, {
        reopen: ['execute', 'verify'], reason: 'light_mode_reexec',
      }, { cwd });
      assert.equal(retried.allowed, true);
      assert.equal(retried.count, 2);
      assert.deepEqual(retried.reopened, ['execute', 'verify']);
      await completeThrough(runId, cwd, ['execute', 'verify']);
      assert.equal(enterPhase(runId, 'review', { cwd }).proceed, true);
      assert.equal(loopTick(runId, 'review', { cwd }).count, 2);
      assert.equal((await completeNoCheckpoint(runId, 'review', cwd)).ok, true);

      const completions = readEvents(cwd, runId)
        .filter(event => event.type === 'pipeline_phase_completed')
        .map(event => event.phase);
      assert.equal(completions.filter(phaseId => phaseId === 'execute').length, 2);
      assert.equal(completions.filter(phaseId => phaseId === 'verify').length, 2);
      assert.equal(completions.filter(phaseId => phaseId === 'review').length, 1);
      const ledger = readJson(pipelinePath(cwd, runId));
      assert.equal(ledger.phases.execute.status, 'completed');
      assert.equal(ledger.phases.verify.status, 'completed');
      assert.equal(ledger.phases.review.status, 'completed');
      assert.equal(ledger.reattemptReceipt.currentPhase, 'review');
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('three review rounds remain available without consuming the quality-failure cap', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-attempts', 'atlas', { cwd });
      await advanceToAttemptPhase('run-attempts', 'atlas', cwd);
      const first = beginAttempt('run-attempts', { cwd });
      assert.equal(first.allowed, true);
      assert.equal(first.count, 1);

      await completeThrough('run-attempts', cwd, ['execute', 'verify']);
      enterPhase('run-attempts', 'review', { cwd });

      const counts = [];
      for (let i = 0; i < 2; i++) {
        assert.equal(loopTick('run-attempts', 'review', { cwd }).count, i + 1);
        const r = reattempt('run-attempts', { reopen: ['verify'], reason: 'review_reject' }, { cwd });
        assert.equal(r.allowed, true);
        counts.push(r.count);
        assert.deepEqual(r.reopened, ['verify']);
        await completeThrough('run-attempts', cwd, ['verify']);
        enterPhase('run-attempts', 'review', { cwd });
      }
      assert.equal(loopTick('run-attempts', 'review', { cwd }).count, 3);
      assert.equal((await completeNoCheckpoint('run-attempts', 'review', cwd)).ok, true);
      assert.deepEqual(counts, [2, 3]);
      assert.equal(readJson(guardPath(cwd, 'run-attempts')).counters.iterations.count, 3);
      assert.equal(readJson(guardPath(cwd, 'run-attempts')).counters['quality-cycles'], undefined);
      assert.equal(readJson(pipelinePath(cwd, 'run-attempts')).attempt, 3);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('attempt mirror corruption fails closed before consuming cap or rewinding', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-mirror', 'atlas', { cwd });
      await advanceToAttemptPhase('run-mirror', 'atlas', cwd);
      assert.equal(beginAttempt('run-mirror', { cwd }).count, 1);
      const ledger = readJson(pipelinePath(cwd, 'run-mirror'));
      ledger.attempt = 999;
      writeFileSync(pipelinePath(cwd, 'run-mirror'), JSON.stringify(ledger, null, 2), { mode: 0o600 });

      await completeThrough('run-mirror', cwd, ['execute', 'verify']);
      enterPhase('run-mirror', 'review', { cwd });
      assert.equal(loopTick('run-mirror', 'review', { cwd }).allowed, true);

      const second = reattempt('run-mirror', { reopen: ['verify'], reason: 'review_reject' }, { cwd });
      assert.equal(second.allowed, false);
      assert.equal(second.degraded, true);
      assert.equal(second.count, 1);
      assert.equal(readJson(guardPath(cwd, 'run-mirror')).counters.iterations.count, 1);
      assert.equal(readJson(pipelinePath(cwd, 'run-mirror')).attempt, 999);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('ticks only at the code-defined attempt phase after all prior phases are terminal', async () => {
    const cwd = await makeTmpDir();
    try {
      for (const [orchestrator, attemptPhase] of [['atlas', 'execute'], ['athena', 'integrate']]) {
        const runId = `run-attempt-order-${orchestrator}`;
        initPipeline(runId, orchestrator, { cwd });

        const tooEarly = beginAttempt(runId, { cwd });
        assert.deepEqual(tooEarly, {
          allowed: false,
          count: 0,
          cap: 15,
          degraded: false,
        });
        assert.equal(existsSync(guardPath(cwd, runId)), false);

        await advanceToAttemptPhase(runId, orchestrator, cwd);
        assert.equal(nextPhase(runId, { cwd }), attemptPhase);
        const first = beginAttempt(runId, { cwd });
        assert.equal(first.allowed, true);
        assert.equal(first.count, 1);

        enterPhase(runId, attemptPhase, { cwd });
        await completeNoCheckpoint(runId, attemptPhase, cwd);
        const tooLate = beginAttempt(runId, { cwd });
        assert.equal(tooLate.allowed, false);
        assert.equal(tooLate.count, 1);
        assert.equal(readJson(guardPath(cwd, runId)).counters.iterations.count, 1);
      }
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('reattempt rejects early or forward rewinds without consuming the outer cap', async () => {
    const cwd = await makeTmpDir();
    try {
      const runId = 'run-invalid-reattempt';
      initPipeline(runId, 'atlas', { cwd });
      let callbackCalls = 0;
      const early = reattempt(
        runId,
        { reopen: ['verify'], reason: 'review_reject' },
        { cwd, _beforeRewind: () => { callbackCalls += 1; } },
      );
      assert.equal(early.allowed, false);
      assert.deepEqual(early.reopened, []);
      assert.equal(callbackCalls, 0);
      assert.equal(existsSync(guardPath(cwd, runId)), false);

      await advanceToAttemptPhase(runId, 'atlas', cwd);
      assert.equal(beginAttempt(runId, { cwd }).allowed, true);
      const future = reattempt(
        runId,
        { reopen: ['verify'], reason: 'review_reject' },
        { cwd, _beforeRewind: () => { callbackCalls += 1; } },
      );
      assert.equal(future.allowed, false);
      assert.deepEqual(future.reopened, []);
      assert.equal(callbackCalls, 0);
      assert.equal(readJson(guardPath(cwd, runId)).counters.iterations.count, 1);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('trusted rewind callback runs after preflight and before the single mutation', async () => {
    const cwd = await makeTmpDir();
    try {
      const runId = 'run-atomic-reattempt';
      initPipeline(runId, 'atlas', { cwd });
      await advanceToAttemptPhase(runId, 'atlas', cwd);
      assert.equal(beginAttempt(runId, { cwd }).count, 1);
      await completeThrough(runId, cwd, ['execute', 'verify']);
      enterPhase(runId, 'review', { cwd });
      assert.equal(loopTick(runId, 'review', { cwd }).allowed, true);

      const observations = [];
      const retry = reattempt(
        runId,
        { reopen: ['verify'], reason: 'review_reject' },
        {
          cwd,
          _beforeRewind: (context) => {
            observations.push({
              context,
              counter: readJson(guardPath(cwd, runId)).counters.iterations.count,
              attempt: readJson(pipelinePath(cwd, runId)).attempt,
            });
          },
        },
      );
      assert.equal(retry.allowed, true);
      assert.equal(retry.count, 2);
      assert.equal(observations.length, 1);
      assert.equal(observations[0].counter, 1);
      assert.equal(observations[0].attempt, 1);
      assert.equal(observations[0].context.nextAttempt, 2);
      assert.equal(readJson(guardPath(cwd, runId)).counters.iterations.count, 2);
      assert.equal(readJson(pipelinePath(cwd, runId)).attempt, 2);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('throwing rewind callback leaves the counter and pipeline ledger unchanged', async () => {
    const cwd = await makeTmpDir();
    try {
      const runId = 'run-atomic-reattempt-throw';
      initPipeline(runId, 'atlas', { cwd });
      await advanceToAttemptPhase(runId, 'atlas', cwd);
      assert.equal(beginAttempt(runId, { cwd }).count, 1);
      await completeThrough(runId, cwd, ['execute', 'verify']);
      enterPhase(runId, 'review', { cwd });
      assert.equal(loopTick(runId, 'review', { cwd }).allowed, true);
      const ledgerBefore = readFileSync(pipelinePath(cwd, runId), 'utf8');
      const guardBefore = readFileSync(guardPath(cwd, runId), 'utf8');

      const retry = reattempt(
        runId,
        { reopen: ['verify'], reason: 'review_reject' },
        { cwd, _beforeRewind: () => { throw new Error('CAS failed'); } },
      );
      assert.equal(retry.allowed, false);
      assert.equal(retry.degraded, true);
      assert.equal(readFileSync(pipelinePath(cwd, runId), 'utf8'), ledgerBefore);
      assert.equal(readFileSync(guardPath(cwd, runId), 'utf8'), guardBefore);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('quality-boundary crash resumes without consuming quality or PRD rollback twice', async () => {
    const cwd = await makeTmpDir();
    try {
      const runId = 'run-reattempt-crash-after-quality';
      const snapshotPath = path.join(cwd, 'latest-prd-snapshot.json');
      initPipeline(runId, 'atlas', { cwd });
      await advanceToAttemptPhase(runId, 'atlas', cwd);
      assert.equal(beginAttempt(runId, { cwd }).count, 1);
      await completeThrough(runId, cwd, ['execute']);
      assert.equal(enterPhase(runId, 'verify', { cwd }).proceed, true);

      let rollbackCalls = 0;
      const rollback = () => {
        rollbackCalls += 1;
        writeFileSync(snapshotPath, JSON.stringify({ generation: 7, passes: false }), { mode: 0o600 });
      };
      const interrupted = reattempt(runId, {
        reopen: ['execute', 'verify'], reason: 'quality_fail',
      }, {
        cwd,
        _beforeRewind: rollback,
        _afterReattemptBoundary: boundary => {
          if (boundary === 'quality') throw new Error('simulated crash after quality write');
        },
      });
      assert.equal(interrupted.allowed, false);
      assert.equal(interrupted.degraded, true);
      assert.equal(readJson(guardPath(cwd, runId)).counters['quality-cycles'].count, 1);
      assert.equal(readJson(guardPath(cwd, runId)).counters.iterations.count, 1);
      assert.equal(readJson(pipelinePath(cwd, runId)).attempt, 1);
      assert.equal(readJson(pipelinePath(cwd, runId)).pendingReattempt.targetAttempt, 2);
      assert.equal(rollbackCalls, 1);

      const resumed = reattempt(runId, {
        reopen: ['execute', 'verify'], reason: 'quality_fail',
      }, { cwd, _beforeRewind: rollback });
      assert.equal(resumed.allowed, true);
      assert.equal(resumed.count, 2);
      assert.equal(resumed.qualityCount, 1);
      assert.equal(rollbackCalls, 1, 'durable intent replay must not repeat the PRD rollback');
      assert.deepEqual(JSON.parse(readFileSync(snapshotPath, 'utf8')), {
        generation: 7,
        passes: false,
      });
      assert.equal(readJson(guardPath(cwd, runId)).counters['quality-cycles'].count, 1);
      assert.equal(readJson(guardPath(cwd, runId)).counters.iterations.count, 2);
      assert.equal(Object.hasOwn(readJson(pipelinePath(cwd, runId)), 'pendingReattempt'), false);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('iteration-boundary crash converges already-consumed counters with the pending ledger', async () => {
    const cwd = await makeTmpDir();
    try {
      const runId = 'run-reattempt-crash-after-iteration';
      initPipeline(runId, 'atlas', { cwd });
      await advanceToAttemptPhase(runId, 'atlas', cwd);
      assert.equal(beginAttempt(runId, { cwd }).count, 1);
      await completeThrough(runId, cwd, ['execute']);
      assert.equal(enterPhase(runId, 'verify', { cwd }).proceed, true);

      const interrupted = reattempt(runId, {
        reopen: ['execute', 'verify'], reason: 'quality_fail',
      }, {
        cwd,
        _afterReattemptBoundary: boundary => {
          if (boundary === 'iteration') throw new Error('simulated crash after iteration write');
        },
      });
      assert.equal(interrupted.allowed, false);
      assert.equal(interrupted.degraded, true);
      const guardAfterCrash = readJson(guardPath(cwd, runId));
      assert.equal(guardAfterCrash.counters['quality-cycles'].count, 1);
      assert.equal(guardAfterCrash.counters.iterations.count, 2);
      assert.equal(readJson(pipelinePath(cwd, runId)).attempt, 1);

      const resumed = reattempt(runId, {
        reopen: ['execute', 'verify'], reason: 'quality_fail',
      }, { cwd });
      assert.equal(resumed.allowed, true);
      assert.equal(resumed.count, 2);
      assert.equal(resumed.qualityCount, 1);
      const guardAfterResume = readJson(guardPath(cwd, runId));
      assert.equal(guardAfterResume.counters['quality-cycles'].count, 1);
      assert.equal(guardAfterResume.counters.iterations.count, 2);
      assert.equal(readJson(pipelinePath(cwd, runId)).attempt, 2);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('final pipeline rename failure leaves a recoverable intent and never double-charges counters', async () => {
    const cwd = await makeTmpDir();
    try {
      const runId = 'run-reattempt-final-rename-failure';
      initPipeline(runId, 'atlas', { cwd });
      await advanceToAttemptPhase(runId, 'atlas', cwd);
      assert.equal(beginAttempt(runId, { cwd }).count, 1);
      await completeThrough(runId, cwd, ['execute']);
      assert.equal(enterPhase(runId, 'verify', { cwd }).proceed, true);

      const writes = [];
      const interrupted = reattempt(runId, {
        reopen: ['execute', 'verify'], reason: 'quality_fail',
      }, {
        cwd,
        _writeReattemptLedger: ({ stage }, write) => {
          writes.push(stage);
          return stage === 'commit' ? false : write();
        },
      });
      assert.equal(interrupted.allowed, false);
      assert.equal(interrupted.reason, 'pipeline-commit-failed');
      assert.deepEqual(writes, ['prepare', 'commit']);
      assert.equal(readJson(guardPath(cwd, runId)).counters['quality-cycles'].count, 1);
      assert.equal(readJson(guardPath(cwd, runId)).counters.iterations.count, 2);
      const pendingLedger = readJson(pipelinePath(cwd, runId));
      assert.equal(pendingLedger.attempt, 1);
      assert.equal(pendingLedger.pendingReattempt.targetAttempt, 2);

      const resumed = reattempt(runId, {
        reopen: ['execute', 'verify'], reason: 'quality_fail',
      }, { cwd });
      assert.equal(resumed.allowed, true);
      assert.equal(resumed.count, 2);
      assert.equal(resumed.qualityCount, 1);
      assert.equal(readJson(guardPath(cwd, runId)).counters['quality-cycles'].count, 1);
      assert.equal(readJson(guardPath(cwd, runId)).counters.iterations.count, 2);
      assert.equal(Object.hasOwn(readJson(pipelinePath(cwd, runId)), 'pendingReattempt'), false);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('lost acknowledgement after a successful final rename replays the committed receipt', async () => {
    const cwd = await makeTmpDir();
    try {
      const runId = 'run-reattempt-lost-commit-ack';
      initPipeline(runId, 'atlas', { cwd });
      await advanceToAttemptPhase(runId, 'atlas', cwd);
      assert.equal(beginAttempt(runId, { cwd }).count, 1);
      await completeThrough(runId, cwd, ['execute']);
      assert.equal(enterPhase(runId, 'verify', { cwd }).proceed, true);

      let rollbackCalls = 0;
      const interrupted = reattempt(runId, {
        reopen: ['execute', 'verify'], reason: 'quality_fail',
      }, {
        cwd,
        _beforeRewind: () => { rollbackCalls += 1; },
        _writeReattemptLedger: ({ stage }, write) => {
          const written = write();
          return stage === 'commit' ? false : written;
        },
      });
      assert.equal(interrupted.allowed, false);
      const committed = readJson(pipelinePath(cwd, runId));
      assert.equal(committed.attempt, 2);
      assert.equal(committed.reattemptReceipt.targetAttempt, 2);
      assert.equal(Object.hasOwn(committed, 'pendingReattempt'), false);

      const replayed = reattempt(runId, {
        reopen: ['execute', 'verify'], reason: 'quality_fail',
      }, {
        cwd,
        _beforeRewind: () => { rollbackCalls += 1; },
      });
      assert.equal(replayed.allowed, true);
      assert.equal(replayed.reused, true);
      assert.equal(replayed.count, 2);
      assert.equal(replayed.qualityCount, 1);
      assert.equal(rollbackCalls, 1);
      assert.equal(readJson(guardPath(cwd, runId)).counters['quality-cycles'].count, 1);
      assert.equal(readJson(guardPath(cwd, runId)).counters.iterations.count, 2);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('a pending reattempt rejects different reason or reopen content without mutation', async () => {
    const cwd = await makeTmpDir();
    try {
      const runId = 'run-reattempt-pending-conflict';
      initPipeline(runId, 'atlas', { cwd });
      await advanceToAttemptPhase(runId, 'atlas', cwd);
      assert.equal(beginAttempt(runId, { cwd }).count, 1);
      await completeThrough(runId, cwd, ['execute']);
      assert.equal(enterPhase(runId, 'verify', { cwd }).proceed, true);
      reattempt(runId, {
        reopen: ['execute', 'verify'], reason: 'quality_fail',
      }, {
        cwd,
        _afterReattemptBoundary: boundary => {
          if (boundary === 'quality') throw new Error('leave pending intent');
        },
      });
      const ledgerBefore = readFileSync(pipelinePath(cwd, runId), 'utf8');
      const guardBefore = readFileSync(guardPath(cwd, runId), 'utf8');

      for (const request of [
        { reopen: ['execute', 'verify'], reason: 'review_reject' },
        { reopen: ['verify'], reason: 'quality_fail' },
      ]) {
        const conflict = reattempt(runId, request, { cwd });
        assert.equal(conflict.allowed, false);
        assert.equal(conflict.degraded, true);
        assert.equal(conflict.reason, 'pending-reattempt-conflict');
        assert.equal(readFileSync(pipelinePath(cwd, runId), 'utf8'), ledgerBefore);
        assert.equal(readFileSync(guardPath(cwd, runId), 'utf8'), guardBefore);
      }

      assert.equal(reattempt(runId, {
        reopen: ['execute', 'verify'], reason: 'quality_fail',
      }, { cwd }).allowed, true);
    } finally {
      await removeTmpDir(cwd);
    }
  });
});

describe('loopTick', () => {
  test('dispatches monitor and ci multi-cycle caps', async () => {
    const cwd = await makeTmpDir();
    try {
      const cases = [
        ['monitor', 10, 'athena'],
        ['ci', 2, 'atlas'],
      ];
      for (const [key, cap, orchestrator] of cases) {
        const runId = `run-${key}`;
        initPipeline(runId, orchestrator, { cwd });
        if (key === 'monitor') {
          await completeThrough(runId, cwd, ['triage', 'context', 'spec', 'plan', 'spawn']);
          enterPhase(runId, 'monitor', { cwd });
        } else {
          await advanceToAttemptPhase(runId, 'atlas', cwd);
          beginAttempt(runId, { cwd });
          await completeThrough(runId, cwd, ['execute']);
          await completeThrough(runId, cwd, ['verify']);
          await completeThrough(runId, cwd, ['review', 'finalize']);
          skipPhase(runId, 'ship', 'not-applicable', { cwd });
          enterPhase(runId, 'ci', { cwd });
        }
        const results = [];
        for (let i = 0; i < cap + 1; i++) results.push(loopTick(runId, key, { cwd }));
        assert.deepEqual(results.map(r => r.allowed), [...Array(cap).fill(true), false], `${key} allowed sequence`);
        assert.equal(results.at(-1).count, cap, `${key} count pinned at cap`);
      }
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('final review is idempotent per attempt and independently bounded', async () => {
    const cwd = await makeTmpDir();
    try {
      const runId = 'run-final-review';
      initPipeline(runId, 'atlas', { cwd });
      await advanceToAttemptPhase(runId, 'atlas', cwd);
      assert.equal(beginAttempt(runId, { cwd }).allowed, true);
      await completeThrough(runId, cwd, ['execute', 'verify', 'review']);
      enterPhase(runId, 'finalize', { cwd });

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const first = loopTick(runId, 'final-review', { cwd });
        const duplicate = loopTick(runId, 'final-review', { cwd });
        assert.equal(first.allowed, true);
        assert.equal(first.count, attempt);
        assert.equal(duplicate.allowed, true);
        assert.equal(duplicate.count, attempt);
        assert.equal(duplicate.reused, true);
        if (attempt < 2) {
          assert.equal(reattempt(runId, {
            reopen: ['verify'], reason: 'final_review_reject',
          }, { cwd }).allowed, true);
          await completeThrough(runId, cwd, ['verify', 'review']);
          assert.equal(enterPhase(runId, 'finalize', { cwd }).proceed, true);
        }
      }
      assert.equal(readJson(guardPath(cwd, runId)).counters.finalReviewRounds.count, 2);
      assert.equal(readJson(guardPath(cwd, runId)).counters.reviewRounds.count, 2);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('resolves phase ids to descriptor loop guards', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-phase-loop', 'athena', { cwd });
      await completeThrough('run-phase-loop', cwd, ['triage', 'context', 'spec', 'plan', 'spawn']);
      enterPhase('run-phase-loop', 'monitor', { cwd });
      for (let i = 0; i < 10; i++) assert.equal(loopTick('run-phase-loop', 'monitor', { cwd }).allowed, true);
      const blocked = loopTick('run-phase-loop', 'monitor', { cwd });
      assert.equal(blocked.allowed, false);
      assert.equal(blocked.cap, 10);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('cannot prefill loop counters outside their active phase', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-loop-order', 'athena', { cwd });
      const blocked = loopTick('run-loop-order', 'monitor', { cwd });
      assert.equal(blocked.allowed, false);
      assert.equal(blocked.reason, 'phase-not-in-progress');
      assert.equal(existsSync(guardPath(cwd, 'run-loop-order')), false);
    } finally {
      await removeTmpDir(cwd);
    }
  });
});

describe('recordPhaseError', () => {
  test('escalates on the 3rd matching error signature', async () => {
    const cwd = await makeTmpDir();
    try {
      const a = recordPhaseError('run-errors', 'verify', 'TypeError at app.js:10', { cwd });
      const b = recordPhaseError('run-errors', 'verify', 'TypeError at app.js:12', { cwd });
      const c = recordPhaseError('run-errors', 'verify', 'TypeError at app.js:99', { cwd });
      assert.deepEqual([a.repeatCount, b.repeatCount, c.repeatCount], [1, 2, 3]);
      assert.deepEqual([a.shouldEscalate, b.shouldEscalate, c.shouldEscalate], [false, false, true]);
      assert.equal(c.threshold, 3);
    } finally {
      await removeTmpDir(cwd);
    }
  });
});

// ---------------------------------------------------------------------------
// Explicit terminal failure
// ---------------------------------------------------------------------------

describe('failPhase', () => {
  test('repairs a trailing torn event and terminalizes the active phase exactly once', async () => {
    const cwd = await makeTmpDir();
    try {
      const runId = 'run-torn-failure-event';
      initPipeline(runId, 'atlas', { cwd });
      enterPhase(runId, 'triage', { cwd });
      writeFileSync(eventsPath(cwd, runId), '{"type":"torn"', { mode: 0o600 });

      assert.deepEqual(failPhase(runId, 'triage', 'plan_validation_failed', { cwd }), {
        ok: true, idempotent: false, degraded: false,
      });
      assert.deepEqual(failPhase(runId, 'triage', 'plan_validation_failed', { cwd }), {
        ok: true, idempotent: true, degraded: false,
      });

      const raw = readFileSync(eventsPath(cwd, runId), 'utf8');
      assert.match(raw, /^\{"type":"torn"\n\{/,
        'a missing LF must be repaired before the next JSONL record');
      assert.equal(readValidEvents(cwd, runId)
        .filter(event => event.type === 'pipeline_phase_failed').length, 1);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('fails only the exact active phase and is idempotent for the same code', async () => {
    const cwd = await makeTmpDir();
    try {
      const runId = 'run-explicit-failure';
      initPipeline(runId, 'atlas', { cwd });
      enterPhase(runId, 'triage', { cwd });
      assert.deepEqual(failPhase(runId, 'context', 'plan_validation_failed', { cwd }), {
        ok: false, idempotent: false, degraded: false,
      });
      const first = failPhase(runId, 'triage', 'plan_validation_failed', { cwd });
      assert.deepEqual(first, { ok: true, idempotent: false, degraded: false });
      const ledger = readJson(pipelinePath(cwd, runId));
      assert.equal(ledger.phases.triage.status, 'failed');
      assert.equal(ledger.phases.triage.failureCode, 'plan_validation_failed');
      assert.equal(typeof ledger.phases.triage.failedAt, 'string');
      assert.equal(ledger.phases.context.status, 'pending');
      assert.deepEqual(failPhase(runId, 'triage', 'plan_validation_failed', { cwd }), {
        ok: true, idempotent: true, degraded: false,
      });
      assert.deepEqual(failPhase(runId, 'triage', 'phase_guard_exhausted', { cwd }), {
        ok: false, idempotent: false, degraded: false,
      });
      assert.deepEqual(enterPhase(runId, 'triage', { cwd }), {
        proceed: false,
        skip: false,
        reason: 'terminal-failure',
        status: 'failed',
        degraded: false,
      });
      assert.equal((await completeNoCheckpoint(runId, 'triage', cwd)).ok, false);
      assert.equal(
        readEvents(cwd, runId).filter(event => event.type === 'pipeline_phase_failed').length,
        1,
      );
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('fails closed for missing/corrupt ledgers and non-progress phases', async () => {
    const cwd = await makeTmpDir();
    try {
      assert.equal(failPhase('missing', 'triage', 'plan_validation_failed', { cwd }).ok, false);
      initPipeline('pending', 'atlas', { cwd });
      assert.equal(failPhase('pending', 'triage', 'plan_validation_failed', { cwd }).ok, false);
      assert.equal(failPhase('pending', 'triage', 'raw error text', { cwd }).ok, false);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('terminal marker freezes every public pipeline mutator', async () => {
    const cwd = await makeTmpDir();
    try {
      const runId = 'run-terminal-freeze';
      initPipeline(runId, 'atlas', { cwd });
      enterPhase(runId, 'triage', { cwd });
      writeFileSync(path.join(cwd, '.ao', 'artifacts', 'runs', runId, 'terminal-failure.json'), '{}', { mode: 0o600 });
      assert.equal(enterPhase(runId, 'triage', { cwd }).reason, 'run-terminal');
      assert.equal(beginAttempt(runId, { cwd }).allowed, false);
      assert.equal(loopTick(runId, 'review', { cwd }).allowed, false);
      assert.equal(recordPhaseOutputs(runId, 'triage', { x: 1 }, { cwd }).ok, false);
      assert.equal((await completeNoCheckpoint(runId, 'triage', cwd)).ok, false);
      assert.equal(skipPhase(runId, 'triage', 'trivial', { cwd }).ok, false);
      assert.equal(reopenPhase(runId, 'plan', { reason: 'light_mode_rewind' }, { cwd }).ok, false);
      assert.equal(initPipeline(runId, 'atlas', { cwd }).ok, false);
      assert.equal(getPipelineState(runId, { cwd }).phases.triage.status, 'in_progress');
    } finally {
      await removeTmpDir(cwd);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase completion, events, skips, reopens
// ---------------------------------------------------------------------------

describe('completePhase', () => {
  test('skips torn middle/trailing records and appends one durable completion event', async () => {
    const cwd = await makeTmpDir();
    try {
      const runId = 'run-torn-completion-event';
      initPipeline(runId, 'atlas', { cwd });
      enterPhase(runId, 'triage', { cwd });
      const before = { type: 'diagnostic', detail: { position: 'before' } };
      const after = { type: 'diagnostic', detail: { position: 'after' } };
      writeFileSync(eventsPath(cwd, runId), [
        JSON.stringify(before),
        '{"type":broken}',
        JSON.stringify(after),
        '{"type":"trailing"',
      ].join('\n'), { mode: 0o600 });

      assert.equal((await completeNoCheckpoint(runId, 'triage', cwd)).ok, true);
      assert.equal((await completeNoCheckpoint(runId, 'triage', cwd)).ok, true);

      const events = readValidEvents(cwd, runId);
      assert.deepEqual(events.filter(event => event.type === 'diagnostic'), [before, after],
        'valid records after a damaged line must remain visible');
      assert.equal(events.filter(event => event.type === 'pipeline_phase_completed').length, 1);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('rejects pending, future, and already-terminal completion on a valid ledger', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-complete-order', 'atlas', { cwd });

      const pending = await completeNoCheckpoint('run-complete-order', 'triage', cwd);
      assert.equal(pending.ok, false);
      assert.equal(pending.next, 'triage');

      enterPhase('run-complete-order', 'triage', { cwd });
      const future = await completeNoCheckpoint('run-complete-order', 'context', cwd);
      assert.equal(future.ok, false);
      assert.equal(future.next, 'triage');
      assert.equal(readJson(pipelinePath(cwd, 'run-complete-order')).phases.context.status, 'pending');

      assert.equal((await completeNoCheckpoint('run-complete-order', 'triage', cwd)).ok, true);
      enterPhase('run-complete-order', 'context', { cwd });
      const reverse = await completeNoCheckpoint('run-complete-order', 'triage', cwd);
      assert.equal(reverse.ok, true, 'same completed phase is an idempotent event-repair boundary');
      assert.equal(reverse.next, 'context');
      assert.equal(
        readEvents(cwd, 'run-complete-order').filter(e => e.type === 'pipeline_phase_completed').length,
        1,
      );
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('writes ledger and pipeline event before injected saveCheckpoint', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-complete', 'atlas', { cwd });
      enterPhase('run-complete', 'triage', { cwd });
      const order = [];
      const result = await completePhase('run-complete', 'triage', { storyCount: 1 }, {
        cwd,
        _saveCheckpoint: async (orchestrator, payload, checkpointOpts) => {
          order.push('checkpoint');
          assert.equal(orchestrator, 'atlas');
          assert.equal(payload.phase, 0);
          assert.equal(typeof checkpointOpts._runLockOwner?.token, 'string');
          assert.equal(readJson(pipelinePath(cwd, 'run-complete')).phases.triage.status, 'completed');
          assert.equal(readEvents(cwd, 'run-complete').filter(e => e.type === 'pipeline_phase_completed').length, 1);
          return { ok: true, degraded: false };
        },
      });

      assert.equal(result.ok, true);
      assert.equal(result.next, 'context');
      assert.equal(result.checkpointDegraded, false);
      assert.deepEqual(order, ['checkpoint']);
      const events = readEvents(cwd, 'run-complete');
      assert.equal(events.filter(e => e.type === 'pipeline_phase_completed').length, 1);
      assert.equal(events.filter(e => e.type === 'phase_transition').length, 0);
      assert.equal(events.filter(e => e.type === 'checkpoint_saved').length, 0);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('real checkpoint events reuse the phase transition lock without re-entry failure', async () => {
    const cwd = await makeTmpDir();
    try {
      const base = path.join(cwd, '.ao', 'artifacts', 'runs');
      const stateDir = path.join(cwd, '.ao', 'state');
      const { runId } = createRun('atlas', 'checkpoint under transition lock', {
        base,
        stateDir,
      });
      assert.equal(initPipeline(runId, 'atlas', { cwd }).ok, true);
      assert.equal(enterPhase(runId, 'triage', { cwd }).proceed, true);

      const result = await completePhase(runId, 'triage', { storyCount: 1 }, { cwd });
      assert.equal(result.ok, true);
      assert.equal(result.checkpointDegraded, false);
      const eventTypes = readEvents(cwd, runId).map(event => event.type);
      assert.deepEqual(eventTypes, [
        'pipeline_phase_completed',
        'phase_transition',
        'checkpoint_saved',
      ]);
      assert.equal(existsSync(path.join(
        cwd, '.ao', 'artifacts', 'runs', runId, '.terminal-failure.lock',
      )), false);
      assert.equal(readJson(path.join(stateDir, 'checkpoint-atlas.json')).runId, runId);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('simulated crash between ledger and checkpoint leaves ledger authoritative', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-crash', 'atlas', { cwd });
      enterPhase('run-crash', 'triage', { cwd });
      const result = await completePhase('run-crash', 'triage', undefined, {
        cwd,
        _saveCheckpoint: async () => {
          throw new Error('checkpoint crash');
        },
      });
      assert.equal(result.ok, true);
      assert.equal(result.checkpointDegraded, true);
      assert.equal(readJson(pipelinePath(cwd, 'run-crash')).phases.triage.status, 'completed');
      assert.equal(initPipeline('run-crash', 'atlas', { cwd }).resumePhase, 'context');
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('recover phases checkpoint before completion and remain resumable on checkpoint degradation', async () => {
    const cwd = await makeTmpDir();
    try {
      const phases = ['spawn', 'monitor', 'integrate'];
      for (const phaseId of phases) {
        const runId = `run-recover-durability-${phaseId}`;
        initPipeline(runId, 'athena', { cwd });
        const sequence = getPhaseSequence('athena').map(p => p.id);
        const prior = sequence.slice(0, sequence.indexOf(phaseId));
        await completeThrough(runId, cwd, prior);
        if (phaseId === 'integrate') {
          const attempt = beginAttempt(runId, { cwd });
          assert.equal(attempt.allowed, true);
        }
        enterPhase(runId, phaseId, { cwd });
        if (phaseId === 'monitor') {
          assert.equal(loopTick(runId, 'monitor', { cwd }).allowed, true);
        }
        if (phaseId === 'integrate') {
          assert.equal(loopTick(runId, 'quality', { cwd }).allowed, true);
        }
        if (phaseId === 'spawn') {
          assert.equal(recordPhaseOutputs(runId, phaseId, { teamSlug: 'durable-team' }, { cwd }).ok, true);
        }

        const eventsBefore = readEvents(cwd, runId).filter(e => e.type === 'pipeline_phase_completed').length;
        const failed = await completePhase(runId, phaseId, { durable: true }, {
          cwd,
          _saveCheckpoint: async () => {
            assert.equal(readJson(pipelinePath(cwd, runId)).phases[phaseId].status, 'in_progress');
            assert.equal(
              readEvents(cwd, runId).filter(e => e.type === 'pipeline_phase_completed').length,
              eventsBefore,
            );
            if (phaseId === 'spawn') return { ok: false, degraded: false };
            if (phaseId === 'monitor') return { ok: true, degraded: true };
            throw new Error('simulated checkpoint write failure');
          },
        });

        assert.equal(failed.ok, false);
        assert.equal(failed.checkpointDegraded, true);
        assert.equal(readJson(pipelinePath(cwd, runId)).phases[phaseId].status, 'in_progress');
        assert.equal(
          readEvents(cwd, runId).filter(e => e.type === 'pipeline_phase_completed').length,
          eventsBefore,
        );
        const resumed = initPipeline(runId, 'athena', { cwd });
        assert.equal(resumed.resumePhase, phaseId);
        assert.equal(resumed.resumePolicy, 'recover');
      }
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('recover completion holds the shared transition lock across checkpoint await', async () => {
    const cwd = await makeTmpDir();
    try {
      const runId = 'run-checkpoint-transition-lock';
      initPipeline(runId, 'athena', { cwd });
      await completeThrough(runId, cwd, ['triage', 'context', 'spec', 'plan']);
      enterPhase(runId, 'spawn', { cwd });
      const result = await completePhase(runId, 'spawn', undefined, {
        cwd,
        _saveCheckpoint: async () => {
          const racingFailure = failPhase(
            runId, 'spawn', 'recovery_state_invalid', { cwd },
          );
          assert.equal(racingFailure.ok, false);
          assert.equal(racingFailure.degraded, true);
          return { ok: true, degraded: false };
        },
      });
      assert.equal(result.ok, true);
      assert.equal(getPipelineState(runId, { cwd }).phases.spawn.status, 'completed');
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('recover phase emits completion only after a durable checkpoint succeeds', async () => {
    const cwd = await makeTmpDir();
    try {
      const runId = 'run-recover-checkpoint-first';
      initPipeline(runId, 'athena', { cwd });
      await completeThrough(runId, cwd, ['triage', 'context', 'spec', 'plan']);
      enterPhase(runId, 'spawn', { cwd });

      const result = await completePhase(runId, 'spawn', { teamSlug: 'checkpoint-first' }, {
        cwd,
        _saveCheckpoint: async () => {
          assert.equal(readJson(pipelinePath(cwd, runId)).phases.spawn.status, 'in_progress');
          assert.equal(
            readEvents(cwd, runId).some(e => e.type === 'pipeline_phase_completed' && e.phase === 'spawn'),
            false,
          );
          return { ok: true, degraded: false };
        },
      });
      assert.equal(result.ok, true);
      assert.equal(result.checkpointDegraded, false);
      assert.equal(readJson(pipelinePath(cwd, runId)).phases.spawn.status, 'completed');
      assert.equal(
        readEvents(cwd, runId).filter(e => e.type === 'pipeline_phase_completed' && e.phase === 'spawn').length,
        1,
      );
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('outputs are scalars-only and capped around 4KB', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-outputs', 'atlas', { cwd });
      enterPhase('run-outputs', 'triage', { cwd });
      await completeNoCheckpoint('run-outputs', 'triage', cwd, {
        ok: true,
        count: 3,
        nested: { dropped: true },
        list: ['dropped'],
        huge: 'x'.repeat(9000),
      });
      const outputs = readJson(pipelinePath(cwd, 'run-outputs')).phases.triage.outputs;
      assert.equal(outputs.truncated, true);
      assert.equal(typeof outputs.tail, 'string');
      assert.ok(Buffer.byteLength(JSON.stringify(outputs), 'utf-8') <= 4096);
      assert.equal(outputs.tail.includes('x'.repeat(20)), true);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('trusted completion evidence is derived under the phase lock after traversal checks', async () => {
    const cwd = await makeTmpDir();
    try {
      const runId = 'run-derived-completion';
      initPipeline(runId, 'atlas', { cwd });
      let calls = 0;
      const denied = await completePhase(runId, 'triage', undefined, {
        cwd,
        saveCheckpoint: false,
        _deriveOutputs: () => { calls += 1; return { proof: 'too-early' }; },
      });
      assert.equal(denied.ok, false);
      assert.equal(calls, 0);

      enterPhase(runId, 'triage', { cwd });
      const completed = await completePhase(runId, 'triage', undefined, {
        cwd,
        saveCheckpoint: false,
        _deriveOutputs: (context) => {
          calls += 1;
          assert.equal(context.phaseId, 'triage');
          assert.equal(context.attempt, 0);
          assert.equal(context.phaseAttempt, 1);
          assert.equal(Number.isFinite(Date.parse(context.phaseStartedAt)), true);
          return { proof: 'git-bound' };
        },
      });
      assert.equal(completed.ok, true);
      assert.equal(calls, 1);
      assert.deepEqual(getPipelineState(runId, { cwd }).phases.triage.outputs, {
        proof: 'git-bound',
      });
    } finally {
      await removeTmpDir(cwd);
    }
  });
});

describe('recordPhaseOutputs', () => {
  test('repairs a torn log while recording recovery outputs exactly once', async () => {
    const cwd = await makeTmpDir();
    try {
      const runId = 'run-torn-output-event';
      initPipeline(runId, 'athena', { cwd });
      await completeThrough(runId, cwd, ['triage', 'context', 'spec', 'plan']);
      enterPhase(runId, 'spawn', { cwd });
      writeFileSync(eventsPath(cwd, runId), '{"type":"torn"', { mode: 0o600 });

      const outputs = { teamSlug: 'recoverable-team' };
      assert.deepEqual(recordPhaseOutputs(runId, 'spawn', outputs, { cwd }), {
        ok: true, degraded: false,
      });
      assert.deepEqual(recordPhaseOutputs(runId, 'spawn', outputs, { cwd }), {
        ok: true, degraded: false,
      });
      assert.equal(readValidEvents(cwd, runId)
        .filter(event => event.type === 'pipeline_phase_outputs_recorded').length, 1);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('persists bounded recovery identity without completing the phase', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-spawn-output', 'athena', { cwd });
      assert.deepEqual(
        recordPhaseOutputs('run-spawn-output', 'spawn', { teamSlug: 'too-early' }, { cwd }),
        { ok: false, degraded: false },
      );
      enterPhase('run-spawn-output', 'triage', { cwd });
      assert.deepEqual(
        recordPhaseOutputs('run-spawn-output', 'triage', { teamSlug: 'wrong-phase' }, { cwd }),
        { ok: false, degraded: false },
      );

      await completeThrough('run-spawn-output', cwd, ['triage', 'context', 'spec', 'plan']);
      enterPhase('run-spawn-output', 'spawn', { cwd });
      const recorded = recordPhaseOutputs('run-spawn-output', 'spawn', {
        teamSlug: 'athena-recovery',
        intendedWorkers: 'api,test',
      }, { cwd });
      assert.deepEqual(recorded, { ok: true, degraded: false });

      const inProgress = readJson(pipelinePath(cwd, 'run-spawn-output')).phases.spawn;
      assert.equal(inProgress.status, 'in_progress');
      assert.deepEqual(inProgress.outputs, {
        teamSlug: 'athena-recovery',
        intendedWorkers: 'api,test',
      });
      assert.equal(
        readEvents(cwd, 'run-spawn-output').at(-1).type,
        'pipeline_phase_outputs_recorded',
      );

      const nestedRejected = recordPhaseOutputs('run-spawn-output', 'spawn', {
        nested: { rejected: true },
      }, { cwd });
      assert.deepEqual(nestedRejected, { ok: false, degraded: false });
      assert.deepEqual(
        recordPhaseOutputs('run-spawn-output', 'spawn', [], { cwd }),
        { ok: false, degraded: false },
      );
      const oversizedRejected = recordPhaseOutputs('run-spawn-output', 'spawn', {
        huge: 'x'.repeat(5000),
      }, { cwd });
      assert.deepEqual(oversizedRejected, { ok: false, degraded: false });
      assert.equal(
        readJson(pipelinePath(cwd, 'run-spawn-output')).phases.spawn.outputs.teamSlug,
        'athena-recovery',
      );

      await completeNoCheckpoint('run-spawn-output', 'spawn', cwd, { spawnPath: 'adapter' });
      const completed = readJson(pipelinePath(cwd, 'run-spawn-output')).phases.spawn;
      assert.equal(completed.status, 'completed');
      assert.deepEqual(completed.outputs, {
        teamSlug: 'athena-recovery',
        intendedWorkers: 'api,test',
        spawnPath: 'adapter',
      });

      initPipeline('run-spawn-overflow', 'athena', { cwd });
      await completeThrough('run-spawn-overflow', cwd, ['triage', 'context', 'spec', 'plan']);
      enterPhase('run-spawn-overflow', 'spawn', { cwd });
      assert.equal(recordPhaseOutputs('run-spawn-overflow', 'spawn', {
        teamSlug: 'athena-overflow',
      }, { cwd }).ok, true);
      const overflow = await completeNoCheckpoint('run-spawn-overflow', 'spawn', cwd, {
        huge: 'x'.repeat(5000),
      });
      assert.equal(overflow.ok, false);
      assert.equal(
        readJson(pipelinePath(cwd, 'run-spawn-overflow')).phases.spawn.status,
        'in_progress',
      );

      initPipeline('run-spawn-direct-overflow', 'athena', { cwd });
      await completeThrough('run-spawn-direct-overflow', cwd, ['triage', 'context', 'spec', 'plan']);
      enterPhase('run-spawn-direct-overflow', 'spawn', { cwd });
      const directOverflow = await completeNoCheckpoint('run-spawn-direct-overflow', 'spawn', cwd, {
        huge: 'x'.repeat(5000),
      });
      assert.equal(directOverflow.ok, false);
      assert.equal(
        readJson(pipelinePath(cwd, 'run-spawn-direct-overflow')).phases.spawn.status,
        'in_progress',
      );
    } finally {
      await removeTmpDir(cwd);
    }
  });
});

describe('skipPhase and reopenPhase', () => {
  test('runs a synchronous skip boundary under the transition lock before mutation', async () => {
    const cwd = await makeTmpDir();
    try {
      const runId = 'run-skip-boundary';
      initPipeline(runId, 'atlas', { cwd });
      assert.equal(enterPhase(runId, 'triage', { cwd }).proceed, true);
      assert.equal((await completeNoCheckpoint(runId, 'triage', cwd)).ok, true);
      const before = readJson(pipelinePath(cwd, runId));
      let observed = null;
      assert.deepEqual(skipPhase(runId, 'context', 'trivial', {
        cwd,
        _validateSkip: (boundary) => {
          observed = boundary;
          throw new Error('deny skip');
        },
      }), { ok: false, next: null, degraded: true });
      assert.equal(observed.phaseId, 'context');
      assert.equal(observed.reason, 'trivial');
      assert.equal(observed.pipeline.phases.context.status, 'pending');
      assert.deepEqual(readJson(pipelinePath(cwd, runId)), before);

      const skipped = skipPhase(runId, 'context', 'trivial', {
        cwd,
        _validateSkip: ({ pipeline }) => {
          assert.equal(pipeline.phases.context.status, 'pending');
          return true;
        },
      });
      assert.equal(skipped.ok, true);
      assert.equal(getPipelineState(runId, { cwd }).phases.context.status, 'skipped');
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('skipPhase rejects future skips and advances only when the current phase is skipped', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-skip-order', 'atlas', { cwd });
      enterPhase('run-skip-order', 'triage', { cwd });
      const future = skipPhase('run-skip-order', 'context', 'trivial', { cwd });
      assert.deepEqual(future, { ok: false, next: 'triage', degraded: false });
      assert.equal(readJson(pipelinePath(cwd, 'run-skip-order')).phases.context.status, 'pending');

      await completeNoCheckpoint('run-skip-order', 'triage', cwd);
      const current = skipPhase('run-skip-order', 'context', 'trivial', { cwd });
      assert.equal(current.ok, true);
      assert.equal(current.next, 'spec');
      assert.equal(skipPhase('run-skip-order', 'plan', 'trivial', { cwd }).ok, false);
      assert.equal(skipPhase('run-skip-order', 'spec', 'trivial', { cwd }).ok, true);
      assert.equal(skipPhase('run-skip-order', 'plan', 'trivial', { cwd }).ok, true);
      assert.equal(nextPhase('run-skip-order', { cwd }), 'execute');
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('skipPhase rejects core phases and unapproved reasons even in current order', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-skip-policy', 'athena', { cwd });
      assert.equal(skipPhase('run-skip-policy', 'triage', 'forged', { cwd }).ok, false);
      assert.equal(nextPhase('run-skip-policy', { cwd }), 'triage');

      initPipeline('run-skip-reason', 'atlas', { cwd });
      await completeThrough('run-skip-reason', cwd, ['triage']);
      assert.equal(skipPhase('run-skip-reason', 'context', 'forged', { cwd }).ok, false);
      assert.equal(skipPhase('run-skip-reason', 'context', 'trivial', { cwd }).ok, true);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('skipPhase marks optional phases skipped and resume does not re-evaluate them', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-skip', 'atlas', { cwd });
      await completeThrough('run-skip', cwd, ['triage']);
      skipPhase('run-skip', 'context', 'trivial', { cwd });
      skipPhase('run-skip', 'spec', 'trivial', { cwd });
      skipPhase('run-skip', 'plan', 'trivial', { cwd });
      const resumed = initPipeline('run-skip', 'atlas', { cwd });
      assert.equal(resumed.resumePhase, 'execute');
      assert.deepEqual(resumed.completed, ['triage', 'context', 'spec', 'plan']);
      assert.equal(enterPhase('run-skip', 'context', { cwd }).skip, true);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('reopenPhase is allowed only for reopenableFor and does not tick the 15-cap', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-reopen', 'atlas', { cwd });
      const tooEarly = reopenPhase('run-reopen', 'plan', { reason: 'light_mode_rewind' }, { cwd });
      assert.equal(tooEarly.ok, true);
      assert.equal(tooEarly.rejected, true);
      await advanceToAttemptPhase('run-reopen', 'atlas', cwd);
      beginAttempt('run-reopen', { cwd });
      const allowed = reopenPhase('run-reopen', 'plan', { reason: 'light_mode_rewind' }, { cwd });
      assert.equal(allowed.ok, true);
      assert.equal(allowed.rejected, false);
      assert.equal(readJson(pipelinePath(cwd, 'run-reopen')).phases.plan.status, 'pending');
      assert.equal(readJson(guardPath(cwd, 'run-reopen')).counters.iterations.count, 1);

      const rejected = reopenPhase('run-reopen', 'plan', { reason: 'review_reject' }, { cwd });
      assert.equal(rejected.ok, true);
      assert.equal(rejected.rejected, true);
      assert.equal(readJson(guardPath(cwd, 'run-reopen')).counters.iterations.count, 1);

      initPipeline('run-current-reopen', 'atlas', { cwd });
      await completeThrough('run-current-reopen', cwd, ['triage', 'context', 'spec']);
      enterPhase('run-current-reopen', 'plan', { cwd });
      const current = reopenPhase('run-current-reopen', 'plan', { reason: 'light_mode_rewind' }, { cwd });
      assert.equal(current.ok, true);
      assert.equal(current.rejected, false);
      assert.equal(nextPhase('run-current-reopen', { cwd }), 'plan');
    } finally {
      await removeTmpDir(cwd);
    }
  });
});

// ---------------------------------------------------------------------------
// Resume, schema fail-safe, isolation
// ---------------------------------------------------------------------------

describe('resume semantics', () => {
  test('in_progress verify resumes at verify and earlier phases skip', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-resume', 'atlas', { cwd });
      await completeThrough('run-resume', cwd, ['triage', 'context', 'spec', 'plan', 'execute']);
      enterPhase('run-resume', 'verify', { cwd });

      const resumed = initPipeline('run-resume', 'atlas', { cwd });
      assert.equal(resumed.resumePhase, 'verify');
      assert.equal(resumed.resumePolicy, 'reexecute');
      assert.equal(enterPhase('run-resume', 'execute', { cwd }).skip, true);
      assert.equal(nextPhase('run-resume', { cwd }), 'verify');
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('recover phase in_progress reports resumePolicy recover', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-recover-policy', 'athena', { cwd });
      await completeThrough('run-recover-policy', cwd, ['triage', 'context', 'spec', 'plan']);
      enterPhase('run-recover-policy', 'spawn', { cwd });
      const resumed = initPipeline('run-recover-policy', 'athena', { cwd });
      assert.equal(resumed.resumePhase, 'spawn');
      assert.equal(resumed.resumePolicy, 'recover');
    } finally {
      await removeTmpDir(cwd);
    }
  });
});

describe('schemaVersion and corrupt-file fail-safe', () => {
  test('future schemaVersion is never overwritten or reset', async () => {
    const cwd = await makeTmpDir();
    try {
      const p = pipelinePath(cwd, 'run-future');
      mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
      const bytes = JSON.stringify({
        schemaVersion: 99,
        orchestrator: 'atlas',
        phases: { triage: { status: 'completed' } },
      });
      writeFileSync(p, bytes, { mode: 0o600 });
      const r = initPipeline('run-future', 'atlas', { cwd });
      assert.deepEqual(r, {
        ok: false,
        resumePhase: null,
        resumePolicy: null,
        completed: [],
        degraded: true,
      });
      assert.equal(readFileSync(p, 'utf-8'), bytes);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('garbage JSON and structurally corrupt payloads remain byte-for-byte untouched', async () => {
    const cwd = await makeTmpDir();
    try {
      const garbage = pipelinePath(cwd, 'run-garbage');
      mkdirSync(path.dirname(garbage), { recursive: true, mode: 0o700 });
      const garbageBytes = '{not-json';
      writeFileSync(garbage, garbageBytes, { mode: 0o600 });
      const g = initPipeline('run-garbage', 'atlas', { cwd });
      assert.deepEqual(g, {
        ok: false,
        resumePhase: null,
        resumePolicy: null,
        completed: [],
        degraded: true,
      });
      assert.equal(readFileSync(garbage, 'utf-8'), garbageBytes);

      const arr = pipelinePath(cwd, 'run-array');
      mkdirSync(path.dirname(arr), { recursive: true, mode: 0o700 });
      const arrayBytes = '[1,2,3]';
      writeFileSync(arr, arrayBytes, { mode: 0o600 });
      const a = initPipeline('run-array', 'atlas', { cwd });
      assert.deepEqual(a, {
        ok: false,
        resumePhase: null,
        resumePolicy: null,
        completed: [],
        degraded: true,
      });
      assert.equal(readFileSync(arr, 'utf-8'), arrayBytes);

      const object = pipelinePath(cwd, 'run-object');
      mkdirSync(path.dirname(object), { recursive: true, mode: 0o700 });
      const objectBytes = '{"schemaVersion":1,"orchestrator":"atlas","attempt":0,"phases":{}}';
      writeFileSync(object, objectBytes, { mode: 0o600 });
      const o = initPipeline('run-object', 'atlas', { cwd });
      assert.deepEqual(o, {
        ok: false,
        resumePhase: null,
        resumePolicy: null,
        completed: [],
        degraded: true,
      });
      assert.equal(readFileSync(object, 'utf-8'), objectBytes);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('operation calls fail open on corrupt storage without replacing the corrupt bytes', async () => {
    const cwd = await makeTmpDir();
    try {
      const runId = 'run-corrupt-operations';
      const p = pipelinePath(cwd, runId);
      mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
      const bytes = '{broken';
      writeFileSync(p, bytes, { mode: 0o600 });

      const entered = enterPhase(runId, 'triage', { cwd });
      assert.equal(entered.proceed, true);
      assert.equal(entered.degraded, true);
      const attempted = beginAttempt(runId, { cwd });
      assert.equal(attempted.allowed, true);
      assert.equal(attempted.degraded, true);
      assert.equal(existsSync(guardPath(cwd, runId)), false);
      const completed = await completePhase(runId, 'triage', undefined, { cwd });
      assert.equal(completed.ok, true);
      assert.equal(completed.degraded, true);
      const skipped = skipPhase(runId, 'triage', 'fail-open', { cwd });
      assert.equal(skipped.ok, true);
      assert.equal(skipped.degraded, true);
      assert.equal(readFileSync(p, 'utf-8'), bytes);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('initPipeline never repurposes a valid run owned by another orchestrator', async () => {
    const cwd = await makeTmpDir();
    try {
      const runId = 'run-orchestrator-mismatch';
      assert.equal(initPipeline(runId, 'atlas', { cwd }).ok, true);
      const p = pipelinePath(cwd, runId);
      const bytes = readFileSync(p, 'utf-8');
      assert.deepEqual(initPipeline(runId, 'athena', { cwd }), {
        ok: false,
        resumePhase: null,
        resumePolicy: null,
        completed: [],
        degraded: true,
      });
      assert.equal(readFileSync(p, 'utf-8'), bytes);
    } finally {
      await removeTmpDir(cwd);
    }
  });
});

describe('isolation and fail-open', () => {
  test('different runs are isolated', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-a', 'atlas', { cwd });
      initPipeline('run-b', 'atlas', { cwd });
      enterPhase('run-a', 'triage', { cwd });
      await completeNoCheckpoint('run-a', 'triage', cwd);
      assert.equal(nextPhase('run-a', { cwd }), 'context');
      assert.equal(nextPhase('run-b', { cwd }), 'triage');
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('missing runId fails open with degraded permissive results', () => {
    assert.equal(initPipeline('', 'atlas').degraded, true);
    assert.equal(enterPhase('', 'triage').proceed, true);
    assert.equal(beginAttempt('').allowed, true);
    assert.equal(reattempt('', { reopen: ['verify'] }).allowed, true);
    assert.equal(loopTick('', 'review').allowed, true);
    assert.equal(recordPhaseError('', 'verify', 'boom').shouldEscalate, false);
  });

  test('pipeline.json coexists with loop-guard.json without clobbering', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-coexist', 'atlas', { cwd });
      await advanceToAttemptPhase('run-coexist', 'atlas', cwd);
      beginAttempt('run-coexist', { cwd });
      enterPhase('run-coexist', 'execute', { cwd });
      assert.ok(existsSync(pipelinePath(cwd, 'run-coexist')));
      assert.ok(existsSync(guardPath(cwd, 'run-coexist')));
      assert.equal(readJson(guardPath(cwd, 'run-coexist')).counters.iterations.count, 1);
      assert.equal(readJson(pipelinePath(cwd, 'run-coexist')).phases.triage.status, 'completed');
    } finally {
      await removeTmpDir(cwd);
    }
  });
});

describe('isComplete', () => {
  test('every phase must be explicitly terminal and at least one attempt must be recorded', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-done', 'atlas', { cwd });
      assert.equal(isComplete('run-done', { cwd }), false);

      await completeThrough('run-done', cwd, ['triage']);
      assert.equal(skipPhase('run-done', 'context', 'trivial', { cwd }).ok, true);
      assert.equal(skipPhase('run-done', 'spec', 'trivial', { cwd }).ok, true);
      assert.equal(skipPhase('run-done', 'plan', 'trivial', { cwd }).ok, true);
      assert.equal(isComplete('run-done', { cwd }), false);

      assert.equal(beginAttempt('run-done', { cwd }).allowed, true);
      await completeThrough('run-done', cwd, ['execute', 'verify', 'review', 'finalize']);
      assert.equal(skipPhase('run-done', 'ship', 'not-applicable', { cwd }).ok, true);
      assert.equal(skipPhase('run-done', 'ci', 'no-pr', { cwd }).ok, true);
      await completeThrough('run-done', cwd, ['complete']);
      assert.equal(isComplete('run-done', { cwd }), true);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('all-terminal ledger without an outer attempt is not complete', async () => {
    const cwd = await makeTmpDir();
    try {
      const runId = 'run-terminal-no-attempt';
      const p = pipelinePath(cwd, runId);
      mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
      const ledger = {
        schemaVersion: 1,
        orchestrator: 'atlas',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attempt: 0,
        phases: Object.fromEntries(getPhaseSequence('atlas').map(({ id }) => [id, { status: 'completed' }])),
      };
      writeFileSync(p, JSON.stringify(ledger), { mode: 0o600 });
      assert.equal(isComplete(runId, { cwd }), false);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('getPipelineState returns a fresh default on unknown run', () => {
    const state = getPipelineState('missing-run', { cwd: '/tmp/ao-missing-phase-runner' });
    assert.equal(state.schemaVersion, 1);
    assert.deepEqual(state.phases, {});
  });
});

describe('finalizeCompletedPipeline', () => {
  test('rejects an incomplete pipeline without mutating the running summary', async () => {
    const cwd = await makeTmpDir();
    try {
      const base = path.join(cwd, '.ao', 'artifacts', 'runs');
      const stateDir = path.join(cwd, '.ao', 'state');
      const created = createRun('atlas', 'incomplete finalization', {
        base,
        stateDir,
        trustedRoot: cwd,
      });
      assert.equal(created.ok, true);
      initPipeline(created.runId, 'atlas', { cwd });
      const summaryPath = path.join(base, created.runId, 'summary.json');
      const before = readFileSync(summaryPath, 'utf8');

      const result = finalizeCompletedPipeline(created.runId, { cwd });
      assert.deepEqual(result, {
        ok: false,
        reason: 'pipeline-incomplete',
        degraded: false,
      });
      assert.equal(readFileSync(summaryPath, 'utf8'), before);
      assert.equal(getActiveRunId('atlas', { stateDir }), created.runId);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('runs the final evidence validator under the completion transition lock', async () => {
    const cwd = await makeTmpDir();
    try {
      const base = path.join(cwd, '.ao', 'artifacts', 'runs');
      const stateDir = path.join(cwd, '.ao', 'state');
      const created = createRun('atlas', 'validated finalization', {
        base,
        stateDir,
        trustedRoot: cwd,
      });
      assert.equal(created.ok, true);
      initPipeline(created.runId, 'atlas', { cwd });
      await completeThrough(created.runId, cwd, ['triage', 'context', 'spec', 'plan']);
      assert.equal(beginAttempt(created.runId, { cwd }).allowed, true);
      await completeThrough(created.runId, cwd, ['execute', 'verify', 'review']);
      assert.equal(enterPhase(created.runId, 'finalize', { cwd }).proceed, true);
      assert.equal(loopTick(created.runId, 'final-review', { cwd }).allowed, true);
      assert.equal((await completeNoCheckpoint(created.runId, 'finalize', cwd, {
        finalReviewDigest: 'digest',
        finalReviewTreeOid: 'tree',
        finalCommit: 'commit',
      })).ok, true);
      assert.equal(skipPhase(created.runId, 'ship', 'not-applicable', { cwd }).ok, true);
      assert.equal(skipPhase(created.runId, 'ci', 'no-pr', { cwd }).ok, true);
      await completeThrough(created.runId, cwd, ['complete']);
      const finalPrd = writeCompletedAtlasPrd(cwd);

      let calls = 0;
      const denied = finalizeCompletedPipeline(created.runId, {
        cwd,
        _validateCompletion: ({ finalizeOutputs, _runLockOwner }) => {
          calls += 1;
          assert.equal(typeof _runLockOwner?.token, 'string');
          assert.equal(finalizeOutputs.finalCommit, 'commit');
          return false;
        },
      });
      assert.equal(denied.ok, false);
      assert.equal(denied.reason, 'completion-evidence-invalid');
      assert.equal(readJson(path.join(base, created.runId, 'summary.json')).status, 'running');

      const finalized = finalizeCompletedPipeline(created.runId, {
        cwd,
        _validateCompletion: () => { calls += 1; return true; },
      });
      assert.equal(finalized.ok, true);
      assert.equal(calls, 2);
      const snapshot = getRunExecutionPrdSnapshot(created.runId, {
        base,
        trustedRoot: cwd,
      });
      assert.equal(snapshot.ok, true);
      assert.deepEqual(snapshot.snapshot.prd, finalPrd);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('atomically finalizes a complete run and repairs a stale matching pointer', async () => {
    const cwd = await makeTmpDir();
    try {
      const base = path.join(cwd, '.ao', 'artifacts', 'runs');
      const stateDir = path.join(cwd, '.ao', 'state');
      const pointerPath = path.join(stateDir, 'ao-active-run-atlas.json');
      const created = createRun('atlas', 'complete finalization', {
        base,
        stateDir,
        trustedRoot: cwd,
      });
      assert.equal(created.ok, true);
      const pointerPayload = readFileSync(pointerPath, 'utf8');
      initPipeline(created.runId, 'atlas', { cwd });
      await completeThrough(created.runId, cwd, ['triage', 'context', 'spec', 'plan']);
      assert.equal(beginAttempt(created.runId, { cwd }).allowed, true);
      await completeThrough(created.runId, cwd, ['execute', 'verify', 'review', 'finalize']);
      assert.equal(skipPhase(created.runId, 'ship', 'not-applicable', { cwd }).ok, true);
      assert.equal(skipPhase(created.runId, 'ci', 'no-pr', { cwd }).ok, true);
      await completeThrough(created.runId, cwd, ['complete']);
      const finalPrd = writeCompletedAtlasPrd(cwd);

      const first = finalizeCompletedPipeline(created.runId, { cwd });
      assert.equal(first.ok, true);
      assert.equal(first.idempotent, false);
      assert.equal(getActiveRunId('atlas', { stateDir }), null);
      assert.deepEqual(
        getRunExecutionPrdSnapshot(created.runId, { base, trustedRoot: cwd }).snapshot.prd,
        finalPrd,
      );

      writeFileSync(pointerPath, pointerPayload, { flag: 'wx', mode: 0o600 });
      assert.equal(getActiveRunId('atlas', { stateDir }), created.runId);
      writeFileSync(path.join(cwd, 'later-user-work.txt'), 'must not strand pointer repair\n');
      let replayValidationCalls = 0;
      const replay = finalizeCompletedPipeline(created.runId, {
        cwd,
        _validateCompletion: () => {
          replayValidationCalls += 1;
          return false;
        },
      });
      assert.equal(replay.ok, true);
      assert.equal(replay.idempotent, true);
      assert.equal(replayValidationCalls, 0,
        'completed-summary replay repairs durable state without consulting a mutable checkout');
      assert.equal(getActiveRunId('atlas', { stateDir }), null);
      assert.equal(readJson(path.join(base, created.runId, 'summary.json')).result, 'success');
    } finally {
      await removeTmpDir(cwd);
    }
  });
});
