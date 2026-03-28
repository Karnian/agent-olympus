/**
 * Config Validator - schema validation for model-routing.jsonc
 *
 * Validates the required structure of the routing config and falls back to
 * safe defaults on any validation failure. Always fail-safe.
 */

/**
 * Default routing config used when validation fails or config is absent.
 *
 * @type {{
 *   version: string,
 *   routes: Record<string, { agent: string, model: string }>,
 *   concurrency: { maxParallelTasks: number, maxGeminiWorkers: number, maxCodexWorkers: number },
 *   thresholds: { minConfidence: number, highConfidence: number }
 * }}
 */
export const DEFAULT_ROUTING_CONFIG = {
  version: '1',
  routes: {
    'visual-engineering': { agent: 'agent-olympus:designer', model: 'sonnet', fallbackChain: ['sonnet', 'haiku'], teamWorkerType: 'gemini' },
    'deep':               { agent: 'agent-olympus:architect', model: 'opus', fallbackChain: ['opus', 'sonnet'], teamWorkerType: null },
    'quick':              { agent: 'agent-olympus:explore', model: 'haiku', fallbackChain: ['haiku', 'sonnet'], teamWorkerType: null },
    'writing':            { agent: 'agent-olympus:writer', model: 'haiku', fallbackChain: ['haiku', 'sonnet'], teamWorkerType: null },
    'artistry':           { agent: 'agent-olympus:designer', model: 'sonnet', fallbackChain: ['sonnet'], teamWorkerType: 'gemini' },
    'planning':           { agent: 'agent-olympus:prometheus', model: 'opus', fallbackChain: ['opus', 'sonnet'], teamWorkerType: null },
    'unknown':            { agent: 'agent-olympus:executor', model: 'sonnet', fallbackChain: ['sonnet', 'haiku'], teamWorkerType: null },
  },
  concurrency: { maxParallelTasks: 3, maxGeminiWorkers: 2, maxCodexWorkers: 2 },
  thresholds: { minConfidence: 0.15, highConfidence: 0.70 },
};

/**
 * Validation result returned by validateRoutingConfig.
 *
 * @typedef {{ valid: boolean, errors: string[], config: typeof DEFAULT_ROUTING_CONFIG }} ValidationResult
 */

/**
 * Validate the structure of a parsed model-routing.jsonc config object.
 *
 * Rules checked:
 *   - config.version must be a non-empty string
 *   - config.routes must be a non-null object
 *   - each entry in config.routes must have string `agent` and `model` fields
 *   - config.concurrency.maxParallelTasks must be a positive integer
 *   - config.thresholds.minConfidence must be a number in [0, 1]
 *
 * On any validation error the function returns DEFAULT_ROUTING_CONFIG so the
 * caller always receives a usable config regardless of the input.
 *
 * @param {unknown} config - raw parsed config (may be null/undefined on load failure)
 * @returns {ValidationResult}
 */
export function validateRoutingConfig(config) {
  try {
    const errors = [];

    // Guard: config must be a non-null object
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      errors.push('config must be a non-null object; received: ' + (config === null ? 'null' : typeof config));
      return { valid: false, errors, config: DEFAULT_ROUTING_CONFIG };
    }

    // --- version ---
    if (!config.version || typeof config.version !== 'string') {
      errors.push(
        'config.version must be a non-empty string; received: ' +
        JSON.stringify(config.version)
      );
    }

    // --- routes ---
    if (!config.routes || typeof config.routes !== 'object' || Array.isArray(config.routes)) {
      errors.push(
        'config.routes must be a non-null object; received: ' +
        (config.routes === null ? 'null' : typeof config.routes)
      );
    } else {
      // Validate each route entry
      for (const [routeKey, route] of Object.entries(config.routes)) {
        if (!route || typeof route !== 'object') {
          errors.push(`config.routes["${routeKey}"] must be an object; received: ${typeof route}`);
          continue;
        }
        if (!route.agent || typeof route.agent !== 'string') {
          errors.push(
            `config.routes["${routeKey}"].agent must be a non-empty string; received: ` +
            JSON.stringify(route.agent)
          );
        }
        if (!route.model || typeof route.model !== 'string') {
          errors.push(
            `config.routes["${routeKey}"].model must be a non-empty string; received: ` +
            JSON.stringify(route.model)
          );
        }
      }
    }

    // --- concurrency.maxParallelTasks ---
    const maxParallelTasks = config.concurrency?.maxParallelTasks;
    if (maxParallelTasks !== undefined) {
      if (
        typeof maxParallelTasks !== 'number' ||
        !Number.isInteger(maxParallelTasks) ||
        maxParallelTasks < 1
      ) {
        errors.push(
          'config.concurrency.maxParallelTasks must be a positive integer; received: ' +
          JSON.stringify(maxParallelTasks)
        );
      }
    }

    // --- route-level optional fields ---
    if (config.routes && typeof config.routes === 'object' && !Array.isArray(config.routes)) {
      const VALID_WORKER_TYPES = ['gemini', 'codex', null];
      const VALID_MODELS = ['opus', 'sonnet', 'haiku'];

      for (const [routeKey, route] of Object.entries(config.routes)) {
        if (!route || typeof route !== 'object') continue;

        // Validate fallbackChain if present
        if (route.fallbackChain !== undefined) {
          if (!Array.isArray(route.fallbackChain)) {
            errors.push(
              `config.routes["${routeKey}"].fallbackChain must be an array; received: ${typeof route.fallbackChain}`
            );
          } else {
            for (const model of route.fallbackChain) {
              if (typeof model !== 'string' || !VALID_MODELS.includes(model)) {
                errors.push(
                  `config.routes["${routeKey}"].fallbackChain contains invalid model "${model}"; allowed: ${VALID_MODELS.join(', ')}`
                );
              }
            }
          }
        }

        // Validate teamWorkerType if present
        if (route.teamWorkerType !== undefined && !VALID_WORKER_TYPES.includes(route.teamWorkerType)) {
          errors.push(
            `config.routes["${routeKey}"].teamWorkerType must be "gemini", "codex", or null; received: ${JSON.stringify(route.teamWorkerType)}`
          );
        }
      }
    }

    // --- thresholds.minConfidence ---
    const minConfidence = config.thresholds?.minConfidence;
    if (minConfidence !== undefined) {
      if (
        typeof minConfidence !== 'number' ||
        minConfidence < 0 ||
        minConfidence > 1
      ) {
        errors.push(
          'config.thresholds.minConfidence must be a number between 0 and 1; received: ' +
          JSON.stringify(minConfidence)
        );
      }
    }

    // --- thresholds.highConfidence ---
    const highConfidence = config.thresholds?.highConfidence;
    if (highConfidence !== undefined) {
      if (
        typeof highConfidence !== 'number' ||
        highConfidence < 0 ||
        highConfidence > 1
      ) {
        errors.push(
          'config.thresholds.highConfidence must be a number between 0 and 1; received: ' +
          JSON.stringify(highConfidence)
        );
      }
    }

    // --- consistency: minConfidence < highConfidence ---
    if (
      typeof minConfidence === 'number' &&
      typeof highConfidence === 'number' &&
      minConfidence >= highConfidence
    ) {
      errors.push(
        `config.thresholds.minConfidence (${minConfidence}) must be less than highConfidence (${highConfidence})`
      );
    }

    if (errors.length > 0) {
      return { valid: false, errors, config: DEFAULT_ROUTING_CONFIG };
    }

    return { valid: true, errors: [], config };
  } catch {
    // fail-safe: never throw
    return {
      valid: false,
      errors: ['validateRoutingConfig threw an unexpected error; using defaults'],
      config: DEFAULT_ROUTING_CONFIG,
    };
  }
}
