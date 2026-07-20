import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  beginPipelineEvidence,
  pipelineEvidenceNotApplicable,
  verifyPipelineEvidence,
} from '../../evals/lib/pipeline-evidence.mjs';
import { runEval } from '../../evals/run.mjs';
import {
  createFinalizedEvalPipelineFixture,
  invokeAtlasEvalBootstrap,
} from './helpers/eval-pipeline-fixture.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const REGRESSION_TASK = path.join(REPO_ROOT, 'evals/tasks/fix-failing-test');

function tempDir(t, prefix = 'ao-eval-pipeline-') {
  const cwd = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function begin(cwd) {
  return beginPipelineEvidence({
    workdir: cwd,
    orchestrator: 'atlas',
    evalRunId: 'outer-eval',
    taskId: 'fixture-task',
    taskPrompt: 'Fix the isolated fixture.',
    trial: 1,
  });
}

function json(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function reviewBindingIntegrity(binding) {
  return createHash('sha256').update(JSON.stringify({
    schemaVersion: binding.schemaVersion,
    runId: binding.runId,
    phase: binding.phase,
    generationId: binding.generationId,
    reviewTreeOid: binding.reviewTreeOid,
    finalCommitProposal: binding.finalCommitProposal,
    storyIds: binding.storyIds,
    prdGeneration: binding.prdGeneration,
    route: binding.route,
    boundAt: binding.boundAt,
  }), 'utf8').digest('hex');
}

async function finalized(t) {
  const cwd = tempDir(t);
  const handle = begin(cwd);
  assert.equal(handle.ready, true);
  await createFinalizedEvalPipelineFixture(cwd);
  return { cwd, handle };
}

function makePlugin(root) {
  const pluginDir = path.join(root, 'plugin');
  mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
  writeFileSync(path.join(pluginDir, '.claude-plugin/plugin.json'), '{"name":"pipeline-evidence-test"}\n');
  cpSync(path.join(REPO_ROOT, 'skills', 'atlas'), path.join(pluginDir, 'skills', 'atlas'), {
    recursive: true,
  });
  cpSync(path.join(REPO_ROOT, 'skills', 'athena'), path.join(pluginDir, 'skills', 'athena'), {
    recursive: true,
  });
  return pluginDir;
}

function fakeLiveSpawn({ pipeline = true, solution = true, orchestrator = 'atlas' } = {}) {
  return (_command, _args, options) => {
    if (pipeline && orchestrator === 'atlas') invokeAtlasEvalBootstrap(options.cwd);
    if (solution) cpSync(path.join(REGRESSION_TASK, 'solution'), options.cwd, { recursive: true, force: true });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    process.nextTick(() => {
      void (async () => {
        if (pipeline) await createFinalizedEvalPipelineFixture(options.cwd, orchestrator);
        child.stdout.end(`${JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          duration_ms: 10,
          total_cost_usd: 0.01,
        })}\n`);
        child.emit('close', 0, null);
      })().catch((error) => child.emit('error', error));
    });
    return child;
  };
}

test('valid finalized Atlas pipeline produces bounded cooperative evidence', async (t) => {
  const { handle } = await finalized(t);
  const evidence = verifyPipelineEvidence(handle);
  assert.equal(evidence.pass, true);
  assert.equal(evidence.required, true);
  assert.equal(evidence.trust, 'candidate-asserted');
  assert.equal(evidence.pipelineRunId, handle.pipelineRunId);
  assert.equal(evidence.phaseStatuses.complete, 'completed');
  assert.match(evidence.ledgerSha256, /^[a-f0-9]{64}$/);
  assert.match(evidence.summarySha256, /^[a-f0-9]{64}$/);
  assert.match(evidence.eventsSha256, /^[a-f0-9]{64}$/);
  assert.match(evidence.atlasEvidence.reviewGenerationId, /^[a-f0-9-]{36}$/i);
  assert.match(evidence.atlasEvidence.finalGenerationId, /^[a-f0-9-]{36}$/i);
  assert.match(evidence.atlasEvidence.reviewDigest, /^[a-f0-9]{64}$/);
  assert.match(evidence.atlasEvidence.finalReviewDigest, /^[a-f0-9]{64}$/);
  assert.match(evidence.atlasEvidence.finalCommit, /^[a-f0-9]{40,64}$/);
  assert.match(evidence.atlasEvidence.reviewApprovalSha256, /^[a-f0-9]{64}$/);
  assert.match(evidence.atlasEvidence.reviewBindingSha256, /^[a-f0-9]{64}$/);
  assert.match(evidence.atlasEvidence.finalReviewApprovalSha256, /^[a-f0-9]{64}$/);
  assert.match(evidence.atlasEvidence.finalReviewBindingSha256, /^[a-f0-9]{64}$/);
  assert.match(evidence.atlasEvidence.finalGenerationSha256, /^[a-f0-9]{64}$/);
  assert.match(evidence.atlasEvidence.executionPrdSnapshotSha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(evidence, 'workdir'), false);
});

test('a production quality reattempt reaches terminal evidence with one exact receipt', async (t) => {
  const cwd = tempDir(t, 'ao-eval-pipeline-reattempt-');
  const handle = begin(cwd);
  assert.equal(handle.ready, true);
  await createFinalizedEvalPipelineFixture(cwd, 'atlas', { qualityReattempt: true });

  const ledger = json(handle.pipelinePath);
  const guard = json(path.join(handle.runDir, 'loop-guard.json'));
  assert.equal(Object.hasOwn(ledger, 'pendingReattempt'), false);
  assert.deepEqual(ledger.reattemptReceipt, {
    schemaVersion: 1,
    runId: handle.pipelineRunId,
    orchestrator: 'atlas',
    reason: 'quality_fail',
    currentPhase: 'verify',
    reopen: ['execute', 'verify'],
    baseAttempt: 1,
    targetAttempt: 2,
    qualityBaseCount: 0,
  });
  assert.equal(guard.counters.iterations.count, 2);
  assert.equal(guard.counters['quality-cycles'].count, 1);
  const evidence = verifyPipelineEvidence(handle);
  assert.equal(evidence.pass, true);
  assert.equal(evidence.attempt, 2);
});

test('a terminal light-mode reexecution receipt matches the runtime reopen policy', async (t) => {
  const cwd = tempDir(t, 'ao-eval-pipeline-light-reexec-');
  const handle = begin(cwd);
  await createFinalizedEvalPipelineFixture(cwd, 'atlas', { lightModeReattempt: true });

  const ledger = json(handle.pipelinePath);
  assert.deepEqual(ledger.reattemptReceipt, {
    schemaVersion: 1,
    runId: handle.pipelineRunId,
    orchestrator: 'atlas',
    reason: 'light_mode_reexec',
    currentPhase: 'review',
    reopen: ['execute', 'verify'],
    baseAttempt: 1,
    targetAttempt: 2,
  });
  assert.equal(ledger.phases.execute.status, 'completed');
  assert.equal(ledger.phases.verify.status, 'completed');
  assert.equal(ledger.phases.review.status, 'completed');
  assert.equal(ledger.phases.review.attempts, 2);
  const evidence = verifyPipelineEvidence(handle);
  assert.equal(evidence.pass, true);
  assert.equal(evidence.attempt, 2);
});

test('light-mode receipt rejects forged current phase, reopen policy, or nonterminal source', async (t) => {
  const cwd = tempDir(t, 'ao-eval-pipeline-light-reexec-forged-');
  const handle = begin(cwd);
  await createFinalizedEvalPipelineFixture(cwd, 'atlas', { lightModeReattempt: true });
  const original = json(handle.pipelinePath);

  for (const mutate of [
    ledger => { ledger.reattemptReceipt.currentPhase = 'verify'; },
    ledger => { ledger.reattemptReceipt.reopen = ['verify']; },
    ledger => { ledger.phases.review.status = 'in_progress'; },
  ]) {
    const forged = structuredClone(original);
    mutate(forged);
    writeFileSync(handle.pipelinePath, JSON.stringify(forged));
    assert.equal(verifyPipelineEvidence(handle).reason, 'reattempt-receipt-mismatch');
  }
});

test('terminal evidence rejects pending, forged, and counter-mismatched reattempt records', async (t) => {
  const cwd = tempDir(t, 'ao-eval-pipeline-reattempt-invalid-');
  const handle = begin(cwd);
  await createFinalizedEvalPipelineFixture(cwd, 'atlas', { qualityReattempt: true });
  const originalLedger = json(handle.pipelinePath);
  const originalGuard = json(path.join(handle.runDir, 'loop-guard.json'));

  const pending = structuredClone(originalLedger);
  pending.pendingReattempt = structuredClone(pending.reattemptReceipt);
  writeFileSync(handle.pipelinePath, JSON.stringify(pending));
  assert.equal(verifyPipelineEvidence(handle).reason, 'pending-reattempt-not-terminal');

  for (const mutate of [
    ledger => { ledger.reattemptReceipt.runId = 'atlas-forged-receipt'; },
    ledger => { ledger.reattemptReceipt.orchestrator = 'athena'; },
    ledger => { ledger.reattemptReceipt.targetAttempt = 3; },
    ledger => { ledger.reattemptReceipt.reopen = ['verify']; },
    ledger => { ledger.reattemptReceipt.untrusted = true; },
  ]) {
    const forged = structuredClone(originalLedger);
    mutate(forged);
    writeFileSync(handle.pipelinePath, JSON.stringify(forged));
    assert.equal(verifyPipelineEvidence(handle).reason, 'reattempt-receipt-mismatch');
  }

  writeFileSync(handle.pipelinePath, JSON.stringify(originalLedger));
  const mismatchedGuard = structuredClone(originalGuard);
  mismatchedGuard.counters['quality-cycles'].count = 2;
  writeFileSync(path.join(handle.runDir, 'loop-guard.json'), JSON.stringify(mismatchedGuard));
  assert.equal(verifyPipelineEvidence(handle).reason, 'quality-guard-mismatch');
});

test('valid finalized Atlas evidence survives cleanup of the live PRD', async (t) => {
  const { cwd, handle } = await finalized(t);
  assert.doesNotThrow(() => json(path.join(handle.runDir, 'execution-prd-snapshot.json')));
  unlinkSync(path.join(cwd, '.ao', 'prd.json'));

  const evidence = verifyPipelineEvidence(handle);
  assert.equal(evidence.pass, true);
  assert.match(evidence.atlasEvidence.executionPrdSnapshotSha256, /^[a-f0-9]{64}$/);
});

test('post-cleanup Atlas evidence still rejects stale PRD generations and tree changes', async (t) => {
  const { cwd, handle } = await finalized(t);
  unlinkSync(path.join(cwd, '.ao', 'prd.json'));
  const ledger = json(handle.pipelinePath);
  const finalApproval = json(path.join(
    handle.runDir,
    `review-approval-final-review-${ledger.phases.finalize.outputs.finalReviewDigest}.json`,
  ));
  const bindingPath = path.join(
    handle.runDir,
    `review-verification-final-review-${finalApproval.generationId}.json`,
  );
  const originalBinding = readFileSync(bindingPath, 'utf8');
  const staleBinding = JSON.parse(originalBinding);
  staleBinding.prdGeneration = 'f'.repeat(64);
  staleBinding.integrity.value = reviewBindingIntegrity(staleBinding);
  writeFileSync(bindingPath, JSON.stringify(staleBinding));
  assert.equal(verifyPipelineEvidence(handle).pass, false);

  writeFileSync(bindingPath, originalBinding);
  writeFileSync(path.join(cwd, 'post-cleanup-tree-change.txt'), 'not reviewed\n');
  assert.equal(verifyPipelineEvidence(handle).pass, false);
});

test('Atlas evidence rejects a finalized fixture that bypassed the real slash bootstrap', async (t) => {
  const cwd = tempDir(t, 'ao-eval-pipeline-no-bootstrap-');
  const handle = begin(cwd);
  assert.equal(handle.ready, true);
  await createFinalizedEvalPipelineFixture(cwd, 'atlas', { skipBootstrap: true });
  const evidence = verifyPipelineEvidence(handle);
  assert.equal(evidence.pass, false);
  assert.equal(evidence.reason, 'task-invocation-provenance');
});

test('Atlas evidence rejects caller-invented phase digests without code-owned artifacts', async (t) => {
  const { handle } = await finalized(t);
  const ledger = json(handle.pipelinePath);
  const invented = 'f'.repeat(64);
  ledger.phases.verify.outputs.verificationReviewDigest = invented;
  ledger.phases.review.outputs.approvedReviewDigest = invented;
  writeFileSync(handle.pipelinePath, JSON.stringify(ledger));

  const evidence = verifyPipelineEvidence(handle);
  assert.equal(evidence.pass, false);
  assert.equal(evidence.reason, 'atlas-review-evidence');
});

test('Atlas evidence rejects tampered immutable review approval contents', async (t) => {
  const { handle } = await finalized(t);
  const ledger = json(handle.pipelinePath);
  const approvalPath = path.join(
    handle.runDir,
    `review-approval-review-${ledger.phases.review.outputs.approvedReviewDigest}.json`,
  );
  const approval = json(approvalPath);
  approval.results[0].verdict = 'REVISE';
  writeFileSync(approvalPath, JSON.stringify(approval));

  const evidence = verifyPipelineEvidence(handle);
  assert.equal(evidence.pass, false);
  assert.equal(evidence.reason, 'atlas-review-evidence');
});

test('Atlas evidence rejects a forged final commit proposal even with recomputed binding integrity', async (t) => {
  const { handle } = await finalized(t);
  const ledger = json(handle.pipelinePath);
  const approval = json(path.join(
    handle.runDir,
    `review-approval-final-review-${ledger.phases.finalize.outputs.finalReviewDigest}.json`,
  ));
  const bindingPath = path.join(
    handle.runDir,
    `review-verification-final-review-${approval.generationId}.json`,
  );
  const binding = json(bindingPath);
  binding.finalCommitProposal.message = 'forged final commit message\n';
  binding.integrity.value = reviewBindingIntegrity(binding);
  writeFileSync(bindingPath, JSON.stringify(binding));

  const evidence = verifyPipelineEvidence(handle);
  assert.equal(evidence.pass, false);
  assert.equal(evidence.reason, 'atlas-final-review-evidence');
});

test('Atlas evidence rejects an authoritative PRD with an incomplete story', async (t) => {
  const { cwd, handle } = await finalized(t);
  const prdPath = path.join(cwd, '.ao', 'prd.json');
  const prd = json(prdPath);
  prd.userStories[0].passes = false;
  writeFileSync(prdPath, JSON.stringify(prd));

  const evidence = verifyPipelineEvidence(handle);
  assert.equal(evidence.pass, false);
  assert.equal(evidence.reason, 'atlas-verification-evidence');
});

test('Atlas evidence rejects a caller-invented final commit even when shaped as an object id', async (t) => {
  const { handle } = await finalized(t);
  const ledger = json(handle.pipelinePath);
  const forgedCommit = 'e'.repeat(40);
  ledger.phases.finalize.outputs.finalCommit = forgedCommit;
  ledger.phases.ship.outputs.headCommit = forgedCommit;
  ledger.phases.ci.outputs.ciHeadCommit = forgedCommit;
  writeFileSync(handle.pipelinePath, JSON.stringify(ledger));

  const evidence = verifyPipelineEvidence(handle);
  assert.equal(evidence.pass, false);
  assert.equal(evidence.reason, 'atlas-final-git-evidence');
});

test('Atlas evidence rejects ship and CI commits that differ from finalize', async (t) => {
  for (const [phase, field, reason] of [
    ['ship', 'headCommit', 'atlas-ship-finalize-mismatch'],
    ['ci', 'ciHeadCommit', 'atlas-ci-finalize-mismatch'],
  ]) {
    const cwd = tempDir(t, `ao-eval-pipeline-${phase}-binding-`);
    const handle = begin(cwd);
    await createFinalizedEvalPipelineFixture(cwd);
    const ledger = json(handle.pipelinePath);
    ledger.phases[phase].outputs[field] = 'd'.repeat(40);
    writeFileSync(handle.pipelinePath, JSON.stringify(ledger));

    const evidence = verifyPipelineEvidence(handle);
    assert.equal(evidence.pass, false, phase);
    assert.equal(evidence.reason, reason, phase);
  }
});

test('Atlas evidence requires exact code-owned ship and CI output schemas', async (t) => {
  for (const [phase, outputs, reason] of [
    ['ship', (finalCommit) => ({ headCommit: finalCommit }), 'atlas-ship-evidence'],
    ['ci', (finalCommit) => ({ ciHeadCommit: finalCommit, extra: 'forged' }), 'atlas-ci-evidence'],
  ]) {
    const cwd = tempDir(t, `ao-eval-pipeline-${phase}-schema-`);
    const handle = begin(cwd);
    await createFinalizedEvalPipelineFixture(cwd);
    const ledger = json(handle.pipelinePath);
    ledger.phases[phase].outputs = outputs(ledger.phases.finalize.outputs.finalCommit);
    writeFileSync(handle.pipelinePath, JSON.stringify(ledger));

    const evidence = verifyPipelineEvidence(handle);
    assert.equal(evidence.pass, false, phase);
    assert.equal(evidence.reason, reason, phase);
  }
});

test('Atlas evidence binds ship and CI events to their final ledger outputs', async (t) => {
  for (const phase of ['ship', 'ci']) {
    const cwd = tempDir(t, `ao-eval-pipeline-${phase}-event-output-`);
    const handle = begin(cwd);
    await createFinalizedEvalPipelineFixture(cwd);
    const eventsPath = path.join(handle.runDir, 'events.jsonl');
    const events = readFileSync(eventsPath, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line));
    const event = events.findLast(item => (
      item.type === 'pipeline_phase_completed' && item.phase === phase
    ));
    event.detail.outputs = phase === 'ship'
      ? { headCommit: 'd'.repeat(40) }
      : { ciHeadCommit: 'd'.repeat(40) };
    writeFileSync(eventsPath, `${events.map(item => JSON.stringify(item)).join('\n')}\n`);

    const evidence = verifyPipelineEvidence(handle);
    assert.equal(evidence.pass, false, phase);
    assert.equal(evidence.reason, 'atlas-phase-event-output-mismatch', phase);
  }
});

test('Atlas evidence binds CI skip semantics to the ship outcome', async (t) => {
  const validCwd = tempDir(t, 'ao-eval-pipeline-valid-dynamic-skip-');
  const validHandle = begin(validCwd);
  await createFinalizedEvalPipelineFixture(validCwd, 'atlas', {
    shipSkipReason: 'preflight-unavailable',
    ciSkipReason: 'no-pr',
  });
  assert.equal(verifyPipelineEvidence(validHandle).pass, true);

  const invalidCwd = tempDir(t, 'ao-eval-pipeline-invalid-dynamic-skip-');
  const invalidHandle = begin(invalidCwd);
  await createFinalizedEvalPipelineFixture(invalidCwd, 'atlas', {
    ciSkipReason: 'no-pr',
  });
  const evidence = verifyPipelineEvidence(invalidHandle);
  assert.equal(evidence.pass, false);
  assert.equal(evidence.reason, 'ship-ci-outcome-mismatch');
});

test('Atlas evidence rejects dynamic skips that contradict durable ship and CI policy', async (t) => {
  const askCwd = tempDir(t, 'ao-eval-pipeline-ask-preflight-skip-');
  const askHandle = begin(askCwd);
  await createFinalizedEvalPipelineFixture(askCwd, 'atlas', {
    shipMode: 'ask',
    shipSkipReason: 'preflight-unavailable',
    ciSkipReason: 'no-pr',
  });
  assert.equal(verifyPipelineEvidence(askHandle).reason, 'ship-policy-evidence');

  const ciCwd = tempDir(t, 'ao-eval-pipeline-enabled-watch-skip-');
  const ciHandle = begin(ciCwd);
  await createFinalizedEvalPipelineFixture(ciCwd, 'atlas', {
    ciWatchEnabled: true,
    ciSkipReason: 'watch-disabled',
  });
  assert.equal(verifyPipelineEvidence(ciHandle).reason, 'ci-policy-evidence');
});

test('production Atlas trivial skip timing remains valid evidence', async (t) => {
  const cwd = tempDir(t, 'ao-eval-pipeline-trivial-');
  const handle = begin(cwd);
  await createFinalizedEvalPipelineFixture(cwd, 'atlas', { trivial: true });
  const evidence = verifyPipelineEvidence(handle);
  assert.equal(evidence.pass, true);
  assert.deepEqual(
    ['context', 'spec', 'plan'].map((id) => evidence.phaseStatuses[id]),
    ['skipped', 'skipped', 'skipped'],
  );
});

test('late light-mode plan rewind does not invalidate a canonical completed traversal', async (t) => {
  const cwd = tempDir(t, 'ao-eval-pipeline-rewind-');
  const handle = begin(cwd);
  await createFinalizedEvalPipelineFixture(cwd, 'atlas', { latePlanRewind: true });
  const evidence = verifyPipelineEvidence(handle);
  assert.equal(evidence.pass, true);
});

test('valid finalized Athena pipeline includes recover phases and monitor guard evidence', async (t) => {
  const cwd = tempDir(t, 'ao-eval-pipeline-athena-');
  const handle = beginPipelineEvidence({
    workdir: cwd,
    orchestrator: 'athena',
    evalRunId: 'outer-eval',
    taskId: 'fixture-task',
    trial: 1,
  });
  assert.equal(handle.required, true);
  assert.equal(handle.ready, true);
  await createFinalizedEvalPipelineFixture(cwd, 'athena');
  const evidence = verifyPipelineEvidence(handle);
  assert.equal(evidence.pass, true);
  assert.equal(evidence.orchestrator, 'athena');
  assert.equal(evidence.phaseStatuses.spawn, 'completed');
  assert.equal(evidence.phaseStatuses.monitor, 'completed');
  assert.equal(evidence.phaseStatuses.integrate, 'completed');
});

test('Athena evidence rejects missing spawn identity and launch progress', async (t) => {
  const cwd = tempDir(t, 'ao-eval-pipeline-athena-spawn-proof-');
  const handle = beginPipelineEvidence({
    workdir: cwd, orchestrator: 'athena', evalRunId: 'outer-eval', taskId: 'fixture-task', trial: 1,
  });
  await createFinalizedEvalPipelineFixture(cwd, 'athena');
  const ledger = json(handle.pipelinePath);
  const originalLedger = JSON.stringify(ledger);
  delete ledger.phases.spawn.outputs;
  writeFileSync(handle.pipelinePath, JSON.stringify(ledger));
  assert.equal(verifyPipelineEvidence(handle).reason, 'athena-spawn-evidence');

  writeFileSync(handle.pipelinePath, originalLedger);
  const eventPath = path.join(handle.runDir, 'events.jsonl');
  const filtered = readFileSync(eventPath, 'utf-8').split(/\r?\n/)
    .filter((line) => line && JSON.parse(line).type !== 'pipeline_phase_outputs_recorded')
    .join('\n');
  writeFileSync(eventPath, `${filtered}\n`);
  assert.equal(verifyPipelineEvidence(handle).reason, 'athena-spawn-progress-evidence');
});

test('Athena evidence rejects partial terminal, stale generation, and merge rosters', async (t) => {
  for (const mutation of ['partial-terminal', 'stale-monitor-generation', 'partial-merge', 'empty-merge']) {
    const cwd = tempDir(t, `ao-eval-pipeline-athena-${mutation}-`);
    const handle = beginPipelineEvidence({
      workdir: cwd, orchestrator: 'athena', evalRunId: 'outer-eval', taskId: 'fixture-task', trial: 1,
    });
    await createFinalizedEvalPipelineFixture(cwd, 'athena');
    const ledger = json(handle.pipelinePath);
    if (mutation === 'partial-terminal') ledger.phases.monitor.outputs.terminalWorkers = 'api';
    if (mutation === 'stale-monitor-generation') {
      ledger.phases.monitor.outputs.adapterRunId = 'ffffffffffffffff';
    }
    if (mutation === 'partial-merge') ledger.phases.integrate.outputs.mergedWorkers = 'api';
    if (mutation === 'empty-merge') {
      ledger.phases.integrate.outputs.isolatedWorkers = '';
      ledger.phases.integrate.outputs.mergedWorkers = '';
      const eventsPath = path.join(handle.runDir, 'events.jsonl');
      const events = readFileSync(eventsPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
      const event = events.findLast((item) => item.type === 'pipeline_phase_completed' && item.phase === 'integrate');
      event.detail.outputs = ledger.phases.integrate.outputs;
      writeFileSync(eventsPath, `${events.map((item) => JSON.stringify(item)).join('\n')}\n`);
    }
    writeFileSync(handle.pipelinePath, JSON.stringify(ledger));
    const evidence = verifyPipelineEvidence(handle);
    assert.equal(evidence.pass, false);
    assert.equal(
      evidence.reason,
      ['partial-terminal', 'stale-monitor-generation'].includes(mutation)
        ? 'athena-monitor-evidence'
        : 'athena-integrate-evidence',
    );
  }
});

test('Athena evidence requires cleanup completion bound to spawn identity', async (t) => {
  const cwd = tempDir(t, 'ao-eval-pipeline-athena-cleanup-');
  const handle = beginPipelineEvidence({
    workdir: cwd, orchestrator: 'athena', evalRunId: 'outer-eval', taskId: 'fixture-task', trial: 1,
  });
  await createFinalizedEvalPipelineFixture(cwd, 'athena');
  const ledger = json(handle.pipelinePath);
  ledger.phases.complete.outputs.cleanupState = 'pending';
  const eventsPath = path.join(handle.runDir, 'events.jsonl');
  const events = readFileSync(eventsPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
  events.findLast((item) => item.type === 'pipeline_phase_completed' && item.phase === 'complete')
    .detail.outputs = ledger.phases.complete.outputs;
  writeFileSync(handle.pipelinePath, JSON.stringify(ledger));
  writeFileSync(eventsPath, `${events.map((item) => JSON.stringify(item)).join('\n')}\n`);
  assert.equal(verifyPipelineEvidence(handle).reason, 'athena-cleanup-evidence');
});

test('Athena evidence requires production spawn and monitor identity fields', async (t) => {
  for (const mutation of ['missing-prd-generation', 'missing-native-session']) {
    const cwd = tempDir(t, `ao-eval-pipeline-athena-output-${mutation}-`);
    const handle = beginPipelineEvidence({
      workdir: cwd, orchestrator: 'athena', evalRunId: 'outer-eval', taskId: 'fixture-task', trial: 1,
    });
    await createFinalizedEvalPipelineFixture(cwd, 'athena');
    const ledger = json(handle.pipelinePath);
    const eventsPath = path.join(handle.runDir, 'events.jsonl');
    const events = readFileSync(eventsPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    if (mutation === 'missing-prd-generation') {
      delete ledger.phases.spawn.outputs.prdGeneration;
      events.findLast((event) => event.type === 'pipeline_phase_completed' && event.phase === 'spawn')
        .detail.outputs = ledger.phases.spawn.outputs;
    } else {
      delete ledger.phases.monitor.outputs.nativeSessionId;
      events.findLast((event) => event.type === 'pipeline_phase_completed' && event.phase === 'monitor')
        .detail.outputs = ledger.phases.monitor.outputs;
    }
    writeFileSync(handle.pipelinePath, JSON.stringify(ledger));
    writeFileSync(eventsPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
    assert.equal(
      verifyPipelineEvidence(handle).reason,
      mutation === 'missing-prd-generation' ? 'athena-spawn-evidence' : 'athena-monitor-evidence',
    );
  }
});

test('Athena final-review evidence is bound to the exact finalize attempt', async (t) => {
  const cwd = tempDir(t, 'ao-eval-pipeline-athena-final-review-');
  const handle = beginPipelineEvidence({
    workdir: cwd, orchestrator: 'athena', evalRunId: 'outer-eval', taskId: 'fixture-task', trial: 1,
  });
  await createFinalizedEvalPipelineFixture(cwd, 'athena');
  const ledger = json(handle.pipelinePath);
  ledger.phases.finalize.attempts = 2;
  writeFileSync(handle.pipelinePath, JSON.stringify(ledger));
  assert.equal(verifyPipelineEvidence(handle).reason, 'final-review-guard-mismatch');
});

test('pre-existing .ao state is rejected before a live provider can spawn', (t) => {
  const cwd = tempDir(t);
  mkdirSync(path.join(cwd, '.ao', 'state'), { recursive: true });
  writeFileSync(path.join(cwd, '.ao', 'state', 'ao-active-run-atlas.json'), '{"runId":"stale"}\n');
  const handle = begin(cwd);
  assert.equal(handle.ready, false);
  assert.equal(handle.reason, 'preexisting-ao-state');
});

test('missing finalization cannot reuse a pre-allocated active run as success', (t) => {
  const cwd = tempDir(t);
  const handle = begin(cwd);
  const taskUpdates = json(path.join(handle.runDir, 'task-updates.json'));
  assert.deepEqual(taskUpdates.updates.map((update) => update.task), [
    'Fix the isolated fixture.',
  ]);
  const evidence = verifyPipelineEvidence(handle);
  assert.equal(evidence.pass, false);
  assert.equal(evidence.reason, 'active-run-not-finalized');
  assert.deepEqual(evidence.diagnostics, {
    artifactReads: {
      pipeline: false,
      summary: true,
      events: true,
      guard: false,
    },
    pipeline: {
      attempt: null,
      phaseStatuses: {},
    },
    summary: {
      status: 'running',
      result: null,
    },
    lastEvent: {
      type: 'user_task_update',
      phase: null,
    },
    guardCounterCounts: {},
  });
});

test('active-run diagnostics expose only bounded structural progress', (t) => {
  const cwd = tempDir(t, 'ao-eval-pipeline-active-diagnostics-');
  const handle = begin(cwd);
  const secret = 'PRIVATE prompt output /tmp/private-worktree raw-command';

  writeFileSync(handle.pipelinePath, JSON.stringify({
    schemaVersion: 1,
    runId: handle.pipelineRunId,
    orchestrator: 'atlas',
    attempt: 2,
    phases: {
      triage: { status: 'completed', outputs: { prompt: secret } },
      execute: { status: 'in_progress', reason: secret },
      forged: { status: secret },
    },
    prompt: secret,
  }));

  const summaryPath = path.join(handle.runDir, 'summary.json');
  const summary = json(summaryPath);
  summary.result = 'failure';
  summary.output = secret;
  writeFileSync(summaryPath, JSON.stringify(summary));

  writeFileSync(path.join(handle.runDir, 'events.jsonl'), `${JSON.stringify({
    type: 'subagent_completed',
    phase: 'review',
    prompt: secret,
    detail: { output: secret, command: secret, path: cwd },
  })}\n`);
  writeFileSync(path.join(handle.runDir, 'loop-guard.json'), JSON.stringify({
    schemaVersion: 1,
    counters: {
      iterations: { count: 2, sample: secret },
      reviewRounds: { count: 1, sample: secret },
      [secret]: { count: 3 },
    },
    errors: { private: { count: 1, sample: secret } },
  }));

  const evidence = verifyPipelineEvidence(handle);
  assert.equal(evidence.pass, false);
  assert.equal(evidence.reason, 'active-run-not-finalized');
  assert.deepEqual(evidence.diagnostics, {
    artifactReads: {
      pipeline: true,
      summary: true,
      events: true,
      guard: true,
    },
    pipeline: {
      attempt: 2,
      phaseStatuses: {
        triage: 'completed',
        execute: 'in_progress',
      },
    },
    summary: {
      status: 'running',
      result: 'failure',
    },
    lastEvent: {
      type: 'subagent_completed',
      phase: 'review',
    },
    guardCounterCounts: {
      iterations: 2,
      reviewRounds: 1,
    },
  });
  const rendered = JSON.stringify(evidence);
  assert.equal(rendered.includes(secret), false);
  assert.equal(rendered.includes(cwd), false);
  assert.ok(Buffer.byteLength(JSON.stringify(evidence.diagnostics), 'utf-8') < 2_048);
});

test('active-run diagnostics normalize arbitrary structural strings', (t) => {
  const cwd = tempDir(t, 'ao-eval-pipeline-active-normalized-');
  const handle = begin(cwd);
  const secret = 'PRIVATE-STRUCTURAL-VALUE';

  writeFileSync(handle.pipelinePath, JSON.stringify({
    schemaVersion: 1,
    runId: handle.pipelineRunId,
    orchestrator: 'atlas',
    attempt: 1,
    phases: { triage: { status: secret } },
  }));
  const summaryPath = path.join(handle.runDir, 'summary.json');
  const summary = json(summaryPath);
  summary.status = secret;
  summary.result = secret;
  writeFileSync(summaryPath, JSON.stringify(summary));
  writeFileSync(path.join(handle.runDir, 'events.jsonl'), `${JSON.stringify({
    type: secret,
    phase: secret,
    detail: { prompt: secret },
  })}\n`);
  writeFileSync(path.join(handle.runDir, 'loop-guard.json'), JSON.stringify({
    schemaVersion: 1,
    counters: { iterations: { count: secret } },
    errors: {},
  }));

  const evidence = verifyPipelineEvidence(handle);
  assert.equal(evidence.reason, 'active-run-not-finalized');
  assert.equal(evidence.diagnostics.pipeline.phaseStatuses.triage, 'unknown');
  assert.deepEqual(evidence.diagnostics.summary, { status: 'unknown', result: 'unknown' });
  assert.deepEqual(evidence.diagnostics.lastEvent, { type: 'unknown', phase: null });
  assert.deepEqual(evidence.diagnostics.guardCounterCounts, {});
  assert.equal(JSON.stringify(evidence).includes(secret), false);
});

test('a finalized summary cannot report a non-success result', async (t) => {
  const { handle } = await finalized(t);
  const summaryPath = path.join(handle.runDir, 'summary.json');
  const summary = json(summaryPath);
  summary.result = 'failed';
  writeFileSync(summaryPath, JSON.stringify(summary));
  const evidence = verifyPipelineEvidence(handle);
  assert.equal(evidence.pass, false);
  assert.equal(evidence.reason, 'summary-identity-mismatch');
});

test('an extra run directory makes pipeline identity ambiguous', async (t) => {
  const { handle } = await finalized(t);
  mkdirSync(path.join(handle.runsBase, 'atlas-extra-run'));
  const evidence = verifyPipelineEvidence(handle);
  assert.equal(evidence.pass, false);
  assert.equal(evidence.reason, 'ambiguous-run-identity');
});

test('core phases cannot be skipped or left incomplete', async (t) => {
  const { handle } = await finalized(t);
  const ledger = json(handle.pipelinePath);
  ledger.phases.verify = {
    status: 'skipped',
    reason: 'forged',
    completedAt: ledger.phases.verify.completedAt,
  };
  writeFileSync(handle.pipelinePath, JSON.stringify(ledger));
  const evidence = verifyPipelineEvidence(handle);
  assert.equal(evidence.pass, false);
  assert.equal(evidence.reason, 'core-phase-not-completed');
});

test('review evidence requires one guard tick for every recorded attempt', async (t) => {
  const { handle } = await finalized(t);
  const ledger = json(handle.pipelinePath);
  ledger.phases.review.attempts = 2;
  writeFileSync(handle.pipelinePath, JSON.stringify(ledger));
  const evidence = verifyPipelineEvidence(handle);
  assert.equal(evidence.pass, false);
  assert.equal(evidence.reason, 'review-guard-mismatch');
});

test('final-review evidence is bound to the exact finalize attempt', async (t) => {
  const finalReview = await finalized(t);
  const finalLedger = json(finalReview.handle.pipelinePath);
  finalLedger.phases.finalize.attempts = 2;
  writeFileSync(finalReview.handle.pipelinePath, JSON.stringify(finalLedger));
  assert.equal(verifyPipelineEvidence(finalReview.handle).reason, 'final-review-guard-mismatch');
});

test('missing, extra, corrupt, copied-run, and future-schema ledgers fail closed', async (t) => {
  for (const mutation of ['missing-phase', 'extra-phase', 'corrupt', 'copied-run', 'future']) {
    const cwd = tempDir(t, `ao-eval-pipeline-${mutation}-`);
    const handle = begin(cwd);
    await createFinalizedEvalPipelineFixture(cwd);
    const ledger = json(handle.pipelinePath);
    if (mutation === 'missing-phase') delete ledger.phases.review;
    if (mutation === 'extra-phase') ledger.phases.forged = { status: 'completed' };
    if (mutation === 'copied-run') ledger.runId = 'atlas-copied-ledger';
    if (mutation === 'future') ledger.schemaVersion = 99;
    writeFileSync(handle.pipelinePath, mutation === 'corrupt' ? '{' : JSON.stringify(ledger));
    const evidence = verifyPipelineEvidence(handle);
    assert.equal(evidence.pass, false, mutation);
  }
});

test('missing or inconsistent loop-guard authority fails closed', async (t) => {
  const missing = await finalized(t);
  unlinkSync(path.join(missing.handle.runDir, 'loop-guard.json'));
  assert.equal(verifyPipelineEvidence(missing.handle).reason, 'missing-file');

  const mismatched = await finalized(t);
  const guardPath = path.join(mismatched.handle.runDir, 'loop-guard.json');
  const guard = json(guardPath);
  guard.counters.iterations.count = 2;
  writeFileSync(guardPath, JSON.stringify(guard));
  assert.equal(verifyPipelineEvidence(mismatched.handle).reason, 'iteration-guard-mismatch');
});

test('iteration authority cannot be backfilled after phase completion', async (t) => {
  const cwd = tempDir(t, 'ao-eval-pipeline-backfilled-attempt-');
  const handle = begin(cwd);
  await createFinalizedEvalPipelineFixture(cwd, 'atlas', { backfillAttempt: true });
  const evidence = verifyPipelineEvidence(handle);
  assert.equal(evidence.pass, false);
  assert.equal(evidence.reason, 'iteration-guard-phase-order');
});

test('phase completion events must preserve the final code-defined order', async (t) => {
  const { handle } = await finalized(t);
  const eventsPath = path.join(handle.runDir, 'events.jsonl');
  const events = readFileSync(eventsPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
  const completions = events.filter((event) => event.type === 'pipeline_phase_completed').reverse();
  let completionIndex = 0;
  const reordered = events.map((event) => (
    event.type === 'pipeline_phase_completed' ? completions[completionIndex++] : event
  ));
  writeFileSync(eventsPath, `${reordered.map((event) => JSON.stringify(event)).join('\n')}\n`);
  const evidence = verifyPipelineEvidence(handle);
  assert.equal(evidence.pass, false);
  assert.equal(evidence.reason, 'phase-event-order-mismatch');
});

test('phase event timestamps must agree with durable JSONL order', async (t) => {
  const { handle } = await finalized(t);
  const eventsPath = path.join(handle.runDir, 'events.jsonl');
  const summaryPath = path.join(handle.runDir, 'summary.json');
  const summary = json(summaryPath);
  const events = readFileSync(eventsPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
  const triage = events.find((event) => event.type === 'pipeline_phase_completed' && event.phase === 'triage');
  const finalizedEvent = events.find((event) => event.type === 'run_finalized');
  const now = Date.now();
  const endedAtMs = now + 1_500;
  summary.finishedAt = new Date(now + 1_000).toISOString();
  triage.timestamp = new Date(now + 500).toISOString();
  finalizedEvent.timestamp = new Date(now + 1_100).toISOString();
  writeFileSync(summaryPath, JSON.stringify(summary));
  writeFileSync(eventsPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  const evidence = verifyPipelineEvidence(handle, endedAtMs);
  assert.equal(evidence.pass, false);
  assert.equal(evidence.reason, 'phase-event-time-order-mismatch');
});

test('phase events cannot claim completion after the run summary finished', async (t) => {
  const { handle } = await finalized(t);
  const eventsPath = path.join(handle.runDir, 'events.jsonl');
  const summary = json(path.join(handle.runDir, 'summary.json'));
  const events = readFileSync(eventsPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
  const complete = events.find((event) => event.type === 'pipeline_phase_completed' && event.phase === 'complete');
  const finalizedEvent = events.find((event) => event.type === 'run_finalized');
  const finishedAtMs = Date.parse(summary.finishedAt);
  complete.timestamp = new Date(finishedAtMs + 500).toISOString();
  finalizedEvent.timestamp = new Date(finishedAtMs + 600).toISOString();
  writeFileSync(eventsPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  const evidence = verifyPipelineEvidence(handle, finishedAtMs + 1_000);
  assert.equal(evidence.pass, false);
  assert.equal(evidence.reason, 'phase-event-after-summary');
});

test('run_finalized event cannot predate summary finalization', async (t) => {
  const { handle } = await finalized(t);
  const eventsPath = path.join(handle.runDir, 'events.jsonl');
  const summaryPath = path.join(handle.runDir, 'summary.json');
  const summary = json(summaryPath);
  const events = readFileSync(eventsPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
  const finalizedEvent = events.find((event) => event.type === 'run_finalized');
  const endedAtMs = Date.now() + 1_000;
  summary.finishedAt = new Date(endedAtMs - 500).toISOString();
  writeFileSync(summaryPath, JSON.stringify(summary));
  const evidence = verifyPipelineEvidence(handle, endedAtMs);
  assert.equal(evidence.pass, false);
  assert.equal(evidence.reason, 'missing-run-finalization');
  assert.ok(Date.parse(finalizedEvent.timestamp) < Date.parse(summary.finishedAt));
});

test('symlinked evidence files are rejected', { skip: process.platform === 'win32' }, async (t) => {
  const { handle } = await finalized(t);
  const backup = `${handle.pipelinePath}.real`;
  const content = readFileSync(handle.pipelinePath);
  writeFileSync(backup, content);
  unlinkSync(handle.pipelinePath);
  symlinkSync(backup, handle.pipelinePath);
  const evidence = verifyPipelineEvidence(handle);
  assert.equal(evidence.pass, false);
  assert.equal(evidence.reason, 'unsafe-file-type');
});

test('stale copied evidence mtimes are rejected even under the pre-allocated identity', async (t) => {
  const { handle } = await finalized(t);
  utimesSync(handle.pipelinePath, new Date(0), new Date(0));
  const evidence = verifyPipelineEvidence(handle);
  assert.equal(evidence.pass, false);
  assert.equal(evidence.reason, 'stale-evidence-file');
});

test('JSON object insertion order is not treated as schema semantics', async (t) => {
  const { handle } = await finalized(t);
  const ledger = json(handle.pipelinePath);
  const reorderedPhases = Object.fromEntries(Object.entries(ledger.phases).reverse());
  writeFileSync(handle.pipelinePath, JSON.stringify({
    phases: reorderedPhases,
    attempt: ledger.attempt,
    updatedAt: ledger.updatedAt,
    createdAt: ledger.createdAt,
    orchestrator: ledger.orchestrator,
    runId: ledger.runId,
    schemaVersion: ledger.schemaVersion,
  }));
  assert.equal(verifyPipelineEvidence(handle).pass, true);
});

test('runEval fails provider-success + grader-green when pipeline evidence is absent', async (t) => {
  const root = tempDir(t, 'ao-eval-pipeline-integration-red-');
  const result = await runEval(REGRESSION_TASK, {
    live: true,
    maxBudgetUsd: 1,
    k: 1,
    runId: 'pipeline-missing',
    resultsDir: path.join(root, 'results'),
    pluginDir: makePlugin(root),
    spawn: fakeLiveSpawn({ pipeline: false }),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.results[0].checks.find((check) => check.name === 'pipeline-evidence').pass, false);
  assert.equal(result.results[0].pipelineEvidence.reason, 'active-run-not-finalized');
});

test('runEval passes only when provider, pipeline, and independent grader all pass', async (t) => {
  const root = tempDir(t, 'ao-eval-pipeline-integration-green-');
  const result = await runEval(REGRESSION_TASK, {
    live: true,
    maxBudgetUsd: 1,
    k: 1,
    runId: 'pipeline-green',
    resultsDir: path.join(root, 'results'),
    pluginDir: makePlugin(root),
    spawn: fakeLiveSpawn(),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.results[0].pass, true);
  assert.equal(result.summary.pipelineEvidence.required, true);
  assert.equal(result.summary.pipelineEvidence.passedTrials, 1);
  assert.equal(result.results[0].pipelineEvidence.pass, true);
});

test('runEval accepts a valid Athena provider, pipeline, and grader result', async (t) => {
  const root = tempDir(t, 'ao-eval-pipeline-athena-green-');
  const taskDir = mkdtempSync(path.join(REPO_ROOT, 'evals/tasks/_tmp-athena-'));
  t.after(() => rmSync(taskDir, { recursive: true, force: true }));
  cpSync(REGRESSION_TASK, taskDir, { recursive: true });
  const taskPath = path.join(taskDir, 'task.json');
  const task = json(taskPath);
  task.orchestrator = 'athena';
  writeFileSync(taskPath, `${JSON.stringify(task, null, 2)}\n`);
  const result = await runEval(taskDir, {
    live: true,
    maxBudgetUsd: 1,
    k: 1,
    runId: 'pipeline-athena-green',
    resultsDir: path.join(root, 'results'),
    pluginDir: makePlugin(root),
    spawn: fakeLiveSpawn({ orchestrator: 'athena' }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.results[0].pipelineEvidence.pass, true);
  assert.equal(result.results[0].pipelineEvidence.orchestrator, 'athena');
});

test('fixture mode remains hermetic and records pipeline evidence as not applicable', async (t) => {
  const root = tempDir(t, 'ao-eval-pipeline-fixture-');
  const result = await runEval(REGRESSION_TASK, {
    fixture: 'solution',
    k: 1,
    runId: 'pipeline-fixture',
    resultsDir: path.join(root, 'results'),
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.results[0].pipelineEvidence, pipelineEvidenceNotApplicable('fixture-mode'));
  assert.equal(result.results[0].checks.some((check) => check.name === 'pipeline-evidence'), false);
});
