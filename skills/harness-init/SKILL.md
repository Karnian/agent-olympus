---
name: harness-init
description: Initialize harness engineering structure — AGENTS.md as TOC, docs/ knowledge base, golden principles, architectural constraints
---

<Harness_Init>

## Purpose

Set up OpenAI-style harness engineering infrastructure for a new or existing project.

Core philosophy: **agents need maps, not encyclopedias.**
Engineering work shifts from writing code to:
- Designing environments (docs/, AGENTS.md as TOC, architectural constraints)
- Specifying intent (golden principles, acceptance criteria)
- Building feedback loops (structural tests, linters, entropy management)

Reference: [OpenAI Harness Engineering](https://openai.com/index/harness-engineering/)

## Use_When

- Starting a new project that will use Atlas or Athena
- User says "harness-init", "setup-harness", "하네스 설정", "init-harness"
- Atlas/Athena Phase 0 detects missing `docs/golden-principles.md`
- AGENTS.md exists but is monolithic (>150 lines) — needs refactoring to TOC

## Do_Not_Use_When

- Project already has `docs/golden-principles.md` and `docs/ARCHITECTURE.md` (run verify instead)
- Simple script or one-off task (not a sustained development project)

## Steps

### Phase 1 — SCAN

Analyze the project to understand its structure and existing conventions:

```
Task(subagent_type="agent-olympus:explore", model="haiku",
  prompt="Scan this project thoroughly and report:
  1. Tech stack (language, framework, build tool, test framework)
  2. Directory structure (depth 3, file counts per dir)
  3. Existing docs/, README, AGENTS.md, CLAUDE.md contents if present
  4. Module/package boundaries and import patterns
  5. Naming conventions (files, functions, variables)
  6. Any existing linter configs (.eslintrc, .pylintrc, etc.)
  7. CI configuration if present
  Report as structured JSON.")
```

### Phase 2 — DESIGN HARNESS

Architect the knowledge base and golden principles:

```
Task(subagent_type="agent-olympus:executor", model="opus",
  prompt="Design and write a harness engineering structure for this project.

  Project scan: <explore_results>

  Produce all of the following files:

  ## 1. AGENTS.md (≤100 lines — TABLE OF CONTENTS ONLY)
  Format:
  # <project-name>
  <!-- harness-version: 1 -->

  ## Architecture
  <3-5 sentence high-level description>
  See: docs/ARCHITECTURE.md

  ## Dependency Layers
  <layer diagram, e.g. Types → Config → Repo → Service → Runtime → UI>
  See: docs/ARCHITECTURE.md for full rules

  ## Directory Map
  - <dir>/  — <one-line purpose> → see <dir>/AGENTS.md
  ...

  ## Tech Stack
  <language, framework, build, test>

  ## Key Commands
  - Build:  <command>
  - Test:   <command>
  - Lint:   <command>
  - Run:    <command>

  ## Knowledge Base
  - Architecture:     docs/ARCHITECTURE.md
  - Golden Principles: docs/golden-principles.md
  - Exec Plans:       docs/exec-plans/
  - Design Docs:      docs/design-docs/
  - Quality:          docs/QUALITY_SCORE.md

  ## 2. docs/ARCHITECTURE.md
  - Full dependency layer diagram with rules
  - What each layer is responsible for
  - Allowed and forbidden cross-layer imports
  - Cross-cutting concerns (auth, logging, config) and how they flow

  ## 3. docs/golden-principles.md
  5-10 encoding rules that agents MUST follow. Examples:
  - Prefer shared utilities over inline helpers (enforce invariants centrally)
  - Always validate data at boundaries — never assume shape from external sources
  - No layer violations: UI must not import directly from Repo layer
  - Test coverage requirement (e.g., every public function must have a test)
  - Naming conventions (e.g., all interfaces prefixed with I, all errors suffixed with Error)
  - No YOLO-style data access (no `as any`, no unchecked casts)
  - Error handling pattern (e.g., Result<T,E> or throw+catch convention)

  Tailor principles to the actual tech stack and project patterns discovered.

  ## 4. docs/design-docs/index.md
  Stub:
  # Design Docs
  Architecture decisions and design rationale.
  Add one file per significant design decision.

  ## 5. docs/exec-plans/active/.gitkeep and docs/exec-plans/completed/.gitkeep
  (empty files to scaffold the subdirectories)

  ## 6. docs/exec-plans/README.md
  Index file:
  # Execution Plans
  Plans are first-class artifacts stored here, not in ephemeral chat.

  ## Active
  (none yet)

  ## Completed
  (none yet)

  ## Tech Debt Tracker
  See: tech-debt-tracker.md

  ## 7. docs/exec-plans/tech-debt-tracker.md
  Template:
  # Tech Debt Tracker
  | Date | Task | Files | Stories | Notes |
  |------|------|-------|---------|-------|

  ## 8. docs/QUALITY_SCORE.md

  Template grading each module/domain:
  # Quality Scores
  | Module | Coverage | Lint | Arch Compliance | Last Updated |
  |--------|----------|------|-----------------|--------------|

  Write all files directly to disk.")
```

### Phase 3 — STRUCTURAL CONSTRAINTS

Generate architectural constraint stubs:

```
Task(subagent_type="agent-olympus:test-engineer", model="sonnet",
  prompt="Create architectural constraint validation for this project.

  Architecture: <docs/ARCHITECTURE.md>
  Tech stack: <stack>
  Golden principles: <docs/golden-principles.md>

  Generate ONE structural test file appropriate for the tech stack:
  - TypeScript/JS: tests/arch.test.ts — import graph checks using jest + madge or custom resolver
  - Python: tests/test_arch.py — import checks using ast module
  - Go: tests/arch_test.go — package dependency checks
  - Other: docs/arch-constraints.md describing the checks as CI pseudocode

  The test should validate at least:
  1. No UI → Repo direct imports (or equivalent layer violation)
  2. No circular dependencies within a module
  3. Naming convention spot-check (e.g., test files end in .test.ts)

  Add TODO comments where full implementation requires project-specific knowledge.
  Keep it minimal and runnable — better a simple passing test than a complex broken one.")
```

### Phase 4 — VERIFY

```bash
echo "=== Harness files created ==="
ls docs/
echo ""
echo "=== AGENTS.md line count ==="
wc -l AGENTS.md
echo ""
echo "=== Golden Principles ==="
cat docs/golden-principles.md
```

Report to user:
- Files created
- Golden principles summary (list them)
- Dependency layers defined
- Structural constraint test location
- **Next steps**:
  1. Review and customize `docs/golden-principles.md` for your team's taste
  2. Fill in `docs/design-docs/` as design decisions are made
  3. Atlas/Athena will now auto-load the harness context on every run

</Harness_Init>
