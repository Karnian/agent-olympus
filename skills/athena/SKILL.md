---
name: athena
description: Self-driving hybrid team orchestrator — native Claude collaboration plus bridged Codex/Gemini workers
---

# Athena

Use Athena when the task has non-overlapping work packages that benefit from
discovery sharing. Claude teammates may coordinate directly. The lead dispatches
Codex and Gemini through their adapters and relays results to the team.

## Start or resume

Keep the working directory at the target Git repository. The installed plugin
root for this invocation is `${CLAUDE_PLUGIN_ROOT}`. Use that absolute path to
open [the Athena phase reference](reference.md) and to resolve every
`CLAUDE_PLUGIN_ROOT` placeholder in its examples. Export the same value for
Node subprocesses.

1. Read the **Phase_Runner** section in the reference, including
   `AO-CONTRACT:runner-init`. Follow that block once. It sends the exact current
   user request on stdin to the installed `scripts/athena-bootstrap.mjs` and
   reads the run ID and resume phase from its JSON response.
2. Preserve the existing run, ledger and worktrees if admission or recovery
   fails or the runner reports degraded state. A resumed spawn, monitor or
   integration phase requires the reference’s recovery checks before dispatch.
3. Find the heading for the active phase in the reference and read that section
   through the next phase heading. Keep the returned run ID across phase
   transitions. Each phase's entry, completion and retry conditions apply on
   every invocation, including after context compaction.

| Runner phase | Reference heading |
|---|---|
| Triage and context | Phase 0 |
| Specification | Phase 0.5 |
| Plan | Phase 1 |
| Spawn | Phase 2 |
| Monitor and capture learnings | Phase 3 and Phase 3b |
| Integrate and verify | Phase 4 |
| Review | Phase 5 |
| Finalize and review the final tree | `enterPhase(runId, 'finalize')` at the end of Phase 5, then Phase 5b through Phase 5e |
| Ship and monitor CI | Phase 6 and Phase 6b |
| Complete and release team resources | COMPLETION |

For explicit managed execution, first read **Managed_Execution_Backend** in
the reference and `${CLAUDE_PLUGIN_ROOT}/docs/internals/athena-runtime.md`.
Native teams and lead-bridged adapters are the default. A managed worker batch
returns execution evidence to the same review and finalization phases.
