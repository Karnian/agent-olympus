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
import { logUsage } from './lib/model-usage.mjs';
import { isCriticAgent, parseStageVerdict } from './lib/stage-escalation.mjs';

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

    // Append new result — include structured stage_verdict when the
    // subagent is a critic and its output carries a STAGE_VERDICT block.
    const agentType = data.tool_input?.subagent_type || null;
    const entry = {
      timestamp: new Date().toISOString(),
      toolName: data.tool_name || null,
      agentType,
      transcriptPath: data.agent_transcript_path || null,
      lastMessage: lastMessage.slice(0, 4000), // Cap message size
    };
    if (isCriticAgent(agentType)) {
      const parsed = parseStageVerdict(lastMessage);
      if (parsed) entry.stageVerdict = parsed;
    }
    results.push(entry);

    // FIFO cap — keep only the most recent MAX_RESULTS entries
    if (results.length > MAX_RESULTS) {
      results = results.slice(-MAX_RESULTS);
    }

    await atomicWriteFile(RESULTS_FILE, JSON.stringify(results, null, 2), { mode: 0o600 });

    // Emit subagent_completed event to active run if one exists (US-005)
    let activeRunId = null;
    try {
      const activeRun = discoverActiveRun();
      if (activeRun) {
        activeRunId = activeRun.runId;
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

    // Phase 0 — model usage logging for Opus-skew analysis.
    // Fail-safe: logUsage() swallows all errors internally.
    // Known blind spot: native team TaskCreated/Completed events are not
    // observed here. Athena native-team workers will not appear in the log
    // until a dedicated hook is added (Phase-deferred).
    const promptStr = typeof data.tool_input?.prompt === 'string'
      ? data.tool_input.prompt : '';
    logUsage({
      runId: activeRunId,
      agentType: data.tool_input?.subagent_type || null,
      model: data.tool_input?.model || null,  // resolveEffectiveModel() falls back to AGENT_DEFAULT_MODEL
      inputCharLength: promptStr.length,
      outputCharLength: lastMessage.length,
      toolName: data.tool_name || null,
      transcriptPath: data.agent_transcript_path || null,
    });

    process.stdout.write('{}');
  } catch {
    process.stdout.write('{}');
  }
  process.exit(0);
}

main();
