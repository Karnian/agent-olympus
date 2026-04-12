---
name: teach-design
description: Capture project-specific brand colors, typography, and design conventions into .ao/memory/design-identity.json for auto-injection into designer/aphrodite subagents
---

<Teach_Design_Skill>

## Purpose

`/teach-design` is a one-time setup flow that captures the project's visual
identity — brand colors, typography tokens, spacing scale, component library,
conventions — and persists it to `.ao/memory/design-identity.json`. From that
point onward, every `designer`, `aphrodite`, and `ui-review` subagent spawn
automatically receives this identity as prompt context via `subagent-start.mjs`.

The goal: stop re-stating "we use Fraunces, not Inter" on every design review.

## Use_When

- Starting Agent Olympus on a new frontend project
- Brand guidelines have changed and you want the agents to learn the new system
- Re-running to merge additional fields (deep-merge: objects recurse, arrays replace)
- User says: "teach-design", "learn our design system", "design brief"

## Do_Not_Use_When

- You only need a one-off design critique — use `/ui-review` instead
- The project has no UI surface (pure backend / CLI)

## Workflow

### Step 1 — Detect existing identity

Read `.ao/memory/design-identity.json` if it exists. Show the current contents
as the baseline so the user can see what's already captured.

```bash
node -e '
  import("./scripts/lib/design-identity.mjs").then(async (m) => {
    const existing = await m.loadIdentity();
    console.log(JSON.stringify(existing, null, 2));
  });
'
```

### Step 2 — Auto-detect from project files

Scan for common design-token sources and propose field values to the user:

- `tailwind.config.{js,ts,cjs,mjs}` → `theme.colors`, `theme.fontFamily`, `theme.spacing`
- `package.json` → `dependencies` for component library detection (`@radix-ui/*`, `@mantine/*`, `@chakra-ui/*`, `antd`, `@mui/*`)
- `src/styles/theme.{css,scss}` or `src/theme.{ts,js}` → CSS custom properties
- `src/design-tokens.json` or `tokens.json` → token spec files

Present each auto-detected value with a confirm/edit prompt; do NOT auto-save.

### Step 3 — Interview for missing fields

For any field that could not be auto-detected, ask the user directly:

1. **Brand name** — one line, e.g. "Acme"
2. **Primary brand colors** — up to 5 hex values, most important first
3. **Fonts** — display family, body family, mono family (if distinct)
4. **allowedFonts** — explicit list that overrides the ui-smell-scan font blacklist
   (e.g. `["Inter"]` if your brand legitimately uses Inter)
5. **Spacing scale** — base unit (4px or 8px) + ratio
6. **Component library** — `radix`, `mantine`, `chakra`, `antd`, `mui`, `custom`, etc.
7. **Conventions notes** — free-form: "we avoid gradients", "no rounded-full on buttons", etc.

### Step 4 — Diff preview

Before saving, show the diff between existing and proposed merged identity.
Ask the user to confirm. The merge semantics are:

- **Objects**: deep-merge (existing keys survive)
- **Arrays**: REPLACE (explicit overwrite so `allowedFonts` stays precise)
- **Scalars**: replace

### Step 5 — Save

```bash
# IMPORTANT: env var MUST be set BEFORE `node`, not as a positional arg after `-e`.
UPDATE='<the confirmed update object>' node -e '
  import("./scripts/lib/design-identity.mjs").then(async (m) => {
    const update = JSON.parse(process.env.UPDATE || "{}");
    const result = await m.saveIdentity(update);
    console.log(JSON.stringify(result, null, 2));
  }).catch((err) => { console.error("teach-design save failed:", err.message); process.exit(1); });
'
```

The file is written atomically with `mode: 0o600` to `.ao/memory/design-identity.json`
via `scripts/lib/memory.mjs`. `schemaVersion: 1` is stamped automatically.

### Step 6 — Confirm auto-injection

Remind the user that from now on, any `Task(subagent_type="agent-olympus:designer")`,
`Task(subagent_type="agent-olympus:aphrodite")`, or `/ui-review` invocation will
receive the identity as prompt context (with a 2KB budget cap).

## Output Format

```
## Design Identity Captured

| Field | Value |
|-------|-------|
| Brand | Acme |
| Primary colors | #0b0c0f, #5a4fe8, #f4f5f7 |
| Display font | Fraunces |
| Body font | Söhne |
| Allowed fonts | Fraunces, Söhne |
| Spacing base | 4px geometric |
| Components | radix |

Saved to `.ao/memory/design-identity.json` (schemaVersion: 1).

**Auto-injection**: designer, aphrodite, and ui-review subagents will now
reference this identity on every invocation.
```

## Iron Laws

1. **NEVER overwrite without showing the diff.** Users must confirm merges explicitly.
2. **NEVER write outside `.ao/memory/`.** The file is worktree-shared and
   exempt from SessionEnd cleanup.
3. **ALWAYS stamp `schemaVersion: 1`.** Forward compat loaders refuse higher versions.
4. **NEVER block on disk errors.** If the write fails, report it to the user
   and continue — the saveIdentity() helper returns `{ok: false, errors: [...]}`.

## Integration

- **scripts/lib/design-identity.mjs** — persistence + merge + 2KB projection
- **scripts/lib/memory.mjs** — atomic JSON I/O under `.ao/memory/`
- **scripts/lib/subagent-context.mjs** — injects the summary into designer/aphrodite/ui-review prompts
- **scripts/subagent-start.mjs** — hook entry point that reads the bundle

## Rollback

- To disable the injection entirely: set `.ao/autonomy.json` → `{ "memory": { "disabled": true } }`
- To delete the identity: remove `.ao/memory/design-identity.json`
- To forward-compat break it: bump `schemaVersion` above 1 — loaders will return `{}`

</Teach_Design_Skill>
