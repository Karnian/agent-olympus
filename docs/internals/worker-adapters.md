# Detached Worker Supervisor (v1.2.0+)
> Moved verbatim from CLAUDE.md (Codex Interop v1, Ship order 1).

### Detached Worker Supervisor (v1.2.0+)

**Problem.** Atlas/Athena orchestration is **fresh-process-per-poll**: `monitorTeam` / `collectResults` / `shutdownTeam` each `loadTeamState()` from disk in a brand-new Node process. A live in-process adapter handle (`_liveHandle`) does NOT survive that boundary — `saveTeamState` strips it (`NON_SERIALIZABLE_WORKER_KEYS`). Before v1.2.0 the five non-tmux adapters spawned in-process, so once the orchestrator re-polled in a fresh process their completion was invisible and the workers were stuck `status: 'running'` forever (a fresh `monitorTeam` had no handle to read).

**Fix (the "FLIP").** `spawnTeam` no longer spawns adapters in-process. For every non-tmux worker it launches a **detached supervisor** — `node scripts/lib/adapter-worker-supervisor.mjs <manifest>` (`detached: true`, `unref`, `stdio: 'ignore'`) — that loads the adapter ITSELF, runs one prompt to terminal completion, and writes **atomic disk snapshots + a durable output file**. A fresh-process orchestrator then reads the worker's outcome from disk. tmux workers are unchanged (still `capturePane`-classified).

- **Run identity** — `spawnTeam` stamps the team state with a `runId` (random hex) + absolute `projectRoot`. Each worker gets a `workerRunId`; the persisted `_handle = { supervisorPid, supervisorStartId, runId, workerRunId }` is fully serializable. The supervisor's snapshot/output/manifest paths are DERIVED from the absolute `projectRoot` + these validated hex IDs (the manifest is NOT consulted for any explicit module/snapshot/output path), so a STALE supervisor from a prior same-name run can never be read as the current one.
- **Snapshot lifecycle** (`scripts/lib/supervisor-state.mjs`, schemaVersion:1) — atomic `writeSnapshot` (0600, clamped output tail), `readSnapshot(path, expected)` with a 5-way result (`missing` / `corrupt` / `unsupported` / `mismatch` / `ok`), heartbeat freshness (future-skew bounded), HEARTBEAT_INTERVAL 10s / STALE 90s / STARTUP_GRACE 10s.
- **Readers** (`worker-spawn.mjs`) — `monitorSupervisorWorker` maps a snapshot → MonitorResult: terminal status wins; `running` + dead supervisor (PID start-time identity mismatch) → crash; `running` + stale heartbeat → crash on the 2nd consecutive poll (`_supStaleSeen` latch); missing snapshot past startup grace (or a future `startedAt`) → crash; `mismatch`/`corrupt` → invalid. `collectResults` reads the durable output file (under `.ao/artifacts/team/`). `shutdownSupervisorWorker` is **supervisor-first**: signal the supervisor group (its SIGTERM handler shuts the adapter down) → re-read the snapshot → reap a surviving adapter group via the F3 start-id-checked kill → scrub the prompt-bearing manifest.
- **Adapter dispatch** — the supervisor's `run*` functions use pure manifest→option builders in `scripts/lib/supervisor-opts.mjs` (`buildExecOpts` / `buildAppserverThreadOpts` / `buildGeminiAcpSessionOpts`), kept in a CLI-free module so the wiring is unit-testable without importing the supervisor (which runs `main()` on import). gemini `model` rides on `createSession` (→ `unstable_setSessionModel`), NOT `startServer`.
- **Manifest hygiene** — the manifest carries the raw prompt. It is DATA for behavior (and supplies `projectRoot`/`cwd`), but NO explicit module/snapshot/output path is ever read from it — those are derived from the absolute `projectRoot` + validated IDs. The supervisor truncates+unlinks it on startup; a launch failure or an early shutdown also truncates+unlinks it so the prompt never lingers to the 24h sweep.
- **SessionEnd** — `session-end.mjs` sweeps the supervisor tree **per-run** (never wholesale) and skips a run with a `running` snapshot that has a fresh heartbeat OR a live supervisor PID (identity-checked when a `supervisorStartId` is recorded and readable; otherwise it fails open to a bare `kill(pid,0)` existence probe).
- **Security** — the built-in `fixture` adapter (test-only) is selectable ONLY when `AO_SUPERVISOR_ALLOW_FIXTURE==='1'`, which `spawnTeam` STRIPS from the child env in production; tests opt in via `_inject.supervisor.env`.

Key files: `scripts/lib/adapter-worker-supervisor.mjs` (detached CLI), `scripts/lib/supervisor-state.mjs` (paths + atomic snapshot I/O), `scripts/lib/supervisor-opts.mjs` (pure option builders), `scripts/lib/proc-identity.mjs` (`readProcStartId` PID start-time identity for reuse detection). See `docs/plans/adapter-worker-supervisor/PLAN.md`.


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

Detached supervisor snapshots may include `workerMeta.binaryFlavor` (`gemini`, `agy`, or `custom`) and `workerMeta.binaryResolved` from the live adapter handle. Baseline: validated against gemini-cli 0.37.1; npm latest 0.50.0; agy path unit-tested only (no binary available), e2e pending.

**All workers**:
6. **tmux** — Legacy fallback, works for all worker types
   - `tmux new-session` + `tmux send-keys` + `tmux capture-pane`
   - Always available when tmux is installed


### Session Naming
- tmux sessions: `atlas-codex-<N>`, `atlas-gemini-<N>`, `athena-<slug>-codex-<N>`, `athena-<slug>-gemini-<N>`
- Cross-validation: `atlas-codex-xval-<story-id>`, `atlas-gemini-xval-<story-id>`, `athena-<slug>-codex-xval-<story-id>`, `athena-<slug>-gemini-xval-<story-id>`
