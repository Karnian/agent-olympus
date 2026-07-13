/**
 * Unit tests for scripts/lib/ci-watch.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  watchCI,
  getFailedLogs,
  __setExecFileSyncForTest,
  __resetForTest,
} from '../lib/ci-watch.mjs';

const CWD = '/worktree';
const REPOSITORY = 'github.com/example/repo';
const HEAD_SHA = 'a'.repeat(40);
const OLD_SHA = 'b'.repeat(40);

function withExecMock(fn, assertion) {
  __setExecFileSyncForTest(fn);
  return Promise.resolve()
    .then(assertion)
    .finally(__resetForTest);
}

function completedRun(headSha, conclusion = 'success', databaseId = 123) {
  return JSON.stringify([{
    databaseId,
    status: 'completed',
    conclusion,
    headSha,
  }]);
}

function watchOptions(overrides = {}) {
  return {
    cwd: CWD,
    repository: REPOSITORY,
    branch: 'feature/ship-safety',
    expectedHeadSha: HEAD_SHA,
    maxCycles: 1,
    pollIntervalMs: 0,
    ...overrides,
  };
}

test('ci-watch: public functions are exported', () => {
  assert.equal(typeof watchCI, 'function');
  assert.equal(typeof getFailedLogs, 'function');
});

test('watchCI: maxCycles=0 skips only after validating pinned inputs', async () => {
  await withExecMock(() => {
    throw new Error('must not execute');
  }, async () => {
    assert.deepEqual(
      await watchCI(watchOptions({ maxCycles: 0 })),
      { status: 'skipped' },
    );
  });
});

test('watchCI: missing or unsafe identity inputs fail closed without invoking gh', async () => {
  const invalidOverrides = [
    { cwd: undefined },
    { cwd: 'relative/path' },
    { repository: 'example/repo' },
    { repository: 'github.com/example/repo/extra' },
    { branch: '--repo' },
    { branch: 'bad branch' },
    { expectedHeadSha: 'abc123' },
    { maxCycles: -1 },
    { pollIntervalMs: -1 },
  ];
  let calls = 0;
  await withExecMock(() => {
    calls += 1;
    return '[]';
  }, async () => {
    for (const override of invalidOverrides) {
      assert.deepEqual(
        await watchCI(watchOptions(override)),
        { status: 'failed', conclusion: 'invalid-input' },
      );
    }
  });
  assert.equal(calls, 0);
});

test('watchCI: passes cwd, pinned repository, branch, and exact commit to gh', async () => {
  const calls = [];
  const result = await withExecMock((cmd, args, options) => {
    calls.push({ cmd, args, options });
    return completedRun(HEAD_SHA);
  }, () => watchCI(watchOptions()));

  assert.deepEqual(result, {
    status: 'passed',
    runId: '123',
    conclusion: 'success',
  });
  assert.deepEqual(calls, [{
    cmd: 'gh',
    args: [
      'run', 'list',
      '--repo', REPOSITORY,
      '--branch', 'feature/ship-safety',
      '--commit', HEAD_SHA,
      '--json', 'databaseId,status,conclusion,headSha',
      '--limit', '1000',
    ],
    options: { encoding: 'utf8', timeout: 30_000, cwd: CWD },
  }]);
});

test('watchCI: ignores a successful run from an older branch HEAD', async () => {
  const responses = [
    completedRun(OLD_SHA),
    JSON.stringify([{
      databaseId: 456,
      status: 'in_progress',
      conclusion: '',
      headSha: HEAD_SHA,
    }]),
    completedRun(HEAD_SHA, 'success', 456),
  ];
  let calls = 0;
  const result = await withExecMock(() => responses[calls++], () => (
    watchCI(watchOptions({ maxCycles: 3 }))
  ));

  assert.equal(calls, 3, 'must poll until the expected HEAD run completes');
  assert.deepEqual(result, {
    status: 'passed',
    runId: '456',
    conclusion: 'success',
  });
});

test('watchCI: times out when no run for expectedHeadSha appears', async () => {
  let calls = 0;
  const result = await withExecMock(() => {
    calls += 1;
    return completedRun(OLD_SHA);
  }, () => watchCI(watchOptions({ maxCycles: 2 })));

  assert.equal(calls, 2);
  assert.deepEqual(result, { status: 'timeout' });
});

test('watchCI: reports a matching failed run and accepts a GHES port', async () => {
  const result = await withExecMock(() => completedRun(HEAD_SHA, 'failure', '987'), () => (
    watchCI(watchOptions({ repository: 'github.example.com:8443/acme/widget' }))
  ));
  assert.deepEqual(result, {
    status: 'failed',
    runId: '987',
    conclusion: 'failure',
  });
});

test('watchCI: reports a matching skipped run without triggering a failure fixer', async () => {
  const result = await withExecMock(() => completedRun(HEAD_SHA, 'skipped', '988'), () => (
    watchCI(watchOptions())
  ));
  assert.deepEqual(result, {
    status: 'skipped',
    runId: '988',
    conclusion: 'skipped',
  });
});

test('watchCI: never passes while another workflow for the same SHA is pending', async () => {
  const pending = JSON.stringify([
    JSON.parse(completedRun(HEAD_SHA, 'success', 100))[0],
    { databaseId: 101, status: 'in_progress', conclusion: '', headSha: HEAD_SHA },
  ]);
  const result = await withExecMock(() => pending, () => watchCI(watchOptions()));
  assert.deepEqual(result, { status: 'timeout' });
});

test('watchCI: any failed workflow for the same SHA defeats a successful one', async () => {
  const mixed = JSON.stringify([
    JSON.parse(completedRun(HEAD_SHA, 'success', 100))[0],
    JSON.parse(completedRun(HEAD_SHA, 'failure', 101))[0],
  ]);
  const result = await withExecMock(() => mixed, () => watchCI(watchOptions()));
  assert.deepEqual(result, {
    status: 'failed',
    runId: '101',
    conclusion: 'failure',
  });
});

test('watchCI: malformed or incomplete gh output cannot pass CI', async () => {
  for (const output of [
    'not-json',
    '{}',
    '[]',
    JSON.stringify([{ databaseId: 0, status: 'completed', conclusion: 'success', headSha: HEAD_SHA }]),
    JSON.stringify([{ databaseId: 1, status: 'completed', conclusion: '', headSha: HEAD_SHA }]),
  ]) {
    const result = await withExecMock(() => output, () => watchCI(watchOptions()));
    assert.deepEqual(result, { status: 'timeout' });
  }
});

test('watchCI: explicit --repo is immune to ambient GH_REPO contamination', async () => {
  const previous = process.env.GH_REPO;
  process.env.GH_REPO = 'attacker/redirected';
  try {
    await withExecMock((_cmd, args) => {
      const repoIndex = args.indexOf('--repo');
      assert.notEqual(repoIndex, -1);
      assert.equal(args[repoIndex + 1], REPOSITORY);
      assert.equal(args.includes(process.env.GH_REPO), false);
      return completedRun(HEAD_SHA);
    }, async () => {
      assert.equal((await watchCI(watchOptions())).status, 'passed');
    });
  } finally {
    if (previous === undefined) delete process.env.GH_REPO;
    else process.env.GH_REPO = previous;
  }
});

test('getFailedLogs: uses explicit cwd and pinned repository for gh', async () => {
  const calls = [];
  const result = await withExecMock((cmd, args, options) => {
    calls.push({ cmd, args, options });
    return 'failed step output\n';
  }, () => getFailedLogs({ cwd: CWD, repository: REPOSITORY, runId: '456' }));

  assert.equal(result, 'failed step output');
  assert.deepEqual(calls, [{
    cmd: 'gh',
    args: ['run', 'view', '456', '--repo', REPOSITORY, '--log-failed'],
    options: { encoding: 'utf8', timeout: 30_000, cwd: CWD },
  }]);
});

test('getFailedLogs: invalid input fails closed without invoking gh', async () => {
  const invalid = [
    undefined,
    { cwd: CWD, repository: REPOSITORY, runId: '' },
    { cwd: CWD, repository: REPOSITORY, runId: '1; rm -rf /' },
    { cwd: 'relative', repository: REPOSITORY, runId: '1' },
    { cwd: CWD, repository: 'example/repo', runId: '1' },
  ];
  let calls = 0;
  await withExecMock(() => {
    calls += 1;
    return 'unexpected';
  }, () => {
    for (const input of invalid) assert.equal(getFailedLogs(input), '');
  });
  assert.equal(calls, 0);
});

test('getFailedLogs: gh failure returns an empty string', async () => {
  const result = await withExecMock(() => {
    throw new Error('gh unavailable');
  }, () => getFailedLogs({ cwd: CWD, repository: REPOSITORY, runId: '123' }));
  assert.equal(result, '');
});
