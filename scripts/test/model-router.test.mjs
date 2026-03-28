/**
 * Unit tests for scripts/lib/model-router.mjs
 *
 * Tests routeByIntent() for all 7 intent categories, low-confidence fallback,
 * missing/null input, and user config override behavior (via buildRoutingTable).
 *
 * Because model-router.mjs calls loadRoutingConfig() which reads
 * process.env.CLAUDE_PLUGIN_ROOT at call time, each test group that needs
 * a custom config sets/restores the env var around the import and call.
 *
 * stripJsoncComments is private but is exercised indirectly: tests that point
 * CLAUDE_PLUGIN_ROOT at a temp dir containing a JSONC file with comments verify
 * that comment stripping works correctly.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { routeByIntent, DEFAULT_ROUTING_CONFIG } from '../lib/model-router.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(suffix = 'model-router-test') {
  return fs.mkdtemp(path.join(os.tmpdir(), `ao-${suffix}-`));
}

async function removeTmpDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Write a model-routing.jsonc file inside <root>/config/ and return the root.
 * @param {string} root - tmpdir that acts as CLAUDE_PLUGIN_ROOT
 * @param {string} content - raw JSONC content
 */
async function writeRoutingConfig(root, content) {
  const configDir = path.join(root, 'config');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, 'model-routing.jsonc'), content, 'utf-8');
}

/**
 * Call routeByIntent with CLAUDE_PLUGIN_ROOT pointed at `root` (or undefined).
 * Restores the original env value after the call.
 */
function routeWithRoot(intentResult, root) {
  const originalRoot = process.env.CLAUDE_PLUGIN_ROOT;
  try {
    if (root === undefined) {
      delete process.env.CLAUDE_PLUGIN_ROOT;
    } else {
      process.env.CLAUDE_PLUGIN_ROOT = root;
    }
    return routeByIntent(intentResult);
  } finally {
    if (originalRoot === undefined) {
      delete process.env.CLAUDE_PLUGIN_ROOT;
    } else {
      process.env.CLAUDE_PLUGIN_ROOT = originalRoot;
    }
  }
}

/** High-confidence intent fixture for a given category. */
function intent(category, confidence = 0.9) {
  return { category, confidence, scores: { [category]: confidence } };
}

// ---------------------------------------------------------------------------
// Isolate tests from any ambient CLAUDE_PLUGIN_ROOT that the outer shell may
// have set so that "default config" tests are truly deterministic.
// ---------------------------------------------------------------------------

let savedPluginRoot;

describe('model-router', () => {
  before(() => {
    savedPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.CLAUDE_PLUGIN_ROOT;
  });

  after(() => {
    if (savedPluginRoot !== undefined) {
      process.env.CLAUDE_PLUGIN_ROOT = savedPluginRoot;
    } else {
      delete process.env.CLAUDE_PLUGIN_ROOT;
    }
  });

  // -------------------------------------------------------------------------
  // routeByIntent — 7 intent categories produce correct agent/model mapping
  // -------------------------------------------------------------------------

  describe('routeByIntent: all 7 categories with high confidence', () => {
    const expectations = [
      {
        category: 'visual-engineering',
        agent: DEFAULT_ROUTING_CONFIG.routes['visual-engineering'].agent,
        model: DEFAULT_ROUTING_CONFIG.routes['visual-engineering'].model,
        teamWorkerType: DEFAULT_ROUTING_CONFIG.routes['visual-engineering'].teamWorkerType,
      },
      {
        category: 'deep',
        agent: DEFAULT_ROUTING_CONFIG.routes['deep'].agent,
        model: DEFAULT_ROUTING_CONFIG.routes['deep'].model,
        teamWorkerType: DEFAULT_ROUTING_CONFIG.routes['deep'].teamWorkerType,
      },
      {
        category: 'quick',
        agent: DEFAULT_ROUTING_CONFIG.routes['quick'].agent,
        model: DEFAULT_ROUTING_CONFIG.routes['quick'].model,
        teamWorkerType: DEFAULT_ROUTING_CONFIG.routes['quick'].teamWorkerType,
      },
      {
        category: 'writing',
        agent: DEFAULT_ROUTING_CONFIG.routes['writing'].agent,
        model: DEFAULT_ROUTING_CONFIG.routes['writing'].model,
        teamWorkerType: DEFAULT_ROUTING_CONFIG.routes['writing'].teamWorkerType,
      },
      {
        category: 'artistry',
        agent: DEFAULT_ROUTING_CONFIG.routes['artistry'].agent,
        model: DEFAULT_ROUTING_CONFIG.routes['artistry'].model,
        teamWorkerType: DEFAULT_ROUTING_CONFIG.routes['artistry'].teamWorkerType,
      },
      {
        category: 'planning',
        agent: DEFAULT_ROUTING_CONFIG.routes['planning'].agent,
        model: DEFAULT_ROUTING_CONFIG.routes['planning'].model,
        teamWorkerType: DEFAULT_ROUTING_CONFIG.routes['planning'].teamWorkerType,
      },
      {
        category: 'unknown',
        agent: DEFAULT_ROUTING_CONFIG.routes['unknown'].agent,
        model: DEFAULT_ROUTING_CONFIG.routes['unknown'].model,
        teamWorkerType: DEFAULT_ROUTING_CONFIG.routes['unknown'].teamWorkerType,
      },
    ];

    for (const { category, agent, model, teamWorkerType } of expectations) {
      it(`category "${category}" → agent=${agent}, model=${model}`, () => {
        const result = routeByIntent(intent(category));
        assert.equal(result.recommendedAgent, agent);
        assert.equal(result.recommendedModel, model);
        assert.equal(result.teamWorkerType, teamWorkerType);
      });
    }
  });

  it('routeByIntent: result always contains fallbackChain array', () => {
    const result = routeByIntent(intent('deep'));
    assert.ok(Array.isArray(result.fallbackChain));
    assert.ok(result.fallbackChain.length > 0);
  });

  it('routeByIntent: result always contains a non-empty advice string', () => {
    const result = routeByIntent(intent('planning'));
    assert.equal(typeof result.advice, 'string');
    assert.ok(result.advice.length > 0);
  });

  it('routeByIntent: advice includes confidence percentage', () => {
    const result = routeByIntent(intent('quick', 0.75));
    assert.ok(result.advice.includes('75%'), `Expected "75%" in advice: "${result.advice}"`);
  });

  // -------------------------------------------------------------------------
  // routeByIntent — low confidence falls back to 'unknown'
  // -------------------------------------------------------------------------

  describe('routeByIntent: low confidence falls back to unknown', () => {
    const minConfidence = DEFAULT_ROUTING_CONFIG.thresholds.minConfidence;
    const unknownEntry = DEFAULT_ROUTING_CONFIG.routes['unknown'];

    it('confidence exactly at threshold is accepted (not a fallback)', () => {
      const result = routeByIntent(intent('deep', minConfidence));
      assert.equal(result.recommendedAgent, DEFAULT_ROUTING_CONFIG.routes['deep'].agent);
    });

    it('confidence just below threshold falls back to unknown agent', () => {
      const belowThreshold = minConfidence - 0.01;
      const result = routeByIntent(intent('deep', belowThreshold));
      assert.equal(result.recommendedAgent, unknownEntry.agent);
      assert.equal(result.recommendedModel, unknownEntry.model);
    });

    it('confidence=0 falls back to unknown', () => {
      const result = routeByIntent({ category: 'planning', confidence: 0, scores: {} });
      assert.equal(result.recommendedAgent, unknownEntry.agent);
    });

    it('confidence=0.001 (very low) falls back to unknown', () => {
      const result = routeByIntent({ category: 'artistry', confidence: 0.001, scores: {} });
      assert.equal(result.recommendedAgent, unknownEntry.agent);
    });

    it('low-confidence advice still reports the rounded percentage', () => {
      const result = routeByIntent({ category: 'writing', confidence: 0.05, scores: {} });
      assert.ok(result.advice.includes('5%'), `Expected "5%" in advice: "${result.advice}"`);
    });
  });

  // -------------------------------------------------------------------------
  // routeByIntent — missing/null/undefined input returns fallback
  // -------------------------------------------------------------------------

  describe('routeByIntent: missing or null input returns fallback', () => {
    const unknownEntry = DEFAULT_ROUTING_CONFIG.routes['unknown'];

    it('null intentResult → unknown fallback', () => {
      const result = routeByIntent(null);
      assert.equal(result.recommendedAgent, unknownEntry.agent);
      assert.equal(result.recommendedModel, unknownEntry.model);
    });

    it('undefined intentResult → unknown fallback', () => {
      const result = routeByIntent(undefined);
      assert.equal(result.recommendedAgent, unknownEntry.agent);
    });

    it('empty object {} → confidence=0 → unknown fallback', () => {
      const result = routeByIntent({});
      assert.equal(result.recommendedAgent, unknownEntry.agent);
    });

    it('intentResult with no category field → unknown category routing', () => {
      const result = routeByIntent({ confidence: 0.9 });
      // no category supplied, defaults to 'unknown'
      assert.equal(result.recommendedAgent, unknownEntry.agent);
    });

    it('intentResult with unrecognised category → unknown fallback', () => {
      // unrecognised category key is not present in routing table,
      // so should fall through to the 'unknown' entry
      const result = routeByIntent({ category: 'nonexistent-category', confidence: 0.99 });
      assert.equal(result.recommendedAgent, unknownEntry.agent);
    });

    it('result object always has all required keys even for null input', () => {
      const result = routeByIntent(null);
      assert.ok('recommendedAgent' in result);
      assert.ok('recommendedModel' in result);
      assert.ok('fallbackChain' in result);
      assert.ok('teamWorkerType' in result);
      assert.ok('advice' in result);
    });
  });

  // -------------------------------------------------------------------------
  // stripJsoncComments — exercised via loadRoutingConfig with a JSONC file
  // -------------------------------------------------------------------------

  describe('stripJsoncComments: exercised via CLAUDE_PLUGIN_ROOT config loading', () => {
    let tmpDir;

    before(async () => {
      tmpDir = await makeTmpDir('jsonccomments');
    });

    after(async () => {
      await removeTmpDir(tmpDir);
    });

    it('JSONC with line comments (//) is parsed without error', async () => {
      const jsonc = `{
  // This is a line comment
  "version": "1",
  "routes": {
    // route comment
    "quick": { "agent": "agent-olympus:explore", "model": "haiku" }
  }
}`;
      await writeRoutingConfig(tmpDir, jsonc);
      // Should not throw — comments stripped before JSON.parse
      const result = routeWithRoot(intent('quick', 0.9), tmpDir);
      assert.equal(result.recommendedAgent, 'agent-olympus:explore');
    });

    it('JSONC with block comments (/* */) is parsed without error', async () => {
      const jsonc = `{
  /* Block comment
     spanning multiple lines */
  "version": "1",
  "routes": {
    "writing": { /* inline block */ "agent": "agent-olympus:writer", "model": "haiku" }
  }
}`;
      await writeRoutingConfig(tmpDir, jsonc);
      const result = routeWithRoot(intent('writing', 0.9), tmpDir);
      assert.equal(result.recommendedAgent, 'agent-olympus:writer');
    });

    it('JSONC with mixed line and block comments is parsed correctly', async () => {
      const jsonc = `{
  // version line comment
  "version": "1", /* trailing block */
  /* routes block */ "routes": {
    // deep route
    "deep": { "agent": "agent-olympus:architect", "model": "opus" }
  }
}`;
      await writeRoutingConfig(tmpDir, jsonc);
      const result = routeWithRoot(intent('deep', 0.9), tmpDir);
      assert.equal(result.recommendedAgent, 'agent-olympus:architect');
      assert.equal(result.recommendedModel, 'opus');
    });
  });

  // -------------------------------------------------------------------------
  // buildRoutingTable: user config overrides defaults — exercised via routeByIntent
  // -------------------------------------------------------------------------

  describe('buildRoutingTable: user config overrides defaults via routeByIntent', () => {
    let tmpDir;

    before(async () => {
      tmpDir = await makeTmpDir('buildrouting');
    });

    after(async () => {
      await removeTmpDir(tmpDir);
    });

    it('overriding the agent for "quick" category takes effect', async () => {
      const config = JSON.stringify({
        version: '1',
        routes: {
          quick: { agent: 'agent-olympus:executor', model: 'sonnet' },
        },
      });
      await writeRoutingConfig(tmpDir, config);
      const result = routeWithRoot(intent('quick', 0.9), tmpDir);
      assert.equal(result.recommendedAgent, 'agent-olympus:executor');
      assert.equal(result.recommendedModel, 'sonnet');
    });

    it('overriding the model for "deep" category takes effect', async () => {
      const config = JSON.stringify({
        version: '1',
        routes: {
          deep: { agent: 'agent-olympus:architect', model: 'haiku' },
        },
      });
      await writeRoutingConfig(tmpDir, config);
      const result = routeWithRoot(intent('deep', 0.9), tmpDir);
      assert.equal(result.recommendedModel, 'haiku');
    });

    it('user override only affects the named category; others retain defaults', async () => {
      const config = JSON.stringify({
        version: '1',
        routes: {
          planning: { agent: 'agent-olympus:executor', model: 'sonnet' },
        },
      });
      await writeRoutingConfig(tmpDir, config);

      // 'planning' should use overridden values
      const planResult = routeWithRoot(intent('planning', 0.9), tmpDir);
      assert.equal(planResult.recommendedAgent, 'agent-olympus:executor');

      // 'writing' is not overridden, should remain at default
      const writeResult = routeWithRoot(intent('writing', 0.9), tmpDir);
      assert.equal(
        writeResult.recommendedAgent,
        DEFAULT_ROUTING_CONFIG.routes['writing'].agent,
      );
    });

    it('partial route override merges with defaults (fallbackChain preserved)', async () => {
      // Override only agent, leave model absent → model should come from defaults
      const config = JSON.stringify({
        version: '1',
        routes: {
          artistry: { agent: 'agent-olympus:executor', model: 'sonnet' },
        },
      });
      await writeRoutingConfig(tmpDir, config);
      const result = routeWithRoot(intent('artistry', 0.9), tmpDir);
      assert.equal(result.recommendedAgent, 'agent-olympus:executor');
      // fallbackChain from default should still be present
      assert.ok(Array.isArray(result.fallbackChain));
    });

    it('invalid config file falls back to defaults gracefully', async () => {
      await writeRoutingConfig(tmpDir, '{ not valid json !!!');
      // loadRoutingConfig catches the parse error and returns DEFAULT_ROUTING_CONFIG
      const result = routeWithRoot(intent('deep', 0.9), tmpDir);
      assert.equal(
        result.recommendedAgent,
        DEFAULT_ROUTING_CONFIG.routes['deep'].agent,
      );
    });

    it('config with invalid schema falls back to defaults gracefully', async () => {
      // Missing required "routes" field — validateRoutingConfig will reject it
      const config = JSON.stringify({ version: '1' });
      await writeRoutingConfig(tmpDir, config);
      const result = routeWithRoot(intent('quick', 0.9), tmpDir);
      assert.equal(
        result.recommendedAgent,
        DEFAULT_ROUTING_CONFIG.routes['quick'].agent,
      );
    });

    it('CLAUDE_PLUGIN_ROOT pointing to nonexistent dir falls back to defaults', () => {
      const result = routeWithRoot(intent('writing', 0.9), '/nonexistent/path/does/not/exist');
      assert.equal(
        result.recommendedAgent,
        DEFAULT_ROUTING_CONFIG.routes['writing'].agent,
      );
    });

    it('custom minConfidence threshold in config is respected', async () => {
      // Set minConfidence to 0.5 — a confidence of 0.3 should now fall back to 'unknown'
      const config = JSON.stringify({
        version: '1',
        routes: {
          deep: { agent: 'agent-olympus:architect', model: 'opus' },
        },
        thresholds: { minConfidence: 0.5, highConfidence: 0.9 },
      });
      await writeRoutingConfig(tmpDir, config);

      // confidence=0.3 is below the custom threshold of 0.5 → unknown fallback
      const lowResult = routeWithRoot({ category: 'deep', confidence: 0.3, scores: {} }, tmpDir);
      assert.equal(
        lowResult.recommendedAgent,
        DEFAULT_ROUTING_CONFIG.routes['unknown'].agent,
      );

      // confidence=0.6 is above the custom threshold → deep routing
      const highResult = routeWithRoot({ category: 'deep', confidence: 0.6, scores: {} }, tmpDir);
      assert.equal(highResult.recommendedAgent, 'agent-olympus:architect');
    });
  });

  // -------------------------------------------------------------------------
  // CLAUDE_PLUGIN_ROOT absent → pure defaults
  // -------------------------------------------------------------------------

  describe('routeByIntent: no CLAUDE_PLUGIN_ROOT uses DEFAULT_ROUTING_CONFIG', () => {
    it('all default routes map to the expected agents from DEFAULT_ROUTING_CONFIG', () => {
      for (const [category, entry] of Object.entries(DEFAULT_ROUTING_CONFIG.routes)) {
        const result = routeByIntent(intent(category, 0.9));
        assert.equal(
          result.recommendedAgent,
          entry.agent,
          `category "${category}": expected agent ${entry.agent}, got ${result.recommendedAgent}`,
        );
        assert.equal(
          result.recommendedModel,
          entry.model,
          `category "${category}": expected model ${entry.model}, got ${result.recommendedModel}`,
        );
      }
    });
  });
});
