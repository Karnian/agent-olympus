---
schemaVersion: 1
module: color-and-contrast
---

# Color & Contrast — reference module

## Domain

Palette construction, semantic color roles, contrast ratios, and the use of
color for hierarchy vs. decoration. Covers WCAG 2.2 AA contrast targets,
dark-mode parity, and brand color expression.

## Top 5 principles

1. **Neutrals do the heavy lifting.** 80%+ of any good interface is a tuned gray
   scale. Saturated color is reserved for meaning (primary CTA, state, brand moment).
2. **Define semantic roles, not raw values.** `--color-text-primary` not `#111`.
   Roles let dark mode / theming / re-branding happen without a search-and-replace.
3. **Hit WCAG AA (4.5:1 body, 3:1 large).** AAA (7:1) for long-form reading.
   Pure gray text on colored backgrounds almost always fails.
4. **Tinted neutrals beat pure neutrals.** A hint of the brand hue in the grays
   (1–3% chroma) unifies the whole palette and avoids a washed-out feel.
5. **A single accent is often enough.** Two accents need a clear rule for when
   each fires. Three or more demands a full palette system.

## Top 5 anti-patterns

1. **Pure `#000000` backgrounds.** The LLM default. Reads as harsh, kills visual
   warmth. Use a slightly tinted dark neutral instead (e.g. `#0a0b10`).
2. **Gray-400 or gray-500 text on `bg-blue-600` / `bg-indigo-600`.** Canonical
   LLM slop — fails AA and looks cheap.
3. **Using saturated colors for borders.** Dilutes meaning and fights the content.
4. **Status colors (red / yellow / green) identical to brand colors.** Blurs
   "this is an error" vs. "this is our brand".
5. **Dark mode implemented via `invert()`.** Destroys all contrast relationships
   and makes images look radioactive.

## Worked example

```css
/* Bad — raw values, fails AA on the CTA */
.cta { background: #4f46e5; color: #9ca3af; } /* 2.4:1 — fails AA */

/* Good — semantic roles, passes AA */
:root {
  --color-bg-primary: #0b0c0f;       /* tinted dark neutral */
  --color-fg-primary: #f4f5f7;
  --color-fg-muted: #a0a4ad;
  --color-brand: #5a4fe8;            /* brand accent */
  --color-brand-contrast: #ffffff;   /* guaranteed 4.5:1+ */
}
.cta {
  background: var(--color-brand);
  color: var(--color-brand-contrast);
}
body {
  background: var(--color-bg-primary);
  color: var(--color-fg-primary);
}
```
