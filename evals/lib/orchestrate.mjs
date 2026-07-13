import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyResultEvent } from '../../scripts/lib/claude-cli.mjs';

const DEFAULT_TIMEOUT_MS = 600000;
const SHUTDOWN_GRACE_MS = 5000;
const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const VALID_STATUSES = new Set(['completed', 'failed', 'timeout']);
const SAFE_MODEL_SELECTOR = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;

function normalizeTimeoutMs(value) {
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_TIMEOUT_MS;
}

function normalizeStatus(status, fallback = 'completed') {
  if (VALID_STATUSES.has(status)) return status;
  if (status === 'pass' || status === 'fail') return 'completed';
  if (status === 'error') return 'failed';
  return fallback;
}

function normalizeModelTier(value) {
  const modelTier = String(value ?? 'sonnet');
  if (!SAFE_MODEL_SELECTOR.test(modelTier)) {
    throw new Error(`Unsafe Claude model selector: ${modelTier}`);
  }
  return modelTier;
}

function buildLiveEnv(cwd) {
  const env = { ...process.env, PWD: resolve(cwd) };
  // The live worker needs provider credentials, but inherited shell/package
  // location hints can point straight back to the source repository that owns
  // hidden eval oracles. Claude receives only the trial cwd + staged plugin
  // path through its explicit argv.
  for (const key of [
    'OLDPWD',
    'INIT_CWD',
    'npm_config_local_prefix',
    'npm_package_json',
    'CLAUDE_PROJECT_DIR',
    'CLAUDE_PLUGIN_ROOT',
  ]) delete env[key];
  return env;
}

function errorToEvent(error) {
  return {
    type: 'error',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
}

function descriptorName(descriptor) {
  if (typeof descriptor === 'string') return descriptor;
  if (descriptor && typeof descriptor === 'object') {
    return descriptor.name ?? descriptor.fixture ?? null;
  }
  return null;
}

function descriptorStatus(descriptor) {
  const name = descriptorName(descriptor);
  if (name === 'timeout') return 'timeout';
  if (name === 'failed' || name === 'error') return 'failed';
  if (descriptor && typeof descriptor === 'object') {
    return normalizeStatus(descriptor.status);
  }
  return 'completed';
}

async function applyFixtureMutation(descriptor, cwd) {
  const name = descriptorName(descriptor);

  if (name === 'pass') {
    const markerPath = join(cwd, 'marker.txt');
    if (existsSync(markerPath)) {
      writeFileSync(markerPath, 'fixed\n', { encoding: 'utf-8' });
    }
  }

  if (descriptor && typeof descriptor === 'object') {
    if (typeof descriptor.mutate === 'function') {
      await descriptor.mutate(cwd);
    }
    if (descriptor.writeFile && typeof descriptor.writeFile === 'object') {
      const filePath = join(cwd, String(descriptor.writeFile.path));
      writeFileSync(filePath, String(descriptor.writeFile.content ?? ''), {
        encoding: 'utf-8',
      });
    }
  }
}

async function runFixture({ fixture, cwd }) {
  let descriptor = fixture;
  if (typeof fixture === 'function') {
    descriptor = await fixture(cwd);
  }

  await applyFixtureMutation(descriptor, cwd);

  const status = descriptorStatus(descriptor);
  const timedOut = status === 'timeout' || Boolean(descriptor?.timedOut);
  const name = descriptorName(descriptor);
  const finalEvent = descriptor?.finalEvent ?? {
    type: 'fixture',
    status,
    name,
  };

  return {
    status,
    finalEvent,
    // Fixtures prove harness behavior without invoking a provider. Never let a
    // fixture descriptor masquerade as real provider token usage.
    usage: null,
    timedOut,
    raw: {
      fixture: name,
      descriptorStatus: descriptor?.status ?? null,
    },
  };
}

function buildClaudeArgs({ orchestrator, prompt, pluginDir, modelTier }) {
  return [
    '-p',
    `/${orchestrator} ${prompt}`,
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
    '--no-session-persistence',
    '--model',
    modelTier,
    '--plugin-dir',
    pluginDir,
  ];
}

function killChild(child, signal) {
  if (child?.pid) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {}
  }

  if (typeof child?.kill === 'function') {
    try {
      child.kill(signal);
      return true;
    } catch {}
  }

  return false;
}

function parseTerminalStream(stdout) {
  const events = [];
  const malformedLines = [];
  const lines = String(stdout).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index].trim();
    if (!text) continue;
    try {
      const event = JSON.parse(text);
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        malformedLines.push(index + 1);
      } else {
        events.push(event);
      }
    } catch {
      malformedLines.push(index + 1);
    }
  }

  const resultEvents = events.filter((event) => event.type === 'result');
  const explicitError = events.some((event) => event.type === 'error');
  const assistantError = events.some((event) => event.type === 'assistant' && event.error);
  let resultCategory = null;
  if (malformedLines.length > 0) resultCategory = 'malformed_stream';
  else if (explicitError) resultCategory = 'error_event';
  else if (assistantError) resultCategory = 'assistant_error';
  else if (resultEvents.length === 0) resultCategory = 'missing_result';
  else if (resultEvents.length !== 1) resultCategory = 'multiple_results';
  else if (events.at(-1) !== resultEvents[0]) resultCategory = 'result_not_terminal';
  else if (resultEvents[0].subtype !== 'success' || resultEvents[0].is_error !== false) {
    resultCategory = classifyResultEvent(resultEvents[0]) || 'invalid_result';
  }

  const resultEvent = resultCategory === null ? resultEvents[0] : null;
  const finalEvent = resultCategory === null
    ? resultEvent
    : {
      type: 'stream_error',
      category: resultCategory,
      malformedLines,
    };
  return { events, malformedLines, resultEvent, finalEvent, resultCategory };
}

function parseLiveResult({ stdout, stderr, timedOut, exitCode, signal, error, args, modelTier }) {
  const parsed = parseTerminalStream(stdout);
  const finalEvent = error ? errorToEvent(error) : parsed.finalEvent;
  // Exit 0 is insufficient. A successful live run has exactly one result event,
  // it is the last non-blank JSONL record, and it is an explicit success. Any
  // malformed or trailing record makes the stream non-terminal and fails closed.
  const resultCategory = error ? 'process_error' : parsed.resultCategory;
  const abnormalExit = !timedOut && (exitCode !== 0 || signal != null);
  const failed = Boolean(error || resultCategory || abnormalExit);
  const status = timedOut ? 'timeout' : failed ? 'failed' : 'completed';

  return {
    status,
    finalEvent,
    usage: parsed.resultEvent?.usage ?? null,
    timedOut,
    raw: {
      argv: ['claude', ...args],
      modelTier,
      stdout,
      stderr,
      events: parsed.events,
      malformedLines: parsed.malformedLines,
      exitCode,
      signal,
      error: error ? errorToEvent(error) : null,
      resultCategory,
    },
  };
}

async function runLive({
  orchestrator,
  prompt,
  cwd,
  timeoutMs,
  modelTier,
  pluginDir,
  spawn,
}) {
  const effectivePluginDir = resolve(pluginDir ?? REPO_ROOT);
  const effectiveTimeoutMs = normalizeTimeoutMs(timeoutMs);
  const killGraceMs = Math.min(SHUTDOWN_GRACE_MS, effectiveTimeoutMs);
  const effectiveModelTier = normalizeModelTier(modelTier);
  const args = buildClaudeArgs({
    orchestrator,
    prompt,
    pluginDir: effectivePluginDir,
    modelTier: effectiveModelTier,
  });

  let child;
  try {
    child = spawn('claude', args, {
      cwd,
      env: buildLiveEnv(cwd),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
  } catch (error) {
    return parseLiveResult({
      stdout: '',
      stderr: '',
      timedOut: false,
      exitCode: null,
      signal: null,
      error,
      args,
      modelTier: effectiveModelTier,
    });
  }

  return await new Promise((resolveResult) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;
    let settled = false;
    let timeoutTimer = null;
    let killTimer = null;

    const finish = ({ exitCode = null, signal = null, error = null } = {}) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);

      resolveResult(parseLiveResult({
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
        timedOut,
        exitCode,
        signal,
        error,
        args,
        modelTier: effectiveModelTier,
      }));
    };

    child?.stdout?.on?.('data', (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk));
    });
    child?.stderr?.on?.('data', (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk));
    });
    child?.once?.('error', (error) => finish({ error }));
    child?.once?.('close', (exitCode, signal) => finish({ exitCode, signal }));

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killChild(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        killChild(child, 'SIGKILL');
        finish({ signal: 'SIGKILL' });
      }, killGraceMs);
      killTimer.unref?.();
    }, effectiveTimeoutMs);
    timeoutTimer.unref?.();
  });
}

/**
 * Run an Olympus orchestrator headlessly.
 *
 * The fixture path is deterministic and used by tests. The live path is
 * intentionally available for manual eval runs only; it invokes Claude Code
 * with this repository loaded as the plugin directory and without --bare.
 *
 * @param {object} params
 * @param {'atlas'|'athena'|'solo'} params.orchestrator Orchestrator command.
 * @param {string} params.prompt Prompt to pass to the orchestrator.
 * @param {string} params.cwd Trial working directory.
 * @param {number} [params.timeoutMs=600000] Timeout in milliseconds.
 * @param {string} [params.modelTier='sonnet'] Claude model selector, also persisted for reporting.
 * @param {string} [params.pluginDir] Plugin directory for live Claude runs.
 * @param {Function} [params.spawn] Injectable child_process.spawn-compatible function.
 * @param {Function|object|string} [params.fixture] Deterministic fixture descriptor.
 * @returns {Promise<{status:'completed'|'failed'|'timeout', finalEvent: object|null, usage: object|null, timedOut: boolean, raw: object}>}
 */
export async function runOrchestrator({
  orchestrator,
  prompt,
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  modelTier = 'sonnet',
  pluginDir,
  spawn = nodeSpawn,
  fixture,
}) {
  try {
    if (fixture !== undefined && fixture !== null) {
      return await runFixture({ fixture, cwd });
    }

    return await runLive({
      orchestrator,
      prompt,
      cwd,
      timeoutMs,
      modelTier,
      pluginDir,
      spawn,
    });
  } catch (error) {
    return {
      status: 'failed',
      finalEvent: errorToEvent(error),
      usage: null,
      timedOut: false,
      raw: {
        error: errorToEvent(error),
      },
    };
  }
}
