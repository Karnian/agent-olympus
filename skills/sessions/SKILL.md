---
name: sessions
description: Browse, inspect, resume, and clean up Claude Code session history
level: 2
aliases: [sessions, session, 세션, 세션관리, history, 히스토리, runs, 실행이력, show-sessions]
---

<Sessions>

## Purpose

On-demand browser for Claude Code session history in this project.
Shows which sessions ran, what branch they were on, whether they are
resumable, and which Atlas/Athena runs they produced.

## Use_When

- User asks "what did I work on before?", "이전에 뭐 했지?"
- User wants to reference or resume a previous session
- User asks about Atlas/Athena run history
- User wants to clean up stale session/state data
- Atlas/Athena needs to find a session with relevant context

## Do_Not_Use_When

- User wants to cancel a running Atlas/Athena session -> use /cancel
- User wants to start a new orchestration -> use /atlas or /athena

## Steps

### Step 1 — PARSE REQUEST

Determine action from user input:

| Input | Action |
|-------|--------|
| `/sessions` (no args) | **list** — show recent 10 sessions |
| `/sessions <session-id>` | **inspect** — show session details + linked runs |
| `/sessions search <keyword>` | **search** — filter by branch, cwd, or keyword |
| `/sessions cleanup` | **cleanup** — prune expired records + stale state |
| `/sessions resume <session-id>` | **resume** — reactivate a dormant session via tmux |

### Step 2 — FETCH DATA

Use the session-registry library to query data:

```javascript
import {
  listSessions,
  getSession,
  isSessionAlive,
  pruneSessions,
} from './scripts/lib/session-registry.mjs';

import { listRuns, getRun } from './scripts/lib/run-artifacts.mjs';
import { loadCheckpoint, formatCheckpoint } from './scripts/lib/checkpoint.mjs';
```

**list action:**
```javascript
const sessions = listSessions({ limit: 10 });
const atlasCP = await loadCheckpoint('atlas');
const athenaCP = await loadCheckpoint('athena');
```

**inspect action:**
```javascript
const session = getSession(sessionId);
const alive = isSessionAlive(sessionId);
// If session has runIds, fetch run details
for (const runId of session.runIds) {
  const run = getRun(runId);
}
```

**search action:**
```javascript
const sessions = listSessions({ branch: keyword, limit: 20 });
// Also try filtering by cwd substring
```

### Step 3 — DISPLAY

**list output:**
```markdown
## Recent Sessions

| Session | Branch | Started | Status | Runs | Resumable |
|---------|--------|---------|--------|------|-----------|
| abc123.. | feature/auth | 04-02 14:30 | ended | 1 | yes |
| def456.. | main | 04-01 16:05 | ended | 0 | no (expired) |
| ghi789.. | fix/login | 04-01 10:20 | crashed | 0 | yes |

## Active Checkpoints
- Atlas: Phase 3 (EXECUTE), 2/5 stories -> resume with /atlas
```

**inspect output:**
```markdown
## Session: abc123...

**Branch:** feature/auth
**Status:** ended | **Resumable:** yes
**Started:** 2026-04-02 14:30 | **Ended:** 2026-04-02 15:45
**CWD:** /project/path
**HEAD:** a1b2c3d

### Linked Runs
- atlas-20260402-143022-a1b2 — "Implement OAuth2" — completed (5/5 stories)

### Actions
- `/sessions resume abc123` — resume this session
- `/sessions abc123` — refresh details
```

**cleanup output:**
```markdown
## Cleanup Summary
- Pruned 3 session records (>90 days)
- Removed 2 stale state files (>24h)
- No orphan tmux sessions found
```

### Step 4 — RESUME (resume action only)

If `isSessionAlive(sessionId)` returns true:

```bash
tmux new-session -d -s "ao-resume-<short-id>" -c "<session-cwd>"
tmux send-keys -t "ao-resume-<short-id>" 'claude -r "<sessionId>" "Continue from where you left off"' Enter
```

Report the tmux session name so the user can monitor it.

If session is not alive:
```
Session <id> is no longer resumable (expired or deleted by Claude Code).
Available alternatives:
- Start a new session with the same context: /atlas <task>
- View what this session worked on: /sessions <id>
```

### Step 5 — SUGGEST NEXT

Always suggest relevant follow-up actions:
- After list: "Use `/sessions <id>` for details, `/sessions resume <id>` to reactivate"
- After inspect: "Use `/sessions resume <id>` to continue this session"
- After cleanup: "Use `/sessions` to see remaining sessions"

## Integration

- **SessionStart hook** registers each new session automatically
- **SessionEnd hook** finalizes session record on exit
- **Crash recovery** — if a session ends abnormally, next SessionStart marks it as 'crashed'
- **Run-artifacts** — Atlas/Athena runs link back to their parent session via sessionId
- **/cancel** — cancels active orchestration; session record remains for reference

## Guardrails

| Guard | Behaviour |
|-------|-----------|
| wisdom.jsonl | NEVER deleted by cleanup |
| Active session | NEVER pruned (only ended/crashed sessions with age > 90d) |
| Resume confirmation | Ask user before resuming a session |
| tmux cleanup | Kill ao-resume-* sessions on /cancel |

## Notes

- Session data lives in `.ao/sessions/` at the project root (shared across worktrees)
- All functions are fail-safe — missing/corrupt data returns empty results, never errors
- Session records are lightweight metadata only (no conversation content)
- For detailed context, resume the actual session via `claude -r <id>`
- `isSessionAlive()` checks `~/.claude/sessions/` for Claude Code's own session data

</Sessions>
