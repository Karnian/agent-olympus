---
name: ui-review
description: Comprehensive UI/UX review — chains design-critique + a11y-audit + design-system-audit + ux-copy-review
level: 3
aliases: [ui-review, UI리뷰, 종합UI검토, full-design-review, ui-audit, UI검사, UI総合レビュー]
---

<UI_Review>

## Purpose

UI Review is the umbrella skill that orchestrates a comprehensive UI/UX quality review. It chains four focused skills in parallel, synthesizes their findings, and produces a unified report with a single go/no-go verdict.

This is the skill to use when you want a thorough, multi-dimensional evaluation of your UI before release.

## Use_When

- User says "full UI review", "종합 UI 검토", "review everything about the UI"
- Before major releases as a UI quality gate
- When significant frontend changes are being merged
- When the user wants a comprehensive assessment, not just one dimension

## Workflow

### Step 1 — Scope & Context

Determine what to review:
```bash
# Detect changed frontend files
git diff --name-only origin/main | grep -E '\.(tsx|jsx|vue|svelte|css|scss|html)$'
```

If Claude Preview MCP is available, start the preview server:
```
preview_start(name="<dev-server>")
```

### Step 2 — Parallel Review Lanes

Spawn all four review skills simultaneously:

```
# Lane 1: Design Critique (Nielsen + Gestalt)
Task(subagent_type="agent-olympus:aphrodite", model="sonnet",
  prompt="Perform design critique on: <scope>
  Focus on: Nielsen's 10 heuristics + Gestalt principles.
  Include visual hierarchy, consistency, user control, error prevention.")

# Lane 2: Accessibility Audit (WCAG 2.2 AA)
Task(subagent_type="agent-olympus:aphrodite", model="sonnet",
  prompt="Perform WCAG 2.2 AA accessibility audit on: <scope>
  Run the full 15-point code-review checklist.
  Score by WCAG principle (Perceivable, Operable, Understandable, Robust).")

# Lane 3: Design System Compliance
Task(subagent_type="agent-olympus:aphrodite", model="sonnet",
  prompt="Perform design system audit on: <scope>
  Check: token leaks, component API consistency, state coverage, naming patterns.")

# Lane 4: UX Copy Quality
Task(subagent_type="agent-olympus:aphrodite", model="sonnet",
  prompt="Perform UX copy review on: <scope>
  Check: clarity, consistency, tone, inclusivity, error messages, empty states.")
```

### Step 3 — Visual Verification (if preview available)

If Claude Preview MCP is running:
```
preview_screenshot(serverId="<id>")   # Visual check
preview_snapshot(serverId="<id>")      # Accessibility tree
preview_resize(serverId="<id>", preset="mobile")
preview_screenshot(serverId="<id>")   # Mobile check
preview_resize(serverId="<id>", preset="desktop")
```

Evaluate screenshots for:
- Blank pages or broken layouts
- Responsive behavior at mobile/tablet/desktop
- Visual hierarchy and readability
- Console errors via `preview_console_logs(level="error")`

### Step 4 — Unified Report

Synthesize all lanes into one report:

```markdown
## Comprehensive UI Review: [Scope]

### Executive Summary
- **Design Quality**: [PASS/CONDITIONAL/FAIL] — X issues
- **Accessibility**: [PASS/PARTIAL/FAIL] — Y issues (Z critical)
- **Design System**: [HEALTHY/NEEDS_ATTENTION/CRITICAL_DEBT]
- **UX Copy**: [PASS/NEEDS_POLISH/FAIL] — W issues

### Critical Issues (must fix before merge)
| # | Category | Finding | Fix | File:Line |
|---|----------|---------|-----|-----------|

### High Priority Issues
| # | Category | Finding | Fix | File:Line |
|---|----------|---------|-----|-----------|

### Medium & Low Issues
[Grouped by category]

### Strengths
- [What's working well — reinforce good patterns]

### Overall Verdict: PASS / CONDITIONAL / FAIL
- PASS: Ship it
- CONDITIONAL: Fix critical/high issues, then ship
- FAIL: Significant rework needed
```

### Step 5 — Handoff

- If standalone → present unified report to user
- If called from Atlas/Athena → return structured findings with verdict
- If FAIL → create remediation tasks per category
- If CONDITIONAL → list specific items to fix before merge

## Integration Points

- **Atlas Phase 4.2**: Replace or augment basic visual verification with full UI review
- **Athena Review Phase**: Add as a parallel reviewer alongside code-reviewer and security-reviewer
- **PR workflow**: Can be invoked by `/finish-branch` before merge decision
- **Periodic audits**: Can be scheduled for design health tracking

## Composition

This skill composes the following focused skills:
1. `/design-critique` — usability heuristic evaluation
2. `/a11y-audit` — WCAG 2.2 AA compliance
3. `/design-system-audit` — design system health
4. `/ux-copy-review` — copy quality and consistency

Each can also be invoked independently for targeted reviews.

</UI_Review>
