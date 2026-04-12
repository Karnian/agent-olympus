---
name: finish-branch
description: Structured branch completion with verified checklist before merge decision
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
Step 2.5: UI SMELL SCAN (v1.0.2 US-001 — opt-in)
    Run ui-smell-scan if config/design-blacklist.jsonc exists
        │
        ├─ CLEAN / NO CONFIG / NO UI FILES ────┐
        ├─ WARN MODE + violations ─────────────┤ (log + continue)
        │                                      │
        └─ BLOCK MODE + violations ────→ STOP (fail with structured error)
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

Run the project's lint/syntax check:

- If `package.json` has a `lint` script → `npm run lint`
- If `.mjs` files present → `node --check` on each script file
- If other linter config found (`.eslintrc`, `pyproject.toml`, etc.) → use project linter

```
Record:
- Lint errors: <count>
- Lint warnings: <count>
- Syntax errors: 0

If lint errors exist:
  STOP. Do not proceed. Ask user to fix lint errors.
  Return to user: "Fix these lint errors: <list>"
```

**Gate**: Zero lint errors. Warnings are acceptable.

### Step 2.5 — UI SMELL SCAN (v1.0.2 US-001, opt-in)

Run the anti-pattern registry scan against the diff. This step is OPT-IN:
it only runs when `config/design-blacklist.jsonc` exists. Without that file
the step is skipped silently and finish-branch continues.

```
# Check for config
if [ ! -f config/design-blacklist.jsonc ]; then
  # skip silently — no config, no scan
  continue to Step 3
fi

# Determine mode from .ao/autonomy.json (default 'warn')
mode=$(node -e '
  try {
    const c = JSON.parse(require("fs").readFileSync(".ao/autonomy.json","utf-8"));
    process.stdout.write(c.uiSmellScan === "block" ? "block" : "warn");
  } catch { process.stdout.write("warn"); }
')

# Collect diff files with UI extensions
BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||' || echo "main")
UI_FILES=$(git diff origin/$BASE --name-only | grep -E '\.(css|scss|sass|less|tsx|jsx|vue|svelte|html)$' || true)

# If no UI files in diff, skip silently regardless of mode
if [ -z "$UI_FILES" ]; then
  continue to Step 3
fi

# Run scan via scripts/lib/ui-smell-scan.mjs
# IMPORTANT: env vars MUST be set BEFORE `node`, not as positional args after `-e`.
UI_FILES="$UI_FILES" AO_RUN_ID="${AO_RUN_ID:-}" node -e '
  import("./scripts/lib/ui-smell-scan.mjs").then(async (m) => {
    const fs = await import("node:fs/promises");
    const paths = (process.env.UI_FILES || "").split("\n").filter(Boolean);
    const files = await Promise.all(paths.map(async (p) => ({
      path: p,
      content: await fs.readFile(p, "utf-8").catch(() => ""),
    })));
    const result = await m.scanDiff({ files });
    // Write run artifact
    const runId = process.env.AO_RUN_ID || String(Date.now());
    const artifactDir = `.ao/artifacts/runs/${runId}`;
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(
      `${artifactDir}/ui-smell-scan.json`,
      JSON.stringify({ schemaVersion: 1, ...result }, null, 2),
    );
    console.log(JSON.stringify(result));
    if (result.mode === "block" && !result.clean) process.exit(2);
  }).catch((err) => { console.error("ui-smell-scan failed:", err.message); process.exit(0); });
'
```

**Gate (warn mode, default)**: Log violations and continue to Step 3.
**Gate (block mode, opt-in)**: Fail finish-branch with structured error listing all violations. User must resolve each violation or override via `allowedFonts` in `.ao/memory/design-identity.json`.

**Rollback**: Delete `config/design-blacklist.jsonc` to disable the scan entirely.

### Step 2.7 — UI REMEDIATE (v1.0.2 US-008, optional)

If `/ui-remediate` was invoked during this session and a remediation chain is
in progress, finish-branch waits for chain completion before continuing.

```javascript
// Finish-branch checks for a pending remediation run
const remediationPending = existsSync('.ao/state/ao-ui-remediation-pending.json');
if (remediationPending) {
  // Wait for runChain() to resolve — it is already running as an awaited async task
  // The skill handles the wait; finish-branch does NOT spawn a new chain here.
  // If the chain already completed, read the result from:
  //   .ao/artifacts/runs/<runId>/ui-remediation.json
  // Check result.ok — if false: STOP and report to user
  // If ok or if file doesn't exist: continue to Step 3
}
```

**Gate (if remediation was run)**: `result.ok === true`. A halted or regressed
remediation chain causes finish-branch to STOP and report.

**Gate (if remediation was NOT run)**: Skip silently, continue to Step 3.

### Step 3 — COVERAGE

Invoke verify-coverage to detect gaps:

```
invoke /verify-coverage

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
# Detect base branch
BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||' || echo "main")
CHANGED=$(git diff origin/$BASE --name-only)

Task(subagent_type="agent-olympus:code-reviewer", model="sonnet",
  prompt="Review all changes in this branch for code quality.

  Changed files: <list from git diff>
  Branch: <current_branch>
  Base branch: origin/$BASE

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

#### Option: Auto-Ship (if autonomy.json configured)

If `.ao/autonomy.json` exists with `ship.autoPush: true`:
1. Run preflight: `preflightCheck()`
2. If passes: push branch, create/reuse PR, link issues
3. Report PR URL

If `ship.autoPush` is false (default):
Present "Create PR" as an additional option alongside existing merge/keep/discard options:
- **Create PR** — push branch and create a draft PR via `gh pr create`
  - Extracts issue refs from commits and branch name
  - Builds PR body from test results and file changes

For structured commit history: invoke /git-master for atomic commit discipline.

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
| Discard branch | User confirms twice (type "DELETE" to confirm) | Abort if not confirmed |

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
