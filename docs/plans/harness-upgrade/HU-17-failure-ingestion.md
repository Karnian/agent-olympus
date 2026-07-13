# HU-17 — Failed-run review candidate ingestion

Status: implemented locally on the 2026-07-12 harness/failover branch.

## Decision

A failed production run cannot safely become a golden eval task automatically.
Run artifacts do not contain a reviewed seed repository, deterministic hidden
grader, or reference solution, and may contain prompts, errors, paths, diffs,
or provider output. HU-17 therefore closes the feedback loop in two explicit
steps:

1. Atlas/Athena may mark a genuinely terminal failure with a minimal,
   allowlisted `terminal-failure.json`.
2. SessionEnd may derive a local metadata-and-digest candidate for human review.

Creating an eval task remains a separate manual engineering action. No HU-17
API or CLI edits `evals/tasks/`, invokes a provider, accesses the network, or
runs git commands.

## Terminal marker

`scripts/lib/run-failure.mjs` exposes `finalizeFailedRun()`. It accepts exactly:

```json
{
  "orchestrator": "atlas",
  "failureClass": "task-outcome",
  "code": "verification_exhausted",
  "phase": "verify"
}
```

The persisted schema contains only `schemaVersion`, `runId`, those four enum
fields, and `failedAt`. Raw reason/error/metadata fields are rejected. The API
validates the running summary, matching active pointer, and exact pipeline
failure cut. Every predecessor must be completed or skipped for a
descriptor-authorized reason, the named phase must be the only failed phase,
and every successor must remain pending. It durably records one matching
`pipeline_phase_failed` event, writes an immutable 0600 marker, finalizes the
exact run as `result:"failure"`, and clears the pointer only after the matching
`run_finalized` event is durable. Success and failure finalizers share one
run-scoped lock; stale-owner recovery uses an append-only claim lineage for the
exact observed generation, so a dead recoverer can be succeeded without
weakening the generation fence. The shared finalizer validates canonical non-future
start time and immutable run/orchestrator/task/session identity before mutation;
only the marker-owning internal path may finalize or repair a failure result.
It rejects linked or replaced run/summary/event artifacts, opens bounded regular
files with no-follow semantics, and rechecks directory/file identity before
terminal writes.

Athena additionally rejects failures at `spawn` or `monitor`. For later phases,
terminal liveness is eligible only when a completed adapter-only roster, its
monitor digest, and the exact adapter run generation all match the durable team
state. Native or mixed teams, including a native Claude provider fallback, stay
ineligible because their liveness cannot be proven from repository artifacts.

Only `task-outcome` and `orchestration` markers are candidate-eligible.
Infrastructure failures and cancellation remain recorded run outcomes but are
excluded from the learning queue. A resumable run or one with active workers
must not be finalized merely to create a candidate.

## Candidate boundary

`scripts/lib/eval-failure-candidates.mjs` stores validated records under
`.ao/eval-candidates/records/` (directory 0700, files 0600). A candidate contains:

- allowlisted run identity, category, phase, and timestamps;
- SHA-256, byte count, and bounded record/count signals for known artifacts;
- review status and an optional reviewed golden-task ID.

It never copies artifact content, the original task, errors, evidence text,
paths, diffs, checkpoint payloads, or provider output. IDs are deterministic,
collection is deduplicated and lock-protected, and the collector independently
revalidates the exact pipeline cut and its single failure event. Corrupt,
future-schema, oversized, symlinked, or unsafe inputs fail closed. Pending
candidates are capped at 500 and the full queue at 2,000.

SessionEnd inspects at most the newest 64 `runIds` from the session registry.
It never lists or scans the global run directory. Its collection path has a
one-second deadline and makes a single non-waiting queue-lock attempt, so a live
collector cannot stall session shutdown. Collection errors are suppressed so
the hook still emits valid JSON and exits zero.

## Human workflow

```sh
node scripts/eval-candidates.mjs list
node scripts/eval-candidates.mjs show <candidateId>
node scripts/eval-candidates.mjs approve <candidateId>
# Separately author and review evals/tasks/<taskId>/ seed, grader, solution.
node scripts/eval-candidates.mjs link <candidateId> <taskId>
```

Use `reject` when the failure is duplicate, non-actionable, environment-specific,
or cannot support a deterministic grader. `approve` does not generate a task;
`link` records only the ID of a task created and reviewed through the normal
eval process.

## Safety invariants

- No automatic golden-task generation or promotion.
- No raw failure data in marker or candidate.
- No global SessionEnd run scan.
- No infrastructure/cancelled candidate ingestion.
- No mutation of an active or resumable run.
- No network, provider, git staging, commit, push, or PR behavior.
- Persisted formats use `schemaVersion:1` and atomic writes.
