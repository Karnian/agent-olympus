# P0a — Enforced read-only agent tool-scoping + frontmatter linter

> Implements **HU-02b** (enforce per-agent read-only intent) + **HU-18** (agent
> contract linter). Cheapest, safest first step of the harness-upgrade backlog.
> Branch: `feat/hu-02b-agent-tool-scoping`. **Rev 2 — incorporates Codex plan review (GO-WITH-CHANGES, 2026-06-17).**

## Why

Read-only/review agents declare their read-only intent only in prose, which the model
can ignore — an autonomous run can have a "reviewer" silently edit files. Close that
hole with **enforced** frontmatter tool-scoping, and add a linter so it can't regress.

## Mechanism — `tools:` allowlist (verified)

Confirmed against current Claude Code docs (`code.claude.com/docs/en/sub-agents`):

- Markdown subagent frontmatter supports **both** `tools:` (allowlist) and
  `disallowedTools:` (denylist). We use the **`tools:` allowlist** because it is
  **more fail-safe**, not because the denylist is unsupported:
  - Omitting `tools:` **inherits ALL tools**.
  - An allowlist **denies any future / MCP mutating tool by default**; a denylist must
    enumerate every dangerous tool and silently widens when a new one appears.
- Enforcement applies when invoked via `Task`/`Agent(subagent_type="agent-olympus:…")`,
  including plugin-namespaced agents (`Task` is an alias of `Agent` per current docs). ✓
- ⚠️ This is **load-time** enforcement: a unit test can only validate the *contract*,
  not Claude Code's runtime enforcement (see Verification §B).

## Scope — restrict the 5 unambiguous, MCP-free read-only agents

Canonical read-only allowlist (exact set — no mutation, no shell, **no delegation**):
```yaml
tools: Read, Grep, Glob, WebFetch, WebSearch
```

| agent | role evidence | restrict? |
|-------|---------------|:--:|
| `explore` | "Fast codebase explorer" — body uses only Glob/Grep/Read | ✅ |
| `architect` | "structural integrity **review**" — READ-ONLY, no git/Bash | ✅ |
| `code-reviewer` | "Code quality **reviewer**" — feedback only | ✅ |
| `security-reviewer` | "Security vulnerability **detection**" — no edits | ✅ |
| `momus` | "Ruthless plan **validator**" — judges, never edits | ✅ |

The allowlist excludes — by exact-match — every mutation/escape tool: `Edit`, `Write`,
`NotebookEdit`, `Bash`, **and `Agent`/`Task`/`Skill`** (a read-only agent must not be
able to spawn a mutating sub-agent — the bypass Codex flagged) and **`memory`** (docs:
enabling memory auto-enables Read/Write/Edit).

### Deferred (NOT in P0a — reasons)

| agent | reason to defer |
|-------|-----------------|
| `aphrodite` | ⚠️ Codex: body relies on **read-only visual MCP tools** (`preview_screenshot`, `preview_snapshot`). A pure allowlist would strip them. Needs its own allowlist that adds the preview MCP tool names — handle in a follow-up, not P0a. |
| `themis` | READ-ONLY re: code BUT body requires **`Bash` only** to run tests/lint → separate "verify" tier (`tools: Read, Grep, Glob, Bash`). |
| `debugger` | "Root-cause analysis **& fix**" → needs `Edit`/`Write`. |
| `metis`, `prometheus`, `hermes` | planning may legitimately **write** plan/spec docs → judgment call; defer. |
| `ask` | invokes external-model CLIs (likely needs `Bash`) → defer. |
| `executor`, `hephaestus`, `designer`, `writer`, `test-engineer`, `atlas`, `athena` | implement / write tests / orchestrate → keep full tools. |

Caller note: with no `Bash`, `code-reviewer`/`security-reviewer` cannot run `git diff`
themselves — the **caller must pass the diff / changed-file scope** in the prompt. (No
behavior change needed; the orchestrator skills already pass scope.)

## Linter (HU-18) — `scripts/test/agent-frontmatter-contract.test.mjs`

`node:test`, zero-dep. **No reusable frontmatter parser exists in `scripts/lib`** (Codex
checked `subagent-context.mjs`, `micro-skill-scope.mjs` — neither parses agent
frontmatter), so write a small **robust** parser in the test:

1. **Key-order-agnostic** frontmatter parse (`atlas`/`athena` put `description` before
   `model`) — split each line on the **first `:` only** (descriptions contain colons).
2. **Schema** per `agents/*.md`: `name` present and equals the filename stem;
   `model ∈ {haiku, sonnet, opus}`; `description` non-empty.
3. **Unknown-key detection**: reject frontmatter keys outside
   `{name, model, description, tools, disallowedTools}` — a `tool:` typo would otherwise
   be read as "no `tools`" → inherit-all (silent widening).
4. **`tools:` tokenizer is paren-aware**: do NOT naively split on comma — preserve commas
   inside parentheses (`Bash(git diff:*)`, `Agent(a, b)`); split on top-level commas only.
5. **Read-only contract** — single source of truth:
   `READONLY_AGENTS = ['explore','architect','code-reviewer','security-reviewer','momus']`.
   Each MUST declare `tools:` whose token set **exactly equals**
   `{Read, Grep, Glob, WebFetch, WebSearch}` (exact match is strongest — auto-excludes
   `Edit/Write/NotebookEdit/Bash/Agent/Task/Skill/memory` and any typo).
6. **Allowlist token sanity** (all agents that declare `tools:`): every token is a
   recognized tool name (catch `Reed`/`Globb` typos that silently widen).
7. **Negative assertions** (prove the gate bites) using in-test fixtures, not real files:
   a `tools:` list containing `Write`, `Bash(git diff:*)`, `Agent(executor)`, a `tool:`
   key typo, and a `Reed` token must each FAIL the matrix/parse checks.
8. **Do NOT hard-code the full-suite test count** anywhere.

## Files

- **EDIT** (add one `tools:` line to frontmatter; body unchanged):
  `agents/explore.md`, `agents/architect.md`, `agents/code-reviewer.md`,
  `agents/security-reviewer.md`, `agents/momus.md`
- **NEW**: `scripts/test/agent-frontmatter-contract.test.mjs`
- No production/runtime code changes.

## Verification (acceptance)

### A. Contract (automated — the linter)
1. `node --test scripts/test/agent-frontmatter-contract.test.mjs` → passes (incl. negative fixtures).
2. `node --test 'scripts/test/**/*.test.mjs'` → still green, **no regressions**.
3. Every `agents/*.md` still parses as valid frontmatter; each edited body unchanged except the added `tools:` line.

### B. Runtime enforcement (manual — SEPARATE; the unit test does NOT prove this)
> Per Codex: a passing unit test validates the *contract file*, not Claude Code's runtime
> tool-gating. After implementation, verify enforcement out-of-band:
1. Restart the Claude Code session (subagents load at session start).
2. For each read-only agent, `Task`/`Agent`-invoke it with an adversarial prompt that
   tries `Write`/`Edit`/`Bash("touch probe")`/`Agent(executor)`.
3. Expect: tool unavailable/denied in the transcript; **no probe file created**.
4. Control: `Read`/`Grep` still work.
5. Note the limitation: distinguishing "model declined" from "runtime blocked" needs the
   tool-error/transcript signal.

## Out of scope (later HU items)
- `aphrodite` read-only + preview-MCP allowlist (follow-up).
- `themis` verify-tier (`Bash`-allowed).
- Planning-agent scoping (metis/prometheus/hermes); HU-02a injection gate (P0c).

## Execution flow (per goal)
1. ✅ Plan (this doc, rev 2 — Codex changes folded in).
2. ✅ Codex reviewed → GO-WITH-CHANGES (changes incorporated above).
3. 🛠️ Codex implements (workspace-write): the 5 frontmatter edits + the linter test.
4. ✅ I review Codex's diff + run the full suite + the negative checks.
