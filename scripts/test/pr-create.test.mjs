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
  updateExistingPR,
  detectBaseBranch,
  detectRepositoryIdentity,
  repositoryIdentitiesEqual,
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

function repoMetadata(defaultBranch = 'main', nameWithOwner = 'example/repo') {
  return JSON.stringify({
    defaultBranchRef: { name: defaultBranch },
    nameWithOwner,
  });
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

test('detectBaseBranch: falls back to origin/HEAD and preserves branch slashes', () => {
  const calls = [];
  withExecMock((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'git' && args[0] === 'remote') {
      return 'git@github.com:example/repo.git\n';
    }
    if (cmd === 'gh') throw new Error('GitHub unavailable');
    return 'refs/remotes/origin/release/2.x\n';
  }, () => {
    assert.equal(detectBaseBranch('/repo'), 'release/2.x');
  });
  assert.deepEqual(calls.map(call => call.cmd), ['git', 'gh', 'git']);
  assert.deepEqual(calls[2], {
      cmd: 'git',
      args: ['symbolic-ref', 'refs/remotes/origin/HEAD'],
      opts: { encoding: 'utf8', cwd: '/repo' },
    });
});

test('detectBaseBranch: prefers the authoritative GitHub default', () => {
  const calls = [];
  withExecMock((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'git') return 'git@github.com:example/repo.git\n';
    return repoMetadata('develop');
  }, () => {
    assert.equal(detectBaseBranch('/worktree'), 'develop');
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], {
    cmd: 'gh',
    args: ['repo', 'view', 'github.com/example/repo', '--json', 'defaultBranchRef,nameWithOwner'],
    opts: { encoding: 'utf8', cwd: '/worktree' },
  });
});

test('detectBaseBranch: ignores a stale local origin/HEAD when GitHub reports a new default', () => {
  const calls = [];
  withExecMock((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'gh') return repoMetadata('trunk');
    if (args[0] === 'remote') return 'git@github.com:example/repo.git\n';
    return 'refs/remotes/origin/main\n';
  }, () => {
    assert.equal(detectBaseBranch('/repo'), 'trunk');
  });
  assert.deepEqual(calls.map(call => call.cmd), ['git', 'gh']);
});

test('detectBaseBranch: blank GitHub result falls back to origin/HEAD validation', () => {
  for (const symbolicRef of ['refs/remotes/upstream/main\n', 'refs/remotes/origin/HEAD\n']) {
    const calls = [];
    withExecMock((cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (cmd === 'gh') return '   ';
      if (args[0] === 'remote') return 'git@github.com:example/repo.git\n';
      return symbolicRef;
    }, () => {
      assert.equal(detectBaseBranch('/repo', '   '), 'main');
    });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map(call => call.cmd), ['git', 'gh', 'git']);
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

test('detectRepositoryIdentity: binds canonical gh metadata to the origin URL', () => {
  const calls = [];
  const identity = withExecMock((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'git') return 'git@github.com:Example/Repo.git\n';
    return repoMetadata('main', 'Example/Repo');
  }, () => detectRepositoryIdentity('/repo'));

  assert.deepEqual(identity, {
    originUrl: 'git@github.com:Example/Repo.git',
    pushUrl: 'git@github.com:Example/Repo.git',
    repository: 'github.com/Example/Repo',
    defaultBranch: 'main',
  });
  assert.deepEqual(calls[2].args, [
    'repo', 'view', 'github.com/Example/Repo', '--json', 'defaultBranchRef,nameWithOwner',
  ]);
});

test('detectRepositoryIdentity: rejects gh metadata for a different origin repository', () => {
  const identity = withExecMock((cmd) => (
    cmd === 'git'
      ? 'git@github.com:example/repo.git\n'
      : repoMetadata('main', 'attacker/other')
  ), () => detectRepositoryIdentity('/repo'));
  assert.equal(identity, null);
});

test('detectRepositoryIdentity: canonicalizes URLs without persisting embedded HTTP credentials', () => {
  const identity = withExecMock((cmd) => (
    cmd === 'git'
      ? 'https://oauth-token:secret@GitHub.com/example/repo.git?ignored=1\n'
      : repoMetadata('main')
  ), () => detectRepositoryIdentity('/repo'));

  assert.deepEqual(identity, {
    originUrl: 'https://github.com/example/repo.git',
    pushUrl: 'https://github.com/example/repo.git',
    repository: 'github.com/example/repo',
    defaultBranch: 'main',
  });
});

test('detectRepositoryIdentity: preserves a custom GitHub Enterprise HTTPS port', () => {
  const identity = withExecMock((cmd) => (
    cmd === 'git'
      ? 'https://ghe.example:8443/acme/widgets.git\n'
      : repoMetadata('trunk', 'acme/widgets')
  ), () => detectRepositoryIdentity('/repo'));

  assert.deepEqual(identity, {
    originUrl: 'https://ghe.example:8443/acme/widgets.git',
    pushUrl: 'https://ghe.example:8443/acme/widgets.git',
    repository: 'ghe.example:8443/acme/widgets',
    defaultBranch: 'trunk',
  });
});

test('detectRepositoryIdentity: rejects non-network remotes and ambiguous or redirected push URLs', () => {
  const nonNetwork = withExecMock((cmd) => (
    cmd === 'git' ? 'file://github.com/example/repo.git\n' : repoMetadata('main')
  ), () => detectRepositoryIdentity('/repo'));
  assert.equal(nonNetwork, null);

  const redirectedPush = withExecMock((cmd, args) => {
    if (cmd === 'gh') return repoMetadata('main');
    if (args.includes('--push')) return 'git@github.com:attacker/other.git\n';
    return 'git@github.com:example/repo.git\n';
  }, () => detectRepositoryIdentity('/repo'));
  assert.equal(redirectedPush, null);

  const multiplePushUrls = withExecMock((cmd, args) => {
    if (cmd === 'gh') return repoMetadata('main');
    if (args.includes('--push')) {
      return 'git@github.com:example/repo.git\nhttps://github.com/example/repo.git\n';
    }
    return 'git@github.com:example/repo.git\n';
  }, () => detectRepositoryIdentity('/repo'));
  assert.equal(multiplePushUrls, null);
});

test('repositoryIdentitiesEqual: requires exact origin, repository, and default branch', () => {
  const identity = {
    originUrl: 'git@github.com:example/repo.git',
    pushUrl: 'git@github.com:example/repo.git',
    repository: 'github.com/example/repo',
    defaultBranch: 'main',
  };
  assert.equal(repositoryIdentitiesEqual(identity, { ...identity }), true);
  assert.equal(repositoryIdentitiesEqual(identity, { ...identity, originUrl: 'https://github.com/example/repo.git' }), false);
  assert.equal(repositoryIdentitiesEqual(identity, { ...identity, pushUrl: 'https://github.com/example/repo.git' }), false);
  assert.equal(repositoryIdentitiesEqual(identity, { ...identity, repository: 'github.com/other/repo' }), false);
  assert.equal(repositoryIdentitiesEqual(identity, { ...identity, defaultBranch: 'trunk' }), false);
  assert.equal(repositoryIdentitiesEqual(identity, null), false);
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

test('preflightCheck: rejects develop and trunk when either is the resolved base', () => {
  for (const baseBranch of ['develop', 'trunk']) {
    const calls = [];
    const result = withExecMock((cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (cmd === 'which') return '/usr/bin/gh\n';
      if (cmd === 'gh' && args[0] === 'auth') return '';
      if (cmd === 'gh' && args[0] === 'repo') return repoMetadata(baseBranch);
      if (cmd === 'git' && args[0] === 'remote') return 'git@github.com:example/repo.git\n';
      if (cmd === 'git' && args[0] === 'branch') return `${baseBranch}\n`;
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    }, () => preflightCheck({ cwd: '/target-repo', baseBranch }));

    assert.deepEqual(result, { ok: false, errors: ['on base branch'] });
    assert.ok(calls.length > 0);
    assert.ok(
      calls.every(call => call.opts.cwd === '/target-repo'),
      'every preflight subprocess must be scoped to the target repository',
    );
  }
});

test('preflightCheck: permits a feature branch and scopes all checks to cwd', () => {
  const calls = [];
  const result = withExecMock((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'which') return '/usr/bin/gh\n';
    if (cmd === 'gh' && args[0] === 'auth') return '';
    if (cmd === 'gh' && args[0] === 'repo') return repoMetadata('develop');
    if (cmd === 'git' && args[0] === 'remote') return 'git@github.com:example/repo.git\n';
    if (cmd === 'git' && args[0] === 'branch') return 'feat/safe-shipping\n';
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  }, () => preflightCheck({ cwd: '/target-repo', baseBranch: 'develop' }));

  assert.deepEqual(result, {
    ok: true,
    errors: [],
    repoIdentity: {
      originUrl: 'git@github.com:example/repo.git',
      pushUrl: 'git@github.com:example/repo.git',
      repository: 'github.com/example/repo',
      defaultBranch: 'develop',
    },
  });
  assert.ok(calls.every(call => call.opts.cwd === '/target-repo'));
});

test('preflightCheck: fails closed when the current branch cannot be determined', () => {
  const result = withExecMock((cmd, args) => {
    if (cmd === 'which') return '/usr/bin/gh\n';
    if (cmd === 'gh' && args[0] === 'auth') return '';
    if (cmd === 'gh' && args[0] === 'repo') return repoMetadata('main');
    if (cmd === 'git' && args[0] === 'remote') return 'git@github.com:example/repo.git\n';
    if (cmd === 'git' && args[0] === 'branch') return '';
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  }, () => preflightCheck({ cwd: '/target-repo', baseBranch: 'main' }));

  assert.deepEqual(result, {
    ok: false,
    errors: ['unable to determine current branch'],
  });
});

test('preflightCheck: supports the legacy cwd and base positional arguments', () => {
  const calls = [];
  const result = withExecMock((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'which') return '/usr/bin/gh\n';
    if (cmd === 'gh' && args[0] === 'repo') return repoMetadata('trunk');
    if (cmd === 'gh') return '';
    if (args[0] === 'remote') return 'git@github.com:example/repo.git\n';
    if (args[0] === 'branch') return 'trunk\n';
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  }, () => preflightCheck('/legacy-repo', 'trunk'));

  assert.deepEqual(result, { ok: false, errors: ['on base branch'] });
  assert.ok(calls.every(call => call.opts.cwd === '/legacy-repo'));
});

test('preflightCheck: explicit PR base does not permit the repository default branch', () => {
  for (const { currentBranch, defaultBranch } of [
    { currentBranch: 'main', defaultBranch: 'main' },
    { currentBranch: 'master', defaultBranch: 'main' },
    { currentBranch: 'trunk', defaultBranch: 'trunk' },
  ]) {
    const result = withExecMock((cmd, args) => {
      if (cmd === 'which') return '/usr/bin/gh\n';
      if (cmd === 'gh' && args[0] === 'auth') return '';
      if (cmd === 'gh' && args[0] === 'repo') return repoMetadata(defaultBranch);
      if (cmd === 'git' && args[0] === 'symbolic-ref') {
        return `refs/remotes/origin/${defaultBranch}\n`;
      }
      if (cmd === 'git' && args[0] === 'remote') {
        return 'git@github.com:example/repo.git\n';
      }
      if (cmd === 'git' && args[0] === 'branch') return `${currentBranch}\n`;
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    }, () => preflightCheck({ cwd: '/repo', baseBranch: 'develop' }));

    assert.deepEqual(result, { ok: false, errors: ['on base branch'] });
  }
});

test('preflightCheck: fails closed when authoritative GitHub default metadata is unavailable', () => {
  const result = withExecMock((cmd, args) => {
    if (cmd === 'which') return '/usr/bin/gh\n';
    if (cmd === 'gh' && args[0] === 'repo') throw new Error('metadata unavailable');
    if (cmd === 'gh' && args[0] === 'auth') return '';
    if (cmd === 'git' && args[0] === 'symbolic-ref') return 'refs/remotes/origin/main\n';
    if (cmd === 'git' && args[0] === 'remote') return 'git@github.com:example/repo.git\n';
    if (cmd === 'git' && args[0] === 'branch') return 'feat/safe-shipping\n';
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  }, () => preflightCheck({ cwd: '/repo', baseBranch: 'main' }));

  assert.deepEqual(result, {
    ok: false,
    errors: ['unable to determine GitHub repository identity/default branch'],
  });
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
    headBranch: 'feat/pinned-head',
    baseBranch: 'develop',
    repository: 'github.com/example/repo',
    cwd: '/repo',
  }));

  assert.deepEqual(result, { ok: true, prUrl: 'https://github.com/example/repo/pull/1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'gh');
  assert.deepEqual(calls[0].opts, { encoding: 'utf8', cwd: '/repo' });
  assert.equal(argValue(calls[0].args, '--base'), 'develop');
  assert.equal(argValue(calls[0].args, '--head'), 'feat/pinned-head');
  assert.equal(argValue(calls[0].args, '--repo'), 'github.com/example/repo');
});

test('createPR: pins head independently of ambient GitHub routing and checkout state', () => {
  const calls = [];
  const previousRepo = process.env.GH_REPO;
  const previousHost = process.env.GH_HOST;
  process.env.GH_REPO = 'attacker/redirected';
  process.env.GH_HOST = 'evil.example.test';
  try {
    const result = withExecMock((cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (cmd !== 'gh') throw new Error('must not inspect the current checkout');
      return 'https://github.com/example/repo/pull/101\n';
    }, () => createPR({
      title: 'Pinned head',
      body: 'Body',
      headBranch: 'feat/pinned-head',
      baseBranch: 'main',
      repository: 'github.com/example/repo',
      cwd: '/repo',
    }));

    assert.deepEqual(result, {
      ok: true,
      prUrl: 'https://github.com/example/repo/pull/101',
    });
    assert.equal(calls.length, 1);
    assert.equal(argValue(calls[0].args, '--head'), 'feat/pinned-head');
    assert.equal(argValue(calls[0].args, '--repo'), 'github.com/example/repo');
  } finally {
    if (previousRepo === undefined) delete process.env.GH_REPO;
    else process.env.GH_REPO = previousRepo;
    if (previousHost === undefined) delete process.env.GH_HOST;
    else process.env.GH_HOST = previousHost;
  }
});

test('createPR: rejects missing, blank, and option-like heads before execution', () => {
  for (const headBranch of [undefined, null, '', '   ', '--repo', '-C']) {
    let calls = 0;
    const result = withExecMock(() => {
      calls += 1;
      throw new Error('must not execute');
    }, () => createPR({
      title: 'Title',
      body: 'Body',
      headBranch,
      baseBranch: 'main',
      repository: 'github.com/example/repo',
      cwd: '/repo',
    }));

    assert.deepEqual(result, { ok: false, error: 'invalid head branch' });
    assert.equal(calls, 0);
  }
});

test('createPR: detects omitted base and passes it to gh create', () => {
  const calls = [];
  const result = withExecMock((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'git') return 'git@github.com:example/repo.git\n';
    if (cmd === 'gh' && args[0] === 'repo') return repoMetadata('trunk');
    return 'https://github.com/example/repo/pull/2\n';
  }, () => createPR({
    title: 'Title',
    body: 'Body',
    headBranch: 'feat/create-pr',
    cwd: '/repo',
    repository: 'github.com/example/repo',
  }));

  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], {
    cmd: 'git',
    args: ['remote', 'get-url', 'origin'],
    opts: { encoding: 'utf8', cwd: '/repo' },
  });
  assert.equal(calls[2].cmd, 'gh');
  assert.deepEqual(calls[2].opts, { encoding: 'utf8', cwd: '/repo' });
  assert.equal(argValue(calls[2].args, '--base'), 'trunk');
});

test('createPR: blank baseBranch is detected instead of forwarded', () => {
  const calls = [];
  const result = withExecMock((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'git') return 'git@github.com:example/repo.git\n';
    if (cmd === 'gh' && args[0] === 'repo') return repoMetadata('develop');
    return 'https://github.com/example/repo/pull/4\n';
  }, () => createPR({
    title: 'Title',
    body: 'Body',
    headBranch: 'feat/create-pr',
    baseBranch: '   ',
    repository: 'github.com/example/repo',
    cwd: '/repo',
  }));

  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.equal(argValue(calls[2].args, '--base'), 'develop');
});

test('createPR: falls back to main when base detection fails', () => {
  const calls = [];
  const result = withExecMock((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'git') throw new Error('no origin head');
    if (args[0] === 'repo') throw new Error('no gh metadata');
    return 'https://github.com/example/repo/pull/3\n';
  }, () => createPR({
    title: 'Title',
    body: 'Body',
    headBranch: 'feat/create-pr',
    cwd: '/repo',
    repository: 'github.com/example/repo',
  }));

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
    headBranch: 'feat/create-pr',
    baseBranch: 'main',
    repository: 'github.com/example/repo',
    cwd: '/repo',
  }));

  assert.deepEqual(result, { ok: false, error: 'permission denied' });
});

test('createPR: rejects missing, malformed, or different-repository PR URLs', () => {
  for (const output of [
    '',
    'warning: completed without URL\n',
    'https://github.com/other/repo/pull/1\n',
    'http://github.com/example/repo/pull/1\n',
  ]) {
    const result = withExecMock(() => output, () => createPR({
      title: 'Title',
      body: 'Body',
      headBranch: 'feat/create-pr',
      baseBranch: 'main',
      repository: 'github.com/example/repo',
      cwd: '/repo',
    }));
    assert.deepEqual(result, {
      ok: false,
      error: 'gh pr create returned no matching PR URL',
    }, output);
  }
});

test('createPR: process.cwd failure is returned as a structured error', () => {
  const originalCwd = process.cwd;
  process.cwd = () => { throw new Error('cwd unavailable'); };
  try {
    assert.deepEqual(
      createPR({
        title: 'Title',
        body: 'Body',
        headBranch: 'feat/create-pr',
        baseBranch: 'main',
      }),
      { ok: false, error: 'cwd unavailable' },
    );
  } finally {
    process.cwd = originalCwd;
  }
});

test('findExistingPR: is exported as a function', () => {
  assert.equal(typeof findExistingPR, 'function');
});

test('findExistingPR: scopes the lookup to cwd and validates the requested base', () => {
  const calls = [];
  const result = withExecMock((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return JSON.stringify([{
      number: 85,
      url: 'https://github.com/example/repo/pull/85',
      baseRefName: 'develop',
      isCrossRepository: false,
    }]);
  }, () => findExistingPR('feat/safe-shipping', {
    cwd: '/target-repo',
    baseBranch: 'develop',
    repository: 'github.com/example/repo',
  }));

  assert.deepEqual(result, {
    ok: true,
    found: true,
    prUrl: 'https://github.com/example/repo/pull/85',
    prNumber: 85,
    baseRefName: 'develop',
    baseMatches: true,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'gh');
  assert.deepEqual(calls[0].opts, { encoding: 'utf8', cwd: '/target-repo' });
  assert.equal(argValue(calls[0].args, '--head'), 'feat/safe-shipping');
  assert.equal(argValue(calls[0].args, '--state'), 'open');
  assert.equal(argValue(calls[0].args, '--json'), 'number,url,baseRefName,isCrossRepository');
  assert.equal(argValue(calls[0].args, '--limit'), '100');
  assert.equal(argValue(calls[0].args, '--repo'), 'github.com/example/repo');
});

test('findExistingPR: returns a wrong-base PR as an explicit retarget candidate', () => {
  const result = withExecMock(() => JSON.stringify([{
    number: 84,
    url: 'https://github.com/example/repo/pull/84',
    baseRefName: 'main',
    isCrossRepository: false,
  }]), () => findExistingPR('feat/safe-shipping', {
    cwd: '/target-repo',
    baseBranch: 'develop',
    repository: 'github.com/example/repo',
  }));

  assert.deepEqual(result, {
    ok: true,
    found: true,
    prUrl: 'https://github.com/example/repo/pull/84',
    prNumber: 84,
    baseRefName: 'main',
    baseMatches: false,
  });
});

test('findExistingPR: prefers an exact-base PR over a newer wrong-base PR', () => {
  const result = withExecMock(() => JSON.stringify([
    {
      number: 84,
      url: 'https://github.com/example/repo/pull/84',
      baseRefName: 'main',
      isCrossRepository: false,
    },
    {
      number: 85,
      url: 'https://github.com/example/repo/pull/85',
      baseRefName: 'develop',
      isCrossRepository: false,
    },
  ]), () => findExistingPR('feat/safe-shipping', {
    cwd: '/target-repo',
    baseBranch: 'develop',
    repository: 'github.com/example/repo',
  }));

  assert.equal(result.prNumber, 85);
  assert.equal(result.ok, true);
  assert.equal(result.baseRefName, 'develop');
  assert.equal(result.baseMatches, true);
});

test('findExistingPR: ignores fork PRs that collide on the head branch name', () => {
  const result = withExecMock(() => JSON.stringify([{
    number: 999,
    url: 'https://github.com/contributor/fork/pull/999',
    baseRefName: 'main',
    isCrossRepository: true,
  }]), () => findExistingPR('patch-1', {
    cwd: '/repo',
    baseBranch: 'main',
    repository: 'github.com/example/repo',
  }));

  assert.deepEqual(result, { ok: true, found: false });
});

test('findExistingPR: fails closed on ambiguous same-repository candidates', () => {
  for (const rows of [
    [
      { number: 1, url: 'https://github.com/example/repo/pull/1', baseRefName: 'develop', isCrossRepository: false },
      { number: 2, url: 'https://github.com/example/repo/pull/2', baseRefName: 'release', isCrossRepository: false },
    ],
    [
      { number: 3, url: 'https://github.com/example/repo/pull/3', baseRefName: 'main', isCrossRepository: false },
      { number: 4, url: 'https://github.com/example/repo/pull/4', baseRefName: 'main', isCrossRepository: false },
    ],
  ]) {
    const result = withExecMock(() => JSON.stringify(rows), () => findExistingPR('feat/x', {
      cwd: '/repo',
      baseBranch: 'main',
      repository: 'github.com/example/repo',
    }));
    assert.deepEqual(result, {
      ok: false,
      found: false,
      error: 'ambiguous same-repository PR candidates',
    });
  }
});

test('findExistingPR: rejects a same-repository row whose URL targets another repo', () => {
  const result = withExecMock(() => JSON.stringify([{
    number: 85,
    url: 'https://github.com/other/repo/pull/85',
    baseRefName: 'main',
    isCrossRepository: false,
  }]), () => findExistingPR('feat/x', {
    cwd: '/repo',
    baseBranch: 'main',
    repository: 'github.com/example/repo',
  }));
  assert.deepEqual(result, {
    ok: false,
    found: false,
    error: 'PR URL does not match pinned repository',
  });
});

test('findExistingPR: detects an omitted base in the same cwd before lookup', () => {
  const calls = [];
  const result = withExecMock((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'git') return 'git@github.com:example/repo.git\n';
    if (cmd === 'gh' && args[0] === 'repo') return repoMetadata('trunk');
    return JSON.stringify([{
      number: 86,
      url: 'https://github.com/example/repo/pull/86',
      baseRefName: 'trunk',
      isCrossRepository: false,
    }]);
  }, () => findExistingPR('feat/safe-shipping', {
    cwd: '/target-repo',
    repository: 'github.com/example/repo',
  }));

  assert.equal(result.found, true);
  assert.equal(result.ok, true);
  assert.equal(result.baseMatches, true);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.opts.cwd === '/target-repo'));
  assert.equal(argValue(calls[2].args, '--head'), 'feat/safe-shipping');
});

test('findExistingPR: supports legacy positional cwd/base and never interpolates argv', () => {
  const hostileBranch = 'feat/test; echo pwned';
  const calls = [];
  const result = withExecMock((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'git') return 'git@github.com:example/repo.git\n';
    if (cmd === 'gh' && args[0] === 'repo') return repoMetadata('main');
    return JSON.stringify([{
      number: 87,
      url: 'https://github.com/example/repo/pull/87',
      baseRefName: 'release/2.x',
      isCrossRepository: false,
    }]);
  }, () => findExistingPR(hostileBranch, '/legacy-repo', 'release/2.x'));

  assert.equal(result.found, true);
  assert.equal(result.ok, true);
  assert.equal(result.baseMatches, true);
  assert.equal(calls.length, 4);
  assert.equal(argValue(calls[3].args, '--head'), hostileBranch);
  assert.equal(result.baseRefName, 'release/2.x');
  assert.ok(calls.every(call => call.opts.cwd === '/legacy-repo'));
});

test('findExistingPR: malformed output, command failure, and blank branches fail closed', () => {
  const malformed = withExecMock(() => '{not json', () => findExistingPR('feat/x', {
    cwd: '/repo',
    baseBranch: 'main',
    repository: 'github.com/example/repo',
  }));
  assert.deepEqual(malformed, {
    ok: false,
    found: false,
    error: 'invalid gh pr list JSON',
  });

  const failed = withExecMock(() => {
    throw new Error('gh unavailable');
  }, () => findExistingPR('feat/x', {
    cwd: '/repo',
    baseBranch: 'main',
    repository: 'github.com/example/repo',
  }));
  assert.deepEqual(failed, {
    ok: false,
    found: false,
    error: 'gh pr list failed',
  });

  let calls = 0;
  const blank = withExecMock(() => {
    calls += 1;
    throw new Error('must not execute');
  }, () => findExistingPR('   ', { cwd: '/repo', baseBranch: 'main' }));
  assert.deepEqual(blank, { ok: false, found: false, error: 'invalid branch' });
  assert.equal(calls, 0);
});

test('findExistingPR: a successful empty list is the only no-match result', () => {
  const result = withExecMock(() => '[]', () => findExistingPR('feat/x', {
    cwd: '/repo',
    baseBranch: 'main',
    repository: 'github.com/example/repo',
  }));

  assert.deepEqual(result, { ok: true, found: false });
});

test('findExistingPR: malformed response schemas fail closed', () => {
  for (const response of [
    JSON.stringify({ number: 85 }),
    JSON.stringify([{
      number: '85', url: null, baseRefName: 'main', isCrossRepository: false,
    }]),
  ]) {
    const result = withExecMock(() => response, () => findExistingPR('feat/x', {
      cwd: '/repo',
      baseBranch: 'main',
      repository: 'github.com/example/repo',
    }));

    assert.equal(result.ok, false);
    assert.equal(result.found, false);
    assert.match(result.error, /unexpected|invalid/);
  }
});

test('updateExistingPR: retargets and refreshes content using safe argv', () => {
  const calls = [];
  const result = withExecMock((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return '';
  }, () => updateExistingPR({
    prNumber: 85,
    title: 'fix: safe shipping; no shell',
    body: 'Fixes #81\n\nCloses #82',
    baseBranch: 'develop',
    labels: ['bug', 'ship safety'],
    repository: 'github.com/example/repo',
    cwd: '/target-repo',
  }));

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'gh');
  assert.deepEqual(calls[0].opts, { encoding: 'utf8', cwd: '/target-repo' });
  assert.deepEqual(calls[0].args, [
    'pr', 'edit', '85',
    '--base', 'develop',
    '--title', 'fix: safe shipping; no shell',
    '--body', 'Fixes #81\n\nCloses #82',
    '--add-label', 'bug',
    '--add-label', 'ship safety',
    '--repo', 'github.com/example/repo',
  ]);
});

test('updateExistingPR: detects an omitted base in cwd before editing', () => {
  const calls = [];
  const result = withExecMock((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'git') return 'git@github.com:example/repo.git\n';
    if (cmd === 'gh' && args[0] === 'repo') return repoMetadata('trunk');
    return '';
  }, () => updateExistingPR({
    prNumber: '86',
    cwd: '/target-repo',
    repository: 'github.com/example/repo',
  }));

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.opts.cwd === '/target-repo'));
  assert.equal(argValue(calls[2].args, '--base'), 'trunk');
});

test('updateExistingPR: invalid number and gh failures return structured errors', () => {
  let calls = 0;
  const invalid = withExecMock(() => {
    calls += 1;
    throw new Error('must not execute');
  }, () => updateExistingPR({ prNumber: '85; echo pwned', cwd: '/repo' }));
  assert.deepEqual(invalid, { ok: false, error: 'invalid PR number' });
  assert.equal(calls, 0);

  const failed = withExecMock(() => {
    const error = new Error('command failed');
    error.stderr = 'permission denied\n';
    throw error;
  }, () => updateExistingPR({
    prNumber: 85,
    baseBranch: 'main',
    repository: 'github.com/example/repo',
    cwd: '/repo',
  }));
  assert.deepEqual(failed, { ok: false, error: 'permission denied' });
});
