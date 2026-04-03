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

test('PRICING: has Gemini model entries', () => {
  assert.ok('gemini-pro' in PRICING, 'PRICING must have gemini-pro entry');
  assert.ok('gemini-flash' in PRICING, 'PRICING must have gemini-flash entry');
  assert.ok('gemini-flash-lite' in PRICING, 'PRICING must have gemini-flash-lite entry');
  assert.ok('gemini-2.5-pro' in PRICING, 'PRICING must have gemini-2.5-pro alias');
  assert.ok('gemini-2.5-flash' in PRICING, 'PRICING must have gemini-2.5-flash alias');
});

test('PRICING: each tier has numeric input and output fields', () => {
  for (const tier of ['opus', 'sonnet', 'haiku', 'gemini-pro', 'gemini-flash', 'gemini-flash-lite']) {
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

// ---------------------------------------------------------------------------
// Test: Gemini model cost estimation
// ---------------------------------------------------------------------------

test('estimateCost: gemini-pro returns positive cost', () => {
  const result = estimateCost({ stories: 1, modelTiers: [{ model: 'gemini-pro', count: 1 }] });
  assert.ok(result.estimatedCostUSD > 0, 'gemini-pro must have positive cost');
});

test('estimateCost: gemini-flash is cheaper than gemini-pro', () => {
  const pro = estimateCost({ stories: 1, modelTiers: [{ model: 'gemini-pro', count: 1 }] });
  const flash = estimateCost({ stories: 1, modelTiers: [{ model: 'gemini-flash', count: 1 }] });
  const lite = estimateCost({ stories: 1, modelTiers: [{ model: 'gemini-flash-lite', count: 1 }] });

  assert.ok(pro.estimatedCostUSD > flash.estimatedCostUSD,
    `gemini-pro (${pro.estimatedCostUSD}) must cost more than gemini-flash (${flash.estimatedCostUSD})`);
  assert.ok(flash.estimatedCostUSD > lite.estimatedCostUSD,
    `gemini-flash (${flash.estimatedCostUSD}) must cost more than gemini-flash-lite (${lite.estimatedCostUSD})`);
});

test('estimateCost: gemini-2.5-pro alias returns same cost as gemini-pro', () => {
  const pro = estimateCost({ stories: 1, modelTiers: [{ model: 'gemini-pro', count: 1 }] });
  const alias = estimateCost({ stories: 1, modelTiers: [{ model: 'gemini-2.5-pro', count: 1 }] });
  assert.equal(pro.estimatedCostUSD, alias.estimatedCostUSD,
    'gemini-pro and gemini-2.5-pro must have identical cost');
  assert.ok(alias.estimatedCostUSD > 0, 'gemini-2.5-pro alias must have positive cost');
});

test('estimateCost: gemini-2.5-flash alias returns same cost as gemini-flash', () => {
  const flash = estimateCost({ stories: 1, modelTiers: [{ model: 'gemini-flash', count: 1 }] });
  const alias = estimateCost({ stories: 1, modelTiers: [{ model: 'gemini-2.5-flash', count: 1 }] });
  assert.equal(flash.estimatedCostUSD, alias.estimatedCostUSD,
    'gemini-flash and gemini-2.5-flash must have identical cost');
});

test('estimateCost: mixed Claude + Gemini tiers produce correct breakdown', () => {
  const result = estimateCost({
    stories: 4,
    modelTiers: [
      { model: 'sonnet', count: 2 },
      { model: 'gemini-flash', count: 2 },
    ],
  });
  assert.equal(result.breakdown.length, 2);
  assert.ok(result.estimatedCostUSD > 0);
  // Sonnet should cost more per spawn than gemini-flash
  assert.ok(result.breakdown[0].costUSD > result.breakdown[1].costUSD,
    'sonnet should cost more than gemini-flash per spawn');
});
