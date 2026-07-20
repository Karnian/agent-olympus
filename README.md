# Agent Olympus

**Language / 언어:** [English](README.md) | [한국어](README.ko.md)

> Self-driving AI orchestrator plugin for Claude Code — zero dependencies, maximum autonomy.

Agent Olympus is a standalone Claude Code plugin that transforms how you build software. Give it a task, and it orchestrates specialized AI agents to complete it autonomously — analyzing requirements, planning execution, implementing changes, verifying results, and fixing issues until everything passes.

Two orchestrators, 19 specialized agents, 37 workflow skills. Zero npm dependencies.

## What It Does

Agent Olympus solves the **supervision problem**: you shouldn't have to babysit AI. Instead, you describe the goal and the orchestrator handles the complexity — planning, routing work to specialized agents, integrating results, catching failures, and looping until the task is truly complete.

Two distinct modes:

- **Atlas** — Hub-and-spoke orchestration. One orchestrator brain analyzes the task, creates a plan, spawns specialized agents in parallel, verifies results, and fixes issues autonomously. Best for independent, parallelizable work.
- **Athena** — Hybrid team orchestration. Claude teammates coordinate through the native task/mailbox lifecycle, while Codex/Gemini remain external workers bridged by the Athena lead through the adapter system (codex-appserver > codex-exec > tmux fallback). Best for large tasks that split into non-overlapping work packages but still benefit from peer discoveries and lead-owned integration.

Both loop until every acceptance criterion is met, the build passes, tests pass, and code review is approved — or escalate with evidence if something is unfixable.

## Features

- **Two orchestrators**: Atlas (hub-and-spoke) and Athena (hybrid native/external team)
- **19 specialized agents**: Explorer, Metis (analysis), Prometheus (planning), Momus (validation), Hermes (spec), Executor, Designer (UI/UX), **Aphrodite (design review)**, Test Engineer, Debugger, Architect, Security Reviewer, Code Reviewer, Writer (docs), Hephaestus (deep coding), Themis (quality gate), Ask, Atlas, Athena
- **37 workflow skills**: atlas, athena, ask, deep-interview, research, trace, cancel, slop-cleaner, git-master, deepinit, deep-dive, consensus-plan, external-context, verify-coverage, plan, tdd, systematic-debug, brainstorm, finish-branch, design-critique, a11y-audit, design-system-audit, ux-copy-review, ui-review, harness-init, sessions, setup-gemini-auth, **teach-design, normalize, polish, typeset, arrange, taste, ui-remediate, resume-handoff**, codex-goal, codex-review
- **Session recovery**: Checkpoint system survives interruptions; resume from any phase
- **Structured wisdom**: Cross-session learnings in JSONL format; persists across runs; intent-aware query expansion
- **Zero npm dependencies**: Node.js built-ins only
- **Multi-model support**: Claude (Opus/Sonnet/Haiku) + Codex/Gemini via adapter system (appserver/exec/tmux fallback)
- **Multilingual intent detection**: English, Korean, Japanese, Chinese pattern matching via IntentGate hook
- **Worker Status Dashboard**: Real-time inline markdown display of all active worker states during Athena team runs
- **Athena worktree isolation**: Each parallel worker runs in an isolated git worktree, preventing silent file overwrites between concurrent workers
- **SessionStart hook**: Automatically injects prior wisdom and interrupted checkpoint context at session start
- **Stop hook WIP commit**: Auto-saves uncommitted work as a WIP commit on session end, except while an Atlas run is active (or its pointer cannot be proven absent), when Atlas preserves the unreviewed tree for its code-owned finalization
- **Atlas executable-control admission**: A fresh `/atlas` requires a real Git HEAD, a clean worktree, and trusted system Git; pre-existing user changes must be committed or stashed first
- **Atomic writes**: All state files use tmp+rename pattern for crash-safe writes
- **Superpowers methodology**: TDD discipline, systematic debugging, brainstorm-first gate, two-stage code review — embedded as native skills (standalone; no Superpowers install required)
- **Post-code automation** *(v0.8)*: After commit — ship-policy-gated push/PR, issue refs, exact-SHA CI watch/fix, CHANGELOG update
- **Ship policy config** *(v0.8, hardened in v1.5.1)*: `.ao/autonomy.json` controls `ship.mode`, PR targeting/update flags, exact-SHA CI watch/retry timing, and `notify.*`; legacy `autoPush` remains compatibility-only
- **OS notifications** *(v0.8)*: Desktop notifications on task complete/blocked/CI events — macOS, Linux, terminal bell fallback
- **Cost awareness** *(v0.8)*: Token cost estimate before long runs; configurable per orchestrator
- **Auto-onboarding** *(v0.8)*: Runs `deepinit` automatically if no `AGENTS.md` found
- **Visual verification** *(v0.8)*: Optional Claude Preview MCP screenshot after UI changes
- **UI/UX design review** *(v0.8.3)*: Aphrodite agent + 5 design skills — critique (Nielsen+Gestalt), a11y audit (WCAG 2.2 AA), design system audit (token leaks), UX copy review, unified UI review
- **L-scale resilience** *(v0.8.8)*: `input-guard` library prevents sub-agent silent failures on large documents — auto-summarizes oversized inputs while preserving story IDs and acceptance criteria. `preflight` library detects and clears stale pointer files in `.ao/` before each run
- **Codex permission mirroring** *(v0.9.5, reworked in v1.1.0)*: Automatically detects Claude's merged permission level (across managed/user/project scopes) and mirrors it to Codex's **sandbox axis** — broad `Bash(*)`+broad `Write(*)` → `danger-full-access`; broad Write/Edit or `acceptEdits` → `workspace-write`; scoped-only grants demote to `suggest`. Approval policy is held at `never` (codex 0.118+ is non-interactive). `.ao/autonomy.json` `codex.approval` overrides default auto-detection
- **Robust hook execution** *(v0.9.8)*: `run.sh` shell wrapper resolves node from nvm/volta/fnm/mise in restricted PATH hook environments; `run.sh || node run.cjs` fallback for Windows; `buildEnhancedPath()` injected into all capability detection child processes
- **Native Teams capability gate** *(hardened after v1.5.1)*: native teams require `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and Claude Code 2.1.178+; the legacy `.ao/autonomy.json` `nativeTeams` boolean remains parseable for compatibility but cannot manufacture runtime capability
- **Gemini permission mirroring** *(v0.9.8)*: `.ao/autonomy.json` `gemini.approval` — auto-detect or override Gemini approval mode (`yolo`, `auto_edit`, `plan`, `default`)
- **Design identity memory** *(v1.0.2)*: `.ao/memory/design-identity.json` — `/teach-design` captures brand colors, typography, spacing, component library; auto-injected into designer/aphrodite/ui-review subagents (hard 2KB cap, worktree-shared, schemaVersion:1)
- **Anti-pattern scan + precision micro-skills** *(v1.0.2, adapted from [impeccable](https://github.com/pbakaus/impeccable))*: `ui-smell-scan` as finish-branch gate (warn default, block opt-in), modular design reference pack (7 domains), `/normalize`, `/polish`, `/typeset`, `/arrange`, `/ui-remediate` audit→normalize→polish→re-audit convergence chain
- **Change-aware review router** *(v1.0.2, hardened after v1.5.1; adapted from [gstack](https://github.com/garrytan/gstack))*: CSS-only diffs minimal-route to the read-only `{aphrodite}` approval reviewer, 30+ security patterns force-include `security-reviewer`, and changes to reviewer prompts or review-gate code force the immutable full reviewer set; `alwaysInclude:["*"]` remains the rollback path
- **Taste memory** *(v1.0.2, adapted from gstack)*: `.ao/memory/taste.jsonl` accumulates user aesthetic preferences across sessions; replayed to designer/aphrodite (1KB cap, 200-entry FIFO, explicit `/taste prune` grammar)
- **Browser pause + manual continue** *(v1.0.2, adapted from gstack)*: `/resume-handoff` — on CAPTCHA/auth/MFA, persists sanitized URL + breadcrumb to `.ao/state/browser-handoff.json` (16 sensitive param strip, allow-list breadcrumb, 24h TTL). Deterministic exact-resume deferred to v1.0.3.
- **Cascade artifact archival pipe** *(v1.0.2, adapted from gstack)*: `.ao/artifacts/pipe/<runId>/<stage>/{inbox,outbox}/` structured stage handoffs (6 canonical stages, 100KB/file + 10MB/run caps, atomic writes). Archival only, NOT prompt-history isolation.
- **`/ask` async path** *(v1.0.4)*: `async / status / collect / cancel / list` subcommands for long-running Codex/Gemini queries that exceed the 120s sync timeout. Job-based with detached runners, JSONL artifact streams, and a `runner_done` sentinel for crash-safe completion reconciliation
- **Plan A permission mirroring** *(v1.1.0)*: Detection reads allow/deny/ask lists from ALL Claude scopes (managed/user/project) and merges with union semantics. Broad-vs-scoped split (only literal `Tool` or `Tool(*)` promotes a tier — wildcard variants like `Bash(*:*)` map to `suggest`). Fail-closed deny/ask rules. Host-sandbox intersection (passive LSM/AppArmor/SELinux/Landlock detection) prevents privilege expansion when the Codex worker would outrun the host's actual sandbox
- **Gemini credential auto-resolver** *(v1.1.1)*: Spawns Gemini workers with `GEMINI_API_KEY` resolved from macOS Keychain or Linux libsecret at runtime — no need to export the key into your shell. Per-`(platform, service, account)` cache with split TTL (24h hit / 60s error / 30s miss). Auto-invalidates on `auth_failed` so `gemini /auth` recovery works in-session
- **Layered autonomy config** *(v1.1.2)*: `.ao/autonomy.json` resolution merges `defaults ← global ← project`, where the global layer is `AO_AUTONOMY_CONFIG` env override OR the first existing file under `$XDG_CONFIG_HOME/agent-olympus/`, `~/.config/agent-olympus/`, or `~/.ao/`. CI kill-switch skips global layer on shared runners (CI / GITHUB_ACTIONS / etc.) unless `AO_AUTONOMY_CONFIG` is set. Symlink guard rejects global configs escaping allowed roots
- **Gemini Keychain wizard** *(v1.1.3, partition-list fix in v1.1.4)*: `/setup-gemini-auth` creates an AO-owned Keychain item with `/usr/bin/security` pre-listed as trusted, eliminating the macOS password prompt every Gemini worker spawn would otherwise trigger. Scoped to keychain users — OAuth/Vertex/env-var paths are unaffected
- **Layered Opus-skew reduction** *(v1.1.0+)*: Per-subagent model usage logging (`ao-model-usage.jsonl`, schemaVersion:1) for measurement; escalation-first routing pipeline that defaults to Sonnet/Haiku and only promotes to Opus on demonstrated need. Summarise with `node scripts/usage-report.mjs`
- **Runtime permission_mode capture + `/ask codex` read-only fallback** *(v1.1.6, hardened after v1.5.1)*: SessionStart + UserPromptSubmit hooks record non-authoritative session identity/diagnostics in `.ao/state/ao-runtime-permissions.json`; the short-lived authoritative grant lives outside the workspace at `~/.cache/agent-olympus/runtime-permissions/<canonical-cwd-sha256>.json`. Promotion requires a hardened current-session + capture-ID match, expires after 30 minutes, and is revoked on SessionEnd; unsafe state falls back to settings-only detection (Windows also stays settings-only until ACL ownership can be proved). The settings ⇧ runtime merge remains **upgrade-only** through the deny/ask/managed-policy pipeline. Independently, `/ask codex` on suggest-tier hosts uses Codex's `read-only` sandbox (`-s read-only -a never`) with a system-prompt guard + `git status --porcelain` post-check. `node scripts/diagnose-sandbox.mjs --explain-permissions` shows the bound layers. Closes #67/#68/#69
- **Detached worker supervisor** *(v1.2.0)*: Adapter team workers (codex-exec/appserver, claude-cli, gemini-exec/acp) no longer run in-process — `spawnTeam` launches a detached supervisor per worker that owns the adapter and writes completion/failure/output to disk, so the fresh-process-per-poll orchestrator (`monitorTeam`/`collectResults`/`shutdownTeam`) finally observes their outcome across the process boundary (they were previously stuck `running` forever). Run-scoped snapshots (schemaVersion:1) with PID start-time identity for crash/reuse detection, supervisor-first shutdown with orphan-group reap, per-run SessionEnd protection, and prompt-bearing-manifest scrubbing. Shipped across P1–P6 phases with 4 Codex cross-review rounds
- **HU-01 P2/P3 evaluation harness** *(v1.5.0+)*: Eight vendored regression/capability tasks support `pass^k`/`pass@k`, token and provider-cost accounting, declared or measured baselines, benchmark/protocol/treatment provenance, and per-agent trend reports. CI exercises hermetic GREEN/RED fixtures only; paid Atlas/Athena/direct-agent runs require explicit operator budgets.
- **Bounded provider failover** *(v1.5.0)*: Exhausted Codex workers move to Gemini when available and then to native Claude, with a fresh retry budget per provider, generation-bound identity, deterministic child teams, and durable completion output. Lost authenticated Claude output fails closed instead of silently rerunning committed work.
- **Crash-safe event-backed runs** *(v1.5.0)*: Active-run CAS, phase evidence, finalization locks, terminal-failure markers, and Athena generation adoption make resume/restart fail closed. Hardened no-follow artifact I/O tolerates a torn run-event JSONL record, preserves later valid events, validates only the appended tail, and allows a definitely dead recovery claimant to be safely re-elected without weakening ABA fences.
- **Sanitized failed-run feedback loop** *(v1.5.0)*: SessionEnd queues only independently verified, session-linked terminal task failures as metadata/digests. A human must approve and link candidates; prompts, error text, paths, diffs, evidence payloads, and provider output never enter the queue.
- **Revocable shipping + exact-SHA CI** *(v1.5.1)*: `ship.mode` (`never` / `ask` / `auto`) is overridden by durable user no-ship follow-ups; push/PR operations bind repository, base, branch, and remote HEAD identity. CI aggregates every workflow for the exact pushed SHA and crash recovery links each fix candidate to one failed run and attempt.
- **Codex MCP recovery + `--no-mcp`** *(v1.5.1)*: `/ask` classifies record-ordered MCP authentication failures across exec and tmux adapters. Codex-only `--no-mcp` skips the entire user-level config, including configured MCP servers, with a fail-closed Codex version gate while preserving authentication and explicit CLI overrides.
- **3360 unit tests**: Current development-tree suite using `node:test` across 134 test files (published v1.5.1 baseline: 2858 tests across 108 files)
- **Fail-safe architecture**: Hooks normally fail open; concurrency admission and the Atlas executable-control gates deliberately block on unsafe, unreadable, or unresolved protected state

## Installation

### Via Marketplace (Recommended)

1. Open Claude Code
2. Go to **Marketplace** → **Productivity**
3. Find **Agent Olympus** by Karnian
4. Click **Install**

### Manual Install

Clone the repository and reference it in your Claude Code plugin directory:

```bash
git clone https://github.com/Karnian/agent-olympus.git ~/.claude/plugins/agent-olympus
```

## Quick Start

### Atlas (Hub-and-Spoke)

Start an autonomous task:

```
/atlas build a user authentication system with login and signup
```

Or describe your task in any language — IntentGate detects intent across English, Korean, Japanese, and Chinese:

```
아틀라스 사용자 로그인 시스템을 구현해줘
/atlas rebuild the payment processing pipeline
```

Atlas will:

1. **Triage** the task (trivial vs. complex)
2. **Analyze** affected files and dependencies
3. **Plan** a structured work breakdown with acceptance criteria
4. **Validate** the plan (catches blocking issues early)
5. **Execute** in parallel using specialized agents
6. **Verify** build, tests, linting
7. **Review** architecture, security, code quality
8. **Finalize** cleanup/changelog/tracker mutations, then re-run every required
   check and bind fresh story evidence to the exact final Git tree
9. **Final review + commit** — commit only the newly reviewed tree; loop on any failure

### Athena (Hybrid Team)

Spawn a coordinated team:

```
/athena build an API with frontend, tests, and documentation
```

Athena will:

1. **Design** a team of Claude workers + Codex workers
2. **Plan** task assignments and handoff points
3. **Bootstrap** the first native Claude teammate, establish the shared task
   graph, then launch the remaining Claude teammates in parallel
4. **Spawn** Codex/Gemini adapter workers and bridge cross-provider context
5. **Monitor** and integrate every isolated worktree
6. **Verify** and run the initial routed review
7. **Finalize, re-verify, and re-review** the exact final tree before commit
8. **Loop** until all worker outputs and final mutations are tested and approved

### Resume Interrupted Work

If a session is interrupted:

```
/atlas [previous task]
```

Atlas detects the checkpoint and offers to resume:

```
[Previous session found: Phase 3/EXECUTE. Completed: 2/5 stories.
Resume from Phase 3 or restart?]
```

Reply `resume` to pick up where you left off.

### Post-Code Automation (New in v0.8.0)

After `/atlas` or `/athena` completes and commits, the SHIP phase runs automatically:

1. Resolves `ship.mode` (`never`, `ask`, or `auto`) and re-checks durable no-ship follow-ups before every release side effect
2. Binds repository, base, branch, and SHA identity before pushing and creating or reusing a PR
3. Aggregates every workflow for the exact pushed SHA until all required runs pass or a terminal failure is known
4. On CI failure: links one bounded fix candidate to the failed run, fixes, pushes, and re-polls up to `ci.maxCycles` (default 2)
5. Sends desktop notification on completion or block

Configure by creating `.ao/autonomy.json` in your project:

```json
{
  "ship": {
    "mode": "ask",
    "baseBranch": null,
    "draftPR": true,
    "updateChangelog": true,
    "updateTechDebtTracker": true
  },
  "ci": {
    "watchEnabled": true,
    "maxCycles": 2,
    "pollIntervalMs": 30000,
    "timeoutMs": 600000
  },
  "notify": {
    "onComplete": true,
    "onBlocked": true,
    "onCIFail": true,
    "sound": true
  },
  "budget": { "warnThresholdUsd": null }
}
```

### Methodology Skills (New in v0.7.0)

- **`/tdd`** — Test-driven development: write failing test first, then minimum code to pass, then refactor
- **`/brainstorm`** — Design-before-code: diverge (many options) → converge (filter) → refine (approve) before any implementation
- **`/systematic-debug`** — Root-cause-first debugging: reproduce consistently → isolate to component → understand cause → minimal fix → verify
- **`/finish-branch`** — Structured branch completion: tests → lint → coverage → review → present merge options

### Other Skills

- **`/ask`** — Quick single-shot query to Codex or Gemini
- **`/research`** — Parallel web research for external docs and APIs
- **`/deep-interview`** — Socratic clarification for ambiguous requirements
- **`/trace`** — Evidence-driven root-cause analysis when debugger is stuck
- **`/slop-cleaner`** — Clean AI-generated bloat before final commit
- **`/git-master`** — Atomic, well-structured commit discipline
- **`/deepinit`** — Generate codebase map (AGENTS.md) for orientation
- **`/cancel`** — Gracefully stop a running orchestrator and clean up state
- **`/deep-dive`** — Exhaustive single-topic investigation with multi-angle synthesis
- **`/consensus-plan`** — Multi-agent planning consensus (Prometheus + Momus) before execution
- **`/external-context`** — Fetch and inject external documentation or specs into the active context
- **`/verify-coverage`** — Detect test coverage gaps for recently changed files and generate missing tests

### UI/UX Design Review Skills (New in v0.8.3)

- **`/ui-review`** — Comprehensive UI review: chains design-critique + a11y-audit + design-system-audit + ux-copy-review in parallel
- **`/design-critique`** — Structured design feedback using Nielsen 10 heuristics + Gestalt principles + WCAG standards
- **`/a11y-audit`** — WCAG 2.2 AA accessibility audit via code review only — no browser tools needed
- **`/design-system-audit`** — Audit for token leaks (hardcoded colors, spacing), component API consistency, missing states
- **`/ux-copy-review`** — Review error messages, CTAs, empty states, labels for clarity, consistency, and tone

## Orchestrators

### Atlas: Hub-and-Spoke

**When to use:**
- Task has independent, parallelizable components
- You want one orchestrator brain making all routing decisions
- Standard implementation, testing, review workflows

**Architecture:**

```
User Request
    ↓
[Triage] → Trivial? → Execute directly
    ↓ Moderate+
[Analyze] (Metis: deep requirements, risks, unknowns)
    ↓
[Plan] (Prometheus: structured work breakdown)
    ↓
[Validate] (Momus: catches blocking issues)
    ↓
[Execute] (Parallel agents: executor, designer, test-engineer, debugger, etc.)
    ↓
[Verify] (Build + tests + lint)
    ↓ Failures?
[Debug] (Debugger agent fixes issues, loops back)
    ↓
[Review] (Architect + Security + Code Quality reviewers)
    ↓ Rejections?
[Fix & Re-review] (Loops until approved)
    ↓
[Finalize] (Cleanup + release-document mutations)
    ↓
[Re-verify + Final Review] (Fresh evidence bound to exact Git tree)
    ↓
[Commit] (Only the newly approved tree)
```

**Phases:**

1. **Triage** — Classify complexity, decide strategy
2. **Analyze** — Requirements, risks, dependencies
3. **Plan + Validate** — Work breakdown with acceptance criteria
4. **Execute** — Parallel agent work
5. **Verify** — Build, tests, lint
6. **Review** — Architecture, security, code quality
7. **Finalize mutations** — Slop cleanup plus resumable changelog/tracker updates
8. **Final-tree lock** — Re-run story evidence, route a fresh review package,
   then commit only the tree bound to `reviewTreeOid`

### Athena: Hybrid Native/External Team

**When to use:**
- Task can be split into non-overlapping packages owned by separate workers
- Workers benefit from sharing discoveries in real-time without cross-worker execution dependencies
- Large-scale work across many files and multiple specialties

**Architecture:**

```
[Athena Lead] ← Orchestrator (NEVER implements, only coordinates)
    ↓
    ├─→ Claude Native Team (SendMessage, TaskList)
    │   ├─ API Worker (executor)
    │   ├─ Frontend Worker (designer)
    │   ├─ Test Worker (test-engineer)
    │   └─ Docs Worker (writer)
    │
    └─→ Codex/Gemini Workers (via adapter system)
        ├─ Algorithm Worker
        └─ Refactoring Worker
```

**Phases:**

1. **Triage & Team Design** — Map task into independent scopes
2. **Plan** — Task assignments, dependencies, handoff protocol
3. **Bootstrap Native Team** — Launch one Claude teammate, establish shared
   tasks, then fan out the remaining native teammates
4. **Monitor & Coordinate** — Bridge communication, unblock workers
5. **Integrate & Verify** — Merge outputs, run build + tests
6. **Review** — All reviewers, fix rejections
7. **Finalize mutations** — Cleanup and resumable release-document updates
8. **Final-tree lock** — Fresh per-story verification, routed review, and
   tree-bound commit

**Key Difference from Atlas:**

| Aspect | Atlas | Athena |
|--------|-------|--------|
| Communication | Hub-and-spoke (lead controls all) | Claude teammates share natively; Codex/Gemini use lead relay |
| Discovery sharing | Lead relays insights | Native Claude mailbox plus explicit cross-provider bridge |
| Best for | Independent tasks | Non-overlapping work packages that benefit from discovery sharing |
| Overhead | Lower | Higher but more collaborative |

## Agents (19 Total)

| Agent | Model | Role |
|-------|-------|------|
| **atlas** | Opus | Hub-and-spoke orchestrator — triage, analyze, plan, execute, verify, review, loop |
| **athena** | Opus | Hybrid team orchestrator — own shared tasks, bridge external providers, integrate isolated worktrees |
| **metis** | Opus | Deep analysis — affected files, hidden requirements, risks, unknowns, recommendations |
| **prometheus** | Opus | Strategic planner — work breakdown, parallelization, acceptance criteria, file ownership |
| **momus** | Opus | Plan validator — catches blocking issues before execution begins (clarity, verification, context) |
| **hermes** | Opus | Product planning specialist — transforms vague ideas into executable specs (forward & reverse PRD) |
| **explore** | Haiku | Fast codebase scanner — architecture, file structure, tech stack, test framework |
| **executor** | Sonnet | Implementation specialist — handles standard coding tasks, focused execution |
| **designer** | Sonnet | UI/UX implementation specialist — builds accessible, responsive interfaces with design system discipline |
| **aphrodite** | Sonnet | UI/UX design reviewer (read-only) — Nielsen heuristics, Gestalt principles, WCAG 2.2 AA critique |
| **test-engineer** | Sonnet | Test specialist — designs comprehensive test strategies, writes robust tests |
| **debugger** | Sonnet | Root-cause analyzer — systematically diagnoses and fixes bugs |
| **hephaestus** | Sonnet | Deep autonomous coder — exploratory end-to-end multi-file tasks |
| **architect** | Opus | Architecture reviewer (read-only) — structural integrity, module boundaries |
| **security-reviewer** | Sonnet | Security reviewer (read-only) — OWASP Top 10, common vulnerabilities |
| **code-reviewer** | Sonnet | Code quality reviewer (read-only) — standards, patterns, maintainability |
| **themis** | Sonnet | No-direct-edit quality gate — executes project checks; exact-tree freshness rejects side effects |
| **writer** | Haiku | Documentation specialist — clear, accurate technical docs and code comments |
| **ask** | Sonnet | Quick single-shot dispatcher — routes questions to Codex/Gemini workers |

## Skills (37 Total)

| Skill | Level | Aliases | Use Case |
|-------|-------|---------|----------|
| **atlas** | 5 | `atlas`, `아틀라스`, `do-it`, `해줘`, `just-do-it` | Autonomous hub-and-spoke orchestration |
| **athena** | 5 | `athena`, `아테나`, `team-do-it`, `팀으로해`, `collaborate` | Autonomous hybrid native/external team orchestration |
| **plan** | 4 | `plan`, `계획`, `spec`, `기획`, `prd`, `역기획` | Adaptive product planner — forward (idea→spec) and reverse (code→spec) |
| **tdd** | 3 | `tdd`, `test-driven`, `테스트주도개발`, `red-green-refactor` | Test-driven development — RED→GREEN→REFACTOR discipline |
| **brainstorm** | 3 | `brainstorm`, `브레인스토밍`, `design-first`, `설계먼저` | Design-before-code — diverge→converge→refine with approval gate |
| **systematic-debug** | 3 | `systematic-debug`, `체계적디버깅`, `root-cause-debug`, `디버그` | Root-cause-first debugging — reproduce→isolate→understand→fix→verify |
| **finish-branch** | 2 | `finish-branch`, `브랜치완료`, `finish`, `완료` | Structured branch completion with verified checklist before merge |
| **ask** | 2 | `ask`, `물어봐`, `codex`, `gemini`, `quick-ask` | Quick single-shot query to Codex/Gemini |
| **codex-goal** | 3 | `codex-goal`, `코덱스에위임` | Delegate one bounded goal to Codex with Claude-hosted verification |
| **codex-review** | 3 | `codex-review`, `코덱스리뷰` | Independent Codex PASS/FAIL review gate for the current diff |
| **deep-interview** | 4 | `deep-interview`, `인터뷰`, `clarify`, `명확하게` | Socratic requirements clarification |
| **research** | 3 | `research`, `조사`, `외부정보`, `lookup` | Parallel web research for external knowledge |
| **trace** | 3 | `trace`, `추적`, `root-cause`, `원인분석` | Evidence-driven root-cause analysis |
| **slop-cleaner** | 3 | `slop-cleaner`, `deslop`, `슬롭`, `cleanup` | AI bloat removal with regression safety |
| **git-master** | 2 | `git-master`, `commit`, `커밋`, `atomic` | Atomic commit discipline and history |
| **deepinit** | 2 | `deepinit`, `init`, `초기화`, `map-codebase` | Generate AGENTS.md codebase documentation |
| **cancel** | 1 | `cancel`, `취소`, `stop`, `abort` | Graceful session shutdown and cleanup |
| **deep-dive** | 3 | `deep-dive`, `깊게파봐`, `exhaustive` | Exhaustive single-topic investigation with synthesis |
| **consensus-plan** | 4 | `consensus-plan`, `합의`, `consensus` | Multi-agent planning consensus before execution |
| **external-context** | 2 | `external-context`, `외부문서`, `docs`, `inject-docs` | Fetch and inject external docs/specs into context |
| **verify-coverage** | 3 | `verify-coverage`, `coverage`, `커버리지`, `test-gaps` | Detect test coverage gaps for recently changed files |
| **ui-review** | 3 | `ui-review`, `UI리뷰`, `종합UI검토`, `full-design-review` | Comprehensive UI review — chains 4 design review skills |
| **design-critique** | 2 | `design-critique`, `디자인리뷰`, `design-review` | Structured design critique (Nielsen + Gestalt + WCAG) |
| **a11y-audit** | 2 | `a11y-audit`, `접근성검사`, `accessibility-audit` | WCAG 2.2 AA accessibility audit via code review |
| **design-system-audit** | 2 | `design-system-audit`, `디자인시스템검사`, `ds-audit` | Design system health: token leaks, component consistency |
| **ux-copy-review** | 2 | `ux-copy-review`, `카피리뷰`, `copy-review` | UX copy quality: clarity, consistency, tone, inclusivity |
| **harness-init** | 2 | `harness-init`, `하네스초기화`, `setup-harness` | Initialize testing harness and framework scaffolding |
| **sessions** | 1 | `sessions`, `세션`, `history` | Browse and inspect prior Atlas/Athena session artifacts |
| **teach-design** *(v1.0.2)* | 3 | `teach-design`, `디자인알려줘`, `brand-identity` | Capture brand identity (colors, typography, spacing, components) into `.ao/memory/design-identity.json` |
| **normalize** *(v1.0.2)* | 2 | `normalize`, `정규화`, `ui-normalize` | Precision micro-skill — normalize UI to design system tokens |
| **polish** *(v1.0.2)* | 2 | `polish`, `다듬기`, `ui-polish` | Precision micro-skill — final UI refinement and polish pass |
| **typeset** *(v1.0.2)* | 2 | `typeset`, `타이포`, `typography` | Precision micro-skill — typography hierarchy and rhythm fixes |
| **arrange** *(v1.0.2)* | 2 | `arrange`, `정렬`, `layout-arrange` | Precision micro-skill — spacing and layout alignment fixes |
| **taste** *(v1.0.2)* | 2 | `taste`, `취향`, `aesthetic-memory` | Persist user aesthetic preferences into `.ao/memory/taste.jsonl` (gstack-inspired) |
| **ui-remediate** *(v1.0.2)* | 4 | `ui-remediate`, `UI개선`, `ui-fix-chain` | Sequential audit→normalize→polish→re-audit convergence chain |
| **resume-handoff** *(v1.0.2)* | 2 | `resume-handoff`, `브라우저이어서`, `browser-resume` | Resume work after browser pause (CAPTCHA/auth/MFA) via sanitized handoff state |
| **setup-gemini-auth** *(v1.1.3)* | 1 | `setup-gemini-auth`, `제미니키체인`, `gemini keychain` | macOS-only wizard that creates an AO-owned Keychain item to eliminate the per-spawn password prompt for Gemini API-key users |

## Architecture

### Directory Structure

```
agents/              Agent persona definitions (.md files with model + role)
skills/              User-facing workflow skills (SKILL.md with triggers, steps)
scripts/             Hook scripts (Node.js ESM, zero dependencies)
  lib/               Orchestration, hardened artifacts, adapters, and recovery
  run.cjs            Universal hook entry point with version fallback
config/              Model routing configuration (JSONC)
hooks/               Hook event registrations (hooks.json)
.claude-plugin/      Plugin metadata (plugin.json, marketplace.json)
```

### Key Design Principles

1. **Fail-Safe Hooks**: Every hook catches errors and outputs JSON, never throws
2. **State Isolation**: Per-orchestrator checkpoint, transient state files in `.ao/state/`
3. **Wisdom Persistence**: Cross-session learnings in `.ao/wisdom.jsonl` (JSONL format)
4. **Checkpoint Recovery**: 24-hour TTL; resume from any phase after interruption
5. **Zero Dependencies**: Node.js ≥ 20.0 only; no npm packages at runtime

### Session State Management

**Checkpoints** (`.ao/state/checkpoint-<orchestrator>.json`):
- Saved after each phase transition
- Contains: orchestrator, phase, prdSnapshot, completedStories, activeWorkers, taskDescription
- TTL: 24 hours (auto-cleared if stale)
- Purpose: Resume interrupted sessions

**PRD** (`.ao/prd.json`):
- Common AO_SPEC_V1 fields: `mode`, `scale`, `goals`, `nonGoals`,
  `constraints`, `risks`, `openQuestions`; product features also require
  `targetUsers` and measurable `successMetrics`
- Stories use unique IDs, non-empty uppercase `GIVEN ... WHEN ... THEN ...`
  criteria, and `passes: true/false`
- Atlas assignment: `assignTo`, `model`, an allowlisted Claude `agentType`,
  explicit `scope`, and `parallelGroup`; Athena assignment: `assignedWorker`,
  `workerType`, `model`, an allowlisted Claude `agentType`, explicit `scope`,
  and `parallelGroup`
- Purpose: Track execution progress against requirements

**Wisdom** (`.ao/wisdom.jsonl`):
- JSONL format (one entry per line)
- Categories: test, build, architecture, pattern, debug, performance, general
- Entries survive across sessions (never auto-delete)
- Automatically pruned to 200 most recent entries after completion
- Purpose: Cross-session learnings reduce friction in future runs

**Teams** (`.ao/teams/<slug>/`) — Athena only:
- Per-worker communication directories for Codex/Gemini (adapter-managed)
- Cleaned up after team completion

**Worktrees** (`.ao/worktrees/<slug>/<worker>/`):
- Isolate parallel workers so file changes do not collide
- `/codex-goal` gives every goal a unique worktree and fails without mutation if
  its intended path or branch already exists
- The legacy replacement policy is only for disposable stale/cancelled workers:
  it preserves unmerged commits under an `-orphan-<timestamp>` branch but
  discards uncommitted and untracked files in the replaced worktree
- Ambiguous stale metadata and concurrent replacement races fail closed; inspect
  the reported worktree/branch and prune confirmed-stale metadata before retrying

## Session Recovery

If Claude Code crashes or closes during an orchestration:

1. Run `/atlas [previous task]` or `/athena [previous task]`
2. Orchestrator detects stale checkpoint (< 24h old)
3. Presents options: **Resume** or **Restart**
   - **Resume** → Skip completed phases, restore story state, continue from where you left off
   - **Restart** → First terminalize the exact active run and verify that its
     matching active-run pointer was cleared; only then clear its checkpoint and
     create a fresh run. A missing, corrupt, linked, or identity-unproven Athena
     orphan is preserved with its teams/worktrees and stops for recovery — deleting
     a checkpoint alone never authorizes a restart.

This works because checkpoints are a recovery cache, while the active-run pointer,
summary, and pipeline ledger remain the durable run-identity authority.
Operational `events.jsonl` recovery skips a malformed/torn record without hiding
later valid events; phase/finalization ensures repair the line boundary and
verify only their exact appended tail.

## Wisdom System

Agent Olympus learns from every execution. After each story, agents contribute learnings:

```javascript
addWisdom({
  category: 'pattern',
  lesson: 'Codebase uses snake_case for API response keys',
  confidence: 'high'
})

addWisdom({
  category: 'debug',
  lesson: 'TypeScript strict mode requires explicit return types on async functions',
  confidence: 'high'
})
```

**Categories:**
- `test` — Test framework quirks, patterns that work
- `build` — Build tool behavior, compilation requirements
- `architecture` — Structural decisions, module boundaries
- `pattern` — Codebase conventions, naming, error handling
- `debug` — Pitfalls, root causes, antipatterns
- `performance` — Optimization findings
- `general` — Everything else

**Persistence:**
- Stored in `.ao/wisdom.jsonl` (JSONL format)
- Survives across sessions indefinitely
- Automatically pruned to 200 most recent entries + auto-cleanup of entries older than 90 days
- Never auto-deleted (you choose when to clear)

Later sessions query wisdom to accelerate analysis, avoid repeating mistakes, and leverage codebase knowledge.

## Multi-Model Support

### Claude Models

- **Haiku** — Fast exploratory tasks (codebase scans, documentation)
- **Sonnet** — Standard implementation (most executor, designer, test work)
- **Opus** — Complex reasoning (analysis, planning, architecture, security review)

### Codex / Gemini (via Adapter System)

For algorithmic work, large refactoring, or exploratory coding, orchestrators spawn Codex/Gemini workers through a strategy-pattern adapter system. The adapter is auto-selected by priority:

| Worker Type | Priority |
|-------------|----------|
| **Codex** | codex-appserver (JSON-RPC 2.0) → codex-exec (JSONL) → tmux (legacy fallback) |
| **Gemini** | gemini-acp (JSON-RPC 2.0) → gemini-exec (JSON) → tmux (legacy fallback) |
| **Claude** | claude-cli (stream-json) → tmux (legacy fallback) |

The permission level is automatically resolved from Claude's permission level (see [Permission Mirroring](#features)). Override via `.ao/autonomy.json` `codex.approval` or `gemini.approval`.

Session naming convention:
- Atlas: `atlas-codex-<N>`, `atlas-gemini-<N>`
- Athena: `athena-<slug>-codex-<N>`, `athena-<slug>-gemini-<N>`

## Requirements

- **Node.js** ≥ 20.0.0 (for ESM support)
- **Claude Code** 2.1.214 or newer is the validated support baseline for `UserPromptExpansion` and skill-scoped `hooks:` (2.1.214 is the tested floor, not a claim that every earlier build lacks both capabilities). A build without `UserPromptExpansion` cannot inject the direct `/atlas` bootstrap reminder, so `/atlas` intentionally stops; a build without skill-scoped hooks lacks the premature-Stop gate and is unsupported.
- **Trusted VCS binaries** are resolved only from fixed system roots. Trusted Git is required to start a fresh Atlas run and to collect ship/CI evidence; trusted `gh` is required for GitHub repository and PR evidence. nix/asdf/mise-only installations are not discovered.
- **Optional**: tmux (legacy fallback for all worker types when native adapters are unavailable)
- **Optional**: codex CLI (`npm install -g @openai/codex`) for Codex worker execution
- **Optional**: gemini CLI (`npm install -g @google/gemini-cli`) for Gemini worker execution
- **npm packages**: None (zero runtime dependencies)

## Project Structure for Contributors

### Adding a New Agent

1. Create `agents/<name>.md` with frontmatter:

```yaml
---
model: sonnet  # haiku | sonnet | opus
description: One-line description
---
```

2. Write the persona prompt below the frontmatter
3. Reference it in skills/SKILL.md as `agent-olympus:<name>`

### Adding a New Skill

1. Create `skills/<name>/SKILL.md` with frontmatter:

```yaml
---
name: <name>
description: One-line description (include key trigger keywords for discoverability)
---
```

2. Write workflow steps
3. Reference agents via `Task(subagent_type="agent-olympus:<agent>", model="<tier>", prompt="...")`

### Adding a New Hook

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

### Syntax Checking

Verify all scripts are valid:

```bash
for f in scripts/*.mjs scripts/lib/*.mjs; do node --check "$f" && echo "OK: $f"; done
```

Check for stale namespace references:

```bash
grep -r "oh-my-claude:" agents/ skills/ scripts/ config/
grep -r "oh-my-claudecode:" skills/ agents/
grep -r '\.omc/' scripts/ skills/ agents/
```

## Testing Notes

A `node:test` based test suite (3360 tests across 134 files in the current development tree; 2858 tests across 108 files in the published v1.5.1 baseline) covers the core hook libraries. To run:

```bash
npm test
# or, invoke the cross-platform Node test enumerator directly
node scripts/run-tests.mjs
```

**Representative covered modules:** phase-runner, run-artifacts, run-failure,
recovery-claim, hardened-fs, athena-recovery, orphan-run-recovery,
eval-failure-candidates, worker-spawn, checkpoint, worktree

Additional integration verification:

1. Syntax check all scripts (see above)
2. Run a trivial `/atlas` task in Claude Code
3. Run an `/athena` task to verify team orchestration
4. Check `.ao/wisdom.jsonl` is populated after completion
5. Verify checkpoints can be resumed after interruption

## Philosophy

Agent Olympus embodies three core principles:

1. **Autonomy**: You describe the goal; the orchestrator handles the details. No babysitting.
2. **Verification**: Loops until every criterion is met. Failures are fixed, not ignored.
3. **Learning**: Wisdom persists across sessions. Each run makes the next run faster.

The name is deliberate. Atlas carries the world. Athena leads the team. Together, they complete any task you ask.

## Acknowledgements

This project was inspired by and references ideas from:

- [Oh My Claude Code](https://github.com/Yeachan-Heo/oh-my-claudecode) — Multi-agent orchestration plugin for Claude Code
- [Oh My OpenAgent](https://github.com/code-yeongyu/oh-my-openagent) — Batteries-included agent harness with multi-model orchestration
- [Kimoring AI Skills](https://github.com/codefactory-co/kimoring-ai-skills) — SessionStart/Stop hook patterns, coverage gap detection concept
- [Superpowers](https://github.com/obra/superpowers) — TDD discipline, systematic debugging methodology, brainstorm-first gate, verification-before-completion iron law, two-stage code review protocol (v0.7.0)
- [claw-code](https://github.com/instructkr/claw-code) — Claude Code Python clean-room rewrite; source structure analysis informed v0.9 module design (plugins/hooks/skills/services)
- [impeccable](https://github.com/pbakaus/impeccable) — Apache 2.0 — modular design reference pack (7 domains), executable anti-pattern registry, project-specific design briefing, and precision style-pass micro-skills; basis for v1.0.2 design-quality stories US-001 through US-004 and US-008
- [gstack](https://github.com/garrytan/gstack) — MIT — change-aware review router, browser handoff/resume, cascade artifact pipe, taste memory, and TTHW benchmarking; basis for v1.0.2 orchestration efficiency stories US-005 through US-007, US-009, and US-010

### Inspiration

Additional projects and patterns researched during planning that influenced design decisions, even where no code was directly adapted:

- **Happy Coder** — phone push notifications and remote approval for long-running agent tasks
- **CC Notify** — lightweight desktop notification hooks for Claude Code
- **Ralph Loop** (awesome-ralph) — autonomous restart pattern with intelligent exit detection and circuit breakers
- **Trail of Bits Security Skills** — CodeQL/Semgrep integration beyond pure LLM-based security review
- **Claude Squad** — terminal UI for managing multiple agent sessions in parallel
- **Container Use** — Docker-isolated execution environments for parallel agents
- **Compound Engineering Plugin** — structured mistake-to-lesson pipeline (compared against our wisdom system)
- **Claude-Mem** — cross-session long-term memory with semantic retrieval
- **Ruflo** — vector-based multi-layered memory for agent swarms
- **anthropics/claude-plugins-official** and curated lists (awesome-claude-code, ccplugins) — broader Claude Code plugin ecosystem reference

## License

MIT

## Author

Karnian

## Links

- **Repository**: [https://github.com/Karnian/agent-olympus](https://github.com/Karnian/agent-olympus)
- **Issues**: [https://github.com/Karnian/agent-olympus/issues](https://github.com/Karnian/agent-olympus/issues)
