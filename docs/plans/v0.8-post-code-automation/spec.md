# v0.8 — Post-Code Automation & "해줘" Gap Closure

> **Vision**: "해줘" means the user says what they want and walks away. Atlas/Athena handle everything — from understanding the request to closing the issue. Current coverage stops at commit. This spec extends the loop to cover the full developer workflow.

**Scale**: L (cross-cutting, multi-skill, multi-phase changes)
**Mode**: forward (concept → spec)
**Status**: draft
**Created**: 2026-03-30
**Last Updated**: 2026-03-30

---

## Problem Statement

**WHO**: Developers using Atlas/Athena orchestrators
**WHAT**: After autonomous code completion (build passes, tests pass, review approved, committed), the workflow drops the user back into manual mode for PR creation, CI monitoring, issue management, docs updates, and notifications.
**WHY NOW**: The core orchestration loop (v0.1–v0.7) is stable with 295+ tests. The next bottleneck in "just do it" autonomy is post-code automation.

---

## Current Coverage vs Full "해줘" Scope

```
Request → Analyze → Plan → Execute → Test → Review → Commit → [GAP] → PR → CI → Deploy → Issue Close → Notify
          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
          v0.1–v0.7 covers this                                   v0.8 targets this →→→→→→→→→→→→→→→→→→→→→
```

---

## Category A: Post-Code Automation

### A1. PR Auto-Creation (Priority: HIGH)

**Gap**: git-master commits atomically, finish-branch runs pre-merge checklist, but neither creates a PR.

**Proposal**: New skill `pr-ship` or extend `finish-branch` to:
1. Detect current branch vs base branch
2. Generate PR title from commit messages (conventional commit aware)
3. Generate PR body from `.ao/prd.json` user stories + acceptance criteria
4. Add labels based on change type (feature/fix/refactor/docs)
5. Link related issues (parse `#123` from commits and PRD)
6. Create PR via `gh pr create`
7. Optionally request reviewers

**Acceptance Criteria**:
- GIVEN a completed Atlas/Athena run on a feature branch
- WHEN Phase 5b completes (slop-clean + git-master)
- THEN a PR is created with structured description, linked issues, and appropriate labels
- AND the PR URL is reported to the user

**Integration Point**: Atlas Phase 5b / Athena Phase 5b, after git-master, before COMPLETION.

**Implementation Notes**:
- `gh` CLI is widely available and handles auth
- PR body template should include: Summary (from PRD), Changes (from git diff --stat), Stories Completed (from prd.json), Test Results (from Phase 4)
- Consider a `--draft` flag for WIP PRs

---

### A2. CI Monitor & Auto-Fix Loop (Priority: HIGH)

**Gap**: After PR is created, CI may fail. Currently the user must detect this, come back, and ask for help.

**Proposal**: New skill `ci-watch` or extend `pr-ship`:
1. After PR creation, run `gh run watch` or poll `gh run list`
2. If CI passes → report success, done
3. If CI fails → fetch logs via `gh run view --log-failed`
4. Diagnose failure (test failure vs build failure vs lint vs type check)
5. Fix using existing debug escalation chain (debugger → systematic-debug → trace)
6. Push fix, wait for CI again
7. Max 3 CI fix cycles, then escalate

**Acceptance Criteria**:
- GIVEN a PR with failing CI
- WHEN the CI failure is detected
- THEN the orchestrator fetches CI logs, diagnoses the issue, pushes a fix
- AND loops until CI passes (max 3 attempts) or escalates

**Integration Point**: After PR creation in A1. Optional — can be skipped with `--no-ci-watch` flag.

---

### A3. Issue Tracker Integration (Priority: MEDIUM)

**Gap**: No connection between work and issue trackers. User manually closes issues.

**Proposal**: New skill `issue-link` or hook:
1. Parse issue references from: user request, commit messages, branch name (e.g., `feat/123-add-auth`)
2. On PR creation: add `Closes #123` to PR body
3. On completion: post comment to issue summarizing what was done
4. Support GitHub Issues natively via `gh`
5. Extensible for Linear/Jira via MCP servers (future)

**Acceptance Criteria**:
- GIVEN user says "해줘 #42" or works on branch `fix/42-broken-login`
- WHEN PR is created
- THEN PR body includes `Closes #42`
- AND a summary comment is posted to issue #42

---

### A4. Documentation Auto-Update (Priority: MEDIUM)

**Gap**: Code changes but docs stay stale. README, API docs, CHANGELOG not updated.

**Proposal**: Add a docs-check step to Phase 5b:
1. Detect if changed files affect public API, config, or CLI
2. If yes → spawn writer agent to update relevant docs
3. Auto-add CHANGELOG entry from PRD summary
4. Re-run build to verify docs don't break anything

**Acceptance Criteria**:
- GIVEN a feature that changes public API signatures
- WHEN Phase 5b runs
- THEN relevant documentation files are updated
- AND a CHANGELOG entry is added

**Integration Point**: Phase 5b, after slop-cleaner, before git-master.

---

## Category B: User Communication

### B1. Desktop Notifications (Priority: HIGH)

**Gap**: Long-running orchestrations (10-30min) give no signal when done or blocked.

**Proposal**: Hook-based notification system:
1. `osascript -e 'display notification ...'` on macOS
2. `notify-send` on Linux
3. Trigger on: task complete, task blocked (needs user input), error escalation
4. Implemented as a post-hook on orchestrator completion, or via the existing Stop hook pattern

**Acceptance Criteria**:
- GIVEN an Atlas/Athena run that takes >2 minutes
- WHEN the run completes or hits a blocker
- THEN a desktop notification is shown with status summary

**Implementation Notes**:
- Could be a simple script in `scripts/notify.mjs`
- Detect OS via `process.platform`
- Fail-safe: notification failure never blocks the orchestrator

---

### B2. Progress Briefing (Priority: LOW)

**Gap**: During long runs, user has no visibility into what's happening.

**Proposal**: Periodic status output during Phase 3 (execute) and Phase 4 (verify):
- worker-status already tracks per-worker phase and progress
- Add a periodic summary output (every 2-3 minutes) showing: workers active, stories completed, current phase
- Format as a compact markdown table

**Implementation Notes**:
- Atlas/Athena already call `formatStatusMarkdown()` at monitoring loop end
- Could output intermediate summaries during the monitoring loop itself

---

### B3. Cost Awareness (Priority: LOW)

**Gap**: No visibility into token usage or estimated cost of an orchestration run.

**Proposal**:
1. Estimate token cost per agent spawn based on model tier
2. Show cumulative estimate at plan approval (Phase 2): "This plan will spawn ~8 agents, estimated ~500K tokens (~$X)"
3. Optional budget guard: if estimated cost exceeds threshold, ask user before proceeding

**Implementation Notes**:
- Rough heuristics: opus ~$15/M input, sonnet ~$3/M, haiku ~$0.25/M
- Precision not needed — order-of-magnitude awareness is the goal
- Could be a field in the PRD output

---

## Category C: Context Intelligence

### C1. Auto Project Onboarding (Priority: HIGH)

**Gap**: On unfamiliar projects, Atlas/Athena don't automatically orient themselves.

**Proposal**: In Phase 0 (Triage), add a pre-step:
1. Check if `AGENTS.md` exists in the project root
2. If not → auto-invoke `Skill(skill="agent-olympus:deepinit")` to generate it
3. Feed the generated AGENTS.md into metis analysis context
4. This only runs once per project (AGENTS.md persists)

**Acceptance Criteria**:
- GIVEN a project without AGENTS.md
- WHEN Atlas/Athena Phase 0 starts
- THEN deepinit runs automatically and AGENTS.md is created
- AND subsequent analysis uses this context

---

### C2. Visual Verification (Priority: MEDIUM)

**Gap**: Tests pass but UI may be broken. No visual regression detection.

**Proposal**: Optional Phase 4.5 step for UI-related changes:
1. Detect if changed files are in frontend/UI directories
2. Start preview server via Claude Preview MCP
3. Take screenshots of affected pages
4. Compare against expectations (either from user description or prior screenshots)
5. If visual issues found → spawn designer agent to fix

**Acceptance Criteria**:
- GIVEN a change to React/Vue/HTML files
- WHEN Phase 4 verification runs
- THEN a preview server is started and key pages are screenshotted
- AND visual issues are flagged or fixed

**Implementation Notes**:
- Depends on Claude Preview MCP being available
- `.claude/launch.json` must exist for the project
- Fail-safe: skip silently if preview server can't start

---

### C3. Semantic Memory (Priority: LOW — Future)

**Gap**: wisdom.jsonl is append-only JSONL with category filtering. No semantic search.

**Proposal**: Long-term exploration:
1. Embed wisdom entries with a lightweight model
2. Store embeddings alongside JSONL entries
3. Query by semantic similarity instead of just category
4. Cross-project wisdom sharing

**Notes**: This is a v0.9+ consideration. Current wisdom system works well for single-project context. Semantic search becomes valuable when wisdom grows beyond 200 entries or spans multiple projects.

---

## Proposed Phase Additions to Atlas/Athena

### Current Flow:
```
Phase 0: Triage → Phase 1: Analyze → Phase 1.5: Spec → Phase 2: Plan →
Phase 3: Execute → Phase 4: Verify → Phase 4.5: Quality Gate →
Phase 5: Review → Phase 5b: Slop Clean + Commit → COMPLETION
```

### Proposed v0.8 Flow:
```
Phase 0: Triage (+ C1: auto-onboarding) →
Phase 1: Analyze → Phase 1.5: Spec → Phase 2: Plan (+ B3: cost estimate) →
Phase 3: Execute (+ B2: progress briefing) →
Phase 4: Verify (+ C2: visual verification) → Phase 4.5: Quality Gate →
Phase 5: Review → Phase 5b: Slop Clean + Commit →
Phase 5c: Docs Update (A4) →
Phase 6: Ship (A1: PR create + A3: issue link) →
Phase 6b: CI Watch (A2: monitor + auto-fix) →
COMPLETION (+ B1: desktop notification)
```

---

## Implementation Priority

| ID | Feature | Priority | Effort | Depends On |
|----|---------|----------|--------|------------|
| A1 | PR Auto-Creation | HIGH | S | git-master, finish-branch |
| A2 | CI Monitor & Auto-Fix | HIGH | M | A1 |
| B1 | Desktop Notifications | HIGH | S | None |
| C1 | Auto Project Onboarding | HIGH | S | deepinit skill |
| A3 | Issue Tracker Integration | MEDIUM | S | A1 |
| A4 | Documentation Auto-Update | MEDIUM | M | writer agent |
| C2 | Visual Verification | MEDIUM | M | Claude Preview MCP |
| B2 | Progress Briefing | LOW | S | worker-status lib |
| B3 | Cost Awareness | LOW | S | None |
| C3 | Semantic Memory | LOW | L | Future (v0.9+) |

**Recommended implementation order**: C1 → B1 → A1 → A2 → A3 → A4 → C2 → B2 → B3

---

## External Ecosystem References

Plugins/patterns that informed this analysis:
- **Happy Coder** — phone push notifications + remote approval for long-running tasks
- **CC Notify** — desktop notification hooks for Claude Code
- **Ralph Loop** — autonomous restart with intelligent exit detection
- **Trail of Bits Security Skills** — CodeQL/Semgrep integration (beyond pure LLM review)
- **Claude Squad** — multi-agent terminal UI dashboard
- **Container Use** — Docker isolation for safe parallel execution
- **Compound Engineering Plugin** — mistake-to-lesson pipeline
- **Claude-Mem** — cross-session long-term memory
- **Ruflo** — vector-based multi-layered memory for agent swarms

---

## Non-Goals for v0.8

- Deployment automation (CD) — too environment-specific, out of scope
- Multi-repo orchestration — complex, defer to v0.9+
- Ralph-style autonomous restart — requires external process manager, not a plugin concern
- Voice input integration — available via existing MCP servers
- Cost billing/metering — awareness only, not enforcement
