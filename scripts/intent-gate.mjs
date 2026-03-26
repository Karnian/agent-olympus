#!/usr/bin/env node

/**
 * Agent Olympus Intent Gate - UserPromptSubmit hook
 *
 * Classifies the user's intent from their prompt and injects routing context
 * as additionalContext so Claude can self-route to the appropriate agent/model.
 *
 * Never blocks the hook chain: always exits 0.
 */

import fs from 'fs';
import path from 'path';
import { readStdin } from './lib/stdin.mjs';
import { classifyIntent } from './lib/intent-patterns.mjs';

const STATE_DIR = '.ao/state';
const INTENT_FILE = 'ao-intent.json';

/**
 * Extract prompt text from various UserPromptSubmit JSON shapes.
 * @param {unknown} data
 * @returns {string}
 */
function extractPrompt(data) {
  if (!data || typeof data !== 'object') return '';

  // Standard UserPromptSubmit shapes
  if (typeof data.prompt === 'string') return data.prompt;
  if (data.message?.content && typeof data.message.content === 'string') {
    return data.message.content;
  }
  if (Array.isArray(data.message?.content)) {
    return data.message.content
      .filter((p) => p.type === 'text')
      .map((p) => p.text || '')
      .join(' ');
  }
  if (Array.isArray(data.parts)) {
    return data.parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text || '')
      .join(' ');
  }
  return '';
}

/**
 * Persist intent result to .ao/state/ao-intent.json for downstream hooks.
 * @param {string} directory - Project root (cwd)
 * @param {object} intentResult
 */
function saveIntentState(directory, intentResult) {
  try {
    const stateDir = path.join(directory, STATE_DIR);
    fs.mkdirSync(stateDir, { recursive: true });
    const dest = path.join(stateDir, INTENT_FILE);
    fs.writeFileSync(dest, JSON.stringify({
      ...intentResult,
      savedAt: new Date().toISOString(),
    }, null, 2), { mode: 0o600 });
  } catch {
    // Non-fatal: downstream hooks will handle missing state gracefully
  }
}

/**
 * Build a human-readable routing advice string for a given intent category.
 * @param {string} category
 * @param {number} confidence
 * @returns {string}
 */
function buildAdvice(category, confidence) {
  const pct = Math.round(confidence * 100);
  const confidenceLabel = pct >= 70 ? 'high' : pct >= 40 ? 'medium' : 'low';

  const adviceMap = {
    'visual-engineering': 'Consider using the designer agent or Gemini for visual/UI tasks. Sonnet-class model recommended.',
    'deep': 'Opus-class model recommended for complex architectural analysis. Consider /deep-dive or architect agent.',
    'quick': 'Haiku-class model is sufficient for this task. Explore agent can handle it efficiently.',
    'writing': 'Writer agent recommended. Haiku-class model is well-suited for documentation tasks.',
    'artistry': 'Designer agent with Gemini team worker recommended for creative/generative tasks. Sonnet-class model.',
    'planning': 'For product planning (new features, systems, specs): use /plan skill which invokes Hermes for structured spec generation. For implementation planning (how to refactor, approach a bug fix): EnterPlanMode is fine. Opus-class model recommended.',
    'unknown': 'No strong intent signal detected. Proceed with default model selection.',
  };

  const advice = adviceMap[category] || adviceMap['unknown'];
  return `${advice} (confidence: ${confidenceLabel} ${pct}%)`;
}

/**
 * Build the additionalContext string injected into Claude's context window.
 * @param {string} category
 * @param {number} confidence
 * @param {Record<string, number>} scores
 * @returns {string}
 */
function buildAdditionalContext(category, confidence, scores) {
  const advice = buildAdvice(category, confidence);

  // Include top-3 non-zero scores for transparency
  const topScores = Object.entries(scores)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([k, v]) => `${k}:${v.toFixed(1)}`)
    .join(', ');

  const scoresNote = topScores ? ` [scores: ${topScores}]` : '';

  return `[INTENT: ${category} | confidence: ${Math.round(confidence * 100)}%]${scoresNote}\nRouting recommendation: ${advice}`;
}

async function main() {
  // Skip guard
  if (process.env.DISABLE_AO === '1') {
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  try {
    const input = await readStdin();
    if (!input.trim()) {
      process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    let data = {};
    try {
      data = JSON.parse(input);
    } catch {
      // Malformed input — pass through silently
      process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const directory = data.cwd || data.directory || process.cwd();
    const prompt = extractPrompt(data);

    if (!prompt.trim()) {
      process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const intentResult = classifyIntent(prompt);

    // Persist for downstream hooks (model-router.mjs)
    saveIntentState(directory, intentResult);

    // If intent is unknown with zero confidence, pass through without noise
    if (intentResult.category === 'unknown' && intentResult.confidence === 0) {
      process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const additionalContext = buildAdditionalContext(
      intentResult.category,
      intentResult.confidence,
      intentResult.scores,
    );

    process.stdout.write(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext,
      },
    }));
  } catch {
    // Never block on any error
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

main();
