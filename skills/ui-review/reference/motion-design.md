---
schemaVersion: 1
module: motion-design
---

# Motion Design — reference module

## Domain

Transitions, micro-interactions, loading states, and choreography. Covers
duration curves, easing families, reduced-motion accessibility, and the
difference between purposeful motion and decorative motion.

## Top 5 principles

1. **Motion should have a job.** Transitions signal cause and effect, orient the
   user through state change, or confirm an action. Never just "look nice".
2. **Keep it short.** 150–300ms for most transitions; 400–600ms only for large
   spatial movements. Anything over 600ms feels sluggish.
3. **Prefer easing-out over easing-in for entrance.** Things that arrive should
   decelerate. Things that leave can accelerate.
4. **Honor `prefers-reduced-motion`.** Every non-essential animation must have a
   fallback that collapses duration to 0 or uses opacity alone.
5. **Group choreography > individual animation.** When many elements animate,
   stagger with a 30–60ms rhythm — don't fire everything at once.

## Top 5 anti-patterns

1. **Bounce / spring / elastic easing on UI transitions.** `cubic-bezier(0.68, -0.55, ...)`
   is an LLM default that rarely matches brand motion. Reserve for playful moments only.
2. **Every state change animated the same way.** Homogeneous motion is invisible
   and adds latency without value.
3. **Long page-load spinners with no progress hint.** The user starts to doubt.
4. **Ignoring `prefers-reduced-motion`.** Vestibular-disorder users actively get
   sick from parallax and auto-motion.
5. **Fade-in on every element.** The "everything appears" pattern creates visual
   noise and slows down perceived performance.

## Worked example

```css
/* Bad — bounce easing, no reduced-motion fallback, too long */
.modal {
  animation: enter 700ms cubic-bezier(0.68, -0.55, 0.265, 1.55);
}
@keyframes enter {
  from { transform: scale(0.5); opacity: 0; }
  to   { transform: scale(1);   opacity: 1; }
}

/* Good — purposeful, short, accessible */
.modal {
  animation: enter 220ms cubic-bezier(0.16, 1, 0.3, 1); /* ease-out-expo */
  will-change: transform, opacity;
}
@keyframes enter {
  from { transform: translateY(8px); opacity: 0; }
  to   { transform: translateY(0);   opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .modal { animation: fade 0.01ms; }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
}
```
