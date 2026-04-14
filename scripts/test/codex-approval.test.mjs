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

describe('detectClaudePermissionLevel: expanded pattern matching', () => {
  it('scoped Bash(git:*) + Write(*) → full-auto (scoped bash counts)', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['Bash(git:*)', 'Write(*)'] },
    });
    const result = detectClaudePermissionLevel({ cwd: dir, home: '/nonexistent' });
    assert.equal(result, 'full-auto');
    rmSync(dir, { recursive: true, force: true });
  });

  it('Bash(*:*) wildcard variant → full-auto', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['Bash(*:*)', 'Write(*)'] },
    });
    const result = detectClaudePermissionLevel({ cwd: dir, home: '/nonexistent' });
    assert.equal(result, 'full-auto');
    rmSync(dir, { recursive: true, force: true });
  });

  it('scoped Write(src/**) alone → auto-edit', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['Write(src/**)'] },
    });
    const result = detectClaudePermissionLevel({ cwd: dir, home: '/nonexistent' });
    assert.equal(result, 'auto-edit');
    rmSync(dir, { recursive: true, force: true });
  });

  it('NotebookEdit(*) does NOT match Edit (anchored prefix)', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['NotebookEdit(*)', 'Read(*)'] },
    });
    const result = detectClaudePermissionLevel({ cwd: dir, home: '/nonexistent' });
    assert.equal(result, 'suggest');
    rmSync(dir, { recursive: true, force: true });
  });

  it('scoped deny Bash(curl:*) does NOT block broad Bash allow', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['Bash(*)', 'Write(*)'], deny: ['Bash(curl:*)'] },
    });
    const result = detectClaudePermissionLevel({ cwd: dir, home: '/nonexistent' });
    assert.equal(result, 'full-auto');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('detectClaudePermissionLevel: project settings.json source', () => {
  it('reads project-committed .claude/settings.json when settings.local.json absent', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.json', {
      permissions: { allow: ['Bash(*)', 'Write(*)'] },
    });
    const result = detectClaudePermissionLevel({ cwd: dir, home: '/nonexistent' });
    assert.equal(result, 'full-auto');
    rmSync(dir, { recursive: true, force: true });
  });

  it('settings.local.json wins over settings.json within same project', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['Read(*)'] },
    });
    writeSettings(dir, '.claude/settings.json', {
      permissions: { allow: ['Bash(*)', 'Write(*)'] },
    });
    const result = detectClaudePermissionLevel({ cwd: dir, home: '/nonexistent' });
    assert.equal(result, 'suggest');
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
// detectClaudePermissionLevel — priority order
// ---------------------------------------------------------------------------

describe('detectClaudePermissionLevel: priority order', () => {
  it('project-level settings override user-level', () => {
    const home = makeTmpDir();
    const cwd = makeTmpDir();
    // User-level: full-auto
    writeSettings(home, '.claude/settings.local.json', {
      permissions: { allow: ['Bash(*)', 'Write(*)'] },
    });
    // Project-level: suggest (read only)
    writeSettings(cwd, '.claude/settings.local.json', {
      permissions: { allow: ['Read(*)'] },
    });
    const result = detectClaudePermissionLevel({ cwd, home });
    assert.equal(result, 'suggest');
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
