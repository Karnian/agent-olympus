import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateRuntimeLedger, reserveRuntimeSubtree, readActiveConcurrencyCounts, releaseRuntimeSubtree, bindRuntimeProcess } from '../lib/concurrency-limits.mjs';
import { createWorkerBroker } from '../lib/worker-broker.mjs';
import { createRuntimeProviderOptions, effectiveRuntimeLevel } from '../lib/runtime-provider.mjs';
import { reassignProvider } from '../lib/worker-spawn.mjs';
import { buildExecOpts } from '../lib/supervisor-opts.mjs';

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'ao-broker-'));
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, '.gitignore'), '.ao/\n');
  writeFileSync(join(root, 'file.txt'), 'initial');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=AO Test', '-c', 'user.email=ao@example.test', 'commit', '-qm', 'initial']);
  migrateRuntimeLedger(root);
  const reservation = reserveRuntimeSubtree(root, { runId: 'a'.repeat(16), parentId: 'parent', provider: 'claude', children: { codex: 2 } });
  bindRuntimeProcess(root, reservation.parentEntryId, process.pid);
  return { root, m: { projectRoot: root, cwd: root, runId: 'a'.repeat(16), workerRunId: 'b'.repeat(16),
    parentEntryId: reservation.parentEntryId, workerName: 'parent', adapterName: 'fixture', level: 'auto-edit', scope: ['file.txt'], timeoutMs: 5000 } };
}
test('broker: two leaf processes overlap within reserved capacity, result collection frees no parent capacity, and leaf MCP cannot delegate', async () => {
  const { root, m } = repo();
  const prior = process.env.AO_SUPERVISOR_ALLOW_FIXTURE;
  process.env.AO_SUPERVISOR_ALLOW_FIXTURE = '1';
  const broker = await createWorkerBroker(m);
  let proxy;
  try {
    m.level = 'suggest';
    await assert.rejects(broker.dispatch('spawn', { id: 'f'.repeat(16), provider: 'codex', scope: ['file.txt'], prompt: 'write' }), /read-only/);
    m.level = 'auto-edit';
    const request = id => ({ id, provider: 'codex', scope: ['file.txt'], readOnly: true, prompt: 'child result' });
    const one = await broker.dispatch('spawn', request('c'.repeat(16)));
    const two = await broker.dispatch('spawn', request('d'.repeat(16)));
    assert.equal(one.status, 'running'); assert.equal(two.status, 'running');
    assert.equal((await broker.dispatch('spawn', request('e'.repeat(16)))).status, 'denied');
    assert.throws(() => broker.assertResolved(), /child results/);
    const deadline = Date.now() + 7000;
    for (const id of [one.id, two.id]) {
      let result;
      while (Date.now() < deadline) {
        result = await broker.dispatch('inspect', { id });
        if (result.status === 'completed') break;
        await new Promise(r => setTimeout(r, 25));
      }
      assert.equal(result.status, 'completed'); assert.equal(result.output, 'child result');
    }
    broker.assertResolved();
    m.level = 'suggest';
    await assert.rejects(broker.dispatch('integrate', { id: one.id }), /integration writes/);
    m.level = 'auto-edit';
    assert.equal(readActiveConcurrencyCounts(root).global, 3);
    const attach = broker.bootstrap('leaf');
    const credentials = JSON.parse(readFileSync(attach));
    proxy = spawn(process.execPath, [fileURLToPath(new URL('../runtime-mcp.mjs', import.meta.url)), attach], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: proxy.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    proxy.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    const response = JSON.parse((await iterator.next()).value);
    assert.deepEqual(response.result.tools, []);
    assert.equal(existsSync(attach), false);
    await new Promise((resolve, reject) => {
      const replay = connect(credentials.port, '127.0.0.1', () => replay.write(JSON.stringify({ id: 1, token: credentials.token }) + '\n'));
      const timer = setTimeout(() => { replay.destroy(); reject(new Error('replayed bootstrap was not rejected')); }, 2000);
      replay.on('data', () => { clearTimeout(timer); replay.destroy(); reject(new Error('replayed bootstrap received a grant')); });
      replay.on('close', () => { clearTimeout(timer); resolve(); }); replay.on('error', reject);
    });
    proxy.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'spawn', arguments: request('f'.repeat(16)) } }) + '\n');
    assert.match(JSON.parse((await iterator.next()).value).error.message, /unavailable/);
    proxy.stdin.end();
    lines.close();
  } finally {
    proxy?.kill('SIGKILL'); await broker.close(); releaseRuntimeSubtree(root, m.parentEntryId);
    if (prior === undefined) delete process.env.AO_SUPERVISOR_ALLOW_FIXTURE; else process.env.AO_SUPERVISOR_ALLOW_FIXTURE = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
test('broker refuses out-of-scope child commits and preserves the branch for explicit discard', async () => {
  const { root, m } = repo();
  const prior = process.env.AO_SUPERVISOR_ALLOW_FIXTURE;
  process.env.AO_SUPERVISOR_ALLOW_FIXTURE = '1';
  const broker = await createWorkerBroker(m);
  try {
    await assert.rejects(createWorkerBroker({ ...m, workerName: 'forged-parent', workerRunId: 'f'.repeat(16) }), /bound/);
    const id = 'e'.repeat(16);
    await broker.dispatch('spawn', { id, provider: 'codex', scope: ['file.txt'], prompt: 'work' });
    let result;
    const deadline = Date.now() + 7000;
    do {
      result = await broker.dispatch('inspect', { id });
      if (result.status !== 'completed') await new Promise(r => setTimeout(r, 20));
    } while (result.status !== 'completed' && Date.now() < deadline);
    assert.equal(result.status, 'completed');
    writeFileSync(join(result.cwd, 'outside.txt'), 'out of scope');
    execFileSync('git', ['-C', result.cwd, 'add', 'outside.txt']);
    execFileSync('git', ['-C', result.cwd, '-c', 'user.name=AO Test', '-c', 'user.email=ao@example.test', 'commit', '-qm', 'invalid child scope']);
    await assert.rejects(broker.dispatch('integrate', { id }), /outside its scope/);
    assert.equal(existsSync(join(root, 'outside.txt')), false);
    await broker.dispatch('discard', { id }); broker.assertResolved();
    assert.equal(existsSync(join(result.cwd, 'outside.txt')), true);
  } finally {
    await broker.close(); releaseRuntimeSubtree(root, m.parentEntryId);
    if (prior === undefined) delete process.env.AO_SUPERVISOR_ALLOW_FIXTURE; else process.env.AO_SUPERVISOR_ALLOW_FIXTURE = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
test('runtime provider configuration removes native Claude delegation and configures Codex/Gemini restrictions without parent secrets in env', () => {
  const config = createRuntimeProviderOptions({ readOnly: false }, '/private/attach.json');
  try {
    assert.ok(!config.options.tools.includes('Agent') && !config.options.tools.includes('Task'));
    assert.ok(config.options.configOverrides.includes('features.multi_agent=false'));
    const gemini = JSON.parse(readFileSync(config.options.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH));
    assert.equal(gemini.experimental.enableAgents, false);
    assert.equal(gemini.mcpServers.ao_runtime.trust, true);
    assert.deepEqual(Object.keys(config.options.env), ['GEMINI_CLI_SYSTEM_SETTINGS_PATH']);
    const leaf = buildExecOpts({ runtimeLeaf: true, level: 'auto-edit', permissionMode: 'bypassPermissions', runtimeOptions: config.options });
    assert.equal(leaf.permissionMode, 'acceptEdits');
    assert.equal(buildExecOpts({ runtimeLeaf: true, level: 'auto-edit', approvalMode: 'yolo', runtimeOptions: config.options }).approvalMode, 'auto_edit');
    assert.equal(effectiveRuntimeLevel({ level: 'full-auto', permissionMode: 'plan' }), 'suggest');
  } finally { config.cleanup(); }
});
test('legacy provider failover cannot silently replace a managed subtree', async () => {
  const result = await reassignProvider('managed-test', 'parent', 'task', 'crash', undefined, {
    worker: { managed: true, name: 'parent', type: 'codex' },
  });
  assert.equal(result.blocked, true);
  assert.equal(result.fallbackNeeded, false);
  assert.equal(result.replacementWorker, null);
});
