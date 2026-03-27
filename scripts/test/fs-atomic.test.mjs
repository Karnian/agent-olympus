/**
 * Unit tests for scripts/lib/fs-atomic.mjs
 * Uses node:test — zero npm dependencies.
 *
 * Tests both the sync (atomicWriteFileSync) and async (atomicWriteFile)
 * variants. Each test uses an isolated temp directory and cleans up after
 * itself, making the suite fully idempotent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFileSync, atomicWriteFile } from '../lib/fs-atomic.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ao-fs-atomic-test-'));
}

async function removeTmpDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// atomicWriteFileSync — basic write + read
// ---------------------------------------------------------------------------

test('atomicWriteFileSync: written content can be read back', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const filePath = path.join(tmpDir, 'output.txt');
    atomicWriteFileSync(filePath, 'hello atomic world');
    const content = readFileSync(filePath, 'utf-8');
    assert.equal(content, 'hello atomic world');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('atomicWriteFileSync: overwrites existing file with new content', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const filePath = path.join(tmpDir, 'output.txt');
    atomicWriteFileSync(filePath, 'first write');
    atomicWriteFileSync(filePath, 'second write');
    const content = readFileSync(filePath, 'utf-8');
    assert.equal(content, 'second write');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('atomicWriteFileSync: creates parent directories if they do not exist', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const filePath = path.join(tmpDir, 'deep', 'nested', 'output.txt');
    atomicWriteFileSync(filePath, 'nested content');
    const content = readFileSync(filePath, 'utf-8');
    assert.equal(content, 'nested content');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('atomicWriteFileSync: sequential writes — last write wins', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const filePath = path.join(tmpDir, 'state.json');
    // Simulate two sequential writes (last value must be visible)
    atomicWriteFileSync(filePath, JSON.stringify({ value: 1 }));
    atomicWriteFileSync(filePath, JSON.stringify({ value: 2 }));
    const result = JSON.parse(readFileSync(filePath, 'utf-8'));
    assert.equal(result.value, 2);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('atomicWriteFileSync: writes empty string without error', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const filePath = path.join(tmpDir, 'empty.txt');
    atomicWriteFileSync(filePath, '');
    const content = readFileSync(filePath, 'utf-8');
    assert.equal(content, '');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// atomicWriteFile (async) — basic write + read
// ---------------------------------------------------------------------------

test('atomicWriteFile: written content can be read back (async)', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const filePath = path.join(tmpDir, 'async-output.txt');
    await atomicWriteFile(filePath, 'async hello atomic');
    const content = await fs.readFile(filePath, 'utf-8');
    assert.equal(content, 'async hello atomic');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('atomicWriteFile: overwrites existing file with new content (async)', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const filePath = path.join(tmpDir, 'async-output.txt');
    await atomicWriteFile(filePath, 'async first');
    await atomicWriteFile(filePath, 'async second');
    const content = await fs.readFile(filePath, 'utf-8');
    assert.equal(content, 'async second');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('atomicWriteFile: creates parent directories if they do not exist (async)', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const filePath = path.join(tmpDir, 'deep', 'async', 'output.txt');
    await atomicWriteFile(filePath, 'deep async content');
    const content = await fs.readFile(filePath, 'utf-8');
    assert.equal(content, 'deep async content');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('atomicWriteFile: sequential async writes — last write wins', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const filePath = path.join(tmpDir, 'async-state.json');
    await atomicWriteFile(filePath, JSON.stringify({ value: 'a' }));
    await atomicWriteFile(filePath, JSON.stringify({ value: 'b' }));
    const result = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    assert.equal(result.value, 'b');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('atomicWriteFile: writes JSON content correctly (async)', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const filePath = path.join(tmpDir, 'data.json');
    const data = { phase: 3, stories: ['US-1', 'US-2'], active: true };
    await atomicWriteFile(filePath, JSON.stringify(data, null, 2));
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    assert.deepEqual(parsed, data);
  } finally {
    await removeTmpDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// No leftover .tmp files after successful write
// ---------------------------------------------------------------------------

test('atomicWriteFileSync: no leftover .tmp file after successful write', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const filePath = path.join(tmpDir, 'output.txt');
    atomicWriteFileSync(filePath, 'clean write');
    const entries = await fs.readdir(tmpDir);
    const leftoverTmp = entries.filter(e => e.startsWith('.tmp-'));
    assert.equal(leftoverTmp.length, 0, 'no .tmp files should remain after a successful write');
  } finally {
    await removeTmpDir(tmpDir);
  }
});

test('atomicWriteFile: no leftover .tmp file after successful async write', async () => {
  const tmpDir = await makeTmpDir();
  try {
    const filePath = path.join(tmpDir, 'output.txt');
    await atomicWriteFile(filePath, 'clean async write');
    const entries = await fs.readdir(tmpDir);
    const leftoverTmp = entries.filter(e => e.startsWith('.tmp-'));
    assert.equal(leftoverTmp.length, 0, 'no .tmp files should remain after a successful async write');
  } finally {
    await removeTmpDir(tmpDir);
  }
});
