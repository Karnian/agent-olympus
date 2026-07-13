# HU-01 — Agent Eval & CI Regression Harness (spec)

> P0. The single biggest frontier gap (both reviewers, unanimous). Lets us
> answer the question Olympus currently **cannot**: *did this prompt/agent/skill
> edit make the orchestrators better or worse?*

## Implemented P2/P3 contract (2026-07-13)

This section supersedes the older aspirational details below wherever they
differ:

- Trials copy vendored `seed/` directories with `fs.cpSync` into fresh temporary
  roots. They do not derive fixtures from repository HEAD or use Athena's
  worktree lifecycle.
- Public CI is fully hermetic: full Node tests, committed baseline integrity,
  and discovered regression GREEN (`solution`) / RED (`none`) proofs. CI never
  invokes `claude -p`, consumes credentials, or claims a measured live result.
- True live pass^k comparison is an explicit operator/private-nightly action.
  Baselines record provenance plus separate SHA-256 identities for the
  benchmark/grader contract and the pipeline measurement protocol. Protocol
  identity follows the deterministic repo-local relative-import closure of its
  explicit roots, excluding builtins, packages, and unreferenced SUT files. A
  protocol-only change preserves the outcome delta but closes an explicit
  review gate; a benchmark change is outcome-incomparable. Declared targets
  report `baseline-unmeasured` and `delta_vs_target`, never a measured-baseline
  comparison. Historical live protocol identities remain immutable and can be
  replaced only by a reviewed live refresh, not by baseline-integrity repair.
- Every supported Atlas live trial pre-allocates exactly one production run identity
  in its fresh workdir. Provider success is insufficient: the exact run must
  finish the strict code-defined phase sequence, emit ordered completion events,
  match its bounded iteration/review/CI guard counters, finalize its run summary,
  and clear its active pointer before the independent grader runs. Fixture
  trials record this evidence as not applicable.
- Pipeline evidence is cooperative and candidate-asserted, not a security
  attestation. It prevents stale/missing/accidental protocol false positives;
  HU-11 remains responsible for a candidate-inaccessible event channel and OS
  isolation against deliberate forgery.
- Athena live eval now uses its production phase-runner/finalization contract,
  including its distinct spawn/monitor/integrate recovery phases. It remains an
  operator-only path and is not executed by public CI.
- Regression uses pass^k as its gate. Capability uses pass@k and is report-only,
  including the single-task CLI exit contract.
- HU-17 now supplies explicit terminal-failure markers and a local
  metadata/digest-only human review queue. It intentionally does not generate
  golden tasks automatically and remains separate from HU-01's CI gate.
- Production recovery/finalization uses bounded no-follow artifact I/O. Its
  operational event reader skips malformed/torn JSONL records. The
  phase/finalization ensure writers repair a missing LF and verify the exact
  appended tail. The independent eval evidence verifier is intentionally
  stricter: any malformed production event makes that trial ineligible with
  `invalid-events-jsonl`.

## Problem

Before HU-01, 79 test files exercised hooks and library functions but **none
measured orchestration quality**. There was no fixed task set the orchestrators
were scored against, so:
- A one-line edit to `agents/*.md`, `skills/atlas|athena/SKILL.md`, an intent
  pattern, or a model-routing rule can silently degrade end-to-end quality.
- "It worked once" (best-of-1 on a non-deterministic agent) is reported as success
  — Anthropic's worked example shows 0.75³ ≈ 42% true reliability behind a single PASS.
- There is no cross-run trend, so backsliding between releases is invisible.

Historical pre-HU-01 baseline: `evals/` was absent and `scripts/` had no
`pass@k` references. The implemented contract above supersedes that snapshot.

## Goal

A **zero-dependency, Node-built-in** eval harness that:
1. Runs the orchestrators (Atlas / Athena / solo) headless over a fixed **golden
   task set**.
2. Requires a finalized production pipeline ledger for supported live Atlas and Athena runs,
   proving that the selected orchestrator exercised its required cooperative
   protocol instead of merely returning a successful provider event.
3. Grades each run with an **independent deterministic grader** (NOT the agent's own
   verification — no self-grading).
4. Splits **capability** (hard, expected < 100%, measures progress) vs **regression**
   (held ~100%, gates CI) tracks — the Anthropic two-track model.
5. Reports **pass^k** (all-k-succeed reliability) and **pass@k** (any-of-k capability)
   over k isolated trials.
6. Captures **real token cost** per run (depends on HU-03).
7. Gates CI on harness/fixture regression and supports reviewed live
   regression-track backslide comparison outside public CI.

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
  with the plugin loaded, `cwd` = the per-trial temporary seed copy.
- Stream-json `result` event carries the final state **and real `usage`** → feeds HU-03.
- Hard-kill at `timeoutMs` (SIGTERM→SIGKILL, mirror the supervisor's shutdown grace).

### Isolation & pass^k (`evals/run.mjs`)
- For each task, copy vendored `seed/` into **k isolated temporary directories**
  with Node built-ins. This keeps the benchmark independent of repository HEAD
  and avoids coupling eval cleanup to Athena worktree ownership.
- Reject any seed that already contains `.ao`, then pre-allocate one run via the
  production run-artifact API. After the child exits and before grading, require
  that exact finalized run, its strict phase ledger, ordered completion events,
  matching loop-guard counters, fresh bounded regular evidence files, and a
  cleared active pointer. Do not select an arbitrary "latest" ledger.
- Run the orchestrator independently in each (bounded by the existing
  `concurrency-gate` global limit).
- `grade(workdir)` each trial → `pass_i ∈ {0,1}`.
- A live trial passes only when provider completion, pipeline evidence, and the
  independent grader all pass. Fixture pipeline evidence is not applicable.
- `pass@k = any(pass_i)` (capability), `pass^k = all(pass_i)` (reliability).

### Grading (`grader.mjs`, independent)
Each grader is deterministic and **self-contained** (no network, no model):
- run the project's build/test command in `workdir`, assert exit 0;
- assert task-specific invariants (a regex on the diff, a unit assertion, a
  golden-output match);
- return `{ pass, checks: [...] }`. Never grade via the agent's own
  `verification.jsonl` — that is the thing under test.

### CI gate (`.github/workflows/evals.yml`)
- Trigger: `workflow_dispatch` + schedule + PR **label** `run-evals`.
- Run `npm test`, baseline/schema/fingerprint integrity, and every discovered
  regression task's hermetic GREEN/RED fixture proof.
- Never run the real orchestrator or compare an unmeasured live result in public
  CI. Live regression/capability runs remain reviewed operator jobs.

### Output & trend
- `summary.json` carries per-task `pass^k`, per-track rollup, **real token cost**
  (HU-03), pipeline-evidence policy/trust rollups, and `delta_vs_baseline`.
- A `node evals/report.mjs --trend` rolls `results/*/summary.json` into a
  release-over-release quality line (the cross-run trend Olympus lacks today).
- Eval `summary.json` and `results.jsonl` outputs use atomic full-file writes.
  Production run artifacts inspected by the verifier use the bounded no-follow
  `run-artifacts.mjs`/`hardened-fs.mjs` contract, but attestation parsing remains
  fail-closed on every malformed event rather than inheriting recovery tolerance.

## Phasing

| Phase | Scope | Exit criteria |
|-------|-------|---------------|
| **P1 (MVP)** | 3 regression tasks (S, atlas, k=1), `run.mjs` + deterministic graders, manual `node evals/run.mjs` | green/red verdict on a known-good vs known-broken edit |
| **P2** | k=3 + pass^k/pass@k, capability track (3 hard tasks), real token capture (HU-03), independent trial directories | reliability numbers + cost per run |
| **P3** | Hermetic CI proof, provenance-aware `baseline.json` management, trend report | CI fails on grader/fixture regression; reviewed live runs produce comparable baselines |

## Dependencies & ordering
- **HU-03** (real token usage) lands inside P2 here (the runner is the natural capture point).
- **HU-13** (calibrated judge) extends graders later for subjective ACs — out of scope for v1.
- Constraint: **zero npm deps** (Node built-ins + `claude`/`git` CLIs only), every writer
  `schemaVersion:1` + fail-safe, consistent with repo conventions.

## Open questions
1. Seed fixtures are vendored mini-repos for both tracks. Network-fetched or
   pinned remote fixtures are deferred because they would weaken the hermetic
   CI and grader contract.
2. Token budget per eval run — wire a hard cap via `cost-estimate` once HU-03 gives real numbers.
3. Athena (peer-to-peer) evals need tmux/worker availability in CI — gate those tasks on capability detection, skip-with-record when unavailable (mirror cross-validation's skip semantics).
