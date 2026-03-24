---
name: deep-dive
description: 2-stage investigation pipeline — trace analysis + requirements crystallization before execution
level: 4
aliases: [deep-dive, 딥다이브, 심층분석]
---

<Deep_Dive>

## Purpose

Deep Dive is a 2-stage investigation pipeline for tasks that are complex or ambiguous enough
that jumping straight to execution would risk wasted work or wrong answers.

Stage 1 (INVESTIGATE) runs parallel evidence lanes to form a root-cause hypothesis.
Stage 2 (CRYSTALLIZE) either sharpens that hypothesis via targeted Socratic questioning or
skips straight to synthesis when confidence is already high.

The result is a structured report — usable standalone or as a pipeline stage feeding Atlas/Athena.

## Use_When

- User says "deep-dive", "딥다이브", "심층분석"
- Task is complex AND ambiguous (unknown root cause + unclear requirements)
- Atlas/Athena detect both ambiguity > 40 AND an unclear failure mode simultaneously
- You need investigation output as structured data before handing to an orchestrator
- A previous trace or deep-interview alone wasn't enough

## Do_Not_Use_When

- Root cause is already known → use `agent-olympus:trace` directly
- Requirements are clear but just need investigation → use `agent-olympus:trace` directly
- Task is ambiguous but code is well-understood → use `agent-olympus:deep-interview` directly
- Trivial task → use Atlas directly

## Steps

### Stage 1 — INVESTIGATE

Run 3 evidence lanes **simultaneously** using `agent-olympus:debugger`.
Each lane is independent; none waits for the others.

```
Lane A — Code-level analysis:
Task(subagent_type="agent-olympus:debugger", model="sonnet",
  prompt="Code-level investigation for: <task_description>

  Your job:
  - grep for relevant symbols, function calls, and entry points
  - read affected files and trace call chains end-to-end
  - identify any logic errors, missing branches, or incorrect assumptions in the code path
  - note every file you read and every symbol you traced

  Output format:
  FINDINGS: [bullet list of concrete observations]
  EVIDENCE: [file:line references for each finding]
  CONFIDENCE: 0-100 (how well does code-level evidence explain the problem?)")

Lane B — Context analysis:
Task(subagent_type="agent-olympus:debugger", model="sonnet",
  prompt="Context investigation for: <task_description>

  Your job:
  - check git log for recent changes touching relevant files (last 20 commits)
  - identify related files, sibling modules, and transitive dependencies
  - look for environment assumptions, config values, or external constraints
  - check for version mismatches or recently changed interfaces

  Output format:
  FINDINGS: [bullet list of concrete observations]
  EVIDENCE: [file:line or git-sha references for each finding]
  CONFIDENCE: 0-100 (how well does context evidence explain the problem?)")

Lane C — Pattern analysis:
Task(subagent_type="agent-olympus:debugger", model="sonnet",
  prompt="Pattern investigation for: <task_description>

  Your job:
  - search for similar bugs or failures elsewhere in the codebase
  - identify anti-patterns, known pitfalls, or architectural smells that could cause this
  - look for repeated error handling patterns that might mask the real issue
  - check if the problem has occurred before (comments, TODOs, closed issues referenced in code)

  Output format:
  FINDINGS: [bullet list of concrete observations]
  EVIDENCE: [file:line references for each finding]
  CONFIDENCE: 0-100 (how well does pattern evidence explain the problem?)")
```

After all three lanes complete, synthesize with `agent-olympus:metis`:

```
Task(subagent_type="agent-olympus:metis", model="opus",
  prompt="Synthesize three investigation lanes into a root-cause hypothesis.

  Lane A (code-level): <lane_A_output>
  Lane B (context):    <lane_B_output>
  Lane C (pattern):    <lane_C_output>

  Produce:
  HYPOTHESIS: <one clear statement of the most likely root cause>
  SUPPORTING_EVIDENCE: [top 3-5 evidence points across all lanes]
  CONTRADICTING_EVIDENCE: [anything that doesn't fit the hypothesis]
  OPEN_QUESTIONS: [what we still don't know]
  COMPOSITE_CONFIDENCE: 0-100

  Scoring guide:
  80-100: Strong convergent evidence, minimal unknowns
  60-79:  Plausible hypothesis, some gaps remain
  40-59:  Weak evidence, significant unknowns
  0-39:   Insufficient data, hypothesis is speculative")
```

Record the synthesis as `stage1_result` (hypothesis + composite_confidence + open_questions).

### Stage 2 — CRYSTALLIZE

Branch on `composite_confidence` from Stage 1:

#### If confidence < 80 — run targeted interview

```
Task(subagent_type="agent-olympus:metis", model="opus",
  prompt="Generate targeted interview questions to resolve Stage 1 unknowns.

  Hypothesis: <stage1_result.hypothesis>
  Open questions: <stage1_result.open_questions>
  Evidence gaps: <stage1_result.contradicting_evidence>

  Produce exactly the questions (max 5) that would most raise confidence,
  ordered by impact. Each question must:
  - Be answerable by the user in one sentence
  - Offer 2-3 concrete options where possible
  - Directly address a specific open question from Stage 1

  Do NOT ask generic clarifying questions. Every question must be grounded
  in the Stage 1 evidence.")
```

Ask questions ONE AT A TIME, in impact order. After each user answer:
- Update the working hypothesis
- Reassess confidence
- If confidence crosses 80 mid-interview → stop asking, proceed to synthesis
- Maximum 5 questions regardless of confidence

#### If confidence >= 80 — skip interview, proceed directly

No questions asked. Stage 1 evidence is sufficient.

### Synthesis — produce structured report

```
Task(subagent_type="agent-olympus:metis", model="opus",
  prompt="Produce the final Deep Dive report.

  Stage 1 findings: <stage1_result>
  Interview answers (if any): <interview_transcript>

  Output a JSON object matching this schema exactly:
  {
    'problem_statement': '<1-2 sentences>',
    'root_cause': {
      'description': '<clear causal explanation>',
      'evidence': ['<evidence point 1>', '...'],
      'confidence': 0-100
    },
    'recommended_approaches': [
      {
        'rank': 1,
        'title': '<approach name>',
        'description': '<what to do and why>',
        'tradeoffs': '<benefits vs risks>',
        'effort': 'low | medium | high'
      }
    ],
    'risk_factors': ['<risk 1>', '...'],
    'affected_files': ['<path/to/file>', '...'],
    'affected_components': ['<component name>', '...'],
    'open_unknowns': ['<anything still unresolved>', '...'],
    'pipeline_ready': true
  }

  Include exactly 2-3 recommended_approaches, ranked best-first.
  Set pipeline_ready: true only if confidence >= 70 and recommended_approaches is non-empty.")
```

Save the JSON report to `.ao/deep-dive-report.json`.

### Output to user

After saving the report, format and present a markdown summary:

```markdown
## Deep Dive Report

### Problem
<problem_statement>

### Root Cause
<root_cause.description>

**Evidence:**
<root_cause.evidence as bullet list>

**Confidence:** <root_cause.confidence>%

### Recommended Approaches

**1. <approach 1 title>** _(effort: <effort>)_
<approach 1 description>
Tradeoffs: <tradeoffs>

**2. <approach 2 title>** _(effort: <effort>)_
<approach 2 description>
Tradeoffs: <tradeoffs>

### Risk Factors
<risk_factors as bullet list>

### Affected Files / Components
<affected_files and affected_components combined as bullet list>

---
_Full report saved to `.ao/deep-dive-report.json`_
```

Then ask: "Should I hand this off to Atlas for execution, or would you like to review first?"

## Pipeline_Mode

When called from Atlas or Athena as a pipeline stage (not directly by the user):

- Skip the final user-facing question
- Return `.ao/deep-dive-report.json` path and `pipeline_ready` flag as the stage result
- The calling orchestrator reads `recommended_approaches[0]` as the execution target
- If `pipeline_ready: false`, the orchestrator must escalate to the user before proceeding

Atlas invocation pattern:
```
Task(subagent_type="agent-olympus:deep-dive", model="opus",
  prompt="Run deep-dive investigation on: <task_description>
  Context from codebase scan: <explore_results>
  Return path to .ao/deep-dive-report.json when complete.")
```

## Integration_With_Atlas_Athena

Deep Dive sits between triage and execution:

```
Complex + Ambiguous Task
        │
        ▼
  Deep Dive (Stage 1: investigate → Stage 2: crystallize)
        │
        ▼
  deep-dive-report.json (pipeline_ready: true)
        │
        ▼
  Atlas/Athena executes recommended_approaches[0]
```

Atlas escalates to Deep Dive (instead of trace or deep-interview alone) when:
- Task complexity is `complex` or `architectural` AND ambiguity > 40
- A previous trace produced a hypothesis but left open unknowns that need user input
- Same failure appears in multiple unrelated areas (pattern + requirements both unclear)

</Deep_Dive>
