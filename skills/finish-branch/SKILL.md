---
name: finish-branch
description: Structured branch completion with verified checklist before merge decision
level: 2
aliases: [finish-branch, 브랜치완료, finish, 완료, branch-done, pre-merge]
---

<Finish_Branch_Skill>

## Purpose

Finish-branch performs a systematic pre-merge checklist: tests pass, lint passes, coverage gaps identified, code reviewed, and commits clean. Only after all checks pass does the skill present merge options to the user. No auto-merging; all decisions rest with the user.

## Use_When

- User says "finish-branch", "브랜치완료", "finish", "완료", "pre-merge"
- Feature branch is ready for merge decision
- Verification is needed before merging to main
- Code review and test verification required before completion

## Do_Not_Use_When

- Feature branch has known unresolved conflicts
- User wants to merge without verification

## Core_Principle

**ALL verification checks must pass before presenting merge options to user.**

## Architecture

```
Feature Branch (Ready for Completion)
        │
        ▼
Step 1: TEST
    Run full test suite
        │
        ├─ ALL PASS ────┐
        │               │
        └─ ANY FAIL ────→ STOP (must fix)
                         │
                         ▼
Step 2: LINT
    Run linter/formatter
        │
        ├─ PASS ────┐
        │           │
        └─ FAIL ────→ STOP (fix or suppress)
                     │
                     ▼
Step 3: COVERAGE
    Check for test gaps (invoke verify-coverage)
        │
        ▼
Step 4: REVIEW
    code-reviewer final pass
        │
        ├─ No CRITICAL ────┐
        │                  │
        └─ CRITICAL ───────→ STOP (resolve findings)
                            │
                            ▼
Step 5: PRESENT
    Show checklist results
    Offer merge options
```

## Steps

### Step 1 — TEST

Run the full test suite:

```
Command: npm test  (or project-specific test command)

Record:
- Total tests: <count>
- Passing: <count>
- Failing: <count>
- Exit code: 0

If any test fails:
  STOP. Do not proceed. Ask user to fix failing tests.
  Return to user: "Fix these tests before proceeding: <list>"
```

**Gate**: ALL tests PASS. Zero failures.

### Step 2 — LINT

Run linter and syntax checker:

```
Commands:
  npm run lint  (if configured)
  for f in scripts/*.mjs; do node --check "$f"; done  (AO-specific)

Record:
- Lint errors: <count>
- Lint warnings: <count>
- Syntax errors: 0

If lint errors exist:
  STOP. Do not proceed. Ask user to fix lint errors.
  Return to user: "Fix these lint errors: <list>"
```

**Gate**: Zero lint errors. Warnings are acceptable.

### Step 3 — COVERAGE

Invoke verify-coverage to detect gaps:

```
Skill(skill="agent-olympus:verify-coverage",
  args="Check coverage gaps for this branch")

Collect output:
- Covered files: <list>
- Missing tests: <list>
- Hook registration check: <status>

Warnings are acceptable. Critical gaps flag files with no test coverage.
Present gap report to user.
```

**Gate**: No critical coverage gaps. Advisory gaps noted but do not block.

### Step 4 — REVIEW

Run code-reviewer on all changed files:

```
git diff origin/main --name-only > changed_files.txt

Task(subagent_type="agent-olympus:code-reviewer", model="sonnet",
  prompt="Review all changes in this branch for code quality.

  Changed files: <list from git diff>
  Branch: <current_branch>
  Base branch: origin/main

  Requirements:
  - Read each changed file
  - Check review items 1-9 (existing checklist)
  - Classify findings: CRITICAL / HIGH / MEDIUM / LOW
  - CRITICAL findings must be resolved before merge

  Output: findings by severity, with specific file/line references")
```

Collect reviewer verdict:
- CRITICAL findings: <count>
- HIGH findings: <count>
- MEDIUM findings: <count>
- LOW findings: <count>

If CRITICAL findings exist:
  STOP. Do not proceed. Ask user to resolve critical findings.

**Gate**: Zero CRITICAL findings. HIGH/MEDIUM/LOW are warnings but do not block.

### Step 5 — PRESENT

Format results and present merge options:

```
## Branch Ready: <branch-name>

**Verification Checklist:**

| Check | Result |
|-------|--------|
| Tests | PASS (<count> / <count>) |
| Lint | PASS (0 errors, <warns> warnings) |
| Coverage | <N> gaps (advisory), <M> critical gaps if any |
| Review | <N> findings (0 CRITICAL, <H> HIGH, <M> MEDIUM, <L> LOW) |

**Status**: ✅ Ready for merge

### Options

Choose one:

1. **Merge to main** — Merge this branch into main with `git merge --no-ff`
2. **Create PR** — Create a pull request for additional review
3. **Keep branch** — Do nothing; branch stays as-is
4. **Discard branch** — Delete this branch (ask for confirmation first)

Which option?
```

**User chooses action. Execute chosen action only after explicit confirmation.**

## Output Format

```
## Pre-Merge Checklist — <branch_name>

| Check | Status | Details |
|-------|--------|---------|
| Test Suite | PASS | 182/182 passing |
| Lint | PASS | 0 errors, 2 warnings |
| Coverage Gaps | ADVISORY | 2 files without tests (see list) |
| Code Review | PASS | 8 findings: 0 CRITICAL, 2 HIGH, 3 MEDIUM, 3 LOW |

### Coverage Gap Report
See verify-coverage output

### Code Review Findings
- <file>:<line> — CRITICAL/HIGH/MEDIUM/LOW finding

### Next Steps
Ready for merge. Choose: merge / PR / keep / discard
```

## Iron Laws

1. **NEVER merge with failing tests.**
2. **NEVER merge with unreviewed CRITICAL findings.**
3. **NEVER skip the test step, even for 'trivial' changes.**
4. **Present ALL options to the user. Do not auto-merge.**

## Forbidden

- Merging without running the test suite
- Suppressing lint errors instead of fixing them
- Auto-merging without user confirmation
- Skipping review for "small" changes
- Ignoring CRITICAL findings

## Integration

**User invokes directly:**
```
/finish-branch  (on feature branch)
```

**verify-coverage integration:**
finish-branch calls verify-coverage as Step 3 of the pre-merge checklist.

**code-reviewer integration:**
finish-branch calls code-reviewer as Step 4 of the pre-merge checklist.

## Guardrails

| Guard | Value | Behaviour on breach |
|-------|-------|---------------------|
| Test failure | STOP | Do not proceed to Step 2 |
| Lint failure | STOP | Do not proceed to Step 3 |
| CRITICAL review finding | STOP | Do not proceed to Step 5 |
| User confirmation required | Yes | Do not execute merge/discard without confirmation |

## Stop_Conditions

STOP and report results when:
- All 5 steps complete successfully (no failures, no blockers)
- Checklist summary is presented to user
- User chooses action (merge/PR/keep/discard)

STOP and ask for fixes when:
- Step 1 (TEST) fails — user must fix failing tests
- Step 2 (LINT) fails — user must fix lint errors
- Step 4 (REVIEW) finds CRITICAL issues — user must address them

**User confirms action before execution:**
- Merge: "git merge --no-ff" only after user confirms
- Discard: "git branch -D" only after user confirms deletion twice
- Create PR: "gh pr create" only after user confirms

</Finish_Branch_Skill>
