/**
 * Unit tests for scripts/lib/gemini-approval.mjs
 *
 * Tests resolveGeminiApproval(), geminiApprovalFlag(), and _detectClaudePermissions().
 * Uses temporary settings files to simulate different Claude permission configurations.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  resolveGeminiApproval,
  geminiApprovalFlag,
  _detectClaudePermissions,
} from '../lib/gemini-approval.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  const dir = join(tmpdir(), `ao-gemini-approval-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSettings(dir, relPath, data) {
  const fullDir = join(dir, ...relPath.split('/').slice(0, -1));
  mkdirSync(fullDir, { recursive: true });
  writeFileSync(join(dir, relPath), JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// geminiApprovalFlag
// ---------------------------------------------------------------------------

describe('geminiApprovalFlag', () => {
  it('returns --approval-mode yolo for yolo', () => {
    assert.equal(geminiApprovalFlag('yolo'), '--approval-mode yolo');
  });

  it('returns --approval-mode auto_edit for auto_edit', () => {
    assert.equal(geminiApprovalFlag('auto_edit'), '--approval-mode auto_edit');
  });

  it('returns --approval-mode plan for plan', () => {
    assert.equal(geminiApprovalFlag('plan'), '--approval-mode plan');
  });

  it('returns empty string for default', () => {
    assert.equal(geminiApprovalFlag('default'), '');
  });

  it('returns empty string for unknown mode', () => {
    assert.equal(geminiApprovalFlag('unknown'), '');
  });

  it('returns empty string for undefined', () => {
    assert.equal(geminiApprovalFlag(undefined), '');
  });
});

// ---------------------------------------------------------------------------
// _detectClaudePermissions — project-level settings
// ---------------------------------------------------------------------------

describe('_detectClaudePermissions: project-level settings', () => {
  let tmpDir;

  before(() => {
    tmpDir = makeTmpDir();
  });
  after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('detects Bash(*) + Write(*) in project settings', () => {
    writeSettings(tmpDir, '.claude/settings.local.json', {
      permissions: { allow: ['Bash(*)', 'Read(*)', 'Write(*)', 'Edit(*)'] },
    });
    const result = _detectClaudePermissions({ cwd: tmpDir, home: '/nonexistent' });
    assert.equal(result.hasBashStar, true);
    assert.equal(result.hasWriteStar, true);
    assert.equal(result.hasEditStar, true);
  });

  it('detects bare Bash (without glob) + Write(*)', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['Bash', 'Write(*)'] },
    });
    const result = _detectClaudePermissions({ cwd: dir, home: '/nonexistent' });
    assert.equal(result.hasBashStar, true);
    assert.equal(result.hasWriteStar, true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns false for all when only Read(*)', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['Read(*)', 'Glob(*)'] },
    });
    const result = _detectClaudePermissions({ cwd: dir, home: '/nonexistent' });
    assert.equal(result.hasBashStar, false);
    assert.equal(result.hasWriteStar, false);
    assert.equal(result.hasEditStar, false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns false for all with malformed settings', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', { foo: 'bar' });
    const result = _detectClaudePermissions({ cwd: dir, home: '/nonexistent' });
    assert.equal(result.hasBashStar, false);
    assert.equal(result.hasWriteStar, false);
    assert.equal(result.hasEditStar, false);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// _detectClaudePermissions — no settings files
// ---------------------------------------------------------------------------

describe('_detectClaudePermissions: no settings files', () => {
  it('returns all false when no settings files exist', () => {
    const result = _detectClaudePermissions({
      cwd: '/nonexistent/path',
      home: '/nonexistent/home',
      managedRootOverride: '/nonexistent/managed',
    });
    // Contract: all tool flags false; defaultMode null; no bypass disable; not managed.
    assert.equal(result.hasBashStar, false);
    assert.equal(result.hasBashScoped, false);
    assert.equal(result.hasWriteStar, false);
    assert.equal(result.hasWriteScoped, false);
    assert.equal(result.hasEditStar, false);
    assert.equal(result.hasEditScoped, false);
    assert.equal(result.defaultMode, null);
    assert.equal(result.bypassDisabled, false);
    assert.equal(result.managedDetected, false);
  });
});

// ---------------------------------------------------------------------------
// resolveGeminiApproval — explicit override via autonomy config
// ---------------------------------------------------------------------------

describe('resolveGeminiApproval: explicit override', () => {
  it('uses explicit yolo from config', () => {
    const result = resolveGeminiApproval({ gemini: { approval: 'yolo' } });
    assert.equal(result, 'yolo');
  });

  it('uses explicit auto_edit from config', () => {
    const result = resolveGeminiApproval({ gemini: { approval: 'auto_edit' } });
    assert.equal(result, 'auto_edit');
  });

  it('uses explicit default from config', () => {
    const result = resolveGeminiApproval({ gemini: { approval: 'default' } });
    assert.equal(result, 'default');
  });

  it('uses explicit plan from config', () => {
    const result = resolveGeminiApproval({ gemini: { approval: 'plan' } });
    assert.equal(result, 'plan');
  });

  it('ignores invalid approval value and falls back to detection', () => {
    const result = resolveGeminiApproval(
      { gemini: { approval: 'invalid-mode' } },
      { cwd: '/nonexistent', home: '/nonexistent' },
    );
    assert.equal(result, 'default');
  });
});

// ---------------------------------------------------------------------------
// resolveGeminiApproval — auto detection
// ---------------------------------------------------------------------------

describe('resolveGeminiApproval: auto detection', () => {
  it('falls back to detection when "auto"', () => {
    const result = resolveGeminiApproval(
      { gemini: { approval: 'auto' } },
      { cwd: '/nonexistent', home: '/nonexistent' },
    );
    assert.equal(result, 'default'); // no settings → default
  });

  it('falls back to detection when gemini config is missing', () => {
    const result = resolveGeminiApproval(
      {},
      { cwd: '/nonexistent', home: '/nonexistent' },
    );
    assert.equal(result, 'default');
  });

  it('falls back to detection when config is null', () => {
    const result = resolveGeminiApproval(
      null,
      { cwd: '/nonexistent', home: '/nonexistent' },
    );
    assert.equal(result, 'default');
  });

  it('"auto" detects yolo when Bash(*) + Write(*) present', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['Bash(*)', 'Write(*)', 'Edit(*)'] },
    });
    const result = resolveGeminiApproval(
      { gemini: { approval: 'auto' } },
      { cwd: dir, home: '/nonexistent' },
    );
    assert.equal(result, 'yolo');
    rmSync(dir, { recursive: true, force: true });
  });

  it('"auto" detects auto_edit when Write(*) but no Bash(*)', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['Read(*)', 'Write(*)', 'Edit(*)'] },
    });
    const result = resolveGeminiApproval(
      { gemini: { approval: 'auto' } },
      { cwd: dir, home: '/nonexistent' },
    );
    assert.equal(result, 'auto_edit');
    rmSync(dir, { recursive: true, force: true });
  });

  it('"auto" detects auto_edit when Edit(*) only', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['Read(*)', 'Edit(*)'] },
    });
    const result = resolveGeminiApproval(
      { gemini: { approval: 'auto' } },
      { cwd: dir, home: '/nonexistent' },
    );
    assert.equal(result, 'auto_edit');
    rmSync(dir, { recursive: true, force: true });
  });

  it('"auto" detects default when only Read(*)', () => {
    const dir = makeTmpDir();
    writeSettings(dir, '.claude/settings.local.json', {
      permissions: { allow: ['Read(*)', 'Glob(*)'] },
    });
    const result = resolveGeminiApproval(
      { gemini: { approval: 'auto' } },
      { cwd: dir, home: '/nonexistent' },
    );
    assert.equal(result, 'default');
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to user-level ~/.claude/settings.local.json', () => {
    const home = makeTmpDir();
    const cwd = makeTmpDir();
    writeSettings(home, '.claude/settings.local.json', {
      permissions: { allow: ['Bash(*)', 'Write(*)'] },
    });
    const result = resolveGeminiApproval({}, { cwd, home });
    assert.equal(result, 'yolo');
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('falls back to user-level ~/.claude/settings.json', () => {
    const home = makeTmpDir();
    const cwd = makeTmpDir();
    writeSettings(home, '.claude/settings.json', {
      permissions: { allow: ['Edit(*)'] },
    });
    const result = resolveGeminiApproval({}, { cwd, home });
    assert.equal(result, 'auto_edit');
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('allow lists MERGE across scopes (project + user)', () => {
    // Plan A semantics: allow arrays union across scopes (per Claude docs).
    // Project-local narrow grant does NOT hide broader user-level grant.
    const home = makeTmpDir();
    const cwd = makeTmpDir();
    writeSettings(home, '.claude/settings.local.json', {
      permissions: { allow: ['Bash(*)', 'Write(*)'] },
    });
    writeSettings(cwd, '.claude/settings.local.json', {
      permissions: { allow: ['Read(*)'] },
    });
    const result = resolveGeminiApproval({}, {
      cwd, home, managedRootOverride: '/nonexistent/managed',
    });
    assert.equal(result, 'yolo'); // merged allow includes Bash(*) + Write(*)
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
});
