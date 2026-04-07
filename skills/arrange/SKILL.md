---
name: arrange
description: Layout & spacing rhythm pass — touches nothing else (no typography, no color, no copy)
level: 2
aliases: [arrange, layout-pass, spacing-pass, 배치]
---

<Arrange_Skill>

## Purpose

`/arrange` is one of four precision style-pass micro-skills. It adjusts ONLY
layout properties — display/flex/grid, padding/margin, gap, width/height,
alignment. It does NOT touch typography, color, motion, or copy. Use it when
the shapes are right but the rhythm is off.

## Use_When

- Spacing feels cramped or inconsistent
- Alignment is off-grid
- Responsive breakpoints need adjustment
- Right after `/typeset` has corrected type but the box model needs follow-up

## Do_Not_Use_When

- You want type changes → use `/typeset`
- You want color changes → `/normalize` or designer review
- You want a broader refinement → use `/polish`

## Workflow

### Step 1 — Invoke designer at sonnet

```
Task(subagent_type="agent-olympus:designer", model="sonnet",
  prompt="ARRANGE pass on: <target files>
  Adjust ONLY: display, position, flex/grid, padding/margin/gap, width/height, min/max dimensions, z-index, overflow, breakpoints.
  Do NOT touch: font-family, font-size, font-weight, color, background-color, transitions, animations, copy.
  Snap to the project's spacing scale (4/8 multiples).
  Report: files touched, lines changed, rhythm fixes applied.")
```

### Step 2 — Scope-confirmation check

```bash
git diff | node -e '
  let s=""; process.stdin.on("data",c=>s+=c); process.stdin.on("end", async ()=>{
    const m = await import("./scripts/lib/micro-skill-scope.mjs");
    const r = m.checkScope(s, m.MICRO_SKILL_SCOPES.arrange);
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) { console.error("SCOPE VIOLATION:", r.violations.join(", ")); process.exit(1); }
  });
'
```

### Step 3 — Report

```
## Arrange: <component>

| Metric | Value |
|--------|-------|
| Files touched | 2 |
| Layout lines changed | 8 |
| Typography changes | 0 (enforced) |
| Color changes | 0 (enforced) |
| Scope violations | none |
```

## Iron Laws

1. **Layout-only** — typography=0, color=0, motion=0 or exit 1
2. **Snap to the spacing scale** — no hardcoded odd pixel values
3. **Sonnet tier only**
4. **Scope violation = exit 1** — do not report success if out of lane

</Arrange_Skill>
