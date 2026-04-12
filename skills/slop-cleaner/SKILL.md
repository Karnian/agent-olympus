---
name: slop-cleaner
description: Regression-safe cleanup of AI-generated code bloat — deletion-first, verify-after
---

<Slop_Cleaner>

## Purpose

Remove AI-generated bloat (dead code, duplicate logic, needless abstractions, over-commenting)
without changing behavior. Runs in structured passes with regression verification after each.

## Use_When

- After multi-agent implementation (Atlas/Athena produce slop naturally)
- User says "clean up", "deslop", "슬롭 정리"
- Code review found AI slop patterns
- Atlas/Athena Phase 5 review flagged code quality issues

## Do_Not_Use_When

- Code is already clean and minimal
- Changes are trivial (single function addition)

## Slop Patterns to Target

1. **Dead code**: Unused imports, unreachable branches, commented-out code
2. **Duplicate logic**: Same function/pattern repeated across files
3. **Over-abstraction**: Wrapper functions that add no value
4. **Excessive comments**: Comments restating what code obviously does
5. **Placeholder code**: TODO stubs, empty catch blocks, pass-through functions
6. **Defensive over-engineering**: Try/catch around code that can't throw
7. **Naming bloat**: `getAllUsersFromDatabase()` → `getUsers()`

## Steps

### Pass 1 — DEAD CODE (highest confidence, lowest risk)

```
Find and remove:
- Unused imports/requires
- Unreachable code after return/throw
- Commented-out code blocks (>2 lines)
- Unused variables and functions
```

Verify: `build + tests pass`

### Pass 2 — DUPLICATES

```
Find and consolidate:
- Functions with >80% similar logic → extract shared function
- Copy-pasted blocks → extract to utility
- Repeated patterns → DRY up
```

Verify: `build + tests pass`

### Pass 3 — COMMENTS & NAMING

```
Remove:
- Comments that restate the code: // increment counter \n counter++
- Section dividers: // =========
- Obvious JSDoc: @param name - the name

Simplify:
- Overly verbose names
- Unnecessary intermediate variables
```

Verify: `build + tests pass`

### Pass 4 — VERIFY NO BEHAVIOR CHANGE

```bash
# Run full test suite
# Run build
# Diff review: only deletions and renames, no logic changes
git diff --stat  # should show mostly deletions
```

## Critical Rules

- **NEVER change behavior** — only remove/simplify
- **Verify after EVERY pass** — if tests fail, revert that pass
- **Deletions > additions** — if your diff adds more than it removes, you're doing it wrong
- **When in doubt, leave it** — false positives are worse than missed slop

## Integration

Atlas/Athena invoke this automatically before final completion:
```
Phase 5 Review → slop-cleaner → git-master → DONE
```

</Slop_Cleaner>
