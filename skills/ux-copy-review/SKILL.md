---
name: ux-copy-review
description: Review UI copy for clarity, consistency, tone, and inclusivity — error messages, CTAs, empty states, labels
level: 2
aliases: [ux-copy-review, 카피리뷰, copy-review, microcopy-review, 문구검토, UXライティング]
---

<UX_Copy_Review>

## Purpose

UX Copy Review evaluates all user-facing text in the interface: error messages, button labels, empty states, tooltips, confirmation dialogs, onboarding text, and navigation labels. It checks for clarity, consistency, appropriate tone, and inclusivity.

## Use_When

- User says "review copy", "check the text", "카피 리뷰", "문구 검토"
- Before release — as a copy quality gate
- When users report confusion about UI messaging
- As part of `/ui-review` umbrella skill

## Workflow

### Step 1 — Copy Extraction

Identify all user-facing text in scope:

```
Task(subagent_type="agent-olympus:aphrodite", model="sonnet",
  prompt="Extract all user-facing copy from these files: <scope>

  Categorize by type:
  1. **Labels** — buttons, links, nav items, form labels
  2. **Error messages** — validation errors, API errors, system errors
  3. **Empty states** — no data, no results, first-time use
  4. **Confirmation dialogs** — destructive actions, important decisions
  5. **Help text** — tooltips, descriptions, placeholder text
  6. **Status messages** — success, loading, progress indicators
  7. **Onboarding** — welcome, setup, tutorial text

  For each piece of copy, note the file:line location.")
```

### Step 2 — Copy Quality Review

Evaluate each piece of copy against these criteria:

```
Task(subagent_type="agent-olympus:aphrodite", model="sonnet",
  prompt="Review the extracted copy against these criteria:

  **Clarity**
  - Is the message understandable without context?
  - Does it use plain language (no jargon, no technical terms)?
  - Is the action clear from the label? (verb-first CTAs: 'Save changes' not 'OK')

  **Consistency**
  - Are similar actions labeled the same way across the app?
  - Is capitalization consistent? (Sentence case vs Title Case)
  - Are date/time/number formats consistent?
  - Is terminology consistent? (don't mix 'delete/remove', 'save/submit', 'cancel/close')

  **Tone**
  - Is the tone appropriate for the context? (friendly but not flippant for errors)
  - Are error messages helpful, not blaming? ('Email is required' not 'You forgot email')
  - Do destructive actions have clear warnings without being alarming?

  **Inclusivity**
  - Is language gender-neutral?
  - Are idioms/metaphors culturally neutral?
  - Is text screen-reader friendly? (no 'click here', no emoji-only labels)

  **Error Messages (special focus)**
  - Does each error explain WHAT happened?
  - Does each error explain HOW to fix it?
  - Are error messages specific? ('Password must be 8+ characters' not 'Invalid password')

  **Empty States**
  - Does each empty state explain WHY it's empty?
  - Does it suggest WHAT to do next?
  - Is the tone encouraging, not discouraging?

  For each issue:
  - Severity: CRITICAL/HIGH/MEDIUM/LOW
  - Current text (quoted)
  - Suggested replacement
  - Rationale

  Output format:
  ## UX Copy Review Report

  ### Copy Issues
  | # | Type | Severity | Current | Suggested | Rationale | File:Line |
  |---|------|----------|---------|-----------|-----------|-----------|

  ### Consistency Issues
  - Term conflicts: [list pairs]
  - Capitalization inconsistencies: [list]
  - Format inconsistencies: [list]

  ### Missing Copy
  - Components without error states: [list]
  - Components without empty states: [list]
  - Actions without confirmation: [list]

  ### Summary
  - Total issues: X
  - Verdict: PASS / NEEDS_POLISH / FAIL")
```

### Step 3 — Style Guide Extraction

If the project doesn't have a copy style guide, generate one from observed patterns:

```markdown
## Inferred Copy Style Guide
- **Tone**: [formal/friendly/casual based on codebase]
- **Capitalization**: [Sentence case / Title Case]
- **CTAs**: [verb-first pattern]
- **Errors**: [pattern observed]
- **Terminology**: [preferred terms list]
```

## Integration Points

- **Atlas/Athena**: Can run as part of review phase alongside code-reviewer
- **Brainstorm**: Can validate copy in design documents before implementation
- **i18n prep**: Copy audit naturally feeds into internationalization readiness

</UX_Copy_Review>
