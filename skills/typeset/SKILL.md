---
name: typeset
description: Typography-only pass — font choice, hierarchy, sizing, weight. Touches nothing else
level: 2
aliases: [typeset, typography-pass, type-only, 타이포]
---

<Typeset_Skill>

## Purpose

`/typeset` is one of four precision style-pass micro-skills. It adjusts ONLY
typography — font family, size, weight, line-height, letter-spacing, text
transforms. It does NOT touch layout, color, motion, or structure. Use it when
the copy reads wrong but everything else is right.

## Use_When

- Heading hierarchy feels off
- Body copy is too dense or too loose
- Font stack swap (e.g. adopting a new brand typeface)
- Right after `/teach-design` captures a new font identity

## Do_Not_Use_When

- You want to change spacing → use `/arrange`
- You want to change colors → `/normalize` or designer review
- You want a broader refinement → use `/polish`

## Workflow

### Step 1 — Invoke designer at sonnet

```
Task(subagent_type="agent-olympus:designer", model="sonnet",
  prompt="TYPESET pass on: <target files>
  Adjust ONLY: font-family, font-size, font-weight, line-height, letter-spacing, text-transform, text-align.
  Do NOT touch: color, layout, spacing, motion, copy strings.
  Respect .ao/memory/design-identity.json if present (use the allowedFonts list).
  Report: files touched, lines changed, typography changes made.")
```

### Step 2 — Scope-confirmation check

```bash
git diff | node -e '
  let s=""; process.stdin.on("data",c=>s+=c); process.stdin.on("end", async ()=>{
    const m = await import("./scripts/lib/micro-skill-scope.mjs");
    const r = m.checkScope(s, m.MICRO_SKILL_SCOPES.typeset);
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) { console.error("SCOPE VIOLATION:", r.violations.join(", ")); process.exit(1); }
  });
'
```

### Step 3 — Report

```
## Typeset: <component>

| Metric | Value |
|--------|-------|
| Files touched | 2 |
| Typography lines changed | 7 |
| Layout changes | 0 (enforced) |
| Color changes | 0 (enforced) |
| Scope violations | none |
```

## Iron Laws

1. **Typography-only** — layout=0, color=0, motion=0 or exit 1
2. **Honor design-identity.json allowedFonts** — never introduce a blacklisted font
3. **Sonnet tier only**

</Typeset_Skill>
