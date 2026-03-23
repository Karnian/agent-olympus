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
ls .omc/state/atlas-state.json 2>/dev/null && echo "ATLAS ACTIVE"

# Check for Athena
ls .omc/state/athena-state.json 2>/dev/null && echo "ATHENA ACTIVE"

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
rm -f .omc/state/atlas-state.json
rm -f .omc/prd.json

# 3. Keep progress.txt (preserves learnings)
echo "Atlas session cancelled. Progress preserved in .omc/progress.txt"
```

**For Athena:**
```bash
# 1. Kill Codex tmux sessions (workers first)
tmux list-sessions -F "#{session_name}" 2>/dev/null | grep "athena-" | while read s; do
  tmux kill-session -t "$s"
done

# 2. Clean team resources
rm -rf .omc/teams/

# 3. Clean state files
rm -f .omc/state/athena-state.json
rm -f .omc/prd.json

# 4. Clean up Claude native team if active
# TeamDelete("athena-<slug>") if team exists

# 5. Keep progress.txt
echo "Athena session cancelled. Progress preserved in .omc/progress.txt"
```

### 3. Report

Tell user:
- What was cancelled (Atlas/Athena)
- What phase it was in when cancelled
- What was preserved (.omc/progress.txt)
- How to resume: "Run /atlas or /athena again with the same task"

## Resume After Cancel

Progress is preserved in `.omc/progress.txt`. When Atlas/Athena is invoked again:
1. Check if `.omc/progress.txt` exists
2. Read previous learnings and completed work
3. Skip already-completed stories
4. Continue from where it left off

## Notes

- Cancel is always safe — no data loss (progress.txt preserved)
- Tmux sessions are killed gracefully (SIGTERM, not SIGKILL)
- prd.json is deleted so a fresh plan is generated on restart
- State files are deleted to prevent stale state corruption

</Cancel>
