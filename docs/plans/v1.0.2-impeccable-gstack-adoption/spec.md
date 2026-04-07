# v1.0.2 — Impeccable & gstack Adoption Specification

**Scale:** M (Feature pack — 9 user stories across design quality, orchestration efficiency, and brownfield resilience)
**Created:** 2026-04-07
**Revised:** 2026-04-07 (revision pass — 11 blockers resolved per `.ao/work-order-negotiated.md`)
**Status:** Draft — Revision 2 (CONDITIONAL_GO target)
**Source:** 3-way cross-review by Claude + Codex + Gemini against [pbakaus/impeccable](https://github.com/pbakaus/impeccable) and [garrytan/gstack](https://github.com/garrytan/gstack)

---

## Problem Statement

**WHO:** Solo developers and small teams running Agent Olympus (Atlas/Athena) for autonomous task completion, especially on UI-heavy or brownfield projects.

**WHAT:** Agent Olympus orchestrates well and has strong design-review coverage (aphrodite, designer, ui-review chain), but three concrete gaps remain after the v0.7 Superpowers integration and v0.9 source-informed pass:

1. **Generic LLM design output** — Aphrodite critiques against generic principles (Nielsen, Gestalt, WCAG) but lacks LLM-specific negative constraints (Inter font, card-soup, pure-black, bounce easing) and project-specific brand context. Result: visually competent but indistinguishable "AI default" UI.

2. **Always-on reviewer overhead** — Atlas/Athena always run architect + security + code-review on every story regardless of diff scope, wasting 60–80% of reviewer tokens on irrelevant changes (Gemini estimate). No diff-aware routing.

3. **Brownfield stalls** — finish-branch assumes a test harness exists; on greenfield repos with no tests, the autonomous loop stalls. Browser-based QA hits CAPTCHA/auth/MFA walls with no handoff path.

**Note on problem #3:** v1.0.2 ships partial mitigation only. The actual test-bootstrap fix is explicitly deferred to v1.0.3 (see Out of Scope). The brownfield-stall problem is acknowledged here for context, NOT solved in this release.

**WHY NOW:** Three independent reviewers (Claude/Codex/Gemini) reached unanimous consensus on five concrete adoptions from impeccable/gstack, plus four additional 2-of-3 consensus items. The 5 unanimous items are low-risk additive features that compound with existing infrastructure (subagent-start hook, run-artifacts, ui-review chain).

## Target Users

1. **Solo AI developer (primary)** — Uses `/atlas` or `/athena` for autonomous shipping. Suffers from "AI default" UI and always-on reviewer costs.
2. **Frontend-heavy team (secondary)** — Wants design-system discipline enforced automatically across iterations without re-stating brand guidelines each time.
3. **Brownfield rescuer (tertiary)** — Adopting Olympus on a legacy repo with no tests. v1.0.2 provides a non-blocking opt-in path; full test-harness bootstrap is v1.0.3.

## Goals

- **G1**: Eliminate generic LLM UI defaults via an executable anti-pattern registry that runs as an OPT-IN gate before finish-branch (warn-by-default in v1.0.2; block-mode opt-in)
- **G2**: Make designer/aphrodite project-aware via a one-time `/teach-design` capture stored in `.ao/memory/design-identity.json` and auto-injected through a refactored `subagent-start.mjs`
- **G3**: Replace monolithic design prompts with seven modular reference packs (typography, color-and-contrast, spatial-design, motion-design, interaction-design, responsive-design, ux-writing), lazy-loaded by ui-review/design-critique via `scripts/lib/ui-reference.mjs`
- **G4**: Add precision style-pass micro-skills (`/normalize`, `/polish`, `/typeset`, `/arrange`) for surgical UI iteration without full re-generation
- **G5**: Cut Athena reviewer overhead 40–80% via a regex-driven, change-aware review router that activates only relevant agents based on diff scope, with reviewer-triggered escalation
- **G6**: Add browser pause + manual continue protocol so autonomous QA can stop at CAPTCHA/auth and let the user complete the step manually (deterministic exact-resume deferred to v1.0.3)
- **G7**: Add a stage artifact archival pipe (`.ao/artifacts/pipe/<runId>/<stage>/`) that records each Atlas/Athena stage's outputs for postmortem and structured handoff (NOT prompt-history isolation — that requires a fresh-process architecture and is out of scope)
- **G8**: Add deterministic frontend remediation chain (`audit → normalize → polish → re-audit`) recorded in `.ao/artifacts/runs/<runId>/`
- **G9**: Add taste memory (`.ao/memory/taste.jsonl`) — aesthetic preference accumulation distinct from wisdom (which is for facts/library bans)
- **G10**: All existing tests continue to pass; additive-only changes to autonomy.json (new optional fields), hooks/hooks.json, run.cjs, and existing skills (with explicit opt-out paths)
- **G11**: Standalone operation — no dependency on impeccable or gstack being installed

## Non-Goals

- **N1**: Will NOT port impeccable's full 20-command surface; only the 4 highest-leverage micro-skills
- **N2**: Will NOT port gstack's `/learn` (wisdom system already covers this) or `/autoplan` (Atlas/Athena cover this)
- **N3**: Will NOT port gstack's GStack Browser binary or its Pretext layout engine
- **N4**: Will NOT introduce new npm dependencies (Node.js built-ins only, consistent with existing scripts/ convention)
- **N5**: Will NOT modify hook signatures or run.cjs entry point (only additive)
- **N6**: Will NOT break the autonomy.json schema; new fields are optional with documented defaults
- **N7**: STRIDE security review and ship-time test bootstrap (Codex single-vote items) are deferred to v1.0.3 or v1.1.0
- **N8**: `/freeze`/`/careful`/`/guard` safety guards (Claude single-vote) deferred to v1.1.0 unless trivially small
- **N9**: Will NOT change Greek mythology agent persona structure
- **N10 [NEW]**: Will NOT implement TTHW benchmarking — DEFERRED to v1.0.3 because (a) it does not solve the brownfield-stall problem stated above, (b) clone-source/privacy/cost/network contract is undefined, and (c) the v1.0.3 test-bootstrap story is the actual brownfield fix
- **N11 [NEW]**: Will NOT implement deterministic browser exact-resume (UA/TLS fingerprint persistence). v1.0.2 ships pause + manual continue only; deterministic resume deferred to v1.0.3
- **N12 [NEW]**: Will NOT implement strict prompt-history isolation between orchestrator stages. Atlas/Athena are continuous-session orchestrators; the cascade artifact pipe (US-007) provides ARCHIVAL only, not isolation. Strict isolation requires a fresh-process stage runner architecture and is out of scope
- **N13 [NEW]**: Will NOT add a 5th `/harden` micro-skill in this release. The remediation chain ends with `re-audit` (convergence check), not `harden`. Harden-style functionality is already covered by existing security-reviewer + impeccable:audit + a11y-audit

## Source Attribution

Five items unanimously identified by all three reviewers (Claude + Codex + Gemini) as the highest-leverage adoptions:

| Item | Source | Consensus |
|---|---|---|
| Anti-pattern registry / UI slop blacklist | impeccable | 3/3 |
| Modular design reference pack (7 modules) | impeccable | 3/3 |
| Project-specific design identity briefing | impeccable | 3/3 |
| Precision style-pass micro-skills | impeccable | 3/3 |
| Change-aware review router | gstack | 3/3 |

Four additional items reached 2-of-3 consensus and are included as lower-priority stories (one item — TTHW — was DEFERRED in revision 2):

| Item | Source | Consensus |
|---|---|---|
| Browser pause + manual continue (downgraded from handoff/resume) | gstack | Codex + Gemini |
| Cascade artifact archival (reframed from isolation pipe) | gstack | Claude + Gemini |
| Sequential remediation chain (audit→normalize→polish→re-audit) | impeccable | Codex + Gemini |
| Taste memory | gstack | Claude + Gemini |

## Success Metrics

- **Reviewer cost reduction**: median Athena run uses ≥40% fewer reviewer agent invocations on diffs scoped to a single layer (frontend-only, infra-only, docs-only)
- **Anti-pattern catch rate**: ui-smell-scan detects ≥4 of the 5 canonical slop patterns (Inter font, pure black, card-nesting, bounce easing, gray-on-color) on a known-bad seed fixture (raised from ≥3 to ≥4 per Momus M-H equivalent)
- **Design identity adoption**: ≥80% of design-critique invocations on a project with `design-identity.json` reference at least one project-specific token
- **SubagentStart hook latency**: 95th percentile under 1500ms with synthetic 1MB wisdom + 1MB taste + 4KB design-identity fixtures (regression test ships with US-003)
- **Security router false-negative rate**: 0 misses on a chaos-test fixture with 30+ obfuscated secret patterns (token, secret, apikey, hmac, jwt, .pem, etc.)
- **All existing tests pass**: zero regression in `node --test 'scripts/test/**/*.test.mjs'`

## Architecture Overview

```
.ao/memory/                  ← NEW namespace, EXEMPT from SessionEnd cleanup
├── design-identity.json     ← NEW (US-003): brand/tokens/typography snapshot — schemaVersion: 1
├── taste.jsonl              ← NEW (US-009): aesthetic preference accumulation — schemaVersion: 1 per line
└── (future) tthw-history    ← deferred to v1.0.3

.ao/state/                   ← unchanged: ephemeral, 24h TTL, swept by SessionEnd
└── (existing files only)

.ao/artifacts/
├── pipe/<runId>/<stage>/    ← NEW (US-007): ARCHIVAL outbox/inbox per orchestrator stage — schemaVersion: 1
└── runs/<runId>/
    └── ui-remediation.json  ← NEW (US-008): chain audit/normalize/polish/re-audit results — schemaVersion: 1

config/
├── design-blacklist.jsonc.example  ← NEW (US-001): example anti-pattern rules; user copies to .jsonc to opt-in
└── review-routing.jsonc            ← NEW (US-005): regex-based diff-scope → reviewer mapping — schemaVersion: 1

scripts/lib/
├── memory.mjs               ← NEW (US-003+US-009 infra): unified .ao/memory/ resolver mirroring wisdom.mjs git-common-dir pattern
├── subagent-context.mjs     ← NEW (M-B2): single-pass loader for wisdom + identity + taste with 2.5s wall-clock race
├── ui-smell-scan.mjs        ← NEW (US-001): executable anti-pattern detector (regex)
├── ui-reference.mjs         ← NEW (US-002, M-B1 fix): selectModules(diffPaths, diffContent) → string[]
├── design-identity.mjs      ← NEW (US-003): identity loader + injector (wraps memory.mjs)
├── review-router.mjs        ← NEW (US-005, P-B1 fix): regex-driven diff-aware reviewer selection with escalation flag
├── browser-handoff.mjs      ← NEW (US-006, downgraded): pause-only protocol; no exact-resume
├── artifact-pipe.mjs        ← NEW (US-007, B-X2 fix): outbox/inbox archival helper (NOT isolation)
└── taste-memory.mjs         ← NEW (US-009): taste log read/write (wraps memory.mjs)

scripts/
└── subagent-start.mjs       ← REFACTOR (M-B2): single-pass loader, 2.5s wall-clock race, async:true if compatible

scripts/session-end.mjs      ← MODIFY (B-X1): add .ao/memory/ to cleanup-exclusion allow-list

skills/
├── teach-design/            ← NEW (US-003): identity capture flow
├── normalize/               ← NEW (US-004): token/style normalization pass
├── polish/                  ← NEW (US-004): final-pass micro-skill
├── typeset/                 ← NEW (US-004): typography fix-only pass
├── arrange/                 ← NEW (US-004): layout/spacing fix-only pass
├── ui-remediate/            ← NEW (US-008): deterministic remediation chain (no harden — re-audit instead)
├── taste/                   ← NEW (HR-X3 fix): /taste capture + /taste prune surface (alternative: extend skills/sessions/SKILL.md)
└── ui-review/reference/     ← NEW (US-002): 7 modular design markdown files
    ├── typography.md
    ├── color-and-contrast.md
    ├── spatial-design.md
    ├── motion-design.md
    ├── interaction-design.md
    ├── responsive-design.md
    └── ux-writing.md
```

## Integration Points

- **`scripts/subagent-start.mjs`** (existing → REFACTORED in M-B2): single-pass loader via `subagent-context.mjs`; injects wisdom + design-identity + taste under a 2.5s wall-clock race; falls back to empty additionalContext on timeout (never blocks)
- **`hooks/hooks.json`** (existing): SubagentStart REMAINS SYNC by default (matching the existing context-producing hook pattern in `scripts/session-start.mjs`). The wall-clock race protects the 3s budget. `async: true` is allowed only if a compatibility test (`scripts/test/subagent-start-async.test.mjs`) proves Claude Code still delivers `additionalContext` from async SubagentStart hooks. Default is sync; async is opt-in and gated by a passing test.
- **`scripts/session-end.mjs`** (existing → MODIFIED in B-X1): cleanup loop adds explicit `.ao/memory/` skip; no other change
- **`skills/finish-branch/SKILL.md`** (existing → MODIFIED in US-001 / M-B3): adds OPT-IN ui-smell-scan gate that runs only when `config/design-blacklist.jsonc` exists; mode controlled by `autonomy.json.uiSmellScan` (`warn`|`block`); default `warn`
- **`skills/atlas/SKILL.md`** & **`skills/athena/SKILL.md`** (existing): consult review-router before reviewer fan-out; ConcurrencyGate compatibility note added for US-007 fan-out
- **`skills/sessions/SKILL.md`** OR new **`skills/taste/SKILL.md`** (HR-X3): explicit `taste prune` grammar (not implicit)
- **`scripts/lib/run-artifacts.mjs`** (existing): record ui-remediation results under existing run artifacts
- **`scripts/lib/wisdom.mjs`** (existing): taste-memory is parallel/sibling, NOT a wisdom field; both use the same git-common-dir resolver for worktree sharing
- **`config/model-routing.jsonc`** (existing): no changes — review-routing is a separate config
- **`CLAUDE.md`** (existing): State Management section MUST be updated to enumerate `.ao/memory/` paths (added as explicit AC on US-007)

## Compatibility & Rollback (NEW section per M-B3)

Every user-visible behavior change in v1.0.2 ships with an opt-out switch and a documented rollback path:

| Change | Default | Opt-out | Rollback |
|---|---|---|---|
| `ui-smell-scan` finish-branch gate (US-001) | OPT-IN: only runs when `config/design-blacklist.jsonc` exists | `autonomy.json: {uiSmellScan: "warn"}` (warn = log + continue, block = fail). v1.0.2 default is `warn` if config exists | Delete `config/design-blacklist.jsonc` |
| `subagent-start.mjs` refactor (M-B2) | always on | `autonomy.json: {subagentContext: {disabled: true}}` | Hook fail-opens to empty additionalContext on any error |
| `.ao/memory/` namespace (B-X1) | always on | `autonomy.json: {memory: {disabled: true}}` (memory loaders return empty) | Delete `.ao/memory/` directory; no other state touches it |
| `review-router` (US-005) | always on with conservative fallback (full reviewer set if no rule match) | `autonomy.json: {reviewRouter: {disabled: true}}` | Set `routing.alwaysInclude: ["*"]` |
| Taste memory injection (US-009) | always on if file exists | Delete `.ao/memory/taste.jsonl` | n/a — fail-safe load |
| Design-identity injection (US-003) | always on if file exists | Delete `.ao/memory/design-identity.json` | n/a — fail-safe load |
| Browser pause (US-006) | only triggered on detected auth/captcha | `autonomy.json: {browserHandoff: {disabled: true}}` | n/a |

**Schema versioning**: every new persisted file format carries `schemaVersion: 1` (top-level for JSON, per-line for JSONL). Loaders MUST refuse `schemaVersion > known` with a clear error and continue with empty data (fail-safe). A migration policy stub is documented in CLAUDE.md.

**No autonomy.json schema break**: all new fields are optional. Loaders default to current behavior when fields are absent.

## User Story Catalog

See `prd.json` for full acceptance criteria. Summary (9 stories — US-010 deferred):

| ID | Title | Source | Scale | Group |
|---|---|---|---|---|
| US-001 | Anti-pattern registry + opt-in UI smell scan | impeccable | M | A1 |
| US-002 | Modular design reference pack (7 modules) + ui-reference.mjs | impeccable | M | A2 |
| US-003 | `/teach-design` identity briefing (depends on M-B2 hook refactor) | impeccable | M | B |
| US-004 | Precision style-pass micro-skills (4: normalize, polish, typeset, arrange) | impeccable | M | C1 |
| US-005 | Regex-driven change-aware review router with escalation | gstack | M | B |
| US-006 | Browser pause + manual continue (deterministic resume deferred) | gstack | M | D |
| US-007 | Cascade artifact ARCHIVAL pipe (NOT isolation) + CLAUDE.md doc update | gstack | M | D |
| US-008 | Sequential frontend remediation chain (audit → normalize → polish → re-audit) | impeccable | M | C2 |
| US-009 | Taste memory in `.ao/memory/taste.jsonl` (depends on M-B2 hook refactor) | gstack | S | B |

**Parallel groups (revised — US-001 mutates finish-branch SKILL.md so Group A is split):**
- **A1**: US-001 (owns `config/design-blacklist.jsonc.example`, `scripts/lib/ui-smell-scan.mjs`, `skills/finish-branch/SKILL.md`)
- **A2**: US-002 (owns `scripts/lib/ui-reference.mjs`, `skills/ui-review/reference/*.md`, `skills/ui-review/SKILL.md`)
- **B**: US-003, US-005, US-009 (state/config/router additions; US-003 + US-009 share `scripts/lib/memory.mjs` and `scripts/subagent-context.mjs` so they MUST be implemented as one delivery)
- **C1**: US-004 (must complete first)
- **C2**: US-008 (depends on US-004 — sequential, NOT parallel with C1)
- **D**: US-006, US-007 (both add new lib modules, independent)

**Pre-requisite (M-B2 foundation)**: SubagentStart hook refactor MUST land before US-003 and US-009 implementation. This is a foundation story, not a v1.0.2 user-facing feature, but it ships in the same release.

**Suggested execution order**: M-B2 → A1 + A2 (parallel) → B → C1 → C2 → D. ConcurrencyGate cap of 3 Claude workers limits how much of B + C + D can run truly in parallel.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| ui-smell-scan false positives on legitimate Inter usage in non-default contexts | Allow per-project override in `design-identity.json` (e.g., `allowedFonts: ["Inter"]`); v1.0.2 default is `warn` mode so false positives never block |
| review-router misses edge cases and skips a needed reviewer | (a) regex set covers all secret-material vectors, (b) reviewer-triggered escalation flag (`RE-REVIEW-REQUESTED`) lets any reviewer pull `security-reviewer` back in mid-run, (c) `routing.alwaysInclude` array for manual override |
| Browser pause state file leaks credentials | Persist only session ID + URL (with query-string sanitization) + sanitized breadcrumb (allowlist: `{step, lastClickedSelector, screenshotPath?}`). NEVER cookies/headers/form values |
| Cascade pipe doubles disk I/O | Append-only JSONL + 24h auto-cleanup via existing SessionEnd hook (note: `.ao/artifacts/pipe/` lives outside `.ao/memory/` so SessionEnd CAN sweep it); per-file 100KB cap; per-run total 10MB cap |
| Taste memory drifts with stale preferences | Cap at 200 entries, FIFO; explicit `/taste prune` (or `/sessions taste prune`) grammar; per-line `schemaVersion` for forward compat |
| SubagentStart hook latency regression (M-B2) | Single-pass loader + 2.5s wall-clock race; regression test with synthetic 1MB fixtures must pass at <1500ms p95 |
| .ao/memory/ worktree divergence (AC-X2) | All memory module file paths resolved via the same git-common-dir helper as `wisdom.mjs` (`scripts/lib/memory.mjs` mirrors that pattern); Athena workers in worktrees share the project-root memory dir |
| ConcurrencyGate × US-007 fan-out (D6) | US-007 archival writes are async, in-process; do NOT spawn subagents per stage. US-008 chain is sequential by design (4 stages, max 1 active worker). |

## Out of Scope (Future)

- **v1.0.3 candidates**:
  - **Test-bootstrap skill** (the actual brownfield-stall fix that this v1.0.2 release does NOT solve)
  - **TTHW benchmarking** (former US-010 — deferred for clone-source, privacy, cost, and offline-mode design)
  - **Browser deterministic exact-resume** with UA/TLS fingerprint persistence (former US-006 upgrade)
  - **STRIDE security review** + false-positive registry
  - **Local analytics + retro dashboard**
- **v1.1.0 candidates**: `/freeze`/`/careful`/`/guard` safety guards, `/canary` post-deploy watcher, `/overdrive` ambitious mode
- **Architectural follow-ups (not blockers)**: unified `StateManager` wrapper (Gemini AC-G1), content-addressable artifact store replacing pipe symlinks (Gemini AC-G3), fresh-process stage runner enabling true prompt-history isolation (Codex B-X2 root cause)

## References

- [pbakaus/impeccable](https://github.com/pbakaus/impeccable) — Apache 2.0 — 7-module design reference pack + 20 steering commands + anti-pattern enforcement
- [garrytan/gstack](https://github.com/garrytan/gstack) — MIT — 23-skill AI software factory with sprint cascade + browser handoff + multi-agent coordination
- 3-way cross-review session: Claude (this conversation) + Codex 0.118.0 + Gemini 0.36.0
- Revision-2 negotiation: `.ao/work-order-negotiated.md`
- Prior reviews: `.ao/consensus-plan-report.md`, `.ao/momus-blocking-review.md`
