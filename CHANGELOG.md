# Changelog

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
