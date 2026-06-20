# Codex Interop v1 — "delegate the goal, verify externally" (rev 1)

> Provenance: 3-round deep-research + Codex consultation (2026-06-20). Round 3 was
> an adversarial re-review (26-agent web pass + Codex as devil's-advocate) that
> **trimmed an over-built earlier plan**. See [[project-codex-advanced-invocation]]
> memory for the full trail. Verdict: **CORRECT-WITH-CHANGES** — spine right,
> day-one scope was too big; lean on Codex-native primitives, keep Olympus narrow.

## Problem

Olympus drives Codex only via single-shot `/ask codex` (`codex exec --json
--ephemeral`). We want (a) goal-oriented/agentic Codex delegation (not one-shot
Q&A) and, eventually, (b) Olympus capability usable BY Codex. The hard infra
already exists in-repo (`codex-appserver.mjs` multi-turn; `codex-exec.mjs` JSONL;
`loop-guard.mjs`/`phase-runner.mjs` caps). The risk is **over-building** custom
equivalents of primitives Codex now ships natively (H1-2026: native `/goal`,
native subagents, native hooks with Stop-continuation, native plugin + MCP
bundling, SKILL.md as an open standard).

## Goal (v1 = interop, not orchestration)

Hand Codex a **structured goal**, let **Codex's own native subagents/goal loop**
do the work, and have **Olympus verify the result externally** (run the tests
itself — never trust the agent's self-report) and loop under hard caps. Keep
Olympus's unique value — **cross-model (Claude+Codex+Gemini) coordination +
external verification + loop-guard** — in the Claude host, NOT pushed into a
Codex-facing control plane.

Reframe vs the original plan: **delegate the goal; don't push the machinery.**

## Scope

| | Item |
|---|---|
| KEEP | Tier-1 Codex goal handoff as an external-verify + loop-guard **wrapper around the existing `codex-exec.mjs`**; AGENTS.md unification; single-**source** philosophy; `Task()`→tool-call insight (validated: Codex plugins cannot define subagents); cross-model coordination + verification kept in the host |
| LEAN (use native, don't reimplement) | Codex native `/goal` (0.128+), native subagents (`.codex/agents/*.toml`, `agents.max_threads`/`max_depth`), `--output-schema`, `codex exec resume`, native hooks (Stop `{decision:"block"}` = loop-guard) |
| CUT (v1) | broad "Olympus MCP control plane" — **esp. `start_worker`/`start_team` exposed to Codex** (highest regret: Codex→Olympus→Codex recursion/cost/cancel/authority; native will replace it); `app-server` as a public primitive (keep behind experimental flag); wholesale 35-skill mirroring (ship 3-5); `--include-plan-tool` dependency; dual skill-**body** render pipeline; Gemini as a co-equal leg |

## Out of scope (explicit, deferred)

- **Olympus MCP server** as a broad capability layer. A NARROW status-only server
  (`monitor_run`/`collect_worker`/`record_verification`, `enabled=false` default,
  `default_tools_approval_mode="prompt"`) is considered ONLY **after HU-01 eval**
  proves cross-model value, and must be designed against the MCP **Tasks**
  extension (2026-07-28 RC — future, not final).
- **`app-server` (Tier-2) steered sessions** as a user primitive — only if an eval
  justifies multi-turn steering over the exec+resume loop.
- **Gemini propagation** — frozen behind a capability flag pending the separate
  Gemini-CLI-deprecation check (reported 2026-06-18; unverified).
- **Skill-body render pipeline** — SKILL.md is portable; adapters only for
  host-specific artifacts + placement/permission glue.

## Open decisions (resolve during impl)

1. **AGENTS.md ⇄ CLAUDE.md unification — RESOLVED (2026-06-21, joint Claude+Codex review).**
   Direction **(b)**: `AGENTS.md` = canonical concise shared instruction file;
   `CLAUDE.md` = `@AGENTS.md` import + a THIN Claude-runtime-only layer. NOT a symlink
   (the files serve different purposes; a symlink would either bloat Codex past its
   cap or strip Claude's context) and NOT two independent files (drift = current
   failure mode).
   - **Decisive facts:** Claude Code reads `CLAUDE.md` only (NOT `AGENTS.md`) and the
     official Anthropic guidance IS this `@AGENTS.md`-import pattern; `@path` imports
     resolve relative to the importing file, 4-hop max, treated as inline ([memory.md](https://code.claude.com/docs/en/memory.md)).
     Codex loads `AGENTS.md` (global→root→cwd chain, nested merged) but STOPS at
     `project_doc_max_bytes` = **32 KiB default** (overflow silently truncated); `AGENTS.md`
     has no `@import` (flat markdown, can only REFERENCE other docs for on-demand reading).
   - **Operative constraint:** current `AGENTS.md` is already ~24,810 B (~76% of the 32 KiB
     cap). Migration is curation-UNDER-BUDGET, not a merge: put SUMMARIES + `docs/` links in
     `AGENTS.md`, move deep internals to `docs/`. Aligns with the repo's own `harness-init`
     doctrine ("AGENTS.md = TOC, docs/ = knowledge base").
   - **Target:** `AGENTS.md` (≤32 KiB: identity, architecture, dir map, key conventions
     [zero-dep/ESM/fail-safe/atomic/schemaVersion], short add-checklists, test/lint commands,
     state-lifecycle summary, adapter-priority summary, concise catalogs, "read docs/X when
     touching Y" routing) + `CLAUDE.md` (`@AGENTS.md` + Claude-only deltas) +
     `docs/internals/{permission-mirroring,credentials,worker-adapters}.md` + `docs/testing.md`
     (the heavy CLAUDE.md sections — permission-mirroring ~150 lines, Gemini credentials
     ~120 lines, supervisor deep-dive — move here).
   - **Biggest risk:** `AGENTS.md` crossing 32 KiB → most-important instructions silently
     lost to truncation. Check byte size in CI.
2. **`--ephemeral` removal for resume.** `codex-exec.mjs` hardcodes `--ephemeral`
   (`_buildSpawnArgs`, ~line 117) and the supervisor hardcodes `ephemeral:true`
   (`supervisor-opts.mjs` ~line 38). The "use `codex exec resume` for multi-stage"
   story is BLOCKED until a non-ephemeral/persistent mode is added. Add `opts.persist`
   (omit `--ephemeral`, capture session id); keep the single-shot path unchanged.

## Architecture — the `codex-goal` flow (Tier-1)

```
goal packet (stdin)
  → codex exec --json --output-schema <schema> -a never -s workspace-write -C <worktree>
      (prompt instructs Codex to use its NATIVE explorer/tester/reviewer subagents)
  → collect JSONL events + final structured message
  → Olympus parses result, then EXTERNALLY verifies (Themis runs tests/lint itself)
  → PASS → return result ; FAIL → `codex exec resume <session>` with the failures
      (bounded by loop-guard caps; worktree isolates changes)
```

- Permission tier mirrored via the existing `codex-approval.mjs` (`-a never -s …`).
- Worktree isolation via the existing `worktree.mjs`.
- Caps via the existing `loop-guard.mjs` (max iterations / same-error-3× / review rounds).
- External verification via the existing `agent-olympus:themis` (READ-ONLY PASS/FAIL).
- `--output-schema` is **best-effort, not enforced** (can be dropped when MCP/tools
  active) → parse defensively; the external test verdict is the source of truth.

## Files

### NEW
- `scripts/codex-goal.mjs` — the Tier-1 wrapper (goal packet → exec → parse →
  Themis verify → resume loop under loop-guard). Zero-dep ESM, fail-safe.
- `scripts/test/codex-goal.test.mjs` — node:test (happy path, schema-miss fallback,
  verify-fail→resume loop, cap-hit STOP, ephemeral-vs-persist).
- `.ao/schemas/codex-goal-result.schema.json` — structured result contract (below).
- `skills/codex-goal/SKILL.md` — Claude-side trigger/recipe (`/codex-goal`).
- `.codex/agents/{explorer,tester,reviewer}.toml` — Codex native subagent roles.
- `.agents/skills/olympus-goal/SKILL.md`, `olympus-verify/SKILL.md`,
  `olympus-review/SKILL.md` — 3 Codex-side skills (core format, NO `Task()` bodies).

### CHANGED
- `scripts/lib/codex-exec.mjs` — add `opts.persist` (omit `--ephemeral`, capture
  `session_id`/`thread_id`) + a resume spawn path. Single-shot path byte-unchanged.
- `AGENTS.md` (+ `CLAUDE.md`) — unify per Open Decision 1; add an Olympus handoff /
  verification-commands section Codex reads natively.

## Goal packet (handoff format) + result schema

Goal packet (what Olympus sends Codex):
```
# Goal / # Definition of Done / # Scope (in+out) / # Context / # Environment
(cwd, sandbox, budget, parallelism) / # Reporting (return JSON matching schema)
```

`codex-goal-result.schema.json` (final structured message):
```
{ summary, files_changed[], verification: { commands[], results[] },
  unresolved_risks[], follow_ups[] }
```

## Verified facts & volatile (re-confirm vs live binary at build)

- `--include-plan-tool` is NOT a `codex exec` flag (confirmed: absent in `codex
  exec --help`). It lives on `codex mcp-server`'s `codex` tool. Use `--output-schema`.
- Confirmed present: `--json`, `--output-schema`, `-o/--output-last-message`,
  `-s/--sandbox`, `codex exec resume [SESSION_ID|--last] [PROMPT]`.
- Olympus `full-auto` is an INTERNAL approval-level token (→ `-s danger-full-access`),
  NOT the deprecated CLI `--full-auto` flag → cosmetic only, no runtime change needed.
- `.codex/config.toml` loads only in TRUSTED projects.
- `codex doctor` reports 0.141 available (0.140 installed) → all flags volatile;
  re-run `codex exec --help` / `codex app-server --help` before wiring.

## Ship order

1. AGENTS.md⇄CLAUDE.md unification + 3 Codex-side skills (cheapest, highest-leverage).
2. `codex-exec.mjs` `opts.persist` + `scripts/codex-goal.mjs` + result schema +
   `.codex/agents/*.toml` + `skills/codex-goal/SKILL.md` + tests.
3. (Deferred) narrow status-only MCP — only after HU-01 eval; design vs MCP Tasks.
4. (Deferred) app-server Tier-2 — only if eval justifies steering.

## Implementation notes

- Branch first: `git checkout -b feat/codex-goal` (repo auto-pushes `main` commits
  to PUBLIC origin — never commit on `main`).
- Run `node --test 'scripts/test/**/*.test.mjs'` (2289 tests) green before/after.
- Keep all new scripts fail-safe (catch → safe default → exit 0) per repo conventions.

## Provenance / key sources

- Codex CLI: developers.openai.com/codex (noninteractive, cli/reference, subagents,
  plugins/build, hooks); `--include-plan-tool` removal corroborated by openai/codex
  PR #5384 + live `codex exec --help`.
- Multi-agent evidence: Anthropic orchestrator-worker (90.2% / ~15× tokens);
  Magentic-One Task/Progress Ledger (arXiv 2411.04468) ↔ phase-runner+loop-guard;
  METR (o3 reward-hacked 30.4%) → external verification mandatory.
- Reference impl for single-source→multi-harness: github.com/wshobson/agents.
