# Managed Athena execution runtime

This opt-in backend supports concurrent provider workers and broker-managed
leaf agents. Legacy Athena/native teams, Atlas, `/ask`, and read-only review
workers retain their existing lifecycle. The runtime performs local task
execution and integration; its `completed` status is not full pipeline review,
release approval, a PR, or successful shipping.

Run commands from the project root, using the plugin's absolute script path
when the target project does not contain the plugin sources.

```sh
node scripts/athena-runtime.mjs capabilities
node scripts/athena-runtime.mjs start .ao/prd.json .ao/runtime-options.json
node scripts/athena-runtime.mjs tick <run-id>
node scripts/athena-runtime.mjs status <run-id>
node scripts/athena-runtime.mjs cancel <run-id>
```

`start` requires a clean committed tree, an execution-enriched AO_SPEC PRD,
available provider launch controls, and explicit verification commands. Options:

```json
{
  "verification": [
    { "command": "npm", "args": ["test"] },
    { "command": "npm", "args": ["run", "check"] }
  ],
  "childCapacity": {
    "api-worker": { "codex": 2 },
    "ui-worker": { "gemini": 1 }
  }
}
```

Choose verification commands for the target project. No shell parses these
argument arrays. The lead calls `tick` while work is active and reports changes
in status. Each tick adopts the exact persisted worker generation; it never
blindly replays an ambiguous launch. An integration crash with an unexplained
HEAD change stops for reconciliation rather than repeating a merge.

The backend serializes assignments to the same logical worker, admits ready
independent stories in parallel, and starts dependent stories only after their
inputs are integrated and the configured verification passes. Globally disjoint
cross-worker scopes are still required. Existing PRD validation keeps rejecting
multiple groups and cross-worker dependencies unless the scheduler explicitly
selects `allowDependencyWaves`.

## Worker and child lifecycle

Supervisors keep running after an assignment completes. Task acknowledgements
and results live in generation-bound mailboxes. Codex app-server and Gemini ACP
reuse their sessions; exec adapters use explicit task chaining. Codex app-server
supports steering of the pinned active task. Unsupported steering is rejected.

```sh
node scripts/athena-runtime.mjs command <team> <worker> <generation> .ao/command.json
node scripts/athena-runtime.mjs result <team> <worker> <generation> <command-id>
```

Command JSON uses `type: assign` with `prompt`, `steer` with `prompt` and
`expectedTaskId`, `interrupt` with `expectedTaskId`, or `shutdown`. Reusing an id
with different content fails; accepted work from a lost supervisor is not
automatically replayed. Idle and total worker lifetimes are bounded.
Each batch assignment receives a fresh one-use broker bootstrap and private
provider configuration. Session adapters retain their existing connection across
turns. The supervisor independently rejects managed non-persistent manifests.

Each managed parent receives `ao_runtime` MCP tools: `spawn`, `inspect`,
`followup`, `cancel`, `integrate`, and `discard`. A spawn request specifies a
unique lowercase hex id, provider, prompt, explicit scope, and optional readOnly.
The broker takes parent identity from the connection, never from request fields.
Children are leaves with native delegation disabled and no inherited parent MCP
configuration or bootstrap credentials. Bootstrap files are private, single-use,
short-lived, and outside the project; child tools cannot mint a parent identity.
Child manifests copy only execution identity, scope, timeout, and the resolved
permission grant. They use the chosen provider's default model and do not inherit
the parent's model, system prompt, per-invocation budget, or MCP/tool options.
A parent's `maxBudgetUsd` is not a shared subtree spending limit.

Child capacity is reserved before the parent launches, by provider. Reserved to
active conversion does not increase the charged slot count. A request exceeding
the reservation is denied with a serial fallback. Idle parents retain their
reserved capacity until subtree shutdown. Provider failover must not use the
legacy root-only replacement path while children remain live; cancel/reconcile
the subtree before replanning its provider reservation.

Every child works on an isolated branch from a clean parent checkpoint. A parent
may commit only its own assigned changes to obtain this checkpoint. `integrate`
checks child scope and clean status before merging. The parent must re-run its
acceptance checks after integration; the scheduler then verifies the integrated
wave. Read-only results must be inspected, and writable results must be integrated
or explicitly discarded, before parent task completion succeeds. `followup`
chains a new leaf task from a resolved result and the current parent checkpoint;
it does not claim live steering or continuity of the old batch process.

Cancellation fences new admission, terminates descendants, and then releases
capacity. A fresh process can reap recorded children after a killed parent.
Ambiguous child launches or unconfirmed termination retain evidence and slots.
Managed worktrees and branches are retained for inspection, including discarded
child work; cancellation does not force-delete them.

## Failure and recovery

Task, scope, integration, and verification failures persist `status: failed`
before stopping the current wave. Every peer is shut down and its subtree slots
are released only after confirmed termination. Subsequent ticks return the
failure; they only retry unfinished cleanup, never assignments or verification.
An unproven termination retains capacity and records `cleanupError` on the wave.

Verification can fail after some branches have already been merged. The state
retains each `mergeCommit`, the wave's `baseCommit`, expected/observed HEAD, and
the failure message. These merged tasks are `merged_unverified`; dependent work
does not launch. Inspect the commits, preserve any subsequent user changes, and
either repair and verify them or explicitly revert the recorded merges in reverse
order with `git revert -m 1 <merge-commit>`. The runtime does not reset or revert
the user's branch automatically. Start a new run from a clean checkpoint after
reviewing the retained failure.

Use `cancel <run-id>` for ordinary recovery, including after a killed supervisor.
If missing team evidence or an unrecorded launch prevents cancellation:

1. Stop every launcher, supervisor, adapter, and descendant for that run. Inspect
   `.ao/state/supervisor/<runId>/` snapshots and child sidecars, plus the OS process
   list. A missing PID does not prove that a process was never started. Preserve
   run state, outputs, branches, and any uncommitted work before proceeding.
2. Run `node scripts/athena-runtime.mjs reservations` and identify the exact
   `parentEntryId`, entries, and digest of the orphaned subtree.
3. Only after confirming **all** its processes and launchers are stopped, run:

   ```sh
   node scripts/athena-runtime.mjs reconcile <parent-entry-id> <digest> --confirm-stopped
   ```

   This is an explicit offline operator acknowledgement for unrecorded launches,
   not automatic liveness proof. The command refuses changed reservations and
   known live/unproven owners, supervisors, or adapters. It writes an audit request
   containing the original entries under `.ao/artifacts/runtime-recovery/` before
   releasing only that subtree. Reinspect after any refusal; never reuse a digest
   for changed work. Run participants must remain stopped throughout recovery.
4. Retain the failed generation for audit and start a new run. Do not resume its
   saved commands. Downgrade remains possible only after the entire project is
   quiescent; reconciliation does not bypass that rule or repair corrupt formats.

### Retained worktree cleanup

After confirmed shutdown/reconciliation, inspect `git worktree list --porcelain`
and match worker/child paths and branches to the saved wave/child records. For
each selected worktree, inspect `git -C <path> status --short` and save any needed
uncommitted files or commits. Then use `git worktree remove <path>` without
`--force`; dirty worktrees remain protected. Branches remain recoverable after
removal. Delete a branch only after checking its result is integrated or exported;
`git branch -d <branch>` refuses branches which are not merged. Do not recursively
delete `.ao/worktrees` while workers are active. Retain state and audit records.

## Ledger compatibility and current control limits

Ordinary callers retain ledger v2 until the explicit runtime opt-in. First use
performs the same migration as `athena-runtime.mjs migrate`: require a quiescent
v2 ledger, no pending queue/recovery barrier, no active durable team evidence,
and no active Atlas/Athena state. A durable migration marker protects a v3 ledger
from being silently reset when missing or corrupt. Existing hooks use the same
reader and count reserved subtree capacity. Old plugins reject v3; stop old
sessions and upgrade all participants together.

`athena-runtime.mjs migrate --downgrade` requires quiescence too. Never delete a
live ledger to bypass an upgrade or recovery diagnostic. Runtime slots are not
released by generic hook release or TTL cleanup.

Provider diagnostics report **configured**, not live-provider verification.
Claude receives an explicit built-in tool set without Task/Agent and an explicit
strict MCP config even under `--bare`. Codex disables both native multi-agent
features through strict config. The inspected Gemini 0.50.x settings contract
disables experimental agents through invocation-specific system settings;
unrecognized versions are unavailable pending validation. Managed Gemini ACP
uses current `session/*` methods and `session/update` text streaming; legacy
callers keep their prior protocol. No global provider configuration is rewritten.

The enforced admission cap covers the **managed task graph**. Unrestricted shell
tools and hostile same-user processes are outside that boundary. This backend
does not advertise a process-wide/spend-wide cap or verified suppression of every
provider-native path. Live native-tool exposure and provider MCP smoke tests
remain separate operator-controlled validation from the hermetic fixture suite.
Implementation-time diagnostics confirmed Claude Code 2.1.278's bare-mode MCP
connection, Codex 0.162.1's resolved feature flags and MCP registration, and
Gemini 0.50.0's current ACP session creation without starting model task turns.
