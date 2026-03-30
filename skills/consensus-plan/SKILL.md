---
name: consensus-plan
description: Multi-perspective plan validation — Planner/Architect/Critic consensus loop before execution
level: 4
aliases: [consensus-plan, 합의계획, 컨센서스]
---

<Consensus_Plan_Skill>

## Purpose

consensus-plan produces a battle-tested PRD by running every draft plan through an independent Architect review and a Critic review before it is ever executed. The loop catches architectural anti-patterns, missing edge cases, and scope creep at the cheapest possible moment — before a single line of code is written.

## Use_When

- User invokes `/consensus-plan` or says "consensus-plan", "합의계획", "컨센서스"
- Atlas Phase 2 needs a higher-confidence plan than a single Prometheus pass delivers
- Athena needs a shared, agreed-upon PRD before dispatching workers
- Task is architectural, cross-system, or has stated non-functional requirements

## Do_Not_Use_When

- Task is trivial (single file, obvious change) — use Atlas directly
- User wants to skip planning and execute immediately
- A PRD already exists and only execution is needed

## Core_Principle

**NEVER hand off an unreviewed plan.** A plan is only finalized when both the Architect and the Critic independently issue APPROVE verdicts, or when the user explicitly overrides after a REJECT.

## Architecture

```
User Request / Pipeline Caller
        │
        ▼
Phase 1: DRAFT (Prometheus)
        │
        ▼
Phase 2: PARALLEL REVIEW
    ┌───┴───────────────┐
    ▼                   ▼
Architect            Momus
(feasibility)       (critique)
    └───┬───────────────┘
        ▼
Phase 3: CONSENSUS
    ├─ BOTH APPROVE ──────────────────→ Phase 4: FINALIZE
    ├─ EITHER REVISE (≤2 iterations) → merge feedback → Phase 2
    └─ EITHER REJECT ─────────────────→ Metis escalation → Phase 1 (new constraints)
        │
        ▼
Phase 4: FINALIZE
    - Write .ao/prd.json
    - Return markdown summary
```

## Steps

### Phase 1 — DRAFT

Task Prometheus to produce the initial plan:

```
Task(subagent_type="agent-olympus:prometheus", model="opus",
  prompt="Create a structured implementation plan for the following task.

  Task: <user_request>
  Codebase context: <analysis_results_if_available>
  Prior wisdom: <formatWisdomForPrompt() if available>
  Additional constraints: <constraints_from_prior_reject_if_any>

  Your output must include:
  1. User stories — each with a unique ID (US-001 …), a one-sentence title,
     and 2–5 concrete acceptance criteria (testable, not vague)
  2. Complexity estimate per story: S / M / L
  3. Execution order and dependency graph (which stories block which)
  4. Parallel groups — stories that can run concurrently (non-overlapping file scopes)
  5. Agent and model assignment per story (executor/designer/test-engineer, haiku/sonnet/opus)
  6. Explicit file ownership per story to prevent conflicts

  Output the plan as structured text followed by a PRD JSON block.")
```

Record the draft as `draft_plan` and `revision_count = 0`.

### Phase 2 — PARALLEL REVIEW

Spawn both reviewers simultaneously:

```
Task A — Architectural review:
Task(subagent_type="agent-olympus:architect", model="opus",
  prompt="Review the following implementation plan for architectural soundness.

  Plan: <draft_plan>
  Task context: <user_request>

  Evaluate:
  1. Technical feasibility — can each story actually be implemented as described?
  2. Architectural anti-patterns — does the plan introduce coupling, god objects,
     leaky abstractions, or other structural problems?
  3. Pattern alignment — does the plan follow the existing codebase conventions?
  4. Scalability and maintainability risks

  If a better pattern exists, name it and explain why.

  End your response with one of:
  VERDICT: APPROVE
  VERDICT: REVISE — <one-line summary of required change>
  VERDICT: REJECT  — <one-line summary of blocking reason>")

Task B — Critical review:
Task(subagent_type="agent-olympus:momus", model="opus",
  prompt="Critique the following implementation plan. Find every flaw before execution begins.

  Plan: <draft_plan>
  Task context: <user_request>

  Score each criterion 0–100. REJECT if any score < 70:
  - Clarity:      Does each story specify WHERE (file paths, function names)?
  - Verification: Are acceptance criteria concrete and measurable?
  - Context:      Is there enough context to proceed with < 10% guesswork?
  - Big Picture:  Is the purpose, background, and end-to-end workflow clear?

  Also identify:
  - Missing edge cases or error paths
  - Unchallenged assumptions that could invalidate the plan
  - Scope creep — work not required by the original task
  - Blocking issues vs. advisory notes (distinguish clearly)

  End your response with one of:
  VERDICT: APPROVE
  VERDICT: REVISE — <bullet list of required changes>
  VERDICT: REJECT  — <bullet list of blocking issues>")
```

Collect both verdicts as `architect_verdict` and `momus_verdict`.

### Phase 3 — CONSENSUS

Evaluate the combined verdicts:

#### Both APPROVE

Proceed directly to Phase 4.

#### Either REVISE

If `revision_count < 2`:

1. Merge all REVISE feedback from both reviewers into a single change list
2. Increment `revision_count`
3. Return to Phase 1, passing the merged feedback as `constraints_from_prior_reject`
4. Make clear to Prometheus which specific items must be addressed

If `revision_count >= 2`:

- Present the outstanding issues to the user
- Ask: "After 2 revision cycles the following issues remain unresolved. Do you want to override and proceed with the current plan, or provide additional guidance?"
- If user overrides → proceed to Phase 4 with current plan
- If user provides guidance → reset `revision_count = 0`, treat guidance as new constraints, return to Phase 1

#### Either REJECT

Do not revise silently. Surface the problem:

```
Task(subagent_type="agent-olympus:metis", model="opus",
  prompt="The following plan was rejected during consensus review.

  Original task: <user_request>
  Rejected plan: <draft_plan>
  Architect verdict: <architect_verdict>
  Momus verdict: <momus_verdict>

  Analyze the rejection reasons and propose revised constraints or a
  fundamentally different approach. Output:
  1. Root cause of the rejection
  2. Recommended new constraints for the planner
  3. Alternative approach if a replan is warranted")
```

Present Metis's analysis to the user. Ask: "The plan was rejected. Metis recommends: <summary>. Proceed with the revised approach, or provide your own direction?"

On user confirmation, reset `revision_count = 0` and return to Phase 1 with the new constraints.

### Phase 4 — FINALIZE

Write the approved plan to `.ao/prd.json`:

```json
{
  "projectName": "consensus-<task-slug>",
  "consensusReached": true,
  "revisionCycles": <revision_count>,
  "userStories": [
    {
      "id": "US-001",
      "title": "...",
      "complexity": "S|M|L",
      "acceptanceCriteria": ["specific", "measurable", "testable"],
      "passes": false,
      "assignTo": "claude|codex",
      "model": "opus|sonnet|haiku",
      "parallelGroup": "A",
      "ownedFiles": ["path/to/file.ts"]
    }
  ],
  "dependencyOrder": ["US-001", "US-002"],
  "architectReview": "<brief summary>",
  "mosReview": "<brief summary>"
}
```

**PRD QUALITY RULE**: Generic acceptance criteria are FORBIDDEN.

Not acceptable:
- "Implementation is complete"
- "Code works correctly"
- "Feature is functional"

Acceptable:
- "GET /api/users returns 200 with a JSON array matching the User schema"
- "parseConfig() returns default values when a key is missing from the config file"
- "tests/auth.test.ts exists and all 5 test cases pass with `npm test`"

Output a markdown summary to the user (or pipeline caller):

```
## Consensus Plan — <task-slug>

**Revision cycles:** <N>
**Stories:** <count> across <parallel-group-count> parallel groups
**Complexity distribution:** S:<n> M:<n> L:<n>

### User Stories
| ID | Title | Complexity | Group | Agent |
|----|-------|------------|-------|-------|
| US-001 | … | M | A | executor/sonnet |
…

### Architect Notes
<one short paragraph>

### Critic Notes
<one short paragraph>

PRD saved to `.ao/prd.json`. Ready for execution.
```

## Pipeline_Integration

When called from Atlas or Athena, this skill acts as a drop-in replacement for the Phase 2 PLAN step:

- **Input**: same `user_request` and `analysis_results` Atlas passes to Prometheus
- **Output**: finalized `.ao/prd.json` + markdown summary returned to the caller
- Atlas can then skip its own momus validation pass and proceed directly to Phase 3 EXECUTE

Caller pattern (Atlas Phase 2):

```
Skill(skill="agent-olympus:consensus-plan",
  args="Run consensus planning for this task.
  Task: <user_request>
  Analysis: <metis_analysis>
  Wisdom: <formatWisdomForPrompt()>")
```

## TDD Planning Hint
When consensus produces user stories with testable acceptance criteria,
mark each story with `requiresTDD: true` in the output so the calling
orchestrator (Atlas/Athena) can route implementation through /tdd.

## Limits_and_Guardrails

| Guard | Value | Behaviour on breach |
|-------|-------|---------------------|
| Max revision cycles | 2 | Pause and ask user |
| Max total phases | 10 | Escalate to user, surface last known state |
| Rejection without user input | Not allowed | Always surface to user before restarting |

## Stop_Conditions

STOP and return the finalized PRD when:
- Both reviewers issue APPROVE (or user overrides)
- `.ao/prd.json` is written and verified readable

ESCALATE to user when:
- Either reviewer issues REJECT
- Revision limit (2 cycles) is exceeded without consensus
- The same blocking issue appears in two consecutive revision cycles (likely a fundamental conflict requiring human judgement)

**NEVER produce a PRD from an unreviewed plan.**

</Consensus_Plan_Skill>
