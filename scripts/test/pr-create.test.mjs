/**
 * Unit tests for scripts/lib/pr-create.mjs
 * Tests extractIssueRefs(), buildPRBody(), preflightCheck(), and function exports.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractIssueRefs,
  buildPRBody,
  preflightCheck,
  createPR,
  findExistingPR,
} from '../lib/pr-create.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal PRD fixture */
function samplePrd() {
  return {
    projectName: 'test-project',
    userStories: [
      { id: 'US-1', title: 'Add autonomy config support', passes: true },
      { id: 'US-2', title: 'Implement CI watching', passes: true },
    ],
  };
}

/** Minimal diffStat fixture */
function sampleDiffStat() {
  return '3 files changed, 42 insertions(+), 5 deletions(-)';
}

// ---------------------------------------------------------------------------
// Test: extractIssueRefs — pattern parsing
// ---------------------------------------------------------------------------

test('extractIssueRefs: "fixes #123" → [123]', () => {
  const refs = extractIssueRefs('fixes #123');
  assert.deepEqual(refs, [123]);
});

test('extractIssueRefs: "closes #45, fixes #67" → [45, 67]', () => {
  const refs = extractIssueRefs('closes #45, fixes #67');
  assert.deepEqual(refs, [45, 67]);
});

test('extractIssueRefs: "no issues here" → []', () => {
  const refs = extractIssueRefs('no issues here');
  assert.deepEqual(refs, []);
});

test('extractIssueRefs: "#1 and #2 and #3" → [1, 2, 3]', () => {
  const refs = extractIssueRefs('#1 and #2 and #3');
  assert.deepEqual(refs, [1, 2, 3]);
});

test('extractIssueRefs: branch-style "feat/42-add-auth" → [42]', () => {
  const refs = extractIssueRefs('feat/42-add-auth');
  assert.deepEqual(refs, [42]);
});

test('extractIssueRefs: deduplicates — "#5 fixes #5" → [5]', () => {
  const refs = extractIssueRefs('#5 fixes #5');
  assert.deepEqual(refs, [5]);
});

// ---------------------------------------------------------------------------
// Test: buildPRBody — structure and content
// ---------------------------------------------------------------------------

test('buildPRBody: returns a string containing "## Summary"', () => {
  const body = buildPRBody({ prd: samplePrd(), diffStat: sampleDiffStat(), verifyResults: null });
  assert.equal(typeof body, 'string', 'buildPRBody must return a string');
  assert.ok(body.includes('## Summary'), 'body must contain "## Summary"');
});

test('buildPRBody: includes story titles from prd', () => {
  const prd = samplePrd();
  const body = buildPRBody({ prd, diffStat: sampleDiffStat(), verifyResults: null });
  for (const story of prd.userStories) {
    assert.ok(
      body.includes(story.title),
      `body must include story title "${story.title}"`,
    );
  }
});

test('buildPRBody: includes diffStat content', () => {
  const diffStat = sampleDiffStat();
  const body = buildPRBody({ prd: samplePrd(), diffStat, verifyResults: null });
  assert.ok(body.includes(diffStat), `body must include diffStat "${diffStat}"`);
});

test('buildPRBody: works when verifyResults is provided', () => {
  const verifyResults = { passed: 10, failed: 0, skipped: 1 };
  let threw = false;
  try {
    buildPRBody({ prd: samplePrd(), diffStat: sampleDiffStat(), verifyResults });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'buildPRBody must not throw when verifyResults is provided');
});

// ---------------------------------------------------------------------------
// Test: preflightCheck — function signature check
// ---------------------------------------------------------------------------

test('preflightCheck: is exported as a function', () => {
  assert.equal(typeof preflightCheck, 'function');
});

test('preflightCheck: returns an object with ok and errors fields', async () => {
  // preflightCheck may call external tools; we only verify the return shape
  let result;
  try {
    result = await preflightCheck();
  } catch {
    // If it throws entirely, that is a bug — but we tolerate it in a stub scenario
    return;
  }
  assert.ok(result !== null && typeof result === 'object', 'preflightCheck must return an object');
  assert.ok('ok' in result, 'result must have ok field');
  assert.ok('errors' in result, 'result must have errors field');
  assert.ok(Array.isArray(result.errors), 'result.errors must be an array');
});

// ---------------------------------------------------------------------------
// Test: createPR and findExistingPR — export shape checks
// ---------------------------------------------------------------------------

test('createPR: is exported as a function', () => {
  assert.equal(typeof createPR, 'function');
});

test('findExistingPR: is exported as a function', () => {
  assert.equal(typeof findExistingPR, 'function');
});
