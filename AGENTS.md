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
    Triage → Analyze → Plan(+PRD) → Execute → Verify → Review → Slop Clean → Commit
         │           │                              │
         │           └─ /research (if needed)       └─ /trace (if debugger fails)
         └─ /deepinit (if unfamiliar codebase)
```

## Directory Structure

```
agent-olympus/
├── hooks/hooks.json              — Hook event registrations
├── agents/                       — 19 agent personas (role definitions)
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
│   ├── hephaestus.md             — Codex deep worker (Sonnet)
│   ├── ask.md                    — Quick Codex/Gemini query agent (Sonnet)
│   └── themis.md                 — Quality gate: tests/lint/AC verification (Sonnet)
├── skills/                       — 37 user-facing skills (workflow recipes)
│   ├── atlas/SKILL.md            — /atlas: autonomous sub-agent pipeline
│   ├── athena/SKILL.md           — /athena: autonomous team pipeline
│   ├── plan/SKILL.md             — /plan: forward/reverse product planning
│   ├── ask/SKILL.md              — /ask: quick Codex/Gemini query (sync + async)
│   ├── deep-interview/SKILL.md   — /deep-interview: Socratic clarification
│   ├── deepinit/SKILL.md         — /deepinit: codebase AGENTS.md generation
│   ├── research/SKILL.md         — /research: parallel web research
│   ├── trace/SKILL.md            — /trace: competing-hypothesis root-cause analysis
│   ├── brainstorm/SKILL.md       — /brainstorm: design-before-code diverge-converge
│   ├── slop-cleaner/SKILL.md     — /slop-cleaner: AI bloat removal
│   ├── git-master/SKILL.md       — /git-master: atomic commit discipline
│   ├── cancel/SKILL.md           — /cancel: graceful session shutdown
│   ├── finish-branch/SKILL.md    — /finish-branch: structured branch completion checklist
│   ├── sessions/SKILL.md         — /sessions: browse/inspect/resume session history
│   ├── deep-dive/SKILL.md        — /deep-dive: exhaustive single-topic investigation
│   ├── consensus-plan/SKILL.md   — /consensus-plan: multi-agent planning consensus
│   ├── external-context/SKILL.md — /external-context: inject external docs/specs into context
│   ├── harness-init/SKILL.md     — /harness-init: initialize AGENTS.md + docs/ structure
│   ├── systematic-debug/SKILL.md — /systematic-debug: root-cause-first debugging
│   ├── tdd/SKILL.md              — /tdd: test-driven development (RED-GREEN-REFACTOR)
│   ├── verify-coverage/SKILL.md  — /verify-coverage: detect test coverage gaps for changed files
│   ├── design-critique/SKILL.md  — /design-critique: Nielsen + Gestalt + WCAG design critique
│   ├── a11y-audit/SKILL.md       — /a11y-audit: WCAG 2.2 AA accessibility audit (code-review only)
│   ├── design-system-audit/SKILL.md — /design-system-audit: token leaks, component API consistency
│   ├── ux-copy-review/SKILL.md   — /ux-copy-review: UX copy clarity, consistency, tone, inclusivity
│   ├── ui-review/SKILL.md        — /ui-review: umbrella (chains all 4 design review skills)
│   ├── ui-remediate/SKILL.md     — /ui-remediate: sequential remediation chain (audit→normalize→polish→re-audit)
│   ├── arrange/SKILL.md          — /arrange: layout & spacing rhythm pass
│   ├── normalize/SKILL.md        — /normalize: replace hardcoded values with design tokens
│   ├── polish/SKILL.md           — /polish: final-pass micro-refinements
│   ├── typeset/SKILL.md          — /typeset: typography-only pass (font, hierarchy, sizing)
│   ├── taste/SKILL.md            — /taste: record/list/prune aesthetic preferences
│   ├── teach-design/SKILL.md     — /teach-design: capture brand identity for auto-injection
│   ├── resume-handoff/SKILL.md   — /resume-handoff: read browser handoff state for manual resume
│   └── setup-gemini-auth/SKILL.md — /setup-gemini-auth: macOS Keychain wizard for Gemini API-key users (v1.1.3)
├── scripts/                      — Hook scripts (Node.js ESM, zero dependencies)
│   ├── run.cjs                   — Cross-platform hook runner with version fallback
│   ├── intent-gate.mjs           — UserPromptSubmit: classify intent (EN/KO/JA/ZH)
│   ├── model-router.mjs          — PreToolUse: inject model routing advice
│   ├── concurrency-gate.mjs      — PreToolUse: enforce parallel task limits
│   ├── concurrency-release.mjs   — PostToolUse: release task from concurrency pool
│   ├── session-start.mjs         — SessionStart: inject wisdom + checkpoint context
│   ├── runtime-permissions-capture.mjs — SessionStart + UserPromptSubmit: capture runtime permission_mode (v1.1.6)
│   ├── stop-hook.mjs             — Stop: auto-commit uncommitted work as WIP
│   ├── test/                     — node:test unit tests (2313 tests, 89 files; v1.3.1: 2313/2313 passing)
│   └── lib/
│       ├── stdin.mjs             — Shared stdin reader with timeout
│       ├── intent-patterns.mjs   — Intent classifier (8 categories, multilingual)
│       ├── model-router.mjs      — Routing logic with JSONC config merge
│       ├── tmux-session.mjs      — Tmux session lifecycle + sanitizeForShellArg()
│       ├── inbox-outbox.mjs      — File-based message queue (legacy, used by tmux fallback)
│       ├── worker-spawn.mjs      — Team worker lifecycle (spawn/monitor/collect/shutdown); launches detached supervisors + reads their disk snapshots (v1.2.0)
│       ├── adapter-worker-supervisor.mjs — Detached per-worker supervisor CLI: owns the adapter, writes disk snapshot/output (v1.2.0)
│       ├── supervisor-state.mjs  — Run-scoped supervisor paths + atomic snapshot I/O (5-way read, heartbeat) (v1.2.0)
│       ├── supervisor-opts.mjs   — Pure manifest→adapter-call option builders (CLI-free, unit-testable) (v1.2.0)
│       ├── proc-identity.mjs     — readProcStartId() PID start-time identity for reuse detection (v1.2.0)
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
│       ├── codex-approval.mjs    — Claude permission detection → Codex sandbox-axis mirroring + host-sandbox intersection (v1.1.0)
│       ├── gemini-approval.mjs   — Claude permission detection → Gemini approval mode mirroring
│       ├── gemini-exec.mjs       — Gemini exec adapter (single-turn JSON spawn)
│       ├── gemini-acp.mjs        — Gemini ACP adapter (multi-turn JSON-RPC 2.0)
│       ├── claude-cli.mjs        — Claude CLI adapter (headless stream-json)
│       ├── codex-exec.mjs        — Codex exec adapter (single-turn JSONL)
│       ├── codex-appserver.mjs   — Codex app-server adapter (multi-turn JSON-RPC 2.0)
│       ├── resolve-binary.mjs    — Binary resolution with caching + buildEnhancedPath()
│       ├── host-sandbox-detect.mjs — Passive host sandbox detection (LSM, container, seccomp)
│       ├── permission-detect.mjs — Unified permission detection (settings + runtime layers, shared by all adapters)
│       ├── runtime-permissions.mjs — Runtime permission_mode capture/load helpers (v1.1.6)
│       ├── artifact-pipe.mjs     — Cascade artifact archival pipe for orchestrator stages
│       ├── browser-handoff.mjs   — Browser pause state persistence for /resume-handoff
│       ├── design-identity.mjs   — Brand identity loader/writer (.ao/memory/)
│       ├── memory.mjs            — Durable memory namespace manager (.ao/memory/)
│       ├── taste-memory.mjs      — Aesthetic preference accumulation (.ao/memory/taste.jsonl)
│       ├── ask-jobs.mjs          — Job lifecycle for async /ask path
│       ├── micro-skill-scope.mjs — Micro-skill scope detection for design passes
│       ├── review-router.mjs     — Review routing logic for design review chain
│       ├── subagent-context.mjs  — Subagent context builder for hook injection
│       ├── ui-reference.mjs      — UI reference material loader for design skills
│       ├── ui-remediate.mjs      — UI remediation chain orchestrator
│       ├── ui-smell-scan.mjs     — UI smell detection heuristics
│       ├── ao-keychain-write.mjs — macOS Keychain item writer with partition-list grant (v1.1.3+)
│       ├── architect-scope.mjs   — Architect agent scope/blast-radius calculator
│       ├── gemini-credential.mjs — Gemini API key auto-resolver (env/Keychain/libsecret) (v1.1.1+)
│       ├── light-mode.mjs        — Atlas/Athena lightweight execution path
│       ├── model-usage.mjs       — Per-subagent model usage logger for Opus-skew analysis (v1.1.0+)
│       └── stage-escalation.mjs  — Escalation-first model routing for orchestrator stages
├── config/
│   └── model-routing.jsonc       — Intent→model routing configuration
└── hooks/
    └── hooks.json                — Hook event registrations
```

## Conventions

- Naming follows Greek-myth agents where practical, with the `agent-olympus:` namespace for subagents and skills.
- Scripts are zero-dependency Node.js ESM (`.mjs`), except `scripts/run.cjs` for cross-platform hook wrapping.
- Hooks are fail-safe: catch errors, write a safe default (`{}`), and exit 0.
- State writes use atomic tmp+rename helpers; state files use mode `0600` and state directories use `0700`.
- Persisted formats use `schemaVersion: 1`; see [docs/development.md](docs/development.md) for loader/writer rules.
- State lives under `.ao/`: `state/` is transient, `memory/` is durable, and run/team artifacts are swept by lifecycle rules.

## Worker Adapter System

- Workers are selected by adapter priority: Codex `codex-appserver` -> `codex-exec` -> `tmux`; Claude `claude-cli` -> `tmux`; Gemini `gemini-acp` -> `gemini-exec` -> `tmux`.
- Atlas/Athena run `runPreflight()` before orchestration; trivial work stays Claude-only and cross-validation prefers Codex then Gemini.
- Autonomy config resolves as `defaults <- global <- project`; project `.ao/autonomy.json` wins, and CI skips the global layer unless explicitly overridden.
- Session names use stable prefixes such as `atlas-codex-<N>`, `athena-<slug>-gemini-<N>`, and `*-xval-<story-id>`.
- Key files: `scripts/lib/worker-spawn.mjs`, `codex-appserver.mjs`, `codex-exec.mjs`, `claude-cli.mjs`, `gemini-acp.mjs`, `gemini-exec.mjs`, `permission-detect.mjs`.
- Detached worker supervisor -> [docs/internals/worker-adapters.md](docs/internals/worker-adapters.md); permission mirroring -> [docs/internals/permission-mirroring.md](docs/internals/permission-mirroring.md); Gemini credentials -> [docs/internals/credentials.md](docs/internals/credentials.md).

## Deep References

- Hook architecture / per-hook details -> [docs/internals/hooks.md](docs/internals/hooks.md).
- Autonomy config resolution (layered, CI kill-switch) -> [docs/internals/autonomy-config.md](docs/internals/autonomy-config.md).
- Adapter priority + session naming -> [docs/internals/worker-adapters.md](docs/internals/worker-adapters.md).
- schemaVersion convention -> [docs/development.md](docs/development.md).

## Contributing

- Add an agent: follow [docs/development.md#how-to-add-a-new-agent](docs/development.md#how-to-add-a-new-agent).
- Add a skill: follow [docs/development.md#how-to-add-a-new-skill](docs/development.md#how-to-add-a-new-skill).
- Add a hook: follow [docs/development.md#how-to-add-a-new-hook](docs/development.md#how-to-add-a-new-hook).

## Testing

Run the 2313-test Node suite and syntax checks from [docs/testing.md](docs/testing.md). Keep this file under 28 KiB with `node scripts/check-agents-size.mjs`.

## Dependencies

- Runtime: Node.js >= 20.0.0.
- Optional: tmux for legacy worker fallback and Athena team mode.
- Optional: Codex CLI (`npm install -g @openai/codex`) for Codex workers.
- Optional: Gemini CLI (`npm install -g @google/gemini-cli`) for Gemini workers.
- npm packages: none at runtime.

## Known Limitations

- `--bare` Claude Code mode skips hooks, plugins, and skill directory walks, so Agent Olympus hooks will not fire there.
- Claude Code sandbox mode should be used when testing hooks; edge cases can appear around `.ao/` filesystem access.
- Gemini credential auto-resolution supports macOS Keychain and Linux libsecret in v1; Windows users must set `GEMINI_API_KEY`.

## Agent Roles

### Orchestrators (Opus)
| Agent | Role |
|-------|------|
| **atlas** | Hub-and-spoke: one brain delegates to many sub-agents; supports session recovery via checkpoint |
| **athena** | Peer-to-peer: Claude + Codex + Gemini team via adapter system; supports session recovery via checkpoint |

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
| **themis** | Quality gate: tests, lint, namespace, frontmatter, per-AC verification |

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
| `/athena` | "팀으로 해", "team" | Same pipeline but with Claude + Codex + Gemini team (each in git worktree) via adapter system |
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
| `/setup-gemini-auth` | "제미니키체인", "gemini keychain" | macOS-only one-time wizard to create AO-owned Keychain item (v1.1.3) |

## Hooks

| Event | Hook | Purpose |
|-------|------|---------|
| SessionStart | session-start | Inject prior wisdom + interrupted checkpoint context at session start |
| SessionStart | runtime-permissions-capture | Capture runtime `permission_mode` from hook stdin/env to `.ao/state/ao-runtime-permissions.json` (async, v1.1.6) |
| UserPromptSubmit | intent-gate | Classify user intent into 7 categories (multilingual) |
| UserPromptSubmit | runtime-permissions-capture | Refresh runtime `permission_mode` cache so mid-session mode flips are picked up on next turn (async, v1.1.6) |
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
| SessionEnd | session-end | Clean up stale state files older than 24h |
| Stop | stop-hook | Auto-commit uncommitted work as WIP commit on session end |

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
| `.ao/state/ao-concurrency.json` | Active task tracking | Updated per task spawn/complete |
| `.ao/memory/` | Durable design identity and taste memory (`schemaVersion:1`) | Survives SessionEnd and cancel |
| `.ao/state/supervisor/<runId>/` | Detached worker snapshots/manifests | Swept per inactive run |
| `.ao/artifacts/runs/<runId>/` | Run events, summaries, verification, pipeline/loop ledgers | Swept by SessionEnd lifecycle |
| `.ao/artifacts/ask/<jobId>.*` | Async `/ask` raw and rendered outputs | Job-addressable artifacts |
| `.ao/artifacts/pipe/` | Stage handoff/archive pipe (`plan`, `execute`, `verify`, etc.) | 24h SessionEnd sweep |
| `.ao/sessions/<sessionId>.json` | Cross-session registry metadata | 90-day TTL |
| `.ao/teams/<slug>/` | Inbox/outbox for team workers (Claude/Codex/Gemini) | Created by Athena, cleaned on completion |
| `.ao/worktrees/<slug>/<worker>/` | Isolated git worktrees for Athena workers | Created per worker, merged + cleaned on completion |

## Multi-Model Support

| Model | Agent Tier | When Used |
|-------|-----------|-----------|
| Claude Haiku | explore, writer | Fast scans, documentation |
| Claude Sonnet | executor, designer, aphrodite, debugger, ask, reviewers, hephaestus | Standard implementation and review |
| Claude Opus | atlas, athena, metis, prometheus, momus, hermes, architect | Orchestration, analysis, planning |
| OpenAI Codex | hephaestus (via adapter) | Algorithms, large refactoring, deep exploration |
| Google Gemini | (via adapter) | Cross-validation, alternative perspective |

## Key Design Decisions

1. **Self-driving loop** — Atlas/Athena loop until PRD/build/tests/reviews pass; max 15 iterations.
2. **PRD quality enforcement** — Acceptance criteria must be specific and testable.
3. **Progress persistence** — `.ao/wisdom.jsonl` survives cancellation and seeds later sessions.
4. **Multi-adapter worker system** — `ADAPTER_REGISTRY` selects Codex, Gemini, Claude, or tmux fallback adapters.
5. **External skill awareness** — Atlas/Athena can invoke installed plugin skills when they fit.
6. **Zero runtime dependencies** — All scripts use Node.js built-ins only. No npm packages.
7. **Athena worktree isolation** — Parallel workers use `.ao/worktrees/<slug>/<worker>/`.
8. **Fail-safe hooks** — Hooks catch errors and output `{}` so Claude Code is never blocked.
9. **Atomic state writes** — State mutations use tmp+rename via `lib/fs-atomic.mjs`.
10. **tmux injection prevention** — `sanitizeForShellArg()` in `lib/tmux-session.mjs` escapes shell special characters before any `send-keys` call.
