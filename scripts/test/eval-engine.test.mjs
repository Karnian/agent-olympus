import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  cpSync,
  mkdirSync,
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
import {
  collectPipelineProtocolFiles,
  fingerprintBenchmark,
  fingerprintPipelineProtocol,
} from '../../evals/lib/tasks.mjs';
import { aggregateTokenUsage, runEval } from '../../evals/run.mjs';
import { createFinalizedEvalPipelineFixture } from './helpers/eval-pipeline-fixture.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SAMPLE_TASK = path.join(REPO_ROOT, 'evals/tasks/_sample');
const REGRESSION_TASK = path.join(REPO_ROOT, 'evals/tasks/fix-failing-test');

function makeTmpDir(prefix = 'ao-eval-engine-test-') {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function completeFakeLiveChild(child, cwd, resultEvent = {
  type: 'result',
  subtype: 'success',
  is_error: false,
}) {
  process.nextTick(() => {
    void createFinalizedEvalPipelineFixture(cwd).then(() => {
      child.stdout.end(`${JSON.stringify(resultEvent)}\n`);
      child.emit('close', 0, null);
    }).catch((error) => child.emit('error', error));
  });
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
    { track: 'capability', passAtK: true, passHatK: false },
    { track: 'capability', passAtK: false, passHatK: true },
    { track: 'capability', pass: false, passAtK: true, passHatK: true },
  ]), [
    { track: 'regression', total: 2, passed: 1 },
    { track: 'capability', total: 3, passed: 1 },
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
      modelTier: 'opus',
      spawn: fakeSpawn,
    });

    assert.equal(result.status, 'completed');
    assert.deepEqual(result.usage, { input_tokens: 2, output_tokens: 3 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'claude');
    assert.equal(calls[0].opts.cwd, cwd);
    assert.equal(calls[0].opts.env.PWD, cwd);
    assert.equal(Object.hasOwn(calls[0].opts.env, 'OLDPWD'), false);
    assert.equal(Object.hasOwn(calls[0].opts.env, 'INIT_CWD'), false);
    assert.equal(Object.hasOwn(calls[0].opts.env, 'CLAUDE_PLUGIN_ROOT'), false);
    assert.equal(calls[0].args[0], '-p');
    assert.equal(calls[0].args[1], '/atlas do the thing');
    assert.equal(calls[0].args.includes('--plugin-dir'), true);
    assert.equal(calls[0].args[calls[0].args.indexOf('--plugin-dir') + 1], pluginDir);
    assert.equal(calls[0].args.includes('--model'), true);
    assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'opus');
    assert.equal(result.raw.modelTier, 'opus');
    assert.equal(calls[0].args.includes('--bare'), false);
    assert.equal(calls[0].args.includes('--dangerously-skip-permissions'), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runOrchestrator rejects option-shaped model selectors before spawn', async () => {
  const cwd = makeTmpDir();
  let spawned = false;
  try {
    const result = await runOrchestrator({
      orchestrator: 'atlas',
      prompt: 'ignored',
      cwd,
      modelTier: '--dangerously-skip-permissions',
      spawn: () => {
        spawned = true;
        throw new Error('must not spawn');
      },
    });
    assert.equal(result.status, 'failed');
    assert.match(result.finalEvent.message, /Unsafe Claude model selector/);
    assert.equal(spawned, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runOrchestrator requires one valid terminal success result at exit 0', async () => {
  const cwd = makeTmpDir();
  try {
    for (const { stdout, category } of [
      {
        stdout: `${JSON.stringify({ type: 'assistant', message: 'partial' })}\n`,
        category: 'missing_result',
      },
      {
        stdout: '{"type":"result","subtype":"success"',
        category: 'malformed_stream',
      },
      {
        stdout: [
          JSON.stringify({ type: 'result', subtype: 'success', is_error: false }),
          JSON.stringify({ type: 'error', message: 'late wrapper failure' }),
          '',
        ].join('\n'),
        category: 'error_event',
      },
      {
        stdout: [
          JSON.stringify({ type: 'error', message: 'provider failed before wrapper result' }),
          JSON.stringify({ type: 'result', subtype: 'success', is_error: false }),
          '',
        ].join('\n'),
        category: 'error_event',
      },
      {
        stdout: [
          JSON.stringify({ type: 'assistant', error: 'tool execution failed' }),
          JSON.stringify({ type: 'result', subtype: 'success', is_error: false }),
          '',
        ].join('\n'),
        category: 'assistant_error',
      },
      {
        stdout: `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false })}\n{malformed}\n`,
        category: 'malformed_stream',
      },
      {
        stdout: [
          JSON.stringify({ type: 'result', subtype: 'success', is_error: false }),
          JSON.stringify({ type: 'result', subtype: 'success', is_error: false }),
          '',
        ].join('\n'),
        category: 'multiple_results',
      },
      {
        stdout: `${JSON.stringify({ type: 'result', subtype: 'unknown', is_error: false })}\n`,
        category: 'invalid_result',
      },
    ]) {
      const fakeSpawn = () => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => true;
        process.nextTick(() => {
          child.stdout.end(stdout);
          child.emit('close', 0, null);
        });
        return child;
      };

      const result = await runOrchestrator({
        orchestrator: 'atlas',
        prompt: 'incomplete stream',
        cwd,
        spawn: fakeSpawn,
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.raw.exitCode, 0);
      assert.equal(result.raw.resultCategory, category);
      assert.equal(result.usage, null);
    }

    const benignSpawn = () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      process.nextTick(() => {
        child.stdout.end([
          JSON.stringify({ type: 'future-benign-event', payload: true }),
          JSON.stringify({ type: 'result', subtype: 'success', is_error: false }),
          '',
        ].join('\n'));
        child.emit('close', 0, null);
      });
      return child;
    };
    const benign = await runOrchestrator({
      orchestrator: 'atlas',
      prompt: 'benign future event',
      cwd,
      spawn: benignSpawn,
    });
    assert.equal(benign.status, 'completed');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runOrchestrator rejects terminal success when the child has no normal exit code', async () => {
  const cwd = makeTmpDir();
  try {
    const fakeSpawn = () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      process.nextTick(() => {
        child.stdout.end(`${JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          usage: { input_tokens: 1, output_tokens: 1 },
        })}\n`);
        child.emit('close', null, 'SIGKILL');
      });
      return child;
    };

    const result = await runOrchestrator({
      orchestrator: 'atlas',
      prompt: 'abnormal process exit',
      cwd,
      spawn: fakeSpawn,
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.timedOut, false);
    assert.equal(result.raw.exitCode, null);
    assert.equal(result.raw.signal, 'SIGKILL');
    assert.equal(result.raw.resultCategory, null, 'the stream itself remains valid');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runEval live path uses and cleans a plugin snapshot without eval oracles', async () => {
  const tempRoot = makeTmpDir('ao-eval-live-stage-');
  const pluginSource = path.join(tempRoot, 'plugin-source');
  const resultsDir = path.join(tempRoot, 'results');
  mkdirSync(path.join(pluginSource, '.claude-plugin'), { recursive: true });
  mkdirSync(path.join(pluginSource, 'evals/tasks/demo/solution'), { recursive: true });
  writeFileSync(path.join(pluginSource, '.claude-plugin/plugin.json'), '{"name":"fixture"}\n');
  writeFileSync(path.join(pluginSource, 'evals/tasks/demo/solution/oracle.txt'), 'secret\n');
  const stagedPluginDirs = [];

  try {
    const fakeSpawn = (_command, args, options) => {
      const stagedPluginDir = args[args.indexOf('--plugin-dir') + 1];
      stagedPluginDirs.push(stagedPluginDir);
      assert.notEqual(path.resolve(stagedPluginDir), path.resolve(pluginSource));
      assert.equal(existsSync(path.join(stagedPluginDir, '.claude-plugin/plugin.json')), true);
      assert.equal(existsSync(path.join(stagedPluginDir, 'evals')), false);
      const trialMarker = path.join(stagedPluginDir, 'trial-marker.txt');
      assert.equal(existsSync(trialMarker), false, 'a later trial must receive a pristine plugin snapshot');
      writeFileSync(trialMarker, 'mutated by this trial\n');

      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      completeFakeLiveChild(child, options.cwd, {
        type: 'result',
        subtype: 'success',
        is_error: false,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      return child;
    };

    const result = await runEval(REGRESSION_TASK, {
      live: true,
      k: 2,
      pluginDir: pluginSource,
      resultsDir,
      spawn: fakeSpawn,
    });

    assert.equal(result.summary.oracleIsolation, 'staged-plugin-best-effort');
    assert.equal(result.summary.tasks[0].oracleIsolation, 'staged-plugin-best-effort');
    assert.equal(stagedPluginDirs.length, 2);
    assert.equal(new Set(stagedPluginDirs).size, 2);
    assert.equal(stagedPluginDirs.every((pluginDir) => !existsSync(pluginDir)), true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
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

    const synchronousSignals = [];
    const synchronousResult = await runOrchestrator({
      orchestrator: 'atlas',
      prompt: 'close during terminate',
      cwd,
      timeoutMs: 5,
      spawn: () => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = (signal) => {
          synchronousSignals.push(signal);
          child.emit('close', null, signal);
          return true;
        };
        return child;
      },
    });
    assert.equal(synchronousResult.status, 'timeout');
    assert.deepEqual(synchronousSignals, ['SIGTERM']);
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

test('eval trial workdirs have a committed seed HEAD and ignore harness .ao state', async () => {
  const tmpRoot = makeTmpDir();
  try {
    let inspected = false;
    const result = await runEval(SAMPLE_TASK, {
      fixture: (cwd) => {
        inspected = true;
        assert.match(
          execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd, encoding: 'utf-8' }).trim(),
          /^[a-f0-9]{40,64}$/,
        );
        assert.match(readFileSync(path.join(cwd, '.git/info/exclude'), 'utf-8'), /^\/\.ao\/$/m);
        assert.equal(readFileSync(path.join(cwd, 'AGENTS.md'), 'utf-8').includes('isolated repository'), true);
        assert.equal(
          execFileSync('git', ['config', 'user.email'], { cwd, encoding: 'utf-8' }).trim(),
          'eval@agent-olympus.invalid',
        );
        assert.equal(
          execFileSync('git', ['rev-parse', 'origin/main'], { cwd, encoding: 'utf-8' }).trim(),
          execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf-8' }).trim(),
        );
        assert.equal(execFileSync('git', ['remote'], { cwd, encoding: 'utf-8' }).trim(), '');
        mkdirSync(path.join(cwd, '.ao', 'state'), { recursive: true });
        writeFileSync(path.join(cwd, '.ao', 'state', 'runtime.json'), '{}\n');
        assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf-8' }), '');
        writeFileSync(path.join(cwd, 'marker.txt'), 'fixed\n');
        return { status: 'completed' };
      },
      k: 1,
      runId: 'committed-seed-head',
      resultsDir: path.join(tmpRoot, 'results'),
    });
    assert.equal(inspected, true);
    assert.equal(result.exitCode, 0);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
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
    assert.equal(result.summary.modelTier, 'sonnet');
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
    assert.equal(result.summary.trials[0].modelTier, 'sonnet');
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
    assert.equal(lines[0].modelTier, 'sonnet');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('benchmark and pipeline protocol fingerprints are independent identities', () => {
  const tmpRoot = makeTmpDir();
  const copiedTask = path.join(tmpRoot, 'task');
  try {
    cpSync(REGRESSION_TASK, copiedTask, { recursive: true });
    const benchmarkBefore = fingerprintBenchmark(copiedTask);
    const protocolBefore = fingerprintPipelineProtocol();
    writeFileSync(path.join(copiedTask, 'seed', 'benchmark-change.txt'), 'changed benchmark\n');
    const benchmarkAfter = fingerprintBenchmark(copiedTask);
    const protocolAfter = fingerprintPipelineProtocol();

    assert.match(benchmarkBefore, /^[a-f0-9]{64}$/);
    assert.match(protocolBefore, /^[a-f0-9]{64}$/);
    assert.notEqual(benchmarkAfter, benchmarkBefore);
    assert.equal(protocolAfter, protocolBefore);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('pipeline protocol fingerprint follows local import closure without hashing SUT files', () => {
  const tmpRoot = makeTmpDir();
  const repoRoot = path.join(tmpRoot, 'repo');
  const root = path.join(repoRoot, 'root.mjs');
  const dependency = path.join(repoRoot, 'dependency.mjs');
  const cycle = path.join(repoRoot, 'cycle.js');
  const dynamic = path.join(repoRoot, 'dynamic.cjs');
  const unrelated = path.join(repoRoot, 'worker-spawn.mjs');
  try {
    mkdirSync(repoRoot);
    writeFileSync(root, [
      "import fs from 'node:fs';",
      "import packageValue from 'external-package';",
      "import './dependency';",
      "export { cycle } from './cycle.js';",
      "export const load = () => import('./dynamic.cjs', {});",
      'export { fs, packageValue };',
      '',
    ].join('\n'));
    writeFileSync(dependency, "import './root.mjs';\nexport const value = 1;\n");
    writeFileSync(cycle, 'export const cycle = true;\n');
    writeFileSync(dynamic, 'module.exports = 1;\n');
    writeFileSync(unrelated, 'export const worker = 1;\n');

    const options = { repoRoot, rootFiles: [root] };
    const paths = collectPipelineProtocolFiles(options).map((entry) => entry.relativePath);
    assert.deepEqual(paths, [
      'protocol/cycle.js',
      'protocol/dependency.mjs',
      'protocol/dynamic.cjs',
      'protocol/root.mjs',
    ]);
    const before = fingerprintPipelineProtocol(options);
    writeFileSync(unrelated, 'export const worker = 2;\n');
    assert.equal(fingerprintPipelineProtocol(options), before, 'unimported SUT must not affect protocol');
    writeFileSync(dependency, "import './root.mjs';\nexport const value = 2;\n");
    assert.notEqual(fingerprintPipelineProtocol(options), before, 'transitive dependency must affect protocol');

    const outside = path.join(tmpRoot, 'outside.mjs');
    writeFileSync(outside, 'export const outside = true;\n');
    writeFileSync(root, "import '../outside.mjs';\n");
    assert.throws(
      () => fingerprintPipelineProtocol(options),
      /escapes repository boundary/,
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }

  const productionPaths = collectPipelineProtocolFiles().map((entry) => entry.relativePath);
  assert.equal(productionPaths.includes('protocol/scripts/lib/recovery-claim.mjs'), true);
  assert.equal(productionPaths.some((value) => value.endsWith('/worker-spawn.mjs')), false);
  assert.equal(productionPaths.some((value) => /protocol\/(?:skills|agents)\//.test(value)), false);
});

test('runEval separates measured-baseline deltas, declared targets, and protocol review gates', async () => {
  const tmpRoot = makeTmpDir();
  try {
    const pluginSource = path.join(tmpRoot, 'plugin-source');
    mkdirSync(path.join(pluginSource, '.claude-plugin'), { recursive: true });
    writeFileSync(path.join(pluginSource, '.claude-plugin/plugin.json'), '{"name":"fixture"}\n');
    const fakeLiveSpawn = (_command, _args, options) => {
      cpSync(path.join(REGRESSION_TASK, 'solution'), options.cwd, { recursive: true, force: true });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      completeFakeLiveChild(child, options.cwd);
      return child;
    };
    const declaredTarget = await runEval(REGRESSION_TASK, {
      live: true,
      k: 3,
      runId: 'declared-target-k3',
      resultsDir: path.join(tmpRoot, 'results'),
      pluginDir: pluginSource,
      spawn: fakeLiveSpawn,
    });
    assert.equal(declaredTarget.summary.delta_vs_baseline, null);
    assert.equal(declaredTarget.summary.delta_vs_target, 0);
    assert.equal(declaredTarget.summary.baselineComparison.comparable, false);
    assert.equal(declaredTarget.summary.baselineComparison.decisionEligible, false);
    assert.equal(declaredTarget.summary.baselineComparison.reason, 'baseline-unmeasured');
    assert.equal(declaredTarget.summary.baselineComparison.provenance.source, 'declared-target');
    assert.equal(declaredTarget.summary.baselineProvenance.runId, null);

    const baselinePath = path.join(tmpRoot, 'live-baseline.json');
    const liveBaseline = readJson(path.join(REPO_ROOT, 'evals/baseline.json'));
    liveBaseline.tasks['fix-failing-test'] = {
      ...liveBaseline.tasks['fix-failing-test'],
      source: 'live',
      runId: 'trusted-sonnet-run',
      measuredAt: '2026-07-12T00:00:00.000Z',
      modelTier: 'sonnet',
    };
    writeFileSync(baselinePath, `${JSON.stringify(liveBaseline, null, 2)}\n`);
    const comparable = await runEval(REGRESSION_TASK, {
      live: true,
      k: 3,
      runId: 'baseline-k3',
      resultsDir: path.join(tmpRoot, 'results'),
      baselinePath,
      pluginDir: pluginSource,
      spawn: fakeLiveSpawn,
    });
    assert.equal(comparable.summary.delta_vs_baseline, 0);
    assert.equal(comparable.summary.delta_vs_target, null);
    assert.equal(comparable.summary.baselineComparison.comparable, true);
    assert.equal(comparable.summary.baselineComparison.decisionEligible, true);
    assert.equal(comparable.summary.baselineComparison.protocolGate.passed, true);
    assert.equal(comparable.summary.baselineComparison.provenance.source, 'live');

    const incomparable = await runEval(REGRESSION_TASK, {
      live: true,
      k: 1,
      runId: 'baseline-k1',
      resultsDir: path.join(tmpRoot, 'results'),
      baselinePath,
      pluginDir: pluginSource,
      spawn: fakeLiveSpawn,
    });
    assert.equal(incomparable.summary.delta_vs_baseline, null);
    assert.equal(incomparable.summary.baselineComparison.comparable, false);
    assert.equal(incomparable.summary.baselineComparison.reason, 'k-mismatch');

    const protocolMismatchPath = path.join(tmpRoot, 'protocol-mismatch-baseline.json');
    const protocolMismatchBaseline = structuredClone(liveBaseline);
    protocolMismatchBaseline.tasks['fix-failing-test'].pipelineProtocolFingerprint = 'f'.repeat(64);
    writeFileSync(protocolMismatchPath, `${JSON.stringify(protocolMismatchBaseline, null, 2)}\n`);
    const protocolMismatch = await runEval(REGRESSION_TASK, {
      live: true,
      k: 3,
      runId: 'baseline-protocol-mismatch',
      resultsDir: path.join(tmpRoot, 'results'),
      baselinePath: protocolMismatchPath,
      pluginDir: pluginSource,
      spawn: fakeLiveSpawn,
    });
    assert.equal(protocolMismatch.summary.delta_vs_baseline, 0, 'outcomes remain comparable');
    assert.equal(protocolMismatch.summary.baselineComparison.comparable, true);
    assert.equal(protocolMismatch.summary.baselineComparison.decisionEligible, false);
    assert.equal(protocolMismatch.summary.baselineComparison.protocolGate.passed, false);
    assert.equal(
      protocolMismatch.summary.baselineComparison.protocolGate.reason,
      'pipeline-protocol-mismatch',
    );

    const modelMismatchPath = path.join(tmpRoot, 'model-mismatch-baseline.json');
    const modelMismatchBaseline = structuredClone(liveBaseline);
    modelMismatchBaseline.tasks['fix-failing-test'].modelTier = 'opus';
    writeFileSync(modelMismatchPath, `${JSON.stringify(modelMismatchBaseline, null, 2)}\n`);
    const modelMismatch = await runEval(REGRESSION_TASK, {
      live: true,
      k: 3,
      runId: 'baseline-model-mismatch',
      resultsDir: path.join(tmpRoot, 'results'),
      baselinePath: modelMismatchPath,
      pluginDir: pluginSource,
      spawn: fakeLiveSpawn,
    });
    assert.equal(modelMismatch.summary.delta_vs_baseline, null);
    assert.equal(modelMismatch.summary.baselineComparison.reason, 'model-tier-mismatch');

    const fixture = await runEval(REGRESSION_TASK, {
      fixture: 'solution',
      k: 3,
      runId: 'fixture-not-comparable',
      resultsDir: path.join(tmpRoot, 'results'),
    });
    assert.equal(fixture.summary.baselineComparison.reason, 'non-live-run');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('runEval fails a trial when orchestration fails even if the resulting files grade green', async () => {
  const tmpRoot = makeTmpDir();
  try {
    const result = await runEval(SAMPLE_TASK, {
      fixture: {
        status: 'timeout',
        timedOut: true,
        mutate: (cwd) => writeFileSync(path.join(cwd, 'marker.txt'), 'fixed\n'),
      },
      runId: 'orchestration-timeout-is-red',
      resultsDir: path.join(tmpRoot, 'results'),
    });
    assert.equal(result.summary.passHatK, false);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.results[0].checks[0], {
      name: 'orchestrator-completed',
      pass: false,
      detail: 'orchestrator status=timeout, timedOut=true',
    });
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('capability task exit code follows pass@k and task metadata is schema-strict', async () => {
  const tmpRoot = makeTmpDir();
  const taskDir = path.join(tmpRoot, 'capability-task');
  cpSync(SAMPLE_TASK, taskDir, { recursive: true });
  const taskPath = path.join(taskDir, 'task.json');
  const task = readJson(taskPath);
  task.id = 'capability-sample';
  task.track = 'capability';
  task.k = 3;
  writeFileSync(taskPath, `${JSON.stringify(task, null, 2)}\n`);
  let trial = 0;
  try {
    const result = await runEval(taskDir, {
      fixture: (cwd) => {
        trial += 1;
        if (trial === 2) writeFileSync(path.join(cwd, 'marker.txt'), 'fixed\n');
        return { status: 'completed' };
      },
      resultsDir: path.join(tmpRoot, 'results'),
    });
    assert.deepEqual(result.results.map((row) => row.pass), [false, true, false]);
    assert.equal(result.summary.passAtK, true);
    assert.equal(result.summary.passHatK, false);
    assert.equal(result.exitCode, 0);

    delete task.k;
    task.modelTire = 'opus';
    writeFileSync(taskPath, `${JSON.stringify(task, null, 2)}\n`);
    await assert.rejects(
      () => runEval(taskDir, { fixture: 'pass', resultsDir: path.join(tmpRoot, 'invalid') }),
      /k is required.*unexpected property: modelTire/,
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('runEval rejects run ids that could escape the results directory', async () => {
  await assert.rejects(
    () => runEval(SAMPLE_TASK, { fixture: 'pass', runId: '../../escape' }),
    /Unsafe run id/,
  );
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
