/**
 * Unit tests for scripts/lib/changelog.mjs
 * Tests generateChangelogEntry() and prependToChangelog().
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateChangelogEntry, prependToChangelog } from '../lib/changelog.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ao-changelog-test-'));
}

async function removeTmpDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

/** Minimal PRD fixture with story titles */
function samplePrd() {
  return {
    projectName: 'test-project',
    userStories: [
      { id: 'US-1', title: 'Add autonomy config support', passes: true },
      { id: 'US-2', title: 'Implement cost estimation', passes: true },
    ],
  };
}

// ---------------------------------------------------------------------------
// Test: generateChangelogEntry
// ---------------------------------------------------------------------------

test('generateChangelogEntry: output starts with ## [version]', () => {
  const entry = generateChangelogEntry({ prd: samplePrd(), version: '0.8.0', date: '2026-03-30' });
  assert.equal(typeof entry, 'string', 'must return a string');
  assert.ok(
    entry.startsWith('## [0.8.0]') || entry.includes('## [0.8.0]'),
    `entry must include "## [0.8.0]", got: ${entry.slice(0, 80)}`,
  );
});

test('generateChangelogEntry: includes the provided date in output', () => {
  const entry = generateChangelogEntry({ prd: samplePrd(), version: '0.8.0', date: '2026-03-30' });
  assert.ok(entry.includes('2026-03-30'), 'entry must include the date "2026-03-30"');
});

test('generateChangelogEntry: includes story titles from prd', () => {
  const prd = samplePrd();
  const entry = generateChangelogEntry({ prd, version: '0.8.0', date: '2026-03-30' });
  for (const story of prd.userStories) {
    assert.ok(
      entry.includes(story.title),
      `entry must include story title "${story.title}"`,
    );
  }
});

test('generateChangelogEntry: works with empty stories array', () => {
  const prd = { ...samplePrd(), userStories: [] };
  let threw = false;
  try {
    generateChangelogEntry({ prd, version: '0.8.0', date: '2026-03-30' });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'must not throw for empty stories array');
});

// ---------------------------------------------------------------------------
// Test: prependToChangelog
// ---------------------------------------------------------------------------

test('prependToChangelog: inserts entry before first ## in existing file', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const filePath = path.join(tmpDir, 'CHANGELOG.md');
    const existing = '## [0.7.0] - 2026-01-01\n\nOld content here.\n';
    writeFileSync(filePath, existing, 'utf-8');

    const newEntry = '## [0.8.0] - 2026-03-30\n\nNew content here.\n\n';
    await prependToChangelog(filePath, newEntry);

    const content = await fs.readFile(filePath, 'utf-8');
    const newEntryPos = content.indexOf('## [0.8.0]');
    const oldEntryPos = content.indexOf('## [0.7.0]');
    assert.ok(newEntryPos !== -1, 'new entry must be present');
    assert.ok(oldEntryPos !== -1, 'old entry must still be present');
    assert.ok(newEntryPos < oldEntryPos, 'new entry must appear before old entry');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('prependToChangelog: creates file if it does not exist', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const filePath = path.join(tmpDir, 'NEW_CHANGELOG.md');
    const entry = '## [0.8.0] - 2026-03-30\n\nFirst entry.\n';
    await prependToChangelog(filePath, entry);

    const content = await fs.readFile(filePath, 'utf-8');
    assert.ok(content.includes('## [0.8.0]'), 'created file must contain the entry');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('prependToChangelog: preserves existing content after insertion', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const filePath = path.join(tmpDir, 'CHANGELOG.md');
    const existing = '## [0.7.0] - 2026-01-01\n\nOriginal line one.\nOriginal line two.\n';
    writeFileSync(filePath, existing, 'utf-8');

    const newEntry = '## [0.8.0] - 2026-03-30\n\nNew release notes.\n\n';
    await prependToChangelog(filePath, newEntry);

    const content = await fs.readFile(filePath, 'utf-8');
    assert.ok(content.includes('Original line one.'), 'existing content must be preserved');
    assert.ok(content.includes('Original line two.'), 'existing content must be preserved');
    assert.ok(content.includes('New release notes.'), 'new entry content must be present');
  } finally {
    await removeTmpDir(tmpDir);
  }
});
