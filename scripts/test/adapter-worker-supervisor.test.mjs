/**
 * Tests for scripts/lib/adapter-worker-supervisor.mjs (F1 supervisor — P2).
 *
 * Drives the REAL supervisor as a separate process (dependency injection can't
 * reach a detached child) against the built-in env-gated `fixture` adapter, and
 * verifies the disk snapshot/output it leaves behind.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestPath, snapshotPath, outputPath, readSnapshot } from '../lib/supervisor-state.mjs';
import { buildExecOpts, buildAppserverThreadOpts, buildGeminiAcpSessionOpts } from '../lib/adapter-worker-supervisor.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = resolve(HERE, '..', 'lib', 'adapter-worker-supervisor.mjs');

let _seq = 0;
function freshIds() {
  _seq += 1;
  const n = _seq.toString(16).padStart(4, '0');
  return { runId: `aaaa${n}aaaa${n}`, workerRunId: `bbbb${n}bbbb${n}` };
}

function writeManifest(root, runId, workerRunId, overrides = {}) {
  const mp = manifestPath(root, runId, workerRunId);
  mkdirSync(dirname(mp), { recursive: true });
  const m = {
    schemaVersion: 1, runId, workerRunId, teamName: 't', workerName: 'w',
    adapterName: 'fixture', projectRoot: root, cwd: root, prompt: 'do the thing',
    timeoutMs: 600000, fixture: {}, ...overrides,
  };
  writeFileSync(mp, JSON.stringify(m), { mode: 0o600 });
  return mp;
}

function spawnSupervisor(mp, { allowFixture = true } = {}) {
  return spawn(process.execPath, [SUPERVISOR, mp], {
    stdio: 'ignore',
    env: { ...process.env, AO_SUPERVISOR_ALLOW_FIXTURE: allowFixture ? '1' : '' },
  });
}

function waitExit(child) {
  return new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })));
}

async function pollSnapshot(root, runId, workerRunId, pred, { tries = 100, ms = 20 } = {}) {
  for (let i = 0; i < tries; i++) {
    const r = readSnapshot(snapshotPath(root, runId, workerRunId));
    if (r.kind === 'ok' && pred(r.snapshot)) return r.snapshot;
    await new Promise((res) => setTimeout(res, ms));
  }
  return null;
}

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'ao-sup-'));
  return Promise.resolve(fn(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

test('supervisor: happy path — fixture exit 0 → completed snapshot + durable output, manifest unlinked', async () => {
  await withRoot(async (root) => {
    const { runId, workerRunId } = freshIds();
    const mp = writeManifest(root, runId, workerRunId, { fixture: { exitCode: 0, output: 'HELLO-OUTPUT' } });
    const child = spawnSupervisor(mp);
    const { code } = await waitExit(child);
    assert.equal(code, 0, 'exit 0 on success');

    const snap = readSnapshot(snapshotPath(root, runId, workerRunId));
    assert.equal(snap.kind, 'ok');
    assert.equal(snap.snapshot.status, 'completed');
    assert.equal(snap.snapshot.error, null);
    assert.equal(snap.snapshot.supervisorPid > 0, true);

    assert.equal(readFileSync(outputPath(root, runId, workerRunId), 'utf-8'), 'HELLO-OUTPUT');
    assert.equal(existsSync(mp), false, 'manifest is unlinked after read');
  });
});

test('supervisor: failure — fixture nonzero exit → failed snapshot + category, exit 1', async () => {
  await withRoot(async (root) => {
    const { runId, workerRunId } = freshIds();
    const mp = writeManifest(root, runId, workerRunId, { fixture: { exitCode: 3, output: 'partial' } });
    const child = spawnSupervisor(mp);
    const { code } = await waitExit(child);
    assert.equal(code, 1, 'exit 1 on failure');

    const snap = readSnapshot(snapshotPath(root, runId, workerRunId));
    assert.equal(snap.kind, 'ok');
    assert.equal(snap.snapshot.status, 'failed');
    assert.equal(snap.snapshot.error.category, 'nonzero_exit');
  });
});

test('supervisor: SIGTERM → cancelled terminal snapshot', async () => {
  await withRoot(async (root) => {
    const { runId, workerRunId } = freshIds();
    const mp = writeManifest(root, runId, workerRunId, { fixture: { exitCode: 0, output: 'x', delayMs: 5000 } });
    const child = spawnSupervisor(mp);
    // Wait until it's running, then cancel.
    const running = await pollSnapshot(root, runId, workerRunId, (s) => s.status === 'running');
    assert.ok(running, 'supervisor wrote a running snapshot');
    child.kill('SIGTERM');
    const { code } = await waitExit(child);
    assert.equal(code, 1, 'cancelled exits non-zero');

    const snap = readSnapshot(snapshotPath(root, runId, workerRunId));
    assert.equal(snap.kind, 'ok');
    assert.equal(snap.snapshot.status, 'cancelled');
    assert.equal(snap.snapshot.error.category, 'cancelled');
  });
});

test('supervisor: watchdog → timeout failure when the worker overruns', async () => {
  await withRoot(async (root) => {
    const { runId, workerRunId } = freshIds();
    // timeoutMs small + fixture delay huge → watchdog (timeoutMs+2000) fires.
    const mp = writeManifest(root, runId, workerRunId, { timeoutMs: 200, fixture: { exitCode: 0, output: 'x', delayMs: 60000 } });
    const child = spawnSupervisor(mp);
    const { code } = await waitExit(child);
    assert.equal(code, 1);
    const snap = readSnapshot(snapshotPath(root, runId, workerRunId));
    assert.equal(snap.kind, 'ok');
    assert.equal(snap.snapshot.status, 'failed');
    assert.equal(snap.snapshot.error.category, 'timeout');
  });
});

test('supervisor: fixture is REJECTED without the env gate (no completed snapshot, exit 2)', async () => {
  await withRoot(async (root) => {
    const { runId, workerRunId } = freshIds();
    const mp = writeManifest(root, runId, workerRunId, { fixture: { exitCode: 0, output: 'x' } });
    const child = spawnSupervisor(mp, { allowFixture: false });
    const { code } = await waitExit(child);
    assert.equal(code, 2, 'invalid/disallowed manifest exits 2');
    // No snapshot should claim completion.
    const snap = readSnapshot(snapshotPath(root, runId, workerRunId));
    assert.notEqual(snap.kind, 'ok');
  });
});

test('supervisor: descendant reap — SIGTERM kills the adapter process GROUP (F1)', async () => {
  await withRoot(async (root) => {
    const { runId, workerRunId } = freshIds();
    const mp = writeManifest(root, runId, workerRunId, { fixture: { exitCode: 0, output: 'x', delayMs: 8000, spawnChild: true } });
    const child = spawnSupervisor(mp);
    // Wait until the supervisor recorded the spawned child's adapterPid.
    const snap = await pollSnapshot(root, runId, workerRunId, (s) => s.status === 'running' && Number.isInteger(s.adapterPid));
    assert.ok(snap, 'supervisor recorded an adapterPid');
    const adapterPid = snap.adapterPid;
    assert.doesNotThrow(() => process.kill(-adapterPid, 0), 'child group alive before cancel');

    child.kill('SIGTERM');
    await waitExit(child);

    // The adapter group must have been reaped (graceful shutdown was a no-op).
    let groupDead = false;
    for (let i = 0; i < 100; i++) {
      try { process.kill(-adapterPid, 0); } catch { groupDead = true; break; }
      await new Promise((r) => setTimeout(r, 20));
    }
    try { process.kill(-adapterPid, 'SIGKILL'); } catch { /* cleanup */ }
    assert.equal(groupDead, true, 'the detached adapter group must be reaped on cancel');
  });
});

test('supervisor: huge timeoutMs is clamped (no 32-bit timer overflow → false instant timeout) (F4)', async () => {
  await withRoot(async (root) => {
    const { runId, workerRunId } = freshIds();
    // 2^31+ would overflow a Node timer and fire at ~1ms (instant false timeout)
    // unless clamped. The fixture finishes quickly → must be `completed`.
    const mp = writeManifest(root, runId, workerRunId, { timeoutMs: 2 ** 31 + 5000, fixture: { exitCode: 0, output: 'ok', delayMs: 50 } });
    const child = spawnSupervisor(mp);
    const { code } = await waitExit(child);
    assert.equal(code, 0);
    assert.equal(readSnapshot(snapshotPath(root, runId, workerRunId)).snapshot.status, 'completed');
  });
});

test('supervisor: invalid manifest (bad runId) → exit 2', async () => {
  await withRoot(async (root) => {
    // Hand-write a manifest with a bad runId at a path we control.
    const mp = join(root, 'bad.manifest.json');
    writeFileSync(mp, JSON.stringify({ schemaVersion: 1, runId: '../escape', workerRunId: 'bbbbbbbb', projectRoot: root, adapterName: 'fixture', prompt: 'x', fixture: {} }));
    const child = spawnSupervisor(mp);
    const { code } = await waitExit(child);
    assert.equal(code, 2);
  });
});

// ─── Pure manifest → adapter-call option builders ───────────────────────────
// Direct contract tests for the manifest→adapter wiring (no spawn). These guard
// the seam where the gemini model was once routed to startServer (ignored)
// instead of createSession — a regression a fake-recorder integration test
// could not catch because the recorder mirrored the manifest, not production.

test('buildGeminiAcpSessionOpts: model rides on createSession (→ unstable_setSessionModel), not startServer', () => {
  const m = { cwd: '/p', approvalMode: 'yolo', model: 'gemini-2.5-pro', geminiCredential: { account: 'x' } };
  const opts = buildGeminiAcpSessionOpts(m);
  assert.equal(opts.model, 'gemini-2.5-pro', 'model MUST be present so the session model is actually set');
  assert.equal(opts.approvalMode, 'yolo');
  assert.equal(opts.cwd, '/p');
  // The credential is a startServer concern — it must NOT leak into session opts.
  assert.equal('credential' in opts, false);
});

test('buildExecOpts: threads model/level/systemPrompt/maxBudgetUsd/approvalMode/credential', () => {
  const m = {
    cwd: '/w', model: 'gpt-5', level: 'full-auto', systemPrompt: 'be terse',
    maxBudgetUsd: 2.5, approvalMode: 'auto_edit', geminiCredential: { account: 'a' },
  };
  const opts = buildExecOpts(m);
  assert.equal(opts.cwd, '/w');
  assert.equal(opts.model, 'gpt-5');
  assert.equal(opts.level, 'full-auto');
  assert.equal(opts.appendSystemPrompt, 'be terse', 'systemPrompt maps to appendSystemPrompt');
  assert.equal(opts.maxBudgetUsd, 2.5);
  assert.equal(opts.approvalMode, 'auto_edit');
  assert.deepEqual(opts.credential, { account: 'a' });
});

test('buildAppserverThreadOpts: carries level + ephemeral + per-team serviceName', () => {
  const opts = buildAppserverThreadOpts({ cwd: '/w', level: 'workspace-write', teamName: 'sprint-x' });
  assert.equal(opts.cwd, '/w');
  assert.equal(opts.level, 'workspace-write');
  assert.equal(opts.ephemeral, true);
  assert.equal(opts.serviceName, 'agent-olympus:sprint-x');
});

test('option builders: importing the supervisor module does NOT run the CLI (main is guarded)', () => {
  // If the import had run main(), the test process would have exited(2) on the
  // missing manifest arg before reaching here. Reaching this line proves the
  // import.meta.url === argv[1] guard holds.
  assert.equal(typeof buildExecOpts, 'function');
});
