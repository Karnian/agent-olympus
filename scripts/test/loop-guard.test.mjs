/**
 * Unit tests for scripts/lib/loop-guard.mjs
 *
 * Covers the code-backed termination guards that replace the prose-only loop
 * bounds ("max 15 iterations", "same error 3x = stop", "max 3 review rounds"):
 *   - registerIteration / registerReviewRound / registerCounter caps
 *   - recordError repeat threshold + signature normalization/dedup
 *   - getIterationCount / getReviewRoundCount / getCounter / getErrorCount (read-only)
 *   - normalizeErrorSignature / errorSignatureKey behaviour
 *   - persistence shape, schemaVersion loader rule, corrupt-file fail-safe
 *   - fail-open polarity (missing runId / blank signature → degraded, not halt)
 *   - no-clobber when counters + errors share one run file
 *   - cross-run isolation + errors-map pruning
 *
 * Mirrors the structure of stage-escalation.test.mjs (tmpdir per persistence
 * test, describe/test from node:test).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  registerIteration,
  registerReviewRound,
  registerCounter,
  recordError,
  getIterationCount,
  getReviewRoundCount,
  getCounter,
  getErrorCount,
  normalizeErrorSignature,
  errorSignatureKey,
  readLoopGuardState,
  DEFAULT_ITERATION_CAP,
  DEFAULT_REVIEW_ROUND_CAP,
  DEFAULT_ERROR_THRESHOLD,
} from '../lib/loop-guard.mjs';

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'ao-loop-guard-test-'));
}
async function removeTmpDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}
function guardPath(cwd, runId) {
  return path.join(cwd, '.ao', 'artifacts', 'runs', runId, 'loop-guard.json');
}

// ---------------------------------------------------------------------------
// Default-bound constants
// ---------------------------------------------------------------------------

describe('default bounds', () => {
  test('match the prose limits they replace', () => {
    assert.equal(DEFAULT_ITERATION_CAP, 15);
    assert.equal(DEFAULT_REVIEW_ROUND_CAP, 3);
    assert.equal(DEFAULT_ERROR_THRESHOLD, 3);
  });
});

// ---------------------------------------------------------------------------
// normalizeErrorSignature
// ---------------------------------------------------------------------------

describe('normalizeErrorSignature', () => {
  test('collapses volatile line numbers to one signature', () => {
    assert.equal(
      normalizeErrorSignature('Error at line 42'),
      normalizeErrorSignature('Error at line 47'),
    );
  });

  test('masks hex addresses', () => {
    assert.equal(
      normalizeErrorSignature('segfault at 0x7ffe1234'),
      normalizeErrorSignature('segfault at 0xDEADBEEF'),
    );
  });

  test('preserves short semantic numbers', () => {
    assert.notEqual(
      normalizeErrorSignature('exit code 1'),
      normalizeErrorSignature('exit code 2'),
    );
    assert.notEqual(
      normalizeErrorSignature('HTTP 401'),
      normalizeErrorSignature('HTTP 403'),
    );
  });

  test('masks file positions without collapsing semantic codes', () => {
    assert.equal(
      normalizeErrorSignature('TypeError at app.js:120'),
      normalizeErrorSignature('TypeError at app.js:131'),
    );
  });

  test('strips ANSI colour codes', () => {
    assert.equal(normalizeErrorSignature('[31mFAIL[0m'), 'fail');
  });

  test('preserves bracketed error codes (ESC required to strip)', () => {
    // The leading ESC in the ANSI matcher means a plain "[...]" is NOT stripped.
    assert.match(normalizeErrorSignature('Error [ERR_MODULE_NOT_FOUND]'), /\[err_module_not_found\]/);
  });

  test('collapses whitespace and lowercases', () => {
    assert.equal(normalizeErrorSignature('  TypeError:\n\t x  is  undefined '), 'typeerror: x is undefined');
  });

  test('non-string / empty → empty string', () => {
    assert.equal(normalizeErrorSignature(null), '');
    assert.equal(normalizeErrorSignature(undefined), '');
    assert.equal(normalizeErrorSignature(42), '');
    assert.equal(normalizeErrorSignature(''), '');
    assert.equal(normalizeErrorSignature('   '), '');
  });

  test('is idempotent (hex + numeric placeholders do not re-mask)', () => {
    for (const s of ['seg 0xFF then 12', 'line 9 col 4', 'ERR_X', 'no digits here']) {
      assert.equal(normalizeErrorSignature(normalizeErrorSignature(s)), normalizeErrorSignature(s));
    }
  });
});

// ---------------------------------------------------------------------------
// errorSignatureKey
// ---------------------------------------------------------------------------

describe('errorSignatureKey', () => {
  test('equivalent signatures share a key', () => {
    assert.equal(errorSignatureKey('build failed at line 10'), errorSignatureKey('build failed at line 99'));
  });
  test('distinct signatures differ', () => {
    assert.notEqual(errorSignatureKey('compile error'), errorSignatureKey('test failure'));
  });
  test('raw and pre-normalized input yield the same key', () => {
    const raw = 'TypeError at line 5';
    assert.equal(errorSignatureKey(raw), errorSignatureKey(normalizeErrorSignature(raw)));
  });
  test('empty / non-string → empty key', () => {
    assert.equal(errorSignatureKey(''), '');
    assert.equal(errorSignatureKey(null), '');
    assert.equal(errorSignatureKey(42), '');
  });
  test('key is a 16-char hex string', () => {
    assert.match(errorSignatureKey('something'), /^[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// registerIteration
// ---------------------------------------------------------------------------

describe('registerIteration', () => {
  test('fresh run: first call allowed, count=1, default cap 15', async () => {
    const cwd = await makeTmpDir();
    try {
      const r = registerIteration('run-a', { cwd });
      assert.equal(r.allowed, true);
      assert.equal(r.count, 1);
      assert.equal(r.cap, 15);
      assert.equal(r.degraded, false);
    } finally { await removeTmpDir(cwd); }
  });

  test('allows exactly `cap` ticks, blocks the (cap+1)th without incrementing', async () => {
    const cwd = await makeTmpDir();
    try {
      const seq = [];
      for (let i = 0; i < 4; i++) seq.push(registerIteration('run-b', { cwd, cap: 3 }));
      assert.deepEqual(seq.map(s => s.allowed), [true, true, true, false]);
      assert.deepEqual(seq.map(s => s.count), [1, 2, 3, 3]); // pinned at cap, not 4
    } finally { await removeTmpDir(cwd); }
  });

  test('blocked call stays blocked on repeat (idempotent stop)', async () => {
    const cwd = await makeTmpDir();
    try {
      registerIteration('run-c', { cwd, cap: 1 });
      const second = registerIteration('run-c', { cwd, cap: 1 });
      const third = registerIteration('run-c', { cwd, cap: 1 });
      assert.equal(second.allowed, false);
      assert.equal(third.allowed, false);
      assert.equal(third.count, 1);
    } finally { await removeTmpDir(cwd); }
  });

  test('invalid cap falls back to default 15', async () => {
    const cwd = await makeTmpDir();
    try {
      assert.equal(registerIteration('run-d', { cwd, cap: 0 }).cap, 15);
      assert.equal(registerIteration('run-e', { cwd, cap: -4 }).cap, 15);
      assert.equal(registerIteration('run-f', { cwd, cap: 'lots' }).cap, 15);
    } finally { await removeTmpDir(cwd); }
  });

  test('missing runId → fail-open (allowed, degraded)', () => {
    const r = registerIteration('', { cwd: '/tmp' });
    assert.equal(r.allowed, true);
    assert.equal(r.degraded, true);
    assert.equal(r.count, 0);
  });
});

// ---------------------------------------------------------------------------
// registerReviewRound
// ---------------------------------------------------------------------------

describe('registerReviewRound', () => {
  test('default cap 3 — allows 3 rounds, blocks the 4th', async () => {
    const cwd = await makeTmpDir();
    try {
      const seq = [0, 1, 2, 3].map(() => registerReviewRound('run-rr', { cwd }));
      assert.deepEqual(seq.map(s => s.allowed), [true, true, true, false]);
      assert.equal(seq[0].cap, 3);
    } finally { await removeTmpDir(cwd); }
  });

  test('tracked independently from iterations in the same run', async () => {
    const cwd = await makeTmpDir();
    try {
      registerIteration('run-mix', { cwd });
      registerIteration('run-mix', { cwd });
      registerReviewRound('run-mix', { cwd });
      assert.equal(getIterationCount('run-mix', { cwd }).count, 2);
      assert.equal(getReviewRoundCount('run-mix', { cwd }).count, 1);
    } finally { await removeTmpDir(cwd); }
  });
});

// ---------------------------------------------------------------------------
// registerCounter (generic)
// ---------------------------------------------------------------------------

describe('registerCounter', () => {
  test('generic named counter with default cap 5', async () => {
    const cwd = await makeTmpDir();
    try {
      const r = registerCounter('run-g', 'fix-cycles', { cwd });
      assert.equal(r.allowed, true);
      assert.equal(r.count, 1);
      assert.equal(r.cap, 5);
    } finally { await removeTmpDir(cwd); }
  });

  test('distinct counter names are independent', async () => {
    const cwd = await makeTmpDir();
    try {
      registerCounter('run-h', 'a', { cwd, cap: 1 });
      const aBlocked = registerCounter('run-h', 'a', { cwd, cap: 1 });
      const bFresh = registerCounter('run-h', 'b', { cwd, cap: 1 });
      assert.equal(aBlocked.allowed, false);
      assert.equal(bFresh.allowed, true);
      assert.equal(bFresh.count, 1);
    } finally { await removeTmpDir(cwd); }
  });

  test('missing runId or name → fail-open degraded', () => {
    assert.equal(registerCounter('', 'x', { cwd: '/tmp' }).degraded, true);
    assert.equal(registerCounter('run', '', { cwd: '/tmp' }).degraded, true);
    assert.equal(registerCounter('', 'x', { cwd: '/tmp' }).allowed, true);
  });
});

// ---------------------------------------------------------------------------
// recordError
// ---------------------------------------------------------------------------

describe('recordError', () => {
  test('escalates on the threshold-th repeat (default 3)', async () => {
    const cwd = await makeTmpDir();
    try {
      const e1 = recordError('run-e1', 'tests failed at app.test.js:120:4: expected ok', { cwd });
      const e2 = recordError('run-e1', 'tests failed at app.test.js:121:4: expected ok', { cwd });
      const e3 = recordError('run-e1', 'tests failed at app.test.js:131:9: expected ok', { cwd });
      assert.deepEqual([e1.repeatCount, e2.repeatCount, e3.repeatCount], [1, 2, 3]);
      assert.deepEqual([e1.shouldEscalate, e2.shouldEscalate, e3.shouldEscalate], [false, false, true]);
      assert.equal(e3.threshold, 3);
    } finally { await removeTmpDir(cwd); }
  });

  test('custom threshold', async () => {
    const cwd = await makeTmpDir();
    try {
      const e1 = recordError('run-e2', 'boom', { cwd, threshold: 2 });
      const e2 = recordError('run-e2', 'boom', { cwd, threshold: 2 });
      assert.equal(e1.shouldEscalate, false);
      assert.equal(e2.shouldEscalate, true);
    } finally { await removeTmpDir(cwd); }
  });

  test('absent file records cleanly without degradation', async () => {
    const cwd = await makeTmpDir();
    try {
      const e = recordError('run-e-fresh', 'boom', { cwd });
      assert.equal(e.repeatCount, 1);
      assert.equal(e.shouldEscalate, false);
      assert.equal(e.degraded, false);
    } finally { await removeTmpDir(cwd); }
  });

  test('distinct errors are tracked separately', async () => {
    const cwd = await makeTmpDir();
    try {
      recordError('run-e3', 'compile error in foo.ts', { cwd });
      recordError('run-e3', 'compile error in foo.ts', { cwd });
      const other = recordError('run-e3', 'lint error in bar.ts', { cwd });
      assert.equal(other.repeatCount, 1);
      assert.equal(other.shouldEscalate, false);
    } finally { await removeTmpDir(cwd); }
  });

  test('volatile line numbers do NOT reset the repeat counter', async () => {
    const cwd = await makeTmpDir();
    try {
      // Same logical error, shifting line numbers across fix attempts.
      recordError('run-e4', 'TypeError: x is undefined (at app.js:120)', { cwd });
      recordError('run-e4', 'TypeError: x is undefined (at app.js:118)', { cwd });
      const third = recordError('run-e4', 'TypeError: x is undefined (at app.js:131)', { cwd });
      assert.equal(third.repeatCount, 3);
      assert.equal(third.shouldEscalate, true);
    } finally { await removeTmpDir(cwd); }
  });

  test('missing runId or blank signature → fail-open (no forced escalation)', () => {
    const a = recordError('', 'real error', { cwd: '/tmp' });
    const b = recordError('run', '   ', { cwd: '/tmp' });
    const c = recordError('run', null, { cwd: '/tmp' });
    for (const r of [a, b, c]) {
      assert.equal(r.shouldEscalate, false);
      assert.equal(r.degraded, true);
      assert.equal(r.repeatCount, 0);
    }
  });
});

// ---------------------------------------------------------------------------
// Read-only getters do not mutate
// ---------------------------------------------------------------------------

describe('read-only getters', () => {
  test('getIterationCount / getReviewRoundCount report without incrementing', async () => {
    const cwd = await makeTmpDir();
    try {
      registerIteration('run-q', { cwd });
      registerIteration('run-q', { cwd });
      registerReviewRound('run-q', { cwd });
      assert.equal(getIterationCount('run-q', { cwd }).count, 2);
      assert.equal(getIterationCount('run-q', { cwd }).count, 2); // unchanged
      assert.equal(getReviewRoundCount('run-q', { cwd }).count, 1);
    } finally { await removeTmpDir(cwd); }
  });

  test('getErrorCount reports current repeat without incrementing', async () => {
    const cwd = await makeTmpDir();
    try {
      recordError('run-q2', 'err at line 10', { cwd });
      recordError('run-q2', 'err at line 20', { cwd });
      assert.equal(getErrorCount('run-q2', 'err at line 30', { cwd }).repeatCount, 2);
      assert.equal(getErrorCount('run-q2', 'err at line 40', { cwd }).repeatCount, 2); // unchanged
    } finally { await removeTmpDir(cwd); }
  });

  test('getCounter on unknown run/name → count 0', () => {
    assert.equal(getCounter('no-run', 'no-name', { cwd: '/tmp/nope-ao' }).count, 0);
    assert.equal(getIterationCount('', { cwd: '/tmp' }).count, 0);
  });
});

// ---------------------------------------------------------------------------
// Persistence: shape, location, no-clobber
// ---------------------------------------------------------------------------

describe('persistence', () => {
  test('file lives at runs/<runId>/loop-guard.json with the expected shape', async () => {
    const cwd = await makeTmpDir();
    try {
      registerIteration('run-shape', { cwd, cap: 9 });
      const p = guardPath(cwd, 'run-shape');
      assert.ok(existsSync(p));
      const parsed = JSON.parse(readFileSync(p, 'utf-8'));
      assert.equal(parsed.schemaVersion, 1);
      assert.equal(parsed.counters.iterations.count, 1);
      assert.equal(typeof parsed.counters.iterations.firstAt, 'string');
      assert.equal(typeof parsed.counters.iterations.lastAt, 'string');
      assert.deepEqual(parsed.errors, {});
    } finally { await removeTmpDir(cwd); }
  });

  test('counters and errors coexist in one file without clobbering', async () => {
    const cwd = await makeTmpDir();
    try {
      registerIteration('run-co', { cwd });
      recordError('run-co', 'some failure', { cwd });
      registerReviewRound('run-co', { cwd });
      recordError('run-co', 'some failure', { cwd });

      const state = readLoopGuardState('run-co', { cwd });
      assert.equal(state.counters.iterations.count, 1);
      assert.equal(state.counters.reviewRounds.count, 1);
      assert.equal(Object.keys(state.errors).length, 1);
      assert.equal(Object.values(state.errors)[0].count, 2);
      // recordError after counters must not have wiped the counters, and vice-versa.
      assert.equal(getIterationCount('run-co', { cwd }).count, 1);
    } finally { await removeTmpDir(cwd); }
  });

  test('stored error entry keeps a normalized sample for diagnostics', async () => {
    const cwd = await makeTmpDir();
    try {
      recordError('run-sample', 'Boom Happened At 77', { cwd });
      const state = readLoopGuardState('run-sample', { cwd });
      const entry = Object.values(state.errors)[0];
      assert.equal(entry.sample, 'boom happened at 77');
    } finally { await removeTmpDir(cwd); }
  });
});

// ---------------------------------------------------------------------------
// Cross-run isolation
// ---------------------------------------------------------------------------

describe('cross-run isolation', () => {
  test('counters in different runs are independent', async () => {
    const cwd = await makeTmpDir();
    try {
      registerIteration('run-x', { cwd, cap: 2 });
      registerIteration('run-x', { cwd, cap: 2 });
      const blockedX = registerIteration('run-x', { cwd, cap: 2 });
      const freshY = registerIteration('run-y', { cwd, cap: 2 });
      assert.equal(blockedX.allowed, false);
      assert.equal(freshY.allowed, true);
      assert.equal(freshY.count, 1);
    } finally { await removeTmpDir(cwd); }
  });
});

// ---------------------------------------------------------------------------
// schemaVersion loader rule + corrupt-file fail-safe
// ---------------------------------------------------------------------------

describe('schemaVersion loader rule', () => {
  test('unknown future schemaVersion → treated as empty (read returns fresh)', async () => {
    const cwd = await makeTmpDir();
    try {
      const p = guardPath(cwd, 'run-future');
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify({
        schemaVersion: 2,
        counters: { iterations: { count: 99 } },
        errors: {},
      }));
      const state = readLoopGuardState('run-future', { cwd });
      assert.deepEqual(state.counters, {});
      assert.equal(getIterationCount('run-future', { cwd }).count, 0);
    } finally { await removeTmpDir(cwd); }
  });

  test('a register call on an unknown-version file starts fresh and reports degraded', async () => {
    const cwd = await makeTmpDir();
    try {
      const p = guardPath(cwd, 'run-future2');
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify({ schemaVersion: 5, counters: { iterations: { count: 99 } } }));
      const r = registerIteration('run-future2', { cwd, cap: 15 });
      assert.equal(r.allowed, true);
      assert.equal(r.count, 1); // reset, not 100
      assert.equal(r.degraded, true);
    } finally { await removeTmpDir(cwd); }
  });

  test('recordError on an unknown-version file starts fresh and reports degraded', async () => {
    const cwd = await makeTmpDir();
    try {
      const p = guardPath(cwd, 'run-future-error');
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify({
        schemaVersion: 5,
        counters: {},
        errors: { old: { count: 99 } },
      }));
      const r = recordError('run-future-error', 'boom', { cwd });
      assert.equal(r.repeatCount, 1);
      assert.equal(r.shouldEscalate, false);
      assert.equal(r.degraded, true);
    } finally { await removeTmpDir(cwd); }
  });
});

describe('corrupt-file fail-safe', () => {
  test('garbage JSON → fresh default, never throws', async () => {
    const cwd = await makeTmpDir();
    try {
      const p = guardPath(cwd, 'run-garbage');
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, '{ not valid json at all ::::');
      assert.deepEqual(readLoopGuardState('run-garbage', { cwd }).counters, {});
      const r = registerIteration('run-garbage', { cwd });
      assert.equal(r.allowed, true);
      assert.equal(r.count, 1);
      assert.equal(r.degraded, true);
    } finally { await removeTmpDir(cwd); }
  });

  test('recordError on garbage JSON starts fresh and reports degraded', async () => {
    const cwd = await makeTmpDir();
    try {
      const p = guardPath(cwd, 'run-garbage-error');
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, '{ not valid json at all ::::');
      const r = recordError('run-garbage-error', 'boom', { cwd });
      assert.equal(r.repeatCount, 1);
      assert.equal(r.shouldEscalate, false);
      assert.equal(r.degraded, true);
    } finally { await removeTmpDir(cwd); }
  });

  test('non-object payload (array) → fresh default', async () => {
    const cwd = await makeTmpDir();
    try {
      const p = guardPath(cwd, 'run-arr');
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, '[1,2,3]');
      assert.deepEqual(readLoopGuardState('run-arr', { cwd }).counters, {});
    } finally { await removeTmpDir(cwd); }
  });
});

// ---------------------------------------------------------------------------
// errors-map pruning (unbounded-growth guard)
// ---------------------------------------------------------------------------

describe('errors map pruning', () => {
  test('distinct signatures stay bounded at 200 keys', async () => {
    const cwd = await makeTmpDir();
    try {
      // Use non-numeric distinguishers so future normalization changes cannot
      // accidentally collapse "err 1".."err 250"-style fixtures.
      const letters = 'abcdefghijklmnopqrstuvwxyz';
      for (let i = 0; i < 250; i++) {
        const tag = letters[Math.floor(i / 26) % 26] + letters[i % 26] + '-' + letters[(i * 7) % 26];
        recordError('run-prune', `error variant ${tag}`, { cwd });
      }
      const state = readLoopGuardState('run-prune', { cwd });
      assert.ok(Object.keys(state.errors).length <= 200,
        `expected <=200 keys, got ${Object.keys(state.errors).length}`);
    } finally { await removeTmpDir(cwd); }
  });
});

// ---------------------------------------------------------------------------
// readLoopGuardState
// ---------------------------------------------------------------------------

describe('readLoopGuardState', () => {
  test('missing run → fresh empty state', () => {
    const s = readLoopGuardState('nope', { cwd: '/tmp/does-not-exist-ao' });
    assert.equal(s.schemaVersion, 1);
    assert.deepEqual(s.counters, {});
    assert.deepEqual(s.errors, {});
  });
  test('empty runId → fresh empty state', () => {
    assert.deepEqual(readLoopGuardState('', { cwd: '/tmp' }).counters, {});
  });
});
