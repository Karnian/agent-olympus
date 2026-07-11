import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

const tasks = [
  { id: 'fix-failing-test', track: 'regression' },
  { id: 'fix-null-deref', track: 'regression' },
  { id: 'fix-off-by-one', track: 'regression' },
  { id: 'fix-deep-merge', track: 'capability' },
  { id: 'fix-map-limit', track: 'capability' },
  { id: 'fix-lru-cache', track: 'capability' },
];

function copySeed(taskId) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), `ao-${taskId}-`));
  const workdir = path.join(tempRoot, 'workdir');
  cpSync(path.join(repoRoot, 'evals', 'tasks', taskId, 'seed'), workdir, { recursive: true });
  return { tempRoot, workdir };
}

for (const task of tasks) {
  test(`${task.id} grader reds broken seed and greens fixed seed`, async () => {
    const grader = await import(
      new URL(`../../evals/tasks/${task.id}/grader.mjs`, import.meta.url)
    );

    const broken = copySeed(task.id);
    try {
      const result = await grader.grade(broken.workdir);
      assert.equal(result.pass, false, `${task.id} broken seed should fail`);
      assert.equal(
        result.checks.some((check) => check.name === 'tests-pass' && check.pass === false),
        true,
        `${task.id} broken seed should fail its tests`,
      );
    } finally {
      rmSync(broken.tempRoot, { recursive: true, force: true });
    }

    const fixed = copySeed(task.id);
    try {
      cpSync(
        path.join(repoRoot, 'evals', 'tasks', task.id, 'solution'),
        fixed.workdir,
        { recursive: true, force: true },
      );
      const result = await grader.grade(fixed.workdir);
      assert.equal(result.pass, true, `${task.id} fixed seed should pass: ${JSON.stringify(result)}`);
    } finally {
      rmSync(fixed.tempRoot, { recursive: true, force: true });
    }
  });
}

// Full-pipeline proof: run.mjs + the `solution` fixture (which applies each
// task's reference solution/) must produce a GREEN summary on the real tasks,
// while no fixture leaves the seed broken → RED. This exercises
// run → orchestrate(fixture) → grade → score end-to-end on the golden tasks
// without a live orchestrator.
for (const task of tasks.filter((candidate) => candidate.track === 'regression')) {
  test(`${task.id} runs GREEN via --fixture solution and RED without it`, async () => {
    const { runEval } = await import(new URL('../../evals/run.mjs', import.meta.url));
    const taskDir = path.join(repoRoot, 'evals', 'tasks', task.id);
    const resultsRoot = mkdtempSync(path.join(tmpdir(), `ao-run-${task.id}-`));
    try {
      const green = await runEval(taskDir, { fixture: 'solution', resultsDir: resultsRoot, runId: `green-${task.id}` });
      assert.equal(green.summary.passHatK, true, `${task.id} should be GREEN with the reference solution`);
      assert.equal(green.exitCode, 0);

      const red = await runEval(taskDir, { fixture: 'none', resultsDir: resultsRoot, runId: `red-${task.id}` });
      assert.equal(red.summary.passHatK, false, `${task.id} should be RED with no fix applied`);
      assert.notEqual(red.exitCode, 0);
    } finally {
      rmSync(resultsRoot, { recursive: true, force: true });
    }
  });
}

test('runEval refuses an implicit live run (no fixture, no --live)', async () => {
  const { runEval } = await import(new URL('../../evals/run.mjs', import.meta.url));
  const taskDir = path.join(repoRoot, 'evals', 'tasks', 'fix-failing-test');
  await assert.rejects(
    () => runEval(taskDir, { runId: 'guard' }),
    /Refusing to run the real orchestrator implicitly/,
    'a bare run must not silently spawn a real unsupervised orchestrator',
  );
});
