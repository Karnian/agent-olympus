#!/usr/bin/env node
/**
 * notify-cli.mjs — CLI wrapper for agent-olympus desktop notifications.
 *
 * Invoked by orchestrator skills via Bash tool to fire desktop notifications
 * without requiring the caller to import notify.mjs directly.
 *
 * Usage:
 *   node scripts/notify-cli.mjs --title "Atlas" --body "Done" --sound
 *   node scripts/notify-cli.mjs --event complete --orchestrator atlas --body "5/5 passed"
 *   node scripts/notify-cli.mjs --event blocked  --orchestrator athena
 *
 * Always exits 0 (fail-safe). Zero npm dependencies.
 */

import { notify, notifyOrchestrator } from './lib/notify.mjs';

/**
 * Parse process.argv into a flat key→value map.
 * Flags with no value (e.g. --sound) are set to true.
 *
 * @param {string[]} argv - process.argv slice from index 2
 * @returns {Record<string, string | true>}
 */
function parseArgs(argv) {
  const result = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      // Peek at next token: if it exists and is not itself a flag, treat it as the value
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        result[key] = next;
        i += 2;
      } else {
        // Boolean flag (no value)
        result[key] = true;
        i += 1;
      }
    } else {
      // Positional argument — skip
      i += 1;
    }
  }
  return result;
}

/**
 * Main entry point. Parses CLI args and dispatches to notify or notifyOrchestrator.
 * Wrapped in try/catch to ensure process always exits 0.
 */
async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));

    const title       = typeof args.title       === 'string' ? args.title       : 'Agent Olympus';
    const body        = typeof args.body        === 'string' ? args.body        : 'Task complete.';
    const sound       = args.sound === true;
    const event       = typeof args.event       === 'string' ? args.event       : undefined;
    const orchestrator = typeof args.orchestrator === 'string' ? args.orchestrator : 'atlas';

    if (event) {
      // Route to orchestrator lifecycle notification
      notifyOrchestrator({ event, orchestrator, summary: body });
    } else {
      // Generic notification
      notify({ title, body, sound });
    }
  } catch {
    // Fail-safe: never let a notification error propagate
  }
  process.exit(0);
}

main();
