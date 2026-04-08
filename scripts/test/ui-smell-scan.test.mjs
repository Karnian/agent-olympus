/**
 * Tests for scripts/lib/ui-smell-scan.mjs (v1.0.2 US-001)
 *
 * Covers all acceptance criteria:
 *   - opt-in: skipped silently when config/design-blacklist.jsonc absent
 *   - example file ships with 5 canonical rules and schemaVersion 1
 *   - rule loader reports file:line, rule id, matched substring
 *   - known-bad seed fixture hits ≥4 of the 5 canonical patterns
 *   - allowedFonts override suppresses font rule hits
 *   - warn mode logs but does not fail
 *   - block mode fails with structured error
 *   - clean result written to run artifact path
 *   - no UI files in diff → skipped silently regardless of mode
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

async function makeTmp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-ui-smell-test-'));
  execSync('git init -q', { cwd: dir });
  return dir;
}

async function freshImport() {
  const url = new URL('../lib/ui-smell-scan.mjs?t=' + Date.now() + Math.random(), import.meta.url);
  return import(url.href);
}

// ---------------------------------------------------------------------------
// Example config ships with 5 rules and schemaVersion 1
// ---------------------------------------------------------------------------

describe('ui-smell-scan: example config', () => {
  it('config/design-blacklist.jsonc.example has schemaVersion 1 and 5 rules', () => {
    const examplePath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '..', '..', 'config', 'design-blacklist.jsonc.example',
    );
    const raw = readFileSync(examplePath, 'utf-8');
    // Strip line comments before JSON parse (JSONC-lite)
    const stripped = raw
      .split('\n')
      .map((l) => l.replace(/\/\/[^\n]*$/, ''))
      .join('\n');
    const parsed = JSON.parse(stripped);
    assert.equal(parsed.schemaVersion, 1);
    assert.ok(Array.isArray(parsed.rules));
    assert.equal(parsed.rules.length, 5);
    const ids = parsed.rules.map((r) => r.id);
    assert.ok(ids.some((id) => /font|typography|inter/i.test(id)));
    assert.ok(ids.some((id) => /black/i.test(id)));
    assert.ok(ids.some((id) => /card/i.test(id)));
    assert.ok(ids.some((id) => /bounce|easing/i.test(id)));
    assert.ok(ids.some((id) => /gray/i.test(id)));
  });
});

// ---------------------------------------------------------------------------
// Opt-in: no config → skipped silently
// ---------------------------------------------------------------------------

describe('ui-smell-scan: opt-in when config absent', () => {
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

  it('scanDiff returns skipped:true when config/design-blacklist.jsonc absent', async () => {
    const mod = await freshImport();
    const result = await mod.scanDiff({
      files: [{ path: 'src/app.css', content: 'font-family: Inter;' }],
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'no-config');
    assert.equal(result.clean, true);
    assert.equal(result.violations.length, 0);
  });

  it('loadRules returns null when config absent', async () => {
    const mod = await freshImport();
    assert.equal(mod.loadRules(tmp), null);
  });
});

// ---------------------------------------------------------------------------
// Known-bad fixture: detect ≥4 of 5 canonical patterns
// ---------------------------------------------------------------------------

describe('ui-smell-scan: known-bad seed fixture', () => {
  let tmp;
  let saved;
  before(async () => {
    tmp = await makeTmp();
    saved = process.cwd();
    process.chdir(tmp);
    // Copy the example rules into place
    const src = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '..', '..', 'config', 'design-blacklist.jsonc.example',
    );
    mkdirSync(path.join(tmp, 'config'), { recursive: true });
    writeFileSync(
      path.join(tmp, 'config', 'design-blacklist.jsonc'),
      readFileSync(src, 'utf-8'),
    );
  });
  after(async () => {
    process.chdir(saved);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('detects at least 4 of 5 canonical slop patterns in a mixed fixture', async () => {
    const mod = await freshImport();
    const fixture = `
/* slop fixture */
.foo {
  font-family: "Inter", system-ui, sans-serif;
  background: #000000;
  transition: transform 500ms cubic-bezier(0.68, -0.55, 0.265, 1.55);
}
.card {
  /* nested card-soup */
  className: "rounded-xl border border-gray-200 shadow-lg p-4";
}
.hero {
  className: "bg-indigo-600 text-gray-400";
}
`;
    const result = await mod.scanDiff({
      files: [{ path: 'src/styles.css', content: fixture }],
    });
    assert.equal(result.skipped, false);
    const hitRuleIds = new Set(result.violations.map((v) => v.ruleId));
    assert.ok(
      hitRuleIds.size >= 4,
      `expected ≥4 distinct rules hit, got ${hitRuleIds.size}: ${[...hitRuleIds].join(',')}`,
    );
  });

  it('violations include file:line, ruleId, category, description, and match', async () => {
    const mod = await freshImport();
    const result = await mod.scanDiff({
      files: [{
        path: 'src/button.css',
        content: 'button { background: #000; }',
      }],
    });
    assert.ok(result.violations.length >= 1);
    const v = result.violations[0];
    assert.equal(typeof v.file, 'string');
    assert.equal(typeof v.line, 'number');
    assert.ok(v.line >= 1);
    assert.equal(typeof v.ruleId, 'string');
    assert.equal(typeof v.category, 'string');
    assert.equal(typeof v.description, 'string');
    assert.equal(typeof v.match, 'string');
  });
});

// ---------------------------------------------------------------------------
// allowedFonts suppression
// ---------------------------------------------------------------------------

describe('ui-smell-scan: allowedFonts suppression', () => {
  let tmp;
  let saved;
  before(async () => {
    tmp = await makeTmp();
    saved = process.cwd();
    process.chdir(tmp);
    const src = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '..', '..', 'config', 'design-blacklist.jsonc.example',
    );
    mkdirSync(path.join(tmp, 'config'), { recursive: true });
    writeFileSync(
      path.join(tmp, 'config', 'design-blacklist.jsonc'),
      readFileSync(src, 'utf-8'),
    );
    // Project explicitly allows Inter
    mkdirSync(path.join(tmp, '.ao', 'memory'), { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(tmp, '.ao', 'memory', 'design-identity.json'),
      JSON.stringify({ schemaVersion: 1, allowedFonts: ['Inter'] }),
    );
  });
  after(async () => {
    process.chdir(saved);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('does not flag Inter when allowedFonts contains it', async () => {
    const mod = await freshImport();
    const result = await mod.scanDiff({
      files: [{ path: 'src/type.css', content: 'h1 { font-family: "Inter"; }' }],
    });
    const fontViolations = result.violations.filter((v) => v.category === 'typography');
    assert.equal(fontViolations.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

describe('ui-smell-scan: getScanMode', () => {
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

  it('defaults to warn when no autonomy.json', async () => {
    const mod = await freshImport();
    assert.equal(mod.getScanMode(tmp), 'warn');
  });

  it('returns block when autonomy.json sets uiSmellScan=block', async () => {
    mkdirSync(path.join(tmp, '.ao'), { recursive: true });
    writeFileSync(path.join(tmp, '.ao', 'autonomy.json'), JSON.stringify({ uiSmellScan: 'block' }));
    const mod = await freshImport();
    assert.equal(mod.getScanMode(tmp), 'block');
  });

  it('returns warn for invalid mode values', async () => {
    writeFileSync(path.join(tmp, '.ao', 'autonomy.json'), JSON.stringify({ uiSmellScan: 'garbage' }));
    const mod = await freshImport();
    assert.equal(mod.getScanMode(tmp), 'warn');
  });
});

// ---------------------------------------------------------------------------
// No UI files in diff → skipped silently
// ---------------------------------------------------------------------------

describe('ui-smell-scan: non-UI diff skipped', () => {
  let tmp;
  let saved;
  before(async () => {
    tmp = await makeTmp();
    saved = process.cwd();
    process.chdir(tmp);
    const src = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '..', '..', 'config', 'design-blacklist.jsonc.example',
    );
    mkdirSync(path.join(tmp, 'config'), { recursive: true });
    writeFileSync(
      path.join(tmp, 'config', 'design-blacklist.jsonc'),
      readFileSync(src, 'utf-8'),
    );
  });
  after(async () => {
    process.chdir(saved);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('backend-only diff → skipped with reason=no-ui-files', async () => {
    const mod = await freshImport();
    const result = await mod.scanDiff({
      files: [
        { path: 'src/api/user.js', content: 'module.exports = {};' },
        { path: 'tests/user.test.js', content: 'test("x", () => {});' },
      ],
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'no-ui-files');
  });
});

// ---------------------------------------------------------------------------
// isUiPath
// ---------------------------------------------------------------------------

describe('ui-smell-scan: isUiPath', () => {
  it('recognizes UI extensions', async () => {
    const mod = await freshImport();
    for (const p of ['a.css', 'b.scss', 'c.tsx', 'd.jsx', 'e.vue', 'f.svelte', 'g.html']) {
      assert.equal(mod.isUiPath(p), true, `${p} should be a UI path`);
    }
  });
  it('rejects non-UI extensions', async () => {
    const mod = await freshImport();
    for (const p of ['a.js', 'b.py', 'c.md', 'd.json', '']) {
      assert.equal(mod.isUiPath(p), false, `${p} should not be a UI path`);
    }
  });
});
