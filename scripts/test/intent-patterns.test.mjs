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
  'code-review',
  'security-review',
  'test-authoring',
  'product-planning',
  'deep',
  'deep-mutation',
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

test('classifyIntent: PRD and reverse-spec requests → product-planning', () => {
  assert.equal(classifyIntent('write a PRD for this feature').category, 'product-planning');
  assert.equal(classifyIntent('reverse engineer a spec from this code').category, 'product-planning');
  assert.equal(classifyIntent('이 코드 역기획해줘').category, 'product-planning');
  assert.equal(classifyIntent('이 기능 기획해줘').category, 'product-planning');
});

test('classifyIntent: explicit security review → security-review', () => {
  assert.equal(classifyIntent('security review the authentication flow').category, 'security-review');
  assert.equal(classifyIntent('security review this authentication diff').category, 'security-review');
  assert.equal(classifyIntent('보안 리뷰해줘').category, 'security-review');
});

test('classifyIntent: explicit test authoring → test-authoring', () => {
  assert.equal(classifyIntent('write unit tests for the authentication database layer').category, 'test-authoring');
  assert.equal(classifyIntent('인증 모듈 테스트를 작성해줘').category, 'test-authoring');
});

// ---------------------------------------------------------------------------
// deep
// ---------------------------------------------------------------------------

test('classifyIntent: database refactor → deep-mutation', () => {
  const result = classifyIntent('refactor the database schema and optimize query performance');
  assert.equal(result.category, 'deep-mutation');
});

test('classifyIntent: security auth implementation → deep-mutation', () => {
  const result = classifyIntent('implement authentication with oauth and JWT authorization');
  assert.equal(result.category, 'deep-mutation');
});

test('classifyIntent: Korean refactor request → deep-mutation', () => {
  assert.equal(classifyIntent('리팩토링 해줘').category, 'deep-mutation');
});

test('classifyIntent: alternate Korean refactoring spelling → deep-mutation', () => {
  assert.equal(classifyIntent('대규모 리팩터링 해줘').category, 'deep-mutation');
});

test('classifyIntent: English auth refactor → deep-mutation', () => {
  assert.equal(classifyIntent('refactor the auth module').category, 'deep-mutation');
});

test('classifyIntent: database migration request → deep-mutation', () => {
  assert.equal(classifyIntent('migrate this database schema').category, 'deep-mutation');
});

test('classifyIntent: query optimization request → deep-mutation', () => {
  assert.equal(classifyIntent('optimize this slow query').category, 'deep-mutation');
});

test('classifyIntent: architecture review remains read-only deep analysis', () => {
  assert.equal(classifyIntent('review the architecture for coupling risks').category, 'deep');
  assert.equal(classifyIntent('아키텍처 검토해줘').category, 'deep');
});

test('classifyIntent: explicit planning outranks dense deep mutation nouns', () => {
  assert.equal(
    classifyIntent('plan the database schema migration security authorization oauth jwt architecture refactor optimize distributed microservice infrastructure kubernetes concurrency').category,
    'planning',
  );
  assert.equal(
    classifyIntent('아키텍처 리팩터링 마이그레이션 최적화 구현 계획을 세워줘').category,
    'planning',
  );
});

test('classifyIntent: executing an existing plan remains a mutation', () => {
  assert.equal(classifyIntent('implement the plan').category, 'quick');
  assert.equal(classifyIntent('implement the database migration plan').category, 'deep-mutation');
  assert.equal(classifyIntent('write code for the database migration plan').category, 'deep-mutation');
});

test('classifyIntent: explicit documentation outranks dense deep nouns', () => {
  assert.equal(
    classifyIntent('write documentation for the database schema migration security architecture refactor plan').category,
    'writing',
  );
  assert.equal(
    classifyIntent('write API documentation for the authentication database schema').category,
    'writing',
  );
});

test('classifyIntent: explicit UI and visualization actions outrank deep nouns', () => {
  assert.equal(
    classifyIntent('build a responsive UI dashboard for database security metrics').category,
    'visual-engineering',
  );
  assert.equal(
    classifyIntent('create a generative SVG visualization for database performance').category,
    'artistry',
  );
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
    'visual-engineering', 'design-review', 'code-review', 'security-review', 'test-authoring',
    'product-planning', 'deep', 'deep-mutation', 'quick', 'writing', 'artistry',
    'planning', 'external-model',
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

test('classifyIntent: exact Korean UI review outranks broad UI implementation nouns', () => {
  const result = classifyIntent('UI 리뷰해줘');
  assert.equal(result.category, 'design-review');
});

test('classifyIntent: English review-the-UI phrasing routes to design-review', () => {
  const result = classifyIntent('review the UI before release');
  assert.equal(result.category, 'design-review');
});

test('classifyIntent: explicit UI review survives dense visual vocabulary', () => {
  const result = classifyIntent('review the UI design CSS layout responsive color font button modal navbar sidebar component animation accessibility WCAG');
  assert.equal(result.category, 'design-review');
  assert.ok(result.confidence >= 0.7);
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

test('classifyIntent: Korean UI implementation remains visual-engineering', () => {
  const result = classifyIntent('반응형 UI 컴포넌트를 구현해줘');
  assert.equal(result.category, 'visual-engineering');
});

test('classifyIntent: English UI implementation remains visual-engineering', () => {
  const result = classifyIntent('build a responsive UI component');
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

test('classifyIntent: providerless Korean cross-validation → external-model', () => {
  assert.equal(classifyIntent('교차 검증 해줘').category, 'external-model');
});

test('classifyIntent: explicit Claude-only cross-review → internal code-review', () => {
  for (const prompt of [
    'ask Claude to cross-review this change',
    'review this change with Claude',
    'as Claude, review this change',
    'ask Claude to review the Codex adapter',
    '클로드로 교차리뷰 해봐',
    '클로드에게 이 코드 검토를 맡겨줘',
  ]) {
    const result = classifyIntent(prompt);
    assert.equal(result.category, 'code-review', prompt);
    assert.equal(result.scores['external-model'], 0, `${prompt}: external score must be suppressed`);
  }
});

test('classifyIntent: model subjects are not mistaken for review actors', () => {
  assert.equal(
    classifyIntent('Claude suggested this; get a second opinion').category,
    'external-model',
  );
  assert.equal(
    classifyIntent('ask Claude to review the Codex adapter').category,
    'code-review',
  );
  for (const prompt of [
    'review the patch generated by Codex',
    'review the output produced by Gemini',
    'We use Codex for code generation; review this adapter',
    '코덱스로 만든 결과를 검토해줘',
  ]) {
    assert.equal(classifyIntent(prompt).category, 'code-review', prompt);
  }
});

test('classifyIntent: command-shaped use still assigns an external reviewer', () => {
  for (const prompt of [
    'use Codex to review this change',
    'use Codex, review this change',
    'please use Gemini to verify this patch',
    'can you use Codex to review this change',
    'I want you to use Gemini to review this change',
  ]) {
    assert.equal(classifyIntent(prompt).category, 'external-model', prompt);
  }
});

test('classifyIntent: provider review provenance does not swallow mutation intent', () => {
  for (const prompt of [
    'fix issues from the Claude review',
    'implement changes recommended by Claude review',
    '클로드가 검토한 문제를 수정해줘',
    '코덱스가 검토한 문제를 수정해줘',
  ]) {
    assert.equal(classifyIntent(prompt).category, 'quick', prompt);
  }
});

test('classifyIntent: explicit reviewer syntax does not swallow a requested mutation', () => {
  for (const prompt of [
    'Claude, analyze and implement this database refactor',
    'ask Claude to analyze and fix this auth bug',
  ]) {
    assert.equal(classifyIntent(prompt).category, 'deep-mutation', prompt);
  }

  assert.equal(
    classifyIntent('ask Claude to review the Codex adapter').category,
    'code-review',
  );

  for (const prompt of [
    'ask Claude to review this; implement the result',
    'ask Codex to review this; fix the result',
    'ask Claude to review this, implement the result',
    'ask Gemini to review this, fix the findings',
  ]) {
    assert.equal(classifyIntent(prompt).category, 'quick', prompt);
  }
});

test('classifyIntent: review subjects named fix or update are not mutation verbs', () => {
  assert.equal(
    classifyIntent('ask Codex to review this fix').category,
    'external-model',
  );
  assert.equal(
    classifyIntent('ask Claude to review this update').category,
    'code-review',
  );
});

test('classifyIntent: passive reviewer assignment remains an external actor', () => {
  for (const prompt of [
    'have this patch reviewed by Codex',
    'get this checked by Gemini',
  ]) {
    assert.equal(classifyIntent(prompt).category, 'external-model', prompt);
  }
});

test('classifyIntent: explicit Codex or Gemini wins in mixed Claude cross-review', () => {
  for (const prompt of [
    'Codex and Claude cross-review this change',
    'codex랑 claude로 교차검증 해줘',
    '제미니와 클로드로 교차 검증해줘',
  ]) {
    assert.equal(classifyIntent(prompt).category, 'external-model', prompt);
  }
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

test('classifyIntent: external-model survives adversarial mixed-domain vocabulary', () => {
  const result = classifyIntent('ask codex to review the database schema migration security authorization oauth jwt architecture refactor optimize distributed microservice infrastructure kubernetes concurrency');
  assert.equal(result.category, 'external-model');
  assert.ok(result.confidence >= 0.7);
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
