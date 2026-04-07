---
schemaVersion: 1
module: spatial-design
---

# Spatial Design — reference module

## Domain

Layout, spacing rhythm, visual grouping, and negative space. Covers the
spacing scale, grid/gap systems, container widths, and the relationship
between whitespace and hierarchy.

## Top 5 principles

1. **One spacing scale, applied everywhere.** Ideally a 4px or 8px base with
   geometric multipliers (4/8/12/16/24/32/48/64). Arbitrary values break rhythm.
2. **Proximity communicates grouping.** Related items sit tighter than unrelated
   items by a factor of 2x+. This is Gestalt, not decoration.
3. **Whitespace scales with importance.** A hero deserves 96–128px of vertical
   breathing room; a form field needs 4–8px.
4. **Content width has an upper bound.** 65–75ch (about 680–800px) for body copy;
   wider lines become hard to read.
5. **Grids are a tool, not a cage.** Break the grid deliberately for the one
   thing that should command attention.

## Top 5 anti-patterns

1. **Nested card-soup.** `rounded-xl border shadow p-4` inside another
   `rounded-xl border shadow p-4` collapses hierarchy to mush.
2. **Equal spacing between unrelated items.** Everything feels equally important,
   which means nothing is.
3. **Random arbitrary values (`padding: 13px`, `margin: 27px`).** Fails the
   "does it fit the scale?" sniff test.
4. **Full-bleed containers with dense text.** Lines of 120+ characters that
   fatigue the reader.
5. **Forgetting responsive spacing.** Desktop padding literally half-emptying
   the mobile viewport.

## Worked example

```css
/* Bad — arbitrary values, nested cards, no rhythm */
.card { padding: 13px; margin: 27px 0; border-radius: 11px; border: 1px solid #ddd; box-shadow: 0 1px 4px rgba(0,0,0,0.1); }
.card .card { padding: 11px; margin: 9px; border-radius: 8px; border: 1px solid #eee; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }

/* Good — scale + single card level + proper rhythm */
:root {
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --space-7: 48px;
}
.card { padding: var(--space-5); border-radius: 12px; border: 1px solid var(--color-border); }
.card > * + * { margin-top: var(--space-4); } /* consistent internal rhythm */
.card .card { border: none; padding: 0; } /* no nesting — use dividers instead */
```
