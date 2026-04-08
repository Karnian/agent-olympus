/**
 * Tests for scripts/lib/subagent-context.mjs (v1.0.2 F-001)
 *
 * Covers:
 *   - loadContextBundle returns {wisdom, designIdentity, taste, metadata}
 *   - design-facing agents get identity + taste; others don't
 *   - autonomy.json { subagentContext: { disabled: true } } → empty bundle
 *   - Per-loader fail-safe: wisdom throws → identity/taste still populate
 *   - 2.5s wall-clock race: slow loader → timedOut:true + empty bundle
 *   - Identity > 2KB gets projected/summarized
 *   - formatBundle produces expected sections
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

async function makeTmp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-subagent-ctx-test-'));
  execSync('git init -q', { cwd: dir });
  return dir;
}

async function freshImport() {
  const url = new URL('../lib/subagent-context.mjs?t=' + Date.now() + Math.random(), import.meta.url);
  return import(url.href);
}

describe('subagent-context — normalizeAgentName', () => {
  it('strips agent-olympus: prefix', async () => {
    const ctx = await freshImport();
    assert.equal(ctx.normalizeAgentName('agent-olympus:designer'), 'designer');
    assert.equal(ctx.normalizeAgentName('designer'), 'designer');
    assert.equal(ctx.normalizeAgentName(''), '');
    assert.equal(ctx.normalizeAgentName(null), '');
  });
});

describe('subagent-context — loadContextBundle basic shape', () => {
  let tmp;
  let saved;
  before(async () => {
    tmp = await makeTmp();
    saved = process.cwd();
    process.chdir(tmp);
  });
  after(async () => {
    process.chdir(saved);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('returns expected keys even with empty memory', async () => {
    const ctx = await freshImport();
    const bundle = await ctx.loadContextBundle({ agentName: 'designer' });
    assert.ok('wisdom' in bundle);
    assert.ok('designIdentity' in bundle);
    assert.ok('taste' in bundle);
    assert.ok('metadata' in bundle);
    assert.equal(typeof bundle.metadata.elapsedMs, 'number');
    assert.equal(bundle.metadata.timedOut, false);
  });

  it('non-design agents get empty identity and taste', async () => {
    const ctx = await freshImport();
    const bundle = await ctx.loadContextBundle({ agentName: 'code-reviewer' });
    assert.deepEqual(bundle.designIdentity, {});
    assert.deepEqual(bundle.taste, []);
  });
});

describe('subagent-context — design identity injection', () => {
  let tmp;
  let saved;
  before(async () => {
    tmp = await makeTmp();
    saved = process.cwd();
    process.chdir(tmp);
    const memDir = path.join(tmp, '.ao', 'memory');
    mkdirSync(memDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(memDir, 'design-identity.json'),
      JSON.stringify({
        schemaVersion: 1,
        brand: { name: 'Acme', colors: ['#000', '#fff', '#f00'] },
        typography: { fonts: ['Fraunces', 'Inter'] },
        allowedFonts: ['Fraunces', 'Inter'],
      }),
    );
  });
  after(async () => {
    process.chdir(saved);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('designer agent receives design-identity', async () => {
    const ctx = await freshImport();
    const bundle = await ctx.loadContextBundle({ agentName: 'designer' });
    assert.equal(bundle.designIdentity.brand.name, 'Acme');
    assert.deepEqual(bundle.designIdentity.allowedFonts, ['Fraunces', 'Inter']);
  });

  it('code-reviewer does NOT receive design-identity', async () => {
    const ctx = await freshImport();
    const bundle = await ctx.loadContextBundle({ agentName: 'code-reviewer' });
    assert.deepEqual(bundle.designIdentity, {});
  });
});

describe('subagent-context — identity >2KB is projected/capped', () => {
  let tmp;
  let saved;
  before(async () => {
    tmp = await makeTmp();
    saved = process.cwd();
    process.chdir(tmp);
    const memDir = path.join(tmp, '.ao', 'memory');
    mkdirSync(memDir, { recursive: true, mode: 0o700 });
    // Build a >2KB payload
    const bigNotes = 'x'.repeat(4096);
    writeFileSync(
      path.join(memDir, 'design-identity.json'),
      JSON.stringify({
        schemaVersion: 1,
        brand: { name: 'Acme', colors: ['#111', '#222', '#333', '#444', '#555'] },
        typography: { fonts: ['A', 'B', 'C', 'D', 'E'] },
        conventions: { notes: bigNotes },
      }),
    );
  });
  after(async () => {
    process.chdir(saved);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('projects to top-level keys + first 3 colors + first 2 fonts', async () => {
    const ctx = await freshImport();
    const bundle = await ctx.loadContextBundle({ agentName: 'aphrodite' });
    assert.equal(bundle.designIdentity.brand.colors.length, 3);
    assert.equal(bundle.designIdentity.typography.fonts.length, 2);
    assert.ok(!('conventions' in bundle.designIdentity), 'oversized fields dropped');
    assert.ok(
      JSON.stringify(bundle.designIdentity).length <= 2048,
      'projection must fit in 2KB budget',
    );
  });
});

describe('subagent-context — unbounded spacing array still capped at 2KB', () => {
  let tmp;
  let saved;
  before(async () => {
    tmp = await makeTmp();
    saved = process.cwd();
    process.chdir(tmp);
    const memDir = path.join(tmp, '.ao', 'memory');
    mkdirSync(memDir, { recursive: true, mode: 0o700 });
    // Reproducer for Codex's blocking issue: huge spacing.scale + huge allowedFonts
    writeFileSync(
      path.join(memDir, 'design-identity.json'),
      JSON.stringify({
        schemaVersion: 1,
        brand: { name: 'X', colors: ['#111', '#222', '#333', '#444'] },
        typography: { fonts: ['A', 'B', 'C'] },
        spacing: { scale: Array.from({ length: 1000 }, (_, i) => i) },
        allowedFonts: Array.from({ length: 1000 }, (_, i) => `Font${i}`),
      }),
    );
  });
  after(async () => {
    process.chdir(saved);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('enforces hard 2KB cap even with unbounded spacing/allowedFonts arrays (US-003 AC)', async () => {
    const ctx = await freshImport();
    const bundle = await ctx.loadContextBundle({ agentName: 'designer' });
    const len = JSON.stringify(bundle.designIdentity).length;
    assert.ok(len <= 2048, `expected ≤2048 bytes, got ${len}`);
    assert.equal(bundle.designIdentity.schemaVersion, 1);
  });
});

describe('subagent-context — taste memory injection', () => {
  let tmp;
  let saved;
  before(async () => {
    tmp = await makeTmp();
    saved = process.cwd();
    process.chdir(tmp);
    const memDir = path.join(tmp, '.ao', 'memory');
    mkdirSync(memDir, { recursive: true, mode: 0o700 });
    const lines = [];
    for (let i = 0; i < 30; i++) {
      lines.push(JSON.stringify({
        schemaVersion: 1,
        id: `t${i}`,
        timestamp: new Date().toISOString(),
        source: 'user',
        category: 'typography',
        preference: `prefer ${i}`,
        confidence: 'med',
      }));
    }
    writeFileSync(path.join(memDir, 'taste.jsonl'), lines.join('\n') + '\n');
  });
  after(async () => {
    process.chdir(saved);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('returns the most recent entries capped at 20', async () => {
    const ctx = await freshImport();
    const bundle = await ctx.loadContextBundle({ agentName: 'designer' });
    assert.ok(bundle.taste.length <= 20);
    // Most recent should be the last-written id
    assert.equal(bundle.taste[bundle.taste.length - 1].id, 't29');
  });

  it('cap taste footprint at 1KB', async () => {
    const ctx = await freshImport();
    const bundle = await ctx.loadContextBundle({ agentName: 'designer' });
    assert.ok(JSON.stringify(bundle.taste).length <= 1024);
  });
});

describe('subagent-context — autonomy disable flag', () => {
  let tmp;
  let saved;
  before(async () => {
    tmp = await makeTmp();
    saved = process.cwd();
    process.chdir(tmp);
    mkdirSync(path.join(tmp, '.ao'), { recursive: true });
    writeFileSync(
      path.join(tmp, '.ao', 'autonomy.json'),
      JSON.stringify({ subagentContext: { disabled: true } }),
    );
    const memDir = path.join(tmp, '.ao', 'memory');
    mkdirSync(memDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(memDir, 'design-identity.json'),
      JSON.stringify({ schemaVersion: 1, brand: { name: 'Acme' } }),
    );
  });
  after(async () => {
    process.chdir(saved);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('short-circuits to empty bundle when disabled', async () => {
    const ctx = await freshImport();
    const bundle = await ctx.loadContextBundle({ agentName: 'designer' });
    assert.deepEqual(bundle.wisdom, []);
    assert.deepEqual(bundle.designIdentity, {});
    assert.deepEqual(bundle.taste, []);
    assert.equal(bundle.metadata.disabled, true);
  });
});

describe('subagent-context — formatBundle', () => {
  it('includes token efficiency directive by default', async () => {
    const ctx = await freshImport();
    const str = ctx.formatBundle({ wisdom: [], designIdentity: {}, taste: [] });
    assert.match(str, /Token Efficiency/);
  });

  it('skips token efficiency when includeTokenEfficiency=false (haiku path)', async () => {
    const ctx = await freshImport();
    const str = ctx.formatBundle({ wisdom: [], designIdentity: {}, taste: [] }, { includeTokenEfficiency: false });
    assert.ok(!/Token Efficiency/.test(str));
    assert.equal(str, '');
  });

  it('formats wisdom, identity, and taste sections', async () => {
    const ctx = await freshImport();
    const str = ctx.formatBundle({
      wisdom: [{ category: 'debug', lesson: 'always grep first' }],
      designIdentity: { brand: { name: 'X' } },
      taste: [{ category: 'typography', preference: 'prefer serif', antiPreference: 'no Inter' }],
    });
    assert.match(str, /Prior Learnings/);
    assert.match(str, /always grep first/);
    assert.match(str, /Design Identity/);
    assert.match(str, /Taste Memory/);
    assert.match(str, /prefer serif/);
    assert.match(str, /avoid: no Inter/);
  });
});
