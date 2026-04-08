---
name: taste
description: Record, list, and prune aesthetic preferences in .ao/memory/taste.jsonl. Replayed automatically into designer/aphrodite/ui-review subagents
level: 2
aliases: [taste, taste-memory, aesthetic-prefs, taste-prune, 취향]
---

<Taste_Skill>

## Purpose

`/taste` is the user-facing surface for Agent Olympus's taste memory — the
sibling of wisdom that records *aesthetic* preferences (not facts). Anything
captured here is automatically injected into `designer`, `aphrodite`, and
`ui-review` subagent spawns via `scripts/lib/subagent-context.mjs`.

Wisdom answers "what did we learn?". Taste answers "what does the user *prefer*?".

## Use_When

- User says: "I prefer monochromatic palettes", "no rounded corners", "avoid bouncy easings"
- User asks for: "remember my taste", "save this preference", "taste prune"
- Cleaning up stale or wrong-direction preferences via `taste prune`

## Do_Not_Use_When

- Recording technical facts → use wisdom/`/sessions` instead
- One-off design critique → use `/ui-review` or `/design-critique`

## Subcommands

### `taste record`

Append a new taste entry. The implementer should call:
```bash
node -e '
  import("./scripts/lib/taste-memory.mjs").then(async (m) => {
    const r = await m.recordTaste({
      category: "color",       // typography | color | layout | motion | copy
      preference: "monochromatic with single accent",
      antiPreference: "rainbow gradients",
      confidence: "high",      // low | med | high
      source: "user",          // user | auto
    });
    console.log(JSON.stringify(r, null, 2));
  });
'
```

The entry is stamped with `schemaVersion: 1`, a UUID id, and an ISO timestamp.
FIFO prune keeps the file under 200 entries automatically.

### `taste list`

Show the most recent N entries (default 20):
```bash
node -e '
  import("./scripts/lib/taste-memory.mjs").then(async (m) => {
    const all = await m.loadTaste(20);
    console.log(JSON.stringify(all, null, 2));
  });
'
```

### `taste prune`

Explicit grammar — at least one of `--id`, `--category`, or `--before` must be
provided:

| Flag | Meaning | Example |
|------|---------|---------|
| `--id <uuid>` | Drop one specific entry | `taste prune --id 123e4567-...` |
| `--category <cat>` | Drop ALL entries of a category | `taste prune --category typography` |
| `--before <iso-date>` | Drop entries older than the cutoff | `taste prune --before 2026-01-01` |

```bash
# IMPORTANT: env vars MUST be set BEFORE `node`, not as positional args after `-e`.
ID="..." CAT="" BEFORE="" node -e '
  import("./scripts/lib/taste-memory.mjs").then(async (m) => {
    const r = await m.pruneTaste({
      id: process.env.ID || undefined,
      category: process.env.CAT || undefined,
      before: process.env.BEFORE || undefined,
    });
    console.log(JSON.stringify(r, null, 2));
    if (r.ok === false) process.exit(1);
  });
'
```

Returns `{ ok: true, removed: <count> }`. No-match prunes are no-ops with
`removed: 0` (not an error). Empty selectors return `{ ok: false, error: ... }`
to prevent accidental nukes.

## Iron Laws

1. **Taste lives in `.ao/memory/taste.jsonl`** — exempt from SessionEnd cleanup.
2. **schemaVersion: 1 on every line** — loaders skip lines with `schemaVersion > 1`.
3. **Categories are closed-set**: `typography | color | layout | motion | copy`.
   Any other value is rejected by `makeTasteEntry()`.
4. **Confidence is closed-set**: `low | med | high`. Default `med`.
5. **Pruning is explicit**: `taste prune` requires at least one selector. No
   "prune everything" without an explicit `--category` or `--before` cutoff.
6. **Auto-injection**: every `Task(subagent_type="agent-olympus:designer")`,
   `aphrodite`, or `/ui-review` invocation receives the last 20 taste entries
   inside a 1KB budget cap.

## Integration

- **scripts/lib/taste-memory.mjs** — record/load/prune + FIFO at 200 entries
- **scripts/lib/memory.mjs** — atomic JSONL I/O under `.ao/memory/`
- **scripts/lib/subagent-context.mjs** — `loadTasteEntries()` reads last 20 with 1KB cap
- **scripts/subagent-start.mjs** — formats the bundle into `additionalContext`

## Rollback

- Disable injection entirely: `.ao/autonomy.json` → `{ "memory": { "disabled": true } }`
- Delete the file: `rm .ao/memory/taste.jsonl`
- Forward-compat break: bump `schemaVersion` above 1 — readers skip the line

</Taste_Skill>
