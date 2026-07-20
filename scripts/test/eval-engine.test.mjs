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
  fingerprintComparableFixture,
  fingerprintPipelineProtocol,
  validateTaskDefinition,
} from '../../evals/lib/tasks.mjs';
import { aggregateTokenUsage, fingerprintTargetPrompt, runEval } from '../../evals/run.mjs';
import {
  createFinalizedEvalPipelineFixture,
  invokeAtlasEvalBootstrap,
} from './helpers/eval-pipeline-fixture.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SAMPLE_TASK = path.join(REPO_ROOT, 'evals/tasks/_sample');
const REGRESSION_TASK = path.join(REPO_ROOT, 'evals/tasks/fix-failing-test');
const EXECUTOR_ROLE_TASK = path.join(REPO_ROOT, 'evals/tasks/role-executor-scope');
const HEPHAESTUS_ROLE_TASK = path.join(REPO_ROOT, 'evals/tasks/role-hephaestus-scope');
const ATLAS_REGRESSION_TASKS = [
  'fix-failing-test',
  'fix-null-deref',
  'fix-off-by-one',
].map((id) => path.join(REPO_ROOT, 'evals', 'tasks', id));

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
  duration_ms: 10,
  total_cost_usd: 0.01,
  fast_mode_state: 'off',
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    speed: 'standard',
    service_tier: 'standard',
  },
  modelUsage: { 'claude-sonnet-test': {} },
}) {
  invokeAtlasEvalBootstrap(cwd);
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

test('Atlas regression treatments match the skill model and timeout contract', () => {
  const skill = readFileSync(path.join(REPO_ROOT, 'skills/atlas/SKILL.md'), 'utf8');
  assert.match(skill, /^model: opus$/m);
  for (const taskDir of ATLAS_REGRESSION_TASKS) {
    const task = readJson(path.join(taskDir, 'task.json'));
    assert.equal(task.orchestrator, 'atlas');
    assert.equal(task.modelTier, 'opus');
    assert.equal(task.timeoutMs, 180_000);
  }
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
    assert.equal(Object.hasOwn(calls[0].opts.env, 'DISABLE_AO'), false);
    assert.equal(calls[0].args[0], '-p');
    assert.equal(calls[0].args[1], '/agent-olympus:atlas do the thing');
    assert.equal(calls[0].args.includes('--plugin-dir'), true);
    assert.equal(calls[0].args[calls[0].args.indexOf('--setting-sources') + 1], 'project');
    assert.equal(calls[0].args[calls[0].args.indexOf('--plugin-dir') + 1], pluginDir);
    assert.equal(calls[0].args.includes('--model'), true);
    assert.equal(calls[0].args[calls[0].args.indexOf('--prompt-suggestions') + 1], 'false');
    assert.equal(calls[0].args[calls[0].args.indexOf('--effort') + 1], 'high');
    assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'opus');
    assert.equal(result.raw.modelTier, 'opus');
    assert.equal(calls[0].args.includes('--bare'), false);
    assert.equal(calls[0].args.includes('--dangerously-skip-permissions'), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runOrchestrator solo control uses a plain prompt instead of a nonexistent plugin command', async () => {
  const cwd = makeTmpDir();
  const calls = [];
  try {
    const result = await runOrchestrator({
      orchestrator: 'solo',
      prompt: 'do the thing without orchestration',
      cwd,
      spawn: (command, args) => {
        calls.push({ command, args });
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => true;
        process.nextTick(() => {
          child.stdout.end(`${JSON.stringify({
            type: 'result', subtype: 'success', is_error: false,
          })}\n`);
          child.emit('close', 0, null);
        });
        return child;
      },
    });

    assert.equal(result.status, 'completed');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[1], 'do the thing without orchestration');
    assert.equal(calls[0].args[1].startsWith('/solo'), false);
    assert.equal(calls[0].args.includes('--safe-mode'), true);
    assert.equal(calls[0].args.includes('--plugin-dir'), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runOrchestrator direct-agent path selects a namespaced plugin agent safely', async () => {
  const cwd = makeTmpDir();
  const calls = [];
  try {
    const spawn = (command, args, opts) => {
      calls.push({ command, args, opts });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      process.nextTick(() => {
        child.stdout.end(`${JSON.stringify({
          type: 'result', subtype: 'success', is_error: false,
        })}\n`);
        child.emit('close', 0, null);
      });
      return child;
    };
    const result = await runOrchestrator({
      orchestrator: 'agent',
      agentName: 'executor',
      prompt: 'make the bounded change',
      cwd,
      modelTier: 'sonnet',
      maxBudgetUsd: 1,
      spawn,
    });

    assert.equal(result.status, 'completed');
    assert.equal(calls[0].args[1], 'make the bounded change');
    assert.equal(calls[0].args[calls[0].args.indexOf('--agent') + 1], 'agent-olympus:executor');
    assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'sonnet');
    assert.equal(calls[0].args[calls[0].args.indexOf('--max-budget-usd') + 1], '1');
    assert.equal(calls[0].args[calls[0].args.indexOf('--setting-sources') + 1], 'project');
    assert.equal(calls[0].opts.env.DISABLE_AO, '1');
    assert.deepEqual(result.invocation, {
      route: 'direct-agent',
      target: 'agent-olympus:executor',
      promptMode: 'plain',
      pluginHooksEnabled: false,
      customizationBoundary: 'project-settings-only',
      promptSuggestions: false,
      effort: 'high',
      modelSelector: 'sonnet',
      maxBudgetUsd: 1,
      observedModels: [],
    });

    let unbudgetedSpawned = false;
    const unbudgeted = await runOrchestrator({
      orchestrator: 'agent',
      agentName: 'executor',
      prompt: 'ignored',
      cwd,
      spawn: () => { unbudgetedSpawned = true; },
    });
    assert.equal(unbudgeted.status, 'failed');
    assert.match(unbudgeted.finalEvent.message, /require maxBudgetUsd/);
    assert.equal(unbudgetedSpawned, false);

    let unsafeSpawned = false;
    const unsafe = await runOrchestrator({
      orchestrator: 'agent',
      agentName: '--help',
      prompt: 'ignored',
      cwd,
      spawn: () => { unsafeSpawned = true; },
    });
    assert.equal(unsafe.status, 'failed');
    assert.match(unsafe.finalEvent.message, /Unsafe Agent Olympus agent selector/);
    assert.equal(unsafeSpawned, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('direct-agent task definitions are capability-only and name bundled agents', () => {
  const base = readJson(path.join(SAMPLE_TASK, 'task.json'));
  assert.equal(validateTaskDefinition(base), base, 'existing tasks remain valid');

  const valid = {
    ...base,
    track: 'capability',
    orchestrator: 'agent',
    agent: 'executor',
    maxBudgetUsd: 1,
  };
  assert.equal(validateTaskDefinition(valid), valid);
  assert.throws(
    () => validateTaskDefinition({ ...valid, agent: undefined }),
    /bundled Agent Olympus agent/,
  );
  const missing = { ...valid };
  delete missing.agent;
  assert.throws(() => validateTaskDefinition(missing), /agent is required/);
  const unbudgeted = { ...valid };
  delete unbudgeted.maxBudgetUsd;
  assert.throws(() => validateTaskDefinition(unbudgeted), /maxBudgetUsd is required/);
  assert.throws(
    () => validateTaskDefinition({ ...valid, maxBudgetUsd: 0 }),
    /maxBudgetUsd must be a finite number/,
  );
  assert.throws(
    () => validateTaskDefinition({ ...valid, agent: '--help' }),
    /bundled Agent Olympus agent/,
  );
  assert.throws(
    () => validateTaskDefinition({ ...valid, agent: 'other-plugin:executor' }),
    /bundled Agent Olympus agent/,
  );
  assert.throws(
    () => validateTaskDefinition({ ...valid, track: 'regression' }),
    /direct-agent tasks must use capability track/,
  );
  assert.throws(
    () => validateTaskDefinition({ ...base, agent: 'executor' }),
    /agent is only allowed when orchestrator is agent/,
  );
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
  mkdirSync(path.join(pluginSource, 'skills/atlas'), { recursive: true });
  mkdirSync(path.join(pluginSource, 'evals/tasks/demo/solution'), { recursive: true });
  writeFileSync(path.join(pluginSource, '.claude-plugin/plugin.json'), '{"name":"fixture"}\n');
  writeFileSync(path.join(pluginSource, 'skills/atlas/SKILL.md'), '# Atlas fixture\n');
  writeFileSync(path.join(pluginSource, 'skills/atlas/reference.md'), '# Atlas reference\n');
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
        duration_ms: 10,
        total_cost_usd: 0.01,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      return child;
    };

    const result = await runEval(REGRESSION_TASK, {
      live: true,
      maxBudgetUsd: 1,
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

test('runEval direct-agent live path preserves target identity and makes pipeline evidence N/A', async () => {
  const tempRoot = makeTmpDir('ao-eval-direct-agent-');
  const taskDir = path.join(tempRoot, 'task');
  const pluginSource = path.join(tempRoot, 'plugin-source');
  cpSync(SAMPLE_TASK, taskDir, { recursive: true });
  mkdirSync(path.join(pluginSource, '.claude-plugin'), { recursive: true });
  mkdirSync(path.join(pluginSource, 'agents'), { recursive: true });
  mkdirSync(path.join(pluginSource, 'hooks'), { recursive: true });
  writeFileSync(
    path.join(pluginSource, '.claude-plugin/plugin.json'),
    '{"name":"agent-olympus"}\n',
  );
  writeFileSync(path.join(pluginSource, 'agents/executor.md'), '---\nname: executor\n---\n');
  writeFileSync(path.join(pluginSource, 'hooks/hooks.json'), '{"hooks":{}}\n');
  const task = readJson(path.join(taskDir, 'task.json'));
  writeFileSync(path.join(taskDir, 'task.json'), `${JSON.stringify({
    ...task,
    id: 'direct-agent-sample',
    track: 'capability',
    orchestrator: 'agent',
    agent: 'executor',
    maxBudgetUsd: 1,
  }, null, 2)}\n`);
  const resultsDir = path.join(tempRoot, 'results');
  const calls = [];

  try {
    const result = await runEval(taskDir, {
      live: true,
      k: 1,
      runId: 'direct-agent-live',
      resultsDir,
      pluginDir: pluginSource,
      claudeCliVersion: '2.1.209',
      spawn: (_command, args, options) => {
        calls.push(args);
        const stagedPluginDir = args[args.indexOf('--plugin-dir') + 1];
        assert.equal(existsSync(path.join(stagedPluginDir, 'agents/executor.md')), true);
        assert.equal(existsSync(path.join(stagedPluginDir, 'hooks')), false);
        assert.equal(options.env.DISABLE_AO, '1');
        writeFileSync(path.join(options.cwd, 'marker.txt'), 'fixed\n');
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => true;
        process.nextTick(() => {
          child.stdout.end(`${JSON.stringify({
            type: 'result',
            subtype: 'success',
            is_error: false,
            duration_ms: 25,
            total_cost_usd: 0.01,
            fast_mode_state: 'off',
            usage: {
              input_tokens: 2,
              output_tokens: 1,
              speed: 'standard',
              service_tier: 'standard',
            },
            modelUsage: { 'claude-sonnet-test': { inputTokens: 2, outputTokens: 1 } },
          })}\n`);
          child.emit('close', 0, null);
        });
        return child;
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0][calls[0].indexOf('--agent') + 1], 'agent-olympus:executor');
    assert.equal(calls[0][calls[0].indexOf('--prompt-suggestions') + 1], 'false');
    assert.equal(calls[0][calls[0].indexOf('--effort') + 1], 'high');
    assert.equal(calls[0][calls[0].indexOf('--max-budget-usd') + 1], '1');
    assert.equal(result.exitCode, 0);
    assert.equal(result.results[0].agent, 'executor');
    assert.equal(result.results[0].pipelineEvidence.required, false);
    assert.equal(result.results[0].pipelineEvidence.reason, 'agent-orchestrator');
    assert.equal(result.results[0].claudeCliVersion, '2.1.209');
    assert.match(result.results[0].pluginProvenance.fingerprint, /^[a-f0-9]{64}$/);
    assert.match(result.results[0].pluginProvenance.targetPromptFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(result.results[0].pluginProvenance.hooksIncluded, false);
    assert.equal(result.results[0].orchestration.invocation.target, 'agent-olympus:executor');
    assert.equal(result.results[0].orchestration.invocation.promptSuggestions, false);
    assert.equal(result.results[0].orchestration.invocation.effort, 'high');
    assert.deepEqual(
      result.results[0].orchestration.invocation.observedModels,
      ['claude-sonnet-test'],
    );
    assert.equal(result.results[0].provenanceComplete, true);
    assert.equal(result.results[0].outcomePass, true);
    assert.equal(result.summary.agent, 'executor');
    assert.equal(result.summary.claudeCliVersion, '2.1.209');
    assert.equal(result.summary.pluginProvenance.hooksIncluded, false);
    assert.deepEqual(result.summary.providerRuntime, {
      effort: 'high',
      efforts: ['high'],
      fastModeStates: ['off'],
      usageSpeeds: ['standard'],
      serviceTiers: ['standard'],
    });
    assert.equal(
      result.summary.pluginProvenance.targetPromptFingerprint,
      result.results[0].pluginProvenance.targetPromptFingerprint,
    );
    assert.equal(result.summary.tasks[0].agent, 'executor');
    assert.equal(result.summary.trials[0].agent, 'executor');
    assert.equal(result.summary.pipelineEvidence.required, false);

    const incomplete = await runEval(taskDir, {
      live: true,
      k: 1,
      runId: 'direct-agent-incomplete-provenance',
      resultsDir,
      pluginDir: pluginSource,
      claudeCliVersion: '2.1.209',
      spawn: (_command, _args, options) => {
        writeFileSync(path.join(options.cwd, 'marker.txt'), 'fixed\n');
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => true;
        process.nextTick(() => {
          child.stdout.end(`${JSON.stringify({
            type: 'result', subtype: 'success', is_error: false,
            duration_ms: 25,
            fast_mode_state: 'off',
            usage: { input_tokens: 1, output_tokens: 1, speed: 'standard' },
            modelUsage: { 'claude-sonnet-test': { inputTokens: 1, outputTokens: 1 } },
          })}\n`);
          child.emit('close', 0, null);
        });
        return child;
      },
    });
    assert.equal(incomplete.exitCode, 1);
    assert.equal(incomplete.results[0].checks.some((check) => (
      check.name === 'direct-agent-provenance' && check.pass === false
    )), true);
    assert.match(
      incomplete.results[0].checks.find((check) => check.name === 'direct-agent-provenance').detail,
      /service-tier/,
    );
    assert.equal(incomplete.results[0].checks.some((check) => (
      check.name === 'marker.txt contains fixed' && check.pass === true
    )), true, 'a green task outcome cannot hide incomplete live provenance');
    assert.equal(incomplete.results[0].outcomePass, true);
    assert.equal(incomplete.summary.outcomePassAtK, true);
    assert.equal(incomplete.summary.budgetCompliant, false);
    assert.equal(incomplete.results[0].checks.some((check) => (
      check.name === 'trial-budget-compliance'
      && check.pass === false
      && /did not report trial cost/.test(check.detail)
    )), true);

    let consistencyTrial = 0;
    const mixedTreatment = await runEval(taskDir, {
      live: true,
      k: 2,
      runId: 'direct-agent-mixed-treatment',
      resultsDir,
      pluginDir: pluginSource,
      claudeCliVersion: '2.1.209',
      spawn: (_command, _args, options) => {
        consistencyTrial += 1;
        writeFileSync(path.join(options.cwd, 'marker.txt'), 'fixed\n');
        if (consistencyTrial === 1) {
          writeFileSync(
            path.join(pluginSource, 'agents/executor.md'),
            '---\nname: executor\n---\nchanged between trials\n',
          );
        }
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => true;
        process.nextTick(() => {
          child.stdout.end(`${JSON.stringify({
            type: 'result', subtype: 'success', is_error: false,
            duration_ms: 10, total_cost_usd: 0.01,
            usage: { input_tokens: 1, output_tokens: 1 },
            modelUsage: { 'claude-sonnet-test': {} },
          })}\n`);
          child.emit('close', 0, null);
        });
        return child;
      },
    });
    assert.equal(mixedTreatment.exitCode, 1);
    assert.equal(mixedTreatment.summary.provenanceComplete, false);
    assert.equal(mixedTreatment.results.every((trialResult) => (
      trialResult.checks.some((check) => (
        check.name === 'direct-agent-treatment-consistency' && check.pass === false
      ))
    )), true);

    let overBudgetCalls = 0;
    const overBudget = await runEval(taskDir, {
      live: true,
      k: 2,
      runId: 'direct-agent-budget-stop',
      resultsDir,
      pluginDir: pluginSource,
      claudeCliVersion: '2.1.209',
      spawn: (_command, _args, options) => {
        overBudgetCalls += 1;
        writeFileSync(path.join(options.cwd, 'marker.txt'), 'fixed\n');
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => true;
        process.nextTick(() => {
          child.stdout.end(`${JSON.stringify({
            type: 'result', subtype: 'success', is_error: false,
            duration_ms: 10, total_cost_usd: 1.01,
            usage: { input_tokens: 1, output_tokens: 1 },
            modelUsage: { 'claude-sonnet-test': {} },
          })}\n`);
          child.emit('close', 0, null);
        });
        return child;
      },
    });
    assert.equal(overBudgetCalls, 1, 'an overshoot must stop scheduling later trials');
    assert.equal(overBudget.exitCode, 1);
    assert.equal(overBudget.summary.budgetCompliant, false);
    assert.equal(overBudget.summary.completedTrials, 1);
    assert.equal(overBudget.summary.outcomePassAtK, true);
    assert.equal(overBudget.summary.outcomePassHatK, false);
    assert.equal(overBudget.summary.passAtK, false);
    assert.equal(overBudget.results[0].outcomePass, true);
    assert.equal(overBudget.results[0].checks.some((check) => (
      check.name === 'trial-budget-compliance' && check.pass === false
    )), true);
    assert.equal(overBudget.results[0].checks.some((check) => (
      check.name === 'run-budget-compliance' && check.pass === false
    )), true);
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

test('direct-agent target identity changes the benchmark fingerprint', () => {
  const tmpRoot = makeTmpDir();
  const copiedTask = path.join(tmpRoot, 'task');
  try {
    cpSync(SAMPLE_TASK, copiedTask, { recursive: true });
    const taskPath = path.join(copiedTask, 'task.json');
    const task = readJson(taskPath);
    writeFileSync(taskPath, `${JSON.stringify({
      ...task,
      track: 'capability',
      orchestrator: 'agent',
      agent: 'executor',
      maxBudgetUsd: 1,
    }, null, 2)}\n`);
    const executorFingerprint = fingerprintBenchmark(copiedTask);
    const executorFixtureFingerprint = fingerprintComparableFixture(copiedTask);
    const hephaestusTask = { ...readJson(taskPath), agent: 'hephaestus' };
    writeFileSync(taskPath, `${JSON.stringify(hephaestusTask, null, 2)}\n`);
    const hephaestusFingerprint = fingerprintBenchmark(copiedTask);
    const hephaestusFixtureFingerprint = fingerprintComparableFixture(copiedTask);
    assert.notEqual(hephaestusFingerprint, executorFingerprint);
    assert.equal(hephaestusFixtureFingerprint, executorFixtureFingerprint);

    const soloControl = { ...hephaestusTask, orchestrator: 'solo' };
    delete soloControl.agent;
    delete soloControl.maxBudgetUsd;
    writeFileSync(taskPath, `${JSON.stringify(soloControl, null, 2)}\n`);
    assert.equal(fingerprintComparableFixture(copiedTask), executorFixtureFingerprint);

    writeFileSync(taskPath, `${JSON.stringify({
      ...soloControl,
      prompt: `${hephaestusTask.prompt} Different treatment.`,
    }, null, 2)}\n`);
    assert.notEqual(fingerprintComparableFixture(copiedTask), executorFixtureFingerprint);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Atlas target prompt identity includes its progressive-disclosure reference', () => {
  const skillFingerprint = 'a'.repeat(64);
  const referenceFingerprint = 'b'.repeat(64);
  const task = { orchestrator: 'atlas' };
  const strict = fingerprintTargetPrompt(task, {
    'skills/atlas/SKILL.md': skillFingerprint,
  });
  assert.equal(strict.targetPromptFingerprint, null);
  assert.deepEqual(strict.missingTargetPromptPaths, ['skills/atlas/reference.md']);

  const legacy = fingerprintTargetPrompt(task, {
    'skills/atlas/SKILL.md': skillFingerprint,
  }, { allowLegacySingleFile: true });
  assert.equal(legacy.targetPromptFingerprint, skillFingerprint);

  const composite = fingerprintTargetPrompt(task, {
    'skills/atlas/SKILL.md': skillFingerprint,
    'skills/atlas/reference.md': referenceFingerprint,
  });
  assert.match(composite.targetPromptFingerprint, /^[a-f0-9]{64}$/);
  assert.notEqual(composite.targetPromptFingerprint, skillFingerprint);
  assert.notEqual(
    fingerprintTargetPrompt(task, {
      'skills/atlas/SKILL.md': skillFingerprint,
      'skills/atlas/reference.md': 'c'.repeat(64),
    }).targetPromptFingerprint,
    composite.targetPromptFingerprint,
  );

  assert.equal(
    fingerprintTargetPrompt(
      { orchestrator: 'agent', agent: 'executor' },
      { 'agents/executor.md': skillFingerprint },
    ).targetPromptFingerprint,
    skillFingerprint,
  );

  const athenaStrict = fingerprintTargetPrompt({ orchestrator: 'athena' }, {
    'skills/athena/SKILL.md': skillFingerprint,
  });
  assert.equal(athenaStrict.targetPromptFingerprint, null);
  assert.deepEqual(athenaStrict.missingTargetPromptPaths, ['skills/atlas/reference.md']);
});

test('live Atlas and Athena evals reject incomplete target prompt resource sets', async () => {
  const tmpRoot = makeTmpDir('ao-eval-prompt-resources-');
  try {
    for (const orchestrator of ['atlas', 'athena']) {
      const taskDir = path.join(tmpRoot, `task-${orchestrator}`);
      const pluginSource = path.join(tmpRoot, `plugin-${orchestrator}`);
      cpSync(SAMPLE_TASK, taskDir, { recursive: true });
      const taskPath = path.join(taskDir, 'task.json');
      const task = readJson(taskPath);
      writeFileSync(taskPath, `${JSON.stringify({
        ...task,
        id: `missing-${orchestrator}-prompt-resource`,
        orchestrator,
      }, null, 2)}\n`);
      mkdirSync(path.join(pluginSource, '.claude-plugin'), { recursive: true });
      mkdirSync(path.join(pluginSource, 'skills', orchestrator), { recursive: true });
      writeFileSync(
        path.join(pluginSource, '.claude-plugin', 'plugin.json'),
        '{"name":"fixture"}\n',
      );
      writeFileSync(
        path.join(pluginSource, 'skills', orchestrator, 'SKILL.md'),
        `# ${orchestrator} fixture\n`,
      );

      await assert.rejects(
        runEval(taskDir, {
          live: true,
          k: 1,
          pluginDir: pluginSource,
          resultsDir: path.join(tmpRoot, `results-${orchestrator}`),
          maxBudgetUsd: 1,
          claudeCliVersion: '2.1.209',
          spawn: () => {
            throw new Error('live spawn must not occur with missing prompt resources');
          },
        }),
        /missing target prompt resource\(s\): skills\/atlas\/reference\.md/,
      );
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Executor and Hephaestus paired arms share one comparable fixture', () => {
  const executor = readJson(path.join(EXECUTOR_ROLE_TASK, 'task.json'));
  const hephaestus = readJson(path.join(HEPHAESTUS_ROLE_TASK, 'task.json'));
  assert.equal(executor.prompt, hephaestus.prompt);
  assert.equal(
    fingerprintComparableFixture(EXECUTOR_ROLE_TASK),
    fingerprintComparableFixture(HEPHAESTUS_ROLE_TASK),
  );
  assert.notEqual(fingerprintBenchmark(EXECUTOR_ROLE_TASK), fingerprintBenchmark(HEPHAESTUS_ROLE_TASK));
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
    mkdirSync(path.join(pluginSource, 'skills/atlas'), { recursive: true });
    writeFileSync(path.join(pluginSource, '.claude-plugin/plugin.json'), '{"name":"fixture"}\n');
    writeFileSync(path.join(pluginSource, 'skills/atlas/SKILL.md'), '# Atlas fixture\n');
    writeFileSync(path.join(pluginSource, 'skills/atlas/reference.md'), '# Atlas reference\n');
    const fakeLiveSpawn = (_command, _args, options) => {
      invokeAtlasEvalBootstrap(options.cwd);
      cpSync(path.join(REGRESSION_TASK, 'solution'), options.cwd, { recursive: true, force: true });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      completeFakeLiveChild(child, options.cwd);
      return child;
    };
    const liveCommon = {
      pluginDir: pluginSource,
      spawn: fakeLiveSpawn,
      claudeCliVersion: '2.1.209',
      maxBudgetUsd: 1,
    };
    const declaredTarget = await runEval(REGRESSION_TASK, {
      ...liveCommon,
      live: true,
      k: 3,
      runId: 'declared-target-k3',
      resultsDir: path.join(tmpRoot, 'results'),
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
      runId: 'trusted-opus-run',
      measuredAt: '2026-07-12T00:00:00.000Z',
      modelTier: declaredTarget.summary.modelTier,
      pipelineProtocolFingerprint: declaredTarget.summary.pipelineProtocolFingerprint,
      claudeCliVersion: declaredTarget.summary.claudeCliVersion,
      pluginFingerprint: declaredTarget.summary.pluginProvenance.fingerprint,
      targetPromptFingerprint: declaredTarget.summary.pluginProvenance.targetPromptFingerprint,
      observedModels: declaredTarget.summary.observedModels,
      maxBudgetUsd: declaredTarget.summary.maxBudgetUsd,
      providerRuntime: declaredTarget.summary.providerRuntime,
    };
    writeFileSync(baselinePath, `${JSON.stringify(liveBaseline, null, 2)}\n`);
    const comparable = await runEval(REGRESSION_TASK, {
      ...liveCommon,
      live: true,
      k: 3,
      runId: 'baseline-k3',
      resultsDir: path.join(tmpRoot, 'results'),
      baselinePath,
    });
    assert.equal(comparable.summary.delta_vs_baseline, 0);
    assert.equal(comparable.summary.delta_vs_target, null);
    assert.equal(comparable.summary.baselineComparison.comparable, true);
    assert.equal(comparable.summary.baselineComparison.decisionEligible, true);
    assert.equal(comparable.summary.baselineComparison.protocolGate.passed, true);
    assert.equal(comparable.summary.baselineComparison.provenance.source, 'live');

    const incomparable = await runEval(REGRESSION_TASK, {
      ...liveCommon,
      live: true,
      k: 1,
      runId: 'baseline-k1',
      resultsDir: path.join(tmpRoot, 'results'),
      baselinePath,
    });
    assert.equal(incomparable.summary.delta_vs_baseline, null);
    assert.equal(incomparable.summary.baselineComparison.comparable, false);
    assert.equal(incomparable.summary.baselineComparison.reason, 'k-mismatch');

    const protocolMismatchPath = path.join(tmpRoot, 'protocol-mismatch-baseline.json');
    const protocolMismatchBaseline = structuredClone(liveBaseline);
    protocolMismatchBaseline.tasks['fix-failing-test'].pipelineProtocolFingerprint = 'f'.repeat(64);
    writeFileSync(protocolMismatchPath, `${JSON.stringify(protocolMismatchBaseline, null, 2)}\n`);
    const protocolMismatch = await runEval(REGRESSION_TASK, {
      ...liveCommon,
      live: true,
      k: 3,
      runId: 'baseline-protocol-mismatch',
      resultsDir: path.join(tmpRoot, 'results'),
      baselinePath: protocolMismatchPath,
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
    modelMismatchBaseline.tasks['fix-failing-test'].modelTier = 'sonnet';
    writeFileSync(modelMismatchPath, `${JSON.stringify(modelMismatchBaseline, null, 2)}\n`);
    const modelMismatch = await runEval(REGRESSION_TASK, {
      ...liveCommon,
      live: true,
      k: 3,
      runId: 'baseline-model-mismatch',
      resultsDir: path.join(tmpRoot, 'results'),
      baselinePath: modelMismatchPath,
    });
    assert.equal(modelMismatch.summary.delta_vs_baseline, null);
    assert.equal(modelMismatch.summary.baselineComparison.reason, 'model-tier-mismatch');

    const budgetMismatchPath = path.join(tmpRoot, 'budget-mismatch-baseline.json');
    const budgetMismatchBaseline = structuredClone(liveBaseline);
    budgetMismatchBaseline.tasks['fix-failing-test'].maxBudgetUsd = 0.5;
    writeFileSync(budgetMismatchPath, `${JSON.stringify(budgetMismatchBaseline, null, 2)}\n`);
    const budgetMismatch = await runEval(REGRESSION_TASK, {
      ...liveCommon,
      live: true,
      k: 3,
      runId: 'baseline-budget-mismatch',
      resultsDir: path.join(tmpRoot, 'results'),
      baselinePath: budgetMismatchPath,
    });
    assert.equal(budgetMismatch.summary.delta_vs_baseline, null);
    assert.equal(budgetMismatch.summary.baselineComparison.reason, 'max-budget-mismatch');

    const providerRuntimeMismatchPath = path.join(tmpRoot, 'provider-runtime-mismatch-baseline.json');
    const providerRuntimeMismatchBaseline = structuredClone(liveBaseline);
    providerRuntimeMismatchBaseline.tasks['fix-failing-test'].providerRuntime.usageSpeeds = ['priority'];
    writeFileSync(
      providerRuntimeMismatchPath,
      `${JSON.stringify(providerRuntimeMismatchBaseline, null, 2)}\n`,
    );
    const providerRuntimeMismatch = await runEval(REGRESSION_TASK, {
      ...liveCommon,
      live: true,
      k: 3,
      runId: 'baseline-provider-runtime-mismatch',
      resultsDir: path.join(tmpRoot, 'results'),
      baselinePath: providerRuntimeMismatchPath,
    });
    assert.equal(providerRuntimeMismatch.summary.delta_vs_baseline, null);
    assert.equal(
      providerRuntimeMismatch.summary.baselineComparison.reason,
      'provider-runtime-mismatch',
    );

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
