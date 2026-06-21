# Codex Interop v1 — "delegate the goal, verify externally" (rev 3)

> Provenance: 3-round deep-research + Codex consultation (2026-06-20). rev 2 applies
> a two-validator cross-review (2026-06-21): **Momus** (Claude-side plan validator) =
> NEEDS-REVISION, **Codex** (live-0.140 probes) = SAFE-WITH-FIXES → reconciled, all
> fixes folded in below. rev 3 = round-2 convergence (Momus **APPROVE** / Codex **SAFE-WITH-FIXES**):
> budget table numbered + reconciled (5-vs-15), command snippets labeled shorthand, fail-safe narrowed
> for the exec helper. See [[project-codex-advanced-invocation]] memory for the trail.
> Verdict: **CORRECT-WITH-CHANGES** — spine right, scope trimmed, lean on Codex-native.

## Cross-review resolutions (rev 1 → rev 2)

Empirically verified by Codex probing the installed `codex-cli 0.140.0` (0.141 = help-only, runtime unverified):
- ✅ `thread.started.thread_id` from `--json` **resumes** via `codex exec resume <id>` (0.140).
- ✅ `codex exec` **does spawn** project `.codex/agents/*.toml` subagents — but ONLY in a
  **trusted** repo; an untrusted repo ignores `.codex` entirely. → trust preflight is mandatory.
- ❌ FIXED: `codex exec … -a never` errors ("unexpected argument '-a'"); `-a`/`-s` are GLOBAL
  flags and MUST precede `exec`. (The in-repo `codex-exec.mjs` already orders them correctly;
  rev 1's flow diagram was wrong.)
- ❌ FIXED: native `/goal` is NOT reachable from `codex exec` (probe: no durable goal created).
  Removed from v1; the loop is a structured goal PROMPT + external `exec resume`, not `/goal`.
- FIXED: `supervisor-opts.mjs` scope error; Themis read-only vs running tests; 32 KiB budget
  unsized; test-contract for `--ephemeral`; trust/budget/suggest-tier underspecification — all below.

## Problem

Olympus drives Codex only via single-shot `/ask codex` (`codex exec --json --ephemeral`).
We want goal-oriented Codex delegation (not one-shot Q&A) and, eventually, Olympus
capability usable BY Codex. The risk is **over-building** custom equivalents of primitives
Codex now ships natively (H1-2026: native subagents, native hooks, native plugin+MCP
bundling, SKILL.md open standard). Keep Olympus narrow; lean on native.

## Goal (v1 = interop, not orchestration)

Hand Codex a **structured goal prompt**, let **Codex's own native subagents** do the work,
and have **Olympus verify the result externally** (run the goal's checks itself — never trust
the agent's self-report) and loop under hard caps. Keep Olympus's unique value —
**cross-model coordination + external verification + loop-guard** — in the Claude host.
Reframe vs the original plan: **delegate the goal; don't push the machinery.**

## Scope

| | Item |
|---|---|
| KEEP | Tier-1 Codex goal handoff as an external-verify + loop-guard **wrapper around the existing `codex-exec.mjs`**; AGENTS.md unification; single-**source** philosophy; `Task()`→tool-call insight (validated: Codex plugins cannot define subagents); cross-model coordination + verification kept in the host |
| LEAN (use native, don't reimplement) | Codex native subagents (`.codex/agents/*.toml`, `agents.max_threads`/`max_depth`) — **verified to spawn in `exec` when the repo is trusted**; `--output-schema`; `codex exec resume` (thread_id-keyed); native hooks |
| CUT (v1) | broad "Olympus MCP control plane" — esp. `start_worker`/`start_team` exposed to Codex (highest regret: recursion/cost/authority); `app-server` as a public primitive; wholesale 35-skill mirroring (ship 3); `--include-plan-tool`; native `/goal` (NOT reachable from exec); dual skill-**body** render pipeline; Gemini as a co-equal leg |

## Out of scope (deferred)

- **Olympus MCP server** as a broad capability layer. A NARROW status-only server
  (`monitor_run`/`collect_worker`/`record_verification`, `enabled=false` default) only
  AFTER HU-01 eval proves cross-model value; design against the MCP **Tasks** extension
  (2026-07-28 RC — future).
- **`app-server` (Tier-2)** steered sessions — only if an eval justifies steering.
- **Gemini propagation** — frozen behind a flag pending the Gemini-CLI-deprecation check
  (reported 2026-06-18; unverified).
- **Skill-body render pipeline** — SKILL.md is portable; adapters only for host-specific glue.

## Open decisions

1. **AGENTS.md ⇄ CLAUDE.md unification — RESOLVED (2026-06-21, joint review).**
   Direction **(b)**: `AGENTS.md` = canonical concise shared file; `CLAUDE.md` = `@AGENTS.md`
   import + a THIN Claude-runtime-only layer. NOT a symlink (different purposes; would bloat
   Codex past cap or strip Claude context), NOT two independent files (drift).
   - **Decisive facts:** Claude Code reads `CLAUDE.md` only and the official Anthropic guidance
     IS this `@AGENTS.md`-import pattern (`@path`: relative-to-importer, 4-hop, inline-equivalent;
     [memory.md](https://code.claude.com/docs/en/memory.md)). Codex loads `AGENTS.md` but STOPS
     at `project_doc_max_bytes` = **32 KiB default** (overflow silently truncated); no `@import`
     in `AGENTS.md` (flat markdown, can only REFERENCE other docs).
   - **Byte budget (M2 fix — hard numbers):** current `AGENTS.md` = 24,810 B (re-measure exact
     bytes at build; set the CI threshold against the real current size); headroom to 32,768 B
     is only ~7.2 KiB. Target a **≤28,672 B (28 KiB) ceiling** for margin. Per-section budget:
     keep identity+architecture+dir-map+catalogs ≈ current; ADD only SUMMARIES (≤300 B each) of
     conventions/testing/state/adapter with `docs/` routing links; SHED any inlined detail to
     `docs/`. Wire a **hard CI check** (fail if `AGENTS.md` > 28,672 B).
2. **`--ephemeral` / persist — codex-exec.mjs ONLY.** `codex-exec.mjs` hardcodes `--ephemeral`
   in `_buildSpawnArgs` (line 117). Add an `opts.persist` branch (omit `--ephemeral`, capture
   `thread_id`). **`supervisor-opts.mjs` is NOT in scope** (M1 fix): `codex-goal.mjs` spawns
   `codex exec` directly via `codex-exec.mjs` and never calls `spawnTeam`/the supervisor (that
   `ephemeral:true` governs Athena app-server team threads only).
   - **Test contract (B1 fix):** the 6 existing argv assertions in `codex-exec.test.mjs:135-198`
     (`exec --json --ephemeral -` + `approvalIdx < execIdx` ordering) MUST stay green UNMODIFIED;
     add ≥1 new test asserting `_buildSpawnArgs({persist:true})` omits `--ephemeral`.

## Architecture — the `codex-goal` flow (Tier-1)

The **loop lives in `skills/codex-goal/SKILL.md` (Claude host)**, NOT in the Node CLI (M3 fix —
a Node script cannot spawn the Themis Task sub-agent). `codex-goal.mjs` is a thin spawn+parse helper.

```
1. Claude skill mints runId + creates an isolated git worktree (worktree.mjs)
2. codex-goal.mjs spawns:  codex -a never -s workspace-write exec --json [--output-schema <F>] -
      (GLOBAL flags BEFORE `exec`; child cwd = worktree, NO -C flag needed;
       prompt = structured goal packet instructing Codex to use its native subagents)
3. codex-goal.mjs collects JSONL → parses final structured message (best-effort)
4. Verification (external, in the worktree): run the goal's DoD commands under workspace-write
      in the worktree (disposable), CAPTURE output → Themis (READ-ONLY) JUDGES the captured
      output PASS/FAIL. Themis never executes writing tests itself (M3/Codex fix).
5. PASS → return; FAIL → loop: re-inject failures and re-run. loop-guard caps the loop.
```

- **Resume vs stateless (B2 fix):** preferred loop = `codex exec resume <thread_id>` (Codex-verified
  on 0.140). Ship a NEW resume wrapper in `codex-exec.mjs`. **Fallback (no resume):** fresh
  `codex exec` per iteration re-injecting the failure context — the **worktree persists changes on
  disk regardless of session**, so this degrades cleanly. Spike-verify resume on 0.141 before
  relying; default to stateless if unconfirmed.
- **Trust preflight (M-D fix):** before relying on `.codex/agents/*.toml`, verify the project is
  trusted / `.codex` config loaded (untrusted repos silently ignore `.codex`). Fail loudly with
  setup instructions if not.
- **suggest-tier policy (M-F fix):** the disposable worktree IS the write boundary — run codex at
  `-s workspace-write` confined to the worktree regardless of host tier (do NOT demote to read-only,
  which makes Codex "complete" without writing → guaranteed Themis-fail loop). Document rationale.
- **Budget caps (M-E fix) — explicit & enforced:** `maxExecInvocations=5`, `maxResumes=4`,
  per-`codex exec` wall-time ≤15 min, per-shell-command timeout ≤300 s, overall wall-time ≤30 min,
  `agents.max_threads≤4`, `agents.max_depth=1`, stop on context/token pressure. Enforce the invocation
  cap with a DEDICATED counter at **cap 5** — `registerIteration(runId, { cap: 5 })` (NOT the
  orchestrator's default-15 iteration cap) — plus `recordError` threshold 3 (same-error-3×); pass
  `runId`+`cwd` to every loop-guard call. loop-guard fails OPEN (`degraded:true` on FS error) → treat
  `degraded:true` as a HARD secondary stop (abort at `maxExecInvocations`) so a `.ao` write failure
  can't uncap spend.
- Permission flags via existing `codex-approval.mjs` (`buildCodexExecArgs` → `-a never -s <tier>`).
- **Command snippets** elsewhere in this doc (`codex exec …`, `codex exec resume <thread_id>`) are
  SHORTHAND; the canonical spawn is step 2 above (GLOBAL `-a`/`-s` BEFORE `exec`, child cwd = worktree).
- `--output-schema` is best-effort (m3): make it optional; key ALL pass/fail decisions off the Themis
  verdict, NEVER off structured-message presence; missing message → judge the worktree diff/output.

## Files

### NEW
- `scripts/codex-goal.mjs` — spawn+parse helper (goal packet → `codex exec` → parse). Zero-dep ESM, fail-safe. Does NOT run Themis or own the loop.
- `scripts/test/codex-goal.test.mjs` — node:test (parse happy path, schema-missing fallback, persist argv, suggest-tier→worktree, budget-cap STOP).
- `schemas/codex-goal-result.schema.json` — `{ summary, files_changed[], verification{commands[],results[]}, unresolved_risks[], follow_ups[] }`. (Tracked location; NOT `.ao/` which is gitignored.)
- `skills/codex-goal/SKILL.md` — Claude-side trigger + the verify/loop orchestration (worktree, Themis judge, loop-guard, budget caps, trust preflight).
- `.codex/agents/{explorer,tester,reviewer}.toml` — Codex native subagent roles.
- `.agents/skills/olympus-{goal,verify,review}/SKILL.md` — 3 Codex-side skills (core format, NO `Task()` bodies).
- `docs/internals/{permission-mirroring,credentials,worker-adapters}.md`, `docs/testing.md` — offload targets for the heavy CLAUDE.md sections (these dirs/files do NOT exist yet — create them).

### CHANGED
- `scripts/lib/codex-exec.mjs` — add `opts.persist` (omit `--ephemeral`, capture `thread_id` as the canonical resumable id) + a `resume` spawn path. Single-shot argv UNCHANGED (B1 test contract).
- `AGENTS.md` (canonical, ≤28 KiB) + `CLAUDE.md` (`@AGENTS.md` + Claude-only deltas) — per Open Decision 1; move permission-mirroring (~150 lines), Gemini credentials (~120 lines), supervisor deep-dive into `docs/internals/`.

## Goal packet (handoff) + result schema

Packet: `# Goal / # Definition of Done (incl. exact verification commands) / # Scope (in+out) /
# Context / # Environment (cwd, sandbox, budget, parallelism) / # Reporting (return JSON matching schema)`.
Result: `{ summary, files_changed[], verification{commands[],results[]}, unresolved_risks[], follow_ups[] }`
(treated as ADVISORY — Olympus runs the DoD commands itself; Codex's `verification` is never trusted).

## Verified facts & volatile (re-confirm vs live binary at build)

- Command form: `codex -a never -s workspace-write exec --json …` — GLOBAL flags BEFORE `exec` (probe-confirmed; `-a` after `exec` errors).
- `codex exec resume <thread_id>` works on 0.140 with the `thread.started.thread_id` from `--json` (0.141 unverified → spike).
- `codex exec` spawns project `.codex/agents/*.toml` subagents ONLY in a trusted repo.
- `--include-plan-tool` is NOT an `exec` flag (lives on `codex mcp-server`); native `/goal` is NOT reachable from `exec`.
- Olympus `full-auto` is an INTERNAL token (→ `-s danger-full-access`), not the deprecated CLI `--full-auto` → cosmetic.
- `codex doctor`: 0.141 available, 0.140 installed → flags volatile; re-run `codex … --help` before wiring.

## Ship order

1. AGENTS.md⇄CLAUDE.md unification (budget+CI check) + `docs/internals` offload + 3 Codex-side skills.
2. `codex-exec.mjs` `opts.persist`+resume + `codex-goal.mjs` + schema + `.codex/agents/*.toml` +
   `skills/codex-goal/SKILL.md` (loop/verify/trust-preflight/budget) + tests.
3. (Deferred) narrow status-only MCP — after HU-01 eval; design vs MCP Tasks.
4. (Deferred) app-server Tier-2 — only if eval justifies steering.

## Implementation notes

- Branch first: `git checkout -b feat/codex-goal` (repo auto-pushes `main` commits to PUBLIC origin).
- `node --test 'scripts/test/**/*.test.mjs'` (2289 tests) green before/after; existing `codex-exec.test.mjs` argv tests UNMODIFIED.
- **Fail-safe scope (Codex m-fix):** HOOKS only (catch → safe default → exit 0). `codex-goal.mjs`
  is an execution helper, NOT a hook — on spawn/parse failure it must emit a STRUCTURED failure
  (non-zero exit + `{status:"failed",reason}`) the skill treats as FAIL; never silent exit-0 (which
  would mask a failed delegation and defeat external verification).

## Provenance / key sources

- Codex CLI: developers.openai.com/codex (noninteractive, cli/reference, subagents, plugins/build, hooks)
  + live `codex 0.140` probes (resume, native-subagent-in-exec, flag-ordering, `/goal`-not-in-exec).
- Multi-agent evidence: Anthropic orchestrator-worker (90.2% / ~15× tokens); Magentic-One Task/Progress
  Ledger (arXiv 2411.04468) ↔ phase-runner+loop-guard; METR (o3 reward-hacked 30.4%) → external verify.
- Reference impl single-source→multi-harness: github.com/wshobson/agents.
- Cross-review (rev 2): Momus (NEEDS-REVISION) + Codex live-probe (SAFE-WITH-FIXES), reconciled.
