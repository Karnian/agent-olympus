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

// ─── credentialSource + keychainService (PR 3) ────────────────────────────────

test('DEFAULT_AUTONOMY_CONFIG: gemini.credentialSource defaults to "auto"', () => {
  assert.equal(DEFAULT_AUTONOMY_CONFIG.gemini.credentialSource, 'auto');
});

test('DEFAULT_AUTONOMY_CONFIG: gemini.keychainService defaults to null', () => {
  assert.equal(DEFAULT_AUTONOMY_CONFIG.gemini.keychainService, null);
});

test('validateAutonomyConfig: gemini.credentialSource accepts all four documented values', () => {
  for (const src of ['auto', 'env', 'shared-keychain', 'ao-keychain']) {
    const cfg = minimal();
    cfg.gemini.credentialSource = src;
    const r = validateAutonomyConfig(cfg);
    assert.deepEqual(r.errors, [], `credentialSource=${src} should be valid`);
  }
});

test('validateAutonomyConfig: gemini.credentialSource rejects arbitrary strings', () => {
  const cfg = minimal();
  cfg.gemini.credentialSource = 'nonsense';
  const r = validateAutonomyConfig(cfg);
  assert.ok(r.errors.some(e => /credentialSource must be one of/.test(e)));
});

test('validateAutonomyConfig: gemini.credentialSource rejects non-string', () => {
  const cfg = minimal();
  cfg.gemini.credentialSource = 42;
  const r = validateAutonomyConfig(cfg);
  assert.ok(r.errors.some(e => /credentialSource must be one of/.test(e)));
});

test('validateAutonomyConfig: gemini.keychainService accepts null', () => {
  const cfg = minimal();
  cfg.gemini.keychainService = null;
  const r = validateAutonomyConfig(cfg);
  assert.deepEqual(r.errors, []);
});

test('validateAutonomyConfig: gemini.keychainService accepts non-empty string', () => {
  const cfg = minimal();
  cfg.gemini.keychainService = 'my.custom.service';
  const r = validateAutonomyConfig(cfg);
  assert.deepEqual(r.errors, []);
});

test('validateAutonomyConfig: gemini.keychainService rejects empty string', () => {
  const cfg = minimal();
  cfg.gemini.keychainService = '';
  const r = validateAutonomyConfig(cfg);
  assert.ok(r.errors.some(e => /keychainService must be null or a non-empty string/.test(e)));
});

test('validateAutonomyConfig: gemini.keychainService rejects non-string non-null', () => {
  const cfg = minimal();
  cfg.gemini.keychainService = 42;
  const r = validateAutonomyConfig(cfg);
  assert.ok(r.errors.some(e => /keychainService must be null or a non-empty string/.test(e)));
});

// ═══════════════════════════════════════════════════════════════════════════
// v1.1.2: Layered resolution (global + project + env override + CI kill-switch)
// ═══════════════════════════════════════════════════════════════════════════

// Import the newly-exported helpers (available after v1.1.2)
import { resolveAutonomyPaths, isCIEnvironment } from '../lib/autonomy.mjs';

/** Save + restore env vars for a test */
function withEnv(envOverrides, fn) {
  const restore = {};
  for (const k of Object.keys(envOverrides)) {
    restore[k] = process.env[k];
    if (envOverrides[k] === undefined) delete process.env[k];
    else process.env[k] = envOverrides[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(restore)) {
      if (restore[k] === undefined) delete process.env[k];
      else process.env[k] = restore[k];
    }
  }
}

async function makeLayeredFixture(cwd, projectConfig, globalConfig, globalDir) {
  await fs.mkdir(path.join(cwd, '.ao'), { recursive: true });
  if (projectConfig) {
    await fs.writeFile(
      path.join(cwd, '.ao', 'autonomy.json'),
      JSON.stringify(projectConfig),
    );
  }
  if (globalConfig && globalDir) {
    await fs.mkdir(globalDir, { recursive: true });
    await fs.writeFile(
      path.join(globalDir, 'autonomy.json'),
      JSON.stringify(globalConfig),
    );
  }
}

// ---------- isCIEnvironment ----------

test('isCIEnvironment: false when no env flags set', () => {
  withEnv({ CI: undefined, GITHUB_ACTIONS: undefined }, () => {
    assert.equal(isCIEnvironment(), false);
  });
});

test('isCIEnvironment: true when CI=true', () => {
  withEnv({ CI: 'true' }, () => {
    assert.equal(isCIEnvironment(), true);
  });
});

test('isCIEnvironment: true when CI=1', () => {
  withEnv({ CI: '1' }, () => {
    assert.equal(isCIEnvironment(), true);
  });
});

test('isCIEnvironment: false when CI=false explicitly', () => {
  withEnv({ CI: 'false', GITHUB_ACTIONS: undefined }, () => {
    assert.equal(isCIEnvironment(), false);
  });
});

test('isCIEnvironment: false when CI=0 explicitly', () => {
  withEnv({ CI: '0', GITHUB_ACTIONS: undefined }, () => {
    assert.equal(isCIEnvironment(), false);
  });
});

test('isCIEnvironment: true when GITHUB_ACTIONS=true (even without CI)', () => {
  withEnv({ CI: undefined, GITHUB_ACTIONS: 'true' }, () => {
    assert.equal(isCIEnvironment(), true);
  });
});

// ---------- resolveAutonomyPaths ----------

test('resolveAutonomyPaths: AO_AUTONOMY_CONFIG env replaces global chain', async () => {
  const tmp = await makeTmpDir();
  try {
    const custom = path.join(tmp, 'custom.json');
    await fs.writeFile(custom, '{}');
    withEnv({ AO_AUTONOMY_CONFIG: custom, CI: undefined, GITHUB_ACTIONS: undefined }, () => {
      const r = resolveAutonomyPaths(tmp);
      assert.equal(r.global, custom);
      assert.equal(r.project, path.join(tmp, '.ao', 'autonomy.json'));
    });
  } finally {
    await removeTmpDir(tmp);
  }
});

test('resolveAutonomyPaths: AO_AUTONOMY_CONFIG bypasses CI kill-switch', async () => {
  const tmp = await makeTmpDir();
  try {
    const custom = path.join(tmp, 'custom.json');
    await fs.writeFile(custom, '{}');
    withEnv({ AO_AUTONOMY_CONFIG: custom, CI: 'true' }, () => {
      const r = resolveAutonomyPaths(tmp);
      assert.equal(r.global, custom, 'env override must bypass CI kill-switch');
    });
  } finally {
    await removeTmpDir(tmp);
  }
});

test('resolveAutonomyPaths: CI kill-switch skips global when no env override', async () => {
  const tmp = await makeTmpDir();
  try {
    withEnv({ CI: 'true', AO_AUTONOMY_CONFIG: undefined, XDG_CONFIG_HOME: undefined }, () => {
      const r = resolveAutonomyPaths(tmp);
      assert.equal(r.global, null, 'CI must skip global chain');
      assert.ok(r.project.endsWith(path.join('.ao', 'autonomy.json')));
    });
  } finally {
    await removeTmpDir(tmp);
  }
});

test('resolveAutonomyPaths: XDG_CONFIG_HOME takes precedence over ~/.config', async () => {
  const tmp = await makeTmpDir();
  const xdg = await makeTmpDir();
  try {
    const xdgPath = path.join(xdg, 'agent-olympus', 'autonomy.json');
    await fs.mkdir(path.dirname(xdgPath), { recursive: true });
    await fs.writeFile(xdgPath, '{}');
    withEnv({ CI: undefined, GITHUB_ACTIONS: undefined, AO_AUTONOMY_CONFIG: undefined, XDG_CONFIG_HOME: xdg }, () => {
      const r = resolveAutonomyPaths(tmp);
      assert.equal(r.global, xdgPath);
    });
  } finally {
    await removeTmpDir(tmp);
    await removeTmpDir(xdg);
  }
});

test('resolveAutonomyPaths: returns null global when no file exists anywhere', async () => {
  const tmp = await makeTmpDir();
  const emptyXdg = await makeTmpDir(); // no agent-olympus subdir
  try {
    withEnv({
      CI: undefined,
      GITHUB_ACTIONS: undefined,
      AO_AUTONOMY_CONFIG: undefined,
      XDG_CONFIG_HOME: emptyXdg,
      HOME: emptyXdg, // also points HOME to empty dir so ~/.config and ~/.ao are empty
    }, () => {
      const r = resolveAutonomyPaths(tmp);
      assert.equal(r.global, null);
    });
  } finally {
    await removeTmpDir(tmp);
    await removeTmpDir(emptyXdg);
  }
});

// ---------- loadAutonomyConfig layered ----------

test('loadAutonomyConfig: project overrides global (project wins)', async () => {
  const tmp = await makeTmpDir();
  const xdg = await makeTmpDir();
  try {
    const globalDir = path.join(xdg, 'agent-olympus');
    // Global says solo; project says atlas
    await makeLayeredFixture(
      tmp,
      { planExecution: 'atlas' },
      { planExecution: 'solo' },
      globalDir,
    );
    withEnv({ XDG_CONFIG_HOME: xdg, CI: undefined, AO_AUTONOMY_CONFIG: undefined, GITHUB_ACTIONS: undefined }, () => {
      const cfg = loadAutonomyConfig(tmp);
      assert.equal(cfg.planExecution, 'atlas', 'project layer must override global');
    });
  } finally {
    await removeTmpDir(tmp);
    await removeTmpDir(xdg);
  }
});

test('loadAutonomyConfig: global applies when no project file', async () => {
  const tmp = await makeTmpDir();
  const xdg = await makeTmpDir();
  try {
    const globalDir = path.join(xdg, 'agent-olympus');
    await makeLayeredFixture(
      tmp,
      null, // no project config
      { codex: { approval: 'full-auto' } },
      globalDir,
    );
    withEnv({ XDG_CONFIG_HOME: xdg, CI: undefined, AO_AUTONOMY_CONFIG: undefined, GITHUB_ACTIONS: undefined }, () => {
      const cfg = loadAutonomyConfig(tmp);
      assert.equal(cfg.codex.approval, 'full-auto', 'global must apply when project absent');
    });
  } finally {
    await removeTmpDir(tmp);
    await removeTmpDir(xdg);
  }
});

test('loadAutonomyConfig: global ignored under CI', async () => {
  const tmp = await makeTmpDir();
  const xdg = await makeTmpDir();
  try {
    const globalDir = path.join(xdg, 'agent-olympus');
    await makeLayeredFixture(
      tmp,
      null,
      { codex: { approval: 'full-auto' } },
      globalDir,
    );
    withEnv({ XDG_CONFIG_HOME: xdg, CI: 'true', AO_AUTONOMY_CONFIG: undefined }, () => {
      const cfg = loadAutonomyConfig(tmp);
      assert.equal(cfg.codex.approval, 'auto',
        'default must apply — global skipped in CI without env override');
    });
  } finally {
    await removeTmpDir(tmp);
    await removeTmpDir(xdg);
  }
});

test('loadAutonomyConfig: AO_AUTONOMY_CONFIG env override works in CI', async () => {
  const tmp = await makeTmpDir();
  const xdg = await makeTmpDir();
  try {
    const customPath = path.join(xdg, 'my-policy.json');
    await fs.writeFile(customPath, JSON.stringify({ codex: { approval: 'full-auto' } }));
    withEnv({ CI: 'true', AO_AUTONOMY_CONFIG: customPath }, () => {
      const cfg = loadAutonomyConfig(tmp);
      assert.equal(cfg.codex.approval, 'full-auto',
        'explicit env override must apply even in CI');
    });
  } finally {
    await removeTmpDir(tmp);
    await removeTmpDir(xdg);
  }
});

test('loadAutonomyConfig: invalid global layer is skipped, project still applies', async () => {
  const tmp = await makeTmpDir();
  const xdg = await makeTmpDir();
  try {
    const globalDir = path.join(xdg, 'agent-olympus');
    await fs.mkdir(globalDir, { recursive: true });
    // Invalid: nativeTeams must be boolean
    await fs.writeFile(path.join(globalDir, 'autonomy.json'), JSON.stringify({ nativeTeams: 'yes' }));
    await fs.mkdir(path.join(tmp, '.ao'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, '.ao', 'autonomy.json'),
      JSON.stringify({ planExecution: 'solo' }),
    );
    withEnv({ XDG_CONFIG_HOME: xdg, CI: undefined, AO_AUTONOMY_CONFIG: undefined, GITHUB_ACTIONS: undefined }, () => {
      const cfg = loadAutonomyConfig(tmp);
      assert.equal(cfg.planExecution, 'solo',
        'invalid global must be skipped without affecting project');
    });
  } finally {
    await removeTmpDir(tmp);
    await removeTmpDir(xdg);
  }
});

test('loadAutonomyConfig: arrays are replaced, not concatenated (merge semantics)', async () => {
  const tmp = await makeTmpDir();
  const xdg = await makeTmpDir();
  try {
    const globalDir = path.join(xdg, 'agent-olympus');
    await makeLayeredFixture(
      tmp,
      { ship: { labels: ['project-label'] } },
      { ship: { labels: ['global-label-1', 'global-label-2'] } },
      globalDir,
    );
    withEnv({ XDG_CONFIG_HOME: xdg, CI: undefined, AO_AUTONOMY_CONFIG: undefined, GITHUB_ACTIONS: undefined }, () => {
      const cfg = loadAutonomyConfig(tmp);
      assert.deepEqual(cfg.ship.labels, ['project-label'],
        'arrays must be replaced (not concatenated) to keep merge predictable');
    });
  } finally {
    await removeTmpDir(tmp);
    await removeTmpDir(xdg);
  }
});

test('loadAutonomyConfig: project-only config still works (backward compat)', async () => {
  const tmp = await makeTmpDir();
  const emptyXdg = await makeTmpDir();
  try {
    await fs.mkdir(path.join(tmp, '.ao'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, '.ao', 'autonomy.json'),
      JSON.stringify({ planExecution: 'atlas' }),
    );
    withEnv({ XDG_CONFIG_HOME: emptyXdg, CI: undefined, AO_AUTONOMY_CONFIG: undefined, HOME: emptyXdg, GITHUB_ACTIONS: undefined }, () => {
      const cfg = loadAutonomyConfig(tmp);
      assert.equal(cfg.planExecution, 'atlas');
    });
  } finally {
    await removeTmpDir(tmp);
    await removeTmpDir(emptyXdg);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// v1.1.2 Codex review hardening — symlink guard, skip opts, CI providers
// ═══════════════════════════════════════════════════════════════════════════

test('isCIEnvironment: expanded CI provider list (GitLab, CircleCI, Buildkite, etc.)', () => {
  for (const marker of ['GITLAB_CI', 'CIRCLECI', 'TRAVIS', 'JENKINS_URL', 'BUILDKITE', 'DRONE', 'TF_BUILD', 'CODEBUILD_BUILD_ID']) {
    withEnv({ CI: undefined, GITHUB_ACTIONS: undefined, [marker]: 'true' }, () => {
      assert.equal(isCIEnvironment(), true, `${marker} should mark CI`);
    });
  }
});

test('loadAutonomyConfig: skipGlobal opt forces project-only resolution', async () => {
  const tmp = await makeTmpDir();
  const xdg = await makeTmpDir();
  try {
    const globalDir = path.join(xdg, 'agent-olympus');
    await makeLayeredFixture(
      tmp,
      null,
      { codex: { approval: 'full-auto' } },
      globalDir,
    );
    withEnv({ XDG_CONFIG_HOME: xdg, CI: undefined, AO_AUTONOMY_CONFIG: undefined, GITHUB_ACTIONS: undefined }, () => {
      const cfg = loadAutonomyConfig(tmp, { skipGlobal: true });
      assert.equal(cfg.codex.approval, 'auto',
        'skipGlobal must suppress even home-dir global config');
    });
  } finally {
    await removeTmpDir(tmp);
    await removeTmpDir(xdg);
  }
});

test('loadAutonomyConfig: skipEnv opt ignores AO_AUTONOMY_CONFIG but keeps XDG layer', async () => {
  const tmp = await makeTmpDir();
  const xdg = await makeTmpDir();
  try {
    const envPath = path.join(xdg, 'env-override.json');
    await fs.writeFile(envPath, JSON.stringify({ codex: { approval: 'full-auto' } }));
    const globalDir = path.join(xdg, 'agent-olympus');
    await fs.mkdir(globalDir, { recursive: true });
    await fs.writeFile(
      path.join(globalDir, 'autonomy.json'),
      JSON.stringify({ planExecution: 'atlas' }),
    );
    withEnv({ XDG_CONFIG_HOME: xdg, CI: undefined, AO_AUTONOMY_CONFIG: envPath, GITHUB_ACTIONS: undefined }, () => {
      const cfg = loadAutonomyConfig(tmp, { skipEnv: true });
      assert.equal(cfg.planExecution, 'atlas',
        'skipEnv must ignore env override and fall through to XDG');
      assert.equal(cfg.codex.approval, 'auto',
        'env override must NOT apply when skipEnv is true');
    });
  } finally {
    await removeTmpDir(tmp);
    await removeTmpDir(xdg);
  }
});

test('loadAutonomyConfig: symlink escaping allowed global roots is rejected', async () => {
  const tmp = await makeTmpDir();
  const xdg = await makeTmpDir();
  const untrusted = await makeTmpDir();
  try {
    // Write an evil config in an untrusted directory
    const evilPath = path.join(untrusted, 'evil-policy.json');
    await fs.writeFile(evilPath, JSON.stringify({ codex: { approval: 'full-auto' } }));

    // Create a symlink inside the allowed XDG location pointing AT the evil file
    const globalDir = path.join(xdg, 'agent-olympus');
    await fs.mkdir(globalDir, { recursive: true });
    const symlink = path.join(globalDir, 'autonomy.json');
    try { await fs.symlink(evilPath, symlink); }
    catch { /* symlinks may require privileges on some FS — skip test */ return; }

    withEnv({ XDG_CONFIG_HOME: xdg, CI: undefined, AO_AUTONOMY_CONFIG: undefined, HOME: xdg, GITHUB_ACTIONS: undefined }, () => {
      // Silence the symlink-rejected diagnostic
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = () => true;
      try {
        const cfg = loadAutonomyConfig(tmp);
        assert.equal(cfg.codex.approval, 'auto',
          'symlink escape from allowed root must be rejected (kept at default)');
      } finally {
        process.stderr.write = orig;
      }
    });
  } finally {
    await removeTmpDir(tmp);
    await removeTmpDir(xdg);
    await removeTmpDir(untrusted);
  }
});

test('loadAutonomyConfig: symlink within allowed root is accepted', async () => {
  const tmp = await makeTmpDir();
  const xdg = await makeTmpDir();
  try {
    const globalDir = path.join(xdg, 'agent-olympus');
    await fs.mkdir(globalDir, { recursive: true });
    const target = path.join(globalDir, 'real-policy.json');
    await fs.writeFile(target, JSON.stringify({ planExecution: 'atlas' }));
    const symlink = path.join(globalDir, 'autonomy.json');
    try { await fs.symlink(target, symlink); }
    catch { return; }

    withEnv({ XDG_CONFIG_HOME: xdg, CI: undefined, AO_AUTONOMY_CONFIG: undefined, HOME: xdg, GITHUB_ACTIONS: undefined }, () => {
      const cfg = loadAutonomyConfig(tmp);
      assert.equal(cfg.planExecution, 'atlas',
        'symlink staying inside allowed root must resolve normally');
    });
  } finally {
    await removeTmpDir(tmp);
    await removeTmpDir(xdg);
  }
});

test('loadAutonomyConfig: project symlink is NOT checked (project owner trusted)', async () => {
  // Project-level files are under the repo's own .ao/ which the project owner
  // controls — a malicious symlink there means the project itself is malicious,
  // which is a trust boundary decision for the user opening the repo, not for
  // the loader. We document the behavior by asserting project symlinks resolve.
  const tmp = await makeTmpDir();
  const other = await makeTmpDir();
  try {
    const targetInOther = path.join(other, 'policy.json');
    await fs.writeFile(targetInOther, JSON.stringify({ planExecution: 'atlas' }));
    await fs.mkdir(path.join(tmp, '.ao'), { recursive: true });
    const projectLink = path.join(tmp, '.ao', 'autonomy.json');
    try { await fs.symlink(targetInOther, projectLink); }
    catch { return; }

    withEnv({ CI: undefined, AO_AUTONOMY_CONFIG: undefined, GITHUB_ACTIONS: undefined, HOME: other }, () => {
      const cfg = loadAutonomyConfig(tmp);
      assert.equal(cfg.planExecution, 'atlas',
        'project symlinks are trusted (project owner scope)');
    });
  } finally {
    await removeTmpDir(tmp);
    await removeTmpDir(other);
  }
});

test('loadAutonomyConfig: skipEnv=true removes env parent from symlink allowlist (Codex #2)', async () => {
  const tmp = await makeTmpDir();
  const xdg = await makeTmpDir();
  const untrusted = await makeTmpDir();
  try {
    // Env override points at an "evil" policy in untrusted dir
    const envPath = path.join(untrusted, 'evil.json');
    await fs.writeFile(envPath, JSON.stringify({ codex: { approval: 'full-auto' } }));
    // XDG global is a symlink pointing at that same untrusted file
    const globalDir = path.join(xdg, 'agent-olympus');
    await fs.mkdir(globalDir, { recursive: true });
    const linkedGlobal = path.join(globalDir, 'autonomy.json');
    try { await fs.symlink(envPath, linkedGlobal); }
    catch { return; }

    withEnv({
      XDG_CONFIG_HOME: xdg,
      AO_AUTONOMY_CONFIG: envPath,
      CI: undefined,
      GITHUB_ACTIONS: undefined,
      HOME: xdg,
    }, () => {
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = () => true;
      try {
        const cfg = loadAutonomyConfig(tmp, { skipEnv: true });
        assert.equal(cfg.codex.approval, 'auto',
          'skipEnv must disable env override AND its directory whitelist, so the symlinked XDG pointer is rejected');
      } finally {
        process.stderr.write = orig;
      }
    });
  } finally {
    await removeTmpDir(tmp);
    await removeTmpDir(xdg);
    await removeTmpDir(untrusted);
  }
});
