#!/usr/bin/env node
/**
 * Concurrency Release — PostToolUse + SubagentStop hook
 *
 * Releases a concurrency slot when a Task/Agent completes (success or error)
 * or when a subagent stops (SubagentStop safety net).
 *
 * Release strategy (in order):
 *   1. Match by task_id if present in tool_input/hook data
 *   2. Match by provider (oldest matching task)
 *   3. Prune stale tasks (>3 min) regardless
 *
 * Never blocks the hook chain: always exits 0.
 */
import { readStdin } from './lib/stdin.mjs';
import { detectProvider } from './lib/provider-detect.mjs';
import { readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { atomicWriteFileSync } from './lib/fs-atomic.mjs';

const STATE_DIR = join(process.cwd(), '.ao', 'state');
const STATE_FILE = join(STATE_DIR, 'ao-concurrency.json');
const STALE_TASK_MS = 3 * 60 * 1000; // 3 minutes (down from 10)

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf-8')); }
  catch { return { activeTasks: [] }; }
}

function writeState(state) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  atomicWriteFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function main() {
  try {
    const raw = await readStdin(3000);
    if (!raw) { process.stdout.write('{}'); process.exit(0); }
    const data = JSON.parse(raw);

    // Accept both PostToolUse (Task/Agent) and SubagentStop events
    const toolName = data.tool_name ?? '';
    const isSubagentStop = data.event === 'SubagentStop' || data.subagent_id != null;
    const isTaskAgent = toolName === 'Task' || toolName === 'Agent';

    if (!isTaskAgent && !isSubagentStop) {
      process.stdout.write('{}');
      process.exit(0);
    }

    const state = readState();
    const now = Date.now();

    // Strategy 1: Try to release by task_id if available
    const taskId = data.tool_input?.task_id ?? data.subagent_id ?? null;
    let releasedById = false;
    if (taskId) {
      const before = state.activeTasks.length;
      state.activeTasks = (state.activeTasks || []).filter(t => t.id !== taskId);
      releasedById = state.activeTasks.length < before;
    }

    // Strategy 2: Release oldest matching provider (skip if already released by ID)
    const provider = detectProvider(data.tool_input ?? {});
    let releasedByProvider = false;
    state.activeTasks = (state.activeTasks || []).filter(t => {
      const age = now - new Date(t.startedAt || 0).getTime();
      // Prune stale tasks (Strategy 3)
      if (age > STALE_TASK_MS) return false;
      // Release oldest matching provider (only if not already released by ID)
      if (!releasedById && !releasedByProvider && t.provider === provider) {
        releasedByProvider = true;
        return false;
      }
      return true;
    });

    // SubagentStop safety net: if nothing was released and we have any tasks,
    // release the oldest task regardless of provider (prevents permanent zombies)
    if (isSubagentStop && !releasedById && !releasedByProvider && state.activeTasks.length > 0) {
      state.activeTasks.shift(); // remove oldest
    }

    writeState(state);
    process.stdout.write('{}');
    process.exit(0);
  } catch {
    process.stdout.write('{}');
    process.exit(0);
  }
}

main();
