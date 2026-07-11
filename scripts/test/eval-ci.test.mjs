import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

test('baseline matches schema-level rules and every regression task at the same k', () => {
  const baseline = readBaseline(path.join(EVALS_DIR, 'baseline.json'), { required: true });
  assert.deepEqual(validateBaseline(baseline), []);
  assert.deepEqual(verifyBaselineIntegrity(), { schemaVersion: 1, tasks: 3, k: 3 });

  const schema = JSON.parse(readFileSync(path.join(EVALS_DIR, '_schema/baseline.schema.json'), 'utf-8'));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(new Set(schema.required), new Set(Object.keys(schema.properties)));
  const taskSchema = schema.properties.tasks.additionalProperties;
  assert.equal(taskSchema.additionalProperties, false);
  assert.deepEqual(new Set(taskSchema.required), new Set(Object.keys(taskSchema.properties)));
});

test('baseline refresh preserves last-known-good and fixture runs cannot update it', async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'ao-eval-baseline-'));
  const baselinePath = path.join(tempRoot, 'baseline.json');
  cpSync(path.join(EVALS_DIR, 'baseline.json'), baselinePath);

  try {
    await updateBaselineTask(baselinePath, {
      taskId: 'fix-failing-test',
      k: 3,
      passHatK: true,
    });
    assert.equal(readBaseline(baselinePath, { required: true }).tasks['fix-failing-test'].passHatK, true);
    await assert.rejects(
      () => updateBaselineTask(baselinePath, {
        taskId: 'fix-failing-test',
        k: 3,
        passHatK: false,
      }),
      /last-known-good baseline with a failing result/,
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

test('eval workflow is structurally present and contains only hermetic eval commands', () => {
  const workflow = readFileSync(WORKFLOW_PATH, 'utf-8');
  assert.match(workflow, /^name:/m);
  assert.match(workflow, /^on:/m);
  assert.match(workflow, /^jobs:/m);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /node evals\/verify-baseline\.mjs/);
  assert.match(workflow, /node evals\/verify-fixtures\.mjs/);
  assert.doesNotMatch(workflow, /fix-failing-test|fix-null-deref|fix-off-by-one/);
  assert.doesNotMatch(workflow, /--live\b/);
  assert.doesNotMatch(workflow, /\bclaude\s+-p\b/);
});
