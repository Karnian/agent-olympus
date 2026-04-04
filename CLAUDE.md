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
              session-registry, codex-approval, gemini-exec, gemini-acp, gemini-approval)
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
- **SubagentStart** (`scripts/subagent-start.mjs`) — fires when a subagent is spawned; injects wisdom context via `additionalContext`
- **SubagentStop** (`scripts/subagent-stop.mjs`) — fires when a subagent completes; captures results to `.ao/state/ao-subagent-results.json` (async, non-blocking)
- **SessionEnd** (`scripts/session-end.mjs`) — fires on session termination; cleans up stale state files older than 24h (async, non-blocking)
- **Stop** (`scripts/stop-hook.mjs`) — fires at session end; auto-commits any uncommitted work as a WIP commit so nothing is lost

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
- `.ao/state/checkpoint-{atlas|athena}.json` — session recovery checkpoints (auto-expire 24h); emits events to active run on save/clear
- `.ao/state/ao-active-run-{atlas|athena}.json` — active run identity pointer (links checkpoint ↔ run-artifacts)
- `.ao/state/ao-subagent-results.json` — captured subagent outputs (capped at 50, FIFO); also emits `subagent_completed` events to active run
- `.ao/state/ao-current-session.json` — active session pointer (sessionId + startedAt); used for crash recovery
- `.ao/state/*.json` — transient state files (deleted on completion or cleaned by SessionEnd after 24h)
- `.ao/sessions/<sessionId>.json` — per-session metadata (branch, cwd, status, linked runIds); shared across worktrees; 90-day TTL
- `.ao/artifacts/runs/<runId>/` — per-run artifacts (events.jsonl, summary.json, verification.jsonl)
- `.ao/teams/` — tmux worker inbox/outbox directories (Athena only)
- `.ao/worktrees/<teamSlug>/<workerName>/` — isolated git worktrees for Athena parallel workers (Athena only; cleaned up after team completion)
- `docs/plans/` — git-tracked permanent plan storage (survives sessions, shared with team)
- `docs/plans/README.md` — auto-generated index of all plans
- `docs/plans/<slug>/CHANGELOG.md` — per-plan change history

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

**Codex** approval mode is automatically determined from Claude's permission level:
- `Bash(*) + Write(*)` in Claude settings → `--full-auto`
- `Write(*)` or `Edit(*)` only → `--auto-edit`
- Otherwise → no flag (suggest/read-only)

**Gemini** approval mode follows the same detection logic, mapped to Gemini modes:
- `Bash(*) + Write(*)` → `--approval-mode yolo`
- `Write(*)` or `Edit(*)` only → `--approval-mode auto_edit`
- Otherwise → no flag (Gemini default interactive mode)

Detection checks (in priority order): project `.claude/settings.local.json` → user `~/.claude/settings.local.json` → user `~/.claude/settings.json`

Override via `.ao/autonomy.json`:
```json
{
  "codex": { "approval": "full-auto" },
  "gemini": { "approval": "yolo" }
}
```
Codex values: `auto` (default), `suggest`, `auto-edit`, `full-auto`
Gemini values: `auto` (default), `default`, `auto_edit`, `yolo`, `plan`

### Key Files
- `scripts/lib/codex-appserver.mjs` — Codex app-server JSON-RPC client (thread/turn/steer/interrupt)
- `scripts/lib/codex-exec.mjs` — Codex exec JSONL adapter (spawn/monitor/collect/shutdown)
- `scripts/lib/claude-cli.mjs` — Claude CLI adapter (spawn/monitor/collect/shutdown via stream-json)
- `scripts/lib/gemini-acp.mjs` — Gemini ACP JSON-RPC client (session/prompt/cancel + message queue)
- `scripts/lib/gemini-exec.mjs` — Gemini exec JSON adapter (spawn/monitor/collect/shutdown)
- `scripts/lib/gemini-approval.mjs` — Claude permission detection → Gemini approval mode mirroring
- `scripts/lib/worker-spawn.mjs` — Adapter router (`selectAdapter`, `spawnTeam`, `monitorTeam`)
- `scripts/lib/resolve-binary.mjs` — Binary resolution with caching + `buildEnhancedPath()`
- `scripts/lib/preflight.mjs` — Capability detection (`hasCodexAppServer`, `hasCodexExecJson`, `hasClaudeCli`, `hasGeminiCli`, `hasGeminiAcp`)
- `scripts/lib/codex-approval.mjs` — Claude permission detection → Codex approval mode mirroring
- `scripts/lib/cost-estimate.mjs` — Token-based cost estimation (Claude + Gemini pricing)

### Session Naming
- tmux sessions: `atlas-codex-<N>`, `atlas-gemini-<N>`, `athena-<slug>-codex-<N>`, `athena-<slug>-gemini-<N>`
- Cross-validation: `atlas-codex-xval-<story-id>` or `athena-<slug>-codex-xval-<story-id>`

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
