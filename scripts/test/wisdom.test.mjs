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

    await addWisdom({ category: 'general', lesson: 'Validate all external inputs at the service boundary before processing' });
    // Small delay to ensure different timestamps
    await new Promise(r => setTimeout(r, 10));
    await addWisdom({ category: 'general', lesson: 'Second ordering check: prefer immutable data structures for shared state' });

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

// ---------------------------------------------------------------------------
// Test: addWisdom stores optional intent field
// ---------------------------------------------------------------------------

test('addWisdom: optional intent field is persisted', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    await addWisdom({
      category: 'architecture',
      lesson: 'Prefer event-driven design for loosely coupled services',
      confidence: 'high',
      intent: 'deep',
    });

    const results = await queryWisdom('architecture');
    assert.equal(results.length, 1);
    assert.equal(results[0].intent, 'deep', 'intent field should be persisted');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test: addWisdom without intent does not store intent field
// ---------------------------------------------------------------------------

test('addWisdom: intent field absent when not provided', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    await addWisdom({ category: 'general', lesson: 'Keep modules small and focused on a single responsibility' });

    const results = await queryWisdom('general');
    assert.equal(results.length, 1);
    assert.ok(!('intent' in results[0]), 'intent field should be absent when not provided');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test: queryWisdom options object — filter by intent
// ---------------------------------------------------------------------------

test('queryWisdom: options object filters by intent', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    await addWisdom({ category: 'architecture', lesson: 'Use CQRS to separate read and write models in complex domains', intent: 'deep' });
    await addWisdom({ category: 'general', lesson: 'Prefer inline documentation for critical business logic', intent: 'writing' });
    await addWisdom({ category: 'pattern', lesson: 'Apply adapter pattern to isolate third-party library boundaries' });

    const deepResults = await queryWisdom({ intent: 'deep' });
    assert.equal(deepResults.length, 1, 'expected 1 entry with intent=deep');
    assert.equal(deepResults[0].intent, 'deep');

    const writingResults = await queryWisdom({ intent: 'writing' });
    assert.equal(writingResults.length, 1, 'expected 1 entry with intent=writing');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test: queryWisdom options object — minConfidence filter
// ---------------------------------------------------------------------------

test('queryWisdom: minConfidence=high returns only high-confidence entries', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    await addWisdom({ category: 'build', lesson: 'Pin all transitive dependencies for deterministic builds', confidence: 'high' });
    await addWisdom({ category: 'build', lesson: 'Consider lock file auditing as part of the release checklist', confidence: 'medium' });
    await addWisdom({ category: 'build', lesson: 'Investigate whether a build cache would speed up CI further', confidence: 'low' });

    const highOnly = await queryWisdom({ minConfidence: 'high' });
    assert.equal(highOnly.length, 1, 'expected only 1 high-confidence entry');
    assert.equal(highOnly[0].confidence, 'high');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('queryWisdom: minConfidence=medium returns medium and high entries', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    await addWisdom({ category: 'test', lesson: 'Always isolate unit tests from the file system using temp directories', confidence: 'high' });
    await addWisdom({ category: 'test', lesson: 'Integration tests should be tagged so they can be skipped in fast mode', confidence: 'medium' });
    await addWisdom({ category: 'test', lesson: 'Explore whether snapshot testing would reduce assertion verbosity', confidence: 'low' });

    const mediumAndAbove = await queryWisdom({ minConfidence: 'medium' });
    assert.equal(mediumAndAbove.length, 2, 'expected 2 entries with confidence medium or above');
    for (const entry of mediumAndAbove) {
      assert.ok(
        entry.confidence === 'medium' || entry.confidence === 'high',
        `unexpected confidence: ${entry.confidence}`,
      );
    }
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('queryWisdom: minConfidence=low returns all entries', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    await addWisdom({ category: 'debug', lesson: 'Add request correlation IDs to all outbound service calls', confidence: 'high' });
    await addWisdom({ category: 'debug', lesson: 'Centralise structured logging configuration in a single module', confidence: 'medium' });
    await addWisdom({ category: 'debug', lesson: 'Experiment with distributed tracing for latency analysis', confidence: 'low' });

    const all = await queryWisdom({ minConfidence: 'low' });
    assert.equal(all.length, 3, 'expected all 3 entries with minConfidence=low');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test: queryWisdom options object — combined category + minConfidence
// ---------------------------------------------------------------------------

test('queryWisdom: options object combines category and minConfidence filters', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    await addWisdom({ category: 'pattern', lesson: 'Use the repository pattern to abstract data access from business logic', confidence: 'high' });
    await addWisdom({ category: 'pattern', lesson: 'Factory functions improve testability compared to direct constructors', confidence: 'low' });
    await addWisdom({ category: 'general', lesson: 'Keep dependencies minimal to reduce supply-chain attack surface', confidence: 'high' });

    const results = await queryWisdom({ category: 'pattern', minConfidence: 'high' });
    assert.equal(results.length, 1, 'expected 1 pattern entry with high confidence');
    assert.equal(results[0].category, 'pattern');
    assert.equal(results[0].confidence, 'high');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test: queryWisdom options object — limit field inside options
// ---------------------------------------------------------------------------

test('queryWisdom: options object limit field caps results', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    const lessons = [
      'Automate dependency updates with Dependabot or Renovate for security patches',
      'Use semantic versioning strictly to signal breaking changes to consumers',
      'Publish a changelog with every release to aid downstream upgrade decisions',
    ];
    for (const lesson of lessons) {
      await addWisdom({ category: 'general', lesson });
      await new Promise(r => setTimeout(r, 5));
    }

    const limited = await queryWisdom({ limit: 2 });
    assert.equal(limited.length, 2, 'options.limit should cap the result to 2');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Test: queryWisdom options object — filePattern filter
// ---------------------------------------------------------------------------

test('queryWisdom: options object filters by filePattern substring', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    await addWisdom({
      category: 'build',
      lesson: 'Always run linting as a pre-commit hook to catch issues early',
      filePatterns: ['scripts/*.mjs', '.eslintrc.json'],
    });
    await addWisdom({
      category: 'test',
      lesson: 'Use isolated temp dirs for each test to prevent cross-test pollution',
      filePatterns: ['scripts/test/**/*.test.mjs'],
    });
    await addWisdom({
      category: 'general',
      lesson: 'Document module boundaries clearly in the project CLAUDE.md file',
    });

    const scriptResults = await queryWisdom({ filePattern: 'scripts/' });
    assert.equal(scriptResults.length, 2, 'expected 2 entries with filePattern matching "scripts/"');

    const testResults = await queryWisdom({ filePattern: '.test.mjs' });
    assert.equal(testResults.length, 1, 'expected 1 entry with filePattern matching ".test.mjs"');

    const noResults = await queryWisdom({ filePattern: 'nonexistent/' });
    assert.equal(noResults.length, 0, 'expected 0 entries for non-matching filePattern');
  } finally {
    await removeTmpDir(tmpDir);
  }
});
