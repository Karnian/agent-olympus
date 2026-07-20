#!/usr/bin/env node
/**
 * PreToolUse hook for Task/Agent — enforces concurrency limits.
 *
 * Reads limits from config/model-routing.jsonc (concurrency section),
 * with env var overrides (AO_CONCURRENCY_*) taking highest priority.
 *
 * Priority: env var > config file > hardcoded defaults
 *
 * Ledger errors fail closed for Task/Agent so malformed or unsafe state cannot
 * authorize extra work. The hook process itself still exits 0 as required by
 * the Claude Code hook protocol.
 */

import { readStdin } from './lib/stdin.mjs';
import { detectProvider } from './lib/provider-detect.mjs';
import { loadConcurrencyLimits, reserveHookConcurrency } from './lib/concurrency-limits.mjs';

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
    const limits = loadConcurrencyLimits();
    const admission = reserveHookConcurrency(process.cwd(), {
      provider,
      model: toolInput?.model ?? toolInput?.subagent_type ?? provider,
      taskId: data?.tool_use_id ?? toolInput?.task_id ?? null,
    }, { limits });

    if (!admission.ok) {
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: `Concurrency admission denied: ${admission.errors.join('; ')}`,
      }));
    } else {
      process.stdout.write('{}');
    }
  } catch (error) {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: `Concurrency admission failed closed: ${error?.message || String(error)}`,
    }));
  }

  process.exit(0);
}

main();
