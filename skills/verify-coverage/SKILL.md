---
name: verify-coverage
description: Detect test coverage gaps for recently changed files and report missing tests
level: 2
aliases: [verify-coverage, coverage-check, test-gaps, 커버리지확인, 테스트갭]
---

# Verify Coverage

Analyzes recently changed files and identifies which ones lack corresponding tests.
Inspired by Kimoring AI Skills' manage-skills gap detection pattern.

## Workflow

### Step 1 — Identify Changed Files

Run: `git diff --name-only HEAD~1` (or `git diff --name-only origin/main` if on feature branch)
Filter to: `scripts/*.mjs`, `scripts/lib/*.mjs` (exclude test files, config, docs)

### Step 2 — Map to Tests

For each changed file `scripts/lib/foo.mjs`:
- Check if `scripts/test/foo.test.mjs` exists
- Check if `scripts/test/` contains any file that imports from `../lib/foo.mjs`

For each changed `scripts/bar.mjs`:
- Check if `scripts/test/bar.test.mjs` exists

### Step 3 — Check Hook Registration

For any new hook script added:
- Verify it's registered in `hooks/hooks.json`
- Verify `run.cjs` can resolve it

### Step 4 — Run Existing Tests

`node --test 'scripts/test/**/*.test.mjs'`
Report pass/fail counts.

### Step 5 — Generate Gap Report

Output a markdown report:
```
## Coverage Gap Report

### ✅ Covered Files (N)
- scripts/lib/wisdom.mjs → scripts/test/wisdom.test.mjs

### ❌ Missing Tests (N)
- scripts/lib/worktree.mjs → No test file found
  Suggested: scripts/test/worktree.test.mjs
  Key functions: createWorkerWorktree, removeWorkerWorktree, mergeWorkerBranch

### ⚠️ Hook Registration Check
- scripts/session-start.mjs → ✅ registered in hooks.json
- scripts/stop-hook.mjs → ✅ registered in hooks.json

### Test Results
49/49 passing (+ N new)
```

### Step 6 — Optional: Create Stub Tests

If user approves ("yes", "create stubs", "스텁 만들어"):
- Create minimal stub test files for each gap
- Each stub: `test('TODO: <function>', () => { assert.ok(true, 'not implemented') })`
- Add TODO comments pointing to the source function
