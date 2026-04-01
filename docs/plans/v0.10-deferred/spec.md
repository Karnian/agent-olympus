# v0.10 Deferred Items Specification

**Status**: Backlog (deferred from v0.9.1)
**Last Updated**: 2026-04-01

## Overview

These items were identified during the v0.9.1 self-evaluation and external ecosystem research but deferred for separate implementation due to their scope and complexity.

---

## D1: codex-plugin-cc Integration Analysis

**Priority**: Should-have
**Effort**: High
**Source**: OpenAI codex-plugin-cc (Apache 2.0, released 2026-03-30)

### Background

OpenAI released an official Codex plugin for Claude Code (`codex-plugin-cc`) that provides structured Codex integration via the `codex app-server` JSON-RPC protocol, replacing ad-hoc tmux-based invocations.

### Key Patterns to Evaluate

1. **App Server JSON-RPC** — `codex app-server` provides a persistent JSON-RPC API over stdio/unix sockets, enabling structured request/response with real-time notifications (`item/started`, `item/completed`, `turn/completed`). Our current tmux + `codex exec` approach captures output via `capture-pane` (unstructured text).

2. **Review Gate** — `stop-review-gate-hook.mjs` implements an ALLOW/BLOCK protocol on the Stop hook (900s timeout). Codex automatically reviews Claude's output before session end. Could replace our manual cross-validation workflow (`atlas-codex-xval-*` sessions).

3. **Broker Pattern** — `app-server-broker.mjs` enables multiple clients to share a single Codex runtime via unix socket IPC with request queuing. Useful for Atlas multi-worker Codex sessions (currently each spawns separate `codex exec`).

4. **Adversarial Review Prompts** — Well-structured review template with `<attack_surface>`, `<finding_bar>`, `<calibration_rules>`, `<grounding_rules>` sections. Could inform our `code-reviewer` agent prompt.

5. **Job Tracking** — `state.mjs` + `tracked-jobs.mjs` provide workspace-scoped job lifecycle management with progress updates, log files, and session filtering.

### Key Files to Study

- `plugins/codex/scripts/lib/codex.mjs` — App Server client, turn capture, thread management
- `plugins/codex/scripts/lib/app-server.mjs` — JSON-RPC transport (spawned + broker)
- `plugins/codex/scripts/stop-review-gate-hook.mjs` — Review Gate implementation
- `plugins/codex/prompts/adversarial-review.md` — Adversarial review prompt template
- `plugins/codex/scripts/lib/state.mjs` — State management pattern

### Migration Path

1. Create `scripts/lib/codex-appserver.mjs` as thin client wrapper
2. Add app-server as alternative to tmux in `worker-spawn.mjs`
3. Keep tmux for Claude/Gemini workers (they don't have app-server)
4. Gradually migrate Codex calls from tmux to app-server
5. Document coexistence with codex-plugin-cc

---

## D2: Native Agent Teams Migration

**Priority**: Must-evaluate
**Effort**: High
**Source**: Claude Code v2.1.32+ (experimental)

### Background

Claude Code now has built-in Agent Teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`) that closely mirror Athena's architecture:

| Capability | Athena (ours) | Native Agent Teams |
|-----------|--------------|-------------------|
| Worker spawning | Manual via skill prompt | `TeamCreate` tool |
| Communication | `.ao/teams/` inbox/outbox | `SendMessage` + shared mailbox |
| Task tracking | Custom task files | Built-in task list with dependencies |
| Worktree isolation | Manual `.ao/worktrees/` | Built-in git worktree per teammate |
| File locking | None | Built-in for task claiming |
| Codex integration | tmux-based | Not built-in |

### Evaluation Questions

1. Can Athena become a thin wrapper around native teams, adding Codex integration and agent personas as value-add?
2. What native team features would we lose by not migrating (dependency resolution, file locking)?
3. How do native teams interact with our hook system (SubagentStart/Stop)?
4. What happens when `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is not set?

### Relevant Hook Events

- `TaskCreated` / `TaskCompleted` — native task lifecycle
- `TeammateIdle` — worker idle detection
- `WorktreeCreate` / `WorktreeRemove` — worktree lifecycle

### Migration Strategy

1. Feature-flag approach: detect native teams availability
2. If available: use native primitives for coordination, inject our agent personas
3. If unavailable: fall back to current Athena implementation
4. Always keep Codex tmux integration as our unique value-add

---

## D3: Event-Sourced Orchestration State

**Priority**: Should-have
**Effort**: Medium
**Source**: Industry patterns + v0.9 backlog item E7

### Background

Currently, Atlas/Athena use mutable checkpoint files (`.ao/state/checkpoint-{atlas|athena}.json`) that are overwritten on each phase transition. This makes debugging difficult — we can see the current state but not the history of how we got there.

### Proposed Design

Replace mutable checkpoints with an append-only event log:

```jsonl
{"event":"phase_started","phase":0,"timestamp":"2026-04-01T10:00:00Z","orchestrator":"athena"}
{"event":"worker_spawned","worker":"api-worker","type":"claude","model":"sonnet","timestamp":"..."}
{"event":"worker_completed","worker":"api-worker","duration_ms":45000,"stories_passed":["US-001"],"timestamp":"..."}
{"event":"phase_started","phase":4,"timestamp":"...","orchestrator":"athena"}
{"event":"verification_result","type":"tests","passed":true,"timestamp":"..."}
```

### Benefits

- **Debuggability**: Full history of orchestration decisions
- **Session replay**: Can reconstruct any point in time
- **Wisdom extraction**: Pattern analysis across multiple runs
- **Crash recovery**: Replay events to rebuild state after crash

### Implementation Plan

1. Create `scripts/lib/event-log.mjs` with `appendEvent()` and `replayEvents()`
2. Modify checkpoint.mjs to write events instead of overwriting state
3. Add `loadCheckpoint()` that replays events to reconstruct current state
4. Keep `.ao/wisdom.jsonl` separate (different lifecycle)

---

## Dependencies

- D1 depends on: Codex CLI app-server stability
- D2 depends on: Native Agent Teams leaving experimental status
- D3 depends on: None (can be implemented independently)

## Success Criteria

- [ ] D1: Codex app-server client works as drop-in replacement for tmux Codex calls
- [ ] D2: Athena runs on native teams when available, falls back gracefully
- [ ] D3: All orchestration state changes are captured in event log
