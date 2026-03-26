/**
 * Model Router - routing logic for agent-olympus Intent Gate
 *
 * Loads routing configuration from config/model-routing.jsonc (or defaults)
 * and maps intent categories to recommended agents, models, and team workers.
 */

import fs from 'fs';
import path from 'path';

/**
 * Default routing table when config file is absent or unreadable.
 * Keys are intent categories from intent-patterns.mjs.
 *
 * @type {Record<string, {
 *   agent: string,
 *   model: string,
 *   fallbackChain: string[],
 *   teamWorkerType: string|null,
 * }>}
 */
const DEFAULT_ROUTING_TABLE = {
  'visual-engineering': {
    agent: 'agent-olympus:designer',
    model: 'sonnet',
    fallbackChain: ['sonnet', 'haiku'],
    teamWorkerType: 'gemini',
  },
  'deep': {
    agent: 'agent-olympus:architect',
    model: 'opus',
    fallbackChain: ['opus', 'sonnet'],
    teamWorkerType: null,
  },
  'quick': {
    agent: 'agent-olympus:explore',
    model: 'haiku',
    fallbackChain: ['haiku', 'sonnet'],
    teamWorkerType: null,
  },
  'writing': {
    agent: 'agent-olympus:writer',
    model: 'haiku',
    fallbackChain: ['haiku', 'sonnet'],
    teamWorkerType: null,
  },
  'artistry': {
    agent: 'agent-olympus:designer',
    model: 'sonnet',
    fallbackChain: ['sonnet'],
    teamWorkerType: 'gemini',
  },
  'planning': {
    agent: 'agent-olympus:prometheus',
    model: 'opus',
    fallbackChain: ['opus', 'sonnet'],
    teamWorkerType: null,
  },
  'unknown': {
    agent: 'agent-olympus:executor',
    model: 'sonnet',
    fallbackChain: ['sonnet', 'haiku'],
    teamWorkerType: null,
  },
};

/**
 * Strip JSONC-style comments from a string so it can be parsed by JSON.parse.
 * Handles both // line comments and /* block comments * /.
 * @param {string} source
 * @returns {string}
 */
function stripJsoncComments(source) {
  // Remove block comments /* ... */
  let result = source.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove line comments // ...
  result = result.replace(/\/\/[^\n]*/g, '');
  return result;
}

/**
 * Load routing config from CLAUDE_PLUGIN_ROOT/config/model-routing.jsonc.
 * Returns null on any error so callers fall back to defaults.
 * @returns {Record<string, unknown>|null}
 */
function loadRoutingConfig() {
  try {
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    if (!pluginRoot) return null;

    const configPath = path.join(pluginRoot, 'config', 'model-routing.jsonc');
    const raw = fs.readFileSync(configPath, 'utf-8');
    const stripped = stripJsoncComments(raw);
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

/**
 * Merge user-supplied routing config over defaults.
 * Only overrides properties that are explicitly present in the config.
 * @param {Record<string, unknown>|null} config
 * @returns {Record<string, { agent: string, model: string, fallbackChain: string[], teamWorkerType: string|null }>}
 */
function buildRoutingTable(config) {
  if (!config?.routes || typeof config.routes !== 'object') {
    return { ...DEFAULT_ROUTING_TABLE };
  }

  const table = { ...DEFAULT_ROUTING_TABLE };
  for (const [category, override] of Object.entries(config.routes)) {
    if (typeof override !== 'object' || !override) continue;
    table[category] = {
      ...DEFAULT_ROUTING_TABLE[category],
      ...override,
    };
  }
  return table;
}

/**
 * Build human-readable routing advice for a given category + routing entry.
 * @param {string} category
 * @param {{ agent: string, model: string, fallbackChain: string[], teamWorkerType: string|null }} entry
 * @param {number} confidence
 * @returns {string}
 */
function buildRoutingAdvice(category, entry, confidence) {
  const pct = Math.round(confidence * 100);

  const adviceByCategory = {
    'visual-engineering': 'Visual/UI task detected. Designer agent with Gemini team worker is optimal for CSS, components, and layout work.',
    'deep': 'Complex architectural task detected. Architect agent with Opus-class model recommended for thorough analysis.',
    'quick': 'Simple/quick task detected. Explore agent with Haiku-class model is efficient and cost-effective.',
    'writing': 'Documentation/writing task detected. Writer agent with Haiku-class model is well-suited.',
    'artistry': 'Creative/generative task detected. Designer agent with Gemini team worker for visual artistry.',
    'planning': 'Planning/strategy task detected. For product planning (new features, specs, PRD): use /plan skill (Hermes). For implementation planning (refactoring approach, bug fix strategy): EnterPlanMode is fine. Opus-class model recommended.',
    'unknown': 'Intent unclear. Proceeding with default Sonnet model and executor agent.',
  };

  const advice = adviceByCategory[category] || adviceByCategory['unknown'];
  const teamNote = entry.teamWorkerType ? ` Team worker: ${entry.teamWorkerType}.` : '';
  return `${advice}${teamNote} (intent confidence: ${pct}%)`;
}

/**
 * Route an intent classification result to the most appropriate agent + model.
 *
 * @param {{ category: string, confidence: number, scores: Record<string, number> }} intentResult
 * @returns {{
 *   recommendedAgent: string,
 *   recommendedModel: string,
 *   fallbackChain: string[],
 *   teamWorkerType: string|null,
 *   advice: string,
 * }}
 */
export function routeByIntent(intentResult) {
  const config = loadRoutingConfig();
  const table = buildRoutingTable(config);

  const category = intentResult?.category || 'unknown';
  const confidence = intentResult?.confidence ?? 0;

  // Low-confidence results fall back to 'unknown' routing
  const effectiveCategory = confidence < 0.15 ? 'unknown' : category;
  const entry = table[effectiveCategory] || table['unknown'] || DEFAULT_ROUTING_TABLE['unknown'];

  return {
    recommendedAgent: entry.agent,
    recommendedModel: entry.model,
    fallbackChain: entry.fallbackChain,
    teamWorkerType: entry.teamWorkerType,
    advice: buildRoutingAdvice(effectiveCategory, entry, confidence),
  };
}
