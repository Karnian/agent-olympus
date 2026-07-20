#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBaseline } from './lib/baseline.mjs';
import {
  discoverTasks,
  fingerprintBenchmark,
  fingerprintPipelineProtocol,
} from './lib/tasks.mjs';

const EVALS_DIR = path.dirname(fileURLToPath(import.meta.url));

export function verifyBaselineIntegrity({
  evalsDir = EVALS_DIR,
  baselinePath = path.join(evalsDir, 'baseline.json'),
} = {}) {
  const baseline = readBaseline(baselinePath, { required: true });
  const tasksDir = path.join(evalsDir, 'tasks');
  const regressionTasks = discoverTasks(tasksDir, 'regression');

  const expectedIds = regressionTasks.map(({ task }) => task.id).sort();
  const baselineIds = Object.keys(baseline.tasks).sort();
  if (JSON.stringify(expectedIds) !== JSON.stringify(baselineIds)) {
    throw new Error(`Baseline task set mismatch: expected ${expectedIds.join(', ')}, got ${baselineIds.join(', ')}`);
  }
  const pipelineProtocolFingerprint = fingerprintPipelineProtocol();
  const protocolReviewRequired = [];
  for (const { task, taskDir } of regressionTasks) {
    if (task.k !== baseline.k || baseline.tasks[task.id].k !== task.k) {
      throw new Error(`Baseline k mismatch for ${task.id}: task=${task.k}, baseline=${baseline.tasks[task.id].k}`);
    }
    if (baseline.tasks[task.id].orchestrator !== task.orchestrator) {
      throw new Error(`Baseline orchestrator mismatch for ${task.id}`);
    }
    const benchmarkFingerprint = fingerprintBenchmark(taskDir);
    if (baseline.tasks[task.id].benchmarkFingerprint !== benchmarkFingerprint) {
      throw new Error(`Baseline benchmark fingerprint mismatch for ${task.id}`);
    }
    if (baseline.tasks[task.id].pipelineProtocolFingerprint !== pipelineProtocolFingerprint) {
      if (baseline.tasks[task.id].source === 'live') {
        // A measured LKG must retain the protocol identity under which it was
        // observed. Rewriting it to the current hash would forge provenance;
        // run-time comparison exposes the mismatch as a review gate instead.
        protocolReviewRequired.push(task.id);
      } else {
        throw new Error(`Baseline pipeline protocol fingerprint mismatch for ${task.id}`);
      }
    }
  }
  return {
    schemaVersion: baseline.schemaVersion,
    tasks: expectedIds.length,
    k: baseline.k,
    protocolReviewRequired,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyBaselineIntegrity();
    const review = result.protocolReviewRequired.length > 0
      ? `; protocol review required: ${result.protocolReviewRequired.join(', ')}`
      : '';
    console.log(`baseline OK: ${result.tasks} regression tasks at k=${result.k}${review}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
