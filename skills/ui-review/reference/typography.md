---
schemaVersion: 1
module: typography
---

# Typography — reference module

## Domain

Type choice, scale, rhythm, and hierarchy. Covers font family selection,
size scale, line height, letter spacing, weight ladders, and the relationship
between display type and body copy.

## Top 5 principles

1. **One typeface family is usually enough.** Pair only when there is a clear
   functional split (display vs. body, or serif vs. mono).
2. **Scale geometrically, not arithmetically.** Use a ratio (1.125 / 1.2 / 1.25 / 1.333)
   so sizes feel like a family, not a random stack.
3. **Body copy sits 16–18px, line-height 1.5–1.7.** Smaller bodies are fatiguing;
   tighter leading makes long passages bleed together.
4. **Contrast hierarchy with weight OR size, not both at once.** Bold + huge is
   shouting; reserve it for a single anchor per view.
5. **Optical alignment beats metric alignment for display type.** Large headings
   often need −1% to −3% tracking and a manual baseline nudge.

## Top 5 anti-patterns

1. **Inter / system-ui as the primary brand face.** It is the LLM-default fallback;
   a real project defines its own identity in `.ao/memory/design-identity.json`.
2. **Tailwind `text-{xs,sm,base,lg,xl}` everywhere without a defined scale.**
   Produces a flat, characterless ladder.
3. **Body copy at 14px with line-height 1.2.** Hard to read, no breathing room.
4. **Mixing three or more display faces on a single page.** Reads as amateur.
5. **`font-weight: bold` on every emphasis instead of semantic hierarchy.**
   Noise drowns out the actual primary action.

## Worked example

```css
/* Bad — LLM default stack, arbitrary sizes */
h1 { font-family: Inter, system-ui, sans-serif; font-size: 32px; font-weight: 700; line-height: 1.2; }
h2 { font-family: Inter, system-ui, sans-serif; font-size: 22px; font-weight: 700; line-height: 1.2; }
p  { font-family: Inter; font-size: 14px; line-height: 1.3; }

/* Good — project-specific face + geometric scale + breathing room */
:root {
  --font-display: "Fraunces", Georgia, serif;
  --font-body: "Söhne", -apple-system, sans-serif;
  --step-0: 1rem;
  --step-1: 1.125rem;
  --step-2: 1.266rem;
  --step-3: 1.424rem;
  --step-4: 1.602rem;
}
h1 { font-family: var(--font-display); font-size: var(--step-4); font-weight: 500; line-height: 1.1; letter-spacing: -0.02em; }
h2 { font-family: var(--font-display); font-size: var(--step-3); font-weight: 500; line-height: 1.2; }
p  { font-family: var(--font-body); font-size: var(--step-0); line-height: 1.6; }
```
