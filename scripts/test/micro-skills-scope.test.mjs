/**
 * Tests for scripts/lib/micro-skill-scope.mjs (v1.0.2 US-004)
 *
 * Asserts each micro-skill's scope-confirmation contract on fixture diffs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

async function freshImport() {
  const url = new URL('../lib/micro-skill-scope.mjs?t=' + Date.now() + Math.random(), import.meta.url);
  return import(url.href);
}

const ARRANGE_ONLY_DIFF = `
diff --git a/src/Card.css b/src/Card.css
--- a/src/Card.css
+++ b/src/Card.css
@@ -1,4 +1,5 @@
 .card {
-  padding: 12px;
+  padding: 16px;
+  gap: 8px;
   display: flex;
 }
`;

const TYPESET_ONLY_DIFF = `
diff --git a/src/Heading.css b/src/Heading.css
--- a/src/Heading.css
+++ b/src/Heading.css
@@ -1,3 +1,4 @@
 h1 {
-  font-size: 24px;
+  font-size: 32px;
+  font-weight: 600;
 }
`;

const ARRANGE_WITH_TYPOGRAPHY_VIOLATION = `
diff --git a/src/Card.css b/src/Card.css
--- a/src/Card.css
+++ b/src/Card.css
@@ -1,3 +1,4 @@
 .card {
-  padding: 12px;
+  padding: 16px;
+  font-family: "Fraunces";
 }
`;

const NORMALIZE_DIFF = `
diff --git a/src/Btn.css b/src/Btn.css
--- a/src/Btn.css
+++ b/src/Btn.css
@@ -1,3 +1,3 @@
 .btn {
-  color: #5a4fe8;
+  color: var(--brand-primary);
 }
`;

describe('micro-skill-scope: classifyDiffLine', () => {
  it('tags a font-family line as typography', async () => {
    const m = await freshImport();
    const tags = m.classifyDiffLine('+  font-family: "Fraunces";');
    assert.ok(tags.has('typography'));
  });

  it('tags a padding line as layout', async () => {
    const m = await freshImport();
    const tags = m.classifyDiffLine('+  padding: 16px;');
    assert.ok(tags.has('layout'));
  });

  it('tags var(--brand) as token', async () => {
    const m = await freshImport();
    const tags = m.classifyDiffLine('+  color: var(--brand-primary);');
    assert.ok(tags.has('token'));
    assert.ok(tags.has('color'));
  });

  it('ignores context lines', async () => {
    const m = await freshImport();
    assert.equal(m.classifyDiffLine('  padding: 16px;').size, 0);
    assert.equal(m.classifyDiffLine('@@ -1,3 +1,4 @@').size, 0);
  });

  it('ignores file headers +++ / ---', async () => {
    const m = await freshImport();
    assert.equal(m.classifyDiffLine('+++ b/src/Card.css').size, 0);
    assert.equal(m.classifyDiffLine('--- a/src/Card.css').size, 0);
  });
});

describe('micro-skill-scope: /arrange scope enforcement', () => {
  it('layout-only diff passes arrange scope with 0 typography', async () => {
    const m = await freshImport();
    const r = m.checkScope(ARRANGE_ONLY_DIFF, m.MICRO_SKILL_SCOPES.arrange);
    assert.equal(r.ok, true);
    assert.equal(r.counts.typography, 0);
    assert.ok(r.counts.layout > 0);
  });

  it('diff with font-family fails arrange scope', async () => {
    const m = await freshImport();
    const r = m.checkScope(ARRANGE_WITH_TYPOGRAPHY_VIOLATION, m.MICRO_SKILL_SCOPES.arrange);
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.startsWith('typography')));
  });
});

describe('micro-skill-scope: /typeset scope enforcement', () => {
  it('typography-only diff passes typeset scope', async () => {
    const m = await freshImport();
    const r = m.checkScope(TYPESET_ONLY_DIFF, m.MICRO_SKILL_SCOPES.typeset);
    assert.equal(r.ok, true);
    assert.ok(r.counts.typography > 0);
    assert.equal(r.counts.layout, 0);
  });

  it('layout-only diff fails typeset scope', async () => {
    const m = await freshImport();
    const r = m.checkScope(ARRANGE_ONLY_DIFF, m.MICRO_SKILL_SCOPES.typeset);
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.startsWith('layout')));
  });
});

describe('micro-skill-scope: /normalize token signal', () => {
  it('var(--brand) replacement is classified as token', async () => {
    const m = await freshImport();
    const counts = m.classifyDiff(NORMALIZE_DIFF);
    assert.ok(counts.token > 0);
    assert.ok(counts.color > 0);
  });

  it('normalize allows token + color + typography + layout + motion', async () => {
    const m = await freshImport();
    const r = m.checkScope(NORMALIZE_DIFF, m.MICRO_SKILL_SCOPES.normalize);
    assert.equal(r.ok, true);
  });
});

describe('micro-skill-scope: /polish wide scope', () => {
  it('accepts a mixed diff', async () => {
    const m = await freshImport();
    const mixed = ARRANGE_ONLY_DIFF + '\n' + TYPESET_ONLY_DIFF;
    const r = m.checkScope(mixed, m.MICRO_SKILL_SCOPES.polish);
    assert.equal(r.ok, true);
    assert.ok(r.counts.layout > 0);
    assert.ok(r.counts.typography > 0);
  });
});

describe('micro-skill-scope: classifyDiff counts', () => {
  it('reports lines, total, and per-category counts', async () => {
    const m = await freshImport();
    const c = m.classifyDiff(ARRANGE_ONLY_DIFF);
    assert.ok(c.lines >= 2);
    assert.ok(c.layout >= 2);
    assert.equal(c.typography, 0);
    assert.equal(c.motion, 0);
  });

  it('empty diff returns zero counts', async () => {
    const m = await freshImport();
    const c = m.classifyDiff('');
    assert.equal(c.lines, 0);
    assert.equal(c.total, 0);
  });
});
