import assert from 'node:assert/strict';
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
import { createFinalizedEvalPipelineFixture } from './helpers/eval-pipeline-fixture.mjs';

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
    trial: 1,
  });
}

function json(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
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
  return pluginDir;
}

function fakeLiveSpawn({ pipeline = true, solution = true, orchestrator = 'atlas' } = {}) {
  return (_command, _args, options) => {
    if (solution) cpSync(path.join(REGRESSION_TASK, 'solution'), options.cwd, { recursive: true, force: true });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    process.nextTick(() => {
      void (async () => {
        if (pipeline) await createFinalizedEvalPipelineFixture(options.cwd, orchestrator);
        child.stdout.end(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false })}\n`);
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
  assert.equal(Object.hasOwn(evidence, 'workdir'), false);
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
  const evidence = verifyPipelineEvidence(handle);
  assert.equal(evidence.pass, false);
  assert.equal(evidence.reason, 'active-run-not-finalized');
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
  const finalizedEvent = events.find((event) => event.type === 'run_finalized');
  writeFileSync(eventsPath, `${[...completions, finalizedEvent].map((event) => JSON.stringify(event)).join('\n')}\n`);
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
