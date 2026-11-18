/**
 * Cost estimation utilities for agent-olympus orchestrators.
 *
 * Provides token-based USD cost estimates for Atlas/Athena runs based on
 * model tier pricing. Uses approximate per-spawn token budgets to give
 * pre-flight cost projections before dispatching agents.
 *
 * Zero npm dependencies — Node.js built-ins only.
 */

/**
 * Standard uncached API prices per million tokens, checked 2026-11-18.
 * Claude tiers assume 5.5 and Gemini short names assume 2.5. These are
 * short text prompt estimates; subscriptions and custom endpoints may differ.
 * https://platform.claude.com/docs/en/about-claude/pricing
 * https://developers.openai.com/api/docs/pricing
 * https://ai.google.dev/gemini-api/docs/pricing
 *
 * @type {Record<string, { input: number, output: number }>}
 */
export const PRICING = {
  // Anthropic Claude models
  opus:   { input: 4,    output: 20   },
  sonnet: { input: 2,    output: 10   },
  haiku:  { input: 0.10, output: 0.50 },

  'gpt-6.2-astra': { input: 8, output: 40 },
  'gpt-6.2-sol':   { input: 2, output: 10 },

  // Google Gemini models (canonical short names used by model-router)
  'gemini-pro':        { input: 1.25,  output: 10.0  },
  'gemini-flash':      { input: 0.30,  output: 2.50  },
  'gemini-flash-lite': { input: 0.10,  output: 0.40  },
  // Full version names (aliases for convenience)
  'gemini-2.5-pro':        { input: 1.25,  output: 10.0  },
  'gemini-2.5-flash':      { input: 0.30,  output: 2.50  },
};

/**
 * Approximate token usage per agent spawn.
 * These are conservative estimates for orchestrator dispatch calls.
 */
const TOKENS_PER_SPAWN = {
  input:  4000,
  output: 2000,
};

/**
 * @typedef {object} ModelTier
 * @property {string} model  - Model name: 'opus' | 'sonnet' | 'haiku' | 'gemini-pro' | 'gemini-flash' | 'gemini-flash-lite' | 'gemini-2.5-pro' | 'gemini-2.5-flash'
 * @property {number} count  - Number of agent spawns at this tier
 */

/**
 * @typedef {object} BreakdownEntry
 * @property {string} model        - Model name
 * @property {number} count        - Number of agent spawns
 * @property {number} inputTokens  - Total input tokens for this tier
 * @property {number} outputTokens - Total output tokens for this tier
 * @property {number|null} costUSD      - Estimated cost in USD for this tier
 */

/**
 * @typedef {object} CostEstimate
 * @property {number}           totalTokens      - Sum of all input + output tokens
 * @property {number|null}      estimatedCostUSD - Sum of all breakdown costUSD values
 * @property {BreakdownEntry[]} breakdown        - Per-model cost breakdown
 */

/**
 * Estimate the cost of an orchestrator run based on story count and model tiers.
 *
 * Each agent spawn is assumed to consume approximately 4000 input tokens and
 * 2000 output tokens. For model tiers not found in PRICING, an unpriced (null) entry
 * is recorded so the breakdown remains complete.
 *
 * @param {object}      options
 * @param {number}      options.stories    - Number of user stories (informational; not used in calculation)
 * @param {ModelTier[]} options.modelTiers - Array of { model, count } objects describing spawn distribution
 * @returns {CostEstimate}
 */
export function estimateCost({ stories, modelTiers }) {
  try {
    const breakdown = [];
    let totalTokens = 0;
    let estimatedCostUSD = 0;

    const tiers = Array.isArray(modelTiers) ? modelTiers : [];

    for (const tier of tiers) {
      const { model, count } = tier;
      const spawnCount = typeof count === 'number' && count > 0 ? count : 0;

      const inputTokens  = spawnCount * TOKENS_PER_SPAWN.input;
      const outputTokens = spawnCount * TOKENS_PER_SPAWN.output;

      const pricing = Object.hasOwn(PRICING, model) ? PRICING[model] : null;
      const costUSD = pricing
        ? (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000
        : null;

      breakdown.push({ model, count: spawnCount, inputTokens, outputTokens, costUSD });

      totalTokens      += inputTokens + outputTokens;
      if (costUSD === null && spawnCount > 0) estimatedCostUSD = null;
      else if (estimatedCostUSD !== null) estimatedCostUSD += costUSD ?? 0;
    }

    return { totalTokens, estimatedCostUSD, breakdown };
  } catch {
    // A malformed input cannot be priced.
    return { totalTokens: 0, estimatedCostUSD: null, breakdown: [] };
  }
}
