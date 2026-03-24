---
name: plan
description: Adaptive product planner — forward (idea→spec) and reverse (code→spec) planning across any scale
level: 4
aliases: [plan, 기획, 기획서, spec, PRD, 스펙, product-plan, feature-spec, 기획분석, reverse-plan, analyze-spec]
---

<Plan_Skill>

## Purpose

Plan operates in two modes:

**Forward mode** (default): Takes a vague idea and produces an executable specification before any code is written.
Implements Spec-Driven Development (SDD): specifications are the contract between human intent and AI execution.

**Reverse mode**: Analyzes existing code, products, or systems and extracts the implicit specification —
what was built, why, how it works, and where the gaps are. Produces the same structured spec format
as forward mode, enabling seamless handoff to improvement/refactoring workflows.

The key insight: planning depth adapts to project scale.
A one-line feature doesn't need a 50-page PRD.
A new system requires comprehensive specification.

## Use_When

**Forward mode:**
- User says "plan", "기획", "기획서", "spec", "PRD", "스펙", "product-plan", "feature-spec"
- Request is a vague idea: "add authentication", "redesign checkout", "build recommendation engine"
- Atlas/Athena detect ambiguity during triage and escalate to Plan
- User needs an executable spec before handoff to Atlas/Athena

**Reverse mode:**
- User says "기획분석", "reverse-plan", "analyze-spec", "analyze this project", "이 코드 분석해줘"
- User points at an existing codebase, repo, or directory and asks to understand/document it
- User wants a spec extracted before refactoring or improving an existing system
- User wants to understand an undocumented legacy project

## Do_Not_Use_When

- Requirements are already formalized in a PRD
- Requirement is trivial and implementation is obvious
- User explicitly says "just execute" (use Atlas directly instead)

## Core_Principle

**NEVER execute without a spec.** A spec is finalized when all mandatory sections have content
and either the user approves it or explicitly skips review.

## Architecture

```
User Request / Atlas Triage
        │
        ▼
Phase 0: SCALE DETECTION (Hermes)
        │
        ▼
Phase 1: UNDERSTAND (Hermes)
    Draft spec with problem, goals, stories, open questions
        │
        ├─────────────────────────────────┐
        ▼                                  ▼
    S-scale                          M/L-scale
    (Skip to Phase 4)               (Continue to Phase 2)
        │                                  │
        └──────────────────┬───────────────┘
                           ▼
                    Phase 2: CLARIFY (optional)
                    Ask user questions or invoke deep-interview
                           │
                           ▼
                    Phase 3: REFINE (optional)
                    Review with momus (M-scale) or consensus-plan (L-scale)
                           │
                           ▼
                    Phase 4: FINALIZE
                    Write .ao/spec.md and .ao/prd.json
                           │
                           ▼
                    Ready for execution (Atlas/Athena)
```

## Steps

### Phase 0 — SCALE DETECTION

Analyze the request to determine planning depth:

```
Task(subagent_type="agent-olympus:hermes", model="haiku",
  prompt="Determine the SCALE of this request. Reply with ONLY one of: S, M, or L.

  S = Single file, one feature, obvious implementation
      Examples: 'fix typo', 'add a button', 'bump version', 'rename function'

  M = Multi-file feature, new API endpoint, component system
      Examples: 'add user authentication', 'implement checkout flow', 'new API endpoint'

  L = New system, major refactor, multi-service, architectural
      Examples: 'build recommendation engine', 'migrate to microservices', 'redesign database'

  Request: <user_request>")
```

Record the scale as `detected_scale`.

### Phase 1 — UNDERSTAND

Use hermes to produce an initial spec:

```
Task(subagent_type="agent-olympus:hermes", model="opus",
  prompt="Create an initial product specification for this request.

  Request: <user_request>
  Scale: <detected_scale>
  Codebase context: <analysis_of_relevant_files_if_applicable>

  Produce a structured spec with these sections:
  1. Problem Statement — WHO has this problem, WHAT is the pain, WHY now
  2. Target Users — specific personas, not just 'users'
  3. Appetite — how much time/effort to invest (S=hours, M=days, L=weeks)
  4. Goals — specific, measurable objectives (bullet list)
  5. Non-Goals — explicitly out of scope
  6. User Stories — each with ID (US-001), JTBD format, acceptance criteria (GIVEN/WHEN/THEN)
  7. Success Metrics — measurable outcomes with target values
  8. Constraints — technical, time, or resource constraints
  9. Risks & Unknowns — flag areas needing spikes/research before implementation
  10. Open Questions — anything that only the user can answer

  IMPORTANT — Flag untestable words in acceptance criteria:
  Words like 'robust', 'fast', 'user-friendly', 'seamless', 'efficient', 'intuitive'
  must be replaced with measurable alternatives.
  Example: 'loads quickly' → 'loads within 2 seconds on 3G'

  For S-scale: Keep it concise, 1 page max. Minimize open questions.
  For M-scale: Standard depth, 2-3 pages. List all open questions.
  For L-scale: Comprehensive, full PRD. Consider writing a fake press release
    from launch day (Working Backwards) to force clarity on the user benefit.")
```

Record the output as `initial_spec` and count `open_questions`.

### Phase 2 — CLARIFY (skip for S-scale)

Branch on `open_questions` count:

#### If no open questions and clarity is high (< 20% ambiguity)
Skip to Phase 4.

#### If M-scale with open questions
Ask up to 3 targeted questions using AskUserQuestion.
After each answer, internally note the clarification.
Then update the spec with new details.

#### If L-scale with open questions
Invoke deep-interview skill:
```
Skill(skill="agent-olympus:deep-interview",
  args="We have an initial spec but <N> open questions remain:
  <list_open_questions>
  Please conduct a Socratic interview to resolve these.")
```

After interview completes, collect the crystallized requirements and update the spec.

### Phase 3 — REFINE (skip for S-scale)

Branch on detected_scale:

#### M-scale review
Ask momus to validate the spec:

```
Task(subagent_type="agent-olympus:momus", model="opus",
  prompt="Review this product spec for completeness and clarity.

  Spec: <updated_spec_from_phase_1_or_2>
  User request: <original_user_request>

  Score each criterion 0-100. REJECT if any score < 70:
  - Problem Clarity: Is the problem well-defined?
  - Scope Precision: Are boundaries clear (what's in scope vs out)?
  - Story Completeness: Does each story specify concrete acceptance criteria?
  - Testability: Can acceptance criteria be verified with a test?
  - Edge Cases: Are common edge cases addressed?

  Also identify:
  - Missing user stories for complete coverage
  - Vague acceptance criteria that need specificity
  - Scope creep — work not required by the request

  End with one of:
  VERDICT: APPROVE
  VERDICT: REVISE — <bullet list of specific changes>
  VERDICT: REJECT  — <reason>")
```

If REVISE or REJECT: collect feedback and ask Hermes to update the spec with the feedback.
If APPROVE: proceed to Phase 4.

#### L-scale review
Invoke consensus-plan skill:

```
Skill(skill="agent-olympus:consensus-plan",
  args="Validate and finalize this large-scale specification through consensus review.
  Initial spec: <updated_spec>
  Codebase context: <analysis>
  Run the full architect + momus review loop to ensure architectural soundness
  and completeness before execution.")
```

After consensus-plan completes, use its output as the finalized spec.

### Phase 4 — FINALIZE

Write the spec in two formats:

#### Human-readable: .ao/spec.md

```markdown
# <Project/Feature Name> — Specification

**Scale:** S / M / L
**Created:** <date>
**Status:** Draft / Reviewed / Approved

## Problem Statement
<one paragraph describing the problem being solved>

## Target Users
<who benefits from this and why>

## Goals
- <goal 1>
- <goal 2>
- <goal 3>

## Non-Goals
- <explicitly out of scope>
- <will not be addressed in this phase>

## User Stories

### US-001: <title>
**As a** <persona>, **I want to** <action>, **so that** <benefit>

**Acceptance Criteria:**
- GIVEN <context> WHEN <action> THEN <result>
- GIVEN <context> WHEN <action> THEN <result>
- GIVEN <context> WHEN <action> THEN <result>

### US-002: <title>
**As a** <persona>, **I want to** <action>, **so that** <benefit>

**Acceptance Criteria:**
- GIVEN <context> WHEN <action> THEN <result>
- GIVEN <context> WHEN <action> THEN <result>

## Success Metrics
- <metric 1>: <target value, e.g., "95% test pass rate">
- <metric 2>: <target value>

## Constraints
- <technical constraint>
- <time or resource constraint>
- <external dependency>

## Open Questions
(if any remain after clarification)
- <question 1>
- <question 2>

## Review Notes
(if reviewed by momus/architect/consensus)
- <feedback summary>
```

#### Machine-readable: .ao/prd.json

```json
{
  "projectName": "<feature-or-project-slug>",
  "scale": "S|M|L",
  "createdAt": "<ISO timestamp>",
  "status": "draft|reviewed|approved",
  "problemStatement": "<one paragraph>",
  "targetUsers": "<one paragraph>",
  "goals": ["<goal 1>", "<goal 2>"],
  "nonGoals": ["<out of scope 1>"],
  "userStories": [
    {
      "id": "US-001",
      "title": "<one-line title>",
      "asA": "<persona>",
      "iWantTo": "<action>",
      "soThat": "<benefit>",
      "acceptanceCriteria": [
        "GIVEN <context> WHEN <action> THEN <result>",
        "GIVEN <context> WHEN <action> THEN <result>"
      ]
    }
  ],
  "successMetrics": [
    {
      "metric": "<metric name>",
      "target": "<value>"
    }
  ],
  "constraints": ["<constraint 1>"],
  "openQuestions": []
}
```

### Present to User

Format a summary table:

```markdown
## Plan Complete — <name>

| Attribute | Value |
|-----------|-------|
| Scale | S / M / L |
| User Stories | <count> |
| Open Questions | <count> |
| Review Status | <skipped (S) / passed (M/L) / pending (if user review requested)> |

### Quick Summary
<problem statement one-liner>

### User Stories
| ID | Title |
|----|-------|
| US-001 | <title> |
| US-002 | <title> |
...

Spec saved to `.ao/spec.md` (human-readable) and `.ao/prd.json` (machine-readable).
```

If scale is M or L, ask: "Ready to proceed to execution? Say `/atlas` or `/athena`, or ask questions first."

---

## Reverse Mode

When the user requests analysis of an existing codebase/product, switch to reverse mode.
Reverse mode produces the same `.ao/spec.md` and `.ao/prd.json` output as forward mode,
but extracts the spec FROM code rather than creating it FROM an idea.

### Reverse Architecture

```
Existing Codebase / Product
        │
        ▼
Phase R0: MODE DETECTION
    Detect reverse mode from trigger words or context
        │
        ▼
Phase R1: DISCOVERY (parallel)
    ┌───┴─────────────────────────────┐
    ▼                                  ▼
  Explore agent                    Hermes agent
  (codebase structure,             (README, docs, configs
   file inventory,                  → infer intent, users,
   dependencies)                    problem statement)
    └───┬─────────────────────────────┘
        ▼
Phase R2: DEEP ANALYSIS (Hermes)
    Read key files, extract features as user stories,
    recover acceptance criteria from tests/validation,
    map architecture, identify gaps
        │
        ▼
Phase R3: SYNTHESIS & GAP ANALYSIS
    Compile reverse spec, score health,
    identify improvement opportunities
        │
        ▼
Phase R4: FINALIZE
    Write .ao/spec.md and .ao/prd.json
    Present summary with health score
```

### Phase R0 — MODE DETECTION

Detect reverse mode from user intent:

```
If user request mentions an existing codebase, directory, repo, or product:
  AND uses words like "analyze", "분석", "understand", "document", "reverse", "기획분석":
  → Switch to reverse mode
```

### Phase R1 — DISCOVERY

Launch parallel exploration:

```
Task A — Codebase exploration:
Task(subagent_type="agent-olympus:explore", model="haiku",
  prompt="Explore this codebase and produce a structural overview.

  Target: <path_or_repo>

  Report:
  1. Project type (web app, CLI, library, API, mobile, etc.)
  2. Tech stack (languages, frameworks, databases, build tools)
  3. Directory structure with purpose of each top-level directory
  4. Entry points (main files, index files, app bootstrap)
  5. Key configuration files and their purpose
  6. Test structure (framework, location, approximate coverage)
  7. External dependencies (from package.json, requirements.txt, go.mod, etc.)
  8. Total file count and lines of code estimate")

Task B — Intent extraction:
Task(subagent_type="agent-olympus:hermes", model="opus",
  prompt="Read the README, docs, and key config files of this project.
  Infer:
  1. What problem does this project solve?
  2. Who are the target users?
  3. What is the core value proposition?
  4. What are the main features (high-level)?

  Target: <path_or_repo>
  README: <readme_content_if_available>
  Package metadata: <package_json_or_equivalent>")
```

Merge both outputs as `discovery_context`.

### Phase R2 — DEEP ANALYSIS

Hermes reads key files and extracts the implicit spec:

```
Task(subagent_type="agent-olympus:hermes", model="opus",
  prompt="You are in REVERSE MODE. Analyze this existing codebase and extract its implicit spec.

  Discovery context: <discovery_context>
  Target: <path_or_repo>

  Your task:
  1. Read the key source files, routes/endpoints, components, data models
  2. Extract each feature as a Reverse Feature (RF-001, RF-002, ...)
     - Title: what the feature does
     - User story: infer the JTBD (As a <user>, I want to <action>, so that <benefit>)
     - Acceptance criteria: extract from tests, validation logic, error handling
     - Test coverage: ✅ has tests / ⚠️ partial / ❌ none
  3. Map the architecture: modules, data flow, external integrations
  4. Identify technical debt: dead code, deprecated patterns, hardcoded values,
     missing error handling, security issues
  5. Identify documentation gaps: undocumented features, missing API docs
  6. Identify improvement opportunities: performance, UX, security, maintainability
  7. Score project health 0-100 across:
     - Test Coverage / Documentation / Code Quality / Architecture / Security")
```

Record output as `reverse_analysis`.

### Phase R3 — SYNTHESIS & GAP ANALYSIS

If scale is L (large project), run an additional review:

```
Task(subagent_type="agent-olympus:architect", model="opus",
  prompt="Review this reverse-engineered specification for architectural accuracy.

  Reverse analysis: <reverse_analysis>
  Codebase structure: <discovery_context>

  Verify:
  1. Is the architecture description accurate?
  2. Are there architectural concerns not captured?
  3. Are the improvement opportunities technically sound?
  4. Are there additional risks or debt items to flag?

  Add your notes to the analysis.")
```

Merge architect feedback into the spec.

### Phase R4 — FINALIZE (Reverse)

Write the reverse spec to `.ao/spec.md`:

```markdown
# <Project Name> — Reverse Specification

**Mode:** Reverse (extracted from existing code)
**Analyzed:** <date>
**Target:** <path_or_repo>
**Health Score:** <overall>/100

## Product Summary
<one paragraph: what this product does>

## Inferred Problem Statement
<reconstructed from code: what problem this was built to solve>

## Target Users
<inferred from UI, API design, auth patterns>

## Tech Stack
| Layer | Technology |
|-------|-----------|
| Language | <lang> |
| Framework | <framework> |
| Database | <db> |
| Deployment | <deploy> |

## Feature Inventory

### RF-001: <title> [✅/⚠️/❌]
**As a** <persona>, **I want to** <action>, **so that** <benefit>
**Acceptance Criteria:**
- GIVEN <context> WHEN <action> THEN <result>
**Source:** <file path(s)>

### RF-002: <title> [✅/⚠️/❌]
...

## Architecture Overview
<description of system structure, modules, data flow>

## Health Assessment
| Dimension | Score | Notes |
|-----------|-------|-------|
| Test Coverage | /100 | <notes> |
| Documentation | /100 | <notes> |
| Code Quality | /100 | <notes> |
| Architecture | /100 | <notes> |
| Security | /100 | <notes> |
| **Overall** | **/100** | |

## Technical Debt
- <debt item 1>
- <debt item 2>

## Documentation Gaps
- <gap 1>
- <gap 2>

## Improvement Opportunities
- <opportunity 1: description + expected impact>
- <opportunity 2: description + expected impact>
```

Also write `.ao/prd.json` with the same structure (using `"mode": "reverse"` and `"healthScore"` fields).

### Present to User (Reverse)

```markdown
## Reverse Analysis Complete — <project name>

| Attribute | Value |
|-----------|-------|
| Mode | Reverse |
| Health Score | <score>/100 |
| Features Found | <count> |
| With Tests | <count> ✅ |
| Without Tests | <count> ❌ |
| Tech Debt Items | <count> |
| Improvement Opportunities | <count> |

### Top 3 Improvement Opportunities
1. <opportunity>
2. <opportunity>
3. <opportunity>

Spec saved to `.ao/spec.md` and `.ao/prd.json`.
```

Ask: "Want to act on any of these improvements? Say `/atlas` or `/athena` to start, or pick specific items to plan."

## Integration_With_Atlas_Athena

Plan is the **pre-processor** for execution:

```
Vague Idea → /plan → Spec → /atlas or /athena → Done
```

**Pattern for Atlas Phase 0 — Triage:**
```
If ambiguity > 40 and requirements are unclear:
  Skill(skill="agent-olympus:plan",
    args="Create an executable spec for this vague request.
    User request: <request>
    Analysis: <triage_findings>")
```

After Plan completes, Atlas reads `.ao/prd.json` and proceeds directly to execution.

**Pattern for Athena Phase 0 — Triage:**
Same as Atlas. Athena invokes Plan and then uses the finalized PRD to dispatch workers.

## Guardrails

| Guard | Value | On Breach |
|-------|-------|-----------|
| Max clarification questions | 5 | Force finalize with noted unknowns |
| Max refinement cycles | 2 | Ask user to provide guidance or override |
| User stories with acceptance criteria | 100% required | Iterate until all stories are testable |
| Spec completeness threshold | All mandatory sections filled | Escalate to user if any section is empty |

## Stop_Conditions

STOP and save the spec when:
- Spec.md is written with all mandatory sections filled (Problem, Goals, User Stories, Constraints)
- prd.json is written and verified readable
- User approves the spec OR explicitly says "proceed" OR scale is S (auto-approved)

ESCALATE to user when:
- After 2 refinement cycles, momus/architect still rejects
- User stories lack testable acceptance criteria after refinement attempt
- Open questions remain but user does not want to clarify further

**Never hand off a spec to Atlas/Athena without all mandatory sections filled.**

</Plan_Skill>
