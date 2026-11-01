# Athena Parallel Agent Runtime

Status: proposed; runtime implementation has not started.
Updated: 2026-11-01 (PR #93 review revision)
Investigation base: `db474cd` (main, v1.6.1).

Related plans: [Adapter Worker Supervisor](../adapter-worker-supervisor/PLAN.md),
[Native Agent Teams](../native-agent-teams/spec.md), and
[Codex Interop](../codex-interop/PLAN.md). These are historical designs; use
the current implementation for API and lifecycle contracts.

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
| Current native child exposure | Writable Claude descriptors default to `allowedTools: null`; the CLI builder does not restrict the built-in tool set or explicitly deny Task/Agent. Codex worker launch does not set an explicit native-child prohibition. Existing Codex Interop notes record native child execution in a trusted repository on CLI 0.140.0. These establish a possible existing untracked path, not a verified result for the current Athena workers | `scripts/lib/worker-spawn.mjs`, `scripts/lib/claude-cli.mjs`, `scripts/lib/supervisor-opts.mjs`, `scripts/lib/codex-appserver.mjs`, [historical probe record](../codex-interop/PLAN.md#cross-review-resolutions-rev-1--rev-2) |
| Hook coverage | Claude CLI workers default to `--bare`; nested admission cannot depend on Olympus hooks running inside those workers | `scripts/lib/claude-cli.mjs` |

One task turn may already involve many model/tool interactions. The limitation
is the worker lifecycle and coordination boundary, not a single inference.

**Current exposure remains unverified at runtime.** Absence of an explicit
tool restriction does not prove that a particular CLI/version exposes a native
spawn tool, and `allowedTools` alone is not evidence of tool removal. No current
Athena worker was launched to test native child creation in this investigation.
The existing limits count admitted workers; they do not establish a total
count of all provider-native descendants. Audit Claude native teammates,
fallback subagents, and each external adapter separately rather than assuming
the Claude CLI path describes all Claude workers.

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

### Native child exposure gate

Before enabling persistent managed workers, inventory the effective native
spawn tools and configuration for each supported execution path. Default to
disabling provider-native child creation for both parent workers and leaves;
managed children are launched only by the broker. For Claude CLI, distinguish
removing Task/Agent from the available tool set from simply omitting them from
an auto-approval list. Codex and Gemini need version-specific capability and
restriction checks, not guessed flags or prompt-only prohibitions.

An unsupported or unverified restriction reports managed-child capability as
unavailable and prevents entry to the bounded-child mode for that path. A
diagnostic must explain the missing control. Existing batch behavior may stay
available with its existing limitations, but cannot be relabeled as enforcing
the new descendant limit. Test both argument/configuration propagation and
actual attempted native spawning before advertising this capability.

This gate controls supported native agent interfaces. Unrestricted Bash or
equivalent tools can launch another provider CLI independently. A worker-scoped
broker credential and POSIX file modes do not isolate hostile processes under
the same user. The guaranteed cap therefore covers the managed task graph;
claiming a process-wide or spend-wide cap additionally requires a validated
execution boundary that prevents those launches. Do not advertise that stronger
guarantee merely because native spawn tools are disabled.

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
Use a narrow, explicitly configured MCP connection per worker, not a general
Bash CLI carrying a reusable parent token. Exact tool names are an implementation
detail, not an existing API.

Every child is an admitted worker with a parent identity, task identity,
provider, explicit scope, pinned input revision, and terminal evidence. Child
requests use a trusted runtime binding; a project-local file claiming a parent
identity does not authorize a spawn. Unknown policy/schema versions fail closed.

The supervisor registers the immutable worker identity, parent identity,
generation, role, and permitted operations with the broker. A worker-local MCP
proxy attaches using a single-use, short-lived bootstrap capability delivered
through private launch configuration outside the project; attach consumes and
revokes that capability and binds subsequent requests to the established
connection. The broker ignores caller-supplied attempts to replace that identity.
The existing runtime permission grant remains permission authority, not a token
that a worker can use to mint broker identities.

Claude `--bare` workers receive explicit MCP configuration rather than relying
on plugin discovery or hooks. Installed `claude --help` lists explicit
`--mcp-config` and `--strict-mcp-config` support, including with `--bare`; this
is launch-surface evidence only, not a successful broker connection test. The
implementation must wire and test this configuration through the manifest,
option builders, and CLI argv. Codex/Gemini require equivalent explicit
configuration and capability tests; unsupported paths report unavailable.

Each child gets a fresh connection with leaf operations only. Launch the child
from a sanitized supervisor environment/configuration, never by inheriting the
parent's provider MCP configuration, bootstrap capability, transport handles,
or custom environment. Keep bootstrap secrets out of prompts, project artifacts,
logs, and the provider process environment; revoke them on timeout, cancellation,
or attach. Reattachment requires supervisor authorization and fresh credentials.
Tests must inspect child launch data and reject replay and parent impersonation.
This prevents accidental credential inheritance and enforces broker-side leaf
policy; it does not eliminate the same-user execution limitation above.

Start with one child generation below top-level workers. Child agents are
leaves and cannot create their own teams. Bound children per parent and across
the whole run. Root workers plus active descendants count against the same
global and per-provider limits.

**Capacity decision: reserve child capacity at parent admission.** Atomically
reserve the parent's slot plus a bounded vector of child slots by provider
before launch. For example, one Claude parent with two Codex child slots charges
three global slots, one Claude slot, and two Codex slots. Reserved child slots
transition to active child assignments under the same ledger lock; they are not
additional charges. On confirmed child termination they return to the parent's
reservation for reuse. Idle parents keep their slot and unused child reservations
until explicit subtree shutdown or verified reclamation. This trades utilization
for predictable progress; waiting parents do not release and reacquire slots.

If the complete reservation cannot fit, defer the parent before launch or
explicitly assign a serial plan with no required child delegation. Do not admit
a parent that must wait for unreserved children. Requests beyond the reserved
vector return a bounded denial/serial fallback, not an unbounded wait. Provider
failover requires an atomic capacity transfer to the new provider; if unavailable,
it must stop/defer rather than borrowing uncharged capacity. Every managed child
request requires a matching reservation even when other global capacity is free.
Cancellation fences conversion of reserved slots before descendant shutdown.

Read-only children receive a pinned snapshot. Mutation-capable children use
isolated worktrees based on a clean committed parent checkpoint, with scopes
contained in the parent's assignment and disjoint from concurrently edited
scopes. The parent integrates their committed results and re-verifies the
resulting tree. A review result is valid only for its exact reviewed revision.
Permissions never exceed the parent's grant.

The parent checkpoint commit must cover only that worker's assigned changes in
its isolated branch, under the explicit Athena execution workflow. It is not
permission to stage or commit the user's pre-existing work or the shared main
worktree. If a clean authorized checkpoint is unavailable, defer writable child
delegation or continue serially; never auto-commit unrelated changes to unblock it.

The managed broker path is the provider-independent baseline. Provider-native
child execution is a later optimization only when preflight proves support
and Olympus can account for and cancel every descendant. Untracked native
spawning must not silently bypass the managed policy. The exposure gate applies
before enabling this managed mode, including when native optimization is unused.

### Ledger v3 and compatibility

**Decision: change the shared admission ledger from v2 to v3.** Add explicit
subtree/parent identities and reserved-versus-active capacity semantics to the
authoritative ledger. A separate graph artifact may hold task details, but must
not be the only place where child capacity or parent authority is recorded.
Command/mailbox and broker identity formats remain independently versioned.
All shared admission, release, and recovery consumers, including hooks and
non-Athena callers, must understand v3 before the project switches formats.
Their existing task behavior remains unchanged; they must respect capacity
reserved by Athena rather than counting only executing child processes.

Migration requires a quiescent project: drain existing workers and hook tasks,
stop old plugin sessions, and retain any ambiguous recovery barrier. Under the
shared ledger lock, verify a valid v2 ledger has no active entries or pending
queue, reconcile durable team/supervisor and native-session evidence to prove
no old worker is live, and atomically write v3. A missing/empty ledger alone
does not establish quiescence. Active, malformed, or unresolved state blocks
migration with an upgrade diagnostic; never discard it or synthesize parentage.
Legacy v1 state must first use its supported v2 migration and the same drain.

Mixed v2/v3 writers against one project are unsupported. Old loaders reject v3
and preserve its bytes, deliberately blocking admission instead of dropping new
semantics. Update all participating sessions before enabling the new mode. A
downgrade requires the same quiescence proof and an explicit v3-to-empty-v2
migration; never delete/reset a live ledger to make an old plugin run. Unknown
future versions remain untouched and fail closed. Recovery must reconstruct
reserved capacity and active descendants together, never only the live children.

### Dependency-aware scheduling

This is an independent workstream. It can ship before managed child execution
once its own ledger/recovery contracts are satisfied; broker completion is not
a prerequisite. The initial rollout may retain single-task workers for each wave.

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

0. **Native exposure and transport spike.** Record effective native spawn-tool
   exposure for every enabled worker path and prove the default restriction, or
   mark bounded-child execution unavailable for that path. Verify explicit MCP
   configuration works in `--bare` Claude and supported Codex/Gemini paths.
   Separate hermetic wiring checks from operator-controlled live tool-attempt
   evidence; historical Codex probes do not satisfy current-worker validation.
1. **Persistent supervisor and command mailbox.** Preserve the exposure gate
   from step 0; persistence must not silently enable native spawning. A
   fresh-process caller sends a follow-up to the same managed worker; it
   receives an acknowledgement and
   a distinct task result. Duplicate command ids do not launch another task.
   A stale generation/turn is rejected. Existing batch callers still complete
   and shut down as before. Test real detached fixture processes, not only
   regex contracts or in-process adapter mocks.
2. **Ledger v3, shared child admission, and broker.** Migrate only after the
   quiescence checks above. Test active-v2 migration refusal, v3 rejection by the
   old reader, unknown-version preservation, and downgrade refusal with live or
   ambiguous descendants. Fill capacity with reserved subtrees and prove child
   progress without double-charging, waiting-parent slot release, or oversubscription.
   Verify the native-spawn restriction still holds for parents and leaves. Test
   that leaf connections cannot spawn, replay a parent bootstrap capability, or
   override their bound identity. Two children run concurrently under
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
4. **Dependency waves (independent; may move earlier).** Two independent
   assignments overlap in execution; a dependent assignment begins only after
   integration and observes the new revision. Resume neither duplicates an
   active task nor adopts stale results.
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

Review revision checks: re-read the launch/option/ledger code and the historical
Codex Interop probe record; inspect local `claude --help` without a model call.
No current-provider native-child or MCP-connection smoke test was performed.
