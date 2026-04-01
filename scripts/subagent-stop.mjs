#!/usr/bin/env node
/**
 * SubagentStop hook — captures subagent results for Atlas/Athena consumption.
 * Appends each result to .ao/state/ao-subagent-results.json (capped at 50).
 * Never blocks: always exits 0.
 */

import { readStdin } from './lib/stdin.mjs';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from './lib/fs-atomic.mjs';
import { discoverActiveRun, addEvent } from './lib/run-artifacts.mjs';

const STATE_DIR = join(process.cwd(), '.ao', 'state');
const RESULTS_FILE = join(STATE_DIR, 'ao-subagent-results.json');
const MAX_RESULTS = 50;

async function main() {
  try {
    const raw = await readStdin(3000);
    const data = JSON.parse(raw);

    // Only capture if there's meaningful content
    const lastMessage = data.last_assistant_message || '';
    if (!lastMessage.trim()) {
      process.stdout.write('{}');
      process.exit(0);
    }

    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });

    // Load existing results
    let results = [];
    try {
      results = JSON.parse(readFileSync(RESULTS_FILE, 'utf-8'));
      if (!Array.isArray(results)) results = [];
    } catch { /* file doesn't exist yet */ }

    // Append new result
    results.push({
      timestamp: new Date().toISOString(),
      toolName: data.tool_name || null,
      agentType: data.tool_input?.subagent_type || null,
      transcriptPath: data.agent_transcript_path || null,
      lastMessage: lastMessage.slice(0, 4000), // Cap message size
    });

    // FIFO cap — keep only the most recent MAX_RESULTS entries
    if (results.length > MAX_RESULTS) {
      results = results.slice(-MAX_RESULTS);
    }

    await atomicWriteFile(RESULTS_FILE, JSON.stringify(results, null, 2), { mode: 0o600 });

    // Emit subagent_completed event to active run if one exists (US-005)
    try {
      const activeRun = discoverActiveRun();
      if (activeRun) {
        addEvent(activeRun.runId, {
          type: 'subagent_completed',
          detail: {
            agentType: data.tool_input?.subagent_type || null,
            toolName: data.tool_name || null,
            messageLength: lastMessage.length,
          },
        });
      }
    } catch {
      // fail-safe: event emission failure must not affect FIFO behavior
    }

    process.stdout.write('{}');
  } catch {
    process.stdout.write('{}');
  }
  process.exit(0);
}

main();
