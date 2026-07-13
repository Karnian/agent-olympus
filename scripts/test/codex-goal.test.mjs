/**
 * Unit tests for scripts/codex-goal.mjs.
 *
 * The run-path tests inject a fake codex-exec adapter, so no real Codex
 * process starts and no external dependencies are required.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  _setAdapter,
  buildTrustOverride,
  extractGoalResult,
  parseArgs,
  runGoalTurn,
} from '../codex-goal.mjs';

const CODEX_GOAL_SKILL = readFileSync(
  fileURLToPath(new URL('../../skills/codex-goal/SKILL.md', import.meta.url)),
  'utf-8',
);

const SAMPLE_RESULT = {
  summary: 'Implemented codex goal helper.',
  files_changed: ['scripts/codex-goal.mjs'],
  verification: {
    commands: ['node --test scripts/test/codex-goal.test.mjs'],
    results: ['pass'],
  },
  unresolved_risks: [],
  follow_ups: [],
};

function makeFakeAdapter({ collectResult, spawnError } = {}) {
  const calls = {
    spawn: 0,
    spawnResume: 0,
    collect: 0,
    shutdown: 0,
    spawnArgs: [],
    spawnResumeArgs: [],
    collectTimeouts: [],
  };

  const adapter = {
    spawn(prompt, opts) {
      calls.spawn++;
      calls.spawnArgs.push({ prompt, opts });
      if (spawnError) throw spawnError;
      return { threadId: 'thread-new', _output: collectResult?.output ?? '' };
    },
    spawnResume(threadId, prompt, opts) {
      calls.spawnResume++;
      calls.spawnResumeArgs.push({ threadId, prompt, opts });
      if (spawnError) throw spawnError;
      return { threadId, _output: collectResult?.output ?? '' };
    },
    async collect(_handle, timeoutMs) {
      calls.collect++;
      calls.collectTimeouts.push(timeoutMs);
      return collectResult ?? { status: 'completed', output: '' };
    },
    async shutdown(_handle) {
      calls.shutdown++;
    },
  };

  return { adapter, calls };
}

test('SKILL contract: each goal uses a unique fail-closed worktree', () => {
  assert.match(
    CODEX_GOAL_SKILL,
    /const goalTag\s*=\s*[\s\S]*?randomUUID\(\)\.slice\(0, 4\)/,
  );
  assert.match(CODEX_GOAL_SKILL, /`codex-goal-\$\{goalTag\}`/);
  assert.match(
    CODEX_GOAL_SKILL,
    /createWorkerWorktree\(cwd, runId, `codex-goal-\$\{goalTag\}`, \{ onExisting: 'fail' \}\)/,
  );
  assert.doesNotMatch(
    CODEX_GOAL_SKILL,
    /createWorkerWorktree\(cwd, runId, 'codex-goal'\)/,
  );

  const collisionStop = CODEX_GOAL_SKILL.indexOf('if (!created)');
  const firstCodexCommand = CODEX_GOAL_SKILL.indexOf(
    'node "$CLAUDE_PLUGIN_ROOT"/scripts/codex-goal.mjs',
  );
  assert.ok(collisionStop >= 0, 'missing explicit worktree-allocation stop');
  assert.ok(firstCodexCommand > collisionStop, 'allocation failure must stop before Codex starts');
  assert.match(
    CODEX_GOAL_SKILL.slice(collisionStop, firstCodexCommand),
    /throw new Error[\s\S]*?error \|\| 'unknown error'/,
  );
  assert.match(
    CODEX_GOAL_SKILL,
    /## Constraints[\s\S]*?Parallel and sequential goals[\s\S]*?never fall back to running Codex in `cwd`/,
  );
});

async function withAdapter(fakeAdapter, fn) {
  const previous = _setAdapter(fakeAdapter);
  try {
    await fn();
  } finally {
    _setAdapter(previous);
  }
}

test('extractGoalResult: clean JSON', () => {
  assert.deepEqual(
    extractGoalResult(JSON.stringify(SAMPLE_RESULT)),
    { parsed: SAMPLE_RESULT, ok: true }
  );
});

test('extractGoalResult: JSON inside ```json fence', () => {
  const output = [
    'Done.',
    '```json',
    JSON.stringify(SAMPLE_RESULT, null, 2),
    '```',
  ].join('\n');

  assert.deepEqual(
    extractGoalResult(output),
    { parsed: SAMPLE_RESULT, ok: true }
  );
});

test('extractGoalResult: JSON after prose', () => {
  const output = `I changed the helper.\n\n${JSON.stringify(SAMPLE_RESULT)}`;

  assert.deepEqual(
    extractGoalResult(output),
    { parsed: SAMPLE_RESULT, ok: true }
  );
});

test('extractGoalResult: no JSON', () => {
  assert.deepEqual(
    extractGoalResult('No structured result was produced.'),
    { parsed: null, ok: false }
  );
});

test('extractGoalResult: malformed JSON', () => {
  assert.deepEqual(
    extractGoalResult('{"summary": "missing close"'),
    { parsed: null, ok: false }
  );
});

test('parseArgs: defaults', () => {
  assert.deepEqual(parseArgs([]), {
    cwd: process.cwd(),
    level: 'full-auto',
    resume: null,
    noTrust: false,
  });
});

test('parseArgs: --resume', () => {
  assert.deepEqual(parseArgs(['--resume', 'thread-123']), {
    cwd: process.cwd(),
    level: 'full-auto',
    resume: 'thread-123',
    noTrust: false,
  });
});

test('parseArgs: --level', () => {
  assert.deepEqual(parseArgs(['--level', 'suggest']), {
    cwd: process.cwd(),
    level: 'suggest',
    resume: null,
    noTrust: false,
  });
});

test('parseArgs: --no-trust', () => {
  assert.deepEqual(parseArgs(['--no-trust']), {
    cwd: process.cwd(),
    level: 'full-auto',
    resume: null,
    noTrust: true,
  });
});

test('buildTrustOverride: builds Codex project trust override', () => {
  assert.equal(
    buildTrustOverride('/tmp/worktree'),
    'projects."/tmp/worktree".trust_level="trusted"',
  );
});

test('runGoalTurn: injected adapter success returns ok payload and exit intent 0', async () => {
  const output = `Codex completed the task.\n${JSON.stringify(SAMPLE_RESULT)}`;
  const { adapter, calls } = makeFakeAdapter({
    collectResult: { status: 'completed', output },
  });

  await withAdapter(adapter, async () => {
    const args = parseArgs(['--cwd', '/tmp/worktree', '--level', 'auto-edit']);
    const { payload, exitCode } = await runGoalTurn('goal packet', args);

    assert.equal(exitCode, 0);
    assert.equal(payload.status, 'ok');
    assert.equal(payload.threadId, 'thread-new');
    assert.deepEqual(payload.result, SAMPLE_RESULT);
    assert.match(payload.rawTail, /Codex completed the task/);
    assert.equal(calls.spawn, 1);
    assert.equal(calls.spawnResume, 0);
    assert.equal(calls.collect, 1);
    assert.equal(calls.shutdown, 1);
    assert.deepEqual(calls.spawnArgs[0], {
      prompt: 'goal packet',
      opts: {
        persist: true,
        level: 'auto-edit',
        cwd: '/tmp/worktree',
        configOverrides: [buildTrustOverride('/tmp/worktree')],
      },
    });
    assert.deepEqual(calls.collectTimeouts, [900_000]);
  });
});

test('runGoalTurn: injected adapter passes no trust override with --no-trust', async () => {
  const output = JSON.stringify(SAMPLE_RESULT);
  const { adapter, calls } = makeFakeAdapter({
    collectResult: { status: 'completed', output },
  });

  await withAdapter(adapter, async () => {
    const args = parseArgs(['--cwd', '/tmp/worktree', '--no-trust']);
    const { payload, exitCode } = await runGoalTurn('goal packet', args);

    assert.equal(exitCode, 0);
    assert.equal(payload.status, 'ok');
    assert.equal(calls.spawn, 1);
    assert.equal(Object.hasOwn(calls.spawnArgs[0].opts, 'configOverrides'), false);
  });
});

test('runGoalTurn: injected adapter error returns failed payload and non-zero exit intent', async () => {
  const { adapter, calls } = makeFakeAdapter({
    collectResult: {
      status: 'failed',
      output: 'partial adapter output',
      error: { category: 'timeout', message: 'Codex process timed out' },
    },
  });

  await withAdapter(adapter, async () => {
    const args = parseArgs(['--resume', 'thread-existing']);
    const { payload, exitCode } = await runGoalTurn('retry packet', args);

    assert.notEqual(exitCode, 0);
    assert.equal(payload.status, 'failed');
    assert.equal(payload.threadId, 'thread-existing');
    assert.equal(payload.result, null);
    assert.equal(payload.rawTail, 'partial adapter output');
    assert.deepEqual(payload.error, {
      category: 'timeout',
      message: 'Codex process timed out',
    });
    assert.equal(calls.spawn, 0);
    assert.equal(calls.spawnResume, 1);
    assert.equal(calls.collect, 1);
    assert.equal(calls.shutdown, 1);
    assert.deepEqual(calls.spawnResumeArgs[0], {
      threadId: 'thread-existing',
      prompt: 'retry packet',
      opts: {
        persist: true,
        level: 'full-auto',
        cwd: process.cwd(),
        configOverrides: [buildTrustOverride(process.cwd())],
      },
    });
  });
});
