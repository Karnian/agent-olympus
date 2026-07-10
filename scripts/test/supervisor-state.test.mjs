/**
 * Unit tests for scripts/lib/supervisor-state.mjs (F1 supervisor — P1).
 * node:test, zero deps.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, dirname } from 'node:path';
import {
  SUPERVISOR_SCHEMA_VERSION,
  HEARTBEAT_STALE_MS,
  STARTUP_GRACE_MS,
  FUTURE_SKEW_MS,
  MAX_OUTPUT_TAIL_BYTES,
  isValidId,
  isValidTimestamp,
  isTerminalStatus,
  supervisorRunDir,
  manifestPath,
  snapshotPath,
  outputPath,
  clampOutputTail,
  writeSnapshot,
  readSnapshot,
  isHeartbeatFresh,
  sanitizeWorkerMeta,
} from '../lib/supervisor-state.mjs';

const RUN = 'a1b2c3d4e5f60718';
const WRK = '00ff00ff00ff00ff';
// A structurally-complete snapshot (identity + liveness + status).
const VALID = { runId: RUN, workerRunId: WRK, status: 'running', supervisorPid: 123 };

// ---------------------------------------------------------------------------
// isValidId — the path-containment guard
// ---------------------------------------------------------------------------

test('isValidId: accepts 8–64 lowercase hex', () => {
  assert.equal(isValidId('a1b2c3d4'), true);
  assert.equal(isValidId(RUN), true);
  assert.equal(isValidId('0'.repeat(64)), true);
});

test('isValidId: rejects non-hex / traversal / wrong type / out-of-range', () => {
  for (const bad of ['', 'short', 'ABCDEF12', 'g1b2c3d4', '../etc', 'a/b/c', 'a1b2c3d4.', '0'.repeat(65), 42, null, undefined, {}]) {
    assert.equal(isValidId(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('isValidTimestamp: nonnegative safe integers only', () => {
  assert.equal(isValidTimestamp(0), true);
  assert.equal(isValidTimestamp(1_700_000_000_000), true);
  for (const bad of [-1, 1.5, NaN, Infinity, -Infinity, Number.MAX_VALUE, '5', null]) {
    assert.equal(isValidTimestamp(bad), false, `should reject ${bad}`);
  }
});

// ---------------------------------------------------------------------------
// Path helpers — absolute root required, ID-validated, run-scoped
// ---------------------------------------------------------------------------

test('path helpers: absolute, run-scoped, derived from IDs', () => {
  const root = '/proj';
  assert.equal(supervisorRunDir(root, RUN), `/proj/.ao/state/supervisor/${RUN}`);
  assert.equal(manifestPath(root, RUN, WRK), `/proj/.ao/state/supervisor/${RUN}/${WRK}.manifest.json`);
  assert.equal(snapshotPath(root, RUN, WRK), `/proj/.ao/state/supervisor/${RUN}/${WRK}.snapshot.json`);
  // Output is DURABLE (under artifacts) and keyed by workerRunId.
  assert.equal(outputPath(root, RUN, WRK), `/proj/.ao/artifacts/team/${RUN}/${WRK}.output`);
  assert.ok(isAbsolute(snapshotPath(root, RUN, WRK)));
});

test('path helpers: throw on invalid IDs (containment guard)', () => {
  assert.throws(() => supervisorRunDir('/p', '../escape'), /invalid runId/);
  assert.throws(() => snapshotPath('/p', RUN, 'a/b'), /invalid workerRunId/);
  assert.throws(() => outputPath('/p', '..', WRK), /invalid runId/);
});

test('path helpers: reject a RELATIVE projectRoot (detached-cwd hazard)', () => {
  assert.throws(() => supervisorRunDir('.', RUN), /absolute path/);
  assert.throws(() => supervisorRunDir('relative/dir', RUN), /absolute path/);
  assert.throws(() => outputPath('rel', RUN, WRK), /absolute path/);
});

// ---------------------------------------------------------------------------
// writeSnapshot / readSnapshot — round-trip, whitelist, perms
// ---------------------------------------------------------------------------

test('writeSnapshot/readSnapshot: round-trips, stamps schemaVersion+updatedAt, 0600 file + 0700 dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ao-supstate-'));
  try {
    const p = snapshotPath(dir, RUN, WRK);
    writeSnapshot(p, { ...VALID }, 1_000_000);
    const res = readSnapshot(p);
    assert.equal(res.kind, 'ok');
    assert.equal(res.snapshot.status, 'running');
    assert.equal(res.snapshot.supervisorPid, 123);
    assert.equal(res.snapshot.runId, RUN);
    assert.equal(res.snapshot.schemaVersion, SUPERVISOR_SCHEMA_VERSION);
    assert.equal(res.snapshot.updatedAt, 1_000_000);
    assert.equal(statSync(p).mode & 0o777, 0o600, 'snapshot file is 0600');
    assert.equal(statSync(dirname(p)).mode & 0o777, 0o700, 'run dir is 0700');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeSnapshot: WHITELISTS fields — prompt/fullOutput/paths are dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ao-supstate-'));
  try {
    const p = snapshotPath(dir, RUN, WRK);
    writeSnapshot(p, { ...VALID, prompt: 'SECRET', fullOutput: 'huge', outputPath: '/etc/evil' }, 1);
    const raw = readFileSync(p, 'utf-8');
    assert.ok(!raw.includes('SECRET'), 'prompt must not be persisted');
    assert.ok(!raw.includes('/etc/evil'), 'arbitrary outputPath must not be persisted');
    assert.equal(readSnapshot(p).kind, 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeSnapshot: clamps outputTail to the byte cap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ao-supstate-'));
  try {
    const p = snapshotPath(dir, RUN, WRK);
    writeSnapshot(p, { ...VALID, outputTail: 'x'.repeat(MAX_OUTPUT_TAIL_BYTES * 3) }, 1);
    const tail = readSnapshot(p).snapshot.outputTail;
    assert.ok(Buffer.byteLength(tail, 'utf-8') <= MAX_OUTPUT_TAIL_BYTES, 'tail clamped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clampOutputTail: keeps the END (most recent)', () => {
  const big = 'A'.repeat(MAX_OUTPUT_TAIL_BYTES) + 'TAILMARK';
  const clamped = clampOutputTail(big);
  assert.ok(clamped.endsWith('TAILMARK'));
  assert.ok(Buffer.byteLength(clamped) <= MAX_OUTPUT_TAIL_BYTES);
  assert.equal(clampOutputTail('short'), 'short');
});

// ---------------------------------------------------------------------------
// sanitizeWorkerMeta / workerMeta snapshot field
// ---------------------------------------------------------------------------

test('sanitizeWorkerMeta: keeps flat scalars, drops nested/function/undefined values', () => {
  const meta = sanitizeWorkerMeta({
    codexVersion: '0.140.0',
    versionWarning: true,
    retries: 2,
    threadId: null,
    nested: { leak: '/etc/passwd' },
    list: [1, 2],
    fn: () => {},
    missing: undefined,
  });
  assert.deepEqual({ ...meta }, { codexVersion: '0.140.0', versionWarning: true, retries: 2, threadId: null });
});

test('sanitizeWorkerMeta: rejects non-objects and empty results', () => {
  for (const bad of [null, undefined, 'str', 42, [], [{ a: 1 }]]) {
    assert.equal(sanitizeWorkerMeta(bad), undefined, `should reject ${JSON.stringify(bad)}`);
  }
  assert.equal(sanitizeWorkerMeta({}), undefined, 'empty object → undefined');
  assert.equal(sanitizeWorkerMeta({ only: { nested: true } }), undefined, 'nothing safe → undefined');
});

test('sanitizeWorkerMeta: clamps long strings, long keys, and key count', () => {
  const meta = sanitizeWorkerMeta({ raw: 'x'.repeat(500), ['k'.repeat(41)]: 'dropped' });
  assert.equal(meta.raw.length, 120, 'string clamped to 120');
  assert.equal(Object.keys(meta).length, 1, 'over-long key dropped');

  const many = {};
  for (let i = 0; i < 30; i++) many[`k${i}`] = i;
  assert.equal(Object.keys(sanitizeWorkerMeta(many)).length, 16, 'capped at 16 keys');
});

test('sanitizeWorkerMeta: filters reserved keys and returns a null-prototype bag', () => {
  assert.equal(({}).polluted, undefined, 'baseline has no pollution');
  const input = Object.fromEntries([
    ['__proto__', { polluted: true }],
    ['constructor', 'y'],
    ['prototype', 'z'],
    ['flavor', 'agy'],
  ]);
  const meta = sanitizeWorkerMeta(input);
  assert.equal(Object.getPrototypeOf(meta), null);
  assert.deepEqual({ ...meta }, { flavor: 'agy' });
  assert.equal(Object.hasOwn(meta, '__proto__'), false);
  assert.equal(Object.hasOwn(meta, 'constructor'), false);
  assert.equal(Object.hasOwn(meta, 'prototype'), false);
  assert.equal(({}).polluted, undefined, 'sanitize must not pollute Object.prototype');
});

test('writeSnapshot/readSnapshot: round-trips sanitized workerMeta, drops unsafe values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ao-supstate-'));
  try {
    const p = snapshotPath(dir, RUN, WRK);
    writeSnapshot(p, { ...VALID, workerMeta: { flavor: 'agy', nested: { leak: 'SECRET' } } }, 1);
    const res = readSnapshot(p);
    assert.equal(res.kind, 'ok');
    assert.deepEqual(res.snapshot.workerMeta, { flavor: 'agy' });
    assert.ok(!readFileSync(p, 'utf-8').includes('SECRET'), 'nested values must not be persisted');

    // Entirely-unsafe meta → field omitted, snapshot still valid.
    writeSnapshot(p, { ...VALID, workerMeta: 'not-an-object' }, 2);
    const res2 = readSnapshot(p);
    assert.equal(res2.kind, 'ok');
    assert.equal(res2.snapshot.workerMeta, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readSnapshot: rejects a snapshot whose workerMeta is not a plain object', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ao-supstate-'));
  try {
    const p = snapshotPath(dir, RUN, WRK);
    writeSnapshot(p, { ...VALID }, 1);
    const obj = JSON.parse(readFileSync(p, 'utf-8'));
    obj.workerMeta = ['tampered'];
    writeFileSync(p, JSON.stringify(obj));
    assert.equal(readSnapshot(p).kind, 'corrupt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readSnapshot: rejects tampered workerMeta contract violations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ao-supstate-'));
  try {
    const p = snapshotPath(dir, RUN, WRK);
    writeSnapshot(p, { ...VALID, workerMeta: { flavor: 'agy', retries: 1, active: true, threadId: null } }, 1);
    const valid = readSnapshot(p);
    assert.equal(valid.kind, 'ok', 'valid flat workerMeta round-trips');
    assert.deepEqual(valid.snapshot.workerMeta, { flavor: 'agy', retries: 1, active: true, threadId: null });

    const base = JSON.parse(readFileSync(p, 'utf-8'));
    const tooMany = {};
    for (let i = 0; i < 17; i++) tooMany[`k${i}`] = i;
    const cases = [
      ['nested value', { a: { b: 1 } }],
      ['reserved key', Object.fromEntries([['__proto__', 'x'], ['flavor', 'agy']])],
      ['too many keys', tooMany],
      ['over-long key', { ['k'.repeat(41)]: 'x' }],
      ['over-long string', { a: 'x'.repeat(121) }],
    ];

    for (const [label, workerMeta] of cases) {
      writeFileSync(p, JSON.stringify({ ...base, workerMeta }));
      assert.equal(readSnapshot(p).kind, 'corrupt', label);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// readSnapshot — 5-way + contract validation
// ---------------------------------------------------------------------------

test('readSnapshot: missing file → {kind:missing}', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ao-supstate-'));
  try {
    assert.equal(readSnapshot(snapshotPath(dir, RUN, WRK)).kind, 'missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readSnapshot: incomplete CONTRACT → corrupt (missing identity/liveness)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ao-supstate-'));
  try {
    const p = join(dir, 's.json');
    const base = { schemaVersion: 1, updatedAt: 1 };
    writeFileSync(p, '{not json');
    assert.equal(readSnapshot(p).kind, 'corrupt', 'bad JSON');
    writeFileSync(p, JSON.stringify({ ...base, status: 'running', supervisorPid: 1, workerRunId: WRK }));
    assert.equal(readSnapshot(p).kind, 'corrupt', 'missing runId');
    writeFileSync(p, JSON.stringify({ ...base, status: 'running', supervisorPid: 1, runId: RUN }));
    assert.equal(readSnapshot(p).kind, 'corrupt', 'missing workerRunId');
    writeFileSync(p, JSON.stringify({ ...base, status: 'running', runId: RUN, workerRunId: WRK }));
    assert.equal(readSnapshot(p).kind, 'corrupt', 'missing supervisorPid');
    writeFileSync(p, JSON.stringify({ ...base, status: 'bogus', supervisorPid: 1, runId: RUN, workerRunId: WRK }));
    assert.equal(readSnapshot(p).kind, 'corrupt', 'unknown status');
    writeFileSync(p, JSON.stringify({ schemaVersion: 1, status: 'running', supervisorPid: 1, runId: RUN, workerRunId: WRK, updatedAt: Infinity }));
    assert.equal(readSnapshot(p).kind, 'corrupt', 'Infinity updatedAt (JSON null) ');
    writeFileSync(p, JSON.stringify({ ...base, status: 'failed', supervisorPid: 1, runId: RUN, workerRunId: WRK }));
    assert.equal(readSnapshot(p).kind, 'corrupt', 'failed without error.category');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readSnapshot: future schemaVersion → unsupported; older → corrupt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ao-supstate-'));
  try {
    const p = join(dir, 's.json');
    writeFileSync(p, JSON.stringify({ ...VALID, schemaVersion: SUPERVISOR_SCHEMA_VERSION + 1, updatedAt: 1 }));
    assert.equal(readSnapshot(p).kind, 'unsupported');
    writeFileSync(p, JSON.stringify({ ...VALID, schemaVersion: 0, updatedAt: 1 }));
    assert.equal(readSnapshot(p).kind, 'corrupt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readSnapshot: expected-identity mismatch → {kind:mismatch} (stale generation)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ao-supstate-'));
  try {
    const p = snapshotPath(dir, RUN, WRK);
    writeSnapshot(p, { ...VALID }, 1);
    assert.equal(readSnapshot(p, { runId: RUN, workerRunId: WRK }).kind, 'ok', 'match');
    assert.equal(readSnapshot(p, { runId: 'deadbeefdeadbeef' }).kind, 'mismatch', 'other run');
    assert.equal(readSnapshot(p, { workerRunId: 'feedfacefeedface' }).kind, 'mismatch', 'other worker-run');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

test('isTerminalStatus: terminal vs running', () => {
  for (const s of ['completed', 'failed', 'cancelled']) assert.equal(isTerminalStatus(s), true);
  assert.equal(isTerminalStatus('running'), false);
  assert.equal(isTerminalStatus('nope'), false);
});

test('isHeartbeatFresh: within / past stale / invalid / far-future', () => {
  const now = 1_000_000_000;
  assert.equal(isHeartbeatFresh({ updatedAt: now - 1000 }, now), true);
  assert.equal(isHeartbeatFresh({ updatedAt: now - (HEARTBEAT_STALE_MS + 1) }, now), false, 'stale');
  assert.equal(isHeartbeatFresh({ updatedAt: now + FUTURE_SKEW_MS + 1 }, now), false, 'far future');
  assert.equal(isHeartbeatFresh({ updatedAt: Infinity }, now), false, 'invalid');
  assert.equal(isHeartbeatFresh({}, now), false);
  assert.equal(isHeartbeatFresh(null, now), false);
});

test('constants are sane (startup grace < stale threshold)', () => {
  assert.ok(STARTUP_GRACE_MS > 0 && HEARTBEAT_STALE_MS > STARTUP_GRACE_MS);
});
