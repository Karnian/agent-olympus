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
