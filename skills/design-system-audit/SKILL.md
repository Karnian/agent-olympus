---
name: design-system-audit
description: Audit codebase for design system compliance — tokens, consistency, component API, hardcoded values
---

<Design_System_Audit>

## Purpose

Design System Audit scans a codebase for design system compliance: hardcoded values that should be tokens, inconsistent component APIs, missing states/variants, and drift from established patterns. It produces a scorecard with a concrete remediation plan.

## Use_When

- User says "audit design system", "check tokens", "디자인 시스템 검사", "ds audit"
- Before major refactoring of UI components
- When design debt is suspected
- As part of `/ui-review` umbrella skill

## Workflow

### Step 1 — Inventory Discovery

Identify the project's design system surface:

```
Task(subagent_type="agent-olympus:explore", model="haiku",
  prompt="Explore the codebase to identify:
  1. Design token files (CSS custom properties, Tailwind config, theme files, token JSONs)
  2. Component library location (shared components directory)
  3. Style methodology (CSS Modules, Tailwind, styled-components, SCSS, etc.)
  4. Existing design system documentation (if any)

  Report file paths and patterns found.")
```

### Step 2 — Token Leak Detection

Scan for hardcoded values that should use tokens:

```
Task(subagent_type="agent-olympus:aphrodite", model="sonnet",
  prompt="Scan these frontend files for design token leaks:

  **Color leaks** — grep for:
  - Hex codes: #[0-9a-fA-F]{3,8}
  - RGB/HSL: rgb\(, rgba\(, hsl\(, hsla\(
  - Named colors in CSS: 'red', 'blue', etc.
  Exclude: token definition files, SVG fills, test files

  **Spacing leaks** — grep for:
  - Hardcoded px values in margin/padding: [0-9]+px
  - Hardcoded rem/em values not from scale
  Exclude: 0px, 1px (borders), token definitions

  **Typography leaks** — grep for:
  - Hardcoded font-size, line-height, font-weight outside token files
  - Font family declarations outside theme/config

  **Shadow/Radius leaks** — grep for:
  - Hardcoded box-shadow values
  - Hardcoded border-radius values

  For each leak:
  - Report file:line and the hardcoded value
  - Suggest the appropriate token (if token system exists) or flag for extraction

  Output: Token Leak Report with counts per category.")
```

### Step 3 — Component API Consistency

```
Task(subagent_type="agent-olympus:aphrodite", model="sonnet",
  prompt="Audit component API consistency:

  **Naming conventions**
  - Are prop names consistent? (variant/type/kind, size/scale, tone/intent/color)
  - Is polymorphism handled consistently? (as prop, component prop, render prop)
  - Are ref forwarding patterns consistent?

  **State & Variant coverage**
  For each UI component, check if these states exist:
  - Default, hover, active, focus, disabled
  - Loading, empty, error, success
  - Destructive/danger variant (where applicable)
  Create a state coverage matrix.

  **Visual scales**
  - Are size variants consistent across components? (sm/md/lg or xs/sm/md/lg/xl)
  - Are spacing scales consistent?
  - Are color/tone variants aligned?

  Output: Component Consistency Matrix.")
```

### Step 4 — Scorecard & Remediation

Compile into actionable scorecard:

```markdown
## Design System Audit Report

### Scorecard
| Category | Score | Details |
|----------|-------|---------|
| Token usage | ✅/⚠️/❌ | X hardcoded values found |
| Naming consistency | ✅/⚠️/❌ | Y inconsistencies |
| State coverage | ✅/⚠️/❌ | Z missing states |
| Component API alignment | ✅/⚠️/❌ | W mismatches |
| Theme/dark mode support | ✅/⚠️/❌ | |
| Documentation coverage | ✅/⚠️/❌ | |

### Token Leak Report
| Category | Count | Top Offenders |
|----------|-------|--------------|
| Colors | | |
| Spacing | | |
| Typography | | |
| Shadows/Radius | | |

### Missing State Matrix
| Component | hover | focus | disabled | loading | empty | error |
|-----------|-------|-------|----------|---------|-------|-------|

### Top 10 Remediation Items
1. [Priority-ordered fixes with file references]

### Overall: [HEALTHY / NEEDS_ATTENTION / CRITICAL_DEBT]
```

## Integration Points

- **Brainstorm Phase 2**: Architect can reference audit findings during design evaluation
- **Atlas Phase 3**: Execution agents can use audit as a pre-implementation checklist
- **Periodic**: Can be run on schedule to track design system health over time

</Design_System_Audit>
