# Agent Olympus

Standalone multi-model orchestrator plugin for Claude Code.
Atlas + Athena orchestrate 19 agents, 37 skills, Claude/Codex/Gemini execution, and adapter-based workers.

## Architecture

```
User Request
    │
    ├─ "해줘" / "do it" ──→ /atlas (sub-agent orchestrator)
    ├─ "팀으로 해" / "team" ──→ /athena (team orchestrator)
    ├─ "기획" / "plan" ──→ /plan (forward/reverse PRD)
    ├─ "물어봐" ──→ /ask (quick Codex/Gemini query)
    └─ "명확하게" ──→ /deep-interview (requirements clarification)
         │
         ▼
    Atlas/Athena Pipeline:
    Triage → Analyze → Plan(+PRD) → Execute → Verify → Review → Finalize
                                                               ↓
                                      Re-verify final tree → Final Review → Commit
         │           │                              │
         │           └─ /research (if needed)       └─ /trace (if debugger fails)
         └─ /deepinit (if unfamiliar codebase)
```

## Directory Structure

```
agent-olympus/
├── .claude-plugin/     — plugin.json + marketplace.json (version-synced)
├── hooks/hooks.json    — Hook event registrations (see Hooks below)
├── agents/             — 19 agent personas (see Agent Roles below)
├── skills/             — 37 user-facing skills, <name>/SKILL.md (see Skills below)
├── scripts/            — Hook entry points + CLI helpers (Node.js ESM, zero deps)
│   ├── lib/            — Shared modules: pipeline, adapters, permissions, state
│   └── test/           — node:test suites (current: 3351 tests, 135 files)
├── config/             — model-routing.jsonc, review-routing.jsonc
├── schemas/            — Codex goal/review structured-output schemas
├── evals/              — Eval harness (fixture vs live, deterministic graders)
├── .codex/agents/      — Committed Codex sub-agent definitions
└── docs/               — development, testing, internals/, plans/
```

Every `scripts/*.mjs` and `scripts/lib/*.mjs` file is catalogued in
[docs/internals/file-map.md](docs/internals/file-map.md); a test fails when one is missing.

## Conventions

- Naming follows Greek-myth agents where practical, with the `agent-olympus:` namespace for subagents and skills.
- Scripts are zero-dependency Node.js ESM (`.mjs`), except `scripts/run.cjs` for cross-platform hook wrapping.
- Hooks exit 0 and normally fail open; only concurrency admission and the Atlas executable-control gates (skill-init after proven identity, skill-scoped Stop) fail closed — [hooks.md](docs/internals/hooks.md).
- State writes use atomic tmp+rename helpers; state files use mode `0600` and state directories use `0700`.
- Persisted formats are independently versioned (the concurrency ledger is v2); authorization and admission formats fail closed on unknown versions. See [docs/development.md](docs/development.md).
- State lives under `.ao/`: `state/` is transient, `memory/` is durable, and run/team artifacts are swept by lifecycle rules.

## Worker Adapter System

- Workers are selected by adapter priority: Codex `codex-appserver` -> `codex-exec` -> `tmux`; Claude `claude-cli` -> `tmux`; Gemini `gemini-acp` -> `gemini-exec` -> `tmux`.
- Atlas/Athena run `runPreflight()` before orchestration; trivial work stays Claude-only and cross-validation prefers Codex then Gemini.
- Autonomy: `defaults <- global <- project`; project wins, CI skips global unless explicit, and task no-ship overrides `ship.mode`.
- Session names use stable prefixes such as `atlas-codex-<N>`, `athena-<slug>-gemini-<N>`, and `*-xval-<story-id>`.
- Key files: `scripts/lib/worker-spawn.mjs`, `codex-appserver.mjs`, `codex-exec.mjs`, `claude-cli.mjs`, `gemini-acp.mjs`, `gemini-exec.mjs`, `permission-detect.mjs`.
- Detached worker supervisor -> [docs/internals/worker-adapters.md](docs/internals/worker-adapters.md); permission mirroring -> [docs/internals/permission-mirroring.md](docs/internals/permission-mirroring.md); Gemini credentials -> [docs/internals/credentials.md](docs/internals/credentials.md).

## Contributing

Follow [docs/development.md](docs/development.md) when adding agents, skills, hooks, or persisted formats.

## Testing

Run the current 3351-test Node suite and syntax checks from [docs/testing.md](docs/testing.md). Keep this file under 28 KiB with `node scripts/check-agents-size.mjs`.

## Dependencies

- Runtime: Node.js >= 20.0.0.
- Optional: tmux for legacy worker fallback and Athena team mode.
- Optional: Codex CLI (`npm install -g @openai/codex`) for Codex workers.
- Optional: Gemini CLI (`npm install -g @google/gemini-cli`) for Gemini workers, or Antigravity `agy` as drop-in fallback.
- npm packages: none at runtime.

## Known Limitations

- `--bare` Claude Code mode skips hooks, plugins, and skill directory walks, so Agent Olympus hooks will not fire there.
- Atlas requires Claude Code 2.1.214+ (validated; earlier support unknown). Missing `UserPromptExpansion` stops `/atlas`; missing skill hooks removes the Stop gate (unsupported). Fresh runs need clean trees; Agent Olympus does not auto-stage or auto-commit pre-existing work.
- Trusted VCS uses fixed roots: Git for Atlas/ship/CI; `gh` for GitHub/PR evidence. nix/asdf/mise-only installs are unsupported.
- Claude Code sandbox mode should be used when testing hooks; edge cases can appear around `.ao/` filesystem access.
- Gemini credential auto-resolution supports macOS Keychain and Linux libsecret in v1; Windows users must set `GEMINI_API_KEY`.

## Agent Roles

### Orchestrators (Opus)
| Agent | Role |
|-------|------|
| **atlas** | Hub-and-spoke: one brain delegates to many sub-agents; supports session recovery via checkpoint |
| **athena** | Hybrid team: native Claude teammates plus lead-bridged Codex/Gemini adapters; supports session recovery via checkpoint |

### Planning & Specification (Opus)
| Agent | Role |
|-------|------|
| **metis** | Deep analysis: scope, risks, unknowns, dependencies |
| **prometheus** | Strategic planning: work items, parallel groups, acceptance criteria |
| **momus** | Plan validation: 4-criteria gate (Clarity/Verification/Context/BigPicture ≥70) |
| **hermes** | Product planning specialist: forward (idea→spec) and reverse (code→spec) PRD generation |

### Execution (Sonnet)
| Agent | Role |
|-------|------|
| **executor** | Standard implementation worker |
| **designer** | UI/UX implementation specialist |
| **test-engineer** | Test strategy, TDD, coverage |
| **debugger** | Root-cause analysis and fix |
| **hephaestus** | Deep autonomous coder (large refactoring, algorithms) |

### Review & Quality Gate (No Direct Edits)
| Agent | Role |
|-------|------|
| **architect** (Opus) | Functional completeness, architecture alignment |
| **aphrodite** | UI/UX design critique — Nielsen heuristics, Gestalt principles, WCAG 2.2 AA |
| **security-reviewer** | OWASP Top 10, secrets, injection |
| **code-reviewer** | Logic defects, SOLID, DRY, AI slop |
| **themis** | Test-executing quality gate; final tree freshness rejects side effects |

### Utility
| Agent | Role |
|-------|------|
| **ask** (Sonnet) | Quick single-shot Codex/Gemini query agent |
| **explore** (Haiku) | Fast codebase scanning via Glob/Grep/Read |
| **writer** (Haiku) | Technical documentation |

## Skills

### Core Orchestration
| Skill | Trigger | What It Does |
|-------|---------|--------------|
| `/atlas` | "해줘", "do it" | Full autonomous pipeline: triage → analyze → plan → execute → verify → review → commit |
| `/athena` | "팀으로 해", "team" | Native Claude teammates plus lead-bridged Codex/Gemini workers, all worktree-isolated |
| `/plan` | "기획", "spec", "역기획" | Adaptive product planner — forward (idea→spec) and reverse (code→spec) |

### Pre-Processing
| Skill | Trigger | What It Does |
|-------|---------|--------------|
| `/deep-interview` | "명확하게", "clarify" | Socratic interview to crystallize vague requirements → hands off to atlas/athena |
| `/deepinit` | "초기화", "map codebase" | Generate AGENTS.md hierarchy for agent orientation |

### Mid-Pipeline Tools
| Skill | Trigger | What It Does |
|-------|---------|--------------|
| `/ask` | "물어봐", "codex" | Quick single-shot Codex/Gemini query (sync + async job system) |
| `/codex-goal` | "코덱스에 위임", "codex goal" | Delegate one bounded goal to Codex with Claude-hosted external verification |
| `/codex-review` | "코덱스 리뷰", "codex review" | Codex as an independent PASS/FAIL review gate on the diff — inverse of `/codex-goal` |
| `/brainstorm` | "브레인스톰", "설계" | Design-before-code with diverge-converge-refine methodology |
| `/research` | "조사해", "리서치" | Parallel web research: decompose → fetch → synthesize |
| `/trace` | "추적", "원인분석" | 3-lane competing hypothesis investigation with rebuttal round |

### Post-Processing
| Skill | Trigger | What It Does |
|-------|---------|--------------|
| `/slop-cleaner` | "정리", "deslop" | Regression-safe AI bloat removal in 4 passes |
| `/git-master` | "커밋", "commit" | Style-detected atomic commits (3+ files → 2+ commits) |
| `/cancel` | "취소", "stop" | Graceful shutdown: shutdown workers (adapters + tmux sessions), clean state, clean worktrees, preserve progress |
| `/finish-branch` | "브랜치완료", "finish" | Structured branch completion with verified checklist before merge |
| `/sessions` | "세션", "세션관리" | Browse, inspect, resume, and clean up session history |

### Research & Planning
| Skill | Trigger | What It Does |
|-------|---------|--------------|
| `/deep-dive` | "deep-dive", "깊게파봐" | Exhaustive single-topic investigation: multiple search angles, synthesis |
| `/consensus-plan` | "합의", "consensus" | Multi-agent planning: Prometheus + Momus reach consensus before execution |
| `/external-context` | "외부문서", "docs" | Fetch and inject external documentation or specs into the active context |
| `/harness-init` | "하네스초기화", "harness" | Initialize AGENTS.md + docs/ knowledge base + golden principles |
| `/systematic-debug` | "체계적디버깅", "debug" | Root-cause-first debugging — reproduce before any fix attempt |
| `/tdd` | "테스트주도", "tdd" | Test-driven development with strict RED-GREEN-REFACTOR discipline |

### Quality Assurance
| Skill | Trigger | What It Does |
|-------|---------|--------------|
| `/verify-coverage` | "coverage", "커버리지" | Detect test coverage gaps for recently changed files; generate missing tests |

### UI/UX Design Review
| Skill | Trigger | What It Does |
|-------|---------|--------------|
| `/ui-review` | "UI 리뷰", "full design review" | Comprehensive UI review — chains design-critique + a11y-audit + design-system-audit + ux-copy-review |
| `/design-critique` | "디자인 리뷰", "critique" | Structured design feedback using Nielsen heuristics + Gestalt principles + WCAG |
| `/a11y-audit` | "접근성 검사", "a11y" | WCAG 2.2 AA accessibility audit via code review (no browser required) |
| `/design-system-audit` | "디자인 시스템 검사", "ds-audit" | Token leaks, component API consistency, state coverage matrix |
| `/ux-copy-review` | "카피 리뷰", "copy review" | UX copy quality — clarity, consistency, tone, inclusivity, error messages |
| `/ui-remediate` | "프런트엔드수정", "remediate" | Sequential remediation chain: audit → normalize → polish → re-audit |
| `/arrange` | "배치", "layout-pass" | Layout & spacing rhythm pass — touches nothing else |
| `/normalize` | "정규화", "tokenize" | Replace hardcoded CSS/JS values with design tokens |
| `/polish` | "마감", "final-pass" | Final-pass micro-refinements — alignment, spacing, micro-detail |
| `/typeset` | "타이포", "typography" | Typography-only pass — font choice, hierarchy, sizing, weight |
| `/taste` | "취향", "aesthetic" | Record, list, and prune aesthetic preferences for auto-injection |
| `/teach-design` | "디자인학습", "brand-capture" | Capture project brand identity for designer/aphrodite subagents |
| `/resume-handoff` | "재개", "resume" | Read persisted browser handoff state for manual resume |
| `/setup-gemini-auth` | "제미니키체인", "gemini keychain" | macOS-only one-time wizard to create AO-owned Keychain item |

## Hooks

| Event | Hook | Purpose |
|-------|------|---------|
| SessionStart | session-start | Inject prior wisdom + interrupted checkpoint context at session start |
| SessionStart | runtime-permissions-capture | Bind hook session identity to an external private runtime grant (async) |
| UserPromptExpansion:atlas\|agent-olympus:atlas + PreToolUse:Skill | orchestrator-skill-init | Atlas bootstrap: create/adopt one run + inject executable control; fail-closed after proven identity, `{}` otherwise |
| UserPromptSubmit | intent-gate | Classify user intent into 13 categories + unknown fallback (multilingual) |
| UserPromptSubmit | runtime-permissions-capture | Refresh the bound grant without trusting project-local state (async) |
| PreToolUse:Task | concurrency-gate | Enforce parallel task limits |
| PreToolUse:Task | model-router | Inject model routing advice based on intent |
| PreToolUse:Agent | concurrency-gate | Same limits for Agent tool |
| PreToolUse:Agent | model-router | Same routing for Agent tool |
| PostToolUse:Task | concurrency-release | Release task from concurrency pool |
| PostToolUse:Agent | concurrency-release | Same release for Agent tool |
| PostToolUse:ExitPlanMode | plan-execute-gate | Inject execution routing (solo/ask/atlas/athena) after plan approval |
| SubagentStart | subagent-start | Inject token efficiency directive + wisdom context into subagents |
| SubagentStop | subagent-stop | Capture subagent results (async) |
| SubagentStop | concurrency-release | Release concurrency slot as safety net (async) |
| Notification:idle_prompt | notification | Log idle/permission prompts for stall detection |
| Notification:permission_prompt | notification | Same logging for permission prompts |
| SessionEnd | session-end | Sweep stale state; collect linked failed-run candidates |
| Stop (skill-scoped) | orchestrator-stop-gate | atlas SKILL.md frontmatter: blocks premature Stop mid-run |

## State Files

| File | Purpose | Lifecycle |
|------|---------|-----------|
| `.ao/state/atlas-state.json` | Atlas phase tracking | Created on start, deleted on completion |
| `.ao/state/athena-state.json` | Athena phase tracking | Created on start, deleted on completion |
| `.ao/prd.json` | User stories with acceptance criteria | Created in Plan phase, deleted on completion |
| `.ao/wisdom.jsonl` | Cross-iteration learnings (JSONL format) | Accumulated, NEVER deleted (survives cancel) |
| `.ao/state/checkpoint-atlas[-sessionId].json` | Atlas session recovery checkpoint (session-scoped) | Auto-expires after 24h |
| `.ao/state/checkpoint-athena[-sessionId].json` | Athena session recovery checkpoint (session-scoped) | Auto-expires after 24h |
| `.ao/state/ao-intent.json` | Last classified intent | Updated per prompt |
| `.ao/state/ao-concurrency.json` | Schema-v2 active task tracking and recovery barrier | Updated per task spawn/complete; never generic-TTL swept |
| `.ao/memory/` | Durable design identity and taste memory (`schemaVersion:1`) | Survives SessionEnd and cancel |
| `.ao/state/supervisor/<runId>/` | Detached worker snapshots/manifests | Swept per inactive run |
| `.ao/artifacts/runs/<runId>/` | Run evidence, failure marker, task ledger | Retained for audit/candidate review |
| `.ao/artifacts/ask/<jobId>.*` | Async `/ask` raw and rendered outputs | Job-addressable artifacts |
| `.ao/artifacts/pipe/` | Stage handoff/archive pipe (`plan`, `execute`, `verify`, etc.) | 24h SessionEnd sweep |
| `.ao/sessions/<sessionId>.json` | Cross-session registry metadata | 90-day TTL |
| `.ao/teams/<slug>/` | Inbox/outbox for team workers (Claude/Codex/Gemini) | Created by Athena, cleaned on completion |
| `.ao/worktrees/<slug>/<worker>/` | Isolated git worktrees for Athena workers | Created per worker, merged + cleaned on completion |

## Key Design Decisions

1. **Self-driving loop** — Atlas/Athena loop until PRD/build/tests/reviews pass; max 15 iterations.
2. **PRD quality enforcement** — Acceptance criteria must be specific and testable.
3. **Progress persistence** — `.ao/wisdom.jsonl` survives cancellation and seeds later sessions.
4. **Multi-adapter worker system** — `ADAPTER_REGISTRY` selects Codex, Gemini, Claude, or tmux fallback adapters.
5. **External skill awareness** — Atlas/Athena can invoke installed plugin skills when they fit.
6. **Zero runtime dependencies** — All scripts use Node.js built-ins only. No npm packages.
7. **Athena worktree isolation** — Parallel workers use `.ao/worktrees/<slug>/<worker>/`.
8. **Fail-safe hooks** — Hooks exit 0; only concurrency admission and the Atlas executable-control gates fail closed.
9. **Atomic state writes** — State mutations use tmp+rename via `lib/fs-atomic.mjs`.
10. **tmux injection prevention** — `sanitizeForShellArg()` in `lib/tmux-session.mjs` escapes shell special characters before any `send-keys` call.
11. **Explicit Git ownership** — no global Stop hook stages or commits the shared worktree; Git mutations require an explicit user or orchestrator workflow.
