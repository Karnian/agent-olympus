import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  { id: 'role-executor-scope', track: 'capability' },
  { id: 'role-hephaestus-scope', track: 'capability' },
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

test('deep-merge grader rejects implementations that mutate their inputs', async () => {
  const candidate = copySeed('fix-deep-merge');
  try {
    writeFileSync(path.join(candidate.workdir, 'src', 'mergeConfig.mjs'), `
function apply(base, override) {
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      base[key] = apply(base[key] || {}, value);
    } else {
      base[key] = value;
    }
  }
  return base;
}
export function mergeConfig(base, override) {
  apply(base, override);
  return structuredClone(base);
}
`);
    const grader = await import(new URL('../../evals/tasks/fix-deep-merge/grader.mjs', import.meta.url));
    const result = await grader.grade(candidate.workdir);
    assert.equal(result.checks[0].pass, true, 'control: public tests do not catch input mutation');
    assert.equal(result.checks[1].pass, false, 'hidden invariants must reject input mutation');
  } finally {
    rmSync(candidate.tempRoot, { recursive: true, force: true });
  }
});

test('map-limit grader rejects duplicate mapper side effects', async () => {
  const candidate = copySeed('fix-map-limit');
  try {
    writeFileSync(path.join(candidate.workdir, 'src', 'mapLimit.mjs'), `
export async function mapLimit(items, limit, mapper) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('invalid limit');
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  for (let index = 0; index < items.length; index += 1) await mapper(items[index], index);
  return results;
}
`);
    const grader = await import(new URL('../../evals/tasks/fix-map-limit/grader.mjs', import.meta.url));
    const result = await grader.grade(candidate.workdir);
    assert.equal(result.checks[0].pass, true, 'control: public tests do not catch duplicate mapper calls');
    assert.equal(result.checks[1].pass, false, 'hidden invariants must reject duplicate mapper calls');
  } finally {
    rmSync(candidate.tempRoot, { recursive: true, force: true });
  }
});

test('hook-isolated direct-agent scope grader rejects .ao and ordinary candidate files', async () => {
  const candidate = copySeed('role-executor-scope');
  try {
    cpSync(
      path.join(repoRoot, 'evals', 'tasks', 'role-executor-scope', 'solution'),
      candidate.workdir,
      { recursive: true, force: true },
    );
    const grader = await import(
      new URL('../../evals/tasks/role-executor-scope/grader.mjs', import.meta.url)
    );
    mkdirSync(path.join(candidate.workdir, '.ao/state'), { recursive: true });
    writeFileSync(path.join(candidate.workdir, '.ao/state/ao-intent.json'), '{}\n', {
      flag: 'w',
      flush: true,
    });
    const withHarnessState = await grader.grade(candidate.workdir);
    assert.equal(withHarnessState.pass, false, 'hook-isolated trials must not create .ao state');

    rmSync(path.join(candidate.workdir, '.ao'), { recursive: true, force: true });

    writeFileSync(path.join(candidate.workdir, 'UNRELATED.md'), 'candidate-created\n');
    const withCandidateFile = await grader.grade(candidate.workdir);
    assert.equal(withCandidateFile.pass, false, 'ordinary added files remain a scope violation');
  } finally {
    rmSync(candidate.tempRoot, { recursive: true, force: true });
  }
});
