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
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  extractPermissionModeFromStdin,
  extractPermissionModeFromEnv,
  captureRuntimePermissions,
  loadRuntimePermissions,
  loadRuntimeCurrentSessionId,
  loadRuntimeSessionIdentity,
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
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, '.ao', 'state'), { recursive: true, mode: 0o700 });
  return dir;
}

const TEST_SESSION_ID = 'runtime-permission-test-session';

function runtimeHomeFor(cwd) {
  return `${cwd}-runtime-home`;
}

function runtimeOpts(cwd, extra = {}) {
  return {
    cwd,
    runtimeHome: runtimeHomeFor(cwd),
    stateBase: join(cwd, '.ao', 'state'),
    ...extra,
  };
}

function setCurrentSession(cwd, sessionId = TEST_SESSION_ID) {
  writeFileSync(
    join(cwd, '.ao', 'state', 'ao-current-session.json'),
    JSON.stringify({ sessionId }),
    { mode: 0o600 },
  );
}

function captureBound(cwd, permissionMode, record = {}, opts = {}) {
  const sessionId = record.sessionId || TEST_SESSION_ID;
  setCurrentSession(cwd, sessionId);
  mkdirSync(runtimeHomeFor(cwd), { recursive: true, mode: 0o700 });
  return captureRuntimePermissions({
    permissionMode,
    permissionModeObserved: record.permissionModeObserved ?? permissionMode !== null,
    source: 'hook_stdin',
    sessionId,
    ...record,
  }, runtimeOpts(cwd, opts));
}

function loadBound(cwd, opts = {}) {
  const identity = loadRuntimeSessionIdentity({ cwd });
  if (!identity) return null;
  return loadRuntimePermissions(runtimeOpts(cwd, {
    expectedSessionId: identity.sessionId,
    expectedCaptureId: identity.captureId,
    ...opts,
  }));
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
  try { rmSync(runtimeHomeFor(cwd), { recursive: true, force: true }); } catch {}
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

  it('accepts current auto and dontAsk hook permission modes', () => {
    assert.equal(extractPermissionModeFromStdin({ permission_mode: 'auto' }).mode, 'auto');
    assert.equal(extractPermissionModeFromStdin({ permission_mode: 'dontAsk' }).mode, 'dontAsk');
  });

  it('drops unknown mode values', () => {
    const r = extractPermissionModeFromStdin({ permission_mode: 'godMode' });
    assert.equal(r.mode, null);
    assert.equal(r.modeObserved, true);
  });

  it('drops non-string mode values', () => {
    const r = extractPermissionModeFromStdin({ permission_mode: 42 });
    assert.equal(r.mode, null);
  });

  it('returns empty record for null/undefined input', () => {
    assert.equal(extractPermissionModeFromStdin(null).mode, null);
    assert.equal(extractPermissionModeFromStdin(undefined).mode, null);
    assert.deepEqual(extractPermissionModeFromStdin(null).observedKeys, []);
    assert.equal(extractPermissionModeFromStdin(null).modeObserved, false);
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

  it('splits local identity from the external authoritative grant', () => {
    const ok = captureBound(cwd, 'bypassPermissions', {
      rawStdinKeys: ['session_id', 'cwd', 'permission_mode'],
    }, { now: new Date('2026-05-08T12:00:00Z') });
    assert.equal(ok, true);

    const identityRaw = JSON.parse(readFileSync(join(cwd, _internal.CACHE_REL_PATH), 'utf8'));
    assert.equal(identityRaw.kind, _internal.IDENTITY_KIND);
    assert.equal(identityRaw.sessionId, TEST_SESSION_ID);
    assert.equal(identityRaw.permissionObservation, 'recognized');
    assert.equal('permissionMode' in identityRaw, false, 'workspace state is not a grant');

    const rec = loadBound(cwd, { now: new Date('2026-05-08T12:05:00Z') });
    assert.ok(rec, 'expected record');
    assert.equal(rec.permissionMode, 'bypassPermissions');
    assert.equal(rec.source, 'hook_stdin');
    assert.equal(rec.sessionId, TEST_SESSION_ID);
    assert.equal(rec.ageMs, 5 * 60 * 1000);

    const grantPath = _internal.runtimeGrantPaths(runtimeOpts(cwd)).file;
    assert.equal(statSync(dirname(grantPath)).mode & 0o777, 0o700);
    assert.equal(statSync(grantPath).mode & 0o777, 0o600);
  });

  it('requires a hook session identity and refuses env-only grants', () => {
    mkdirSync(runtimeHomeFor(cwd), { recursive: true, mode: 0o700 });
    assert.equal(captureRuntimePermissions({
      permissionMode: 'bypassPermissions',
      source: 'hook_stdin',
    }, runtimeOpts(cwd)), false);
    assert.equal(captureRuntimePermissions({
      permissionMode: 'bypassPermissions',
      source: 'env',
      sessionId: TEST_SESSION_ID,
    }, runtimeOpts(cwd)), false);
    assert.equal(loadRuntimeSessionIdentity({ cwd }), null);

    assert.equal(captureRuntimePermissions({
      permissionMode: 'bypassPermissions',
      permissionModeObserved: true,
      source: 'hook_stdin',
      permissionSource: 'env',
      sessionId: TEST_SESSION_ID,
    }, runtimeOpts(cwd)), true);
    assert.equal(loadRuntimeSessionIdentity({ cwd }).permissionObservation, 'absent');
    assert.equal(loadBound(cwd), null);
  });

  it('persists identity but writes a non-authorizing tombstone for an unknown mode', () => {
    const ok = captureBound(cwd, 'futureMode', {
      permissionModeObserved: true,
      sessionId: 'session-forward-compatible',
    });
    assert.equal(ok, true);
    const identity = loadRuntimeSessionIdentity({ cwd });
    assert.equal(identity.sessionId, 'session-forward-compatible');
    assert.equal(identity.permissionObservation, 'unknown');
    assert.equal(loadBound(cwd), null);
  });

  it('same-session identity refresh preserves a hardened grant without extending TTL', () => {
    captureBound(cwd, 'acceptEdits', {
      sessionId: 'same-session',
    }, { now: new Date('2026-05-08T12:00:00Z') });
    captureRuntimePermissions({
      permissionMode: null,
      permissionModeObserved: false,
      source: 'hook_stdin',
      sessionId: 'same-session',
    }, runtimeOpts(cwd, { now: new Date('2026-05-08T12:20:00Z') }));

    const identity = loadRuntimeSessionIdentity({ cwd });
    assert.equal(identity.permissionObservedAt, '2026-05-08T12:00:00.000Z');
    assert.equal(identity.capturedAt, '2026-05-08T12:20:00.000Z');
    assert.equal(loadRuntimePermissions(runtimeOpts(cwd, {
      expectedSessionId: 'same-session',
      expectedCaptureId: identity.captureId,
      now: new Date('2026-05-08T12:29:00Z'),
    })).permissionMode, 'acceptEdits');
    assert.equal(loadRuntimePermissions(runtimeOpts(cwd, {
      expectedSessionId: 'same-session',
      expectedCaptureId: identity.captureId,
      now: new Date('2026-05-08T12:31:00Z'),
    })), null);
  });

  it('new-session identity-only capture tombstones an old grant against replay', () => {
    captureBound(cwd, 'bypassPermissions', {
      sessionId: 'old-session',
    });
    const oldIdentityText = readFileSync(join(cwd, _internal.CACHE_REL_PATH), 'utf8');
    const oldIdentity = JSON.parse(oldIdentityText);

    setCurrentSession(cwd, 'new-session');
    captureRuntimePermissions({
      permissionMode: null,
      permissionModeObserved: false,
      source: 'hook_stdin',
      sessionId: 'new-session',
    }, runtimeOpts(cwd));

    assert.equal(loadRuntimePermissions(runtimeOpts(cwd, {
      expectedSessionId: 'old-session',
      expectedCaptureId: oldIdentity.captureId,
    })), null, 'external old-session grant was replaced');

    // Even restoring both workspace-controlled records cannot revive it.
    writeFileSync(join(cwd, _internal.CACHE_REL_PATH), oldIdentityText, { mode: 0o600 });
    setCurrentSession(cwd, 'old-session');
    assert.equal(detectClaudePermissionLevel(runtimeOpts(cwd, { home: '/nonexistent' })), 'suggest');
  });

  it('explicitly unknown same-session mode revokes a prior grant', () => {
    captureBound(cwd, 'acceptEdits');
    captureRuntimePermissions({
      permissionMode: 'futureMode',
      permissionModeObserved: true,
      source: 'hook_stdin',
      sessionId: TEST_SESSION_ID,
    }, runtimeOpts(cwd));
    assert.equal(loadBound(cwd), null);
    assert.equal(loadRuntimeSessionIdentity({ cwd }).permissionObservation, 'unknown');
  });

  it('rejects invalid source (write returns false)', () => {
    const ok = captureRuntimePermissions({
      permissionMode: 'default',
      source: 'fabrication',
    }, { cwd });
    assert.equal(ok, false);
  });

  it('requires explicit session and capture bindings on direct loads', () => {
    captureBound(cwd, 'bypassPermissions');
    assert.equal(loadRuntimePermissions(runtimeOpts(cwd)), null);
    const identity = loadRuntimeSessionIdentity({ cwd });
    assert.equal(loadRuntimePermissions(runtimeOpts(cwd, {
      expectedSessionId: 'forged-other-session',
      expectedCaptureId: identity.captureId,
    })), null);
  });

  it('returns null past TTL', () => {
    captureBound(cwd, 'default', {}, {
      now: new Date('2026-05-08T12:00:00Z'),
    });
    assert.equal(loadBound(cwd, { now: new Date('2026-05-08T12:31:00Z') }), null);
  });

  it('rejects future-dated permission grants instead of bypassing the TTL', () => {
    captureBound(cwd, 'bypassPermissions', {}, {
      now: new Date('2026-05-08T12:30:00Z'),
    });
    assert.equal(loadBound(cwd, { now: new Date('2026-05-08T12:00:00Z') }), null);
  });

  it('rejects an invalid current clock value', () => {
    captureBound(cwd, 'bypassPermissions', {}, {
      now: new Date('2026-05-08T12:00:00Z'),
    });
    assert.equal(loadBound(cwd, { now: new Date('invalid') }), null);
  });

  it('retains hook session identity after permission TTL without granting a permission level', () => {
    captureBound(cwd, 'default', {
      sessionId: 'session-long-running-team',
    }, {
      now: new Date('2026-05-08T12:00:00Z'),
    });
    const identity = loadRuntimeSessionIdentity({ cwd });
    assert.equal(loadRuntimePermissions(runtimeOpts(cwd, {
      expectedSessionId: identity.sessionId,
      expectedCaptureId: identity.captureId,
      now: new Date('2026-05-08T14:00:00Z'),
    })), null);
    assert.equal(identity.sessionId, 'session-long-running-team');
    assert.equal(identity.capturedAt, '2026-05-08T12:00:00.000Z');
  });

  it('honors a custom TTL override', () => {
    captureBound(cwd, 'default', {}, {
      now: new Date('2026-05-08T12:00:00Z'),
    });
    const fresh = loadBound(cwd, {
      now: new Date('2026-05-08T12:00:00.100Z'),
      ttlMs: 1000,
    });
    assert.ok(fresh);
    const stale = loadBound(cwd, {
      now: new Date('2026-05-08T12:00:02Z'),
      ttlMs: 1000,
    });
    assert.equal(stale, null);
  });

  it('never migrates a legacy project-local mode into an authoritative grant', () => {
    const f = join(cwd, '.ao', 'state', 'ao-runtime-permissions.json');
    writeFileSync(f, JSON.stringify({
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      permissionMode: 'bypassPermissions',
      source: 'hook_stdin',
      sessionId: TEST_SESSION_ID,
    }), { mode: 0o600 });
    setCurrentSession(cwd);
    assert.equal(loadRuntimeSessionIdentity({ cwd }), null);
    assert.equal(detectClaudePermissionLevel(runtimeOpts(cwd, { home: '/nonexistent' })), 'suggest');
  });

  it('rejects symlink, hardlink, and 0644 external grant files', () => {
    captureBound(cwd, 'bypassPermissions');
    const identity = loadRuntimeSessionIdentity({ cwd });
    const grant = _internal.runtimeGrantPaths(runtimeOpts(cwd)).file;
    const original = readFileSync(grant, 'utf8');

    chmodSync(grant, 0o644);
    assert.equal(loadBound(cwd), null, '0644 rejected');
    chmodSync(grant, 0o600);

    const hardlink = `${grant}.hardlink`;
    linkSync(grant, hardlink);
    assert.equal(loadBound(cwd), null, 'multi-link file rejected');
    rmSync(hardlink);

    rmSync(grant);
    const target = `${grant}.target`;
    writeFileSync(target, original, { mode: 0o600 });
    symlinkSync(target, grant);
    assert.equal(loadRuntimePermissions(runtimeOpts(cwd, {
      expectedSessionId: identity.sessionId,
      expectedCaptureId: identity.captureId,
    })), null, 'symlink rejected');
  });

  it('rejects replacement after a hardened grant read', () => {
    captureBound(cwd, 'bypassPermissions');
    const identity = loadRuntimeSessionIdentity({ cwd });
    const grant = _internal.runtimeGrantPaths(runtimeOpts(cwd)).file;
    const replacement = `${grant}.replacement`;
    writeFileSync(replacement, readFileSync(grant), { mode: 0o600 });
    assert.equal(loadRuntimePermissions(runtimeOpts(cwd, {
      expectedSessionId: identity.sessionId,
      expectedCaptureId: identity.captureId,
      _beforeGrantRevalidate: () => renameSync(replacement, grant),
    })), null);
  });

  it('rejects unsafe local identity modes and oversized grants', () => {
    captureBound(cwd, 'bypassPermissions');
    const identityFile = join(cwd, _internal.CACHE_REL_PATH);
    chmodSync(identityFile, 0o644);
    assert.equal(loadRuntimeSessionIdentity({ cwd }), null);
    assert.equal(detectClaudePermissionLevel(runtimeOpts(cwd, { home: '/nonexistent' })), 'suggest');

    chmodSync(identityFile, 0o600);
    const grant = _internal.runtimeGrantPaths(runtimeOpts(cwd)).file;
    writeFileSync(grant, 'x'.repeat(_internal.MAX_CACHE_BYTES + 1), { mode: 0o600 });
    assert.equal(loadBound(cwd), null);
  });

  it('hardens the current-session pointer against mode, links, size, and replacement', () => {
    captureBound(cwd, 'bypassPermissions');
    const pointer = join(cwd, '.ao', 'state', 'ao-current-session.json');
    const original = readFileSync(pointer);

    chmodSync(pointer, 0o644);
    assert.equal(loadRuntimeCurrentSessionId(runtimeOpts(cwd)), null, '0644 pointer rejected');
    chmodSync(pointer, 0o600);

    const hardlink = `${pointer}.hardlink`;
    linkSync(pointer, hardlink);
    assert.equal(loadRuntimeCurrentSessionId(runtimeOpts(cwd)), null, 'multi-link pointer rejected');
    rmSync(hardlink);

    writeFileSync(pointer, 'x'.repeat(_internal.MAX_POINTER_BYTES + 1), { mode: 0o600 });
    assert.equal(loadRuntimeCurrentSessionId(runtimeOpts(cwd)), null, 'oversized pointer rejected');
    writeFileSync(pointer, original, { mode: 0o600 });

    const replacement = `${pointer}.replacement`;
    writeFileSync(replacement, original, { mode: 0o600 });
    assert.equal(loadRuntimeCurrentSessionId(runtimeOpts(cwd, {
      _beforePointerRevalidate: () => renameSync(replacement, pointer),
    })), null, 'pointer replacement rejected');

    rmSync(pointer);
    const target = `${pointer}.target`;
    writeFileSync(target, original, { mode: 0o600 });
    symlinkSync(target, pointer);
    assert.equal(loadRuntimeCurrentSessionId(runtimeOpts(cwd)), null, 'pointer symlink rejected');
  });

  it('rejects local identity hardlinks and symlinks', () => {
    captureBound(cwd, 'bypassPermissions');
    const identity = join(cwd, _internal.CACHE_REL_PATH);
    const original = readFileSync(identity);
    const hardlink = `${identity}.hardlink`;
    linkSync(identity, hardlink);
    assert.equal(loadRuntimeSessionIdentity({ cwd }), null);
    rmSync(hardlink);

    rmSync(identity);
    const target = `${identity}.target`;
    writeFileSync(target, original, { mode: 0o600 });
    symlinkSync(target, identity);
    assert.equal(loadRuntimeSessionIdentity({ cwd }), null);
  });

  it('fails closed when the external cache would overlap the workspace', () => {
    const ok = captureRuntimePermissions({
      permissionMode: 'bypassPermissions',
      permissionModeObserved: true,
      source: 'hook_stdin',
      sessionId: TEST_SESSION_ID,
    }, { cwd, runtimeHome: cwd });
    assert.equal(ok, false);
    assert.equal(detectClaudePermissionLevel({
      cwd,
      home: '/nonexistent',
      runtimeHome: cwd,
      stateBase: join(cwd, '.ao', 'state'),
    }), 'suggest');
  });

  it('rejects group/other-writable external cache ancestry', () => {
    captureBound(cwd, 'bypassPermissions');
    const cacheParent = join(runtimeHomeFor(cwd), '.cache');
    chmodSync(cacheParent, 0o722);
    assert.equal(loadBound(cwd), null);
    assert.equal(detectClaudePermissionLevel(runtimeOpts(cwd, { home: '/nonexistent' })), 'suggest');
  });

  it('rejects a grant copied from another canonical project', () => {
    const other = makeTmpCwd();
    try {
      captureBound(cwd, 'bypassPermissions');
      captureBound(other, 'acceptEdits');
      const otherIdentity = loadRuntimeSessionIdentity({ cwd: other });
      const sourceGrant = _internal.runtimeGrantPaths(runtimeOpts(cwd)).file;
      const otherGrant = _internal.runtimeGrantPaths(runtimeOpts(other)).file;
      writeFileSync(otherGrant, readFileSync(sourceGrant), { mode: 0o600 });
      assert.equal(loadRuntimePermissions(runtimeOpts(other, {
        expectedSessionId: otherIdentity.sessionId,
        expectedCaptureId: otherIdentity.captureId,
      })), null);
    } finally {
      cleanup(other);
    }
  });

  it('requires hook_stdin as the exact external grant source', () => {
    captureBound(cwd, 'bypassPermissions');
    const grant = _internal.runtimeGrantPaths(runtimeOpts(cwd)).file;
    const forged = JSON.parse(readFileSync(grant, 'utf8'));
    forged.permissionSource = 'manual';
    writeFileSync(grant, JSON.stringify(forged), { mode: 0o600 });
    assert.equal(loadBound(cwd), null);
  });

  it('resolves the production current-session pointer from a worktree common root', () => {
    const worktree = `${cwd}-worktree`;
    try {
      execFileSync('git', ['init', '-q'], { cwd });
      execFileSync('git', ['config', 'user.email', 'runtime-test@example.invalid'], { cwd });
      execFileSync('git', ['config', 'user.name', 'Runtime Test'], { cwd });
      writeFileSync(join(cwd, 'seed.txt'), 'seed\n');
      execFileSync('git', ['add', 'seed.txt'], { cwd });
      execFileSync('git', ['commit', '-qm', 'seed'], { cwd });
      execFileSync('git', ['worktree', 'add', '-qb', 'runtime-pointer-test', worktree], { cwd });

      mkdirSync(runtimeHomeFor(worktree), { recursive: true, mode: 0o700 });
      assert.equal(captureRuntimePermissions({
        permissionMode: 'bypassPermissions',
        permissionModeObserved: true,
        source: 'hook_stdin',
        sessionId: TEST_SESSION_ID,
      }, { cwd: worktree, runtimeHome: runtimeHomeFor(worktree) }), true);
      setCurrentSession(cwd, TEST_SESSION_ID);

      assert.equal(detectClaudePermissionLevel({
        cwd: worktree,
        home: '/nonexistent',
        runtimeHome: runtimeHomeFor(worktree),
      }), 'full-auto');
    } finally {
      rmSync(worktree, { recursive: true, force: true });
      rmSync(runtimeHomeFor(worktree), { recursive: true, force: true });
    }
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
    assert.equal(permissionModeToLevel('auto'), 'suggest');
    assert.equal(permissionModeToLevel('dontAsk'), 'suggest');
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
    captureBound(cwd, 'bypassPermissions');
    const level = detectClaudePermissionLevel(runtimeOpts(cwd, { home: '/nonexistent' }));
    assert.equal(level, 'full-auto');
  });

  it('runtime acceptEdits promotes empty settings (suggest → auto-edit)', () => {
    captureBound(cwd, 'acceptEdits');
    const level = detectClaudePermissionLevel(runtimeOpts(cwd, { home: '/nonexistent' }));
    assert.equal(level, 'auto-edit');
  });

  it('runtime default does NOT promote (suggest → suggest, no-op)', () => {
    captureBound(cwd, 'default');
    const level = detectClaudePermissionLevel(runtimeOpts(cwd, { home: '/nonexistent' }));
    assert.equal(level, 'suggest');
  });

  it('runtime plan does NOT promote (suggest → suggest)', () => {
    captureBound(cwd, 'plan');
    const level = detectClaudePermissionLevel(runtimeOpts(cwd, { home: '/nonexistent' }));
    assert.equal(level, 'suggest');
  });

  it('runtime cannot DOWNGRADE settings (settings full-auto stays)', () => {
    writeSettings(cwd, 'projectLocal', {
      permissions: { allow: ['Bash(*)', 'Write(*)'] },
    });
    captureBound(cwd, 'default');
    const level = detectClaudePermissionLevel(runtimeOpts(cwd, { home: '/nonexistent' }));
    assert.equal(level, 'full-auto');
  });

  it('skipRuntime opts out of override (returns settings tier)', () => {
    captureBound(cwd, 'bypassPermissions');
    const level = detectClaudePermissionLevel({
      ...runtimeOpts(cwd),
      home: '/nonexistent',
      skipRuntime: true,
    });
    assert.equal(level, 'suggest');
  });

  it('expired runtime cache does not promote', () => {
    captureBound(cwd, 'bypassPermissions', {}, {
      now: new Date(Date.now() - 60 * 60 * 1000), // 1h ago, past 30min TTL
    });
    const level = detectClaudePermissionLevel(runtimeOpts(cwd, { home: '/nonexistent' }));
    assert.equal(level, 'suggest');
  });

  it('detectClaudePermissionLevelFromSettings is the pre-runtime baseline', () => {
    writeSettings(cwd, 'projectLocal', {
      permissions: { allow: ['Write(*)'] },
    });
    captureBound(cwd, 'bypassPermissions');
    assert.equal(
      detectClaudePermissionLevelFromSettings({ cwd, home: '/nonexistent' }),
      'auto-edit',
    );
    // Final level promotes via runtime
    assert.equal(
      detectClaudePermissionLevel(runtimeOpts(cwd, { home: '/nonexistent' })),
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
    captureBound(cwd, 'bypassPermissions');
    // Without the fix this would have promoted to full-auto despite the
    // deny — Codex flagged it as a security regression.
    assert.equal(
      detectClaudePermissionLevel(runtimeOpts(cwd, { home: '/nonexistent' })),
      'auto-edit',
      'broad Bash deny clamps runtime bypassPermissions',
    );
  });

  it('runtime bypassPermissions is clamped by scoped Bash deny (still no broad bash)', () => {
    writeSettings(cwd, 'projectLocal', {
      permissions: { deny: ['Bash(curl:*)'] },
    });
    captureBound(cwd, 'bypassPermissions');
    // Scoped deny invalidates the broad bash grant under coarse codex sandbox.
    assert.equal(
      detectClaudePermissionLevel(runtimeOpts(cwd, { home: '/nonexistent' })),
      'auto-edit',
      'scoped Bash deny clamps runtime bypassPermissions to auto-edit',
    );
  });

  it('runtime bypassPermissions implicit grant is dropped by disableBypassPermissionsMode (collapses to suggest, not acceptEdits)', () => {
    writeSettings(cwd, 'projectLocal', {
      permissions: { disableBypassPermissionsMode: true },
    });
    captureBound(cwd, 'bypassPermissions');
    // bypassDisabled → bypassActive=false → implicit broad DROPPED entirely.
    // The runtime tier does NOT silently fall through to acceptEdits — it
    // collapses to suggest unless an explicit allow list compensates.
    assert.equal(
      detectClaudePermissionLevel(runtimeOpts(cwd, { home: '/nonexistent' })),
      'suggest',
      'disableBypassPermissionsMode drops the implicit grant; no acceptEdits fallback',
    );
  });

  it('runtime acceptEdits respects deny: Write(*) (no broad write → suggest)', () => {
    writeSettings(cwd, 'projectLocal', {
      permissions: { deny: ['Write(*)', 'Edit(*)'] },
    });
    captureBound(cwd, 'acceptEdits');
    assert.equal(
      detectClaudePermissionLevel(runtimeOpts(cwd, { home: '/nonexistent' })),
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
    captureBound(cwd, 'bypassPermissions');
    const level = detectClaudePermissionLevel({
      ...runtimeOpts(cwd),
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
    captureBound(cwd, 'bypassPermissions');
    const level = detectClaudePermissionLevel({
      ...runtimeOpts(cwd),
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
    captureBound(cwd, 'bypassPermissions');
    const r = explainPermissionLevel(runtimeOpts(cwd, { home: '/nonexistent' }));
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
    captureBound(cwd, 'bypassPermissions');
    const r = explainPermissionLevel(runtimeOpts(cwd, { home: '/nonexistent' }));
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
    captureBound(cwd, 'default');
    const r = explainPermissionLevel(runtimeOpts(cwd, { home: '/nonexistent' }));
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
    captureBound(cwd, 'default');
    const r = explainPermissionLevel(runtimeOpts(cwd, { home: '/nonexistent' }));
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
