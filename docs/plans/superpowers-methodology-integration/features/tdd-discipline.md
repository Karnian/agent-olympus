# TDD Discipline

## User Stories

### US-001: TDD Skill -- RED-GREEN-REFACTOR Workflow
**As a** solo AI developer, **I want to** invoke /tdd to implement a feature using strict RED-GREEN-REFACTOR discipline, **so that** every feature ships with tests written before production code.

**Acceptance Criteria:**
- GIVEN a user invokes /tdd with a feature description WHEN the skill starts THEN it enters RED phase: writes a failing test first, runs it, confirms the test fails with the expected assertion error
- GIVEN the RED phase completes WHEN GREEN phase begins THEN it writes minimum production code, runs tests, confirms previously-failing test now passes
- GIVEN GREEN phase completes WHEN REFACTOR phase begins THEN it reviews for duplication, applies refactoring, re-runs full test suite, confirms zero regressions
- GIVEN any phase fails WHEN error is detected THEN the skill diagnoses and fixes within that phase before advancing
- GIVEN REFACTOR phase passes WHEN cycle completes THEN outputs summary: test file path, production file path, test count before/after, phase durations

### US-002: TDD Gate in Atlas Phase 3 Execution
**As a** solo AI developer running /atlas, **I want** Atlas to enforce TDD discipline on every implementation story, **so that** no story is marked passes:true without a test written and passing first.

**Acceptance Criteria:**
- GIVEN Atlas Phase 3 executes a claude story WHEN executor is prompted THEN prompt includes TDD instruction
- GIVEN a story executor completes WHEN Atlas verifies THEN checks at least one NEW test exists via git diff
- GIVEN executor produces code but zero new tests WHEN detected THEN Atlas rejects story, spawns test-engineer, marks passes:true only after both pass
- GIVEN a Codex worker completes WHEN Atlas verifies THEN same test-existence check applies

### US-003: TDD Gate in Athena Phase 2 Worker Prompts
**As a** team lead running /athena, **I want** every Athena worker to receive TDD instructions in spawn prompt, **so that** parallel workers independently follow test-first discipline.

**Acceptance Criteria:**
- GIVEN Athena spawns a Claude worker WHEN prompt is constructed THEN includes TDD instruction
- GIVEN Athena spawns a Codex worker WHEN tmux prompt is constructed THEN includes TDD instruction
- GIVEN a worker completes and Phase 4 integrates WHEN merge verification runs THEN checks each branch contains test file changes
- GIVEN a worker branch contains zero test changes WHEN detected THEN spawns test-engineer to backfill

### US-017: Consensus-Plan TDD Story Tagging
**As a** orchestrator, **I want** consensus-plan to tag stories with requiresTDD, **so that** executors know which stories need test-first discipline.

**Acceptance Criteria:**
- GIVEN Phase 1 DRAFT runs WHEN stories generated THEN each includes requiresTDD boolean
- GIVEN PRD written WHEN requiresTDD present THEN Atlas/Athena include TDD instructions only for requiresTDD:true stories
- GIVEN story has requiresTDD:true WHEN completes THEN quality-gate verifies new test exists
