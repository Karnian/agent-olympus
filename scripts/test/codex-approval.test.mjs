/**
 * Unit tests for scripts/lib/codex-approval.mjs
 *
 * Tests detectClaudePermissionLevel(), resolveCodexApproval(), and the
 * sandbox-axis helpers (codexSandboxForLevel, buildCodexExecArgs,
 * buildCodexAppServerParams, shouldDemoteCodexWorker).
 * Uses temporary settings files to simulate different Claude permission configurations.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  detectClaudePermissionLevel,
  resolveCodexApproval,
  codexSandboxForLevel,
  buildCodexExecArgs,
  buildCodexAppServerParams,
  shouldDemoteCodexWorker,
  effectiveCodexLevel,
  buildHostSandboxWarning,
} from '../lib/codex-approval.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  const dir = join(tmpdir(), `ao-codex-approval-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSettings(dir, relPath, data) {
  const fullDir = join(dir, ...relPath.split('/').slice(0, -1));
  mkdirSync(fullDir, { recursive: true });
  writeFileSync(join(dir, relPath), JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// codexSandboxForLevel — level → sandbox enum mapping
// ---------------------------------------------------------------------------

describe('codexSandboxForLevel', () => {
  it('maps full-auto → danger-full-access', () => {
    assert.equal(codexSandboxForLevel('full-auto'), 'danger-full-access');
  });

  it('maps auto-edit → workspace-write', () => {
    assert.equal(codexSandboxForLevel('auto-edit'), 'workspace-write');
  });

  it('maps suggest → read-only', () => {
    assert.equal(codexSandboxForLevel('suggest'), 'read-only');
  });

  it('falls back to read-only for unknown level', () => {
    assert.equal(codexSandboxForLevel('unknown'), 'read-only');
  });

  it('falls back to read-only for undefined', () => {
    assert.equal(codexSandboxForLevel(undefined), 'read-only');
  });
});

// ---------------------------------------------------------------------------
// buildCodexExecArgs — global CLI flags (must come BEFORE `exec` subcommand)
// ---------------------------------------------------------------------------

describe('buildCodexExecArgs', () => {
  it('full-auto → -a never -s danger-full-access', () => {
    assert.deepEqual(
      buildCodexExecArgs('full-auto'),
      ['-a', 'never', '-s', 'danger-full-access'],
    );
  });

  it('auto-edit → -a never -s workspace-write', () => {
    assert.deepEqual(
      buildCodexExecArgs('auto-edit'),
      ['-a', 'never', '-s', 'workspace-write'],
    );
  });

  it('suggest → -a never -s read-only (last-resort safety only)', () => {
    assert.deepEqual(
      buildCodexExecArgs('suggest'),
      ['-a', 'never', '-s', 'read-only'],
    );
  });

  it('always returns approval flag "never" regardless of level', () => {
    for (const level of ['full-auto', 'auto-edit', 'suggest', 'unknown']) {
      const args = buildCodexExecArgs(level);
      assert.equal(args[0], '-a');
      assert.equal(args[1], 'never');
    }
  });

  it('returns a 4-element array (no extra positional args)', () => {
    assert.equal(buildCodexExecArgs('full-auto').length, 4);
  });
});

// ---------------------------------------------------------------------------
// buildCodexAppServerParams — JSON-RPC thread/start params shape
// ---------------------------------------------------------------------------

describe('buildCodexAppServerParams', () => {
  it('full-auto → { approvalPolicy: never, sandbox: danger-full-access }', () => {
    assert.deepEqual(
      buildCodexAppServerParams('full-auto'),
      { approvalPolicy: 'never', sandbox: 'danger-full-access' },
    );
  });

  it('auto-edit → { approvalPolicy: never, sandbox: workspace-write }', () => {
    assert.deepEqual(
      buildCodexAppServerParams('auto-edit'),
      { approvalPolicy: 'never', sandbox: 'workspace-write' },
    );
  });

  it('suggest → { approvalPolicy: never, sandbox: read-only }', () => {
    assert.deepEqual(
      buildCodexAppServerParams('suggest'),
      { approvalPolicy: 'never', sandbox: 'read-only' },
    );
  });

  it('always sets approvalPolicy to never', () => {
    for (const level of ['full-auto', 'auto-edit', 'suggest', 'unknown']) {
      assert.equal(buildCodexAppServerParams(level).approvalPolicy, 'never');
    }
  });
});

// ---------------------------------------------------------------------------
// shouldDemoteCodexWorker — host permission too low for non-interactive codex
// ---------------------------------------------------------------------------

describe('shouldDemoteCodexWorker', () => {
  it('returns true for suggest', () => {
    assert.equal(shouldDemoteCodexWorker('suggest'), true);
  });

  it('returns false for auto-edit', () => {
    assert.equal(shouldDemoteCodexWorker('auto-edit'), false);
  });

  it('returns false for full-auto', () => {
    assert.equal(shouldDemoteCodexWorker('full-auto'), false);
  });

  it('returns false for unknown level (caller treats as non-suggest)', () => {
    assert.equal(shouldDemoteCodexWorker('unknown'), false);
  });
});

// ---------------------------------------------------------------------------
// detectClaudePermissionLevel — project-level settings
// ---------------------------------------------------------------------------

describe('detectClaudePermissionLevel: project-level settings', () => {
  let tmpDir;

  before(() => {
    tmpDir = makeTmpDir();
  });
  after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns full-auto when Bash(*) + Write(*) in project settings', () => {
    writeSettings(tmpDir, '.claude/settings.local.json', {
      permissions: { allow: ['Bash(*)', 'Read(*)', 'Write(*)', 'Edit(*)'] },
    });
    const result = detectClaudePermissionLevel({ cwd: tmpDir, home: '/nonexistent' });
    assert.equal(result, 'full-auto');
  });

  it('returns full-auto when bare Bash (without glob) + Write(*)', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['Bash', 'Write(*)'] },
    });
    const result = detectClaudePermissionLevel({ cwd: dir, home: '/nonexistent' });
    assert.equal(result, 'full-auto');
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns auto-edit when Write(*) but no Bash(*)', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['Read(*)', 'Write(*)', 'Edit(*)'] },
    });
    const result = detectClaudePermissionLevel({ cwd: dir, home: '/nonexistent' });
    assert.equal(result, 'auto-edit');
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns auto-edit when Edit(*) only', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['Read(*)', 'Edit(*)'] },
    });
    const result = detectClaudePermissionLevel({ cwd: dir, home: '/nonexistent' });
    assert.equal(result, 'auto-edit');
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns suggest when only Read(*)', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['Read(*)', 'Glob(*)'] },
    });
    const result = detectClaudePermissionLevel({ cwd: dir, home: '/nonexistent' });
    assert.equal(result, 'suggest');
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// detectClaudePermissionLevel — defaultMode + expanded patterns
// (NEW: plugin-user realism fix)
// ---------------------------------------------------------------------------

describe('detectClaudePermissionLevel: defaultMode recognition', () => {
  it('bypassPermissions defaultMode → full-auto (no allow list needed)', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { defaultMode: 'bypassPermissions' },
    });
    const result = detectClaudePermissionLevel({ cwd: dir, home: '/nonexistent' });
    assert.equal(result, 'full-auto');
    rmSync(dir, { recursive: true, force: true });
  });

  it('acceptEdits defaultMode → auto-edit (Write/Edit granted, no Bash)', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { defaultMode: 'acceptEdits' },
    });
    const result = detectClaudePermissionLevel({ cwd: dir, home: '/nonexistent' });
    assert.equal(result, 'auto-edit');
    rmSync(dir, { recursive: true, force: true });
  });

  it('plan defaultMode → suggest (no implicit grants)', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { defaultMode: 'plan' },
    });
    const result = detectClaudePermissionLevel({ cwd: dir, home: '/nonexistent' });
    assert.equal(result, 'suggest');
    rmSync(dir, { recursive: true, force: true });
  });

  it('unknown defaultMode → suggest (safe default)', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { defaultMode: 'dontAsk' },
    });
    const result = detectClaudePermissionLevel({ cwd: dir, home: '/nonexistent' });
    assert.equal(result, 'suggest');
    rmSync(dir, { recursive: true, force: true });
  });

  it('acceptEdits + Bash(*) allow → full-auto (union)', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { defaultMode: 'acceptEdits', allow: ['Bash(*)'] },
    });
    const result = detectClaudePermissionLevel({ cwd: dir, home: '/nonexistent' });
    assert.equal(result, 'full-auto');
    rmSync(dir, { recursive: true, force: true });
  });

  it('bypassPermissions + deny Bash(*) → auto-edit (deny wins for bash)', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { defaultMode: 'bypassPermissions', deny: ['Bash(*)'] },
    });
    const result = detectClaudePermissionLevel({ cwd: dir, home: '/nonexistent' });
    assert.equal(result, 'auto-edit');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('detectClaudePermissionLevel: broad/scoped split (Plan A)', () => {
  it('scoped Bash(git:*) + Write(*) → auto-edit (scoped bash does NOT promote)', () => {
    // Plan A: codex danger-full-access would bypass the user's scoped Bash
    // restriction. Map to workspace-write instead.
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['Bash(git:*)', 'Write(*)'] },
    });
    const result = detectClaudePermissionLevel({
      cwd: dir, home: '/nonexistent', managedRootOverride: '/nonexistent/managed',
    });
    assert.equal(result, 'auto-edit');
    rmSync(dir, { recursive: true, force: true });
  });

  it('Bash(*:*) wildcard variant → auto-edit (not broad per Claude matcher)', () => {
    // `:*` is a trailing-wildcard suffix in Claude's matcher, not "match all".
    // Only literal `Bash` or `Bash(*)` count as broad.
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['Bash(*:*)', 'Write(*)'] },
    });
    const result = detectClaudePermissionLevel({
      cwd: dir, home: '/nonexistent', managedRootOverride: '/nonexistent/managed',
    });
    assert.equal(result, 'auto-edit');
    rmSync(dir, { recursive: true, force: true });
  });

  it('Bash(**) wildcard variant → auto-edit', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['Bash(**)', 'Write(*)'] },
    });
    const result = detectClaudePermissionLevel({
      cwd: dir, home: '/nonexistent', managedRootOverride: '/nonexistent/managed',
    });
    assert.equal(result, 'auto-edit');
    rmSync(dir, { recursive: true, force: true });
  });

  it('scoped Write(src/**) alone → suggest (scoped cannot promote — codex workspace-write would widen beyond src/**)', () => {
    // Security fix (Plan A v2, post-Codex cross-review 2026-04-14):
    // Scoped grants alone MUST NOT promote. codex's workspace-write sandbox
    // writes anywhere under cwd, not just the user's scoped path — mirroring
    // `Write(src/**)` to auto-edit is privilege expansion.
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['Write(src/**)'] },
    });
    const result = detectClaudePermissionLevel({
      cwd: dir, home: '/nonexistent', managedRootOverride: '/nonexistent/managed',
    });
    assert.equal(result, 'suggest');
    rmSync(dir, { recursive: true, force: true });
  });

  it('scoped Bash(git:*) alone → suggest (scoped bash cannot promote)', () => {
    // Security fix: workspace-write still allows arbitrary shell within cwd,
    // so mirroring `Bash(git:*)` to auto-edit would let codex run `rm`, `curl`,
    // etc. — far beyond the user's git-only grant.
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['Bash(git:*)'] },
    });
    const result = detectClaudePermissionLevel({
      cwd: dir, home: '/nonexistent', managedRootOverride: '/nonexistent/managed',
    });
    assert.equal(result, 'suggest');
    rmSync(dir, { recursive: true, force: true });
  });

  it('NotebookEdit(*) does NOT match Edit (anchored prefix)', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['NotebookEdit(*)', 'Read(*)'] },
    });
    const result = detectClaudePermissionLevel({
      cwd: dir, home: '/nonexistent', managedRootOverride: '/nonexistent/managed',
    });
    assert.equal(result, 'suggest');
    rmSync(dir, { recursive: true, force: true });
  });

  it('scoped deny Bash(curl:*) invalidates broad Bash grant (fail-closed)', () => {
    // Plan A: codex cannot honor scoped deny, so broad grant is revoked for
    // bash. Write remains broad → auto-edit, not full-auto.
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['Bash(*)', 'Write(*)'], deny: ['Bash(curl:*)'] },
    });
    const result = detectClaudePermissionLevel({
      cwd: dir, home: '/nonexistent', managedRootOverride: '/nonexistent/managed',
    });
    assert.equal(result, 'auto-edit');
    rmSync(dir, { recursive: true, force: true });
  });

  it('scoped ask Bash(curl:*) invalidates broad Bash grant (fail-closed)', () => {
    // `ask` means "confirm with human" — codex is non-interactive, so any
    // Bash entry in ask fails closed for bash.
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['Bash(*)', 'Write(*)'], ask: ['Bash(curl:*)'] },
    });
    const result = detectClaudePermissionLevel({
      cwd: dir, home: '/nonexistent', managedRootOverride: '/nonexistent/managed',
    });
    assert.equal(result, 'auto-edit');
    rmSync(dir, { recursive: true, force: true });
  });

  it('literal deny Bash(*) fully blocks even scoped bash allow', () => {
    // literal broad deny removes ALL bash grants (broad + scoped).
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['Bash(git:*)', 'Write(*)'], deny: ['Bash(*)'] },
    });
    const result = detectClaudePermissionLevel({
      cwd: dir, home: '/nonexistent', managedRootOverride: '/nonexistent/managed',
    });
    // No bash at all; Write(*) still broad → auto-edit
    assert.equal(result, 'auto-edit');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('detectClaudePermissionLevel: project settings.json source', () => {
  it('reads project-committed .claude/settings.json when settings.local.json absent', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.json', {
      permissions: { allow: ['Bash(*)', 'Write(*)'] },
    });
    const result = detectClaudePermissionLevel({
      cwd: dir, home: '/nonexistent', managedRootOverride: '/nonexistent/managed',
    });
    assert.equal(result, 'full-auto');
    rmSync(dir, { recursive: true, force: true });
  });

  it('settings.local.json + settings.json MERGE within a project (not first-wins)', () => {
    // Plan A: all scopes union their allow lists.
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['Read(*)'] },
    });
    writeSettings(dir, '.claude/settings.json', {
      permissions: { allow: ['Bash(*)', 'Write(*)'] },
    });
    const result = detectClaudePermissionLevel({
      cwd: dir, home: '/nonexistent', managedRootOverride: '/nonexistent/managed',
    });
    assert.equal(result, 'full-auto'); // merged → broad bash+write
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// detectClaudePermissionLevel — user-level settings
// ---------------------------------------------------------------------------

describe('detectClaudePermissionLevel: user-level settings', () => {
  it('falls back to ~/.claude/settings.local.json', () => {
    const home = makeTmpDir();
    const cwd = makeTmpDir();
    writeSettings(home, '.claude/settings.local.json', {
      permissions: { allow: ['Bash(*)', 'Write(*)'] },
    });
    const result = detectClaudePermissionLevel({ cwd, home });
    assert.equal(result, 'full-auto');
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('falls back to ~/.claude/settings.json', () => {
    const home = makeTmpDir();
    const cwd = makeTmpDir();
    writeSettings(home, '.claude/settings.json', {
      permissions: { allow: ['Edit(*)'] },
    });
    const result = detectClaudePermissionLevel({ cwd, home });
    assert.equal(result, 'auto-edit');
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// detectClaudePermissionLevel — no settings
// ---------------------------------------------------------------------------

describe('detectClaudePermissionLevel: no settings files', () => {
  it('returns suggest when no settings files exist', () => {
    const result = detectClaudePermissionLevel({
      cwd: '/nonexistent/path',
      home: '/nonexistent/home',
    });
    assert.equal(result, 'suggest');
  });

  it('returns suggest for empty allow list', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: [] },
    });
    const result = detectClaudePermissionLevel({ cwd: dir, home: '/nonexistent' });
    assert.equal(result, 'suggest');
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns suggest for malformed settings', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', { foo: 'bar' });
    const result = detectClaudePermissionLevel({ cwd: dir, home: '/nonexistent' });
    assert.equal(result, 'suggest');
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// detectClaudePermissionLevel — multi-scope merge (Plan A semantics)
// ---------------------------------------------------------------------------

describe('detectClaudePermissionLevel: multi-scope merge', () => {
  it('user Bash(*) + project Write(*) MERGE to full-auto', () => {
    // Plan A: allow lists union across scopes (per Claude docs).
    const home = makeTmpDir();
    const cwd = makeTmpDir();
    writeSettings(home, '.claude/settings.local.json', {
      permissions: { allow: ['Bash(*)'] },
    });
    writeSettings(cwd, '.claude/settings.local.json', {
      permissions: { allow: ['Write(*)'] },
    });
    const result = detectClaudePermissionLevel({
      cwd, home, managedRootOverride: '/nonexistent/managed',
    });
    assert.equal(result, 'full-auto');
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('narrow project allow does NOT hide broader user grant', () => {
    // A project-local Read(*) alone used to win under first-wins semantics
    // and downgrade a user-level Bash(*)+Write(*) to suggest. Under merge
    // semantics both grants coexist → full-auto.
    const home = makeTmpDir();
    const cwd = makeTmpDir();
    writeSettings(home, '.claude/settings.local.json', {
      permissions: { allow: ['Bash(*)', 'Write(*)'] },
    });
    writeSettings(cwd, '.claude/settings.local.json', {
      permissions: { allow: ['Read(*)'] },
    });
    const result = detectClaudePermissionLevel({
      cwd, home, managedRootOverride: '/nonexistent/managed',
    });
    assert.equal(result, 'full-auto');
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('deny in any scope overrides allow in any other scope', () => {
    // Deny in user settings must invalidate a project allow (deny > allow).
    const home = makeTmpDir();
    const cwd = makeTmpDir();
    writeSettings(home, '.claude/settings.local.json', {
      permissions: { deny: ['Bash(*)'] },
    });
    writeSettings(cwd, '.claude/settings.local.json', {
      permissions: { allow: ['Bash(*)', 'Write(*)'] },
    });
    const result = detectClaudePermissionLevel({
      cwd, home, managedRootOverride: '/nonexistent/managed',
    });
    // Bash denied, Write still broad → auto-edit
    assert.equal(result, 'auto-edit');
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('ask in any scope fails closed for that tool across all scopes', () => {
    const home = makeTmpDir();
    const cwd = makeTmpDir();
    writeSettings(home, '.claude/settings.local.json', {
      permissions: { ask: ['Bash(git:*)'] },
    });
    writeSettings(cwd, '.claude/settings.local.json', {
      permissions: { allow: ['Bash(*)', 'Write(*)'] },
    });
    const result = detectClaudePermissionLevel({
      cwd, home, managedRootOverride: '/nonexistent/managed',
    });
    // Bash ask-mention fails closed → Write still broad → auto-edit
    assert.equal(result, 'auto-edit');
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('defaultMode comes from highest precedence scope that sets it', () => {
    // Project-local sets acceptEdits, user sets bypassPermissions.
    // Highest precedence (project-local) wins → acceptEdits.
    const home = makeTmpDir();
    const cwd = makeTmpDir();
    writeSettings(home, '.claude/settings.local.json', {
      permissions: { defaultMode: 'bypassPermissions' },
    });
    writeSettings(cwd, '.claude/settings.local.json', {
      permissions: { defaultMode: 'acceptEdits' },
    });
    const result = detectClaudePermissionLevel({
      cwd, home, managedRootOverride: '/nonexistent/managed',
    });
    // acceptEdits → implicit broad for Write+Edit only, no Bash → auto-edit
    assert.equal(result, 'auto-edit');
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// detectClaudePermissionLevel — disableBypassPermissionsMode
// ---------------------------------------------------------------------------

describe('detectClaudePermissionLevel: disableBypassPermissionsMode', () => {
  it('disableBypassPermissionsMode="disable" (string schema) demotes bypassPermissions', () => {
    // Claude docs current schema: the value is the string "disable", not boolean.
    // We accept both for forward/backward compat.
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: {
        defaultMode: 'bypassPermissions',
        disableBypassPermissionsMode: 'disable',
      },
    });
    const result = detectClaudePermissionLevel({
      cwd: dir, home: '/nonexistent', managedRootOverride: '/nonexistent/managed',
    });
    assert.equal(result, 'suggest');
    rmSync(dir, { recursive: true, force: true });
  });

  it('disableBypassPermissionsMode=true demotes bypassPermissions to suggest when no allow', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: {
        defaultMode: 'bypassPermissions',
        disableBypassPermissionsMode: true,
      },
    });
    const result = detectClaudePermissionLevel({
      cwd: dir, home: '/nonexistent', managedRootOverride: '/nonexistent/managed',
    });
    // bypass disabled → no implicit broad → no allow list → suggest
    assert.equal(result, 'suggest');
    rmSync(dir, { recursive: true, force: true });
  });

  it('disableBypassPermissionsMode in any scope disables bypass in all scopes (OR)', () => {
    // User sets bypassPermissions, project sets disableBypassPermissionsMode=true.
    // OR semantics across scopes → bypass is disabled.
    const home = makeTmpDir();
    const cwd = makeTmpDir();
    writeSettings(home, '.claude/settings.local.json', {
      permissions: { defaultMode: 'bypassPermissions' },
    });
    writeSettings(cwd, '.claude/settings.local.json', {
      permissions: { disableBypassPermissionsMode: true },
    });
    const result = detectClaudePermissionLevel({
      cwd, home, managedRootOverride: '/nonexistent/managed',
    });
    assert.equal(result, 'suggest');
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('disableBypassPermissionsMode does NOT affect acceptEdits', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: {
        defaultMode: 'acceptEdits',
        disableBypassPermissionsMode: true,
      },
    });
    const result = detectClaudePermissionLevel({
      cwd: dir, home: '/nonexistent', managedRootOverride: '/nonexistent/managed',
    });
    assert.equal(result, 'auto-edit');
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// detectClaudePermissionLevel — managed settings
// ---------------------------------------------------------------------------

describe('detectClaudePermissionLevel: managed settings', () => {
  it('managed-settings.json contributes to allow merge', () => {
    const managedRoot = makeTmpDir();
    const cwd = makeTmpDir();
    writeSettings(managedRoot, 'managed-settings.json', {
      permissions: { allow: ['Bash(*)', 'Write(*)'] },
    });
    const result = detectClaudePermissionLevel({
      cwd, home: '/nonexistent', managedRootOverride: managedRoot,
    });
    assert.equal(result, 'full-auto');
    rmSync(managedRoot, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('managed deny invalidates user allow (deny wins across scopes)', () => {
    const managedRoot = makeTmpDir();
    const home = makeTmpDir();
    const cwd = makeTmpDir();
    writeSettings(managedRoot, 'managed-settings.json', {
      permissions: { deny: ['Bash(*)'] },
    });
    writeSettings(home, '.claude/settings.local.json', {
      permissions: { allow: ['Bash(*)', 'Write(*)'] },
    });
    const result = detectClaudePermissionLevel({
      cwd, home, managedRootOverride: managedRoot,
    });
    // Managed deny on Bash → Write still broad → auto-edit
    assert.equal(result, 'auto-edit');
    rmSync(managedRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('managed-settings.d/ fragments are read in lexical order', () => {
    const managedRoot = makeTmpDir();
    const cwd = makeTmpDir();
    // Non-.json ignored; .json merged.
    writeSettings(managedRoot, 'managed-settings.d/10-bash.json', {
      permissions: { allow: ['Bash(*)'] },
    });
    writeSettings(managedRoot, 'managed-settings.d/20-write.json', {
      permissions: { allow: ['Write(*)'] },
    });
    writeSettings(managedRoot, 'managed-settings.d/README.txt', 'ignored');
    const result = detectClaudePermissionLevel({
      cwd, home: '/nonexistent', managedRootOverride: managedRoot,
    });
    assert.equal(result, 'full-auto');
    rmSync(managedRoot, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('managed fragment scalar defaultMode uses last-wins within managed scope', () => {
    // managed-settings.json says acceptEdits; a later fragment says
    // bypassPermissions. Per managed-settings.d merge rules, later fragments
    // override earlier scalars → bypassPermissions wins.
    const managedRoot = makeTmpDir();
    const cwd = makeTmpDir();
    writeSettings(managedRoot, 'managed-settings.json', {
      permissions: { defaultMode: 'acceptEdits' },
    });
    writeSettings(managedRoot, 'managed-settings.d/99-override.json', {
      permissions: { defaultMode: 'bypassPermissions' },
    });
    const result = detectClaudePermissionLevel({
      cwd, home: '/nonexistent', managedRootOverride: managedRoot,
    });
    assert.equal(result, 'full-auto'); // bypassPermissions wins via last-wins
    rmSync(managedRoot, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('allowManagedPermissionRulesOnly suppresses user/project allow lists', () => {
    // Managed scope sets the flag → only managed allow rules contribute.
    // User-level Bash(*)+Write(*) is ignored.
    const managedRoot = makeTmpDir();
    const home = makeTmpDir();
    const cwd = makeTmpDir();
    writeSettings(managedRoot, 'managed-settings.json', {
      permissions: {
        allowManagedPermissionRulesOnly: true,
        allow: ['Read(*)'],
      },
    });
    writeSettings(home, '.claude/settings.local.json', {
      permissions: { allow: ['Bash(*)', 'Write(*)'] },
    });
    const result = detectClaudePermissionLevel({
      cwd, home, managedRootOverride: managedRoot,
    });
    assert.equal(result, 'suggest'); // user allows suppressed, managed only has Read
    rmSync(managedRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('allowManagedPermissionRulesOnly does NOT suppress deny/ask (defense-in-depth)', () => {
    // Even with the flag set, user-scope deny/ask still apply — a narrow
    // restriction in any scope must still invalidate the managed broad grant.
    const managedRoot = makeTmpDir();
    const home = makeTmpDir();
    const cwd = makeTmpDir();
    writeSettings(managedRoot, 'managed-settings.json', {
      permissions: {
        allowManagedPermissionRulesOnly: true,
        allow: ['Bash(*)', 'Write(*)'],
      },
    });
    writeSettings(home, '.claude/settings.local.json', {
      permissions: { deny: ['Bash(*)'] },
    });
    const result = detectClaudePermissionLevel({
      cwd, home, managedRootOverride: managedRoot,
    });
    // User deny still applies → Bash dropped → auto-edit (Write still broad)
    assert.equal(result, 'auto-edit');
    rmSync(managedRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('managed disableBypassPermissionsMode overrides user bypassPermissions', () => {
    const managedRoot = makeTmpDir();
    const home = makeTmpDir();
    const cwd = makeTmpDir();
    writeSettings(managedRoot, 'managed-settings.json', {
      permissions: { disableBypassPermissionsMode: true },
    });
    writeSettings(home, '.claude/settings.local.json', {
      permissions: { defaultMode: 'bypassPermissions' },
    });
    const result = detectClaudePermissionLevel({
      cwd, home, managedRootOverride: managedRoot,
    });
    assert.equal(result, 'suggest');
    rmSync(managedRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// resolveCodexApproval
// ---------------------------------------------------------------------------

describe('resolveCodexApproval', () => {
  it('uses explicit full-auto from config', () => {
    const result = resolveCodexApproval({ codex: { approval: 'full-auto' } });
    assert.equal(result, 'full-auto');
  });

  it('uses explicit suggest from config', () => {
    const result = resolveCodexApproval({ codex: { approval: 'suggest' } });
    assert.equal(result, 'suggest');
  });

  it('uses explicit auto-edit from config', () => {
    const result = resolveCodexApproval({ codex: { approval: 'auto-edit' } });
    assert.equal(result, 'auto-edit');
  });

  it('falls back to detection when "auto"', () => {
    const result = resolveCodexApproval(
      { codex: { approval: 'auto' } },
      { cwd: '/nonexistent', home: '/nonexistent' },
    );
    assert.equal(result, 'suggest'); // no settings → suggest
  });

  it('falls back to detection when codex config is missing', () => {
    const result = resolveCodexApproval(
      {},
      { cwd: '/nonexistent', home: '/nonexistent' },
    );
    assert.equal(result, 'suggest');
  });

  it('falls back to detection when config is null', () => {
    const result = resolveCodexApproval(
      null,
      { cwd: '/nonexistent', home: '/nonexistent' },
    );
    assert.equal(result, 'suggest');
  });

  it('ignores invalid approval value and falls back to detection', () => {
    const result = resolveCodexApproval(
      { codex: { approval: 'invalid-mode' } },
      { cwd: '/nonexistent', home: '/nonexistent' },
    );
    assert.equal(result, 'suggest');
  });

  it('"auto" detects full-auto from real settings files', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['Bash(*)', 'Write(*)', 'Edit(*)'] },
    });
    const result = resolveCodexApproval(
      { codex: { approval: 'auto' } },
      { cwd: dir, home: '/nonexistent' },
    );
    assert.equal(result, 'full-auto');
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// effectiveCodexLevel — intersect permissions.allow with host sandbox tier
// ---------------------------------------------------------------------------

describe('effectiveCodexLevel: matrix (permLevel × hostSandbox.tier)', () => {
  // Matrix: rows = permLevel, cols = hostSandbox.tier, values = expected effective
  const cases = [
    // [permLevel,     hostTier,          expected]
    // full-auto permissions
    ['full-auto',     'unrestricted',    'full-auto'],
    ['full-auto',     'workspace-write', 'auto-edit'],
    ['full-auto',     'read-only',       'suggest'],
    ['full-auto',     'unknown',         'full-auto'], // unknown does NOT downgrade
    // auto-edit permissions
    ['auto-edit',     'unrestricted',    'auto-edit'],
    ['auto-edit',     'workspace-write', 'auto-edit'],
    ['auto-edit',     'read-only',       'suggest'],
    ['auto-edit',     'unknown',         'auto-edit'],
    // suggest permissions
    ['suggest',       'unrestricted',    'suggest'],
    ['suggest',       'workspace-write', 'suggest'],
    ['suggest',       'read-only',       'suggest'],
    ['suggest',       'unknown',         'suggest'],
  ];

  for (const [permLevel, tier, expected] of cases) {
    it(`${permLevel} ∩ ${tier} → ${expected}`, () => {
      const result = effectiveCodexLevel(permLevel, { tier, signals: {} });
      assert.equal(result, expected);
    });
  }

  it('unknown host tier never downgrades (silent downgrade guard)', () => {
    assert.equal(effectiveCodexLevel('full-auto', { tier: 'unknown' }), 'full-auto');
    assert.equal(effectiveCodexLevel('auto-edit', { tier: 'unknown' }), 'auto-edit');
  });

  it('missing hostSandbox argument → treated as unknown (no downgrade)', () => {
    assert.equal(effectiveCodexLevel('full-auto', undefined), 'full-auto');
    assert.equal(effectiveCodexLevel('full-auto', null), 'full-auto');
  });

  it('unknown permLevel → suggest (fail-safe)', () => {
    assert.equal(effectiveCodexLevel('bogus', { tier: 'unrestricted' }), 'suggest');
  });
});

// ---------------------------------------------------------------------------
// resolveCodexApproval integration with host sandbox detection
// ---------------------------------------------------------------------------

describe('resolveCodexApproval: host sandbox intersection', () => {
  it('explicit autonomy approval is still intersected with AO_HOST_SANDBOX_LEVEL', () => {
    // KEY CONTRACT: explicit codex.approval does NOT bypass host sandbox.
    // The user can express a ceiling permLevel, but the host sandbox is
    // ground truth and always applies. To escape the host detection the
    // user must also set AO_HOST_SANDBOX_LEVEL or codex.hostSandbox.
    const result = resolveCodexApproval(
      { codex: { approval: 'full-auto' } },
      {
        cwd: '/nonexistent',
        home: '/nonexistent',
        env: { AO_HOST_SANDBOX_LEVEL: 'read-only' },
      },
    );
    assert.equal(result, 'suggest');
  });

  it('explicit codex.approval + explicit codex.hostSandbox → intersection of both', () => {
    // User sets a ceiling AND a host override → min(permLevel, hostTier)
    const result = resolveCodexApproval(
      { codex: { approval: 'full-auto', hostSandbox: 'workspace-write' } },
      { cwd: '/nonexistent', home: '/nonexistent', env: {} },
    );
    assert.equal(result, 'auto-edit');
  });

  it('explicit codex.approval=suggest forces suggest even on permissive host', () => {
    const result = resolveCodexApproval(
      { codex: { approval: 'suggest', hostSandbox: 'unrestricted' } },
      { cwd: '/nonexistent', home: '/nonexistent', env: {} },
    );
    assert.equal(result, 'suggest');
  });

  it('explicit codex.approval acts as ceiling, unknown host does not downgrade', () => {
    // approval=auto-edit, no host signals → unknown → keep auto-edit
    const result = resolveCodexApproval(
      { codex: { approval: 'auto-edit' } },
      { cwd: '/nonexistent', home: '/nonexistent', env: {} },
    );
    assert.equal(result, 'auto-edit');
  });

  it('AO_HOST_SANDBOX_LEVEL=read-only downgrades full-auto permissions to suggest', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['Bash(*)', 'Write(*)'] },
    });
    const result = resolveCodexApproval(
      { codex: { approval: 'auto' } },
      {
        cwd: dir,
        home: '/nonexistent',
        env: { AO_HOST_SANDBOX_LEVEL: 'read-only' },
      },
    );
    assert.equal(result, 'suggest');
    rmSync(dir, { recursive: true, force: true });
  });

  it('AO_HOST_SANDBOX_LEVEL=workspace-write downgrades full-auto to auto-edit', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['Bash(*)', 'Write(*)'] },
    });
    const result = resolveCodexApproval(
      { codex: { approval: 'auto' } },
      {
        cwd: dir,
        home: '/nonexistent',
        env: { AO_HOST_SANDBOX_LEVEL: 'workspace-write' },
      },
    );
    assert.equal(result, 'auto-edit');
    rmSync(dir, { recursive: true, force: true });
  });

  it('autonomy.codex.hostSandbox honored when env absent', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['Bash(*)', 'Write(*)'] },
    });
    const result = resolveCodexApproval(
      { codex: { approval: 'auto', hostSandbox: 'read-only' } },
      { cwd: dir, home: '/nonexistent', env: {} },
    );
    assert.equal(result, 'suggest');
    rmSync(dir, { recursive: true, force: true });
  });

  it('host tier unknown (no signals) keeps permLevel', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['Bash(*)', 'Write(*)'] },
    });
    const result = resolveCodexApproval(
      { codex: { approval: 'auto' } },
      { cwd: dir, home: '/nonexistent', env: {} },
    );
    // Should equal full-auto because host detection returns 'unknown' without signals
    assert.equal(result, 'full-auto');
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// buildHostSandboxWarning — surfaces unknown-tier ambiguity to the user
// ---------------------------------------------------------------------------

describe('buildHostSandboxWarning', () => {
  it('returns null when hostSandbox is null', () => {
    assert.equal(buildHostSandboxWarning('full-auto', null), null);
  });

  it('returns null when tier is resolved (not unknown)', () => {
    assert.equal(
      buildHostSandboxWarning('full-auto', { tier: 'workspace-write', signals: {} }),
      null,
    );
  });

  it('returns null when tier is unknown with no suspicious signals', () => {
    assert.equal(
      buildHostSandboxWarning('full-auto', {
        tier: 'unknown',
        signals: {
          containerized: false,
          networkRestricted: false,
          seccompActive: false,
          noNewPrivs: false,
        },
      }),
      null,
    );
  });

  it('returns warning when containerized + unknown tier', () => {
    const w = buildHostSandboxWarning('full-auto', {
      tier: 'unknown',
      signals: { containerized: true },
    });
    assert.ok(w);
    assert.match(w, /container/);
    assert.match(w, /full-auto/);
    assert.match(w, /AO_HOST_SANDBOX_LEVEL/);
  });

  it('returns null when ONLY networkRestricted (network-only signal does not trigger fs-tier warning)', () => {
    // OPERON_SANDBOXED_NETWORK alone should NOT trigger a warning because
    // AO_HOST_SANDBOX_LEVEL sets a FILESYSTEM tier; recommending it for a
    // network-only signal is misleading.
    assert.equal(
      buildHostSandboxWarning('full-auto', {
        tier: 'unknown',
        signals: { networkRestricted: true },
      }),
      null,
    );
  });

  it('returns warning when seccomp + unknown', () => {
    const w = buildHostSandboxWarning('auto-edit', {
      tier: 'unknown',
      signals: { seccompActive: true },
    });
    assert.ok(w);
    assert.match(w, /seccomp/);
  });

  it('returns warning listing multiple filesystem-scoped signals', () => {
    const w = buildHostSandboxWarning('full-auto', {
      tier: 'unknown',
      signals: { containerized: true, seccompActive: true, noNewPrivs: true },
    });
    assert.ok(w);
    assert.match(w, /container/);
    assert.match(w, /seccomp/);
    assert.match(w, /NoNewPrivs/);
  });

  it('networkRestricted mixed with fs signals does not appear in warning text', () => {
    const w = buildHostSandboxWarning('full-auto', {
      tier: 'unknown',
      signals: { containerized: true, networkRestricted: true },
    });
    assert.ok(w);
    assert.match(w, /container/);
    // Network signal is intentionally excluded from the warning text —
    // the override it recommends doesn't address network policy.
    assert.ok(!/network/.test(w), `network should not appear: ${w}`);
  });

  it('warning includes current effective level so user sees the risk', () => {
    const w = buildHostSandboxWarning('full-auto', {
      tier: 'unknown',
      signals: { containerized: true },
    });
    assert.match(w, /full-auto/);
  });
});
