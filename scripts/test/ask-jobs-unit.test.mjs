/**
 * Unit tests for scripts/lib/ask-jobs.mjs
 *
 * Scope: pure helpers — jobId allocation, prompt hash, metadata round-trip,
 * process-liveness reconciliation, argv parser, sentinel write/scan,
 * debounced flush. No subprocesses, no real adapter code.
 *
 * Isolation: each test runs in a temp cwd with a temp HOME so permission
 * detection cannot read the developer's real ~/.claude settings.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as askJobs from '../lib/ask-jobs.mjs';

let tmp;
let origCwd;
let origHome;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ask-jobs-unit-'));
  origCwd = process.cwd();
  origHome = process.env.HOME;
  process.chdir(tmp);
  process.env.HOME = tmp;
  askJobs._injectClock(null);
  askJobs._injectLiveness(null);
  askJobs._injectRandom(null);
});

afterEach(() => {
  askJobs._injectClock(null);
  askJobs._injectLiveness(null);
  askJobs._injectRandom(null);
  process.chdir(origCwd);
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

// ─── allocateJobId ────────────────────────────────────────────────────────

test('allocateJobId: format ask-<label>-YYYYMMDD-HHMMSS-XXXX', () => {
  askJobs._injectClock(() => new Date('2026-04-09T12:34:56.000Z'));
  askJobs._injectRandom(() => Buffer.from([0xab, 0xcd]));
  const id = askJobs.allocateJobId('codex-exec');
  assert.match(id, /^ask-codex-\d{8}-\d{6}-abcd$/);
});

test('allocateJobId: gemini-exec → gemini label', () => {
  askJobs._injectClock(() => new Date('2026-04-09T12:34:56.000Z'));
  askJobs._injectRandom(() => Buffer.from([0x01, 0x02]));
  const id = askJobs.allocateJobId('gemini-exec');
  assert.match(id, /^ask-gemini-/);
});

test('allocateJobId: unknown adapter falls back to "ask" label', () => {
  askJobs._injectClock(() => new Date('2026-04-09T12:34:56.000Z'));
  askJobs._injectRandom(() => Buffer.from([0x0f, 0xff]));
  const id = askJobs.allocateJobId('mystery');
  assert.match(id, /^ask-ask-/);
});

// ─── computePromptHash ────────────────────────────────────────────────────

test('computePromptHash: stable sha256 for identical (model, prompt)', () => {
  const a = askJobs.computePromptHash('codex', 'hello world');
  const b = askJobs.computePromptHash('codex', 'hello world');
  assert.equal(a, b);
  assert.equal(a.length, 64);
});

test('computePromptHash: different models produce different hashes', () => {
  const a = askJobs.computePromptHash('codex', 'hello');
  const b = askJobs.computePromptHash('gemini', 'hello');
  assert.notEqual(a, b);
});

// ─── metadata round-trip ──────────────────────────────────────────────────

test('writeMetadata/readMetadata: round-trip preserves fields + schemaVersion', () => {
  const meta = {
    model: 'codex',
    adapterName: 'codex-exec',
    runnerPid: 42,
    adapterPid: null,
    startedAt: '2026-04-09T12:00:00.000Z',
    status: 'running',
    promptHash: 'abc',
    promptBytes: 5,
    artifactJsonlPath: '.ao/artifacts/ask/ask-codex-x.jsonl',
    artifactMdPath: '.ao/artifacts/ask/ask-codex-x.md',
  };
  askJobs.writeMetadata('ask-codex-x', meta);
  const read = askJobs.readMetadata('ask-codex-x');
  assert.ok(read);
  assert.equal(read.schemaVersion, 1);
  assert.equal(read.model, 'codex');
  assert.equal(read.runnerPid, 42);
  assert.equal(read.jobId, 'ask-codex-x');
});

test('readMetadata: returns null for missing file', () => {
  assert.equal(askJobs.readMetadata('no-such-job'), null);
});

test('readMetadata: returns null for malformed JSON', () => {
  askJobs.ensureJobDirs();
  writeFileSync(askJobs.metadataPath('bad'), 'not json', { mode: 0o600 });
  assert.equal(askJobs.readMetadata('bad'), null);
});

test('readMetadata: refuses schemaVersion > 1', () => {
  askJobs.ensureJobDirs();
  writeFileSync(
    askJobs.metadataPath('future'),
    JSON.stringify({ schemaVersion: 2, model: 'codex' }),
    { mode: 0o600 },
  );
  assert.equal(askJobs.readMetadata('future'), null);
});

// ─── prompt sidecar ───────────────────────────────────────────────────────

test('writePromptFile/readAndUnlinkPromptFile: round-trip + deletes', () => {
  askJobs.writePromptFile('job1', 'multi\nline\nprompt');
  const path = askJobs.promptPath('job1');
  assert.ok(existsSync(path));
  const got = askJobs.readAndUnlinkPromptFile('job1');
  assert.equal(got, 'multi\nline\nprompt');
  assert.equal(existsSync(path), false, 'prompt file deleted after read');
});

// ─── sentinel write/scan ──────────────────────────────────────────────────

test('writeRunnerSentinel: appendFileSync writes JSONL line with schemaVersion', () => {
  const path = join(tmp, 'sentinel.jsonl');
  askJobs._injectClock(() => new Date('2026-04-09T12:00:00.000Z'));
  askJobs.writeRunnerSentinel(path, {
    reason: 'completed',
    text: 'hello output',
  });
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw.trim());
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.type, 'runner_done');
  assert.equal(parsed.status, 'completed');
  assert.equal(parsed.text, 'hello output');
  assert.equal(parsed.ts, '2026-04-09T12:00:00.000Z');
});

test('writeRunnerSentinel: creates parent directory if missing', () => {
  const path = join(tmp, 'nested', 'dir', 'sentinel.jsonl');
  askJobs.writeRunnerSentinel(path, { reason: 'failed', text: '' });
  assert.ok(existsSync(path));
});

test('jsonlFindRunnerSentinel: returns null when file missing', () => {
  assert.equal(askJobs.jsonlFindRunnerSentinel('/nonexistent/file.jsonl'), null);
});

test('jsonlFindRunnerSentinel: finds the final sentinel, skipping adapter events', () => {
  const path = join(tmp, 'mixed.jsonl');
  writeFileSync(
    path,
    [
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'item.completed', item: {} }),
      JSON.stringify({ type: 'runner_done', schemaVersion: 1, status: 'completed', text: 'final' }),
    ].join('\n') + '\n',
  );
  const sentinel = askJobs.jsonlFindRunnerSentinel(path);
  assert.ok(sentinel);
  assert.equal(sentinel.status, 'completed');
  assert.equal(sentinel.text, 'final');
});

test('jsonlFindRunnerSentinel: tolerates malformed lines', () => {
  const path = join(tmp, 'malformed.jsonl');
  writeFileSync(
    path,
    '{"type":"turn.started"}\ngarbage line\n{"type":"runner_done","status":"failed","message":"oops"}\n',
  );
  const sentinel = askJobs.jsonlFindRunnerSentinel(path);
  assert.ok(sentinel);
  assert.equal(sentinel.status, 'failed');
});

// ─── isProcessAlive ───────────────────────────────────────────────────────

test('isProcessAlive: invalid pid → false', () => {
  assert.equal(askJobs.isProcessAlive(0), false);
  assert.equal(askJobs.isProcessAlive(-1), false);
  assert.equal(askJobs.isProcessAlive(NaN), false);
});

test('isProcessAlive: self pid is alive', () => {
  assert.equal(askJobs.isProcessAlive(process.pid), true);
});

test('isProcessAlive: injected liveness map overrides real syscall', () => {
  askJobs._injectLiveness({ 999999: true, 999998: false });
  assert.equal(askJobs.isProcessAlive(999999), true);
  assert.equal(askJobs.isProcessAlive(999998), false);
});

test('isProcessAlive: unmapped pid falls through to real kill', () => {
  askJobs._injectLiveness({ 100001: true });
  // Self pid is NOT in the map → real syscall → true.
  assert.equal(askJobs.isProcessAlive(process.pid), true);
  assert.equal(askJobs.isProcessAlive(100001), true);
});

// ─── reconcileStatus ──────────────────────────────────────────────────────

test('reconcileStatus: already-terminal metadata is trusted unchanged', () => {
  const meta = {
    status: 'completed',
    runnerPid: 123,
    adapterPid: null,
    artifactJsonlPath: '/nonexistent.jsonl',
  };
  askJobs._injectLiveness({ 123: false });
  const out = askJobs.reconcileStatus(meta);
  assert.equal(out.status, 'completed');
});

test('reconcileStatus: running + runner alive → running', () => {
  const meta = {
    status: 'running',
    runnerPid: 100,
    adapterPid: null,
    artifactJsonlPath: '/nonexistent.jsonl',
  };
  askJobs._injectLiveness({ 100: true });
  const out = askJobs.reconcileStatus(meta);
  assert.equal(out.status, 'running');
  assert.equal(out.runnerAlive, true);
});

test('reconcileStatus: running + runner DEAD + adapter ALIVE → still running (dead-runner recovery)', () => {
  const meta = {
    status: 'running',
    runnerPid: 100,
    adapterPid: 200,
    artifactJsonlPath: '/nonexistent.jsonl',
  };
  askJobs._injectLiveness({ 100: false, 200: true });
  const out = askJobs.reconcileStatus(meta);
  assert.equal(out.status, 'running', 'adapter still alive → job still making progress');
});

test('reconcileStatus: running + both dead + no sentinel → failed/crashed', () => {
  const meta = {
    status: 'running',
    runnerPid: 100,
    adapterPid: 200,
    artifactJsonlPath: join(tmp, 'empty.jsonl'),
  };
  askJobs._injectLiveness({ 100: false, 200: false });
  const out = askJobs.reconcileStatus(meta);
  assert.equal(out.status, 'failed');
  assert.equal(out.error.category, 'crashed');
});

test('reconcileStatus: running + both dead + sentinel=completed → completed', () => {
  const path = join(tmp, 'completed.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'runner_done', status: 'completed', text: 'ok' }) + '\n');
  const meta = {
    status: 'running',
    runnerPid: 100,
    adapterPid: 200,
    artifactJsonlPath: path,
  };
  askJobs._injectLiveness({ 100: false, 200: false });
  const out = askJobs.reconcileStatus(meta);
  assert.equal(out.status, 'completed');
});

test('reconcileStatus: running + both dead + sentinel=cancelled → cancelled', () => {
  const path = join(tmp, 'cancelled.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'runner_done', status: 'cancelled' }) + '\n');
  const meta = {
    status: 'running',
    runnerPid: 100,
    adapterPid: null,
    artifactJsonlPath: path,
  };
  askJobs._injectLiveness({ 100: false });
  const out = askJobs.reconcileStatus(meta);
  assert.equal(out.status, 'cancelled');
});

test('reconcileStatus: running + both dead + sentinel=failed → failed with category from sentinel', () => {
  const path = join(tmp, 'failed.jsonl');
  writeFileSync(path, JSON.stringify({
    type: 'runner_done',
    status: 'failed',
    category: 'auth_failed',
    message: 'no api key',
  }) + '\n');
  const meta = {
    status: 'running',
    runnerPid: 100,
    adapterPid: null,
    artifactJsonlPath: path,
  };
  askJobs._injectLiveness({ 100: false });
  const out = askJobs.reconcileStatus(meta);
  assert.equal(out.status, 'failed');
  assert.equal(out.error.category, 'auth_failed');
  assert.equal(out.error.message, 'no api key');
});

// ─── maybeFlushMetadata (debounced) ───────────────────────────────────────

test('maybeFlushMetadata: first call with no flushedAt → flushes', () => {
  const meta = { status: 'running', adapterPid: null };
  let flushed = 0;
  const result = askJobs.maybeFlushMetadata(meta, {
    flushImpl: () => { flushed++; },
  });
  assert.equal(result, true);
  assert.equal(flushed, 1);
});

test('maybeFlushMetadata: within 5s, no status change → no flush', () => {
  let now = 1_000_000;
  askJobs._injectClock(() => new Date(now));
  const meta = { status: 'running', adapterPid: null };
  let flushed = 0;
  askJobs.maybeFlushMetadata(meta, { flushImpl: () => flushed++ });
  now += 1000; // +1s
  askJobs.maybeFlushMetadata(meta, { flushImpl: () => flushed++ });
  assert.equal(flushed, 1, 'second call within floor → no flush');
});

test('maybeFlushMetadata: after 5s → flushes', () => {
  let now = 1_000_000;
  askJobs._injectClock(() => new Date(now));
  const meta = { status: 'running', adapterPid: null };
  let flushed = 0;
  askJobs.maybeFlushMetadata(meta, { flushImpl: () => flushed++ });
  now += 6000; // +6s
  askJobs.maybeFlushMetadata(meta, { flushImpl: () => flushed++ });
  assert.equal(flushed, 2);
});

test('maybeFlushMetadata: status change → flush immediately', () => {
  let now = 1_000_000;
  askJobs._injectClock(() => new Date(now));
  const meta = { status: 'running', adapterPid: null };
  let flushed = 0;
  askJobs.maybeFlushMetadata(meta, { flushImpl: () => flushed++ });
  now += 500;
  meta.status = 'completed';
  askJobs.maybeFlushMetadata(meta, { flushImpl: () => flushed++ });
  assert.equal(flushed, 2);
});

// ─── parseAskArgs (dispatcher) ────────────────────────────────────────────

test('parseAskArgs: empty argv → error', () => {
  const d = askJobs.parseAskArgs(['node', '/abs/scripts/ask.mjs']);
  assert.equal(d.command, 'error');
});

test('parseAskArgs: [..., codex] → sync codex', () => {
  const d = askJobs.parseAskArgs(['node', '/abs/scripts/ask.mjs', 'codex']);
  assert.equal(d.command, 'sync');
  assert.equal(d.model, 'codex');
});

test('parseAskArgs: [..., async, codex] → async', () => {
  const d = askJobs.parseAskArgs(['node', '/abs/scripts/ask.mjs', 'async', 'codex']);
  assert.equal(d.command, 'async');
  assert.equal(d.model, 'codex');
});

test('parseAskArgs: [..., async] (missing model) → error', () => {
  const d = askJobs.parseAskArgs(['node', '/abs/scripts/ask.mjs', 'async']);
  assert.equal(d.command, 'error');
});

test('parseAskArgs: [..., async, banana] → error', () => {
  const d = askJobs.parseAskArgs(['node', '/abs/scripts/ask.mjs', 'async', 'banana']);
  assert.equal(d.command, 'error');
});

test('parseAskArgs: status with jobId', () => {
  const d = askJobs.parseAskArgs(['node', '/abs/scripts/ask.mjs', 'status', 'ask-codex-x']);
  assert.equal(d.command, 'status');
  assert.equal(d.jobId, 'ask-codex-x');
});

test('parseAskArgs: collect with --wait and --timeout', () => {
  const d = askJobs.parseAskArgs([
    'node', '/abs/scripts/ask.mjs',
    'collect', 'ask-codex-x',
    '--wait',
    '--timeout', '30',
  ]);
  assert.equal(d.command, 'collect');
  assert.equal(d.jobId, 'ask-codex-x');
  assert.equal(d.wait, true);
  assert.equal(d.timeoutSec, 30);
});

test('parseAskArgs: collect default timeout is 600', () => {
  const d = askJobs.parseAskArgs([
    'node', '/abs/scripts/ask.mjs',
    'collect', 'ask-codex-x',
  ]);
  assert.equal(d.wait, false);
  assert.equal(d.timeoutSec, 600);
});

test('parseAskArgs: collect --timeout missing value → error', () => {
  const d = askJobs.parseAskArgs([
    'node', '/abs/scripts/ask.mjs',
    'collect', 'ask-codex-x', '--timeout',
  ]);
  assert.equal(d.command, 'error');
});

test('parseAskArgs: list with status filter', () => {
  const d = askJobs.parseAskArgs([
    'node', '/abs/scripts/ask.mjs',
    'list', '--status', 'running',
  ]);
  assert.equal(d.command, 'list');
  assert.equal(d.statusFilter, 'running');
});

test('parseAskArgs: list with --older-than', () => {
  const d = askJobs.parseAskArgs([
    'node', '/abs/scripts/ask.mjs',
    'list', '--older-than', '600',
  ]);
  assert.equal(d.olderThanSec, 600);
});

test('parseAskArgs: _run-job routes to run-job command', () => {
  const d = askJobs.parseAskArgs([
    'node', '/abs/scripts/ask.mjs',
    '_run-job', 'ask-codex-y',
  ]);
  assert.equal(d.command, 'run-job');
  assert.equal(d.jobId, 'ask-codex-y');
});

test('parseAskArgs: cancel with jobId', () => {
  const d = askJobs.parseAskArgs([
    'node', '/abs/scripts/ask.mjs',
    'cancel', 'ask-codex-z',
  ]);
  assert.equal(d.command, 'cancel');
  assert.equal(d.jobId, 'ask-codex-z');
});

// ─── listJobs ─────────────────────────────────────────────────────────────

test('listJobs: returns [] when no state dir exists', () => {
  assert.deepEqual(askJobs.listJobs(), []);
});

test('listJobs: returns all jobs sorted by startedAt desc', () => {
  askJobs.writeMetadata('a', {
    status: 'running', startedAt: '2026-04-09T10:00:00.000Z',
    artifactJsonlPath: '/a.jsonl', artifactMdPath: '/a.md',
  });
  askJobs.writeMetadata('b', {
    status: 'completed', startedAt: '2026-04-09T12:00:00.000Z',
    artifactJsonlPath: '/b.jsonl', artifactMdPath: '/b.md',
  });
  askJobs.writeMetadata('c', {
    status: 'running', startedAt: '2026-04-09T11:00:00.000Z',
    artifactJsonlPath: '/c.jsonl', artifactMdPath: '/c.md',
  });
  const jobs = askJobs.listJobs();
  assert.equal(jobs.length, 3);
  assert.equal(jobs[0].jobId, 'b');
  assert.equal(jobs[1].jobId, 'c');
  assert.equal(jobs[2].jobId, 'a');
});

test('listJobs: filter by status', () => {
  askJobs.writeMetadata('a', {
    status: 'running', startedAt: '2026-04-09T10:00:00.000Z',
    artifactJsonlPath: '/a.jsonl', artifactMdPath: '/a.md',
  });
  askJobs.writeMetadata('b', {
    status: 'completed', startedAt: '2026-04-09T12:00:00.000Z',
    artifactJsonlPath: '/b.jsonl', artifactMdPath: '/b.md',
  });
  const jobs = askJobs.listJobs({ statusFilter: 'running' });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].jobId, 'a');
});

test('listJobs: filter by --older-than', () => {
  askJobs._injectClock(() => new Date('2026-04-09T12:00:00.000Z'));
  askJobs.writeMetadata('old', {
    status: 'completed',
    startedAt: '2026-04-09T11:00:00.000Z', // 1 hour old
    artifactJsonlPath: '/old.jsonl', artifactMdPath: '/old.md',
  });
  askJobs.writeMetadata('new', {
    status: 'completed',
    startedAt: '2026-04-09T11:59:30.000Z', // 30 seconds old
    artifactJsonlPath: '/new.jsonl', artifactMdPath: '/new.md',
  });
  const jobs = askJobs.listJobs({ olderThanSec: 60 });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].jobId, 'old');
});

// ─── synthesizeMdFromSentinel ────────────────────────────────────────────

test('synthesizeMdFromSentinel: returns null for missing sentinel', () => {
  const path = join(tmp, 'empty.jsonl');
  writeFileSync(path, '');
  assert.equal(askJobs.synthesizeMdFromSentinel(path), null);
});

test('synthesizeMdFromSentinel: returns trimmed text + trailing newline', () => {
  const path = join(tmp, 'sent.jsonl');
  writeFileSync(
    path,
    JSON.stringify({ type: 'runner_done', status: 'completed', text: '  body content  \n' }) + '\n',
  );
  const out = askJobs.synthesizeMdFromSentinel(path);
  assert.equal(out, 'body content\n');
});

test('synthesizeMdFromSentinel: returns null when sentinel text is empty', () => {
  const path = join(tmp, 'empty-text.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'runner_done', status: 'completed', text: '   ' }) + '\n');
  assert.equal(askJobs.synthesizeMdFromSentinel(path), null);
});
