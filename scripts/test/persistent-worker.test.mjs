import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync } from '../lib/fs-atomic.mjs';
import { manifestPath, snapshotPath, readSnapshot } from '../lib/supervisor-state.mjs';
import { submitCommand, readCommandResult } from '../lib/supervisor-mailbox.mjs';
const supervisor = fileURLToPath(new URL('../lib/adapter-worker-supervisor.mjs', import.meta.url));
async function until(fn) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) { const value = fn(); if (value) return value; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('timed out');
}
test('persistent supervisor: independent processes submit follow-ups to the same worker, deduplicate, reject stale steering, and shut down', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ao-persistent-'));
  const identity = { projectRoot: root, runId: 'a'.repeat(16), workerRunId: 'b'.repeat(16) };
  const manifest = { schemaVersion: 1, ...identity, teamName: 'test', workerName: 'parent',
    adapterName: 'fixture', cwd: root, prompt: 'first', persistent: true,
    fixture: { echoPrompt: true, delayMs: 100 }, timeoutMs: 5000, idleTimeoutMs: 5000 };
  atomicWriteFileSync(manifestPath(root, identity.runId, identity.workerRunId), JSON.stringify(manifest));
  const child = spawn(process.execPath, [supervisor, manifestPath(root, identity.runId, identity.workerRunId)], {
    env: { ...process.env, AO_SUPERVISOR_ALLOW_FIXTURE: '1' }, stdio: 'ignore',
  });
  try {
    await until(() => readCommandResult(identity, identity.workerRunId)?.status === 'completed');
    const first = readSnapshot(snapshotPath(root, identity.runId, identity.workerRunId)).snapshot;
    assert.equal(first.status, 'running');
    const mailboxModule = fileURLToPath(new URL('../lib/supervisor-mailbox.mjs', import.meta.url));
    const code = `import { submitCommand } from ${JSON.stringify(mailboxModule)}; console.log(JSON.stringify(submitCommand(${JSON.stringify(identity)}, {id:'${'c'.repeat(32)}',type:'assign',prompt:'second'})))`;
    const submitted = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' }));
    submitCommand(identity, { id: submitted.id, type: 'assign', prompt: 'second' });
    await until(() => readCommandResult(identity, submitted.id)?.status === 'completed');
    assert.equal(readCommandResult(identity, submitted.id).output, 'second');
    const second = readSnapshot(snapshotPath(root, identity.runId, identity.workerRunId)).snapshot;
    assert.equal(second.supervisorPid, first.supervisorPid);
    const stale = submitCommand(identity, { type: 'steer', expectedTaskId: 'd'.repeat(32), prompt: 'wrong' });
    await until(() => readCommandResult(identity, stale.id)?.status === 'rejected');
    const shutdown = submitCommand(identity, { type: 'shutdown' });
    await until(() => readCommandResult(identity, shutdown.id)?.status === 'completed');
    await until(() => child.exitCode !== null);
    assert.equal(child.exitCode, 0);
  } finally { child.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }); }
});
