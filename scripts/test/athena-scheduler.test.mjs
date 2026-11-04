import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAthenaRuntime, tickAthenaRuntime, cancelAthenaRuntime, readAthenaRuntime } from '../lib/athena-scheduler.mjs';
import { readActiveConcurrencyCounts } from '../lib/concurrency-limits.mjs';
import { validateExecutionPrd } from '../lib/execution-prd.mjs';
const spec = {
  projectName: 'runtime-test', mode: 'engineering-change', scale: 'M',
  goals: ['Execute verified dependency waves'], nonGoals: ['Publish changes'], constraints: ['No live providers'], risks: ['Recovery'], openQuestions: [],
  userStories: [
    { id: 'US-001', assignedWorker: 'one', scope: ['first.txt'], parallelGroup: 'A' },
    { id: 'US-002', assignedWorker: 'two', scope: ['second.txt'], parallelGroup: 'A' },
    { id: 'US-003', assignedWorker: 'three', scope: ['third.txt'], parallelGroup: 'B', dependsOn: ['US-001', 'US-002'] },
  ].map(story => ({ ...story, title: `Implement ${story.id}`, workerType: 'claude', agentType: 'executor', model: 'sonnet',
    acceptanceCriteria: ['GIVEN committed inputs WHEN the worker finishes THEN its assigned output is committed'], passes: false })),
};
test('dependency waves are opt-in; legacy execution still rejects cross-worker dependencies', () => {
  assert.equal(validateExecutionPrd(spec, { orchestrator: 'athena' }).ok, false);
  assert.equal(validateExecutionPrd(spec, { orchestrator: 'athena', allowDependencyWaves: true }).ok, true);
});

for (const scenario of ['verification', 'worker']) {
  test(`scheduler ${scenario} failure is durable, stops its wave, releases reserved capacity, and never repeats execution`, async () => {
    const original = process.cwd();
    const root = mkdtempSync(join(tmpdir(), 'ao-scheduler-failure-'));
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'AO Test']);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'ao@example.test']);
    writeFileSync(join(root, '.gitignore'), '.ao/\n');
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'initial']);
    process.chdir(root);
    let state;
    try {
      const verification = scenario === 'verification'
        ? "require('fs').appendFileSync('.ao/check-count','x'); process.exit(7)" : 'process.exit(0)';
      state = createAthenaRuntime({ cwd: root, prd: spec,
        verification: [{ command: process.execPath, args: ['-e', verification] }],
        childCapacity: { one: { codex: 1 }, two: { codex: 1 } },
        _inject: { probeProvider: provider => ({ provider, supported: true }) } });
      const initialHead = state.expectedHead;
      const inject = {
        spawnOptions: { supervisor: { adapterName: 'fixture', env: { AO_SUPERVISOR_ALLOW_FIXTURE: '1' } } },
        fixtureForStory: story => scenario === 'worker'
          ? { delayMs: story.id === 'US-001' ? 10 : 20000, exitCode: story.id === 'US-001' ? 1 : 0 }
          : { delayMs: 10, change: { path: story.scope[0], content: story.id } },
      };
      const deadline = Date.now() + 15000;
      do {
        state = await tickAthenaRuntime(root, state.id, inject);
        if (state.status !== 'failed') await new Promise(resolve => setTimeout(resolve, 40));
      } while (state.status !== 'failed' && Date.now() < deadline);
      assert.equal(state.status, 'failed', JSON.stringify(state));
      assert.equal(state.waves.length, 1); // dependent story must never launch
      assert.equal(state.waves[0].shutdownState, 'completed');
      assert.equal(state.waves[0].cleanupError, undefined);
      assert.equal(readActiveConcurrencyCounts(root).global, 0);
      assert.equal(readAthenaRuntime(root, state.id).status, 'failed');
      assert.match(state.failure.recovery, /retained branches/);
      const failed = JSON.stringify(state);
      state = await tickAthenaRuntime(root, state.id, inject);
      assert.equal(JSON.stringify(state), failed);
      if (scenario === 'verification') {
        assert.equal(state.failure.category, 'verification_failed');
        assert.notEqual(state.expectedHead, initialHead);
        assert.equal(readFileSync(join(root, '.ao/check-count'), 'utf8'), 'x');
        assert.equal(readFileSync(join(root, 'first.txt'), 'utf8'), 'US-001');
        assert.ok(state.waves[0].workers.every(worker => worker.mergeCommit));
        assert.equal(state.tasks[0].status, 'merged_unverified');
      } else {
        assert.equal(state.tasks[0].status, 'failed');
        assert.equal(state.tasks[1].status, 'cancelled');
      }
    } finally {
      if (state) await cancelAthenaRuntime(root, state.id);
      process.chdir(original);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
test('scheduler executes independent detached workers, verifies integration, then launches a dependent worker from the new revision', async () => {
  const cwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), 'ao-scheduler-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'AO Test']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'ao@example.test']);
  writeFileSync(join(root, '.gitignore'), '.ao/\n');
  execFileSync('git', ['-C', root, 'add', '.']); execFileSync('git', ['-C', root, 'commit', '-qm', 'initial']);
  process.chdir(root);
  let state;
  try {
    state = createAthenaRuntime({ cwd: root, prd: spec,
      verification: [{ command: process.execPath, args: ['-e', "const fs=require('fs'); if(fs.readFileSync('first.txt','utf8')!=='first'||fs.readFileSync('second.txt','utf8')!=='second')process.exit(1)"] }],
      _inject: { probeProvider: provider => ({ provider, supported: true }) } });
    const inject = {
      spawnOptions: { supervisor: { adapterName: 'fixture', env: { AO_SUPERVISOR_ALLOW_FIXTURE: '1' } } },
      fixtureForStory: story => ({ delayMs: 100, output: story.id, change: story.id === 'US-001'
        ? { path: 'first.txt', content: 'first' } : story.id === 'US-002'
          ? { path: 'second.txt', content: 'second' }
          : { path: 'third.txt', content: 'third', expectPath: 'first.txt', expectContent: 'first' } }),
    };
    state = await tickAthenaRuntime(root, state.id, inject);
    assert.equal(state.waves[0].workers.length, 2);
    const deadline = Date.now() + 15000;
    while (state.status !== 'completed' && Date.now() < deadline) {
      assert.notEqual(state.status, 'failed', JSON.stringify(state));
      await new Promise(r => setTimeout(r, 40));
      state = await tickAthenaRuntime(root, state.id, inject);
    }
    assert.equal(state.status, 'completed', JSON.stringify(state));
    assert.equal(state.waves.length, 2);
    assert.notEqual(state.waves[0].baseCommit, state.waves[1].baseCommit);
    assert.equal(readFileSync(join(root, 'third.txt'), 'utf8'), 'third');
  } finally {
    if (state && state.status !== 'completed') await cancelAthenaRuntime(root, state.id);
    process.chdir(cwd); rmSync(root, { recursive: true, force: true });
  }
});
