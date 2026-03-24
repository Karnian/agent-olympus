#!/usr/bin/env node

/**
 * Agent Olympus Model Router - PreToolUse hook for Task tool
 *
 * Reads the intent state saved by intent-gate.mjs and injects model routing
 * advice as additionalContext when Claude is about to spawn a Task (subagent).
 *
 * Only provides advisory context — never blocks the hook chain.
 * Always exits 0.
 */

import fs from 'fs';
import path from 'path';
import { readStdin } from './lib/stdin.mjs';
import { routeByIntent } from './lib/model-router.mjs';

const STATE_DIR = '.ao/state';
const INTENT_FILE = 'ao-intent.json';

/**
 * Load the saved intent state from .ao/state/ao-intent.json.
 * Returns null if file is missing, unreadable, or stale (> 10 min old).
 * @param {string} directory
 * @returns {{ category: string, confidence: number, scores: Record<string, number> }|null}
 */
function loadIntentState(directory) {
  try {
    const statePath = path.join(directory, STATE_DIR, INTENT_FILE);
    const raw = fs.readFileSync(statePath, 'utf-8');
    const state = JSON.parse(raw);

    // Discard stale intent (older than 10 minutes)
    const savedAt = new Date(state.savedAt).getTime();
    if (Number.isFinite(savedAt) && Date.now() - savedAt > 10 * 60 * 1000) {
      return null;
    }

    return {
      category: state.category || 'unknown',
      confidence: typeof state.confidence === 'number' ? state.confidence : 0,
      scores: state.scores || {},
    };
  } catch {
    return null;
  }
}

/**
 * Extract relevant fields from a PreToolUse Task tool_input.
 * @param {unknown} data
 * @returns {{ subagentType: string, prompt: string }}
 */
function extractTaskInput(data) {
  if (!data || typeof data !== 'object') {
    return { subagentType: '', prompt: '' };
  }
  const toolInput = data.tool_input || {};
  return {
    subagentType: toolInput.subagent_type || '',
    prompt: toolInput.prompt || toolInput.description || '',
  };
}

/**
 * Build the additionalContext string for the PreToolUse hook output.
 * @param {{ recommendedAgent, recommendedModel, fallbackChain, teamWorkerType, advice }} routing
 * @param {string} subagentType - The subagent type being spawned
 * @returns {string}
 */
function buildModelRoutingContext(routing, subagentType) {
  const agentNote = subagentType
    ? `\nSpawning: ${subagentType}`
    : '';

  const fallbackNote = routing.fallbackChain.length > 0
    ? `\nFallback chain: ${routing.fallbackChain.join(' → ')}`
    : '';

  const teamNote = routing.teamWorkerType
    ? `\nTeam worker type: ${routing.teamWorkerType}`
    : '';

  return [
    `[MODEL ROUTING] ${routing.advice}`,
    `Recommended: ${routing.recommendedAgent} (${routing.recommendedModel})`,
    `${fallbackNote}${teamNote}${agentNote}`,
  ].join('\n').trim();
}

async function main() {
  // Skip guard
  if (process.env.DISABLE_AO === '1') {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  try {
    const input = await readStdin();
    if (!input.trim()) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    let data = {};
    try {
      data = JSON.parse(input);
    } catch {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    // Only act on Task tool invocations
    const toolName = data.tool_name || '';
    if (toolName !== 'Task') {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const directory = data.cwd || data.directory || process.cwd();
    const { subagentType } = extractTaskInput(data);

    // Load intent from state written by intent-gate.mjs
    const intentResult = loadIntentState(directory);
    if (!intentResult || intentResult.category === 'unknown') {
      // No meaningful intent state — pass through without adding noise
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const routing = routeByIntent(intentResult);
    const additionalContext = buildModelRoutingContext(routing, subagentType);

    console.log(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext,
      },
    }));
  } catch {
    // Never block on any error
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

main();
