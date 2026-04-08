# `/ask` Skill — Adapter Migration (tmux → adapter system)

**Status:** APPROVED (rev 6 — Codex APPROVE-WITH-FIXES verdict on rev 5; final fix corrects the §9 §migration table to remove a fictitious tmux-gemini scenario)
**Scope:** S (single skill + small Node CLI helper + tests)
**Branch:** `claude/suspicious-kirch`
**Date:** 2026-04-08
**Cross-review:** Codex CLI 0.118.0 — REWORK verdict on rev 1, blocking issues addressed in §4.1, §6, §8

---

## 1. Problem

`skills/ask/SKILL.md` hardcodes a tmux-based codex/gemini invocation:

```bash
tmux new-session -d -s "$SESSION" -c "<cwd>"
tmux send-keys -t "$SESSION" '<model-binary> exec "<prompt>"' Enter
sleep 5
tmux capture-pane -pt "$SESSION" -S -200
```

This is an **outlier** in the codebase. Atlas/Athena workers were migrated to the
adapter system (`scripts/lib/worker-spawn.mjs::selectAdapter()`) in v0.9.x:

| Worker type | Preferred adapter            | Fallback (legacy) |
| ----------- | ---------------------------- | ----------------- |
| codex       | codex-appserver → codex-exec | tmux              |
| claude      | claude-cli                   | tmux              |
| gemini      | gemini-acp → gemini-exec     | tmux              |

The comment in `worker-spawn.mjs:132` is explicit: **"tmux: legacy fallback for all worker types."**

`/ask` skipped that migration because it's a single-shot lightweight path. The result
is an inconsistency:

1. `skills/ask/SKILL.md` (slash-command path) — tmux hardcoded
2. `agents/ask.md` (sub-agent path)         — already says "Use the available worker adapters"

This plan aligns the slash-command path with the sub-agent path and the rest of the
codebase, removes a tmux dependency for the most common quick-query case, and gives
us per-call structured errors (the tmux path only gets us pane scraping +
`detectCodexError` regex).

## 2. Goals

- `/ask codex …` and `/ask gemini …` use the exec adapters (`codex-exec`,
  `gemini-exec`) directly, the same way Atlas/Athena workers do
- **`/ask` no longer touches tmux at all** (rev 4 architectural decision — see
  §4.1.1(b))
- No regression in artifact format (`.ao/artifacts/ask/<model>-<timestamp>.md`,
  plain body content, no frontmatter)
- No new runtime dependencies (Node built-ins only, consistent with project policy)
- Gemini approval mode mirroring matches Atlas (`gemini-exec` already supports
  `opts.approvalMode`); Codex permission mirroring matches today's behavior
  (still hard-bypass — see §4.1.3)

## 3. Non-Goals

- Not redesigning multi-turn `/ask` (still single-shot — that's the point of `/ask`)
- Not removing tmux from worker-spawn.mjs (Atlas/Athena legacy fallback stays)
- Not changing `agents/ask.md` (already correct)
- Not adding streaming UI — collect-and-print is fine for single-shot
- Not adding cost tracking to `/ask` (out of scope; Atlas/Athena have it via `cost-estimate.mjs`)

## 4. Approach

### 4.1 New file: `scripts/ask.mjs` (CLI helper)

A small Node CLI that the SKILL.md will shell out to:

```
node scripts/ask.mjs <model> <<<EOF
<prompt body>
EOF
```

- `<model>` ∈ `{codex, gemini, auto}` (auto = codex first, gemini fallback)
- Prompt is read from **stdin** (avoids shell-quoting hell with multi-line prompts
  containing backticks, quotes, `$`, etc.)

#### 4.1.1 Routing — `/ask` does NOT call `selectAdapter()`, and has NO tmux fallback

Two corrections from cross-review:

**(a) `selectAdapter()` is wrong for `/ask`.** It returns multi-turn adapters
(`codex-appserver`, `gemini-acp`) when available, but those have multi-step
handshakes (`startServer → initializeServer → createThread → startTurn` for
codex-appserver; `startServer → initializeServer → createSession → sendPrompt`
for gemini-acp). A single-shot `/ask` does not need that machinery and would
pay startup cost for nothing. Also, `'auto'` is not a valid worker `type` —
passing it to `selectAdapter()` falls straight to `tmux`.

**(b) tmux fallback is dropped from `ask.mjs`.** The original plan tried to call
`tmux-session.mjs::createTeamSession()` for the fallback path, but that helper
creates a **git worktree per worker** (tmux-session.mjs:88-135 → worktree.mjs).
That is heavyweight team-mode machinery, completely inappropriate for a
single-shot `/ask`. Building a separate inline tmux path inside `ask.mjs` would
duplicate logic the project is actively trying to retire.

The cleanest answer is: **`ask.mjs` only handles `codex-exec` and `gemini-exec`.**
If neither is available, `ask.mjs` exits 2 and SKILL.md instructs Claude to
answer the question directly. This:
- Aligns with the explicit project direction ("tmux: legacy fallback for all
  worker types" — worker-spawn.mjs:132)
- Eliminates the worktree-creation regression risk
- Reduces `ask.mjs` to ~100 LOC
- Is a small breaking change for users on codex < 0.116 (no JSON exec). The
  project's worker system already requires codex ≥ 0.116 for Atlas/Athena, so
  the affected audience is users who have ONLY ever used `/ask` on a stale
  codex. This is documented in §9 Migration.

```
function pickAskAdapter(model, caps) {
  // Resolve 'auto' first — codex preferred when both available
  if (model === 'auto') {
    if (caps.hasCodexExecJson) return 'codex-exec';
    if (caps.hasGeminiCli)     return 'gemini-exec';
    return 'none';
  }
  if (model === 'codex') {
    if (caps.hasCodexExecJson) return 'codex-exec';
    return 'none';   // explicit codex request: no cross-fallback to gemini
  }
  if (model === 'gemini') {
    if (caps.hasGeminiCli)     return 'gemini-exec';
    return 'none';   // explicit gemini request: no cross-fallback to codex
  }
  return 'none';
}
```

`codex-appserver` and `gemini-acp` are **intentionally excluded** — Atlas/Athena
own those code paths. tmux is **intentionally excluded** — single-shot use cases
should not pull in worktree machinery, and the project is phasing tmux out as
the legacy fallback.

#### 4.1.2 Behavior

1. `await detectCapabilities()` from `preflight.mjs` (uses 60-min cache)
2. `pickAskAdapter(model, caps)` returns one of `codex-exec | gemini-exec | none`
3. **`'none'`** → exit code 2, stderr message "no adapter available for requested
   model; answer directly as Claude"
4. **`'codex-exec'` / `'gemini-exec'`**:
   ```
   const handle = adapter.spawn(prompt, opts);
   try {
     const result = await adapter.collect(handle, 120000); // 120s timeout
     // result: { status, output, error? }
     write artifact (always, with output or error message);
     if (result.error) { stderr(result.error); exit 1; }
     stdout(handle._output || result.output);
     exit 0;
   } finally {
     await adapter.shutdown(handle).catch(() => {}); // MANDATORY — see Risk #1
   }
   ```

No tmux branch — see §4.1.1(b) for rationale.

#### 4.1.3 Permission mirroring (honest version)

- **codex-exec**: hard-bypasses approvals via
  `--dangerously-bypass-approvals-and-sandbox` (codex-exec.mjs:96). This is **the
  current behavior** for both Atlas and tmux paths, so `/ask` matches it. Not
  Atlas-equivalent; fixing this requires plumbing through codex-exec.spawn() and
  is **out of scope** (see §8 Future).
- **gemini-exec**: pass `approvalMode` derived from
  `resolveGeminiApproval()` in `scripts/lib/gemini-approval.mjs` (delegates to
  `permission-detect.mjs`). gemini-exec's `spawn()` already accepts
  `opts.approvalMode` (gemini-exec.mjs:172-174), so this is a one-line plumb.
  This **is** Atlas-equivalent.

The plan does NOT claim full permission parity. It claims "matches current
behavior for codex; gains gemini approval mode mirroring."

#### 4.1.4 Exit codes

  - `0` — success, output printed to stdout
  - `1` — adapter error (auth/network/crash/timeout) — error printed to stderr
  - `2` — **requested model not available** — meaning depends on the model arg:
    - `model=auto`: neither codex (≥0.116) nor gemini installed
    - `model=codex`: codex not installed at version ≥0.116. **No cross-fallback
      to gemini** even if gemini is installed (explicit user intent).
    - `model=gemini`: gemini not installed. **No cross-fallback to codex** even
      if codex is installed (explicit user intent).
    SKILL.md branches to "answer as Claude directly" on exit 2.
  - `3` — argv/usage error (missing model arg, empty stdin)

### 4.2 Updated: `skills/ask/SKILL.md`

Replace the tmux block. The new instructions feed the prompt via heredoc on
stdin so there's NO inline shell quoting (no `PROMPT="..."` intermediate
variable, which Codex review flagged as undermining the stdin fix):

```markdown
### 2. Spawn via adapter

Pipe the prompt to the helper via a heredoc — the helper handles capability
detection, adapter selection, artifact writing, and process cleanup.

​```bash
mkdir -p .ao/artifacts/ask
node scripts/ask.mjs <model> <<'ASK_PROMPT_EOF'
<the user's full question, as-is, no escaping needed>
ASK_PROMPT_EOF
EXIT=$?
​```

- `<model>` is `codex`, `gemini`, or `auto` (default)
- The helper writes the artifact (`.ao/artifacts/ask/<model>-<ts>.md`) and prints
  the response to stdout. No tmux required when codex-exec or gemini-exec is
  available.
- Exit codes: `0` success, `1` adapter error, `2` requested model not available
  (answer directly as Claude with a note), `3` usage error
```

Update the `description` field:

```yaml
description: Quick single-shot query to Codex or Gemini via the worker-adapter system, with artifact saved
```

### 4.3 No changes needed

- `agents/ask.md` — already says "Use the available worker adapters" (ask.md:18)
- `scripts/lib/worker-spawn.mjs` — adapter registry already correct
- `scripts/lib/codex-exec.mjs` / `gemini-exec.mjs` — APIs already cover single-shot
- `CLAUDE.md` — adapter docs already accurate

## 5. File Map

| Action  | Path                                          | Purpose                                 |
| ------- | --------------------------------------------- | --------------------------------------- |
| CREATE  | `scripts/ask.mjs`                             | CLI helper, ~120 LOC                    |
| CREATE  | `scripts/test/ask.test.mjs`                   | Unit tests                              |
| MODIFY  | `skills/ask/SKILL.md`                         | Replace tmux block, update description  |
| —       | `agents/ask.md`                               | (no change — already correct)           |

## 6. Acceptance Criteria

These ACs are written against `pickAskAdapter()`, NOT `selectAdapter()`.

**AC-1 — `codex` arg, codex-exec available**
Given `caps.hasCodexExecJson === true`,
when `echo 'hi' | node scripts/ask.mjs codex` runs,
then `pickAskAdapter('codex', caps) === 'codex-exec'`, codex-exec.spawn is invoked
exactly once, codex-exec.shutdown is called from the `finally` block, and the
response is printed to stdout.

**AC-2 — `auto` arg, both available, codex preferred**
Given `caps.hasCodexExecJson === true && caps.hasGeminiCli === true`,
when `echo 'hi' | node scripts/ask.mjs auto` runs,
then `pickAskAdapter('auto', caps) === 'codex-exec'`. (codex is preferred for
`auto` because Codex has historically been the default in `/ask`.)

**AC-3 — `auto` arg, codex missing**
Given `caps.hasCodexExecJson === false && caps.hasGeminiCli === true`,
when `echo 'hi' | node scripts/ask.mjs auto` runs,
then routes to `'gemini-exec'`.

**AC-4 — `gemini` arg, gemini available without ACP**
Given `caps.hasGeminiCli === true && caps.hasGeminiAcp === false`,
when `echo 'hi' | node scripts/ask.mjs gemini` runs,
then `pickAskAdapter('gemini', caps) === 'gemini-exec'`. **`gemini-acp` is never
selected by `/ask`, even when available** — that's Atlas/Athena territory.

**AC-5 — No-adapter degradation (auto)**
Given `caps.hasCodexExecJson === false && caps.hasGeminiCli === false && caps.hasTmux === false`,
when `echo 'hi' | node scripts/ask.mjs auto` runs,
then exit code is `2` and stderr contains "no adapter available".

**AC-5b — Explicit model unavailable does NOT cross-fall back**
Given `caps.hasCodexExecJson === false && caps.hasGeminiCli === true`,
when `echo 'hi' | node scripts/ask.mjs codex` runs,
then exit code is `2`. The helper does NOT silently route to gemini even though
gemini-exec is available — that would violate explicit user intent. The same
applies symmetrically to `model=gemini` with only codex installed.

**AC-6 — No tmux fallback path exists**
Grep assertion: `scripts/ask.mjs` contains zero references to
`tmux-session.mjs`, `createTeamSession`, `spawnWorkerInSession`, `capturePane`,
or any tmux command string. Verified by a unit test that imports the file as
text and asserts the absence of these tokens. (Rev 4 architectural decision —
see §4.1.1(b).)

**AC-7 — Process cleanup (call-side, not side-effect)**
The helper's `finally` block invokes `adapter.shutdown(handle)` exactly once for
every `adapter.spawn(handle)`. Verified by **spying on `adapter.shutdown`** —
NOT by checking `handle.process.killed`, because `shutdown()` short-circuits
when `_exitCode !== null` (codex-exec.mjs:301) and `process.killed` would be
false on normal-exit paths. The test asserts `shutdownSpy.callCount === 1`
across three scenarios: success, adapter error, and timeout. (Addresses Codex
review residual on Blocker 3.)

**AC-7b — No orphaned children on timeout**
When `collect()` resolves with a `timeout` error, the subsequent
`adapter.shutdown(handle)` call MUST escalate to SIGKILL within `SHUTDOWN_GRACE_MS`
(5s default in codex-exec). Verified by integration test that spawns a sleep
loop, hits the timeout, and asserts `handle._exitCode !== null` within 6s of
`shutdown()` returning.

**AC-8 — Artifact written (always)**
After any `/ask` invocation (success, error, or timeout), the file
`.ao/artifacts/ask/<model>-<ts>.md` exists. **The artifact is plain body content**
(no YAML frontmatter, no metadata header) — preserves "no regression in artifact
format" per Codex review.

**AC-9 — Gemini approval mode mirroring**
When `pickAskAdapter` selects `gemini-exec`, the helper passes
`approvalMode: resolveGeminiApproval(...)` to `geminiExec.spawn()`. Verified by
spy/mock on `geminiExec.spawn`.

**AC-10 — SKILL.md description matches behavior**
`description` field no longer says "via tmux"; it reflects the adapter system.

**AC-11 — All existing tests pass**
`node --test 'scripts/test/**/*.test.mjs'` passes (1000+ tests, 50 files).

## 7. Test Plan

### Unit (scripts/test/ask.test.mjs)

- argv parsing: `codex|gemini|auto`, missing arg → exit 3
- stdin reading: empty stdin → exit 3 with usage message
- `pickAskAdapter()` routing matrix (pure function, no mocks needed):
  | hasCodexExecJson | hasGeminiCli | model arg | expected           |
  | ---------------- | ------------ | --------- | ------------------ |
  | true             | true         | codex     | codex-exec         |
  | true             | true         | gemini    | gemini-exec        |
  | true             | true         | auto      | codex-exec         |
  | false            | true         | auto      | gemini-exec        |
  | true             | false        | auto      | codex-exec         |
  | false            | false        | auto      | none → exit 2      |
  | false            | true         | codex     | none → exit 2      |
  | true             | false        | gemini    | none → exit 2      |
  | false            | false        | codex     | none → exit 2      |
  | false            | false        | gemini    | none → exit 2      |
- Artifact path generation (timestamp format, plain body content)
- Error path: adapter throws → artifact written with `# Error` header, exit 1
- **No tmux references in `scripts/ask.mjs`** — grep test (AC-6): assert the
  source file string contains none of `tmux`, `tmux-session`, `createTeamSession`,
  `spawnWorkerInSession`, `capturePane`
- Shutdown spy: `adapter.shutdown` called exactly once across success/error/timeout
  scenarios (AC-7)

### Integration (manual)

- Run `echo "explain async/await" | node scripts/ask.mjs codex` against a real codex
  install — verify response printed and artifact written
- Same for gemini
- Uninstall both temporarily → verify exit 2 path
- `/ask` slash command end-to-end: invoke from Claude Code session

### Regression

- Atlas/Athena unchanged — run a small Atlas task to confirm worker-spawn still works

## 8. Risks & Future

### Risks

1. **Detached process leak (Codex review blocker #3)** — codex-exec spawns
   children with `detached: true` (codex-exec.mjs:105), and `collect()`'s timeout
   path does NOT kill the process — it just resolves the promise with a `timeout`
   error. If `ask.mjs` exits without calling `shutdown()`, the codex child can
   linger.
   **Mitigation**: every adapter call wrapped in `try { … } finally { await
   adapter.shutdown(handle).catch(() => {}); }`. AC-7 enforces this with a test.
   gemini-exec has the same pattern — same fix.
2. **codex-exec timeout default (30s in `collect()`)** is too low for some queries.
   **Mitigation**: pass `120000` explicitly from `ask.mjs` (single-shot is naturally
   bounded).
3. **Permission parity overstated (Codex review)** — codex-exec hard-bypasses
   approvals. `/ask` cannot achieve full Atlas-equivalent mirroring without
   modifying codex-exec.mjs.
   **Mitigation**: be explicit in the spec (§4.1.3) — "matches current behavior
   for codex; gains gemini approval mode mirroring." Atlas-level codex mirroring
   is filed as a follow-up.
4. **Hidden coupling**: if codex-exec.mjs API changes, ask.mjs breaks.
   **Mitigation**: helper is ~150 LOC and pulls only `spawn`/`collect`/`shutdown`
   — same surface Atlas/Athena uses, so any breaking change would already be
   caught upstream.
5. **`/ask` deliberately ignores the multi-turn adapters** — `codex-appserver`
   and `gemini-acp` are excluded from `pickAskAdapter()` even when their
   capabilities are present. This is intentional (single-shot doesn't justify
   the handshake cost), and is enforced by AC-4 ("`gemini-acp` is never selected
   by `/ask`").
6. **No tmux fallback at all** — Rev 4 architectural decision. The worktree
   side-effect inside `createTeamSession()` made the original tmux fallback
   unsafe for `/ask`, and building a separate inline tmux path would duplicate
   logic the project is phasing out. Trade-off: small breaking change for
   stale-codex users (see §9 Migration). Benefit: ~50 LOC removed, zero tmux
   coupling, zero worktree side effects. AC-6 enforces this with a grep test.

### Follow-ups (out of scope, file as separate plan if pursued)

- Wire `detectClaudePermissionLevel()` into codex-exec `spawn()` so the bypass flag
  is conditional on host permission level (currently always bypasses)
- Add `--timeout` argv flag to ask.mjs
- Add streaming output (print tokens as they arrive, instead of collect-then-print)

## 9. Migration / Rollback

- **Migration**: This is a breaking change in two scenarios. Today's tmux
  `/ask` works in both; rev 5's `/ask` exits 2 and prompts Claude to answer
  directly.

  | Scenario                                                  | Today (tmux)         | Rev 5  |
  | --------------------------------------------------------- | -------------------- | ------ |
  | codex < 0.116, no gemini                                  | works (tmux codex)   | exit 2 |
  | codex < 0.116, gemini installed, `model=codex` (explicit) | works (tmux codex)   | exit 2 |
  | codex < 0.116, gemini installed, `model=auto`             | works (tmux codex)   | works (gemini-exec) |
  | codex ≥ 0.116, gemini installed                           | works (tmux either)  | works (exec adapter) |
  | no codex, no gemini                                       | already broken today | exit 2 (unchanged)  |

  The breaking change affects users who (a) only ever installed codex < 0.116,
  or (b) explicitly request `codex` while running a stale codex install. The
  explicit-request case is intentional — explicit user intent must not silently
  cross-fall back to a different model.

  - Mitigation 1: The project's worker adapter system already requires codex
    ≥0.116 for Atlas/Athena. The affected audience for the stale-codex case is
    users who only ever used `/ask` on a stale install.
  - Mitigation 2: SKILL.md documents the version requirement clearly:
    "`/ask <model>` requires that model installed at a supported version
    (codex ≥0.116, any gemini). Use `/ask auto` to let the helper pick
    whichever is available. Upgrade codex with
    `npm install -g @openai/codex@latest`."
  - Mitigation 3: Exit-2 message includes both the upgrade hint AND the
    `auto` fallback hint.
- **Rollback**: Revert `skills/ask/SKILL.md` and delete `scripts/ask.mjs`. No state
  files or persistent format changes. The old tmux SKILL.md still works as-is.

## 10. Resolved Questions (after Codex cross-review)

- [x] **`.ao/autonomy.json` respect** → **YES** for `gemini.approval` (passed
      through to `gemini-exec.spawn({ approvalMode })`) and the tmux paths.
      Codex review point: "yes for Gemini/tmux paths; otherwise behavior diverges
      unnecessarily." Codex-exec stays bypass-only since the adapter doesn't
      expose an approval flag (separate follow-up).
- [x] **Artifact metadata header** → **NO**. Codex review: keep artifacts
      body-only to preserve "no regression in artifact format." If adapter/duration
      tracking is wanted later, file as a separate plan and write to a sidecar
      `.meta.json` instead of mutating the artifact body.

## 11. Cross-review Trail

| Rev | Reviewer        | Verdict             | Issues addressed                        |
| --- | --------------- | ------------------- | --------------------------------------- |
| 1   | (initial draft) | —                   | —                                       |
| 1   | Codex 0.118.0   | REWORK              | 3 blockers + 2 design + 2 open Qs       |
| 2   | (revision)      | REWORK (closer)     | §4.1.1 routing, §4.1.3 honesty, §6 ACs rewritten, §8 cleanup risk added, §10 Qs resolved |
| 2   | Codex 0.118.0   | REWORK              | 1 medium AC wording, 1 medium exit-2 semantics, 1 low (tmux helper names + SKILL quoting) |
| 3   | (revision)      | REWORK              | AC-7 spy fix, AC-5b/5c added, §4.1.2#5 tmux helper names corrected, §4.2 heredoc, §4.1.4 exit-2 semantics |
| 3   | Codex 0.118.0   | REWORK              | 1 blocker (`hasTmux` insufficient — needs binary), 1 medium (`createTeamSession` creates worktrees) |
| 4   | (revision)      | REWORK (minor)      | tmux fallback dropped from `ask.mjs` (§4.1.1(b)); §4.1.2 simplified; AC-5b/5c collapsed into AC-5b; AC-6 changed to grep-test for tmux absence |
| 4   | Codex 0.118.0   | REWORK (minor only) | 2 medium: stale tmux refs in §3 Goals + §7 Test Plan, §9 migration scope too narrow |
| 5   | (revision)      | APPROVE-WITH-FIXES  | §3 Goals rewritten (no tmux), §7 Test Plan matrix updated (no tmux row), §9 Migration scenario table broadened |
| 5   | Codex 0.118.0   | APPROVE-WITH-FIXES  | 1 medium: §9 last row was factually wrong (tmux gemini wouldn't work without gemini binary either) |
| 6   | (final)         | APPROVED            | §9 table corrected — fictitious "tmux gemini" row removed; "two scenarios" wording restored |
