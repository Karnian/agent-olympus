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
  TaskList                (.ao/teams/)
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
1. Run `migrateProgressTxt()` if `.ao/progress.txt` exists (one-time migration to wisdom.jsonl)
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
  Return path to .ao/deep-dive-report.json when complete.")
```
Read `.ao/deep-dive-report.json` after completion. If `pipeline_ready: false`, escalate to user before proceeding.
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

### Phase 0.5 — SPEC GATE (Hermes validation/creation)

Before team planning, ensure a structured spec exists. Hermes acts as the quality gate between triage and execution planning.

**Check for existing spec:**
```
Does .ao/prd.json exist AND is it non-empty?
```

#### Case A: .ao/prd.json exists (user ran /plan beforehand)

Hermes validates the existing spec against the current task:
```
Task(subagent_type="agent-olympus:hermes", model="opus",
  prompt="VALIDATE this existing specification against the task and team design.

  Existing spec: <contents of .ao/prd.json>
  Task: <user_request>
  Team design: <metis_team_design>

  Check:
  1. Does the spec's problem statement match the actual task?
  2. Are user stories complete with GIVEN/WHEN/THEN acceptance criteria?
  3. Are there untestable words (robust, fast, user-friendly, seamless, efficient)?
  4. Are scope boundaries clear (goals vs non-goals)?
  5. Can stories be cleanly assigned to independent workers?

  If spec is SUFFICIENT: respond with 'VERDICT: PASS' and a one-line summary.
  If spec needs updates: respond with 'VERDICT: UPDATE' and the corrected spec
    in the same JSON format, preserving existing fields that are still valid.
  If spec is fundamentally mismatched: respond with 'VERDICT: RECREATE' and
    produce a new spec from scratch.")
```

If VERDICT is UPDATE or RECREATE → overwrite `.ao/prd.json` and `.ao/spec.md` with Hermes output.

#### Case B: .ao/prd.json does NOT exist (user skipped /plan)

Hermes creates a spec from the team design:
```
Task(subagent_type="agent-olympus:hermes", model="opus",
  prompt="Create a product specification for this task.

  Task: <user_request>
  Team design: <metis_team_design>
  External context (if gathered): <external_context>

  Produce a structured spec with:
  1. Problem Statement — WHO has this problem, WHAT is the pain, WHY now
  2. Target Users — specific personas
  3. Goals — specific, measurable objectives
  4. Non-Goals — explicitly out of scope
  5. User Stories — each with ID (US-001), JTBD format, GIVEN/WHEN/THEN acceptance criteria
  6. Success Metrics — measurable outcomes with target values
  7. Constraints — from team design analysis
  8. Risks & Unknowns — areas needing caution

  IMPORTANT: Replace untestable words (robust, fast, user-friendly, seamless,
  efficient, intuitive) with measurable alternatives.
  Ensure stories have clear boundaries so they can be assigned to independent workers.")
```

Write Hermes output to `.ao/spec.md` and `.ao/prd.json`.

#### After Spec Gate

Proceed to Phase 1 with a guaranteed spec. Prometheus now receives structured requirements, not raw user intent.

### Phase 1 — PLAN

**[OPTIONAL] Consensus Plan** — for complex tasks with 3 or more user stories, replace the standard Prometheus + Momus single pass with the consensus-plan skill for a higher-confidence PRD:
```
Skill(skill="agent-olympus:consensus-plan",
  args="Run consensus planning for this task.
  Task: <user_request>
  Analysis: <metis_team_design>
  Spec: <contents of .ao/prd.json>
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
  Spec: <contents of .ao/prd.json>
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

**Worktree isolation** (before spawning any worker):

Each worker operates in its own git worktree so parallel file changes never collide.
```javascript
import { createWorkerWorktree } from './scripts/lib/worktree.mjs';

// For each worker (Claude and Codex alike):
const { worktreePath, branchName, created } = createWorkerWorktree(cwd, teamSlug, workerName);
// worktreePath → .ao/worktrees/<slug>/<workerName>/
// branchName   → ao-worker-<slug>-<workerName>
// created: false means git worktree unavailable — fall back to cwd (still safe)
```

Track all created worktrees in the checkpoint:
```javascript
// Build the worktrees map as you spawn each worker
const worktrees = {
  "<workerName>": { path: worktreePath, branch: branchName }
};
```

**Claude workers** (native team):
```
TeamCreate("athena-<slug>")

For each Claude worker:
  1. createWorkerWorktree(cwd, "<slug>", "<worker>") → { worktreePath, branchName }
  2. Task(team_name="athena-<slug>", name="<worker>",
       subagent_type="agent-olympus:<agentType>", model="<model>",
       prompt="You are <worker> on team athena.
       YOUR SCOPE: <files>
       YOUR TASK: <stories>
       YOUR WORKTREE: <worktreePath>  (work only inside this directory)
       PROTOCOL: Commit your progress to branch <branchName> before signalling done.
                 SendMessage to <workers> when done.
       CONSTRAINT: Do NOT edit files outside your scope or worktree.
       TDD_INSTRUCTION: If your story has testable acceptance criteria, follow TDD discipline:
         write a failing test first (RED), then minimum code to pass (GREEN), then refactor.
         Do not write production code before tests.
       [OPTIONAL] For new functionality: follow /tdd discipline when implementing testable features.")
```

**Codex workers** (via tmux, simultaneously):
```bash
# Start session rooted at the worker's worktree path
tmux new-session -d -s "athena-<slug>-codex-<N>" -c "<worktreePath>"
tmux send-keys -t "athena-<slug>-codex-<N>" 'codex exec "<implementation prompt>"' Enter
```

Workers must commit their changes to their branch before signalling completion.

**Bridge** (automatic):
```
.ao/teams/<slug>/<worker>/inbox/    — messages TO worker
.ao/teams/<slug>/<worker>/outbox/   — messages FROM worker
```

```
saveCheckpoint('athena', {
  phase: 3,
  prdSnapshot: <prd.json>,
  completedStories: [],
  activeWorkers: <spawned worker names>,
  worktrees: { "<workerName>": { path: worktreePath, branch: branchName }, ... },
  startedAt,
  taskDescription
})
```

### Phase 3 — MONITOR & COORDINATE (loop until all complete)

```
┌─→ Check TaskList for Claude worker status
│   Check tmux panes for Codex worker output
│   ├─ Claude completes something Codex needs → write to inbox
│   ├─ Codex completes something Claude needs → SendMessage to Claude worker
│   ├─ Codex worker fails (auth/rate-limit/crash) → reassign to Claude executor
│   ├─ Worker blocked → unblock or escalate
│   └─ All done? → proceed to Phase 4
└── Loop (max 10 monitor iterations)
```

**Codex failure detection and Claude fallback:**

During each monitoring iteration, for every active Codex worker, pass its pane output to `detectCodexError()` (from `scripts/lib/worker-spawn.mjs`):

```javascript
import { detectCodexError, reassignToClaude } from './scripts/lib/worker-spawn.mjs';
import { reportWorkerStatus } from './scripts/lib/worker-status.mjs';

// Inside the monitoring loop, for each Codex worker:
const paneOutput = capturePane(codexSession, 200);
const errorCheck = detectCodexError(paneOutput);

if (errorCheck.failed) {
  // Update status dashboard immediately
  reportWorkerStatus(teamName, workerName, 'failed', `Codex error: ${errorCheck.reason}`);

  // Kill tmux session and record wisdom.
  // Pass the session name explicitly to avoid the default sessionName() mismatch
  // (athena uses 'athena-<slug>-codex-N' directly, not 'omc-team-athena-...-codex-N').
  const fallback = await reassignToClaude(teamName, workerName, originalPrompt, errorCheck.reason, codexSession);

  // Report the reassignment so the status table shows the transition
  reportWorkerStatus(teamName, workerName, 'implementing', `Codex → Claude: ${errorCheck.reason}`);

  // Spawn Claude replacement with the same prompt
  Task(subagent_type="agent-olympus:executor", model="sonnet",
    prompt=`${fallback.prompt}`)
}
```

Rules:
- If `errorCheck.reason` is `'auth_failed'`, `'rate_limited'`, or `'not_installed'`, do NOT retry Codex for that error type again for any worker in this session.
- If `errorCheck.reason` is `'crash'`, retry Codex once; if it crashes again, fall back to Claude.
- Always call `await reassignToClaude()` before spawning the replacement — it handles tmux cleanup and wisdom recording in one step.

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

**Merge worker branches** (sequential, dependency order first):
```javascript
import { mergeWorkerBranch, removeWorkerWorktree } from './scripts/lib/worktree.mjs';

// Sort workers by dependency order (dependents last)
const orderedWorkers = sortByDependency(completedWorkers);

for (const worker of orderedWorkers) {
  const { branch, path } = checkpoint.worktrees[worker.name] ?? {};
  if (!branch) continue;  // worktree was not created (fallback mode)

  const result = mergeWorkerBranch(cwd, branch, worker.name);
  if (!result.success) {
    // Conflict detected — spawn executor to resolve
    Task(subagent_type="agent-olympus:executor", model="sonnet",
      prompt="Resolve merge conflicts for worker <worker.name>.
      Conflicting files: <result.conflicts.join(', ')>
      Worker branch: <branch>
      Resolve all conflicts and commit the resolution.")
  }

  // After successful merge, remove the worktree
  removeWorkerWorktree(cwd, path, branch);
}
```

Apply any remaining Codex outputs if needed:
```
Task(subagent_type="agent-olympus:executor", model="sonnet",
  prompt="Integrate Codex output: <codex_result>. Target files: <scope>")
```

Mark stories `passes: true` in prd.json after verifying each worker's acceptance criteria.

Run **simultaneously**: build, tests, linter.

**[OPTIONAL] Quality Gate Checkpoint** — after all workers complete and before final review:
If `agent-olympus:themis` agent is available:
```
Task(subagent_type="agent-olympus:themis", model="sonnet",
  prompt="Run quality gate checks on integration output.")
```
- FAIL → debug and retry (max 2 retry cycles); debug path follows the 4-step escalation chain above
- CONDITIONAL → log, proceed
- PASS → proceed to Phase 5
Note: Skip this checkpoint if quality-gate agent is absent.

```
┌─→ ALL PASS → Phase 5
│   ANY FAIL → spawn debugger (with wisdom learnings: formatWisdomForPrompt(queryWisdom(null,10))), fix, re-verify
│   Debug escalation chain:
│     1. First attempt: spawn debugger agent
│     2. Debugger fails once: spawn debugger again with additional context from wisdom
│     3. Debugger fails twice: invoke Skill(skill="agent-olympus:systematic-debug")
│        for root-cause-first investigation
│     4. systematic-debug fails: escalate via Skill(skill="agent-olympus:trace")
│        for evidence-driven hypothesis analysis
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
4. **Optional branch completion**: invoke `Skill(skill="agent-olympus:finish-branch")` for a full
   pre-merge checklist (tests re-run, lint, coverage, code review, merge option presentation).
   Use when the task represents a complete feature branch ready for integration.

### COMPLETION

Prune wisdom to prevent unbounded growth:
- Call `pruneWisdom(200)` to remove entries older than 90 days and cap at 200 most recent

Clean up:
- `clearTeamStatus(teamName)` — delete `.ao/teams/<slug>/status.jsonl` (import from `scripts/lib/worker-status.mjs`)
- `clearCheckpoint('athena')`
- TeamDelete("athena-<slug>")
- Remove `.ao/teams/<slug>/`
- Remove `.ao/state/athena-state.json`, `.ao/prd.json`
- Kill tmux sessions: `tmux kill-session -t "athena-<slug>-*"`
- Clean up any remaining worktrees:
  ```javascript
  import { cleanupTeamWorktrees } from './scripts/lib/worktree.mjs';
  cleanupTeamWorktrees(cwd, teamSlug);  // removes .ao/worktrees/<slug>/ and branches
  ```
- Keep `.ao/wisdom.jsonl` (useful for future sessions — never delete)

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
**Claude → Codex**: Write to `.ao/teams/<slug>/codex-N/inbox/<timestamp>.json`
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
- `agent-olympus:systematic-debug` — root-cause-first debugging (use when debugger fails 2x)
- `agent-olympus:trace` — evidence-driven hypothesis analysis (use when systematic-debug also fails)
- `agent-olympus:slop-cleaner` — AI bloat cleanup (use before final commit)
- `agent-olympus:git-master` — atomic commit discipline (use as final step)
- `agent-olympus:research` — parallel web research for external docs/APIs

**Recommended Athena workflow integration:**
```
Phase 0 (Design) → Skill(skill="agent-olympus:deep-dive") (if complexity=complex/architectural AND ambiguity > 40)
Phase 0 (Design) → Skill(skill="agent-olympus:external-context") (if external API/library knowledge gap detected)
Phase 1 (Plan)   → Skill(skill="agent-olympus:consensus-plan") (if 3+ stories; replaces standard Prometheus pass)
Phase 4 (Verify) → Skill(skill="agent-olympus:systematic-debug") (if debugger fails 2x); Skill(skill="agent-olympus:trace") (if systematic-debug also fails)
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
