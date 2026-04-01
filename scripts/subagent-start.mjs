#!/usr/bin/env node
/**
 * SubagentStart hook — injects wisdom context into spawning subagents.
 * Reads recent learnings from .ao/wisdom.jsonl and provides them as additionalContext.
 * Never blocks: always exits 0.
 */

import { readStdin } from './lib/stdin.mjs';
import { queryWisdom, formatWisdomForPrompt } from './lib/wisdom.mjs';

async function main() {
  try {
    const raw = await readStdin(3000);
    let _data = {};
    try { _data = JSON.parse(raw); } catch { /* non-fatal */ }

    // Query recent wisdom entries — medium confidence or better, most recent 10
    const entries = await queryWisdom({ minConfidence: 'medium', limit: 10 });
    if (!entries || entries.length === 0) {
      process.stdout.write('{}');
      process.exit(0);
    }

    const wisdomContext = formatWisdomForPrompt(entries);
    if (!wisdomContext.trim()) {
      process.stdout.write('{}');
      process.exit(0);
    }

    process.stdout.write(JSON.stringify({
      additionalContext: wisdomContext,
    }));
  } catch {
    process.stdout.write('{}');
  }
  process.exit(0);
}

main();
