#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  cpSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { atomicWriteFile } from '../scripts/lib/fs-atomic.mjs';
import {
  baselineValueForTask,
  readBaseline,
  updateBaselineTask,
} from './lib/baseline.mjs';
import { runOrchestrator } from './lib/orchestrate.mjs';
import {
  beginPipelineEvidence,
  pipelineEvidenceNotApplicable,
  verifyPipelineEvidence,
} from './lib/pipeline-evidence.mjs';
import { stagePluginSnapshot } from './lib/plugin-stage.mjs';
import { passAtK, passHatK, rollupByTrack } from './lib/score.mjs';
import {
  fingerprintBenchmark,
  fingerprintPipelineProtocol,
  validateTaskDefinition,
} from './lib/tasks.mjs';

const EVALS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(EVALS_DIR, '..');
let fallbackRunCounter = 0;

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function loadTask(taskPath) {
  const taskDir = path.resolve(taskPath);
  const taskJsonPath = path.join(taskDir, 'task.json');
  const graderPath = path.join(taskDir, 'grader.mjs');
  const seedDir = path.join(taskDir, 'seed');

  if (!existsSync(taskJsonPath)) throw new Error(`Missing task.json: ${taskJsonPath}`);
  if (!existsSync(graderPath)) throw new Error(`Missing grader.mjs: ${graderPath}`);
  if (!existsSync(seedDir)) throw new Error(`Missing seed directory: ${seedDir}`);

  const task = readJson(taskJsonPath);
  validateTaskDefinition(task);
  return { task, taskDir, graderPath, seedDir };
}

function resolveK(task, opts) {
  const rawK = opts.k ?? task.k ?? 1;
  const k = Number(rawK);
  if (!Number.isInteger(k) || k <= 0) {
    throw new Error(`k must be a positive integer, got: ${rawK}`);
  }
  return k;
}

function safeNow(now) {
  try {
    if (typeof now === 'function') return now();
    if (now !== undefined && now !== null) return now;
    if (globalThis.Date && typeof Date.now === 'function') return Date.now();
  } catch {}
  return null;
}

function safeRandomHex() {
  try {
    return randomBytes(4).toString('hex');
  } catch {
    fallbackRunCounter += 1;
    return `fallback-${process.pid ?? 'pid'}-${fallbackRunCounter}`;
  }
}

function assertSafeRunId(runId) {
  const value = String(runId);
  if (value === '.' || value === '..' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new Error(`Unsafe run id: ${value}`);
  }
  return value;
}

function makeRunId(opts) {
  if (opts.runId) return assertSafeRunId(opts.runId);
  const now = safeNow(opts.now);
  const prefix = now === null || now === undefined
    ? 'notime'
    : String(now).replace(/[^a-zA-Z0-9._-]/g, '-');
  return `eval-${prefix}-${safeRandomHex()}`;
}

function initGitIfAvailable(workdir) {
  try {
    execFileSync('git', ['init'], { cwd: workdir, stdio: 'ignore' });
    // Harness-owned runtime state must not make Athena's committed-root
    // worktree precondition dirty, and every trial needs a real HEAD from which
    // isolated worker branches can be created.
    const excludePath = path.join(workdir, '.git', 'info', 'exclude');
    writeFileSync(excludePath, '/.ao/\n', { encoding: 'utf-8', flag: 'a' });
    if (!existsSync(path.join(workdir, 'AGENTS.md'))) {
      writeFileSync(path.join(workdir, 'AGENTS.md'), [
        '# Eval Task Workspace',
        '',
        'Work only inside this isolated repository and follow the task prompt.',
        'Do not inspect parent directories or external benchmark files.',
        'Use local tests as evidence and keep changes scoped to the requested fix.',
        '',
      ].join('\n'));
    }
    execFileSync('git', ['config', 'user.name', 'Agent Olympus Eval'], { cwd: workdir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'eval@agent-olympus.invalid'], { cwd: workdir, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: workdir, stdio: 'ignore' });
    execFileSync('git', [
      'commit', '--allow-empty', '--no-gpg-sign', '-m', 'eval: seed checkpoint',
    ], { cwd: workdir, stdio: 'ignore' });
    // Review routing expects origin/main, but live evals must not gain a real
    // push target. Local remote-tracking refs provide a stable diff base while
    // shipping preflight still sees no configured remote and skips safely.
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: workdir, stdio: 'ignore' });
    execFileSync('git', [
      'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main',
    ], { cwd: workdir, stdio: 'ignore' });
  } catch {}
}

function createTrialWorkdir(seedDir, trialIndex) {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'ao-eval-'));
  try {
    const workdir = path.join(tmpRoot, `trial-${trialIndex}`);
    cpSync(seedDir, workdir, { recursive: true, force: true });
    initGitIfAvailable(workdir);
    return { tmpRoot, workdir };
  } catch (error) {
    // Clean up the just-created temp root if seed copy/init fails, so a throw
    // here never leaks a directory the caller hasn't registered for cleanup.
    rmSync(tmpRoot, { recursive: true, force: true });
    throw error;
  }
}

function normalizeChecks(checks) {
  if (!Array.isArray(checks)) return [];
  return checks.map((check, index) => ({
    name: typeof check?.name === 'string' ? check.name : `check-${index + 1}`,
    pass: Boolean(check?.pass),
    detail: check?.detail == null ? '' : String(check.detail),
  }));
}

async function gradeWorkdir(grade, workdir) {
  try {
    const result = await grade(workdir);
    return {
      pass: Boolean(result?.pass),
      checks: normalizeChecks(result?.checks),
    };
  } catch (error) {
    return {
      pass: false,
      checks: [{
        name: 'grader threw',
        pass: false,
        detail: error instanceof Error ? error.message : String(error),
      }],
    };
  }
}

function compareWithBaseline({
  baselinePath,
  taskId,
  executionMode,
  orchestrator,
  benchmarkFingerprint,
  pipelineProtocolFingerprint,
  runK,
  modelTier,
  passHat,
}) {
  const provenanceFor = (entry) => entry ? {
    source: entry.source,
    runId: entry.runId,
    measuredAt: entry.measuredAt,
    modelTier: entry.modelTier,
    orchestrator: entry.orchestrator,
    benchmarkFingerprint: entry.benchmarkFingerprint,
    pipelineProtocolFingerprint: entry.pipelineProtocolFingerprint,
  } : null;
  const protocolGate = (entry, evaluated, reason = null) => ({
    evaluated,
    passed: evaluated ? entry.pipelineProtocolFingerprint === pipelineProtocolFingerprint : null,
    reason: evaluated && entry.pipelineProtocolFingerprint !== pipelineProtocolFingerprint
      ? 'pipeline-protocol-mismatch'
      : reason,
    runFingerprint: pipelineProtocolFingerprint,
    baselineFingerprint: entry?.pipelineProtocolFingerprint ?? null,
  });
  const incomparable = (reason, {
    baselineK = null,
    entry = null,
    deltaVsTarget = null,
  } = {}) => ({
    comparable: false,
    decisionEligible: false,
    reason,
    runK,
    baselineK,
    delta: null,
    deltaVsTarget,
    provenance: provenanceFor(entry),
    protocolGate: protocolGate(entry, false, reason),
  });
  let baseline;
  try {
    baseline = readBaseline(baselinePath);
  } catch {
    return incomparable('baseline-unavailable');
  }
  if (!baseline) return incomparable('baseline-unavailable');
  const entry = baseline.tasks?.[taskId];
  if (!entry) return incomparable('task-not-in-baseline', { baselineK: baseline.k ?? null });
  const baselineK = entry.k;
  if (executionMode !== 'live') {
    return incomparable('non-live-run', { baselineK, entry });
  }
  if (entry.orchestrator !== orchestrator) {
    return incomparable('orchestrator-mismatch', { baselineK, entry });
  }
  if (entry.benchmarkFingerprint !== benchmarkFingerprint) {
    return incomparable('benchmark-fingerprint-mismatch', { baselineK, entry });
  }
  if (baseline.k !== runK || baselineK !== runK) {
    return incomparable('k-mismatch', {
      baselineK: baselineK ?? baseline.k ?? null,
      entry,
    });
  }
  if (entry.source === 'live' && entry.modelTier !== modelTier) {
    return incomparable('model-tier-mismatch', { baselineK, entry });
  }
  const baselineValue = baselineValueForTask(baseline, taskId);
  if (baselineValue === null) {
    return incomparable('baseline-verdict-unavailable', { baselineK, entry });
  }
  if (entry.source !== 'live') {
    return incomparable('baseline-unmeasured', {
      baselineK,
      entry,
      deltaVsTarget: (passHat ? 1 : 0) - baselineValue,
    });
  }
  const gate = protocolGate(entry, true);
  return {
    comparable: true,
    decisionEligible: gate.passed === true,
    reason: null,
    runK,
    baselineK,
    delta: (passHat ? 1 : 0) - baselineValue,
    deltaVsTarget: null,
    provenance: provenanceFor(entry),
    protocolGate: gate,
  };
}

function summarizeOrchestration(orchestration) {
  return {
    status: orchestration.status,
    finalEvent: orchestration.finalEvent,
    usage: orchestration.usage,
    timedOut: orchestration.timedOut,
  };
}

function tokenCount(usage, field) {
  const value = usage?.[field];
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Aggregate Claude result-event usage without inventing tokens for fixtures or
 * failed runs whose provider did not report usage.
 *
 * @param {Array<object|null>} usages Raw result-event usage objects.
 * @returns {{inputTokens:number,outputTokens:number,cacheCreationInputTokens:number,cacheReadInputTokens:number,totalTokens:number,reportedTrials:number}}
 */
export function aggregateTokenUsage(usages) {
  const aggregate = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 0,
    reportedTrials: 0,
  };

  for (const usage of Array.isArray(usages) ? usages : []) {
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) continue;
    const inputTokens = tokenCount(usage, 'input_tokens');
    const outputTokens = tokenCount(usage, 'output_tokens');
    const cacheCreationInputTokens = tokenCount(usage, 'cache_creation_input_tokens');
    const cacheReadInputTokens = tokenCount(usage, 'cache_read_input_tokens');

    aggregate.inputTokens += inputTokens;
    aggregate.outputTokens += outputTokens;
    aggregate.cacheCreationInputTokens += cacheCreationInputTokens;
    aggregate.cacheReadInputTokens += cacheReadInputTokens;
    aggregate.reportedTrials += 1;
  }

  aggregate.totalTokens = aggregate.inputTokens
    + aggregate.outputTokens
    + aggregate.cacheCreationInputTokens
    + aggregate.cacheReadInputTokens;
  return aggregate;
}

async function writeRunOutputs({ runDir, trialResults, summary }) {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  chmodSync(runDir, 0o700);
  const jsonl = trialResults.map((result) => JSON.stringify(result)).join('\n');
  await atomicWriteFile(path.join(runDir, 'results.jsonl'), jsonl ? `${jsonl}\n` : '');
  await atomicWriteFile(path.join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}

/**
 * Resolve the `--fixture` option into an orchestrate fixture descriptor.
 *
 * The `solution` fixture applies the task's reference `solution/` (a known-good
 * fix) into the trial workdir, so the full run → grade → score pipeline can be
 * demonstrated GREEN on a real golden task without a live, unsupervised
 * orchestrator run (and it seeds the future P2 baseline). Any other value — a
 * name like `pass`/`fail`, a descriptor object, or a function — passes through
 * unchanged to `runOrchestrator`.
 *
 * @param {Function|object|string|undefined} fixture
 * @param {string} taskDir
 * @returns {Function|object|string|undefined}
 */
function resolveFixture(fixture, taskDir) {
  // `none` — a hermetic no-op orchestrator: runs the fixture path (never spawns
  // a real claude) and leaves the seed untouched, so the grader REDs. Used for
  // the broken-outcome side of the green/red demonstration and tests.
  if (fixture === 'none') return { status: 'completed' };
  if (fixture !== 'solution') return fixture;
  const solutionDir = path.join(taskDir, 'solution');
  return {
    status: 'completed',
    mutate: (cwd) => {
      if (existsSync(solutionDir)) {
        cpSync(solutionDir, cwd, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Run one eval task over k isolated trials.
 *
 * @param {string} taskPath Path to an eval task directory.
 * @param {object} [opts]
 * @param {number|string} [opts.k] Override trial count.
 * @param {string} [opts.runId] Override run identifier.
 * @param {number|Function} [opts.now] Injectable timestamp source.
 * @param {string} [opts.resultsDir] Override results root for tests.
 * @param {string} [opts.pluginDir] Plugin directory for live runs.
 * @param {Function} [opts.spawn] Injectable child_process.spawn-compatible function.
 * @param {Function|object|string} [opts.fixture] Deterministic fixture descriptor.
 * @returns {Promise<{runId:string, runDir:string, summary:object, results:object[], exitCode:number}>}
 */
export async function runEval(taskPath, opts = {}) {
  // Safety: spawning the REAL orchestrator (`claude -p /atlas …`) is expensive,
  // token-burning, and runs UNSUPERVISED (the HU-06 / Codex-flagged risk). Never
  // do it implicitly — a live run requires an explicit `--live` (opts.live). With
  // neither a fixture nor --live, refuse with guidance instead of silently
  // firing a real Atlas run.
  if (!opts.live && opts.fixture === undefined) {
    throw new Error(
      'Refusing to run the real orchestrator implicitly. Pass --fixture solution|none for a hermetic run, ' +
      'or --live to spawn the real orchestrator (burns tokens, runs unsupervised).',
    );
  }
  if (opts.live && opts.fixture !== undefined) {
    throw new Error('Choose exactly one execution mode: --live or --fixture');
  }
  const { task, taskDir, graderPath, seedDir } = loadTask(taskPath);
  if (opts.updateBaseline && (opts.fixture !== undefined || !opts.live)) {
    throw new Error('Baseline refresh requires an explicit live run without fixtures');
  }
  if (opts.updateBaseline && task.track !== 'regression') {
    throw new Error('Only regression tasks can update baseline.json');
  }
  const k = resolveK(task, opts);
  const runId = makeRunId(opts);
  const resultsDir = path.resolve(opts.resultsDir ?? path.join(EVALS_DIR, 'results'));
  const runDir = path.join(resultsDir, runId);
  const sourcePluginDir = path.resolve(opts.pluginDir ?? REPO_ROOT);
  const baselinePath = path.resolve(opts.baselinePath ?? path.join(EVALS_DIR, 'baseline.json'));
  const modelTier = task.modelTier ?? 'sonnet';
  const benchmarkFingerprint = fingerprintBenchmark(taskDir);
  const pipelineProtocolFingerprint = fingerprintPipelineProtocol();
  const trialResults = [];
  const tempRoots = [];

  try {
    const graderModule = await import(pathToFileURL(graderPath).href);
    if (typeof graderModule.grade !== 'function') {
      throw new Error(`grader.mjs must export async function grade(workdir): ${graderPath}`);
    }

    for (let trial = 1; trial <= k; trial += 1) {
      const { tmpRoot, workdir } = createTrialWorkdir(seedDir, trial);
      tempRoots.push(tmpRoot);

      const pipelineHandle = opts.live
        ? beginPipelineEvidence({
          workdir,
          orchestrator: task.orchestrator,
          evalRunId: runId,
          taskId: task.id,
          trial,
        })
        : null;
      if (pipelineHandle?.required && !pipelineHandle.ready) {
        throw new Error(`Live pipeline evidence precondition failed: ${pipelineHandle.reason}: ${pipelineHandle.detail}`);
      }

      // Every live trial gets a fresh plugin snapshot. Sharing one writable
      // snapshot across k trials would let an earlier run contaminate a later
      // run even though their task workdirs are isolated.
      const stagedPlugin = opts.live ? stagePluginSnapshot(sourcePluginDir) : null;
      let orchestration;
      try {
        orchestration = await runOrchestrator({
          orchestrator: task.orchestrator,
          prompt: task.prompt,
          cwd: workdir,
          timeoutMs: task.timeoutMs,
          modelTier,
          pluginDir: stagedPlugin?.pluginDir ?? sourcePluginDir,
          spawn: opts.spawn,
          fixture: resolveFixture(opts.fixture, taskDir),
        });
      } finally {
        stagedPlugin?.cleanup();
      }
      // Freeze orchestration evidence BEFORE the grader runs. Graders execute
      // code inside the trial workdir and must never be able to manufacture the
      // protocol evidence that decides whether orchestration itself succeeded.
      const pipelineEvidence = opts.live
        ? verifyPipelineEvidence(pipelineHandle, Date.now())
        : pipelineEvidenceNotApplicable('fixture-mode');
      const grade = await gradeWorkdir(graderModule.grade, workdir);
      const orchestrationPassed = orchestration.status === 'completed' && orchestration.timedOut !== true;
      const pipelinePassed = pipelineEvidence.required !== true || pipelineEvidence.pass === true;
      const checks = [{
        name: 'orchestrator-completed',
        pass: orchestrationPassed,
        detail: orchestrationPassed
          ? 'orchestrator completed'
          : `orchestrator status=${orchestration.status}, timedOut=${Boolean(orchestration.timedOut)}`,
      }, ...(pipelineEvidence.required ? [{
        name: 'pipeline-evidence',
        pass: pipelineEvidence.pass === true,
        detail: pipelineEvidence.detail,
      }] : []), ...grade.checks];

      trialResults.push({
        schemaVersion: 1,
        runId,
        executionMode: opts.live ? 'live' : 'fixture',
        task: task.id,
        track: task.track,
        taskDir,
        trial,
        orchestrator: task.orchestrator,
        modelTier,
        benchmarkFingerprint,
        pipelineProtocolFingerprint,
        pass: orchestrationPassed && pipelinePassed && grade.pass,
        checks,
        usage: orchestration.usage,
        orchestration: summarizeOrchestration(orchestration),
        pipelineEvidence,
      });
    }

    const passHat = passHatK(trialResults);
    const passAt = passAtK(trialResults);
    const tokenUsage = aggregateTokenUsage(trialResults.map((result) => result.usage));
    const pipelineEvidenceSummary = {
      policyVersion: trialResults[0]?.pipelineEvidence?.policyVersion ?? null,
      required: trialResults.some((result) => result.pipelineEvidence?.required === true),
      trust: trialResults.some((result) => result.pipelineEvidence?.required === true)
        ? 'candidate-asserted'
        : 'not-applicable',
      passedTrials: trialResults.filter((result) => result.pipelineEvidence?.pass === true).length,
      totalTrials: trialResults.length,
    };
    const baselineComparison = compareWithBaseline({
      baselinePath,
      taskId: task.id,
      executionMode: opts.live ? 'live' : 'fixture',
      orchestrator: task.orchestrator,
      benchmarkFingerprint,
      pipelineProtocolFingerprint,
      runK: k,
      modelTier,
      passHat,
    });
    const deltaVsBaseline = baselineComparison.delta;
    const deltaVsTarget = baselineComparison.deltaVsTarget;
    const taskSummary = {
      task: task.id,
      track: task.track,
      executionMode: opts.live ? 'live' : 'fixture',
      oracleIsolation: opts.live ? 'staged-plugin-best-effort' : 'fixture',
      orchestrator: task.orchestrator,
      modelTier,
      benchmarkFingerprint,
      pipelineProtocolFingerprint,
      k,
      passHatK: passHat,
      passAtK: passAt,
      tokenUsage,
      pipelineEvidence: pipelineEvidenceSummary,
      deltaVsBaseline,
      delta_vs_baseline: deltaVsBaseline,
      deltaVsTarget,
      delta_vs_target: deltaVsTarget,
      baselineProvenance: baselineComparison.provenance,
      baselineComparison,
    };
    const summary = {
      schemaVersion: 1,
      runId,
      completedAt: new Date().toISOString(),
      executionMode: opts.live ? 'live' : 'fixture',
      oracleIsolation: opts.live ? 'staged-plugin-best-effort' : 'fixture',
      task: task.id,
      track: task.track,
      orchestrator: task.orchestrator,
      modelTier,
      benchmarkFingerprint,
      pipelineProtocolFingerprint,
      k,
      passHatK: passHat,
      passAtK: passAt,
      tokenUsage,
      pipelineEvidence: pipelineEvidenceSummary,
      tasks: [taskSummary],
      tracks: rollupByTrack([taskSummary]),
      trials: trialResults.map((result) => ({
        trial: result.trial,
        modelTier: result.modelTier,
        pass: result.pass,
        checks: result.checks,
        status: result.orchestration.status,
        usage: result.usage,
        pipelineEvidence: result.pipelineEvidence,
      })),
      deltaVsBaseline,
      delta_vs_baseline: deltaVsBaseline,
      deltaVsTarget,
      delta_vs_target: deltaVsTarget,
      baselineProvenance: baselineComparison.provenance,
      baselineComparison,
    };

    await writeRunOutputs({ runDir, trialResults, summary });
    if (opts.updateBaseline) {
      await updateBaselineTask(baselinePath, {
        taskId: task.id,
        k,
        passHatK: passHat,
        runId,
        measuredAt: summary.completedAt,
        modelTier,
        orchestrator: task.orchestrator,
        benchmarkFingerprint,
        pipelineProtocolFingerprint,
      });
    }
    return {
      runId,
      runDir,
      summary,
      results: trialResults,
      exitCode: (task.track === 'capability' ? passAt : passHat) ? 0 : 1,
    };
  } finally {
    for (const tempRoot of tempRoots) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

function parseCliArgs(argv) {
  const opts = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--task') {
      opts.task = argv[++index];
    } else if (arg === '--fixture') {
      opts.fixture = argv[++index];
    } else if (arg === '--live') {
      opts.live = true;
    } else if (arg === '--k') {
      opts.k = argv[++index];
    } else if (arg === '--run-id') {
      opts.runId = argv[++index];
    } else if (arg === '--results-dir') {
      opts.resultsDir = argv[++index];
    } else if (arg === '--baseline') {
      opts.baselinePath = argv[++index];
    } else if (arg === '--update-baseline') {
      opts.updateBaseline = true;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function usage() {
  return [
    'Usage: node evals/run.mjs --task <dir> [--fixture solution|none|pass|fail] [--k N] [--update-baseline]',
    '',
    'Runs one eval task and writes evals/results/<runId>/results.jsonl and summary.json.',
  ].join('\n');
}

async function main() {
  try {
    const opts = parseCliArgs(process.argv.slice(2));
    if (opts.help) {
      console.log(usage());
      return;
    }
    if (!opts.task) {
      throw new Error('Missing required --task <dir>');
    }

    const result = await runEval(opts.task, opts);
    console.log(JSON.stringify({
      schemaVersion: 1,
      runId: result.runId,
      summaryPath: path.join(result.runDir, 'summary.json'),
      passHatK: result.summary.passHatK,
      passAtK: result.summary.passAtK,
    }, null, 2));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
