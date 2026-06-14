# F1 — Adapter Worker Supervisor (rev 2, post Codex review)

## Problem

Non-tmux adapter team workers (`codex-exec`, `codex-appserver`, `claude-cli`,
`gemini-exec`, `gemini-acp`) cannot be monitored/collected across the
**fresh-process-per-poll** orchestration model. `spawnTeam` stores a live
`_liveHandle` (in-memory pipe) that `saveTeamState` strips, so a later process
sees no handle → `monitorTeam` falls to `monitorTmuxWorker` → adapter workers
have no tmux `session` → stuck `running`, output unrecoverable, failures never
trigger `reassignToClaude`. (tmux workers already work via `__AO_EXIT__`.)

## Goal

A detached per-worker **supervisor** owns the live handle and writes atomic
DISK snapshots + durable output so any fresh process reads terminal state.

**Out of scope (documented):** live multi-turn STEERING (`steerTurn` /
gemini message queue). Supervisor runs **one prompt → terminal completion**.
**Concurrent runs that share a `teamName`** remain a pre-existing team-state
collision (state keyed by team name); rev2 adds a `runId` so a STALE supervisor
from a prior run is ignored, but does not make two simultaneous same-name runs
safe — that is rejected/out of scope.

## Run identity (NEW — fixes stale-overwrite P0)

- `spawnTeam` generates `runId = randomBytes(8).hex` once, stored on team state
  (`state.runId`) and in every manifest/snapshot. Each worker gets a
  `workerRunId = randomBytes(8).hex`.
- All supervisor files live under an absolute, run-scoped dir:
  `<projectRoot>/.ao/state/supervisor/<runId>/<workerRunId>.{manifest,snapshot}.json`
- Durable output: `<projectRoot>/.ao/artifacts/team/<runId>/<workerName>.output`
- Readers (`monitorTeam`/`collectResults`/`shutdown`) compare `state.runId` to
  the snapshot's `runId`/`workerRunId` and **reject mismatches** → a stale
  supervisor's files are never read as current.
- **Absolute paths** rooted at `projectRoot` (resolved at spawn) — never relative
  (a detached supervisor with a different cwd would misresolve).

## Files

### NEW `scripts/lib/supervisor-state.mjs`
- `supervisorRunDir(projectRoot, runId)`, `manifestPath`, `snapshotPath`,
  `outputPath(projectRoot, runId, workerName)` — all absolute, derived from IDs
  (NOT taken from the manifest — see security note).
- `writeSnapshot(path, obj)` — `atomicWriteFileSync` (tmp+rename), mode `0o600`,
  forces `schemaVersion:1` + `updatedAt` heartbeat.
- `readSnapshot(path)` → `{ kind:'ok'|'missing'|'corrupt'|'unsupported', snapshot? }`
  — distinguishes the four cases (NOT a bare `null`, which conflates missing with
  corrupt and creates permanent false-running).
- dir mode `0o700`.

### NEW `scripts/lib/adapter-worker-supervisor.mjs` (detached CLI)
Entry: `node adapter-worker-supervisor.mjs <manifestPath>`.
1. Install `SIGTERM`/`SIGINT` handlers FIRST (before reading the manifest): set a
   `stopping` flag, prevent any new spawn, gracefully shut down the in-flight
   handle, write a terminal `{status:'cancelled'}` snapshot, then exit. (Killing
   the supervisor's own group does NOT reach the adapter — adapters spawn their
   own detached group — so the supervisor MUST clean up its adapter itself.)
2. Read manifest (0600); `unlink` it immediately (carries the raw prompt).
3. Resolve adapter via a FIXED ALLOWLIST switch on `adapterName`
   (`codex-exec|codex-appserver|claude-cli|gemini-exec|gemini-acp`). No dynamic
   import path. A built-in `fixture` flow is selectable ONLY when
   `process.env.AO_SUPERVISOR_ALLOW_FIXTURE==='1'` (set by tests); its behavior
   comes from manifest PARAMS (`fixture:{exitCode,output,delayMs}`), never code.
4. Write initial snapshot `{status:'running', supervisorPid, adapterPid:null, startedAt, updatedAt}`.
5. Run ONE turn to completion (adapter-flavor below). As soon as the handle
   exists, capture `adapterPid` + `adapterStartId = readProcStartId(adapterPid)`
   → snapshot update. Periodic heartbeat (`updatedAt`) while running. Tee output
   to a temp; the snapshot keeps only a bounded tail (≤2KB).
6. Terminal: in a `finally`, ALWAYS shut down the adapter
   (`shutdown`/`shutdownServer`); write full output atomically to `outputPath`;
   AWAIT cleanup; THEN write the terminal snapshot
   `{status:'completed'|'failed'|'cancelled', completedAt, error, outputPath, outputBytes}`;
   only then exit (`0` completed, `1` otherwise). Do NOT `process.exit()` while
   cleanup promises/kill timers are pending.
7. Watchdog: an overall `timeoutMs` timer → terminal `{status:'failed',error:{category:'timeout'}}`.
8. FAIL-SAFE: `uncaughtException`/`unhandledRejection` → terminal failed snapshot, exit 1.

#### Adapter-flavor abstraction → normalized `{status,output,error}`
- **exec** (`codex-exec`/`claude-cli`/`gemini-exec`): `h=spawn(prompt,opts)`;
  `adapterPid=h.pid`; `res=await collect(h,timeoutMs)`; `finally shutdown(h)`.
- **codex-appserver**: `h=startServer({cwd})`; `await initializeServer(h)`;
  `await createThread(h,{cwd,level,...})`; `await startTurn(h,prompt)`;
  `adapterPid=h.pid`; `res=await collectTurnResult(h,timeoutMs)`;
  `finally shutdownServer(h)`.
- **gemini-acp**: `h=startServer(...)`; `await initializeServer(h)`;
  `await createSession(h,...)`; `res=await sendPrompt(h,prompt,{timeout})`
  — `sendPrompt` ALREADY collects internally (do NOT call collectPromptResult
  again); `adapterPid=h.pid`; `finally shutdownServer(h)`. (Mirror the working
  sequence at worker-spawn.mjs gemini-acp branch.)

### CHANGED `scripts/lib/worker-spawn.mjs`
- **spawnTeam** (P4, the FLIP): adapter workers → write manifest (0600, absolute
  paths derived from runId/workerRunId), `spawn(process.execPath,
  [supervisorScript, manifestPath], {detached:true, stdio:'ignore', cwd:projectRoot}).unref()`.
  `_handle = { supervisorPid, supervisorStartId, runId, workerRunId, snapshotPath, outputPath }`.
  No `_liveHandle`. tmux path unchanged.
- **monitorTeam** (P3, dormant first): for a known-adapter worker, read its
  snapshot via `readSnapshot`:
  - `ok` + terminal status → map to completed/failed (+ error category/output tail).
  - `ok` + `running` + supervisor ALIVE (`supervisorPid`+`supervisorStartId` via
    `readProcStartId` match) + heartbeat fresh → `running`.
  - `ok` + `running` but supervisor DEAD, or heartbeat stale past grace → `failed`/`crash`.
  - `missing` within startup grace → `running` (starting); past grace → `crash`.
  - `corrupt`/`unsupported` → `failed` (do NOT treat as running forever).
  NEVER route a known adapter to `monitorTmuxWorker`.
- **collectResults** (P3): adapter workers → read `outputPath` (durable artifact).
- **shutdownTeam / reassignToClaude** (P3): for adapter workers —
  1. SIGTERM the `supervisorPid` GROUP (F3 startId-checked) with a grace ≥ the
     adapter shutdown grace (≥6s, > the 5s adapter `SHUTDOWN_GRACE_MS`) so the
     supervisor finishes graceful adapter cleanup before SIGKILL;
  2. re-read the snapshot; signal the `adapterPid`+`adapterStartId` GROUP as an
     orphan fallback (F3) in case the supervisor died first.
- `monitorAdapterWorker` (old in-process path) retained behind `isLiveHandle`
  for the rare same-process case only.

### CHANGED `scripts/session-end.mjs` (cleanup awareness)
- Skip `.ao/state/supervisor/<runId>/` dirs whose snapshot is `running` with a
  FRESH heartbeat or a LIVE supervisorPid (don't delete an active run's state
  mid-flight). Stale/terminal runs are swept as before.

### CHANGED skills (`athena`/`atlas` SKILL.md)
Concrete `spawnTeam` + disk-backed `monitorTeam`/`collectResults` notes; drop the
claim of automatic in-process adapter monitoring.

## Security notes (fixes manifest-capability P1)
- Manifest carries DATA only (runId, workerRunId, teamName, workerName,
  adapterName∈allowlist, cwd, level, model, prompt, timeoutMs, fixture-params).
  It does NOT carry module paths or output/snapshot paths — the supervisor
  DERIVES those from IDs + projectRoot. So a tampered manifest can't load
  arbitrary code or redirect writes.
- Manifest is `0o600` and unlinked right after read.
- Fixture flow gated by `AO_SUPERVISOR_ALLOW_FIXTURE==='1'` (never set in prod).

## Phasing (Codex-revised; reading side BEFORE the flip; each phase reviewed)
**Status: ALL PHASES COMPLETE (P1–P6).** Each phase implemented → Codex cross-reviewed → hardened → committed. Full suite 2191 tests, 0 failures.
- **P1 ✅**: `supervisor-state.mjs` (paths, run identity, atomic snapshot I/O with
  5-way read result, heartbeat) + unit tests. SessionEnd cleanup rule.
- **P2 ✅**: `adapter-worker-supervisor.mjs` — signal handling, adapter flows,
  `finally` cleanup, watchdog, fixture mode + supervisor tests (happy/fail/
  cancel/timeout/crash) run as REAL detached processes against the fixture.
- **P3 ✅ (DORMANT readers)**: `monitorTeam`/`collectResults`/`shutdownTeam`/
  `reassignToClaude` learn to read snapshots/output + supervisor-first shutdown —
  WITHOUT changing how spawn works yet (no live supervisor workers exist, so
  these are inert for real teams; unit-tested with hand-written snapshots).
- **P4 ✅ (FLIP, `846f50b`)**: `spawnTeam` launches supervisors for adapter workers
  + the two-process E2E (spawn → fresh-read observes running→completed → collect
  output) using the fixture adapter. Review fixes in `43cc0af` (gemini model →
  createSession; spawn error/pid guard; pure option builders).
- **P5 ✅ (`d32ced2`, `8b09829`)**: hardening tests (launch-race shutdown,
  stale-generation overwrite, parent-exits-immediately/orphan-survival via a
  deterministic file gate, duplicate shutdown, no-pid launch guard, manifest
  scrub). Round-2 review fix: pure builders moved to `supervisor-opts.mjs` so
  `main()` stays unconditional (the path-equality guard was not symlink-safe).
- **P6 ✅ (`1a9329c`)**: skills docs (atlas/athena supervisor monitoring model)
  + integration sweep (full suite green, syntax + namespace checks clean).

## Risks & mitigations
- Stale/concurrent generations → runId/workerRunId + mismatch rejection.
- Supervisor group-kill ≠ adapter kill → supervisor signal handlers + graceful
  shutdown + adapterPid/adapterStartId orphan fallback + grace ≥ adapter grace.
- Permanent false-running → 4-way snapshot read + heartbeat + supervisor liveness.
- SessionEnd deleting a live run → cleanup skips active (live pid / fresh heartbeat).
- Secret exposure → 0600, manifest unlinked, output in separate artifact, bounded
  snapshot tail, raw prompt never echoed.
- Manifest as capability → DATA-only manifest, derived paths, allowlisted adapter,
  env-gated fixture.
- PID reuse → F3 (landed) applied to BOTH supervisorPid and adapterPid.

## Non-goals
- Live steering / multi-turn chaining via supervisor; two simultaneous same-name
  runs; changing the tmux path; replacing the outbox.

---

## Round-2 review amendments (BINDING — Codex confirmed "no remaining P0, proceed with P1")

A. **Idempotent terminal**: a `settled` guard (not a bare `stopping` bool) ensures
   shutdown → output → terminal-snapshot run EXACTLY ONCE across the signal,
   watchdog, normal-completion, and uncaught paths.
B. **P3 dormancy gate (critical)**: gate the snapshot branch on an EXPLICIT
   supervisor descriptor — `state.runId && worker._handle?.workerRunId &&
   worker._handle?.supervisorPid` — because every disk-loaded adapter worker
   already matches "known adapter + no live handle" (so that alone is NOT
   dormant). Reader order: `isLiveHandle` → supervisor descriptor → legacy
   adapter-pid/tmux. tmux untouched (no registry entry).
C. **Tri-state liveness** (monitoring ≠ killing): match startId → alive;
   different non-null → dead/reused; null → `process.kill(pid,0)` probe →
   alive-unverified vs ESRCH/dead. Store `supervisorStartId` AND `adapterStartId`
   in the snapshot (SessionEnd scans snapshots, not team-state `_handle`).
D. **`cancelled`** maps to `failed` + `error.category='cancelled'` in monitorTeam's
   resolution (which today only handles completed/attached-error).
E. **Constants** (shared in supervisor-state): heartbeat 10s, stale 90s (confirm
   across 2 polls before declaring crash), startup grace 10s; keep the 5-min
   output STALL_THRESHOLD_MS separate (worker inactivity ≠ supervisor health).
F. **Shutdown grace ≥8s** (10s safer) for the supervisor group via the existing
   `killProcessGroups(targets, graceMs)` per-call arg (> adapters' 5s escalation).
G. **Fixture**: require BOTH `adapterName==='fixture'` AND `AO_SUPERVISOR_ALLOW_FIXTURE==='1'`;
   production adapter selection can NEVER return fixture; tests pass the env to the
   CHILD only (never mutate global process.env); strict caps on `delayMs`/output
   size; fixture params carry NO code/path/command/import fields.
F. **SessionEnd**: must inspect each `supervisor/<runId>` per-run (skip live/fresh)
   — never wholesale-delete the top-level `supervisor/` dir.
H. **P1 (supervisor-state.mjs) scope**: hex ID validation + path containment;
   output keyed by `workerRunId`; STRUCTURAL snapshot validation (not just JSON/
   schema); shared freshness/startup constants + `isHeartbeatFresh()`;
   `supervisorStartId`/`adapterStartId` in the schema.
