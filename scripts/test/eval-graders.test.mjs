import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

const tasks = [
  {
    id: 'fix-failing-test',
    sourceFile: path.join('src', 'sum.mjs'),
    fixedSource: `export function sum(a, b) {
  return a + b;
}
`,
  },
  {
    id: 'fix-null-deref',
    sourceFile: path.join('src', 'greet.mjs'),
    fixedSource: `export function greet(user) {
  const name = user?.name ? user.name : 'guest';
  return \`HELLO, \${name.toUpperCase()}\`;
}
`,
  },
  {
    id: 'fix-off-by-one',
    sourceFile: path.join('src', 'lastN.mjs'),
    fixedSource: `export function lastN(arr, n) {
  if (n <= 0) {
    return [];
  }
  return arr.slice(Math.max(arr.length - n, 0));
}
`,
  },
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
      writeFileSync(path.join(fixed.workdir, task.sourceFile), task.fixedSource);
      const result = await grader.grade(fixed.workdir);
      assert.equal(result.pass, true, `${task.id} fixed seed should pass: ${JSON.stringify(result)}`);
    } finally {
      rmSync(fixed.tempRoot, { recursive: true, force: true });
    }
  });
}
