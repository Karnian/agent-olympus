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

test('formatPreflightReport: returns empty string when nothing to report', async () => {
  const { formatPreflightReport } = await import('../../scripts/lib/preflight.mjs');
  assert.equal(formatPreflightReport({ valid: true, actions: [], warnings: [] }), '');
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
