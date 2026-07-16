/**
 * Unit tests for scripts/lib/tmux-session.mjs
 * Uses node:test — zero npm dependencies.
 *
 * Only tests pure functions that do not require a live tmux process:
 * sanitizeName, sanitizeForShellArg, sessionName.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  sanitizeName,
  sanitizeForShellArg,
  sessionName,
  buildResolvedPath,
  killTeamSessions,
  listTeamSessions,
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

function shortHash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

test('sessionName: combines SESSION_PREFIX, teamName, and workerName', () => {
  assert.equal(
    sessionName('team', 'worker'),
    `ao-team-team-${shortHash('team')}-worker-${shortHash('worker')}`,
  );
});

test('sessionName: sanitizes team and worker names', () => {
  assert.equal(
    sessionName('my team', 'my worker'),
    `ao-team-my-team-${shortHash('my team')}-my-worker-${shortHash('my worker')}`,
  );
});

test('sessionName: handles special characters in both parts', () => {
  const result = sessionName('foo/bar', 'baz@qux');
  assert.equal(
    result,
    `ao-team-foo-bar-${shortHash('foo/bar')}-baz-qux-${shortHash('baz@qux')}`,
  );
});

test('sessionName: original identity hashes prevent sanitize collisions', () => {
  assert.notEqual(sessionName('api.v1', 'worker'), sessionName('api-v1', 'worker'));
  assert.notEqual(sessionName('team', 'api.v1'), sessionName('team', 'api-v1'));
});

// ---------------------------------------------------------------------------
// Legacy/current session discovery
// ---------------------------------------------------------------------------

test('killTeamSessions: recognizes current and exact worker-aware legacy names', () => {
  const current = sessionName('alpha', 'worker');
  const legacy = 'ao-team-alpha-legacy-worker';
  const similar = sessionName('alphabet', 'worker');
  const extendedTeam = sessionName('alpha-worker', 'reviewer');
  const killed = [];
  const execFileSync = (bin, args) => {
    assert.equal(bin, '/fake/tmux');
    if (args[0] === 'list-sessions') {
      return `${current}\n${legacy}\n${similar}\n${extendedTeam}\nao-teams-alpha-worker\n`;
    }
    if (args[0] === 'kill-session') {
      killed.push(args[2]);
      return '';
    }
    throw new Error(`unexpected tmux argv: ${args.join(' ')}`);
  };

  assert.equal(killTeamSessions('alpha', {
    execFileSync,
    tmuxBinary: '/fake/tmux',
    workerNames: ['worker', 'legacy-worker'],
  }), 2);
  assert.deepEqual(killed.sort(), [current, legacy].sort());
});

test('killTeamSessions: worker names are required before any team-scoped matching', () => {
  const current = sessionName('alpha', 'worker');
  const legacy = 'ao-team-alpha-legacy-worker';
  const killed = [];
  const execFileSync = (_bin, args) => {
    if (args[0] === 'list-sessions') return `${current}\n${legacy}\n`;
    if (args[0] === 'kill-session') {
      killed.push(args[2]);
      return '';
    }
    throw new Error(`unexpected tmux argv: ${args.join(' ')}`);
  };

  assert.equal(killTeamSessions('alpha', { execFileSync, tmuxBinary: '/fake/tmux' }), 0);
  assert.deepEqual(killed, []);
});

test('listTeamSessions: returns current and exact legacy sessions without cross-team prefix matches', () => {
  const current = sessionName('alpha', 'worker');
  const legacy = 'ao-team-alpha-legacy-worker';
  const similar = sessionName('alphabet', 'worker');
  const extendedTeam = sessionName('alpha-worker', 'reviewer');
  const execFileSync = (_bin, args) => {
    assert.equal(args[0], 'list-sessions');
    return `${current}:100\n${legacy}:200\n${similar}:300\n${extendedTeam}:400\nao-teams-alpha-worker:500\n`;
  };

  assert.deepEqual(
    listTeamSessions('alpha', {
      execFileSync,
      tmuxBinary: '/fake/tmux',
      workerNames: ['worker', 'legacy-worker'],
    }),
    [
      { name: current, createdAt: 100000 },
      { name: legacy, createdAt: 200000 },
    ],
  );
});

test('listTeamSessions: returns no team-scoped sessions without worker identities', () => {
  const current = sessionName('alpha', 'worker');
  const legacy = 'ao-team-alpha-legacy-worker';
  const execFileSync = () => `${current}:100\n${legacy}:200\n`;

  assert.deepEqual(
    listTeamSessions('alpha', { execFileSync, tmuxBinary: '/fake/tmux' }),
    [],
  );
});

test('team-scoped matching does not claim a hash-shaped legacy session from another team', () => {
  const current = sessionName('alpha', 'worker');
  const teamHash = current.match(/^ao-team-alpha-([0-9a-f]{12})-/)?.[1];
  assert.ok(teamHash);

  // This is the legacy name for team `alpha-${teamHash}`, worker `victim`.
  // It shares alpha's former current prefix but is not alpha's session.
  const collidingLegacy = `ao-team-alpha-${teamHash}-victim`;
  const killed = [];
  const execFileSync = (_bin, args) => {
    if (args[0] === 'list-sessions') return `${current}\n${collidingLegacy}\n`;
    if (args[0] === 'kill-session') {
      killed.push(args[2]);
      return '';
    }
    throw new Error(`unexpected tmux argv: ${args.join(' ')}`);
  };

  assert.equal(killTeamSessions('alpha', {
    execFileSync,
    tmuxBinary: '/fake/tmux',
    workerNames: ['worker'],
  }), 1);
  assert.deepEqual(killed, [current]);

  const listExec = (_bin, args) => {
    assert.equal(args[0], 'list-sessions');
    return `${current}:100\n${collidingLegacy}:200\n`;
  };
  assert.deepEqual(listTeamSessions('alpha', {
    execFileSync: listExec,
    tmuxBinary: '/fake/tmux',
    workerNames: ['worker'],
  }), [{ name: current, createdAt: 100000 }]);
});

test('listTeamSessions: unscoped listing requires the SESSION_PREFIX delimiter', () => {
  const execFileSync = () => 'ao-team-alpha-worker:100\nao-teams-alpha-worker:200\n';
  assert.deepEqual(
    listTeamSessions(undefined, { execFileSync, tmuxBinary: '/fake/tmux' }),
    [{ name: 'ao-team-alpha-worker', createdAt: 100000 }],
  );
});

// ---------------------------------------------------------------------------
// buildResolvedPath
// ---------------------------------------------------------------------------

test('buildResolvedPath: returns a non-empty colon-separated string', () => {
  const result = buildResolvedPath();
  assert.ok(typeof result === 'string');
  assert.ok(result.length > 0);
  assert.ok(result.includes(':'), 'should contain colon separators');
});

test('buildResolvedPath: includes current process PATH entries', () => {
  const result = buildResolvedPath();
  // At minimum, /usr/bin should be present on any system
  assert.ok(result.includes('/usr/bin'), 'should include /usr/bin from system PATH');
});

test('buildResolvedPath: deduplicates entries', () => {
  const result = buildResolvedPath();
  const parts = result.split(':');
  const unique = new Set(parts);
  assert.equal(parts.length, unique.size, 'should not have duplicate path entries');
});
