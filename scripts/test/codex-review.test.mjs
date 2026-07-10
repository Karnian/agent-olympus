/**
 * Unit tests for scripts/codex-review.mjs.
 *
 * The tests inject git and Codex seams, so they never spawn real Codex and
 * never run git against this repository.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assembleReviewTarget,
  deriveVerdict,
  main,
  parseArgs,
} from '../codex-review.mjs';

function reviewResult(overrides = {}) {
  return {
    verdict: 'PASS',
    findings: [],
    summary: 'No blocking findings.',
    ...overrides,
  };
}

function jsonlMessage(text, threadId = 'thread-review-1') {
  return [
    JSON.stringify({ type: 'thread.started', thread_id: threadId }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n');
}

function makeGitExec({ diff = '', untracked = '' } = {}) {
  const calls = [];
  const exec = async (command, args) => {
    calls.push({ command, args });
    if (command !== 'git') throw new Error(`unexpected command: ${command}`);
    const gitArgs = args.slice(2);
    if (gitArgs[0] === 'diff') return { stdout: diff, stderr: '', exitCode: 0 };
    if (gitArgs.join(' ') === 'ls-files --others --exclude-standard') {
      return { stdout: untracked, stderr: '', exitCode: 0 };
    }
    throw new Error(`unexpected git args: ${gitArgs.join(' ')}`);
  };
  return { exec, calls };
}

function makeReadFile(files) {
  return async (path) => {
    if (!Object.hasOwn(files, path)) throw new Error(`missing fixture: ${path}`);
    return files[path];
  };
}

test('deriveVerdict: PASS with no findings', () => {
  assert.equal(deriveVerdict(reviewResult()), 'PASS');
});

test('deriveVerdict: PASS with only P2/P3/nit findings', () => {
  assert.equal(deriveVerdict(reviewResult({
    findings: [
      { severity: 'P2', file: 'a.js', summary: 'advisory' },
      { severity: 'P3', file: 'b.js', summary: 'advisory' },
      { severity: 'nit', file: 'c.js', summary: 'advisory' },
    ],
  })), 'PASS');
});

test('deriveVerdict: FAIL on a critical finding', () => {
  assert.equal(deriveVerdict(reviewResult({
    findings: [{ severity: 'critical', file: 'auth.js', summary: 'auth bypass' }],
  })), 'FAIL');
});

test('deriveVerdict: FAIL on a P1 finding', () => {
  assert.equal(deriveVerdict(reviewResult({
    findings: [{ severity: 'P1', file: 'billing.js', summary: 'double charge' }],
  })), 'FAIL');
});

test('deriveVerdict: FAIL when result.verdict is FAIL', () => {
  assert.equal(deriveVerdict(reviewResult({ verdict: 'FAIL' })), 'FAIL');
});

test('main: fail-open when injected spawn throws', async () => {
  const { exec } = makeGitExec();
  const { payload, exitCode } = await main(['--cwd', '/repo'], {
    exec,
    spawn: () => { throw new Error('codex missing'); },
  });

  assert.equal(exitCode, 2);
  assert.equal(payload.status, 'error');
  assert.equal(payload.verdict, null);
  assert.match(payload.error, /codex missing/);
});

test('main: fail-open on malformed Codex JSON', async () => {
  const { exec } = makeGitExec();
  const { payload, exitCode } = await main(['--cwd', '/repo'], {
    exec,
    spawn: async () => ({ exitCode: 0, stdout: jsonlMessage('not json'), stderr: '' }),
  });

  assert.equal(exitCode, 2);
  assert.equal(payload.status, 'error');
  assert.equal(payload.verdict, null);
  assert.match(payload.error, /not valid JSON/);
});

test('main: fail-open on non-zero Codex exit', async () => {
  const { exec } = makeGitExec();
  const { payload, exitCode } = await main(['--cwd', '/repo'], {
    exec,
    spawn: async () => ({ exitCode: 7, stdout: '', stderr: 'boom' }),
  });

  assert.equal(exitCode, 2);
  assert.equal(payload.status, 'error');
  assert.equal(payload.verdict, null);
  assert.match(payload.error, /boom/);
});

test('main: success path uses read-only Codex exec schema gate', async () => {
  const { exec } = makeGitExec({ diff: 'diff --git a/a.js b/a.js\n' });
  const spawnCalls = [];
  const result = reviewResult();
  const { payload, exitCode } = await main(['--cwd', '/repo'], {
    exec,
    spawn: async (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return {
        exitCode: 0,
        stdout: jsonlMessage(JSON.stringify(result), 'thread-ok'),
        stderr: '',
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(payload.status, 'ok');
  assert.equal(payload.verdict, 'PASS');
  assert.equal(payload.threadId, 'thread-ok');
  assert.ok(spawnCalls[0].command.endsWith('codex'), 'spawns the resolved codex binary');
  assert.equal(typeof spawnCalls[0].options.env?.PATH, 'string', 'passes an enhanced PATH');
  assert.deepEqual(spawnCalls[0].args.slice(0, 4), ['-s', 'read-only', '-a', 'never']);
  assert.ok(spawnCalls[0].args.includes('--output-schema'));
  assert.deepEqual(spawnCalls[0].args.slice(-3), ['-C', '/repo', '-']);
  assert.equal(spawnCalls[0].options.input.includes('Finding bar:'), true);
});

test('main: fail-open when a finding is missing the required line key', async () => {
  const { exec } = makeGitExec({ diff: 'diff --git a/a.js b/a.js\n' });
  const badResult = {
    verdict: 'FAIL',
    summary: 'x',
    findings: [{ severity: 'P1', file: 'a.js', summary: 'no line key' }], // line omitted
  };
  const { payload, exitCode } = await main(['--cwd', '/repo'], {
    exec,
    spawn: async () => ({
      exitCode: 0,
      stdout: jsonlMessage(JSON.stringify(badResult), 'thread-noline'),
      stderr: '',
    }),
  });

  assert.equal(payload.status, 'error', 'validator must reject a finding missing the required line');
  assert.equal(payload.verdict, null);
  assert.equal(exitCode, 2);
});

test('main: a truncated review target cannot certify PASS (gate not satisfied)', async () => {
  const { exec } = makeGitExec({ diff: 'x'.repeat(5000) });
  const { payload, exitCode } = await main(['--cwd', '/repo'], {
    exec,
    maxChars: 100, // force truncation
    spawn: async () => ({
      exitCode: 0,
      stdout: jsonlMessage(JSON.stringify(reviewResult()), 'thread-trunc'),
      stderr: '',
    }),
  });

  assert.equal(payload.status, 'ok');
  assert.equal(payload.verdict, 'PASS', 'Codex still returned PASS on the partial diff');
  assert.equal(payload.truncated, true, 'envelope flags the incomplete review');
  assert.equal(exitCode, 1, 'a truncated review must not exit 0 as an authoritative gate');
});

test('assembleReviewTarget: base mode issues git diff --merge-base <ref> HEAD', async () => {
  const { exec, calls } = makeGitExec({ diff: 'diff --git a/a.js b/a.js\n' });
  const target = await assembleReviewTarget({
    cwd: '/repo',
    base: 'origin/main',
    uncommitted: false,
  }, { exec });

  assert.equal(target.text, 'diff --git a/a.js b/a.js\n');
  assert.equal(target.truncated, false);
  assert.deepEqual(calls, [{
    command: 'git',
    args: ['-C', '/repo', 'diff', '--merge-base', 'origin/main', 'HEAD'],
  }]);
});

test('assembleReviewTarget: uncommitted mode includes injected untracked files', async () => {
  const { exec, calls } = makeGitExec({
    diff: 'diff --git a/tracked.js b/tracked.js\n',
    untracked: 'new.js\nnotes/readme.md\n',
  });
  const target = await assembleReviewTarget({
    cwd: '/repo',
    base: null,
    uncommitted: true,
  }, {
    exec,
    readFile: makeReadFile({
      '/repo/new.js': 'console.log("new");\n',
      '/repo/notes/readme.md': '# Notes\n',
    }),
  });

  assert.match(target.text, /diff --git a\/tracked\.js b\/tracked\.js/);
  assert.match(target.text, /--- NEW UNTRACKED FILE: new\.js ---\nconsole\.log\("new"\);/);
  assert.match(target.text, /--- NEW UNTRACKED FILE: notes\/readme\.md ---\n# Notes/);
  assert.deepEqual(calls.map((call) => call.args), [
    ['-C', '/repo', 'diff', 'HEAD'],
    ['-C', '/repo', 'ls-files', '--others', '--exclude-standard'],
  ]);
});

test('assembleReviewTarget: truncates assembled target within maxChars and notes it', async () => {
  const { exec } = makeGitExec({ diff: 'x'.repeat(500) });
  const target = await assembleReviewTarget({
    cwd: '/repo',
    base: 'origin/main',
    uncommitted: false,
  }, { exec, maxChars: 120 });

  assert.ok(target.text.length <= 120);
  assert.equal(target.truncated, true);
  assert.match(target.text, /TRUNCATED: review target exceeded 120 characters/);
});

test('assembleReviewTarget: a target that merely MENTIONS the truncation notice is not truncated', async () => {
  // Regression: truncation must be a structural signal, not a text scan — a
  // diff that contains the notice string (e.g. codex-review.mjs's own source)
  // must report truncated:false when it fits within maxChars.
  const diff = `+const TRUNCATION_NOTICE = '[TRUNCATED: review target exceeded';\n`;
  const { exec } = makeGitExec({ diff });
  const target = await assembleReviewTarget(
    { cwd: '/repo', base: 'origin/main', uncommitted: false },
    { exec, maxChars: 10_000 },
  );
  assert.equal(target.truncated, false, 'mentioning the notice must not read as truncated');
  assert.match(target.text, /TRUNCATED: review target exceeded/);
});

test('parseArgs: defaults to uncommitted mode', () => {
  assert.deepEqual(parseArgs([]), {
    cwd: process.cwd(),
    base: null,
    uncommitted: true,
  });
});

test('parseArgs: parses --base', () => {
  assert.deepEqual(parseArgs(['--base', 'origin/main']), {
    cwd: process.cwd(),
    base: 'origin/main',
    uncommitted: false,
  });
});

test('parseArgs: parses --uncommitted', () => {
  assert.deepEqual(parseArgs(['--uncommitted']), {
    cwd: process.cwd(),
    base: null,
    uncommitted: true,
  });
});

test('parseArgs: parses --cwd with target', () => {
  assert.deepEqual(parseArgs(['--cwd', '/repo', '--base', 'main']), {
    cwd: '/repo',
    base: 'main',
    uncommitted: false,
  });
});
