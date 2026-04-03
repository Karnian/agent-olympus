/**
 * Tests for wisdom export/import (US-C3R-003)
 * Covers round-trip, merge dedup, replace mode, defaults, invalid input
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ao-wisdom-export-'));
}

async function removeTmpDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

async function importWisdomIn(cwd) {
  const original = process.cwd();
  process.chdir(cwd);
  try {
    const buster = Buffer.from(cwd).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
    const modPath = new URL(`../lib/wisdom.mjs?exp=${buster}`, import.meta.url).href;
    return await import(modPath);
  } finally {
    process.chdir(original);
  }
}

// ---------------------------------------------------------------------------
// AC-003-1: exportWisdom returns valid JSON array
// ---------------------------------------------------------------------------

test('export: exportWisdom() returns valid JSON array string', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, exportWisdom } = await importWisdomIn(tmpDir);

    await addWisdom({ category: 'test', lesson: 'Always write integration tests for critical paths' });
    await addWisdom({ category: 'build', lesson: 'Cache node modules between builds for faster CI runs' });

    const exported = await exportWisdom();
    const parsed = JSON.parse(exported);
    assert.ok(Array.isArray(parsed), 'should be an array');
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].category, 'test');
    assert.equal(parsed[1].category, 'build');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// AC-003-1: exportWisdom on empty store returns empty array
// ---------------------------------------------------------------------------

test('export: exportWisdom() on empty store returns "[]"', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { exportWisdom } = await importWisdomIn(tmpDir);
    const exported = await exportWisdom();
    const parsed = JSON.parse(exported);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 0);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// AC-003-2: importWisdom merge mode skips duplicates
// ---------------------------------------------------------------------------

test('import: merge mode skips entries with Jaccard >= 0.7 similarity', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, importWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    await addWisdom({ category: 'test', lesson: 'Always run linting as a pre-commit hook to catch issues early' });

    const incoming = JSON.stringify([
      // Near-duplicate of existing (should be skipped)
      { lesson: 'Run pre-commit linting hooks to catch issues early and reliably', category: 'test', confidence: 'high' },
      // Distinct (should be imported)
      { lesson: 'Configure eslint with strict TypeScript rules for type safety', category: 'build', confidence: 'medium' },
    ]);

    const result = await importWisdom(incoming, { merge: true });
    assert.equal(result.duplicatesSkipped, 1, 'one duplicate should be skipped');
    assert.equal(result.imported, 1, 'one new entry should be imported');

    const all = await queryWisdom(null);
    assert.equal(all.length, 2, 'total entries: 1 existing + 1 imported');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// AC-003-3: importWisdom replace mode overwrites all
// ---------------------------------------------------------------------------

test('import: replace mode (merge: false) overwrites all existing entries', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { addWisdom, importWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    await addWisdom({ category: 'test', lesson: 'existing lesson that should be replaced entirely' });

    const incoming = JSON.stringify([
      { lesson: 'brand new lesson after replacing all data', category: 'build', confidence: 'high' },
    ]);

    const result = await importWisdom(incoming, { merge: false });
    assert.equal(result.imported, 1);
    assert.equal(result.duplicatesSkipped, 0);

    const all = await queryWisdom(null);
    assert.equal(all.length, 1, 'only the imported entry should remain');
    assert.ok(all[0].lesson.includes('brand new'), 'the new lesson should be present');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// AC-003-4: Missing fields receive defaults
// ---------------------------------------------------------------------------

test('import: missing timestamp, category, confidence get defaults', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { importWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    const incoming = JSON.stringify([
      { lesson: 'lesson with no metadata fields at all provided' },
    ]);

    await importWisdom(incoming);

    const results = await queryWisdom(null);
    assert.equal(results.length, 1);
    assert.ok(results[0].timestamp, 'timestamp should be set');
    assert.equal(results[0].category, 'general', 'default category');
    assert.equal(results[0].confidence, 'medium', 'default confidence');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// AC-003-5: Entries without lesson field silently skipped
// ---------------------------------------------------------------------------

test('import: entries without lesson field are silently skipped', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { importWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    const incoming = JSON.stringify([
      { category: 'test' },                  // no lesson
      { lesson: '', category: 'test' },       // empty lesson (falsy)
      { lesson: 123, category: 'test' },      // non-string lesson
      { lesson: 'valid lesson about test automation strategies', category: 'test' },
    ]);

    const result = await importWisdom(incoming);
    assert.equal(result.imported, 1, 'only the valid entry should be imported');

    const results = await queryWisdom(null);
    assert.equal(results.length, 1);
    assert.ok(results[0].lesson.includes('valid'));
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Round-trip: export then import is idempotent
// ---------------------------------------------------------------------------

test('round-trip: export then import into fresh store produces same entries', async () => {
  const tmpDir1 = await makeTmpDir();
  const tmpDir2 = await makeTmpDir();
  try {
    const mod1 = await importWisdomIn(tmpDir1);
    const mod2 = await importWisdomIn(tmpDir2);

    await mod1.addWisdom({ category: 'test', lesson: 'round trip lesson about integration testing approaches', confidence: 'high' });
    await mod1.addWisdom({ category: 'build', lesson: 'round trip lesson about build optimization strategies', confidence: 'medium' });

    const exported = await mod1.exportWisdom();
    await mod2.importWisdom(exported, { merge: false });

    const results1 = await mod1.queryWisdom(null);
    const results2 = await mod2.queryWisdom(null);

    assert.equal(results1.length, results2.length, 'same entry count');
    assert.equal(results1[0].lesson, results2[0].lesson, 'same lesson content');
    assert.equal(results1[0].category, results2[0].category, 'same category');
  } finally {
    await removeTmpDir(tmpDir1);
    await removeTmpDir(tmpDir2);
  }
});

// ---------------------------------------------------------------------------
// Invalid JSON throws
// ---------------------------------------------------------------------------

test('import: invalid JSON string throws', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { importWisdom } = await importWisdomIn(tmpDir);
    await assert.rejects(
      () => importWisdom('not valid json'),
      { name: 'SyntaxError' },
    );
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Non-array JSON throws
// ---------------------------------------------------------------------------

test('import: non-array JSON throws', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { importWisdom } = await importWisdomIn(tmpDir);
    await assert.rejects(
      () => importWisdom('{"not": "array"}'),
      { message: 'Expected JSON array' },
    );
  } finally {
    await removeTmpDir(tmpDir);
  }
});
