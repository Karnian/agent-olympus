# Athena Parallel Agent Runtime

Status: proposed; runtime implementation has not started.
Updated: 2026-10-31
Investigation base: `db474cd` (main, v1.6.1).

## Requested outcome

Support both forms of parallel execution:

1. Athena operates multiple Claude, Codex, and Gemini workers concurrently.
2. A worker can delegate bounded subtasks to concurrent child agents and use
   their results before finishing its own assignment.

The second form must be an observable part of the Athena run. Merely enabling
a provider's internal agent feature does not establish admission, ownership,
recovery, or cancellation in Agent Olympus.

## Evidence from the current implementation

| Area | Current behavior | Source |
|------|------------------|--------|
| Parallel launch | Launches detached supervisors without awaiting each worker's task completion; reserves the external batch in the shared concurrency ledger | `scripts/lib/worker-spawn.mjs`, `scripts/lib/concurrency-limits.mjs` |
| External worker lifetime | Starts one prompt/turn, collects its result, shuts down the adapter, writes terminal evidence, and exits | `scripts/lib/adapter-worker-supervisor.mjs` |
| Provider messaging | Codex has `steerTurn`; Gemini ACP has `enqueueMessage`. These need live in-process handles. The detached supervisor has no command ingress connecting Athena to these functions | `scripts/lib/codex-appserver.mjs`, `scripts/lib/gemini-acp.mjs` |
| Task scheduling | Athena requires one parallel group and rejects dependencies between different workers | `scripts/lib/execution-prd.mjs` |
| Child agents | Repository role definitions exist, but the Athena worker definitions and supervisor manifest do not carry a child-agent policy or a managed parent/child lifecycle | `.codex/agents/`, `scripts/lib/execution-prd.mjs`, `scripts/lib/worker-spawn.mjs` |
| Hook coverage | Claude CLI workers default to `--bare`; nested admission cannot depend on Olympus hooks running inside those workers | `scripts/lib/claude-cli.mjs` |

One task turn may already involve many model/tool interactions. The limitation
is the worker lifecycle and coordination boundary, not a single inference.

## Proposed architecture

```text
Athena lead
  └─ run scheduler + shared admission ledger
       ├─ Claude worker
       │    ├─ child: exploration
       │    └─ child: tests
       ├─ Codex worker
       │    ├─ child: implementation
       │    └─ child: review
       └─ Gemini worker
            ├─ child: investigation
            └─ child: review
```

Provider choices and roles above are illustrative. A child need not use its
parent's provider. Admission and detected capabilities determine placement.

### Persistent external workers

Keep the supervisor as the owner of the live adapter handle. Add a durable,
generation-bound command mailbox that fresh-process lead calls can use.
Commands cover assignment, follow-up, steering where supported, interruption,
and shutdown. Each command has an id, target identity, expected turn where
applicable, and a durable acknowledgement/result.

Separate task completion from worker termination: a successful task moves a
worker to idle; explicit shutdown ends the worker. Idle lifetime and total
runtime remain bounded. Existing single-task callers retain their current
completion semantics unless they explicitly request persistent operation.

Codex app-server and Gemini ACP can reuse their existing session APIs after
the mailbox is connected. Exec/tmux adapters remain batch executors; subsequent
assignments use explicit task chaining or supported resume. Never advertise
live steering for a batch adapter, or infer that a queued command was delivered.

Crash handling distinguishes an accepted command, an active turn, a completed
turn, and a persisted result. Repeated polling must not duplicate execution.
If a crash leaves acceptance ambiguous, reconcile provider evidence where
available; otherwise preserve the run and report ambiguity rather than replay
a mutation automatically. This is not an exactly-once provider guarantee.

### Managed child agents

Expose a common child-task interface to workers through a broker owned by the
run, with operations equivalent to spawn, inspect/wait, follow-up, and cancel.
Exact tool/CLI names are an implementation detail, not an existing API.

Every child is an admitted worker with a parent identity, task identity,
provider, explicit scope, pinned input revision, and terminal evidence. Child
requests use a trusted runtime binding; a project-local file claiming a parent
identity does not authorize a spawn. Unknown policy/schema versions fail closed.

Start with one child generation below top-level workers. Child agents are
leaves and cannot create their own teams. Bound children per parent and across
the whole run. Root workers plus active descendants count against the same
global and per-provider limits. An idle but reusable worker does not bypass
the admission contract when a new turn starts.

Account for parent/child capacity before admitting leaders that require
delegation. Otherwise all slots can fill with parents waiting for children.
Reservations and active usage must not double-count capacity. If child capacity
is unavailable, return a durable deferred/denied outcome with a serial fallback;
do not block all parents indefinitely or exceed limits to make progress.

Read-only children receive a pinned snapshot. Mutation-capable children use
isolated worktrees based on a clean committed parent checkpoint, with scopes
contained in the parent's assignment and disjoint from concurrently edited
scopes. The parent integrates their committed results and re-verifies the
resulting tree. A review result is valid only for its exact reviewed revision.
Permissions never exceed the parent's grant.

The managed broker path is the provider-independent baseline. Provider-native
child execution is a later optimization only when preflight proves support
and Olympus can account for and cancel every descendant. Untracked native
spawning must not silently bypass the managed policy. Do not claim a hard cap
for a provider that cannot expose or constrain its internal child execution.

### Dependency-aware scheduling

Replace the one-wave restriction only after executable scheduling exists.
Launch ready, independent assignments together. Dependent assignments start
after required results are committed, integrated, and verified at the relevant
boundary. Create their worktrees from that integrated revision rather than
reusing worktrees created before their dependencies finished.

Persist task dependencies, ready/running/terminal states, assignment revisions,
and merge evidence. Merely relaxing PRD validation would allow workers to start
against missing dependencies and is not sufficient implementation.

### Recovery, visibility, and shutdown

Preserve current run-generation, PID start identity, worktree binding, and
permission-mirroring protections. Introduce independently versioned formats
for new commands and parent/child records. Keep private files/directories at
0600/0700 using the existing atomic/hardened filesystem helpers.

Show each worker's provider, parent, assignment, active/idle/blocked state,
and children in progress reporting. Task completion requires all required
children to be terminal and their results integrated or explicitly rejected.

Cancellation fences new child admission and stops the descendant tree before
cleaning up worktrees. A parent crash does not authorize releasing live child
slots or deleting child work. Athena completion requires the full task tree to
be terminal and all retained mutations to have integration evidence.

## Implementation increments and acceptance criteria

1. **Persistent supervisor and command mailbox.** A fresh-process caller sends
   a follow-up to the same managed worker; it receives an acknowledgement and
   a distinct task result. Duplicate command ids do not launch another task.
   A stale generation/turn is rejected. Existing batch callers still complete
   and shut down as before. Test real detached fixture processes, not only
   regex contracts or in-process adapter mocks.
2. **Shared child admission and broker.** Two children run concurrently under
   one parent, with durable identities and independently collected results.
   Root-plus-child limits hold under concurrent admission attempts and after
   recovery. Unsupported depth, forged bindings, expanded permissions, and
   overlapping mutation scopes are rejected before launch. Exhausted capacity
   produces a bounded fallback without parent/child deadlock.
3. **Provider and Athena integration.** Claude, Codex, and Gemini workers can
   request broker-managed children through supported tools. Capability checks
   distinguish persistent, steerable, batch, and managed-child execution.
   Tests cover assignment, follow-up, failure, parent cancellation, and leaf
   policy. Verify that provider-native children cannot bypass the advertised
   limit before advertising enforcement for that execution path.
4. **Dependency waves.** Two independent assignments overlap in execution; a
   dependent assignment begins only after integration and observes the new
   revision. Resume neither duplicates an active task nor adopts stale results.
5. **Full lifecycle validation.** Cover crash windows before/after command
   acceptance and result persistence, exhausted providers, descendants surviving
   parent failure, cancel/admission races, and cleanup with unmerged child work.
   Run the Node suite, syntax checks, and hermetic eval gates. Paid live provider
   trials remain operator-controlled under the existing eval policy.

## Scope boundaries

No unlimited recursive orchestration, shared writable worker directories, or
promise of identical provider-native agent APIs. No change to Atlas, `/ask`,
or review-worker lifetime as an incidental effect of Athena persistence.

This proposal requires executable modules, adapters, schema changes, tests,
and documentation together. Editing the Athena prompt alone cannot implement
the requested behavior.

## Investigation validation

`node --test` over `athena-native-team-contract`, `athena-start`,
`athena-recovery`, `execution-prd`, `worker-spawn-integration`, and
`adapter-worker-supervisor`: 102 tests passed, zero failures. These validate
the existing implementation; they do not prove this proposed runtime exists.
