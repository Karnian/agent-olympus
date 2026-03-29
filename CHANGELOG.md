# Changelog

## [0.8.0] - 2026-03-30

### Added — Post-Code Automation (A1–A4)
- **`scripts/lib/pr-create.mjs`** — PR automation library: `preflightCheck()`, `extractIssueRefs()`, `buildPRBody()`, `findExistingPR()`, `createPR()`. Atlas/Athena auto-create PRs after commit with issue references parsed from branch names and commit messages
- **`scripts/lib/ci-watch.mjs`** — CI monitoring: async `watchCI({branch, maxCycles, pollIntervalMs})` polls `gh run list` until completion; `getFailedLogs(runId)` fetches failure logs for auto-fix loop
- **`scripts/lib/changelog.mjs`** — CHANGELOG automation: `generateChangelogEntry({prd, version, date})` builds entries from passing PRD stories; `prependToChangelog(filePath, entry)` atomically prepends to existing file
- **`skills/atlas/SKILL.md`** + **`skills/athena/SKILL.md`** — Phase 5c: auto-generate CHANGELOG entry from PRD stories after review approval
- **`skills/atlas/SKILL.md`** + **`skills/athena/SKILL.md`** — Phase 6 SHIP: reads `.ao/autonomy.json`, auto-pushes branch and creates PR (A1+A3), auto-closes referenced issues
- **`skills/atlas/SKILL.md`** + **`skills/athena/SKILL.md`** — Phase 6b CI WATCH: full auto-fix loop — poll CI → fetch failed logs → spawn debugger → systematic-debug → trace → verify locally → push → re-poll (max 3 cycles)

### Added — User Communication (B1–B3)
- **`scripts/lib/notify.mjs`** — OS-aware notifications: macOS via `osascript`, Linux via `notify-send`, Windows via PowerShell toast. Fires on task complete, blocked, and CI events
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
