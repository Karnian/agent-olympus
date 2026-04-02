# Changelog

## [0.9.3] - 2026-04-02

### Added — Cross-Session Management System

세션 간 지식 공유 및 추적 시스템. 새 세션에서 이전 세션 작업을 조회하고, 필요 시 잠든 세션을 재개할 수 있음.
Codex(GPT-5.4) + Claude code-reviewer 교차검증 완료.

#### Session Registry (`scripts/lib/session-registry.mjs`) *(new)*
- `registerSession()` — SessionStart 훅에서 세션 메타데이터 기록
- `finalizeSession()` — SessionEnd 훅에서 세션 종료 처리
- `recoverCrashedSession()` — 비정상 종료 감지 + 자동 복구 (isSessionAlive 확인 후 마킹)
- `linkRunToSession()` — Atlas/Athena run을 세션에 연결
- `getCurrentSessionId()`, `getSession()`, `listSessions()` — 세션 조회
- `isSessionAlive()` — `~/.claude/sessions/` 확인으로 재개 가능 여부 판별
- `pruneSessions()` — 90일 TTL 기반 정리 (active 세션 보호)
- 저장소: `.ao/sessions/<sessionId>.json` (프로젝트 루트, worktree 공유)
- 포인터: `.ao/state/ao-current-session.json` (crash recovery용)

#### SessionStart Hook 확장 (`scripts/session-start.mjs`)
- crash recovery: 이전 세션 포인터 잔존 시 crashed로 마킹 + 알림
- 새 세션 등록: stdin의 `session_id`로 `registerSession()` 호출

#### SessionEnd Hook 확장 (`scripts/session-end.mjs`)
- 세션 종료 기록: `finalizeSession(sessionId, { status: 'ended' })`
- 10% 확률 자동 정리: `pruneSessions()` (오버헤드 방지)

#### Run-Artifacts 연동 (`scripts/lib/run-artifacts.mjs`)
- `createRun()` 시 현재 sessionId를 summary에 포함 + `linkRunToSession()` 호출

#### `/sessions` 스킬 *(new)* (`skills/sessions/SKILL.md`)
- `/sessions` — 최근 세션 목록 + 활성 checkpoint + resume 가능 여부
- `/sessions <id>` — 세션 상세 + 관련 run 정보
- `/sessions search <keyword>` — branch명, CWD 기반 검색
- `/sessions cleanup` — 90일+ 기록 정리 + stale state 정리
- `/sessions resume <id>` — tmux에서 `claude -r <id>` 실행으로 세션 재개

### Fixed — Cross-Validation Bug Fixes (Codex + Claude code-reviewer)

- **CRITICAL**: `currentSessionPath()` — `process.cwd()` → `resolveProjectRoot()` 변경. worktree에서 포인터 파일 경로 불일치로 crash recovery 오작동하던 문제 수정
- **HIGH**: `recoverCrashedSession()` — `isSessionAlive()` 체크 추가. 동시 세션 환경에서 살아있는 세션을 crashed로 잘못 마킹하는 문제 수정
- **HIGH**: `pruneSessions()` — `status === 'active'` 세션 skip 가드 추가. active 세션이 TTL에 의해 삭제되는 문제 수정

### Meta

- Version: **0.9.2 → 0.9.3**
- Test count: **550 → 575** (+25 new tests, 0 failures)
- Test files: **36 → 37** (`session-registry.test.mjs`)
- Skill count: **25 → 26** (`sessions`)
- Cross-validation: Codex (GPT-5.4) + Claude code-reviewer — CRITICAL 1건, HIGH 2건, MEDIUM 1건 발견 및 수정
- Branch: `claude/vigorous-rhodes`

## [0.9.0] - 2026-04-01

### Added — Source-Informed Improvements (PR #11)

Claude Code 소스 구조(claw-code) 분석 + Codex 교차검증을 통해 도출한 4개 모듈 구현.
Athena 팀 오케스트레이션(4 workers)으로 병렬 구현 후 코드리뷰에서 Critical 2건 수정.

#### E1. Stuck Recovery Policy (`scripts/lib/stuck-recovery.mjs`) *(new)*
- 스톨된 워커 자동 복구 3-tier 체인: reframe → switch-agent → escalate
- 에이전트 에스컬레이션 래더: executor → debugger → hephaestus
- `worker-spawn.mjs`의 stall 감지 시 자동 호출, wisdom에 stuck 패턴 기록
- **Critical fix**: `buildRecoveryStrategy`를 async→sync로 변경 — fire-and-forget `.then()`이 workerEntry 반환 후 mutate하는 레이스 컨디션 해결

#### E2. Team Blackboard (`scripts/lib/inbox-outbox.mjs`)
- `writeBlackboard(teamName, workerName, entry)` — JSONL append-only 공유 지식 보드
- `readBlackboard(teamName, opts)` — category/limit/since 필터링
- 카테고리: discovery, decision, warning, api-note
- 기존 inbox/outbox 시스템 보완 (대체 아님)

#### E3. Run Artifacts (`scripts/lib/run-artifacts.mjs`) *(new)*
- `createRun`, `addEvent`, `addVerification`, `finalizeRun`, `listRuns`, `getRun`
- Run ID: `<orchestrator>-YYYYMMDD-HHmmss-<rand4hex>`
- 이벤트: `events.jsonl` (append-only), 요약: `summary.json` (atomic write), 검증: `verification.jsonl`
- **Critical fix**: `addVerification`을 JSON read-modify-write → JSONL append-only로 변경 — 동시 접근 시 데이터 유실 방지

#### E6. Capability Detection (`scripts/lib/preflight.mjs`)
- `detectCapabilities()` — tmux, codex, git worktree, team tools, preview MCP 런타임 감지
- `formatCapabilityReport(caps)` — ✓/✗ 기호로 세션 시작 시 자동 리포트
- **Fix**: clean run에서 리포트가 누락되던 early-return 가드 제거

### Meta

- Version: **0.8.8 → 0.9.0**
- Test count: **424 → 470** (+46 new tests, 0 failures)
- Test files: **28 → 30**
- New test files: `stuck-recovery.test.mjs` (13), `run-artifacts.test.mjs` (14), blackboard tests (+10), capability tests (+9)
- Codex cross-validation: 4/4 PASS
- Code review: Critical 2건 해결 (fire-and-forget race, read-modify-write race)
- Branch: `feat/v0.9-source-informed`
- Reference: [claw-code](https://github.com/instructkr/claw-code) — Claude Code Python clean-room rewrite

## [0.8.8] - 2026-04-01

### Fixed — Silent failure on L-scale tasks (Issue #9)

Three root causes were identified and resolved:

**Root cause 1: L-scale input exceeded sub-agent effective context limits**
- **`scripts/lib/input-guard.mjs`** *(new)* — Input size guard library. Estimates token count from text (CJK-aware), checks against per-tier effective limits (haiku: 30k tokens/500 lines, sonnet: 80k/1500, opus: 150k/3000), and extracts structural summaries when limits are exceeded. Structural extraction preserves headings, user story IDs (US-NNN, RF-NNN), GIVEN/WHEN/THEN acceptance criteria, list items, and table rows — stripping verbose prose. Summary target is tier limit ÷ 4 to leave headroom for orchestrator prompt + response generation. Bug fix: heading-embedded story IDs (e.g. `### US-001: Title`) now correctly extracted alongside body-level story IDs
- **`skills/plan/SKILL.md`** — Phase 1 now runs `checkInputSize()` before calling Hermes; for unsafe inputs calls `prepareSubAgentInput()` to produce a structural summary first, then passes `prepared.text` to Hermes instead of the raw document
- **`skills/athena/SKILL.md`** — Phase 0 runs `checkInputSize()` before calling Metis; same summarization path
- **`skills/atlas/SKILL.md`** — Phase 0 runs `checkInputSize()` before calling Metis/Explore; same summarization path

**Root cause 2: Stale pointer files blocked spec creation**
- **`scripts/lib/preflight.mjs`** *(new)* — Preflight validation library. Detects pointer files in `.ao/spec.md` and `.ao/prd.json` (pattern matching: `# Pointer` heading, bare file paths ≤2 lines, JSON with only `canonical`/`ref` field), removes them, and warns about orphaned team state files (>2h old, still running). Also cleans expired checkpoints (>24h) that `loadCheckpoint()` would have silently ignored
- **`scripts/session-start.mjs`** — Now calls `runPreflight()` on every session start before loading checkpoints or wisdom; actions/warnings injected into `additionalContext` under `## Preflight`

**Root cause 3: No checkpoint before Phase 0 sub-agent calls**
- **`skills/athena/SKILL.md`** — `saveCheckpoint()` now called **before** Metis invocation (was: after). Phase 0 checkpoint (`phase: 0`) is written immediately on skill entry so any failure is detectable
- **`skills/atlas/SKILL.md`** — Same: `saveCheckpoint()` before Explore+Metis parallel spawn

**Sub-agent output validation (all three skills)**
- After every sub-agent call (Hermes, Metis, Explore), output is validated: empty/minimal results trigger one retry with sonnet + aggressively condensed input (100-line summary). If retry also fails, skill stops explicitly with a user-facing diagnosis message and records the failure to `wisdom.jsonl` for future sessions. No more silent continuation

### Added

- **`scripts/lib/preflight.mjs`** — `detectPointerFile()`, `cleanStalePointers()`, `runPreflight()`, `formatPreflightReport()`
- **`scripts/lib/input-guard.mjs`** — `estimateTokens()`, `countLines()`, `checkInputSize()`, `extractStructuralSummary()`, `prepareSubAgentInput()`
- **`scripts/test/preflight.test.mjs`** — 16 tests covering pointer detection, stale cleanup, expired checkpoints, orphaned team state
- **`scripts/test/input-guard.test.mjs`** — 18 tests covering token estimation, tier limits, structural summary extraction, chunking correctness

### Meta

- Test count: **390 → 424** (+34 new tests, 0 failures)
- Test files: **26 → 28**
- Codex cross-validation: confirmed chunking correctness (8000 lines → 128 lines for haiku tier, safe=true)
- Fix branch: `worktree-fix+silent-failure-lscale`

## [0.8.7] - 2026-03-30

### Fixed — Post-review fixes (Themis + Architect + Codex 3-way review)

- **`skills/harness-init/SKILL.md`** — Phase 2 agent changed from `architect` (read-only, cannot write files) to `executor`. Section numbering corrected (1–8, no duplicates). Added `docs/exec-plans/active/` and `docs/exec-plans/completed/` to scaffold output
- **`skills/atlas/SKILL.md`** — `harness_context` injection extended to `designer` and `test-engineer` prompts (was previously only in `executor` prompt)
- **`skills/athena/SKILL.md`** — Added `deepinit` and `harness-init` to External_Skills list (was missing, causing asymmetry with Atlas). Added Phase 5d exec-plan tracking (symmetric with Atlas)
- **`CLAUDE.md`** — Added `harness-init` to Available skills list (24 → 25). Added xval session naming convention (`atlas-codex-xval-<story-id>`, `athena-<slug>-codex-xval-<story-id>`) alongside existing `atlas-codex-<N>` pattern
- **`docs/plans/improvements.md`** — Fixed D4 phase reference: "Athena Phase 3" → "Athena Phase 4"

### Meta

- Review methodology: Themis (quality gate) + Architect (structural) + Codex (gpt-5.4, independent) running in parallel
- Themis verdict: PASS — 390/390 tests, 26/26 scripts syntax clean, all versions aligned
- Architect verdict: CONDITIONAL → resolved
- Codex verdict: FAIL → resolved (architect read-only bug was the critical finding)

## [0.8.6] - 2026-03-30

### Added — Harness Engineering Integration

- **`skills/harness-init/SKILL.md`** — New skill: initialize OpenAI-style harness engineering structure for any project. 4-phase workflow: SCAN → DESIGN HARNESS (generates AGENTS.md as TOC ≤100 lines, `docs/ARCHITECTURE.md`, `docs/golden-principles.md`, `docs/design-docs/index.md`, `docs/exec-plans/`, `docs/QUALITY_SCORE.md`) → STRUCTURAL CONSTRAINTS (arch constraint test stubs) → VERIFY. Aliases: `harness-init`, `setup-harness`, `하네스초기화`
- **`skills/atlas/SKILL.md`** — Phase 0 Harness Check: loads `docs/golden-principles.md` + `docs/ARCHITECTURE.md` as `<harness_context>`, injected into all executor and Codex worker prompts. Phase 3: Codex cross-validation per story via tmux (`atlas-codex-xval-<story-id>`) with `detectCodexError()` unavailability guard. Phase 5d: exec-plan completion record in `docs/exec-plans/tech-debt-tracker.md` with markdown header guard on first use
- **`skills/athena/SKILL.md`** — Phase 0 Harness Check (same as Atlas). Phase 2 worker spawn: harness_context injected inline into all Claude and Codex worker prompts. Phase 3: Codex cross-validation (`athena-<slug>-codex-xval-<story-id>`) against post-merge file paths to catch conflict-resolution violations

### Changed

- **`skills/deepinit/SKILL.md`** — Phase 3 now generates AGENTS.md as table of contents (≤100 lines) pointing to `docs/`, not a monolithic file. New Phase 3.5 creates minimal `docs/` stubs when absent; skips if harness-init already ran. Stale "Phase 0.5" cross-reference corrected
- **`skills/atlas/SKILL.md`** — Codex worker prompts include harness constraints when available. `harness-init` added to External_Skills list
- **`skills/athena/SKILL.md`** — Codex worker prompts include harness constraints. Inbox broadcast note clarified to match actual inline injection

### Design Rationale

Follows OpenAI's harness engineering principles (Feb 2026): AGENTS.md as map not encyclopedia, `docs/` as system of record, golden principles encoded mechanically, architectural constraints enforced via structural tests, entropy management via exec-plan tracking, and Codex cross-validation per story before acceptance.

- Skill count: **24 → 25** (`harness-init`)
- Cross-validation: Claude code-reviewer + Codex (gpt-5.4) independent review

## [0.8.4] - 2026-03-30

### Fixed — Cross-Validation Bug Fixes (Claude × Codex 3-way review)

- **`scripts/lib/tmux-session.mjs`** — Replaced all `execSync` shell-string tmux commands with `execFileSync` + args array throughout (`resolveBinary`, `validateTmux`, `createTeamSession`, `spawnWorkerInSession`, `capturePane`, `killSession`, `killTeamSessions`, `listTeamSessions`). Eliminates shell injection via `sessionCwd`, session name, or binary path. Removed now-unused `execSync` import
- **`scripts/lib/worker-spawn.mjs`** — Fixed zsh prompt detection: completion check now matches both `$` (bash) and `%` (zsh) prompts, preventing orchestrator hang on macOS default shell
- **`scripts/lib/worktree.mjs`** — Added `git merge --abort` after failed `mergeWorkerBranch()` so the repo is never left in a half-merged state
- **`scripts/lib/changelog.mjs`** — Replaced `writeFileSync` with `atomicWriteFileSync` in `prependToChangelog()` to prevent CHANGELOG.md corruption on mid-write crash. Consistent with all other state-file writes in the codebase
- **`scripts/session-start.mjs`** — Replaced `execSync('git log ... 2>/dev/null')` shell invocation with `execFileSync('git', [...])` — the `stdio` option already suppressed stderr, making the shell redirect redundant
- **`skills/consensus-plan/SKILL.md`** — Fixed caller pattern: `Task(subagent_type="agent-olympus:consensus-plan")` → `Skill(skill="agent-olympus:consensus-plan")`. `consensus-plan` is a skill, not an agent — the previous form would fail at runtime with "agent type not found"
- **`skills/deep-dive/SKILL.md`** — Same fix: `Task(subagent_type="agent-olympus:deep-dive")` → `Skill(skill="agent-olympus:deep-dive")`
- **`scripts/lib/notify.mjs`** — Fixed iTerm app name: `'iTerm'` → `'iTerm2'` in `detectTerminalApp()`

### Changed

- **`agents/atlas.md`, `agents/athena.md`** — `model: claude-opus-4-6` → `model: opus` to conform to CLAUDE.md convention (haiku | sonnet | opus aliases only)
- **`skills/design-critique/SKILL.md`** — Removed duplicate alias `UI리뷰` (conflicted with `ui-review` skill, causing non-deterministic intent routing)
- **`scripts/lib/worker-spawn.mjs`** — Removed unused `sendMessage` import
- **`scripts/session-start.mjs`** — Removed unused `formatWisdomForPrompt` import
- **`scripts/concurrency-release.mjs`** — Added missing `#!/usr/bin/env node` shebang (consistent with all other hook scripts)
- **`CLAUDE.md`** — Updated `scripts/lib` module list: corrected `intent` → `intent-patterns`, `tmux` → `tmux-session`, added missing `model-router` and `worker-spawn`. Updated test file count: 25 → 26

### Meta

- Review methodology: 3-way cross-validation — arch-reviewer (Claude/opus), scripts-reviewer (Claude/sonnet), codex-1 (Codex/gpt-5.4) running independently in parallel via Athena orchestrator

## [0.8.3] - 2026-03-30

### Added — UI/UX Design Reinforcement

- **`agents/aphrodite.md`** — New agent: Aphrodite, goddess of beauty. READ-ONLY UI/UX design reviewer using hybrid framework (Nielsen 10 Heuristics + Gestalt Principles + WCAG 2.2 AA). Structured 4-stage review protocol with severity-rated output and 15-point accessibility checklist
- **`skills/design-critique/SKILL.md`** — Structured design critique skill using Nielsen heuristics, Gestalt principles, and WCAG standards. Spawns Aphrodite for evidence-based evaluation with prioritized severity report
- **`skills/a11y-audit/SKILL.md`** — WCAG 2.2 AA accessibility audit via code review only (no browser tools required). 15 critical checks across 4 WCAG principles with compliance scorecard output
- **`skills/design-system-audit/SKILL.md`** — Design system health audit: token leak detection (colors, spacing, typography, shadows), component API consistency checks, state coverage matrix, remediation plan
- **`skills/ux-copy-review/SKILL.md`** — UX copy quality review: error messages, CTAs, empty states, labels, tooltips. Checks clarity, consistency, tone, and inclusivity with style guide extraction
- **`skills/ui-review/SKILL.md`** — Umbrella skill that chains all 4 UI/UX review skills in parallel (design-critique + a11y-audit + design-system-audit + ux-copy-review) with unified verdict

### Changed

- **`agents/designer.md`** — Enhanced from 20 lines to 40 lines: added WCAG 2.2 AA + WAI-ARIA APG expertise, design systems/tokens/theming, i18n/RTL support, reduced-motion, 10 hard rules (state coverage, focus styles, token usage), 7 mental models (task-first, hierarchy-before-color, recognition-over-recall)
- **`scripts/lib/intent-patterns.mjs`** — Added 12 design-specific keywords to visual-engineering category: design critique, design review, design system, design token, usability, heuristic, gestalt, ux copy, microcopy, empty state, visual regression, responsive test, a11y audit, accessibility audit
- **`scripts/test/intent-patterns.test.mjs`** — Added 9 new tests for UI/UX design review intent classification (design critique, a11y audit, design system audit, ux copy review, Korean design review, usability heuristics, responsive/visual regression)
- **`config/model-routing.jsonc`** — New `design-review` intent route: maps design critique/audit/copy review intents to `agent-olympus:aphrodite` (sonnet + gemini). Separated from `visual-engineering` (implementation) for clean routing
- **`scripts/lib/intent-patterns.mjs`** — New `design-review` intent category (weight 1.2) with dedicated patterns for critique, audit, copy review, heuristic evaluation keywords (EN/KO/JA). Cleaned `visual-engineering` keywords to avoid routing conflicts
- **`skills/atlas/SKILL.md`** — Phase 5 REVIEW: Aphrodite now spawns conditionally alongside architect, security-reviewer, code-reviewer when frontend files (`.tsx`, `.jsx`, `.vue`, `.svelte`, `.css`, `.scss`, `.html`) are in the changeset
- **`skills/athena/SKILL.md`** — Phase 5 REVIEW: same conditional Aphrodite review for frontend changes
- **`scripts/test/fixtures/a11y-violations.jsx`** — Seeded fixture with 15 planted WCAG violations (img alt, div onClick, missing labels, heading skip, outline:none, bad links, tabindex, small touch targets, missing aria-live, low contrast)
- **`scripts/test/fixtures/a11y-clean.jsx`** — Zero-violation reference fixture for false-positive testing
- **`scripts/test/a11y-fixtures.test.mjs`** — 18 tests verifying detection patterns match violations and produce zero false positives on clean fixture
- Agent count: **17 → 18**, Skill count: **19 → 24**, Intent categories: **6 → 7**, Test count: **363 → 390**

### Research & Cross-Validation

- Codex (GPT-5.4, xhigh effort, 210K tokens) cross-validated priority ranking, skill decomposition, and framework selection
- Claude research agent surveyed Nielsen NN/g, W3C WCAG 2.2, WAI-ARIA APG, Atomic Design, Storybook/Chromatic patterns, React Testing Library best practices
- Key decisions validated by both models: designer/reviewer role separation, many-focused-skills over monolithic, code-review-only a11y auditing feasibility

## [0.8.1] - 2026-03-30

### Fixed
- **`hooks/hooks.json`** — Hook timeout values corrected from `3` (3ms) to `3000` (3s). All `PreToolUse` and `UserPromptSubmit` hooks were silently killed before completing, effectively disabling intent gate, concurrency gate, and model router
- **`scripts/concurrency-gate.mjs`** — Now gates both `Task` and `Agent` tool invocations. Previously only checked `toolName === 'Task'`, allowing `Agent`-spawned sub-agents to bypass concurrency limits entirely
- **`.claude-plugin/marketplace.json`** — Version bumped from stale `0.7.2` to `0.8.1` (was out of sync with `plugin.json` and `package.json` since v0.8.0 release)
- **`CHANGELOG.md`** + **`README.md`** + **`README.ko.md`** — Removed incorrect claim of Windows PowerShell toast notification support; `notify.mjs` only supports macOS (`osascript`), Linux (`notify-send`), and terminal bell fallback
- **`scripts/test/cost-estimate.test.mjs`** — Fixed `tier: 'opus'` → `model: 'opus'` key mismatch; the wrong key caused opus pricing to silently compute as $0 in the test assertion
- **`CLAUDE.md`** — Added missing `security-reviewer` to available agents list (17 agents, was listing only 16)
- **`scripts/lib/notify.mjs`** — Improved fallback for unknown notification events: added `done`, `started`, `progress` aliases; unregistered events now show humanized title instead of raw event string

## [0.8.0] - 2026-03-30

### Added — Post-Code Automation (A1–A4)
- **`scripts/lib/pr-create.mjs`** — PR automation library: `preflightCheck()`, `extractIssueRefs()`, `buildPRBody()`, `findExistingPR()`, `createPR()`. Atlas/Athena auto-create PRs after commit with issue references parsed from branch names and commit messages
- **`scripts/lib/ci-watch.mjs`** — CI monitoring: async `watchCI({branch, maxCycles, pollIntervalMs})` polls `gh run list` until completion; `getFailedLogs(runId)` fetches failure logs for auto-fix loop
- **`scripts/lib/changelog.mjs`** — CHANGELOG automation: `generateChangelogEntry({prd, version, date})` builds entries from passing PRD stories; `prependToChangelog(filePath, entry)` atomically prepends to existing file
- **`skills/atlas/SKILL.md`** + **`skills/athena/SKILL.md`** — Phase 5c: auto-generate CHANGELOG entry from PRD stories after review approval
- **`skills/atlas/SKILL.md`** + **`skills/athena/SKILL.md`** — Phase 6 SHIP: reads `.ao/autonomy.json`, auto-pushes branch and creates PR (A1+A3), auto-closes referenced issues
- **`skills/atlas/SKILL.md`** + **`skills/athena/SKILL.md`** — Phase 6b CI WATCH: full auto-fix loop — poll CI → fetch failed logs → spawn debugger → systematic-debug → trace → verify locally → push → re-poll (max 3 cycles)

### Added — User Communication (B1–B3)
- **`scripts/lib/notify.mjs`** — OS-aware notifications: macOS via `osascript`, Linux via `notify-send`, terminal bell fallback on other platforms. Fires on task complete, blocked, and CI events
- **`scripts/notify-cli.mjs`** — CLI entry: `node scripts/notify-cli.mjs --event done --orchestrator atlas --summary "3 stories"`
- **`scripts/lib/cost-estimate.mjs`** — Token cost estimator with `PRICING` table (opus/sonnet/haiku rates). Shown before long runs when `costAwareness: true`
- **`skills/atlas/SKILL.md`** + **`skills/athena/SKILL.md`** — Phase 0: cost estimate display + periodic progress briefing (B2+B3)

### Added — Context Intelligence (C1–C2)
- **`skills/atlas/SKILL.md`** + **`skills/athena/SKILL.md`** — Phase 0 auto-onboarding: runs `deepinit` automatically if `AGENTS.md` missing (C1)
- **`skills/atlas/SKILL.md`** + **`skills/athena/SKILL.md`** — Phase 4: optional visual verification via Claude Preview MCP after UI changes detected (C2)

### Added — Ship Policy Config
- **`scripts/lib/autonomy.mjs`** — Ship policy loader/validator. Controls `autoPush`, `draftPR`, `ci.maxCycles`, `notify.*`, `costAwareness`, `progressBriefing` via `.ao/autonomy.json`
- **`skills/finish-branch/SKILL.md`** — Auto-Ship option respects `autonomy.json` for non-interactive workflows

### Added — Tests
- 6 new test files: `autonomy.test.mjs` (24), `cost-estimate.test.mjs` (7), `changelog.test.mjs` (7), `pr-create.test.mjs` (14), `ci-watch.test.mjs` (7), `notify-cli.test.mjs` (9)
- Total test suite: **363+ tests across 25 files** (was 295 across 19)

## [0.7.2] - 2026-03-29

### Security
- **`scripts/stop-hook.mjs`** — Replaced `execSync(git commit -m "${message}")` with `execFileSync('git', ['commit', '-m', message])` to eliminate shell injection vector (P0)
- **`scripts/lib/worktree.mjs`** — Converted ALL `execSync` git calls to `execFileSync` with array arguments throughout the entire file (12 call sites), eliminating shell injection via `cwd`, `worktreePath`, and `branchName`

### Added
- **Activity-based liveness detection** (`scripts/lib/worker-spawn.mjs`) — Tracks output changes via MD5 hash comparison; reports `stalled` status when output is unchanged for 5+ minutes. Informational only — never auto-kills workers; the orchestrator decides how to respond
- **Persistent worktree registry** (`scripts/lib/worktree.mjs`) — New `.ao/state/worktree-registry.json` tracks created worktrees for orphan cleanup. Failed-to-remove entries are retained for retry on next session
- **Extended config validation** (`scripts/lib/config-validator.mjs`) — Now validates `fallbackChain` arrays (must contain valid model names), `teamWorkerType` values (`"gemini"`, `"codex"`, or `null`), `highConfidence` threshold, and `minConfidence < highConfidence` consistency
- **6 new test files** (113 tests): `intent-gate.test.mjs`, `session-start.test.mjs`, `stop-hook.test.mjs`, `model-router-hook.test.mjs`, `model-router.test.mjs` (lib), `concurrency-release.test.mjs`
- Total test suite: **295 tests across 19 files** (was 182 across 13)

### Fixed
- **`scripts/concurrency-gate.mjs`** — `parseInt` of env vars now guards against NaN; invalid values like `AO_CONCURRENCY_GLOBAL=abc` safely fall back to defaults instead of silently disabling concurrency limits
- **`scripts/lib/worker-spawn.mjs`** — Improved `isDone` detection: now checks only the last 5 lines of pane output for shell prompt (`$`), reducing false positives from inline `$` in code output. Removed duplicate if/else branch. Fixed `stateChanged` flag to cover activity/stall metadata updates
- **`scripts/lib/model-router.mjs`** — Added `.catch(() => {})` to fire-and-forget `recordValidationWarning()` call to prevent unhandled promise rejections
- **`scripts/lib/inbox-outbox.mjs`** — Failed `atomicMoveSync` during message consume now logs to `failed-moves.log` instead of silently swallowing errors
- **`scripts/lib/wisdom.mjs`** — Auto-prunes every 50 entries via `pruneWisdom()` to prevent unbounded JSONL growth
- **`CLAUDE.md`** — Added `hephaestus` to Available agents list (was missing); updated test count to 295+/19 files

## [0.7.1] - 2026-03-29

### Fixed
- **`skills/athena/SKILL.md`** — Updated skills list and recommended workflow table to reflect 4-step debug escalation chain (debugger → debugger+wisdom → systematic-debug → trace); was stale "use when debugger fails 2x"
- **`skills/atlas/SKILL.md`** — Same stale trace description fixed in recommended workflow table
- **`skills/brainstorm/SKILL.md`** — Fixed CONVERGE gate to require two-evaluator consensus (Architect marks `feasible: true` AND Momus marks `acceptable: true` on same option); was incorrectly referencing single combined score. Fixed Stop_Conditions to match. Added partial change request re-approval flow.
- **`skills/systematic-debug/SKILL.md`** — Fixed phase gate reference from "Phase 1, 3, and 5" to "Phase 1 (REPRODUCE), Phase 4 (FIX), Phase 5 (VERIFY)"; Phase 3 (UNDERSTAND) has no gate
- **`skills/finish-branch/SKILL.md`** — Replaced AO-hardcoded lint path (`scripts/*.mjs`) with project-aware detection; replaced temp file with inline variable for changed files list
- **`agents/code-reviewer.md`** — Removed internal "Superpowers" methodology branding from agent definition
- **`skills/tdd/SKILL.md`**, **`skills/brainstorm/SKILL.md`**, **`skills/plan/SKILL.md`** — Replaced `Skill()` primitive invocations with inline prose (`invoke /X`); `Skill()` is only valid inside atlas/athena orchestrators
- **`agents/themis.md`** — Replaced non-existent `.ao/teams/superpowers/rules-manifest.json` reference with concrete grep patterns

## [0.7.0] - 2026-03-29

### Added
- **`agents/themis.md`** — New agent: Themis, goddess of law and order. READ-ONLY quality gate enforcer that runs tests, syntax checks, namespace hygiene, and forbidden pattern scans. Returns structured `PASS | FAIL | CONDITIONAL` verdict.
- **`skills/tdd/SKILL.md`** — Test-driven development skill with strict RED→GREEN→REFACTOR discipline. Enforces test-first iron law via `test-engineer` + `executor` + `code-reviewer` agents.
- **`skills/systematic-debug/SKILL.md`** — Root-cause-first debugging: reproduce → isolate → understand → fix → verify. Hard gate: never fix without reproducing first.
- **`skills/brainstorm/SKILL.md`** — Design-before-code methodology: diverge → converge → refine. Hard gate for complex/architectural tasks; outputs design decision record to `.ao/brainstorm-<slug>.md`.
- **`skills/finish-branch/SKILL.md`** — Structured branch completion: tests → lint → coverage → review → present merge options (merge / PR / keep / discard).

### Changed
- **`agents/code-reviewer.md`** — Added two-stage review protocol (Stage 1: spec compliance, Stage 2: code quality)
- **`agents/debugger.md`** — Added Step 0 "Reproduce First" iron law + Forbidden section (no shotgun debugging, no printf-and-pray)
- **`skills/atlas/SKILL.md`** — Added optional Phase 4.5 Themis quality gate checkpoint (standalone-safe: skipped if Themis absent)
- **`skills/athena/SKILL.md`** — Added optional quality gate in integration phase + TDD note for worker dispatch
- **`skills/plan/SKILL.md`** — Added brainstorm pre-processing hint for complex/architectural tasks
- **`skills/consensus-plan/SKILL.md`** — Added TDD enforcement note in finalize phase
- **`skills/trace/SKILL.md`** — Added escalation path to `/systematic-debug` from VERDICT phase
- **`skills/verify-coverage/SKILL.md`** — Added integration note with `/finish-branch`
- **`CLAUDE.md`** — Updated agent/skill inventory; test count updated to 182+
- Agent count: **16 → 17**, Skill count: **15 → 19**

### Inspired By
- [Superpowers](https://github.com/obra/superpowers) — TDD discipline, systematic debugging, brainstorm-first gate, verification-before-completion iron law, two-stage code review protocol

## [0.6.7] - 2026-03-28

### Added
- **Test coverage expansion**: Unit tests for all previously untested lib modules
  - `scripts/test/config-validator.test.mjs` — 24 tests for `validateRoutingConfig()` and `DEFAULT_ROUTING_CONFIG`
  - `scripts/test/stdin.test.mjs` — 6 tests for `readStdin()` including child-process behavioral tests
  - `scripts/test/worker-status.test.mjs` — 10 tests for `reportWorkerStatus`, `readTeamStatus`, `formatStatusMarkdown`, `clearTeamStatus`
  - `scripts/test/worktree.test.mjs` — 14 tests for full worktree lifecycle (create, remove, list, merge, cleanup)
- Total test suite: **182 tests across 13 files** (was 128 across 9)

### Changed
- Corrected skill count from 14 → 15 in `README.md`, `plugin.json`, `marketplace.json`, `CHANGELOG.md`

## [0.6.5] - 2026-03-27

### Added
- **Athena worktree isolation**: Each parallel worker now runs in an isolated git worktree (`scripts/lib/worktree.mjs`), preventing silent file overwrites between concurrent workers
- **SessionStart hook**: Automatically injects prior wisdom and interrupted checkpoint context at session start (`scripts/session-start.mjs`)
- **Stop hook WIP commit**: Auto-saves uncommitted work as a WIP commit on session end (`scripts/stop-hook.mjs`)
- **verify-coverage skill**: Detects test coverage gaps for recently changed files (`skills/verify-coverage/SKILL.md`)
- **128 unit tests**: Comprehensive test suite using `node:test` across 9 test files (`scripts/test/`)
- **Atomic writes**: All state files now use tmp+rename pattern (`scripts/lib/fs-atomic.mjs`)
- **Intent-aware wisdom queries**: `queryWisdom()` now supports filtering by intent, confidence, and file pattern
- **Config schema validation**: `model-routing.jsonc` validated on load with safe fallback (`scripts/lib/config-validator.mjs`)
- **tmux command injection prevention**: `sanitizeForShellArg()` escapes shell special chars before `send-keys`
- **detectProvider() extracted**: Shared library for provider detection (`scripts/lib/provider-detect.mjs`)

### Changed
- `scripts/lib/inbox-outbox.mjs` — uses `atomicMoveSync` for all writes
- `scripts/concurrency-gate.mjs`, `concurrency-release.mjs` — atomic writes + `detectProvider` separated into shared lib
- `scripts/model-router.mjs` — validates config schema on load
- `hooks/hooks.json` — SessionStart and Stop events registered
- `skills/athena/SKILL.md` — worktree isolation added to Phase 2, Phase 4, and COMPLETION
- `skills/cancel/SKILL.md` — worktree cleanup step added
- `.claude-plugin/marketplace.json` — updated to 16 agents, 15 skills

### Inspired By
- [Kimoring AI Skills](https://github.com/codefactory-co/kimoring-ai-skills) — SessionStart/Stop hook patterns, coverage gap detection concept

## [0.5.0] - 2026-03-17

Initial release with Atlas and Athena orchestrators.
