#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBaseline } from './lib/baseline.mjs';

const EVALS_DIR = path.dirname(fileURLToPath(import.meta.url));

export function verifyBaselineIntegrity({
  evalsDir = EVALS_DIR,
  baselinePath = path.join(evalsDir, 'baseline.json'),
} = {}) {
  const baseline = readBaseline(baselinePath, { required: true });
  const tasksDir = path.join(evalsDir, 'tasks');
  const regressionTasks = readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => JSON.parse(readFileSync(path.join(tasksDir, entry.name, 'task.json'), 'utf-8')))
    .filter((task) => task.track === 'regression');

  const expectedIds = regressionTasks.map((task) => task.id).sort();
  const baselineIds = Object.keys(baseline.tasks).sort();
  if (JSON.stringify(expectedIds) !== JSON.stringify(baselineIds)) {
    throw new Error(`Baseline task set mismatch: expected ${expectedIds.join(', ')}, got ${baselineIds.join(', ')}`);
  }
  for (const task of regressionTasks) {
    if (task.k !== baseline.k || baseline.tasks[task.id].k !== task.k) {
      throw new Error(`Baseline k mismatch for ${task.id}: task=${task.k}, baseline=${baseline.tasks[task.id].k}`);
    }
  }
  return { schemaVersion: 1, tasks: expectedIds.length, k: baseline.k };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyBaselineIntegrity();
    console.log(`baseline OK: ${result.tasks} regression tasks at k=${result.k}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
