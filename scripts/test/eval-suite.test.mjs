import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildTrend } from '../../evals/report.mjs';
import { runSuite } from '../../evals/run-suite.mjs';
import { discoverTasks } from '../../evals/lib/tasks.mjs';
import { verifyRegressionFixtures } from '../../evals/verify-fixtures.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const EVALS_DIR = path.join(REPO_ROOT, 'evals');

function mode(filePath) {
  return statSync(filePath).mode & 0o777;
}

function createLiveSuiteTasks(tempRoot, count = 3) {
  const evalsDir = path.join(tempRoot, 'evals');
  for (let index = 1; index <= count; index += 1) {
    const taskDir = path.join(evalsDir, 'tasks', `task-${index}`);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({
      schemaVersion: 1,
      id: `task-${index}`,
      track: 'capability',
      orchestrator: 'atlas',
      prompt: `bounded live task ${index}`,
      difficulty: 'S',
      timeoutMs: 1,
      modelTier: 'sonnet',
      k: 1,
    }));
  }
  return evalsDir;
}

function fakeLiveRun(taskDir, {
  costUsd = 0,
  budgetCompliant = true,
  trialCount = 1,
  reportedCostTrials = trialCount,
} = {}) {
  const task = JSON.parse(readFileSync(path.join(taskDir, 'task.json'), 'utf-8'));
  const providerMetrics = {
    totalCostUsd: costUsd,
    durationMs: 1,
    apiDurationMs: 1,
    turns: 1,
    reportedCostTrials,
    reportedDurationTrials: 1,
    reportedTurnTrials: 1,
  };
  return {
    summary: {
      budgetCompliant,
      providerMetrics,
      tasks: [{
        task: task.id,
        track: task.track,
        modelTier: task.modelTier,
        passHatK: true,
        passAtK: true,
        budgetCompliant,
        providerMetrics,
      }],
    },
    results: Array.from({ length: trialCount }, () => ({ task: task.id, usage: null })),
  };
}

test('runSuite aggregates both tracks, trials, tokens, baseline deltas, and secure modes', async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'ao-eval-suite-'));
  try {
    const result = await runSuite({
      evalsDir: EVALS_DIR,
      fixture: 'solution',
      k: 1,
      runId: 'suite-all-green',
      resultsDir: tempRoot,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.summary.taskCount, 8);
    assert.equal(result.summary.passHatK, true);
    assert.equal(result.summary.passAtK, true);
    assert.equal(result.summary.regressionGatePassed, true);
    assert.deepEqual(result.summary.modelTiers, ['opus', 'sonnet']);
    assert.deepEqual(result.summary.tracks, [
      { track: 'capability', total: 5, passed: 5 },
      { track: 'regression', total: 3, passed: 3 },
    ]);
    assert.equal(result.summary.tokenUsage.totalTokens, 0);
    assert.equal(result.summary.tokenUsage.reportedTrials, 0);
    assert.equal(result.summary.tasks
      .filter((task) => task.track === 'regression')
      .every((task) => task.delta_vs_baseline === null
        && task.baselineComparison.comparable === false
        && task.baselineComparison.reason === 'non-live-run'), true);

    const resultLines = readFileSync(path.join(result.runDir, 'results.jsonl'), 'utf-8')
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(resultLines.length, 8);
    assert.equal(resultLines.every((row) => row.runId === 'suite-all-green'), true);
    assert.equal(mode(result.runDir), 0o700);
    assert.equal(mode(path.join(result.runDir, 'summary.json')), 0o600);
    assert.equal(mode(path.join(result.runDir, 'results.jsonl')), 0o600);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('suite rejects ambiguous execution modes and non-atomic baseline refresh', async () => {
  await assert.rejects(
    () => runSuite({ evalsDir: EVALS_DIR, live: true, fixture: 'solution' }),
    /exactly one execution mode/,
  );
  await assert.rejects(
    () => runSuite({
      evalsDir: EVALS_DIR,
      fixture: 'solution',
      runId: '../escape',
    }),
    /Unsafe run id/,
  );
  await assert.rejects(
    () => runSuite({ evalsDir: EVALS_DIR, live: true, track: 'regression', updateBaseline: true }),
    /not atomic/,
  );
});

test('live suite requires explicit safe trial and aggregate budget controls before running tasks', async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'ao-eval-live-budget-validation-'));
  const evalsDir = createLiveSuiteTasks(tempRoot);
  let calls = 0;
  const runEvalImpl = async () => {
    calls += 1;
    throw new Error('live runner must not be called');
  };
  try {
    await assert.rejects(
      () => runSuite({ evalsDir, live: true, runEvalImpl }),
      /require explicit --track/,
    );
    await assert.rejects(
      () => runSuite({ evalsDir, live: true, track: 'all', runEvalImpl }),
      /require explicit --k/,
    );
    await assert.rejects(
      () => runSuite({ evalsDir, live: true, track: 'all', k: 1, runEvalImpl }),
      /require explicit --max-budget-usd/,
    );
    await assert.rejects(
      () => runSuite({
        evalsDir, live: true, track: 'all', k: 1, maxBudgetUsd: 1, runEvalImpl,
      }),
      /require explicit --max-total-budget-usd/,
    );
    await assert.rejects(
      () => runSuite({
        evalsDir,
        live: true,
        track: 'all',
        k: 0,
        maxBudgetUsd: 1,
        maxTotalBudgetUsd: 3,
        runEvalImpl,
      }),
      /--k must be a positive safe integer/,
    );
    await assert.rejects(
      () => runSuite({
        evalsDir,
        live: true,
        track: 'all',
        k: 1,
        maxBudgetUsd: Infinity,
        maxTotalBudgetUsd: 3,
        runEvalImpl,
      }),
      /--max-budget-usd must be a finite number/,
    );
    await assert.rejects(
      () => runSuite({
        evalsDir,
        live: true,
        track: 'all',
        k: 1,
        maxBudgetUsd: 101,
        maxTotalBudgetUsd: 303,
        runEvalImpl,
      }),
      /--max-budget-usd must be a finite number greater than 0 and at most 100/,
    );
    await assert.rejects(
      () => runSuite({
        evalsDir,
        live: true,
        track: 'all',
        k: 1,
        maxBudgetUsd: 1,
        maxTotalBudgetUsd: Number.NaN,
        runEvalImpl,
      }),
      /--max-total-budget-usd must be a finite number/,
    );
    await assert.rejects(
      () => runSuite({
        evalsDir,
        live: true,
        track: 'all',
        k: 2,
        maxBudgetUsd: 1,
        maxTotalBudgetUsd: 5.99,
        runEvalImpl,
      }),
      /Projected live suite budget \$6 exceeds --max-total-budget-usd \$5\.99/,
    );
    assert.equal(calls, 0);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('live suite passes the per-trial cap and stops with a nonzero exit at the aggregate cap', async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'ao-eval-live-budget-cap-'));
  const evalsDir = createLiveSuiteTasks(tempRoot);
  const calls = [];
  try {
    const result = await runSuite({
      evalsDir,
      live: true,
      track: 'all',
      k: '2',
      maxBudgetUsd: '1',
      maxTotalBudgetUsd: '6',
      runId: 'aggregate-cap-stop',
      resultsDir: path.join(tempRoot, 'results'),
      runEvalImpl: async (taskDir, opts) => {
        calls.push({ taskDir, opts });
        return fakeLiveRun(taskDir, { costUsd: 6, trialCount: 2 });
      },
    });

    assert.equal(calls.length, 1, 'no later paid task may be scheduled after the cap is reached');
    assert.equal(calls[0].opts.live, true);
    assert.equal(calls[0].opts.k, 2);
    assert.equal(calls[0].opts.maxBudgetUsd, 1);
    assert.equal(result.summary.schedulingComplete, false);
    assert.equal(result.summary.budgetCompliant, true);
    assert.equal(result.summary.passAtK, false);
    assert.equal(result.summary.liveBudget.stopReason, 'aggregate-budget-reached');
    assert.equal(result.summary.liveBudget.reportedCostUsd, 6);
    assert.equal(result.exitCode, 1);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('live suite stops scheduling and fails when a child run reports budget noncompliance', async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'ao-eval-live-child-budget-'));
  const evalsDir = createLiveSuiteTasks(tempRoot);
  let calls = 0;
  try {
    const result = await runSuite({
      evalsDir,
      live: true,
      track: 'all',
      k: 1,
      maxBudgetUsd: 1,
      maxTotalBudgetUsd: 3,
      runId: 'child-budget-stop',
      resultsDir: path.join(tempRoot, 'results'),
      runEvalImpl: async (taskDir) => {
        calls += 1;
        return fakeLiveRun(taskDir, { costUsd: 0.25, budgetCompliant: false });
      },
    });

    assert.equal(calls, 1);
    assert.equal(result.summary.schedulingComplete, false);
    assert.equal(result.summary.budgetCompliant, false);
    assert.equal(result.summary.liveBudget.stopReason, 'per-run-budget-noncompliance');
    assert.equal(result.exitCode, 1);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('live suite treats missing child cost reports as unknown and schedules no later task', async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'ao-eval-live-unknown-cost-'));
  const evalsDir = createLiveSuiteTasks(tempRoot);
  let calls = 0;
  try {
    const result = await runSuite({
      evalsDir,
      live: true,
      track: 'all',
      k: 1,
      maxBudgetUsd: 1,
      maxTotalBudgetUsd: 3,
      runId: 'unknown-cost-stop',
      resultsDir: path.join(tempRoot, 'results'),
      runEvalImpl: async (taskDir) => {
        calls += 1;
        return fakeLiveRun(taskDir, { costUsd: 0, reportedCostTrials: 0 });
      },
    });

    assert.equal(calls, 1);
    assert.equal(result.summary.schedulingComplete, false);
    assert.equal(result.summary.budgetCompliant, false);
    assert.equal(result.summary.liveBudget.stopReason, 'unknown-reported-cost');
    assert.equal(result.exitCode, 1);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('capability-only suite reports misses without failing the regression gate', async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'ao-eval-capability-'));
  try {
    const result = await runSuite({
      evalsDir: EVALS_DIR,
      track: 'capability',
      fixture: 'none',
      k: 1,
      runId: 'capability-red-is-report-only',
      resultsDir: tempRoot,
    });
    assert.equal(result.summary.passHatK, false);
    assert.equal(result.summary.regressionGatePassed, true);
    assert.equal(result.exitCode, 0);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('discoverTasks is sorted, track-aware, and rejects duplicate unsafe ids', () => {
  const regression = discoverTasks(path.join(EVALS_DIR, 'tasks'), 'regression');
  assert.deepEqual(regression.map(({ task }) => task.id), [
    'fix-failing-test',
    'fix-null-deref',
    'fix-off-by-one',
  ]);

  const tempRoot = mkdtempSync(path.join(tmpdir(), 'ao-eval-discovery-'));
  try {
    for (const name of ['one', 'two']) {
      const taskDir = path.join(tempRoot, name);
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({
        schemaVersion: 1,
        id: 'duplicate',
        track: 'regression',
        orchestrator: 'atlas',
        prompt: 'test',
        difficulty: 'S',
        timeoutMs: 1,
        modelTier: 'sonnet',
        k: 1,
      }));
    }
    assert.throws(() => discoverTasks(tempRoot), /Duplicate eval task id/);
    const unsafe = JSON.parse(readFileSync(path.join(tempRoot, 'two/task.json'), 'utf-8'));
    unsafe.id = '../unsafe';
    writeFileSync(path.join(tempRoot, 'two/task.json'), JSON.stringify(unsafe));
    assert.throws(() => discoverTasks(tempRoot), /Unsafe eval task id/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('verifyRegressionFixtures discovers every regression task and proves all GREEN and RED', async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'ao-eval-proof-'));
  try {
    const proof = await verifyRegressionFixtures({ evalsDir: EVALS_DIR, resultsDir: tempRoot });
    assert.deepEqual(proof.tasks, [
      { task: 'fix-failing-test', green: true, red: true },
      { task: 'fix-null-deref', green: true, red: true },
      { task: 'fix-off-by-one', green: true, red: true },
    ]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildTrend emits chronological per-track quality series and skips corrupt runs', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'ao-eval-trend-'));
  try {
    const fixtures = [
      ['newer', {
        schemaVersion: 1,
        runId: 'newer',
        executionMode: 'live',
        completedAt: '2026-07-12T02:00:00.000Z',
        tracks: [{ track: 'regression', total: 3, passed: 3 }],
        modelTier: 'opus',
        tasks: [{
          task: 'regression-new',
          track: 'regression',
          orchestrator: 'atlas',
          modelTier: 'opus',
          k: 3,
          benchmarkFingerprint: 'a'.repeat(64),
          pipelineProtocolFingerprint: 'd'.repeat(64),
          tokenUsage: { totalTokens: 20 },
        }],
        tokenUsage: { totalTokens: 20 },
      }],
      ['older', {
        schemaVersion: 1,
        runId: 'older',
        executionMode: 'live',
        completedAt: '2026-07-12T01:00:00.000Z',
        tracks: [
          { track: 'regression', total: 3, passed: 2 },
          { track: 'capability', total: 3, passed: 1 },
        ],
        tasks: [
          {
            task: 'regression-old', track: 'regression', orchestrator: 'atlas',
            modelTier: 'sonnet', k: 3, benchmarkFingerprint: 'b'.repeat(64),
            pipelineProtocolFingerprint: 'd'.repeat(64),
            tokenUsage: { totalTokens: 7 },
          },
          {
            task: 'capability-old', track: 'capability', orchestrator: 'atlas',
            modelTier: 'haiku', k: 3, benchmarkFingerprint: 'c'.repeat(64),
            pipelineProtocolFingerprint: 'e'.repeat(64),
            tokenUsage: { totalTokens: 3 },
          },
        ],
        tokenUsage: { totalTokens: 10 },
      }],
    ];
    for (const [dir, summary] of fixtures) {
      mkdirSync(path.join(tempRoot, dir), { recursive: true });
      writeFileSync(path.join(tempRoot, dir, 'summary.json'), JSON.stringify(summary));
    }
    mkdirSync(path.join(tempRoot, 'corrupt'));
    writeFileSync(path.join(tempRoot, 'corrupt/summary.json'), '{');
    mkdirSync(path.join(tempRoot, 'fixture-red'));
    writeFileSync(path.join(tempRoot, 'fixture-red/summary.json'), JSON.stringify({
      schemaVersion: 1,
      runId: 'fixture-red',
      executionMode: 'fixture',
      completedAt: '2026-07-12T03:00:00.000Z',
      tracks: [{ track: 'regression', total: 3, passed: 0 }],
      tokenUsage: { totalTokens: 0 },
    }));

    const trend = buildTrend(tempRoot);
    assert.deepEqual(trend.tracks.regression.map((point) => point.runId), ['older', 'newer']);
    assert.equal(trend.tracks.regression[0].passRate, 2 / 3);
    assert.equal(trend.tracks.regression[1].totalTokens, 20);
    assert.equal(trend.tracks.regression[1].modelTier, 'opus');
    assert.equal(trend.tracks.regression[1].k, 3);
    assert.deepEqual(trend.tracks.regression[1].ks, [3]);
    assert.match(trend.tracks.regression[1].benchmarkFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(trend.tracks.regression[1].pipelineProtocolFingerprint, 'd'.repeat(64));
    assert.deepEqual(trend.tracks.regression[1].pipelineProtocolFingerprints, ['d'.repeat(64)]);
    assert.notEqual(
      trend.tracks.regression[0].benchmarkFingerprint,
      trend.tracks.regression[1].benchmarkFingerprint,
    );
    assert.deepEqual(trend.tracks.regression[0].modelTiers, ['sonnet']);
    assert.deepEqual(trend.tracks.capability[0].modelTiers, ['haiku']);
    assert.deepEqual(trend.tracks.capability.map((point) => point.runId), ['older']);
    const withFixtures = buildTrend(tempRoot, { includeFixtures: true });
    assert.deepEqual(withFixtures.tracks.regression.map((point) => point.runId), [
      'older', 'newer', 'fixture-red',
    ]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildTrend falls back from a malformed runId before deterministic tie sorting', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'ao-eval-trend-run-id-'));
  try {
    const completedAt = '2026-07-12T01:00:00.000Z';
    for (const [dir, runId] of [['a-malformed', 7], ['z-valid', 'valid']]) {
      mkdirSync(path.join(tempRoot, dir), { recursive: true });
      writeFileSync(path.join(tempRoot, dir, 'summary.json'), JSON.stringify({
        schemaVersion: 1,
        runId,
        executionMode: 'live',
        completedAt,
        tracks: [{ track: 'regression', total: 1, passed: 1 }],
      }));
    }

    const trend = buildTrend(tempRoot);
    assert.deepEqual(
      trend.tracks.regression.map((point) => point.runId),
      ['a-malformed', 'valid'],
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildTrend emits safe deterministic direct-agent series without collapsing personas', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'ao-eval-agent-trend-'));
  const fingerprint = (character) => character.repeat(64);
  const writeSummary = (dir, summary) => {
    mkdirSync(path.join(tempRoot, dir), { recursive: true });
    writeFileSync(path.join(tempRoot, dir, 'summary.json'), JSON.stringify(summary));
  };
  const directSummary = ({
    agent,
    runId,
    completedAt,
    executionMode = 'live',
    reportedTrials = 1,
  }) => ({
    schemaVersion: 1,
    runId,
    completedAt,
    executionMode,
    tracks: [{ track: 'capability', total: 1, passed: 1 }],
    tasks: [{
      task: 'shared-role-task',
      track: 'capability',
      orchestrator: 'agent',
      agent,
      completedTrials: 3,
      outcomePassAtK: true,
      outcomePassHatK: true,
      passAtK: true,
      passHatK: false,
      budgetCompliant: true,
      k: 3,
      maxBudgetUsd: 1,
      maxScheduledBudgetUsd: 3,
      modelTier: 'sonnet',
      tokenUsage: { totalTokens: 123 },
      providerMetrics: {
        totalCostUsd: 0.25,
        durationMs: 456,
        turns: 7,
        reportedCostTrials: reportedTrials,
        reportedDurationTrials: reportedTrials,
        reportedTurnTrials: reportedTrials,
        untrustedExtra: 'not-reported',
      },
      providerRuntime: {
        effort: 'high',
        efforts: ['high'],
        fastModeStates: ['off'],
        usageSpeeds: ['standard'],
        serviceTiers: ['standard'],
      },
      benchmarkFingerprint: fingerprint('a'),
      fixtureFingerprint: fingerprint('b'),
      pipelineProtocolFingerprint: fingerprint('c'),
      pluginProvenance: {
        fingerprint: fingerprint('d'),
        targetPromptFingerprint: fingerprint('e'),
        untrustedExtra: 'not-reported',
      },
      claudeCliVersion: '2.1.209',
      observedModels: ['claude-sonnet-4-20250514'],
      provenanceComplete: true,
    }],
  });

  try {
    const executorLater = directSummary({
      agent: 'executor',
      runId: 'executor-later',
      completedAt: '2026-07-12T02:00:00.000Z',
    });
    Object.assign(executorLater.tasks[0].providerMetrics, {
      totalCostUsd: 0,
      durationMs: 0,
      turns: 0,
    });
    writeSummary('z-executor-later', executorLater);
    writeSummary('a-executor-earlier', directSummary({
      agent: 'executor',
      runId: 'executor-earlier',
      completedAt: '2026-07-12T01:00:00.000Z',
    }));
    writeSummary('m-hephaestus', directSummary({
      agent: 'hephaestus',
      runId: 'hephaestus-run',
      completedAt: '2026-07-12T01:00:00.000Z',
      reportedTrials: 0,
    }));
    writeSummary('fixture-agent', directSummary({
      agent: 'writer',
      runId: 'fixture-agent',
      completedAt: '2026-07-12T03:00:00.000Z',
      executionMode: 'fixture',
    }));
    writeSummary('unsafe-agent', directSummary({
      agent: '../executor',
      runId: 'unsafe-agent',
      completedAt: '2026-07-12T04:00:00.000Z',
    }));
    writeSummary('nested-corrupt', {
      ...directSummary({
        agent: 'security-reviewer',
        runId: 'nested-corrupt',
        completedAt: '2026-07-12T05:00:00.000Z',
      }),
      tracks: [null],
    });

    const trend = buildTrend(tempRoot);
    assert.deepEqual(Object.keys(trend.agents), ['executor', 'hephaestus']);
    assert.deepEqual(
      trend.agents.executor.map((point) => point.runId),
      ['executor-earlier', 'executor-later'],
    );
    assert.deepEqual(trend.agents.executor[0], {
      runId: 'executor-earlier',
      completedAt: '2026-07-12T01:00:00.000Z',
      task: 'shared-role-task',
      track: 'capability',
      agent: 'executor',
      completedTrials: 3,
      outcomePassAtK: true,
      outcomePassHatK: true,
      passAtK: true,
      passHatK: false,
      budgetCompliant: true,
      k: 3,
      maxBudgetUsd: 1,
      maxScheduledBudgetUsd: 3,
      modelTier: 'sonnet',
      totalTokens: 123,
      providerMetrics: {
        totalCostUsd: 0.25,
        durationMs: 456,
        turns: 7,
        reportedCostTrials: 1,
        reportedDurationTrials: 1,
        reportedTurnTrials: 1,
      },
      providerRuntime: {
        effort: 'high',
        efforts: ['high'],
        fastModeStates: ['off'],
        usageSpeeds: ['standard'],
        serviceTiers: ['standard'],
      },
      benchmarkFingerprint: fingerprint('a'),
      fixtureFingerprint: fingerprint('b'),
      pipelineProtocolFingerprint: fingerprint('c'),
      pluginFingerprint: fingerprint('d'),
      targetPromptFingerprint: fingerprint('e'),
      claudeCliVersion: '2.1.209',
      observedModels: ['claude-sonnet-4-20250514'],
      provenanceComplete: true,
    });
    assert.deepEqual(trend.agents.executor[1].providerMetrics, {
      totalCostUsd: 0,
      durationMs: 0,
      turns: 0,
      reportedCostTrials: 1,
      reportedDurationTrials: 1,
      reportedTurnTrials: 1,
    });
    assert.deepEqual(trend.agents.hephaestus[0].providerMetrics, {
      totalCostUsd: null,
      durationMs: null,
      turns: null,
      reportedCostTrials: 0,
      reportedDurationTrials: 0,
      reportedTurnTrials: 0,
    });
    assert.notEqual(
      trend.tracks.capability.find((point) => point.runId === 'executor-earlier').benchmarkFingerprint,
      trend.tracks.capability.find((point) => point.runId === 'hephaestus-run').benchmarkFingerprint,
      'the track benchmark identity must include the direct-agent persona',
    );
    assert.equal(Object.hasOwn(trend.agents, 'writer'), false);
    assert.equal(Object.hasOwn(trend.agents, 'security-reviewer'), false);

    const withFixtures = buildTrend(tempRoot, { includeFixtures: true });
    assert.deepEqual(Object.keys(withFixtures.agents), ['executor', 'hephaestus', 'writer']);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
