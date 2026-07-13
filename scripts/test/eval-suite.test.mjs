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
    assert.equal(result.summary.taskCount, 6);
    assert.equal(result.summary.passHatK, true);
    assert.equal(result.summary.passAtK, true);
    assert.equal(result.summary.regressionGatePassed, true);
    assert.deepEqual(result.summary.modelTiers, ['sonnet']);
    assert.deepEqual(result.summary.tracks, [
      { track: 'capability', total: 3, passed: 3 },
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
    assert.equal(resultLines.length, 6);
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
