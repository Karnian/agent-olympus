# HU-01 — Agent Eval & CI Regression Harness (spec)

> P0. The single biggest frontier gap (both reviewers, unanimous). Lets us
> answer the question Olympus currently **cannot**: *did this prompt/agent/skill
> edit make the orchestrators better or worse?*

## Problem

The 79 test files exercise hooks and lib functions; **none measure orchestration
quality**. There is no fixed task set the orchestrators are scored against, so:
- A one-line edit to `agents/*.md`, `skills/atlas|athena/SKILL.md`, an intent
  pattern, or a model-routing rule can silently degrade end-to-end quality.
- "It worked once" (best-of-1 on a non-deterministic agent) is reported as success
  — Anthropic's worked example shows 0.75³ ≈ 42% true reliability behind a single PASS.
- There is no cross-run trend, so backsliding between releases is invisible.

`evals/` is confirmed absent; 0 `pass@k` references in `scripts/`.

## Goal

A **zero-dependency, Node-built-in** eval harness that:
1. Runs the orchestrators (Atlas / Athena / solo) headless over a fixed **golden
   task set**.
2. Grades each run with an **independent deterministic grader** (NOT the agent's own
   verification — no self-grading).
3. Splits **capability** (hard, expected < 100%, measures progress) vs **regression**
   (held ~100%, gates CI) tracks — the Anthropic two-track model.
4. Reports **pass^k** (all-k-succeed reliability) and **pass@k** (any-of-k capability)
   over k isolated trials.
5. Captures **real token cost** per run (depends on HU-03).
6. Gates CI on regression-track backsliding.

## ⚠️ Codex critique (2026-06-17 cross-review) — read before building

**The weakest link is headless orchestrator execution, and HU-06 is a prerequisite, not a sibling.**
This spec assumes `claude -p "/atlas …"` reproduces real Olympus orchestrator behavior — but
`skills/atlas/SKILL.md` is a **prose protocol** (non-interactive confirmations, pseudo-code
imports, `Output` directives, phase jumps), not an executable state machine. As written, the CI
grader risks measuring *"how faithfully Claude followed that prose on that run"* rather than the
Olympus state machine. Consequences for v1:

1. **Promote a minimal executable phase entrypoint (HU-06) ahead of the full harness** — code-ify
   the Atlas phase sequence + phase-state so a run is reproducible, then eval *that*.
2. **Do not overclaim.** A deterministic grader measures **task outcome**, not orchestration
   quality — an agent can fluke the patch. Outcome pass^k is a *reliability floor*, a proxy, not a
   quality measure. (HU-13's calibrated judge is what eventually grades trajectory/quality.)
3. **MVP first** (Codex P0b): Atlas-only, 3 regression tasks, `k=1`, manual. pass^k / CI gate /
   baseline trend are explicitly **post-MVP**, not P0.
4. **Keep the golden set alive:** wire the eval-to-guardrail loop (failed prod runs → new tasks)
   at **P1**, not P3 — 3 hand-authored fixtures rot quickly.

## Out of scope (v1)

- Live LLM-as-judge for subjective ACs (that is HU-13; v1 uses deterministic graders only).
- Semantic diffing of code quality. v1 grades **behavioral outcomes** (build + tests + assertions).
- Running on every PR. Eval runs are minutes + real tokens → **on-demand / scheduled / label-gated** only.

## Design

### Directory layout
```
evals/
  tasks/
    <task-id>/
      task.json          # { id, track, difficulty, prompt, orchestrator, timeoutMs, modelTier }
      seed/              # fixture repo state the task starts from (git-init'd at run time)
      grader.mjs         # export async function grade(workdir) -> { pass:boolean, checks:[{name,pass,detail}] }
  run.mjs                # the runner (drives orchestrator headless, k trials, scores)
  lib/
    orchestrate.mjs      # headless invocation of /atlas|/athena|solo via `claude -p`
    score.mjs            # pass@k / pass^k math + track rollups
  results/
    <runId>/
      results.jsonl      # one line per (task, trial): verdict + checks + real token usage
      summary.json       # per-task pass^k/pass@k, per-track rollup, cost, vs-baseline delta
  baseline.json          # last-known-good per-task pass^k for the regression gate
```

### Task contract (`task.json`)
```json
{
  "schemaVersion": 1,
  "id": "fix-seeded-null-deref",
  "track": "regression",
  "difficulty": "S",
  "orchestrator": "atlas",
  "prompt": "The build fails with a NullPointerException in src/parse.js. Fix it; all tests must pass.",
  "timeoutMs": 600000,
  "modelTier": "sonnet",
  "k": 3
}
```

### Headless orchestration (`evals/lib/orchestrate.mjs`)
Reuse the existing `claude-cli` adapter pattern (`scripts/lib/claude-cli.mjs`):
- `claude -p "/<orchestrator> <prompt>" --output-format stream-json --permission-mode bypassPermissions`
  with the plugin loaded, `cwd` = the per-trial worktree.
- Stream-json `result` event carries the final state **and real `usage`** → feeds HU-03.
- Hard-kill at `timeoutMs` (SIGTERM→SIGKILL, mirror the supervisor's shutdown grace).

### Isolation & pass^k (`evals/run.mjs`)
- For each task, create **k isolated git worktrees** from `seed/` — **reuse
  `scripts/lib/worktree.mjs`** (already used by Athena parallel workers).
- Run the orchestrator independently in each (bounded by the existing
  `concurrency-gate` global limit).
- `grade(workdir)` each trial → `pass_i ∈ {0,1}`.
- `pass@k = any(pass_i)` (capability), `pass^k = all(pass_i)` (reliability).

### Grading (`grader.mjs`, independent)
Each grader is deterministic and **self-contained** (no network, no model):
- run the project's build/test command in `workdir`, assert exit 0;
- assert task-specific invariants (a regex on the diff, a unit assertion, a
  golden-output match);
- return `{ pass, checks: [...] }`. Never grade via the agent's own
  `verification.jsonl` — that is the thing under test.

### CI gate (`.github/workflows/evals.yml`)
- Trigger: `workflow_dispatch` + `schedule` (nightly) + PR **label** `run-evals`
  (NOT every push — cost).
- Run the **regression track** only, `k=3`.
- Fail the job if any regression task's `pass^k` drops below `baseline.json`
  (with a small tolerance band) → "orchestration backslide" signal.
- Capability track runs nightly, reported as a trend (never fails the build).

### Output & trend
- `summary.json` carries per-task `pass^k`, per-track rollup, **real token cost**
  (HU-03), and `delta_vs_baseline`.
- A `node evals/report.mjs --trend` rolls `results/*/summary.json` into a
  release-over-release quality line (the cross-run trend Olympus lacks today).
- Reuse `scripts/lib/run-artifacts.mjs` conventions (append-only JSONL,
  `schemaVersion:1`, fail-safe writes).

## Phasing

| Phase | Scope | Exit criteria |
|-------|-------|---------------|
| **P1 (MVP)** | 3 regression tasks (S, atlas, k=1), `run.mjs` + deterministic graders, manual `node evals/run.mjs` | green/red verdict on a known-good vs known-broken edit |
| **P2** | k=3 + pass^k/pass@k, capability track (3 hard tasks), real token capture (HU-03), worktree isolation | reliability numbers + cost per run |
| **P3** | CI gate on regression backslide, `baseline.json` management, trend report, eval-to-guardrail loop (HU-17: failed prod runs → new tasks) | CI fails on a seeded orchestration regression |

## Dependencies & ordering
- **HU-03** (real token usage) lands inside P2 here (the runner is the natural capture point).
- **HU-13** (calibrated judge) extends graders later for subjective ACs — out of scope for v1.
- Constraint: **zero npm deps** (Node built-ins + `claude`/`git` CLIs only), every writer
  `schemaVersion:1` + fail-safe, consistent with repo conventions.

## Open questions
1. Seed fixtures: vendored mini-repos vs pinned public `git URL@sha`? (Vendored = hermetic, larger repo; pinned = lean, network-dependent.) Lean vendored for regression, pinned allowed for capability.
2. Token budget per eval run — wire a hard cap via `cost-estimate` once HU-03 gives real numbers.
3. Athena (peer-to-peer) evals need tmux/worker availability in CI — gate those tasks on capability detection, skip-with-record when unavailable (mirror cross-validation's skip semantics).
