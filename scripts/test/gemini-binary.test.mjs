/**
 * Unit tests for scripts/lib/gemini-binary.mjs
 * Uses injected resolvers only; never spawns real binaries.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { _createGeminiResolver, resolveGeminiBinary } from '../lib/gemini-binary.mjs';

test('resolveGeminiBinary export is callable', () => {
  assert.equal(typeof resolveGeminiBinary, 'function');
});

test('prefers gemini when resolver returns a real path', () => {
  const calls = [];
  const resolve = (name) => {
    calls.push(name);
    return name === 'gemini' ? '/opt/homebrew/bin/gemini' : '/opt/homebrew/bin/agy';
  };

  const result = _createGeminiResolver({ resolve, env: {} })();

  assert.deepEqual(result, {
    path: '/opt/homebrew/bin/gemini',
    flavor: 'gemini',
    resolved: true,
    attempted: ['gemini'],
  });
  assert.deepEqual(calls, ['gemini']);
});

test('treats bare gemini resolver fallback as miss, then falls back to agy hit', () => {
  const calls = [];
  const resolve = (name) => {
    calls.push(name);
    return name === 'gemini' ? 'gemini' : '/usr/local/bin/agy';
  };

  const result = _createGeminiResolver({ resolve, env: {} })();

  assert.deepEqual(result, {
    path: '/usr/local/bin/agy',
    flavor: 'agy',
    resolved: true,
    attempted: ['gemini', 'agy'],
  });
  assert.deepEqual(calls, ['gemini', 'agy']);
});

test('AO_GEMINI_BINARY override uses verbatim path and labels gemini basename', () => {
  const resolve = () => { throw new Error('must not call resolver'); };

  const result = _createGeminiResolver({
    resolve,
    env: { AO_GEMINI_BINARY: '/custom/bin/gemini' },
  })();

  assert.deepEqual(result, {
    path: '/custom/bin/gemini',
    flavor: 'gemini',
    resolved: true,
    attempted: [],
  });
});

test('AO_GEMINI_BINARY override labels agy basename', () => {
  const result = _createGeminiResolver({
    resolve: () => 'gemini',
    env: { AO_GEMINI_BINARY: '/custom/bin/agy' },
  })();

  assert.equal(result.path, '/custom/bin/agy');
  assert.equal(result.flavor, 'agy');
  assert.equal(result.resolved, true);
  assert.deepEqual(result.attempted, []);
});

test('AO_GEMINI_BINARY override labels non-standard basename as custom', () => {
  const result = _createGeminiResolver({
    resolve: () => 'gemini',
    env: { AO_GEMINI_BINARY: '/custom/bin/gemini-compatible' },
  })();

  assert.equal(result.path, '/custom/bin/gemini-compatible');
  assert.equal(result.flavor, 'custom');
  assert.equal(result.resolved, true);
  assert.deepEqual(result.attempted, []);
});

test('both missing returns unresolved gemini fallback and attempted list', () => {
  const result = _createGeminiResolver({
    resolve: (name) => name,
    env: {},
  })();

  assert.deepEqual(result, {
    path: 'gemini',
    flavor: 'gemini',
    resolved: false,
    attempted: ['gemini', 'agy'],
  });
});

test('resolver never throws when injected resolver throws', () => {
  const result = _createGeminiResolver({
    resolve: () => { throw new Error('lookup failed'); },
    env: {},
  })();

  assert.deepEqual(result, {
    path: 'gemini',
    flavor: 'gemini',
    resolved: false,
    attempted: ['gemini', 'agy'],
  });
});
