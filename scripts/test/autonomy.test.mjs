/**
 * Unit tests for scripts/lib/autonomy.mjs
 * Tests DEFAULT_AUTONOMY_CONFIG, validateAutonomyConfig(), and loadAutonomyConfig().
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_AUTONOMY_CONFIG,
  validateAutonomyConfig,
  loadAutonomyConfig,
} from '../lib/autonomy.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ao-autonomy-test-'));
}

async function removeTmpDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

/** Deep-clone fixture so mutations in tests don't affect each other */
function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** Minimal valid autonomy config fixture */
function minimal() {
  return clone(DEFAULT_AUTONOMY_CONFIG);
}

// ---------------------------------------------------------------------------
// Test: DEFAULT_AUTONOMY_CONFIG self-validation
// ---------------------------------------------------------------------------

test('DEFAULT_AUTONOMY_CONFIG: passes its own validation', () => {
  const result = validateAutonomyConfig(DEFAULT_AUTONOMY_CONFIG);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

// ---------------------------------------------------------------------------
// Test: DEFAULT_AUTONOMY_CONFIG shape and default values
// ---------------------------------------------------------------------------

test('DEFAULT_AUTONOMY_CONFIG: has expected top-level keys', () => {
  assert.ok('version' in DEFAULT_AUTONOMY_CONFIG);
  assert.ok('ship' in DEFAULT_AUTONOMY_CONFIG);
  assert.ok('ci' in DEFAULT_AUTONOMY_CONFIG);
  assert.ok('notify' in DEFAULT_AUTONOMY_CONFIG);
  assert.ok('budget' in DEFAULT_AUTONOMY_CONFIG);
});

test('DEFAULT_AUTONOMY_CONFIG: ship.autoPush defaults to false', () => {
  assert.equal(DEFAULT_AUTONOMY_CONFIG.ship.autoPush, false);
});

test('DEFAULT_AUTONOMY_CONFIG: ship.draftPR defaults to true', () => {
  assert.equal(DEFAULT_AUTONOMY_CONFIG.ship.draftPR, true);
});

test('DEFAULT_AUTONOMY_CONFIG: ci.maxCycles defaults to 2', () => {
  assert.equal(DEFAULT_AUTONOMY_CONFIG.ci.maxCycles, 2);
});

test('DEFAULT_AUTONOMY_CONFIG: ci.watchEnabled is a boolean', () => {
  assert.equal(typeof DEFAULT_AUTONOMY_CONFIG.ci.watchEnabled, 'boolean');
});

test('DEFAULT_AUTONOMY_CONFIG: ci.pollIntervalMs is a positive number', () => {
  const v = DEFAULT_AUTONOMY_CONFIG.ci.pollIntervalMs;
  assert.equal(typeof v, 'number');
  assert.ok(v > 0);
});

test('DEFAULT_AUTONOMY_CONFIG: ci.timeoutMs is a positive number', () => {
  const v = DEFAULT_AUTONOMY_CONFIG.ci.timeoutMs;
  assert.equal(typeof v, 'number');
  assert.ok(v > 0);
});

test('DEFAULT_AUTONOMY_CONFIG: notify fields are booleans', () => {
  const n = DEFAULT_AUTONOMY_CONFIG.notify;
  assert.equal(typeof n.onComplete, 'boolean');
  assert.equal(typeof n.onBlocked, 'boolean');
  assert.equal(typeof n.onCIFail, 'boolean');
});

// ---------------------------------------------------------------------------
// Test: valid configs
// ---------------------------------------------------------------------------

test('validateAutonomyConfig: valid full config → valid:true, errors:[]', () => {
  const result = validateAutonomyConfig(minimal());
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validateAutonomyConfig: returns config object on valid input', () => {
  const cfg = minimal();
  const result = validateAutonomyConfig(cfg);
  assert.ok(result.config !== null && typeof result.config === 'object');
});

// ---------------------------------------------------------------------------
// Test: null / non-object inputs → valid:false, returns defaults
// ---------------------------------------------------------------------------

test('validateAutonomyConfig: null → valid:false, returns defaults', () => {
  const result = validateAutonomyConfig(null);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
  assert.deepEqual(result.config, DEFAULT_AUTONOMY_CONFIG);
});

test('validateAutonomyConfig: undefined → valid:false', () => {
  const result = validateAutonomyConfig(undefined);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test('validateAutonomyConfig: array → valid:false', () => {
  const result = validateAutonomyConfig([]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});

// ---------------------------------------------------------------------------
// Test: missing required fields
// ---------------------------------------------------------------------------

test('validateAutonomyConfig: missing ship field → valid:false, error mentions "ship"', () => {
  const cfg = minimal();
  delete cfg.ship;
  const result = validateAutonomyConfig(cfg);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('ship')));
});

// ---------------------------------------------------------------------------
// Test: ci.maxCycles validation
// ---------------------------------------------------------------------------

test('validateAutonomyConfig: ci.maxCycles=0 → valid:false', () => {
  const cfg = minimal();
  cfg.ci.maxCycles = 0;
  const result = validateAutonomyConfig(cfg);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('maxCycles')));
});

test('validateAutonomyConfig: ci.maxCycles=-1 → valid:false', () => {
  const cfg = minimal();
  cfg.ci.maxCycles = -1;
  const result = validateAutonomyConfig(cfg);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('maxCycles')));
});

test('validateAutonomyConfig: ci.maxCycles=1.5 (not integer) → valid:false', () => {
  const cfg = minimal();
  cfg.ci.maxCycles = 1.5;
  const result = validateAutonomyConfig(cfg);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('maxCycles')));
});

// ---------------------------------------------------------------------------
// Test: notify boolean validation
// ---------------------------------------------------------------------------

test('validateAutonomyConfig: notify.onComplete="yes" (string not boolean) → valid:false', () => {
  const cfg = minimal();
  cfg.notify.onComplete = 'yes';
  const result = validateAutonomyConfig(cfg);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('onComplete')));
});

// ---------------------------------------------------------------------------
// Test: budget.warnThresholdUsd validation
// ---------------------------------------------------------------------------

test('validateAutonomyConfig: budget.warnThresholdUsd=-5 → valid:false (negative)', () => {
  const cfg = minimal();
  cfg.budget.warnThresholdUsd = -5;
  const result = validateAutonomyConfig(cfg);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('warnThresholdUsd')));
});

test('validateAutonomyConfig: budget.warnThresholdUsd=null → valid:true (null is allowed)', () => {
  const cfg = minimal();
  cfg.budget.warnThresholdUsd = null;
  const result = validateAutonomyConfig(cfg);
  assert.equal(result.valid, true);
});

// ---------------------------------------------------------------------------
// Test: partial config handling
// ---------------------------------------------------------------------------

test('validateAutonomyConfig: partial config with only ship field → handles gracefully', () => {
  const cfg = { ship: { autoPush: false, draftPR: true, autoLink: true, labels: [], issuePattern: null } };
  // Should not throw — missing fields should either error or fall back to defaults
  let threw = false;
  let result;
  try {
    result = validateAutonomyConfig(cfg);
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'validateAutonomyConfig must not throw on partial config');
  // Result must be an object with valid and errors fields
  assert.ok(result !== null && typeof result === 'object');
  assert.ok('valid' in result);
  assert.ok('errors' in result);
});

// ---------------------------------------------------------------------------
// Test: loadAutonomyConfig
// ---------------------------------------------------------------------------

test('loadAutonomyConfig: nonexistent dir returns defaults without throwing', async () => {
  const tmpDir = await makeTmpDir();
  await removeTmpDir(tmpDir); // ensure the directory does NOT exist
  let threw = false;
  let config;
  try {
    config = await loadAutonomyConfig(tmpDir);
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'loadAutonomyConfig must not throw for nonexistent directory');
  assert.ok(config !== null && typeof config === 'object');
});

test('loadAutonomyConfig: returns object with required keys', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const config = await loadAutonomyConfig(tmpDir);
    assert.ok('ship' in config);
    assert.ok('ci' in config);
    assert.ok('notify' in config);
    assert.ok('budget' in config);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test: codex.hostSandbox validation (host-sandbox-detect integration)
// ---------------------------------------------------------------------------

test('validateAutonomyConfig: default codex.hostSandbox is "auto"', () => {
  assert.equal(DEFAULT_AUTONOMY_CONFIG.codex.hostSandbox, 'auto');
});

test('validateAutonomyConfig: codex.hostSandbox accepts "auto"', () => {
  const cfg = minimal();
  cfg.codex.hostSandbox = 'auto';
  const r = validateAutonomyConfig(cfg);
  assert.deepEqual(r.errors, []);
});

test('validateAutonomyConfig: codex.hostSandbox accepts "unrestricted"', () => {
  const cfg = minimal();
  cfg.codex.hostSandbox = 'unrestricted';
  const r = validateAutonomyConfig(cfg);
  assert.deepEqual(r.errors, []);
});

test('validateAutonomyConfig: codex.hostSandbox accepts "workspace-write"', () => {
  const cfg = minimal();
  cfg.codex.hostSandbox = 'workspace-write';
  const r = validateAutonomyConfig(cfg);
  assert.deepEqual(r.errors, []);
});

test('validateAutonomyConfig: codex.hostSandbox accepts "read-only"', () => {
  const cfg = minimal();
  cfg.codex.hostSandbox = 'read-only';
  const r = validateAutonomyConfig(cfg);
  assert.deepEqual(r.errors, []);
});

test('validateAutonomyConfig: codex.hostSandbox rejects invalid value', () => {
  const cfg = minimal();
  cfg.codex.hostSandbox = 'yolo';
  const r = validateAutonomyConfig(cfg);
  assert.ok(r.errors.length > 0);
  assert.ok(r.errors.some(e => /codex\.hostSandbox must be one of/.test(e)),
    `expected hostSandbox error, got: ${JSON.stringify(r.errors)}`);
});

test('validateAutonomyConfig: codex.hostSandbox rejects non-string', () => {
  const cfg = minimal();
  cfg.codex.hostSandbox = 42;
  const r = validateAutonomyConfig(cfg);
  assert.ok(r.errors.length > 0);
});

test('validateAutonomyConfig: omitted codex.hostSandbox is fine (optional)', () => {
  const cfg = minimal();
  delete cfg.codex.hostSandbox;
  const r = validateAutonomyConfig(cfg);
  assert.deepEqual(r.errors, []);
});

test('validateAutonomyConfig: codex.hostSandbox and codex.approval coexist', () => {
  const cfg = minimal();
  cfg.codex.approval = 'full-auto';
  cfg.codex.hostSandbox = 'workspace-write';
  const r = validateAutonomyConfig(cfg);
  assert.deepEqual(r.errors, []);
});

// ───────────────────────────────────────────────────────────────────────────
// gemini.useKeychain + gemini.keychainAccount (v1.1 credential resolver)
// ───────────────────────────────────────────────────────────────────────────

test('DEFAULT_AUTONOMY_CONFIG: gemini.useKeychain defaults to true', () => {
  assert.equal(DEFAULT_AUTONOMY_CONFIG.gemini.useKeychain, true);
});

test('DEFAULT_AUTONOMY_CONFIG: gemini.keychainAccount defaults to default-api-key', () => {
  assert.equal(DEFAULT_AUTONOMY_CONFIG.gemini.keychainAccount, 'default-api-key');
});

test('validateAutonomyConfig: gemini.useKeychain accepts booleans', () => {
  for (const val of [true, false]) {
    const cfg = minimal();
    cfg.gemini.useKeychain = val;
    const r = validateAutonomyConfig(cfg);
    assert.deepEqual(r.errors, [], `useKeychain=${val} should be valid`);
  }
});

test('validateAutonomyConfig: gemini.useKeychain rejects non-boolean', () => {
  const cfg = minimal();
  cfg.gemini.useKeychain = 'yes';
  const r = validateAutonomyConfig(cfg);
  assert.ok(r.errors.some(e => /gemini\.useKeychain must be a boolean/.test(e)));
});

test('validateAutonomyConfig: gemini.keychainAccount accepts non-empty strings', () => {
  for (const acct of ['default-api-key', 'work', 'user@example.com', 'team:prod', 'a']) {
    const cfg = minimal();
    cfg.gemini.keychainAccount = acct;
    const r = validateAutonomyConfig(cfg);
    assert.deepEqual(r.errors, [], `account="${acct}" should be valid`);
  }
});

test('validateAutonomyConfig: gemini.keychainAccount rejects empty/whitespace-only strings', () => {
  for (const bad of ['', '   ', '\t\n']) {
    const cfg = minimal();
    cfg.gemini.keychainAccount = bad;
    const r = validateAutonomyConfig(cfg);
    assert.ok(
      r.errors.some(e => /gemini\.keychainAccount must be a non-empty string/.test(e)),
      `account=${JSON.stringify(bad)} should fail`
    );
  }
});

test('validateAutonomyConfig: gemini.keychainAccount rejects non-string types', () => {
  const cfg = minimal();
  cfg.gemini.keychainAccount = 42;
  const r = validateAutonomyConfig(cfg);
  assert.ok(r.errors.some(e => /gemini\.keychainAccount must be a non-empty string/.test(e)));
});

test('validateAutonomyConfig: omitted gemini.useKeychain + keychainAccount is fine (optional)', () => {
  const cfg = minimal();
  delete cfg.gemini.useKeychain;
  delete cfg.gemini.keychainAccount;
  const r = validateAutonomyConfig(cfg);
  assert.deepEqual(r.errors, []);
});

test('validateAutonomyConfig: gemini fields coexist (approval + useKeychain + keychainAccount)', () => {
  const cfg = minimal();
  cfg.gemini.approval = 'yolo';
  cfg.gemini.useKeychain = false;
  cfg.gemini.keychainAccount = 'work-api-key';
  const r = validateAutonomyConfig(cfg);
  assert.deepEqual(r.errors, []);
});
