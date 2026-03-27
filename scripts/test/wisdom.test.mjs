/**
 * Unit tests for scripts/lib/wisdom.mjs
 * Uses node:test — zero npm dependencies.
 *
 * Because wisdom.mjs derives WISDOM_PATH from process.cwd() at module
 * evaluation time, we use a dynamic import trick: each test suite that
 * needs an isolated file path imports a fresh module instance by appending
 * a unique query-string cache-buster so Node's ESM cache does not reuse
 * the previously resolved paths.
 *
 * This avoids modifying the source module while still keeping tests
 * idempotent and self-cleaning.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Temp-dir helpers
// ---------------------------------------------------------------------------

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ao-wisdom-test-'));
}

async function removeTmpDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Import a fresh copy of wisdom.mjs with process.cwd() pointed at `cwd`.
 * The cache-buster query string forces Node to re-evaluate the module so
 * that the WISDOM_PATH constant is derived from the new cwd.
 */
async function importWisdomIn(cwd) {
  const original = process.cwd();
  process.chdir(cwd);
  try {
    // Cache-buster: unique per cwd so each temp dir gets its own module instance
    const buster = Buffer.from(cwd).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
    const modPath = new URL(`../lib/wisdom.mjs?cb=${buster}`, import.meta.url).href;
    const mod = await import(modPath);
    return mod;
  } finally {
    process.chdir(original);
  }
}

// ---------------------------------------------------------------------------
// Test: addWisdom then queryWisdom
// ---------------------------------------------------------------------------

test('addWisdom: entry is persisted and queryWisdom returns it', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    await addWisdom({ category: 'test', lesson: 'Always write unit tests before shipping code', confidence: 'high' });

    const results = await queryWisdom('test');
    assert.equal(results.length, 1, 'expected exactly one entry');
    assert.equal(results[0].category, 'test');
    assert.equal(results[0].lesson, 'Always write unit tests before shipping code');
    assert.equal(results[0].confidence, 'high');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test: queryWisdom — category filter
// ---------------------------------------------------------------------------

test('queryWisdom: filters by category correctly', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    await addWisdom({ category: 'build', lesson: 'Run npm ci instead of npm install in CI pipelines' });
    await addWisdom({ category: 'test', lesson: 'Use isolated temp dirs for file I/O tests' });
    await addWisdom({ category: 'build', lesson: 'Cache node_modules between builds for faster CI' });

    const buildResults = await queryWisdom('build');
    assert.equal(buildResults.length, 2, 'expected 2 build entries');
    for (const entry of buildResults) {
      assert.equal(entry.category, 'build');
    }

    const testResults = await queryWisdom('test');
    assert.equal(testResults.length, 1, 'expected 1 test entry');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test: queryWisdom null → all categories
// ---------------------------------------------------------------------------

test('queryWisdom: null category returns all entries', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    await addWisdom({ category: 'build', lesson: 'Use reproducible builds to ensure consistent artifacts' });
    await addWisdom({ category: 'debug', lesson: 'Add structured logging with correlation IDs for tracing' });
    await addWisdom({ category: 'pattern', lesson: 'Prefer composition over inheritance in module design' });

    const all = await queryWisdom(null);
    assert.equal(all.length, 3, 'expected all 3 entries');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test: queryWisdom returns most recent first
// ---------------------------------------------------------------------------

test('queryWisdom: returns entries in most-recent-first order', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    await addWisdom({ category: 'general', lesson: 'First lesson added to the wisdom store' });
    // Small delay to ensure different timestamps
    await new Promise(r => setTimeout(r, 10));
    await addWisdom({ category: 'general', lesson: 'Second lesson added to the wisdom store' });

    const results = await queryWisdom('general');
    assert.equal(results.length, 2);
    // Most recent first: second lesson should appear before first
    assert.ok(
      results[0].lesson.startsWith('Second'),
      `expected "Second..." first, got "${results[0].lesson}"`,
    );
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test: addWisdom deduplication — >80% Jaccard similarity is skipped
// ---------------------------------------------------------------------------

test('addWisdom: near-duplicate lesson (>80% Jaccard) is skipped', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    // These two lessons share 10/11 unique words → Jaccard ≈ 0.91 (> 0.8 threshold)
    const lesson = 'Use dependency injection to decouple modules and improve testability in the application';
    await addWisdom({ category: 'pattern', lesson });

    // "in" → "throughout": same word-set size difference, similarity stays > 0.8
    const duplicate = 'Use dependency injection to decouple modules and improve testability throughout the application';
    await addWisdom({ category: 'pattern', lesson: duplicate });

    const results = await queryWisdom('pattern');
    assert.equal(results.length, 1, 'duplicate should have been skipped — expected 1 entry');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test: addWisdom allows distinct entries
// ---------------------------------------------------------------------------

test('addWisdom: sufficiently different lessons are both stored', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    await addWisdom({ category: 'build', lesson: 'Use npm ci for reproducible dependency installation' });
    await addWisdom({ category: 'build', lesson: 'Configure eslint with strict TypeScript rules for type safety' });

    const results = await queryWisdom('build');
    assert.equal(results.length, 2, 'both distinct lessons should be stored');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test: pruneWisdom keeps at most N entries (most recent)
// ---------------------------------------------------------------------------

test('pruneWisdom: keeps at most N most-recent entries', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, queryWisdom, pruneWisdom } = await importWisdomIn(tmpDir);

    // Add 5 distinct entries (short delays to ensure ordering by append sequence)
    const lessons = [
      'First entry: validate all external inputs at the boundary',
      'Second entry: prefer async iterators for large data streams',
      'Third entry: centralise error handling in middleware layers',
      'Fourth entry: document every public API with jsdoc annotations',
      'Fifth entry: benchmark before and after each optimisation change',
    ];
    for (const lesson of lessons) {
      await addWisdom({ category: 'general', lesson });
      await new Promise(r => setTimeout(r, 5));
    }

    await pruneWisdom(3);

    const remaining = await queryWisdom(null);
    assert.equal(remaining.length, 3, `expected 3 entries after prune, got ${remaining.length}`);

    // The 3 most recent entries should be retained (lessons[2], [3], [4])
    const retainedLessons = remaining.map(e => e.lesson);
    assert.ok(
      retainedLessons.some(l => l.startsWith('Fifth')),
      'fifth (most recent) lesson should be retained',
    );
    assert.ok(
      retainedLessons.some(l => l.startsWith('Fourth')),
      'fourth lesson should be retained',
    );
    assert.ok(
      retainedLessons.some(l => l.startsWith('Third')),
      'third lesson should be retained',
    );
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test: pruneWisdom on empty store is a no-op
// ---------------------------------------------------------------------------

test('pruneWisdom: no-op on empty wisdom store', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { pruneWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    // Should not throw
    await pruneWisdom(10);

    const results = await queryWisdom(null);
    assert.equal(results.length, 0);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test: addWisdom sets default fields when omitted
// ---------------------------------------------------------------------------

test('addWisdom: defaults category to "general" and confidence to "medium"', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    await addWisdom({ lesson: 'Keep functions small and single-purpose for readability' });

    const results = await queryWisdom('general');
    assert.equal(results.length, 1);
    assert.equal(results[0].category, 'general');
    assert.equal(results[0].confidence, 'medium');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test: queryWisdom respects limit parameter
// ---------------------------------------------------------------------------

test('queryWisdom: limit parameter caps the number of results', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    // Use sufficiently distinct lessons so deduplication does not suppress them
    const lessons = [
      'Validate all external inputs at the application boundary',
      'Use async iterators when streaming large datasets from APIs',
      'Centralise error handling in dedicated middleware layers',
      'Document every public function with accurate jsdoc annotations',
      'Benchmark performance before and after each optimisation change',
    ];
    for (const lesson of lessons) {
      await addWisdom({ category: 'performance', lesson });
      await new Promise(r => setTimeout(r, 5));
    }

    const limited = await queryWisdom('performance', 2);
    assert.equal(limited.length, 2, 'limit of 2 should return only 2 entries');
  } finally {
    await removeTmpDir(tmpDir);
  }
});
