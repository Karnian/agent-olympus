/**
 * Unit tests for scripts/lib/input-guard.mjs
 * Uses node:test — zero npm dependencies.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { estimateTokens, countLines, checkInputSize, extractStructuralSummary, prepareSubAgentInput } =
  await import('../../scripts/lib/input-guard.mjs');

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

test('estimateTokens: returns 0 for empty/null input', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
});

test('estimateTokens: estimates English text (~4 chars/token)', () => {
  const text = 'Hello world this is a test of the token estimator';
  const tokens = estimateTokens(text);
  // 50 chars → ~12-13 tokens
  assert.ok(tokens >= 10 && tokens <= 20, `Expected 10-20, got ${tokens}`);
});

test('estimateTokens: handles CJK text (higher token density)', () => {
  const cjk = '한국어 테스트 문장입니다';  // 12 CJK chars + spaces
  const tokens = estimateTokens(cjk);
  // CJK uses ~1.5 chars/token, should be higher density
  assert.ok(tokens > 5, `Expected >5 tokens for CJK, got ${tokens}`);
});

test('estimateTokens: handles mixed content', () => {
  const mixed = 'User story US-001: 사용자 로그인 기능을 구현한다';
  const tokens = estimateTokens(mixed);
  assert.ok(tokens > 5, `Expected >5 tokens for mixed, got ${tokens}`);
});

// ---------------------------------------------------------------------------
// countLines
// ---------------------------------------------------------------------------

test('countLines: returns 0 for empty input', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines(null), 0);
});

test('countLines: counts lines correctly', () => {
  assert.equal(countLines('one\ntwo\nthree'), 3);
  assert.equal(countLines('single line'), 1);
  assert.equal(countLines('a\nb\nc\nd\ne'), 5);
});

// ---------------------------------------------------------------------------
// checkInputSize
// ---------------------------------------------------------------------------

test('checkInputSize: marks small input as safe', () => {
  const result = checkInputSize('Hello world', 'opus');
  assert.equal(result.safe, true);
  assert.ok(result.tokens < 10);
});

test('checkInputSize: marks huge input as unsafe for haiku', () => {
  // Generate >500 lines of text
  const lines = Array.from({ length: 600 }, (_, i) => `Line ${i}: This is a moderately long line of text for testing purposes.`);
  const result = checkInputSize(lines.join('\n'), 'haiku');
  assert.equal(result.safe, false);
  assert.ok(result.lines >= 600);
});

test('checkInputSize: uses opus limits by default', () => {
  const result = checkInputSize('small', 'opus');
  assert.equal(result.limit.maxInputLines, 3000);
});

test('checkInputSize: falls back to opus for unknown tier', () => {
  const result = checkInputSize('small', 'unknown');
  assert.equal(result.limit.maxInputLines, 3000);
});

// ---------------------------------------------------------------------------
// extractStructuralSummary
// ---------------------------------------------------------------------------

test('extractStructuralSummary: preserves headings', () => {
  const input = '# Title\n\nSome prose paragraph.\n\n## Section 1\n\nMore prose.\n\n### Subsection\n\nEven more.';
  const { summary } = extractStructuralSummary(input, 50);
  assert.ok(summary.includes('# Title'));
  assert.ok(summary.includes('## Section 1'));
  assert.ok(summary.includes('### Subsection'));
});

test('extractStructuralSummary: preserves user story IDs', () => {
  const input = 'Some text\n\n### US-001: User Login\n\nAs a user I want to log in.\n\n### US-002: User Logout\n\nAs a user I want to log out.';
  const { summary, preservedIds } = extractStructuralSummary(input, 50);
  assert.ok(summary.includes('US-001'));
  assert.ok(summary.includes('US-002'));
  assert.deepEqual(preservedIds, ['US-001', 'US-002']);
});

test('extractStructuralSummary: preserves GIVEN/WHEN/THEN', () => {
  const input = 'Header\n\n- GIVEN a user is logged out\n- WHEN they enter valid credentials\n- THEN they see the dashboard';
  const { summary } = extractStructuralSummary(input, 50);
  assert.ok(summary.includes('GIVEN'));
  assert.ok(summary.includes('WHEN'));
  assert.ok(summary.includes('THEN'));
});

test('extractStructuralSummary: preserves table rows', () => {
  const input = '# Table\n\n| Col1 | Col2 |\n|------|------|\n| A    | B    |';
  const { summary } = extractStructuralSummary(input, 50);
  assert.ok(summary.includes('| Col1'));
});

test('extractStructuralSummary: preserves "As a" format', () => {
  const input = 'Story:\n**As a** developer, **I want to** test, **so that** things work.';
  const { summary } = extractStructuralSummary(input, 50);
  assert.ok(summary.includes('As a'));
});

test('extractStructuralSummary: handles empty input', () => {
  const { summary, originalLines, preservedIds } = extractStructuralSummary('', 50);
  assert.equal(summary, '');
  assert.equal(originalLines, 0);
  assert.deepEqual(preservedIds, []);
});

test('extractStructuralSummary: reduces large input', () => {
  // Generate a large document with prose + structure
  const lines = [];
  for (let i = 0; i < 50; i++) {
    lines.push(`## Feature ${i}`);
    lines.push(`### US-${String(i).padStart(3, '0')}: Feature ${i} implementation`);
    lines.push(`**As a** user, **I want to** use feature ${i}, **so that** I am happy.`);
    lines.push(`- GIVEN the system is running WHEN I click button ${i} THEN feature ${i} activates`);
    for (let j = 0; j < 10; j++) {
      lines.push(`This is detailed prose paragraph ${j} about feature ${i} with lots of verbose description that should be stripped.`);
    }
  }
  const input = lines.join('\n');
  const { summary, originalLines } = extractStructuralSummary(input, 200);

  assert.ok(originalLines > 500, `Expected >500 lines, got ${originalLines}`);
  const summaryLines = summary.split('\n').length;
  assert.ok(summaryLines <= 300, `Expected <=300 summary lines, got ${summaryLines}`);
  assert.ok(summary.includes('US-000'));
  assert.ok(summary.includes('GIVEN'));
});

// ---------------------------------------------------------------------------
// prepareSubAgentInput
// ---------------------------------------------------------------------------

test('prepareSubAgentInput: passes small input through unchanged', () => {
  const input = 'Small task description';
  const result = prepareSubAgentInput(input, 'opus');
  assert.equal(result.wasChunked, false);
  assert.equal(result.text, input);
});

test('prepareSubAgentInput: chunks large input with source path', () => {
  const lines = Array.from({ length: 4000 }, (_, i) => `## US-${String(i).padStart(3, '0')}: Story ${i}\n- GIVEN x WHEN y THEN z`);
  const input = lines.join('\n');
  const result = prepareSubAgentInput(input, 'haiku', 'docs/proposal.md');

  assert.equal(result.wasChunked, true);
  assert.ok(result.text.includes('docs/proposal.md'));
  assert.ok(result.text.length < input.length);
});

test('prepareSubAgentInput: preserves story IDs during chunking', () => {
  const input = Array.from({ length: 1000 }, (_, i) =>
    `### US-${String(i).padStart(3, '0')}: Story\n- GIVEN context WHEN action THEN result\n${'Verbose prose '.repeat(20)}`
  ).join('\n');
  const result = prepareSubAgentInput(input, 'haiku');

  assert.equal(result.wasChunked, true);
  assert.ok(result.preservedIds.length > 0);
  assert.ok(result.preservedIds.includes('US-000'));
});
