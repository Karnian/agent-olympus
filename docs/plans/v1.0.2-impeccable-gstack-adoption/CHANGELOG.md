# v1.0.2-impeccable-gstack-adoption — CHANGELOG

## 2026-04-07 — Revision 2.1 (APPROVED + GO, 2/2 critics)

- **Status:** draft → ready-for-execution (APPROVED by Codex+Gemini Prometheus pass; GO from Codex+Gemini Momus pass)
- **Stories:** 10 → **9** (US-010 TTHW deferred to v1.0.3)
- **Foundation stories added:** F-001 (M-B2 SubagentStart refactor), F-002 (.ao/memory/ namespace + B-X1 + AC-X2)
- **Scoring (Codex / Gemini):**
  - Clarity: 91 / 85 (was 62 — +29 / +23)
  - Verification: 90 / 82 (was 58 — +32 / +24)
  - Context: 92 / 88
  - Big Picture: 91 / 90

### Blockers resolved (11)

| # | ID | Source | Resolution |
|---|---|---|---|
| 1 | M-B2 | Momus | New foundation story F-001: single-pass loader, 2.5s wall-clock race, sync-by-default with async opt-in gated by compatibility test, latency regression test with 1MB synthetic fixtures |
| 2 | B-X1 + AC-X2 | Codex + Codex | New foundation story F-002: `.ao/memory/` namespace untouched by SessionEnd; worktree-shared via git common-dir; `scripts/session-end.mjs` gains PROTECTED_NAMES allow-list (defense-in-depth) |
| 3 | M-B3 | Momus | `uiSmellScan: warn|block` flag (`warn` = v1.0.2 default); `schemaVersion: 1` on every new format; new "Compatibility & Rollback" section in spec.md; full opt-out matrix in prd.json |
| 4 | B-X4 | Codex | US-010 TTHW DEFERRED to v1.0.3 (recorded in deferredStories[0] with rationale and v1.0.3 design notes) |
| 5 | M-B1 | Momus | US-002 gains `scripts/lib/ui-reference.mjs` with `selectModules({diffPaths,diffContent}) → string[]` and 7+ explicit unit-test ACs |
| 6 | B-G1 + AC-G2 + D7 | Gemini + Gemini + Momus | Drop `harden` from US-008 chain; new chain is `audit → normalize → polish → re-audit (convergence)`; US-004 `requiresTDD: true`; convergence check verifies smell delta and aborts on regression |
| 7 | P-B1 | Momus + Codex | US-005 gains regex-driven security router with full pattern set (token, secret, apikey, hmac, jwt, .pem, .env, bearer, client_secret, access_key, ssh, OPENSSH PRIVATE KEY, connection_string, db_url, etc.); reviewer-triggered escalation flag `RE-REVIEW-REQUESTED` |
| 8 | B-X2 + D6 | Codex + Momus | US-007 reframed from "strict isolation" to "ARCHIVAL ONLY" with explicit disclaimer; ConcurrencyGate compatibility note: zero subagent fan-out |
| 9 | HR-X3 | Codex | US-009 explicitly documents `taste prune` grammar via either `/taste` skill OR `/sessions taste prune` extension (implementer's choice, documented) |
| 10 | HR-G2 | Gemini | US-006 downgraded to "pause + manual continue"; deterministic exact-resume DEFERRED to v1.0.3; new `skills/resume-handoff/SKILL.md` AC as thin state-reader |
| 11 | D5 + D8 + Group restructure | Momus | Group A split into A1 (US-001 owns finish-branch SKILL.md) + A2 (US-002 owns ui-review/reference); CLAUDE.md State Management update is an explicit AC on US-007; ConcurrencyGate ×US-007/US-008 fan-out documented |

### Code edit shipped in this revision

- **`scripts/session-end.mjs`**: added `PROTECTED_NAMES` defense-in-depth allow-list. Primary fix is the `.ao/memory/` namespace separation (handled by F-002 implementation); allow-list guards against accidental future regressions where a hook drops durable files into `.ao/state/`. Verified: 1054/1054 existing tests still pass; new fixture for protected files added to follow-up F-002 implementation.

### Files changed in this revision

- `docs/plans/v1.0.2-impeccable-gstack-adoption/spec.md` (rewritten — 187 lines diff)
- `docs/plans/v1.0.2-impeccable-gstack-adoption/prd.json` (rewritten — 434 lines diff)
- `scripts/session-end.mjs` (PROTECTED_NAMES allow-list + comments — 23 lines added)

### Validation transcripts

- `.ao/work-order-negotiated.md` — Codex+Gemini negotiated work order
- `.ao/team-roster.md` — team composition and ground rules
- `.ao/validation/round-1-consolidated-review.md` — 11-blocker per-line sign-off (Codex APPROVE_WITH_NITS, Gemini APPROVE)
- `.ao/validation/round-2-final-verdict.md` — final Prometheus + Momus re-run (2/2 APPROVED + GO)

### Residual implementation risks (NOT plan blockers)

- Hook async upgrade: do NOT flip `hooks/hooks.json` SubagentStart to `async: true` without the compatibility test passing.
- Router conservatism: preserve full reviewer set + escalation behavior exactly as specified in US-005.
- F-001 + F-002 must land before US-003 + US-009 implementation (foundation gating).
- US-004 (C1) must complete before US-008 (C2) — they are sequential, not parallel.

## 2026-04-07 — Created (revision 1)

- **Version target:** 1.0.2
- **Scale:** M
- **Mode:** Forward (idea → spec)
- **Stories:** 10 user stories
- **Status:** draft → NEEDS_REVISION (consensus-plan) → NO_GO (Momus)
- **Source:** 3-way cross-review by Claude + Codex 0.118.0 + Gemini 0.36.0 against [pbakaus/impeccable](https://github.com/pbakaus/impeccable) and [garrytan/gstack](https://github.com/garrytan/gstack)
- **Consensus breakdown:**
  - 5 unanimous (3/3): US-001, US-002, US-003, US-004, US-005
  - 5 majority (2/3): US-006, US-007, US-008, US-009, US-010
- **Summary:** Adopt 10 high-leverage concepts from impeccable (anti-pattern registry, modular design reference, project identity, precision style-pass, remediation chain) and gstack (change-aware review router, browser handoff, cascade artifact pipe, taste memory, TTHW benchmarking) without introducing new dependencies or breaking existing hooks.
- **Outcome:** 11+ blockers identified across consensus-plan and Momus reviews. See revision 2.1 above for resolutions.
