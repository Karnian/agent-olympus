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

export async function runSuite(opts = {}) {
  if (!opts.live && opts.fixture === undefined) {
    throw new Error('Refusing to run the real orchestrator implicitly. Pass --fixture solution|none or --live.');
  }
  if (opts.live && opts.fixture !== undefined) throw new Error('Choose exactly one execution mode: --live or --fixture');
  const track = opts.track ?? 'all';
  if (opts.updateBaseline) throw new Error('Suite baseline refresh is not atomic; refresh reviewed regression tasks individually');

  const evalsDir = path.resolve(opts.evalsDir ?? EVALS_DIR);
  const tasks = discoverTasks(path.join(evalsDir, 'tasks'), track);
  if (tasks.length === 0) throw new Error(`No eval tasks found for track: ${track}`);

  const runId = assertSafeRunId(opts.runId ?? makeSuiteRunId());
  const resultsDir = path.resolve(opts.resultsDir ?? path.join(evalsDir, 'results'));
  const runDir = path.join(resultsDir, runId);
  const taskResultsDir = path.join(runDir, 'tasks');
  mkdirSync(taskResultsDir, { recursive: true, mode: 0o700 });
  chmodSync(runDir, 0o700);
  chmodSync(taskResultsDir, 0o700);

  const runs = [];
  for (const { task, taskDir } of tasks) {
    runs.push(await runEval(taskDir, {
      fixture: opts.fixture,
      live: opts.live,
      k: opts.k,
      runId: task.id,
      resultsDir: taskResultsDir,
      pluginDir: opts.pluginDir,
      baselinePath: opts.baselinePath,
      updateBaseline: false,
    }));
  }

  const taskSummaries = runs.map((run) => run.summary.tasks[0]);
  const suiteResults = runs.flatMap((run) => run.results.map((result) => ({
    ...result,
    runId,
  })));
  const trialUsages = suiteResults.map((result) => result.usage);
  const modelTiers = [...new Set(taskSummaries.map((task) => task.modelTier))].sort();
  const regressionGatePassed = taskSummaries
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
    passHatK: taskSummaries.every((task) => task.passHatK),
    passAtK: taskSummaries.every((task) => task.passAtK),
    regressionGatePassed,
    tokenUsage: aggregateTokenUsage(trialUsages),
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
    // Capability tasks measure progress and never gate the suite. Only the
    // regression track's pass^k contract controls process failure.
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
      console.log('Usage: node evals/run-suite.mjs [--track all|regression|capability] [--fixture solution|none] [--k N]');
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
