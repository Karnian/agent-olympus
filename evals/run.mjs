#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { atomicWriteFile } from '../scripts/lib/fs-atomic.mjs';
import { runOrchestrator } from './lib/orchestrate.mjs';
import { passAtK, passHatK } from './lib/score.mjs';

const EVALS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(EVALS_DIR, '..');
const VALID_TRACKS = new Set(['regression', 'capability']);
const VALID_ORCHESTRATORS = new Set(['atlas', 'athena', 'solo']);
let fallbackRunCounter = 0;

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function assertString(value, field, errors) {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${field} must be a non-empty string`);
  }
}

function validateTask(task) {
  const errors = [];

  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw new Error('task.json must contain a JSON object');
  }

  if (task.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  assertString(task.id, 'id', errors);
  assertString(task.prompt, 'prompt', errors);

  if (!VALID_TRACKS.has(task.track)) {
    errors.push('track must be one of: regression, capability');
  }
  if (!VALID_ORCHESTRATORS.has(task.orchestrator)) {
    errors.push('orchestrator must be one of: atlas, athena, solo');
  }
  if (task.timeoutMs !== undefined && (!Number.isInteger(task.timeoutMs) || task.timeoutMs <= 0)) {
    errors.push('timeoutMs must be a positive integer when present');
  }
  if (task.k !== undefined && (!Number.isInteger(task.k) || task.k <= 0)) {
    errors.push('k must be a positive integer when present');
  }
  if (task.modelTier !== undefined && (typeof task.modelTier !== 'string' || task.modelTier.trim() === '')) {
    errors.push('modelTier must be a non-empty string when present');
  }
  if (task.difficulty !== undefined && typeof task.difficulty !== 'string') {
    errors.push('difficulty must be a string when present');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid task.json: ${errors.join('; ')}`);
  }
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
  validateTask(task);
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

function makeRunId(opts) {
  if (opts.runId) return String(opts.runId);
  const now = safeNow(opts.now);
  const prefix = now === null || now === undefined
    ? 'notime'
    : String(now).replace(/[^a-zA-Z0-9._-]/g, '-');
  return `eval-${prefix}-${safeRandomHex()}`;
}

function initGitIfAvailable(workdir) {
  try {
    execFileSync('git', ['init'], { cwd: workdir, stdio: 'ignore' });
  } catch {}
}

function createTrialWorkdir(seedDir, trialIndex) {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'ao-eval-'));
  const workdir = path.join(tmpRoot, `trial-${trialIndex}`);
  cpSync(seedDir, workdir, { recursive: true, force: true });
  initGitIfAvailable(workdir);
  return { tmpRoot, workdir };
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

function readBaseline(baselinePath) {
  if (!existsSync(baselinePath)) return null;
  try {
    return readJson(baselinePath);
  } catch {
    return null;
  }
}

function baselineValueForTask(baseline, taskId) {
  const candidate = baseline?.tasks?.[taskId] ?? baseline?.[taskId];
  if (typeof candidate === 'number') return candidate;
  if (typeof candidate === 'boolean') return candidate ? 1 : 0;
  if (typeof candidate?.passHatK === 'number') return candidate.passHatK;
  if (typeof candidate?.passHatK === 'boolean') return candidate.passHatK ? 1 : 0;
  return null;
}

function computeDeltaVsBaseline({ baselinePath, taskId, passHat }) {
  const baseline = readBaseline(baselinePath);
  const baselineValue = baselineValueForTask(baseline, taskId);
  if (baselineValue === null) return null;
  return (passHat ? 1 : 0) - baselineValue;
}

function summarizeOrchestration(orchestration) {
  return {
    status: orchestration.status,
    finalEvent: orchestration.finalEvent,
    usage: orchestration.usage,
    timedOut: orchestration.timedOut,
  };
}

async function writeRunOutputs({ runDir, trialResults, summary }) {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
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
  const { task, taskDir, graderPath, seedDir } = loadTask(taskPath);
  const k = resolveK(task, opts);
  const runId = makeRunId(opts);
  const resultsDir = path.resolve(opts.resultsDir ?? path.join(EVALS_DIR, 'results'));
  const runDir = path.join(resultsDir, runId);
  const pluginDir = path.resolve(opts.pluginDir ?? REPO_ROOT);
  const baselinePath = path.resolve(opts.baselinePath ?? path.join(EVALS_DIR, 'baseline.json'));
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

      const orchestration = await runOrchestrator({
        orchestrator: task.orchestrator,
        prompt: task.prompt,
        cwd: workdir,
        timeoutMs: task.timeoutMs,
        modelTier: task.modelTier ?? 'sonnet',
        pluginDir,
        fixture: resolveFixture(opts.fixture, taskDir),
      });
      const grade = await gradeWorkdir(graderModule.grade, workdir);

      trialResults.push({
        schemaVersion: 1,
        runId,
        task: task.id,
        track: task.track,
        taskDir,
        trial,
        orchestrator: task.orchestrator,
        pass: grade.pass,
        checks: grade.checks,
        usage: orchestration.usage,
        orchestration: summarizeOrchestration(orchestration),
      });
    }

    const passHat = passHatK(trialResults);
    const passAt = passAtK(trialResults);
    const summary = {
      schemaVersion: 1,
      runId,
      task: task.id,
      track: task.track,
      passHatK: passHat,
      passAtK: passAt,
      trials: trialResults.map((result) => ({
        trial: result.trial,
        pass: result.pass,
        checks: result.checks,
        status: result.orchestration.status,
        usage: result.usage,
      })),
      deltaVsBaseline: computeDeltaVsBaseline({
        baselinePath,
        taskId: task.id,
        passHat,
      }),
    };

    await writeRunOutputs({ runDir, trialResults, summary });
    return {
      runId,
      runDir,
      summary,
      results: trialResults,
      exitCode: passHat ? 0 : 1,
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
    'Usage: node evals/run.mjs --task <dir> [--fixture pass|fail] [--k N]',
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
