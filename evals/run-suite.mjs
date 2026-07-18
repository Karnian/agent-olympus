#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFile } from '../scripts/lib/fs-atomic.mjs';
import { aggregateTokenUsage, runEval } from './run.mjs';
import { rollupByTrack } from './lib/score.mjs';
import { discoverTasks } from './lib/tasks.mjs';

const EVALS_DIR = path.dirname(fileURLToPath(import.meta.url));
const MAX_PER_TRIAL_BUDGET_USD = 100;

function makeSuiteRunId() {
  return `suite-${Date.now()}-${randomBytes(4).toString('hex')}`;
}

function assertSafeRunId(runId) {
  const value = String(runId);
  if (value === '.' || value === '..' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new Error(`Unsafe run id: ${value}`);
  }
  return value;
}

function aggregateProviderMetrics(tasks) {
  const fields = [
    'totalCostUsd',
    'durationMs',
    'apiDurationMs',
    'turns',
    'reportedCostTrials',
    'reportedDurationTrials',
    'reportedTurnTrials',
  ];
  return Object.fromEntries(fields.map((field) => [
    field,
    tasks.reduce((sum, task) => sum + (Number(task.providerMetrics?.[field]) || 0), 0),
  ]));
}

function aggregateProviderRuntime(tasks) {
  const valuesFor = (field) => [...new Set(tasks.flatMap((task) => (
    Array.isArray(task.providerRuntime?.[field]) ? task.providerRuntime[field] : []
  )))].sort();
  const efforts = valuesFor('efforts');
  return {
    effort: efforts.length === 1 ? efforts[0] : null,
    efforts,
    fastModeStates: valuesFor('fastModeStates'),
    usageSpeeds: valuesFor('usageSpeeds'),
    serviceTiers: valuesFor('serviceTiers'),
  };
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function parsePositiveSafeInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive safe integer, got: ${value}`);
  }
  return parsed;
}

function parsePositiveFinite(value, flag, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(
      `${flag} must be a finite number greater than 0 and at most ${maximum}, got: ${value}`,
    );
  }
  return parsed;
}

function comparisonTolerance(left, right) {
  return Math.max(Math.abs(left), Math.abs(right), Number.MIN_VALUE) * Number.EPSILON * 8;
}

function resolveLiveSuiteBudget(opts, taskCount) {
  if (!hasOwn(opts, 'k')) throw new Error('Live suites require explicit --k');
  if (!hasOwn(opts, 'maxBudgetUsd')) {
    throw new Error('Live suites require explicit --max-budget-usd');
  }
  if (!hasOwn(opts, 'maxTotalBudgetUsd')) {
    throw new Error('Live suites require explicit --max-total-budget-usd');
  }

  const k = parsePositiveSafeInteger(opts.k, '--k');
  const maxBudgetUsd = parsePositiveFinite(
    opts.maxBudgetUsd,
    '--max-budget-usd',
    MAX_PER_TRIAL_BUDGET_USD,
  );
  const maxTotalBudgetUsd = parsePositiveFinite(
    opts.maxTotalBudgetUsd,
    '--max-total-budget-usd',
  );
  const projectedMaxBudgetUsd = taskCount * k * maxBudgetUsd;
  if (!Number.isFinite(projectedMaxBudgetUsd)
    || projectedMaxBudgetUsd > maxTotalBudgetUsd
      + comparisonTolerance(projectedMaxBudgetUsd, maxTotalBudgetUsd)) {
    throw new Error(
      `Projected live suite budget $${projectedMaxBudgetUsd} exceeds `
      + `--max-total-budget-usd $${maxTotalBudgetUsd}`,
    );
  }
  return { k, maxBudgetUsd, maxTotalBudgetUsd, projectedMaxBudgetUsd };
}

function reportedRunCost(run, expectedTrials) {
  const metrics = run?.summary?.providerMetrics;
  const completedTrials = Array.isArray(run?.results) ? run.results.length : -1;
  if (completedTrials !== expectedTrials) {
    return { complete: false, reason: 'child-run-incomplete', costUsd: null };
  }
  if (!Number.isSafeInteger(metrics?.reportedCostTrials)
    || metrics.reportedCostTrials !== completedTrials
    || typeof metrics?.totalCostUsd !== 'number'
    || !Number.isFinite(metrics.totalCostUsd)
    || metrics.totalCostUsd < 0) {
    return { complete: false, reason: 'unknown-reported-cost', costUsd: null };
  }
  return { complete: true, reason: null, costUsd: metrics.totalCostUsd };
}

function runBudgetCompliant(run) {
  if (run?.summary?.budgetCompliant === false) return false;
  return !run?.summary?.tasks?.some((task) => task?.budgetCompliant === false);
}

export async function runSuite(opts = {}) {
  if (!opts.live && opts.fixture === undefined) {
    throw new Error('Refusing to run the real orchestrator implicitly. Pass --fixture solution|none or --live.');
  }
  if (opts.live && opts.fixture !== undefined) throw new Error('Choose exactly one execution mode: --live or --fixture');
  const track = opts.track ?? 'all';
  if (opts.updateBaseline) throw new Error('Suite baseline refresh is not atomic; refresh reviewed regression tasks individually');
  if (opts.live && !hasOwn(opts, 'track')) {
    throw new Error('Live suites require explicit --track all|regression|capability');
  }

  const evalsDir = path.resolve(opts.evalsDir ?? EVALS_DIR);
  const tasks = discoverTasks(path.join(evalsDir, 'tasks'), track);
  if (tasks.length === 0) throw new Error(`No eval tasks found for track: ${track}`);
  const liveBudget = opts.live ? resolveLiveSuiteBudget(opts, tasks.length) : null;
  const runTask = opts.runEvalImpl ?? runEval;
  if (typeof runTask !== 'function') throw new Error('runEvalImpl must be a function');

  const runId = assertSafeRunId(opts.runId ?? makeSuiteRunId());
  const resultsDir = path.resolve(opts.resultsDir ?? path.join(evalsDir, 'results'));
  const runDir = path.join(resultsDir, runId);
  const taskResultsDir = path.join(runDir, 'tasks');
  mkdirSync(taskResultsDir, { recursive: true, mode: 0o700 });
  chmodSync(runDir, 0o700);
  chmodSync(taskResultsDir, 0o700);

  const runs = [];
  let reportedCostUsd = 0;
  let budgetStopReason = null;
  let childBudgetsCompliant = true;
  for (const { task, taskDir } of tasks) {
    const run = await runTask(taskDir, {
      fixture: opts.fixture,
      live: opts.live,
      k: liveBudget?.k ?? opts.k,
      runId: task.id,
      resultsDir: taskResultsDir,
      pluginDir: opts.pluginDir,
      baselinePath: opts.baselinePath,
      updateBaseline: false,
      ...(liveBudget ? { maxBudgetUsd: liveBudget.maxBudgetUsd } : {}),
    });
    runs.push(run);
    if (!liveBudget) continue;

    if (!runBudgetCompliant(run)) {
      childBudgetsCompliant = false;
      budgetStopReason = 'per-run-budget-noncompliance';
      break;
    }
    const reportedCost = reportedRunCost(run, liveBudget.k);
    if (!reportedCost.complete) {
      childBudgetsCompliant = false;
      budgetStopReason = reportedCost.reason;
      break;
    }
    reportedCostUsd += reportedCost.costUsd;
    const tolerance = comparisonTolerance(reportedCostUsd, liveBudget.maxTotalBudgetUsd);
    if (reportedCostUsd > liveBudget.maxTotalBudgetUsd + tolerance) {
      budgetStopReason = 'aggregate-budget-exceeded';
      break;
    }
    if (runs.length < tasks.length
      && reportedCostUsd + tolerance >= liveBudget.maxTotalBudgetUsd) {
      budgetStopReason = 'aggregate-budget-reached';
      break;
    }
  }

  const taskSummaries = runs.map((run) => run.summary.tasks[0]);
  const suiteResults = runs.flatMap((run) => run.results.map((result) => ({
    ...result,
    runId,
  })));
  const trialUsages = suiteResults.map((result) => result.usage);
  const modelTiers = [...new Set(taskSummaries.map((task) => task.modelTier))].sort();
  const schedulingComplete = runs.length === tasks.length;
  const budgetCompliant = liveBudget
    ? childBudgetsCompliant
      && reportedCostUsd <= liveBudget.maxTotalBudgetUsd
        + comparisonTolerance(reportedCostUsd, liveBudget.maxTotalBudgetUsd)
    : null;
  const safetyGatePassed = schedulingComplete && budgetCompliant !== false;
  const regressionGatePassed = safetyGatePassed && taskSummaries
    .filter((task) => task.track === 'regression')
    .every((task) => task.passHatK);
  const summary = {
    schemaVersion: 1,
    runId,
    completedAt: new Date().toISOString(),
    executionMode: opts.live ? 'live' : 'fixture',
    track,
    modelTiers,
    taskCount: taskSummaries.length,
    plannedTaskCount: tasks.length,
    schedulingComplete,
    passHatK: safetyGatePassed && taskSummaries.every((task) => task.passHatK),
    passAtK: safetyGatePassed && taskSummaries.every((task) => task.passAtK),
    regressionGatePassed,
    budgetCompliant,
    liveBudget: liveBudget ? {
      ...liveBudget,
      reportedCostUsd,
      stopReason: budgetStopReason,
    } : null,
    tokenUsage: aggregateTokenUsage(trialUsages),
    providerMetrics: aggregateProviderMetrics(taskSummaries),
    providerRuntime: aggregateProviderRuntime(taskSummaries),
    tasks: taskSummaries,
    tracks: rollupByTrack(taskSummaries),
  };
  const jsonl = suiteResults.map((result) => JSON.stringify(result)).join('\n');
  await atomicWriteFile(path.join(runDir, 'results.jsonl'), jsonl ? `${jsonl}\n` : '');
  await atomicWriteFile(path.join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  return {
    runId,
    runDir,
    summary,
    results: suiteResults,
    runs,
    // Capability quality misses remain report-only. An incomplete or
    // over-budget live suite is a safety failure; otherwise regression pass^k
    // controls process failure.
    exitCode: summary.regressionGatePassed ? 0 : 1,
  };
}

function parseArgs(argv) {
  const opts = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--track') opts.track = argv[++index];
    else if (arg === '--fixture') opts.fixture = argv[++index];
    else if (arg === '--live') opts.live = true;
    else if (arg === '--k') opts.k = argv[++index];
    else if (arg === '--max-budget-usd') opts.maxBudgetUsd = argv[++index];
    else if (arg === '--max-total-budget-usd') opts.maxTotalBudgetUsd = argv[++index];
    else if (arg === '--run-id') opts.runId = argv[++index];
    else if (arg === '--results-dir') opts.resultsDir = argv[++index];
    else if (arg === '--baseline') opts.baselinePath = argv[++index];
    else if (arg === '--update-baseline') opts.updateBaseline = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log(
        'Usage: node evals/run-suite.mjs [--track all|regression|capability] '
        + '[--fixture solution|none | --live --k N --max-budget-usd USD --max-total-budget-usd USD]',
      );
    } else {
      const result = await runSuite(opts);
      console.log(JSON.stringify({
        schemaVersion: 1,
        runId: result.runId,
        summaryPath: path.join(result.runDir, 'summary.json'),
        passHatK: result.summary.passHatK,
        passAtK: result.summary.passAtK,
      }, null, 2));
      process.exitCode = result.exitCode;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
