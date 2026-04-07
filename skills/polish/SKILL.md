---
name: polish
description: Final-pass micro-refinements — alignment, spacing rhythm, micro-detail. No structural changes
level: 2
aliases: [polish, final-pass, refine, 마감]
---

<Polish_Skill>

## Purpose

`/polish` is the final precision style-pass micro-skill in the set of four
(`/normalize`, `/polish`, `/typeset`, `/arrange`). It applies the last-10%
refinements that separate a working UI from a shipped one — pixel alignment,
micro-spacing rhythm, border-radius harmony, subtle hover states — without
introducing structural changes or new copy.

## Use_When

- Component is feature-complete and you want the "feels right" pass
- Right before shipping or demoing
- After `/normalize` + `/typeset` + `/arrange` have landed the major moves

## Do_Not_Use_When

- You need a redesign → use `/ui-review` or `/design-critique` first
- You want to change layout → use `/arrange`
- You want to re-token → use `/normalize`

## Workflow

### Step 1 — Scope

Polish should run on a small, well-defined target (single component or 2-3
related files). Avoid running on 20+ files — that's a redesign, not a polish.

### Step 2 — Invoke designer at sonnet

```
Task(subagent_type="agent-olympus:designer", model="sonnet",
  prompt="POLISH pass on: <target files>
  Focus on: alignment, spacing rhythm (4/8/16/24 scale), border-radius harmony,
  micro hover/focus states, pixel-level refinements.
  Do NOT: add new components, change copy, change layout structure, change colors.
  Prefer surgical edits over rewrites.
  Report: files touched, lines changed, specific refinements applied.")
```

### Step 3 — Scope-confirmation check

Polish accepts a wide scope but must still pass the classifier:
```bash
git diff | node -e '
  let s=""; process.stdin.on("data",c=>s+=c); process.stdin.on("end", async ()=>{
    const m = await import("./scripts/lib/micro-skill-scope.mjs");
    const r = m.checkScope(s, m.MICRO_SKILL_SCOPES.polish);
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) process.exit(1);
  });
'
```

### Step 4 — Report

```
## Polish: <component>

| Metric | Value |
|--------|-------|
| Files touched | 2 |
| Lines changed | 9 |
| Refinements | spacing rhythm (4→8), border-radius (6→8), hover transition |
| Structural changes | 0 |
| Copy changes | 0 |
| Scope violations | none |
```

## Iron Laws

1. **Small diff or bust** — if the diff is >40 lines, you're redesigning
2. **No new components, no new copy** — polish refines, doesn't invent
3. **Sonnet tier only**
4. **Exit 1 on scope violation**

</Polish_Skill>
