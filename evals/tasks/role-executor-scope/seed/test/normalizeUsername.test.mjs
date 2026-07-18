import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeUsername } from '../src/normalizeUsername.mjs';

test('lowercases a username and replaces a space', () => {
  assert.equal(normalizeUsername('Ada Lovelace'), 'ada-lovelace');
});

test('trims and collapses repeated whitespace', () => {
  assert.equal(normalizeUsername('  Grace   Hopper  '), 'grace-hopper');
});

test('rejects non-string values', () => {
  assert.throws(() => normalizeUsername(null), TypeError);
});
