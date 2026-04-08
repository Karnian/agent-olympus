/**
 * Tests for scripts/lib/design-identity.mjs (v1.0.2 US-003)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

async function makeTmp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-design-identity-test-'));
  execSync('git init -q', { cwd: dir });
  return dir;
}

async function freshImport() {
  const url = new URL('../lib/design-identity.mjs?t=' + Date.now() + Math.random(), import.meta.url);
  return import(url.href);
}

describe('design-identity: loadIdentity fail-safe', () => {
  let tmp; let saved;
  before(async () => { tmp = await makeTmp(); saved = process.cwd(); process.chdir(tmp); });
  after(async () => { process.chdir(saved); await fs.rm(tmp, { recursive: true, force: true }); });

  it('returns {} when file does not exist', async () => {
    const mod = await freshImport();
    assert.deepEqual(await mod.loadIdentity(), {});
  });

  it('returns {} when file is corrupted', async () => {
    const mod = await freshImport();
    const dir = path.join(tmp, '.ao', 'memory');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'design-identity.json'), 'not json{{{');
    assert.deepEqual(await mod.loadIdentity(), {});
  });

  it('returns {} when schemaVersion > 1 (forward compat)', async () => {
    const mod = await freshImport();
    const dir = path.join(tmp, '.ao', 'memory');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'design-identity.json'),
      JSON.stringify({ schemaVersion: 99, brand: { name: 'X' } }),
    );
    assert.deepEqual(await mod.loadIdentity(), {});
  });
});

describe('design-identity: mergeIdentity deep-merge semantics', () => {
  it('deep-merges objects, replaces arrays', async () => {
    const mod = await freshImport();
    const existing = {
      schemaVersion: 1,
      brand: { name: 'Old', colors: ['#111', '#222'] },
      typography: { fonts: ['Arial'] },
      allowedFonts: ['Arial'],
    };
    const update = {
      brand: { name: 'New' }, // preserves colors
      typography: { fonts: ['Fraunces', 'Inter'] }, // replaces array
      allowedFonts: ['Fraunces', 'Inter'], // replaces array
    };
    const merged = mod.mergeIdentity(existing, update);
    assert.equal(merged.brand.name, 'New');
    assert.deepEqual(merged.brand.colors, ['#111', '#222']); // preserved
    assert.deepEqual(merged.typography.fonts, ['Fraunces', 'Inter']); // replaced
    assert.deepEqual(merged.allowedFonts, ['Fraunces', 'Inter']);
  });

  it('handles null/undefined existing', async () => {
    const mod = await freshImport();
    assert.deepEqual(mod.mergeIdentity(null, { a: 1 }), { a: 1 });
    assert.deepEqual(mod.mergeIdentity({ a: 1 }, null), { a: 1 });
  });
});

describe('design-identity: validateIdentity', () => {
  it('accepts valid shape', async () => {
    const mod = await freshImport();
    const r = mod.validateIdentity({
      schemaVersion: 1,
      brand: { name: 'X', colors: ['#000'] },
      typography: { fonts: ['A'] },
      allowedFonts: ['A'],
    });
    assert.equal(r.valid, true);
    assert.equal(r.errors.length, 0);
  });

  it('rejects schemaVersion mismatch', async () => {
    const mod = await freshImport();
    const r = mod.validateIdentity({ schemaVersion: 2 });
    assert.equal(r.valid, false);
  });

  it('rejects non-array allowedFonts', async () => {
    const mod = await freshImport();
    const r = mod.validateIdentity({ allowedFonts: 'not-an-array' });
    assert.equal(r.valid, false);
  });

  it('rejects non-object brand', async () => {
    const mod = await freshImport();
    const r = mod.validateIdentity({ brand: 'nope' });
    assert.equal(r.valid, false);
  });
});

describe('design-identity: saveIdentity round-trip', () => {
  let tmp; let saved;
  before(async () => { tmp = await makeTmp(); saved = process.cwd(); process.chdir(tmp); });
  after(async () => { process.chdir(saved); await fs.rm(tmp, { recursive: true, force: true }); });

  it('persists + re-loads via loadIdentity, stamps schemaVersion', async () => {
    const mod = await freshImport();
    const r = await mod.saveIdentity({
      brand: { name: 'Acme', colors: ['#000'] },
      typography: { fonts: ['Fraunces'] },
      allowedFonts: ['Fraunces'],
    });
    assert.equal(r.ok, true);
    const loaded = await mod.loadIdentity();
    assert.equal(loaded.schemaVersion, 1);
    assert.equal(loaded.brand.name, 'Acme');
  });

  it('merges on second save (last-write-wins per top-level key)', async () => {
    const mod = await freshImport();
    await mod.saveIdentity({ brand: { name: 'NewName' } });
    const loaded = await mod.loadIdentity();
    assert.equal(loaded.brand.name, 'NewName');
    assert.deepEqual(loaded.brand.colors, ['#000']); // preserved
  });
});

describe('design-identity: loadIdentitySummary 2KB projection', () => {
  let tmp; let saved;
  before(async () => {
    tmp = await makeTmp(); saved = process.cwd(); process.chdir(tmp);
    const dir = path.join(tmp, '.ao', 'memory');
    mkdirSync(dir, { recursive: true });
    // Write a >2KB file
    writeFileSync(path.join(dir, 'design-identity.json'), JSON.stringify({
      schemaVersion: 1,
      brand: { name: 'Acme', colors: ['#111', '#222', '#333', '#444', '#555'] },
      typography: { fonts: ['A', 'B', 'C', 'D', 'E'] },
      spacing: { scale: [4, 8, 16] },
      components: { library: 'radix' },
      allowedFonts: ['A', 'B'],
      conventions: { notes: 'x'.repeat(3000) },
    }, null, 2));
  });
  after(async () => { process.chdir(saved); await fs.rm(tmp, { recursive: true, force: true }); });

  it('returns a projection ≤ 2KB', async () => {
    const mod = await freshImport();
    const summary = await mod.loadIdentitySummary();
    assert.ok(JSON.stringify(summary).length <= 2048);
  });

  it('caps colors to first 3 and fonts to first 2', async () => {
    const mod = await freshImport();
    const summary = await mod.loadIdentitySummary();
    assert.equal(summary.brand.colors.length, 3);
    assert.equal(summary.typography.fonts.length, 2);
  });

  it('drops oversized conventions field', async () => {
    const mod = await freshImport();
    const summary = await mod.loadIdentitySummary();
    assert.ok(!('conventions' in summary));
  });
});
