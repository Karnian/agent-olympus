---
name: normalize
description: Replace hardcoded CSS/JS values with design tokens. Surgical pass — does not alter layout or structure
---

<Normalize_Skill>

## Purpose

`/normalize` is one of four precision style-pass micro-skills. It replaces
hardcoded hex/rgb/px literals with `var(--token)` references from the project's
design system. It does NOT change layout, structure, or copy. Run it after a
feature lands to pay down style-debt in 10% shifts instead of full redesigns.

## Use_When

- After a feature merges that hardcoded brand colors or spacing values
- Before shipping a component to a shared library
- When teaching agents to preserve tokens automatically on future passes

## Do_Not_Use_When

- You want a layout change → use `/arrange`
- You want a typography pass → use `/typeset`
- You want a final micro-polish across everything → use `/polish`

## Workflow

### Step 1 — Scope

Identify target files:
```bash
git diff --name-only HEAD~5 | grep -E '\.(css|scss|tsx|jsx)$'
```

### Step 2 — Invoke designer at sonnet

```
Task(subagent_type="agent-olympus:designer", model="sonnet",
  prompt="NORMALIZE pass on: <target files>
  Replace hardcoded hex/rgb/px/em values with var(--token) references from the project design system (tailwind.config or theme.css).
  Do NOT change layout, structure, font family, or copy.
  Preserve every line count; edit in place.
  Report: files touched, lines changed, tokens introduced.")
```

### Step 3 — Scope-confirmation check

Before reporting success, verify the diff stays in-scope:
```bash
git diff | node -e '
  let s=""; process.stdin.on("data",c=>s+=c); process.stdin.on("end", async ()=>{
    const m = await import("./scripts/lib/micro-skill-scope.mjs");
    const r = m.checkScope(s, m.MICRO_SKILL_SCOPES.normalize);
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) process.exit(1);
  });
'
```

### Step 4 — Report

```
## Normalize: <component>

| Metric | Value |
|--------|-------|
| Files touched | 3 |
| Lines changed | 14 |
| Tokens introduced | --brand-primary, --spacing-3, --radius-md |
| Layout changes | 0 |
| Copy changes | 0 |
| Scope violations | none |
```

## Iron Laws

1. **Replace, don't redesign** — every line count must stay identical
2. **No layout deltas** — scope check enforces this
3. **Sonnet tier only** — no opus spend on a mechanical pass
4. **Exit 1 on scope violation** — never report success if you broke the lane

</Normalize_Skill>
