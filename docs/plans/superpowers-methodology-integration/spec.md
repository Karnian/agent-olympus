# Superpowers Methodology Integration into Agent Olympus -- Specification

**Scale:** L (Architectural)
**Created:** 2026-03-29
**Status:** Draft
**Ambiguity:** 72/100 (from Metis assessment)

---

## Problem Statement

**WHO:** Developers using Agent Olympus as their Claude Code autonomous orchestrator.
**WHAT:** Agent Olympus orchestrates work effectively (Atlas/Athena) but lacks disciplinary guardrails that prevent common AI-agent failure modes: writing code before design is validated, skipping tests until the end, declaring "done" without verification evidence, and applying fixes before understanding root causes. The Superpowers plugin encodes these disciplines as hard gates but lacks AO's orchestration power. Neither plugin alone delivers both discipline AND orchestration.
**WHY NOW:** Both plugins are mature enough (AO v0.6.7, 182 tests) that the integration surface is well-defined. Metis analysis shows zero hook conflicts and a clear complementary relationship. Merging now prevents the ecosystem from fragmenting into two incompatible approaches.

## Target Users

1. **Solo AI Developer (primary)** -- Uses Claude Code daily with Agent Olympus. Wants autonomous task completion but suffers from AI agents that skip tests, ship untested code, or declare done prematurely. Typically runs `/atlas` or `/athena` and walks away.

2. **Team Lead running Athena (secondary)** -- Coordinates multi-agent teams on large features. Needs each worker to follow TDD discipline independently, not just the orchestrator. Currently has no way to enforce test-first at the worker level.

3. **Debugger (tertiary)** -- Encounters failures during Atlas/Athena execution. Currently the debugger agent applies trial-and-error fixes. Needs systematic root-cause investigation BEFORE any fix attempt.

## Goals

- G1: Embed TDD (RED-GREEN-REFACTOR) as a non-skippable gate in Atlas Phase 3 and Athena Phase 2 worker prompts, so that no implementation story is marked `passes: true` without a test written first
- G2: Add a brainstorm-first gate for tasks classified as `complex` or `architectural`, blocking code generation until a design is produced and approved
- G3: Replace trial-and-error debugging with systematic root-cause investigation (hypothesis-evidence-probe) in both the debugger agent and the trace skill
- G4: Enforce verification-before-completion as an iron law: no story, worker, or orchestrator run can declare "done" without machine-verifiable evidence (test output, build log, or linter result)
- G5: Implement two-stage code review: Stage 1 checks spec compliance (do the changes match the acceptance criteria?), Stage 2 checks code quality (the current review)
- G6: Deliver 4 new skills (tdd, systematic-debug, brainstorm, finish-branch) and 1 new agent (quality-gate)
- G7: All 182 existing tests continue to pass after integration
- G8: AO works standalone without Superpowers installed; if Superpowers IS installed, AO detects it and can optionally invoke Superpowers skills via Skill tool

## Non-Goals

- N1: Will NOT port Superpowers' executing-plans skill (Atlas/Athena are superior)
- N2: Will NOT port Superpowers' dispatching-parallel-agents (Athena is superior)
- N3: Will NOT port Superpowers' using-git-worktrees (worktree.mjs is superior)
- N4: Will NOT port Superpowers' meta-skills (using-superpowers, writing-skills)
- N5: Will NOT copy any files from the Superpowers repo (read-only reference)
- N6: Will NOT add npm dependencies
- N7: Will NOT modify hook scripts (session-start.mjs, stop-hook.mjs) -- hook coexistence is already confirmed complementary
- N8: Will NOT change the plugin's hook registration or run.cjs entry point

---

## User Stories

### US-001: TDD Skill -- RED-GREEN-REFACTOR Workflow

**As a** solo AI developer, **I want to** invoke `/tdd` to implement a feature using strict RED-GREEN-REFACTOR discipline, **so that** every feature ships with tests written before production code.

**Acceptance Criteria:**
- GIVEN a user invokes `/tdd` with a feature description WHEN the skill starts THEN it enters RED phase: writes a failing test first, runs it, and confirms the test fails with the expected assertion error
- GIVEN the RED phase completes with a failing test WHEN the skill enters GREEN phase THEN it writes the minimum production code to make the failing test pass, runs the test suite, and confirms the previously-failing test now passes
- GIVEN the GREEN phase completes WHEN the skill enters REFACTOR phase THEN it reviews the production code for duplication/clarity, applies refactoring changes, re-runs the full test suite, and confirms all tests still pass (zero regressions)
- GIVEN any phase fails (test won't compile, production code breaks other tests) WHEN the error is detected THEN the skill diagnoses and fixes within that phase before advancing, logging the fix via `addWisdom()`
- GIVEN the REFACTOR phase passes WHEN the cycle completes THEN the skill outputs a summary: test file path, production file path, test count before/after, and phase durations

### US-002: TDD Gate in Atlas Phase 3 Execution

**As a** solo AI developer running `/atlas`, **I want** Atlas to enforce TDD discipline on every implementation story, **so that** no story is marked `passes: true` without a test written and passing first.

**Acceptance Criteria:**
- GIVEN Atlas Phase 3 begins executing a story with `assignTo: "claude"` WHEN the executor agent is prompted THEN the prompt includes an explicit TDD instruction: "Write the failing test FIRST, verify it fails, THEN write production code, verify it passes, THEN refactor"
- GIVEN a story's executor completes WHEN Atlas verifies acceptance criteria THEN Atlas checks that at least one NEW test file or test case exists that was not present before execution (verified via `git diff --name-only` against the pre-story commit)
- GIVEN a story's executor produces production code but zero new tests WHEN Atlas detects this THEN Atlas rejects the story, spawns a test-engineer agent to write tests, and only marks `passes: true` after both production code and tests pass
- GIVEN a Codex worker completes a story WHEN Atlas verifies the result THEN the same test-existence check applies (Codex output without tests triggers Claude test-engineer fallback)

### US-003: TDD Gate in Athena Phase 2 Worker Prompts

**As a** team lead running `/athena`, **I want** every Athena worker to receive TDD instructions in their spawn prompt, **so that** parallel workers independently follow test-first discipline.

**Acceptance Criteria:**
- GIVEN Athena Phase 2 spawns a Claude worker WHEN the worker prompt is constructed THEN the prompt includes: "Follow TDD: write failing test first, then production code, then refactor. Commit tests alongside production code to your branch."
- GIVEN Athena Phase 2 spawns a Codex worker WHEN the tmux prompt is constructed THEN the prompt includes the same TDD instruction
- GIVEN a worker completes and Athena Phase 4 integrates branches WHEN merge verification runs THEN Athena checks that each worker branch contains at least one test file change (via `git diff --name-only <base>..<branch>` filtered to test patterns)
- GIVEN a worker branch contains zero test changes WHEN Athena detects this THEN Athena spawns a test-engineer to backfill tests before marking the story as passing

### US-004: Brainstorm Skill -- Design-Before-Code Gate

**As a** solo AI developer, **I want to** invoke `/brainstorm` to explore design alternatives before implementation, **so that** complex features have a validated design before any code is written.

**Acceptance Criteria:**
- GIVEN a user invokes `/brainstorm` with a problem statement WHEN the skill starts THEN it generates 3 distinct design alternatives, each with: approach summary, pros (with measurable claims), cons (with measurable claims), effort estimate (S/M/L), and risk assessment
- GIVEN 3 alternatives are generated WHEN the skill presents them THEN it highlights trade-offs in a comparison table and recommends one approach with explicit reasoning
- GIVEN the user selects an approach (or accepts the recommendation) WHEN the skill finalizes THEN it writes a design brief to `.ao/brainstorm-<slug>.md` containing: chosen approach, rejected alternatives with reasons, key constraints, and implementation hints
- GIVEN the user invokes `/brainstorm` and then `/atlas` or `/athena` WHEN the orchestrator starts THEN the orchestrator detects `.ao/brainstorm-<slug>.md` and injects the chosen design into the planning phase prompt

### US-005: Brainstorm Gate in Atlas/Athena for Complex Tasks

**As a** solo AI developer, **I want** Atlas and Athena to automatically invoke brainstorm for tasks classified as `complex` or `architectural`, **so that** the system never jumps to code on hard problems without exploring design alternatives first.

**Acceptance Criteria:**
- GIVEN Atlas Phase 0 classifies a task as COMPLEXITY: `complex` or `architectural` WHEN no `.ao/brainstorm-*.md` file exists for this task THEN Atlas invokes `Skill(skill="agent-olympus:brainstorm")` before proceeding to Phase 1
- GIVEN Athena Phase 0 classifies a task as `complex` or `architectural` WHEN no brainstorm artifact exists THEN Athena invokes brainstorm before team design
- GIVEN the brainstorm skill completes WHEN Atlas/Athena resumes THEN the chosen design approach is passed as `design_context` to Prometheus/Metis in the planning phase
- GIVEN a task is classified as `trivial` or `moderate` WHEN Atlas/Athena triages THEN brainstorm is NOT invoked (no overhead for simple tasks)

### US-006: Systematic Debug Skill

**As a** developer debugging a failure, **I want to** invoke `/systematic-debug` to follow a structured investigation protocol, **so that** root causes are identified before any fix is attempted.

**Acceptance Criteria:**
- GIVEN a user invokes `/systematic-debug` with an error description WHEN the skill starts THEN it enters INVESTIGATE phase: reproduces the error, collects stack trace / error output, and identifies the exact file and line where the failure originates
- GIVEN the INVESTIGATE phase completes WHEN the skill enters HYPOTHESIZE phase THEN it generates 3 ranked hypotheses with predicted evidence for each (what would confirm, what would deny)
- GIVEN hypotheses are ranked WHEN the skill enters PROBE phase THEN it executes the top hypothesis's confirmation check (read specific code, run specific test, check specific state) and reports confirmed/denied with evidence
- GIVEN the root cause is confirmed WHEN the skill enters FIX phase THEN it applies a minimal fix targeting only the confirmed root cause, re-runs the failing test, and confirms it passes
- GIVEN the fix passes WHEN the skill enters VERIFY phase THEN it runs the full test suite and confirms zero regressions (test count before >= test count after, all passing)
- GIVEN the user invokes `/systematic-debug` without an error description WHEN the skill starts THEN it reads the last 50 lines of terminal output to auto-detect the most recent error

### US-007: Systematic Debug Integration in Debugger Agent

**As a** developer, **I want** the debugger agent to follow systematic investigation protocol internally, **so that** it stops applying trial-and-error fixes and instead finds root causes first.

**Acceptance Criteria:**
- GIVEN the debugger agent (agents/debugger.md) receives a fix request WHEN it starts THEN its persona prompt mandates: "NEVER apply a fix without first confirming the root cause through evidence. Follow: Reproduce -> Hypothesize (3 hypotheses) -> Probe (test top hypothesis) -> Fix (minimal, targeted) -> Verify (full test suite)"
- GIVEN the debugger agent is invoked by Atlas Phase 4 or Athena Phase 4 WHEN the error output is provided THEN the agent's response includes: confirmed root cause with file:line reference, evidence that confirms the hypothesis, the minimal fix applied, and full test suite result
- GIVEN the debugger agent cannot confirm a root cause after probing all 3 hypotheses WHEN all are denied THEN the agent escalates to `Skill(skill="agent-olympus:trace")` instead of guessing

### US-008: Trace Skill Enhancement -- Systematic Debug Protocol

**As a** developer, **I want** the trace skill to incorporate systematic debugging methodology in its investigation lanes, **so that** each lane follows evidence-based investigation rather than pattern matching.

**Acceptance Criteria:**
- GIVEN trace Phase 2 spawns investigation lanes WHEN each lane's debugger agent is prompted THEN the prompt includes: "Follow systematic debug protocol: reproduce -> hypothesize -> probe -> report. Do NOT attempt fixes -- investigation only."
- GIVEN trace Phase 3 rebuttal round completes WHEN the discriminating probe is identified THEN the probe specification includes: exact command to run, expected output if hypothesis is correct, expected output if hypothesis is wrong
- GIVEN trace Phase 4 probe confirms a root cause WHEN Phase 5 fix is applied THEN the fix agent receives the full evidence chain (hypothesis, probe command, probe output, confirmed cause) so the fix is targeted, not speculative

### US-009: Verification-Before-Completion Iron Law

**As a** solo AI developer, **I want** Atlas and Athena to enforce that no task is declared "done" without machine-verifiable evidence, **so that** I never encounter "done" tasks that are actually broken.

**Acceptance Criteria:**
- GIVEN Atlas Phase 4 VERIFY completes WHEN all checks pass THEN the checkpoint includes: `verificationEvidence: { buildLog: "<last 20 lines>", testOutput: "<summary: N passed, 0 failed>", lintResult: "<clean or N warnings>" }`
- GIVEN Athena Phase 4 INTEGRATE completes WHEN all checks pass THEN the same `verificationEvidence` object is attached to the checkpoint
- GIVEN Atlas Phase 5 REVIEW completes WHEN all reviewers approve THEN the completion report includes the `verificationEvidence` block as proof
- GIVEN any verification step produces ambiguous output (e.g., "test runner exited with code 0 but no test count in output") WHEN Atlas/Athena evaluates it THEN the step is treated as FAILED, not passed -- the system re-runs with explicit count extraction
- GIVEN a story is about to be marked `passes: true` WHEN the verification check runs THEN it requires ALL of: (a) at least one test file exists for the story's scope, (b) test runner reports 0 failures, (c) build exits with code 0

### US-010: Finish-Branch Skill -- Branch Completion Protocol

**As a** developer working on a feature branch, **I want to** invoke `/finish-branch` to run a complete pre-merge checklist, **so that** I never merge a branch with failing tests, missing verification, or incomplete reviews.

**Acceptance Criteria:**
- GIVEN a user invokes `/finish-branch` WHEN the skill starts THEN it runs in sequence: (1) full test suite, (2) build check, (3) lint check, (4) verify-coverage gap report, (5) two-stage code review
- GIVEN all 5 checks pass WHEN the skill completes THEN it outputs a summary table with: branch name, commit count, files changed, test results (N passed / 0 failed), coverage gaps (N files without tests), review verdict, and a GO/NO-GO recommendation
- GIVEN any check fails WHEN the skill detects the failure THEN it stops at that check, reports the failure with actionable detail, and does NOT proceed to subsequent checks (fail-fast)
- GIVEN the user invokes `/finish-branch` on the main branch WHEN branch detection runs THEN the skill warns: "You are on main. /finish-branch is designed for feature branches. Continue anyway?" and requires explicit confirmation
- GIVEN the GO recommendation is issued WHEN the user confirms THEN the skill offers to create the merge commit or PR via `gh pr create`

### US-011: Two-Stage Code Review in Atlas/Athena Phase 5

**As a** solo AI developer, **I want** Atlas and Athena to run two-stage code review (spec compliance first, code quality second), **so that** reviews catch both "wrong feature" and "bad code" problems.

**Acceptance Criteria:**
- GIVEN Atlas Phase 5 begins WHEN reviewers are spawned THEN Stage 1 runs first: a spec-compliance reviewer checks each changed file against the user story's acceptance criteria and reports: COMPLIANT / NON-COMPLIANT per story with specific evidence
- GIVEN Stage 1 completes with all stories COMPLIANT WHEN Stage 2 begins THEN the existing code-reviewer, architect, and security-reviewer run in parallel (current behavior preserved)
- GIVEN Stage 1 finds any story NON-COMPLIANT WHEN the verdict is returned THEN Atlas spawns an executor to fix the non-compliance BEFORE Stage 2 runs (no point reviewing code quality on wrong code)
- GIVEN Athena Phase 5 begins WHEN the same two-stage protocol applies THEN the behavior matches Atlas's (shared protocol, not duplicated logic)

### US-012: Quality-Gate Agent

**As a** orchestrator (Atlas/Athena), **I want** a quality-gate agent that can verify a story's completion against its acceptance criteria with machine evidence, **so that** verification is consistent and not dependent on individual agent interpretation.

**Acceptance Criteria:**
- GIVEN `agents/quality-gate.md` is created WHEN it receives a story ID and acceptance criteria list THEN it runs each criterion as a specific check: executes tests, reads output, parses build logs, and reports PASS/FAIL per criterion with evidence (exact output line that proves pass or fail)
- GIVEN the quality-gate agent reports FAIL on any criterion WHEN the result is returned to Atlas/Athena THEN the orchestrator knows exactly which criterion failed and can dispatch a targeted fix (not a generic "fix it" prompt)
- GIVEN the quality-gate agent runs WHEN it encounters a criterion it cannot verify automatically (e.g., "UI looks correct") THEN it flags the criterion as MANUAL_REVIEW_NEEDED and does not block the pipeline -- it adds a note to the completion report
- GIVEN the quality-gate agent is assigned model tier WHEN `agents/quality-gate.md` frontmatter is set THEN the model is `sonnet` (verification is pattern-matching, not creative work)

### US-013: Code-Reviewer Agent Enrichment -- Two-Stage Awareness

**As a** orchestrator, **I want** the code-reviewer agent to be aware of spec compliance context, **so that** it can distinguish "code that doesn't match spec" from "code that matches spec but is low quality."

**Acceptance Criteria:**
- GIVEN `agents/code-reviewer.md` is updated WHEN it receives a review prompt with `specContext` (the acceptance criteria and Stage 1 compliance result) THEN the reviewer prioritizes findings that would cause spec non-compliance as CRITICAL severity
- GIVEN the code-reviewer receives a prompt WITHOUT `specContext` WHEN it reviews THEN it falls back to the current behavior (no regression for standalone usage)
- GIVEN the code-reviewer's checklist is updated WHEN the new checklist is read THEN it includes an additional item: "Spec alignment: Do the changes satisfy the stated acceptance criteria?"

### US-014: Debugger Agent Enrichment -- Mandatory Root-Cause Protocol

**As a** orchestrator, **I want** the debugger agent to have an explicit ban on trial-and-error fixing, **so that** every debug session produces a root-cause analysis before any code change.

**Acceptance Criteria:**
- GIVEN `agents/debugger.md` is updated WHEN the new persona is read THEN it contains: "IRON RULE: You MUST identify and confirm the root cause BEFORE writing any fix. A fix without a confirmed root cause is FORBIDDEN."
- GIVEN the debugger agent's process section is updated WHEN it is read THEN it follows the 5-step protocol: Reproduce -> Hypothesize (3 competing) -> Probe (test top hypothesis with specific check) -> Fix (minimal, targeted at confirmed cause only) -> Verify (full test suite, zero regressions)
- GIVEN the debugger agent's process section is updated WHEN it is read THEN it includes: "If all 3 hypotheses are denied, STOP and escalate to trace skill. Do NOT generate a 4th hypothesis -- the problem requires structured parallel investigation."

### US-015: Verify-Coverage Skill Enhancement -- TDD Feedback Loop

**As a** developer, **I want** verify-coverage to report not just missing tests but also tests that exist but do not exercise the changed code paths, **so that** coverage gaps include both missing test files and insufficient test depth.

**Acceptance Criteria:**
- GIVEN verify-coverage Step 2 maps changed files to tests WHEN a test file exists but contains fewer than 2 test cases for a file with 3+ exported functions THEN the report flags it as "SHALLOW COVERAGE" (not just "covered")
- GIVEN the gap report is generated WHEN the output is rendered THEN it includes a new section: "Shallow Coverage (N)" listing files where tests exist but cover less than 50% of exported functions
- GIVEN the verify-coverage skill runs WHEN it completes THEN the summary includes: total changed files, fully covered count, shallow coverage count, missing test count, and a coverage percentage (fully covered / total changed * 100)

### US-016: Plan Skill Enhancement -- Brainstorm Integration

**As a** developer using `/plan`, **I want** the plan skill to invoke brainstorm automatically for L-scale tasks, **so that** large plans always have a validated design foundation.

**Acceptance Criteria:**
- GIVEN Phase 0 TRIAGE detects `detected_scale == L` WHEN no `.ao/brainstorm-*.md` exists THEN the plan skill invokes `Skill(skill="agent-olympus:brainstorm")` between Phase 0 and Phase 1
- GIVEN brainstorm completes WHEN Phase 1 UNDERSTAND begins THEN the brainstorm output (chosen approach, rejected alternatives) is passed to Hermes as `design_context`
- GIVEN `detected_scale` is S or M WHEN Phase 0 completes THEN brainstorm is NOT invoked

### US-017: Consensus-Plan Skill Enhancement -- TDD Story Tagging

**As a** orchestrator, **I want** consensus-plan to tag each user story with `requiresTDD: true/false`, **so that** executors know which stories need test-first discipline.

**Acceptance Criteria:**
- GIVEN consensus-plan Phase 1 DRAFT runs WHEN Prometheus generates stories THEN each story includes a `requiresTDD` boolean field: `true` if the story involves code that can be unit/integration tested, `false` if the story is docs-only, config-only, or UI-only without testable logic
- GIVEN the PRD JSON is written WHEN `requiresTDD` is present on each story THEN Atlas/Athena Phase 3 executor prompts include TDD instructions only for stories where `requiresTDD: true`
- GIVEN a story has `requiresTDD: true` WHEN it completes THEN the quality-gate agent verifies that at least one new test exists for that story's scope

### US-018: Superpowers Coexistence Detection

**As a** plugin system, **I want** Agent Olympus to detect whether Superpowers is also installed, **so that** it can optionally delegate to Superpowers skills when both are present.

**Acceptance Criteria:**
- GIVEN AO starts a session WHEN session-start hook or skill initialization runs THEN it checks for Superpowers availability by looking for known Superpowers skill names in the Skill tool registry (e.g., attempting to detect `superpowers:tdd` or similar)
- GIVEN Superpowers is NOT installed WHEN AO operates THEN all methodology is self-contained in AO's own skills/agents (standalone mode, no errors, no degradation)
- GIVEN Superpowers IS installed WHEN AO's TDD skill is invoked THEN AO MAY optionally invoke `Skill(skill="superpowers:tdd")` if it exists, falling back to its own implementation if the call fails
- GIVEN coexistence detection runs WHEN the result is cached THEN the detection runs at most once per session (not on every skill invocation)

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Existing test suite | 182/182 pass (100%) | `node --test 'scripts/test/**/*.test.mjs'` reports 0 failures |
| New skill files created | 4 (tdd, systematic-debug, brainstorm, finish-branch) | `ls skills/{tdd,systematic-debug,brainstorm,finish-branch}/SKILL.md` returns 4 files |
| New agent file created | 1 (quality-gate) | `cat agents/quality-gate.md` has valid frontmatter |
| Modified skill files | 6 (plan, consensus-plan, trace, verify-coverage, atlas, athena) | `git diff --name-only` shows changes in these 6 SKILL.md files |
| Modified agent files | 2 (code-reviewer, debugger) | `git diff --name-only` shows changes in these 2 agent files |
| Zero npm dependencies | 0 | `package.json` devDependencies and dependencies both empty or absent |
| Standalone operation | AO functions without Superpowers | Skills execute without errors when Superpowers is not installed |
| TDD gate enforcement | Atlas/Athena reject stories without tests | Executor prompts contain TDD instruction text; quality-gate checks for new test files |
| Verification evidence | Every completion report includes build/test/lint evidence | Checkpoint JSON contains `verificationEvidence` key |
| New unit tests for new code | 20+ new tests | `node --test` reports 202+ total tests |

## Constraints

| Constraint | Source | Impact |
|-----------|--------|--------|
| Zero npm dependencies | CLAUDE.md project rule | All new code must use Node.js built-ins only |
| ESM only (.mjs) | CLAUDE.md project rule | No CJS in new scripts (run.cjs is the sole exception) |
| 182 existing tests must pass | Regression gate | Every change must be backward-compatible |
| Superpowers repo is read-only | Task constraint | Reference for methodology only; no file copying |
| Standalone operation required | Task constraint | AO must work without Superpowers installed |
| File permissions | CLAUDE.md convention | State files: mode 0o600, state dirs: mode 0o700 |
| Fail-safe hooks | CLAUDE.md convention | All hooks catch errors, output `{}`, exit 0 |
| Greek mythology naming | CLAUDE.md convention | New agent names should follow convention where possible |
| Max 3s hook timeout | CLAUDE.md convention | No hook changes in this spec, but any future hooks must comply |

## Risks and Unknowns

| ID | Risk | Severity | Mitigation |
|----|------|----------|------------|
| R1 | TDD gate adds latency to every story execution (test-engineer spawn + verify) | Medium | Only enforce for `requiresTDD: true` stories; skip for docs/config |
| R2 | Brainstorm gate for complex tasks may frustrate users who want to "just start" | Medium | Brainstorm is automatic only for complex/architectural; users can override with "skip brainstorm" |
| R3 | Two-stage review doubles review time in Atlas Phase 5 | Medium | Stage 1 (spec compliance) is fast (single agent, haiku-tier); only blocks Stage 2 if non-compliant |
| R4 | Superpowers skill naming/detection may change upstream | Low | Detection is best-effort with graceful fallback; AO never depends on Superpowers |
| R5 | Quality-gate agent may not be able to verify all acceptance criteria automatically | Medium | Agent flags unverifiable criteria as MANUAL_REVIEW_NEEDED; does not block pipeline |
| R6 | Debugger agent's new mandatory protocol may slow down trivial bug fixes | Low | For trivial errors (typo, missing import), hypothesis step is fast; protocol scales naturally |
| R7 | Shallow coverage detection in verify-coverage requires parsing exports from source files | Medium | Use regex-based export detection (grep for `export function/const/class`); not perfect but sufficient for coverage heuristic |

## Open Questions

| ID | Question | Recommended Default | Impact if Different | Stakeholder |
|----|----------|-------------------|-------------------|-------------|
| Q1 | Should the brainstorm skill present alternatives to the user interactively, or auto-select the recommended approach in autonomous mode? | Auto-select in autonomous mode (Atlas/Athena), interactive when user invokes directly | If always interactive: blocks autonomous execution. If always auto: user loses design input on direct invocation. | Product owner |
| Q2 | Should the TDD gate apply to Codex workers, or only Claude workers? Codex prompts have limited control. | Apply to both, but verify after completion rather than enforcing in-prompt for Codex | If Codex-only skip: inconsistent discipline. If strict enforcement: may cause Codex failures. | Tech lead |
| Q3 | Should the quality-gate agent be a standalone skill as well, or internal-only (agent without a skill)? | Internal-only agent (no `/quality-gate` command); orchestrators invoke it | If also a skill: useful for manual verification. Adds one more skill to maintain. | Tech lead |
| Q4 | What is the minimum test count per story to satisfy the TDD gate? 1 test? 2 tests? | 1 new test case minimum per `requiresTDD: true` story | If higher minimum: more thorough but may over-constrain small stories. | Tech lead |

## Implementation Order (Recommended)

The following dependency-aware order minimizes rework:

**Group A -- Foundations (parallel, no dependencies):**
1. US-012: quality-gate agent (new file, no modifications)
2. US-014: debugger agent enrichment (modify existing, no dependencies)
3. US-013: code-reviewer agent enrichment (modify existing, no dependencies)

**Group B -- New Skills (parallel, depends on quality-gate agent):**
4. US-001: TDD skill
5. US-004: Brainstorm skill
6. US-006: Systematic debug skill
7. US-010: Finish-branch skill

**Group C -- Existing Skill Modifications (sequential, depends on Group B):**
8. US-015: verify-coverage enhancement
9. US-017: consensus-plan TDD tagging
10. US-016: plan brainstorm integration
11. US-008: trace systematic debug integration

**Group D -- Orchestrator Integration (sequential, depends on Groups A-C):**
12. US-002: Atlas TDD gate
13. US-003: Athena TDD gate
14. US-005: Atlas/Athena brainstorm gate
15. US-009: Verification-before-completion iron law
16. US-011: Two-stage code review

**Group E -- Coexistence (last, depends on all above):**
17. US-018: Superpowers coexistence detection

## Review Notes

- Metis pre-analysis confirmed: ARCHITECTURAL complexity, 72/100 ambiguity
- Hook coexistence: No conflict (both use additionalContext, complementary)
- Integration approach: Embed methodology inline in SKILL.md (standalone) + optional Skill tool invocation when Superpowers also installed
- All methodology is encoded as SKILL.md workflow text and agent persona prompts -- no new hook scripts needed
- The specification intentionally avoids untestable words: all acceptance criteria use GIVEN/WHEN/THEN with verifiable outcomes
