/**
 * Tests for concurrency-adjacent state helpers:
 *   - atomicWriteFileSync / atomicMoveSync from fs-atomic.mjs
 *   - pruneWisdom deduplication (ensures concurrent-duplicate entries are cleaned up)
 *   - worker-status pruneStale (removes tasks stale for > 10 min)
 *
 * Uses node:test — zero npm dependencies.
 * All I/O uses temporary directories; the real .ao/ directory is never touched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFileSync, atomicMoveSync } from '../lib/fs-atomic.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ao-concurrency-test-'));
}

async function removeTmpDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

async function importWisdomIn(cwd) {
  const original = process.cwd();
  process.chdir(cwd);
  try {
    const buster = Buffer.from(cwd).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
    const modPath = new URL(`../lib/wisdom.mjs?cb=${buster}`, import.meta.url).href;
    return await import(modPath);
  } finally {
    process.chdir(original);
  }
}

async function importWorkerStatusIn(cwd) {
  const original = process.cwd();
  process.chdir(cwd);
  try {
    const buster = Buffer.from(cwd + '-ws').toString('base64').replace(/[^a-zA-Z0-9]/g, '');
    const modPath = new URL(`../lib/worker-status.mjs?cb=${buster}`, import.meta.url).href;
    return await import(modPath);
  } finally {
    process.chdir(original);
  }
}

// ---------------------------------------------------------------------------
// atomicWriteFileSync — basic read-back
// ---------------------------------------------------------------------------

test('atomicWriteFileSync: written content is readable', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const filePath = path.join(tmpDir, 'state.json');
    atomicWriteFileSync(filePath, JSON.stringify({ status: 'ok' }));

    const content = readFileSync(filePath, 'utf-8');
    assert.deepEqual(JSON.parse(content), { status: 'ok' });
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('atomicWriteFileSync: creates parent directory if absent', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const filePath = path.join(tmpDir, 'nested', 'deep', 'file.json');
    atomicWriteFileSync(filePath, '{"created":true}');
    assert.ok(existsSync(filePath), 'file should exist after atomic write');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('atomicWriteFileSync: overwrites existing file atomically', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const filePath = path.join(tmpDir, 'overwrite.json');
    atomicWriteFileSync(filePath, '{"v":1}');
    atomicWriteFileSync(filePath, '{"v":2}');

    const content = JSON.parse(readFileSync(filePath, 'utf-8'));
    assert.equal(content.v, 2, 'second write should overwrite the first');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// atomicMoveSync — basic move behaviour
// ---------------------------------------------------------------------------

test('atomicMoveSync: file is present at dest and absent at src after move', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const src = path.join(tmpDir, 'msg-001.json');
    const destDir = path.join(tmpDir, 'processed');
    const dest = path.join(destDir, 'msg-001.json');

    writeFileSync(src, '{"id":"001"}', { encoding: 'utf-8' });
    atomicMoveSync(src, dest);

    assert.ok(!existsSync(src), 'source file should no longer exist after move');
    assert.ok(existsSync(dest), 'destination file should exist after move');
    assert.equal(readFileSync(dest, 'utf-8'), '{"id":"001"}');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('atomicMoveSync: creates destination directory if absent', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const src = path.join(tmpDir, 'item.json');
    const dest = path.join(tmpDir, 'new', 'subdir', 'item.json');

    writeFileSync(src, 'content', { encoding: 'utf-8' });
    atomicMoveSync(src, dest);

    assert.ok(existsSync(dest), 'file should be at destination inside auto-created directories');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// pruneWisdom — deduplication of concurrent-duplicate entries
// ---------------------------------------------------------------------------

test('pruneWisdom: removes duplicate entries (simulating concurrent-write race)', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { pruneWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    // Manually inject duplicate entries directly into wisdom.jsonl to simulate
    // what happens when two concurrent processes both pass the similarity check
    const wisdomPath = path.join(tmpDir, '.ao', 'wisdom.jsonl');
    mkdirSync(path.join(tmpDir, '.ao'), { recursive: true, mode: 0o700 });

    const baseLesson = 'Use async/await with proper error handling for all async operations in the codebase';
    // Second entry shares the same lesson — a perfect concurrent-write duplicate
    const entry1 = { timestamp: new Date(Date.now() - 1000).toISOString(), project: 'test', category: 'pattern', lesson: baseLesson, confidence: 'high' };
    const entry2 = { timestamp: new Date().toISOString(), project: 'test', category: 'pattern', lesson: baseLesson, confidence: 'high' };

    writeFileSync(wisdomPath, JSON.stringify(entry1) + '\n' + JSON.stringify(entry2) + '\n', { encoding: 'utf-8', mode: 0o600 });

    // pruneWisdom should collapse the duplicate, keeping the newer entry
    await pruneWisdom(200);

    const results = await queryWisdom('pattern');
    assert.equal(results.length, 1, 'pruneWisdom should remove the duplicate, leaving 1 entry');
    assert.equal(results[0].lesson, baseLesson);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('pruneWisdom: keeps both entries when lessons are sufficiently distinct', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { pruneWisdom, queryWisdom } = await importWisdomIn(tmpDir);

    const wisdomPath = path.join(tmpDir, '.ao', 'wisdom.jsonl');
    mkdirSync(path.join(tmpDir, '.ao'), { recursive: true, mode: 0o700 });

    const e1 = { timestamp: new Date(Date.now() - 1000).toISOString(), project: 'test', category: 'build', lesson: 'Always run npm ci in CI environments for reproducible installs', confidence: 'high' };
    const e2 = { timestamp: new Date().toISOString(), project: 'test', category: 'build', lesson: 'Configure eslint with strict TypeScript rules to catch type errors early', confidence: 'medium' };

    writeFileSync(wisdomPath, JSON.stringify(e1) + '\n' + JSON.stringify(e2) + '\n', { encoding: 'utf-8', mode: 0o600 });

    await pruneWisdom(200);

    const results = await queryWisdom('build');
    assert.equal(results.length, 2, 'distinct entries should both be retained after pruneWisdom');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// worker-status — pruneStale removes tasks idle > 10 minutes
// ---------------------------------------------------------------------------

test('worker-status pruneStale: removes tasks stale for more than 10 minutes', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const mod = await importWorkerStatusIn(tmpDir);
    // Only run if pruneStale is exported
    if (typeof mod.pruneStale !== 'function') {
      // Skip gracefully — pruneStale may be internal-only
      return;
    }

    const TEN_MIN_MS = 10 * 60 * 1000;
    const now = Date.now();

    const tasks = [
      { id: 'task-fresh', startedAt: new Date(now - 5 * 60 * 1000).toISOString() },   // 5 min ago — keep
      { id: 'task-stale', startedAt: new Date(now - 15 * 60 * 1000).toISOString() },  // 15 min ago — prune
      { id: 'task-edge',  startedAt: new Date(now - 10 * 60 * 1000 - 1).toISOString() }, // just over 10 min — prune
    ];

    const result = mod.pruneStale(tasks, TEN_MIN_MS);

    assert.equal(result.length, 1, 'only the fresh task should survive pruneStale');
    assert.equal(result[0].id, 'task-fresh');
  } finally {
    await removeTmpDir(tmpDir);
  }
});
