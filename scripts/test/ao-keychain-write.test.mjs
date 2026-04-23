/**
 * Unit tests for scripts/lib/ao-keychain-write.mjs
 *
 * Focus: argv shape (CRITICAL — no secret on argv), stdin payload format,
 * trusted-app list, validation/fail-safe paths. Does NOT touch the real
 * macOS keychain; spawnSync is mocked.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  writeAoKeychainItem,
  _sanitizeStderr,
  __setSpawnSyncForTest,
  __resetSpawnSyncForTest,
  __setIsTtyForTest,
  __resetIsTtyForTest,
  _consts,
} from '../lib/ao-keychain-write.mjs';

function mockOk() {
  const calls = [];
  const fn = (bin, args, opts) => {
    calls.push({ bin, args: [...args], opts });
    return { status: 0, stdout: '', stderr: '', error: undefined, signal: null };
  };
  fn.calls = calls;
  return fn;
}

function mockResult(resp) {
  const calls = [];
  const fn = (bin, args, opts) => {
    calls.push({ bin, args: [...args], opts });
    return resp;
  };
  fn.calls = calls;
  return fn;
}

/**
 * Return spawn responses sequenced per call: first call gets seq[0], second
 * gets seq[1], etc. Useful when add and partition-list need distinct outcomes.
 */
function mockSequence(seq) {
  const calls = [];
  let i = 0;
  const fn = (bin, args, opts) => {
    calls.push({ bin, args: [...args], opts });
    const resp = seq[Math.min(i, seq.length - 1)];
    i++;
    return resp;
  };
  fn.calls = calls;
  return fn;
}

beforeEach(() => {
  __resetSpawnSyncForTest();
  __resetIsTtyForTest();
});

// ─── argv never carries the secret ────────────────────────────────────────────

test('CRITICAL: API key is NOT placed on argv — delivered via stdin only', () => {
  const mock = mockOk();
  __setSpawnSyncForTest(mock);
  const key = 'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
  writeAoKeychainItem({ apiKey: key });
  for (const arg of mock.calls[0].args) {
    assert.ok(
      !arg.includes(key),
      `argv MUST NOT contain the raw API key. Found in: ${arg}`
    );
  }
  // And the stdin payload DOES carry the key twice (password + retype)
  assert.equal(mock.calls[0].opts.input, `${key}\n${key}\n`);
});

test('security invoked with correct binary path (no PATH lookup)', () => {
  const mock = mockOk();
  __setSpawnSyncForTest(mock);
  writeAoKeychainItem({ apiKey: 'AIzaTESTKEY1234567890' });
  assert.equal(mock.calls[0].bin, '/usr/bin/security');
});

test('-w is the LAST option (required for stdin prompt mode)', () => {
  const mock = mockOk();
  __setSpawnSyncForTest(mock);
  writeAoKeychainItem({ apiKey: 'AIzaTESTKEY1234567890' });
  const args = mock.calls[0].args;
  assert.equal(args[args.length - 1], '-w');
});

test('argv starts with add-generic-password -U (idempotent update)', () => {
  const mock = mockOk();
  __setSpawnSyncForTest(mock);
  writeAoKeychainItem({ apiKey: 'AIzaTESTKEY1234567890' });
  const args = mock.calls[0].args;
  assert.equal(args[0], 'add-generic-password');
  assert.equal(args[1], '-U');
});

test('default trusted apps include /usr/bin/security, /usr/bin/env, and current Node', () => {
  const mock = mockOk();
  __setSpawnSyncForTest(mock);
  writeAoKeychainItem({ apiKey: 'AIzaTESTKEY1234567890' });
  const args = mock.calls[0].args;
  // Collect -T paths
  const trusted = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-T') trusted.push(args[i + 1]);
  }
  assert.ok(trusted.includes('/usr/bin/security'));
  assert.ok(trusted.includes('/usr/bin/env'));
  assert.ok(trusted.includes(process.execPath));
});

test('default account and service match the AO convention', () => {
  const mock = mockOk();
  __setSpawnSyncForTest(mock);
  writeAoKeychainItem({ apiKey: 'AIzaTESTKEY1234567890' });
  const args = mock.calls[0].args;
  const a = args.indexOf('-a');
  const s = args.indexOf('-s');
  assert.equal(args[a + 1], 'default-api-key');
  assert.equal(args[s + 1], 'agent-olympus.gemini-api-key');
});

test('custom account and service are threaded through', () => {
  const mock = mockOk();
  __setSpawnSyncForTest(mock);
  writeAoKeychainItem({
    apiKey: 'AIzaTESTKEY1234567890',
    account: 'work-api-key',
    service: 'my.custom.service',
  });
  const args = mock.calls[0].args;
  const a = args.indexOf('-a');
  const s = args.indexOf('-s');
  assert.equal(args[a + 1], 'work-api-key');
  assert.equal(args[s + 1], 'my.custom.service');
});

test('custom trustedApps array replaces the default', () => {
  const mock = mockOk();
  __setSpawnSyncForTest(mock);
  writeAoKeychainItem({
    apiKey: 'AIzaTESTKEY1234567890',
    trustedApps: ['/usr/bin/security', '/opt/homebrew/bin/node'],
  });
  const args = mock.calls[0].args;
  const trusted = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-T') trusted.push(args[i + 1]);
  }
  assert.deepEqual(trusted.sort(), ['/opt/homebrew/bin/node', '/usr/bin/security']);
});

// ─── validation / fail-safe ───────────────────────────────────────────────────

test('rejects missing apiKey', () => {
  __setSpawnSyncForTest(mockOk());
  const r = writeAoKeychainItem({});
  assert.equal(r.ok, false);
  assert.match(r.error, /apiKey must be a non-empty string/);
});

test('rejects empty apiKey', () => {
  __setSpawnSyncForTest(mockOk());
  const r = writeAoKeychainItem({ apiKey: '' });
  assert.equal(r.ok, false);
});

test('rejects apiKey with embedded newline (would truncate stdin payload)', () => {
  const mock = mockOk();
  __setSpawnSyncForTest(mock);
  const r = writeAoKeychainItem({ apiKey: 'AIza\nMALICIOUS' });
  assert.equal(r.ok, false);
  assert.match(r.error, /newline|carriage-return/);
  assert.equal(mock.calls.length, 0, 'must NOT call security with malformed key');
});

test('rejects apiKey with carriage-return', () => {
  const mock = mockOk();
  __setSpawnSyncForTest(mock);
  const r = writeAoKeychainItem({ apiKey: 'AIza\rMALICIOUS' });
  assert.equal(r.ok, false);
  assert.equal(mock.calls.length, 0);
});

test('null/undefined opts returns validation error (never throws)', () => {
  __setSpawnSyncForTest(mockOk());
  const r1 = writeAoKeychainItem(null);
  const r2 = writeAoKeychainItem(undefined);
  assert.equal(r1.ok, false);
  assert.equal(r2.ok, false);
});

// ─── spawn errors ─────────────────────────────────────────────────────────────

test('spawn error (ENOENT) reported as ok=false with error.code', () => {
  __setSpawnSyncForTest(mockResult({
    status: null,
    signal: null,
    error: { code: 'ENOENT', message: 'spawn /usr/bin/security ENOENT' },
    stdout: '',
    stderr: '',
  }));
  const r = writeAoKeychainItem({ apiKey: 'AIzaTESTKEY1234567890' });
  assert.equal(r.ok, false);
  assert.match(r.error, /ENOENT/);
});

test('non-zero exit reported with exitCode and sanitized stderr', () => {
  __setSpawnSyncForTest(mockResult({
    status: 45,
    signal: null,
    error: undefined,
    stdout: '',
    stderr: 'security: something went wrong',
  }));
  const r = writeAoKeychainItem({ apiKey: 'AIzaTESTKEY1234567890' });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 45);
  assert.equal(r.stderr, 'security: something went wrong');
});

test('stderr sanitizer redacts any embedded AIza-shaped API key', () => {
  const leakedKey = 'AIzaLEAKEDKEYABCDEFGHIJKL1234567890xyz';
  __setSpawnSyncForTest(mockResult({
    status: 1,
    signal: null,
    error: undefined,
    stdout: '',
    stderr: `some error containing ${leakedKey} somehow`,
  }));
  const r = writeAoKeychainItem({ apiKey: 'AIzaTESTKEY1234567890' });
  assert.ok(!r.stderr.includes(leakedKey), `sanitizer must redact: ${r.stderr}`);
  assert.ok(r.stderr.includes('REDACTED'));
});

test('stderr sanitizer redacts the exact caller-supplied key (codex PR3 review fix for non-AIza formats)', () => {
  // A key that does NOT match the AIza heuristic — covers any future Google
  // rotation or a custom proxy that uses a different prefix.
  const nonStandardKey = 'custom-proxy-key-xyz_123';
  __setSpawnSyncForTest(mockResult({
    status: 1,
    signal: null,
    error: undefined,
    stdout: '',
    stderr: `security: leaked payload: ${nonStandardKey}`,
  }));
  const r = writeAoKeychainItem({ apiKey: nonStandardKey });
  assert.ok(
    !r.stderr.includes(nonStandardKey),
    `exact-match sanitizer must redact caller-supplied key of any shape: ${r.stderr}`
  );
  assert.ok(r.stderr.includes('<redacted:caller-key>'));
});

test('_sanitizeStderr helper: caller key redacted before AIza pattern fallback', () => {
  const out = _sanitizeStderr('bare=my-secret AIzaABCDEFGHIJKLMNOPQRSTUVWXYZ123456 mixed', 'my-secret');
  assert.ok(!out.includes('my-secret'));
  assert.ok(out.includes('<redacted:caller-key>'));
  assert.ok(out.includes('AIza****REDACTED'));
});

test('_sanitizeStderr helper: escapes regex metacharacters in the caller key', () => {
  const trickyKey = 'key.with*regex+meta()';
  const out = _sanitizeStderr(`prefix ${trickyKey} suffix`, trickyKey);
  assert.ok(!out.includes(trickyKey));
  assert.ok(out.includes('<redacted:caller-key>'));
});

test('_sanitizeStderr helper: null/empty inputs handled safely', () => {
  assert.equal(_sanitizeStderr(null, 'anything'), null);
  assert.equal(_sanitizeStderr('', 'anything'), null);
  assert.equal(_sanitizeStderr(undefined, 'anything'), null);
  // Missing apiKey still runs the pattern pass
  assert.equal(_sanitizeStderr('hello AIzaTESTKEY1234567890ABCDEFGH world'),
    'hello AIza****REDACTED world');
});

test('signal-terminated spawn (timeout) reported with null exitCode', () => {
  __setSpawnSyncForTest(mockResult({
    status: null,
    signal: 'SIGTERM',
    error: undefined,
    stdout: '',
    stderr: '',
  }));
  const r = writeAoKeychainItem({ apiKey: 'AIzaTESTKEY1234567890' });
  assert.equal(r.ok, false);
  assert.match(r.error, /signal SIGTERM/);
});

test('successful spawn returns ok=true with no error or stderr', () => {
  __setSpawnSyncForTest(mockOk());
  const r = writeAoKeychainItem({ apiKey: 'AIzaTESTKEY1234567890' });
  assert.equal(r.ok, true);
  assert.equal(r.error, null);
  assert.equal(r.exitCode, 0);
});

// ─── constants export sanity ──────────────────────────────────────────────────

test('exported _consts match the module defaults', () => {
  assert.equal(_consts.SECURITY_BIN, '/usr/bin/security');
  assert.equal(_consts.DEFAULT_AO_SERVICE, 'agent-olympus.gemini-api-key');
  assert.equal(_consts.DEFAULT_ACCOUNT, 'default-api-key');
  assert.equal(_consts.PARTITION_LIST, 'apple-tool:,apple:');
});

// ─── partition-list step (Step C: Sonoma+ zero-prompt fix) ────────────────────

test('partition-list step: skipped when stdin is NOT a TTY (piped/CI mode)', () => {
  __setIsTtyForTest(() => false);
  const mock = mockOk();
  __setSpawnSyncForTest(mock);
  const r = writeAoKeychainItem({ apiKey: 'AIzaTESTKEY1234567890' });
  assert.equal(r.ok, true, 'add-generic-password still succeeds');
  assert.equal(r.partitionListSet, false);
  assert.equal(r.partitionSkipped, true);
  assert.ok(r.partitionWarning, 'skipped path must surface a warning');
  assert.match(r.partitionWarning, /piped|not a TTY/i);
  assert.match(r.partitionWarning, /apple-tool:,apple:/,
    'warning must include the manual remediation command');
  assert.equal(mock.calls.length, 1,
    'partition-list spawn must NOT happen in non-TTY mode');
});

test('partition-list step: called with correct argv when stdin IS a TTY', () => {
  __setIsTtyForTest(() => true);
  const mock = mockOk();
  __setSpawnSyncForTest(mock);
  const r = writeAoKeychainItem({
    apiKey: 'AIzaTESTKEY1234567890',
    service: 'agent-olympus.gemini-api-key',
    account: 'default-api-key',
  });
  assert.equal(r.ok, true);
  assert.equal(r.partitionListSet, true);
  assert.equal(r.partitionSkipped, false);
  assert.equal(r.partitionWarning, null);
  assert.equal(mock.calls.length, 2, 'add + partition-list = 2 spawns');

  const partArgs = mock.calls[1].args;
  assert.equal(partArgs[0], 'set-generic-password-partition-list');
  // Required options in any order
  const s = partArgs.indexOf('-s');
  const a = partArgs.indexOf('-a');
  const S = partArgs.indexOf('-S');
  assert.equal(partArgs[s + 1], 'agent-olympus.gemini-api-key');
  assert.equal(partArgs[a + 1], 'default-api-key');
  assert.equal(partArgs[S + 1], 'apple-tool:,apple:',
    'partition identifiers grant /usr/bin/security (Apple-signed) zero-prompt reads');
  // Security: we must never pass -k (login password) — that would place the
  // password on argv (visible via `ps`) or require us to capture it.
  assert.equal(partArgs.indexOf('-k'), -1, 'NEVER pass -k on argv');
});

test('partition-list step: uses stdio:inherit so /dev/tty password prompt reaches the user', () => {
  __setIsTtyForTest(() => true);
  const mock = mockOk();
  __setSpawnSyncForTest(mock);
  writeAoKeychainItem({ apiKey: 'AIzaTESTKEY1234567890' });
  assert.equal(mock.calls[1].opts.stdio, 'inherit');
});

test('partition-list step: threads custom service/account', () => {
  __setIsTtyForTest(() => true);
  const mock = mockOk();
  __setSpawnSyncForTest(mock);
  writeAoKeychainItem({
    apiKey: 'AIzaTESTKEY1234567890',
    service: 'my.custom',
    account: 'work',
  });
  const partArgs = mock.calls[1].args;
  const s = partArgs.indexOf('-s');
  const a = partArgs.indexOf('-a');
  assert.equal(partArgs[s + 1], 'my.custom');
  assert.equal(partArgs[a + 1], 'work');
});

test('partition-list step: non-zero exit → partitionListSet=false + warning, but ok stays true', () => {
  __setIsTtyForTest(() => true);
  const mock = mockSequence([
    { status: 0, stdout: '', stderr: '', error: undefined, signal: null }, // add OK
    { status: 128, stdout: '', stderr: '', error: undefined, signal: null }, // partition fail
  ]);
  __setSpawnSyncForTest(mock);
  const r = writeAoKeychainItem({ apiKey: 'AIzaTESTKEY1234567890' });
  assert.equal(r.ok, true, 'item WAS written; partition failure is non-fatal');
  assert.equal(r.partitionListSet, false);
  assert.equal(r.partitionSkipped, false);
  assert.equal(r.partitionExitCode, 128);
  assert.match(r.partitionWarning, /exited with status 128/);
  assert.match(r.partitionWarning, /apple-tool:,apple:/,
    'warning surfaces manual remediation command');
});

test('partition-list step: spawn error (ENOENT) → warning, not fatal', () => {
  __setIsTtyForTest(() => true);
  const mock = mockSequence([
    { status: 0, stdout: '', stderr: '', error: undefined, signal: null },
    { status: null, signal: null, error: { code: 'ENOENT' }, stdout: '', stderr: '' },
  ]);
  __setSpawnSyncForTest(mock);
  const r = writeAoKeychainItem({ apiKey: 'AIzaTESTKEY1234567890' });
  assert.equal(r.ok, true);
  assert.equal(r.partitionListSet, false);
  assert.equal(r.partitionExitCode, null);
  assert.match(r.partitionWarning, /ENOENT|spawn failed/);
});

test('partition-list step: SIGTERM timeout → warning with signal name', () => {
  __setIsTtyForTest(() => true);
  const mock = mockSequence([
    { status: 0, stdout: '', stderr: '', error: undefined, signal: null },
    { status: null, signal: 'SIGTERM', error: undefined, stdout: '', stderr: '' },
  ]);
  __setSpawnSyncForTest(mock);
  const r = writeAoKeychainItem({ apiKey: 'AIzaTESTKEY1234567890' });
  assert.equal(r.ok, true);
  assert.equal(r.partitionListSet, false);
  assert.match(r.partitionWarning, /SIGTERM/);
});

test('partition-list step: NOT called when add-generic-password fails (ordering guarantee)', () => {
  __setIsTtyForTest(() => true);
  const mock = mockResult({
    status: 45, signal: null, error: undefined, stdout: '', stderr: '',
  });
  __setSpawnSyncForTest(mock);
  const r = writeAoKeychainItem({ apiKey: 'AIzaTESTKEY1234567890' });
  assert.equal(r.ok, false);
  assert.equal(mock.calls.length, 1, 'partition-list must not run after add failure');
  // Failed-add shape still surfaces partition fields (consistent shape, no undefineds)
  assert.equal(r.partitionListSet, false);
  assert.equal(r.partitionSkipped, true);
});

test('partition-list step: opts.partitionList="skip" disables step even on TTY', () => {
  __setIsTtyForTest(() => true);
  const mock = mockOk();
  __setSpawnSyncForTest(mock);
  const r = writeAoKeychainItem({
    apiKey: 'AIzaTESTKEY1234567890',
    partitionList: 'skip',
  });
  assert.equal(r.ok, true);
  assert.equal(r.partitionListSet, false);
  assert.equal(r.partitionSkipped, true);
  assert.equal(mock.calls.length, 1, 'skip mode must NOT spawn partition-list');
  assert.match(r.partitionWarning, /skipped by caller/);
});

test('partition-list step: warnings must NEVER leak the API key', () => {
  __setIsTtyForTest(() => true);
  const leakyKey = 'AIzaSECRET0123456789ABCDEFGHIJKLMNOP';
  const mock = mockSequence([
    { status: 0, stdout: '', stderr: '', error: undefined, signal: null },
    { status: 99, stdout: '', stderr: '', error: undefined, signal: null },
  ]);
  __setSpawnSyncForTest(mock);
  const r = writeAoKeychainItem({ apiKey: leakyKey });
  assert.ok(!r.partitionWarning.includes(leakyKey),
    'warning must not carry the raw API key');
});
