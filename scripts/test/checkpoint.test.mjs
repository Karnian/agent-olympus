/**
 * Unit tests for scripts/lib/checkpoint.mjs
 * Uses node:test — zero npm dependencies.
 *
 * checkpoint.mjs resolves STATE_DIR relative to process.cwd() at module
 * evaluation time. We use the same dynamic import + cache-buster pattern
 * as wisdom.test.mjs so each test gets an isolated temp directory.
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
  return fs.mkdtemp(path.join(os.tmpdir(), 'ao-checkpoint-test-'));
}

async function removeTmpDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Import a fresh copy of checkpoint.mjs and return wrapped functions that
 * execute with process.cwd() set to `cwd`.
 *
 * STATE_DIR in checkpoint.mjs is `path.join('.ao', 'state')` — a relative
 * path resolved at call time (not at module load time).  To keep each test
 * isolated we must ensure process.cwd() equals the temp dir whenever any
 * checkpoint function is invoked.
 *
 * The cache-buster on the module URL ensures Node re-evaluates the module
 * for each unique cwd, preventing cross-test contamination from module-level
 * state.
 */
async function importCheckpointIn(cwd) {
  const buster = Buffer.from(cwd).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
  const modPath = new URL(`../lib/checkpoint.mjs?cb=${buster}`, import.meta.url).href;
  const mod = await import(modPath);

  // Wrap every exported function so it runs with cwd set to the temp dir
  function withCwd(fn) {
    return async (...args) => {
      const original = process.cwd();
      process.chdir(cwd);
      try {
        return await fn(...args);
      } finally {
        process.chdir(original);
      }
    };
  }

  return {
    saveCheckpoint: withCwd(mod.saveCheckpoint),
    loadCheckpoint: withCwd(mod.loadCheckpoint),
    clearCheckpoint: withCwd(mod.clearCheckpoint),
    formatCheckpoint: mod.formatCheckpoint, // pure function, no cwd dependency
  };
}

// ---------------------------------------------------------------------------
// Test: saveCheckpoint + loadCheckpoint round-trip
// ---------------------------------------------------------------------------

test('saveCheckpoint + loadCheckpoint: round-trip returns correct data', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { saveCheckpoint, loadCheckpoint } = await importCheckpointIn(tmpDir);

    await saveCheckpoint('atlas', {
      phase: 2,
      taskDescription: 'Implement login feature',
      completedStories: ['US-1'],
    });

    const checkpoint = await loadCheckpoint('atlas');
    assert.ok(checkpoint !== null, 'expected a checkpoint to be returned');
    assert.equal(checkpoint.orchestrator, 'atlas');
    assert.equal(checkpoint.phase, 2);
    assert.equal(checkpoint.taskDescription, 'Implement login feature');
    assert.deepEqual(checkpoint.completedStories, ['US-1']);
    assert.ok(typeof checkpoint.savedAt === 'string', 'savedAt should be an ISO string');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test: loadCheckpoint returns null when no file exists
// ---------------------------------------------------------------------------

test('loadCheckpoint: returns null when no checkpoint file exists', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { loadCheckpoint } = await importCheckpointIn(tmpDir);
    const result = await loadCheckpoint('atlas');
    assert.equal(result, null);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test: expired checkpoint (age > 24h) returns null and deletes file
// ---------------------------------------------------------------------------

test('loadCheckpoint: expired checkpoint (>24h old) returns null', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { saveCheckpoint, loadCheckpoint } = await importCheckpointIn(tmpDir);

    // Save a checkpoint then manually backdate the savedAt field
    await saveCheckpoint('athena', { phase: 1 });

    // The file is written to <tmpDir>/.ao/state/checkpoint-athena.json
    const stateDir = path.join(tmpDir, '.ao', 'state');
    const filePath = path.join(stateDir, 'checkpoint-athena.json');
    const raw = await fs.readFile(filePath, 'utf-8');
    const checkpoint = JSON.parse(raw);

    // Backdate by 25 hours (past the 24h TTL)
    const expired = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    checkpoint.savedAt = expired;
    // Write directly (not via atomic helper) so we keep the path predictable
    await fs.writeFile(filePath, JSON.stringify(checkpoint), 'utf-8');

    const result = await loadCheckpoint('athena');
    assert.equal(result, null, 'expired checkpoint should return null');

    // File should have been deleted by loadCheckpoint
    const exists = await fs.access(filePath).then(() => true).catch(() => false);
    assert.equal(exists, false, 'expired checkpoint file should be deleted');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test: clearCheckpoint removes the file
// ---------------------------------------------------------------------------

test('clearCheckpoint: removes checkpoint file, subsequent load returns null', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { saveCheckpoint, loadCheckpoint, clearCheckpoint } = await importCheckpointIn(tmpDir);

    await saveCheckpoint('atlas', { phase: 3 });

    // Confirm it was saved
    const before = await loadCheckpoint('atlas');
    assert.ok(before !== null, 'checkpoint should exist before clear');

    // Clear and verify
    await clearCheckpoint('atlas');
    const after = await loadCheckpoint('atlas');
    assert.equal(after, null, 'loadCheckpoint should return null after clearCheckpoint');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test: clearCheckpoint is a no-op when no file exists
// ---------------------------------------------------------------------------

test('clearCheckpoint: no-op when checkpoint file does not exist', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { clearCheckpoint } = await importCheckpointIn(tmpDir);
    // Should not throw
    await assert.doesNotReject(async () => clearCheckpoint('atlas'));
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test: atlas and athena checkpoints are independent
// ---------------------------------------------------------------------------

test('saveCheckpoint: atlas and athena checkpoints are stored independently', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { saveCheckpoint, loadCheckpoint } = await importCheckpointIn(tmpDir);

    await saveCheckpoint('atlas', { phase: 4, taskDescription: 'atlas task' });
    await saveCheckpoint('athena', { phase: 2, taskDescription: 'athena task' });

    const atlas = await loadCheckpoint('atlas');
    const athena = await loadCheckpoint('athena');

    assert.equal(atlas.taskDescription, 'atlas task');
    assert.equal(athena.taskDescription, 'athena task');
    assert.equal(atlas.phase, 4);
    assert.equal(athena.phase, 2);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test: formatCheckpoint produces human-readable string
// ---------------------------------------------------------------------------

test('formatCheckpoint: returns a non-empty string with phase info', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { formatCheckpoint } = await importCheckpointIn(tmpDir);

    const checkpoint = {
      orchestrator: 'atlas',
      phase: 3,
      savedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedStories: ['US-1', 'US-2'],
      prdSnapshot: { userStories: ['US-1', 'US-2', 'US-3'] },
    };

    const result = formatCheckpoint(checkpoint);
    assert.ok(typeof result === 'string', 'formatCheckpoint should return a string');
    assert.ok(result.length > 0, 'result should not be empty');
    assert.ok(result.includes('3'), 'result should mention the phase number');
  } finally {
    await removeTmpDir(tmpDir);
  }
});
