# HU-06 — Deterministic Phase Runner + Idempotent Durable Resume (plan)

> P1, but the **eval prerequisite** (Codex re-sequencing, adopted): HU-01 cannot
> reliably eval a *prose-defined* orchestrator. A `claude -p "/atlas …"` run today
> measures "how faithfully Claude followed `skills/atlas/SKILL.md` this time," not
> the Olympus state machine. HU-06 code-ifies the phase sequence + phase-state so a
> run becomes **reproducible and inspectable**, then HU-01 evals *that*.
>
> Status: **rev-4** — three Codex cross-review rounds folded (rev-1 NO-GO → rev-2;
> rev-2 NO-GO, 4/6 RESOLVED → rev-3; rev-3 NO-GO but **B1–B4 CLOSED**, residual
> precision items → rev-4). Authoring branch `feat/hu-06-pipeline-runner`. Pending a
> user call: a 4th confirmation review, or proceed to HU-06.1 implementation.

## Confirmed scope (user decisions, 2026-06-18)

1. **Orchestrators:** Atlas **and** Athena (library is orchestrator-agnostic).
2. **Control model:** cooperative in-conversation library + chokepoint. The LLM
   drives; it calls the runner at every phase/loop boundary. The runner owns the
   phase sequence, durable per-phase ledger, exactly-once resume, and is the single
   chokepoint that consults `loop-guard`. **NOT** an external driver (spec.md N12).
3. **Footprint:** deep rewrite of both `skills/{atlas,athena}/SKILL.md` onto the
   runner. All existing phase logic preserved verbatim — control flow reorganized,
   nothing dropped.

## Codex cross-review (rev-1 → rev-2)

rev-1 received **NO-GO** with 6 blocking issues (all verified against source). rev-2
folds every one. Summary of what changed and why:

| # | rev-1 flaw (verified) | rev-2 resolution |
|---|------------------------|------------------|
| 1 | Phase descriptors marked verify/integrate `loopGuard:iterations`, but API said `beginIteration()` owns the 15-cap and `loopTick()` doesn't — generic implementers would double-tick. | **Outer attempt is transition-bound, not a per-phase descriptor.** `iterations` removed from all descriptors; new `beginAttempt`/`reattempt` own `registerIteration`. |
| 2 | review-reject `reopenPhase('verify')` only reset status → could **miss** the 15-cap (or double-count if both called manually). `skills/atlas/SKILL.md:55-62,844-867`. | `reattempt(runId,{reopen})` is **atomic**: ticks `registerIteration` exactly once *and* reopens, or returns STOP. No separate manual tick. |
| 3 | "in_progress re-executes, idempotent" is **false for Athena `spawn`**: `createWorkerWorktree()` force-removes worktree + `git branch -D` (`worktree.mjs:119-136`); `spawnTeam()` mints a fresh runId/workerRunId each call (`worker-spawn.mjs:822,864`) → resume **deletes live worker branches / orphans supervisors**. | Per-phase **resume policy**. `spawn`/`monitor`/`integrate` are `onResume:'recover'` — recover-or-reuse existing team state, never blind re-spawn. Honest contract, documented landmine. |
| 4 | `completePhase` calling `saveCheckpoint` + emitting `phase_transition`/`checkpoint_saved` **double-emits** — `saveCheckpoint` already emits both before its write and returns no status (`checkpoint.mjs:82-117`). | `pipeline.json` = **sole phase authority**. `saveCheckpoint` stays the **only** checkpoint-event emitter (runner does not re-emit). `completePhase` is **async**; `saveCheckpoint` gains a `{ok,degraded}` return so the runner can flag divergence. |
| 5 | Phase model dropped: Atlas trivial path (skip spec/plan, `atlas:418-420`), light-mode rewind to 2b (`atlas:185-199`), Athena Phase 3b wisdom (`athena:681-698`). Linear phases globally non-reopenable broke light-mode. | Descriptor gains `skippableWhen` + `reopenableFor`; Athena `wisdom` phase added; light-mode rewind uses its **own** `registerEscalation('light-mode-rewind',cap2)` cap, **not** the 15-iteration cap. |
| 6 | `visual`/`quality` modeled as optional linear phases with **unspecified** FAIL transitions; semantics differ (Atlas quality FAIL → Phase 3 `atlas:921-927`; Athena → retry in Phase 4 `athena:772-780`). | **Dropped as standalone phases.** They are sub-steps *inside* `verify`/`integrate`; their FAIL reuses the existing in-phase fix loop + `reattempt`. Shrinks the model. |

Codex's open-question answers and over-engineering callouts are folded into
**Resolved decisions** and **Out of scope** below.

### rev-2 → rev-3 (2nd Codex round)

The 2nd review confirmed issues 1, 2, 4, 5 **RESOLVED** and flagged residual holes
(all folded here):

| Issue | rev-3 resolution |
|---|---|
| **Athena spawn crash window** — `spawnTeam()` persists team state only *after* all workers launch (`worker-spawn.mjs:991-993`); a crash mid-spawn leaves no state and an unpersisted `teamSlug`, so `recover` can't adopt and may re-spawn duplicates. | Persist `teamSlug` (+ intended worker set) into the ledger `spawn.outputs` **and** the checkpoint **before** `spawnTeam`. Recover = adopt-if-state-exists, else **clean-respawn** keyed by `teamSlug`. **Explicit v1 guarantee downgrade** (not silent — see Resume + Out of scope): a mid-spawn-window crash may briefly orphan detached supervisors; no committed work is lost. |
| **Trivial path vs `.ao/prd.json`** — trivial skips spec/plan, but finalize/ship dereference `prd.userStories` (`atlas:1008-1016`, `:1043-1048`). | Trivial path **synthesizes a minimal one-story PRD** so the downstream contract holds unchanged. See "Trivial path & the PRD contract". |
| **`completePhase` ordering** — `saveCheckpoint` emits events before its write; ledger written after → crash between leaves checkpoint advanced, ledger stale. | **Ledger-first ordering**: write authoritative `pipeline.json` first, then `saveCheckpoint` (payload cache may lag the authority by one transition — tolerable). |
| **Quality/visual FAIL transitions underspecified** | Full **Backward-edge specification** table added (per-orchestrator quality/visual/review transitions, what ticks the 15-cap, what reopens). |
| `saveCheckpoint` return | **Additive `{ok,degraded}` only** — no call-shape or throw change; existing callers ignore it. |
| `attempt` mirror divergence | `loop-guard.json` is the sole cap authority; ledger `attempt` is display-only. Test asserts a stale/corrupt `pipeline.attempt` never affects cap enforcement. |

### rev-3 → rev-4 (3rd Codex round)

The 3rd review confirmed **B1/B2, B3, B4 CLOSED** and left precision items (all folded):

| Issue | rev-4 resolution |
|---|---|
| **Atlas `quality_fail` was a no-op** — `execute` only runs `passes:false` stories (`atlas:695`), so reopening `execute` after all stories passed burns an attempt doing nothing; the 2-cycle budget was prose, not code. | The transition **flips quality-failed stories `passes:false`** (so `execute` re-runs them) and is bounded by a **code-owned** `quality-cycles` counter (`loopTick(_,'quality')`, cap 2 = new `QUALITY_CAP`). |
| **Trivial PRD sequencing** — a synthetic `passes:false` story that stays false is dropped from the changelog (`changelog.mjs:29-45`) and shows unchecked in the PR body (`pr-create.mjs:130-133`); pre-execution self-verify is wrong. | Synthesize at triage with `passes:false`; run the trivial work through the normal `execute→verify` path that flips it `true` + records US-001 — no pre-exec self-verify. |
| **Ledger-first vs checkpoint payload** — checkpoint may lag one transition, yet skills restore `completedStories` from it (`atlas:203-207`). | Story-level truth read from `.ao/prd.json` + `verification.jsonl` + ledger (authority); `checkpoint.completedStories` is advisory, reconciled against `prd.json`. |
| **Downgrade text overpromised** — claimed SessionEnd sweeps the orphan; it actually **preserves active supervisor runs** (`session-end.mjs:49-74`). | Corrected: orphans run their single prompt to terminal/timeout and exit on their own; swept only once inactive. Blast radius = one prompt's wasted compute, never lost work. |
| **Test list conflated library + skill** — HU-06.1 "no skill edits" but listed trivial-PRD/recover behavior tests. | Tests split: HU-06.1 = pure-library `phase-runner.test.mjs`; trivial-PRD / quality_fail / Athena-recover behaviors → HU-06.2/.3 contract + smoke tests. |

## Problem

Three defects, one root cause (orchestration lives only as prose):

1. **No code-defined phase sequence.** Order, optional gates, and loop boundaries
   exist only as headings. A reorder, skipped gate, or missed loop-guard consult is
   invisible and unverifiable.
2. **Checkpoints are snapshots, not exactly-once resume.** `checkpoint.mjs` restores
   a payload but records no per-phase completion, so a resumed run can re-execute a
   finished phase. There is no "this phase is done, skip it" ledger.
3. **Loop bounds are cooperative-only.** `loop-guard` code-backs the caps, but the
   orchestrator must *remember* to call it. Nothing structural guarantees the call.

Latent fourth defect: the phase vocabulary is **forked three ways** —
`checkpoint.PHASE_NAMES` (coarse numeric index), `artifact-pipe.CANONICAL_STAGES`
(`plan/decompose/execute/verify/review/finish`), and the SKILL.md prose phases.
Nothing reconciles them.

## Goal

A zero-dependency, Node-built-in `scripts/lib/phase-runner.mjs` that:

1. **Defines the phase sequence in code**, per orchestrator (the single source of
   truth reconciling all three forks).
2. **Records per-phase completion durably** to
   `.ao/artifacts/runs/<runId>/pipeline.json` (schemaVersion:1, atomic 0600) —
   survives compaction / fresh-process polling by construction (the property
   `loop-guard.json` already has).
3. **Resumes with per-phase policy**: completed/skipped phases never re-execute;
   `recover` phases reuse live state; only honestly-idempotent phases re-execute.
4. **Is the single chokepoint that absorbs `loop-guard`** — the orchestrator no
   longer imports `loop-guard`; every cap consult is reached only through a runner
   method, and the phase structure forces the call.
5. **Fails open** (same polarity as `loop-guard`): missing `runId` / corrupt ledger
   / FS error → `degraded:true` + permissive result; a genuine cap hit on healthy
   storage is authoritative STOP.

Non-goal restated: the runner does **not** take execution control from the LLM.
"Deterministic" = sequence + completion ledger + loop-bound consult are code-owned
and recorded. Work *within* a phase stays LLM-driven.

## Design

### New module: `scripts/lib/phase-runner.mjs`

Named `phase-runner` (not `pipeline`) to avoid collision with `artifact-pipe.mjs`
("pipe" = archival). Ledger file is `pipeline.json`.

#### The ledger — `.ao/artifacts/runs/<runId>/pipeline.json`

```json
{
  "schemaVersion": 1,
  "orchestrator": "atlas",
  "createdAt": "…", "updatedAt": "…",
  "attempt": 2,
  "phases": {
    "triage":  { "status": "completed", "startedAt": "…", "completedAt": "…", "attempts": 1 },
    "spec":    { "status": "skipped",   "reason": "trivial" },
    "plan":    { "status": "skipped",   "reason": "trivial" },
    "execute": { "status": "completed", "…": "…" },
    "verify":  { "status": "in_progress", "startedAt": "…", "attempts": 2 },
    "review":  { "status": "pending" }
  }
}
```

- `status` ∈ `pending | in_progress | completed | skipped | failed`.
- `attempt` = outer-iteration counter mirror (authoritative count lives in
  `loop-guard.json`; this is a convenience mirror for status display).
- **No large payload in the ledger.** `outputs` is optional, tiny, scalars-only
  (ids/counts/flags). The durable payload already lives in checkpoint
  (`prdSnapshot`), `.ao/prd.json`, `verification.jsonl`, team state, and supervisor
  output. (Codex: don't duplicate the payload store.) **Exception:** the Athena
  `spawn` phase persists `teamSlug` (a short scalar) here *before* launch so a
  mid-spawn-crash resume can locate the team (Codex rev-2 B2) — see Resume.
- Lives alongside `loop-guard.json` / `summary.json` / `events.jsonl`; swept by
  SessionEnd with other run artifacts.

#### Phase descriptors (the code-defined sequence)

```js
{
  id: 'verify',
  name: 'VERIFY',
  kind: 'loop',                 // 'linear' | 'loop'
  pipeStage: 'verify',          // METADATA ONLY → artifact-pipe stage (no behavior in v1)
  checkpointIndex: 4,           // → checkpoint.PHASE_NAMES index (display back-compat)
  loopGuard: null,              // null | 'reviewRounds' | 'monitor' | 'ci'  (NOT 'iterations')
  loopCap: null,                // forwarded to loop-guard for loop phases
  onResume: 'reexecute',        // 'reexecute' | 'recover' | 'skip-if-complete'
  skippableWhen: [],            // e.g. ['trivial'] — may be marked skipped, not run
  reopenableFor: [],            // e.g. ['light_mode_rewind'] — linear phase may be reopened for this reason
}
```

`loopGuard` deliberately **excludes `iterations`** — the 15-cap is owned by
`beginAttempt`/`reattempt` (below), bound to the *transition into a new attempt*,
not to any phase.

**Atlas `PHASE_SEQUENCE`** (visual/quality are sub-steps of `verify`, not phases):

| id | name | kind | pipeStage | ckpt | loopGuard | onResume | notes |
|----|------|------|--------|:--:|---------|--------|-------|
| `triage` | TRIAGE+ANALYZE | linear | plan | 0 | — | reexecute | |
| `context` | DEEP-DIVE/EXTERNAL | linear | plan | 1 | — | skip-if-complete | `skippableWhen:['trivial']` |
| `spec` | SPEC GATE | linear | plan | 2 | — | skip-if-complete | `skippableWhen:['trivial']` |
| `plan` | PLAN+VALIDATE | linear | decompose | 2 | — | skip-if-complete | `skippableWhen:['trivial']`, `reopenableFor:['light_mode_rewind']` |
| `execute` | EXECUTE | linear | execute | 3 | — | reexecute | per-story idempotent via `prd.passes` + verification ledger |
| `verify` | VERIFY (+visual/quality sub-steps) | loop | verify | 4 | — | reexecute | internal fix loop = `recordPhaseError`; quality FAIL → `reattempt` |
| `review` | REVIEW | loop | review | 5 | reviewRounds (3) | reexecute | |
| `finalize` | SLOP+COMMIT+CHANGELOG+EXECPLAN | linear | finish | 6 | — | reexecute | |
| `ship` | SHIP (PR) | linear | finish | 7 | — | skip-if-complete | |
| `ci` | CI WATCH | loop | finish | 7 | ci (2) | reexecute | |
| `complete` | COMPLETION | linear | finish | 7 | — | reexecute | cleanup |

**Athena `PHASE_SEQUENCE`** (adds `wisdom`; spawn/monitor/integrate are `recover`):

| id | name | kind | pipeStage | ckpt | loopGuard | onResume | notes |
|----|------|------|--------|:--:|---------|--------|-------|
| `triage` | TRIAGE & TEAM DESIGN | linear | plan | 0 | — | reexecute | |
| `context` | DEEP-DIVE/EXTERNAL | linear | plan | 0 | — | skip-if-complete | `skippableWhen:['trivial']` |
| `spec` | SPEC GATE | linear | plan | 1 | — | skip-if-complete | |
| `plan` | PLAN | linear | decompose | 1 | — | skip-if-complete | `reopenableFor:['light_mode_rewind']` |
| `spawn` | SPAWN TEAM | linear | execute | 2 | — | **recover** | ⚠ NOT re-executable — see Resume |
| `monitor` | MONITOR & COORDINATE | loop | execute | 3 | monitor (10) | **recover** | cap hit → force-collect + escalate |
| `wisdom` | WISDOM TRACKING | linear | execute | 3 | — | reexecute | was Athena Phase 3b — restored |
| `integrate` | INTEGRATE & VERIFY (+visual/quality) | loop | verify | 4 | — | **recover** | merges worker branches |
| `review` | REVIEW | loop | review | 5 | reviewRounds (3) | reexecute | |
| `finalize` | SLOP+COMMIT+CHANGELOG+EXECPLAN | linear | finish | 6 | — | reexecute | |
| `ship` | SHIP (PR) | linear | finish | 7 | — | skip-if-complete | |
| `ci` | CI WATCH | loop | finish | 7 | ci (2) | reexecute | |
| `complete` | COMPLETION | linear | finish | 7 | — | reexecute | `shutdownTeam`/`TeamDelete`/worktree cleanup |

`checkpointIndex` keeps `checkpoint.mjs` resume UX unchanged. `pipeStage` is pure
metadata in v1 (no `artifact-pipe` wiring — Codex: don't blur archival responsibility).

### Public API

```
initPipeline(runId, orchestrator, opts?)
    → { ok, resumePhase, resumePolicy, completed:[ids], degraded }
    Idempotent. Creates the ledger if absent; if present, returns the first
    non-terminal phase AND its onResume policy so the skill picks the right branch.

getPhaseSequence(orchestrator) → PhaseDescriptor[]          (pure, no I/O)

enterPhase(runId, phaseId) → { proceed, skip, reason, status, degraded }
    Linear-progress + exactly-once gate. completed/skipped (and skip-if-complete on
    resume) → { proceed:false, skip:true }. Else marks in_progress (++attempts) →
    { proceed:true }. For 'recover' phases on resume, returns
    { proceed:true, reason:'recover' } so the skill runs its recovery branch, NOT
    its spawn branch.

beginAttempt(runId) → { allowed, count, cap, degraded }
    Outer NEVER-STOP loop chokepoint → loop-guard.registerIteration (cap 15).
    Called ONCE at the start of the execute→verify→review block (first attempt).
    allowed:false ⇒ STOP + escalate.

reattempt(runId, { reopen:[phaseIds], reason }) → { allowed, count, cap, reopened, degraded }
    ATOMIC outer re-attempt. Ticks registerIteration exactly once; if allowed,
    reopens the named phases (verify/execute) to 'pending'; returns the cap result.
    This is the ONLY review-reject / verify-can't-pass backward edge that ticks the
    15-cap. Eliminates the miss/double-count hole (Codex #1/#2).

loopTick(runId, phaseId|counterName) → { allowed, count, cap, degraded }
    Per-loop-phase / per-bounded-sub-loop bound (NOT iterations). Dispatch:
      review   → registerReviewRound (cap 3)
      monitor  → registerCounter('monitor-iterations', cap 10)
      ci       → registerCounter('ci-cycles', cap 2)
      quality  → registerCounter('quality-cycles', cap 2)  // Atlas quality-gate retries

recordPhaseError(runId, phaseId, errorSig) → { shouldEscalate, repeatCount, threshold, degraded }
    → loop-guard.recordError (threshold 3). Every verify/integrate failure before retry.

async completePhase(runId, phaseId, outputs?) → { ok, next, checkpointDegraded, degraded }
    LEDGER-FIRST ordering (Codex rev-2 B4): (1) write the authoritative pipeline.json
    marking phaseId completed + emit the runner's own `pipeline_phase_completed` event;
    THEN (2) await saveCheckpoint(orchestrator,{phase:checkpointIndex,…}), which stays
    the SOLE emitter of phase_transition/checkpoint_saved (the runner does NOT re-emit).
    A crash between (1) and (2) leaves the AUTHORITY correct (ledger=completed) and only
    the checkpoint payload-cache lagging one transition — tolerable, because resume
    drives *phase* from the ledger and *live payload* from `.ao/prd.json` +
    `verification.jsonl` (written by the phase work itself), not from the checkpoint
    snapshot. saveCheckpoint gains an ADDITIVE {ok,degraded} return (no call-shape /
    throw change) so completePhase surfaces checkpointDegraded.

skipPhase(runId, phaseId, reason) → { ok, next, degraded }
    Marks an optional/skippable phase skipped (trivial path; no frontend → skip
    visual sub-step is handled in-phase, not here). Recorded so resume won't re-eval.

reopenPhase(runId, phaseId, { reason }) → { ok, rejected, degraded }
    POLICY rewind, distinct from reattempt. Allowed only if reason ∈
    descriptor.reopenableFor (e.g. 'light_mode_rewind'). Does NOT tick the 15-cap —
    light-mode rewind keeps its own registerEscalation('light-mode-rewind',cap2).
    Rejects ('rejected:true') for non-loop phases without the matching policy.

nextPhase(runId) → phaseId|null                              (read-only)
getPipelineState(runId) → ledger                             (read-only, fresh default on error)
isComplete(runId) → boolean
```

### Backward-edge specification (the cap-correctness core)

Every backward transition is enumerated. Three classes that MUST stay distinct:
**outer re-attempt** (ticks the 15-cap), **policy rewind** (own cap, never the 15),
and **internal fix loop** (no backward edge — same-error-3× only). The complete table
(Codex rev-2 B5 — quality/visual were underspecified):

| Trigger | Orch | Runner call | Ticks 15-cap | Reopens | Sub-budget |
|---|:--:|---|:--:|---|---|
| review REJECT | both | `reattempt({reopen:['verify'],reason:'review_reject'})` | ✅ | verify | review-round cap 3 |
| quality gate FAIL | Atlas | mark failed stories `passes:false` → `loopTick(_,'quality')` → `reattempt({reopen:['execute','verify'],reason:'quality_fail'})` | ✅ | execute, verify | `quality-cycles` cap 2 (`atlas:921-927`) |
| quality gate FAIL | Athena | internal `integrate` fix loop (debugger + `recordPhaseError`) | ❌ | — | 2 cycles (`athena:772-780`) |
| visual regression | both | internal `verify`/`integrate` designer fix loop | ❌ | — | 2 cycles |
| build/test FAIL | both | internal fix loop (`recordPhaseError`) | ❌ | — | ~5 soft + same-error-3× |
| light-mode reviewer REJECT | both | `reopenPhase('plan',{reason:'light_mode_rewind'})` | ❌ | plan (+2b) | `registerEscalation('light-mode-rewind',cap 2)` |
| same-error 3× | both | `recordPhaseError` → `shouldEscalate` → STOP | — | — | — |

The asymmetry is intentional and matches today's prose: **Atlas** quality FAIL
returns to *execute* (a new outer attempt → ticks the 15-cap), while **Athena**
quality FAIL retries *within* integrate (no outer tick). Visual + build/test failures
are internal fix loops in both — no outer tick. Light-mode rewind carries its own
escalation cap and never touches the 15-cap.

**Codex rev-3 fix — Atlas quality_fail must DO work, not just reopen.** `execute`
only iterates stories with `passes:false` (`atlas:695`), so reopening `execute` after
all stories already passed would burn an attempt doing nothing. The transition
therefore (a) flips the quality-failed stories back to `passes:false` in `.ao/prd.json`
so `execute` actually re-runs them, and (b) is bounded by a **code-owned**
`quality-cycles` counter (`loopTick(_,'quality')`, cap 2) — the 2-cycle budget is no
longer prose. Both steps live in the rewritten Atlas skill (HU-06.2); the runner
supplies the `quality` counter (HU-06.1).

### Trivial path & the PRD contract (Codex rev-2 B3)

When `triage` classifies `COMPLEXITY=trivial`, the rewritten Atlas skill
`skipPhase('context'|'spec'|'plan', 'trivial')` and executes directly (`atlas:418-420`)
— but `finalize` reads `.ao/prd.json` for the changelog (`atlas:1008-1016`) and `ship`
does `prd.userStories.map(...)` + `checkVerificationGate(runId, storyIds)`
(`atlas:1043-1048`). So the trivial path **synthesizes a minimal one-story PRD** before
leaving triage:

```json
{ "projectName": "atlas-<slug>",
  "userStories": [ { "id": "US-001", "title": "<task>",
    "acceptanceCriteria": ["<derived from task>"], "passes": false } ] }
```

**Sequencing (Codex rev-3 fix).** The synthetic PRD is created at triage with
`passes:false` — NOT pre-verified. The trivial work then flows through the normal
`execute → verify` path, which (after the change is actually made and checked) sets
`passes:true` and records the US-001 verification (`atlas:803-816`) — exactly as a
real story. This matters because `checkVerificationGate` passes on any record, but
the **changelog only includes `passes:true` stories** (`changelog.mjs:29-45`) and the
**PR body renders unchecked for `passes:false`** (`pr-create.mjs:130-133`); leaving
US-001 false would silently drop it from both. So: synthesize false at triage →
execute → verify → mark true. No pre-execution self-verify. (Athena always plans a
team — no trivial-direct path — so this is Atlas-only.)

### Loop-guard absorption (the chokepoint)

After HU-06 **only `phase-runner.mjs` imports `loop-guard`.** Mapping:

| Concern | Old direct call | New runner method |
|---|---|---|
| Outer 15-iteration cap | `registerIteration` | `beginAttempt` / `reattempt` |
| Review-round cap (3) | `registerReviewRound` | `loopTick(_,'review')` |
| Athena monitor cap (10) | `registerCounter('monitor-iterations',{cap:10})` | `loopTick(_,'monitor')` |
| CI watch cap (2) | prose `maxCycles` | `loopTick(_,'ci')` |
| Atlas quality-gate cap (2) | prose `max 2 cycles` | `loopTick(_,'quality')` |
| Same-error-3× | `recordError` | `recordPhaseError` |

**Enforcement, not relocation:** the phase structure makes the calls unavoidable
(no outer loop without `beginAttempt`/`reattempt`; no review round without
`loopTick`; no verify-done without `enterPhase`). A future Stop/PreToolUse hook
(HU-21) can then assert "did this run consult the runner?" against `pipeline.json` —
impossible against prose. `loop-guard.json` is unchanged on disk; the runner is a
caller, not a fork (honors "reuse the primitive, don't extend standalone").
Loop-guard's caps stay its own exported constants (`DEFAULT_ITERATION_CAP=15`,
`DEFAULT_REVIEW_ROUND_CAP=3`, `DEFAULT_ERROR_THRESHOLD=3`); the runner owns only the
*new* named caps it introduces (`MONITOR_CAP=10`, `CI_CAP=2`, `QUALITY_CAP=2`) so
loop-guard stays a generic primitive and does not grow phase policy (Codex OQ4).

### Resume semantics (honest, per-phase)

- **`skip-if-complete` / completed / skipped:** never re-executed. Exactly-once.
- **`reexecute`:** re-run from the phase start on resume — at-least-once. Safe only
  because these phases are idempotent (`execute` guards per-story via `prd.passes` +
  the verification ledger; verify/review/finalize/ci are naturally re-runnable).
- **`recover` (Athena `spawn`/`monitor`/`integrate`) — the Codex #3 fix:** resume
  must **NOT** blindly re-run the spawn branch. `createWorkerWorktree()` force-removes
  the worktree and `git branch -D`s the branch before recreating (`worktree.mjs:119-136`),
  and `spawnTeam()` mints a fresh runId/workerRunId each call (`worker-spawn.mjs:822,
  864`) and persists team state only *after* all workers launch (`:991-993`). So a
  blind re-spawn **deletes live worker branches and orphans supervisors**. To recover,
  the rewritten Atlas/Athena `spawn` phase persists `teamSlug` (+ intended worker set)
  into the ledger `spawn.outputs` **and** the checkpoint **BEFORE** calling
  `spawnTeam` (cheap — the orchestrator knows `teamSlug` pre-launch; closes Codex
  rev-2 B2). On `enterPhase`→`reason:'recover'`:
  1. `loadCheckpoint('athena')` + read the persisted `teamSlug`.
  2. **Team state exists** (`.ao/state/team-<teamSlug>.json` — `spawnTeam` finished) →
     `monitorTeam(teamSlug)` → adopt: completed→collect, running→keep, failed→reassign.
     **Never** `createWorkerWorktree()` for a worker whose worktree/branch is recorded.
  3. **Team state absent but `teamSlug` known** (crash *during* spawn, before the
     `:991` persist) → **clean-respawn**: `cleanupTeamWorktrees(cwd, teamSlug)` (removes
     the partial `.ao/worktrees/<slug>/` + branches — safe because no worker has merged
     yet) → fresh `spawnTeam`.
  - **v1 guarantee — explicit downgrade, NOT a silent deferral (Codex rev-2):** a crash
    in the narrow mid-spawn window (after the first supervisor launches, before the
    `:991` persist) may briefly **orphan detached supervisor processes** — their runId
    was in-memory and is unrecoverable. **No committed work is lost** (mid-spawn workers
    have not merged); each orphan runs its single prompt to terminal completion /
    timeout and exits on its own, its writes landing in the worktree the clean-respawn
    already removed (harmless). **Correction (Codex rev-3):** SessionEnd *preserves*
    active supervisor runs (`session-end.mjs:49-74`) — it does NOT kill a live orphan;
    the stale snapshot dir is swept only once that orphan is no longer active. Honest
    blast radius = one worker's worth of wasted compute (its prompt duration) + a stale
    snapshot dir until then — **never lost committed work**. Fully closing the window
    needs an incremental pre-spawn persist *inside* `worker-spawn.mjs` — deferred past
    v1 (Out of scope). HU-06 itself does **not** modify `worktree.mjs`/`worker-spawn.mjs`.
- **`failed`:** re-enters under its `onResume` policy.

Resume flow: `initPipeline` → `{resumePhase, resumePolicy}` → the rewritten skill
jumps there and picks the policy branch; earlier `enterPhase` calls return
`skip:true`. **Authority order (Codex rev-3 — the ledger-first corollary):** because
the checkpoint payload-cache may lag the ledger by one transition, **story-level truth
is read from `.ao/prd.json` (`passes` flags) + `verification.jsonl` + the ledger — NOT
from `checkpoint.completedStories`**, which is treated as an *advisory hint reconciled
against* `.ao/prd.json`. (`.ao/prd.json` is updated per-story by `execute` itself, so
it never lags.) Checkpoint still supplies coarse resume payload (`prdSnapshot`,
`worktrees`) and the human-readable phase label; the runner + `prd.json` supply the
authoritative "what is actually done." This removes any path where a one-behind
checkpoint re-runs a completed story or misses the verification gate.

### Relationship to existing systems

- **`checkpoint.mjs`** — retained for the rich payload. `completePhase` awaits
  `saveCheckpoint` (mapping `phaseId→checkpointIndex`); `saveCheckpoint` stays the
  **sole** emitter of `phase_transition`/`checkpoint_saved`. Small change:
  `saveCheckpoint` returns `{ok,degraded}` so the runner can flag divergence.
  `pipeline.json` is the **phase authority**; checkpoint is the **payload cache**.
  Not folding checkpoint into the runner in v1 (Codex OQ2).
- **`run-artifacts.mjs`** — reused unchanged. The runner emits its own distinct
  `pipeline_phase_completed` event (no collision with checkpoint events).
- **`artifact-pipe.mjs`** — untouched in v1. `pipeStage` is metadata only.
- **`loop-guard.mjs`** — sole caller becomes the runner.

## SKILL.md deep rewrite — strategy + regression avoidance

Overriding principle: **preserve every existing behavior**; change control-flow
expression, not content.

**Method (per skill):** wrap the body in the runner contract — `initPipeline` →
resume jump (by policy) → each `### Phase X` becomes `enterPhase('<id>') →
(skip/recover guard) → <existing prose verbatim> → await completePhase('<id>')`. The
outer loop becomes an explicit `beginAttempt` head wrapping execute→verify→review;
review-reject is a single `reattempt({reopen:['verify']})`. Light-mode rewind is
`reopenPhase('plan',{reason:'light_mode_rewind'})`. Replace the three direct
loop-guard blocks and the numeric `saveCheckpoint({phase:N})` calls. Update
`agents/{atlas,athena}.md` Constraints + Stop_Conditions to reference runner
chokepoints. **Carry over verbatim** (the acceptance checklist): light-mode
resolution + auto-escalate + 2-rewind cap; false-trivial guard; every sub-agent
output-validation/retry; explore→metis ordering; spec-gate A/B; consensus-plan
branch; per-story cross-validation + explicit-skip; review-router + same-round
escalation; verification gate; debug escalation chain; ship/CI/cleanup. Athena adds:
team design, worktree isolation, Path A/B native-team split, supervisor monitor
model, merge-branch integration, message-queue comms, Phase 3b wisdom.

**Regression avoidance — `scripts/test/phase-contract.test.mjs` (new).** Codex: a
string-anchor linter proves text survived, **not** that the runner graph preserves
behavior. So two layers:
1. **Semantic markers** — the rewritten skills embed explicit `AO-CONTRACT:<x>`
   anchors (`AO-CONTRACT:review-router`, `:light-mode-rewind`, `:verification-gate`,
   `:cross-validation`, `:team-recover`, …). The linter asserts presence of every
   required marker (stable, survives rewording, unlike grepping arbitrary prose).
2. **Graph-level transition checks** — the linter parses the skill for the required
   *transitions/ordering*, not just call presence: every `PHASE_SEQUENCE` id has
   `enterPhase`+`completePhase`; the outer loop uses `beginAttempt`/`reattempt`; loop
   phases use the correct `loopTick`; Athena spawn/monitor/integrate have a
   `recover` branch; **zero** direct `loop-guard` imports/calls outside
   `phase-runner.mjs` (grep assertion).
Plus **2 smoke scenarios** after the rewrite (fresh `claude -p`, since defs load at
session start): **Atlas trivial path** (skips spec/plan, executes directly) and
**Athena resume-from-spawn** with preexisting team/worktree state (asserts no
re-spawn / no branch deletion).

## Testing

Tests are split by sub-phase to match the "HU-06.1 = no skill edits" boundary
(Codex rev-3 flagged the prior list conflating library and skill behaviors).

**HU-06.1 — `scripts/test/phase-runner.test.mjs`** (pure library; mirror `loop-guard.test.mjs`):
- phase-sequence well-formedness (unique ids, valid loopGuard refs ∈
  {null,reviewRounds,monitor,ci,quality}, monotonic checkpointIndex, no `iterations`
  in any descriptor);
- `enterPhase` skip-on-completed/skipped; `recover` phases return `reason:'recover'`;
- `beginAttempt`+`reattempt` tick `registerIteration` exactly once per attempt and
  enforce the 15-cap; **explicit miss/double-count test**: first attempt + 14
  reattempts → 15th blocked, count never skips;
- `loopTick` dispatch → review(3)/monitor(10)/ci(2)/quality(2) caps;
- `recordPhaseError` → recordError threshold 3;
- `completePhase` **ledger-first**: writes pipeline.json + emits one
  `pipeline_phase_completed` BEFORE awaiting saveCheckpoint (single phase_transition,
  no duplicate checkpoint events); simulated crash between the two leaves the ledger
  authoritative and the checkpoint at most one transition behind;
- `reopenPhase('plan',{reason:'light_mode_rewind'})` allowed + does NOT tick the
  15-cap; rejected for a reason ∉ `reopenableFor`;
- `skipPhase`: context/spec/plan marked skipped, resume doesn't re-eval;
- **attempt-mirror safety**: a stale/corrupt `pipeline.attempt` never changes cap
  enforcement (authority is `loop-guard.json`);
- crash-resume (phase level): `verify` in_progress → resumePhase=verify, earlier
  phases skip; a `recover` phase in_progress → resumePolicy='recover';
- schemaVersion>1 loader rule, corrupt/array fail-safe, cross-run isolation,
  fail-open polarity, no-clobber coexisting with `loop-guard.json`, `outputs` size cap;
- `checkpoint.test.mjs` update: `saveCheckpoint` additive `{ok,degraded}` return
  (no call-shape / throw change; existing callers unaffected).

**HU-06.2 / HU-06.3 — `scripts/test/phase-contract.test.mjs` + skill behavior** (exercise
the rewritten skills / control-flow, NOT the standalone library):
- contract linter: `AO-CONTRACT:` markers + graph-level transition checks + zero direct
  `loop-guard` calls outside `phase-runner.mjs` (see Regression avoidance);
- **(06.2) trivial PRD contract**: trivial triage synthesizes a one-story
  `.ao/prd.json` (`passes:false`); execute→verify flips it `true`; changelog + PR body
  + `checkVerificationGate` all include US-001;
- **(06.2) Atlas quality_fail does work**: a quality FAIL flips the failed stories
  `passes:false`, ticks `quality-cycles`, and `reattempt` actually re-runs them (not a
  no-op attempt burn);
- **(06.3) Athena recover**: (a) team state present → adopt path, NO
  `createWorkerWorktree` for recorded workers; (b) team state absent + persisted
  `teamSlug` → clean-respawn (asserts no blind re-spawn of recorded work);
- **2 smokes** (fresh `claude -p`): Atlas trivial path; Athena resume-from-spawn.

**Full suite must stay green** (currently 2249/2249; HU-06.1 adds ~50–60 library
tests, HU-06.2/.3 add contract + behavior tests).

## Phasing

| Sub | Scope | Risk | Unblocks |
|----|-------|:--:|------|
| **HU-06.1** | `phase-runner.mjs` + `phase-runner.test.mjs` + `saveCheckpoint` return-status change. **No skill edits.** | Low | HU-01 can reference the runner |
| **HU-06.2** | Atlas SKILL.md deep rewrite + `phase-contract.test.mjs` (atlas) + `agents/atlas.md` + trivial-path smoke | Med-High | HU-01 Atlas-only MVP |
| **HU-06.3** | Athena SKILL.md deep rewrite (esp. `recover` branches) + contract test (athena) + `agents/athena.md` + resume-from-spawn smoke | High | Athena evals |
| **HU-06.4** | Docs: CLAUDE.md state-file table (`pipeline.json`), README roadmap status flip | Low | — |

Land HU-06.1 (fully unit-tested) before the prose rewrites — it is the piece HU-01
needs, and decoupling caps the rewrites' blast radius. **06.2 and 06.3 ship as
separate PRs** (Codex OQ5) — they share `phase-runner.mjs` but not a SKILL file, and
06.3 (recover branches) is the highest-risk slice.

## Dependencies & ordering

- **Unblocks HU-01** — `pipeline.json` is the artifact HU-01's runner reads to
  confirm *real* orchestration occurred (expected phase sequence present) vs
  prose-following. HU-06.1 + HU-06.2 are the concrete HU-01 Atlas-MVP precondition.
- **Independent of HU-03** — the runner records phase timing, not tokens.
- **Sets up HU-21** — the runner is the chokepoint a future Stop/PreToolUse hook
  asserts against; HU-21's time/token/spend caps + kill-switch hang off the same
  `beginAttempt`/`loopTick` seam.
- Constraints: zero npm deps; every writer `schemaVersion:1` + fail-safe + atomic
  0600/0700; `catch → safe default → never throw`.

## Resolved decisions (was: open questions)

1. **Module name** — `phase-runner.mjs`, ledger `pipeline.json`. (Codex agree.)
2. **Checkpoint** — keep the `checkpointIndex` shim; `pipeline.json` is phase
   authority; `saveCheckpoint` gains `{ok,degraded}`; don't fold checkpoint in v1.
3. **Outer-iteration boundary** — bound to the *transition into a new attempt*
   (`beginAttempt`/`reattempt`), never a per-phase `loopGuard:iterations`.
4. **Caps** — reuse loop-guard's exported 15/3/error constants; runner owns new
   `MONITOR_CAP=10` / `CI_CAP=2` / `QUALITY_CAP=2` named constants; loop-guard stays generic.
5. **Rewrite split** — separate PRs: 06.1 → 06.2 (Atlas) → 06.3 (Athena).
6. **Contract linter** — strict via explicit `AO-CONTRACT:` markers + graph-level
   transition checks (not arbitrary-prose grep) + 2 smokes.

## Out of scope (v1)

- External fresh-process driver / true mid-phase exactly-once (N12).
- Hook-*enforced* runner consult (HU-21; v1 is structurally-guaranteed but still
  cooperative — no hook fails a run that bypasses the runner).
- Time / token / spend caps + kill-switch (HU-21, needs HU-03).
- Modifying `worker-spawn.mjs` to make `spawnTeam` itself crash-idempotent. **Explicit
  v1 guarantee downgrade (not a silent deferral — Codex rev-2):** Atlas/Athena spawn
  recovery handles the pre-spawn-persist (`teamSlug`) and post-spawn (`monitorTeam`
  adopt) cases; a crash in the narrow mid-spawn window does a `teamSlug`-keyed
  clean-respawn that may briefly orphan detached supervisors (no committed work lost,
  self-terminate, SessionEnd-swept). Fully closing the window = a future incremental
  pre-spawn persist inside `worker-spawn.mjs`. HU-06 leaves `worktree.mjs` /
  `worker-spawn.mjs` unchanged.
- Active `artifact-pipe` handoff wiring (Codex: don't blur archival responsibility).
- Folding `checkpoint.mjs` into the runner.

## Workflow checklist (roadmap convention)

- [x] Claude writes plan (rev-1).
- [x] Codex cross-review #1 → **NO-GO**, 6 blocking issues → folded into **rev-2**.
- [x] Codex cross-review #2 → **NO-GO**, 4/6 RESOLVED + residual holes → folded into **rev-3**.
- [x] Codex cross-review #3 → **NO-GO** but **B1–B4 CLOSED**; precision items → folded into **rev-4**.
- [ ] (user call) optional 4th confirmation review of rev-4, OR proceed.
- [ ] Codex implements HU-06.1 (`-s workspace-write`, no commit) → Claude reviews + full suite.
- [ ] Then HU-06.2 (Atlas), then HU-06.3 (Athena).
