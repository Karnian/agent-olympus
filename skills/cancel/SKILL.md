---
name: cancel
description: Graceful shutdown of running Atlas/Athena sessions — clean up state, tmux, and team resources
---

<Cancel>

## Purpose

Gracefully stop one running Atlas or Athena session without destroying the
evidence needed to prove its run identity. An active-run pointer and its
pipeline are authoritative; a checkpoint is only a recovery cache.

## Use_When

- User says "cancel", "취소", "stop", "abort", "중지"
- Need to abort a running Atlas/Athena session
- Something went wrong and you need a safe, explicitly terminal restart

## Steps

### 1. Prove the Exact Active Run First

Do not infer activity from an old state file or checkpoint. Resolve the active
pointer and validate that its ledger has exactly one current `in_progress`
phase before changing any team, worktree, checkpoint, or state file.

```javascript
// AO-CONTRACT:cancel-proof
import { getActiveRunId } from './scripts/lib/run-artifacts.mjs';
import { getPhaseSequence, getPipelineState } from './scripts/lib/phase-runner.mjs';
import { loadCheckpoint } from './scripts/lib/checkpoint.mjs';

const candidates = ['atlas', 'athena']
  .map(orchestrator => ({ orchestrator, runId: getActiveRunId(orchestrator) }))
  .filter(candidate => candidate.runId);
if (candidates.length !== 1) {
  throw new Error('Active run is absent or ambiguous; preserve state and stop');
}
const { orchestrator, runId } = candidates[0];
const ledger = getPipelineState(runId);
const inProgressPhases = getPhaseSequence(orchestrator)
  .filter(({ id }) => ledger?.phases?.[id]?.status === 'in_progress');
const currentPhase = inProgressPhases[0]?.id;
if (ledger?.orchestrator !== orchestrator || inProgressPhases.length !== 1) {
  throw new Error('Run identity or current phase is unproven; preserve everything and stop');
}
const checkpoint = await loadCheckpoint(orchestrator);
if (checkpoint?.runId && checkpoint.runId !== runId) {
  throw new Error('Checkpoint belongs to another run; preserve everything and stop');
}
```

If there is no active pointer but a checkpoint still names a run, use normal
orphan recovery first. Missing, corrupt, linked, or identity-unproven
artifacts are a **STOP and preserve** condition — never clear the checkpoint
to make a new run appear safe.

### 2. Refuse Destructive Live-Team Cancellation

Before terminalization, prove that no external worker remains live. If the
ledger/checkpoint reports a native team, adapter supervisor, or tmux worker
whose terminal state cannot be authenticated for this `runId`, preserve the
run, team, worktree, checkpoint, and state and STOP. Report that the live team
needs explicit operator recovery; do not silently convert uncertainty into a
new run.

Do **not** call `shutdownTeam()`, `cleanupTeamWorktrees()`, send native-team
shutdown requests, perform broad tmux enumeration, or use manual prefix matching
from `/cancel` while the run is
active: `shutdownTeam()` cleans team state/worktrees, while the terminal-failure
proof must still read that evidence. There is currently no non-destructive,
run-bound live-worker cancellation primitive. A session-name similarity is not
run ownership proof.

For Athena, `spawn` and `monitor` are always preserve-and-stop states. A later
Athena phase may proceed only when the durable spawn/monitor evidence proves an
**adapter-only** team with the exact generation and every intended worker already
`completed`; native, mixed, missing, or live-worker evidence remains
preserve-and-stop. Atlas may proceed only with the exact current phase proof
from Step 1 and separately authenticated worker/session state. Do **not**
delete `.ao/teams`, `.ao/worktrees`, a checkpoint, or state files before that
proof succeeds.

### 3. Publish a Categorized Terminal Cancellation

Only after the applicable no-live/terminal-roster proof above, terminalize the
exact current phase. This is the point at which a restart becomes eligible; it
is not optional bookkeeping.

```javascript
// AO-CONTRACT:cancel-terminalize
import { finalizeFailedRun } from './scripts/lib/run-failure.mjs';
import { getActiveRunId } from './scripts/lib/run-artifacts.mjs';

const terminal = finalizeFailedRun(runId, {
  orchestrator,
  failureClass: 'cancelled',
  code: 'user_cancelled',
  phase: currentPhase,
});
if (!terminal.ok || getActiveRunId(orchestrator) === runId) {
  throw new Error('Cancellation terminalization or pointer clear failed; preserve everything and stop');
}
```

If the ledger is corrupt, the phase is not provably `in_progress`, the failure
transition cannot be persisted, or the matching pointer remains, do not clean
up. Preserve the run, team, worktree, checkpoint, and state for manual
recovery.

### 4. Clean Only the Now-Terminal Resources

After the terminal marker and pointer-clear check succeed:

- Call `clearCheckpoint(orchestrator)` for the exact cancelled run.
- Remove only that orchestrator's transient state and PRD when no other active
  run owns it.
- For Athena, read the proven team slug before cleanup, call the native-team
  shutdown/delete operation, then call `cleanupTeamWorktrees(cwd, teamSlug)`.
  Do not use `rm -rf .ao/teams/`; it can erase another run's evidence.
- Keep `.ao/wisdom.jsonl`.

### 5. Report

Tell user:
- What was cancelled (Atlas/Athena)
- What phase it was in when cancelled
- Whether the terminal marker and active-pointer clear were verified
- What was cleaned and what was preserved
- If preservation was required, the exact safety reason and that no restart was attempted

## Resume After Cancel

After a verified cancellation, a later `/atlas` or `/athena` invocation creates
a new run and may reuse `.ao/wisdom.jsonl`; it does not resume the cancelled
run. If cancellation could not be terminalized, preserve state and resolve the
existing run through recovery rather than starting another team.

## Notes

- Cancellation is safe only when its terminal marker and matching pointer-clear
  are verified; otherwise preservation is the safe result.
- Tmux sessions are stopped gracefully where possible (SIGTERM, not SIGKILL).
- Checkpoints are cleared only after terminalization; a checkpoint alone never
  authorizes a fresh run.

</Cancel>
