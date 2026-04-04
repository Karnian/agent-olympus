#!/usr/bin/env node

/**
 * Agent Olympus Plan Execute Gate — PostToolUse hook for ExitPlanMode
 *
 * After a plan is approved via native ExitPlanMode (not the /plan skill),
 * injects execution routing advice based on .ao/autonomy.json planExecution.
 *
 * This is the FALLBACK path — the /plan skill handles its own routing via Phase 5.
 * This hook covers the case where users use Claude's built-in plan mode directly.
 *
 * Never blocks the hook chain: always exits 0.
 */

import { readStdin } from './lib/stdin.mjs';
import { loadAutonomyConfig } from './lib/autonomy.mjs';
import { atomicWriteFileSync } from './lib/fs-atomic.mjs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const STATE_DIR = '.ao/state';
const MARKER_FILE = path.join(STATE_DIR, 'ao-plan-pending.json');

/**
 * Estimate plan complexity from the tool_input (ExitPlanMode payload).
 * ExitPlanMode may include allowedPrompts which hints at complexity.
 * @param {object} data - Hook stdin data
 * @returns {{ isSimple: boolean }}
 */
function estimateComplexity(data) {
  try {
    const prompts = data?.tool_input?.allowedPrompts;
    if (Array.isArray(prompts) && prompts.length <= 2) {
      return { isSimple: true };
    }
    // If we can't determine complexity, assume it's worth asking
    return { isSimple: false };
  } catch {
    return { isSimple: false };
  }
}

/**
 * Build additionalContext for execution routing.
 * @param {string} mode - planExecution mode
 * @param {boolean} isSimple - whether plan is trivially simple
 * @returns {string|null}
 */
function buildContext(mode, isSimple) {
  if (mode === 'solo') return null;

  if (mode === 'ask') {
    if (isSimple) return null; // Don't ask for trivial plans

    return `[PLAN EXECUTION ROUTING]
The plan has been approved. Based on project configuration (planExecution: "ask"), present execution options to the user:

### How would you like to execute this plan?

1. **Solo** — Execute directly (fastest, no overhead)
2. **Atlas** — Sub-agent orchestrator with autonomous loop (recommended for complex tasks)
3. **Athena** — Peer-to-peer team with parallel workers (recommended for large-scale tasks)

> Tip: Set \`planExecution\` in \`.ao/autonomy.json\` to skip this prompt next time.

Wait for the user's choice before proceeding.`;
  }

  if (mode === 'atlas') {
    return `[PLAN EXECUTION ROUTING]
The plan has been approved. User has configured automatic Atlas execution (planExecution: "atlas" in .ao/autonomy.json).
Invoke the /atlas skill now to execute the approved plan. The spec is already in .ao/prd.json.`;
  }

  if (mode === 'athena') {
    return `[PLAN EXECUTION ROUTING]
The plan has been approved. User has configured automatic Athena execution (planExecution: "athena" in .ao/autonomy.json).
Invoke the /athena skill now to execute the approved plan. The spec is already in .ao/prd.json.`;
  }

  return null;
}

async function main() {
  if (process.env.DISABLE_AO === '1') {
    process.stdout.write('{}');
    process.exit(0);
  }

  try {
    const raw = await readStdin(3000);
    let data = {};
    try { data = JSON.parse(raw); } catch {}

    const directory = data.cwd || data.directory || process.cwd();
    const config = loadAutonomyConfig(directory);
    const mode = config.planExecution || 'ask';

    const { isSimple } = estimateComplexity(data);
    const context = buildContext(mode, isSimple);

    // Write marker for SessionStart fallback (context-clear case).
    // - No context (solo or simple+ask): handled=true → SessionStart skips
    // - Has context (ask/atlas/athena): handled=false → if user clears context,
    //   SessionStart will pick up the marker and re-prompt
    try {
      const markerDir = path.join(directory, STATE_DIR);
      mkdirSync(markerDir, { recursive: true, mode: 0o700 });
      atomicWriteFileSync(
        path.join(directory, MARKER_FILE),
        JSON.stringify({
          mode,
          createdAt: new Date().toISOString(),
          handled: !context,
        })
      );
    } catch {}

    if (!context) {
      process.stdout.write('{}');
      process.exit(0);
    }

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: context,
      },
    }));
  } catch {
    process.stdout.write('{}');
  }
  process.exit(0);
}

main();
