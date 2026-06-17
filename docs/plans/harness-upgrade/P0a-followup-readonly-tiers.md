# P0a follow-up — read-only agent tiers (aphrodite + themis)

> Completes the deferred read-only tiering from the v1.2.1 CHANGELOG. Generalizes the
> contract linter to **per-agent tier contracts**. Branch: `feat/readonly-tiers` (off main @ v1.2.1).
> **Rev 2 — Codex cross-review folded in (GO-WITH-CHANGES, 2026-06-18).**

## Context

v1.2.1 enforced one read-only tier (5 agents, exact `tools: Read, Grep, Glob, WebFetch,
WebSearch`). Two agents were deferred because they need MORE than the pure set:
- **`aphrodite`** — read-only UI/UX critique using **Claude Preview MCP** visual tools
  (`agents/aphrodite.md:10`: *"Use preview_screenshot and preview_snapshot when Claude
  Preview MCP is available"*).
- **`themis`** — quality gate that **runs tests/lint via Bash** (`agents/themis.md:11,15`:
  `node --test`, `node --check`, greps). Needs `Bash`.

## Resolved questions (Codex)
- **MCP tokens in `tools:`** — confirmed accepted (docs: exact `mcp__server__tool` + `mcp__server`/`mcp__server__*` patterns).
- **MCP names** — `mcp__Claude_Preview__preview_screenshot` / `mcp__Claude_Preview__preview_snapshot` confirmed (present in the live session's exposed tools). Use ONLY these two (least privilege; body names only these).
- **themis Bash** — UNSCOPED (AC verification runs arbitrary per-project test/lint commands; `Bash(node:*)` is too brittle). Tier 3 is a **"no-direct-edit verify tier," NOT "read-only"** — `Bash` is a known mutation vector, accepted because themis must run checks.

## Tier model

| Tier | Agents | Allowed `tools:` (exact) | Note |
|------|--------|--------------------------|------|
| **1 — pure read-only** | explore, architect, code-reviewer, security-reviewer, momus | `Read, Grep, Glob, WebFetch, WebSearch` | shipped v1.2.1 |
| **2 — read-only + visual MCP** | aphrodite | `Read, Grep, Glob, WebFetch, WebSearch, mcp__Claude_Preview__preview_screenshot, mcp__Claude_Preview__preview_snapshot` | new |
| **3 — no-direct-edit verify (Bash)** | themis | `Read, Grep, Glob, Bash` | new; Bash = verify only |

**Shared invariant (every contracted agent):**
- `tools:` token set must NOT contain any of `FORBIDDEN_TOOL_TOKENS = [Edit, Write, NotebookEdit, Agent, Task, Skill]` (note: NOT `memory` — that is a key, see below).
- Frontmatter must NOT declare the keys `disallowedTools` or `memory` (either would undermine the exact `tools:` contract: a `disallowedTools` could subtract a granted tool, and `memory: true` auto-enables Read/Write/Edit per docs).

## Changes

### 1. `agents/aphrodite.md` — Tier-2 allowlist (frontmatter only, body unchanged)
```yaml
tools: Read, Grep, Glob, WebFetch, WebSearch, mcp__Claude_Preview__preview_screenshot, mcp__Claude_Preview__preview_snapshot
```
Degrades gracefully if Claude Preview MCP is disconnected (those names just go unavailable; body already falls back to code-only review).

### 2. `agents/themis.md` — Tier-3 allowlist (frontmatter only, body unchanged)
```yaml
tools: Read, Grep, Glob, Bash
```
(themis body already says "never use Edit or Write" — accurate; Bash is the verify exception.)

### 3. `scripts/test/agent-frontmatter-contract.test.mjs` — generalize to per-agent contracts
- Replace `READONLY_AGENTS`/`READONLY_TOOLS` with:
```js
const AGENT_TOOL_CONTRACTS = {
  explore:            ['Read','Grep','Glob','WebFetch','WebSearch'],
  architect:          ['Read','Grep','Glob','WebFetch','WebSearch'],
  'code-reviewer':    ['Read','Grep','Glob','WebFetch','WebSearch'],
  'security-reviewer':['Read','Grep','Glob','WebFetch','WebSearch'],
  momus:              ['Read','Grep','Glob','WebFetch','WebSearch'],
  aphrodite:          ['Read','Grep','Glob','WebFetch','WebSearch',
                       'mcp__Claude_Preview__preview_screenshot',
                       'mcp__Claude_Preview__preview_snapshot'],
  themis:             ['Read','Grep','Glob','Bash'],
};
const FORBIDDEN_TOOL_TOKENS = ['Edit','Write','NotebookEdit','Agent','Task','Skill'];
const FORBIDDEN_KEYS_FOR_CONTRACTED = ['disallowedTools','memory'];
```
- For each contracted agent: assert `tools:` token set **exactly equals** its contract,
  assert tokens contain none of `FORBIDDEN_TOOL_TOKENS`, AND assert the frontmatter has
  **none** of `FORBIDDEN_KEYS_FOR_CONTRACTED`.
- `ALLOWED_KEYS` (global schema): keep `name, model, description, tools, disallowedTools`
  AND add `memory` so a NON-contracted agent using it wouldn't trip the unknown-key check
  — but contracted agents still forbid `disallowedTools`+`memory` per above.
- Keep all existing parser / first-colon split / paren-aware tokenizer / unknown-key /
  recognized-token checks. The existing `^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$` regex
  already accepts the aphrodite MCP tokens (verify).

### 4. Negative fixtures — add (in-memory, not real files)
- aphrodite contract + `Bash` → FAIL (exact mismatch / forbidden token)
- themis contract + `Agent` (and `Task`, `Skill`) → FAIL
- a contracted agent declaring `memory: project` → FAIL (forbidden key)
- a contracted agent declaring `disallowedTools: Read` → FAIL (forbidden key)
- a Tier-1 agent with a stray `mcp__Foo__bar` token → FAIL (exact mismatch)
- (keep existing: Write, Bash(git diff:*), Agent(executor), `tool:` key typo, `Reed` token)

## Fallback (only if runtime probe later fails)
If a post-release fresh-process probe shows aphrodite's exact MCP allowlist either (a)
isn't honored or (b) breaks agent load when the MCP server is disconnected, switch
aphrodite to a **`disallowedTools` denylist** (`Write, Edit, NotebookEdit, Bash, Agent,
Task, Skill`) so MCP tools inherit while mutation stays blocked — NOT unrestricted. (Update
the linter's aphrodite contract accordingly.) Do not implement now; documented for the probe.

## Verification (acceptance)
1. `node --test scripts/test/agent-frontmatter-contract.test.mjs` → passes (incl. new fixtures).
2. `node --test 'scripts/test/**/*.test.mjs'` → green, no regressions (do NOT hardcode the count).
3. `aphrodite.md` / `themis.md` parse; bodies unchanged except the added `tools:` line.
4. **Runtime** (post-release + restart, fresh `claude -p` probe): themis runs `Bash`
   (`node --test`) but cannot `Write`; aphrodite has Read + (when connected) the preview
   MCP tools, but cannot `Write`/`Bash`. The 5 Tier-1 agents stay enforced.

## Why not Athena / parallel
The two agents share one artifact (the contract linter), which must be generalized to
tiers atomically — parallel Codex workers would collide on that file. One small cohesive
change → single structured flow (plan → Codex validate → Codex implement → Claude review).

## Execution flow
1. ✅ Plan (this doc, rev 2 — Codex changes folded in).
2. ✅ Codex cross-validated → GO-WITH-CHANGES (incorporated).
3. 🛠️ Codex implements (workspace-write): 2 frontmatter edits + linter generalization + fixtures.
4. ✅ Claude reviews diff + runs full suite.
