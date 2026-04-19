/**
 * Unit tests for scripts/lib/gemini-credential.mjs
 *
 * Covers all 22 cases from the v1.1 PRD:
 *   env precedence, macOS/Linux/Windows branches, TTL cache, per-account
 *   isolation, in-flight behavior (sync), invalidation, custom account,
 *   timeout, whitespace handling, maskKey, null caching.
 */

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveGeminiApiKey,
  invalidateCache,
  maskKey,
  emitStaleAoKeychainWarning,
  __resetForTest,
  __setExecFileSyncForTest,
} from '../lib/gemini-credential.mjs';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a mock execFileSync that records calls and returns a configured response.
 * response can be a string (success), Error (failure), or a function (dynamic).
 */
function mockExec(response) {
  const calls = [];
  const fn = (bin, args, opts) => {
    calls.push({ bin, args: [...args], opts });
    const r = typeof response === 'function' ? response(bin, args, opts) : response;
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = calls;
  return fn;
}

function originalPlatform() {
  return process.platform;
}

function setPlatform(p) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

function restorePlatform(p) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_KEY = 'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
const TEST_KEY_B = 'AIzaSyZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';

const originalEnv = process.env.GEMINI_API_KEY;
const ORIG_PLATFORM = process.platform;

beforeEach(() => {
  __resetForTest();
  delete process.env.GEMINI_API_KEY;
  restorePlatform(ORIG_PLATFORM);
});

// ═══════════════════════════════════════════════════════════════════════════
// #1: env var precedence
// ═══════════════════════════════════════════════════════════════════════════

test('#1 env GEMINI_API_KEY takes precedence; execFileSync never called', () => {
  const mock = mockExec('should-not-run');
  __setExecFileSyncForTest(mock);
  process.env.GEMINI_API_KEY = TEST_KEY;

  const got = resolveGeminiApiKey();

  assert.equal(got, TEST_KEY);
  assert.equal(mock.calls.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// #2-4: macOS branch
// ═══════════════════════════════════════════════════════════════════════════

test('#2 macOS keychain hit returns trimmed key', () => {
  setPlatform('darwin');
  const mock = mockExec(`${TEST_KEY}\n`);
  __setExecFileSyncForTest(mock);

  const got = resolveGeminiApiKey();

  assert.equal(got, TEST_KEY);
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].bin, '/usr/bin/security');
  assert.deepEqual(mock.calls[0].args, [
    'find-generic-password', '-s', 'gemini-cli-api-key', '-a', 'default-api-key', '-w',
  ]);
});

test('#3 macOS keychain miss (execFileSync throws) returns null', () => {
  setPlatform('darwin');
  __setExecFileSyncForTest(mockExec(new Error('The specified item could not be found in the keychain.')));

  const got = resolveGeminiApiKey();

  assert.equal(got, null);
});

test('#4 macOS keychain locked / user-cancelled returns null (no throw)', () => {
  setPlatform('darwin');
  const err = new Error('User canceled the operation.');
  err.status = -128;
  __setExecFileSyncForTest(mockExec(err));

  assert.doesNotThrow(() => resolveGeminiApiKey());
  assert.equal(resolveGeminiApiKey({ forceRefresh: true }), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// #5-7: Linux branch
// ═══════════════════════════════════════════════════════════════════════════

test('#5 Linux secret-tool hit returns trimmed key', () => {
  setPlatform('linux');
  const mock = mockExec(`${TEST_KEY}\n`);
  __setExecFileSyncForTest(mock);

  const got = resolveGeminiApiKey();

  assert.equal(got, TEST_KEY);
  assert.equal(mock.calls[0].bin, '/usr/bin/secret-tool');
  assert.deepEqual(mock.calls[0].args, [
    'lookup', 'service', 'gemini-cli-api-key', 'account', 'default-api-key',
  ]);
});

test('#6 Linux secret-tool ENOENT returns null', () => {
  setPlatform('linux');
  const err = new Error('spawn secret-tool ENOENT');
  err.code = 'ENOENT';
  __setExecFileSyncForTest(mockExec(err));

  assert.equal(resolveGeminiApiKey(), null);
});

test('#7 Linux D-Bus unavailable / secret-tool exits non-zero returns null', () => {
  setPlatform('linux');
  const err = new Error('Cannot autolaunch D-Bus without X11');
  err.status = 1;
  __setExecFileSyncForTest(mockExec(err));

  assert.equal(resolveGeminiApiKey(), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// #8-9: Windows branch
// ═══════════════════════════════════════════════════════════════════════════

test('#8 Windows returns null + emits stderr notice', () => {
  setPlatform('win32');
  const mock = mockExec('should-not-run');
  __setExecFileSyncForTest(mock);

  let got;
  const stderr = captureStderr(() => {
    got = resolveGeminiApiKey();
  });

  assert.equal(got, null);
  assert.match(stderr, /Windows keychain not supported/);
  assert.equal(mock.calls.length, 0);
});

test('#9 Windows notice emitted only once across multiple calls', () => {
  setPlatform('win32');
  __setExecFileSyncForTest(mockExec('never'));

  const stderr = captureStderr(() => {
    resolveGeminiApiKey({ forceRefresh: true });
    resolveGeminiApiKey({ forceRefresh: true });
    resolveGeminiApiKey({ forceRefresh: true });
  });

  const matches = stderr.match(/Windows keychain not supported/g) || [];
  assert.equal(matches.length, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// #10-11: TTL cache
// ═══════════════════════════════════════════════════════════════════════════

test('#10 TTL cache hit: two sequential calls invoke execFileSync once', () => {
  setPlatform('darwin');
  const mock = mockExec(`${TEST_KEY}\n`);
  __setExecFileSyncForTest(mock);

  assert.equal(resolveGeminiApiKey(), TEST_KEY);
  assert.equal(resolveGeminiApiKey(), TEST_KEY);

  assert.equal(mock.calls.length, 1);
});

test('#11 TTL expiry triggers re-fetch (hit path: SUCCESS_TTL_MS = 24h after PR 4 split)', () => {
  setPlatform('darwin');
  const mock = mockExec(`${TEST_KEY}\n`);
  __setExecFileSyncForTest(mock);

  const originalNow = Date.now;
  const start = originalNow();
  Date.now = () => start;

  try {
    assert.equal(resolveGeminiApiKey(), TEST_KEY);
    // Advance past SUCCESS_TTL_MS (24h), +1ms to ensure strict past
    Date.now = () => start + 24 * 60 * 60 * 1000 + 1;
    assert.equal(resolveGeminiApiKey(), TEST_KEY);
    assert.equal(mock.calls.length, 2);
  } finally {
    Date.now = originalNow;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// #12-13: Per-account cache isolation (Codex-flagged critical issue)
// ═══════════════════════════════════════════════════════════════════════════

test('#12 different accounts cached independently (no cross-pollination)', () => {
  setPlatform('darwin');
  const mock = mockExec((bin, args) => {
    const acct = args[args.indexOf('-a') + 1];
    if (acct === 'acct-a') return `${TEST_KEY}\n`;
    if (acct === 'acct-b') return `${TEST_KEY_B}\n`;
    return '';
  });
  __setExecFileSyncForTest(mock);

  assert.equal(resolveGeminiApiKey({ account: 'acct-a' }), TEST_KEY);
  assert.equal(resolveGeminiApiKey({ account: 'acct-b' }), TEST_KEY_B);
  // Second round should hit cache per-account
  assert.equal(resolveGeminiApiKey({ account: 'acct-a' }), TEST_KEY);
  assert.equal(resolveGeminiApiKey({ account: 'acct-b' }), TEST_KEY_B);

  assert.equal(mock.calls.length, 2);
});

test('#13 miss on account A does not poison account B cache', () => {
  setPlatform('darwin');
  const mock = mockExec((bin, args) => {
    const acct = args[args.indexOf('-a') + 1];
    if (acct === 'missing') throw new Error('not found');
    if (acct === 'present') return `${TEST_KEY}\n`;
    return '';
  });
  __setExecFileSyncForTest(mock);

  assert.equal(resolveGeminiApiKey({ account: 'missing' }), null);
  assert.equal(resolveGeminiApiKey({ account: 'present' }), TEST_KEY);

  // Re-queries must come from cache independently
  assert.equal(resolveGeminiApiKey({ account: 'missing' }), null);
  assert.equal(resolveGeminiApiKey({ account: 'present' }), TEST_KEY);
  assert.equal(mock.calls.length, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// #14-15: Cache invalidation
// ═══════════════════════════════════════════════════════════════════════════

test('#14 invalidateCache(account) clears only that account', () => {
  setPlatform('darwin');
  const mock = mockExec((bin, args) => {
    const acct = args[args.indexOf('-a') + 1];
    return `KEY-FOR-${acct}\n`;
  });
  __setExecFileSyncForTest(mock);

  resolveGeminiApiKey({ account: 'a' });
  resolveGeminiApiKey({ account: 'b' });
  assert.equal(mock.calls.length, 2);

  captureStderr(() => invalidateCache('a', 'auth_failed'));

  resolveGeminiApiKey({ account: 'a' }); // re-fetch
  resolveGeminiApiKey({ account: 'b' }); // still cached

  assert.equal(mock.calls.length, 3);
});

test('#15 invalidateCache("all") flushes every account', () => {
  setPlatform('darwin');
  const mock = mockExec((bin, args) => {
    const acct = args[args.indexOf('-a') + 1];
    return `KEY-${acct}\n`;
  });
  __setExecFileSyncForTest(mock);

  resolveGeminiApiKey({ account: 'a' });
  resolveGeminiApiKey({ account: 'b' });
  assert.equal(mock.calls.length, 2);

  captureStderr(() => invalidateCache('all', 'manual'));

  resolveGeminiApiKey({ account: 'a' });
  resolveGeminiApiKey({ account: 'b' });

  assert.equal(mock.calls.length, 4);
});

// ═══════════════════════════════════════════════════════════════════════════
// #16-17: Opt-out & custom account
// ═══════════════════════════════════════════════════════════════════════════

test('#16 useKeychain:false returns null without touching execFileSync', () => {
  setPlatform('darwin');
  const mock = mockExec('never');
  __setExecFileSyncForTest(mock);

  const got = resolveGeminiApiKey({ useKeychain: false });
  assert.equal(got, null);
  assert.equal(mock.calls.length, 0);
});

test('#17 custom account is forwarded to -a flag', () => {
  setPlatform('darwin');
  const mock = mockExec(`${TEST_KEY}\n`);
  __setExecFileSyncForTest(mock);

  resolveGeminiApiKey({ account: 'my-custom-acct' });

  const idx = mock.calls[0].args.indexOf('-a');
  assert.equal(mock.calls[0].args[idx + 1], 'my-custom-acct');
});

// ═══════════════════════════════════════════════════════════════════════════
// #18-20: Edge cases
// ═══════════════════════════════════════════════════════════════════════════

test('#18 execFileSync timeout error returns null (never throws)', () => {
  setPlatform('darwin');
  const err = new Error('spawnSync /usr/bin/security ETIMEDOUT');
  err.code = 'ETIMEDOUT';
  __setExecFileSyncForTest(mockExec(err));

  assert.doesNotThrow(() => resolveGeminiApiKey());
  assert.equal(resolveGeminiApiKey({ forceRefresh: true }), null);
});

test('#19 stdout whitespace/newlines are trimmed', () => {
  setPlatform('darwin');
  __setExecFileSyncForTest(mockExec(`  ${TEST_KEY}  \n\n`));

  assert.equal(resolveGeminiApiKey(), TEST_KEY);
});

test('#20 whitespace-only stdout returns null (not empty string)', () => {
  setPlatform('darwin');
  __setExecFileSyncForTest(mockExec('   \n\n'));

  assert.equal(resolveGeminiApiKey(), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// #21: maskKey coverage
// ═══════════════════════════════════════════════════════════════════════════

describe('#21 maskKey', () => {
  test('normal length key shows prefix + suffix', () => {
    assert.equal(maskKey('AIzaSy1234567890abcdef'), 'AIza****ef');
  });
  test('null returns <none>', () => {
    assert.equal(maskKey(null), '<none>');
  });
  test('undefined returns <none>', () => {
    assert.equal(maskKey(undefined), '<none>');
  });
  test('short key returns ****', () => {
    assert.equal(maskKey('short'), '****');
  });
  test('8-char boundary returns ****', () => {
    assert.equal(maskKey('12345678'), '****');
  });
  test('9-char returns prefix+suffix', () => {
    assert.equal(maskKey('123456789'), '1234****89');
  });
  test('non-string returns <none>', () => {
    assert.equal(maskKey(12345), '<none>');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// #22: null results are cached
// ═══════════════════════════════════════════════════════════════════════════

test('#22 null result is cached; second call does not re-invoke execFileSync', () => {
  setPlatform('darwin');
  __setExecFileSyncForTest(mockExec(new Error('miss')));

  // First call: execFileSync invoked, returns null
  assert.equal(resolveGeminiApiKey(), null);

  // Swap mock to something that WOULD succeed — proves no re-call happened
  const secondMock = mockExec(`${TEST_KEY}\n`);
  __setExecFileSyncForTest(secondMock);

  assert.equal(resolveGeminiApiKey(), null); // still null from cache
  assert.equal(secondMock.calls.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// Codex review fixes (post-commit-1 hardening)
// ═══════════════════════════════════════════════════════════════════════════

test('#23 resolveGeminiApiKey(null) does not throw (never-throws contract)', () => {
  setPlatform('darwin');
  __setExecFileSyncForTest(mockExec(`${TEST_KEY}\n`));
  assert.doesNotThrow(() => resolveGeminiApiKey(null));
  assert.doesNotThrow(() => resolveGeminiApiKey(undefined));
  assert.doesNotThrow(() => resolveGeminiApiKey(42));
  assert.doesNotThrow(() => resolveGeminiApiKey('bad'));
});

test('#24 empty GEMINI_API_KEY env means "explicitly disabled", does NOT fall through to keychain', () => {
  setPlatform('darwin');
  const mock = mockExec(`${TEST_KEY}\n`);
  __setExecFileSyncForTest(mock);
  process.env.GEMINI_API_KEY = '';

  const got = resolveGeminiApiKey();
  assert.equal(got, null);
  assert.equal(mock.calls.length, 0, 'keychain must NOT be queried');
});

test('#25 non-empty GEMINI_API_KEY env used as-is, no keychain query', () => {
  setPlatform('darwin');
  const mock = mockExec(`${TEST_KEY}\n`);
  __setExecFileSyncForTest(mock);
  process.env.GEMINI_API_KEY = 'explicit-key';

  assert.equal(resolveGeminiApiKey(), 'explicit-key');
  assert.equal(mock.calls.length, 0);
});

test('#26 account name containing colon is invalidated exactly (not by suffix match)', () => {
  setPlatform('darwin');
  const mock = mockExec((bin, args) => {
    const acct = args[args.indexOf('-a') + 1];
    return `KEY-${acct}\n`;
  });
  __setExecFileSyncForTest(mock);

  // Two accounts where one ends with a suffix of the other
  resolveGeminiApiKey({ account: 'team:prod' });
  resolveGeminiApiKey({ account: 'prod' });
  assert.equal(mock.calls.length, 2);

  // Invalidate only 'prod' — 'team:prod' must survive despite the suffix
  captureStderr(() => invalidateCache('prod'));

  resolveGeminiApiKey({ account: 'team:prod' }); // cached
  resolveGeminiApiKey({ account: 'prod' }); // re-fetch

  assert.equal(mock.calls.length, 3, 'team:prod must still be cached');
});

test('#27 Linux secret-tool falls back across candidate paths on ENOENT', () => {
  setPlatform('linux');
  const tried = [];
  const fn = (bin, args) => {
    tried.push(bin);
    if (bin === '/usr/bin/secret-tool') {
      const err = new Error('no such file');
      err.code = 'ENOENT';
      throw err;
    }
    if (bin === '/usr/local/bin/secret-tool') {
      const err = new Error('no such file');
      err.code = 'ENOENT';
      throw err;
    }
    if (bin === '/run/current-system/sw/bin/secret-tool') {
      return `${TEST_KEY}\n`;
    }
    return '';
  };
  __setExecFileSyncForTest(fn);

  assert.equal(resolveGeminiApiKey(), TEST_KEY);
  assert.deepEqual(tried, [
    '/usr/bin/secret-tool',
    '/usr/local/bin/secret-tool',
    '/run/current-system/sw/bin/secret-tool',
  ]);
});

test('#28 Linux secret-tool: non-ENOENT error on a candidate stops the chain (no retry)', () => {
  setPlatform('linux');
  const tried = [];
  const fn = (bin) => {
    tried.push(bin);
    if (bin === '/usr/bin/secret-tool') {
      // Found the tool but lookup failed — should NOT try other candidates
      const err = new Error('lookup miss');
      err.status = 1;
      throw err;
    }
    return `${TEST_KEY}\n`;
  };
  __setExecFileSyncForTest(fn);

  assert.equal(resolveGeminiApiKey(), null);
  assert.deepEqual(tried, ['/usr/bin/secret-tool']);
});

// ─── Restore env var if the surrounding process had one ───────────────────────

test('teardown: restores original GEMINI_API_KEY', () => {
  if (originalEnv !== undefined) {
    process.env.GEMINI_API_KEY = originalEnv;
  } else {
    delete process.env.GEMINI_API_KEY;
  }
  assert.ok(true);
});

// ═══════════════════════════════════════════════════════════════════════════
// Real-world Keychain payload handling (gemini CLI stores JSON envelope)
// ═══════════════════════════════════════════════════════════════════════════

test('#29 gemini CLI JSON envelope: extracts token.accessToken', () => {
  setPlatform('darwin');
  const envelope = JSON.stringify({
    serverName: 'default-api-key',
    token: { accessToken: TEST_KEY, tokenType: 'ApiKey' },
    updatedAt: 1775660459156,
  });
  __setExecFileSyncForTest(mockExec(`${envelope}\n`));
  assert.equal(resolveGeminiApiKey(), TEST_KEY);
});

test('#30 JSON envelope with alt field names (accessToken/apiKey/key)', () => {
  setPlatform('darwin');

  for (const field of ['accessToken', 'apiKey', 'api_key', 'key', 'value']) {
    __resetForTest();
    __setExecFileSyncForTest(mockExec(JSON.stringify({ [field]: `${field}-key-${TEST_KEY}` })));
    assert.equal(resolveGeminiApiKey(), `${field}-key-${TEST_KEY}`, `field=${field}`);
  }
});

test('#31 bare string is still returned as-is (backward compat)', () => {
  setPlatform('darwin');
  __setExecFileSyncForTest(mockExec(`${TEST_KEY}\n`));
  assert.equal(resolveGeminiApiKey(), TEST_KEY);
});

test('#32 JSON with no recognized field returns null (safe)', () => {
  setPlatform('darwin');
  __setExecFileSyncForTest(mockExec(JSON.stringify({ foo: 'bar', baz: 42 })));
  assert.equal(resolveGeminiApiKey(), null);
});

test('#33 malformed JSON with leading { falls through to bare-string handling', () => {
  setPlatform('darwin');
  // Looks like JSON but isn't — treat as bare string
  __setExecFileSyncForTest(mockExec('{not json at all'));
  assert.equal(resolveGeminiApiKey(), '{not json at all');
});

test('#34 Linux secret-tool also unwraps JSON envelope (Codex review fix)', () => {
  setPlatform('linux');
  const envelope = JSON.stringify({
    serverName: 'default-api-key',
    token: { accessToken: TEST_KEY, tokenType: 'ApiKey' },
    updatedAt: 1775660459156,
  });
  __setExecFileSyncForTest(mockExec(`${envelope}\n`));
  assert.equal(resolveGeminiApiKey(), TEST_KEY,
    'Linux path must apply _extractKey like macOS does');
});

test('#35 Linux bare-string path still works (backward compat)', () => {
  setPlatform('linux');
  __setExecFileSyncForTest(mockExec(`${TEST_KEY}\n`));
  assert.equal(resolveGeminiApiKey(), TEST_KEY);
});

// ═══════════════════════════════════════════════════════════════════════════
// emitStaleAoKeychainWarning — PR 5 stale hint for ao-keychain users
// ═══════════════════════════════════════════════════════════════════════════

test('emitStaleAoKeychainWarning writes single JSON line with account + guidance', () => {
  const stderr = captureStderr(() => {
    emitStaleAoKeychainWarning('default-api-key');
  });
  const lines = stderr.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'exactly one line emitted');
  const obj = JSON.parse(lines[0]);
  assert.equal(obj.event, 'gemini_cred_stale_ao_keychain');
  assert.equal(obj.account, 'default-api-key');
  assert.match(obj.message, /setup-gemini-auth|setup-gemini-key\.mjs/);
});

test('emitStaleAoKeychainWarning fires UNCONDITIONALLY (no AO_DEBUG_* gate)', () => {
  // Ensure neither debug env var is set — warning must still fire
  const saved1 = process.env.AO_DEBUG_CREDENTIAL;
  const saved2 = process.env.AO_DEBUG_GEMINI;
  delete process.env.AO_DEBUG_CREDENTIAL;
  delete process.env.AO_DEBUG_GEMINI;
  try {
    const stderr = captureStderr(() => emitStaleAoKeychainWarning('acct'));
    assert.ok(stderr.includes('gemini_cred_stale_ao_keychain'),
      'warning must bypass debug gating — it is user-facing guidance, not diagnostic');
  } finally {
    if (saved1 !== undefined) process.env.AO_DEBUG_CREDENTIAL = saved1;
    if (saved2 !== undefined) process.env.AO_DEBUG_GEMINI = saved2;
  }
});

test('emitStaleAoKeychainWarning does not throw even on pathological input', () => {
  assert.doesNotThrow(() => {
    captureStderr(() => emitStaleAoKeychainWarning(undefined));
    captureStderr(() => emitStaleAoKeychainWarning(null));
    captureStderr(() => emitStaleAoKeychainWarning(''));
  });
});

test('emitStaleAoKeychainWarning never leaks API key material', () => {
  const fakeKey = 'AIzaNEVER_IN_STALE_WARNING_ABCDEFGHIJKLMN';
  const stderr = captureStderr(() => emitStaleAoKeychainWarning(fakeKey));
  // The account field ends up in the JSON verbatim, which is fine (we never
  // pass a key there in practice — only account names from autonomy.json).
  // But the message body must not contain any AIza-shape string.
  const obj = JSON.parse(stderr.split('\n').filter(Boolean)[0]);
  assert.ok(!obj.message.includes(fakeKey),
    'the guidance message must NOT interpolate the account/key value');
});
