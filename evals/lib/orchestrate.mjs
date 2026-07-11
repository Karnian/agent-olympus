import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyResultEvent,
  parseStreamJsonEvents,
} from '../../scripts/lib/claude-cli.mjs';

const DEFAULT_TIMEOUT_MS = 600000;
const SHUTDOWN_GRACE_MS = 5000;
const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const VALID_STATUSES = new Set(['completed', 'failed', 'timeout']);

function normalizeTimeoutMs(value) {
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_TIMEOUT_MS;
}

function normalizeStatus(status, fallback = 'completed') {
  if (VALID_STATUSES.has(status)) return status;
  if (status === 'pass' || status === 'fail') return 'completed';
  if (status === 'error') return 'failed';
  return fallback;
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

function buildClaudeArgs({ orchestrator, prompt, pluginDir }) {
  return [
    '-p',
    `/${orchestrator} ${prompt}`,
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
    '--no-session-persistence',
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

function parseLiveResult({ stdout, stderr, timedOut, exitCode, signal, error, args, modelTier }) {
  const parseBuffer = stdout.endsWith('\n') ? stdout : `${stdout}\n`;
  const { events, remainder } = parseStreamJsonEvents(parseBuffer);
  const finalEvent = [...events].reverse().find((event) => event?.type === 'result')
    ?? events.at(-1)
    ?? (error ? errorToEvent(error) : { type: 'process_exit', exitCode, signal });
  const resultEvent = finalEvent?.type === 'result' ? finalEvent : null;
  const resultCategory = classifyResultEvent(resultEvent);
  const failed = Boolean(error || resultCategory || (!timedOut && exitCode != null && exitCode !== 0));
  const status = timedOut ? 'timeout' : failed ? 'failed' : 'completed';

  return {
    status,
    finalEvent,
    usage: resultEvent?.usage ?? null,
    timedOut,
    raw: {
      argv: ['claude', ...args],
      modelTier,
      stdout,
      stderr,
      events,
      remainder,
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
  const args = buildClaudeArgs({ orchestrator, prompt, pluginDir: effectivePluginDir });

  let child;
  try {
    child = spawn('claude', args, {
      cwd,
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
      modelTier,
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
        modelTier,
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
 * @param {string} [params.modelTier='sonnet'] Logical model tier for reporting.
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
