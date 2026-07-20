@AGENTS.md

## Claude Code specifics

- Claude Code reads this file first; `@AGENTS.md` imports the canonical shared instructions inline. Keep this file limited to Claude Code runtime deltas.
- `hooks/hooks.json` commands run from the installed plugin cache via `$CLAUDE_PLUGIN_ROOT`, normally through `"$CLAUDE_PLUGIN_ROOT"/scripts/run.sh ... || node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs ...`. `run.cjs` handles stale versioned plugin paths with fallback resolution.
- Hook runtime contract: Claude Code sends JSON on stdin and expects JSON on stdout. Hooks normally fail open (`catch` -> `{}` -> exit 0), avoid `console.log`, and respect Claude Code hook timeouts. Deliberate fail-closed exceptions: concurrency admission, and the Atlas executable-control gates (`orchestrator-skill-init` after the Atlas identity is proven, `orchestrator-stop-gate`); an unprovable identity (unreadable/non-Atlas payload) still fails open.
- Claude Code hook registrations:
  - `SessionStart`: `runtime-permissions-capture` (async), `session-start`
  - `UserPromptExpansion:atlas` + `agent-olympus:atlas`: `orchestrator-skill-init` (Atlas bootstrap; requires a Claude Code with `UserPromptExpansion`, verified on 2.1.214)
  - `UserPromptSubmit`: `runtime-permissions-capture` (async), `intent-gate`
  - `PreToolUse:Skill`: `orchestrator-skill-init` (Atlas bootstrap for delegated Skill calls; `{}` for every other skill)
  - `PreToolUse:Task`: `concurrency-gate`, `model-router`
  - `PreToolUse:Agent`: `concurrency-gate`, `model-router`
  - `PostToolUse:Task`: `concurrency-release`
  - `PostToolUse:Agent`: `concurrency-release`
  - `PostToolUse:ExitPlanMode`: `plan-execute-gate`
  - `SubagentStart`: `subagent-start`
  - `SubagentStop`: `subagent-stop` (async), `concurrency-release` (async safety net)
  - `Notification:idle_prompt`: `notification` (async)
  - `Notification:permission_prompt`: `notification` (async)
  - `SessionEnd`: `session-end` (async)
  - `Stop`: `stop-hook`; plus `orchestrator-stop-gate` registered skill-scoped via `skills/atlas/SKILL.md` frontmatter `hooks:` while `/atlas` is active
- Skill vs agent invocation in Claude Code:
  - Skills (`skills/*/SKILL.md`) are user-facing workflows invoked by slash command, trigger keyword, or `Skill(skill="agent-olympus:<name>")`.
  - Agents (`agents/*.md`) are internal personas invoked with `Task(subagent_type="agent-olympus:<name>", model="<tier>", prompt="...")`.
  - Not every agent has a matching skill; executor, debugger, designer, and reviewers are usually internal-only.
- Skills that shell out to bundled scripts should use `$CLAUDE_PLUGIN_ROOT`, for example `node "$CLAUDE_PLUGIN_ROOT"/scripts/ask.mjs ...`, so installed plugin cache paths resolve correctly.
