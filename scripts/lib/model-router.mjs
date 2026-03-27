/**
 * Model Router - routing logic for agent-olympus Intent Gate
 *
 * Loads routing configuration from config/model-routing.jsonc (or defaults)
 * and maps intent categories to recommended agents, models, and team workers.
 */

import fs from 'fs';
import path from 'path';
import { validateRoutingConfig, DEFAULT_ROUTING_CONFIG } from './config-validator.mjs';

// Re-export default config for external callers that may need it
export { DEFAULT_ROUTING_CONFIG };

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
 * Attempt to record a warning in .ao/wisdom.jsonl.
 * Fully fail-safe — never throws, never blocks.
 * @param {string} lesson
 */
async function recordValidationWarning(lesson) {
  try {
    // Dynamic import so the wisdom module is only loaded when needed
    const { addWisdom } = await import('./wisdom.mjs');
    await addWisdom({ category: 'general', lesson, confidence: 'low' });
  } catch {
    // fail-safe: ignore any error
  }
}

/**
 * Load and validate routing config from CLAUDE_PLUGIN_ROOT/config/model-routing.jsonc.
 * Returns a validated config object, or DEFAULT_ROUTING_CONFIG on any error/invalid schema.
 * @returns {typeof DEFAULT_ROUTING_CONFIG}
 */
function loadRoutingConfig() {
  try {
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    if (!pluginRoot) return DEFAULT_ROUTING_CONFIG;

    const configPath = path.join(pluginRoot, 'config', 'model-routing.jsonc');
    const raw = fs.readFileSync(configPath, 'utf-8');
    const stripped = stripJsoncComments(raw);
    const parsed = JSON.parse(stripped);

    const { valid, errors, config } = validateRoutingConfig(parsed);
    if (!valid) {
      // Log each validation problem to wisdom asynchronously (fire-and-forget)
      const lesson =
        'model-routing.jsonc schema validation failed — falling back to defaults. Issues: ' +
        errors.join('; ');
      recordValidationWarning(lesson);
      return config; // config === DEFAULT_ROUTING_CONFIG when invalid
    }

    return config;
  } catch {
    return DEFAULT_ROUTING_CONFIG;
  }
}

/**
 * Merge user-supplied routing config over defaults.
 * Only overrides properties that are explicitly present in the config.
 * @param {typeof DEFAULT_ROUTING_CONFIG} config - already validated config
 * @returns {Record<string, { agent: string, model: string, fallbackChain: string[], teamWorkerType: string|null }>}
 */
function buildRoutingTable(config) {
  const defaultRoutes = DEFAULT_ROUTING_CONFIG.routes;

  if (!config?.routes || typeof config.routes !== 'object') {
    return { ...defaultRoutes };
  }

  const table = { ...defaultRoutes };
  for (const [category, override] of Object.entries(config.routes)) {
    if (typeof override !== 'object' || !override) continue;
    table[category] = {
      ...defaultRoutes[category],
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

  // Use minConfidence threshold from validated config (falls back to default 0.15)
  const minConfidence =
    typeof config.thresholds?.minConfidence === 'number'
      ? config.thresholds.minConfidence
      : DEFAULT_ROUTING_CONFIG.thresholds.minConfidence;

  // Low-confidence results fall back to 'unknown' routing
  const effectiveCategory = confidence < minConfidence ? 'unknown' : category;
  const entry =
    table[effectiveCategory] ||
    table['unknown'] ||
    DEFAULT_ROUTING_CONFIG.routes['unknown'];

  return {
    recommendedAgent: entry.agent,
    recommendedModel: entry.model,
    fallbackChain: entry.fallbackChain,
    teamWorkerType: entry.teamWorkerType,
    advice: buildRoutingAdvice(effectiveCategory, entry, confidence),
  };
}
