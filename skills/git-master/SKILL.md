---
name: git-master
description: Atomic commit discipline — style detection, multi-file decomposition, clean history
level: 2
aliases: [git-master, commit, 커밋, git]
---

<Git_Master>

## Purpose

Enforce atomic, well-organized commits. Detect project's commit style from history
and produce commits that match. Prevent monolithic commits from multi-agent work.

## Use_When

- After implementation is complete and changes need committing
- User says "commit", "커밋", "git-master"
- Atlas/Athena completed a task and needs to create clean commits

## Rules

### Style Detection (run FIRST)
```bash
git log --oneline -20
```
Detect from history:
- Prefix style: `feat:`, `fix:`, `chore:` (conventional) vs plain descriptions
- Language: English vs Korean vs mixed
- Scope format: `feat(api):` vs `feat:` vs no prefix
- Match detected style for all new commits

### Atomic Commit Rule
**3+ files changed → MUST produce 2+ commits.**

Decompose by:
1. Logical unit (one feature/fix per commit)
2. Layer (backend vs frontend vs tests vs config)
3. Dependency order (schema before API before UI)

### Commit Process
```bash
# 1. Review all changes
git diff --stat
git diff

# 2. Group into logical commits
# 3. Stage and commit each group separately
git add <specific-files>
git commit -m "<style-matched message>"

# 4. Verify clean state
git status
git log --oneline -5
```

### Rebase & History
- `git rebase` for cleaning up WIP commits before push
- `git commit --fixup=<sha>` + `git rebase -i --autosquash` for corrections
- Never rewrite published history (pushed to shared branches)

### Conflict Resolution
1. `git diff --check` before committing
2. On merge conflicts: understand both sides, resolve semantically (not just pick one)
3. After resolution: verify build + tests still pass

## Integration_With_Orchestrators

Atlas/Athena should invoke git-master as the FINAL step after all verification passes:
```
Phase 5 (Review) → APPROVED → git-master → DONE
```

</Git_Master>
