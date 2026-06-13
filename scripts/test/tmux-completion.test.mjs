/**
 * Regression tests for tmux-worker COMPLETION DETECTION.
 *
 * The bug: monitorTmuxWorker decided a tmux-fallback worker was `completed`
 * purely because the shell prompt returned (`/[$%]\s*$/`). Error detection was
 * Codex-only and pattern-based, so ANY worker that exited non-zero in a way the
 * patterns didn't catch — Claude/Gemini failures, unrecognized Codex errors, or
 * a command that was a shell syntax error and never ran — returned to a prompt
 * and was reported as `completed`. A silent no-op masquerading as success.
 *
 * The fix: buildWorkerCommand now appends an explicit `__AO_EXIT__:<code>`
 * sentinel; classifyTmuxWorker treats that exit code as authoritative
 * (provider-agnostic) and NEVER infers completion from a bare prompt. These
 * tests pin both the parser and the pure classifier, plus a producer↔consumer
 * round-trip through a real shell.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseExitMarker, classifyTmuxWorker } from '../lib/worker-spawn.mjs';
import { buildWorkerCommand, WORKER_EXIT_MARKER } from '../lib/tmux-session.mjs';
import { clearBinCache } from '../lib/resolve-binary.mjs';

const M = WORKER_EXIT_MARKER; // '__AO_EXIT__'

// ---------------------------------------------------------------------------
// parseExitMarker
// ---------------------------------------------------------------------------

test('parseExitMarker: reads a zero exit code', () => {
  assert.equal(parseExitMarker(`output line\n${M}:0\nuser@host project $ `), 0);
});

test('parseExitMarker: reads a non-zero / multi-digit exit code', () => {
  assert.equal(parseExitMarker(`${M}:2`), 2);
  assert.equal(parseExitMarker(`crashed\n${M}:137\n$ `), 137);
});

test('parseExitMarker: absent sentinel returns null (worker still running)', () => {
  assert.equal(parseExitMarker('codex working...\nstill going\n$ '), null);
});

test('parseExitMarker: non-string / empty input returns null', () => {
  assert.equal(parseExitMarker(''), null);
  assert.equal(parseExitMarker(null), null);
  assert.equal(parseExitMarker(undefined), null);
  assert.equal(parseExitMarker(42), null);
});

test('parseExitMarker: ignores the UNEXPANDED typed command line', () => {
  // The pane echoes the typed command, which contains `__AO_EXIT__:$__ao_ec`.
  // `$` is not a digit, so it must NOT be mistaken for a real exit code.
  const typedCommandEcho = `"/bin/claude" --print "$(cat "/tmp/p.txt")"; __ao_ec=$?; rm -f "/tmp/p.txt"; echo "${M}:$__ao_ec"`;
  assert.equal(parseExitMarker(typedCommandEcho), null);
});

test('parseExitMarker: takes the LAST match when several are present', () => {
  assert.equal(parseExitMarker(`${M}:1\nrerun\n${M}:0`), 0);
});

// --- F2: per-invocation nonce makes the marker unforgeable by worker output ---

test('parseExitMarker (F2): a nonce-scoped marker is read only with the matching nonce', () => {
  const nonce = 'deadbeefcafe1234';
  assert.equal(parseExitMarker(`work done\n${M}:${nonce}:0\n$ `, nonce), 0);
  assert.equal(parseExitMarker(`crashed\n${M}:${nonce}:137\n$ `, nonce), 137);
});

test('parseExitMarker (F2): worker output forging a bare marker cannot fake completion', () => {
  const nonce = 'deadbeefcafe1234';
  // A worker that prints `__AO_EXIT__:0` (e.g. echoing docs/code) must NOT be
  // accepted when a nonce is expected — it doesn't know the random token.
  assert.equal(parseExitMarker(`evil: ${M}:0\n${M}:0\nstill running\n`, nonce), null);
  // A wrong/guessed nonce is rejected too.
  assert.equal(parseExitMarker(`${M}:0000000000000000:0\n$ `, nonce), null);
});

test('parseExitMarker (F2): nonce-scoped marker still ignores the unexpanded typed echo', () => {
  const nonce = 'abc123def456';
  const typedEcho = `"/bin/claude" --print "$(cat "/tmp/p.txt")"; __ao_ec=$?; rm -f "/tmp/p.txt"; echo "${M}:${nonce}:$__ao_ec"`;
  assert.equal(parseExitMarker(typedEcho, nonce), null);
});

test('parseExitMarker (F2): line-anchored — a marker mid-line (not column 0) is ignored', () => {
  // Only the EXECUTED echo, alone at line start, counts. A marker embedded in
  // prose/argv mid-line must not match.
  assert.equal(parseExitMarker(`the worker said ${M}:0 in passing\n`), null);
});

// ---------------------------------------------------------------------------
// classifyTmuxWorker — the pure decision logic
// ---------------------------------------------------------------------------

const RUNNING_CODEX = { status: 'running', type: 'codex', session: 's' };
const RUNNING_CLAUDE = { status: 'running', type: 'claude', session: 's' };

test('classifyTmuxWorker: explicit exit 0 → completed (no error)', () => {
  const r = classifyTmuxWorker(RUNNING_CLAUDE, `done\n${M}:0\n$ `);
  assert.equal(r.status, 'completed');
  assert.equal(r.error, undefined);
});

test('classifyTmuxWorker: non-zero exit (no codex signature) → failed/nonzero_exit', () => {
  const r = classifyTmuxWorker(RUNNING_CLAUDE, `claude blew up\n${M}:2\n$ `);
  assert.equal(r.status, 'failed');
  assert.equal(r.error.category, 'nonzero_exit');
  assert.match(r.error.message, /status 2/);
});

test('classifyTmuxWorker: non-zero exit + codex signature → failed with the RICHER category', () => {
  const r = classifyTmuxWorker(RUNNING_CODEX, `Error: authentication failed\n${M}:1\n$ `);
  assert.equal(r.status, 'failed');
  assert.equal(r.error.category, 'auth_failed'); // enriched, not generic nonzero_exit
});

test('REGRESSION: prompt returned but NO sentinel → stays running, NOT completed', () => {
  // This is the exact silent-success bug. The pane ends in a shell prompt; the
  // old heuristic marked it `completed`. With no exit sentinel it must remain
  // `running` (a genuine hang is caught by monitorTeam's stall detector).
  const r = classifyTmuxWorker(RUNNING_CODEX, 'codex starting...\nworking\nuser@host project $ ');
  assert.equal(r.status, 'running');
  assert.equal(r.error, undefined);
});

test('classifyTmuxWorker: codex error signature before the sentinel → fail fast', () => {
  const r = classifyTmuxWorker(RUNNING_CODEX, 'Error: rate limit exceeded\nretrying\n$ ');
  assert.equal(r.status, 'failed');
  assert.equal(r.error.category, 'rate_limited');
});

test('classifyTmuxWorker: exit 0 is authoritative over a stale transient error line', () => {
  // codex printed a rate-limit warning, recovered, and exited 0. The old
  // pattern-only path would false-positive to `failed`; the exit code wins.
  const r = classifyTmuxWorker(RUNNING_CODEX, `Warning: rate limit exceeded earlier\nRecovered. Done.\n${M}:0\n$ `);
  assert.equal(r.status, 'completed');
  assert.equal(r.error, undefined);
});

test('classifyTmuxWorker: worker not running is returned unchanged (no re-classification)', () => {
  const r = classifyTmuxWorker({ status: 'completed', type: 'codex', session: 's' }, `${M}:1\n$ `);
  assert.equal(r.status, 'completed');
});

test('classifyTmuxWorker: null pane output → running, empty output, no crash', () => {
  const r = classifyTmuxWorker(RUNNING_CODEX, null);
  assert.equal(r.status, 'running');
  assert.equal(r.output, '');
  assert.equal(r.error, undefined);
});

// --- F3: the exit sentinel is authoritative across polls, even after a
//        provisional signature-only failure on an earlier poll ---

test('classifyTmuxWorker (F3): a provisionally-failed worker is rescued by a later exit-0', () => {
  // Poll N flagged it failed on a transient "rate limit … retrying" line (no
  // sentinel yet). Poll N+1's pane now carries the real exit-0 sentinel — the
  // worker recovered. Old code gated parsing on status==='running', so the
  // sentinel was ignored and the worker stayed falsely failed.
  const worker = { status: 'failed', type: 'codex', session: 's' };
  const r = classifyTmuxWorker(worker, `Error: rate limit exceeded\nretrying\nRecovered.\n${M}:0\n$ `);
  assert.equal(r.status, 'completed');
  assert.equal(r.error, undefined);
});

test('classifyTmuxWorker (F3): a failed worker with no sentinel stays failed', () => {
  const worker = { status: 'failed', type: 'codex', session: 's' };
  const r = classifyTmuxWorker(worker, 'still retrying\nError: rate limit exceeded\n$ ');
  assert.equal(r.status, 'failed');
});

test('classifyTmuxWorker (F3): a nonzero sentinel keeps a failed worker failed', () => {
  const worker = { status: 'failed', type: 'claude', session: 's' };
  const r = classifyTmuxWorker(worker, `boom\n${M}:1\n$ `);
  assert.equal(r.status, 'failed');
  assert.equal(r.error.category, 'nonzero_exit');
});

test('classifyTmuxWorker (F2): the nonce on the worker scopes the sentinel match', () => {
  const worker = { status: 'running', type: 'claude', session: 's', _exitNonce: 'n0nce1234' };
  // Correct nonce in the pane → completed.
  assert.equal(classifyTmuxWorker(worker, `done\n${M}:n0nce1234:0\n$ `).status, 'completed');
  // A bare/forged marker without the nonce → not accepted → still running.
  assert.equal(classifyTmuxWorker(worker, `evil ${M}:0\n${M}:0\nworking\n`).status, 'running');
});

// ---------------------------------------------------------------------------
// Producer ↔ consumer round-trip through a real shell:
// buildWorkerCommand's sentinel must round-trip back through parseExitMarker.
// A fake `claude` on PATH lets us choose the exit code deterministically.
// ---------------------------------------------------------------------------

function runProducerConsumer(exitCode, nonce, { errexit = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ao-exit-'));
  const origPath = process.env.PATH;
  // Fake CLI: ignore args, exit with the requested code.
  writeFileSync(join(dir, 'claude'), `#!/bin/sh\nexit ${exitCode}\n`, { mode: 0o755 });
  process.env.PATH = `${dir}:${origPath}`;
  clearBinCache(); // force `which claude` to re-resolve to the fake

  let command;
  try {
    command = buildWorkerCommand({ type: 'claude', prompt: 'do the thing' }, { cwd: tmpdir(), autonomyConfig: {}, exitNonce: nonce });
    // The trailing `echo` exits 0, so sh -c never throws regardless of the CLI's
    // code — we read the sentinel from stdout, exactly like capturePane would.
    const shArgs = errexit ? ['-e', '-c', command] : ['-c', command];
    const out = execFileSync('sh', shArgs, { encoding: 'utf-8' });
    return parseExitMarker(out, nonce);
  } finally {
    process.env.PATH = origPath;
    clearBinCache();
    if (command) {
      for (const m of command.match(/\/tmp\/ao-prompt-[0-9a-fA-F-]+\.txt/g) || []) {
        try { unlinkSync(m); } catch {}
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test('round-trip: a CLI that exits 0 yields a sentinel parseExitMarker reads as 0', () => {
  assert.equal(runProducerConsumer(0), 0);
});

test('round-trip: a CLI that exits 7 yields a sentinel parseExitMarker reads as 7', () => {
  // $? is captured BEFORE `rm` clobbers it — proves the ordering in withExitMarker.
  assert.equal(runProducerConsumer(7), 7);
});

test('round-trip (F2): a nonce-scoped sentinel round-trips through a real shell', () => {
  const nonce = 'feedface00112233';
  assert.equal(runProducerConsumer(0, nonce), 0);
  assert.equal(runProducerConsumer(7, nonce), 7);
});

test('round-trip (F5): the sentinel survives a pane shell under `set -e` (errexit)', () => {
  // Under errexit a bare `cli; __ao_ec=$?` would terminate the shell at the
  // failing CLI before capturing the code → no sentinel → worker stuck. The
  // if/then/else capture in withExitMarker must still emit `__AO_EXIT__:…:<code>`.
  assert.equal(runProducerConsumer(4, 'errexitnonce0001', { errexit: true }), 4);
  assert.equal(runProducerConsumer(0, 'errexitnonce0002', { errexit: true }), 0);
});

// ---------------------------------------------------------------------------
// F6: re-evaluating a non-running worker preserves the rich Codex category
// ---------------------------------------------------------------------------

test('classifyTmuxWorker (F6): re-evaluated failed/retry worker keeps its rich crash category', () => {
  // A crashed codex worker re-polled from 'retry': the nonzero sentinel is
  // authoritative, but the category must stay 'crash' (preserving the
  // crash→retry path in monitorTeam), not decay to generic 'nonzero_exit'.
  const worker = { status: 'retry', type: 'codex', session: 's', _exitNonce: 'abcd1234abcd1234' };
  const r = classifyTmuxWorker(worker, `panic: fatal error\nSIGSEGV\n${M}:abcd1234abcd1234:1\n$ `);
  assert.equal(r.status, 'failed');
  assert.equal(r.error.category, 'crash');
});

// ---------------------------------------------------------------------------
// F7b: line-end anchoring — unscoped parse can't misread a nonce-prefixed line,
// and CRLF panes parse correctly.
// ---------------------------------------------------------------------------

test('parseExitMarker (F7b): unscoped parse rejects a nonce-prefixed line (no false exit-0)', () => {
  // Defense-in-depth: if a nonce-scoped marker is ever parsed WITHOUT the nonce
  // (e.g. stale state in a spawn crash window) and the nonce starts with a
  // digit, the line-end anchor stops the unscoped regex misreading it as exit 0.
  assert.equal(parseExitMarker(`${M}:0abc1234:7\n$ `, null), null);
  assert.equal(parseExitMarker(`${M}:0abc1234:7\n$ `), null);
});

test('parseExitMarker (F7b): CRLF line endings parse correctly', () => {
  assert.equal(parseExitMarker(`work\r\n${M}:5\r\n$ `), 5);
});
