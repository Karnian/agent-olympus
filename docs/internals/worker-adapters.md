# Detached Worker Supervisor (v1.2.0+)
> Moved verbatim from CLAUDE.md (Codex Interop v1, Ship order 1).

### Detached Worker Supervisor (v1.2.0+)

**Problem.** Atlas/Athena orchestration is **fresh-process-per-poll**: `monitorTeam` / `collectResults` / `shutdownTeam` each `loadTeamState()` from disk in a brand-new Node process. A live in-process adapter handle (`_liveHandle`) does NOT survive that boundary — `saveTeamState` strips it (`NON_SERIALIZABLE_WORKER_KEYS`). Before v1.2.0 the five non-tmux adapters spawned in-process, so once the orchestrator re-polled in a fresh process their completion was invisible and the workers were stuck `status: 'running'` forever (a fresh `monitorTeam` had no handle to read).

**Fix (the "FLIP").** `spawnTeam` no longer spawns adapters in-process. For every non-tmux worker it launches a **detached supervisor** — `node scripts/lib/adapter-worker-supervisor.mjs <manifest>` (`detached: true`, `unref`, `stdio: 'ignore'`) — that loads the adapter ITSELF, runs one prompt to terminal completion, and writes **atomic disk snapshots + a durable output file**. A fresh-process orchestrator then reads the worker's outcome from disk. tmux workers are unchanged (still `capturePane`-classified).

- **Run identity** — `allocateTeamRunId()` lets Athena mint the random 16-hex generation before launch, persist it in both the pipeline ledger and checkpoint, and pass it through `spawnTeam(..., { runId })`. Callers that omit the option retain the old behavior: `spawnTeam` allocates the generation internally. The exact ID is stamped into team state together with absolute `projectRoot`; each worker gets a `workerRunId`, and the persisted `_handle = { supervisorPid, supervisorStartId, runId, workerRunId }` is fully serializable. Athena adoption proofs, monitor completion evidence, and runtime team state must all match that preallocated generation, so a same-slug prior team cannot be adopted. The supervisor's snapshot/output/manifest paths are DERIVED from the absolute `projectRoot` + these validated hex IDs (the manifest is NOT consulted for any explicit module/snapshot/output path), so a STALE supervisor from a prior same-name run can never be read as the current one.
- **Snapshot lifecycle** (`scripts/lib/supervisor-state.mjs`, schemaVersion:1) — atomic `writeSnapshot` (0600, clamped output tail), `readSnapshot(path, expected)` with a 5-way result (`missing` / `corrupt` / `unsupported` / `mismatch` / `ok`), heartbeat freshness (future-skew bounded), HEARTBEAT_INTERVAL 10s / STALE 90s / STARTUP_GRACE 10s.
- **Readers** (`worker-spawn.mjs`) — `monitorSupervisorWorker` maps a snapshot → MonitorResult: terminal status wins; `running` + dead supervisor (PID start-time identity mismatch) → crash; `running` + stale heartbeat → crash on the 2nd consecutive poll (`_supStaleSeen` latch); missing snapshot past startup grace (or a future `startedAt`) → crash; `mismatch`/`corrupt` → invalid. `collectResults` reads the durable output file (under `.ao/artifacts/team/`). `shutdownSupervisorWorker` is **supervisor-first**: signal the supervisor group (its SIGTERM handler shuts the adapter down) → re-read the snapshot → reap a surviving adapter group via the F3 start-id-checked kill → scrub the prompt-bearing manifest.
- **Adapter dispatch** — the supervisor's `run*` functions use pure manifest→option builders in `scripts/lib/supervisor-opts.mjs` (`buildExecOpts` / `buildAppserverThreadOpts` / `buildGeminiAcpSessionOpts`), kept in a CLI-free module so the wiring is unit-testable without importing the supervisor (which runs `main()` on import). gemini `model` rides on `createSession` (→ `unstable_setSessionModel`), NOT `startServer`.
- **Manifest hygiene** — the manifest carries the raw prompt. It is DATA for behavior (and supplies `projectRoot`/`cwd`), but NO explicit module/snapshot/output path is ever read from it — those are derived from the absolute `projectRoot` + validated IDs. The supervisor truncates+unlinks it on startup; a launch failure or an early shutdown also truncates+unlinks it so the prompt never lingers to the 24h sweep.
- **SessionEnd** — `session-end.mjs` sweeps the supervisor tree **per-run** (never wholesale) and skips a run with a `running` snapshot that has a fresh heartbeat OR a live supervisor PID (identity-checked when a `supervisorStartId` is recorded and readable; otherwise it fails open to a bare `kill(pid,0)` existence probe).
- **Security** — the built-in `fixture` adapter (test-only) is selectable ONLY when `AO_SUPERVISOR_ALLOW_FIXTURE==='1'`, which `spawnTeam` STRIPS from the child env in production; tests opt in via `_inject.supervisor.env`.

Key files: `scripts/lib/adapter-worker-supervisor.mjs` (detached CLI), `scripts/lib/supervisor-state.mjs` (paths + atomic snapshot I/O), `scripts/lib/supervisor-opts.mjs` (pure option builders), `scripts/lib/proc-identity.mjs` (`readProcStartId` PID start-time identity for reuse detection). See `docs/plans/adapter-worker-supervisor/PLAN.md`.

### Worktree collision and recovery policy

`createWorkerWorktree()` supports two explicit collision policies. Callers that
cannot prove an existing worktree is disposable must use `onExisting: 'fail'`:
it returns `created:false` with the intended path and branch without mutating
either artifact. `/codex-goal` uses that policy together with a unique worker
identity for every goal, including goals delegated inside the same Atlas or
Athena run, and stops before launching Codex when allocation fails.

The default `onExisting: 'replace'` policy remains for existing Atlas, Athena,
and tmux callers that are replacing a stale or cancelled worker. It force-removes
the existing worktree, so **uncommitted and untracked files are discarded**.
Committed work not reachable from the current `HEAD` is preserved by renaming
the branch to `<branch>-orphan-<epochSeconds>[-N]`; a branch already reachable
from `HEAD` is deleted with Git's checked `-d` path. The orphan branch preserves
commits only, not dirty worktree contents.

Replacement is fail-closed around ambiguous Git state. Stale worktree metadata
(for example, a missing directory whose branch is still registered as checked
out) can make branch rename/deletion fail. Concurrent replacement attempts can
also race while choosing the same orphan name. In either case the losing call
returns `created:false` instead of force-deleting the branch. Inspect `git
worktree list --porcelain` and the reported branch first; when the directory is
confirmed absent, `git worktree prune` can clear stale metadata before a manual
retry. On a failed allocation, `created` and `error` are authoritative;
`preservedBranch` can be only the candidate chosen before a failed rename. Never
continue in the returned `cwd` fallback when isolation is required.

### Provider-exhaustion failover

`worker-spawn.mjs` owns one bounded replacement chain for external workers.
Provider exhaustion (quota/rate-limit or repeated network/timeout failure)
moves Codex to Gemini when available; Gemini receives its own fresh unavailable
retry budget before the chain terminates at a native Claude Task handoff. A
generic crash retries that provider once and then demotes to Claude rather than
pretending the provider is exhausted. Authentication and missing-binary failures
skip inappropriate manual retries. Atlas creates external workers through one
canonical `spawnTeam(teamSlug, workers, cwd, capabilities)` call. Athena
preallocates and durably records its generation, calls
`spawnTeam(teamSlug, workers, cwd, capabilities, { runId })`, and requires that
exact identity for adoption, monitor evidence, `collectResults`, and cleanup.

Every transition preserves the root `{teamName, workerName, runId,
workerRunId, prompt}` identity. A pre-launch attempt id covers adapter/tmux
startup failures; an incomplete legacy identity fails closed instead of reusing
another run's output. Provider child-team creation is serialized by an
owner-record lock (`0600`, PID + process start identity). The fully written
owner intent is published with a same-directory no-replace hard link, so no
empty owner path is visible; malformed legacy locks fail closed. Dead-owner
recovery is bound to the exact observed lock generation by a create-exclusive
root claim before that generation can be removed. If that claimant dies, a
contender may publish one no-replace successor keyed to the dead predecessor's
token, but only after proving the predecessor stale and revalidating that the
observed lock generation is unchanged. Staleness requires the 30-second grace
period plus either `ESRCH` or a live PID whose process start identity differs;
a live matching owner is never stealable. Each predecessor therefore elects one
successor while a late observer of an older generation still cannot delete a
replacement owner. Provider root and successor claims are durable and excluded
from SessionEnd's transient state sweep. Deterministic child team names make
repeated polls idempotent.

Replacement workers inherit the root worker's `cwd`/`worktreePath` and branch,
but set `worktreeCreated:false`. A child team therefore operates on the same
task state without claiming or deleting the root Athena worktree. tmux fallback
uses the inherited directory directly; supervisor adapters receive it in their
manifest.

Terminal replacement output is written atomically under
`.ao/artifacts/provider-fallback/<handoffId>.json`, paired with
`.ao/state/provider-fallback-<handoffId>.json` (`schemaVersion:1`, mode `0600`).
`monitorTeam` overlays that durable completion onto the failed root worker and
`collectResults` treats it as canonical, so resume or child-team cleanup cannot
re-run an already completed task. `SessionEnd` sweeps inactive completion
artifacts after 24 hours. A native Claude fallback claim is not reclaimed merely
because its lease timestamp elapsed: elapsed time cannot prove that the Task is
dead, and a second claim could duplicate work in the same worktree. Recovery
through the current API therefore requires authenticated terminal output; any
other proof would be an out-of-band operator recovery, not an implemented
dispatch input. If the state is already `completed` but its authenticated
output record is missing
or has a different claim token, dispatch fails closed with
`completed-output-lost` instead of changing the state back to `pending`. A
completion-persistence caller is different: it already holds the real terminal
output bytes, so it repairs the output record under the existing completed claim
without rerunning the task.
The chain is per worker; a session-global provider circuit breaker/cooldown
remains a separate follow-up.


### Adapter Priority (highest → lowest)

**Codex workers** (`type: 'codex'`):
1. **codex-appserver** — Multi-turn JSON-RPC 2.0 over stdio (`codex app-server`)
   - Thread/turn lifecycle, live steering via `steerTurn()`, structured errors
   - Requires `hasCodexAppServer` capability (codex ≥ 0.116.0 + app-server subcommand)
2. **codex-exec** — Single-turn JSONL via `child_process.spawn` (`codex exec --json`)
   - 5 event types, error classification, group-targeted SIGTERM→SIGKILL shutdown
   - `collect()` reaps lingering tool-call descendants that inherited codex's stdout pipe: on the direct child's `'exit'`, if stdout is still open it SIGTERMs the process group, so a held-open pipe can't delay completion or leave a spurious "failed" background shell (#74)
   - Requires `hasCodexExecJson` capability (codex ≥ 0.116.0)

**Claude workers** (`type: 'claude'`):
3. **claude-cli** — Headless Claude Code via `claude -p --output-format stream-json`
   - Stream-json JSONL (system/assistant/result events), budget control, model override
   - Binary auto-discovered from versioned install paths (macOS/Linux)
   - Requires `hasClaudeCli` capability

**Gemini workers** (`type: 'gemini'`):
4. **gemini-acp** — Multi-turn JSON-RPC 2.0 over stdio (`gemini --acp`)
   - ACP (Agent Communication Protocol): newSession/prompt/cancel/setSessionMode lifecycle
   - camelCase method names (sessionStarted, promptCompleted, etc.)
   - Message queue for team communication: `enqueueMessage()` → auto-drain on turn completion
   - No mid-turn injection (unlike Codex `steerTurn()`) — messages queued between turns
   - Requires `hasGeminiAcp` capability (gemini CLI with `--acp` flag support)
5. **gemini-exec** — Single-turn JSON via `child_process.spawn` (`gemini --output-format json -p`)
   - Single JSON object output, error classification, SIGTERM→SIGKILL shutdown
   - Requires `hasGeminiCli` capability

Both Gemini adapters resolve their executable through `scripts/lib/gemini-binary.mjs` without adding a new adapter or changing `ADAPTER_REGISTRY`: `AO_GEMINI_BINARY` verbatim override first, then a real resolved `gemini` path, then a real resolved `agy` path. If neither binary is found, the adapters still spawn bare `gemini` so the existing ENOENT/not_installed flow remains intact, but the error message also explains the 2026-06-18 Gemini CLI tier split and the override.

Detached supervisor snapshots may include `workerMeta.binaryFlavor` (`gemini`, `agy`, or `custom`) and `workerMeta.binaryResolved` from the live adapter handle. Baseline: validated e2e against gemini-cli 0.50.0 (exec JSON roundtrip + ACP initialize; ACP `protocolVersion` is numeric as of 0.50 — 0.37.x has not been re-validated since that change). agy path unit-tested only (no binary available), e2e pending. Preflight capability detection and the tmux gemini command also route through `resolveGeminiBinary()`, so an agy-only install or `AO_GEMINI_BINARY` override still selects the Gemini adapters.

**All workers**:
6. **tmux** — Legacy fallback, works for all worker types
   - `tmux new-session` + `tmux send-keys` + `tmux capture-pane`
   - Always available when tmux is installed


### Session Naming
- tmux sessions: `atlas-codex-<N>`, `atlas-gemini-<N>`, `athena-<slug>-codex-<N>`, `athena-<slug>-gemini-<N>`
- Cross-validation: `atlas-codex-xval-<story-id>`, `atlas-gemini-xval-<story-id>`, `athena-<slug>-codex-xval-<story-id>`, `athena-<slug>-gemini-xval-<story-id>`
