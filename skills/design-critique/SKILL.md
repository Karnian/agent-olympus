---
name: design-critique
description: Structured UI/UX design critique using Nielsen heuristics, Gestalt principles, and WCAG standards
level: 2
aliases: [design-critique, 디자인리뷰, 디자인비평, design-review, review-design, critique-ui, デザインレビュー]
---

<Design_Critique>

## Purpose

Design Critique provides structured, evidence-based feedback on UI/UX quality. It evaluates interfaces against three established frameworks (Nielsen heuristics, Gestalt principles, WCAG accessibility) and produces a severity-rated report with actionable recommendations.

Use this skill for focused design feedback. For comprehensive audits combining multiple concerns, use `/ui-review` instead.

## Use_When

- User says "design critique", "review this design", "디자인 리뷰", "check the UI"
- User shares a screenshot or points to a component for design feedback
- After implementation, before merge — as a design quality gate
- When usability concerns are raised about existing UI

## Workflow

### Step 1 — Scope Identification

Identify what to review:
- If user specifies files/components → use those
- If user provides screenshot → analyze visually
- If no scope given → detect recently changed frontend files:
  ```bash
  git diff --name-only HEAD~1 | grep -E '\.(tsx|jsx|vue|svelte|css|scss|html)$'
  ```

### Step 2 — Evidence Collection

Spawn Aphrodite to perform the critique:

```
Task(subagent_type="agent-olympus:aphrodite", model="sonnet",
  prompt="Perform a design critique of: <scope>

  Review against:
  1. Nielsen's 10 Usability Heuristics
  2. Gestalt Principles (proximity, similarity, closure, continuity, figure-ground)
  3. WCAG 2.2 AA accessibility requirements

  For each finding:
  - Cite the specific heuristic/principle violated
  - Rate severity (CRITICAL/HIGH/MEDIUM/LOW)
  - Provide a concrete, actionable fix
  - Reference the file and line number

  Output the structured review report format.")
```

If Claude Preview MCP is available, also capture visual evidence:
```
preview_start(name="<dev-server>")
preview_screenshot(serverId="<id>")
preview_snapshot(serverId="<id>")
```

### Step 3 — Synthesis

Compile findings into a prioritized report:

```markdown
## Design Critique Report: [Component/Page]

### Critical & High Issues (must fix)
| # | Framework | Violation | File:Line | Fix |
|---|-----------|-----------|-----------|-----|

### Medium Issues (should fix)
| # | Framework | Violation | File:Line | Fix |
|---|-----------|-----------|-----------|-----|

### Low Issues (nice to have)
| # | Framework | Violation | File:Line | Fix |
|---|-----------|-----------|-----------|-----|

### Strengths
- What's working well (reinforce good patterns)

### Verdict: PASS / CONDITIONAL / FAIL
```

### Step 4 — Handoff

- If standalone → present report to user
- If called from Atlas/Athena → return structured findings for orchestrator to act on
- If FAIL verdict → block merge and create fix tasks

## Integration Points

- **Atlas Phase 4.2**: Can be invoked after visual verification for deeper analysis
- **Athena Review Phase**: Can run alongside code-reviewer and security-reviewer
- **Brainstorm Phase 2**: Can validate design options during convergence

</Design_Critique>
