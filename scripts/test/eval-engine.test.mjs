import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { runOrchestrator } from '../../evals/lib/orchestrate.mjs';
import { passAtK, passHatK, rollupByTrack } from '../../evals/lib/score.mjs';
import { aggregateTokenUsage, runEval } from '../../evals/run.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SAMPLE_TASK = path.join(REPO_ROOT, 'evals/tasks/_sample');

function makeTmpDir(prefix = 'ao-eval-engine-test-') {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

test('score helpers compute pass@k, pass^k, and track rollups', () => {
  assert.equal(passAtK([]), false);
  assert.equal(passHatK([]), false);
  assert.equal(passAtK([{ pass: false }, { pass: true }]), true);
  assert.equal(passAtK([{ pass: false }]), false);
  assert.equal(passHatK([{ pass: true }, { pass: true }]), true);
  assert.equal(passHatK([{ pass: true }, { pass: false }]), false);

  assert.deepEqual(rollupByTrack([
    { track: 'regression', passHatK: true },
    { track: 'regression', passHatK: false },
    { track: 'capability', pass: true },
  ]), [
    { track: 'regression', total: 2, passed: 1 },
    { track: 'capability', total: 1, passed: 1 },
  ]);
});

test('runOrchestrator live path builds branch-accurate claude argv without --bare', async () => {
  const cwd = makeTmpDir();
  const pluginDir = path.join(cwd, 'plugin');
  const calls = [];

  try {
    const fakeSpawn = (command, args, opts) => {
      calls.push({ command, args, opts });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      process.nextTick(() => {
        child.stdout.write(`${JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          usage: { input_tokens: 2, output_tokens: 3 },
        })}\n`);
        child.stdout.end();
        child.emit('close', 0, null);
      });
      return child;
    };

    const result = await runOrchestrator({
      orchestrator: 'atlas',
      prompt: 'do the thing',
      cwd,
      pluginDir,
      spawn: fakeSpawn,
    });

    assert.equal(result.status, 'completed');
    assert.deepEqual(result.usage, { input_tokens: 2, output_tokens: 3 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'claude');
    assert.equal(calls[0].opts.cwd, cwd);
    assert.equal(calls[0].args[0], '-p');
    assert.equal(calls[0].args[1], '/atlas do the thing');
    assert.equal(calls[0].args.includes('--plugin-dir'), true);
    assert.equal(calls[0].args[calls[0].args.indexOf('--plugin-dir') + 1], pluginDir);
    assert.equal(calls[0].args.includes('--bare'), false);
    assert.equal(calls[0].args.includes('--dangerously-skip-permissions'), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runOrchestrator timeout sends SIGTERM then SIGKILL and returns timeout', async () => {
  const cwd = makeTmpDir();
  const signals = [];

  try {
    const fakeSpawn = () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => {
        signals.push(signal);
        return true;
      };
      return child;
    };

    const result = await runOrchestrator({
      orchestrator: 'atlas',
      prompt: 'hang',
      cwd,
      timeoutMs: 5,
      spawn: fakeSpawn,
    });

    assert.equal(result.status, 'timeout');
    assert.equal(result.timedOut, true);
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runOrchestrator fixture mode mutates cwd without spawning', async () => {
  const cwd = makeTmpDir();
  const markerPath = path.join(cwd, 'marker.txt');
  writeFileSync(markerPath, 'broken\n', 'utf-8');

  try {
    const result = await runOrchestrator({
      orchestrator: 'atlas',
      prompt: 'ignored',
      cwd,
      fixture: {
        status: 'completed',
        usage: { input_tokens: 999 },
        mutate: (workdir) => writeFileSync(path.join(workdir, 'marker.txt'), 'fixed\n'),
      },
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.usage, null);
    assert.equal(readFileSync(markerPath, 'utf-8').trim(), 'fixed');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('aggregateTokenUsage sums real result-event token fields and ignores missing usage', () => {
  assert.deepEqual(aggregateTokenUsage([
    {
      input_tokens: 10,
      output_tokens: 4,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 2,
    },
    null,
    { input_tokens: 5, output_tokens: 1 },
  ]), {
    inputTokens: 15,
    outputTokens: 5,
    cacheCreationInputTokens: 3,
    cacheReadInputTokens: 2,
    totalTokens: 25,
    reportedTrials: 2,
  });
});

test('runEval isolates k trials and reports pass@k, pass^k, tokens, and track rollup', async () => {
  const tmpRoot = makeTmpDir();
  const workdirs = [];
  let call = 0;

  try {
    const result = await runEval(SAMPLE_TASK, {
      k: 3,
      fixture: (cwd) => {
        workdirs.push(cwd);
        call += 1;
        return call === 2 ? 'pass' : 'fail';
      },
      runId: 'sample-k3',
      resultsDir: path.join(tmpRoot, 'results'),
    });

    assert.equal(new Set(workdirs).size, 3, 'each trial must use a distinct workdir');
    assert.deepEqual(result.results.map((trial) => trial.pass), [false, true, false]);
    assert.equal(result.summary.passAtK, true);
    assert.equal(result.summary.passHatK, false);
    assert.deepEqual(result.summary.tokenUsage, {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 0,
      reportedTrials: 0,
    });
    assert.deepEqual(result.summary.tracks, [
      { track: 'regression', total: 1, passed: 0 },
    ]);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('runEval writes green summary/results for the sample pass fixture', async () => {
  const tmpRoot = makeTmpDir();
  const resultsDir = path.join(tmpRoot, 'missing/results');

  try {
    const result = await runEval(SAMPLE_TASK, {
      fixture: 'pass',
      runId: 'sample-pass',
      resultsDir,
      now: 1,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.summary.schemaVersion, 1);
    assert.equal(result.summary.passHatK, true);
    assert.equal(result.summary.passAtK, true);
    assert.equal(result.summary.trials.length, 1);
    assert.equal(existsSync(resultsDir), true);

    const runDir = path.join(resultsDir, 'sample-pass');
    const summary = readJson(path.join(runDir, 'summary.json'));
    assert.equal(summary.schemaVersion, 1);
    assert.equal(summary.passHatK, true);
    assert.equal(statSync(runDir).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(runDir, 'summary.json')).mode & 0o777, 0o600);
    assert.equal(statSync(path.join(runDir, 'results.jsonl')).mode & 0o777, 0o600);

    const lines = readFileSync(path.join(runDir, 'results.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].schemaVersion, 1);
    assert.equal(lines[0].pass, true);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('runEval writes red summary/results for the sample fail fixture', async () => {
  const tmpRoot = makeTmpDir();
  const resultsDir = path.join(tmpRoot, 'results');

  try {
    const result = await runEval(SAMPLE_TASK, {
      fixture: 'fail',
      runId: 'sample-fail',
      resultsDir,
      now: 2,
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.summary.schemaVersion, 1);
    assert.equal(result.summary.passHatK, false);
    assert.equal(result.summary.passAtK, false);

    const summary = readJson(path.join(resultsDir, 'sample-fail/summary.json'));
    assert.equal(summary.schemaVersion, 1);
    assert.equal(summary.passHatK, false);
    assert.equal(summary.passAtK, false);

    const resultLine = JSON.parse(readFileSync(
      path.join(resultsDir, 'sample-fail/results.jsonl'),
      'utf-8',
    ).trim());
    assert.equal(resultLine.schemaVersion, 1);
    assert.equal(resultLine.pass, false);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
