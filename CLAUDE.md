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
scripts/lib → Shared libraries (stdin, intent, tmux, inbox-outbox, checkpoint, wisdom, worker-status)
config/     → Model routing configuration (JSONC)
hooks/      → Hook event registrations
```

## Key Conventions

### Naming
- **Agents**: Greek mythology names (atlas, athena, metis, prometheus, momus, hephaestus)
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
- Hooks must complete within their timeout (3s for most, 10s for Stop)
- Hooks never block Claude Code — they fail open on any error

### Skill vs Agent
- **Skill** (`skills/*/SKILL.md`) = workflow recipe with steps. User-facing, triggered by `/command` or keyword matching
- **Agent** (`agents/*.md`) = role persona with model assignment. Called internally via `Task(subagent_type="agent-olympus:<name>")`
- Not every agent has a matching skill. executor, debugger, designer etc. are internal-only

### State Management
- `.ao/prd.json` — PRD with user stories and acceptance criteria
- `.ao/wisdom.jsonl` — structured cross-iteration learnings in JSONL format (NEVER delete, survives /cancel)
- `.ao/progress.txt` — legacy format, auto-migrated to wisdom.jsonl on first run
- `.ao/state/checkpoint-{atlas|athena}.json` — session recovery checkpoints (auto-expire 24h)
- `.ao/state/*.json` — transient state files (deleted on completion)
- `.ao/teams/` — tmux worker inbox/outbox directories (Athena only)

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

## Testing

No test framework is configured yet. To verify:
```bash
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
