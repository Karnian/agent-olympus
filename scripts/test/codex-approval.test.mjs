/**
 * Unit tests for scripts/lib/codex-approval.mjs
 *
 * Tests detectClaudePermissionLevel(), resolveCodexApproval(), and codexApprovalFlag().
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
  codexApprovalFlag,
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
// codexApprovalFlag
// ---------------------------------------------------------------------------

describe('codexApprovalFlag', () => {
  it('returns --full-auto for full-auto', () => {
    assert.equal(codexApprovalFlag('full-auto'), '--full-auto');
  });

  it('returns --auto-edit for auto-edit', () => {
    assert.equal(codexApprovalFlag('auto-edit'), '--auto-edit');
  });

  it('returns empty string for suggest', () => {
    assert.equal(codexApprovalFlag('suggest'), '');
  });

  it('returns empty string for unknown mode', () => {
    assert.equal(codexApprovalFlag('unknown'), '');
  });

  it('returns empty string for undefined', () => {
    assert.equal(codexApprovalFlag(undefined), '');
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
