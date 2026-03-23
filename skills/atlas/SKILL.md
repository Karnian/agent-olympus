---
name: atlas
description: Self-driving sub-agent orchestrator — analyzes, plans, executes, and loops until task is fully complete
level: 5
aliases: [atlas, 아틀라스, do-it, 알아서해, 해줘, just-do-it]
---

<Atlas_Orchestrator>

## Purpose

Atlas is the self-driving orchestrator. Give it ANY task and it will autonomously complete it using sub-agents. It never stops early — it keeps looping until every acceptance criterion is met, every test passes, and every review is approved.

You say it. Atlas finishes it. No exceptions.

## Use_When

- User says "atlas", "아틀라스", "do it", "알아서 해", "해줘", "just do it", "figure it out"
- Any task that needs autonomous completion
- User doesn't want to babysit — just wants it done

## Do_Not_Use_When

- User explicitly says "athena" or "팀으로 해" (use athena for team mode)
- User wants to co-author interactively

## Core_Principle

**NEVER STOP UNTIL DONE.** After each phase, evaluate:
- Are all acceptance criteria met? If NO → fix and re-verify
- Does the build pass? If NO → debug and fix
- Do all tests pass? If NO → debug and fix
- Is the code review clean? If NO → fix issues and re-review
- Only stop when ALL checks pass, or after 15 total iterations (then escalate to user)

## Architecture

```
User Request
    │
    ▼
Phase 0: TRIAGE ──→ trivial? ──→ EXECUTE DIRECTLY (no sub-agents needed)
    │
    ▼ (moderate+)
Phase 1: ANALYZE (metis agent)
    │
    ▼
Phase 2: PLAN (prometheus agent) ←──┐
    │                                │ REJECTED
    ▼                                │
Phase 2b: VALIDATE PLAN (momus) ────┘
    │ APPROVED
    ▼
Phase 3: EXECUTE (parallel sub-agents + Codex)
    │
    ▼
Phase 4: VERIFY (build + test + lint)
    │                    │
    │ ALL PASS           │ ANY FAIL
    ▼                    ▼
Phase 5: REVIEW ←── Fix & Retry (debugger agent)
    │                    │
    │ ALL APPROVED       │ ANY REJECTED
    ▼                    ▼
  DONE ←──────────── Fix & Re-review
```

## Steps

### Phase 0 — TRIAGE

#### Load Prior Wisdom
1. Run `migrateProgressTxt()` if `.omc/progress.txt` exists (one-time migration to wisdom.jsonl)
2. Call `queryWisdom(null, 20)` to get recent learnings
3. Inject into analysis context via `formatWisdomForPrompt()`

Classify and pick strategy. Spawn **simultaneously**:

```
Agent A (fast): Task(subagent_type="agent-olympus:explore", model="haiku",
  prompt="Scan codebase: architecture, relevant files, tech stack, test framework.
  Report as bullet points. Context: <user_request>")

Agent B (deep): Task(subagent_type="agent-olympus:metis", model="opus",
  prompt="Classify this task:
  COMPLEXITY: trivial / moderate / complex / architectural
  SCOPE: single-file / multi-file / cross-system
  NEEDS_CODEX: yes/no
  Prior learnings: <formatWisdomForPrompt()>
  Task: <user_request>")
```

**Trivial tasks**: Skip phases 1-2, execute directly (Atlas CAN implement simple things itself).
**Ambiguous tasks** (ambiguity > 60): Invoke `agent-olympus:deep-interview` to clarify before proceeding.
**Moderate+**: Full pipeline.

### Phase 1 — ANALYZE (skip for trivial)

```
Task(subagent_type="agent-olympus:metis", model="opus",
  prompt="Deep analysis: affected files, hidden requirements, risks, unknowns.
  Codebase context: <explore_results>. Task: <user_request>")
```

If `NEEDS_CODEX`, simultaneously spawn Codex via tmux:
```bash
tmux new-session -d -s "atlas-codex-analyze" -c "<cwd>"
tmux send-keys -t "atlas-codex-analyze" 'codex exec "<analysis prompt>"' Enter
```

### Phase 2 — PLAN + VALIDATE (skip for trivial)

```
Task(subagent_type="agent-olympus:prometheus", model="opus",
  prompt="Create implementation plan with:
  - Exact file paths per task
  - Agent type and model tier
  - Parallel groups (non-overlapping file scopes)
  - Concrete acceptance criteria
  - Codex assignments for algorithmic/refactoring work
  Analysis: <analysis>. Task: <user_request>")
```

Validate:
```
Task(subagent_type="agent-olympus:momus", model="opus",
  prompt="Validate plan. Score Clarity/Verification/Context/BigPicture 0-100.
  REJECT if ANY < 70. Plan: <plan>")
```

If REJECTED → feed back to prometheus, retry (max 3 rounds).

**Generate PRD** (after plan approved):
Write `.omc/prd.json` with user stories from the plan:
```json
{
  "projectName": "atlas-<task-slug>",
  "userStories": [
    {
      "id": "US-001",
      "title": "...",
      "acceptanceCriteria": ["specific", "measurable", "testable"],
      "passes": false,
      "assignTo": "claude|codex",
      "model": "opus|sonnet|haiku",
      "parallelGroup": "A"
    }
  ]
}
```

**PRD QUALITY RULE**: Generic criteria are FORBIDDEN. These are NOT acceptable:
- ❌ "Implementation is complete"
- ❌ "Code compiles without errors"
- ❌ "Works correctly"

These ARE acceptable:
- ✅ "GET /api/users returns 200 with User[] body"
- ✅ "Function parseConfig() handles missing keys by returning defaults"
- ✅ "Test file tests/auth.test.ts exists and all 5 cases pass"

### Phase 3 — EXECUTE (story-by-story)

For each story in prd.json with `passes: false`, execute and verify:

1. Group independent stories by `parallelGroup` — fire simultaneously
2. Route to the right executor:

**Claude sub-agents:**
```
Task(subagent_type="agent-olympus:executor", model="sonnet|opus", prompt="...")
Task(subagent_type="agent-olympus:designer", model="sonnet", prompt="...")
Task(subagent_type="agent-olympus:test-engineer", model="sonnet", prompt="...")
```

**Codex deep workers (via tmux):**
```bash
tmux new-session -d -s "atlas-codex-<N>" -c "<cwd>"
tmux send-keys -t "atlas-codex-<N>" 'codex exec "<implementation prompt>"' Enter
# Monitor: tmux capture-pane -pt "atlas-codex-<N>" -S -200
# Cleanup: tmux kill-session -t "atlas-codex-<N>"
```

3. After each story completes, verify its acceptance criteria with FRESH evidence
4. Mark `passes: true` in prd.json only when ALL criteria verified
5. Record learnings via wisdom calls after each story:
   ```
   addWisdom({ category: 'pattern', lesson: '<codebase convention discovered>', confidence: 'high' })
   addWisdom({ category: 'debug',   lesson: '<pitfall to avoid>',              confidence: 'high' })
   addWisdom({ category: 'build',   lesson: '<build/test learning>',           confidence: 'medium' })
   ```

**Wisdom tracking** — call `addWisdom()` after each story with appropriate category:
- `'test'` — test framework quirks, test patterns that work
- `'build'` — build tool behavior, compilation requirements
- `'architecture'` — structural decisions, module boundaries
- `'pattern'` — codebase conventions, naming, error handling
- `'debug'` — pitfalls encountered, root causes found
- `'performance'` — optimization findings
- `'general'` — anything that doesn't fit the above

Wisdom persists across iterations so later stories benefit from earlier learnings.

### Phase 4 — VERIFY (loop until pass)

Run **simultaneously**: build, tests, linter, type checker.

```
┌─→ Run all checks
│   ├─ ALL PASS → proceed to Phase 5
│   └─ ANY FAIL → spawn debugger:
│       Task(subagent_type="agent-olympus:debugger", model="sonnet",
│         prompt="Fix: <error_output>. Previous learnings: <formatWisdomForPrompt(queryWisdom(null,10))>")
│       If debugger fails 2x → escalate to agent-olympus:trace
│       Re-run checks
└── Loop (max 5 fix cycles, same error 3x = escalate)
```

### Phase 5 — REVIEW (loop until approved)

Spawn ALL reviewers **simultaneously**:
```
Task A: agent-olympus:architect (opus) — functional completeness
Task B: agent-olympus:security-reviewer (sonnet) — security
Task C: agent-olympus:code-reviewer (sonnet) — quality
```

```
┌─→ Collect verdicts
│   ├─ ALL APPROVED → DONE ✓
│   └─ ANY REJECTED → fix issues, re-review
└── Loop (max 3 review rounds)
```

### Phase 5b — SLOP CLEAN + COMMIT

After review approved:
1. Run `agent-olympus:slop-cleaner` on all changed files
2. Re-run build + tests to verify no regression from cleanup
3. Run `agent-olympus:git-master` for atomic commits

### COMPLETION

Prune wisdom to prevent unbounded growth:
- Call `pruneWisdom(200)` to remove entries older than 90 days and cap at 200 most recent

Clean up:
- Remove `.omc/state/atlas-state.json`
- Remove `.omc/prd.json`
- Kill any tmux sessions: `tmux kill-session -t "atlas-*"`
- Keep `.omc/wisdom.jsonl` (useful for future sessions — never delete)

Report to user:
- Strategy used (DIRECT/LITE/STANDARD/FULL)
- PRD stories completed (N/N)
- Files changed with descriptions
- Key decisions made
- All verification results

## Model_Selection

| Task Type | Model | Codex? |
|-----------|-------|--------|
| Trivial fix | Haiku | No |
| Standard impl | Sonnet | No |
| Complex refactor | Opus | Yes |
| Algorithm | Opus | Yes (primary) |
| Codebase scan | Haiku (explore) | No |
| Architecture | Opus | Yes (2nd opinion) |
| Tests | Sonnet | No |
| UI/UX | Sonnet (designer) | No |
| Docs | Haiku (writer) | No |

## External_Skills

Beyond agent-olympus agents, you can invoke ANY installed skill or plugin agent.
Check what's available in the session and use them when they fit better than a generic executor.

Common examples:
- `ui-ux-pro-max:ui-ux-pro-max` — advanced UI/UX design with style presets and palettes
- `anthropic-skills:pdf` — PDF reading, creation, manipulation
- `anthropic-skills:xlsx` — spreadsheet creation and editing
- `anthropic-skills:docx` — Word document generation
- `anthropic-skills:pptx` — presentation creation
- `anthropic-skills:canvas-design` — visual art and poster design
- `anthropic-skills:web-artifacts-builder` — complex React/Tailwind web artifacts
- `anthropic-skills:mcp-builder` — MCP server creation
**Agent Olympus built-in skills (always available):**
- `agent-olympus:ask` — quick Codex/Gemini single-shot query
- `agent-olympus:deep-interview` — Socratic requirements clarification
- `agent-olympus:trace` — evidence-driven root-cause analysis (use when debugger fails 2x)
- `agent-olympus:slop-cleaner` — AI bloat cleanup (use before final commit)
- `agent-olympus:git-master` — atomic commit discipline (use as final step)
- `agent-olympus:deepinit` — generate AGENTS.md codebase map (use on unfamiliar projects)
- `agent-olympus:research` — parallel web research for external docs/APIs

**Recommended Atlas workflow integration:**
```
Phase 1 (Analyze) → research (if external knowledge needed)
Phase 4 (Verify) → trace (if debugger fails 2x)
Phase 5 (Review) → slop-cleaner → git-master → DONE
```

**If oh-my-claudecode is also installed:**
- `oh-my-claudecode:ralph` — alternative persistence loop
- `oh-my-claudecode:ccg` — tri-model orchestration

**Rule**: If a specialized skill exists for the task, prefer it over a generic executor.
For example, use `anthropic-skills:xlsx` for spreadsheets instead of writing xlsx code manually.

## Stop_Conditions

STOP only when:
- ✅ All acceptance criteria met AND build passes AND tests pass AND reviews approved
- ❌ Same error 3 times (escalate to user)
- ❌ 15 total iterations exceeded (escalate to user)
- ❌ Critical security vulnerability found (escalate to user)

**NEVER stop because "it seems done" — verify EVERYTHING.**

</Atlas_Orchestrator>
