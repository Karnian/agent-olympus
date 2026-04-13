/**
 * Unit tests for scripts/lib/intent-patterns.mjs
 * Uses node:test — zero npm dependencies
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntent } from '../lib/intent-patterns.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_CATEGORIES = new Set([
  'visual-engineering',
  'design-review',
  'deep',
  'quick',
  'writing',
  'artistry',
  'planning',
  'external-model',
]);

function assertKnownCategory(result) {
  assert.ok(
    VALID_CATEGORIES.has(result.category) || result.category === 'unknown',
    `category "${result.category}" is not a recognised value`,
  );
}

// ---------------------------------------------------------------------------
// orchestration-like prompts — "atlas로 해줘" doesn't match any category
// pattern, so we verify the function still returns a well-formed object.
// ---------------------------------------------------------------------------

test('classifyIntent: "atlas로 해줘" returns well-formed result', () => {
  const result = classifyIntent('atlas로 해줘');
  assert.ok(typeof result.category === 'string', 'category must be a string');
  assert.ok(typeof result.confidence === 'number', 'confidence must be a number');
  assert.ok(typeof result.scores === 'object', 'scores must be an object');
  assertKnownCategory(result);
});

// ---------------------------------------------------------------------------
// visual-engineering
// ---------------------------------------------------------------------------

test('classifyIntent: CSS fix → visual-engineering', () => {
  const result = classifyIntent('CSS fix this button');
  assert.equal(result.category, 'visual-engineering');
  assert.ok(result.confidence > 0, 'confidence should be positive');
});

test('classifyIntent: Korean UI keyword → visual-engineering', () => {
  const result = classifyIntent('이 버튼의 CSS 스타일을 수정해줘');
  assert.equal(result.category, 'visual-engineering');
});

test('classifyIntent: React component → visual-engineering', () => {
  const result = classifyIntent('build a React modal component with dark mode support');
  assert.equal(result.category, 'visual-engineering');
});

// ---------------------------------------------------------------------------
// quick
// ---------------------------------------------------------------------------

test('classifyIntent: simple typo fix → quick', () => {
  const result = classifyIntent('fix the typo in this variable name — simple change');
  assert.equal(result.category, 'quick');
});

test('classifyIntent: Korean quick fix phrase → quick', () => {
  const result = classifyIntent('이 변수명 오타 수정해줘, 간단한 변경이야');
  assert.equal(result.category, 'quick');
});

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

test('classifyIntent: "write a report" → writing', () => {
  const result = classifyIntent('write a report documenting the API endpoints with jsdoc');
  assert.equal(result.category, 'writing');
});

test('classifyIntent: README request → writing', () => {
  const result = classifyIntent('add a readme with a getting started guide and tutorial');
  assert.equal(result.category, 'writing');
});

test('classifyIntent: "explain this code" → writing', () => {
  const result = classifyIntent('explain this code and add documentation comments');
  // "explain" keyword maps to writing via keywords list
  assert.equal(result.category, 'writing');
});

// ---------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------

test('classifyIntent: "plan this feature" → planning', () => {
  const result = classifyIntent('plan this feature and create a roadmap with milestones');
  assert.equal(result.category, 'planning');
});

test('classifyIntent: brainstorm keyword → planning', () => {
  const result = classifyIntent('let us brainstorm the architecture and figure out the best approach');
  assert.equal(result.category, 'planning');
});

test('classifyIntent: Korean planning phrase → planning', () => {
  const result = classifyIntent('이 기능 계획을 세우고 로드맵을 만들어줘');
  assert.equal(result.category, 'planning');
});

// ---------------------------------------------------------------------------
// deep
// ---------------------------------------------------------------------------

test('classifyIntent: database refactor → deep', () => {
  const result = classifyIntent('refactor the database schema and optimize query performance');
  assert.equal(result.category, 'deep');
});

test('classifyIntent: security auth → deep', () => {
  const result = classifyIntent('implement authentication with oauth and JWT authorization');
  assert.equal(result.category, 'deep');
});

// ---------------------------------------------------------------------------
// artistry
// ---------------------------------------------------------------------------

test('classifyIntent: generative art → artistry', () => {
  const result = classifyIntent('create a generative art canvas with particle animations');
  assert.equal(result.category, 'artistry');
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('classifyIntent: empty string → unknown', () => {
  const result = classifyIntent('');
  assert.equal(result.category, 'unknown');
  assert.equal(result.confidence, 0);
});

test('classifyIntent: null → unknown', () => {
  const result = classifyIntent(null);
  assert.equal(result.category, 'unknown');
  assert.equal(result.confidence, 0);
});

test('classifyIntent: non-string number → unknown', () => {
  const result = classifyIntent(42);
  assert.equal(result.category, 'unknown');
  assert.equal(result.confidence, 0);
});

test('classifyIntent: code block is stripped before matching', () => {
  // The URL/code block should be stripped; remaining text is plain "help me"
  const result = classifyIntent('```css .btn { color: red; }``` help me plan this out');
  // After stripping the code block, only "help me plan this out" remains → planning
  assert.equal(result.category, 'planning');
});

test('classifyIntent: scores object contains all categories', () => {
  const result = classifyIntent('write documentation for this React component');
  const expectedCategories = [
    'visual-engineering', 'design-review', 'deep', 'quick', 'writing', 'artistry', 'planning', 'external-model',
  ];
  for (const cat of expectedCategories) {
    assert.ok(cat in result.scores, `scores should contain "${cat}"`);
  }
});

// ---------------------------------------------------------------------------
// UI/UX design review keywords → visual-engineering
// ---------------------------------------------------------------------------

test('classifyIntent: design critique request → design-review', () => {
  const result = classifyIntent('run a design critique on the settings page');
  assert.equal(result.category, 'design-review');
  assert.ok(result.confidence > 0);
});

test('classifyIntent: a11y audit request → design-review', () => {
  const result = classifyIntent('perform an accessibility audit on these form components');
  assert.equal(result.category, 'design-review');
  assert.ok(result.confidence > 0);
});

test('classifyIntent: design system audit → design-review', () => {
  const result = classifyIntent('audit the design system for hardcoded color token leak values');
  assert.equal(result.category, 'design-review');
  assert.ok(result.confidence > 0);
});

test('classifyIntent: UX copy review → design-review', () => {
  const result = classifyIntent('run a ux copy review and microcopy review on the onboarding flow');
  assert.equal(result.category, 'design-review');
  assert.ok(result.confidence > 0);
});

test('classifyIntent: Korean design review → design-review', () => {
  const result = classifyIntent('이 페이지 디자인 리뷰하고 접근성 검사해줘');
  assert.equal(result.category, 'design-review');
  assert.ok(result.confidence > 0);
});

test('classifyIntent: usability heuristic evaluation → design-review', () => {
  const result = classifyIntent('evaluate using Nielsen heuristic evaluation and gestalt principles');
  assert.equal(result.category, 'design-review');
  assert.ok(result.confidence > 0);
});

test('classifyIntent: visual regression review → design-review', () => {
  const result = classifyIntent('check for visual regression in the usability review');
  assert.equal(result.category, 'design-review');
  assert.ok(result.confidence > 0);
});

test('classifyIntent: design-review dashboard UI → visual-engineering', () => {
  const result = classifyIntent('design a beautiful dashboard UI with React and Tailwind');
  assert.equal(result.category, 'visual-engineering');
});

test('classifyIntent: responsive navbar → visual-engineering', () => {
  const result = classifyIntent('build a responsive navbar with CSS flexbox and dark mode toggle');
  assert.equal(result.category, 'visual-engineering');
});

// ---------------------------------------------------------------------------
// External model intent → external-model
// ---------------------------------------------------------------------------

test('classifyIntent: "ask codex to review" → external-model', () => {
  const result = classifyIntent('ask codex to review this code');
  assert.equal(result.category, 'external-model');
  assert.ok(result.confidence > 0);
});

test('classifyIntent: Korean codex request → external-model', () => {
  const result = classifyIntent('코덱스한테 물어봐');
  assert.equal(result.category, 'external-model');
  assert.ok(result.confidence > 0);
});

test('classifyIntent: gemini analysis → external-model', () => {
  const result = classifyIntent('ask gemini what it thinks about this');
  assert.equal(result.category, 'external-model');
  assert.ok(result.confidence > 0);
});

test('classifyIntent: cross-review → external-model', () => {
  const result = classifyIntent('cross-review with gemini and codex');
  assert.equal(result.category, 'external-model');
  assert.ok(result.confidence > 0);
});

test('classifyIntent: Korean cross-review → external-model', () => {
  const result = classifyIntent('교차 리뷰 해줘');
  assert.equal(result.category, 'external-model');
  assert.ok(result.confidence > 0);
});

test('classifyIntent: codex로 검토 → external-model', () => {
  const result = classifyIntent('codex로 검토해줘');
  assert.equal(result.category, 'external-model');
  assert.ok(result.confidence > 0);
});

test('classifyIntent: second opinion → external-model', () => {
  const result = classifyIntent('get a second opinion from codex');
  assert.equal(result.category, 'external-model');
  assert.ok(result.confidence > 0);
});

test('classifyIntent: mixed prompt with codex request overrides deep', () => {
  // "ask codex to review this complex auth refactor plan" should be external-model
  // even though "auth refactor" scores high in 'deep'
  const result = classifyIntent('ask codex to review this complex auth refactor plan');
  assert.equal(result.category, 'external-model');
});

test('classifyIntent: Japanese lowercase codex → external-model', () => {
  const result = classifyIntent('codexにレビューして');
  assert.equal(result.category, 'external-model');
});

test('classifyIntent: Japanese lowercase gemini → external-model', () => {
  const result = classifyIntent('geminiに聞いてください');
  assert.equal(result.category, 'external-model');
});

test('classifyIntent: Korean 다른 모델에게 물어봐 → external-model', () => {
  const result = classifyIntent('다른 모델에게 물어봐');
  assert.equal(result.category, 'external-model');
});

test('classifyIntent: Korean 외부 모델로 확인 → external-model', () => {
  const result = classifyIntent('외부 모델로 확인해줘');
  assert.equal(result.category, 'external-model');
});

// ---------------------------------------------------------------------------
// Confidence and edge cases
// ---------------------------------------------------------------------------

test('classifyIntent: confidence is clamped between 0 and 1', () => {
  const inputs = [
    'refactor the entire database schema and optimize security auth',
    'CSS button fix',
    'plan the architecture roadmap and brainstorm strategy',
  ];
  for (const input of inputs) {
    const { confidence } = classifyIntent(input);
    assert.ok(confidence >= 0 && confidence <= 1, `confidence ${confidence} out of range for "${input}"`);
  }
});
