#!/usr/bin/env node

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEval } from './run.mjs';
import { discoverTasks } from './lib/tasks.mjs';

const EVALS_DIR = path.dirname(fileURLToPath(import.meta.url));

export async function verifyRegressionFixtures({ evalsDir = EVALS_DIR, resultsDir } = {}) {
  const ownedResultsDir = resultsDir ? null : mkdtempSync(path.join(tmpdir(), 'ao-eval-fixtures-'));
  const outputDir = path.resolve(resultsDir ?? ownedResultsDir);
  const tasks = discoverTasks(path.join(evalsDir, 'tasks'), 'regression');
  const results = [];
  try {
    for (const { task, taskDir } of tasks) {
      const green = await runEval(taskDir, {
        fixture: 'solution',
        resultsDir: outputDir,
        runId: `green-${task.id}`,
      });
      const red = await runEval(taskDir, {
        fixture: 'none',
        resultsDir: outputDir,
        runId: `red-${task.id}`,
      });
      if (green.exitCode !== 0 || red.exitCode === 0) {
        throw new Error(`Fixture proof failed for ${task.id}`);
      }
      results.push({ task: task.id, green: true, red: true });
    }
    return { schemaVersion: 1, tasks: results };
  } finally {
    if (ownedResultsDir) rmSync(ownedResultsDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyRegressionFixtures();
    console.log(`fixture proof OK: ${result.tasks.length} regression tasks`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
