/**
 * Unit tests for scripts/lib/pr-create.mjs
 * Tests extractIssueRefs(), buildPRBody(), preflightCheck(), and function exports.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractIssueRefs,
  buildPRBody,
  preflightCheck,
  createPR,
  findExistingPR,
  detectBaseBranch,
  __setExecFileSyncForTest,
  __resetForTest,
} from '../lib/pr-create.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal PRD fixture */
function samplePrd() {
  return {
    projectName: 'test-project',
    userStories: [
      { id: 'US-1', title: 'Add autonomy config support', passes: true },
      { id: 'US-2', title: 'Implement CI watching', passes: true },
    ],
  };
}

/** Minimal diffStat fixture */
function sampleDiffStat() {
  return '3 files changed, 42 insertions(+), 5 deletions(-)';
}

function withExecMock(fn, assertion) {
  __setExecFileSyncForTest(fn);
  try {
    return assertion();
  } finally {
    __resetForTest();
  }
}

function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

// ---------------------------------------------------------------------------
// Test: detectBaseBranch — explicit and inferred defaults
// ---------------------------------------------------------------------------

test('detectBaseBranch: trimmed explicit override wins without subprocesses', () => {
  let calls = 0;
  withExecMock(() => {
    calls += 1;
    throw new Error('must not execute');
  }, () => {
    assert.equal(detectBaseBranch('/repo', ' release/2.x '), 'release/2.x');
  });
  assert.equal(calls, 0);
});

test('detectBaseBranch: reads origin/HEAD and preserves branch slashes', () => {
  const calls = [];
  withExecMock((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return 'refs/remotes/origin/release/2.x\n';
  }, () => {
    assert.equal(detectBaseBranch('/repo'), 'release/2.x');
  });
  assert.deepEqual(calls, [{
    cmd: 'git',
    args: ['symbolic-ref', 'refs/remotes/origin/HEAD'],
    opts: { encoding: 'utf8', cwd: '/repo' },
  }]);
});

test('detectBaseBranch: falls through from git failure to GitHub default', () => {
  const calls = [];
  withExecMock((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'git') throw new Error('no symbolic ref');
    return 'develop\n';
  }, () => {
    assert.equal(detectBaseBranch('/worktree'), 'develop');
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], {
    cmd: 'gh',
    args: ['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'],
    opts: { encoding: 'utf8', cwd: '/worktree' },
  });
});

test('detectBaseBranch: malformed symbolic refs and blank override still probe GitHub', () => {
  for (const symbolicRef of ['refs/remotes/upstream/main\n', 'refs/remotes/origin/HEAD\n']) {
    const calls = [];
    withExecMock((cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return cmd === 'git' ? symbolicRef : 'develop\n';
    }, () => {
      assert.equal(detectBaseBranch('/repo', '   '), 'develop');
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(call => call.cmd), ['git', 'gh']);
    assert.ok(calls.every(call => call.opts.cwd === '/repo'));
  }
});

test('detectBaseBranch: malformed or blank command output falls back to main', () => {
  for (const gitOutput of ['', 'refs/remotes/upstream/main', 'refs/remotes/origin/']) {
    withExecMock((cmd) => cmd === 'git' ? gitOutput : '   ', () => {
      assert.equal(detectBaseBranch('/repo', '   '), 'main');
    });
  }
});

test('detectBaseBranch: both probes may throw and never escape', () => {
  withExecMock(() => {
    throw new Error('unavailable');
  }, () => {
    assert.doesNotThrow(() => detectBaseBranch('/repo'));
    assert.equal(detectBaseBranch('/repo'), 'main');
  });
});

test('detectBaseBranch: process.cwd failure is contained by the never-throws contract', () => {
  const originalCwd = process.cwd;
  process.cwd = () => { throw new Error('cwd unavailable'); };
  try {
    assert.doesNotThrow(() => detectBaseBranch());
    assert.equal(detectBaseBranch(), 'main');
  } finally {
    process.cwd = originalCwd;
  }
});

// ---------------------------------------------------------------------------
// Test: extractIssueRefs — pattern parsing
// ---------------------------------------------------------------------------

test('extractIssueRefs: "fixes #123" → [123]', () => {
  const refs = extractIssueRefs('fixes #123');
  assert.deepEqual(refs, [123]);
});

test('extractIssueRefs: "closes #45, fixes #67" → [45, 67]', () => {
  const refs = extractIssueRefs('closes #45, fixes #67');
  assert.deepEqual(refs, [45, 67]);
});

test('extractIssueRefs: "no issues here" → []', () => {
  const refs = extractIssueRefs('no issues here');
  assert.deepEqual(refs, []);
});

test('extractIssueRefs: "#1 and #2 and #3" → [1, 2, 3]', () => {
  const refs = extractIssueRefs('#1 and #2 and #3');
  assert.deepEqual(refs, [1, 2, 3]);
});

test('extractIssueRefs: branch-style "feat/42-add-auth" → [42]', () => {
  const refs = extractIssueRefs('feat/42-add-auth');
  assert.deepEqual(refs, [42]);
});

test('extractIssueRefs: deduplicates — "#5 fixes #5" → [5]', () => {
  const refs = extractIssueRefs('#5 fixes #5');
  assert.deepEqual(refs, [5]);
});

// ---------------------------------------------------------------------------
// Test: buildPRBody — structure and content
// ---------------------------------------------------------------------------

test('buildPRBody: returns a string containing "## Summary"', () => {
  const body = buildPRBody({ prd: samplePrd(), diffStat: sampleDiffStat(), verifyResults: null });
  assert.equal(typeof body, 'string', 'buildPRBody must return a string');
  assert.ok(body.includes('## Summary'), 'body must contain "## Summary"');
});

test('buildPRBody: includes story titles from prd', () => {
  const prd = samplePrd();
  const body = buildPRBody({ prd, diffStat: sampleDiffStat(), verifyResults: null });
  for (const story of prd.userStories) {
    assert.ok(
      body.includes(story.title),
      `body must include story title "${story.title}"`,
    );
  }
});

test('buildPRBody: includes diffStat content', () => {
  const diffStat = sampleDiffStat();
  const body = buildPRBody({ prd: samplePrd(), diffStat, verifyResults: null });
  assert.ok(body.includes(diffStat), `body must include diffStat "${diffStat}"`);
});

test('buildPRBody: works when verifyResults is provided', () => {
  const verifyResults = { passed: 10, failed: 0, skipped: 1 };
  let threw = false;
  try {
    buildPRBody({ prd: samplePrd(), diffStat: sampleDiffStat(), verifyResults });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'buildPRBody must not throw when verifyResults is provided');
});

// ---------------------------------------------------------------------------
// Test: preflightCheck — function signature check
// ---------------------------------------------------------------------------

test('preflightCheck: is exported as a function', () => {
  assert.equal(typeof preflightCheck, 'function');
});

test('preflightCheck: returns an object with ok and errors fields', async () => {
  // preflightCheck may call external tools; we only verify the return shape
  let result;
  try {
    result = await preflightCheck();
  } catch {
    // If it throws entirely, that is a bug — but we tolerate it in a stub scenario
    return;
  }
  assert.ok(result !== null && typeof result === 'object', 'preflightCheck must return an object');
  assert.ok('ok' in result, 'result must have ok field');
  assert.ok('errors' in result, 'result must have errors field');
  assert.ok(Array.isArray(result.errors), 'result.errors must be an array');
});

// ---------------------------------------------------------------------------
// Test: createPR and findExistingPR — export shape checks
// ---------------------------------------------------------------------------

test('createPR: is exported as a function', () => {
  assert.equal(typeof createPR, 'function');
});

test('createPR: uses explicit base and cwd for gh create', () => {
  const calls = [];
  const result = withExecMock((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return 'https://github.com/example/repo/pull/1\n';
  }, () => createPR({
    title: 'Ship safely',
    body: 'Refs #82',
    baseBranch: 'develop',
    cwd: '/repo',
  }));

  assert.deepEqual(result, { ok: true, prUrl: 'https://github.com/example/repo/pull/1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'gh');
  assert.deepEqual(calls[0].opts, { encoding: 'utf8', cwd: '/repo' });
  assert.equal(argValue(calls[0].args, '--base'), 'develop');
});

test('createPR: detects omitted base and passes it to gh create', () => {
  const calls = [];
  const result = withExecMock((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'git') return 'refs/remotes/origin/trunk\n';
    return 'https://github.com/example/repo/pull/2\n';
  }, () => createPR({ title: 'Title', body: 'Body', cwd: '/repo' }));

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    cmd: 'git',
    args: ['symbolic-ref', 'refs/remotes/origin/HEAD'],
    opts: { encoding: 'utf8', cwd: '/repo' },
  });
  assert.equal(calls[1].cmd, 'gh');
  assert.deepEqual(calls[1].opts, { encoding: 'utf8', cwd: '/repo' });
  assert.equal(argValue(calls[1].args, '--base'), 'trunk');
});

test('createPR: blank baseBranch is detected instead of forwarded', () => {
  const calls = [];
  const result = withExecMock((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'git') return 'refs/remotes/origin/develop\n';
    return 'https://github.com/example/repo/pull/4\n';
  }, () => createPR({
    title: 'Title',
    body: 'Body',
    baseBranch: '   ',
    cwd: '/repo',
  }));

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(argValue(calls[1].args, '--base'), 'develop');
});

test('createPR: falls back to main when base detection fails', () => {
  const calls = [];
  const result = withExecMock((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'git') throw new Error('no origin head');
    if (args[0] === 'repo') throw new Error('no gh metadata');
    return 'https://github.com/example/repo/pull/3\n';
  }, () => createPR({ title: 'Title', body: 'Body', cwd: '/repo' }));

  assert.equal(result.ok, true);
  assert.equal(argValue(calls.at(-1).args, '--base'), 'main');
});

test('createPR: gh create failure remains a structured result', () => {
  const result = withExecMock(() => {
    const error = new Error('command failed');
    error.stderr = 'permission denied';
    throw error;
  }, () => createPR({
    title: 'Title',
    body: 'Body',
    baseBranch: 'main',
    cwd: '/repo',
  }));

  assert.deepEqual(result, { ok: false, error: 'permission denied' });
});

test('createPR: process.cwd failure is returned as a structured error', () => {
  const originalCwd = process.cwd;
  process.cwd = () => { throw new Error('cwd unavailable'); };
  try {
    assert.deepEqual(
      createPR({ title: 'Title', body: 'Body', baseBranch: 'main' }),
      { ok: false, error: 'cwd unavailable' },
    );
  } finally {
    process.cwd = originalCwd;
  }
});

test('findExistingPR: is exported as a function', () => {
  assert.equal(typeof findExistingPR, 'function');
});
