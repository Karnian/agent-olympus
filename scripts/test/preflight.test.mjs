/**
 * Unit tests for scripts/lib/preflight.mjs
 * Uses node:test — zero npm dependencies.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ao-preflight-test-'));
}

async function removeTmpDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Import preflight with cwd set to tmpDir.
 * preflight.mjs uses relative paths like '.ao/state'.
 */
async function importPreflight(cwd) {
  const origCwd = process.cwd();
  process.chdir(cwd);
  try {
    const cacheBuster = `?t=${Date.now()}-${Math.random()}`;
    const mod = await import(`../../scripts/lib/preflight.mjs${cacheBuster}`);
    return mod;
  } finally {
    process.chdir(origCwd);
  }
}

// ---------------------------------------------------------------------------
// detectPointerFile
// ---------------------------------------------------------------------------

test('detectPointerFile: detects "# Pointer" pattern', async () => {
  const { detectPointerFile } = await import('../../scripts/lib/preflight.mjs');
  const content = '# Pointer — Agent Session Enhancement Spec\nCanonical: docs/specs/AGENT_SESSION_ENHANCEMENT.md';
  const result = detectPointerFile(content);
  assert.equal(result.isPointer, true);
  assert.equal(result.target, 'docs/specs/AGENT_SESSION_ENHANCEMENT.md');
});

test('detectPointerFile: detects bare file path', async () => {
  const { detectPointerFile } = await import('../../scripts/lib/preflight.mjs');
  const result = detectPointerFile('docs/specs/FOO.md');
  assert.equal(result.isPointer, true);
  assert.equal(result.target, 'docs/specs/FOO.md');
});

test('detectPointerFile: detects JSON pointer', async () => {
  const { detectPointerFile } = await import('../../scripts/lib/preflight.mjs');
  const content = JSON.stringify({ canonical: 'docs/plans/foo/prd.json', version: 1 });
  const result = detectPointerFile(content);
  assert.equal(result.isPointer, true);
  assert.equal(result.target, 'docs/plans/foo/prd.json');
});

test('detectPointerFile: returns false for real spec content', async () => {
  const { detectPointerFile } = await import('../../scripts/lib/preflight.mjs');
  const content = `# User Auth Spec\n\n## Problem Statement\nUsers need authentication.\n\n## Goals\n- Secure login\n- OAuth support\n\n## User Stories\n\n### US-001: Login\nAs a user I want to log in.`;
  const result = detectPointerFile(content);
  assert.equal(result.isPointer, false);
});

test('detectPointerFile: returns false for null/empty', async () => {
  const { detectPointerFile } = await import('../../scripts/lib/preflight.mjs');
  assert.equal(detectPointerFile(null).isPointer, false);
  assert.equal(detectPointerFile('').isPointer, false);
  assert.equal(detectPointerFile(undefined).isPointer, false);
});

test('detectPointerFile: returns false for large JSON (real prd.json)', async () => {
  const { detectPointerFile } = await import('../../scripts/lib/preflight.mjs');
  const prd = JSON.stringify({
    projectName: 'auth-system',
    scale: 'M',
    userStories: [{ id: 'US-001', title: 'Login' }],
    goals: ['Secure auth'],
  });
  assert.equal(detectPointerFile(prd).isPointer, false);
});

// ---------------------------------------------------------------------------
// cleanStalePointers
// ---------------------------------------------------------------------------

test('cleanStalePointers: removes pointer spec.md and prd.json', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const aoDir = path.join(tmpDir, '.ao');
    await fs.mkdir(aoDir, { recursive: true });
    await fs.writeFile(path.join(aoDir, 'spec.md'), '# Pointer — Old\nCanonical: docs/old.md');
    await fs.writeFile(path.join(aoDir, 'prd.json'), '{"canonical": "docs/old.json"}');

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const { cleanStalePointers } = await import(`../../scripts/lib/preflight.mjs?clean-${Date.now()}`);
      const cleaned = await cleanStalePointers();
      assert.equal(cleaned.length, 2);

      // Files should be gone
      await assert.rejects(fs.access(path.join(aoDir, 'spec.md')));
      await assert.rejects(fs.access(path.join(aoDir, 'prd.json')));
    } finally {
      process.chdir(origCwd);
    }
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('cleanStalePointers: leaves real spec files intact', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const aoDir = path.join(tmpDir, '.ao');
    await fs.mkdir(aoDir, { recursive: true });
    const realSpec = '# Auth Spec\n\n## Problem\nNeed auth.\n\n## Goals\n- Login\n- OAuth\n\n## Stories\n### US-001\nAs a user...';
    await fs.writeFile(path.join(aoDir, 'spec.md'), realSpec);

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const { cleanStalePointers } = await import(`../../scripts/lib/preflight.mjs?real-${Date.now()}`);
      const cleaned = await cleanStalePointers();
      assert.equal(cleaned.length, 0);

      // File should still exist
      const content = await fs.readFile(path.join(aoDir, 'spec.md'), 'utf-8');
      assert.equal(content, realSpec);
    } finally {
      process.chdir(origCwd);
    }
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// runPreflight
// ---------------------------------------------------------------------------

test('runPreflight: cleans expired checkpoints', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const stateDir = path.join(tmpDir, '.ao', 'state');
    await fs.mkdir(stateDir, { recursive: true });

    // Write an expired checkpoint (25h old)
    const expiredCp = {
      orchestrator: 'atlas',
      phase: 1,
      savedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    };
    await fs.writeFile(
      path.join(stateDir, 'checkpoint-atlas.json'),
      JSON.stringify(expiredCp),
    );

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const { runPreflight } = await import(`../../scripts/lib/preflight.mjs?expire-${Date.now()}`);
      const report = await runPreflight();
      assert.ok(report.actions.some(a => a.includes('Expired checkpoint')));
      await assert.rejects(fs.access(path.join(stateDir, 'checkpoint-atlas.json')));
    } finally {
      process.chdir(origCwd);
    }
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('runPreflight: keeps fresh checkpoints', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const stateDir = path.join(tmpDir, '.ao', 'state');
    await fs.mkdir(stateDir, { recursive: true });

    const freshCp = {
      orchestrator: 'athena',
      phase: 2,
      savedAt: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(stateDir, 'checkpoint-athena.json'),
      JSON.stringify(freshCp),
    );

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const { runPreflight } = await import(`../../scripts/lib/preflight.mjs?fresh-${Date.now()}`);
      const report = await runPreflight();
      assert.ok(!report.actions.some(a => a.includes('Expired checkpoint')));
      // File should still exist
      await fs.access(path.join(stateDir, 'checkpoint-athena.json'));
    } finally {
      process.chdir(origCwd);
    }
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('runPreflight: warns about orphaned team state', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const stateDir = path.join(tmpDir, '.ao', 'state');
    await fs.mkdir(stateDir, { recursive: true });

    const orphanedTeam = {
      teamName: 'athena-old',
      phase: 'running',
      startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      workers: [],
    };
    await fs.writeFile(
      path.join(stateDir, 'team-athena-old.json'),
      JSON.stringify(orphanedTeam),
    );

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const { runPreflight } = await import(`../../scripts/lib/preflight.mjs?orphan-${Date.now()}`);
      const report = await runPreflight();
      assert.ok(report.warnings.some(w => w.includes('orphaned')));
    } finally {
      process.chdir(origCwd);
    }
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('runPreflight: returns valid:true when .ao/ does not exist', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const { runPreflight } = await import(`../../scripts/lib/preflight.mjs?empty-${Date.now()}`);
      const report = await runPreflight();
      assert.equal(report.valid, true);
      assert.equal(report.actions.length, 0);
      assert.equal(report.warnings.length, 0);
    } finally {
      process.chdir(origCwd);
    }
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// formatPreflightReport
// ---------------------------------------------------------------------------

test('formatPreflightReport: returns empty string when nothing to report and no capabilities', async () => {
  const { formatPreflightReport } = await import('../../scripts/lib/preflight.mjs');
  assert.equal(formatPreflightReport({ valid: true, actions: [], warnings: [] }), '');
});

test('formatPreflightReport: returns capability report even with no actions/warnings', async () => {
  const { formatPreflightReport } = await import('../../scripts/lib/preflight.mjs');
  const result = formatPreflightReport({
    valid: true, actions: [], warnings: [],
    capabilities: { hasTmux: true, hasCodex: false, hasGitWorktree: true, hasNativeTeamTools: true, hasPreviewMCP: false }
  });
  assert.ok(result.length > 0, 'should include capability report');
  assert.ok(result.includes('tmux'), 'should mention tmux');
});

test('formatPreflightReport: formats actions and warnings', async () => {
  const { formatPreflightReport } = await import('../../scripts/lib/preflight.mjs');
  const report = {
    valid: false,
    actions: ['Removed pointer: .ao/spec.md'],
    warnings: ['Orphaned team: team-old.json'],
  };
  const formatted = formatPreflightReport(report);
  assert.ok(formatted.includes('Removed pointer'));
  assert.ok(formatted.includes('Orphaned team'));
});

// ---------------------------------------------------------------------------
// detectCapabilities
// ---------------------------------------------------------------------------

test('detectCapabilities: returns object with all boolean fields', async () => {
  const { detectCapabilities } = await import('../../scripts/lib/preflight.mjs');
  const caps = await detectCapabilities();
  assert.ok(typeof caps === 'object' && caps !== null);
  for (const key of ['hasTmux', 'hasCodex', 'hasCodexExecJson', 'hasCodexAppServer', 'hasClaudeCli', 'hasGeminiCli', 'hasGeminiAcp', 'hasGitWorktree', 'hasNativeTeamTools', 'hasPreviewMCP']) {
    assert.ok(typeof caps[key] === 'boolean', `${key} should be boolean`);
  }
});

test('detectCapabilities: hasNativeTeamTools follows CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS env var', async () => {
  const { execFileSync } = await import('node:child_process');
  // Isolate cwd so we don't pick up the project's .ao/autonomy.json (which may have nativeTeams:true)
  const tmpDir = await makeTmpDir();
  try {
    const preflightUrl = new URL('../../scripts/lib/preflight.mjs', import.meta.url).href;
    const script = `const mod = await import(${JSON.stringify(preflightUrl)}); const caps = await mod.detectCapabilities(); console.log(JSON.stringify({ hasNativeTeamTools: caps.hasNativeTeamTools }));`;

    // With env var set to '1' → true
    const out1 = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
      encoding: 'utf-8',
      cwd: tmpDir,
    });
    assert.equal(JSON.parse(out1.trim()).hasNativeTeamTools, true);

    // With env var unset → false
    const env2 = { ...process.env };
    delete env2.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    const out2 = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: env2,
      encoding: 'utf-8',
      cwd: tmpDir,
    });
    assert.equal(JSON.parse(out2.trim()).hasNativeTeamTools, false);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('detectCapabilities: hasNativeTeamTools true when .ao/autonomy.json has nativeTeams:true (no env var)', async () => {
  const { execFileSync } = await import('node:child_process');
  const tmpDir = await makeTmpDir();
  try {
    // Create .ao/autonomy.json with nativeTeams: true
    await fs.mkdir(path.join(tmpDir, '.ao'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.ao', 'autonomy.json'), JSON.stringify({ nativeTeams: true }));

    const preflightUrl = new URL('../../scripts/lib/preflight.mjs', import.meta.url).href;
    const script = `const mod = await import(${JSON.stringify(preflightUrl)}); const caps = await mod.detectCapabilities(); console.log(JSON.stringify({ hasNativeTeamTools: caps.hasNativeTeamTools }));`;

    // No env var, but autonomy.json has nativeTeams: true
    const env = { ...process.env };
    delete env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env,
      encoding: 'utf-8',
      cwd: tmpDir,
    });
    assert.equal(JSON.parse(out.trim()).hasNativeTeamTools, true);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('detectCapabilities: handles command failures gracefully (all binary checks return boolean)', async () => {
  const { detectCapabilities } = await import('../../scripts/lib/preflight.mjs');
  // Even if binaries are missing, the function should never throw
  const caps = await detectCapabilities();
  // All fields must be booleans regardless of environment
  for (const key of ['hasTmux', 'hasCodex', 'hasCodexExecJson', 'hasCodexAppServer', 'hasClaudeCli', 'hasGeminiCli', 'hasGeminiAcp', 'hasGitWorktree', 'hasNativeTeamTools', 'hasPreviewMCP']) {
    assert.ok(typeof caps[key] === 'boolean', `${key} should be boolean`);
  }
});

// ---------------------------------------------------------------------------
// formatCapabilityReport
// ---------------------------------------------------------------------------

test('formatCapabilityReport: formats ✓ for true capabilities', async () => {
  const { formatCapabilityReport } = await import('../../scripts/lib/preflight.mjs');
  const caps = { hasTmux: true, hasCodex: true, hasClaudeCli: true, hasGeminiCli: true, hasGitWorktree: true, hasNativeTeamTools: true, hasPreviewMCP: true };
  const report = formatCapabilityReport(caps);
  // All 7 entries should show ✓
  const checkmarks = (report.match(/✓/g) || []).length;
  assert.equal(checkmarks, 7);
});

test('formatCapabilityReport: formats ✗ for false capabilities', async () => {
  const { formatCapabilityReport } = await import('../../scripts/lib/preflight.mjs');
  const caps = { hasTmux: false, hasCodex: false, hasClaudeCli: false, hasGeminiCli: false, hasGitWorktree: false, hasNativeTeamTools: false, hasPreviewMCP: false };
  const report = formatCapabilityReport(caps);
  // All 7 entries should show ✗
  const crosses = (report.match(/✗/g) || []).length;
  assert.equal(crosses, 7);
});

test('formatCapabilityReport: includes all 7 capability names', async () => {
  const { formatCapabilityReport } = await import('../../scripts/lib/preflight.mjs');
  const caps = { hasTmux: true, hasCodex: false, hasClaudeCli: true, hasGeminiCli: false, hasGitWorktree: true, hasNativeTeamTools: true, hasPreviewMCP: false };
  const report = formatCapabilityReport(caps);
  assert.ok(report.includes('tmux'), 'should mention tmux');
  assert.ok(report.includes('codex'), 'should mention codex');
  assert.ok(report.includes('claude-cli'), 'should mention claude-cli');
  assert.ok(report.includes('gemini-cli'), 'should mention gemini-cli');
  assert.ok(report.includes('git worktree'), 'should mention git worktree');
  assert.ok(report.includes('Native Agent Teams'), 'should mention Native Agent Teams');
  assert.ok(report.includes('preview MCP'), 'should mention preview MCP');
});

// ---------------------------------------------------------------------------
// runPreflight — capabilities field
// ---------------------------------------------------------------------------

test('runPreflight: includes capabilities field in result', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const { runPreflight } = await import(`../../scripts/lib/preflight.mjs?caps-${Date.now()}`);
      const report = await runPreflight();
      assert.ok('capabilities' in report, 'report should have capabilities field');
      assert.ok(typeof report.capabilities === 'object' && report.capabilities !== null);
      assert.ok(typeof report.capabilities.hasNativeTeamTools === 'boolean');
    } finally {
      process.chdir(origCwd);
    }
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('formatPreflightReport: includes capability report when capabilities present alongside actions', async () => {
  const { formatPreflightReport } = await import('../../scripts/lib/preflight.mjs');
  const report = {
    valid: true,
    // Capabilities are appended when there are actions or warnings to report
    actions: ['Removed stale pointer: .ao/spec.md'],
    warnings: [],
    capabilities: { hasTmux: true, hasCodex: false, hasClaudeCli: false, hasGeminiCli: false, hasGitWorktree: true, hasNativeTeamTools: true, hasPreviewMCP: false },
  };
  const formatted = formatPreflightReport(report);
  assert.ok(formatted.includes('[Capabilities] Capabilities:'), 'should include Capabilities header');
  assert.ok(formatted.includes('tmux'), 'should include tmux capability');
  assert.ok(formatted.includes('Native Agent Teams'), 'should include Native Agent Teams capability');
});

test('formatPreflightReport: uses orchestrator name when opts provided', async () => {
  const { formatPreflightReport } = await import('../../scripts/lib/preflight.mjs');
  const report = {
    valid: true,
    actions: ['Removed stale pointer: .ao/spec.md'],
    warnings: ['Orphaned team: team-old.json'],
    capabilities: { hasTmux: true, hasCodex: false, hasClaudeCli: false, hasGeminiCli: false, hasGitWorktree: true, hasNativeTeamTools: true, hasPreviewMCP: false },
  };
  const formatted = formatPreflightReport(report, { orchestrator: 'Athena' });
  assert.ok(formatted.includes('[Athena] Preflight actions:'), 'actions should have [Athena] prefix');
  assert.ok(formatted.includes('[Athena] Preflight warnings:'), 'warnings should have [Athena] prefix');
  assert.ok(formatted.includes('[Athena] Capabilities:'), 'capabilities should have [Athena] header');
});

test('formatCapabilityReport: uses orchestrator name when opts provided', async () => {
  const { formatCapabilityReport } = await import('../../scripts/lib/preflight.mjs');
  const caps = { hasTmux: true, hasCodex: false, hasClaudeCli: false, hasGeminiCli: false, hasGitWorktree: true, hasNativeTeamTools: true, hasPreviewMCP: false };
  const report = formatCapabilityReport(caps, { orchestrator: 'Atlas' });
  assert.ok(report.startsWith('[Atlas] Capabilities:'), 'should start with [Atlas] Capabilities:');
});

// ---------------------------------------------------------------------------
// meetsMinVersion
// ---------------------------------------------------------------------------

test('meetsMinVersion: returns true for version exactly at minimum', async () => {
  const { meetsMinVersion } = await import('../../scripts/lib/preflight.mjs');
  assert.equal(meetsMinVersion('0.116.0', 0, 116, 0), true);
});

test('meetsMinVersion: returns true for version above minimum (higher minor)', async () => {
  const { meetsMinVersion } = await import('../../scripts/lib/preflight.mjs');
  assert.equal(meetsMinVersion('0.117.0', 0, 116, 0), true);
});

test('meetsMinVersion: returns true for version above minimum (higher patch)', async () => {
  const { meetsMinVersion } = await import('../../scripts/lib/preflight.mjs');
  assert.equal(meetsMinVersion('0.116.5', 0, 116, 0), true);
});

test('meetsMinVersion: returns false for version below minimum (lower minor)', async () => {
  const { meetsMinVersion } = await import('../../scripts/lib/preflight.mjs');
  assert.equal(meetsMinVersion('0.115.9', 0, 116, 0), false);
});

test('meetsMinVersion: returns false for version below minimum (lower patch)', async () => {
  const { meetsMinVersion } = await import('../../scripts/lib/preflight.mjs');
  assert.equal(meetsMinVersion('0.115.0', 0, 116, 0), false);
});

test('meetsMinVersion: parses "codex-cli 0.116.0" format correctly', async () => {
  const { meetsMinVersion } = await import('../../scripts/lib/preflight.mjs');
  assert.equal(meetsMinVersion('codex-cli 0.116.0', 0, 116, 0), true);
});

test('meetsMinVersion: parses "codex-cli 0.115.9" format and returns false', async () => {
  const { meetsMinVersion } = await import('../../scripts/lib/preflight.mjs');
  assert.equal(meetsMinVersion('codex-cli 0.115.9', 0, 116, 0), false);
});

test('meetsMinVersion: returns false for invalid/empty string', async () => {
  const { meetsMinVersion } = await import('../../scripts/lib/preflight.mjs');
  assert.equal(meetsMinVersion('', 0, 116, 0), false);
  assert.equal(meetsMinVersion('not-a-version', 0, 116, 0), false);
  assert.equal(meetsMinVersion(null, 0, 116, 0), false);
  assert.equal(meetsMinVersion(undefined, 0, 116, 0), false);
});

test('meetsMinVersion: returns true when major is higher than minimum', async () => {
  const { meetsMinVersion } = await import('../../scripts/lib/preflight.mjs');
  assert.equal(meetsMinVersion('1.0.0', 0, 116, 0), true);
});

// ---------------------------------------------------------------------------
// detectCapabilities — hasCodexExecJson field
// ---------------------------------------------------------------------------

test('detectCapabilities: returns hasCodexExecJson as boolean', async () => {
  const { detectCapabilities } = await import('../../scripts/lib/preflight.mjs');
  const caps = await detectCapabilities();
  assert.ok(typeof caps.hasCodexExecJson === 'boolean', 'hasCodexExecJson must be a boolean');
});

test('detectCapabilities: hasCodexExecJson is false when codex is not installed', async () => {
  // This test verifies fail-safe behaviour — if codex throws, hasCodexExecJson must be false.
  // We cannot easily mock execFileSync here, so we verify the invariant: if hasCodex is false,
  // hasCodexExecJson must also be false (cannot have json support without the binary).
  const { detectCapabilities } = await import('../../scripts/lib/preflight.mjs');
  const caps = await detectCapabilities();
  if (!caps.hasCodex) {
    assert.equal(caps.hasCodexExecJson, false, 'hasCodexExecJson must be false when codex is absent');
  }
});

test('detectCapabilities: handles all binary fields including hasCodexExecJson as booleans', async () => {
  const { detectCapabilities } = await import('../../scripts/lib/preflight.mjs');
  const caps = await detectCapabilities();
  const allFields = ['hasTmux', 'hasCodex', 'hasCodexExecJson', 'hasCodexAppServer', 'hasClaudeCli', 'hasGeminiCli', 'hasGeminiAcp', 'hasGitWorktree', 'hasNativeTeamTools', 'hasPreviewMCP'];
  for (const key of allFields) {
    assert.ok(typeof caps[key] === 'boolean', `${key} should be boolean`);
  }
});
