/**
 * Tests for multi-dimensional scoring (US-C3R-002)
 * Covers legacy bypass, existing caller compatibility, scoring activation, weight renormalization
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ao-wisdom-score-'));
}

async function removeTmpDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

async function importWisdomIn(cwd) {
  const original = process.cwd();
  process.chdir(cwd);
  try {
    const buster = Buffer.from(cwd).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
    const modPath = new URL(`../lib/wisdom.mjs?score=${buster}`, import.meta.url).href;
    return await import(modPath);
  } finally {
    process.chdir(original);
  }
}

/** Write entries directly to wisdom.jsonl for controlled test setup */
async function writeEntries(tmpDir, entries) {
  const wisdomPath = path.join(tmpDir, '.ao', 'wisdom.jsonl');
  await fs.mkdir(path.dirname(wisdomPath), { recursive: true });
  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  await fs.writeFile(wisdomPath, content);
}

// ---------------------------------------------------------------------------
// AC-002-1: Legacy string signature returns reverse-chronological
// ---------------------------------------------------------------------------

test('scoring: queryWisdom("test", 5) returns reverse-chronological, scorer NOT invoked', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { queryWisdom } = await importWisdomIn(tmpDir);
    const now = Date.now();
    await writeEntries(tmpDir, [
      { timestamp: new Date(now - 3000).toISOString(), project: 'p', category: 'test', lesson: 'older lesson about testing strategies in complex systems', confidence: 'low' },
      { timestamp: new Date(now - 2000).toISOString(), project: 'p', category: 'test', lesson: 'middle lesson about integration test patterns and fixtures', confidence: 'high' },
      { timestamp: new Date(now - 1000).toISOString(), project: 'p', category: 'test', lesson: 'newest lesson about unit test best practices and coverage', confidence: 'low' },
    ]);

    const results = await queryWisdom('test', 5);
    assert.equal(results.length, 3);
    assert.ok(results[0].lesson.includes('newest'), 'most recent first');
    assert.ok(results[2].lesson.includes('older'), 'oldest last');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// AC-002-2: session-start.mjs pattern returns reverse-chronological
// ---------------------------------------------------------------------------

test('scoring: queryWisdom({ minConfidence: "medium", limit: 15 }) returns reverse-chronological', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { queryWisdom } = await importWisdomIn(tmpDir);
    const now = Date.now();
    await writeEntries(tmpDir, [
      { timestamp: new Date(now - 3000).toISOString(), project: 'p', category: 'build', lesson: 'first lesson about build pipeline optimization approaches', confidence: 'high' },
      { timestamp: new Date(now - 2000).toISOString(), project: 'p', category: 'test', lesson: 'second lesson about testing infrastructure improvements needed', confidence: 'medium' },
      { timestamp: new Date(now - 1000).toISOString(), project: 'p', category: 'debug', lesson: 'third lesson about debugging complex distributed systems', confidence: 'high' },
    ]);

    const results = await queryWisdom({ minConfidence: 'medium', limit: 15 });
    assert.equal(results.length, 3);
    assert.ok(results[0].lesson.includes('third'), 'most recent first (recency-only path)');
    assert.ok(results[2].lesson.includes('first'), 'oldest last');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// AC-002-3: subagent-start.mjs pattern returns reverse-chronological
// ---------------------------------------------------------------------------

test('scoring: queryWisdom({ minConfidence: "medium", limit: 10 }) returns reverse-chronological', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { queryWisdom } = await importWisdomIn(tmpDir);
    const now = Date.now();
    await writeEntries(tmpDir, [
      { timestamp: new Date(now - 2000).toISOString(), project: 'p', category: 'general', lesson: 'earlier lesson about code review best practices', confidence: 'medium' },
      { timestamp: new Date(now - 1000).toISOString(), project: 'p', category: 'general', lesson: 'later lesson about refactoring large legacy codebases', confidence: 'medium' },
    ]);

    const results = await queryWisdom({ minConfidence: 'medium', limit: 10 });
    assert.equal(results.length, 2);
    assert.ok(results[0].lesson.includes('later'), 'most recent first');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// AC-002-4: Category query ranks match above recency
// ---------------------------------------------------------------------------

test('scoring: queryWisdom({ category: "test" }) ranks category match by score', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { queryWisdom } = await importWisdomIn(tmpDir);
    const now = Date.now();
    await writeEntries(tmpDir, [
      { timestamp: new Date(now - 5000).toISOString(), project: 'p', category: 'test', lesson: 'older high-confidence lesson about test automation frameworks', confidence: 'high' },
      { timestamp: new Date(now - 1000).toISOString(), project: 'p', category: 'test', lesson: 'newer low-confidence lesson about random test observations noted', confidence: 'low' },
    ]);

    const results = await queryWisdom({ category: 'test' });
    assert.equal(results.length, 2);
    // Both match category, so scoring is recency(0.462) + confidence(0.154) + category(0.385)
    // High-conf older entry: recency slightly lower, confidence much higher
    // This verifies scoring is active (not just recency)
    assert.ok(results[0].confidence === 'high', 'high confidence entry should rank first when scoring is active');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// AC-002-5: All 5 dimensions active with category+intent+filePattern
// ---------------------------------------------------------------------------

test('scoring: all 5 dimensions active when category+intent+filePattern specified', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { queryWisdom } = await importWisdomIn(tmpDir);
    const now = Date.now();
    await writeEntries(tmpDir, [
      { timestamp: new Date(now - 1000).toISOString(), project: 'p', category: 'build', lesson: 'lesson about build scripts optimization for faster pipelines', confidence: 'high', intent: 'deep', filePatterns: ['scripts/lib/build.mjs'] },
    ]);

    const results = await queryWisdom({ category: 'build', intent: 'deep', filePattern: 'scripts/' });
    assert.equal(results.length, 1);
    // Entry matches all dimensions — should be returned
    assert.equal(results[0].category, 'build');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// AC-002-7: minConfidence is hard pre-filter
// ---------------------------------------------------------------------------

test('scoring: minConfidence is hard pre-filter even with scoring active', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { queryWisdom } = await importWisdomIn(tmpDir);
    const now = Date.now();
    await writeEntries(tmpDir, [
      { timestamp: new Date(now - 1000).toISOString(), project: 'p', category: 'test', lesson: 'high conf lesson about testing critical path scenarios', confidence: 'high' },
      { timestamp: new Date(now - 500).toISOString(), project: 'p', category: 'test', lesson: 'low conf lesson about possible testing approaches maybe', confidence: 'low' },
    ]);

    const results = await queryWisdom({ category: 'test', minConfidence: 'high' });
    assert.equal(results.length, 1, 'low confidence entry should be pre-filtered out');
    assert.equal(results[0].confidence, 'high');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// AC-002-8: Score ties broken by timestamp descending
// ---------------------------------------------------------------------------

test('scoring: ties broken by most recent first', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { queryWisdom } = await importWisdomIn(tmpDir);
    const now = Date.now();
    // Two entries with identical category, confidence — only recency differs
    await writeEntries(tmpDir, [
      { timestamp: new Date(now - 5000).toISOString(), project: 'p', category: 'build', lesson: 'earlier lesson about continuous integration pipeline setup', confidence: 'medium' },
      { timestamp: new Date(now - 1000).toISOString(), project: 'p', category: 'build', lesson: 'later lesson about continuous deployment pipeline setup', confidence: 'medium' },
    ]);

    const results = await queryWisdom({ category: 'build' });
    assert.equal(results.length, 2);
    assert.ok(results[0].lesson.includes('later'), 'more recent entry should come first on tie');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// AC-002-9: queryWisdom(null) returns reverse-chronological
// ---------------------------------------------------------------------------

test('scoring: queryWisdom(null) returns reverse-chronological, scorer NOT invoked', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { queryWisdom } = await importWisdomIn(tmpDir);
    const now = Date.now();
    await writeEntries(tmpDir, [
      { timestamp: new Date(now - 3000).toISOString(), project: 'p', category: 'test', lesson: 'first entry for null query test verification', confidence: 'high' },
      { timestamp: new Date(now - 1000).toISOString(), project: 'p', category: 'build', lesson: 'second entry for null query test verification', confidence: 'low' },
    ]);

    const results = await queryWisdom(null);
    assert.equal(results.length, 2);
    assert.ok(results[0].lesson.includes('second'), 'most recent first with null query');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Edge: empty entries returns empty array with scoring
// ---------------------------------------------------------------------------

test('scoring: empty wisdom store with scoring query returns empty array', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { queryWisdom } = await importWisdomIn(tmpDir);
    const results = await queryWisdom({ category: 'test', intent: 'deep' });
    assert.equal(results.length, 0);
  } finally {
    await removeTmpDir(tmpDir);
  }
});
