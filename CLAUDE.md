# CLAUDE.md — Agent Olympus

This file provides guidance for Claude Code when working in this repository.

## What This Project Is

Agent Olympus is a standalone Claude Code plugin that provides two self-driving AI orchestrators:
- **Atlas** — sub-agent based (hub-and-spoke): one brain delegates to many specialized agents
- **Athena** — team based (peer-to-peer): multiple agents collaborate via SendMessage + Codex/Gemini workers

Both orchestrators autonomously loop until the task is fully complete (build passes, tests pass, reviews approved).

## Project Structure

```
agents/     → Agent persona definitions (.md files with model and role)
skills/     → User-facing skills (SKILL.md with triggers, steps, workflow)
scripts/    → Hook scripts (Node.js ESM, zero npm dependencies)
scripts/lib → Shared libraries (stdin, intent-patterns, tmux-session, inbox-outbox, checkpoint,
              wisdom, worker-status, worktree, fs-atomic, provider-detect, config-validator,
              autonomy, cost-estimate, changelog, pr-create, ci-watch, notify, model-router,
              worker-spawn, preflight, input-guard, stuck-recovery, run-artifacts,
              session-registry, permission-detect, codex-approval, gemini-exec, gemini-acp,
              gemini-approval)
scripts/test → node:test based unit tests (1000+ tests, 50 files)
config/     → Model routing configuration (JSONC)
hooks/      → Hook event registrations
docs/plans/ → Finalized specifications (git-tracked, permanent)
```

## Key Conventions

### Naming
- **Agents**: Greek mythology names (atlas, athena, metis, prometheus, momus, hermes, hephaestus, themis, aphrodite); also role-based agents (test-engineer, code-reviewer, etc.)
- **Namespace**: `agent-olympus:` prefix for all subagent_type references
- **State files**: `.ao/state/` directory with `ao-` prefix per hook

### Code Style (scripts/)
- All scripts are ESM (.mjs), except `run.cjs` (CJS for cross-platform compatibility)
- Zero npm dependencies — Node.js built-ins only
- Every hook must be **fail-safe**: `catch → process.stdout.write('{}') → process.exit(0)`
- Output via `process.stdout.write(JSON.stringify(...))`, not `console.log`
- File permissions: `mode: 0o600` for state files, `mode: 0o700` for state directories

### Hook Architecture
- `run.cjs` is the universal entry point — it resolves the correct script path with version fallback
- All hooks receive JSON on stdin and output JSON on stdout
- Hooks must complete within their timeout (3s for most, 5s for SessionStart/SessionEnd, 10s for Stop)
- Hooks never block Claude Code — they fail open on any error
- Hooks can set `"async": true` to run in the background without blocking Claude's execution
- **SessionStart** (`scripts/session-start.mjs`) — fires at session start; injects prior wisdom and any interrupted checkpoint context into the conversation
- **SubagentStart** (`scripts/subagent-start.mjs`) — fires when a subagent is spawned; injects token efficiency directive (non-haiku agents only) + wisdom context via `additionalContext`, filtered by `subagent_type` relevance
- **Notification** (`scripts/notification.mjs`) — fires on `idle_prompt` and `permission_prompt` events; logs to `.ao/state/ao-notifications.json` for stall detection (async, non-blocking)
- **SubagentStop** (`scripts/subagent-stop.mjs`) — fires when a subagent completes; captures results to `.ao/state/ao-subagent-results.json` (async, non-blocking); also triggers concurrency-release as safety net
- **ConcurrencyGate** (`scripts/concurrency-gate.mjs`) — fires on PreToolUse Task/Agent; enforces parallel limits (global 5, claude 3, codex 2, gemini 2) with 3-min stale pruning. Limits configurable via `config/model-routing.jsonc` or `AO_CONCURRENCY_*` env vars
- **ConcurrencyRelease** (`scripts/concurrency-release.mjs`) — fires on PostToolUse Task/Agent + SubagentStop; 3-stage release: task_id match → provider match → SubagentStop safety net (force-release oldest). Stale threshold 3 min
- **PlanExecuteGate** (`scripts/plan-execute-gate.mjs`) — fires on PostToolUse ExitPlanMode; reads `planExecution` from autonomy.json and injects execution routing (solo/ask/atlas/athena); `ask` mode instructs Claude to use `AskUserQuestion` interactive UI with text fallback; writes marker `.ao/state/ao-plan-pending.json` for SessionStart fallback (marker preserved as `handled: true`, cleaned by SessionEnd after 24h)
- **SessionEnd** (`scripts/session-end.mjs`) — fires on session termination; cleans up stale state files older than 24h (async, non-blocking)
- **Stop** (`scripts/stop-hook.mjs`) — fires at session end; auto-commits any uncommitted work as a WIP commit so nothing is lost; uses selective staging (excludes `.env`, secrets, `.ao/state/`, `.ao/teams/`)

### Skill vs Agent
- **Skill** (`skills/*/SKILL.md`) = workflow recipe with steps. User-facing, triggered by `/command` or keyword matching
- **Agent** (`agents/*.md`) = role persona with model assignment. Called internally via `Task(subagent_type="agent-olympus:<name>")`
- Not every agent has a matching skill. executor, debugger, designer etc. are internal-only
- **Available agents** (agents/): aphrodite, atlas, athena, architect, code-reviewer, debugger, designer, executor, explore, hephaestus, hermes, metis, momus, prometheus, security-reviewer, test-engineer, themis, writer
- **Available skills** (skills/): a11y-audit, ask, athena, atlas, brainstorm, cancel, consensus-plan, deep-dive, deep-interview, deepinit, design-critique, design-system-audit, external-context, finish-branch, git-master, harness-init, plan, research, sessions, slop-cleaner, systematic-debug, tdd, trace, ui-review, ux-copy-review, verify-coverage

### State Management
- `.ao/prd.json` — PRD with user stories and acceptance criteria (ephemeral working copy)
- `.ao/spec.md` — human-readable spec (ephemeral working copy)
- `.ao/wisdom.jsonl` — structured cross-iteration learnings in JSONL format (NEVER delete, survives /cancel)
- `.ao/progress.txt` — legacy format, auto-migrated to wisdom.jsonl on first run
- `.ao/memory/` — **[v1.0.2+] durable long-lived memory namespace; EXEMPT from SessionEnd 24h cleanup; shared across all worktrees via git-common-dir resolution**
  - `.ao/memory/design-identity.json` — brand colors, typography tokens, spacing scale, component library (schemaVersion: 1); populated by `/teach-design`
  - `.ao/memory/taste.jsonl` — aesthetic preference accumulation (schemaVersion: 1 per line); populated by `/taste`; capped at 200 entries (FIFO)
  - Loader rule: any file with `schemaVersion > 1` is refused and the loader returns the empty default (fail-safe forward-compat)
  - Opt-out: `autonomy.json { memory: { disabled: true } }` causes all memory loaders to return empty defaults without touching disk
- `.ao/state/checkpoint-{atlas|athena}.json` — session recovery checkpoints (auto-expire 24h); emits events to active run on save/clear
- `.ao/state/ao-active-run-{atlas|athena}.json` — active run identity pointer (links checkpoint ↔ run-artifacts)
- `.ao/state/ao-subagent-results.json` — captured subagent outputs (capped at 50, FIFO); also emits `subagent_completed` events to active run
- `.ao/state/ao-current-session.json` — active session pointer (sessionId + startedAt); used for crash recovery
- `.ao/state/ao-capabilities.json` — cached capability detection results (60-min TTL, file-based since hooks run as separate processes). To force refresh after installing codex/gemini mid-session, delete this file manually
- `.ao/state/ao-notifications.json` — logged idle/permission prompt notifications for stall detection (capped at 50 entries, FIFO)
- `.ao/state/ao-plan-pending.json` — marker for plan execution routing fallback (created by PlanExecuteGate, consumed by SessionStart)
- `.ao/state/browser-handoff.json` — [v1.0.2+] browser pause state (sessionId + sanitized URL + sanitized breadcrumb); 24h TTL; created by US-006 browser-handoff.mjs; read by `/resume-handoff`
- `.ao/state/*.json` — transient state files (deleted on completion or cleaned by SessionEnd after 24h)
- `.ao/sessions/<sessionId>.json` — per-session metadata (branch, cwd, status, linked runIds); shared across worktrees; 90-day TTL
- `.ao/artifacts/runs/<runId>/` — per-run artifacts (events.jsonl, summary.json, verification.jsonl)
  - `.ao/artifacts/runs/<runId>/ui-remediation.json` — [v1.0.2+] sequential remediation chain results (schemaVersion: 1); written by `/ui-remediate`
- `.ao/artifacts/pipe/` — **[v1.0.2+] cascade artifact ARCHIVAL pipe (NOT prompt-history isolation); swept by SessionEnd after 24h**
  - `.ao/artifacts/pipe/<runId>/<stage>/outbox/` — stage output archives written by orchestrators
  - `.ao/artifacts/pipe/<runId>/<stage>/inbox/` — prior-stage handoff manifests for current stage
  - Canonical stage names: `plan`, `decompose`, `execute`, `verify`, `review`, `finish` (schema-validated; free-form names rejected)
  - Per-file cap: 100KB (tail-truncation warning on exceed); per-run cap: 10MB (drops + warning on exceed)
  - ARCHIVAL ONLY: continuous-session orchestrators cannot deliver strict prompt-history isolation; isolation requires fresh-process stage runners (out of scope v1.0.2, per spec.md N12)
- `.ao/teams/` — tmux worker inbox/outbox directories (Athena only)
- `.ao/worktrees/<teamSlug>/<workerName>/` — isolated git worktrees for Athena parallel workers (Athena only; cleaned up after team completion)
- `docs/plans/` — git-tracked permanent plan storage (survives sessions, shared with team)
- `docs/plans/README.md` — auto-generated index of all plans
- `docs/plans/<slug>/CHANGELOG.md` — per-plan change history

### schemaVersion Convention (v1.0.2+)

Every new persisted file format introduced in v1.0.2 carries `schemaVersion: 1`:
- **JSON files**: top-level field (`{ "schemaVersion": 1, ... }`)
- **JSONL files**: per-line field (`{"schemaVersion":1,"id":"..."}`)
- **Loader rule**: if `schemaVersion > 1` (unknown future format), the loader MUST return the empty default (`{}` or `[]`) and emit a clear error to stderr (suppressOutput). Never throw or block.
- **Writer rule**: callers are responsible for including `schemaVersion: 1` in data passed to memory.mjs writers and artifact writers.
- **Migration policy**: when schemaVersion increments in a future release, the new loader MUST include a migration path or a clear upgrade message.

## How to Add a New Agent

1. Create `agents/<name>.md` with frontmatter:
   ```yaml
   ---
   model: sonnet  # haiku | sonnet | opus
   description: One-line description
   ---
   ```
2. Write the persona prompt below the frontmatter
3. Reference it in skills as `agent-olympus:<name>`

## How to Add a New Skill

1. Create `skills/<name>/SKILL.md` with frontmatter:
   ```yaml
   ---
   name: <name>
   description: One-line description
   level: 1-5
   aliases: [trigger, words, 한국어도가능]
   ---
   ```
2. Write the workflow steps
3. Reference agents via `Task(subagent_type="agent-olympus:<agent>", model="<tier>", prompt="...")`

## How to Add a New Hook

1. Create `scripts/<hook-name>.mjs` following the fail-safe pattern:
   ```javascript
   import { readStdin } from './lib/stdin.mjs';
   async function main() {
     try {
       const raw = await readStdin(3000);
       const data = JSON.parse(raw);
       // ... hook logic ...
       process.stdout.write(JSON.stringify({ /* output */ }));
     } catch {
       process.stdout.write('{}');
     }
     process.exit(0);
   }
   main();
   ```
2. Register in `hooks/hooks.json` under the appropriate event
3. Use `run.cjs` as the command wrapper for version-safe resolution

## Worker Adapter System

Workers (Codex, Claude, and Gemini) are spawned via a strategy-pattern adapter system (`selectAdapter()`):

### Adapter Priority (highest → lowest)

**Codex workers** (`type: 'codex'`):
1. **codex-appserver** — Multi-turn JSON-RPC 2.0 over stdio (`codex app-server`)
   - Thread/turn lifecycle, live steering via `steerTurn()`, structured errors
   - Requires `hasCodexAppServer` capability (codex ≥ 0.116.0 + app-server subcommand)
2. **codex-exec** — Single-turn JSONL via `child_process.spawn` (`codex exec --json`)
   - 5 event types, error classification, SIGTERM→SIGKILL shutdown
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

**All workers**:
6. **tmux** — Legacy fallback, works for all worker types
   - `tmux new-session` + `tmux send-keys` + `tmux capture-pane`
   - Always available when tmux is installed

### Permission Mirroring

All worker types (Codex, Claude, Gemini) mirror the host session's permission level via `scripts/lib/permission-detect.mjs`. This shared module eliminates duplication between adapter-specific approval modules.

**Detection** reads allow/deny lists from (in priority order): project `.claude/settings.local.json` → user `~/.claude/settings.local.json` → user `~/.claude/settings.json`. Deny lists are merged from ALL files (any deny overrides any allow).

**Codex** mirrors permissions to the **sandbox axis** (not the approval axis). Both `codex-exec` and `codex-appserver` workers run non-interactively — there is no TTY to prompt for approvals — so we hold the approval policy at `never` and vary the Codex sandbox tier instead. (Codex 0.118+ docs: *"Prefer `on-request` for interactive runs or `never` for non-interactive runs"*; the `--auto-edit` flag was removed in 0.118.)

| Host Claude allow list      | `-a` (approval) | `-s` (sandbox)         |
|-----------------------------|-----------------|------------------------|
| `Bash(*) + Write(*)`        | `never`         | `danger-full-access`   |
| `Write(*)` or `Edit(*)`     | `never`         | `workspace-write`      |
| Otherwise (suggest)         | _demoted_       | _demoted_              |

Suggest-tier hosts cannot run codex usefully — a `read-only` sandbox would let codex silently complete with "I can only suggest changes" and confuse Atlas/Athena into marking the task done. So:
- **Atlas/Athena teams** (`worker-spawn.mjs`): codex workers are demoted to `claude` workers BEFORE adapter selection (`demoteCodexWorkersIfNeeded`). The `_demotedFrom`/`_demotionReason`/`_demotedModel` fields are preserved on the worker for observability. Provider-specific fields like `model` are stripped so the Claude path doesn't receive a Codex model name.
- **`/ask` skill** (`ask.mjs`): codex requests exit with code 2 (model not available, answer as Claude) — no team context to demote into.

The `-a` and `-s` flags are GLOBAL Codex CLI flags and MUST appear BEFORE the `exec` subcommand. `codex exec -a never` errors with `unexpected argument '-a'` in 0.118+.

**Host sandbox intersection** (`scripts/lib/host-sandbox-detect.mjs`). The codex permission level derived from `permissions.allow` is now INTERSECTED with a passive host-sandbox detection (the more restrictive of the two wins). Signal priority:

1. **Explicit override** (ground truth) — `AO_HOST_SANDBOX_LEVEL` env var OR `.ao/autonomy.json { codex: { hostSandbox: ... } }` ∈ `{unrestricted, workspace-write, read-only}`. Env wins when both are set.
2. **Linux LSM enforcing** — AppArmor (`/proc/self/attr/current` `(enforce)`), SELinux (`/sys/fs/selinux/enforce == 1` + non-`unconfined_t` context), or Landlock (`/proc/self/status` Landlock field). Any of these → tier `workspace-write`.
3. **Otherwise** — tier `unknown` (NO silent downgrade; ambiguous signals like containers, seccomp, or macOS `OPERON_SANDBOXED_NETWORK` are recorded as SIGNALS but don't force a tier change).

When tier is `unknown` but filesystem-scoped signals exist (containerized, seccomp filter, NoNewPrivs), Atlas/Athena records a one-time `architecture` wisdom warning asking the user to set `AO_HOST_SANDBOX_LEVEL` explicitly. Network-only signals (OPERON_SANDBOXED_NETWORK) do NOT trigger the warning because the override controls filesystem tier, not network.

Diagnostic CLI: `node scripts/diagnose-sandbox.mjs` prints the full detection record (tier, source, all signals, effective codex level) as JSON. Use it to figure out whether you need to set an explicit override.

**Known limitation.** Host sandbox detection is passive only — no active probing of writable roots or network reachability. A host that appears unrestricted on paper but is actually inside a chroot or `sandbox-exec` policy without exposing LSM-equivalent signals will still show tier `unknown`. Set `AO_HOST_SANDBOX_LEVEL` explicitly in those environments.

**Claude** workers now auto-detect permission level (no longer default to `--dangerously-skip-permissions`):
- `Bash(*) + Write(*)` → `--permission-mode bypassPermissions`
- `Write(*)` or `Edit(*)` → `--permission-mode acceptEdits`
- Otherwise → `--permission-mode default`

**Gemini** approval mode follows the same detection logic, mapped to Gemini modes:
- `Bash(*) + Write(*)` → `--approval-mode yolo`
- `Write(*)` or `Edit(*)` only → `--approval-mode auto_edit`
- Otherwise → no flag (Gemini default interactive mode)

Override via `.ao/autonomy.json`:
```json
{
  "codex": { "approval": "full-auto", "hostSandbox": "auto" },
  "gemini": { "approval": "yolo" },
  "nativeTeams": true,
  "planExecution": "ask"
}
```
Codex values: `auto` (default), `suggest`, `auto-edit`, `full-auto`
Codex host sandbox: `auto` (default — detect), `unrestricted`, `workspace-write`, `read-only`. Env var `AO_HOST_SANDBOX_LEVEL` (same enum, minus `auto`) takes precedence.
Gemini values: `auto` (default), `default`, `auto_edit`, `yolo`, `plan`
`nativeTeams`: `true` enables Native Agent Teams without env var (fallback when `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is not set in hook environment)
`planExecution`: `ask` (default) presents Solo/Atlas/Athena choice via `AskUserQuestion` interactive UI after plan approval (text fallback for non-Desktop environments); `solo` skips orchestration; `atlas`/`athena` auto-routes. Simple plans (S-scale or ≤2 stories) auto-skip to solo.

### Key Files
- `scripts/lib/codex-appserver.mjs` — Codex app-server JSON-RPC client (thread/turn/steer/interrupt)
- `scripts/lib/codex-exec.mjs` — Codex exec JSONL adapter (spawn/monitor/collect/shutdown)
- `scripts/lib/claude-cli.mjs` — Claude CLI adapter (spawn/monitor/collect/shutdown via stream-json)
- `scripts/lib/gemini-acp.mjs` — Gemini ACP JSON-RPC client (session/prompt/cancel + message queue)
- `scripts/lib/gemini-exec.mjs` — Gemini exec JSON adapter (spawn/monitor/collect/shutdown)
- `scripts/lib/permission-detect.mjs` — Unified permission detection (shared by all worker adapters)
- `scripts/lib/gemini-approval.mjs` — Gemini approval mode mapping (delegates to permission-detect)
- `scripts/lib/worker-spawn.mjs` — Adapter router (`selectAdapter`, `spawnTeam`, `monitorTeam`)
- `scripts/lib/resolve-binary.mjs` — Binary resolution with caching + `buildEnhancedPath()`
- `scripts/lib/preflight.mjs` — `runStateCleanup()` (lightweight, SessionStart) + `runPreflight()` (full, orchestrators) + `detectCapabilities()` (parallel, cached 60min)
- `scripts/lib/codex-approval.mjs` — Claude permission level → Codex sandbox tier mirroring + host-sandbox intersection (`buildCodexExecArgs`, `buildCodexAppServerParams`, `shouldDemoteCodexWorker`, `effectiveCodexLevel`, `buildHostSandboxWarning`)
- `scripts/lib/host-sandbox-detect.mjs` — Passive host sandbox detection (LSM enforce, container, seccomp, macOS signals, WSL)
- `scripts/diagnose-sandbox.mjs` — Diagnostic CLI that prints the full host-sandbox record + effective codex level as JSON
- `scripts/lib/cost-estimate.mjs` — Token-based cost estimation (Claude + Gemini pricing)

### Session Naming
- tmux sessions: `atlas-codex-<N>`, `atlas-gemini-<N>`, `athena-<slug>-codex-<N>`, `athena-<slug>-gemini-<N>`
- Cross-validation: `atlas-codex-xval-<story-id>`, `atlas-gemini-xval-<story-id>`, `athena-<slug>-codex-xval-<story-id>`, `athena-<slug>-gemini-xval-<story-id>`

### Multi-Model Auto-Routing
Atlas/Athena automatically detect available capabilities via `runPreflight()` and pass them to Metis:
- Metis receives `Available capabilities: Codex: AVAILABLE/NOT AVAILABLE, Gemini: ...`
- Team design and `MULTI_MODEL` classification are capability-aware — no phantom worker assignment
- Cross-validation priority: Codex → Gemini fallback → skip with explicit record
- Trivial tasks automatically use Claude-only (no external model overhead)

### Gemini Team Communication
Unlike Codex app-server (which supports `steerTurn()` for mid-turn injection), Gemini ACP only accepts new prompts between turns. Team communication uses a message queue pattern:
- `enqueueMessage(handle, message, { from, priority })` — queues messages during active turns
- Messages auto-drain as sequential turns when current turn completes
- Failed messages retry once, then move to dead letters (`handle._deadLetters`)
- Queue capped at `MAX_QUEUE_DEPTH=200` to prevent memory leaks

## Known Limitations

- **`--bare` mode**: When Claude Code is run with the `--bare` flag, all hooks, plugins, and skill directory walks are skipped. Agent Olympus hooks will not fire in this mode. This flag is intended for scripted `-p` calls and requires `ANTHROPIC_API_KEY` or `apiKeyHelper`.
- **Sandbox mode**: Hook scripts should be tested with Claude Code's sandbox mode enabled (available on Linux and Mac). All scripts use Node.js built-ins only, so they should be compatible, but edge cases around file system access in `.ao/` may arise.

## Testing

```bash
# Run unit tests (1000+ tests, 50 files)
node --test 'scripts/test/**/*.test.mjs'

# Or via npm script
npm test

# Syntax check all scripts
for f in scripts/*.mjs scripts/lib/*.mjs; do node --check "$f" && echo "OK: $f"; done

# Check for stale namespace references
grep -r "oh-my-claude:" agents/ skills/ scripts/ config/   # should return nothing
grep -r "oh-my-claudecode:" skills/ agents/                 # should return nothing
grep -r '\.omc/' scripts/ skills/ agents/                   # should return nothing
```

## Dependencies

- **Runtime**: Node.js ≥ 20.0.0 (for ESM support)
- **Optional**: tmux (required for legacy worker fallback and Athena team mode)
- **Optional**: codex CLI (`npm install -g @openai/codex`) for Codex worker execution
- **Optional**: gemini CLI (`npm install -g @google/gemini-cli`) for Gemini worker execution
- **npm packages**: None (zero runtime dependencies)
