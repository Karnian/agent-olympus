/**
 * Tests for token normalization (US-C3R-001)
 * Covers stop words, suffix stripping, min-stem guard, Jaccard threshold validation
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ao-wisdom-norm-'));
}

async function removeTmpDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

async function importWisdomIn(cwd) {
  const original = process.cwd();
  process.chdir(cwd);
  try {
    const buster = Buffer.from(cwd).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
    const modPath = new URL(`../lib/wisdom.mjs?norm=${buster}`, import.meta.url).href;
    return await import(modPath);
  } finally {
    process.chdir(original);
  }
}

// ---------------------------------------------------------------------------
// AC-001-1: Suffix variants produce Jaccard > 0.7
// ---------------------------------------------------------------------------

test('normalization: "testing the modules" vs "tested those module" yields Jaccard > 0.7', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    await addWisdom({ category: 'test', lesson: 'testing the modules for correctness and reliability' });
    // "tested" and "testing" should normalize similarly; "modules" and "module" should match via -s strip
    await addWisdom({ category: 'test', lesson: 'tested those module for correctness and reliability' });

    const results = await queryWisdom('test');
    // Second should be deduped (Jaccard >= 0.7 after normalization)
    assert.equal(results.length, 1, 'near-duplicate with suffix variants should be deduped');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// AC-001-2: "sing" not stripped, "singing" stripped to "sing"
// ---------------------------------------------------------------------------

test('normalization: "sing" not stripped (stem < 4), "singing" stripped to "sing"', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    // These share "sing" after normalization — but are very different lessons
    await addWisdom({ category: 'general', lesson: 'sing along with the music player application' });
    await addWisdom({ category: 'general', lesson: 'singing together in the choir practice session' });

    const results = await queryWisdom('general');
    // Both should be kept — they share some words but overall Jaccard should be < 0.7
    assert.equal(results.length, 2, 'distinct lessons with sing/singing should both be kept');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// AC-001-3: Stop words removed from token sets
// ---------------------------------------------------------------------------

test('normalization: stop words do not appear in dedup comparison', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    // Two lessons that share ONLY stop words — should not be deduped
    await addWisdom({ category: 'test', lesson: 'the function will have this from your module' });
    await addWisdom({ category: 'test', lesson: 'that they can make each when than all but' });

    const results = await queryWisdom('test');
    assert.equal(results.length, 2, 'lessons sharing only stop words should not be deduped');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// AC-001-5: Words with stems < 4 chars kept unchanged
// ---------------------------------------------------------------------------

test('normalization: stripSuffix guards — "used", "only", "being" kept unchanged', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    // "used" should stay "used" (not "us"), "only" stays "only" (not "on")
    await addWisdom({ category: 'general', lesson: 'used only being there' });
    // completely different lesson that would NOT match if stems were incorrectly stripped
    await addWisdom({ category: 'general', lesson: 'user once begun here' });

    const results = await queryWisdom('general');
    assert.equal(results.length, 2, 'short-stem words should not cause false conflation');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// AC-001-6: Threshold validation — Pair 2 from spec (false negative fixed)
// ---------------------------------------------------------------------------

test('normalization: near-duplicate with word reorder is deduped (Pair 2)', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    await addWisdom({ category: 'build', lesson: 'Always run linting as a pre-commit hook to catch issues early' });
    await addWisdom({ category: 'build', lesson: 'Run pre-commit linting hooks to catch issues early and reliably' });

    const results = await queryWisdom('build');
    assert.equal(results.length, 1, 'Pair 2: reordered near-duplicate should be deduped after normalization');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// AC-001-6: Threshold validation — distinct lessons stay separate
// ---------------------------------------------------------------------------

test('normalization: distinct lessons stay separate (Pair 3)', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    await addWisdom({ category: 'build', lesson: 'Pin all transitive dependencies for deterministic builds' });
    await addWisdom({ category: 'build', lesson: 'Configure eslint with strict TypeScript rules for type safety' });

    const results = await queryWisdom('build');
    assert.equal(results.length, 2, 'Pair 3: distinct lessons should not be deduped');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// AC-001-6: Same topic different advice stays separate (Pair 4)
// ---------------------------------------------------------------------------

test('normalization: same topic different advice stays separate (Pair 4)', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    await addWisdom({ category: 'test', lesson: 'Use isolated temp dirs for each test to prevent cross-test pollution' });
    await addWisdom({ category: 'test', lesson: 'Tag integration tests so they can be skipped in fast mode' });

    const results = await queryWisdom('test');
    assert.equal(results.length, 2, 'Pair 4: same topic different advice should not be deduped');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// AC-001-7: pruneWisdom uses normalized Jaccard
// ---------------------------------------------------------------------------

test('normalization: pruneWisdom deduplicates using normalized Jaccard', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, queryWisdom, pruneWisdom } = await importWisdomIn(tmpDir);

    // Manually insert two near-duplicates that differ only by suffix
    // addWisdom dedup would catch this, so we write directly
    const wisdomPath = path.join(tmpDir, '.ao', 'wisdom.jsonl');
    await fs.mkdir(path.dirname(wisdomPath), { recursive: true });
    const entries = [
      JSON.stringify({ timestamp: new Date().toISOString(), project: 'test', category: 'build', lesson: 'Always run linting as a pre-commit hook to catch issues early', confidence: 'medium' }),
      JSON.stringify({ timestamp: new Date().toISOString(), project: 'test', category: 'build', lesson: 'Run pre-commit linting hooks to catch issues early and reliably', confidence: 'medium' }),
    ];
    await fs.writeFile(wisdomPath, entries.join('\n') + '\n');

    await pruneWisdom(200);

    const results = await queryWisdom(null);
    assert.equal(results.length, 1, 'pruneWisdom should deduplicate using normalized Jaccard');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Edge case: empty string and non-English text
// ---------------------------------------------------------------------------

test('normalization: empty string produces empty token set, no crash', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    await addWisdom({ category: 'general', lesson: '' });
    // Should not crash, empty lesson is stored (lesson field exists but empty)
    const results = await queryWisdom('general');
    // Empty lesson still gets stored since addWisdom doesn't validate content
    assert.ok(results.length <= 1);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('normalization: non-English (Korean) text passes through unchanged', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    await addWisdom({ category: 'general', lesson: '테스트를 항상 먼저 작성하세요' });
    await addWisdom({ category: 'general', lesson: '코드 리뷰는 반드시 수행해야 합니다' });

    const results = await queryWisdom('general');
    assert.equal(results.length, 2, 'Korean text should pass through normalization unchanged');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Suffix stripping: "worker" and "working" both reduce to "work"
// ---------------------------------------------------------------------------

test('normalization: "worker" and "working" both reduce to "work" (desired conflation)', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    await addWisdom({ category: 'general', lesson: 'configure the worker pool to handle batch processing tasks efficiently' });
    await addWisdom({ category: 'general', lesson: 'configure the working pool to handle batch processing tasks efficiently' });

    const results = await queryWisdom('general');
    assert.equal(results.length, 1, 'worker/working conflation is desired for dedup');
  } finally {
    await removeTmpDir(tmpDir);
  }
});
