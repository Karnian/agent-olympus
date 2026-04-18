/**
 * Unit tests for the PR 2 tracing instrumentation in
 * scripts/lib/gemini-credential.mjs.
 *
 * Covers the gemini_cred_resolve event stream: opt-in gating via env,
 * every result branch (env hit, env miss, disabled, cache, macos_security,
 * linux_secret_tool, windows_unsupported), stderrClass categorization for
 * the common macOS `security` exit codes + timeouts + ENOENT, and hard
 * guarantees about what MUST NOT appear in the stream (raw key values).
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveGeminiApiKey,
  __resetForTest,
  __setExecFileSyncForTest,
} from '../lib/gemini-credential.mjs';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function captureStderr(fn) {
  const write = process.stderr.write.bind(process.stderr);
  const chunks = [];
  process.stderr.write = (chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = write;
  }
  return chunks.join('');
}

function parseEvents(stderr) {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.startsWith('{'))
    .map((line) => {
      try { return JSON.parse(line); }
      catch { return null; }
    })
    .filter(Boolean)
    .filter((obj) => obj.event === 'gemini_cred_resolve');
}

function setPlatform(p) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

function mockExec(response) {
  return (bin, args, opts) => {
    const r = typeof response === 'function' ? response(bin, args, opts) : response;
    if (r instanceof Error) throw r;
    return r;
  };
}

function errorWith(overrides) {
  const e = new Error(overrides.message || 'mock');
  Object.assign(e, overrides);
  return e;
}

const TEST_KEY = 'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
const ORIG_PLATFORM = process.platform;
const originalEnv = process.env.GEMINI_API_KEY;
const originalDbgCred = process.env.AO_DEBUG_CREDENTIAL;
const originalDbgGemini = process.env.AO_DEBUG_GEMINI;

beforeEach(() => {
  __resetForTest();
  delete process.env.GEMINI_API_KEY;
  delete process.env.AO_DEBUG_CREDENTIAL;
  delete process.env.AO_DEBUG_GEMINI;
  Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// #1 gating

test('no events emitted when both debug env vars are unset', () => {
  __setExecFileSyncForTest(mockExec(TEST_KEY));
  setPlatform('darwin');
  const stderr = captureStderr(() => resolveGeminiApiKey());
  assert.equal(parseEvents(stderr).length, 0);
});

test('events emitted when AO_DEBUG_CREDENTIAL=1', () => {
  process.env.AO_DEBUG_CREDENTIAL = '1';
  __setExecFileSyncForTest(mockExec(TEST_KEY));
  setPlatform('darwin');
  const stderr = captureStderr(() => resolveGeminiApiKey());
  assert.ok(parseEvents(stderr).length >= 2); // start + fetch_end + end
});

test('events emitted when AO_DEBUG_GEMINI=1 (umbrella flag)', () => {
  process.env.AO_DEBUG_GEMINI = '1';
  __setExecFileSyncForTest(mockExec(TEST_KEY));
  setPlatform('darwin');
  const stderr = captureStderr(() => resolveGeminiApiKey());
  assert.ok(parseEvents(stderr).length >= 2);
});

test('non-"1" values do NOT enable tracing (no truthy coercion)', () => {
  process.env.AO_DEBUG_CREDENTIAL = 'true'; // not '1'
  __setExecFileSyncForTest(mockExec(TEST_KEY));
  setPlatform('darwin');
  const stderr = captureStderr(() => resolveGeminiApiKey());
  assert.equal(parseEvents(stderr).length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// #2 start event shape

test('start event carries account, platform, useKeychain, forceRefresh', () => {
  process.env.AO_DEBUG_CREDENTIAL = '1';
  __setExecFileSyncForTest(mockExec(TEST_KEY));
  setPlatform('darwin');
  const stderr = captureStderr(() => resolveGeminiApiKey({ account: 'acct' }));
  const events = parseEvents(stderr);
  const start = events.find((e) => e.stage === 'start');
  assert.ok(start);
  assert.equal(start.account, 'acct');
  assert.equal(start.platform, 'darwin');
  assert.equal(start.useKeychain, true);
  assert.equal(start.forceRefresh, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// #3 end event source classification

test('end event has source=env when GEMINI_API_KEY is set', () => {
  process.env.AO_DEBUG_CREDENTIAL = '1';
  process.env.GEMINI_API_KEY = TEST_KEY;
  const stderr = captureStderr(() => resolveGeminiApiKey());
  const end = parseEvents(stderr).find((e) => e.stage === 'end');
  assert.equal(end.source, 'env');
  assert.equal(end.result, 'hit');
  assert.ok(end.keyMask);
});

test('end event has result=miss when GEMINI_API_KEY is empty string', () => {
  process.env.AO_DEBUG_CREDENTIAL = '1';
  process.env.GEMINI_API_KEY = '';
  const stderr = captureStderr(() => resolveGeminiApiKey());
  const end = parseEvents(stderr).find((e) => e.stage === 'end');
  assert.equal(end.source, 'env');
  assert.equal(end.result, 'miss');
  assert.equal(end.keyMask, null);
});

test('end event has source=disabled when useKeychain=false', () => {
  process.env.AO_DEBUG_CREDENTIAL = '1';
  const stderr = captureStderr(() => resolveGeminiApiKey({ useKeychain: false }));
  const end = parseEvents(stderr).find((e) => e.stage === 'end');
  assert.equal(end.source, 'disabled');
  assert.equal(end.result, 'miss');
});

test('end event has source=cache on second call (within TTL)', () => {
  __setExecFileSyncForTest(mockExec(TEST_KEY));
  setPlatform('darwin');
  resolveGeminiApiKey(); // prime cache with tracing OFF
  process.env.AO_DEBUG_CREDENTIAL = '1';
  const stderr = captureStderr(() => resolveGeminiApiKey());
  const end = parseEvents(stderr).find((e) => e.stage === 'end');
  assert.equal(end.source, 'cache');
  assert.equal(end.result, 'hit');
});

test('end event has source=macos_security on darwin fresh lookup', () => {
  process.env.AO_DEBUG_CREDENTIAL = '1';
  __setExecFileSyncForTest(mockExec(TEST_KEY));
  setPlatform('darwin');
  const stderr = captureStderr(() => resolveGeminiApiKey());
  const end = parseEvents(stderr).find((e) => e.stage === 'end');
  assert.equal(end.source, 'macos_security');
  assert.equal(end.result, 'hit');
});

test('end event has source=linux_secret_tool on linux fresh lookup', () => {
  process.env.AO_DEBUG_CREDENTIAL = '1';
  __setExecFileSyncForTest(mockExec(TEST_KEY));
  setPlatform('linux');
  const stderr = captureStderr(() => resolveGeminiApiKey());
  const end = parseEvents(stderr).find((e) => e.stage === 'end');
  assert.equal(end.source, 'linux_secret_tool');
  assert.equal(end.result, 'hit');
});

// ═══════════════════════════════════════════════════════════════════════════
// #4 stderrClass mapping — macOS

test('macos: exit 44 → stderrClass=not_found, result=miss', () => {
  process.env.AO_DEBUG_CREDENTIAL = '1';
  __setExecFileSyncForTest(mockExec(errorWith({ status: 44, message: 'missing' })));
  setPlatform('darwin');
  const stderr = captureStderr(() => resolveGeminiApiKey());
  const fetch = parseEvents(stderr).find((e) => e.stage === 'fetch_end');
  assert.equal(fetch.stderrClass, 'not_found');
  assert.equal(fetch.exitCode, 44);
  assert.equal(fetch.result, 'miss');
});

test('macos: exit 45 → stderrClass=unknown (45 is NOT user_canceled; low byte of -25299=errSecDuplicateItem)', () => {
  process.env.AO_DEBUG_CREDENTIAL = '1';
  __setExecFileSyncForTest(mockExec(errorWith({ status: 45 })));
  setPlatform('darwin');
  const stderr = captureStderr(() => resolveGeminiApiKey());
  const fetch = parseEvents(stderr).find((e) => e.stage === 'fetch_end');
  assert.equal(fetch.stderrClass, 'unknown');
  assert.equal(fetch.exitCode, 45);
  assert.equal(fetch.result, 'error');
});

test('macos: exit 51 → stderrClass=acl_denied, result=error', () => {
  process.env.AO_DEBUG_CREDENTIAL = '1';
  __setExecFileSyncForTest(mockExec(errorWith({ status: 51 })));
  setPlatform('darwin');
  const stderr = captureStderr(() => resolveGeminiApiKey());
  const fetch = parseEvents(stderr).find((e) => e.stage === 'fetch_end');
  assert.equal(fetch.stderrClass, 'acl_denied');
  assert.equal(fetch.exitCode, 51);
  assert.equal(fetch.result, 'error');
});

test('macos: ETIMEDOUT code → stderrClass=timeout', () => {
  process.env.AO_DEBUG_CREDENTIAL = '1';
  __setExecFileSyncForTest(mockExec(errorWith({ code: 'ETIMEDOUT' })));
  setPlatform('darwin');
  const stderr = captureStderr(() => resolveGeminiApiKey());
  const fetch = parseEvents(stderr).find((e) => e.stage === 'fetch_end');
  assert.equal(fetch.stderrClass, 'timeout');
  assert.equal(fetch.errnoCode, 'ETIMEDOUT');
});

test('macos: killed + SIGTERM → stderrClass=timeout even without ETIMEDOUT code', () => {
  process.env.AO_DEBUG_CREDENTIAL = '1';
  __setExecFileSyncForTest(mockExec(errorWith({ killed: true, signal: 'SIGTERM' })));
  setPlatform('darwin');
  const stderr = captureStderr(() => resolveGeminiApiKey());
  const fetch = parseEvents(stderr).find((e) => e.stage === 'fetch_end');
  assert.equal(fetch.stderrClass, 'timeout');
});

test('macos: ENOENT → stderrClass=binary_not_found', () => {
  process.env.AO_DEBUG_CREDENTIAL = '1';
  __setExecFileSyncForTest(mockExec(errorWith({ code: 'ENOENT' })));
  setPlatform('darwin');
  const stderr = captureStderr(() => resolveGeminiApiKey());
  const fetch = parseEvents(stderr).find((e) => e.stage === 'fetch_end');
  assert.equal(fetch.stderrClass, 'binary_not_found');
  assert.equal(fetch.errnoCode, 'ENOENT');
});

test('macos: arbitrary exit status → stderrClass=unknown, exitCode preserved', () => {
  process.env.AO_DEBUG_CREDENTIAL = '1';
  __setExecFileSyncForTest(mockExec(errorWith({ status: 99 })));
  setPlatform('darwin');
  const stderr = captureStderr(() => resolveGeminiApiKey());
  const fetch = parseEvents(stderr).find((e) => e.stage === 'fetch_end');
  assert.equal(fetch.stderrClass, 'unknown');
  assert.equal(fetch.exitCode, 99);
});

// ═══════════════════════════════════════════════════════════════════════════
// #5 Linux backend

test('linux: all candidates ENOENT → stderrClass=binary_not_found on final event', () => {
  process.env.AO_DEBUG_CREDENTIAL = '1';
  __setExecFileSyncForTest(mockExec(errorWith({ code: 'ENOENT' })));
  setPlatform('linux');
  const stderr = captureStderr(() => resolveGeminiApiKey());
  const events = parseEvents(stderr);
  // Should end up with a final fetch_end event marking binary_not_found
  const fetch = events.filter((e) => e.stage === 'fetch_end').at(-1);
  assert.equal(fetch.stderrClass, 'binary_not_found');
  assert.equal(fetch.backend, 'linux_secret_tool');
});

test('linux: first candidate ENOENT then next succeeds → result=hit on real backend', () => {
  process.env.AO_DEBUG_CREDENTIAL = '1';
  let callCount = 0;
  __setExecFileSyncForTest((bin, args, opts) => {
    callCount++;
    if (callCount === 1) throw errorWith({ code: 'ENOENT' });
    return TEST_KEY;
  });
  setPlatform('linux');
  const stderr = captureStderr(() => resolveGeminiApiKey());
  const fetch = parseEvents(stderr).find(
    (e) => e.stage === 'fetch_end' && e.result === 'hit'
  );
  assert.ok(fetch);
  assert.equal(fetch.backend, 'linux_secret_tool');
});

// ═══════════════════════════════════════════════════════════════════════════
// #6 secret safety — raw key never appears anywhere in the event stream

test('full successful run never writes raw key to stderr', () => {
  process.env.AO_DEBUG_CREDENTIAL = '1';
  __setExecFileSyncForTest(mockExec(TEST_KEY));
  setPlatform('darwin');
  const stderr = captureStderr(() => resolveGeminiApiKey());
  assert.ok(
    !stderr.includes(TEST_KEY),
    `stderr contained the raw key: ${stderr}`
  );
  // And the mask we DO emit should be present
  assert.ok(stderr.includes('AIza****'));
});

test('env-source success never writes raw key to stderr', () => {
  process.env.AO_DEBUG_CREDENTIAL = '1';
  process.env.GEMINI_API_KEY = TEST_KEY;
  const stderr = captureStderr(() => resolveGeminiApiKey());
  assert.ok(!stderr.includes(TEST_KEY));
  assert.ok(stderr.includes('AIza****'));
});

test('cache-source success never writes raw key to stderr', () => {
  __setExecFileSyncForTest(mockExec(TEST_KEY));
  setPlatform('darwin');
  resolveGeminiApiKey(); // prime cache with tracing OFF
  process.env.AO_DEBUG_CREDENTIAL = '1';
  const stderr = captureStderr(() => resolveGeminiApiKey());
  assert.ok(!stderr.includes(TEST_KEY));
});

// ═══════════════════════════════════════════════════════════════════════════
// #7 end event carries fetch-time classification (PR 2 review fix)

test('end event: backend timeout → result=error AND stderrClass=timeout on END (not miss)', () => {
  process.env.AO_DEBUG_CREDENTIAL = '1';
  __setExecFileSyncForTest(mockExec(errorWith({ code: 'ETIMEDOUT' })));
  setPlatform('darwin');
  const stderr = captureStderr(() => resolveGeminiApiKey());
  const end = parseEvents(stderr).find((e) => e.stage === 'end');
  assert.equal(end.result, 'error');
  assert.equal(end.stderrClass, 'timeout');
});

test('end event: backend acl_denied (exit 51) → end carries stderrClass=acl_denied, exitCode=51', () => {
  process.env.AO_DEBUG_CREDENTIAL = '1';
  __setExecFileSyncForTest(mockExec(errorWith({ status: 51 })));
  setPlatform('darwin');
  const stderr = captureStderr(() => resolveGeminiApiKey());
  const end = parseEvents(stderr).find((e) => e.stage === 'end');
  assert.equal(end.result, 'error');
  assert.equal(end.stderrClass, 'acl_denied');
  assert.equal(end.exitCode, 51);
});

test('end event: exit 44 (not_found) → result=miss (distinct from error)', () => {
  process.env.AO_DEBUG_CREDENTIAL = '1';
  __setExecFileSyncForTest(mockExec(errorWith({ status: 44 })));
  setPlatform('darwin');
  const stderr = captureStderr(() => resolveGeminiApiKey());
  const end = parseEvents(stderr).find((e) => e.stage === 'end');
  assert.equal(end.result, 'miss');
  assert.equal(end.stderrClass, 'not_found');
});

test('end event: windows_unsupported platform → source=windows_unsupported, result=error', () => {
  process.env.AO_DEBUG_CREDENTIAL = '1';
  setPlatform('win32');
  const stderr = captureStderr(() => resolveGeminiApiKey());
  const end = parseEvents(stderr).find((e) => e.stage === 'end');
  assert.equal(end.source, 'windows_unsupported');
  assert.equal(end.result, 'error');
  assert.equal(end.stderrClass, 'windows_unsupported');
});

// ═══════════════════════════════════════════════════════════════════════════
// #8 secret safety — key must not leak via error shape fields either

test('raw key embedded in err.message is NOT propagated to tracing output', () => {
  process.env.AO_DEBUG_CREDENTIAL = '1';
  const err = errorWith({
    status: 1,
    message: `Oops the key was ${TEST_KEY} and that failed`,
    stderr: `tool output contains ${TEST_KEY} somehow`,
    stdout: TEST_KEY,
  });
  __setExecFileSyncForTest(mockExec(err));
  setPlatform('darwin');
  const stderr = captureStderr(() => resolveGeminiApiKey());
  assert.ok(
    !stderr.includes(TEST_KEY),
    `stderr should not include raw key embedded in error object: ${stderr}`
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// #9 resilience — tracing code never crashes the resolver

test('tracing never throws even on pathological inputs', () => {
  process.env.AO_DEBUG_CREDENTIAL = '1';
  __setExecFileSyncForTest(mockExec(errorWith({ status: -1, signal: 'SIGXCPU', killed: false })));
  setPlatform('darwin');
  assert.doesNotThrow(() => {
    captureStderr(() => resolveGeminiApiKey());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// teardown

test('teardown: restore env vars', () => {
  if (originalEnv === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalEnv;
  if (originalDbgCred === undefined) delete process.env.AO_DEBUG_CREDENTIAL;
  else process.env.AO_DEBUG_CREDENTIAL = originalDbgCred;
  if (originalDbgGemini === undefined) delete process.env.AO_DEBUG_GEMINI;
  else process.env.AO_DEBUG_GEMINI = originalDbgGemini;
});
