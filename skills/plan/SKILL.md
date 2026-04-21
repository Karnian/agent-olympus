---
name: plan
description: Adaptive product planner — forward (idea→spec) and reverse (code→spec) planning across any scale
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
Phase 0: TRIAGE (unified)
    Detect MODE (forward vs reverse) and SCALE (S/M/L)
    in a single lightweight pass
        │
        ├── Forward ──────────────────────── Reverse ──┐
        ▼                                               ▼
Phase 1: UNDERSTAND (Hermes)              Phase R1: DISCOVERY (parallel)
    Draft spec with problem,                  Explore + Hermes intent
    goals, stories, open questions            extraction simultaneously
        │                                               │
        ├──────────────┐                                ▼
        ▼              ▼                    Phase R2: DEEP ANALYSIS
    S-scale      M/L-scale                    Extract features, recover
    (Phase 4)    (Phase 2)                    acceptance criteria, map arch
        │              │                                │
        │              ▼                                ▼
        │       Phase 2: CLARIFY            Phase R3: SYNTHESIS (L only)
        │       Phase 3: REFINE               Architect review
        │              │                                │
        └──────┬───────┘                                │
               ▼                                        ▼
        Phase 4: FINALIZE              Phase R4: FINALIZE
        Write .ao/spec.md               Write .ao/spec.md
        + .ao/prd.json                  + .ao/prd.json (mode: reverse)
               │                                        │
               ▼                                        ▼
        Ready for Atlas/Athena          "Act on improvements?"
```

## Spec_Persistence

Finalized specs are written to TWO locations:

1. **`docs/plans/<project-slug>/`** — Git-tracked permanent storage. Survives sessions, shared with team.
2. **`.ao/spec.md` + `.ao/prd.json`** — Ephemeral working copy for Atlas/Athena execution.

### Slug Derivation

Derive `<project-slug>` from `prd.json.projectName`:
- Lowercase the entire string
- Replace spaces, underscores, and non-alphanumeric characters (except hyphens) with hyphens
- Collapse consecutive hyphens into one
- Strip leading/trailing hyphens
- Truncate to 50 characters
- Example: "User Authentication System" → "user-authentication-system"

### Directory Layout

```
docs/plans/
├── README.md                    ← auto-generated index of all plans
├── <project-slug>/
│   ├── spec.md                  ← human-readable specification
│   ├── prd.json                 ← machine-readable PRD
│   ├── CHANGELOG.md             ← change history (auto-appended)
│   └── features/                ← M/L scale only (4+ user stories)
│       └── <feature-slug>.md    ← per-feature detail
```

### Existing Spec Detection

Before writing to `docs/plans/<slug>/`:
1. Check if `docs/plans/<slug>/prd.json` exists
2. If YES → this is an **UPDATE**. Overwrite files (git preserves history). CHANGELOG entry: "Updated"
3. If NO → this is a **CREATE**. Create directory. CHANGELOG entry: "Created"
4. If slug already exists for a DIFFERENT project → append `-2`, `-3` suffix

### What Gets Stored Where

| Content | `.ao/` (ephemeral) | `docs/plans/` (permanent) |
|---------|-------------------|---------------------|
| spec.md | ✅ | ✅ (identical copy) |
| prd.json | ✅ | ✅ (identical copy) |
| features/ | ❌ | ✅ (M/L only) |
| CHANGELOG.md | ❌ | ✅ |
| README.md index | ❌ | ✅ |

Atlas/Athena read exclusively from `.ao/prd.json`. The `docs/plans/` copy is the permanent record
that Atlas's execution-time mutations do NOT affect.

## Steps

### Phase 0 — TRIAGE (mode + scale detection)

Detect both MODE and SCALE in a single lightweight pass.
This avoids spawning a sub-agent just for scale detection.

```
Analyze the user's request and determine two things:

1. MODE — Is this forward (new idea → spec) or reverse (existing code → spec)?

   Reverse indicators:
   - References an existing codebase, directory, repo, or product
   - Uses words: "analyze", "분석", "understand", "document", "reverse", "기획분석",
     "이 코드", "이 프로젝트", "existing", "current", "legacy"
   - Asks to "extract spec", "understand architecture", "find gaps"

   Forward indicators (default):
   - Describes something to build: "add", "create", "implement", "build", "만들어"
   - Describes a problem to solve: "fix", "improve", "redesign"

   If ambiguous, default to FORWARD.

2. SCALE — How large is this?

   S = Single file, one feature, obvious implementation
       Examples: 'fix typo', 'add a button', 'bump version', 'rename function'

   M = Multi-file feature, new API endpoint, component system
       Examples: 'add user authentication', 'implement checkout flow', 'new API endpoint'

   L = New system, major refactor, multi-service, architectural
       Examples: 'build recommendation engine', 'migrate to microservices', 'redesign database'

   For reverse mode: S = single module, M = multi-module project, L = large system

Record: detected_mode (forward|reverse), detected_scale (S|M|L)
```

If `detected_mode == reverse`: jump to **Phase R1**.
If `detected_mode == forward`: continue to **Phase 1**.

Output: "[plan] Phase 0 complete — mode: <detected_mode>, scale: <detected_scale>"

### Phase 1 — UNDERSTAND

#### Pre-flight: State Validation & Input Guard

Run preflight validation and input size check BEFORE any sub-agent call:

```javascript
// Step 1: Clean stale .ao/ state (pointer files, expired checkpoints)
import { runPreflight } from './scripts/lib/preflight.mjs';
const preflightReport = await runPreflight();
// If preflight cleaned pointer files, .ao/spec.md and .ao/prd.json are now absent
// → proceed to create new ones (which is the correct behavior)
for (const action of preflightReport.actions) {
  Output: "[plan] Preflight: " + action;
}

// Step 2: Guard input size for sub-agent calls
import { prepareSubAgentInput, checkInputSize } from './scripts/lib/input-guard.mjs';
const inputCheck = checkInputSize(<user_request_text>, 'opus');
if (!inputCheck.safe) {
  Output: "[plan] Input too large for direct sub-agent call (" + inputCheck.lines + " lines, ~" + inputCheck.tokens + " tokens)"
  Output: "[plan] Extracting structural summary for Hermes..."
  const prepared = prepareSubAgentInput(<user_request_text>, 'opus', <source_file_path>);
  // Use prepared.text instead of raw input for ALL sub-agent prompts in this skill
  // prepared.preservedIds contains the story IDs that were preserved
  Output: "[plan] Summary: " + prepared.originalLines + " → " + countLines(prepared.text) + " lines. " + prepared.preservedIds.length + " story IDs preserved."
  <user_request_for_hermes> = prepared.text
} else {
  <user_request_for_hermes> = <user_request_text>
}
```

Output: "[plan] Spawning Hermes for spec generation..."

#### Hermes Spec Generation

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

**Sub-agent output validation — MANDATORY:**

After Hermes returns, validate before proceeding:
```
hermes_output = <result from Hermes Task() call above>

If hermes_output is empty OR hermes_output.length < 50 characters:
  // RETRY with aggressively reduced input
  Output: "[plan] ⚠ Hermes returned empty/minimal output. Retrying with reduced input..."

  // Force-summarize even if input was already summarized
  import { extractStructuralSummary } from './scripts/lib/input-guard.mjs';
  const { summary } = extractStructuralSummary(<user_request_text>, 100);
  // Retry with ONLY the summary + a simplified prompt
  hermes_output = Task(subagent_type="agent-olympus:hermes", model="sonnet",
    prompt="Create a product spec. Input (summarized): " + summary)

  If hermes_output is STILL empty OR hermes_output.length < 50:
    Output: "[plan] ✗ Phase 1 FAILED — Hermes could not generate spec after retry."
    Output: "[plan] Root cause: input likely exceeds sub-agent processing capacity."
    Output: "[plan] Try: (1) split the document into per-feature chunks, or (2) run /plan on one feature at a time."
    // Record the failure as wisdom for future sessions
    import { addWisdom } from './scripts/lib/wisdom.mjs';
    await addWisdom({
      category: 'debug',
      lesson: 'Plan skill Phase 1 failed: Hermes empty output on L-scale input (' + inputCheck.lines + ' lines). Input guard summary was insufficient.',
      confidence: 'high',
    });
    STOP — do not proceed to Phase 2.
```

Record the output as `initial_spec` and count `open_questions`.
Output: "[plan] Phase 1 complete — <N> user stories, <open_questions> open questions."

### Phase 2 — CLARIFY (skip for S-scale)

Output: "[plan] Starting Phase 2: CLARIFY"

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

Output: "[plan] Starting Phase 3: REFINE"

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

Output: "[plan] Starting Phase 4: FINALIZE — writing spec files..."

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

#### Persistent storage: docs/plans/\<slug\>/

After writing to `.ao/`, persist to the git-tracked `docs/plans/` directory:

1. **Derive slug** from `prd.json.projectName` using the Slug Derivation rules in Spec_Persistence.

2. **Detect create vs update**:
   ```
   If docs/plans/<slug>/prd.json exists → action = "Updated"
   Else → action = "Created", create docs/plans/<slug>/ directory
   If docs/plans/ directory doesn't exist → create it
   ```

3. **Write spec.md**: Copy `.ao/spec.md` content to `docs/plans/<slug>/spec.md`.

4. **Write prd.json**: Copy `.ao/prd.json` content to `docs/plans/<slug>/prd.json`.

5. **Write features/ (M/L scale with 4+ user stories only)**:
   ```
   Group user stories by logical feature area (infer from story titles and context).
   Each group becomes: docs/plans/<slug>/features/<feature-slug>.md

   Feature file format:
   # <Feature Name>

   ## User Stories

   ### <US-ID>: <title>
   **As a** <persona>, **I want to** <action>, **so that** <benefit>

   **Acceptance Criteria:**
   - GIVEN <context> WHEN <action> THEN <result>

   (repeat for each story in this feature group)
   ```

   S-scale specs do NOT get a features/ directory.

6. **Append to CHANGELOG.md** (create if new):
   ```markdown
   ## <YYYY-MM-DD> — <Created|Updated>

   - **Scale:** <S/M/L>
   - **Mode:** Forward
   - **Stories:** <count> user stories
   - **Status:** <draft/reviewed/approved>
   - **Summary:** <one-line problem statement>
   ```

7. **Regenerate docs/plans/README.md** by scanning all `docs/plans/*/prd.json` files:
   ```markdown
   # Specifications Index

   Auto-generated index of all project specifications.

   | Project | Scale | Mode | Stories | Status | Last Updated |
   |---------|-------|------|---------|--------|-------------|
   | [<projectName>](./<slug>/spec.md) | S/M/L | forward | <count> | <status> | <date> |
   ```
   Sort by last updated date, most recent first.

### Auto-Validation (Phase 4 gate)

Before writing files, validate consistency:

```
Validation checklist:
1. Story count: spec.md user story count == prd.json userStories array length
2. Story IDs: all IDs in spec.md appear in prd.json (no orphans)
3. Acceptance criteria: every user story has ≥1 GIVEN/WHEN/THEN criterion
4. Untestable words: scan for [robust, efficient, user-friendly, fast, safe,
   accurate, effective, flexible, maintainable, reliable, adequate, quickly,
   in a timely manner] — flag and rewrite any found
5. Mandatory sections: Problem, Goals, User Stories, Constraints all non-empty
6. Open questions: if openQuestions.length > 0 AND scale == L,
   add "(⚠️ N open questions remain — stakeholder review recommended)" to summary

If any check fails → fix automatically before writing.
If untestable words found → rewrite with measurable alternatives.
Log all auto-corrections in Review Notes section.
```

### Open Question Handling

Open questions should not block execution for S/M scale:

```
S-scale: Open questions are NOT allowed. Force resolution or use sensible defaults.
M-scale: Up to 2 open questions allowed. Each must have a recommended default.
         Atlas/Athena use the default and log the assumption.
L-scale: Up to 5 open questions allowed. Each must have:
         - Recommended default (so execution CAN proceed)
         - Impact analysis (what changes if a different answer is chosen)
         - Stakeholder tag (who should answer: "tech lead", "product owner", "designer")
         Mark spec status as "reviewed-with-open-questions" instead of "approved".
```

### Present to User

Format a summary table:

```markdown
## Plan Complete — <name>

| Attribute | Value |
|-----------|-------|
| Scale | S / M / L |
| User Stories | <count> |
| Open Questions | <count> (with defaults) |
| Auto-Corrections | <count> |
| Review Status | <skipped (S) / passed (M/L) / pending (if user review requested)> |

### Quick Summary
<problem statement one-liner>

### User Stories
| ID | Title |
|----|-------|
| US-001 | <title> |
| US-002 | <title> |
...

Spec saved to:
- `docs/plans/<slug>/` (git-tracked permanent copy)
- `.ao/` (working copy for Atlas/Athena)
```

### Phase 5 — EXECUTE (auto-routing)

After presenting the summary, route execution based on `.ao/autonomy.json` `planExecution` setting:

```
import { loadAutonomyConfig } from './scripts/lib/autonomy.mjs';
const config = loadAutonomyConfig(process.cwd());
const mode = config.planExecution || 'ask';
```

**Complexity check** — determine if the plan is simple enough to skip orchestration:

```
const isSimple = detected_scale === 'S' || userStoryCount <= 2;
```

If `isSimple` AND `mode === 'ask'`: skip the prompt, execute solo (no orchestrator needed for trivial plans).

Otherwise, route by mode:

| `planExecution` | Behavior |
|-----------------|----------|
| `"solo"` | Proceed with direct Claude execution. No orchestrator. |
| `"ask"` | Present choice to user (see below). |
| `"atlas"` | Output: "[plan] Auto-routing to Atlas..." then invoke `Skill(skill="agent-olympus:atlas")` |
| `"athena"` | Output: "[plan] Auto-routing to Athena..." then invoke `Skill(skill="agent-olympus:athena")` |

**When `mode === "ask"`** — use AskUserQuestion tool for interactive selection:

```
AskUserQuestion({
  questions: [{
    question: "플랜이 승인되었습니다. 실행 방식을 선택해주세요.",
    header: "실행 방식",
    multiSelect: false,
    options: [
      { label: "Solo (Recommended)", description: "직접 실행 — 가장 빠르고 오버헤드 없음" },
      { label: "Atlas", description: "서브에이전트 오케스트레이터 — 복잡한 작업에 적합" },
      { label: "Athena", description: "병렬 팀 워커 (Claude+Codex+Gemini) — 대규모 작업에 적합" }
    ]
  }]
})
```

If AskUserQuestion is not available in this environment, fall back to presenting the same three options as a numbered markdown list and wait for user reply.

After user selects:
- "Solo" → proceed with direct execution
- "Atlas" → invoke `Skill(skill="agent-olympus:atlas")`
- "Athena" → invoke `Skill(skill="agent-olympus:athena")`
- Other (custom text) → interpret user intent and route accordingly

**Important:** The spec is already written to `.ao/prd.json` — Atlas/Athena will read it automatically. No need to pass the spec content in the prompt.

---

## Reverse Mode

When the user requests analysis of an existing codebase/product, switch to reverse mode.
Reverse mode produces the same `.ao/spec.md` and `.ao/prd.json` output as forward mode,
but extracts the spec FROM code rather than creating it FROM an idea.

### Reverse Architecture

```
Phase 0 TRIAGE detects reverse mode
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

### Phase R1 — DISCOVERY

Mode detection is handled by Phase 0 TRIAGE (unified).
When `detected_mode == reverse`, execution jumps here.

**Scope control for large codebases:**
- S-scale: Read up to 10 key files
- M-scale: Read up to 30 key files
- L-scale: Read up to 60 key files, prioritize entry points and public APIs
- Always prioritize: README, package metadata, entry points, config files, test files
- Skip: node_modules, .git, build output, generated code, binary files, lock files

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

  Scope limit: Read up to <scope_limit_by_scale> key files.
  Prioritize: entry points, public APIs, route handlers, core business logic, test files.
  Skip: generated code, lock files, node_modules, build output.

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

**Always run for L-scale.** For S/M-scale, skip to Phase R4.

For L-scale projects, the deep analysis alone may miss architectural nuances.
Run an architect review to cross-check:

```javascript
// Optional diff-scope hint (disabled by default; see .ao/autonomy.json architect.diffScope).
import { loadAutonomyConfig } from './scripts/lib/autonomy.mjs';
import { resolveArchitectScope, formatScopeHint } from './scripts/lib/architect-scope.mjs';
const _autonomy = loadAutonomyConfig(process.cwd());
const _scope = resolveArchitectScope({ autonomyConfig: _autonomy, cwd: process.cwd() });
const _scopeHint = formatScopeHint(_scope);
```

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

  Add your notes to the analysis."
  + _scopeHint)
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

Also write `.ao/prd.json` for machine consumption by Atlas/Athena:

```json
{
  "mode": "reverse",
  "projectName": "<project-slug>",
  "analyzedAt": "<ISO timestamp>",
  "target": "<path_or_repo>",
  "healthScore": {
    "testCoverage": <0-100>,
    "documentation": <0-100>,
    "codeQuality": <0-100>,
    "architecture": <0-100>,
    "security": <0-100>,
    "overall": <0-100>
  },
  "features": [
    {
      "id": "RF-001",
      "title": "<title>",
      "testCoverage": "full|partial|none",
      "asA": "<persona>",
      "iWantTo": "<action>",
      "soThat": "<benefit>",
      "acceptanceCriteria": ["GIVEN ... WHEN ... THEN ..."],
      "sourceFiles": ["path/to/file.ts"]
    }
  ],
  "technicalDebt": [
    {
      "severity": "critical|moderate|low",
      "description": "<issue>",
      "file": "<path>",
      "suggestion": "<fix>"
    }
  ],
  "improvementOpportunities": [
    {
      "title": "<opportunity>",
      "impact": "high|medium|low",
      "description": "<details>"
    }
  ]
}
```

This JSON is designed so Atlas/Athena can directly read improvement opportunities
and convert them into executable user stories without human reformatting.

#### Persistent storage: docs/plans/\<slug\>/ (Reverse)

After writing to `.ao/`, persist to the git-tracked `docs/plans/` directory:

1. **Derive slug** from `prd.json.projectName` using the Slug Derivation rules in Spec_Persistence.

2. **Detect create vs update**: Same as forward mode.

3. **Write spec.md**: Copy reverse spec content to `docs/plans/<slug>/spec.md`.

4. **Write prd.json**: Copy reverse prd.json to `docs/plans/<slug>/prd.json`.

5. **Write features/ (M/L scale only)**:
   Same logic as forward mode, but group by RF-NNN features instead of US-NNN stories.
   Feature file names derived from feature group titles.

6. **Append to CHANGELOG.md** (create if new):
   ```markdown
   ## <YYYY-MM-DD> — <Created|Updated>

   - **Scale:** <S/M/L>
   - **Mode:** Reverse
   - **Health Score:** <overall>/100
   - **Features Found:** <count>
   - **Summary:** <one-line product summary>
   ```

7. **Regenerate docs/plans/README.md**: Same as forward mode.

### Reverse Auto-Validation (Phase R4 gate)

Before writing reverse output files, validate consistency:

```
Validation checklist:
1. Feature count: spec.md RF-NNN count == prd.json features array length
2. Feature IDs: all RF-NNN IDs in spec.md appear in prd.json (no orphans)
3. Health scores: all 5 dimensions present and in 0-100 range
4. Overall score: matches weighted average (or is explicitly justified if not)
5. Tech debt severity: every item has severity tag (critical/moderate/low)
6. Source files: every RF-NNN references at least one source file path
7. Acceptance criteria: every feature has ≥1 GIVEN/WHEN/THEN or behavioral description

If any check fails → fix automatically before writing.
Log all auto-corrections in spec footer.
```

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

Spec saved to:
- `docs/plans/<slug>/` (git-tracked permanent copy)
- `.ao/` (working copy for Atlas/Athena)
```

Then proceed to **Phase 5 — EXECUTE** (same as forward mode) to auto-route execution.
For reverse mode, the prompt says "Act on improvements?" instead of "Execute plan?".

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

**Pattern for brainstorm pre-processing:**
If the task is classified as `architectural` or `complex` by triage AND the user
has not explicitly skipped design:
  invoke /brainstorm first, or ask the user to run /brainstorm before /plan for this task
After brainstorm completes, read `.ao/brainstorm-<slug>.md` and use it as
additional input to the Plan skill's Phase 1 UNDERSTAND step.

## Guardrails

| Guard | Value | On Breach |
|-------|-------|-----------|
| Max clarification questions | 5 | Force finalize with noted unknowns |
| Max refinement cycles | 2 | Ask user to provide guidance or override |
| User stories with acceptance criteria | 100% required | Iterate until all stories are testable |
| Spec completeness threshold | All mandatory sections filled | Escalate to user if any section is empty |

## Stop_Conditions

STOP and save the spec when:
- Auto-validation passes (all checklist items green)
- Spec.md is written with all mandatory sections filled (Problem, Goals, User Stories, Constraints)
- prd.json is written, verified readable, and story/feature count matches spec.md
- No untestable words remain in acceptance criteria
- User approves the spec OR explicitly says "proceed" OR scale is S (auto-approved)

ESCALATE to user when:
- After 2 refinement cycles, momus/architect still rejects
- User stories lack testable acceptance criteria after refinement attempt
- Open questions remain but user does not want to clarify further

**Never hand off a spec to Atlas/Athena without all mandatory sections filled.**

</Plan_Skill>
