/**
 * Tests for scripts/lib/ui-reference.mjs (v1.0.2 US-002)
 *
 * Covers all acceptance criteria:
 *   1. selectModules returns a subset of CANONICAL_MODULES
 *   2. CSS-only path → color-and-contrast + spatial-design + responsive-design
 *   3. tsx + className/style/font content → typography + color + spatial
 *   4. copy-only change (i18n JSON) → ['ux-writing']
 *   5. keyframes/transition → motion-design + interaction-design
 *   6. no-match → full 7 modules + warning logged
 *   7. loadModule returns file content for each canonical module
 *   8. every reference module has domain + 5 principles + 5 anti-patterns +
 *      1 worked example + schemaVersion frontmatter
 *   9. ≥ 7 test cases covering css-only, tsx+style, copy-only, motion,
 *      no-match-fallback, mixed-bag, empty-input
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function freshImport() {
  const url = new URL('../lib/ui-reference.mjs?t=' + Date.now() + Math.random(), import.meta.url);
  return import(url.href);
}

describe('ui-reference: CANONICAL_MODULES', () => {
  it('exposes the 7 canonical modules in a stable order', async () => {
    const mod = await freshImport();
    assert.deepEqual(mod.CANONICAL_MODULES, [
      'typography',
      'color-and-contrast',
      'spatial-design',
      'motion-design',
      'interaction-design',
      'responsive-design',
      'ux-writing',
    ]);
  });
});

describe('ui-reference: selectModules — 7+ canonical test cases', () => {
  // Case 1 — css-only
  it('case 1: css-only diff → color-and-contrast + spatial-design + responsive-design', async () => {
    const mod = await freshImport();
    const result = mod.selectModules({ diffPaths: ['src/styles/buttons.css'] });
    assert.ok(result.includes('color-and-contrast'));
    assert.ok(result.includes('spatial-design'));
    assert.ok(result.includes('responsive-design'));
  });

  // Case 2 — tsx + className/style/font
  it('case 2: tsx with className/font → typography + color-and-contrast + spatial-design (at minimum)', async () => {
    const mod = await freshImport();
    const result = mod.selectModules({
      diffPaths: ['src/components/Button.tsx'],
      diffContent: 'className="text-lg font-bold bg-indigo-600"',
    });
    assert.ok(result.includes('typography'));
    assert.ok(result.includes('color-and-contrast'));
    assert.ok(result.includes('spatial-design'));
  });

  // Case 3 — copy-only (i18n JSON)
  it('case 3: i18n JSON change → [ux-writing] only', async () => {
    const mod = await freshImport();
    const result = mod.selectModules({ diffPaths: ['src/i18n/errors.json'] });
    assert.deepEqual(result, ['ux-writing']);
  });

  it('case 3b: locales/en.yaml → [ux-writing] only', async () => {
    const mod = await freshImport();
    const result = mod.selectModules({ diffPaths: ['locales/en.yaml'] });
    assert.deepEqual(result, ['ux-writing']);
  });

  // Case 4 — motion
  it('case 4: keyframes/transition → motion-design + interaction-design', async () => {
    const mod = await freshImport();
    const result = mod.selectModules({
      diffPaths: ['src/animations.css'],
      diffContent: '@keyframes slide { from { transform: translateY(-8px); } to { transform: translateY(0); } }',
    });
    assert.ok(result.includes('motion-design'));
    assert.ok(result.includes('interaction-design'));
  });

  // Case 5 — no match → full fallback
  it('case 5: no-match (backend .go) → full 7-module fallback', async () => {
    const mod = await freshImport();
    const result = mod.selectModules({ diffPaths: ['cmd/main.go'] });
    assert.equal(result.length, 7);
    assert.deepEqual(result, mod.CANONICAL_MODULES);
  });

  // Case 6 — mixed bag
  it('case 6: mixed (css + component + layout) → multiple modules', async () => {
    const mod = await freshImport();
    const result = mod.selectModules({
      diffPaths: ['src/styles/layout.css', 'src/components/Card.tsx'],
      diffContent: 'font-family: "Söhne"; @media (min-width: 768px) { ... }',
    });
    assert.ok(result.includes('typography'));
    assert.ok(result.includes('color-and-contrast'));
    assert.ok(result.includes('spatial-design'));
    assert.ok(result.includes('responsive-design'));
  });

  // Case 7 — empty input → fallback
  it('case 7: empty diffPaths → full 7-module fallback (with warning)', async () => {
    const mod = await freshImport();
    const result = mod.selectModules({ diffPaths: [] });
    assert.equal(result.length, 7);
  });
});

describe('ui-reference: loadModule', () => {
  it('loads each canonical module from skills/ui-review/reference/', async () => {
    const mod = await freshImport();
    for (const name of mod.CANONICAL_MODULES) {
      const content = mod.loadModule(name);
      assert.ok(content.length > 100, `${name}.md should have meaningful content`);
      assert.ok(content.includes('schemaVersion: 1'), `${name}.md must carry schemaVersion: 1`);
    }
  });

  it('returns empty string for unknown module', async () => {
    const mod = await freshImport();
    assert.equal(mod.loadModule('not-a-module'), '');
  });
});

describe('ui-reference: every module has required sections', () => {
  const CANONICAL = [
    'typography',
    'color-and-contrast',
    'spatial-design',
    'motion-design',
    'interaction-design',
    'responsive-design',
    'ux-writing',
  ];

  for (const name of CANONICAL) {
    it(`${name}.md has domain, 5 principles, 5 anti-patterns, worked example`, () => {
      const filePath = path.resolve(
        __dirname, '..', '..', 'skills', 'ui-review', 'reference', `${name}.md`,
      );
      const content = readFileSync(filePath, 'utf-8');
      assert.ok(/^---\nschemaVersion: 1/m.test(content), 'has schemaVersion frontmatter');
      assert.ok(/## Domain/.test(content), 'has Domain section');
      assert.ok(/## Top 5 principles/.test(content), 'has Top 5 principles');
      assert.ok(/## Top 5 anti-patterns/.test(content), 'has Top 5 anti-patterns');
      assert.ok(/## Worked example/.test(content), 'has Worked example');

      // Count principle + anti-pattern list items (must be at least 5 each)
      const principleSection = content.split(/## Top 5 principles/)[1]?.split(/## /)[0] || '';
      const antiSection = content.split(/## Top 5 anti-patterns/)[1]?.split(/## /)[0] || '';
      const principleCount = (principleSection.match(/^\d+\./gm) || []).length;
      const antiCount = (antiSection.match(/^\d+\./gm) || []).length;
      assert.ok(principleCount >= 5, `${name}: ${principleCount} principles found`);
      assert.ok(antiCount >= 5, `${name}: ${antiCount} anti-patterns found`);
    });
  }
});
