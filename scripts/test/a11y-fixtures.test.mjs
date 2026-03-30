/**
 * Seeded-fixture tests for a11y audit detection patterns.
 *
 * These tests verify that the grep-based detection patterns used by
 * Aphrodite and the /a11y-audit skill correctly identify known violations
 * in the seeded fixture file and produce zero false positives on the
 * clean fixture file.
 *
 * Uses node:test — zero npm dependencies.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIOLATIONS_FILE = join(__dirname, 'fixtures', 'a11y-violations.jsx');
const CLEAN_FILE = join(__dirname, 'fixtures', 'a11y-clean.jsx');

const violationsSource = readFileSync(VIOLATIONS_FILE, 'utf-8');
const cleanSource = readFileSync(CLEAN_FILE, 'utf-8');

// ---------------------------------------------------------------------------
// Detection patterns — these mirror what Aphrodite checks via code review
// ---------------------------------------------------------------------------

const A11Y_PATTERNS = {
  // WCAG 1.1.1: img without alt
  imgWithoutAlt: /<img\b(?![^>]*\balt\s*=)[^>]*>/gi,

  // WCAG 4.1.2: div/span with onClick (should be button/a)
  divWithOnClick: /<div\b[^>]*\bonClick\b/gi,

  // WCAG 1.3.1: input without associated label (heuristic: input not preceded by label)
  inputWithoutLabel: /<input\b(?![^>]*\baria-label\b)(?![^>]*\baria-labelledby\b)[^>]*>/gi,

  // WCAG 2.4.7: outline:none without replacement focus style
  outlineNone: /outline:\s*(?:none|0)\b/gi,

  // WCAG 2.4.4: non-descriptive link text
  badLinkText: />\s*(?:click here|read more|here|learn more)\s*</gi,

  // WCAG anti-pattern: tabindex > 0
  positiveTabindex: /tabIndex\s*=\s*\{?\s*[1-9]/gi,

  // WCAG 2.5.8: small touch targets (heuristic: explicit small dimensions)
  smallTouchTarget: /(?:width|height):\s*['"]?(?:1[0-9]|2[0-9]|3[0-9]|[0-9])px/gi,

  // WCAG 1.4.3: hardcoded low-contrast pairs (heuristic: #aaa+ on #fff)
  suspiciousContrast: /color:\s*['"]?#[aA-fF]{3,6}['"]?/gi,
};

// ---------------------------------------------------------------------------
// Tests: violations fixture should trigger all patterns
// ---------------------------------------------------------------------------

test('a11y fixture: img without alt is detected', () => {
  const matches = violationsSource.match(A11Y_PATTERNS.imgWithoutAlt);
  assert.ok(matches && matches.length >= 1, 'should find at least 1 img without alt');
});

test('a11y fixture: div with onClick is detected', () => {
  const matches = violationsSource.match(A11Y_PATTERNS.divWithOnClick);
  assert.ok(matches && matches.length >= 1, 'should find at least 1 div with onClick');
});

test('a11y fixture: outline:none is detected', () => {
  const matches = violationsSource.match(A11Y_PATTERNS.outlineNone);
  assert.ok(matches && matches.length >= 1, 'should find outline:none');
});

test('a11y fixture: bad link text is detected', () => {
  const matches = violationsSource.match(A11Y_PATTERNS.badLinkText);
  assert.ok(matches && matches.length >= 1, 'should find non-descriptive link text');
});

test('a11y fixture: positive tabindex is detected', () => {
  const matches = violationsSource.match(A11Y_PATTERNS.positiveTabindex);
  assert.ok(matches && matches.length >= 1, 'should find tabindex > 0');
});

test('a11y fixture: small touch target is detected', () => {
  const matches = violationsSource.match(A11Y_PATTERNS.smallTouchTarget);
  assert.ok(matches && matches.length >= 1, 'should find touch targets < 44px');
});

test('a11y fixture: heading skip is present (h1 → h3)', () => {
  const h1 = violationsSource.includes('<h1>');
  const h3 = violationsSource.includes('<h3>');
  const h2Between = violationsSource.indexOf('<h2>') > -1 &&
    violationsSource.indexOf('<h2>') < violationsSource.indexOf('<h3>');
  assert.ok(h1 && h3, 'fixture has h1 and h3');
  assert.ok(!h2Between, 'h2 should not appear before h3 (skip present)');
});

test('a11y fixture: aria-live missing on dynamic content', () => {
  // BadLiveRegion has no aria-live attribute
  const badRegion = violationsSource.match(/id="status-message"(?![^>]*aria-live)/);
  assert.ok(badRegion, 'should find status-message div without aria-live');
});

// ---------------------------------------------------------------------------
// Tests: clean fixture should have zero violations
// ---------------------------------------------------------------------------

test('a11y clean: no img without alt', () => {
  const matches = cleanSource.match(A11Y_PATTERNS.imgWithoutAlt);
  assert.equal(matches, null, 'clean file should have no img without alt');
});

test('a11y clean: no div with onClick', () => {
  const matches = cleanSource.match(A11Y_PATTERNS.divWithOnClick);
  assert.equal(matches, null, 'clean file should have no div with onClick');
});

test('a11y clean: no bad link text', () => {
  const matches = cleanSource.match(A11Y_PATTERNS.badLinkText);
  assert.equal(matches, null, 'clean file should have no bad link text');
});

test('a11y clean: no positive tabindex', () => {
  const matches = cleanSource.match(A11Y_PATTERNS.positiveTabindex);
  assert.equal(matches, null, 'clean file should have no tabindex > 0');
});

test('a11y clean: all images have alt text', () => {
  const allImgs = cleanSource.match(/<img\b[^>]*>/gi) || [];
  for (const img of allImgs) {
    assert.ok(/\balt\s*=/.test(img), `img should have alt: ${img}`);
  }
});

test('a11y clean: all buttons use semantic HTML', () => {
  const divClicks = cleanSource.match(/<div\b[^>]*\bonClick\b/gi);
  assert.equal(divClicks, null, 'clean file should have no div with onClick');
  const buttons = cleanSource.match(/<button\b/gi);
  assert.ok(buttons && buttons.length >= 1, 'clean file should use <button> elements');
});

test('a11y clean: all interactive labels have aria-label or visible text', () => {
  const iconButtons = cleanSource.match(/<button\b[^>]*>[^<]*<svg/gi) || [];
  for (const btn of iconButtons) {
    const hasAriaLabel = /aria-label\s*=/.test(
      cleanSource.slice(
        cleanSource.indexOf(btn),
        cleanSource.indexOf(btn) + btn.length + 200
      )
    );
    assert.ok(hasAriaLabel, 'icon button should have aria-label');
  }
});

test('a11y clean: live regions have aria-live attribute', () => {
  const statusDivs = cleanSource.match(/id="status-message"[^>]*/gi) || [];
  for (const div of statusDivs) {
    assert.ok(/aria-live/.test(div), 'status div should have aria-live');
  }
});

// ---------------------------------------------------------------------------
// Fixture integrity: both files exist and are non-trivial
// ---------------------------------------------------------------------------

test('fixture integrity: violations file has 15+ planted issues', () => {
  const violationComments = (violationsSource.match(/VIOLATION \d+/g) || []).length;
  assert.ok(violationComments >= 15, `expected 15+ violations, found ${violationComments}`);
});

test('fixture integrity: clean file has zero VIOLATION markers', () => {
  const violationComments = (cleanSource.match(/VIOLATION/g) || []).length;
  assert.equal(violationComments, 0, 'clean file should have no VIOLATION markers');
});
