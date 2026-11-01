/** Worker-scoped broker. Transport identity is bound once; requests cannot choose a parent. */
import { createServer } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { ensureSafeDirectoryPath, revalidateDirectoryBinding, readRegularArtifact } from './hardened-fs.mjs';
import { supervisorRunDir, manifestPath, snapshotPath, outputPath, readSnapshot } from './supervisor-state.mjs';
import { claimRuntimeChild, bindRuntimeProcess, finishRuntimeChild, fenceRuntimeSubtree, assertRuntimeParent } from './concurrency-limits.mjs';
import { validateChangedPathsAgainstScope, parseNulDelimitedGitPaths } from './execution-prd.mjs';
import { createWorkerWorktree, mergeWorkerBranch } from './worktree.mjs';
import { resolveTrustedVcsBinary, sanitizedVcsEnvironment } from './trusted-vcs.mjs';
import { readProcStartId } from './proc-identity.mjs';

const supervisor = fileURLToPath(new URL('./adapter-worker-supervisor.mjs', import.meta.url));
const MAX_FRAME = 1024 * 1024;
export const WORKER_BROKER_SCHEMA_VERSION = 1;
export const RUNTIME_BOOTSTRAP_SCHEMA_VERSION = 1;
export function runtimeChildrenPath(m) {
  return join(supervisorRunDir(m.projectRoot, m.runId), `${m.workerRunId}.children.json`);
}
function git(cwd, args, binary = resolveTrustedVcsBinary('git')) {
  return execFileSync(binary, ['-C', cwd, ...args], { env: sanitizedVcsEnvironment({ git: true }), maxBuffer: 4 * 1024 * 1024 });
}
function clean(cwd) { if (git(cwd, ['status', '--porcelain', '-z']).length) throw new Error('a clean committed worker checkpoint is required'); }
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

export async function createWorkerBroker(m) {
  if (!m.parentEntryId || !validateChangedPathsAgainstScope([], m.scope).ok) throw new Error('invalid broker parent policy');
  assertRuntimeParent(m.projectRoot, m.parentEntryId, { runId: m.runId, parentId: m.workerName });
  const context = ensureSafeDirectoryPath(supervisorRunDir(m.projectRoot, m.runId), 'worker broker', { trustedRoot: m.projectRoot });
  const recordPath = runtimeChildrenPath(m);
  if (existsSync(recordPath)) throw new Error('broker recovery is ambiguous; preserve existing children instead of replaying');
  const children = new Map();
  const tokens = new Map();
  const sockets = new Set();
  const privateDirs = [];
  let closing = false;
  let mutation = Promise.resolve();
  const save = () => {
    revalidateDirectoryBinding(context, 'worker broker');
    atomicWriteFileSync(recordPath, JSON.stringify({ schemaVersion: WORKER_BROKER_SCHEMA_VERSION,
      runId: m.runId, workerRunId: m.workerRunId, parentEntryId: m.parentEntryId,
      closing, children: [...children.values()].map(({ process, ...item }) => item),
    }), { durable: true });
  };
  const check = item => {
    if (item.status === 'ambiguous') return { status: 'ambiguous' };
    const snapshot = readSnapshot(snapshotPath(m.projectRoot, m.runId, item.workerRunId),
      { runId: m.runId, workerRunId: item.workerRunId });
    if (snapshot.kind !== 'ok') return { status: item.process?.exitCode !== null && item.process?.exitCode !== undefined ? 'ambiguous' : 'running' };
    return snapshot.snapshot;
  };
  async function reap(item) {
    if (item.process) await new Promise(resolve => {
      if (item.process.exitCode !== null) return resolve();
      item.process.once('exit', resolve);
    });
    const release = finishRuntimeChild(m.projectRoot, m.parentEntryId, item.id);
    if (!release.ok) throw new Error('child is still live; capacity retained');
  }
  async function inspect(item) {
    const value = check(item);
    if (!['completed', 'failed', 'cancelled'].includes(value.status)) return { ...item, process: undefined, status: value.status };
    await reap(item);
    item.status = value.status;
    let output = '';
    try { output = readRegularArtifact(outputPath(m.projectRoot, m.runId, item.workerRunId), 'child output', MAX_FRAME, { allowEmpty: true }).text; } catch {}
    if (item.readOnly && value.status === 'completed') item.resolution = 'observed';
    save();
    return { ...item, process: undefined, output,
      ...(item.readOnly ? { validForCurrentHead: git(m.cwd, ['rev-parse', 'HEAD']).toString().trim() === item.baseCommit } : {}),
    };
  }
  async function cancel(item) {
    if (item.process?.exitCode === null) item.process.kill('SIGTERM');
    const deadline = Date.now() + 7000;
    while (item.process?.exitCode === null && Date.now() < deadline) await wait(25);
    if (item.process?.exitCode === null) throw new Error('child shutdown unconfirmed; preserve its worktree and reservation');
    await reap(item);
    item.status = 'cancelled';
    item.resolution = 'discarded';
    save();
    return { status: 'cancelled', retainedWorktree: item.cwd };
  }
  async function dispatch(identity, name, args = {}) {
    if (identity.role !== 'parent') throw new Error('leaf connections cannot delegate');
    if (closing) throw new Error('parent admission is fenced');
    if (name === 'spawn') {
      if (!/^[0-9a-f]{16,64}$/.test(args.id || '') || !['claude', 'codex', 'gemini'].includes(args.provider)
        || typeof args.prompt !== 'string' || !args.prompt.trim() || Buffer.byteLength(args.prompt) > 65536
        || !validateChangedPathsAgainstScope(args.scope, m.scope).ok
        || !validateChangedPathsAgainstScope([], args.scope).ok) throw new Error('invalid child request or scope expansion');
      const digest = createHash('sha256').update(JSON.stringify(args)).digest('hex');
      if (children.has(args.id)) {
        const item = children.get(args.id);
        if (item.digest !== digest) throw new Error('child id conflict');
        return inspect(item);
      }
      if ([...children.values()].some(item => !item.resolution && !item.readOnly && args.readOnly !== true
        && (validateChangedPathsAgainstScope(item.scope, args.scope).ok
          || item.scope.some(a => args.scope.some(b => a.toLowerCase() === b.toLowerCase() || a.toLowerCase().startsWith(b.toLowerCase() + '/') || b.toLowerCase().startsWith(a.toLowerCase() + '/')))))) {
        throw new Error('child mutation scopes overlap');
      }
      clean(m.cwd);
      const baseCommit = git(m.cwd, ['rev-parse', 'HEAD']).toString().trim();
      const admitted = claimRuntimeChild(m.projectRoot, m.parentEntryId, { childId: args.id, provider: args.provider });
      if (!admitted.ok) return { status: 'denied', reason: admitted.reason, fallback: 'execute serially within parent scope' };
      const worktree = createWorkerWorktree(m.cwd, `children-${m.runId}-${m.workerRunId}`, args.id, { onExisting: 'fail' });
      if (!worktree.created) { finishRuntimeChild(m.projectRoot, m.parentEntryId, args.id); throw new Error(worktree.error); }
      const workerRunId = randomBytes(8).toString('hex');
      const item = { id: args.id, digest, provider: args.provider, workerRunId, scope: args.scope,
        ...(args.previousChildId ? { previousChildId: args.previousChildId } : {}),
        cwd: worktree.worktreePath, branch: worktree.branchName, baseCommit,
        readOnly: args.readOnly === true, status: 'launching', resolution: null };
      children.set(item.id, item); save(); // durable identity BEFORE process launch
      const leaf = { ...m, schemaVersion: 1, persistent: false, managed: false, runtimeLeaf: true,
        parentEntryId: m.parentEntryId, workerRunId, workerName: `child-${args.id}`,
        cwd: item.cwd, scope: args.scope,
        prompt: `You are an Athena leaf agent. Work only in ${item.cwd}. Do not delegate or start another team. Other workers are active; preserve their work. Your explicit scope is ${JSON.stringify(args.scope)}.\n${item.readOnly
          ? 'Read and report only; do not edit files or make commits.'
          : `Implement and verify your assignment. Commit only your assigned changes on ${item.branch} before reporting completion; leave a clean worktree. Never stage pre-existing user work or modify the shared main worktree.`}\nAssignment:\n${args.prompt}`,
        readOnly: item.readOnly, reviewTreeOid: item.readOnly ? git(m.cwd, ['rev-parse', 'HEAD^{tree}']).toString().trim() : null,
        validationIdentity: null,
        adapterName: m.adapterName === 'fixture' && process.env.AO_SUPERVISOR_ALLOW_FIXTURE === '1'
          ? 'fixture' : ({ claude: 'claude-cli', codex: 'codex-exec', gemini: 'gemini-exec' })[args.provider],
      };
      delete leaf.fixture;
      if (leaf.adapterName === 'fixture') leaf.fixture = { output: args.prompt,
        delayMs: Math.min(30000, Number(m.fixture?.leafDelayMs) || 200) };
      const path = manifestPath(m.projectRoot, m.runId, workerRunId);
      atomicWriteFileSync(path, JSON.stringify(leaf), { durable: true });
      const env = { ...process.env };
      delete env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
      for (const key of Object.keys(env)) if (/^AO_RUNTIME_|^CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS$/.test(key)) delete env[key];
      const child = spawn(process.execPath, [supervisor, path], { detached: true, stdio: 'ignore', env });
      child.on('error', () => { item.status = 'ambiguous'; save(); });
      child.unref();
      item.process = child;
      item.supervisorPid = child.pid;
      item.supervisorStartId = child.pid ? readProcStartId(child.pid) : null;
      item.status = child.pid ? 'running' : 'ambiguous';
      if (child.pid) bindRuntimeProcess(m.projectRoot, admitted.slot.id, child.pid);
      save();
      return { id: item.id, status: item.status, provider: item.provider };
    }
    const item = children.get(args.id);
    if (!item) throw new Error('unknown child identity');
    if (name === 'inspect') return inspect(item);
    if (name === 'cancel') return cancel(item);
    if (name === 'followup') {
      const prior = await inspect(item);
      if (!item.resolution || typeof args.prompt !== 'string' || Buffer.byteLength(args.prompt) > 16384) {
        throw new Error('resolve the prior child result before a bounded follow-up');
      }
      const context = Buffer.from(prior.output || '').subarray(-32768).toString();
      const next = await dispatch(identity, 'spawn', { id: args.nextId, provider: item.provider,
        scope: item.scope, readOnly: item.readOnly, previousChildId: item.id,
        prompt: `Previous child result (advisory):\n${context}\nFollow-up assignment:\n${args.prompt}` });
      return { ...next, mode: 'task-chain', previousChildId: item.id };
    }
    if (name === 'integrate' || name === 'discard') {
      const status = await inspect(item);
      if (!['completed', 'failed', 'cancelled'].includes(status.status)) throw new Error('child must be terminal before resolution');
      if (name === 'integrate') {
        if (status.status !== 'completed') throw new Error('failed child cannot be integrated');
        clean(item.cwd); clean(m.cwd);
        const parentChanged = parseNulDelimitedGitPaths(git(m.cwd, ['diff', '--name-only', '-z', item.baseCommit, 'HEAD']));
        if (parentChanged.some(path => item.scope.some(scope => {
          const a = path.toLowerCase(), b = scope.toLowerCase();
          return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
        }))) throw new Error('parent edited child-owned scope after the child checkpoint');
        const paths = parseNulDelimitedGitPaths(git(item.cwd, ['diff', '--name-only', '-z', item.baseCommit, 'HEAD']));
        if (!validateChangedPathsAgainstScope(paths, item.scope).ok) throw new Error('child changed files outside its scope');
        const merge = mergeWorkerBranch(m.cwd, item.branch, item.id);
        if (!merge.success) throw new Error('child merge failed; work retained');
      }
      item.resolution = name === 'integrate' ? 'integrated' : 'discarded'; save();
      return { id: item.id, resolution: item.resolution, retainedWorktree: item.cwd };
    }
    throw new Error('unsupported broker operation');
  }
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let identity = null, buffer = '';
    socket.on('data', data => {
      buffer += data.toString();
      if (Buffer.byteLength(buffer) > MAX_FRAME) { socket.destroy(); return; }
      let boundary;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const raw = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        let request;
        try { request = JSON.parse(raw); } catch { socket.destroy(); return; }
        const respond = value => { if (!socket.destroyed) socket.write(JSON.stringify({ id: request.id, ...value }) + '\n'); };
        if (!identity) {
          const grant = tokens.get(request.token);
          if (!grant || grant.expiresAt < Date.now()) { socket.destroy(); return; }
          tokens.delete(request.token); identity = grant;
          respond({ result: { connected: true, role: identity.role } });
          continue;
        }
        mutation = mutation.then(() => dispatch(identity, request.name, request.arguments)).then(
          value => respond({ result: value }), error => respond({ error: error.message }),
        );
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  save();
  function bootstrap(role = 'parent') {
    const dir = mkdtempSync(join(tmpdir(), 'ao-runtime-attach-')); privateDirs.push(dir);
    const token = randomBytes(32).toString('hex');
    tokens.set(token, { role, expiresAt: Date.now() + 60000 });
    const path = join(dir, 'attach.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: RUNTIME_BOOTSTRAP_SCHEMA_VERSION, port: server.address().port, token }), { mode: 0o600, flag: 'wx' });
    return path;
  }
  return {
    bootstrap,
    dispatch: (name, args) => dispatch({ role: 'parent' }, name, args),
    assertResolved() {
      if ([...children.values()].some(item => !item.resolution)) throw new Error('child results must be observed, integrated, or explicitly discarded before parent completion');
    },
    async close() {
      closing = true; fenceRuntimeSubtree(m.projectRoot, m.parentEntryId); save();
      await mutation;
      for (const item of children.values()) if (!item.resolution) await cancel(item);
      tokens.clear(); for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      for (const dir of privateDirs) rmSync(dir, { recursive: true, force: true });
    },
  };
}
