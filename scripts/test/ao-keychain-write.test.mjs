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

beforeEach(() => {
  __resetSpawnSyncForTest();
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
});
