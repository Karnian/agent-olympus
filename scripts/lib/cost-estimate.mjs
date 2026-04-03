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
 * Model pricing in USD per 1M tokens (as of early 2026).
 * Includes Anthropic (Claude) and Google (Gemini) model families.
 *
 * Gemini pricing source: Google AI pricing page (2026-Q1).
 * - gemini-pro / gemini-2.5-pro: $1.25 input, $10.00 output (>200k context)
 * - gemini-flash / gemini-2.5-flash: $0.15 input, $0.60 output (>200k context)
 * - gemini-flash-lite: $0.075 input, $0.30 output
 *
 * For unknown models, estimateCost() falls back to zero — callers should
 * handle this gracefully in UI display.
 *
 * @type {Record<string, { input: number, output: number }>}
 */
export const PRICING = {
  // Anthropic Claude models
  opus:   { input: 15,   output: 75   },
  sonnet: { input: 3,    output: 15   },
  haiku:  { input: 0.25, output: 1.25 },

  // Google Gemini models (canonical short names used by model-router)
  'gemini-pro':        { input: 1.25,  output: 10.0  },
  'gemini-flash':      { input: 0.15,  output: 0.60  },
  'gemini-flash-lite': { input: 0.075, output: 0.30  },
  // Full version names (aliases for convenience)
  'gemini-2.5-pro':        { input: 1.25,  output: 10.0  },
  'gemini-2.5-flash':      { input: 0.15,  output: 0.60  },
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
 * @property {number} costUSD      - Estimated cost in USD for this tier
 */

/**
 * @typedef {object} CostEstimate
 * @property {number}           totalTokens      - Sum of all input + output tokens
 * @property {number}           estimatedCostUSD - Sum of all breakdown costUSD values
 * @property {BreakdownEntry[]} breakdown        - Per-model cost breakdown
 */

/**
 * Estimate the cost of an orchestrator run based on story count and model tiers.
 *
 * Each agent spawn is assumed to consume approximately 4000 input tokens and
 * 2000 output tokens. For model tiers not found in PRICING, a zero-cost entry
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

      // Look up pricing; fall back to zero if model is unrecognised
      const pricing = PRICING[model] ?? { input: 0, output: 0 };

      // Cost = (tokens / 1_000_000) * rate
      const costUSD =
        (inputTokens  / 1_000_000) * pricing.input +
        (outputTokens / 1_000_000) * pricing.output;

      breakdown.push({ model, count: spawnCount, inputTokens, outputTokens, costUSD });

      totalTokens      += inputTokens + outputTokens;
      estimatedCostUSD += costUSD;
    }

    return { totalTokens, estimatedCostUSD, breakdown };
  } catch {
    // Fail-safe: return zero estimate rather than throwing
    return { totalTokens: 0, estimatedCostUSD: 0, breakdown: [] };
  }
}
