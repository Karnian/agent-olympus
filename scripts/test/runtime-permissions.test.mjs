/**
 * Unit tests for scripts/lib/runtime-permissions.mjs and the integration with
 * scripts/lib/permission-detect.mjs (issue #67/#68/#69).
 *
 * Coverage:
 *   - extractPermissionModeFromStdin: variant shapes, invalid modes
 *   - extractPermissionModeFromEnv: precedence, invalid values
 *   - captureRuntimePermissions: schema, atomicity (rename), invalid input
 *   - loadRuntimePermissions: TTL expiry, schema-version refusal, fail-safe null
 *   - permissionModeToLevel: full mapping table
 *   - detectClaudePermissionLevel: settings ⇧ runtime upgrade-only merge
 *   - explainPermissionLevel: every chosen-source narrative branch
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  extractPermissionModeFromStdin,
  extractPermissionModeFromEnv,
  captureRuntimePermissions,
  loadRuntimePermissions,
  permissionModeToLevel,
  _internal,
} from '../lib/runtime-permissions.mjs';
import {
  detectClaudePermissionLevel,
  detectClaudePermissionLevelFromSettings,
  explainPermissionLevel,
} from '../lib/permission-detect.mjs';

// ─── Fixture helpers ────────────────────────────────────────────────────────

function makeTmpCwd() {
  const dir = join(tmpdir(), `ao-runtime-perms-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, '.ao', 'state'), { recursive: true });
  return dir;
}

function writeSettings(cwd, scope, body) {
  // scope: 'projectLocal' | 'project'
  const dir = join(cwd, '.claude');
  mkdirSync(dir, { recursive: true });
  const file = scope === 'projectLocal' ? 'settings.local.json' : 'settings.json';
  writeFileSync(join(dir, file), JSON.stringify(body));
}

function cleanup(cwd) {
  try { rmSync(cwd, { recursive: true, force: true }); } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════
// extractPermissionModeFromStdin
// ═══════════════════════════════════════════════════════════════════════════

describe('extractPermissionModeFromStdin', () => {
  it('reads top-level snake_case `permission_mode`', () => {
    const r = extractPermissionModeFromStdin({ permission_mode: 'bypassPermissions' });
    assert.equal(r.mode, 'bypassPermissions');
  });

  it('reads top-level camelCase `permissionMode`', () => {
    const r = extractPermissionModeFromStdin({ permissionMode: 'acceptEdits' });
    assert.equal(r.mode, 'acceptEdits');
  });

  it('reads nested `session.permission_mode`', () => {
    const r = extractPermissionModeFromStdin({ session: { permission_mode: 'plan' } });
    assert.equal(r.mode, 'plan');
  });

  it('reads nested `permissions.mode`', () => {
    const r = extractPermissionModeFromStdin({ permissions: { mode: 'default' } });
    assert.equal(r.mode, 'default');
  });

  it('drops unknown mode values', () => {
    const r = extractPermissionModeFromStdin({ permission_mode: 'godMode' });
    assert.equal(r.mode, null);
  });

  it('drops non-string mode values', () => {
    const r = extractPermissionModeFromStdin({ permission_mode: 42 });
    assert.equal(r.mode, null);
  });

  it('returns empty record for null/undefined input', () => {
    assert.equal(extractPermissionModeFromStdin(null).mode, null);
    assert.equal(extractPermissionModeFromStdin(undefined).mode, null);
    assert.deepEqual(extractPermissionModeFromStdin(null).observedKeys, []);
  });

  it('captures top-level keys as observedKeys (capped at 20)', () => {
    const big = {};
    for (let i = 0; i < 30; i++) big[`k${i}`] = i;
    big.permission_mode = 'default';
    const r = extractPermissionModeFromStdin(big);
    assert.equal(r.observedKeys.length, 20);
  });

  it('extracts sessionId from snake_case or camelCase', () => {
    assert.equal(extractPermissionModeFromStdin({ session_id: 's1' }).sessionId, 's1');
    assert.equal(extractPermissionModeFromStdin({ sessionId: 's2' }).sessionId, 's2');
  });

  it('first-match-wins precedence (top-level beats nested)', () => {
    const r = extractPermissionModeFromStdin({
      permission_mode: 'bypassPermissions',
      session: { permission_mode: 'default' },
    });
    assert.equal(r.mode, 'bypassPermissions');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// extractPermissionModeFromEnv
// ═══════════════════════════════════════════════════════════════════════════

describe('extractPermissionModeFromEnv', () => {
  it('reads CLAUDE_PERMISSION_MODE first', () => {
    const r = extractPermissionModeFromEnv({
      CLAUDE_PERMISSION_MODE: 'bypassPermissions',
      CLAUDE_CODE_PERMISSION_MODE: 'default',
    });
    assert.equal(r, 'bypassPermissions');
  });

  it('falls back to CLAUDE_CODE_PERMISSION_MODE', () => {
    const r = extractPermissionModeFromEnv({ CLAUDE_CODE_PERMISSION_MODE: 'acceptEdits' });
    assert.equal(r, 'acceptEdits');
  });

  it('drops unknown values', () => {
    assert.equal(extractPermissionModeFromEnv({ CLAUDE_PERMISSION_MODE: 'wat' }), null);
  });

  it('returns null when neither var is set', () => {
    assert.equal(extractPermissionModeFromEnv({}), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// captureRuntimePermissions + loadRuntimePermissions
// ═══════════════════════════════════════════════════════════════════════════

describe('capture/load round-trip', () => {
  let cwd;
  beforeEach(() => { cwd = makeTmpCwd(); });
  afterEach(() => { cleanup(cwd); });

  it('writes and reads back a valid record', () => {
    const ok = captureRuntimePermissions({
      permissionMode: 'bypassPermissions',
      source: 'hook_stdin',
      sessionId: 'abc',
      rawStdinKeys: ['session_id', 'cwd', 'permission_mode'],
    }, { cwd, now: new Date('2026-05-08T12:00:00Z') });
    assert.equal(ok, true);

    const rec = loadRuntimePermissions({ cwd, now: new Date('2026-05-08T12:05:00Z') });
    assert.ok(rec, 'expected record');
    assert.equal(rec.permissionMode, 'bypassPermissions');
    assert.equal(rec.source, 'hook_stdin');
    assert.equal(rec.sessionId, 'abc');
    assert.deepEqual(rec.rawStdinKeys, ['session_id', 'cwd', 'permission_mode']);
    assert.equal(rec.ageMs, 5 * 60 * 1000);
  });

  it('rejects invalid permissionMode (write returns false)', () => {
    const ok = captureRuntimePermissions({ permissionMode: 'godMode' }, { cwd });
    assert.equal(ok, false);
  });

  it('rejects invalid source (write returns false)', () => {
    const ok = captureRuntimePermissions({
      permissionMode: 'default',
      source: 'fabrication',
    }, { cwd });
    assert.equal(ok, false);
  });

  it('returns null when cache file is missing', () => {
    assert.equal(loadRuntimePermissions({ cwd }), null);
  });

  it('returns null past TTL', () => {
    captureRuntimePermissions({ permissionMode: 'default' }, {
      cwd,
      now: new Date('2026-05-08T12:00:00Z'),
    });
    // 31 minutes later — past 30-min TTL
    const rec = loadRuntimePermissions({
      cwd,
      now: new Date('2026-05-08T12:31:00Z'),
    });
    assert.equal(rec, null);
  });

  it('honors a custom TTL override', () => {
    captureRuntimePermissions({ permissionMode: 'default' }, {
      cwd,
      now: new Date('2026-05-08T12:00:00Z'),
    });
    // 100 ms after capture — within 1s custom TTL
    const fresh = loadRuntimePermissions({
      cwd,
      now: new Date('2026-05-08T12:00:00.100Z'),
      ttlMs: 1000,
    });
    assert.ok(fresh);
    // 2s after capture — past 1s custom TTL
    const stale = loadRuntimePermissions({
      cwd,
      now: new Date('2026-05-08T12:00:02Z'),
      ttlMs: 1000,
    });
    assert.equal(stale, null);
  });

  it('refuses unknown schema versions (forward-compat)', () => {
    const f = join(cwd, '.ao', 'state', 'ao-runtime-permissions.json');
    writeFileSync(f, JSON.stringify({
      schemaVersion: 99,
      capturedAt: new Date().toISOString(),
      permissionMode: 'bypassPermissions',
      source: 'hook_stdin',
    }));
    assert.equal(loadRuntimePermissions({ cwd }), null);
  });

  it('refuses corrupt JSON without throwing', () => {
    const f = join(cwd, '.ao', 'state', 'ao-runtime-permissions.json');
    writeFileSync(f, 'not-json');
    assert.equal(loadRuntimePermissions({ cwd }), null);
  });

  it('written file has 0o600 mode', () => {
    captureRuntimePermissions({ permissionMode: 'default' }, { cwd });
    const f = join(cwd, '.ao', 'state', 'ao-runtime-permissions.json');
    const mode = statSync(f).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it('written file is parseable JSON with schemaVersion 1', () => {
    captureRuntimePermissions({ permissionMode: 'acceptEdits' }, { cwd });
    const f = join(cwd, '.ao', 'state', 'ao-runtime-permissions.json');
    const parsed = JSON.parse(readFileSync(f, 'utf-8'));
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.permissionMode, 'acceptEdits');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// permissionModeToLevel
// ═══════════════════════════════════════════════════════════════════════════

describe('permissionModeToLevel', () => {
  it('maps the full table', () => {
    assert.equal(permissionModeToLevel('bypassPermissions'), 'full-auto');
    assert.equal(permissionModeToLevel('acceptEdits'), 'auto-edit');
    assert.equal(permissionModeToLevel('default'), 'suggest');
    assert.equal(permissionModeToLevel('plan'), 'suggest');
  });

  it('returns null for unknown / undefined', () => {
    assert.equal(permissionModeToLevel('godMode'), null);
    assert.equal(permissionModeToLevel(undefined), null);
    assert.equal(permissionModeToLevel(null), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// detectClaudePermissionLevel — settings ⇧ runtime merge
// ═══════════════════════════════════════════════════════════════════════════

describe('detectClaudePermissionLevel (settings ⇧ runtime)', () => {
  let cwd;
  beforeEach(() => { cwd = makeTmpCwd(); });
  afterEach(() => { cleanup(cwd); });

  it('returns settings level when no runtime override is present', () => {
    writeSettings(cwd, 'projectLocal', {
      permissions: { allow: ['Bash(*)', 'Write(*)'] },
    });
    const level = detectClaudePermissionLevel({ cwd, home: '/nonexistent' });
    assert.equal(level, 'full-auto');
  });

  it('runtime bypassPermissions promotes empty settings (suggest → full-auto)', () => {
    captureRuntimePermissions({ permissionMode: 'bypassPermissions' }, { cwd });
    const level = detectClaudePermissionLevel({ cwd, home: '/nonexistent' });
    assert.equal(level, 'full-auto');
  });

  it('runtime acceptEdits promotes empty settings (suggest → auto-edit)', () => {
    captureRuntimePermissions({ permissionMode: 'acceptEdits' }, { cwd });
    const level = detectClaudePermissionLevel({ cwd, home: '/nonexistent' });
    assert.equal(level, 'auto-edit');
  });

  it('runtime default does NOT promote (suggest → suggest, no-op)', () => {
    captureRuntimePermissions({ permissionMode: 'default' }, { cwd });
    const level = detectClaudePermissionLevel({ cwd, home: '/nonexistent' });
    assert.equal(level, 'suggest');
  });

  it('runtime plan does NOT promote (suggest → suggest)', () => {
    captureRuntimePermissions({ permissionMode: 'plan' }, { cwd });
    const level = detectClaudePermissionLevel({ cwd, home: '/nonexistent' });
    assert.equal(level, 'suggest');
  });

  it('runtime cannot DOWNGRADE settings (settings full-auto stays)', () => {
    writeSettings(cwd, 'projectLocal', {
      permissions: { allow: ['Bash(*)', 'Write(*)'] },
    });
    captureRuntimePermissions({ permissionMode: 'default' }, { cwd });
    const level = detectClaudePermissionLevel({ cwd, home: '/nonexistent' });
    assert.equal(level, 'full-auto');
  });

  it('skipRuntime opts out of override (returns settings tier)', () => {
    captureRuntimePermissions({ permissionMode: 'bypassPermissions' }, { cwd });
    const level = detectClaudePermissionLevel({
      cwd,
      home: '/nonexistent',
      skipRuntime: true,
    });
    assert.equal(level, 'suggest');
  });

  it('expired runtime cache does not promote', () => {
    captureRuntimePermissions({ permissionMode: 'bypassPermissions' }, {
      cwd,
      now: new Date(Date.now() - 60 * 60 * 1000), // 1h ago, past 30min TTL
    });
    const level = detectClaudePermissionLevel({ cwd, home: '/nonexistent' });
    assert.equal(level, 'suggest');
  });

  it('detectClaudePermissionLevelFromSettings is the pre-runtime baseline', () => {
    writeSettings(cwd, 'projectLocal', {
      permissions: { allow: ['Write(*)'] },
    });
    captureRuntimePermissions({ permissionMode: 'bypassPermissions' }, { cwd });
    assert.equal(
      detectClaudePermissionLevelFromSettings({ cwd, home: '/nonexistent' }),
      'auto-edit',
    );
    // Final level promotes via runtime
    assert.equal(
      detectClaudePermissionLevel({ cwd, home: '/nonexistent' }),
      'full-auto',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// explainPermissionLevel
// ═══════════════════════════════════════════════════════════════════════════

describe('explainPermissionLevel', () => {
  let cwd;
  beforeEach(() => { cwd = makeTmpCwd(); });
  afterEach(() => { cleanup(cwd); });

  it('reports settings-only when no runtime override exists', () => {
    writeSettings(cwd, 'projectLocal', {
      permissions: { allow: ['Bash(*)', 'Write(*)'] },
    });
    const r = explainPermissionLevel({ cwd, home: '/nonexistent' });
    assert.equal(r.settingsLevel, 'full-auto');
    assert.equal(r.runtime, null);
    assert.equal(r.finalLevel, 'full-auto');
    assert.equal(r.chosenSource, 'settings');
  });

  it('reports promotion when runtime upgrades settings', () => {
    captureRuntimePermissions({ permissionMode: 'bypassPermissions' }, { cwd });
    const r = explainPermissionLevel({ cwd, home: '/nonexistent' });
    assert.equal(r.settingsLevel, 'suggest');
    assert.equal(r.runtime?.level, 'full-auto');
    assert.equal(r.finalLevel, 'full-auto');
    assert.equal(r.chosenSource, 'runtime');
    assert.match(r.chosenSourceReason, /promotes/);
  });

  it('reports tie (settings wins) when levels are equal', () => {
    writeSettings(cwd, 'projectLocal', {
      permissions: { allow: ['Bash(*)', 'Write(*)'] },
    });
    captureRuntimePermissions({ permissionMode: 'bypassPermissions' }, { cwd });
    const r = explainPermissionLevel({ cwd, home: '/nonexistent' });
    assert.equal(r.chosenSource, 'settings');
    assert.match(r.chosenSourceReason, /matches settings tier/);
  });

  it('reports settings-wins when runtime is lower (upgrade-only)', () => {
    writeSettings(cwd, 'projectLocal', {
      permissions: { allow: ['Bash(*)', 'Write(*)'] },
    });
    captureRuntimePermissions({ permissionMode: 'default' }, { cwd });
    const r = explainPermissionLevel({ cwd, home: '/nonexistent' });
    assert.equal(r.finalLevel, 'full-auto');
    assert.equal(r.chosenSource, 'settings');
    assert.match(r.chosenSourceReason, /upgrade-only policy/);
  });

  it('mentions /ask diagnostic guidance when settings stay at suggest with no runtime', () => {
    const r = explainPermissionLevel({ cwd, home: '/nonexistent' });
    assert.equal(r.finalLevel, 'suggest');
    assert.match(r.chosenSourceReason, /No runtime override captured/);
    assert.match(r.chosenSourceReason, /SessionStart hook/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// _internal sanity (canary against accidental constant drift)
// ═══════════════════════════════════════════════════════════════════════════

describe('_internal constants', () => {
  it('exposes the documented defaults', () => {
    assert.equal(_internal.SCHEMA_VERSION, 1);
    assert.equal(_internal.TTL_MS, 30 * 60 * 1000);
    assert.equal(_internal.CACHE_REL_PATH, '.ao/state/ao-runtime-permissions.json');
  });
});
