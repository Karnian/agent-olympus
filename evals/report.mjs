#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EVALS_DIR = path.dirname(fileURLToPath(import.meta.url));
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;
const SAFE_AGENT_RE = /^[a-z][a-z0-9-]{0,63}$/;

function safeString(value, { pattern, maxLength = 128 } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return null;
  if (pattern && !pattern.test(value)) return null;
  return value;
}

function safeFingerprint(value) {
  return safeString(value, { pattern: FINGERPRINT_RE, maxLength: 64 });
}

function safeNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function safeOptionalNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function safePositiveNumber(value, { maximum = Number.POSITIVE_INFINITY } = {}) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= maximum
    ? value
    : null;
}

function safeNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function safePositiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function safeBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function safeObservedModels(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return null;
  const models = value.map((model) => safeString(model, {
    pattern: /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/,
    maxLength: 128,
  }));
  if (models.some((model) => model === null) || new Set(models).size !== models.length) return null;
  return [...models].sort();
}

function safeRuntimeValues(value) {
  if (!Array.isArray(value) || value.length > 16) return [];
  const values = value.map((entry) => safeString(entry, {
    pattern: /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/,
    maxLength: 64,
  }));
  if (values.some((entry) => entry === null) || new Set(values).size !== values.length) return [];
  return [...values].sort();
}

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
    ...(task.orchestrator === 'agent' ? { agent: task.agent } : {}),
    k: task.k,
    benchmarkFingerprint: task.benchmarkFingerprint,
  })).sort((a, b) => (
    String(a.task).localeCompare(String(b.task))
    || String(a.orchestrator).localeCompare(String(b.orchestrator))
    || String(a.agent ?? '').localeCompare(String(b.agent ?? ''))
  ));
  const complete = entries.length > 0 && entries.every((entry) => (
    typeof entry.task === 'string'
    && typeof entry.orchestrator === 'string'
    && (entry.orchestrator !== 'agent' || SAFE_AGENT_RE.test(entry.agent))
    && Number.isInteger(entry.k)
    && FINGERPRINT_RE.test(entry.benchmarkFingerprint)
  ));
  const pipelineProtocolFingerprints = [...new Set(
    tasks
      .map((task) => task.pipelineProtocolFingerprint)
      .filter((value) => FINGERPRINT_RE.test(value)),
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

function directAgentPoint(summary, task, runId, completedAt) {
  if (task?.orchestrator !== 'agent') return null;
  const agent = safeString(task.agent, { pattern: SAFE_AGENT_RE, maxLength: 64 });
  const taskId = safeString(task.task);
  const track = ['regression', 'capability'].includes(task.track) ? task.track : null;
  if (!agent || !taskId || !track) return null;

  const provenance = task.pluginProvenance && typeof task.pluginProvenance === 'object'
    ? task.pluginProvenance
    : summary.pluginProvenance && typeof summary.pluginProvenance === 'object'
      ? summary.pluginProvenance
      : null;
  const providerMetrics = task.providerMetrics && typeof task.providerMetrics === 'object'
    ? task.providerMetrics
    : {};
  const providerRuntime = task.providerRuntime && typeof task.providerRuntime === 'object'
    ? task.providerRuntime
    : {};
  const reportedCostTrials = safeNonNegativeInteger(providerMetrics.reportedCostTrials);
  const reportedDurationTrials = safeNonNegativeInteger(providerMetrics.reportedDurationTrials);
  const reportedTurnTrials = safeNonNegativeInteger(providerMetrics.reportedTurnTrials);
  return {
    runId,
    completedAt,
    task: taskId,
    track,
    agent,
    completedTrials: safePositiveInteger(task.completedTrials),
    outcomePassAtK: safeBoolean(task.outcomePassAtK),
    outcomePassHatK: safeBoolean(task.outcomePassHatK),
    passAtK: safeBoolean(task.passAtK),
    passHatK: safeBoolean(task.passHatK),
    budgetCompliant: safeBoolean(task.budgetCompliant),
    k: safePositiveInteger(task.k),
    maxBudgetUsd: safePositiveNumber(task.maxBudgetUsd, { maximum: 100 }),
    maxScheduledBudgetUsd: safePositiveNumber(task.maxScheduledBudgetUsd),
    modelTier: safeString(task.modelTier, { maxLength: 64 }),
    totalTokens: safeNonNegativeNumber(task.tokenUsage?.totalTokens),
    providerMetrics: {
      totalCostUsd: reportedCostTrials > 0
        ? safeOptionalNonNegativeNumber(providerMetrics.totalCostUsd)
        : null,
      durationMs: reportedDurationTrials > 0
        ? safeOptionalNonNegativeNumber(providerMetrics.durationMs)
        : null,
      turns: reportedTurnTrials > 0
        ? safeOptionalNonNegativeNumber(providerMetrics.turns)
        : null,
      reportedCostTrials,
      reportedDurationTrials,
      reportedTurnTrials,
    },
    providerRuntime: {
      effort: safeString(providerRuntime.effort, {
        pattern: /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/,
        maxLength: 64,
      }),
      efforts: safeRuntimeValues(providerRuntime.efforts),
      fastModeStates: safeRuntimeValues(providerRuntime.fastModeStates),
      usageSpeeds: safeRuntimeValues(providerRuntime.usageSpeeds),
      serviceTiers: safeRuntimeValues(providerRuntime.serviceTiers),
    },
    benchmarkFingerprint: safeFingerprint(task.benchmarkFingerprint),
    fixtureFingerprint: safeFingerprint(task.fixtureFingerprint),
    pipelineProtocolFingerprint: safeFingerprint(task.pipelineProtocolFingerprint),
    pluginFingerprint: safeFingerprint(provenance?.fingerprint),
    targetPromptFingerprint: safeFingerprint(provenance?.targetPromptFingerprint),
    claudeCliVersion: safeString(task.claudeCliVersion ?? summary.claudeCliVersion, { maxLength: 64 }),
    observedModels: safeObservedModels(task.observedModels ?? summary.observedModels),
    provenanceComplete: safeBoolean(task.provenanceComplete),
  };
}

export function buildTrend(resultsDir = path.join(EVALS_DIR, 'results'), { includeFixtures = false } = {}) {
  const series = { regression: [], capability: [] };
  const agentSeries = {};
  if (!existsSync(resultsDir)) return { schemaVersion: 1, tracks: series, agents: agentSeries };

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
      const runId = typeof summary.runId === 'string' && summary.runId.length > 0
        ? summary.runId
        : entry.name;
      const pendingAgentPoints = [];
      const pendingTrackPoints = [];
      if (Array.isArray(summary.tasks)) {
        for (const task of summary.tasks) {
          const point = directAgentPoint(summary, task, runId, completedAt);
          if (!point) continue;
          pendingAgentPoints.push(point);
        }
      }
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
        pendingTrackPoints.push([track.track, {
          runId,
          completedAt,
          total,
          passed,
          passRate: total > 0 ? passed / total : 0,
          totalTokens: trackTokenTotal,
          modelTier: modelTiers.length === 1 ? modelTiers[0] : null,
          modelTiers,
          ...benchmark,
        }]);
      }
      // Commit one parsed summary atomically. If any nested field is corrupt,
      // the catch below discards all points from that run instead of leaking a
      // partial agent or track series.
      for (const [trackName, point] of pendingTrackPoints) {
        series[trackName].push(point);
      }
      for (const point of pendingAgentPoints) {
        (agentSeries[point.agent] ??= []).push(point);
      }
    } catch {
      // A partial/corrupt result must not prevent reporting intact runs.
    }
  }
  for (const points of Object.values(series)) {
    points.sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.runId.localeCompare(b.runId));
  }
  const sortedAgentSeries = Object.fromEntries(
    Object.entries(agentSeries)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([agent, points]) => [agent, points.sort((a, b) => (
        a.completedAt.localeCompare(b.completedAt)
        || a.runId.localeCompare(b.runId)
        || a.task.localeCompare(b.task)
        || a.track.localeCompare(b.track)
      ))]),
  );
  return { schemaVersion: 1, tracks: series, agents: sortedAgentSeries };
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
