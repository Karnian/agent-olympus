# CLAUDE.md — Agent Olympus

This file provides guidance for Claude Code when working in this repository.

## What This Project Is

Agent Olympus is a standalone Claude Code plugin that provides two self-driving AI orchestrators:
- **Atlas** — sub-agent based (hub-and-spoke): one brain delegates to many specialized agents
- **Athena** — team based (peer-to-peer): multiple agents collaborate via SendMessage + Codex via tmux

Both orchestrators autonomously loop until the task is fully complete (build passes, tests pass, reviews approved).

## Project Structure

```
agents/     → Agent persona definitions (.md files with model and role)
skills/     → User-facing skills (SKILL.md with triggers, steps, workflow)
scripts/    → Hook scripts (Node.js ESM, zero npm dependencies)
scripts/lib → Shared libraries (stdin, intent-patterns, tmux-session, inbox-outbox, checkpoint,
              wisdom, worker-status, worktree, fs-atomic, provider-detect, config-validator,
              autonomy, cost-estimate, changelog, pr-create, ci-watch, notify, model-router,
              worker-spawn, preflight, input-guard, stuck-recovery, run-artifacts)
scripts/test → node:test based unit tests (510+ tests, 34 files)
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
- **Available skills** (skills/): a11y-audit, ask, athena, atlas, brainstorm, cancel, consensus-plan, deep-dive, deep-interview, deepinit, design-critique, design-system-audit, external-context, finish-branch, git-master, harness-init, plan, research, slop-cleaner, systematic-debug, tdd, trace, ui-review, ux-copy-review, verify-coverage

### State Management
- `.ao/prd.json` — PRD with user stories and acceptance criteria (ephemeral working copy)
- `.ao/spec.md` — human-readable spec (ephemeral working copy)
- `.ao/wisdom.jsonl` — structured cross-iteration learnings in JSONL format (NEVER delete, survives /cancel)
- `.ao/progress.txt` — legacy format, auto-migrated to wisdom.jsonl on first run
- `.ao/state/checkpoint-{atlas|athena}.json` — session recovery checkpoints (auto-expire 24h)
- `.ao/state/ao-subagent-results.json` — captured subagent outputs (capped at 50, FIFO)
- `.ao/state/*.json` — transient state files (deleted on completion or cleaned by SessionEnd after 24h)
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

## Codex Integration

Codex is invoked via tmux, not via omc CLI:
```bash
tmux new-session -d -s "<session-name>" -c "<cwd>"
tmux send-keys -t "<session-name>" 'codex exec "<prompt>"' Enter
tmux capture-pane -pt "<session-name>" -S -200   # monitor output
tmux kill-session -t "<session-name>"             # cleanup
```

Session naming convention: `atlas-codex-<N>` or `athena-<slug>-codex-<N>`
Cross-validation sessions: `atlas-codex-xval-<story-id>` or `athena-<slug>-codex-xval-<story-id>`

## Known Limitations

- **`--bare` mode**: When Claude Code is run with the `--bare` flag, all hooks, plugins, and skill directory walks are skipped. Agent Olympus hooks will not fire in this mode. This flag is intended for scripted `-p` calls and requires `ANTHROPIC_API_KEY` or `apiKeyHelper`.
- **Sandbox mode**: Hook scripts should be tested with Claude Code's sandbox mode enabled (available on Linux and Mac). All scripts use Node.js built-ins only, so they should be compatible, but edge cases around file system access in `.ao/` may arise.

## Testing

```bash
# Run unit tests (510+ tests, 34 files)
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
- **Optional**: tmux (required for Codex integration and Athena team mode)
- **Optional**: codex CLI (`npm install -g @openai/codex`) for multi-model execution
- **npm packages**: None (zero runtime dependencies)
