#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EVALS_DIR = path.dirname(fileURLToPath(import.meta.url));

function benchmarkMetadata(summary, trackName) {
  const tasks = Array.isArray(summary.tasks)
    ? summary.tasks.filter((task) => task.track === trackName)
    : [];
  const ks = [...new Set(
    (tasks.length > 0 ? tasks.map((task) => task.k) : [summary.k])
      .filter((value) => Number.isInteger(value) && value > 0),
  )].sort((a, b) => a - b);
  const entries = tasks.map((task) => ({
    task: task.task,
    orchestrator: task.orchestrator,
    k: task.k,
    benchmarkFingerprint: task.benchmarkFingerprint,
  })).sort((a, b) => String(a.task).localeCompare(String(b.task)));
  const complete = entries.length > 0 && entries.every((entry) => (
    typeof entry.task === 'string'
    && typeof entry.orchestrator === 'string'
    && Number.isInteger(entry.k)
    && /^[a-f0-9]{64}$/.test(entry.benchmarkFingerprint)
  ));
  const pipelineProtocolFingerprints = [...new Set(
    tasks
      .map((task) => task.pipelineProtocolFingerprint)
      .filter((value) => /^[a-f0-9]{64}$/.test(value)),
  )].sort();
  return {
    ks,
    k: ks.length === 1 ? ks[0] : null,
    benchmarkFingerprint: complete
      ? createHash('sha256').update(JSON.stringify(entries)).digest('hex')
      : null,
    pipelineProtocolFingerprint: pipelineProtocolFingerprints.length === 1
      ? pipelineProtocolFingerprints[0]
      : null,
    pipelineProtocolFingerprints,
  };
}

export function buildTrend(resultsDir = path.join(EVALS_DIR, 'results'), { includeFixtures = false } = {}) {
  const series = { regression: [], capability: [] };
  if (!existsSync(resultsDir)) return { schemaVersion: 1, tracks: series };

  for (const entry of readdirSync(resultsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const summaryPath = path.join(resultsDir, entry.name, 'summary.json');
    if (!existsSync(summaryPath)) continue;
    try {
      const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));
      if (summary.schemaVersion !== 1 || !Array.isArray(summary.tracks)) continue;
      if (!includeFixtures && summary.executionMode !== 'live') continue;
      const completedAt = typeof summary.completedAt === 'string'
        ? summary.completedAt
        : statSync(summaryPath).mtime.toISOString();
      for (const track of summary.tracks) {
        if (!Object.hasOwn(series, track.track)) continue;
        const total = Number(track.total) || 0;
        const passed = Number(track.passed) || 0;
        const trackTokenTotal = Array.isArray(summary.tasks)
          ? summary.tasks
            .filter((task) => task.track === track.track)
            .reduce((sum, task) => sum + (Number(task.tokenUsage?.totalTokens) || 0), 0)
          : Number(summary.tokenUsage?.totalTokens) || 0;
        const modelTiers = [...new Set(
          Array.isArray(summary.tasks)
            ? summary.tasks
              .filter((task) => task.track === track.track)
              .map((task) => task.modelTier)
              .filter((value) => typeof value === 'string' && value.length > 0)
            : Array.isArray(summary.modelTiers)
              ? summary.modelTiers
              : typeof summary.modelTier === 'string'
                ? [summary.modelTier]
                : [],
        )].sort();
        const benchmark = benchmarkMetadata(summary, track.track);
        series[track.track].push({
          runId: typeof summary.runId === 'string' && summary.runId.length > 0
            ? summary.runId
            : entry.name,
          completedAt,
          total,
          passed,
          passRate: total > 0 ? passed / total : 0,
          totalTokens: trackTokenTotal,
          modelTier: modelTiers.length === 1 ? modelTiers[0] : null,
          modelTiers,
          ...benchmark,
        });
      }
    } catch {
      // A partial/corrupt result must not prevent reporting intact runs.
    }
  }
  for (const points of Object.values(series)) {
    points.sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.runId.localeCompare(b.runId));
  }
  return { schemaVersion: 1, tracks: series };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.includes('--trend')) {
    console.error('Usage: node evals/report.mjs --trend [--results-dir <dir>] [--include-fixtures]');
    process.exitCode = 2;
  } else {
    const index = args.indexOf('--results-dir');
    const resultsDir = index >= 0 ? args[index + 1] : undefined;
    console.log(JSON.stringify(buildTrend(resultsDir, {
      includeFixtures: args.includes('--include-fixtures'),
    }), null, 2));
  }
}
