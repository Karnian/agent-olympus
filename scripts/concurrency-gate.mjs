#!/usr/bin/env node
/**
 * PreToolUse hook for Task tool - enforces concurrency limits
 * Tracks active sub-agent tasks and blocks when limits are exceeded.
 */

import { readStdin } from './lib/stdin.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

const STATE_DIR = join(process.cwd(), '.omc', 'state');
const STATE_FILE = join(STATE_DIR, 'oac-concurrency.json');

const STALE_TASK_MS = 10 * 60 * 1000; // 10 minutes

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
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function pruneStale(activeTasks) {
  const now = Date.now();
  return activeTasks.filter((task) => {
    if (!task.startedAt) return false;
    return now - new Date(task.startedAt).getTime() < STALE_TASK_MS;
  });
}

function detectProvider(toolInput) {
  const subagentType = toolInput?.subagent_type ?? '';
  const model = (toolInput?.model ?? '').toLowerCase();

  if (subagentType.includes('claude') || model.includes('claude') || model.includes('anthropic')) {
    return 'claude';
  }
  if (subagentType.includes('codex') || model.includes('codex') || model.includes('openai') || model.includes('gpt')) {
    return 'codex';
  }
  if (subagentType.includes('gemini') || model.includes('gemini') || model.includes('google')) {
    return 'gemini';
  }
  // Default: treat as claude if subagent_type contains 'agent-olympus' or similar
  if (subagentType) {
    return 'claude';
  }
  return 'claude';
}

function getLimits() {
  return {
    global: parseInt(process.env.OMC_CONCURRENCY_GLOBAL ?? '5', 10),
    claude: parseInt(process.env.OMC_CONCURRENCY_CLAUDE ?? '3', 10),
    codex: parseInt(process.env.OMC_CONCURRENCY_CODEX ?? '2', 10),
    gemini: parseInt(process.env.OMC_CONCURRENCY_GEMINI ?? '2', 10),
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
    // Only gate Task tool invocations
    if (toolName !== 'Task') {
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
