#!/usr/bin/env node
/**
 * PreToolUse hook for Task/Agent — enforces concurrency limits.
 *
 * Reads limits from config/model-routing.jsonc (concurrency section),
 * with env var overrides (AO_CONCURRENCY_*) taking highest priority.
 *
 * Priority: env var > config file > hardcoded defaults
 *
 * Never blocks the hook chain on error: always exits 0.
 */

import { readStdin } from './lib/stdin.mjs';
import { detectProvider } from './lib/provider-detect.mjs';
import { readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { atomicWriteFileSync } from './lib/fs-atomic.mjs';

const STATE_DIR = join(process.cwd(), '.ao', 'state');
const STATE_FILE = join(STATE_DIR, 'ao-concurrency.json');

const STALE_TASK_MS = 3 * 60 * 1000; // 3 minutes (aligned with concurrency-release)

// Hardcoded defaults (used when config file is absent or invalid)
const DEFAULTS = {
  global: 10,
  claude: 8,
  codex: 5,
  gemini: 5,
};

function readState() {
  try {
    if (!existsSync(STATE_FILE)) {
      return { activeTasks: [], queue: [] };
    }
    const raw = readFileSync(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      activeTasks: Array.isArray(parsed.activeTasks) ? parsed.activeTasks : [],
      queue: Array.isArray(parsed.queue) ? parsed.queue : [],
    };
  } catch {
    return { activeTasks: [], queue: [] };
  }
}

function writeState(state) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  atomicWriteFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function pruneStale(activeTasks) {
  const now = Date.now();
  return activeTasks.filter((task) => {
    if (!task.startedAt) return false;
    return now - new Date(task.startedAt).getTime() < STALE_TASK_MS;
  });
}

function parseIntSafe(envVar, defaultVal) {
  const raw = process.env[envVar];
  if (raw === undefined || raw === '') return defaultVal;
  const num = parseInt(raw, 10);
  return Number.isInteger(num) && num > 0 ? num : defaultVal;
}

/**
 * Strip JSONC-style comments (// and /* ... * /) from a string.
 * @param {string} source
 * @returns {string}
 */
function stripJsoncComments(source) {
  let result = source.replace(/\/\*[\s\S]*?\*\//g, '');
  result = result.replace(/\/\/[^\n]*/g, '');
  return result;
}

/**
 * Load concurrency limits from config/model-routing.jsonc.
 * Falls back to DEFAULTS on any error.
 * @returns {{ global: number, claude: number, codex: number, gemini: number }}
 */
function loadConfigLimits() {
  try {
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    if (!pluginRoot) return { ...DEFAULTS };

    const configPath = join(pluginRoot, 'config', 'model-routing.jsonc');
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(stripJsoncComments(raw));
    const c = parsed?.concurrency;
    if (!c || typeof c !== 'object') return { ...DEFAULTS };

    return {
      global: typeof c.maxParallelTasks === 'number' && c.maxParallelTasks > 0 ? c.maxParallelTasks : DEFAULTS.global,
      claude: typeof c.maxClaudeWorkers === 'number' && c.maxClaudeWorkers > 0 ? c.maxClaudeWorkers : DEFAULTS.claude,
      codex: typeof c.maxCodexWorkers === 'number' && c.maxCodexWorkers > 0 ? c.maxCodexWorkers : DEFAULTS.codex,
      gemini: typeof c.maxGeminiWorkers === 'number' && c.maxGeminiWorkers > 0 ? c.maxGeminiWorkers : DEFAULTS.gemini,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Get concurrency limits. Priority: env var > config file > hardcoded defaults.
 */
function getLimits() {
  const fromConfig = loadConfigLimits();
  return {
    global: parseIntSafe('AO_CONCURRENCY_GLOBAL', fromConfig.global),
    claude: parseIntSafe('AO_CONCURRENCY_CLAUDE', fromConfig.claude),
    codex: parseIntSafe('AO_CONCURRENCY_CODEX', fromConfig.codex),
    gemini: parseIntSafe('AO_CONCURRENCY_GEMINI', fromConfig.gemini),
  };
}

async function main() {
  let input;
  try {
    input = await readStdin();
  } catch {
    process.stdout.write('{}');
    process.exit(0);
  }

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    process.stdout.write('{}');
    process.exit(0);
  }

  try {
    const toolName = data?.tool_name ?? '';
    // Only gate Task and Agent tool invocations
    if (toolName !== 'Task' && toolName !== 'Agent') {
      process.stdout.write('{}');
      process.exit(0);
    }

    const toolInput = data?.tool_input ?? {};
    const provider = detectProvider(toolInput);
    const limits = getLimits();

    const state = readState();
    // Prune stale tasks before checking limits
    state.activeTasks = pruneStale(state.activeTasks);

    const globalCount = state.activeTasks.length;
    const providerCount = state.activeTasks.filter((t) => t.provider === provider).length;
    const providerLimit = limits[provider] ?? limits.global;

    if (globalCount >= limits.global) {
      writeState(state);
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: `Concurrency limit reached globally (${globalCount}/${limits.global} active). Wait for a task to complete.`,
      }));
      process.exit(0);
    }

    if (providerCount >= providerLimit) {
      writeState(state);
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: `Concurrency limit reached for ${provider} (${providerCount}/${providerLimit} active). Wait for a task to complete.`,
      }));
      process.exit(0);
    }

    // Under limits - add to active tasks
    const taskId = randomUUID();
    state.activeTasks.push({
      id: taskId,
      provider,
      model: toolInput?.model ?? toolInput?.subagent_type ?? provider,
      startedAt: new Date().toISOString(),
    });
    writeState(state);

    process.stdout.write('{}');
  } catch {
    process.stdout.write('{}');
  }

  process.exit(0);
}

main();
