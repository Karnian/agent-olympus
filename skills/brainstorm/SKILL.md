---
name: brainstorm
description: Design-before-code with diverge-converge-refine methodology
level: 3
aliases: [brainstorm, 브레인스톰, 설계, design-first, ideate, 아이디어]
---

<Brainstorm_Skill>

## Purpose

Brainstorm forces design review before implementation for complex or architectural tasks. It runs a diverge-converge-refine cycle to generate multiple design options, evaluate them objectively, and deepen the chosen design into an actionable document. No code is written until design is approved.

## Use_When

- User says "brainstorm", "브레인스톰", "design-first", "설계"
- Task is classified as `architectural` or `complex` by triage
- User explicitly requests design-before-code review
- Design approval is a dependency for downstream execution

## Do_Not_Use_When

- Task is small (S-scale) with obvious implementation path
- Design already exists and execution is requested
- User explicitly says "skip design, just execute"

## Core_Principle

**NEVER implement before the design document is approved.**

## Architecture

```
User Request (Complex/Architectural)
        │
        ▼
Phase 1: DIVERGE
    prometheus generates >=3 design options
    NO criticism allowed
        │
        ▼
Phase 2: CONVERGE
    architect + momus evaluate all options
    in parallel, score, recommend top 1-2
        │
        ├─ All >=1 option scores >=70 ──────┐
        │                                    │
        ├─ No option qualifies ──→ return to Phase 1 with constraints (max 2 cycles)
        │                                    │
        └────────────────────────────────────┘
                                             ▼
                                    Phase 3: REFINE
                                    metis deepens chosen option
                                             │
                                             ▼
                                    Design doc produced
                                    + user approval
```

## Steps

### Phase 1 — DIVERGE

Generate multiple design options without criticism:

```
Task(subagent_type="agent-olympus:prometheus", model="opus",
  prompt="Generate >=3 distinct design options for this task.

  Task: <user_request>
  Context: <codebase_analysis>

  Requirements:
  - Generate 3+ completely different approaches (not variations)
  - Include for each option:
    • Approach summary (1-2 sentences)
    • Tradeoffs (what you gain, what you lose)
    • Rough effort estimate (hours/days)
    • Risk profile (high/medium/low)
  - Do NOT criticize any option
  - Do NOT recommend yet
  - Do NOT narrow the field

  Output: numbered options (Option A, B, C, ...) with full details for each")
```

**Gate**: >=3 distinct options generated with complete details (summary, tradeoffs, effort, risk).

### Phase 2 — CONVERGE

Evaluate all options in parallel:

```
Task A — Architectural evaluation:
Task(subagent_type="agent-olympus:architect", model="opus",
  prompt="Evaluate these design options for architectural soundness.

  Design options: <all_options_from_phase_1>
  Task context: <user_request>

  Score each option 0–100 on:
  - Feasibility: Can we actually build this?
  - Codebase alignment: Does it fit existing patterns?
  - Scalability: Will this hold up under growth?
  - Maintainability: Will future developers understand it?

  Recommend top 1-2 options.
  Output: score table + recommendation")

Task B — Critical evaluation:
Task(subagent_type="agent-olympus:momus", model="opus",
  prompt="Critique these design options. Find every flaw.

  Design options: <all_options_from_phase_1>
  Task context: <user_request>

  Score each option 0–100 on:
  - Cost: Is the effort estimate realistic?
  - Risk: What could go wrong? (be specific)
  - Edge cases: What doesn't this approach handle?
  - Dependencies: What external dependencies does this create?

  For each option: identify 2-3 hidden costs or risks.
  Output: score table + risk analysis")
```

**Gate**: At least one option scores >=70 on ALL four dimensions (feasibility, alignment, cost, risk).
If no option qualifies: return to Phase 1 with constraints (max 2 cycles).

### Phase 3 — REFINE

Deepen the chosen option into a design document:

```
Task(subagent_type="agent-olympus:metis", model="opus",
  prompt="Deepen this design option into an actionable design document.

  Chosen option: <top_ranked_option>
  Architect feedback: <architect_review>
  Critic feedback: <momus_review>

  Produce a design document with:
  1. Component diagram (ASCII or description)
  2. API contracts (signatures, inputs, outputs)
  3. Data flow (how data moves through the system)
  4. Affected files (which files will be modified/created)
  5. Migration path (if applicable, how to transition from old to new)
  6. Machine-verifiable acceptance criteria
     (specific, testable outcomes proving design was implemented correctly)

  Output: complete design document ready for approval")
```

Record the design document to `.ao/brainstorm-<slug>.md`.

**Gate**: Design document produced with all required sections.

### Present to User

```
## Design Review Complete — <task_name>

### Diverge Phase
Generated <count> design options

### Converge Phase
| Option | Feasibility | Alignment | Cost | Risk | Architect | Momus | Selected |
|--------|-------------|-----------|------|------|-----------|-------|----------|
| A | <score> | <score> | <score> | <score> | <rec> | <rec> | <check> |
| B | ...

Top option selected: **Option X**

### Design Document
Saved to: `.ao/brainstorm-<slug>.md`

**Ready for review. Approve design, request changes, or ask questions.**
```

Wait for user approval:
- "approve" / "looks good" → proceed to execution
- "changes needed" → surface specific feedback, refine Phase 3 output
- "ask questions" → clarify via AskUserQuestion, update design doc

## Output Format

```
## Brainstorm Design — <task_name>

**Status**: Design approved

### Selected Design
Option A: <summary>

### Component Diagram
<ASCII diagram or description>

### API Contracts
<function/method signatures>

### Data Flow
<description of data movement>

### Affected Files
- <file 1> (add/modify/delete)
- <file 2>

### Acceptance Criteria
- <specific, measurable outcome 1>
- <specific, measurable outcome 2>
- <specific, measurable outcome 3>

Ready for implementation.
```

## Iron Laws

1. **NEVER implement before the design document is approved.**
2. **In DIVERGE phase, NO criticism is allowed. Generate freely.**
3. **In CONVERGE phase, ALL options must be evaluated — do not silently drop any.**
4. **The chosen design must have machine-verifiable acceptance criteria before handoff to implementation.**

## Forbidden

- Implementing the first idea that comes to mind
- Evaluating options during diverge (kills creativity)
- Choosing by gut feeling without scoring
- Producing a design doc with no acceptance criteria
- Silently dropping options during converge phase
- Merging unreviewed design documents

## Integration

**Atlas Phase 1-2 (TRIAGE + PLAN):**
If task is marked `architectural` or `complex`:

```
Skill(skill="agent-olympus:brainstorm",
  args="Design-before-code for: <user_request>")
```

After brainstorm completes, read `.ao/brainstorm-<slug>.md` and use it as input to consensus-plan Phase 1 UNDERSTAND step.

**In plan/SKILL.md integration note:**
Brainstorm can be invoked as a pre-processor to plan for architectural tasks.

## Guardrails

| Guard | Value | Behaviour on breach |
|-------|-------|---------------------|
| Min options in diverge | 3 | Reject, ask for more options |
| Min score threshold | 70 on all dimensions | Retry diverge or escalate to user |
| Max diverge-converge cycles | 2 | Present options to user, ask for override/guidance |
| Design doc completeness | All 6 sections required | Reject incomplete docs, ask for refinement |

## Stop_Conditions

STOP and hand off to execution when:
- >=3 distinct options generated in Phase 1
- At least one option scores >=70 on all four evaluation dimensions (Phase 2)
- Design document written with all required sections (Phase 3)
- User explicitly approves design OR deadline reached and user confirms override

ESCALATE to user when:
- After 2 diverge-converge cycles, no option scores >=70 (suggest user revise requirements)
- Design document incomplete after Phase 3 refinement attempt
- User cannot decide between top options (facilitate trade-off discussion)

</Brainstorm_Skill>
