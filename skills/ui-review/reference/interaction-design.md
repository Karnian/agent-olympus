---
schemaVersion: 1
module: interaction-design
---

# Interaction Design — reference module

## Domain

Affordances, states (default / hover / focus / active / disabled / loading),
feedback, error recovery, and the tactile feel of controls. Covers form fields,
buttons, menus, modals, and the choreography of user action → system response.

## Top 5 principles

1. **Every interactive element has 5 states.** Default, hover, focus-visible,
   active, disabled. Missing any of them is a usability bug.
2. **Focus rings are non-negotiable.** `outline: none` without a replacement
   destroys keyboard accessibility.
3. **Give feedback within 100ms.** The user must know their click registered.
   Beyond 100ms without ack, they click again.
4. **Errors explain what and how to fix.** "Invalid input" is a failure.
   "Email must include @" is a recovery.
5. **Destructive actions require confirmation or undo.** One click should never
   permanently delete user data without a retrieval path.

## Top 5 anti-patterns

1. **Disabled buttons with no tooltip.** The user cannot tell WHY they can't click.
2. **`outline: none` with no focus-visible replacement.** Keyboard users get lost.
3. **Hover-only menus on touch devices.** Complete dead ends.
4. **Ghost buttons as primary CTAs.** Low affordance — users don't know to click.
5. **Inline errors that vanish when the field regains focus.** The user loses
   the context they need to fix the problem.

## Worked example

```tsx
/* Bad — no focus ring, no feedback, no disabled reason */
<button onClick={submit} disabled={!valid}>Save</button>

/* Good — complete state set, focus-visible, explained disabled, optimistic feedback */
<button
  type="button"
  onClick={submit}
  disabled={!valid || pending}
  aria-disabled={!valid || pending}
  aria-describedby={!valid ? "save-hint" : undefined}
  className="
    bg-brand text-brand-contrast
    hover:bg-brand-hover
    focus-visible:ring-2 focus-visible:ring-brand/50 focus-visible:outline-none
    active:translate-y-px
    disabled:bg-neutral-200 disabled:text-neutral-500 disabled:cursor-not-allowed
  "
>
  {pending ? "Saving…" : "Save"}
</button>
{!valid && <p id="save-hint" role="status">Complete all required fields to save.</p>}
```
