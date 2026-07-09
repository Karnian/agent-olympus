/**
 * Unit tests for scripts/lib/cli-version.mjs
 * Uses node:test — zero npm dependencies.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  probeCliVersion,
  compareSemver,
  meetsMinimum,
  _clearVersionCache,
} from '../lib/cli-version.mjs';

beforeEach(() => {
  _clearVersionCache();
});

function spawnResult(stdout, overrides = {}) {
  return {
    status: 0,
    stdout,
    stderr: '',
    ...overrides,
  };
}

test('probeCliVersion: parses codex-cli prefixed version', () => {
  const result = probeCliVersion('/fake/codex', {
    spawn: () => spawnResult('codex-cli 0.140.0\n'),
  });

  assert.deepEqual(result, { version: '0.140.0', raw: 'codex-cli 0.140.0\n' });
});

test('probeCliVersion: parses bare version', () => {
  const result = probeCliVersion('/fake/codex', {
    spawn: () => spawnResult('0.50.0\n'),
  });

  assert.deepEqual(result, { version: '0.50.0', raw: '0.50.0\n' });
});

test('probeCliVersion: parses v-prefixed version', () => {
  const result = probeCliVersion('/fake/codex', {
    spawn: () => spawnResult('v1.2.3\n'),
  });

  assert.deepEqual(result, { version: '1.2.3', raw: 'v1.2.3\n' });
});

test('probeCliVersion: garbage output returns null version with raw output', () => {
  const result = probeCliVersion('/fake/codex', {
    spawn: () => spawnResult('not a version\n'),
  });

  assert.deepEqual(result, { version: null, raw: 'not a version\n' });
});

test('probeCliVersion: empty output returns null version', () => {
  const result = probeCliVersion('/fake/codex', {
    spawn: () => spawnResult(''),
  });

  assert.deepEqual(result, { version: null, raw: '' });
});

test('probeCliVersion: spawn error returns null version', () => {
  const result = probeCliVersion('/fake/missing-codex', {
    spawn: () => {
      const error = new Error('spawn /fake/missing-codex ENOENT');
      error.code = 'ENOENT';
      return spawnResult('', { status: null, error });
    },
  });

  assert.equal(result.version, null);
  assert.match(result.raw, /ENOENT/);
});

test('probeCliVersion: timeout returns null version', () => {
  const result = probeCliVersion('/fake/slow-codex', {
    timeoutMs: 1,
    spawn: () => {
      const error = new Error('spawnSync /fake/slow-codex ETIMEDOUT');
      error.code = 'ETIMEDOUT';
      return spawnResult('', { status: null, signal: 'SIGTERM', error });
    },
  });

  assert.equal(result.version, null);
  assert.match(result.raw, /ETIMEDOUT/);
});

test('probeCliVersion: non-zero exit returns null even with parseable output', () => {
  const result = probeCliVersion('/fake/codex', {
    spawn: () => spawnResult('codex-cli 0.140.0\n', { status: 1, stderr: 'bad flag\n' }),
  });

  assert.deepEqual(result, { version: null, raw: 'codex-cli 0.140.0\nbad flag\n' });
});

test('compareSemver: orders numeric triplets', () => {
  assert.equal(compareSemver('0.140.0', '0.142.5'), -1);
  assert.equal(compareSemver('0.142.5', '0.142.5'), 0);
  assert.equal(compareSemver('0.143.0', '0.142.5'), 1);
  assert.equal(compareSemver('1.0.0', '0.999.999'), 1);
});

test('compareSemver: missing patch is treated as zero', () => {
  assert.equal(compareSemver('1.2', '1.2.0'), 0);
  assert.equal(compareSemver('1.2', '1.2.1'), -1);
  assert.equal(compareSemver('1.3', '1.2.9'), 1);
});

test('meetsMinimum: applies advisory thresholds and fails open for null', () => {
  assert.equal(meetsMinimum('0.140.0', '0.142.5'), false);
  assert.equal(meetsMinimum('0.142.5', '0.142.5'), true);
  assert.equal(meetsMinimum('0.143.0', '0.142.5'), true);
  assert.equal(meetsMinimum(null, '0.142.5'), true);
});

test('meetsMinimum: unparseable versions fail open', () => {
  assert.equal(meetsMinimum('garbage', '0.142.5'), true);
});

test('probeCliVersion: caches by binPath until cleared', () => {
  let calls = 0;
  const first = probeCliVersion('/fake/codex', {
    spawn: () => {
      calls += 1;
      return spawnResult('codex-cli 0.140.0\n');
    },
  });
  const second = probeCliVersion('/fake/codex', {
    spawn: () => {
      calls += 1;
      return spawnResult('codex-cli 0.999.0\n');
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(second, first);

  _clearVersionCache();
  const third = probeCliVersion('/fake/codex', {
    spawn: () => {
      calls += 1;
      return spawnResult('codex-cli 0.999.0\n');
    },
  });

  assert.equal(calls, 2);
  assert.equal(third.version, '0.999.0');
});
