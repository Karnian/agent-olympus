---
schemaVersion: 1
module: responsive-design
---

# Responsive Design — reference module

## Domain

Viewport adaptation, breakpoint strategy, fluid type, touch vs. pointer input,
and graceful degradation across devices. Covers container queries, safe areas,
orientation changes, and the mobile-first mindset.

## Top 5 principles

1. **Mobile-first.** Default styles target the smallest screen; media queries
   add capacity as viewport grows. Never the other way around.
2. **Fluid over fixed.** Use `clamp()` for type and spacing so layouts breathe
   between breakpoints instead of snapping awkwardly.
3. **Touch targets ≥ 44×44px.** Apple HIG / Material — smaller is literally
   unclickable on a phone for many users.
4. **Respect safe areas.** `env(safe-area-inset-*)` for notched devices.
   Content behind the notch is unreadable content.
5. **Container queries over viewport queries where possible.** A card should
   adapt based on its container, not the whole viewport.

## Top 5 anti-patterns

1. **Fixed pixel widths on form fields.** `width: 300px` overflows a 320px phone.
2. **Hover-only disclosure on touch devices.** No way to trigger.
3. **Tiny tap targets (`h-6 w-6` icon buttons).** Thumb-sized miss factories.
4. **Desktop designed first, then "shrunk down".** Produces crammed mobile
   experiences where content is just scaled rather than re-thought.
5. **Ignoring landscape orientation on mobile.** Fixed heights cover the entire
   viewport sideways.

## Worked example

```css
/* Bad — fixed widths, desktop-first, no touch target */
.card { width: 400px; padding: 20px; }
.close { width: 24px; height: 24px; }
@media (max-width: 768px) { .card { width: 300px; } }

/* Good — mobile-first, fluid, proper touch target */
.card {
  width: 100%;
  max-width: min(100% - 2rem, 42rem);  /* 2rem gutter, capped at 42rem */
  padding: clamp(1rem, 2.5vw, 1.5rem);
}
.close {
  min-width: 44px;
  min-height: 44px;
  display: grid;
  place-items: center; /* 24px icon centered inside 44px target */
}
/* Progressively add capacity */
@media (min-width: 768px) { .card { padding: clamp(1.5rem, 3vw, 2rem); } }
```
