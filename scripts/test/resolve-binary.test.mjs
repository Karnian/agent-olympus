/**
 * Unit tests for scripts/lib/resolve-binary.mjs
 * Uses node:test — zero npm dependencies.
 *
 * resolveBinary() calls execFileSync('which') and existsSync, which are
 * live system calls.  We test the logic via the _createResolver() factory
 * that accepts injected `which` and `stat` functions, keeping tests
 * hermetic without requiring module-level mocking flags.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveBinary,
  clearBinCache,
  _binCache,
  SEARCH_PATHS,
  _createResolver,
} from '../lib/resolve-binary.mjs';

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Build a resolver with controlled which/stat behaviour */
function makeResolver({
  whichResult = null,
  whichThrows = false,
  statResult = false,
  searchPaths = SEARCH_PATHS,
} = {}) {
  const which = (name) => {
    if (whichThrows) throw new Error(`which: ${name}: not found`);
    if (whichResult === null) return '';
    return whichResult;
  };
  const stat = () => statResult;
  return _createResolver({ which, stat, searchPaths });
}

// ─── _createResolver tests ────────────────────────────────────────────────────

test('returns absolute path when which succeeds', () => {
  const { resolveBinary: rb } = makeResolver({ whichResult: '/usr/bin/tmux' });
  assert.equal(rb('tmux'), '/usr/bin/tmux');
});

test('returns bare name when which throws and no SEARCH_PATHS match', () => {
  const { resolveBinary: rb } = makeResolver({ whichThrows: true, statResult: false });
  assert.equal(rb('nonexistent-bin'), 'nonexistent-bin');
});

test('returns SEARCH_PATHS candidate when which throws but stat returns true', () => {
  const { resolveBinary: rb } = makeResolver({
    whichThrows: true,
    statResult: true,
    searchPaths: ['/custom/bin'],
  });
  assert.equal(rb('tmux'), '/custom/bin/tmux');
});

test('cache hit: second call returns same value without invoking which again', () => {
  let callCount = 0;
  const which = () => { callCount++; return '/usr/bin/git'; };
  const { resolveBinary: rb } = _createResolver({ which, stat: () => false });

  rb('git');
  rb('git'); // should hit cache
  assert.equal(callCount, 1, 'which should only be called once');
});

test('multiple different binaries are cached independently', () => {
  const bins = { tmux: '/usr/bin/tmux', git: '/usr/bin/git' };
  const which = (name) => bins[name] ?? (() => { throw new Error(); })();
  const { resolveBinary: rb, cache } = _createResolver({ which, stat: () => false });

  assert.equal(rb('tmux'), '/usr/bin/tmux');
  assert.equal(rb('git'), '/usr/bin/git');
  assert.equal(cache.size, 2);
});

test('empty string name: falls through to bare name when no match', () => {
  const { resolveBinary: rb } = makeResolver({ whichThrows: true, statResult: false });
  assert.equal(rb(''), '');
});

test('which returns whitespace-only string: treated as empty, falls to SEARCH_PATHS', () => {
  const { resolveBinary: rb } = makeResolver({
    whichResult: '   ',   // .trim() → '' → falsy
    statResult: true,
    searchPaths: ['/opt/homebrew/bin'],
  });
  assert.equal(rb('tmux'), '/opt/homebrew/bin/tmux');
});

test('custom searchPaths override is respected', () => {
  const { resolveBinary: rb } = _createResolver({
    which: () => { throw new Error(); },
    stat: (p) => p === '/my/custom/path/node',
    searchPaths: ['/my/custom/path'],
  });
  assert.equal(rb('node'), '/my/custom/path/node');
});

// ─── clearBinCache / _binCache tests ─────────────────────────────────────────

test('clearBinCache() removes all entries from the module-level cache', () => {
  // Prime the real module-level cache via the actual resolveBinary
  // (which will resolve something real or fall back to bare name — either is fine)
  clearBinCache();
  assert.equal(_binCache.size, 0, 'cache should start empty after clear');

  // Manually populate to confirm clear works
  _binCache.set('__test__', '/some/path');
  assert.equal(_binCache.size, 1);
  clearBinCache();
  assert.equal(_binCache.size, 0);
});

// ─── SEARCH_PATHS content tests ───────────────────────────────────────────────

test('SEARCH_PATHS contains expected platform directories', () => {
  assert.ok(SEARCH_PATHS.includes('/opt/homebrew/bin'), 'missing macOS ARM path');
  assert.ok(SEARCH_PATHS.includes('/usr/local/bin'), 'missing macOS Intel path');
  assert.ok(SEARCH_PATHS.includes('/usr/bin'), 'missing Linux system path');
  assert.ok(SEARCH_PATHS.includes('/home/linuxbrew/.linuxbrew/bin'), 'missing Linuxbrew path');
  assert.ok(Array.isArray(SEARCH_PATHS));
});

// ─── Integration smoke test ───────────────────────────────────────────────────

test('real resolveBinary returns a non-empty string for any input', () => {
  clearBinCache();
  // We don't assert a specific path (varies by machine) — just that it's a string
  const result = resolveBinary('node');
  assert.equal(typeof result, 'string');
  assert.ok(result.length > 0);
});
