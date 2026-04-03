# Agent Olympus

Standalone multi-model orchestrator plugin for Claude Code.
Two self-driving orchestrators (Atlas + Athena) that autonomously complete any task using 18 specialized agents, 26 skills, Claude + Codex multi-model execution, and tmux-based team infrastructure.

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
    Triage → Analyze → Plan(+PRD) → Execute → Verify → Review → Slop Clean → Commit
         │           │                              │
         │           └─ /research (if needed)       └─ /trace (if debugger fails)
         └─ /deepinit (if unfamiliar codebase)
```

## Directory Structure

```
agent-olympus/
├── .claude-plugin/plugin.json    — Plugin manifest (v0.8.3)
├── agents/                       — 18 agent personas (role definitions)
│   ├── atlas.md                  — Self-driving sub-agent orchestrator (Opus)
│   ├── athena.md                 — Self-driving team orchestrator (Opus)
│   ├── metis.md                  — Pre-planning analyst (Opus)
│   ├── prometheus.md             — Strategic planner (Opus)
│   ├── momus.md                  — Plan validator / critic (Opus)
│   ├── hermes.md                 — Product planning specialist, forward & reverse PRD (Opus)
│   ├── executor.md               — Implementation worker (Sonnet)
│   ├── designer.md               — UI/UX implementation specialist (Sonnet)
│   ├── aphrodite.md              — UI/UX design reviewer, goddess of beauty (Sonnet)
│   ├── test-engineer.md          — Test strategy & TDD (Sonnet)
│   ├── debugger.md               — Root-cause analysis & fix (Sonnet)
│   ├── architect.md              — Architecture review, read-only (Opus)
│   ├── security-reviewer.md      — Security review, read-only (Sonnet)
│   ├── code-reviewer.md          — Code quality review, read-only (Sonnet)
│   ├── explore.md                — Fast codebase scanner (Haiku)
│   ├── writer.md                 — Documentation writer (Haiku)
│   └── hephaestus.md             — Codex deep worker (Sonnet)
├── skills/                       — 26 user-facing skills (workflow recipes)
│   ├── atlas/SKILL.md            — /atlas: autonomous sub-agent pipeline
│   ├── athena/SKILL.md           — /athena: autonomous team pipeline
│   ├── plan/SKILL.md             — /plan: forward/reverse product planning
│   ├── ask/SKILL.md              — /ask: quick Codex/Gemini query
│   ├── deep-interview/SKILL.md   — /deep-interview: Socratic clarification
│   ├── deepinit/SKILL.md         — /deepinit: codebase AGENTS.md generation
│   ├── research/SKILL.md         — /research: parallel web research
│   ├── trace/SKILL.md            — /trace: competing-hypothesis root-cause analysis
│   ├── slop-cleaner/SKILL.md     — /slop-cleaner: AI bloat removal
│   ├── git-master/SKILL.md       — /git-master: atomic commit discipline
│   ├── cancel/SKILL.md           — /cancel: graceful session shutdown
│   ├── deep-dive/SKILL.md        — /deep-dive: exhaustive single-topic investigation
│   ├── consensus-plan/SKILL.md   — /consensus-plan: multi-agent planning consensus
│   ├── external-context/SKILL.md — /external-context: inject external docs/specs into context
│   ├── verify-coverage/SKILL.md  — /verify-coverage: detect test coverage gaps for changed files
│   ├── design-critique/SKILL.md  — /design-critique: Nielsen + Gestalt + WCAG design critique
│   ├── a11y-audit/SKILL.md       — /a11y-audit: WCAG 2.2 AA accessibility audit (code-review only)
│   ├── design-system-audit/SKILL.md — /design-system-audit: token leaks, component API consistency
│   ├── ux-copy-review/SKILL.md   — /ux-copy-review: UX copy clarity, consistency, tone, inclusivity
│   └── ui-review/SKILL.md        — /ui-review: umbrella (chains all 4 design review skills)
├── scripts/                      — Hook scripts (Node.js ESM, zero dependencies)
│   ├── run.cjs                   — Cross-platform hook runner with version fallback
│   ├── intent-gate.mjs           — UserPromptSubmit: classify intent (EN/KO/JA/ZH)
│   ├── model-router.mjs          — PreToolUse: inject model routing advice
│   ├── concurrency-gate.mjs      — PreToolUse: enforce parallel task limits
│   ├── concurrency-release.mjs   — PostToolUse: release task from concurrency pool
│   ├── session-start.mjs         — SessionStart: inject wisdom + checkpoint context
│   ├── stop-hook.mjs             — Stop: auto-commit uncommitted work as WIP
│   ├── test/                     — node:test unit tests (1000+ tests, 47 files)
│   └── lib/
│       ├── stdin.mjs             — Shared stdin reader with timeout
│       ├── intent-patterns.mjs   — Intent classifier (8 categories, multilingual)
│       ├── model-router.mjs      — Routing logic with JSONC config merge
│       ├── tmux-session.mjs      — Tmux session lifecycle + sanitizeForShellArg()
│       ├── inbox-outbox.mjs      — File-based message queue for Claude↔Codex
│       ├── worker-spawn.mjs      — Team worker lifecycle (spawn/monitor/collect/shutdown)
│       ├── checkpoint.mjs        — Session checkpoint save/restore (24h expiry)
│       ├── wisdom.mjs            — Structured learning store (JSONL, intent-aware query)
│       ├── worker-status.mjs     — Real-time worker status dashboard (inline markdown)
│       ├── worktree.mjs          — Git worktree isolation for Athena parallel workers
│       ├── fs-atomic.mjs         — Atomic write helpers (tmp+rename pattern)
│       ├── provider-detect.mjs   — Shared detectProvider() for concurrency hooks
│       ├── config-validator.mjs  — Schema validation for model-routing.jsonc
│       ├── autonomy.mjs          — Ship policy config loader/validator (.ao/autonomy.json)
│       ├── cost-estimate.mjs     — Token cost estimation before long runs
│       ├── changelog.mjs         — CHANGELOG.md auto-generation
│       ├── pr-create.mjs         — GitHub PR creation via gh CLI
│       ├── ci-watch.mjs          — CI status polling and auto-fix loop
│       ├── notify.mjs            — OS desktop notifications (macOS/Linux/terminal bell)
│       ├── input-guard.mjs       — Large input auto-summarization for sub-agents
│       ├── preflight.mjs         — Stale pointer file detection and cleanup
│       ├── stuck-recovery.mjs    — Detect and recover from stuck worker states
│       ├── run-artifacts.mjs     — Per-run event log, summary, and verification storage
│       ├── session-registry.mjs  — Cross-session metadata tracking and crash recovery
│       └── codex-approval.mjs    — Claude permission detection → Codex approval mode mirroring
├── config/
│   └── model-routing.jsonc       — Intent→model routing configuration
└── hooks/
    └── hooks.json                — Hook event registrations
```

## Agent Roles

### Orchestrators (Opus)
| Agent | Role |
|-------|------|
| **atlas** | Hub-and-spoke: one brain delegates to many sub-agents; supports session recovery via checkpoint |
| **athena** | Peer-to-peer: many brains collaborate via SendMessage + tmux; supports session recovery via checkpoint |

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
| **hephaestus** | Codex deep worker (large refactoring, algorithms) |

### Review (Read-Only)
| Agent | Role |
|-------|------|
| **architect** (Opus) | Functional completeness, architecture alignment |
| **aphrodite** | UI/UX design critique — Nielsen heuristics, Gestalt principles, WCAG 2.2 AA |
| **security-reviewer** | OWASP Top 10, secrets, injection |
| **code-reviewer** | Logic defects, SOLID, DRY, AI slop |

### Utility
| Agent | Role |
|-------|------|
| **explore** (Haiku) | Fast codebase scanning via Glob/Grep/Read |
| **writer** (Haiku) | Technical documentation |

## Skills

### Core Orchestration
| Skill | Trigger | What It Does |
|-------|---------|--------------|
| `/atlas` | "해줘", "do it" | Full autonomous pipeline: triage → analyze → plan → execute → verify → review → commit |
| `/athena` | "팀으로 해", "team" | Same pipeline but with native Claude team (each in git worktree) + Codex tmux workers |
| `/plan` | "기획", "spec", "역기획" | Adaptive product planner — forward (idea→spec) and reverse (code→spec) |

### Pre-Processing
| Skill | Trigger | What It Does |
|-------|---------|--------------|
| `/deep-interview` | "명확하게", "clarify" | Socratic interview to crystallize vague requirements → hands off to atlas/athena |
| `/deepinit` | "초기화", "map codebase" | Generate AGENTS.md hierarchy for agent orientation |

### Mid-Pipeline Tools
| Skill | Trigger | What It Does |
|-------|---------|--------------|
| `/ask` | "물어봐", "codex" | Quick single-shot Codex/Gemini query via tmux |
| `/research` | "조사해", "리서치" | Parallel web research: decompose → fetch → synthesize |
| `/trace` | "추적", "원인분석" | 3-lane competing hypothesis investigation with rebuttal round |

### Post-Processing
| Skill | Trigger | What It Does |
|-------|---------|--------------|
| `/slop-cleaner` | "정리", "deslop" | Regression-safe AI bloat removal in 4 passes |
| `/git-master` | "커밋", "commit" | Style-detected atomic commits (3+ files → 2+ commits) |
| `/cancel` | "취소", "stop" | Graceful shutdown: kill tmux, clean state, clean worktrees, preserve progress |

### Research & Planning
| Skill | Trigger | What It Does |
|-------|---------|--------------|
| `/deep-dive` | "deep-dive", "깊게파봐" | Exhaustive single-topic investigation: multiple search angles, synthesis |
| `/consensus-plan` | "합의", "consensus" | Multi-agent planning: Prometheus + Momus reach consensus before execution |
| `/external-context` | "외부문서", "docs" | Fetch and inject external documentation or specs into the active context |

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

## Hooks

| Event | Hook | Purpose |
|-------|------|---------|
| SessionStart | session-start | Inject prior wisdom + interrupted checkpoint context at session start |
| UserPromptSubmit | intent-gate | Classify user intent into 7 categories (multilingual) |
| PreToolUse:Task | concurrency-gate | Enforce parallel task limits |
| PreToolUse:Task | model-router | Inject model routing advice based on intent |
| PreToolUse:Agent | concurrency-gate | Same limits for Agent tool |
| PreToolUse:Agent | model-router | Same routing for Agent tool |
| PostToolUse:Task | concurrency-release | Release task from concurrency pool |
| PostToolUse:Agent | concurrency-release | Same release for Agent tool |
| Stop | stop-hook | Auto-commit uncommitted work as WIP commit on session end |

## State Files

| File | Purpose | Lifecycle |
|------|---------|-----------|
| `.ao/state/atlas-state.json` | Atlas phase tracking | Created on start, deleted on completion |
| `.ao/state/athena-state.json` | Athena phase tracking | Created on start, deleted on completion |
| `.ao/prd.json` | User stories with acceptance criteria | Created in Plan phase, deleted on completion |
| `.ao/wisdom.jsonl` | Cross-iteration learnings (JSONL format) | Accumulated, NEVER deleted (survives cancel) |
| `.ao/state/checkpoint-atlas.json` | Atlas session recovery checkpoint | Auto-expires after 24h |
| `.ao/state/checkpoint-athena.json` | Athena session recovery checkpoint | Auto-expires after 24h |
| `.ao/state/ao-intent.json` | Last classified intent | Updated per prompt |
| `.ao/state/ao-concurrency.json` | Active task tracking | Updated per task spawn/complete |
| `.ao/teams/<slug>/` | Inbox/outbox for Codex workers | Created by Athena, cleaned on completion |
| `.ao/worktrees/<slug>/<worker>/` | Isolated git worktrees for Athena workers | Created per worker, merged + cleaned on completion |

## Multi-Model Support

| Model | Agent Tier | When Used |
|-------|-----------|-----------|
| Claude Haiku | explore, writer | Fast scans, documentation |
| Claude Sonnet | executor, designer, aphrodite, debugger, reviewers, hephaestus | Standard implementation and review |
| Claude Opus | atlas, athena, metis, prometheus, momus, hermes, architect | Orchestration, analysis, planning |
| OpenAI Codex | hephaestus (via tmux) | Algorithms, large refactoring, deep exploration |

## Key Design Decisions

1. **Self-driving loop** — Atlas/Athena never stop early. They loop until all PRD stories pass, build succeeds, tests pass, and reviews approve. Max 15 iterations before escalating.
2. **PRD quality enforcement** — Generic acceptance criteria ("works correctly") are forbidden. Every criterion must be specific and testable.
3. **Progress persistence** — `.ao/wisdom.jsonl` accumulates learnings across iterations and survives cancellation, so future sessions start smarter.
4. **Codex via tmux** — No omc dependency. Codex is spawned directly as tmux sessions, monitored via `capture-pane`, and cleaned up on completion.
5. **External skill awareness** — Atlas/Athena can invoke any installed plugin skill (anthropic-skills, ui-ux-pro-max, etc.) when it fits better than a generic executor.
6. **Zero runtime dependencies** — All scripts use Node.js built-ins only. No npm packages.
7. **Athena worktree isolation** — Each parallel Athena worker runs in a dedicated git worktree (`.ao/worktrees/<slug>/<worker>/`), preventing silent file overwrites and merge conflicts between concurrent workers.
8. **Fail-safe hooks** — Every hook catches all errors and outputs `{}` to stdout, so Claude Code is never blocked by a hook failure.
9. **Atomic state writes** — All state file mutations use tmp+rename via `lib/fs-atomic.mjs`, preventing data corruption from concurrent writes or crashes mid-write.
10. **tmux injection prevention** — `sanitizeForShellArg()` in `lib/tmux-session.mjs` escapes shell special characters before any `send-keys` call.
