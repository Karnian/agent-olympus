/**
 * Unit tests for scripts/ask.mjs
 *
 * Strategy:
 *   - pickAskAdapter() is a pure function — full matrix coverage with no mocks.
 *   - runOnce() is tested by injecting a fake adapter via dynamic import override
 *     would be heavy; instead we exercise the file at the module-import level
 *     to assert pickAskAdapter contract + the AC-6 grep contract (no tmux refs).
 *   - The cleanup AC-7 contract is documented and asserted via static source
 *     inspection (the `finally { adapter.shutdown }` block must exist).
 *
 * Zero npm dependencies.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { pickAskAdapter, runOnce, buildSpawnOpts } from '../ask.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASK_SOURCE_PATH = join(__dirname, '..', 'ask.mjs');
const ASK_SOURCE = readFileSync(ASK_SOURCE_PATH, 'utf-8');

/**
 * Strip JS block comments (/* ... *​/) and line comments (// ...) from source
 * so architectural assertions can target executable code only. The forbidden
 * words tmux/selectAdapter/worker-spawn appear in JSDoc explaining WHY we don't
 * use them — those references are intentional and should not fail the test.
 */
function stripComments(src) {
  // Remove block comments first (greedy across lines)
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove line comments
  out = out.replace(/(^|[^:])\/\/.*$/gm, '$1');
  return out;
}

const ASK_CODE_ONLY = stripComments(ASK_SOURCE);

// ─── pickAskAdapter routing matrix (AC-1 through AC-5) ─────────────────────

test('pickAskAdapter: codex+gemini both available, model=codex → codex-exec (AC-1)', () => {
  const caps = { hasCodexExecJson: true, hasGeminiCli: true };
  assert.equal(pickAskAdapter('codex', caps), 'codex-exec');
});

test('pickAskAdapter: codex+gemini both available, model=auto → codex-exec preferred (AC-2)', () => {
  const caps = { hasCodexExecJson: true, hasGeminiCli: true };
  assert.equal(pickAskAdapter('auto', caps), 'codex-exec');
});

test('pickAskAdapter: model=auto, only gemini available → gemini-exec (AC-3)', () => {
  const caps = { hasCodexExecJson: false, hasGeminiCli: true };
  assert.equal(pickAskAdapter('auto', caps), 'gemini-exec');
});

test('pickAskAdapter: model=auto, only codex available → codex-exec', () => {
  const caps = { hasCodexExecJson: true, hasGeminiCli: false };
  assert.equal(pickAskAdapter('auto', caps), 'codex-exec');
});

test('pickAskAdapter: model=gemini, gemini installed → gemini-exec (AC-4)', () => {
  // Note: gemini-acp is intentionally NOT selected even when hasGeminiAcp is true
  const caps = { hasCodexExecJson: true, hasGeminiCli: true, hasGeminiAcp: true };
  assert.equal(pickAskAdapter('gemini', caps), 'gemini-exec');
});

test('pickAskAdapter: model=auto, neither available → none (AC-5)', () => {
  const caps = { hasCodexExecJson: false, hasGeminiCli: false };
  assert.equal(pickAskAdapter('auto', caps), 'none');
});

test('pickAskAdapter: model=codex with only gemini → none, NO cross-fallback (AC-5b)', () => {
  const caps = { hasCodexExecJson: false, hasGeminiCli: true };
  assert.equal(pickAskAdapter('codex', caps), 'none');
});

test('pickAskAdapter: model=gemini with only codex → none, NO cross-fallback (AC-5b symmetric)', () => {
  const caps = { hasCodexExecJson: true, hasGeminiCli: false };
  assert.equal(pickAskAdapter('gemini', caps), 'none');
});

test('pickAskAdapter: empty caps → none', () => {
  assert.equal(pickAskAdapter('codex', {}), 'none');
  assert.equal(pickAskAdapter('gemini', {}), 'none');
  assert.equal(pickAskAdapter('auto', {}), 'none');
});

test('pickAskAdapter: caps undefined defaults to empty', () => {
  assert.equal(pickAskAdapter('auto'), 'none');
});

test('pickAskAdapter: invalid model arg → none', () => {
  const caps = { hasCodexExecJson: true, hasGeminiCli: true };
  assert.equal(pickAskAdapter('claude', caps), 'none');
  assert.equal(pickAskAdapter('', caps), 'none');
});

test('pickAskAdapter: codex-appserver capability does NOT route to codex-appserver', () => {
  // The whole point of having ask.mjs not call selectAdapter() — multi-turn
  // adapters are intentionally excluded.
  const caps = { hasCodexExecJson: true, hasCodexAppServer: true };
  assert.equal(pickAskAdapter('codex', caps), 'codex-exec');
});

// ─── AC-6: ask.mjs source contains zero tmux references ────────────────────

test('AC-6: scripts/ask.mjs has no tmux references in executable code', () => {
  // Check executable code only — JSDoc comments explaining "we don't use tmux"
  // are intentional and acceptable.
  const forbidden = [
    'tmux',
    'tmux-session',
    'createTeamSession',
    'spawnWorkerInSession',
    'capturePane',
    'killSession',
  ];
  for (const token of forbidden) {
    assert.equal(
      ASK_CODE_ONLY.includes(token),
      false,
      `ask.mjs executable code must not reference "${token}" — see plan §4.1.1(b)`
    );
  }
});

// ─── AC-7: cleanup contract — finally { shutdown } block exists ────────────

test('AC-7: ask.mjs has finally block with adapter.shutdown call', () => {
  // The runOnce() function MUST contain a `finally { ... shutdown(handle) ... }`
  // pattern. This test asserts the call site exists; runtime spy testing requires
  // a real adapter mock which would couple the test to internal module IDs.
  assert.match(ASK_SOURCE, /finally\s*\{[\s\S]*?adapter\.shutdown\(handle\)/);
});

test('AC-7: shutdown is wrapped in try/catch (best-effort cleanup)', () => {
  // shutdown failures must not propagate — they would mask the original result.
  // Look for either a try/catch around shutdown OR a .catch() on the promise.
  const finallyBlock = ASK_SOURCE.match(/finally\s*\{([\s\S]*?)\n\s{0,4}\}/);
  assert.ok(finallyBlock, 'finally block should exist');
  const body = finallyBlock[1];
  const hasTryCatch = /try\s*\{[\s\S]*?adapter\.shutdown[\s\S]*?\}\s*catch/.test(body);
  const hasPromiseCatch = /adapter\.shutdown[\s\S]*?\.catch/.test(body);
  assert.ok(
    hasTryCatch || hasPromiseCatch,
    'shutdown must be wrapped in try/catch or .catch() to prevent propagation'
  );
});

// ─── runOnce runtime tests with injected fake adapters ────────────────────
//
// runOnce() accepts a `_inject` test hook so we can pass a fake adapter
// module instead of dynamic-importing the real codex-exec/gemini-exec. This
// lets us exercise success/error/timeout paths AND verify the cleanup
// contract (AC-7) without spawning subprocesses.

/**
 * Build a fake adapter module that records calls and returns canned results.
 *
 * @param {object} opts
 * @param {object} [opts.collectResult] - What collect() should resolve to.
 * @param {Error} [opts.spawnError] - If set, spawn() throws this.
 * @param {Error} [opts.collectError] - If set, collect() rejects with this.
 * @param {Error} [opts.shutdownError] - If set, shutdown() rejects with this.
 * @returns {{ adapter: object, calls: object }}
 */
function makeFakeAdapter({ collectResult, spawnError, collectError, shutdownError } = {}) {
  const calls = {
    spawn: 0,
    collect: 0,
    shutdown: 0,
    spawnArgs: [],
    spawnOpts: [],
  };
  const adapter = {
    spawn(prompt, spawnOpts) {
      calls.spawn++;
      calls.spawnArgs.push(prompt);
      calls.spawnOpts.push(spawnOpts);
      if (spawnError) throw spawnError;
      // Mimic the real handle shape minimally
      return {
        pid: 99999,
        process: { killed: false },
        _output: collectResult?.output || '',
        _exitCode: null,
      };
    },
    async collect(handle, _timeoutMs) {
      calls.collect++;
      if (collectError) throw collectError;
      return collectResult || { status: 'completed', output: '' };
    },
    async shutdown(handle) {
      calls.shutdown++;
      if (shutdownError) throw shutdownError;
    },
  };
  return { adapter, calls };
}

// Use a temp cwd so artifact writes don't pollute the repo
function withTempCwd(fn) {
  return async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ask-test-'));
    const orig = process.cwd();
    process.chdir(tmp);
    try {
      await fn(tmp);
    } finally {
      process.chdir(orig);
      try { rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  };
}

test('runOnce: success path — spawn/collect/shutdown all called once', withTempCwd(async (cwd) => {
  const { adapter, calls } = makeFakeAdapter({
    collectResult: { status: 'completed', output: 'hello world' },
  });
  const result = await runOnce('codex-exec', 'test prompt', { adapter, opts: { cwd } });

  assert.equal(result.ok, true);
  assert.equal(result.output, 'hello world');
  assert.equal(result.error, null);
  assert.match(result.artifactPath, /\.ao\/artifacts\/ask\/codex-\d{8}-\d{6}\.md$/);
  assert.equal(calls.spawn, 1, 'spawn called once');
  assert.equal(calls.collect, 1, 'collect called once');
  assert.equal(calls.shutdown, 1, 'shutdown called once (AC-7)');
  // Artifact actually written and contains the body
  assert.ok(existsSync(result.artifactPath), 'artifact file exists');
  assert.match(readFileSync(result.artifactPath, 'utf-8'), /hello world/);
}));

test('runOnce: adapter error path — shutdown still called (AC-7)', withTempCwd(async (cwd) => {
  const { adapter, calls } = makeFakeAdapter({
    collectResult: {
      status: 'failed',
      output: '',
      error: { category: 'auth_failed', message: 'invalid api key' },
    },
  });
  const result = await runOnce('codex-exec', 'test', { adapter, opts: { cwd } });

  assert.equal(result.ok, false);
  assert.match(result.error, /auth_failed/);
  assert.equal(calls.shutdown, 1, 'shutdown called even on adapter error');
  // Artifact written with # Error header
  const body = readFileSync(result.artifactPath, 'utf-8');
  assert.match(body, /# Error/);
  assert.match(body, /auth_failed/);
}));

test('runOnce: timeout error path — shutdown still called (AC-7)', withTempCwd(async (cwd) => {
  const { adapter, calls } = makeFakeAdapter({
    collectResult: {
      status: 'failed',
      output: '',
      error: { category: 'timeout', message: 'did not complete within 120000ms' },
    },
  });
  const result = await runOnce('gemini-exec', 'test', { adapter, opts: { cwd } });

  assert.equal(result.ok, false);
  assert.match(result.error, /timeout/);
  assert.equal(calls.shutdown, 1, 'shutdown called on timeout');
  assert.match(result.artifactPath, /gemini-/, 'artifact uses gemini label');
}));

test('runOnce: spawn() throws — no collect, but no shutdown either (no handle)', withTempCwd(async (cwd) => {
  const { adapter, calls } = makeFakeAdapter({
    spawnError: new Error('ENOENT: codex not found'),
  });
  const result = await runOnce('codex-exec', 'test', { adapter, opts: { cwd } });

  assert.equal(result.ok, false);
  assert.match(result.error, /ENOENT/);
  assert.equal(calls.spawn, 1);
  assert.equal(calls.collect, 0, 'collect not called when spawn throws');
  assert.equal(calls.shutdown, 0, 'shutdown skipped when spawn never produced a handle');
  // Artifact still written with # Error header
  const body = readFileSync(result.artifactPath, 'utf-8');
  assert.match(body, /# Error/);
  assert.match(body, /ENOENT/);
}));

test('runOnce: shutdown() failure does not propagate (best-effort)', withTempCwd(async (cwd) => {
  const { adapter, calls } = makeFakeAdapter({
    collectResult: { status: 'completed', output: 'ok' },
    shutdownError: new Error('process already gone'),
  });
  // Must NOT throw — runOnce swallows shutdown errors
  const result = await runOnce('codex-exec', 'test', { adapter, opts: { cwd } });

  assert.equal(result.ok, true, 'success result preserved despite shutdown error');
  assert.equal(result.output, 'ok');
  assert.equal(calls.shutdown, 1, 'shutdown was attempted');
}));

test('runOnce: opts.cwd is forwarded to adapter.spawn', withTempCwd(async (cwd) => {
  const { adapter, calls } = makeFakeAdapter({
    collectResult: { status: 'completed', output: 'ok' },
  });
  const customOpts = { cwd, approvalMode: 'yolo' };
  await runOnce('gemini-exec', 'test', { adapter, opts: customOpts });

  assert.equal(calls.spawnOpts[0].cwd, cwd);
  assert.equal(calls.spawnOpts[0].approvalMode, 'yolo', 'caller-supplied approvalMode forwarded');
}));

// ─── AC-9: Production gemini-approval plumbing ────────────────────────────
//
// The test above only proves runOnce forwards caller-supplied opts. To prove
// the production buildSpawnOpts() actually invokes resolveGeminiApproval()
// for gemini-exec, we test buildSpawnOpts directly. This avoids the dynamic
// import mock complexity and exercises the real branch at scripts/ask.mjs:127.

test('AC-9: buildSpawnOpts(gemini-exec) returns an approvalMode from resolveGeminiApproval', withTempCwd(async (cwd) => {
  const opts = buildSpawnOpts('gemini-exec');
  // macOS symlinks /var → /private/var; process.cwd() returns realpath, so
  // endsWith is the safe comparison.
  assert.ok(opts.cwd.endsWith(cwd) || cwd.endsWith(opts.cwd),
    `cwd mismatch: opts.cwd=${opts.cwd} vs tmpdir=${cwd}`);
  // resolveGeminiApproval returns one of: 'default' | 'auto_edit' | 'yolo' | 'plan'
  assert.ok(
    ['default', 'auto_edit', 'yolo', 'plan'].includes(opts.approvalMode),
    `approvalMode must be a valid gemini mode, got: ${opts.approvalMode}`
  );
}));

test('AC-9: buildSpawnOpts(codex-exec) does NOT set approvalMode (codex hard-bypasses)', withTempCwd(async (cwd) => {
  const opts = buildSpawnOpts('codex-exec');
  // macOS symlinks /var → /private/var; process.cwd() returns realpath, so
  // endsWith is the safe comparison.
  assert.ok(opts.cwd.endsWith(cwd) || cwd.endsWith(opts.cwd),
    `cwd mismatch: opts.cwd=${opts.cwd} vs tmpdir=${cwd}`);
  assert.equal(opts.approvalMode, undefined,
    'codex-exec should not get approvalMode — it uses --dangerously-bypass-approvals-and-sandbox');
}));

test('AC-9: buildSpawnOpts(gemini-exec) honors .ao/autonomy.json gemini.approval=yolo override', withTempCwd(async (cwd) => {
  // Write an autonomy config that pins yolo mode
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(join(cwd, '.ao'), { recursive: true });
  writeFileSync(
    join(cwd, '.ao', 'autonomy.json'),
    JSON.stringify({ gemini: { approval: 'yolo' } })
  );

  const opts = buildSpawnOpts('gemini-exec');
  assert.equal(opts.approvalMode, 'yolo',
    'autonomy.json gemini.approval override should reach buildSpawnOpts');
}));

test('AC-9: buildSpawnOpts(gemini-exec) honors .ao/autonomy.json gemini.approval=default', withTempCwd(async (cwd) => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(join(cwd, '.ao'), { recursive: true });
  writeFileSync(
    join(cwd, '.ao', 'autonomy.json'),
    JSON.stringify({ gemini: { approval: 'default' } })
  );

  const opts = buildSpawnOpts('gemini-exec');
  assert.equal(opts.approvalMode, 'default');
}));

// ─── Artifact path generation ──────────────────────────────────────────────

test('artifact path: filename includes model name and timestamp', () => {
  // Reach into source to verify the regex contract — runOnce() is the producer.
  // The format is `.ao/artifacts/ask/<model>-YYYYMMDD-HHMMSS.md`.
  assert.match(ASK_SOURCE, /\.ao\/artifacts\/ask/);
  assert.match(ASK_SOURCE, /\$\{model\}-\$\{ts\}\.md/);
});

// ─── Exit code documentation contract ──────────────────────────────────────

test('exit codes: source documents 0/1/2/3 semantics', () => {
  // The leading JSDoc must list all four exit codes, otherwise SKILL.md
  // and tests can drift.
  assert.match(ASK_SOURCE, /Exit codes:/);
  assert.match(ASK_SOURCE, /0\s*—\s*success/);
  assert.match(ASK_SOURCE, /1\s*—\s*adapter error/);
  assert.match(ASK_SOURCE, /2\s*—\s*requested model not available/);
  assert.match(ASK_SOURCE, /3\s*—\s*argv\/usage error/);
});

// ─── No use of selectAdapter() (architectural assertion) ───────────────────

test('architectural: ask.mjs does NOT import selectAdapter from worker-spawn', () => {
  // Same comment-stripped check — JSDoc may reference these names while
  // explaining why they're excluded.
  assert.equal(
    /selectAdapter/.test(ASK_CODE_ONLY),
    false,
    'ask.mjs must implement its own pickAskAdapter() — see plan §4.1.1(a)'
  );
  assert.equal(
    /worker-spawn/.test(ASK_CODE_ONLY),
    false,
    'ask.mjs must not depend on worker-spawn.mjs (multi-turn adapter coupling)'
  );
});
