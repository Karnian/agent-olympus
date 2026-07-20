---
name: consensus-plan
description: Multi-perspective plan validation — Planner/Architect/Critic consensus loop before execution
---

<Consensus_Plan_Skill>

## Purpose

consensus-plan produces a reviewed **execution-assignment plan** for an existing
typed AO_SPEC PRD. It runs every draft through independent Architect and Momus
review before returning assignments to Atlas or Athena. The caller remains the
sole owner of `.ao/prd.json` and applies the result through the hardened
execution-PRD enrichment store.

## Use_When

- User invokes `/consensus-plan` or says "consensus-plan", "합의계획", "컨센서스"
- Atlas Phase 2 needs a higher-confidence plan than a single Prometheus pass delivers
- Athena needs a shared, agreed-upon PRD before dispatching workers
- Task is architectural, cross-system, or has stated non-functional requirements
- A valid AO_SPEC planning PRD already exists and its generation is supplied by
  `readPlanningPrdForExecution()`

## Do_Not_Use_When

- Task is trivial (single file, obvious change) — use Atlas directly
- User wants to skip planning and execute immediately
- No valid typed planning PRD exists — run `/plan` (or the orchestrator Spec
  Gate) first; this skill must not create a replacement schema

## Core_Principle

**NEVER hand off an unreviewed plan.** A plan is finalized only when both the
Architect and Momus independently approve it, or when the user explicitly
overrides after a rejection. The skill MUST NOT write, replace, rename, or
delete `.ao/prd.json` or `.ao/spec.md`.

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
    - Return AO_CONSENSUS_ASSIGNMENT_PLAN_V1
    - Optionally archive that assignment-only envelope
    - Caller validates, merges, and CAS-persists it
```

## Steps

### Phase 1 — DRAFT

Task Prometheus to produce the initial plan:

```
Task(subagent_type="agent-olympus:prometheus", model="opus",
  prompt="Create a structured implementation plan for the following task.

  Orchestrator: <atlas|athena>
  Source PRD generation: <64-character generation from readPlanningPrdForExecution>
  Available providers: Claude=true, Codex=<true|false>, Gemini=<true|false>
  Task: <user_request>
  Typed AO_SPEC PRD (requirements and story IDs are immutable): <planning_prd>
  Codebase context: <analysis_results_if_available>
  Prior wisdom: <formatWisdomForPrompt() if available>
  Additional constraints: <constraints_from_prior_reject_if_any>

  Your output must include:
  1. User stories — each with a unique ID (US-001 …), a one-sentence title,
     and 2–5 concrete acceptance criteria (testable, not vague)
  2. Complexity estimate per story: S / M / L
  3. Execution order and dependency graph (which stories block which)
  4. Parallel groups — stories that can run concurrently (non-overlapping file scopes)
  5. Provider, agent, and model assignment per story, using only providers
     reported available above
  6. Explicit file ownership per story to prevent conflicts

  Preserve the AO_SPEC story IDs and order. Do not rewrite requirements and do
  not write any file. Produce an assignment-plan draft for review.")
```

Record the draft as `draft_plan` and `revision_count = 0`.

### Phase 2 — PARALLEL REVIEW

Before spawning the architect, optionally resolve a diff-scope hint to
constrain the architect's Glob/Grep/Read. Fail-safe: if the resolver
returns `apply: false`, no hint is injected and the architect scans freely.

```javascript
import { loadAutonomyConfig } from './scripts/lib/autonomy.mjs';
import { resolveArchitectScope, formatScopeHint } from './scripts/lib/architect-scope.mjs';

const _autonomy = loadAutonomyConfig(process.cwd());
const _scope = resolveArchitectScope({ autonomyConfig: _autonomy, cwd: process.cwd() });
const _scopeHint = formatScopeHint(_scope);  // empty string when apply=false
// Log only when an actual narrowing happened.
if (_scope.apply) {
  Output: "[Consensus] architect diff-scope enabled — " + _scope.reason;
} else if (_scope.sharedLibDetected) {
  Output: "[Consensus] architect using full context — " + _scope.reason;
}
```

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
  VERDICT: REJECT  — <one-line summary of blocking reason>"
  + _scopeHint)

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

Return exactly one JSON object with no Markdown fence or surrounding prose.
This is an assignment-only handoff; it is not a PRD replacement:

```json
{
  "schemaVersion": 1,
  "contract": "AO_CONSENSUS_ASSIGNMENT_PLAN_V1",
  "verdict": "APPROVE",
  "approvalBasis": "reviewers",
  "orchestrator": "atlas",
  "sourcePrdGeneration": "<copy the supplied 64-character generation exactly>",
  "revisionCycles": <revision_count>,
  "summary": "one concise assignment-plan summary",
  "assignments": [
    {
      "storyId": "US-001",
      "parallelGroup": "A",
      "scope": ["path/to/file.ts"],
      "dependsOn": [],
      "requiresTDD": true,
      "assignTo": "claude",
      "model": "sonnet",
      "agentType": "executor"
    }
  ]
}
```

Set `orchestrator` to the caller-supplied value. Set `approvalBasis` to
`reviewers` only when both reviewers approved; use `user-override` only after an
explicit user override. The envelope must contain every existing PRD story once,
in the same order, and must copy `sourcePrdGeneration` exactly.

Assignment fields are deliberately different by orchestrator:

- **Atlas**: `storyId`, `parallelGroup`, `scope`, optional `dependsOn` and
  `requiresTDD`, plus `assignTo` and a Claude model-tier hint (`model`) for
  every provider. `agentType` is required for Claude and must be omitted for
  Codex/Gemini.
- **Athena**: the common fields plus `assignedWorker`, `workerType`, optional
  Claude `model`, and `agentType` for Claude only. External workers omit both
  `model` and `agentType`.

Allowed Claude execution roles are `executor`, `designer`, `test-engineer`,
`debugger`, `hephaestus`, and `writer`. Never assign a provider reported
unavailable. Never include `projectName`, requirements, titles, acceptance
criteria, `passes`, review prose, or any other PRD field in an assignment item.

The caller parses and applies the envelope through the checked bridge below:

```javascript
import {
  buildConsensusExecutionPrd,
  parseConsensusAssignmentPlan,
} from './scripts/lib/consensus-assignment-plan.mjs';
import { enrichExecutionPrd } from './scripts/lib/execution-prd-store.mjs';
import { writeOutbox } from './scripts/lib/artifact-pipe.mjs';

const assignmentPlan = parseConsensusAssignmentPlan(<raw skill output>, {
  orchestrator: '<atlas|athena>',
});
const executionCandidate = buildConsensusExecutionPrd(
  planningPrdState.prd,
  assignmentPlan,
  {
    orchestrator: '<atlas|athena>',
    sourcePrdGeneration: planningPrdState.generation,
    hasCodex,
    hasGemini: hasGeminiCli,
  },
);

// Archival only. Never reload this best-effort pipe artifact as authority.
await writeOutbox(
  runId,
  'plan',
  'consensus-assignment-plan.json',
  assignmentPlan,
);

const plannedPrdState = enrichExecutionPrd(executionCandidate, {
  cwd,
  orchestrator: '<atlas|athena>',
  expectedGeneration: planningPrdState.generation,
});
```

`buildConsensusExecutionPrd()` rejects unknown fields, stale generations,
missing/reordered stories, unavailable providers, invalid scope ownership, and
orchestrator-specific assignment errors. `enrichExecutionPrd()` remains the
only authoritative writer and proves that non-assignment AO_SPEC content did
not change.

## Pipeline_Integration

When called from Atlas or Athena, this skill replaces only the Prometheus +
Momus assignment-planning pass:

- **Input**: orchestrator name, provider capabilities, immutable typed PRD and
  generation, user request, and analysis context
- **Output**: one validated `AO_CONSENSUS_ASSIGNMENT_PLAN_V1` envelope
- **Persistence**: optional archival pipe copy only; the caller merges and
  persists through `enrichExecutionPrd()` before execution

Caller pattern (Atlas Phase 2):

```
consensus_raw = Skill(skill="agent-olympus:consensus-plan",
  args="Run consensus planning for this task.
  OUTPUT_CONTRACT: AO_CONSENSUS_ASSIGNMENT_PLAN_V1
  Orchestrator: atlas
  Source PRD generation: <planningPrdState.generation>
  Available providers: Claude=true, Codex=<hasCodex>, Gemini=<hasGeminiCli>
  Task: <user_request>
  Spec: <planningPrdState.prd>
  Analysis: <metis_analysis>
  Wisdom: <formatWisdomForPrompt()>")
```

## TDD Planning Hint
When an existing story should use TDD, set `requiresTDD: true` on its assignment.
Never create a new story or rewrite acceptance criteria here.

## Limits_and_Guardrails

| Guard | Value | Behaviour on breach |
|-------|-------|---------------------|
| Max revision cycles | 2 | Pause and ask user |
| Max total phases | 10 | Escalate to user, surface last known state |
| Rejection without user input | Not allowed | Always surface to user before restarting |

## Stop_Conditions

STOP and return the assignment envelope when:
- Both reviewers issue APPROVE (or user overrides)
- The envelope satisfies `AO_CONSENSUS_ASSIGNMENT_PLAN_V1`

ESCALATE to user when:
- Either reviewer issues REJECT
- Revision limit (2 cycles) is exceeded without consensus
- The same blocking issue appears in two consecutive revision cycles (likely a fundamental conflict requiring human judgement)

**NEVER produce assignments from an unreviewed plan, and NEVER write the
authoritative PRD from this skill.**

</Consensus_Plan_Skill>
