# Event-Backed Run System + Story-Level AC Evidence + Completion Notices

**Version**: 1.1
**Scale**: M (multi-file, extends existing modules, 3-5 days appetite)
**Status**: Implemented (v0.9.2)
**Date**: 2026-04-01

---

## Problem Statement

Atlas and Athena orchestrators currently maintain two disconnected state systems: a run artifacts log (`run-artifacts.mjs`) that nobody calls, and a checkpoint system (`checkpoint.mjs`) that skills call 17+ times but stores only a flat snapshot with no history. When a session is interrupted and resumes, the checkpoint tells you WHERE you were but not HOW you got there or WHAT happened along the way. Verification results are captured at story granularity only, so there is no way to determine which specific acceptance criterion failed. And when orchestration completes, there is no systematic scan for gaps -- things that were skipped, unavailable, or left unresolved -- so operators discover these only by manually auditing output.

These three gaps compound: without event history, you cannot replay state; without criterion-level evidence, you cannot pinpoint failures; without completion notices, you cannot trust that "done" actually means done.

## Target Users

- **Atlas/Athena orchestrator skills** -- the primary consumers that call `saveCheckpoint()` and will call `addEvent()` to record phase transitions
- **Themis quality-gate agent** -- produces verification evidence that needs a structured destination
- **Codex cross-validation sessions** -- produce pass/fail results per acceptance criterion
- **Operators reviewing completed runs** -- need to audit what happened, what passed, and what was skipped

## Goals

1. Unify run artifacts and checkpoints so every phase transition, subagent completion, and verification result lives in a single append-only event log per run
2. Enable checkpoint reconstruction from events via `replayEvents(runId)`, making the event log the source of truth and checkpoint files a performance cache
3. Support criterion-level verification evidence so each GIVEN/WHEN/THEN acceptance criterion has its own pass/fail/skip verdict with evidence
4. Generate actionable completion notices that surface specific unresolved gaps -- not generic suggestions -- when a run finalizes

## Non-Goals

- **Replacing checkpoint API** -- `saveCheckpoint()`, `loadCheckpoint()`, `clearCheckpoint()`, and `formatCheckpoint()` keep their signatures and behavior; they gain internal event emission but callers do not change
- **Migrating existing checkpoint files** -- old checkpoint files without a runId will continue to work as-is via the existing code path
- **Building a UI or dashboard** -- this is a data layer; presentation is out of scope
- **Worker status integration** -- `worker-status.mjs` is Athena-specific and will not be merged into the event log in this iteration
- **Modifying SKILL.md files** -- skills continue calling the same checkpoint API; no skill-level code changes
- **Run artifact retention policy** -- cleanup/rotation of old runs is out of scope
- **Worker lifecycle events** -- `worker_spawned`, `worker_completed`, `worker_failed` event types are registered but NOT emitted in this iteration (Athena SKILL.md changes deferred)

---

## User Stories

### US-001: Active Run Identity

**As** an orchestrator skill, **I want** `createRun()` and `saveCheckpoint()` to share a run identity **so that** events and checkpoints are linked to the same run.

**Acceptance Criteria:**

- GIVEN a new run is created via `createRun('atlas', 'implement feature X')`
  WHEN I call `getActiveRunId('atlas')`
  THEN it returns the runId from `createRun()`

- GIVEN a runId is active
  WHEN `saveCheckpoint('atlas', {...})` is called
  THEN an event of type `checkpoint_saved` is appended to that run's `events.jsonl`

- GIVEN no run has been created
  WHEN `getActiveRunId('atlas')` is called
  THEN it returns `null` (never throws)

- GIVEN a run is finalized via `finalizeRun(runId, summary)`
  WHEN `getActiveRunId()` is called afterward
  THEN it returns `null`

- GIVEN `finalizeRun(runId, summary)` is called
  WHEN the active-run file points to a DIFFERENT runId
  THEN the active-run file is NOT deleted (compare-and-delete)

**Implementation notes:**
- Active run identity stored at `.ao/state/ao-active-run-<orchestrator>.json`
- Contains `{ runId, orchestrator, startedAt }`
- `createRun()` writes this file; `finalizeRun()` deletes it only if runId matches (compare-and-delete)
- New export: `getActiveRunId(orchestrator)` reads this file
- New export: `setActiveRunId(orchestrator, runId)` for explicit linking (testing, recovery)
- File permissions: `0o600`

### US-002: Event-Backed Checkpoint

**As** the checkpoint system, **I want** each `saveCheckpoint()` call to emit a structured event to the active run **so that** checkpoint state can be reconstructed from the event log.

**Acceptance Criteria:**

- GIVEN an active run exists for orchestrator 'atlas'
  WHEN `saveCheckpoint('atlas', { phase: 3, completedStories: ['S1'], taskDescription: 'test' })` is called
  THEN an event `{ type: 'checkpoint_saved', phase: 3, detail: { completedStories: ['S1'], taskDescription: 'test' } }` is appended to `events.jsonl`
  AND the checkpoint file `.ao/state/checkpoint-atlas.json` is still written (backward compat)

- GIVEN no active run exists
  WHEN `saveCheckpoint()` is called
  THEN the checkpoint file is written as before
  AND no event is emitted (fail-safe, no error)
  AND no run is auto-created (callers must explicitly call `createRun()` first)

- GIVEN `clearCheckpoint('atlas')` is called
  WHEN there is an active run
  THEN an event `{ type: 'checkpoint_cleared' }` is appended

### US-003: Phase Transition Events

**As** an operator reviewing a completed run, **I want** explicit `phase_transition` events in the log **so that** I can see exactly when and how long each phase took.

**Acceptance Criteria:**

- GIVEN an active run exists
  WHEN `saveCheckpoint('atlas', { phase: 3, ... })` is called and the previous checkpoint had `phase: 2`
  THEN a `phase_transition` event is emitted with `{ from: 2, to: 3, fromName: 'PLAN', toName: 'EXECUTE' }` BEFORE the `checkpoint_saved` event

- GIVEN this is the first checkpoint (no previous phase)
  WHEN `saveCheckpoint('atlas', { phase: 0, ... })` is called
  THEN a `phase_transition` event is emitted with `{ from: null, to: 0, toName: 'TRIAGE' }`

- GIVEN an active run exists and the previous checkpoint had `phase: 3`
  WHEN `saveCheckpoint('atlas', { phase: 3, ... })` is called (same phase, no transition)
  THEN NO `phase_transition` event is emitted
  AND only a `checkpoint_saved` event is emitted

**Implementation notes:**
- `saveCheckpoint()` internally reads the previous checkpoint to detect phase changes
- Phase names resolved from the existing `PHASE_NAMES` map (export it)
- Phase transition is only emitted when `data.phase !== previousPhase` (strict inequality)

### US-004: Replay Events to Reconstruct Checkpoint

**As** a recovery system, **I want** to reconstruct checkpoint state from the event log **so that** if the checkpoint file is lost, state can be recovered.

**Acceptance Criteria:**

- GIVEN a run has events: `phase_transition(to:0)`, `checkpoint_saved(phase:0, ...)`, `phase_transition(to:3)`, `checkpoint_saved(phase:3, completedStories:['S1','S2'])`
  WHEN `replayEvents(runId)` is called
  THEN it returns `{ phase: 3, completedStories: ['S1','S2'], orchestrator: 'atlas', ... }` matching the last checkpoint_saved event's detail

- GIVEN a run has no checkpoint_saved events
  WHEN `replayEvents(runId)` is called
  THEN it returns `null`

- GIVEN a run has events including `verification_result` events
  WHEN `replayEvents(runId)` is called
  THEN the returned state includes `verifications: [...]` aggregated from those events

- GIVEN the events.jsonl file does not exist or is corrupt
  WHEN `replayEvents(runId)` is called
  THEN it returns `null` (never throws)

**Implementation notes:**
- New export from `run-artifacts.mjs`: `replayEvents(runId, opts)`
- Iterates events in order; `checkpoint_saved` events overwrite accumulated state; `verification_result` events append to a verifications array

### US-005: Subagent Completion Events

**As** the subagent-stop hook, **I want** to emit a `subagent_completed` event to the active run **so that** subagent results are captured in the canonical event log.

**Acceptance Criteria:**

- GIVEN an active run exists for any orchestrator
  WHEN the subagent-stop hook fires with `{ tool_name, tool_input: { subagent_type }, last_assistant_message }`
  THEN a `subagent_completed` event is appended to the active run's `events.jsonl` with `{ agentType, toolName, messageLength }`
  AND the existing `.ao/state/ao-subagent-results.json` FIFO is still written (backward compat)

- GIVEN no active run exists
  WHEN the subagent-stop hook fires
  THEN only the existing FIFO behavior occurs (no event emitted, no error)

**Implementation notes:**
- `subagent-stop.mjs` imports `getActiveRunId` and `addEvent` from `run-artifacts.mjs`
- The lastMessage is NOT stored in the event (too large); only `messageLength` is recorded
- The full message remains in the FIFO file for backward compat
- **Orchestrator discovery**: Hook payload does NOT include orchestrator info. The hook checks BOTH `ao-active-run-atlas.json` and `ao-active-run-athena.json`. If both exist, use the most recently created one (compare `startedAt`). If neither exists, skip event emission.

### US-006: Criterion-Level Verification Evidence

**As** a quality gate (Themis or Codex xval), **I want** to record pass/fail/skip results for each individual acceptance criterion **so that** operators can see exactly which criterion failed and why.

**Acceptance Criteria:**

- GIVEN `addVerification(runId, { story_id: 'US-001', criteria: [{ criterion_index: 0, criterion_text: 'GIVEN...WHEN...THEN...', verdict: 'pass', evidence: 'test output shows...' }, { criterion_index: 1, criterion_text: 'GIVEN...WHEN...THEN...', verdict: 'fail', evidence: 'expected 200, got 404' }], verifiedBy: 'themis' })` is called
  WHEN I read `verification.jsonl`
  THEN it contains one line with both criteria embedded
  AND a `verification_result` event is appended to the run's `events.jsonl`

- GIVEN `addVerification()` is called with the OLD schema (story_id, verdict, evidence, verifiedBy -- no criteria array)
  WHEN the function executes
  THEN it still works, writing a single story-level record (backward compat)

- GIVEN criterion-level results exist for story 'US-001'
  WHEN `verifyStory(runId, 'US-001')` is called
  THEN it returns `{ story_id: 'US-001', verdict: 'fail', criteria: [{criterion_index:0, verdict:'pass', ...}, {criterion_index:1, verdict:'fail', ...}] }`
  AND story-level verdict is 'fail' if ANY criterion is 'fail', 'skip' if any is 'skip' and none is 'fail', 'pass' only if all are 'pass'

- GIVEN no verification results exist for story 'US-003'
  WHEN `verifyStory(runId, 'US-003')` is called
  THEN it returns `null`

**Implementation notes:**
- `addVerification()` signature extended: the `result` param MAY now include a `criteria` array
- When `criteria` is present, it is stored alongside story_id in verification.jsonl
- New export: `verifyStory(runId, storyId, opts)` reads verification.jsonl and aggregates
- Event type `verification_result` carries the FULL verification payload `{ story_id, verdict, verifiedBy, criteria, criteriaCount, failCount }` (not just counts — needed for `replayEvents` to reconstruct verification state)

### US-007: Story Verification Rollup

**As** an orchestrator reviewing execution results, **I want** a function to summarize all story verifications for a run **so that** I can see overall pass/fail status at a glance.

**Acceptance Criteria:**

- GIVEN a run has verification results for stories US-001 (pass), US-002 (fail), US-003 (skip)
  WHEN `getRunVerificationSummary(runId)` is called
  THEN it returns `{ total: 3, passed: 1, failed: 1, skipped: 1, stories: { 'US-001': { verdict: 'pass', ... }, 'US-002': { verdict: 'fail', ... }, 'US-003': { verdict: 'skip', ... } } }`

- GIVEN a run has no verification results
  WHEN `getRunVerificationSummary(runId)` is called
  THEN it returns `{ total: 0, passed: 0, failed: 0, skipped: 0, stories: {} }`

### US-008: Completion Notices

**As** an operator, **I want** the system to scan for specific unresolved gaps after orchestration completes **so that** I know exactly what requires manual follow-up.

**Acceptance Criteria:**

- GIVEN a run has verification results where story US-002 has `verdict: 'skip'` with evidence `'codex unavailable'`
  WHEN `generateCompletionNotices(runId)` is called
  THEN the output includes `'[notice] codex_unavailable: US-002 verification skipped — codex was not available for cross-validation'`

- GIVEN a run has all stories with `verdict: 'pass'` and no other gaps
  WHEN `generateCompletionNotices(runId)` is called
  THEN the output is an empty array (no generic suggestions emitted)

- GIVEN a run has events showing a worker with phase 'failed' (from a `worker_failed` event)
  WHEN `generateCompletionNotices(runId)` is called
  THEN the output includes `'[notice] worker_failed: <worker_name> failed during <phase>'`
  (NOTE: `worker_failed` events are NOT emitted in this iteration — gap type is registered but will only fire when worker lifecycle events are implemented)

- GIVEN a run has verification results where criterion verdict is 'skip' with evidence containing 'manual review'
  WHEN `generateCompletionNotices(runId)` is called
  THEN the output includes `'[notice] manual_review_needed: US-XXX criterion N requires manual review'`

**Gap types detected:**
1. `tests_skipped` -- verification with verdict 'skip' and evidence mentioning tests
2. `manual_review_needed` -- criterion with verdict 'skip' and evidence mentioning manual/review
3. `preview_skipped` -- criterion with verdict 'skip' and evidence mentioning preview/visual
4. `codex_unavailable` -- criterion with verdict 'skip' and evidence mentioning codex
5. `unresolved_warnings` -- events of type `warning` present in the log
6. `worker_failed` -- events of type `worker_failed` present in the log

**Implementation notes:**
- New export from `run-artifacts.mjs`: `generateCompletionNotices(runId, opts)`
- Returns `string[]`, each prefixed with `[notice] <type>: `
- Evidence-matching uses case-insensitive substring search
- Must never throw; returns `[]` on any error

---

## Event Type Registry

All events share a common envelope: `{ type, phase, timestamp, detail }`.

| Type | Emitted By | Detail Shape |
|------|-----------|--------------|
| `phase_transition` | `saveCheckpoint()` | `{ from, to, fromName, toName }` |
| `checkpoint_saved` | `saveCheckpoint()` | Full checkpoint data (phase, completedStories, etc.) |
| `checkpoint_cleared` | `clearCheckpoint()` | `{}` |
| `subagent_completed` | `subagent-stop.mjs` | `{ agentType, toolName, messageLength }` |
| `verification_result` | `addVerification()` | `{ story_id, verdict, criteriaCount, failCount, verifiedBy }` |
| `worker_spawned` | (future: Athena skill) | `{ workerName, storyId }` |
| `worker_completed` | (future: Athena skill) | `{ workerName, storyId, verdict }` |
| `worker_failed` | (future: Athena skill) | `{ workerName, storyId, error }` |
| `run_finalized` | `finalizeRun()` | `{ status, storiesCompleted, duration_ms }` |
| `warning` | any caller via `addEvent()` | `{ message }` |

---

## File Changes Summary

| File | Change Type | Description |
|------|------------|-------------|
| `scripts/lib/run-artifacts.mjs` | Extend | Add `getActiveRunId`, `setActiveRunId`, `replayEvents`, `verifyStory`, `getRunVerificationSummary`, `generateCompletionNotices`; extend `createRun` to write active-run file; extend `finalizeRun` to delete active-run file and emit event; extend `addVerification` to accept criteria array and emit event |
| `scripts/lib/checkpoint.mjs` | Extend | Import `getActiveRunId`, `addEvent` from run-artifacts; emit `phase_transition` and `checkpoint_saved` events inside `saveCheckpoint`; emit `checkpoint_cleared` in `clearCheckpoint`; export `PHASE_NAMES` |
| `scripts/subagent-stop.mjs` | Extend | Import `getActiveRunId`, `addEvent`; emit `subagent_completed` event alongside existing FIFO |
| `scripts/test/run-artifacts.test.mjs` | Extend | Add tests for all new exports |
| `scripts/test/checkpoint-events.test.mjs` | New | Tests for event emission from checkpoint functions |
| `scripts/test/completion-notices.test.mjs` | New | Tests for `generateCompletionNotices` |

---

## Success Metrics

| Metric | Target |
|--------|--------|
| All existing checkpoint tests pass unchanged | 100% |
| All existing run-artifacts tests pass unchanged | 100% |
| New tests for event emission, replay, criterion-level verification, and completion notices | 40+ new test cases |
| `saveCheckpoint` / `loadCheckpoint` / `clearCheckpoint` / `formatCheckpoint` signatures unchanged | 0 breaking changes |
| `addEvent` / `addVerification` / `createRun` / `finalizeRun` signatures remain backward-compatible | 0 breaking changes |
| `replayEvents` reconstructs state matching latest `checkpoint_saved` event | Verified in tests |
| `generateCompletionNotices` returns `[]` when no gaps exist | Verified in tests |
| No npm dependencies added | 0 |

---

## Constraints

1. **Zero npm dependencies** -- Node.js built-ins only (fs, path, crypto)
2. **ESM modules** -- all files are `.mjs`
3. **Fail-safe** -- every new function wraps its body in try/catch and returns a safe default on error; never throws
4. **File permissions** -- `0o600` for data files, `0o700` for directories
5. **Backward compatible** -- all existing function signatures and return types remain unchanged; new parameters are optional
6. **Sync/async boundary** -- `run-artifacts.mjs` uses sync fs (readFileSync, appendFileSync); `checkpoint.mjs` uses async fs (promises API). Event emission from checkpoint must use sync fs to match run-artifacts conventions, or handle the async/sync boundary explicitly
7. **No SKILL.md changes** -- skills continue calling the same checkpoint API; integration happens internally

---

## Risks and Unknowns

### R1: Sync/Async Boundary (Medium)
`checkpoint.mjs` uses `fs.promises` (async). `run-artifacts.mjs` uses `readFileSync`/`appendFileSync` (sync). When `saveCheckpoint()` emits events via `addEvent()`, it will call sync fs functions from an async context. This is safe in Node.js (sync calls block the event loop briefly) but worth noting. The alternative -- making `addEvent` async -- would require changing its signature (breaking).

**Mitigation**: Use sync `addEvent()` from async `saveCheckpoint()`. The append is a single small write; blocking is negligible.

### R2: Active Run File Race Condition (Low)
If two orchestrators (atlas and athena) run simultaneously, they each have their own active-run file (`ao-active-run-atlas.json`, `ao-active-run-athena.json`), so no conflict. If the same orchestrator is somehow started twice, the second `createRun` overwrites the active-run pointer. This is acceptable -- the old run becomes orphaned but its artifacts are preserved.

### R3: Event Log Size (Low)
A long-running orchestration with many subagents could generate hundreds of events. Each event is one JSONL line (typically 200-500 bytes). At 500 events, the file is ~250KB -- well within acceptable limits. `replayEvents` reads the full file, which is fine at this scale.

### R4: Completion Notice False Positives (Medium)
Evidence-matching for gap detection uses substring search on the `evidence` field. If a passing criterion mentions "codex" in its evidence text, it would NOT trigger a false positive because we only scan `verdict: 'skip'` or `verdict: 'fail'` entries. However, creative evidence wording could still cause misclassification.

**Mitigation**: Document the exact substring patterns. Allow callers to pass custom gap detectors in a future iteration.

---

## Open Questions

1. **Should `replayEvents` be used as the PRIMARY path for `loadCheckpoint`, or only as a fallback?** Current spec treats it as a fallback/recovery tool. Making it primary would make the checkpoint file purely a cache. Recommendation: keep checkpoint file as primary for now (simpler, faster), add `replayEvents` as recovery path.

2. **Should worker_spawned/worker_completed/worker_failed events be emitted in this iteration?** The event types are defined in the registry, but the Athena SKILL.md would need modification to call `addEvent()` for worker lifecycle events. Recommendation: define the types now, defer SKILL.md integration to a follow-up.

3. **Should `generateCompletionNotices` be called automatically by `finalizeRun`, or left to the caller?** Recommendation: leave it to the caller. `finalizeRun` should not grow implicit side effects.
