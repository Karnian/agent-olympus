---
name: a11y-audit
description: WCAG 2.2 AA accessibility audit via code review — no browser tools required
level: 2
aliases: [a11y-audit, accessibility-audit, 접근성검사, 접근성감사, a11y-check, wcag-audit, アクセシビリティ監査]
---

<A11y_Audit>

## Purpose

A11y Audit performs a comprehensive WCAG 2.2 AA accessibility audit through code review alone — no browser tools, no axe-core, no runtime required. It systematically checks source code against 15 critical accessibility criteria and produces a structured compliance report.

## Use_When

- User says "a11y audit", "accessibility check", "접근성 검사", "wcag audit"
- Before merging frontend changes
- When accessibility concerns are raised
- As part of `/ui-review` umbrella skill

## Workflow

### Step 1 — Scope Detection

Identify frontend files to audit:
```bash
# If on feature branch
git diff --name-only origin/main | grep -E '\.(tsx|jsx|vue|svelte|css|scss|html)$'
# Or audit specific directory
find src/components -name '*.tsx' -o -name '*.jsx' -o -name '*.vue'
```

### Step 2 — Automated Code Checks

Spawn Aphrodite with accessibility focus:

```
Task(subagent_type="agent-olympus:aphrodite", model="sonnet",
  prompt="Perform a WCAG 2.2 AA accessibility audit on: <files>

  Check these 15 criteria systematically:

  **Images & Media**
  1. Every <img> has meaningful alt text (or alt='' + aria-hidden for decorative)
  2. Video/audio has captions or transcripts

  **Forms & Inputs**
  3. Every form input has a visible <label> with htmlFor/for association
  4. Forms have aria-describedby for error messages and help text
  5. Error states are conveyed beyond color alone (icon + text)

  **Interactive Elements**
  6. Interactive elements use semantic HTML (<button>, <a>, <input>) not <div onClick>
  7. Custom components have correct ARIA roles matching WAI-ARIA APG patterns
  8. aria-label/aria-labelledby present on elements without visible text

  **Structure & Navigation**
  9. Heading hierarchy is logical (h1→h2→h3, no skips)
  10. Page has landmark regions (<main>, <nav>, <header>, <footer>)
  11. Links have descriptive text (not 'click here' or 'read more' alone)

  **Focus & Keyboard**
  12. Focus styles present — no outline:none without replacement
  13. Modal/dialog has focus trap and returns focus on close
  14. tabindex usage correct (0 for focusable, -1 for programmatic, never > 0)

  **Dynamic Content**
  15. Dynamic content uses aria-live regions (polite or assertive)

  **Additional checks**
  - Touch targets ≥ 44x44px (WCAG 2.5.8)
  - Color contrast ratios (flag hardcoded low-contrast color pairs)
  - prefers-reduced-motion respected for animations
  - Page <title> present and descriptive

  For each finding:
  - Reference WCAG success criterion (e.g., 1.1.1, 2.4.6)
  - Rate severity: CRITICAL (blocker), HIGH (significant), MEDIUM (should fix), LOW (enhancement)
  - Cite exact file:line
  - Provide the fix code snippet

  Output format:
  ## A11y Audit Report
  ### Summary
  - Files audited: N
  - Total issues: X (🔴 Y critical, 🟠 Z high)
  - WCAG 2.2 AA compliance: PASS / PARTIAL / FAIL

  ### Findings
  | # | WCAG | Criterion Name | Severity | File:Line | Issue | Fix |
  |---|------|---------------|----------|-----------|-------|-----|
  ")
```

### Step 3 — Compliance Scoring

Calculate compliance across the 4 WCAG principles:

```markdown
## WCAG Compliance Scorecard

| Principle | Checks | Pass | Fail | Score |
|-----------|--------|------|------|-------|
| Perceivable (1.x) | | | | |
| Operable (2.x) | | | | |
| Understandable (3.x) | | | | |
| Robust (4.x) | | | | |

**Overall: X/Y criteria met — [PASS/PARTIAL/FAIL]**
```

### Step 4 — Remediation Plan

For PARTIAL or FAIL verdicts, produce prioritized fix list:
1. Critical violations first (blocking for users)
2. High violations (significant barriers)
3. Quick wins (easy fixes with high impact)

## Integration Points

- **Atlas/Athena Review Phase**: Run alongside code-reviewer as a parallel reviewer
- **Themis Quality Gate**: Can extend Themis checks with a11y-specific criteria
- **CI/CD**: Report can be formatted for PR comments

</A11y_Audit>
