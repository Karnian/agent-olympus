/**
 * Unit tests for scripts/lib/cost-estimate.mjs
 * Tests PRICING constants and estimateCost().
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRICING, estimateCost } from '../lib/cost-estimate.mjs';

// ---------------------------------------------------------------------------
// Test: PRICING shape
// ---------------------------------------------------------------------------

test('PRICING: has opus, sonnet, and haiku entries', () => {
  assert.ok('opus' in PRICING, 'PRICING must have opus entry');
  assert.ok('sonnet' in PRICING, 'PRICING must have sonnet entry');
  assert.ok('haiku' in PRICING, 'PRICING must have haiku entry');
});

test('PRICING: each tier has numeric input and output fields', () => {
  for (const tier of ['opus', 'sonnet', 'haiku']) {
    const entry = PRICING[tier];
    assert.ok(entry !== null && typeof entry === 'object', `PRICING.${tier} must be an object`);
    assert.equal(typeof entry.input, 'number', `PRICING.${tier}.input must be a number`);
    assert.equal(typeof entry.output, 'number', `PRICING.${tier}.output must be a number`);
    assert.ok(entry.input > 0, `PRICING.${tier}.input must be positive`);
    assert.ok(entry.output > 0, `PRICING.${tier}.output must be positive`);
  }
});

// ---------------------------------------------------------------------------
// Test: estimateCost basic cases
// ---------------------------------------------------------------------------

test('estimateCost: 1 story with 1 opus agent → positive totalTokens and estimatedCostUSD', () => {
  const result = estimateCost({ stories: 1, modelTiers: [{ model: 'opus', count: 1 }] });
  assert.ok(result !== null && typeof result === 'object', 'must return an object');
  assert.ok(typeof result.totalTokens === 'number' && result.totalTokens > 0, 'totalTokens must be positive');
  assert.ok(typeof result.estimatedCostUSD === 'number' && result.estimatedCostUSD > 0, 'estimatedCostUSD must be positive');
});

test('estimateCost: empty modelTiers → returns zeros', () => {
  const result = estimateCost({ stories: 0, modelTiers: [] });
  assert.equal(result.totalTokens, 0);
  assert.equal(result.estimatedCostUSD, 0);
  assert.deepEqual(result.breakdown, []);
});

test('estimateCost: mixed tiers (2 opus, 3 sonnet, 1 haiku) → breakdown has 3 entries', () => {
  const result = estimateCost({
    stories: 5,
    modelTiers: [
      { model: 'opus', count: 2 },
      { model: 'sonnet', count: 3 },
      { model: 'haiku', count: 1 },
    ],
  });
  assert.ok(Array.isArray(result.breakdown), 'breakdown must be an array');
  assert.equal(result.breakdown.length, 3, 'breakdown must have one entry per tier');
});

test('estimateCost: estimatedCostUSD equals sum of breakdown[].costUSD', () => {
  const result = estimateCost({
    stories: 3,
    modelTiers: [
      { model: 'opus', count: 1 },
      { model: 'sonnet', count: 2 },
      { model: 'haiku', count: 1 },
    ],
  });
  const sumFromBreakdown = result.breakdown.reduce((sum, entry) => sum + entry.costUSD, 0);
  // Allow for floating-point rounding tolerance
  assert.ok(
    Math.abs(result.estimatedCostUSD - sumFromBreakdown) < 0.000001,
    `estimatedCostUSD (${result.estimatedCostUSD}) must equal sum of breakdown costUSD (${sumFromBreakdown})`,
  );
});

test('estimateCost: opus costs more than sonnet which costs more than haiku for same count', () => {
  const sharedArgs = { stories: 2 };
  const opusResult = estimateCost({ ...sharedArgs, modelTiers: [{ model: 'opus', count: 1 }] });
  const sonnetResult = estimateCost({ ...sharedArgs, modelTiers: [{ model: 'sonnet', count: 1 }] });
  const haikuResult = estimateCost({ ...sharedArgs, modelTiers: [{ model: 'haiku', count: 1 }] });

  assert.ok(
    opusResult.estimatedCostUSD > sonnetResult.estimatedCostUSD,
    `opus (${opusResult.estimatedCostUSD}) must cost more than sonnet (${sonnetResult.estimatedCostUSD})`,
  );
  assert.ok(
    sonnetResult.estimatedCostUSD > haikuResult.estimatedCostUSD,
    `sonnet (${sonnetResult.estimatedCostUSD}) must cost more than haiku (${haikuResult.estimatedCostUSD})`,
  );
});
