/**
 * Tests for scripts/lib/taste-memory.mjs (v1.0.2 US-009)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

async function makeTmp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-taste-test-'));
  execSync('git init -q', { cwd: dir });
  return dir;
}

async function freshImport() {
  const url = new URL('../lib/taste-memory.mjs?t=' + Date.now() + Math.random(), import.meta.url);
  return import(url.href);
}

describe('taste-memory: makeTasteEntry', () => {
  it('builds a valid entry with defaults', async () => {
    const mod = await freshImport();
    const e = mod.makeTasteEntry({ category: 'color', preference: 'monochromatic' });
    assert.equal(e.schemaVersion, 1);
    assert.equal(e.category, 'color');
    assert.equal(e.preference, 'monochromatic');
    assert.equal(e.source, 'user');
    assert.equal(e.confidence, 'med');
    assert.ok(e.id);
    assert.ok(e.timestamp);
  });

  it('rejects unknown category', async () => {
    const mod = await freshImport();
    assert.equal(mod.makeTasteEntry({ category: 'flavor', preference: 'spicy' }), null);
  });

  it('rejects empty preference', async () => {
    const mod = await freshImport();
    assert.equal(mod.makeTasteEntry({ category: 'color', preference: '' }), null);
  });
});

describe('taste-memory: recordTaste + loadTaste round-trip', () => {
  let tmp; let saved;
  before(async () => { tmp = await makeTmp(); saved = process.cwd(); process.chdir(tmp); });
  after(async () => { process.chdir(saved); await fs.rm(tmp, { recursive: true, force: true }); });

  it('records and loads back', async () => {
    const mod = await freshImport();
    await mod.recordTaste({ category: 'layout', preference: 'minimal whitespace' });
    await mod.recordTaste({ category: 'motion', preference: 'no bouncy easings', confidence: 'high' });
    const loaded = await mod.loadTaste(10);
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].category, 'layout');
    assert.equal(loaded[1].confidence, 'high');
  });

  it('loadTaste respects limit', async () => {
    const mod = await freshImport();
    const loaded = await mod.loadTaste(1);
    assert.equal(loaded.length, 1);
    // Most recent
    assert.equal(loaded[0].category, 'motion');
  });
});

describe('taste-memory: FIFO prune at 200 entries', () => {
  let tmp; let saved;
  before(async () => { tmp = await makeTmp(); saved = process.cwd(); process.chdir(tmp); });
  after(async () => { process.chdir(saved); await fs.rm(tmp, { recursive: true, force: true }); });

  it('keeps only the latest MAX_ENTRIES after overflow', async () => {
    const mod = await freshImport();
    // Pre-seed 199 entries directly to skip the 199 individual await/prune cycles.
    const dir = path.join(tmp, '.ao', 'memory');
    mkdirSync(dir, { recursive: true });
    const lines = [];
    for (let i = 0; i < 199; i++) {
      lines.push(JSON.stringify({
        schemaVersion: 1, id: `seed-${i}`, timestamp: new Date(Date.now() - (200 - i) * 1000).toISOString(),
        source: 'auto', category: 'color', preference: `seed-${i}`, confidence: 'low',
      }));
    }
    writeFileSync(path.join(dir, 'taste.jsonl'), lines.join('\n') + '\n');

    // Add 5 more — pushes total to 204, triggers FIFO prune to 200.
    for (let i = 0; i < 5; i++) {
      await mod.recordTaste({ category: 'layout', preference: `fresh-${i}` });
    }
    const all = await mod.loadTaste(500);
    assert.equal(all.length, 200);
    // The oldest 4 seeds should have been dropped
    assert.ok(!all.some((e) => e.id === 'seed-0'));
    assert.ok(!all.some((e) => e.id === 'seed-3'));
    assert.ok(all.some((e) => e.id === 'seed-4'));
    // Latest is the 5th fresh entry
    assert.equal(all[all.length - 1].preference, 'fresh-4');
  });
});

describe('taste-memory: pruneTaste explicit grammar', () => {
  let tmp; let saved;
  before(async () => { tmp = await makeTmp(); saved = process.cwd(); process.chdir(tmp); });
  after(async () => { process.chdir(saved); await fs.rm(tmp, { recursive: true, force: true }); });

  it('prune by id', async () => {
    const mod = await freshImport();
    const r = await mod.recordTaste({ category: 'color', preference: 'navy primary' });
    await mod.recordTaste({ category: 'color', preference: 'no neon' });
    const p = await mod.pruneTaste({ id: r.entry.id });
    assert.equal(p.removed, 1);
    const left = await mod.loadTaste(10);
    assert.equal(left.length, 1);
    assert.equal(left[0].preference, 'no neon');
  });

  it('prune by category', async () => {
    const mod = await freshImport();
    await mod.recordTaste({ category: 'typography', preference: 'serif headings' });
    await mod.recordTaste({ category: 'typography', preference: 'small caps' });
    await mod.recordTaste({ category: 'motion', preference: 'spring damping' });
    const p = await mod.pruneTaste({ category: 'typography' });
    assert.ok(p.removed >= 2);
    const left = await mod.loadTaste(10);
    assert.ok(!left.some((e) => e.category === 'typography'));
  });

  it('prune by before timestamp', async () => {
    const mod = await freshImport();
    const cutoff = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    await mod.recordTaste({ category: 'layout', preference: 'after-cutoff' });
    const p = await mod.pruneTaste({ before: cutoff });
    assert.ok(p.removed >= 1);
    const left = await mod.loadTaste(50);
    // The "after-cutoff" entry should remain
    assert.ok(left.some((e) => e.preference === 'after-cutoff'));
  });

  it('prune with empty selectors → ok:false (no accidental nuke) — US-009 hardening', async () => {
    const mod = await freshImport();
    await mod.recordTaste({ category: 'color', preference: 'do not delete me' });
    const before = await mod.loadTaste(100);
    const r = await mod.pruneTaste({});
    assert.equal(r.ok, false);
    assert.equal(r.removed, 0);
    assert.match(r.error || '', /requires at least one selector/);
    const after = await mod.loadTaste(100);
    assert.equal(after.length, before.length, 'history must be untouched');
  });

  it('prune with empty-string selectors also rejected', async () => {
    const mod = await freshImport();
    const r = await mod.pruneTaste({ id: '', category: '', before: '' });
    assert.equal(r.ok, false);
  });
});

describe('taste-memory: fail-safe loaders', () => {
  let tmp; let saved;
  before(async () => { tmp = await makeTmp(); saved = process.cwd(); process.chdir(tmp); });
  after(async () => { process.chdir(saved); await fs.rm(tmp, { recursive: true, force: true }); });

  it('returns [] when file missing', async () => {
    const mod = await freshImport();
    assert.deepEqual(await mod.loadTaste(20), []);
  });

  it('returns [] / skips lines when corrupted', async () => {
    const mod = await freshImport();
    const dir = path.join(tmp, '.ao', 'memory');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'taste.jsonl'), 'not json\n{"schemaVersion":1,"id":"x","timestamp":"2026-01-01","source":"user","category":"color","preference":"ok","confidence":"med"}\nbroken{\n');
    const loaded = await mod.loadTaste(10);
    // Only the valid line is loaded
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].preference, 'ok');
  });

  it('skips entries with schemaVersion > 1', async () => {
    const mod = await freshImport();
    const dir = path.join(tmp, '.ao', 'memory');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'taste.jsonl'), JSON.stringify({
      schemaVersion: 99, id: 'x', timestamp: '2026-01-01', source: 'user',
      category: 'color', preference: 'future', confidence: 'med',
    }) + '\n');
    const loaded = await mod.loadTaste(10);
    assert.equal(loaded.length, 0);
  });
});
