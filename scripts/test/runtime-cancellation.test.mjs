import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateRuntimeLedger, readActiveConcurrencyCounts } from '../lib/concurrency-limits.mjs';
import { spawnTeam, shutdownTeam } from '../lib/worker-spawn.mjs';
import { runtimeChildrenPath } from '../lib/worker-broker.mjs';
import { readSnapshot, snapshotPath } from '../lib/supervisor-state.mjs';
test('fresh-process cancellation reaps descendants of a killed parent before releasing their slots and preserves worktrees', async () => {
  const original = process.cwd();
  const root = mkdtempSync(join(tmpdir(), 'ao-runtime-cancel-'));
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, '.gitignore'), '.ao/\n'); writeFileSync(join(root, 'file.txt'), 'initial');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=AO Test', '-c', 'user.email=ao@example.test', 'commit', '-qm', 'initial']);
  process.chdir(root);
  let state;
  try {
    migrateRuntimeLedger(root);
    state = await spawnTeam('cancel-test', [{ name: 'parent', type: 'claude', prompt: 'delegate',
      cwd: root, scope: ['file.txt'], managed: true, persistent: true, childCapacity: { codex: 1 },
      fixture: { delayMs: 30000, leafDelayMs: 30000,
        delegate: { id: 'c'.repeat(16), provider: 'codex', readOnly: true, scope: ['file.txt'], prompt: 'wait' } },
    }], root, { hasClaudeCli: true }, {
      supervisor: { adapterName: 'fixture', env: { AO_SUPERVISOR_ALLOW_FIXTURE: '1' } },
    });
    const parent = state.workers[0];
    const identity = { projectRoot: state.projectRoot, runId: state.runId, workerRunId: parent._handle.workerRunId };
    const recordPath = runtimeChildrenPath(identity);
    let child;
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      if (existsSync(recordPath)) {
        child = JSON.parse(readFileSync(recordPath)).children[0];
        if (child?.supervisorPid && readSnapshot(snapshotPath(state.projectRoot, state.runId, child.workerRunId)).kind === 'ok') break;
      }
      await new Promise(r => setTimeout(r, 20));
    }
    assert.ok(child?.supervisorPid);
    process.kill(parent._handle.supervisorPid, 'SIGKILL');
    const modulePath = fileURLToPath(new URL('../lib/worker-spawn.mjs', import.meta.url));
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
      `import { shutdownTeam } from ${JSON.stringify(modulePath)}; await shutdownTeam('cancel-test');`], { cwd: root, timeout: 20000 });
    assert.equal(readActiveConcurrencyCounts(root).global, 0);
    assert.equal(existsSync(child.cwd), true);
    const snapshot = readSnapshot(snapshotPath(state.projectRoot, state.runId, child.workerRunId));
    assert.equal(snapshot.snapshot.status, 'cancelled');
  } finally {
    try { if (state) await shutdownTeam('cancel-test'); } catch {}
    process.chdir(original); rmSync(root, { recursive: true, force: true });
  }
});
