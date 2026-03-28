---
name: tdd
description: Test-driven development with strict RED-GREEN-REFACTOR discipline
level: 3
aliases: [tdd, test-driven, 테스트주도개발, tdd개발, red-green-refactor]
---

<TDD_Skill>

## Purpose

TDD enforces strict discipline through a three-phase cycle: RED (write failing test), GREEN (write minimum code), REFACTOR (clean up). Every line of production code is written only after a failing test proves it is needed. This prevents gold-plating, over-engineering, and untested logic.

## Use_When

- User says "tdd", "test-driven", "테스트주도개발", "red-green-refactor"
- Implementing new features with testable acceptance criteria
- Bug fixing with test-first verification
- Refactoring with regression test protection
- Atlas/Athena Phase 3 (EXECUTE) for testable stories

## Do_Not_Use_When

- Task is pure documentation or configuration
- No test framework detected in codebase
- Acceptance criteria are not measurable/testable

## Core_Principle

**NEVER write production code before a failing test exists for it.**

## Architecture

```
User Request + Acceptance Criteria
        │
        ▼
Phase 0: SCOPE
    Detect test framework, identify units to implement
        │
        ├────────────────────────────────┐
        ▼                                ▼
Phase 1: RED                    Phase 2: GREEN
    test-engineer writes           executor writes
    failing test                    minimal code
        │                                │
        ▼                                ▼
Test FAILS                         ALL tests PASS
    │                                    │
    └────────────────────────┬───────────┘
                             ▼
                    Phase 3: REFACTOR
                    executor cleans up
                    code-reviewer audits
                             │
                             ▼
                      Full suite PASSES
                    (Loop for each unit)
```

## Steps

### Phase 0 — SCOPE

Analyze the user request and acceptance criteria. Identify:

1. Test framework (node:test, Jest, Mocha, vitest, pytest, etc.)
2. Test file location convention
3. Units to implement (functions, classes, modules)
4. Expected test count per unit

```
Record: framework, location, units_to_implement[]
```

### Phase 1 — RED

For the first unit identified in Phase 0:

```
Task(subagent_type="agent-olympus:test-engineer", model="sonnet",
  prompt="Write ONE failing test for this unit.

  Unit: <unit_name>
  Acceptance criteria: <criteria_from_request>
  Test framework: <detected_framework>
  Test location: <path>

  Requirements:
  - Write ONLY ONE test file or ONE test case
  - Test must be as minimal as possible — show desired behavior only
  - Use real code, avoid mocks if possible
  - Test name must clearly describe the behavior being tested

  Output: complete test code, ready to run
  After output, note: 'RUN: <command_to_run_test>' to verify failure")
```

Record the test code. Run the test suite. Verify:
- The new test FAILS with an expected error (not a typo, not all tests failing)
- Error message matches expected behavior

**Gate**: Test must FAIL. If it passes, the test is wrong — ask test-engineer to rewrite it.

### Phase 2 — GREEN

Write the minimum code to make the test pass:

```
Task(subagent_type="agent-olympus:executor", model="sonnet",
  prompt="Write the MINIMUM code to pass this test.

  Test: <test_code>
  Test failure: <exact_error_message>

  Requirements:
  - Write ONLY the code needed to pass the test
  - Do NOT add features beyond what the test requires
  - Do NOT refactor or clean up yet
  - Do NOT write additional tests

  Output: complete production code file, ready to run
  After output, note: 'RUN: npm test' or equivalent")
```

Record the production code. Run the test suite. Verify:
- The new test PASSES
- ALL existing tests still PASS (zero regressions)
- Test output is clean (no warnings related to this code)

**Gate**: ALL tests PASS. If any existing test breaks, revert the code and diagnose.

### Phase 3 — REFACTOR

Clean up the code (duplication, naming, structure):

```
Task(subagent_type="agent-olympus:executor", model="sonnet",
  prompt="Clean up the code written in GREEN phase.

  Production code: <code_from_phase_2>
  Test: <test_code>

  Requirements:
  - Extract duplicated logic into helpers
  - Rename unclear variable/function names
  - Remove unnecessary comments
  - Do NOT add new behavior or new code paths

  Output: refactored code
  Note: Full test suite run command")
```

Run the full test suite. Verify:
- All tests still PASS (zero regressions)
- Code is cleaner and more maintainable

**Gate**: Full suite passes AND code-reviewer approves.

```
Task(subagent_type="agent-olympus:code-reviewer", model="sonnet",
  prompt="Review this refactored code for quality.

  Original test: <test>
  Production code (refactored): <code>

  Check:
  - Code is cleaner than Phase 2
  - No new behavior introduced
  - Names are clear
  - Any remaining duplication?

  Verdict: APPROVE or request specific changes")
```

### Phase 1-3 Loop

After Phase 3 completes, increment to the next unit identified in Phase 0.
Return to Phase 1 for the next unit.

Stop when all units are implemented and all tests pass.

## Output Format

```
## TDD Cycle Complete — <unit_name>

| Phase | Status | Evidence |
|-------|--------|----------|
| RED | PASS | Test fails with: <error> |
| GREEN | PASS | All N tests passing |
| REFACTOR | PASS | Full suite passing, reviewer approved |

### Units Completed
- Unit-1 ✅
- Unit-2 ✅

### Test Results
<count> / <count> passing

Ready for integration.
```

## Iron Laws

1. **NEVER write production code before a failing test exists for it.**
2. **In GREEN phase, write the MINIMUM code to pass. No gold-plating.**
3. **In REFACTOR phase, do NOT add new behavior. Only restructure.**
4. **If any existing test breaks during GREEN or REFACTOR, REVERT immediately and diagnose.**
5. **Every phase transition requires running the FULL test suite as machine-verifiable evidence.**

## Forbidden

- Writing production code and tests simultaneously
- Skipping the RED phase ("I know it will fail")
- Writing more than one test at a time in RED phase
- Declaring GREEN without running the test suite
- Adding new features in REFACTOR phase
- Merging REFACTOR changes if any test breaks

## Integration

**Atlas Phase 3 (EXECUTE):**
If the story involves new functionality (not pure refactoring) and has testable acceptance criteria:

```
Skill(skill="agent-olympus:tdd",
  args="Implement US-<ID> using RED/GREEN/REFACTOR: <story details>")
```

This replaces standard executor dispatch for that story.

**Post-consensus-plan:**
When consensus-plan produces a PRD with testable stories, consider invoking `/tdd` for each story's implementation rather than direct executor dispatch.

## Guardrails

| Guard | Value | Behaviour on breach |
|-------|-------|---------------------|
| Max test count per phase | 1 in RED | Reject; only one test per RED pass |
| Framework detection failure | Escalate | Ask user which framework to use |
| Test file location not found | Escalate | Ask user where test files live |
| Phase gate failure | STOP | Do not proceed to next phase |

## Stop_Conditions

STOP and report completion when:
- All units identified in Phase 0 have completed Phase 3 (REFACTOR)
- All tests pass (new + existing, zero regressions)
- code-reviewer approves final REFACTOR
- Markdown summary is presented to user

ESCALATE to user when:
- Test framework cannot be detected
- A unit's tests fail after two REFACTOR attempts
- User requests manual override of phase gates

</TDD_Skill>
