/**
 * Unit tests for scripts/lib/config-validator.mjs
 * Tests validateRoutingConfig() and DEFAULT_ROUTING_CONFIG.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRoutingConfig, DEFAULT_ROUTING_CONFIG } from '../lib/config-validator.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid config fixture */
function minimal() {
  return {
    version: '1',
    routes: { r: { agent: 'agent-olympus:executor', model: 'sonnet' } },
  };
}

// ---------------------------------------------------------------------------
// Test: valid configs
// ---------------------------------------------------------------------------

test('validateRoutingConfig: valid minimal config → { valid:true, errors:[] }', () => {
  const cfg = minimal();
  const result = validateRoutingConfig(cfg);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.config, cfg);
});

test('validateRoutingConfig: valid config with optional concurrency+thresholds', () => {
  const cfg = {
    ...minimal(),
    concurrency: { maxParallelTasks: 5, maxCodexWorkers: 2, maxGeminiWorkers: 2 },
    thresholds: { minConfidence: 0.2, highConfidence: 0.8 },
  };
  const result = validateRoutingConfig(cfg);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validateRoutingConfig: DEFAULT_ROUTING_CONFIG passes its own validation', () => {
  const result = validateRoutingConfig(DEFAULT_ROUTING_CONFIG);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validateRoutingConfig: minConfidence=0 (lower boundary) → valid:true', () => {
  const result = validateRoutingConfig({ ...minimal(), thresholds: { minConfidence: 0 } });
  assert.equal(result.valid, true);
});

test('validateRoutingConfig: minConfidence=1 (upper boundary) → valid:true', () => {
  const result = validateRoutingConfig({ ...minimal(), thresholds: { minConfidence: 1 } });
  assert.equal(result.valid, true);
});

test('validateRoutingConfig: maxParallelTasks=1 (minimum valid) → valid:true', () => {
  const result = validateRoutingConfig({ ...minimal(), concurrency: { maxParallelTasks: 1 } });
  assert.equal(result.valid, true);
});

// ---------------------------------------------------------------------------
// Test: null / non-object inputs → always returns DEFAULT_ROUTING_CONFIG
// ---------------------------------------------------------------------------

test('validateRoutingConfig: null → valid:false, returns DEFAULT_ROUTING_CONFIG', () => {
  const result = validateRoutingConfig(null);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
  assert.deepEqual(result.config, DEFAULT_ROUTING_CONFIG);
});

test('validateRoutingConfig: undefined → valid:false, returns DEFAULT_ROUTING_CONFIG', () => {
  const result = validateRoutingConfig(undefined);
  assert.equal(result.valid, false);
  assert.deepEqual(result.config, DEFAULT_ROUTING_CONFIG);
});

test('validateRoutingConfig: array → valid:false, returns DEFAULT_ROUTING_CONFIG', () => {
  const result = validateRoutingConfig([]);
  assert.equal(result.valid, false);
  assert.deepEqual(result.config, DEFAULT_ROUTING_CONFIG);
});

test('validateRoutingConfig: string → valid:false, returns DEFAULT_ROUTING_CONFIG', () => {
  const result = validateRoutingConfig('bad');
  assert.equal(result.valid, false);
  assert.deepEqual(result.config, DEFAULT_ROUTING_CONFIG);
});

// ---------------------------------------------------------------------------
// Test: missing / invalid required fields
// ---------------------------------------------------------------------------

test('validateRoutingConfig: missing version → valid:false, error mentions "version"', () => {
  const cfg = { routes: { r: { agent: 'a', model: 'm' } } };
  const result = validateRoutingConfig(cfg);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('version')));
  assert.deepEqual(result.config, DEFAULT_ROUTING_CONFIG);
});

test('validateRoutingConfig: version="" (empty string) → valid:false', () => {
  const result = validateRoutingConfig({ ...minimal(), version: '' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('version')));
});

test('validateRoutingConfig: missing routes → valid:false, error mentions "routes"', () => {
  const result = validateRoutingConfig({ version: '1' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('routes')));
});

test('validateRoutingConfig: routes=null → valid:false', () => {
  const result = validateRoutingConfig({ version: '1', routes: null });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('routes')));
});

test('validateRoutingConfig: route missing agent → valid:false, error mentions "agent"', () => {
  const result = validateRoutingConfig({ version: '1', routes: { r: { model: 'sonnet' } } });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('agent')));
});

test('validateRoutingConfig: route missing model → valid:false, error mentions "model"', () => {
  const result = validateRoutingConfig({ version: '1', routes: { r: { agent: 'agent-olympus:executor' } } });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('model')));
});

// ---------------------------------------------------------------------------
// Test: invalid optional field values
// ---------------------------------------------------------------------------

test('validateRoutingConfig: maxParallelTasks=0 → valid:false', () => {
  const result = validateRoutingConfig({ ...minimal(), concurrency: { maxParallelTasks: 0 } });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('maxParallelTasks')));
});

test('validateRoutingConfig: maxParallelTasks=1.5 (float) → valid:false', () => {
  const result = validateRoutingConfig({ ...minimal(), concurrency: { maxParallelTasks: 1.5 } });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('maxParallelTasks')));
});

test('validateRoutingConfig: maxParallelTasks="3" (string) → valid:false', () => {
  const result = validateRoutingConfig({ ...minimal(), concurrency: { maxParallelTasks: '3' } });
  assert.equal(result.valid, false);
});

test('validateRoutingConfig: minConfidence=-0.1 → valid:false', () => {
  const result = validateRoutingConfig({ ...minimal(), thresholds: { minConfidence: -0.1 } });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('minConfidence')));
});

test('validateRoutingConfig: minConfidence=1.01 → valid:false', () => {
  const result = validateRoutingConfig({ ...minimal(), thresholds: { minConfidence: 1.01 } });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('minConfidence')));
});

// ---------------------------------------------------------------------------
// Test: DEFAULT_ROUTING_CONFIG shape
// ---------------------------------------------------------------------------

test('DEFAULT_ROUTING_CONFIG: has required top-level keys', () => {
  assert.ok('version' in DEFAULT_ROUTING_CONFIG);
  assert.ok('routes' in DEFAULT_ROUTING_CONFIG);
  assert.ok('concurrency' in DEFAULT_ROUTING_CONFIG);
  assert.ok('thresholds' in DEFAULT_ROUTING_CONFIG);
});

test('DEFAULT_ROUTING_CONFIG: concurrency.maxParallelTasks is a positive integer', () => {
  const v = DEFAULT_ROUTING_CONFIG.concurrency.maxParallelTasks;
  assert.equal(typeof v, 'number');
  assert.ok(Number.isInteger(v) && v >= 1);
});

test('DEFAULT_ROUTING_CONFIG: thresholds.minConfidence is in [0,1]', () => {
  const v = DEFAULT_ROUTING_CONFIG.thresholds.minConfidence;
  assert.equal(typeof v, 'number');
  assert.ok(v >= 0 && v <= 1);
});
