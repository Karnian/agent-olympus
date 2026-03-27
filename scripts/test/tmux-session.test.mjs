/**
 * Unit tests for scripts/lib/tmux-session.mjs
 * Uses node:test — zero npm dependencies.
 *
 * Only tests pure functions that do not require a live tmux process:
 * sanitizeName, sanitizeForShellArg, sessionName.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeName,
  sanitizeForShellArg,
  sessionName,
} from '../lib/tmux-session.mjs';

// ---------------------------------------------------------------------------
// sanitizeName
// ---------------------------------------------------------------------------

test('sanitizeName: replaces spaces with hyphens', () => {
  assert.equal(sanitizeName('hello world'), 'hello-world');
});

test('sanitizeName: empty string returns empty string', () => {
  assert.equal(sanitizeName(''), '');
});

test('sanitizeName: allows alphanumeric, hyphens and underscores', () => {
  assert.equal(sanitizeName('my_worker-1'), 'my_worker-1');
});

test('sanitizeName: replaces special characters with hyphens', () => {
  assert.equal(sanitizeName('foo/bar@baz'), 'foo-bar-baz');
});

test('sanitizeName: truncates to 50 characters', () => {
  const long = 'a'.repeat(60);
  const result = sanitizeName(long);
  assert.equal(result.length, 50);
});

test('sanitizeName: coerces non-string to string', () => {
  const result = sanitizeName(42);
  assert.equal(result, '42');
});

// ---------------------------------------------------------------------------
// sanitizeForShellArg
// ---------------------------------------------------------------------------

test('sanitizeForShellArg: escapes double quotes', () => {
  assert.equal(sanitizeForShellArg('"hello"'), '\\"hello\\"');
});

test('sanitizeForShellArg: escapes backslashes first', () => {
  assert.equal(sanitizeForShellArg('a\\b'), 'a\\\\b');
});

test('sanitizeForShellArg: escapes dollar signs', () => {
  assert.equal(sanitizeForShellArg('$HOME'), '\\$HOME');
});

test('sanitizeForShellArg: escapes backticks', () => {
  assert.equal(sanitizeForShellArg('`cmd`'), '\\`cmd\\`');
});

test('sanitizeForShellArg: escapes exclamation marks', () => {
  assert.equal(sanitizeForShellArg('hello!'), 'hello\\!');
});

test('sanitizeForShellArg: plain text passes through unchanged', () => {
  assert.equal(sanitizeForShellArg('hello world'), 'hello world');
});

test('sanitizeForShellArg: empty string returns empty string', () => {
  assert.equal(sanitizeForShellArg(''), '');
});

test('sanitizeForShellArg: coerces non-string to string', () => {
  assert.equal(sanitizeForShellArg(123), '123');
});

// ---------------------------------------------------------------------------
// sessionName
// ---------------------------------------------------------------------------

test('sessionName: combines SESSION_PREFIX, teamName, and workerName', () => {
  assert.equal(sessionName('team', 'worker'), 'ao-team-team-worker');
});

test('sessionName: sanitizes team and worker names', () => {
  assert.equal(sessionName('my team', 'my worker'), 'ao-team-my-team-my-worker');
});

test('sessionName: handles special characters in both parts', () => {
  const result = sessionName('foo/bar', 'baz@qux');
  assert.equal(result, 'ao-team-foo-bar-baz-qux');
});
