---
name: athena
description: Self-driving team orchestrator — spawns Claude + Codex peer-to-peer team and loops until task is fully complete
level: 5
aliases: [athena, 아테나, team-do-it, 팀으로해, 같이해, team, collaborate]
---

<Athena_Orchestrator>

## Purpose

Athena is the self-driving team orchestrator. Unlike Atlas (one brain, many hands), Athena spawns a real team where workers talk to EACH OTHER. She never stops until every worker's output is integrated, tested, and reviewed.

Atlas = one brain delegating.
Athena = many brains collaborating.

## Use_When

- User says "athena", "아테나", "팀으로 해", "같이 해", "team", "collaborate"
- Task has interdependent parts (API + frontend + tests)
- Workers need to share discoveries in real-time
- Large-scale work across many files

## Do_Not_Use_When

- User explicitly says "atlas" (use atlas for hub-and-spoke)
- Task has no parallelizable components
- Simple single-file task (atlas handles this fine)

## Core_Principle

**NEVER STOP UNTIL DONE.** After spawning the team:
- Monitor continuously until all workers complete
- Bridge ALL Claude↔Codex communication
- If integration fails → debug and retry
- If reviews reject → fix and re-review
- Only stop when ALL checks pass, or after 15 iterations (then escalate)

## Architecture

```
┌─────────────────────────────────────────────┐
│              ATHENA LEAD                     │
│  (orchestrates, monitors, bridges, NEVER     │
│   implements — only coordinates)             │
└──────┬───────────────────────┬──────────────┘
       │                       │
  ┌────┴────┐            ┌────┴────┐
  │ Claude  │            │ Codex   │
  │ Native  │◄──bridge──►│ TMux    │
  │ Team    │            │ Workers │
  └────┬────┘            └────┬────┘
       │                       │
  SendMessage              inbox/outbox
  TaskList                (.omc/teams/)
  (peer-to-peer)
```

## Steps

### Phase 0 — TRIAGE & TEAM DESIGN

#### Checkpoint Recovery

Before starting any work:
1. Check for an interrupted session: `loadCheckpoint('athena')`
2. If found, present to user: "[formatCheckpoint output]. Resume or restart?"
   - **Resume** → skip to saved phase, restore `completedStories` and `activeWorkers` from checkpoint
   - **Restart** → `clearCheckpoint('athena')`, proceed normally

#### Load Prior Wisdom
1. Run `migrateProgressTxt()` if `.omc/progress.txt` exists (one-time migration to wisdom.jsonl)
2. Call `queryWisdom(null, 20)` to get recent learnings
3. Inject into analysis context via `formatWisdomForPrompt()`

Analyze task and design team:
```
Task(subagent_type="agent-olympus:metis", model="opus",
  prompt="Design a team:
  1. Break into INDEPENDENT work streams
  2. Each stream: scope (files), worker type, model tier, dependencies
  3. Identify coordination points
  4. Recommend team size (max 5 Claude + 2 Codex)
  Rules: Codex for algorithms/large refactoring, Claude for standard impl/UI/tests
  Prior learnings: <formatWisdomForPrompt()>
  Task: <user_request>")
```

**[OPTIONAL] Deep Dive** — if metis classifies complexity as `complex` or `architectural` AND ambiguity > 40:
```
Skill(skill="agent-olympus:deep-dive",
  args="Run deep-dive investigation on: <user_request>
  Context from codebase scan: <explore_results>
  Return path to .omc/deep-dive-report.json when complete.")
```
Read `.omc/deep-dive-report.json` after completion. If `pipeline_ready: false`, escalate to user before proceeding.
Use `recommended_approaches[0]` and `affected_files` to inform Phase 1 team design.

**[OPTIONAL] External Context** — if metis identifies an external knowledge gap (unfamiliar API, library, or protocol):
```
Skill(skill="agent-olympus:external-context",
  args="Research external context needed for: <user_request>
  Specific gap: <identified_knowledge_gap>")
```
Broadcast the returned markdown brief to all workers via team inbox before Phase 2 spawn.

```
saveCheckpoint('athena', { phase: 1, completedStories: [], activeWorkers: [], startedAt: new Date().toISOString(), taskDescription: <user_request> })
```

### Phase 1 — PLAN

**[OPTIONAL] Consensus Plan** — for complex tasks with 3 or more user stories, replace the standard Prometheus + Momus single pass with the consensus-plan skill for a higher-confidence PRD:
```
Skill(skill="agent-olympus:consensus-plan",
  args="Run consensus planning for this task.
  Task: <user_request>
  Analysis: <metis_team_design>
  Wisdom: <formatWisdomForPrompt()>
  External context (if gathered): <external_context>")
```
If consensus-plan is used, skip the standard Prometheus + Momus steps below and go directly to PRD generation.

**Standard path** (fewer than 3 stories or moderate complexity):
```
Task(subagent_type="agent-olympus:prometheus", model="opus",
  prompt="Team execution plan:
  - Assign tasks to workers by name
  - Define parallel vs sequential order
  - Set acceptance criteria per task
  - Define handoff protocol: when Worker A finishes X, SendMessage to Worker B
  Team design: <design>. Task: <user_request>
  External context (if gathered): <external_context>")
```

Quick validate:
```
Task(subagent_type="agent-olympus:momus", model="sonnet",
  prompt="Quick check: right worker types? clear scope boundaries? missing tasks?
  Plan: <plan>")
```

**Generate PRD** with worker assignments:
```json
{
  "projectName": "athena-<task-slug>",
  "userStories": [
    {
      "id": "US-001",
      "title": "...",
      "assignedWorker": "api-worker",
      "workerType": "claude",
      "acceptanceCriteria": ["GET /users returns 200", "POST creates user"],
      "passes": false,
      "parallelGroup": "A"
    }
  ]
}
```

**PRD QUALITY RULE**: Generic criteria are FORBIDDEN.
- ❌ "Implementation is complete" / "Works correctly"
- ✅ "GET /api/users returns 200 with User[] body"
- ✅ "Test file tests/auth.test.ts exists and all cases pass"

```
saveCheckpoint('athena', { phase: 2, prdSnapshot: <prd.json contents>, completedStories: [], activeWorkers: [], startedAt, taskDescription })
```

### Phase 2 — SPAWN TEAM

**Claude workers** (native team):
```
TeamCreate("athena-<slug>")

For each Claude worker:
  Task(team_name="athena-<slug>", name="<worker>",
    subagent_type="agent-olympus:<agentType>", model="<model>",
    prompt="You are <worker> on team athena.
    YOUR SCOPE: <files>
    YOUR TASK: <stories>
    PROTOCOL: SendMessage to <workers> when done.
    CONSTRAINT: Do NOT edit files outside your scope.")
```

**Codex workers** (via tmux, simultaneously):
```bash
tmux new-session -d -s "athena-<slug>-codex-<N>" -c "<cwd>"
tmux send-keys -t "athena-<slug>-codex-<N>" 'codex exec "<implementation prompt>"' Enter
```

**Bridge** (automatic):
```
.omc/teams/<slug>/<worker>/inbox/    — messages TO worker
.omc/teams/<slug>/<worker>/outbox/   — messages FROM worker
```

```
saveCheckpoint('athena', { phase: 3, prdSnapshot: <prd.json>, completedStories: [], activeWorkers: <spawned worker names>, startedAt, taskDescription })
```

### Phase 3 — MONITOR & COORDINATE (loop until all complete)

```
┌─→ Check TaskList for Claude worker status
│   Check tmux panes for Codex worker output
│   ├─ Claude completes something Codex needs → write to inbox
│   ├─ Codex completes something Claude needs → SendMessage to Claude worker
│   ├─ Worker blocked → unblock or escalate
│   └─ All done? → proceed to Phase 4
└── Loop (max 10 monitor iterations)
```

After checking each worker's status, record it via worker-status (import from `scripts/lib/worker-status.mjs`):
```javascript
// After each status check — call once per worker per iteration
reportWorkerStatus(teamName, workerName, phase, progressSummary)
// phase: one of planning|implementing|testing|reviewing|done|blocked|failed
// progressSummary: short free-text description of current progress
```

After the monitoring loop ends (all workers done or max iterations reached), render and output the final status table:
```javascript
const statusTable = formatStatusMarkdown(teamName)
// Output statusTable to the user so they can see per-worker phase + progress
```

After each worker completes a story: `saveCheckpoint('athena', { phase: 3, prdSnapshot: <updated prd.json>, completedStories: <all passing story IDs>, activeWorkers: <remaining in-flight workers>, startedAt, taskDescription })`

### Phase 3b — WISDOM TRACKING

After each worker completes, call `addWisdom()` with learnings:
```
addWisdom({ category: 'pattern',      lesson: '<codebase convention discovered>',      confidence: 'high' })
addWisdom({ category: 'architecture', lesson: '<structural decision or boundary note>', confidence: 'high' })
addWisdom({ category: 'debug',        lesson: '<pitfall encountered by this worker>',   confidence: 'high' })
addWisdom({ category: 'general',      lesson: '<coordination note for future teams>',   confidence: 'medium' })
```

Use appropriate category per learning:
- `'test'` / `'build'` / `'architecture'` / `'pattern'` / `'debug'` / `'performance'` / `'general'`

Wisdom persists across sessions so future runs benefit from team discoveries.

```
saveCheckpoint('athena', { phase: 4, prdSnapshot: <prd.json>, completedStories, activeWorkers: [], startedAt, taskDescription })
```

### Phase 4 — INTEGRATE & VERIFY (loop until pass)

Apply Codex outputs if needed:
```
Task(subagent_type="agent-olympus:executor", model="sonnet",
  prompt="Integrate Codex output: <codex_result>. Target files: <scope>")
```

Mark stories `passes: true` in prd.json after verifying each worker's acceptance criteria.

Run **simultaneously**: build, tests, linter.

```
┌─→ ALL PASS → Phase 5
│   ANY FAIL → spawn debugger (with wisdom learnings: formatWisdomForPrompt(queryWisdom(null,10))), fix, re-verify
│   If debugger fails 2x → escalate via Skill(skill="agent-olympus:trace")
└── Loop (max 5 fix cycles)
```

```
saveCheckpoint('athena', { phase: 5, prdSnapshot: <prd.json>, completedStories, activeWorkers: [], startedAt, taskDescription })
```

### Phase 5 — REVIEW (loop until approved)

Spawn reviewers **simultaneously**:
```
agent-olympus:architect (opus) — completeness
agent-olympus:security-reviewer (sonnet) — security
agent-olympus:code-reviewer (sonnet) — quality
```

```
┌─→ ALL APPROVED → DONE ✓
│   ANY REJECTED → fix, re-review
└── Loop (max 3 rounds)
```

### Phase 5b — SLOP CLEAN + COMMIT

After review approved:
1. Run `Skill(skill="agent-olympus:slop-cleaner")` on all changed files
2. Re-run build + tests to verify no regression
3. Run `Skill(skill="agent-olympus:git-master")` for atomic commits

### COMPLETION

Prune wisdom to prevent unbounded growth:
- Call `pruneWisdom(200)` to remove entries older than 90 days and cap at 200 most recent

Clean up:
- `clearTeamStatus(teamName)` — delete `.omc/teams/<slug>/status.jsonl` (import from `scripts/lib/worker-status.mjs`)
- `clearCheckpoint('athena')`
- TeamDelete("athena-<slug>")
- Remove `.omc/teams/<slug>/`
- Remove `.omc/state/athena-state.json`, `.omc/prd.json`
- Kill tmux sessions: `tmux kill-session -t "athena-<slug>-*"`
- Keep `.omc/wisdom.jsonl` (useful for future sessions — never delete)

Report: PRD stories (N/N), per-worker summary, files changed, coordination log, verification results.

## Team_Sizing

| Scope | Claude | Codex | Total |
|-------|--------|-------|-------|
| 2-3 files | 2 | 0 | 2 |
| 4-6 files | 2-3 | 1 | 3-4 |
| 7-15 files | 3-4 | 1 | 4-5 |
| 15+ files | 4-5 | 2 | 6-7 |

## Worker_Types

| Work | Agent | Model |
|------|-------|-------|
| API/backend | executor | sonnet |
| UI/frontend | designer | sonnet |
| Business logic | executor | sonnet/opus |
| Algorithm | **codex** | — |
| Tests | test-engineer | sonnet |
| Large refactor | **codex** | — |
| Docs | writer | haiku |
| Security-critical | executor | opus |

## Communication_Protocol

**Claude ↔ Claude**: `SendMessage(to="worker", content="...")`
**Claude → Codex**: Write to `.omc/teams/<slug>/codex-N/inbox/<timestamp>.json`
**Codex → Claude**: Lead reads tmux output, relays via SendMessage

## External_Skills

Beyond agent-olympus agents, workers can invoke ANY installed skill or plugin.
When assigning tasks, consider whether a specialized skill fits better than a generic executor.

Common examples:
- `ui-ux-pro-max:ui-ux-pro-max` — advanced UI/UX design with style presets
- `anthropic-skills:pdf` / `xlsx` / `docx` / `pptx` — document generation
- `anthropic-skills:canvas-design` — visual art and poster design
- `anthropic-skills:web-artifacts-builder` — complex React/Tailwind artifacts
- `anthropic-skills:mcp-builder` — MCP server creation
**Agent Olympus built-in skills (always available):**

> **IMPORTANT**: These are **skills**, NOT agents. Invoke them via `Skill(skill="agent-olympus:<name>")`, NOT via `Task(subagent_type=...)`. Using `Task(subagent_type=...)` will fail with "agent type not found".

- `agent-olympus:ask` — quick Codex/Gemini single-shot query
- `agent-olympus:deep-interview` — Socratic requirements clarification
- `agent-olympus:deep-dive` — 2-stage investigation pipeline for complex + ambiguous tasks (Phase 0)
- `agent-olympus:consensus-plan` — multi-perspective plan validation loop for 3+ story tasks (Phase 1)
- `agent-olympus:external-context` — facet-decomposed parallel research; enriches team context with external docs and best practices (Phase 0)
- `agent-olympus:trace` — evidence-driven root-cause analysis (use when debugger fails 2x)
- `agent-olympus:slop-cleaner` — AI bloat cleanup (use before final commit)
- `agent-olympus:git-master` — atomic commit discipline (use as final step)
- `agent-olympus:research` — parallel web research for external docs/APIs

**Recommended Athena workflow integration:**
```
Phase 0 (Design) → Skill(skill="agent-olympus:deep-dive") (if complexity=complex/architectural AND ambiguity > 40)
Phase 0 (Design) → Skill(skill="agent-olympus:external-context") (if external API/library knowledge gap detected)
Phase 1 (Plan)   → Skill(skill="agent-olympus:consensus-plan") (if 3+ stories; replaces standard Prometheus pass)
Phase 4 (Verify) → Skill(skill="agent-olympus:trace") (if integration failures persist)
Phase 5 (Review) → Skill(skill="agent-olympus:slop-cleaner") → Skill(skill="agent-olympus:git-master") → DONE
```

**Rule**: If a specialized skill exists, prefer it over a generic executor.

## Stop_Conditions

STOP only when:
- ✅ All workers complete + integrated + build passes + tests pass + reviews approved
- ❌ Same error 3 times (escalate)
- ❌ 15 iterations exceeded (escalate)
- ❌ Critical security issue (escalate)
- ❌ Workers in circular deadlock (escalate)

**NEVER stop because "it seems done" — verify EVERYTHING.**

## Comparison_With_Atlas

| | Atlas | Athena |
|---|---|---|
| Communication | Hub-and-spoke | Peer-to-peer |
| Discovery sharing | Lead relays | Workers share directly |
| Best for | Independent tasks | Interdependent tasks |
| Overhead | Lower | Higher |

</Athena_Orchestrator>
