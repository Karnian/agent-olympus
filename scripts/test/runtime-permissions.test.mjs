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
  detectClaudePermissions,
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

  // ─── Codex-review fixes (#69 WARN): runtime override must respect ────────
  // managed deny lists and disableBypassPermissionsMode. The earlier
  // implementation mapped runtime mode to a tier in isolation; the fix flows
  // it through detectClaudePermissions's same broad/scoped + deny pipeline.

  it('runtime bypassPermissions is clamped by deny: Bash(*) (no broad bash → auto-edit max)', () => {
    writeSettings(cwd, 'projectLocal', {
      permissions: { deny: ['Bash(*)'] },
    });
    captureRuntimePermissions({ permissionMode: 'bypassPermissions' }, { cwd });
    // Without the fix this would have promoted to full-auto despite the
    // deny — Codex flagged it as a security regression.
    assert.equal(
      detectClaudePermissionLevel({ cwd, home: '/nonexistent' }),
      'auto-edit',
      'broad Bash deny clamps runtime bypassPermissions',
    );
  });

  it('runtime bypassPermissions is clamped by scoped Bash deny (still no broad bash)', () => {
    writeSettings(cwd, 'projectLocal', {
      permissions: { deny: ['Bash(curl:*)'] },
    });
    captureRuntimePermissions({ permissionMode: 'bypassPermissions' }, { cwd });
    // Scoped deny invalidates the broad bash grant under coarse codex sandbox.
    assert.equal(
      detectClaudePermissionLevel({ cwd, home: '/nonexistent' }),
      'auto-edit',
      'scoped Bash deny clamps runtime bypassPermissions to auto-edit',
    );
  });

  it('runtime bypassPermissions implicit grant is dropped by disableBypassPermissionsMode (collapses to suggest, not acceptEdits)', () => {
    writeSettings(cwd, 'projectLocal', {
      permissions: { disableBypassPermissionsMode: true },
    });
    captureRuntimePermissions({ permissionMode: 'bypassPermissions' }, { cwd });
    // bypassDisabled → bypassActive=false → implicit broad DROPPED entirely.
    // The runtime tier does NOT silently fall through to acceptEdits — it
    // collapses to suggest unless an explicit allow list compensates.
    assert.equal(
      detectClaudePermissionLevel({ cwd, home: '/nonexistent' }),
      'suggest',
      'disableBypassPermissionsMode drops the implicit grant; no acceptEdits fallback',
    );
  });

  it('runtime acceptEdits respects deny: Write(*) (no broad write → suggest)', () => {
    writeSettings(cwd, 'projectLocal', {
      permissions: { deny: ['Write(*)', 'Edit(*)'] },
    });
    captureRuntimePermissions({ permissionMode: 'acceptEdits' }, { cwd });
    assert.equal(
      detectClaudePermissionLevel({ cwd, home: '/nonexistent' }),
      'suggest',
      'broad Write+Edit deny invalidates runtime acceptEdits implicit broad',
    );
  });

  it('runtime is clamped via opts.effectiveDefaultMode in detectClaudePermissions', () => {
    writeSettings(cwd, 'projectLocal', {
      permissions: { deny: ['Bash(*)'] },
    });
    // Direct exercise of the override knob — no runtime cache needed.
    const flags = detectClaudePermissions({
      cwd,
      home: '/nonexistent',
      effectiveDefaultMode: 'bypassPermissions',
    });
    assert.equal(flags.hasBashStar, false, 'broad Bash deny invalidates implicit grant');
    assert.equal(flags.hasWriteStar, true, 'Write/Edit not denied → still broad');
    assert.equal(flags.hasEditStar, true);
  });

  // ─── Codex round-2 review (WARN #2): allowManagedPermissionRulesOnly ─────
  // must clamp runtime implicit grants. The flag means "only managed scope's
  // allow list counts". A runtime `bypassPermissions` produces an implicit
  // broad grant that's by definition non-managed — without the fix the runtime
  // could promote to full-auto despite the org policy locking down to
  // managed-only allow.

  it('allowManagedPermissionRulesOnly clamps runtime bypassPermissions implicit grant', () => {
    // Simulate a managed-only org: managed scope sets the flag + a narrow
    // allow list. Runtime captures bypassPermissions (e.g. user launched
    // claude --dangerously-skip-permissions).
    const managedRoot = join(cwd, 'fake-managed');
    mkdirSync(managedRoot, { recursive: true });
    writeFileSync(join(managedRoot, 'managed-settings.json'), JSON.stringify({
      permissions: {
        allow: ['Read(*)'],
        allowManagedPermissionRulesOnly: true,
      },
    }));
    captureRuntimePermissions({ permissionMode: 'bypassPermissions' }, { cwd });
    const level = detectClaudePermissionLevel({
      cwd,
      home: '/nonexistent',
      managedRootOverride: managedRoot,
    });
    // Runtime implicit grant must NOT bypass managed-only ceiling.
    assert.equal(level, 'suggest',
      'allowManagedPermissionRulesOnly suppresses non-managed runtime implicit grants');
  });

  it('allowManagedPermissionRulesOnly does NOT clamp managed-scope defaultMode', () => {
    // Managed admin can still grant broad implicit access to ALL users by
    // setting defaultMode in the managed scope itself. This is intentional —
    // the flag suppresses NON-managed grants only.
    const managedRoot = join(cwd, 'fake-managed-implicit');
    mkdirSync(managedRoot, { recursive: true });
    writeFileSync(join(managedRoot, 'managed-settings.json'), JSON.stringify({
      permissions: {
        defaultMode: 'bypassPermissions',
        allowManagedPermissionRulesOnly: true,
      },
    }));
    const level = detectClaudePermissionLevel({
      cwd,
      home: '/nonexistent',
      managedRootOverride: managedRoot,
      skipRuntime: true, // isolate the managed-defaultMode signal
    });
    assert.equal(level, 'full-auto',
      'managed-scope bypassPermissions still grants implicit broad even with managed-only flag');
  });

  it('multi-scope merge: user-level deny overrides project-level allow under runtime promotion', () => {
    // Project allows broad Bash, user-level (lower precedence but merged)
    // deny adds a scoped restriction. Even with runtime bypassPermissions,
    // the deny union must invalidate the broad bash grant.
    writeSettings(cwd, 'project', {
      permissions: { allow: ['Bash(*)', 'Write(*)'] },
    });
    // Use a tmp HOME to write user-scope settings
    const fakeHome = join(cwd, 'fake-home');
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    writeFileSync(join(fakeHome, '.claude', 'settings.json'), JSON.stringify({
      permissions: { deny: ['Bash(curl:*)'] },
    }));
    captureRuntimePermissions({ permissionMode: 'bypassPermissions' }, { cwd });
    const level = detectClaudePermissionLevel({
      cwd,
      home: fakeHome,
    });
    // Bash deny union → no broad bash → max tier auto-edit. Runtime promotion
    // doesn't bypass the union.
    assert.equal(level, 'auto-edit',
      'cross-scope deny union clamps runtime promotion');
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

  it('reports tie (settings wins) when literal allow grants stay broad regardless of runtime mode', () => {
    // Literal Bash(*)+Write(*) allow grants don't go away when runtime
    // flips to 'default'. Both layers therefore compute full-auto, and
    // settings wins the tie. This documents the desirable behavior:
    // explicit allow lists are persistent and unaffected by mode flips.
    writeSettings(cwd, 'projectLocal', {
      permissions: { allow: ['Bash(*)', 'Write(*)'] },
    });
    captureRuntimePermissions({ permissionMode: 'default' }, { cwd });
    const r = explainPermissionLevel({ cwd, home: '/nonexistent' });
    assert.equal(r.finalLevel, 'full-auto');
    assert.equal(r.chosenSource, 'settings');
    assert.match(r.chosenSourceReason, /matches settings tier full-auto/);
  });

  it('reports upgrade-only policy when runtime IS strictly lower than settings (implicit-only path)', () => {
    // Settings has only implicit broad via defaultMode=bypassPermissions
    // (no literal allow). Runtime flips to 'default' → bypassActive=false →
    // no implicit broad → runtimeLevel='suggest'. Strict downgrade.
    writeSettings(cwd, 'projectLocal', {
      permissions: { defaultMode: 'bypassPermissions' },
    });
    captureRuntimePermissions({ permissionMode: 'default' }, { cwd });
    const r = explainPermissionLevel({ cwd, home: '/nonexistent' });
    assert.equal(r.settingsLevel, 'full-auto', 'settings sees full-auto via implicit broad');
    assert.equal(r.runtime?.level, 'suggest', 'runtime default has no implicit broad');
    assert.equal(r.finalLevel, 'full-auto', 'upgrade-only policy keeps settings tier');
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
