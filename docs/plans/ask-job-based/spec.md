# `/ask` Job-Based Refactor — `scripts/ask.mjs` async/status/collect/cancel/list

**Status:** APPROVED (rev 4) — Codex APPROVE verdict after 3 rounds of cross-review (REWORK → APPROVE-WITH-FIXES → APPROVE-WITH-FIXES → APPROVE)
**Slug:** `ask-job-based`
**Base:** v1.0.3 (commit 250e8c5)
**Author:** Hermes (planner mode)
**Date:** 2026-04-09
**Successor to:** `docs/plans/ask-adapter-migration/spec.md` (rev 6) — that PR landed the codex/gemini exec adapter routing + v1.0.3 host-sandbox demotion. This PR builds on top of it.

---

## 1. Problem

`scripts/ask.mjs` (rev 6 of ask-adapter-migration) is a single-shot synchronous helper:

```
echo "<prompt>" | node scripts/ask.mjs <model>
  → spawn adapter
  → await collect(handle, COLLECT_TIMEOUT_MS = 120_000)
  → print to stdout
  → exit
```

The `COLLECT_TIMEOUT_MS = 120_000` constant is hardcoded at `scripts/ask.mjs:34`. Codex code reviews on non-trivial changes routinely take 2–5 minutes. At 120s the helper SIGKILLs the adapter via `adapter.shutdown(handle)` in the `finally` block (`scripts/ask.mjs:232-242`) and the partial output is discarded.

In the previous session, this regression forced the user to wrap every `/ask codex` call in a manual tmux workaround:

```
tmux new-session -d -s ask-codex "echo '...' | node scripts/ask.mjs codex > /tmp/ask.out 2>&1"
# come back later
tmux capture-pane -p -S -500
```

That workaround caused three concrete pain points:

1. **Shell-quoting accidents.** Heredoc + nested single-quote interactions repeatedly produced `unexpected argument` errors that ate cycles to diagnose.
2. **Lifecycle pollution.** Background `tmux` processes outlived the chat turn and emitted `task-notification` events into the next turn, creating phantom output the user had to mentally filter.
3. **Output truncation.** `tmux capture-pane -S -500` caps the scrollback at 500 lines; longer Codex reviews silently lost the head of the response.

The previous `ask-adapter-migration` PR explicitly forbade tmux from `ask.mjs` (AC-6: grep test for no `tmux` references in executable code). The tmux workaround was an *out-of-band* user-side hack, not a regression of AC-6, but it is the symptom that proves the synchronous design is broken for real-world Codex review workloads.

The goal of this PR is **to retire that tmux workaround.** After this PR lands, callers can fire a job, walk away, and collect the answer minutes later from a separate process — no tmux, no shell quoting, no truncation.

---

## 2. Goals

| ID  | Goal                                                                                                  | Measurable                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| G1  | Allow long-running (>120s) `/ask codex` invocations to complete without SIGKILL.                       | Codex review of 3+ minute duration completes successfully via `async` + `collect --wait`.                  |
| G2  | Eliminate the user-side tmux workaround.                                                              | Documented `/ask` workflow in SKILL.md uses only `node scripts/ask.mjs async/status/collect`. Zero tmux.   |
| G3  | Preserve the v1.0.3 sync contract for Atlas/Athena and other internal callers.                        | All 28 existing `scripts/test/ask.test.mjs` tests pass unchanged.                                          |
| G4  | Preserve the v1.0.3 codex `level` + host-sandbox demotion path.                                       | `buildSpawnOpts` continues to be called from BOTH the sync path AND the runner; integration test asserts. |
| G5  | Keep the helper zero-dependency and ESM-only, consistent with `agent-olympus` conventions.            | No new `package.json` deps; `node --check` passes.                                                         |
| G6  | Test isolation: tests must not pollute the developer's repo or `~/.claude/`.                          | Every new test uses `process.chdir(tmpdir) + HOME=tmpdir + _inject*` fakes. No real subprocesses spawned. |

---

## 3. Non-goals

| ID    | Non-goal                                                                                                 | Rationale                                                                                                                          |
| ----- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| NG1   | **Dedup cache.** Identical (model, promptHash) re-fires reuse a prior artifact.                          | Out of scope. We persist `promptHash` in metadata as a hook for a future PR but do NOT implement reuse logic here.                  |
| NG2   | **Streaming `collect`.** Tail the JSONL output as it arrives.                                            | Out of scope. `collect --wait` polls metadata for completion; partial-output streaming is a follow-up.                              |
| NG3   | **Multi-tenant job queue / scheduler.** Throttle concurrent jobs across multiple `/ask` callers.         | Out of scope. Concurrency is bounded by host machine + the existing `scripts/concurrency-gate.mjs` tooling, not by ask.mjs itself.  |
| NG4   | **Persistent (>24h) artifact retention.** Async artifacts survive SessionEnd cleanup.                    | Out of scope. Async jobs opt INTO the existing 24h SessionEnd sweep, same as other `.ao/state/` and `.ao/artifacts/` files.         |
| NG5   | **Migrate `/ask` SKILL.md to async-by-default.**                                                         | Out of scope. SKILL.md gets a NEW `async` recipe section; the default sync recipe is preserved verbatim.                            |
| NG6   | **Fresh-process stage isolation** (the gstack-style isolation mentioned in v1.0.2 spec.md N12).          | Out of scope. The runner is a fresh detached node process, but the rest of the cascade-pipe isolation work is unrelated.            |

---

## 4. Approach

### 4.1 Subcommand dispatcher

`scripts/ask.mjs` `main()` becomes a thin dispatcher on `process.argv[2]`:

```
argv[2] ∈ {codex, gemini, auto}              → legacy sync path (unchanged)
argv[2] === 'async'    && argv[3] ∈ models   → async launch path
argv[2] === 'status'   && argv[3] = jobId    → status reader
argv[2] === 'collect'  && argv[3] = jobId    → artifact reader (+ optional --wait)
argv[2] === 'cancel'   && argv[3] = jobId    → SIGTERM the runner
argv[2] === 'list'     [+ filters]           → enumerate jobs
argv[2] === '_run-job' && argv[3] = jobId    → INTERNAL runner entry point
otherwise                                    → exit 3 (usage error)
```

The dispatcher decision MUST happen BEFORE any stdin read, capability detection, or `buildSpawnOpts` call, because `status`/`collect`/`cancel`/`list`/`_run-job` do not read stdin and have different exit-code semantics. The legacy sync path keeps its current `main()` body verbatim, hoisted into a `runSyncPath()` function for clarity.

**Backward compat invariant.** When `argv[2] ∈ {codex, gemini, auto}` the dispatcher routes to `runSyncPath()` and the externally observable behavior — stdin read, capability detect, adapter spawn, `<model>-<ts>.md` artifact at `.ao/artifacts/ask/`, exit codes 0/1/2/3 — is byte-identical to v1.0.3.

### 4.2 Async launch path (`async <model>`)

```
1. Validate model arg (same VALID_MODELS list as sync path).
2. Read stdin → prompt (same as sync path).
3. detectCapabilities() + pickAskAdapter(model, caps).
4. If adapter === 'none' → printUnavailable + exit 2.
4a. **(Rev 3) Codex demotion fallback check.** Call `buildSpawnOpts(adapter)`.
    If `opts._demoted === true` AND model === 'auto' AND `caps.hasGeminiCli`:
      - log to stderr `[ask] codex unavailable (${opts._demotionReason}); falling back to gemini-exec`
      - adapter = 'gemini-exec'
      - opts = buildSpawnOpts('gemini-exec')
    If `opts._demoted === true` AND we cannot fall back (explicit codex request,
    or auto without gemini available):
      - printUnavailable + exit 2 (no artifact, same as sync path)
    This preserves the v1.0.3 sync-path contract (`ask.mjs:307-318`) that
    `/ask auto` transparently routes around a demoted codex. The runner later
    still calls `buildSpawnOpts` for defence in depth, but the authoritative
    adapter choice is made here at dispatch. Rev-2 blocker 1 fix.
5. Allocate jobId: `ask-${label}-${ts}-${rand4}`.
   - label = 'codex' | 'gemini' (resolved from adapter name)
   - ts = `YYYYMMDD-HHMMSS` from new Date()
   - rand4 = 4-char hex from crypto.randomBytes(2)
6. mkdirSync `.ao/state/ask-jobs/` (0o700) and `.ao/artifacts/ask/` (0o700) so
   runner never hits ENOENT on first use. Addresses rev-1 Blocker 4.
7. Write `.ao/state/ask-jobs/<jobId>.prompt` (mode 0o600) — raw prompt.
8. scriptPath = fileURLToPath(import.meta.url) — absolute path required for
   cross-platform detached spawn (Codex Q1).
9. Detached re-exec runner:
      const runner = spawn(process.execPath, [scriptPath, '_run-job', jobId], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        cwd: process.cwd(),
      });
10. IMMEDIATELY after spawn returns (runner.pid available synchronously),
    write `.ao/state/ask-jobs/<jobId>.json` with runnerPid=runner.pid,
    status='running', adapterPid=null, lastActivityAt=startedAt, schemaVersion:1.
    Use atomic write (tmp+rename) via ask-jobs.mjs::writeMetadata.
    **This MUST happen before `runner.unref()` + process.exit** — the async
    parent cannot exit until the metadata file exists on disk, otherwise
    §4.3 step 1 would see a missing file and the runner would self-orphan.
    The runner's step-1 retry loop (§4.3) is a defence-in-depth safety net;
    this synchronous write is the primary guarantee.
11. runner.unref().
12. Print one JSON line to stdout: {jobId, artifactPath, runnerPid}
    - artifactPath is the FUTURE `.ao/artifacts/ask/<jobId>.md` location.
13. Exit 0.
```

**Launch ordering rev 2.** Rev 1 had the metadata written AFTER `runner.unref()`, which Codex flagged as racey: on a fast start the runner could read metadata before the parent finished writing and self-orphan. Rev 2 fixes this by:
1. Writing metadata SYNCHRONOUSLY in the parent between `spawn()` returning (runner.pid is available) and `runner.unref()`. The runner is still running but has not yet attempted to read metadata because process startup takes milliseconds.
2. §4.3 step 1 adds a 2-second retry loop for defence in depth — if the parent is preempted between `spawn()` and `writeFileSync`, the runner polls the metadata path every 50ms for up to 2s before declaring orphan. In practice the retry loop never fires; it exists so a very loaded system cannot produce an unrecoverable orphan.

**Why a sibling `.prompt` file.** Inlining the prompt into the metadata JSON makes the metadata file unwieldy for multi-KB prompts and means every `status`/`list` read pulls the prompt body off disk for no reason. The runner reads the prompt file ONCE on startup, hands it to `adapter.spawn(prompt, opts)`, and immediately deletes the `.prompt` file. After that the prompt lives only inside the adapter child's stdin.

**Hash field.** `promptHash = sha256(`${model}\n${prompt}`)` is computed BEFORE the prompt file is written and recorded in metadata. This is a hook for the future dedup cache (NG1). Computing it now is free; refusing to compute it now would force a metadata schema bump later.

### 4.3 `_run-job <jobId>` runner — internal entry point

The runner is the **single writer** of `.ao/state/ask-jobs/<jobId>.json`. No other entry point ever calls `writeFileSync` against the metadata file. This invariant prevents the cancel-vs-runner race that would otherwise corrupt status flips.

**Runner sequence:**

```
1. Read .ao/state/ask-jobs/<jobId>.json → meta, with 2-second retry loop
   (poll every 50ms for up to 2000ms) to tolerate the async-parent launch
   race window. If still missing after 2s → exit 1 (truly orphaned: async
   parent crashed between spawn() and writeMetadata).
2. Read .ao/state/ask-jobs/<jobId>.prompt → prompt; unlinkSync the file.
3. **(Rev 4)** mkdirSync(dirname(meta.artifactJsonlPath), { recursive: true, mode: 0o700 })
   IMMEDIATELY — before any branch. Every code path below (demoted, spawn error,
   success, SIGTERM) needs the directory to exist so `appendFileSync` of the
   runner_done sentinel can land. Rev 3 had mkdir inside step 6, which meant
   the step-4 demoted path had no place to write its sentinel.
4. opts = buildSpawnOpts(meta.adapterName)  // SAME function the sync path uses.
5. If opts._demoted → call `writeRunnerSentinel(meta.artifactJsonlPath, {
     reason: 'failed', category: 'demoted', message: opts._demotionReason,
     text: '',
   })` via `fs.appendFileSync` (synchronous, flushed before return).
   Then flip metadata to status='failed', errorCategory='demoted',
   errorMessage = opts._demotionReason, exitCode=2, endedAt=now. Exit 0.
6. adapter = await loadAdapter(meta.adapterName).
7. Open jsonlStream = fs.createWriteStream(meta.artifactJsonlPath, {flags:'a', mode:0o600})
   for the data tee (see step 10). The tee stream is used ONLY for buffering
   adapter `data` chunks during the job; the terminal sentinel never goes
   through it (see §4.3.2).
   Attach jsonlStream.on('error', (err) => {
     meta._jsonlError = err && err.message ? err.message : String(err);
     // Tee failure is non-fatal — adapter collect still runs. The error is
     // captured in meta for reconciliation visibility.
   }). Addresses rev-1 Blocker 4.
7. handle = adapter.spawn(prompt, opts).
8. Write meta.adapterPid = handle.pid back to metadata (single writer; first
   metadata mutation after launch).
9. Attach JSONL tee:
      handle.stdout.on('data', chunk => {
        try { jsonlStream.write(chunk); } catch {}
        meta._inMemoryLastActivityAt = new Date().toISOString();
        maybeFlushMetadata(meta);
      });
   The adapter's OWN data handler (codex-exec.mjs:179-211) continues to run
   alongside this listener — Node EventEmitter delivers each 'data' event to
   ALL listeners.
10. Install SIGTERM handler as a ONCE-ONLY finalizer via a shared `finalizing`
    flag so SIGTERM and the normal post-collect finalize cannot both run:
       let finalizing = false;
       async function finalize(reason, category, message) {
         if (finalizing) return;
         finalizing = true;
         try { await adapter.shutdown(handle); } catch {}
         // (Rev 4) Close the data-tee stream FIRST and wait for its 'finish'
         // event so any buffered adapter chunks hit disk before we write the
         // sentinel. process.exit(0) does NOT flush node WriteStream buffers;
         // rev 3 assumed it did and had a crash window where the sentinel
         // could be lost. Fix: use await-finish on the tee + synchronous
         // appendFileSync for the sentinel itself.
         try {
           await new Promise((resolve) => {
             jsonlStream.end(() => resolve());
             jsonlStream.once('error', resolve);
           });
         } catch {}
         // Now write runner_done sentinel via SYNCHRONOUS appendFileSync —
         // it bypasses the WriteStream entirely, so there is no buffer and
         // process.exit(0) cannot beat the flush. The file was opened at
         // the start of the runner with mkdirSync + createWriteStream; the
         // directory is guaranteed to exist here because step 3 created it
         // before any other branch.
         writeRunnerSentinel(meta.artifactJsonlPath, {
           reason, category, message,
           text: handle._output || '',
         });
         meta.status = reason;  // 'completed' | 'failed' | 'cancelled'
         if (category) meta.errorCategory = category;
         if (message)  meta.errorMessage = message;
         meta.endedAt = new Date().toISOString();
         writeMetadata(meta);  // atomic tmp+rename, synchronous
         // Synthesize .md ONLY on completed path.
         if (reason === 'completed') {
           const output = (handle._output || '').trim();
           const body = output + (output.endsWith('\n') ? '' : '\n');
           writeFileSync(meta.artifactMdPath, body, { mode: 0o600 });
         }
         // All writes above are synchronous; no buffered streams remain.
         // Safe to exit.
         process.exit(0);
       }
       process.on('SIGTERM', () => finalize('cancelled'));
11. result = await adapter.collect(handle, 86_400_000 /* 24h explicit */).
    **Why 86_400_000 not undefined.** codex-exec.mjs:307 defaults to
    `timeoutMs = 30000` and gemini-exec.mjs:288 does the same. Omitting the
    argument means 30s, which defeats the entire purpose of the async path.
    Addresses rev-1 Blocker 2.
12. If result.error → await finalize('failed', result.error.category, result.error.message).
    Otherwise → await finalize('completed').
    Both paths route through the same once-only finalize() so SIGTERM cannot
    race the normal exit path.
13. Unreachable — finalize() calls process.exit(0).
```

#### 4.3.2 Runner sentinel — adapter-agnostic completion marker

Rev 1 used the string `"turn.completed"` in the teed JSONL as the oracle for "runner reached terminal state". Codex pointed out (rev-1 Blocker 3) that this is codex-specific: gemini-exec emits a single raw JSON object and only synthesizes `type: 'gemini.result'` **in memory**, not on stdout (`gemini-exec.mjs:120`, `gemini-exec.mjs:203`). So the JSONL teed on the gemini path never contains any completion marker.

Fix: the runner writes an **explicit adapter-agnostic sentinel line** to the JSONL immediately before flipping metadata, as the last step of the `finalize()` path. **Rev 3** added an embedded `text` field carrying `handle._output`, so `collect` can recover the full body from the sentinel alone if the `.md` synthesis step crashed. **Rev 4** switches the sentinel write from a buffered `WriteStream.write()` to `fs.appendFileSync()` so the bytes hit disk synchronously before `process.exit(0)` — otherwise a fast exit can lose the sentinel, reopening the exact recovery hole rev 3 was trying to close.

```
{"schemaVersion":1,"type":"runner_done","status":"completed","ts":"2026-04-09T12:34:56.789Z","bytes":12345,"text":"<handle._output verbatim>"}
```

`status` is one of `completed | failed | cancelled`. The reconciler (§4.4) scans the JSONL tail for `"type":"runner_done"` and treats the sentinel's `status` as authoritative for ALL three terminal states (rev-2 medium fix): if the runner wrote `runner_done:cancelled` but died before metadata flip, reconciliation must report `cancelled`, not `failed/crashed`.

This works for both adapters because WE write the sentinel, not the adapter. The sentinel carries `schemaVersion:1` per the project's forward-compat convention.

**Rev-2 blocker 2 fix — fallback synthesis is now adapter-agnostic.** The `collect` fallback (§4.5) no longer parses adapter-specific event shapes; it reads the sentinel's `text` field directly. This works for codex-exec (text aggregated from `item.completed` events into `handle._output`) and gemini-exec (text aggregated from the single response JSON into `handle._output`) alike, because `handle._output` is the common contract both adapters fulfill.

**Why sentinel before metadata flip.** If the runner crashes between writing the sentinel and writing metadata, reconciliation still reports `completed`. If the runner crashes before writing the sentinel, reconciliation reports `failed/category=crashed`. The sentinel is the ground truth, not the metadata file.

**The runner MUST NOT log to stdout/stderr.** Its parent set `stdio: ['ignore','ignore','ignore']` and there is no shell to read it. Any debug output the runner needs to emit goes into the JSONL artifact as a `{schemaVersion:1, type:"runner_log", level, msg, ts}` line. The JSONL file is the runner's only side-channel for debuggability.

#### 4.3.1 Metadata flush debouncing

Writing metadata on EVERY adapter `data` event would amplify disk traffic for chatty codex turns. The runner debounces metadata flushes for `lastActivityAt` updates: an in-memory `lastActivityAt` field bumps on every chunk, but the actual `writeMetadata(meta)` flush fires only when:

- `now - meta._lastFlushAt > 5_000` (5-second floor), OR
- `meta.status` changes (running → completed/failed/cancelled), OR
- `meta.adapterPid` is set for the first time (step 8).

This keeps `status <jobId>` reasonably fresh (worst case 5s lag on `lastActivityAt`) without thrashing the filesystem.

### 4.4 `status <jobId>` — read + reconcile

Pure read path. Does NOT mutate the metadata file.

```
1. Read .ao/state/ask-jobs/<jobId>.json → meta. Exit 3 if missing.
2. runnerAlive = isProcessAlive(meta.runnerPid)
   adapterAlive = meta.adapterPid ? isProcessAlive(meta.adapterPid) : null
3. reconciledStatus = meta.status
   if meta.status === 'running' && !runnerAlive && !adapterAlive:
     // Runner crashed before flipping metadata. Scan JSONL for the
     // runner-written sentinel (§4.3.2) — adapter-agnostic. Rev 1 used the
     // codex-specific 'turn.completed' event which fails for gemini.
     sentinel = jsonlFindRunnerSentinel(meta.artifactJsonlPath)
     if sentinel && sentinel.status in {'completed','failed','cancelled'}:
       // (Rev 3) All three terminal states from the sentinel are authoritative.
       reconciledStatus = sentinel.status
       if sentinel.status === 'failed':
         reconciledError = { category: sentinel.category || 'unknown', message: sentinel.message }
     else:
       reconciledStatus = 'failed'
       reconciledError = { category: 'crashed', message: 'runner exited without sentinel' }
4. Print {
     jobId, status: reconciledStatus, startedAt: meta.startedAt,
     elapsedSec: (now - startedAt) / 1000,
     bytesOut: statSync(meta.artifactJsonlPath).size  // 0 if file missing
     lastActivityAt: meta.lastActivityAt,
     runnerAlive, adapterAlive,
     errorCategory?, errorMessage?,  // only if reconciled or already failed
   }
5. Exit 0.
```

`isProcessAlive(pid)` is a dedicated helper: `process.kill(pid, 0)` → success=alive; `ENOENT`/`ESRCH`=dead; `EPERM`=alive (cross-uid cannot signal but is alive). Wrapped so tests can `_injectLiveness(pidMap)`.

### 4.5 `collect <jobId> [--wait] [--timeout Ns]`

```
1. Read meta. Exit 3 if missing.
2. Reconcile status (same logic as §4.4).
3. switch (reconciledStatus):
     'completed':
       if existsSync(meta.artifactMdPath):
         cat meta.artifactMdPath to stdout, exit 0.
       else:
         // Runner crashed between writing the sentinel and synthesizing .md.
         // (Rev 3) Read the sentinel's embedded `text` field directly — this
         // is adapter-agnostic because both codex-exec and gemini-exec populate
         // handle._output, and the runner copies that into the sentinel.
         sentinel = jsonlFindRunnerSentinel(meta.artifactJsonlPath)
         if sentinel && typeof sentinel.text === 'string':
           body = (sentinel.text.trim() + '\n')
           writeFileSync(meta.artifactMdPath, body, { mode: 0o600 })
           cat, exit 0.
         else:
           stderr "completed but .md missing and sentinel has no text", exit 1.
     'failed'    → stderr "${errorCategory}: ${errorMessage}", exit 1.
     'cancelled' → stderr "cancelled", exit 1.
     'running' && !--wait → exit 75 ("not yet").
     'running' && --wait  → poll loop:
        - first iteration runs IMMEDIATELY (no initial sleep) so sub-500ms
          jobs don't incur a spurious 75
        - re-read .ao/state/ask-jobs/<jobId>.json
        - reconcile on each read
        - if reconciled !== 'running' → goto top of switch
        - sleep 500ms
        - if elapsed > timeout (default 600s, override via --timeout Ns) → exit 75
4. Exit codes: 0 success, 1 failed/cancelled, 3 argv error or unknown jobId, 75 not-ready.
```

**Why exit 75.** 75 = `EX_TEMPFAIL` from BSD sysexits — "temporary failure, try again later". Distinguishes "not ready" from "actually failed" without colliding with the existing 0/1/2/3 contract on the sync path.

**Polling, not inotify.** Cross-platform `fs.watch` is unreliable on macOS for files that get rewritten by a different process; a 500ms poll on a small JSON file is well within the noise floor and matches the existing `.ao/state/` polling patterns elsewhere in the codebase.

### 4.6 `cancel <jobId>` — race-safe shutdown

```
1. Read meta. Exit 3 if missing.
2. Reconcile status (§4.4 logic) before deciding. This catches the case
   where the runner already flipped meta.status and exited.
3. If reconciledStatus !== 'running' → exit 0 (idempotent; already terminal).
   Covers: completed/failed/cancelled OR dead runner whose sentinel already
   made reconciliation yield a terminal state. Addresses rev-1 Medium 5.
4. If !isProcessAlive(meta.runnerPid):
   // Reconciliation said 'running' but runner is dead → runner died
   // without writing the sentinel. Real crash.
   stderr "runner already dead; run 'status' to reconcile"
   exit 1.
5. process.kill(meta.runnerPid, 'SIGTERM').
6. Poll isProcessAlive(meta.runnerPid) every 200ms for up to 5_000ms.
7. If still alive → process.kill(meta.runnerPid, 'SIGKILL').
8. Exit 0.
```

The cancel CLI does NOT touch the metadata file. The runner's once-only `finalize('cancelled')` (§4.3 step 10) is the single writer that flips status. If SIGKILL is needed, the runner never gets a chance to flip — the next `status` call reconciles it as `failed/category=crashed`. That asymmetry is intentional and documented in §4.7.

**Rev-2 fix for cancel vs finalize race.** Rev 1 had a window where a second cancel arriving mid-finalize would see `meta.status=running` (runner hadn't flushed yet) and exit 1, contradicting AC-24's idempotency claim. Rev 2 fixes this by (a) adding the reconciliation step before the liveness check — if the runner has exited (even without flushing metadata), reconciliation sees the sentinel and reports terminal status — and (b) documenting that the finalize function in §4.3 is a once-only guarded path so SIGTERM and the normal post-collect finalize cannot both run.

### 4.7 Single-writer rule (lock semantics)

Exactly ONE process ever writes to `.ao/state/ask-jobs/<jobId>.json` over the job's lifetime: the runner process pid'd in `meta.runnerPid`.

| Caller        | Reads metadata | Writes metadata | Notes                                                       |
| ------------- | -------------- | --------------- | ----------------------------------------------------------- |
| `async`       | no             | YES (initial)   | Writes once before exiting; runner takes over from there.   |
| `_run-job`    | YES            | YES             | The lock owner. All status flips, lastActivityAt bumps.     |
| `status`      | YES            | no              | Reconciles in-memory; never persists.                       |
| `collect`     | YES            | no              | Polls in `--wait` mode; never persists.                     |
| `cancel`      | YES            | no              | Signals runner; runner does the flip.                       |
| `list`        | YES            | no              | Bulk read.                                                  |
| SessionEnd    | no             | no (delete only) | Sweeps stale files via existing 24h cleanup.                |

The async parent handing off to the runner is a one-time bootstrap write — the parent exits before the runner starts mutating. The two writes are causally ordered (parent finishes its `writeFileSync` before `runner.unref(); process.exit()`, and the runner's first write is gated on its own startup latency, well after the parent's flush).

### 4.8 `list [--status ...] [--older-than Ns]`

```
1. readdirSync('.ao/state/ask-jobs') filter by *.json (excluding *.prompt).
2. For each: read JSON → meta.
3. Apply filters:
     --status running        → meta.status === 'running'
     --status completed      → ...
     --older-than 600        → (now - parseISO(meta.startedAt)) / 1000 > 600
4. Print JSON array to stdout. NOT liveness-reconciled — pure metadata read.
   Callers needing ground truth pipe through `xargs -n1 ask.mjs status`.
5. Exit 0.
```

### 4.9 JSONL tee strategy — verified against codex-exec.mjs

The runner needs to persist the adapter's stdout stream to disk WITHOUT interfering with the adapter's own JSONL parsing. Two facts make this tractable:

1. `scripts/lib/codex-exec.mjs:160` exposes `handle.stdout = child.stdout` on the returned handle.
2. `scripts/lib/codex-exec.mjs:179-211` attaches a `child.stdout.on('data', ...)` listener that aggregates events into `handle._output`.

Node `Readable` streams in flowing mode broadcast each `data` event to ALL attached listeners. The runner adds a SECOND listener:

```js
handle.stdout.on('data', (chunk) => {
  try { jsonlStream.write(chunk); } catch {}
  meta._inMemoryLastActivityAt = new Date().toISOString();
  maybeFlushMetadata(meta);
});
```

Both listeners receive every chunk; the adapter's parser continues to populate `handle._output`, and the runner's tee continues to persist raw bytes. The two are independent and there is no interference.

**Same fact for gemini-exec.** `scripts/lib/gemini-exec.mjs` follows the same handle shape — `handle.stdout = child.stdout`, with its own data listener. The same two-listener pattern works without modification.

**Risk:** if a future adapter refactor stops exposing `handle.stdout` directly (e.g., wraps it in a parsed-event emitter), the runner's tee breaks silently. AC-12 enforces this with a smoke test: spawn the real codex-exec module against a fake binary and assert `typeof handle.stdout?.on === 'function'`.

### 4.10 `.md` synthesis

For the async path, `.md` synthesis lives inside the runner's once-only `finalize('completed')` path (§4.3 step 10) and uses the SAME logic as the sync path at `scripts/ask.mjs:217-227`:

```js
const output = (handle._output || '').trim();
const body = output + (output.endsWith('\n') ? '' : '\n');
fs.writeFileSync(meta.artifactMdPath, body, { mode: 0o600 });
```

No frontmatter (matches the sync-path body-only contract from `ask-adapter-migration` rev 6 §4.1). The `.md` is jobId-addressable (`<jobId>.md`) instead of `<model>-<ts>.md` because parallel async jobs in the same second would otherwise collide.

**Fallback synthesis in `collect`.** If the runner crashed between writing the sentinel and writing `.md`, `collect` (§4.5 step 3) reads the sentinel's embedded `text` field directly — no adapter-specific JSONL parsing required. The sentinel text is `handle._output` verbatim, which is the same source the sync path uses for the `.md` body. This is a defence-in-depth recovery path; in normal operation the runner's finalize produces the `.md` directly.

### 4.11 `buildSpawnOpts` re-use — v1.0.3 contract preservation

The v1.0.3 contract is that codex's `level` (and gemini's `approvalMode`) are resolved via `resolveCodexApproval` / `resolveGeminiApproval` and the host-sandbox demotion path is honored. This logic lives in `scripts/ask.mjs:138-165` (`buildSpawnOpts`) and MUST be called from BOTH:

1. The sync path (already does, via `runOnce`).
2. The runner (NEW — must call `buildSpawnOpts(meta.adapterName)` at runner step 3 in §4.3).

AC-10 enforces this by injecting a fake adapter into the runner via `_injectAdapter` and asserting that the spawn opts received include `level` (codex) or `approvalMode` (gemini), proving the runner went through `buildSpawnOpts`.

If `buildSpawnOpts` returns `_demoted: true` inside the runner (host permission too low for non-interactive codex), the runner takes the same exit-2-equivalent path: writes status='failed' with errorCategory='demoted' to metadata and exits 0 (the runner's exit code is informational; callers learn the demotion via `status` / `collect`).

---

## 5. File map

Estimated LOC includes blank lines and JSDoc.

### 5.1 New files

| Path                                                        | LOC  | Purpose                                                                                            |
| ----------------------------------------------------------- | ---: | -------------------------------------------------------------------------------------------------- |
| `scripts/lib/ask-jobs.mjs`                                  | ~280 | Pure-ish helpers: jobId allocator, metadata reader/writer, prompt-file I/O, isProcessAlive, JSONL completion scanner, debounced flush. All test injection seams (`_injectClock`, `_injectLiveness`, `_injectFs`) live here. |
| `scripts/test/ask-jobs-unit.test.mjs`                       | ~300 | Pure unit tests for ask-jobs.mjs helpers — jobId format, metadata round-trip, liveness reconciliation, debounced flush, JSONL scan. No subprocess.                                                                       |
| `scripts/test/ask-async-dispatch.test.mjs`                  | ~220 | Dispatcher tests — argv routing, sync-path passthrough, async/status/collect/cancel/list arg validation. Uses `_injectRunJobSpawner` to avoid real `_run-job` re-exec.                                                  |
| `scripts/test/ask-runner-integration.test.mjs`              | ~320 | Full lifecycle integration tests — fake codex-exec/gemini-exec adapter (same `_inject` style as `scripts/test/worker-spawn-integration.test.mjs:4-29`), fake clock, fake liveness, exercise async → status → collect → md.  |
| `docs/plans/ask-job-based/spec.md`                          | ~700 | This file.                                                                                          |
| `docs/plans/ask-job-based/CHANGELOG.md`                     | ~30  | Per-plan change history (rev 1).                                                                    |

### 5.2 Modified files

| Path                                | LOC delta | Purpose                                                                                                                                       |
| ----------------------------------- | --------: | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/ask.mjs`                   | +350 / -10 | Add dispatcher, hoist sync path into `runSyncPath()`, add `runAsyncLaunch()`, `runStatus()`, `runCollect()`, `runCancel()`, `runList()`, `runJob()` (the `_run-job` entry point). |
| `scripts/test/ask.test.mjs`         | +0 / 0    | Existing 28 tests unchanged. Verify they still pass against the dispatched `runSyncPath`.                                                       |
| `skills/ask/SKILL.md`               | +60 / 0   | Add `## Async usage` section documenting `async`/`status`/`collect`/`cancel`/`list`. Default sync recipe preserved verbatim.                     |
| `CLAUDE.md`                         | +12 / 0   | Add `.ao/state/ask-jobs/` and async `.ao/artifacts/ask/<jobId>.{jsonl,md}` to State Management section. Note 24h SessionEnd opt-in.              |
| `CHANGELOG.md`                      | +20 / 0   | New `Unreleased` section documenting the `/ask` job-based commands.                                                                              |

### 5.3 Deleted files

None.

### 5.4 Total estimated implementation LOC

| Bucket                               | LOC   |
| ------------------------------------ | ----: |
| `scripts/ask.mjs` net additions       | ~340  |
| `scripts/lib/ask-jobs.mjs`           | ~280  |
| New tests (3 files)                  | ~840  |
| Docs (SKILL/CLAUDE/CHANGELOG)         | ~92   |
| Spec + plan CHANGELOG                 | ~730  |
| **TOTAL**                            | ~2280 |

**Implementation-only LOC (excluding tests + docs + spec):** ~620.

The user's "500–800 LOC real scope" estimate is correct for implementation. The total PR diff including tests, docs, and the spec itself lands around ~2.3k. **No split is recommended at this estimate.** If implementation drifts past 800 LOC during execution (e.g., the metadata flush debouncing or the JSONL completion scanner balloons), the implementer should pause and propose a split before continuing.

---

## 6. Acceptance criteria

### 6.1 Backward compat (sync path preservation)

**AC-1.** `echo "hello" | node scripts/ask.mjs codex` (with codex available) produces identical stdout, stderr, exit code, and artifact filename pattern as v1.0.3. The artifact still lives at `.ao/artifacts/ask/codex-<YYYYMMDD-HHMMSS>.md`, body-only, no frontmatter. _Verified by existing `scripts/test/ask.test.mjs` running unchanged._

**AC-2.** `echo "hello" | node scripts/ask.mjs gemini` likewise unchanged. _Verified by existing tests._

**AC-3.** `echo "hello" | node scripts/ask.mjs auto` likewise unchanged, including the codex→gemini auto-fallback on demotion (`scripts/ask.mjs:307-318`). _Verified by existing tests._

**AC-4.** Sync-path exit codes unchanged: 0 success / 1 adapter error / 2 model not available / 3 argv error. _Verified by existing tests + new dispatcher test asserting passthrough._

**AC-5.** v1.0.3 baseline: `node --test 'scripts/test/**/*.test.mjs'` reports ≥ 1506 passing tests before this PR. After this PR: ≥ 1530.

### 6.2 Async launch + runner lifecycle

**AC-6.** `echo "hello" | node scripts/ask.mjs async codex` (with codex available) prints exactly one JSON line to stdout `{jobId, artifactPath, runnerPid}`, creates `.ao/state/ask-jobs/<jobId>.json` with status='running', creates `.ao/state/ask-jobs/<jobId>.prompt` with the prompt body (deleted by the runner moments later), and exits 0 within 200ms. Verified by integration test using `_injectRunJobSpawner`.

**AC-7.** `node scripts/ask.mjs async codex` with codex unavailable exits 2 and prints the same `printUnavailable` message as the sync path. Does NOT create any files in `.ao/state/ask-jobs/`.

**AC-8.** The `_run-job` runner reads the prompt file, deletes it, calls `buildSpawnOpts(adapterName)`, spawns the adapter via `loadAdapter(adapterName)` (the SAME loader the sync path uses), and tees `handle.stdout` to `.ao/artifacts/ask/<jobId>.jsonl`. Verified by integration test with a fake adapter that records the spawn opts and asserts `level` is present for codex / `approvalMode` for gemini.

**AC-9.** On adapter `turn.completed`, the runner synthesizes `.ao/artifacts/ask/<jobId>.md` from `handle._output` using the same trim+newline logic as the sync path. The metadata file is flipped to status='completed', exitCode=0, endedAt set. Verified by integration test against fake adapter that emits `turn.completed`.

**AC-10.** `buildSpawnOpts` is invoked from BOTH the sync path AND the runner. Verified by an integration test that injects `_injectBuildSpawnOpts(spy)` and asserts the spy was called twice across one sync run + one async run.

**AC-11.** The runner does not write anything to its stdout/stderr (since the parent set those to `'ignore'`). Any internal logging goes into the JSONL artifact as `{type:"runner_log", ...}` lines. Verified by integration test asserting `runner.stdout` is null/empty and grepping the JSONL for `runner_log` entries.

**AC-12.** Smoke test: importing `./lib/codex-exec.mjs` and calling `spawn('test', { cwd: tmpdir })` against a fake codex binary on PATH returns a handle with `typeof handle.stdout?.on === 'function'`. Same for gemini-exec. This locks in the §4.9 contract that adapters expose `handle.stdout` for the JSONL tee.

### 6.3 Status reconciliation

**AC-13.** `status <jobId>` on a running job returns `status: 'running'`, `runnerAlive: true`, `adapterAlive: true|false`, `elapsedSec` ≥ 0, and does NOT mutate the metadata file. Verified by integration test reading the metadata file's mtime before and after.

**AC-14.** `status <jobId>` on a job whose runner has been killed AND whose JSONL contains no `runner_done` sentinel returns `status: 'failed'`, `errorCategory: 'crashed'`. Metadata file remains untouched on disk (still says 'running'). Verified by integration test using `_injectLiveness` to fake the runner as dead.

**AC-15.** `status <jobId>` on a job whose runner died AFTER writing the `runner_done` sentinel but BEFORE flipping metadata returns `status: 'completed'`. Verified by integration test that pre-seeds a JSONL with a `{"type":"runner_done","status":"completed"}` line and fakes the runner as dead.

**AC-15a.** (Rev-2) The runner writes its `runner_done` sentinel for BOTH codex-exec AND gemini-exec adapters. Verified by integration test using two fake adapters (codex-like emitting `turn.completed` on stdout, gemini-like emitting only a final JSON object) — BOTH must produce a JSONL file containing `{"type":"runner_done","status":"completed"}` after finalize runs. This addresses rev-1 Blocker 3 (adapter-agnostic completion detection).

**AC-15b.** (Rev-2) `collect` on a completed job whose `.md` was deleted falls back to synthesizing body from the JSONL's `agent_message` text. Verified by integration test that pre-seeds metadata=completed + JSONL with agent_message + deletes the .md file, then asserts `collect` recreates the .md and prints it.

**AC-15c.** (Rev-2) The runner passes `86_400_000` (24h) to `adapter.collect()` — verified by a `_injectCollect(spy)` integration test asserting `spy.callArgs[1] === 86_400_000`. This addresses rev-1 Blocker 2 (30s default timeout).

**AC-15d.** (Rev-3) `async auto` with a demoted-codex host and gemini available re-picks `gemini-exec` at dispatch (§4.2 step 4a) BEFORE spawning the runner. Verified by integration test that stubs `buildSpawnOpts('codex-exec')` to return `{_demoted:true}` and asserts the spawned runner's metadata contains `adapterName: 'gemini-exec'`. Addresses rev-2 blocker 1.

**AC-15e.** (Rev-3) The `runner_done` sentinel embeds `handle._output` verbatim in a `text` field. Verified by integration test parsing the JSONL tail after runner finalize. The text field length matches `handle._output.length`.

**AC-15f.** (Rev-3) `collect` on a completed job with the `.md` deleted recovers via the sentinel's `text` field for BOTH codex-exec and gemini-exec fake adapters. Verified by two integration tests (one per adapter) that pre-seed metadata=completed + JSONL with sentinel + delete .md, then assert `collect` recreates the .md and prints it. Addresses rev-2 blocker 2.

**AC-15g.** (Rev-3) `reconcileStatus` treats a sentinel with `status: 'cancelled'` as authoritative and reports `cancelled`, not `failed/crashed`. Verified by integration test pre-seeding a sentinel `{type:"runner_done",status:"cancelled"}` + faking runner dead + asserting reconciled status. Addresses rev-2 medium (cancel/finalize race).

**AC-16.** `status <unknown-jobId>` exits 3 with stderr `unknown jobId`.

### 6.4 Collect

**AC-17.** `collect <jobId>` on a completed job prints the `.md` artifact contents to stdout (exact byte-for-byte match) and exits 0.

**AC-18.** `collect <jobId>` on a running job WITHOUT `--wait` exits 75 immediately (within 100ms), no stdout, stderr brief.

**AC-19.** `collect <jobId> --wait --timeout 2` on a running job that never completes exits 75 after ~2 seconds, with stderr `timeout waiting for job <jobId>`. Verified by integration test using fake clock + fake adapter that never emits `turn.completed`.

**AC-20.** `collect <jobId> --wait` on a running job that completes mid-poll prints the `.md` and exits 0. Verified by integration test that flips metadata mid-poll.

**AC-21.** `collect <jobId>` on a failed job prints `{errorCategory}: {errorMessage}` to stderr and exits 1.

**AC-22.** `collect <jobId>` on a cancelled job prints `cancelled` to stderr and exits 1.

### 6.5 Cancel

**AC-23.** `cancel <jobId>` on a running job sends SIGTERM to `meta.runnerPid` and exits 0. The metadata file is NOT mutated by the cancel CLI itself. Verified by integration test asserting that the cancel CLI's process did not write to the metadata file (mtime unchanged from cancel CLI's perspective; it changes only after the runner's SIGTERM handler flips it).

**AC-24.** `cancel <jobId>` is idempotent: a second invocation on an already-terminal job exits 0 without sending any signal.

**AC-25.** `cancel <jobId>` when the runner pid is no longer alive AND reconciliation still yields 'running' (crashed runner, no sentinel) exits 1 with stderr instructing the user to run `status` to reconcile.

**AC-25a.** (Rev-2) `cancel <jobId>` when the runner already wrote the `runner_done` sentinel but has not yet updated metadata → reconciliation in step 2 sees `completed` and the cancel exits 0 (idempotent). Verified by integration test pre-seeding the sentinel + faking runner dead. Addresses rev-1 Medium 5 cancel/finalize race.

### 6.6 List

**AC-26.** `list` with no filters returns a JSON array of all `.ao/state/ask-jobs/*.json` entries (excluding `*.prompt` files), sorted by `startedAt` descending.

**AC-27.** `list --status running` filters to entries where `meta.status === 'running'` (NOT liveness-reconciled — explicit non-goal documented in §4.8).

**AC-28.** `list --older-than 600` filters to entries where `(now - parseISO(meta.startedAt)) / 1000 > 600`. Verified with fake clock.

### 6.7 No regressions / hygiene

**AC-29.** Grep test: no new occurrences of `tmux` in `scripts/ask.mjs` or `scripts/lib/ask-jobs.mjs`. (Existing AC-6 from `ask-adapter-migration` rev 6 stays in force.)

**AC-30.** Grep test: `scripts/ask.mjs` does NOT call itself recursively via `node scripts/ask.mjs ...` from inside any code path EXCEPT the documented detached re-exec in `runAsyncLaunch()`. (Prevents accidental fork bombs.)

**AC-31.** Test isolation: every new test in `scripts/test/ask-*.test.mjs` calls `process.chdir(mkdtempSync(...))` AND sets `process.env.HOME = <empty tmpdir>` in `beforeEach`, and cleans up via `afterEach`. Verified by reading the test files. Without this, `permission-detect.mjs` will read the developer's real `~/.claude/settings*.json` and either leak machine-specific behavior into the tests or pollute results based on whoever runs them.

**AC-32.** No new npm dependencies. `package.json` `dependencies` and `devDependencies` are unchanged.

**AC-33.** All hooks remain fail-safe. The async launch path's `printUsage`/`printUnavailable` outputs go to stderr (not stdout) so callers parsing the stdout JSON line never see an unexpected error blob.

---

## 7. Test plan

### 7.1 Pure unit tests — `scripts/test/ask-jobs-unit.test.mjs`

Subjects under test (all exported from `scripts/lib/ask-jobs.mjs`):

- `allocateJobId(adapterName, clock)` — format `ask-<label>-YYYYMMDD-HHMMSS-XXXX`, label ∈ {codex,gemini}, clock injectable
- `computePromptHash(model, prompt)` — sha256(`${model}\n${prompt}`), hex
- `writeMetadata(jobId, meta, fsImpl)` — atomic write via tmp + rename, mode 0o600, parent dir 0o700
- `readMetadata(jobId, fsImpl)` — returns null on ENOENT, parses JSON, throws on schemaVersion > 1 (per existing v1.0.2 schemaVersion convention in CLAUDE.md)
- `writePromptFile(jobId, prompt, fsImpl)` / `readAndUnlinkPromptFile(jobId, fsImpl)` — round-trip
- `isProcessAlive(pid, killImpl)` — pid 0 is invalid (false), `process.kill(0)` success → true, ENOENT/ESRCH → false, EPERM → true
- `reconcileStatus(meta, livenessImpl, jsonlScannerImpl)` — the §4.4 reconciliation logic in pure form
- `scanJsonlForCompletion(path, fsImpl)` — returns true if any line contains `"type":"turn.completed"`
- `maybeFlushMetadata(meta, clock, fsImpl)` — debounced flush; 5s floor + status-change override
- `parseAskArgs(argv)` — dispatcher routing; returns `{ command: 'sync'|'async'|'status'|..., model?, jobId?, wait?, timeoutSec?, statusFilter?, olderThanSec? }`

Each test uses `node:test` + injectable fakes. No `mock` package, no real fs, no real `process.kill`.

### 7.2 Dispatcher tests — `scripts/test/ask-async-dispatch.test.mjs`

- argv `[]` / `[node, ask.mjs]` → exit 3, usage error
- argv `[..., 'codex']` → routes to sync path; `_injectSyncRunner(spy)` records the call
- argv `[..., 'async', 'codex']` → routes to async; `_injectRunJobSpawner(spy)` records the spawn arguments
- argv `[..., 'async']` (missing model) → exit 3
- argv `[..., 'async', 'banana']` → exit 3
- argv `[..., 'status', '<id>']` → routes to status reader
- argv `[..., 'collect', '<id>', '--wait']` → routes to collect with `wait=true`
- argv `[..., 'collect', '<id>', '--wait', '--timeout', '30']` → `wait=true, timeoutSec=30`
- argv `[..., 'list', '--status', 'running']` → `command='list', statusFilter='running'`
- argv `[..., '_run-job', '<id>']` → routes to runner

### 7.3 Runner integration tests — `scripts/test/ask-runner-integration.test.mjs`

Pattern mirrors `scripts/test/worker-spawn-integration.test.mjs:4-29`: a fake adapter object with `spawn`, `collect`, `shutdown` is passed via `_inject`. Real subprocesses are NEVER spawned in tests.

Cases:

1. **Happy path codex.** Inject fake codex-exec → async launch → runner consumes prompt file → tees fake `data` chunks to JSONL → fake adapter emits `turn.completed` → runner synthesizes `.md` → metadata flips to completed → `collect` returns the body.
2. **Happy path gemini.** Same with fake gemini-exec.
3. **Codex demoted.** Inject fake codex-exec; force `buildSpawnOpts` (via `_injectBuildSpawnOpts`) to return `{ _demoted: true, _demotionReason: 'host suggest tier' }`. Runner flips metadata to failed/category=demoted. `collect` exits 1 with the demotion message.
4. **Adapter error.** Fake adapter's `collect` resolves with `{ error: { category: 'auth', message: 'OPENAI_API_KEY not set' }}`. Runner flips metadata to failed/category=auth. `collect` exits 1.
5. **Crash before completion.** Fake adapter never resolves; integration test fakes the runner as dead via `_injectLiveness`. `status` reconciles to failed/category=crashed. JSONL scanner returns false (no `turn.completed`).
6. **Crash after completion.** Pre-seed JSONL with a `turn.completed` line; fake runner as dead. `status` reconciles to completed.
7. **Cancel.** Async launch → cancel sends SIGTERM → fake runner's SIGTERM handler flips metadata to cancelled → `collect` exits 1 with "cancelled".
8. **Cancel idempotent.** Cancel a completed job → exit 0, no signal sent.
9. **Collect --wait happy.** Spawn runner; runner takes 50ms (fake clock); `collect --wait --timeout 5` returns the .md.
10. **Collect --wait timeout.** Runner takes 5s; `collect --wait --timeout 1` exits 75 after ~1s.
11. **List filters.** Pre-seed three metadata files with different `startedAt` and `status`; assert `--status running`, `--older-than 60` filter correctly.
12. **buildSpawnOpts called from runner.** Spy on `_injectBuildSpawnOpts`; assert the spy was called from inside the runner with the correct adapterName.
13. **Sync path still works.** Verify existing 28 ask.test.mjs tests pass without modification (delegate via `node --test`).
14. **Adapter handle.stdout smoke.** Import real `./lib/codex-exec.mjs`, spawn against a fake `codex` binary on PATH, assert `typeof handle.stdout?.on === 'function'`. Same for gemini-exec.

### 7.4 Test isolation harness

Every new test file ships with this `beforeEach`/`afterEach`:

```js
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp;
let originalCwd;
let originalHome;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ask-jobs-test-'));
  originalCwd = process.cwd();
  originalHome = process.env.HOME;
  process.chdir(tmp);
  process.env.HOME = tmp;  // empty HOME prevents permission-detect from reading developer's real ~/.claude
});

afterEach(() => {
  process.chdir(originalCwd);
  process.env.HOME = originalHome;
  rmSync(tmp, { recursive: true, force: true });
});
```

---

## 8. Risks & follow-ups

### 8.1 Risks

| ID  | Risk                                                                                                     | Mitigation                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| R1  | Runner double-detach. Codex-exec sets `detached:true` on its child; if the runner ALSO detaches the adapter child, the runner loses parent status and `process.on('exit')` won't fire. | The runner does NOT call `child.unref()` on the adapter handle. The runner detaches from the async parent only; it stays the controlling parent of the adapter. Documented in §4.3 step 7. |
| R2  | JSONL tee assumption breaks if a future adapter wraps `child.stdout`.                                    | AC-12 smoke test pins `typeof handle.stdout?.on === 'function'` for both real adapters.                   |
| R3  | Cancel race: cancel CLI signals runner just as runner is mid-flush; partial metadata corruption.         | Single-writer rule (§4.7) — only the runner ever writes. Cancel cannot corrupt because cancel never writes. The runner's SIGTERM handler does an atomic `writeFileSync` (whole-file replace), not a streaming append. |
| R4  | Async parent crashes between detached spawn and metadata write → orphaned runner with no metadata.       | Runner step 1: if metadata missing, exit 1. The orphaned runner self-terminates. The orphan is harmless because it never writes anything (it exited before opening the JSONL stream).                                  |
| R5  | `process.kill(pid, 0)` on Windows behaves differently (always returns true if you have access).          | Agent-olympus targets macOS/Linux primarily. Document the limitation in `isProcessAlive` JSDoc; call it out in CLAUDE.md if it ever ships on Windows.                                                                  |
| R6  | SessionEnd 24h sweep deletes an in-flight job's metadata.                                                | The 24h threshold uses file mtime; runner's debounced flush bumps mtime every 5s. A job has to be idle for 24h to be swept. Codex turns top out at ~10 minutes in practice. No realistic risk.                          |
| R7  | Detached spawn on macOS sometimes inherits the parent's controlling tty unless `stdio: 'ignore'` is explicit. | We pass `stdio: ['ignore','ignore','ignore']` explicitly. Documented in §4.2 step 7.                     |
| R8  | The 500ms `collect --wait` poll is long enough that a sub-second job could finish, get reconciled, AND have its `.md` ready before the first poll fires; spurious 75 exits. | The first poll happens immediately (`while (true) { check; if (done) return; sleep(500); }`), not after a sleep. Documented in §4.5.                                                                                  |
| R9  | Real LOC drift past 800 implementation lines.                                                            | The implementer pauses and proposes a split before exceeding the budget. The natural split point is `runAsyncLaunch + runJob + runStatus + runCollect + runCancel + runList` (this PR) vs `ask-jobs.mjs + tests + docs` (follow-up). If split, AC-1..AC-5 must hold for both PRs independently. |

### 8.2 Follow-ups (out of scope)

- **F1.** Dedup cache (NG1). The `promptHash` field is persisted now so the future PR is purely additive.
- **F2.** Streaming `collect` (NG2). Tail JSONL chunks to stdout in real time.
- **F3.** Atlas/Athena `/ask` callers can opt into async fire-and-forget. Right now they stay on the sync path; switching them is a separate decision.
- **F4.** A `ask:gc` housekeeping subcommand that bulk-removes terminal jobs older than N hours, independent of the SessionEnd sweep.
- **F5.** Windows `isProcessAlive` portability — once agent-olympus officially supports Windows.

---

## 9. Migration / rollback

### 9.1 Migration

This PR is **purely additive** for all existing callers. The sync path is byte-identical to v1.0.3 from the caller's perspective. No state migration is required because no v1.0.3 state files exist for the new `.ao/state/ask-jobs/` directory — it is created on first use by the async launch path.

SKILL.md gets a NEW `## Async usage` section. The default sync recipe is preserved verbatim so muscle-memory `/ask codex` invocations behave identically.

### 9.2 Rollback

Revert the PR. After revert:

- Existing sync-path callers continue to work (no behavior change).
- Any `.ao/state/ask-jobs/<jobId>.json` and `.ao/artifacts/ask/<jobId>.{jsonl,md}` files written by the async path become orphaned but harmless. They will be swept by the existing SessionEnd 24h cleanup.
- Any in-flight `_run-job` runners still alive at revert time continue running until their adapter exits — they are detached node processes with no dependency on the host claude-code session. The runner's eventual `writeMetadata` call will succeed (the metadata file format is unchanged after revert because the file was created before the revert) but the resulting `.md` artifact will simply be unreachable via the now-deleted `collect` subcommand. Users can still `cat .ao/artifacts/ask/<jobId>.md` directly.
- No git-tracked state changes. No schema migration. No locked rows. Zero rollback friction.

---

## 10. Cross-review trail

| Rev | Reviewer        | Verdict             | Issues addressed                                                                  |
| --- | --------------- | ------------------- | --------------------------------------------------------------------------------- |
| 1   | Codex 0.118.0   | REWORK              | 4 blockers + 1 medium: launch race, 30s collect default, codex-specific completion oracle, missing mkdir + tee error handling, cancel/finalize race |
| 2   | (revision)      | —                   | §4.2 launch order, §4.3 explicit 24h timeout + runner_done sentinel + once-only finalize + mkdir + stream error, §4.4 sentinel reconciler, §4.5 fallback synth + immediate first poll, §4.6 reconcile before liveness, AC-15a/15b/15c/25a added |
| 2   | Codex 0.118.0   | APPROVE-WITH-FIXES  | 2 blockers + 1 medium: async-auto demotion fallback missing, fallback synth still codex-shaped, cancelled-sentinel not treated as authoritative |
| 3   | (revision)      | —                   | §4.2 step 4a dispatch-level auto fallback, §4.3.2 sentinel `text` field, §4.4 reconciler treats all 3 sentinel statuses authoritatively, §4.5 fallback reads sentinel text, AC-15d/15e/15f/15g added |
| 3   | Codex 0.118.0   | APPROVE-WITH-FIXES  | 1 blocker + 1 small: sentinel flush not guaranteed before process.exit (WriteStream buffering), demoted early-exit path tried to write sentinel before stream opened |
| 4   | (revision)      | —                   | §4.3 step 3 mkdir hoisted above demoted branch, §4.3.2 sentinel write switched to `appendFileSync` (synchronous, bypasses WriteStream), §4.3 step 10 finalize awaits `jsonlStream.end()` completion before sentinel append |
| 4   | Codex 0.118.0   | APPROVE             | Rev-3 flush/ordering issues closed; no remaining findings. Implementation can begin. |

---

## Appendix A — Cited file:line references

- `scripts/ask.mjs:34` — `COLLECT_TIMEOUT_MS = 120_000` (the source of the bug).
- `scripts/ask.mjs:138-165` — `buildSpawnOpts(adapterName)`, the v1.0.3 contract that MUST be re-used by the runner unchanged.
- `scripts/ask.mjs:187-243` — `runOnce()`, the sync path's spawn → collect → shutdown lifecycle. The runner mirrors this with the timeout removed and the JSONL tee added.
- `scripts/ask.mjs:217-227` — `.md` synthesis logic (trim + trailing newline). The runner uses the SAME logic.
- `scripts/ask.mjs:307-318` — auto-mode codex→gemini fallback on demotion. Async path inherits this only at the dispatch layer (the launcher's `pickAskAdapter` → `runOnce` short-circuit); the runner does NOT need to know about it because by the time `_run-job` is invoked, the adapter has already been chosen.
- `scripts/lib/codex-exec.mjs:160` — `handle.stdout = child.stdout`, the JSONL tee anchor (§4.9).
- `scripts/lib/codex-exec.mjs:179-211` — adapter's own `child.stdout.on('data', ...)` handler. Confirms that adding a second listener does not interfere with parsing.
- `scripts/lib/codex-exec.mjs:154` — `detached: true` on the codex child. R1 risk source: the runner must NOT add a second `detached/unref` layer on top.
- `scripts/test/worker-spawn-integration.test.mjs:4-29` — the canonical `_inject` pattern for fake adapter modules. New `ask-runner-integration.test.mjs` mirrors this exactly.
- `CLAUDE.md` State Management section — `.ao/state/` 24h SessionEnd sweep convention. New `.ao/state/ask-jobs/` opts in.
- `CLAUDE.md` schemaVersion convention (v1.0.2+) — every new persisted format carries `schemaVersion: 1`. The metadata JSON, prompt sidecar, and `.jsonl` artifact entries all comply.
