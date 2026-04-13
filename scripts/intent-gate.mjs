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
import { atomicWriteFileSync } from './lib/fs-atomic.mjs';

/**
 * Read cached capability state from .ao/state/ao-capabilities.json.
 * Returns null if cache doesn't exist or is stale (>60min).
 * @param {string} directory
 * @returns {{ hasCodex: boolean, hasGemini: boolean } | null}
 */
function readCapabilityCache(directory) {
  try {
    const capPath = path.join(directory, '.ao/state/ao-capabilities.json');
    const stat = fs.statSync(capPath);
    const raw = fs.readFileSync(capPath, 'utf8');
    const data = JSON.parse(raw);

    // Check TTL (60 minutes) — prefer detectedAt field, fall back to file mtime
    const TTL = 60 * 60 * 1000;
    if (data.detectedAt) {
      const ts = new Date(data.detectedAt).getTime();
      if (Number.isNaN(ts) || Date.now() - ts > TTL) return null;
    } else {
      // preflight.mjs uses file mtime for TTL, no detectedAt field
      if (Date.now() - stat.mtimeMs > TTL) return null;
    }

    return {
      hasCodex: !!(data.hasCodexExecJson || data.hasCodexAppServer),
      hasGemini: !!(data.hasGeminiCli || data.hasGeminiAcp),
    };
  } catch {
    return null;
  }
}

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
    const dest = path.join(directory, STATE_DIR, INTENT_FILE);
    atomicWriteFileSync(dest, JSON.stringify({
      ...intentResult,
      savedAt: new Date().toISOString(),
    }, null, 2));
  } catch {
    // Non-fatal: downstream hooks will handle missing state gracefully
  }
}

/**
 * Build a human-readable routing advice string for a given intent category.
 * @param {string} category
 * @param {number} confidence
 * @param {string} [directory] - Project root for capability cache lookup
 * @returns {string}
 */
function buildAdvice(category, confidence, directory) {
  const pct = Math.round(confidence * 100);
  const confidenceLabel = pct >= 70 ? 'high' : pct >= 40 ? 'medium' : 'low';

  // Special handling for external-model: capability-aware routing
  if (category === 'external-model' && directory) {
    const caps = readCapabilityCache(directory);
    let capStatus = '';
    if (caps) {
      const available = [];
      const unavailable = [];
      if (caps.hasCodex) available.push('codex'); else unavailable.push('codex');
      if (caps.hasGemini) available.push('gemini'); else unavailable.push('gemini');
      capStatus = ` Available: ${available.join(', ') || 'none'}${unavailable.length ? ` | Not available: ${unavailable.join(', ')}` : ''}.`;
    } else {
      capStatus = ' Capability cache not available — /ask will auto-detect on first run.';
    }
    const advice = `User wants to query an external model (Codex/Gemini). Use the /ask skill: \`/ask codex <question>\` or \`/ask gemini <question>\` or \`/ask auto <question>\`. This routes through the CLI (codex exec / gemini CLI), NOT through an API key. Do NOT claim API keys are needed — the CLI handles its own authentication.${capStatus}`;
    return `${advice} (confidence: ${confidenceLabel} ${pct}%)`;
  }

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
 * @param {string} [directory] - Project root for capability cache lookup
 * @returns {string}
 */
function buildAdditionalContext(category, confidence, scores, directory) {
  const advice = buildAdvice(category, confidence, directory);

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
      directory,
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
