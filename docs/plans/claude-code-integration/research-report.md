# Claude Code Platform Integration — Research Report

**Date**: 2026-04-04
**Team**: Hermes (source), Apollo (external), Prometheus (gap analysis), Momus (validation)
**Platform**: Claude Code v2.1.91 | Agent Olympus v0.9.8

---

## Executive Summary

Agent Olympus uses **8 of 25** available Claude Code hook events and misses significant platform capabilities introduced in v2.1.49–v2.1.91. The single P0 issue is that `claude-cli.mjs` hardcodes `--dangerously-skip-permissions`, bypassing permission mirroring that Codex and Gemini workers already have. Beyond bug fixes, the highest-value opportunities are: (1) adopting new hook events for autonomous stall detection, (2) exposing AO as an MCP server, (3) leveraging native subagent frontmatter fields, and (4) shipping CLI tools via the `bin/` directory.

Athena's cross-model orchestration (Claude + Codex + Gemini) remains a unique differentiator that native agent teams cannot replicate.

---

## 1. Prioritized Recommendations

### P0 — Security Fix (Do Now)

| # | Issue | Module | Fix | Effort |
|---|-------|--------|-----|--------|
| 1 | ~~Claude CLI workers hardcode `--dangerously-skip-permissions`~~ | `worker-spawn.mjs:392` | ~~Pass `permissionMode: detectClaudePermissionLevel({ cwd })` at spawn call site.~~ | S |

**✅ Fixed in v0.9.8**: `permission-detect.mjs` 통합 모듈로 해결. Claude CLI workers가 호스트 세션의 permission level을 자동 감지하여 미러링.

---

### P1 — High-Value Improvements (Next Sprint)

| # | Recommendation | Modules | Description | Effort | Breaking? |
|---|---------------|---------|-------------|--------|-----------|
| 2 | **Notification hook for stall detection** | `hooks.json`, new `notification.mjs` | Register `Notification` hook with `idle_prompt` + `permission_prompt` matchers. Detect when Atlas/Athena orchestrator stalls waiting for user input. Auto-answer via `updatedInput` in PreToolUse. | M | No |
| 3 | **Unify permission detection** | `codex-approval.mjs`, `gemini-approval.mjs`, new `permission-detect.mjs` | Extract shared `detectPermissions()`. Add `deny` list handling. Keep first-match semantics for now (merge is a breaking change — see Momus caveat). | S | No |
| 4 | **Cache capabilities to file** | `preflight.mjs`, `.ao/state/ao-capabilities.json` | Cache `detectCapabilities()` result with 5-min TTL in `.ao/state/` (not in-process — hooks are separate processes). Saves ~2-3s per preflight. | M | No |
| 5 | **Resolve project root consistently** | `wisdom.mjs`, `checkpoint.mjs`, `session-registry.mjs` | Use `resolveProjectRoot()` everywhere instead of `process.cwd()`. Fixes wisdom isolation when running inside worktrees. | S | No |
| 6 | **Register orphan cleanup handlers** | `worker-spawn.mjs` | Add `process.on('SIGTERM')` + `process.on('SIGINT')` to kill detached children. Note: `process.on('exit')` alone won't catch SIGKILL. | S | No |
| 7 | **Parse tool_use blocks in stream-json** | `claude-cli.mjs` | Extract `tool_use` content blocks from assistant messages. Enables real-time worker progress tracking (which tools the worker is calling). | M | No |
| 8 | **Filter wisdom by subagent_type** | `subagent-start.mjs` | Read `subagent_type` from stdin to filter wisdom entries by relevance. A test-engineer gets test wisdom, designer gets design wisdom. | S | No |

---

### P2 — Platform Alignment (Next Release)

| # | Recommendation | Description | Effort | Breaking? |
|---|---------------|-------------|--------|-----------|
| 9 | **Adopt `--json-schema` for structured worker output** | Define JSON schemas for worker result types. Use `--json-schema` flag in claude-cli adapter to get validated, typed output. Eliminates manual JSON parsing. | M | No |
| 10 | **Add `--max-budget-usd` and `--max-turns` to workers** | Pass cost/turn limits to Claude CLI workers. Cost control for autonomous runs. | S | No |
| 11 | **Add `--effort` to model router** | Map task complexity to effort levels (low/medium/high). Simple lint tasks use low effort, architecture tasks use high. | S | No |
| 12 | **Add `--fallback-model` for resilience** | Configure fallback model (e.g., sonnet when opus overloaded) in claude-cli adapter. | S | No |
| 13 | **Ship `bin/` CLI tools** | Create `bin/ao-status`, `bin/ao-cancel`, `bin/ao-wisdom` as standalone CLI tools. Added to PATH automatically when plugin enabled (v2.1.91). | M | No |
| 14 | **Hook PreToolUse(Bash/Write/Edit)** | Enforce worker scope constraints — prevent workers from editing files outside their assigned worktree. | M | No |
| 15 | **Hook TaskCreated/TaskCompleted** | Quality gates when using native agent teams. Block task creation/completion with feedback. | S | No |
| 16 | **Adopt `defer` permission decision** | PreToolUse hooks can return `permissionDecision: "defer"` for human-in-the-loop approval of dangerous operations (force push, production deploys). | M | No |
| 17 | **Use `CLAUDE_ENV_FILE` in SessionStart** | Persist AO-specific environment variables for all subsequent Bash commands in the session. | S | No |
| 18 | **Adopt subagent frontmatter fields** | Add `effort`, `maxTurns`, `skills` to AO agent .md files. Claude Code respects these natively. | S | No |
| 19 | **Permission merge semantics** | Change from first-match-wins to merge (project overrides user). **Breaking change** for users with layered settings. | M | **Yes** |
| 20 | **Add `--name` and `--session-id` to workers** | Better session identification and deterministic tracking for AO workers. | S | No |
| 21 | **`userConfig` for plugin settings** | Define user-configurable settings (codex_approval, gemini_approval, default_model) prompted at plugin install. | S | No |
| 22 | **stop-hook.mjs: replace `git add -A`** | Use explicit file staging to avoid committing sensitive files (.env, secrets). Add `.ao/` to .gitignore check. | S | No |

---

### P3 — Strategic / Long-term

| # | Recommendation | Description | Effort | Notes |
|---|---------------|-------------|--------|-------|
| 23 | **MCP server for AO orchestration** | Expose `ao_spawn_team`, `ao_monitor_team`, `ao_query_wisdom` etc. as MCP tools via stdio JSON-RPC 2.0. Zero npm deps needed. | L | **Momus caveat**: `$CLAUDE_PLUGIN_ROOT` variable substitution in `.mcp.json` args is unverified. Must test before implementing. |
| 24 | **Multi-turn Claude CLI workers** | Use `--resume` for iterative work instead of single-turn `claude -p`. | L | Significant adapter redesign |
| 25 | **Channels integration** | Push Atlas/Athena progress to Telegram/Discord via Channels API. | L | Research preview only, allowlisted. Watch for GA. |
| 26 | **Native agent teams hybrid** | Use native teams for Claude workers + custom adapters for Codex/Gemini. Best of both worlds. | L | Depends on native teams graduating from experimental. |
| 27 | **Verify `level`/`aliases` frontmatter** | Custom skill frontmatter fields may not be in official spec. Test whether Claude Code respects or ignores them. | S | **Unresolved risk** flagged by Momus. |
| 28 | **Hook PostToolUse(Bash) for auto-wisdom** | Capture build/test results automatically and feed into wisdom system. | M | |
| 29 | **Session JSONL integration** | Link AO session IDs to Claude Code's `~/.claude/projects/` transcript paths for debugging/replay. | M | Relies on undocumented internal format. |
| 30 | **`--no-session-persistence` for ephemeral workers** | Prevent worker sessions from cluttering session history. | S | |

---

## 2. Key Platform Gaps Identified

### 2.1 Hook Events: 8 used / 25 available

| Used (8) | High-Value Unused (7) | Lower-Value Unused (10) |
|----------|----------------------|------------------------|
| SessionStart | **Notification** (stall detection) | PreCompact |
| UserPromptSubmit | **PreToolUse** (Bash/Write scope) | PostCompact |
| PreToolUse (Task/Agent) | **TaskCreated** (quality gate) | CwdChanged |
| PostToolUse (Task/Agent) | **TaskCompleted** (quality gate) | WorktreeCreate |
| SubagentStart | **PermissionDenied** (retry logic) | WorktreeRemove |
| SubagentStop | **FileChanged** (config watch) | InstructionsLoaded |
| SessionEnd | **TeammateIdle** (team monitoring) | ConfigChange |
| Stop | | Elicitation / ElicitationResult |
| | | PostToolUseFailure / StopFailure |

### 2.2 CLI Flags Not Leveraged

| Flag | Value | Category |
|------|-------|----------|
| `--json-schema` | Typed worker output, no manual parsing | Output |
| `--max-budget-usd` | Cost control per worker | Safety |
| `--max-turns` | Turn limit per worker | Safety |
| `--effort` | Cost optimization per task | Cost |
| `--fallback-model` | Auto-fallback on overload | Resilience |
| `--name` / `--session-id` | Worker identification | Observability |
| `--resume` | Session continuity after crash | Reliability |
| `--tools` | Restrict worker capabilities | Security |
| `--no-session-persistence` | Ephemeral workers | Cleanup |

### 2.3 Plugin Features Not Used

| Feature | Value |
|---------|-------|
| `bin/` directory | CLI tools on PATH (ao-status, ao-cancel) |
| `userConfig` | User-configurable settings at install |
| `.mcp.json` | MCP server bundling |
| `CLAUDE_PLUGIN_DATA` | Persistent data surviving updates |
| `CLAUDE_ENV_FILE` | Persistent env vars for Bash commands |
| `defer` permission | Human-in-the-loop approval gates |
| Hook `if` conditional | Narrow hooks to specific tool patterns |

---

## 3. Momus Validation Summary

| Area | Verdict | Key Correction |
|------|---------|----------------|
| Hook event count | **Apollo corrected** | AO uses 8 events (not 5 as Apollo claimed) |
| P0 priority justified | **PASS** | `--dangerously-skip-permissions` confirmed at source |
| MCP feasibility | **PASS with caveat** | Zero-dep feasible, but `$CLAUDE_PLUGIN_ROOT` in `.mcp.json` unverified |
| Capability caching | **Corrected** | Must be file-based, not in-process (hooks are separate processes) |
| Permission merge semantics | **Downgraded P1 → P2** | Breaking behavioral change for layered settings users |
| Backward compatibility | **FAIL (undercovered)** | Reports don't assess compat impact for most proposals |
| Missing module analysis | **CONCERN** | `input-guard.mjs` and `stuck-recovery.mjs` not analyzed |
| Frontmatter `level`/`aliases` | **Unresolved risk** | No report confirms whether Claude Code respects these |

---

## 4. Competitive Landscape

Athena's unique differentiators vs. native agent teams and community alternatives:

| Capability | Agent Olympus | Native Teams | Community Tools |
|-----------|--------------|-------------|----------------|
| Cross-model (Claude+Codex+Gemini) | **Yes** | No | No |
| Adapter fallback chain | **Yes** (6 adapters) | No | No |
| Session checkpoints + crash recovery | **Yes** | Limited | Partial (claude-session-restore) |
| Cross-session wisdom/learning | **Yes** | No | No (Ruflo has vector memory) |
| Permission mirroring | **Yes** (Codex+Gemini) | Built-in | No |
| Autonomous loop until complete | **Yes** | No | Partial (Ralph variants) |
| Plugin marketplace distribution | Not yet | N/A | Partial |

**Strategic recommendation**: Don't compete with native teams on Claude-only orchestration. Double down on cross-model orchestration + autonomous completion loop. Consider hybrid mode (native teams for Claude workers, custom adapters for Codex/Gemini).

---

## 5. Implementation Roadmap

```
Phase 1 (v0.9.8) — Security + Quick Wins
  [P0] Fix Claude CLI permission mirroring
  [P1] Unify permission detection
  [P1] Cache capabilities to file
  [P1] Resolve project root consistently
  [P1] Parse tool_use blocks
  [P1] Filter wisdom by subagent_type

Phase 2 (v0.10.0) — Platform Alignment
  [P2] Adopt --json-schema, --max-budget-usd, --effort, --fallback-model
  [P2] Ship bin/ CLI tools
  [P2] Hook Notification, PreToolUse(Bash), TaskCreated/TaskCompleted
  [P2] Adopt defer permission decision
  [P2] Adopt subagent frontmatter fields
  [P2] Add userConfig for plugin settings
  [P2] Fix stop-hook git add -A

Phase 3 (v0.11.0) — Strategic
  [P3] MCP server for orchestration tools
  [P3] Multi-turn Claude CLI workers
  [P3] Native agent teams hybrid mode
  [P3] Channels integration (when GA)
```

---

## Appendix: Source Reports

- Hermes (source analysis): `.ao/teams/research/hermes/outbox/source-analysis.md`
- Apollo (external intel): `.ao/teams/research/apollo/outbox/external-intel.md`
- Prometheus (gap analysis): `.ao/teams/research/prometheus/outbox/gap-analysis.md`
- Momus (validation): Agent output (not persisted to file)

## Appendix: Claude Code Documentation URLs

- Hooks: https://code.claude.com/docs/en/hooks
- CLI: https://code.claude.com/docs/en/cli-reference
- MCP: https://code.claude.com/docs/en/mcp
- Plugins: https://code.claude.com/docs/en/plugins-reference
- Agent Teams: https://code.claude.com/docs/en/agent-teams
- Subagents: https://code.claude.com/docs/en/sub-agents
- Permissions: https://code.claude.com/docs/en/permissions
- Channels: https://code.claude.com/docs/en/channels-reference
