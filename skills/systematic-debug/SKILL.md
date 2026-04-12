---
name: systematic-debug
description: Root-cause-first debugging methodology - reproduce before any fix attempt
---

<Systematic_Debug_Skill>

## Purpose

Systematic debugging enforces a disciplined five-phase pipeline: REPRODUCE (prove bug is real), ISOLATE (find the boundary), UNDERSTAND (explain why), FIX (apply minimal targeted fix), VERIFY (regression test). No guesswork, no shotgun debugging, no "I think this might fix it."

## Use_When

- User says "debug", "디버그", "systematic-debug", "root-cause"
- A known bug is broken (user can describe symptoms)
- Reproduction steps are unclear but the failure is observable
- Existing fix attempts have not worked
- First-line debugging before escalating to `trace` skill

## Do_Not_Use_When

- Failure is completely ambiguous (use `trace` skill instead)
- Multiple unrelated bugs may be present (use `trace` for multi-hypothesis)
- Reproduction is impossible (user cannot trigger bug reliably)

## Core_Principle

**NEVER attempt a fix without first reproducing the bug consistently.**

## Architecture

```
Known Failure (User Reports Bug)
        │
        ▼
Phase 1: REPRODUCE
    Find exact steps, reproduce 3/3 times
        │
        ▼
Phase 2: ISOLATE
    Binary search to module/function/line
        │
        ▼
Phase 3: UNDERSTAND
    Root cause (not symptom)
        │
        ▼
Phase 4: FIX
    Minimal targeted change
        │
        ▼
Phase 5: VERIFY
    Regression test + full suite
```

## Steps

### Phase 1 — REPRODUCE

Find exact, consistent reproduction steps:

```
Task(subagent_type="agent-olympus:debugger", model="sonnet",
  prompt="Find exact reproduction steps for this bug.

  Symptom: <user_description>
  Environment: <context>

  Requirements:
  - Find the EXACT sequence of actions/inputs that trigger the failure
  - Each step must be deterministic (no randomness, no timing-dependent)
  - Test the steps 3 times; if any test differs, note the variance
  - Document: exact command, inputs, expected vs actual output
  - If reproduction fails, list what was tried and why it didn't work

  Output: numbered steps, verified to reproduce bug 3/3 times
  Or: 'Reproduction failed: <reason>. Suggest: <alternative approach>'")
```

Run the reproduction steps yourself. Verify failure 3 consecutive times.

**Gate**: Bug must reproduce consistently (3/3 runs show same failure).
If reproduction fails after 3 attempts: escalate to user (do not guess).

### Phase 2 — ISOLATE

Use binary search to narrow the fault boundary:

```
Task(subagent_type="agent-olympus:debugger", model="sonnet",
  prompt="Isolate this bug to a specific module/function/line.

  Bug reproduction: <exact_steps>
  Failure: <error_message>

  Strategy:
  1. Identify the entry point (function/API/command)
  2. Add strategic logging/debugging output (no code changes yet)
  3. Binary search: run with half the code disabled (comment out blocks)
  4. Find the minimal component that triggers the failure
  5. Narrow to the specific function or block

  For complex bugs: outline your binary search strategy before executing.
  For simple bugs: execute the binary search directly.

  Output: identified component, line number, or function name
  Evidence: logs/output from each binary search step")
```

For complex bugs, optionally invoke Metis for isolation strategy:

```
Task(subagent_type="agent-olympus:metis", model="opus",
  prompt="Design a binary search strategy to isolate this bug.

  Component: <system_description>
  Symptom: <failure>
  Known-working: <parts_that_work>

  Propose 3-5 targeted tests that will efficiently narrow the fault boundary.
  Output: numbered tests with predicted outcomes for each hypothesis")
```

**Gate**: Narrowed to specific module/function/line. No ambiguity remains about the location.

### Phase 3 — UNDERSTAND

Explain the root cause (not the symptom):

```
Task(subagent_type="agent-olympus:debugger", model="sonnet",
  prompt="Explain the root cause of this bug.

  Isolated component: <file_and_line>
  Code context: <surrounding_code>
  Symptom: <failure_behavior>

  Requirements:
  - Do NOT describe the symptom; explain WHY it happens
  - Trace the causal chain: execution path → data flow → actual error
  - Answer: What assumption did the code make that is false?
  - Answer: What input or state breaks that assumption?

  Output: Root cause explanation (2-3 sentences, clear causal chain)
  Do NOT propose a fix yet.")
```

**Gate**: Root cause documented with clear causal chain. The explanation must answer "Why does this happen?" not just "Where does this happen?"

### Phase 4 — FIX

Apply a minimal, targeted fix:

```
Task(subagent_type="agent-olympus:debugger", model="sonnet",
  prompt="Apply a minimal targeted fix for this root cause.

  Root cause: <explanation>
  Isolated component: <file_and_line>
  Current code: <code_snippet>

  Requirements:
  - Write ONLY the fix needed to address this root cause
  - Do NOT refactor, clean up, or add 'while I'm here' changes
  - Do NOT fix other bugs even if you spot them
  - After fix, reproduction steps should no longer trigger the failure

  Output: fixed code snippet, ready to apply
  Note: exact file path and line range for the fix")
```

Record the fix. Manually verify reproduction steps no longer trigger the bug.

**Gate**: Reproduction steps executed 1+ time after fix; bug no longer reproduces.

Note: Phase 4 requires only 1 successful run (not 3/3) because Phase 1 already
established consistent reproduction. The fix verification confirms resolution,
not consistency.

### Phase 5 — VERIFY

Write a regression test and verify no regressions:

```
Task(subagent_type="agent-olympus:test-engineer", model="sonnet",
  prompt="Write a regression test for this bug fix.

  Root cause: <explanation>
  Fix applied: <code_change>
  Reproduction steps: <original_steps>

  Requirements:
  - Test must fail BEFORE the fix is applied
  - Test must pass AFTER the fix is applied
  - Test should specifically verify the root cause is fixed
  - Test name should describe the bug being prevented

  Output: complete test code, ready to add to test suite")
```

Add the regression test to the test suite. Run the full test suite:

```
npm test  (or project-specific test command)
```

Verify:
- New regression test PASSES
- ALL existing tests still PASS (zero regressions)
- Full suite output is clean

**Gate**: Regression test exists AND full suite passes.

## Output Format

```
## Bug Fixed — <bug_title>

| Phase | Status | Evidence |
|-------|--------|----------|
| REPRODUCE | PASS | Bug reproduced 3/3 times |
| ISOLATE | PASS | Narrowed to <file>:<line> |
| UNDERSTAND | PASS | Root cause: <explanation> |
| FIX | PASS | Applied to <file> |
| VERIFY | PASS | Regression test + <N> tests passing |

### Reproduction Steps (Original)
1. <step>
2. <step>
3. <step>

### Root Cause
<explanation>

### Fix Applied
<code change>

### Regression Test
<test code snippet>

All tests passing. Bug fixed.
```

## Iron Laws

1. **NEVER attempt a fix without first reproducing the bug consistently (Phase 1 gate).**
2. **NEVER skip isolation. Fixing a symptom without understanding the cause creates new bugs.**
3. **The fix must be MINIMAL and TARGETED. No refactoring, no 'while I am here' changes.**
4. **A bug is not fixed until a regression test proves it cannot recur.**
5. **If reproduction fails after 3 attempts, escalate to user — do not guess.**

## Forbidden

- Shotgun debugging (trying random changes to see what sticks)
- Printf-and-pray (adding console.log everywhere without a hypothesis)
- Fix-and-forget (fixing without a regression test)
- Symptom-squashing (suppressing the error instead of fixing the cause)
- Fixing without reproduction (applying a change "just in case")

## Integration

**When to use systematic-debug vs trace:**
- **systematic-debug**: Bug is known and reproducible (single-bug focus, clear entry point)
- **trace**: Failure is ambiguous, involves multiple possible causes, or debugger has failed twice

**In debugger.md Hard Gates:**
The debugger agent enforces systematic-debug discipline through mandatory gates at Phase 1 (REPRODUCE), Phase 4 (FIX), and Phase 5 (VERIFY).

**Post-fix integration:**
After systematic-debug completes, regression test is integrated into the main test suite for ongoing protection.

## Guardrails

| Guard | Value | Behaviour on breach |
|-------|-------|---------------------|
| Reproduction attempts | 3 | Escalate to user if all fail |
| Binary search depth | No limit, but log each step | Escalate if >10 steps needed |
| Time per phase | No limit | Escalate if >1 hour without progress |

## Stop_Conditions

STOP and report completion when:
- Bug reproduces consistently (3/3)
- Root cause is documented
- Fix applied and verified
- Regression test written and passes
- Full test suite passes (zero regressions)
- Markdown summary presented to user

ESCALATE to user when:
- Reproduction fails after 3 attempts (cannot verify bug exists)
- Root cause cannot be identified after Phase 2 isolation (suggest trace skill)
- Multiple different errors appear in binary search (suggest trace skill)
- Debugger agent fails to propose a fix after identifying root cause

</Systematic_Debug_Skill>
