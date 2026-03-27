---
name: cancel
description: Graceful shutdown of running Atlas/Athena sessions — clean up state, tmux, and team resources
level: 1
aliases: [cancel, 취소, stop, abort, 중지]
---

<Cancel>

## Purpose

Gracefully shut down any running Atlas or Athena session. Cleans up state files,
kills tmux sessions, and removes team resources in dependency order.

## Use_When

- User says "cancel", "취소", "stop", "abort", "중지"
- Need to abort a running Atlas/Athena session
- Something went wrong and you want a clean restart

## Steps

### 1. Detect Active Mode

Check for state files to determine what's running:

```bash
# Check for Atlas
ls .ao/state/atlas-state.json 2>/dev/null && echo "ATLAS ACTIVE"

# Check for Athena
ls .ao/state/athena-state.json 2>/dev/null && echo "ATHENA ACTIVE"

# Check for active tmux sessions
tmux list-sessions 2>/dev/null | grep -E "atlas-|athena-"
```

### 2. Shutdown Order (dependency-safe)

**For Atlas:**
```bash
# 1. Kill Codex tmux sessions first (workers before lead)
tmux list-sessions -F "#{session_name}" 2>/dev/null | grep "atlas-codex" | while read s; do
  tmux kill-session -t "$s"
done

# 2. Clean state files
rm -f .ao/state/atlas-state.json
rm -f .ao/prd.json

# 3. Keep wisdom.jsonl (preserves learnings)
echo "Atlas session cancelled. Progress preserved in .ao/wisdom.jsonl"
```

**For Athena:**
```bash
# 1. Kill Codex tmux sessions (workers first)
tmux list-sessions -F "#{session_name}" 2>/dev/null | grep "athena-" | while read s; do
  tmux kill-session -t "$s"
done

# 2. Clean team resources
rm -rf .ao/teams/

# 3. Clean state files
rm -f .ao/state/athena-state.json
rm -f .ao/prd.json

# 4. Clean up Claude native team if active
# TeamDelete("athena-<slug>") if team exists

# 5. Clean up git worktrees (fail-safe — skip if no worktrees exist)
```javascript
import { cleanupTeamWorktrees } from './scripts/lib/worktree.mjs';
// Read team slug from checkpoint or state before clearing them
cleanupTeamWorktrees(cwd, teamSlug);  // removes .ao/worktrees/<slug>/ and worker branches
```

# 6. Keep wisdom.jsonl
echo "Athena session cancelled. Progress preserved in .ao/wisdom.jsonl"
```

### 3. Report

Tell user:
- What was cancelled (Atlas/Athena)
- What phase it was in when cancelled
- What was preserved (.ao/wisdom.jsonl)
- How to resume: "Run /atlas or /athena again with the same task"

## Resume After Cancel

Progress is preserved in `.ao/wisdom.jsonl`. When Atlas/Athena is invoked again:
1. Check if `.ao/wisdom.jsonl` exists
2. Read previous learnings and completed work
3. Skip already-completed stories
4. Continue from where it left off

## Notes

- Cancel is always safe — no data loss (wisdom.jsonl preserved)
- Tmux sessions are killed gracefully (SIGTERM, not SIGKILL)
- prd.json is deleted so a fresh plan is generated on restart
- State files are deleted to prevent stale state corruption
- **Checkpoint files are PRESERVED on cancel** (`.ao/state/checkpoint-atlas.json` / `.ao/state/checkpoint-athena.json`). They are NOT deleted. This enables the next Atlas/Athena invocation to detect the interrupted session and offer to resume from the exact phase where it was cancelled.

</Cancel>
