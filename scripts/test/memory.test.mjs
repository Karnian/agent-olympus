/**
 * Tests for scripts/lib/memory.mjs (v1.0.2 F-002)
 *
 * Covers:
 *   - resolveMemoryDir() returns <projectRoot>/.ao/memory
 *   - readJsonFile fail-safe on missing/corrupted/forward-schema files
 *   - writeJsonFile atomic write + round-trip
 *   - JSONL append / read / rewrite round-trip
 *   - schemaVersion > KNOWN filtering (forward compat)
 *   - autonomy.json { memory: { disabled: true } } short-circuits all loaders
 *   - Writers NEVER create the memory dir when disabled
 *   - Loaders NEVER create the memory dir when it doesn't exist
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function makeTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ao-memory-test-'));
}

async function freshImport() {
  // Bust the module cache so each test gets a clean module with a freshly
  // captured moduleCwd / projectRoot.
  const url = new URL('../lib/memory.mjs?t=' + Date.now() + Math.random(), import.meta.url);
  return import(url.href);
}

describe('memory.mjs — resolveMemoryDir', () => {
  let tmp;
  let saved;
  before(async () => {
    tmp = await makeTmp();
    // Initialize as a real git repo so git rev-parse works
    const { execSync } = await import('node:child_process');
    execSync('git init -q', { cwd: tmp });
    saved = process.cwd();
    process.chdir(tmp);
  });
  after(async () => {
    process.chdir(saved);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('resolves to <projectRoot>/.ao/memory', async () => {
    const mem = await freshImport();
    const dir = mem.resolveMemoryDir();
    // On macOS /tmp -> /private/tmp so compare realpath-adjusted
    const expected = path.join(await fs.realpath(tmp), '.ao', 'memory');
    const actual = path.resolve(dir);
    assert.equal(actual, expected);
  });

  it('memoryFilePath joins the name under memory dir', async () => {
    const mem = await freshImport();
    const p = mem.memoryFilePath('design-identity.json');
    assert.ok(p.endsWith(path.join('.ao', 'memory', 'design-identity.json')));
  });

  it('memoryFilePath rejects path traversal and absolute paths (hardening)', async () => {
    const mem = await freshImport();
    for (const bad of ['../escape.json', '../../etc/passwd', '/etc/passwd', 'sub/dir.json', 'a\\b.json', '..', '']) {
      assert.throws(
        () => mem.memoryFilePath(bad),
        /illegal filename|invalid name/,
        `expected throw on ${JSON.stringify(bad)}`,
      );
    }
  });
});

describe('memory.mjs — readJsonFile fail-safe', () => {
  let tmp;
  let saved;
  before(async () => {
    tmp = await makeTmp();
    const { execSync } = await import('node:child_process');
    execSync('git init -q', { cwd: tmp });
    saved = process.cwd();
    process.chdir(tmp);
  });
  after(async () => {
    process.chdir(saved);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('returns {} when file does not exist', async () => {
    const mem = await freshImport();
    const result = await mem.readJsonFile('missing.json');
    assert.deepEqual(result, {});
  });

  it('does NOT create the memory directory when reading a missing file', async () => {
    const mem = await freshImport();
    await mem.readJsonFile('missing.json');
    assert.ok(!existsSync(path.join(tmp, '.ao', 'memory')));
  });

  it('returns {} when file is corrupted JSON', async () => {
    const mem = await freshImport();
    const dir = path.join(tmp, '.ao', 'memory');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(dir, 'corrupt.json'), 'not json{{{');
    const result = await mem.readJsonFile('corrupt.json');
    assert.deepEqual(result, {});
  });

  it('returns {} when file has schemaVersion > known (forward compat)', async () => {
    const mem = await freshImport();
    const dir = path.join(tmp, '.ao', 'memory');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(dir, 'future.json'),
      JSON.stringify({ schemaVersion: 99, brand: 'x' }),
    );
    const result = await mem.readJsonFile('future.json');
    assert.deepEqual(result, {});
  });

  it('returns parsed object when schemaVersion is at known version', async () => {
    const mem = await freshImport();
    const dir = path.join(tmp, '.ao', 'memory');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const data = { schemaVersion: 1, brand: { name: 'Acme' } };
    writeFileSync(path.join(dir, 'ok.json'), JSON.stringify(data));
    const result = await mem.readJsonFile('ok.json');
    assert.equal(result.brand.name, 'Acme');
    assert.equal(result.schemaVersion, 1);
  });
});

describe('memory.mjs — writeJsonFile round-trip', () => {
  let tmp;
  let saved;
  before(async () => {
    tmp = await makeTmp();
    const { execSync } = await import('node:child_process');
    execSync('git init -q', { cwd: tmp });
    saved = process.cwd();
    process.chdir(tmp);
  });
  after(async () => {
    process.chdir(saved);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('writes JSON atomically and round-trips via readJsonFile', async () => {
    const mem = await freshImport();
    const data = { schemaVersion: 1, foo: 'bar', nested: { n: 42 } };
    const ok = await mem.writeJsonFile('roundtrip.json', data);
    assert.equal(ok, true);
    const read = await mem.readJsonFile('roundtrip.json');
    assert.equal(read.foo, 'bar');
    assert.equal(read.nested.n, 42);
  });

  it('creates the memory directory on first write', async () => {
    const mem = await freshImport();
    // Remove dir if present from prior test
    await fs.rm(path.join(tmp, '.ao', 'memory'), { recursive: true, force: true });
    await mem.writeJsonFile('first.json', { schemaVersion: 1, a: 1 });
    assert.ok(existsSync(path.join(tmp, '.ao', 'memory')));
  });
});

describe('memory.mjs — JSONL operations', () => {
  let tmp;
  let saved;
  beforeEach(async () => {
    if (tmp) {
      process.chdir(saved);
      await fs.rm(tmp, { recursive: true, force: true });
    }
    tmp = await makeTmp();
    const { execSync } = await import('node:child_process');
    execSync('git init -q', { cwd: tmp });
    saved = process.cwd();
    process.chdir(tmp);
  });
  after(async () => {
    process.chdir(saved);
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it('appendJsonlLine + readJsonlFile round-trip', async () => {
    const mem = await freshImport();
    await mem.appendJsonlLine('taste.jsonl', { schemaVersion: 1, id: 'a', v: 1 });
    await mem.appendJsonlLine('taste.jsonl', { schemaVersion: 1, id: 'b', v: 2 });
    const entries = await mem.readJsonlFile('taste.jsonl');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].id, 'a');
    assert.equal(entries[1].id, 'b');
  });

  it('readJsonlFile skips malformed lines and forward-schema lines', async () => {
    const mem = await freshImport();
    const dir = path.join(tmp, '.ao', 'memory');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const content = [
      JSON.stringify({ schemaVersion: 1, id: 'good' }),
      'not json at all',
      JSON.stringify({ schemaVersion: 99, id: 'future' }),
      JSON.stringify({ schemaVersion: 1, id: 'good2' }),
    ].join('\n');
    writeFileSync(path.join(dir, 'mixed.jsonl'), content);
    const entries = await mem.readJsonlFile('mixed.jsonl');
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((e) => e.id), ['good', 'good2']);
  });

  it('writeJsonlFile atomic rewrite (FIFO pruning use case)', async () => {
    const mem = await freshImport();
    await mem.appendJsonlLine('taste.jsonl', { schemaVersion: 1, id: 'a' });
    await mem.appendJsonlLine('taste.jsonl', { schemaVersion: 1, id: 'b' });
    await mem.appendJsonlLine('taste.jsonl', { schemaVersion: 1, id: 'c' });
    // Rewrite keeping only last 2
    const all = await mem.readJsonlFile('taste.jsonl');
    await mem.writeJsonlFile('taste.jsonl', all.slice(-2));
    const after = await mem.readJsonlFile('taste.jsonl');
    assert.equal(after.length, 2);
    assert.deepEqual(after.map((e) => e.id), ['b', 'c']);
  });

  it('readJsonlFile returns [] for missing file', async () => {
    const mem = await freshImport();
    const entries = await mem.readJsonlFile('nope.jsonl');
    assert.deepEqual(entries, []);
  });
});

describe('memory.mjs — autonomy disable flag', () => {
  let tmp;
  let saved;
  before(async () => {
    tmp = await makeTmp();
    const { execSync } = await import('node:child_process');
    execSync('git init -q', { cwd: tmp });
    saved = process.cwd();
    process.chdir(tmp);
    // Set disabled=true
    mkdirSync(path.join(tmp, '.ao'), { recursive: true });
    writeFileSync(
      path.join(tmp, '.ao', 'autonomy.json'),
      JSON.stringify({ memory: { disabled: true } }),
    );
  });
  after(async () => {
    process.chdir(saved);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('isMemoryDisabled returns true when autonomy flag is set', async () => {
    const mem = await freshImport();
    assert.equal(mem.isMemoryDisabled(tmp), true);
  });

  it('readJsonFile returns {} without touching disk when disabled', async () => {
    const mem = await freshImport();
    const res = await mem.readJsonFile('any.json');
    assert.deepEqual(res, {});
    assert.ok(!existsSync(path.join(tmp, '.ao', 'memory')));
  });

  it('writeJsonFile returns false and does NOT create memory dir when disabled', async () => {
    const mem = await freshImport();
    const ok = await mem.writeJsonFile('any.json', { schemaVersion: 1, x: 1 });
    assert.equal(ok, false);
    assert.ok(!existsSync(path.join(tmp, '.ao', 'memory')));
  });

  it('appendJsonlLine returns false when disabled', async () => {
    const mem = await freshImport();
    const ok = await mem.appendJsonlLine('x.jsonl', { schemaVersion: 1 });
    assert.equal(ok, false);
  });

  it('readJsonlFile returns [] when disabled', async () => {
    const mem = await freshImport();
    const res = await mem.readJsonlFile('x.jsonl');
    assert.deepEqual(res, []);
  });
});
