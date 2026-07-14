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
import { releaseHookConcurrency } from './lib/concurrency-limits.mjs';

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

    const taskId = data.tool_use_id ?? data.tool_input?.task_id ?? data.subagent_id ?? null;
    const provider = detectProvider(data.tool_input ?? {});
    releaseHookConcurrency(process.cwd(), { taskId, provider, isSubagentStop });
    process.stdout.write('{}');
    process.exit(0);
  } catch {
    process.stdout.write('{}');
    process.exit(0);
  }
}

main();
