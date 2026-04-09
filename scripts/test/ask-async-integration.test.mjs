/**
 * Integration tests for scripts/ask.mjs — async/status/collect/cancel/list
 * subcommands exercised via the exported `main(argv)` entry with injected
 * fake adapters, fake clock, fake liveness, and a fake runner spawner.
 *
 * No real subprocesses are ever spawned. No real codex/gemini binaries are
 * touched. Every test runs in an isolated temp cwd with an empty temp HOME.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import * as ask from '../ask.mjs';
import * as askJobs from '../lib/ask-jobs.mjs';

let tmp;
let origCwd;
let origHome;
let stdoutCap;
let stderrCap;
let lastExit;

function resetCaptures() {
  stdoutCap = [];
  stderrCap = [];
  lastExit = null;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ask-async-'));
  origCwd = process.cwd();
  origHome = process.env.HOME;
  process.chdir(tmp);
  process.env.HOME = tmp;
  resetCaptures();
  ask._inject({
    stdoutWrite: (s) => { stdoutCap.push(s); return true; },
    stderrWrite: (s) => { stderrCap.push(s); return true; },
    exitFn: (code) => { lastExit = code; throw new ExitSignal(code); },
  });
  askJobs._injectClock(null);
  askJobs._injectLiveness(null);
  askJobs._injectRandom(null);
});

afterEach(() => {
  ask._inject(null);
  askJobs._injectClock(null);
  askJobs._injectLiveness(null);
  askJobs._injectRandom(null);
  process.chdir(origCwd);
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

class ExitSignal extends Error {
  constructor(code) { super(`exit ${code}`); this.code = code; }
}

/** Run main(argv), swallow the ExitSignal, return the exit code. */
async function runMain(argvTail) {
  try {
    await ask.main(['node', '/fake/scripts/ask.mjs', ...argvTail]);
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  }
  return lastExit;
}

/** Build a fake adapter shaped like codex-exec / gemini-exec. */
function makeFakeAdapter({
  output = 'fake response',
  error = null,
  throwOnSpawn = null,
} = {}) {
  const calls = {
    spawn: 0,
    collect: 0,
    shutdown: 0,
    spawnArgs: [],
    spawnOpts: [],
    collectTimeouts: [],
  };
  const stdoutEmitter = new EventEmitter();
  const handle = {
    pid: 99001,
    process: { killed: false },
    stdout: stdoutEmitter,
    _output: output,
    _exitCode: null,
  };
  const adapter = {
    spawn(prompt, opts) {
      calls.spawn++;
      calls.spawnArgs.push(prompt);
      calls.spawnOpts.push(opts);
      if (throwOnSpawn) throw throwOnSpawn;
      return handle;
    },
    async collect(h, timeoutMs) {
      calls.collect++;
      calls.collectTimeouts.push(timeoutMs);
      if (error) return { status: 'failed', output: '', error };
      return { status: 'completed', output };
    },
    async shutdown() { calls.shutdown++; },
  };
  return { adapter, calls, handle, stdoutEmitter };
}

/** Fake runner spawner — captures invocations and returns a mock child. */
function makeFakeRunnerSpawner(customPid = 55001) {
  const invocations = [];
  const spawner = (bin, args, opts) => {
    invocations.push({ bin, args, opts });
    return {
      pid: customPid,
      unref: () => {},
    };
  };
  return { spawner, invocations };
}

// ═══ async launch path ═══════════════════════════════════════════════════

test('async codex: writes metadata + prompt sidecar + spawns runner + prints handoff', async () => {
  const { spawner, invocations } = makeFakeRunnerSpawner();
  ask._inject({
    runJobSpawner: spawner,
    buildSpawnOpts: () => ({ cwd: tmp, level: 'full-auto' }),
    capabilities: { hasCodexExecJson: true, hasGeminiCli: true },
    stdinReader: () => 'test prompt body',
    stdoutWrite: (s) => { stdoutCap.push(s); return true; },
    stderrWrite: (s) => { stderrCap.push(s); return true; },
    exitFn: (code) => { lastExit = code; throw new ExitSignal(code); },
  });

  await runMain(['async', 'codex']);

  assert.equal(lastExit, 0, `expected exit 0, got ${lastExit}, stderr=${stderrCap.join('')}`);
  assert.equal(invocations.length, 1, 'runner spawned exactly once');
  assert.equal(invocations[0].args[1], '_run-job');
  const jobId = invocations[0].args[2];
  assert.match(jobId, /^ask-codex-/);

  // Metadata file exists + contains expected fields
  const meta = askJobs.readMetadata(jobId);
  assert.ok(meta, 'metadata file written');
  assert.equal(meta.status, 'running');
  assert.equal(meta.adapterName, 'codex-exec');
  assert.equal(meta.runnerPid, 55001);

  // Prompt sidecar exists
  assert.ok(existsSync(askJobs.promptPath(jobId)));
  assert.equal(readFileSync(askJobs.promptPath(jobId), 'utf-8'), 'test prompt body');

  // stdout carries the JSON handoff line
  const out = stdoutCap.join('');
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.jobId, jobId);
  assert.equal(parsed.runnerPid, 55001);
});

test('async with no adapters available → exit 2 + no files written', async () => {
  ask._inject({
    capabilities: { hasCodexExecJson: false, hasGeminiCli: false, hasTmux: false },
    stdinReader: () => 'hi',
    stdoutWrite: (s) => { stdoutCap.push(s); return true; },
    stderrWrite: (s) => { stderrCap.push(s); return true; },
    exitFn: (code) => { lastExit = code; throw new ExitSignal(code); },
  });
  await runMain(['async', 'codex']);
  assert.equal(lastExit, 2);
  assert.equal(askJobs.listJobs().length, 0);
});

test('async auto on demoted codex with gemini available → re-picks gemini', async () => {
  const { spawner, invocations } = makeFakeRunnerSpawner();
  ask._inject({
    runJobSpawner: spawner,
    capabilities: { hasCodexExecJson: true, hasGeminiCli: true },
    stdinReader: () => 'hi',
    buildSpawnOpts: (name) => {
      if (name === 'codex-exec') {
        return { cwd: tmp, _demoted: true, _demotionReason: 'host suggest tier' };
      }
      return { cwd: tmp, approvalMode: 'default' };
    },
    stdoutWrite: (s) => { stdoutCap.push(s); return true; },
    stderrWrite: (s) => { stderrCap.push(s); return true; },
    exitFn: (code) => { lastExit = code; throw new ExitSignal(code); },
  });
  await runMain(['async', 'auto']);
  assert.equal(lastExit, 0);
  assert.ok(stderrCap.join('').includes('falling back to gemini-exec'));
  const jobId = invocations[0].args[2];
  const meta = askJobs.readMetadata(jobId);
  assert.equal(meta.adapterName, 'gemini-exec');
});

test('async codex explicit on demoted host → exit 2, no fallback', async () => {
  const { spawner } = makeFakeRunnerSpawner();
  ask._inject({
    runJobSpawner: spawner,
    capabilities: { hasCodexExecJson: true, hasGeminiCli: true },
    stdinReader: () => 'hi',
    buildSpawnOpts: () => ({ cwd: tmp, _demoted: true, _demotionReason: 'suggest' }),
    stdoutWrite: (s) => { stdoutCap.push(s); return true; },
    stderrWrite: (s) => { stderrCap.push(s); return true; },
    exitFn: (code) => { lastExit = code; throw new ExitSignal(code); },
  });
  await runMain(['async', 'codex']);
  assert.equal(lastExit, 2);
});

// ═══ run-job runner ═══════════════════════════════════════════════════════

test('run-job: happy path → sentinel + metadata=completed + .md synthesized', async () => {
  // Pre-seed metadata + prompt sidecar as the async launcher would.
  const jobId = 'ask-codex-20260409-120000-0001';
  const meta = {
    model: 'codex',
    adapterName: 'codex-exec',
    runnerPid: process.pid,
    adapterPid: null,
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    status: 'running',
    promptHash: 'abc',
    promptBytes: 4,
    artifactJsonlPath: askJobs.artifactJsonlPath(jobId),
    artifactMdPath: askJobs.artifactMdPath(jobId),
  };
  askJobs.ensureJobDirs();
  askJobs.writeMetadata(jobId, meta);
  askJobs.writePromptFile(jobId, 'ping');

  const { adapter, calls, handle } = makeFakeAdapter({ output: 'pong response' });
  ask._inject({
    adapter,
    buildSpawnOpts: () => ({ cwd: tmp, level: 'full-auto' }),
    stdoutWrite: () => true,
    stderrWrite: () => true,
    exitFn: (code) => { lastExit = code; throw new ExitSignal(code); },
  });

  try { await ask.main(['node', '/fake/scripts/ask.mjs', '_run-job', jobId]); }
  catch (err) { if (!(err instanceof ExitSignal)) throw err; }

  assert.equal(lastExit, 0);
  assert.equal(calls.spawn, 1);
  assert.equal(calls.collectTimeouts[0], 86_400_000, 'runner passes 24h timeout');

  // Metadata flipped to completed
  const finalMeta = askJobs.readMetadata(jobId);
  assert.equal(finalMeta.status, 'completed');
  assert.equal(finalMeta.exitCode, 0);

  // .md artifact written with body
  assert.ok(existsSync(meta.artifactMdPath));
  assert.equal(readFileSync(meta.artifactMdPath, 'utf-8').trim(), 'pong response');

  // Sentinel present in JSONL
  const sentinel = askJobs.jsonlFindRunnerSentinel(meta.artifactJsonlPath);
  assert.ok(sentinel);
  assert.equal(sentinel.status, 'completed');
  assert.equal(sentinel.text, 'pong response');

  // Prompt sidecar deleted
  assert.equal(existsSync(askJobs.promptPath(jobId)), false);
});

test('run-job: demoted opts → metadata=failed/demoted + sentinel + no spawn', async () => {
  const jobId = 'ask-codex-demoted';
  const meta = {
    model: 'codex',
    adapterName: 'codex-exec',
    runnerPid: process.pid,
    adapterPid: null,
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    status: 'running',
    promptHash: 'abc',
    promptBytes: 4,
    artifactJsonlPath: askJobs.artifactJsonlPath(jobId),
    artifactMdPath: askJobs.artifactMdPath(jobId),
  };
  askJobs.ensureJobDirs();
  askJobs.writeMetadata(jobId, meta);
  askJobs.writePromptFile(jobId, 'ping');

  const { adapter, calls } = makeFakeAdapter();
  ask._inject({
    adapter,
    buildSpawnOpts: () => ({ cwd: tmp, _demoted: true, _demotionReason: 'host suggest tier' }),
    stdoutWrite: () => true,
    stderrWrite: () => true,
    exitFn: (code) => { lastExit = code; throw new ExitSignal(code); },
  });

  try { await ask.main(['node', '/fake/scripts/ask.mjs', '_run-job', jobId]); }
  catch (err) { if (!(err instanceof ExitSignal)) throw err; }

  assert.equal(lastExit, 0);
  assert.equal(calls.spawn, 0, 'adapter NOT spawned on demoted path');
  const finalMeta = askJobs.readMetadata(jobId);
  assert.equal(finalMeta.status, 'failed');
  assert.equal(finalMeta.errorCategory, 'demoted');
  const sentinel = askJobs.jsonlFindRunnerSentinel(meta.artifactJsonlPath);
  assert.equal(sentinel.status, 'failed');
  assert.equal(sentinel.category, 'demoted');
});

test('run-job: missing metadata → exit 1 (orphan)', async () => {
  ask._inject({
    stdoutWrite: () => true,
    stderrWrite: () => true,
    exitFn: (code) => { lastExit = code; throw new ExitSignal(code); },
  });
  try {
    await ask.main(['node', '/fake/scripts/ask.mjs', '_run-job', 'no-such-job']);
  } catch (err) { if (!(err instanceof ExitSignal)) throw err; }
  assert.equal(lastExit, 1);
});

test('run-job: adapter.collect returns error → metadata=failed with category', async () => {
  const jobId = 'ask-codex-err';
  const meta = {
    model: 'codex',
    adapterName: 'codex-exec',
    runnerPid: process.pid,
    adapterPid: null,
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    status: 'running',
    promptHash: 'abc',
    promptBytes: 4,
    artifactJsonlPath: askJobs.artifactJsonlPath(jobId),
    artifactMdPath: askJobs.artifactMdPath(jobId),
  };
  askJobs.ensureJobDirs();
  askJobs.writeMetadata(jobId, meta);
  askJobs.writePromptFile(jobId, 'ping');

  const { adapter } = makeFakeAdapter({
    error: { category: 'auth_failed', message: 'no api key' },
  });
  ask._inject({
    adapter,
    buildSpawnOpts: () => ({ cwd: tmp, level: 'full-auto' }),
    stdoutWrite: () => true,
    stderrWrite: () => true,
    exitFn: (code) => { lastExit = code; throw new ExitSignal(code); },
  });

  try { await ask.main(['node', '/fake/scripts/ask.mjs', '_run-job', jobId]); }
  catch (err) { if (!(err instanceof ExitSignal)) throw err; }

  const finalMeta = askJobs.readMetadata(jobId);
  assert.equal(finalMeta.status, 'failed');
  assert.equal(finalMeta.errorCategory, 'auth_failed');
  const sentinel = askJobs.jsonlFindRunnerSentinel(meta.artifactJsonlPath);
  assert.equal(sentinel.status, 'failed');
  assert.equal(sentinel.category, 'auth_failed');
});

// ═══ status ═══════════════════════════════════════════════════════════════

test('status: running job reports running + does not mutate metadata file', async () => {
  const jobId = 'ask-codex-running';
  askJobs.ensureJobDirs();
  askJobs.writeMetadata(jobId, {
    status: 'running', runnerPid: process.pid, adapterPid: null,
    startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
    artifactJsonlPath: askJobs.artifactJsonlPath(jobId),
    artifactMdPath: askJobs.artifactMdPath(jobId),
  });

  const mtimeBefore = (await import('node:fs')).statSync(askJobs.metadataPath(jobId)).mtimeMs;
  await new Promise((r) => setTimeout(r, 10));
  await runMain(['status', jobId]);
  const mtimeAfter = (await import('node:fs')).statSync(askJobs.metadataPath(jobId)).mtimeMs;

  assert.equal(lastExit, 0);
  const out = JSON.parse(stdoutCap.join('').trim());
  assert.equal(out.status, 'running');
  assert.equal(mtimeBefore, mtimeAfter, 'status must not mutate metadata');
});

test('status: unknown jobId → exit 3', async () => {
  await runMain(['status', 'no-such-job']);
  assert.equal(lastExit, 3);
});

test('status: dead runner + no sentinel → failed/crashed', async () => {
  const jobId = 'ask-codex-dead';
  askJobs.ensureJobDirs();
  askJobs.writeMetadata(jobId, {
    status: 'running', runnerPid: 99, adapterPid: null,
    startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
    artifactJsonlPath: askJobs.artifactJsonlPath(jobId),
    artifactMdPath: askJobs.artifactMdPath(jobId),
  });
  askJobs._injectLiveness({ 99: false });
  ask._inject({
    liveness: { 99: false },
    stdoutWrite: (s) => { stdoutCap.push(s); return true; },
    stderrWrite: (s) => { stderrCap.push(s); return true; },
    exitFn: (code) => { lastExit = code; throw new ExitSignal(code); },
  });

  await runMain(['status', jobId]);
  const out = JSON.parse(stdoutCap.join('').trim());
  assert.equal(out.status, 'failed');
  assert.equal(out.errorCategory, 'crashed');
});

test('status: dead runner + sentinel=completed → completed', async () => {
  const jobId = 'ask-codex-racey';
  askJobs.ensureJobDirs();
  const meta = {
    status: 'running', runnerPid: 99, adapterPid: null,
    startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
    artifactJsonlPath: askJobs.artifactJsonlPath(jobId),
    artifactMdPath: askJobs.artifactMdPath(jobId),
  };
  askJobs.writeMetadata(jobId, meta);
  writeFileSync(
    meta.artifactJsonlPath,
    JSON.stringify({ type: 'runner_done', status: 'completed', text: 'recovered body' }) + '\n',
  );
  ask._inject({
    liveness: { 99: false },
    stdoutWrite: (s) => { stdoutCap.push(s); return true; },
    stderrWrite: (s) => { stderrCap.push(s); return true; },
    exitFn: (code) => { lastExit = code; throw new ExitSignal(code); },
  });
  await runMain(['status', jobId]);
  const out = JSON.parse(stdoutCap.join('').trim());
  assert.equal(out.status, 'completed');
});

// ═══ collect ══════════════════════════════════════════════════════════════

test('collect: completed job prints .md body', async () => {
  const jobId = 'ask-codex-done';
  askJobs.ensureJobDirs();
  askJobs.writeMetadata(jobId, {
    status: 'completed', runnerPid: 99, adapterPid: null,
    startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
    artifactJsonlPath: askJobs.artifactJsonlPath(jobId),
    artifactMdPath: askJobs.artifactMdPath(jobId),
  });
  writeFileSync(askJobs.artifactMdPath(jobId), 'final answer\n');
  ask._inject({
    liveness: { 99: false },
    stdoutWrite: (s) => { stdoutCap.push(s); return true; },
    stderrWrite: (s) => { stderrCap.push(s); return true; },
    exitFn: (code) => { lastExit = code; throw new ExitSignal(code); },
  });
  await runMain(['collect', jobId]);
  assert.equal(lastExit, 0);
  assert.equal(stdoutCap.join(''), 'final answer\n');
});

test('collect: completed + .md missing → recovers from sentinel text', async () => {
  const jobId = 'ask-codex-recover';
  askJobs.ensureJobDirs();
  askJobs.writeMetadata(jobId, {
    status: 'completed', runnerPid: 99, adapterPid: null,
    startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
    artifactJsonlPath: askJobs.artifactJsonlPath(jobId),
    artifactMdPath: askJobs.artifactMdPath(jobId),
  });
  writeFileSync(
    askJobs.artifactJsonlPath(jobId),
    JSON.stringify({ type: 'runner_done', status: 'completed', text: 'recovered body' }) + '\n',
  );
  ask._inject({
    liveness: { 99: false },
    stdoutWrite: (s) => { stdoutCap.push(s); return true; },
    stderrWrite: (s) => { stderrCap.push(s); return true; },
    exitFn: (code) => { lastExit = code; throw new ExitSignal(code); },
  });
  await runMain(['collect', jobId]);
  assert.equal(lastExit, 0);
  assert.equal(stdoutCap.join(''), 'recovered body\n');
  // .md was materialized as a side effect
  assert.ok(existsSync(askJobs.artifactMdPath(jobId)));
});

test('collect: running job without --wait → exit 75', async () => {
  const jobId = 'ask-codex-running2';
  askJobs.ensureJobDirs();
  askJobs.writeMetadata(jobId, {
    status: 'running', runnerPid: process.pid, adapterPid: null,
    startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
    artifactJsonlPath: askJobs.artifactJsonlPath(jobId),
    artifactMdPath: askJobs.artifactMdPath(jobId),
  });
  await runMain(['collect', jobId]);
  assert.equal(lastExit, 75);
});

test('collect: failed job → exit 1 with category on stderr', async () => {
  const jobId = 'ask-codex-failed';
  askJobs.ensureJobDirs();
  askJobs.writeMetadata(jobId, {
    status: 'failed', runnerPid: 99, adapterPid: null,
    errorCategory: 'auth_failed', errorMessage: 'no key',
    startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
    artifactJsonlPath: askJobs.artifactJsonlPath(jobId),
    artifactMdPath: askJobs.artifactMdPath(jobId),
  });
  ask._inject({
    liveness: { 99: false },
    stdoutWrite: (s) => { stdoutCap.push(s); return true; },
    stderrWrite: (s) => { stderrCap.push(s); return true; },
    exitFn: (code) => { lastExit = code; throw new ExitSignal(code); },
  });
  await runMain(['collect', jobId]);
  assert.equal(lastExit, 1);
  assert.ok(stderrCap.join('').includes('auth_failed'));
});

test('collect: cancelled job → exit 1 with cancelled on stderr', async () => {
  const jobId = 'ask-codex-cancel';
  askJobs.ensureJobDirs();
  askJobs.writeMetadata(jobId, {
    status: 'cancelled', runnerPid: 99, adapterPid: null,
    startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
    artifactJsonlPath: askJobs.artifactJsonlPath(jobId),
    artifactMdPath: askJobs.artifactMdPath(jobId),
  });
  ask._inject({
    liveness: { 99: false },
    stdoutWrite: (s) => { stdoutCap.push(s); return true; },
    stderrWrite: (s) => { stderrCap.push(s); return true; },
    exitFn: (code) => { lastExit = code; throw new ExitSignal(code); },
  });
  await runMain(['collect', jobId]);
  assert.equal(lastExit, 1);
  assert.ok(stderrCap.join('').includes('cancelled'));
});

test('collect --wait --timeout on stuck job → exit 75 after timeout', async () => {
  const jobId = 'ask-codex-stuck';
  askJobs.ensureJobDirs();
  askJobs.writeMetadata(jobId, {
    status: 'running', runnerPid: process.pid, adapterPid: null,
    startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
    artifactJsonlPath: askJobs.artifactJsonlPath(jobId),
    artifactMdPath: askJobs.artifactMdPath(jobId),
  });
  ask._inject({
    pollInterval: 10,
    stdoutWrite: (s) => { stdoutCap.push(s); return true; },
    stderrWrite: (s) => { stderrCap.push(s); return true; },
    exitFn: (code) => { lastExit = code; throw new ExitSignal(code); },
  });
  const start = Date.now();
  await runMain(['collect', jobId, '--wait', '--timeout', '1']);
  const elapsed = Date.now() - start;
  assert.equal(lastExit, 75);
  assert.ok(elapsed >= 900 && elapsed < 3000, `expected ~1s, got ${elapsed}ms`);
});

// ═══ cancel ═══════════════════════════════════════════════════════════════

test('cancel: already terminal → exit 0 (idempotent)', async () => {
  const jobId = 'ask-codex-already-done';
  askJobs.ensureJobDirs();
  askJobs.writeMetadata(jobId, {
    status: 'completed', runnerPid: 99, adapterPid: null,
    startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
    artifactJsonlPath: askJobs.artifactJsonlPath(jobId),
    artifactMdPath: askJobs.artifactMdPath(jobId),
  });
  ask._inject({
    liveness: { 99: false },
    stdoutWrite: (s) => { stdoutCap.push(s); return true; },
    stderrWrite: (s) => { stderrCap.push(s); return true; },
    exitFn: (code) => { lastExit = code; throw new ExitSignal(code); },
  });
  await runMain(['cancel', jobId]);
  assert.equal(lastExit, 0);
});

test('cancel: unknown jobId → exit 3', async () => {
  await runMain(['cancel', 'no-such-job']);
  assert.equal(lastExit, 3);
});

test('cancel: dead runner + sentinel says cancelled → exit 0 (idempotent via reconcile)', async () => {
  const jobId = 'ask-codex-sentinel-cancelled';
  askJobs.ensureJobDirs();
  askJobs.writeMetadata(jobId, {
    status: 'running', runnerPid: 99, adapterPid: null,
    startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
    artifactJsonlPath: askJobs.artifactJsonlPath(jobId),
    artifactMdPath: askJobs.artifactMdPath(jobId),
  });
  writeFileSync(
    askJobs.artifactJsonlPath(jobId),
    JSON.stringify({ type: 'runner_done', status: 'cancelled' }) + '\n',
  );
  ask._inject({
    liveness: { 99: false },
    stdoutWrite: (s) => { stdoutCap.push(s); return true; },
    stderrWrite: (s) => { stderrCap.push(s); return true; },
    exitFn: (code) => { lastExit = code; throw new ExitSignal(code); },
  });
  await runMain(['cancel', jobId]);
  assert.equal(lastExit, 0);
});

test('cancel: running + both dead + no sentinel → reconcile=failed → exit 0 idempotent', async () => {
  const jobId = 'ask-codex-hard-crash';
  askJobs.ensureJobDirs();
  askJobs.writeMetadata(jobId, {
    status: 'running', runnerPid: 99, adapterPid: null,
    startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
    artifactJsonlPath: askJobs.artifactJsonlPath(jobId),
    artifactMdPath: askJobs.artifactMdPath(jobId),
  });
  ask._inject({
    liveness: { 99: false },
    stdoutWrite: (s) => { stdoutCap.push(s); return true; },
    stderrWrite: (s) => { stderrCap.push(s); return true; },
    exitFn: (code) => { lastExit = code; throw new ExitSignal(code); },
  });
  await runMain(['cancel', jobId]);
  // reconcileStatus returns 'failed' (both dead + no sentinel), which is
  // terminal → cancel exits 0 (idempotent).
  assert.equal(lastExit, 0);
});

// ═══ list ═════════════════════════════════════════════════════════════════

test('list: prints JSON array of jobs', async () => {
  askJobs.ensureJobDirs();
  askJobs.writeMetadata('a', {
    status: 'running', startedAt: '2026-04-09T10:00:00.000Z',
    artifactJsonlPath: '/a.jsonl', artifactMdPath: '/a.md',
  });
  askJobs.writeMetadata('b', {
    status: 'completed', startedAt: '2026-04-09T12:00:00.000Z',
    artifactJsonlPath: '/b.jsonl', artifactMdPath: '/b.md',
  });

  await runMain(['list']);
  assert.equal(lastExit, 0);
  const arr = JSON.parse(stdoutCap.join('').trim());
  assert.equal(arr.length, 2);
  assert.equal(arr[0].jobId, 'b'); // sorted desc
});

test('list --status running filters correctly', async () => {
  askJobs.ensureJobDirs();
  askJobs.writeMetadata('a', {
    status: 'running', startedAt: '2026-04-09T10:00:00.000Z',
    artifactJsonlPath: '/a.jsonl', artifactMdPath: '/a.md',
  });
  askJobs.writeMetadata('b', {
    status: 'completed', startedAt: '2026-04-09T12:00:00.000Z',
    artifactJsonlPath: '/b.jsonl', artifactMdPath: '/b.md',
  });
  await runMain(['list', '--status', 'running']);
  const arr = JSON.parse(stdoutCap.join('').trim());
  assert.equal(arr.length, 1);
  assert.equal(arr[0].jobId, 'a');
});

// ═══ New regression tests for step-3 Codex review ═══════════════════════

test('collect --wait completes mid-poll when metadata flips', async () => {
  const jobId = 'ask-codex-midpoll';
  askJobs.ensureJobDirs();
  const baseMeta = {
    model: 'codex', adapterName: 'codex-exec',
    status: 'running', runnerPid: process.pid, adapterPid: null,
    startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
    artifactJsonlPath: askJobs.artifactJsonlPath(jobId),
    artifactMdPath: askJobs.artifactMdPath(jobId),
  };
  askJobs.writeMetadata(jobId, baseMeta);
  ask._inject({
    pollInterval: 20,
    stdoutWrite: (s) => { stdoutCap.push(s); return true; },
    stderrWrite: (s) => { stderrCap.push(s); return true; },
    exitFn: (code) => { lastExit = code; throw new ExitSignal(code); },
  });

  // Schedule a metadata flip + .md write after 100ms (well before 5s timeout).
  setTimeout(() => {
    writeFileSync(askJobs.artifactMdPath(jobId), 'midpoll body\n');
    askJobs.writeMetadata(jobId, { ...baseMeta, status: 'completed', exitCode: 0 });
  }, 100);

  await runMain(['collect', jobId, '--wait', '--timeout', '5']);
  assert.equal(lastExit, 0);
  assert.equal(stdoutCap.join(''), 'midpoll body\n');
});

test('cancel: live adapter fallback — runner dead + adapter alive → signals adapter', async () => {
  const jobId = 'ask-codex-adapter-fallback';
  askJobs.ensureJobDirs();
  askJobs.writeMetadata(jobId, {
    status: 'running', runnerPid: 7001, adapterPid: 8001,
    startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
    artifactJsonlPath: askJobs.artifactJsonlPath(jobId),
    artifactMdPath: askJobs.artifactMdPath(jobId),
  });
  const killCalls = [];
  // Fake liveness: runner dead, adapter starts alive, dies on SIGTERM.
  const liveMap = { 7001: false, 8001: true };
  ask._inject({
    liveness: liveMap,
    killFn: (pid, sig) => {
      killCalls.push({ pid, sig });
      if (sig === 'SIGTERM' && pid === 8001) liveMap[8001] = false;
    },
    stdoutWrite: (s) => { stdoutCap.push(s); return true; },
    stderrWrite: (s) => { stderrCap.push(s); return true; },
    exitFn: (code) => { lastExit = code; throw new ExitSignal(code); },
  });
  await runMain(['cancel', jobId]);
  assert.equal(lastExit, 0);
  assert.deepEqual(killCalls[0], { pid: 8001, sig: 'SIGTERM' },
    'cancel must signal the adapter when runner is dead');
});

test('cancel: SIGKILL escalation when SIGTERM is ignored', async () => {
  const jobId = 'ask-codex-sigkill';
  askJobs.ensureJobDirs();
  askJobs.writeMetadata(jobId, {
    status: 'running', runnerPid: 7002, adapterPid: null,
    startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
    artifactJsonlPath: askJobs.artifactJsonlPath(jobId),
    artifactMdPath: askJobs.artifactMdPath(jobId),
  });
  const killCalls = [];
  const liveMap = { 7002: true };  // Never dies, even on SIGTERM.
  let now = 1_000_000;
  ask._inject({
    liveness: liveMap,
    killFn: (pid, sig) => { killCalls.push({ pid, sig }); },
    clock: () => new Date(now),
    stdoutWrite: (s) => { stdoutCap.push(s); return true; },
    stderrWrite: (s) => { stderrCap.push(s); return true; },
    exitFn: (code) => { lastExit = code; throw new ExitSignal(code); },
  });

  // Advance the fake clock in the background so the 5s cancel deadline passes.
  const tick = setInterval(() => { now += 1000; }, 20);
  try {
    await runMain(['cancel', jobId]);
  } finally {
    clearInterval(tick);
  }
  assert.equal(lastExit, 0);
  const sigs = killCalls.map((c) => c.sig);
  assert.ok(sigs.includes('SIGTERM'), 'SIGTERM sent first');
  assert.ok(sigs.includes('SIGKILL'), 'SIGKILL escalation happened after grace period');
});

test('runner tee: maybeFlushMetadata is called and lastActivityAt advances', async () => {
  const jobId = 'ask-codex-flush';
  const meta = {
    model: 'codex', adapterName: 'codex-exec',
    runnerPid: process.pid, adapterPid: null,
    startedAt: '2026-04-09T12:00:00.000Z',
    lastActivityAt: '2026-04-09T12:00:00.000Z',
    status: 'running',
    promptHash: 'abc', promptBytes: 4,
    artifactJsonlPath: askJobs.artifactJsonlPath(jobId),
    artifactMdPath: askJobs.artifactMdPath(jobId),
  };
  askJobs.ensureJobDirs();
  askJobs.writeMetadata(jobId, meta);
  askJobs.writePromptFile(jobId, 'ping');

  const { adapter, handle, stdoutEmitter } = makeFakeAdapter({ output: 'pong' });

  // Override collect so we can drive stdout chunks before resolving.
  adapter.collect = async () => {
    // Simulate 2 stdout chunks before the adapter terminates.
    stdoutEmitter.emit('data', Buffer.from('chunk-1'));
    await new Promise((r) => setTimeout(r, 10));
    stdoutEmitter.emit('data', Buffer.from('chunk-2'));
    await new Promise((r) => setTimeout(r, 10));
    return { status: 'completed', output: 'pong' };
  };

  // Fake clock that advances 6s between calls so maybeFlush's 5s floor fires.
  let t = 1_000_000_000_000;
  ask._inject({
    adapter,
    buildSpawnOpts: () => ({ cwd: tmp, level: 'full-auto' }),
    clock: () => { const d = new Date(t); t += 6000; return d; },
    stdoutWrite: () => true,
    stderrWrite: () => true,
    exitFn: (code) => { lastExit = code; throw new ExitSignal(code); },
  });

  try {
    await ask.main(['node', '/fake/scripts/ask.mjs', '_run-job', jobId]);
  } catch (err) { if (!(err instanceof ExitSignal)) throw err; }

  const finalMeta = askJobs.readMetadata(jobId);
  assert.equal(finalMeta.status, 'completed');
  // lastActivityAt should have advanced past the initial startedAt value.
  assert.notEqual(finalMeta.lastActivityAt, '2026-04-09T12:00:00.000Z',
    'runner tee should bump lastActivityAt via maybeFlushMetadata');
});

// ═══ dispatcher / sync-path preservation ═════════════════════════════════

test('dispatcher: empty argv → exit 3', async () => {
  await runMain([]);
  assert.equal(lastExit, 3);
});

test('dispatcher: unknown subcommand → exit 3', async () => {
  await runMain(['potato']);
  assert.equal(lastExit, 3);
});

// ═══ AC-6 guard: no tmux references in executable code ══════════════════

test('AC-6: scripts/ask.mjs + ask-jobs.mjs have no tmux references in executable code', async () => {
  function stripComments(src) {
    let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
    out = out.replace(/(^|[^:])\/\/.*$/gm, '$1');
    return out;
  }
  const askSrc = readFileSync(new URL('../ask.mjs', import.meta.url), 'utf-8');
  const jobsSrc = readFileSync(new URL('../lib/ask-jobs.mjs', import.meta.url), 'utf-8');
  const forbidden = ['tmux', 'createTeamSession', 'spawnWorkerInSession', 'capturePane', 'killSession'];
  for (const token of forbidden) {
    assert.equal(stripComments(askSrc).includes(token), false, `ask.mjs executable code must not reference ${token}`);
    assert.equal(stripComments(jobsSrc).includes(token), false, `ask-jobs.mjs executable code must not reference ${token}`);
  }
});
