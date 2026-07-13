import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readBaseline, updateBaselineTask, validateBaseline } from '../../evals/lib/baseline.mjs';
import { runEval } from '../../evals/run.mjs';
import { verifyBaselineIntegrity } from '../../evals/verify-baseline.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const EVALS_DIR = path.join(REPO_ROOT, 'evals');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/evals.yml');
const GITIGNORE_PATH = path.join(REPO_ROOT, '.gitignore');
const PACKAGE_PATH = path.join(REPO_ROOT, 'package.json');

test('baseline matches schema-level rules and every regression task at the same k', () => {
  const baseline = readBaseline(path.join(EVALS_DIR, 'baseline.json'), { required: true });
  assert.deepEqual(validateBaseline(baseline), []);
  assert.deepEqual(verifyBaselineIntegrity(), {
    schemaVersion: 1,
    tasks: 3,
    k: 3,
    protocolReviewRequired: [],
  });

  const schema = JSON.parse(readFileSync(path.join(EVALS_DIR, '_schema/baseline.schema.json'), 'utf-8'));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(new Set(schema.required), new Set(Object.keys(schema.properties)));
  const taskSchema = schema.properties.tasks.additionalProperties;
  assert.equal(taskSchema.additionalProperties, false);
  assert.deepEqual(new Set(taskSchema.required), new Set(Object.keys(taskSchema.properties)));
});

test('baseline integrity preserves a measured LKG protocol identity and reports review', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'ao-eval-baseline-protocol-'));
  const baselinePath = path.join(tempRoot, 'baseline.json');
  try {
    const baseline = readBaseline(path.join(EVALS_DIR, 'baseline.json'), { required: true });
    baseline.tasks['fix-failing-test'] = {
      ...baseline.tasks['fix-failing-test'],
      source: 'live',
      runId: 'historical-live-run',
      measuredAt: '2026-07-12T00:00:00.000Z',
      modelTier: 'sonnet',
      pipelineProtocolFingerprint: 'f'.repeat(64),
    };
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);

    assert.deepEqual(verifyBaselineIntegrity({ baselinePath }), {
      schemaVersion: 1,
      tasks: 3,
      k: 3,
      protocolReviewRequired: ['fix-failing-test'],
    });
    assert.equal(
      readBaseline(baselinePath, { required: true }).tasks['fix-failing-test'].pipelineProtocolFingerprint,
      'f'.repeat(64),
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('baseline refresh preserves last-known-good and fixture runs cannot update it', async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'ao-eval-baseline-'));
  const baselinePath = path.join(tempRoot, 'baseline.json');
  cpSync(path.join(EVALS_DIR, 'baseline.json'), baselinePath);

  try {
    const originalEntry = readBaseline(baselinePath, { required: true }).tasks['fix-failing-test'];
    await updateBaselineTask(baselinePath, {
      taskId: 'fix-failing-test',
      k: 3,
      passHatK: true,
      runId: 'trusted-live-run',
      measuredAt: '2026-07-12T00:00:00.000Z',
      modelTier: 'sonnet',
      orchestrator: 'atlas',
      benchmarkFingerprint: originalEntry.benchmarkFingerprint,
      pipelineProtocolFingerprint: originalEntry.pipelineProtocolFingerprint,
    });
    assert.deepEqual(readBaseline(baselinePath, { required: true }).tasks['fix-failing-test'], {
      k: 3,
      passHatK: true,
      source: 'live',
      runId: 'trusted-live-run',
      measuredAt: '2026-07-12T00:00:00.000Z',
      modelTier: 'sonnet',
      orchestrator: 'atlas',
      benchmarkFingerprint: originalEntry.benchmarkFingerprint,
      pipelineProtocolFingerprint: originalEntry.pipelineProtocolFingerprint,
    });
    await assert.rejects(
      () => updateBaselineTask(baselinePath, {
        taskId: 'fix-failing-test',
        k: 3,
        passHatK: false,
        runId: 'failed-live-run',
        measuredAt: '2026-07-12T00:00:00.000Z',
        modelTier: 'sonnet',
      }),
      /last-known-good baseline with a failing result/,
    );
    await assert.rejects(
      () => updateBaselineTask(baselinePath, {
        taskId: 'fix-null-deref',
        k: 3,
        passHatK: true,
      }),
      /requires runId/,
    );

    await assert.rejects(
      () => runEval(path.join(EVALS_DIR, 'tasks/fix-failing-test'), {
        fixture: 'solution',
        runId: 'fixture-refresh',
        resultsDir: path.join(tempRoot, 'results'),
        baselinePath,
        updateBaseline: true,
      }),
      /requires an explicit live run without fixtures/,
    );
    await assert.rejects(
      () => runEval(path.join(EVALS_DIR, 'tasks/fix-failing-test'), {
        live: true,
        fixture: 'solution',
      }),
      /exactly one execution mode/,
    );
    await assert.rejects(
      () => runEval(path.join(EVALS_DIR, 'tasks/fix-deep-merge'), {
        live: true,
        updateBaseline: true,
      }),
      /Only regression tasks/,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('concurrent baseline refreshes fail explicitly instead of losing an update', async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'ao-eval-baseline-race-'));
  const baselinePath = path.join(tempRoot, 'baseline.json');
  cpSync(path.join(EVALS_DIR, 'baseline.json'), baselinePath);
  const baseline = readBaseline(baselinePath, { required: true });
  const refresh = (taskId, runId) => updateBaselineTask(baselinePath, {
    taskId,
    k: 3,
    passHatK: true,
    runId,
    measuredAt: '2026-07-12T00:00:00.000Z',
    modelTier: 'sonnet',
    orchestrator: 'atlas',
    benchmarkFingerprint: baseline.tasks[taskId].benchmarkFingerprint,
    pipelineProtocolFingerprint: baseline.tasks[taskId].pipelineProtocolFingerprint,
  });
  try {
    const settled = await Promise.allSettled([
      refresh('fix-failing-test', 'live-a'),
      refresh('fix-null-deref', 'live-b'),
    ]);
    assert.deepEqual(settled.map((item) => item.status).sort(), ['fulfilled', 'rejected']);
    assert.match(settled.find((item) => item.status === 'rejected').reason.message, /refresh already in progress/);
    const updated = readBaseline(baselinePath, { required: true });
    assert.equal(
      Object.values(updated.tasks).filter((entry) => entry.source === 'live').length,
      1,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('eval workflow is structurally present and contains only hermetic eval commands', () => {
  const workflow = readFileSync(WORKFLOW_PATH, 'utf-8');
  const packageJson = JSON.parse(readFileSync(PACKAGE_PATH, 'utf-8'));
  assert.match(workflow, /^name:/m);
  assert.match(workflow, /^on:/m);
  assert.match(workflow, /^jobs:/m);
  assert.match(workflow, /types: \[opened, synchronize, reopened, labeled\]/);
  assert.match(
    workflow,
    /contains\(github\.event\.pull_request\.labels\.\*\.name, 'run-evals'\)/,
  );
  assert.doesNotMatch(workflow, /github\.event\.label\.name/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /node evals\/verify-baseline\.mjs/);
  assert.match(workflow, /node evals\/verify-fixtures\.mjs/);
  assert.doesNotMatch(workflow, /fix-failing-test|fix-null-deref|fix-off-by-one/);
  assert.doesNotMatch(workflow, /--live\b/);
  assert.doesNotMatch(workflow, /\bclaude\s+-p\b/);
  assert.match(readFileSync(GITIGNORE_PATH, 'utf-8'), /^\/evals\/results\/$/m);
  assert.equal(packageJson.scripts.test, 'node scripts/run-tests.mjs');
});
