# v1.0.2 — Impeccable & gstack Adoption Specification

**Scale:** M (Feature pack — 10 user stories across design quality, orchestration efficiency, and brownfield resilience)
**Created:** 2026-04-07
**Status:** Draft
**Source:** 3-way cross-review by Claude + Codex + Gemini against [pbakaus/impeccable](https://github.com/pbakaus/impeccable) and [garrytan/gstack](https://github.com/garrytan/gstack)

---

## Problem Statement

**WHO:** Solo developers and small teams running Agent Olympus (Atlas/Athena) for autonomous task completion, especially on UI-heavy or brownfield projects.

**WHAT:** Agent Olympus orchestrates well and has strong design-review coverage (aphrodite, designer, ui-review chain), but three concrete gaps remain after the v0.7 Superpowers integration and v0.9 source-informed pass:

1. **Generic LLM design output** — Aphrodite critiques against generic principles (Nielsen, Gestalt, WCAG) but lacks LLM-specific negative constraints (Inter font, card-soup, pure-black, bounce easing) and project-specific brand context. Result: visually competent but indistinguishable "AI default" UI.

2. **Always-on reviewer overhead** — Atlas/Athena always run architect + security + code-review on every story regardless of diff scope, wasting 60–80% of reviewer tokens on irrelevant changes (Gemini estimate). No diff-aware routing.

3. **Brownfield stalls** — finish-branch assumes a test harness exists; on greenfield repos with no tests, the autonomous loop stalls. Browser-based QA hits CAPTCHA/auth/MFA walls with no handoff path.

**WHY NOW:** Three independent reviewers (Claude/Codex/Gemini) reached unanimous consensus on five concrete adoptions from impeccable/gstack, plus five additional 2-of-3 consensus items. The 5 unanimous items are low-risk additive features that compound with existing infrastructure (subagent-start hook, run-artifacts, ui-review chain).

## Target Users

1. **Solo AI developer (primary)** — Uses `/atlas` or `/athena` for autonomous shipping. Suffers from "AI default" UI and always-on reviewer costs.
2. **Frontend-heavy team (secondary)** — Wants design-system discipline enforced automatically across iterations without re-stating brand guidelines each time.
3. **Brownfield rescuer (tertiary)** — Adopting Olympus on a legacy repo with no tests. Currently the autonomous loop stalls at finish-branch.

## Goals

- **G1**: Eliminate generic LLM UI defaults via an executable anti-pattern registry that runs as a hard gate before finish-branch
- **G2**: Make designer/aphrodite project-aware via a one-time `/teach-design` capture stored in `.ao/state/design-identity.json` and auto-injected through `subagent-start.mjs`
- **G3**: Replace monolithic design prompts with seven modular reference packs (typography, color-and-contrast, spatial-design, motion-design, interaction-design, responsive-design, ux-writing), lazy-loaded by ui-review/design-critique
- **G4**: Add precision style-pass micro-skills (`/normalize`, `/polish`, `/typeset`, `/arrange`) for surgical UI iteration without full re-generation
- **G5**: Cut Athena reviewer overhead 60–80% via a change-aware review router that activates only relevant agents based on diff scope
- **G6**: Add browser handoff/resume so autonomous QA can pause for CAPTCHA/auth and continue from exact session state
- **G7**: Formalize cascade artifact pipe (`.ao/artifacts/pipe/<runId>/<stage>/`) so each Atlas/Athena stage has strict inbox/outbox, preventing context carry-over
- **G8**: Add deterministic frontend remediation chain (`audit → normalize → polish → harden`) recorded in `.ao/artifacts/runs/<runId>/`
- **G9**: Add taste memory (`.ao/state/taste.jsonl`) — aesthetic preference accumulation distinct from wisdom (which is for facts/library bans)
- **G10**: Add TTHW (Time To Hello World) benchmarking so finish-branch tracks clone-to-running-tests latency over time
- **G11**: All existing tests continue to pass; no breaking changes to autonomy.json, hooks/hooks.json, or run.cjs
- **G12**: Standalone operation — no dependency on impeccable or gstack being installed

## Non-Goals

- **N1**: Will NOT port impeccable's full 20-command surface; only the 4 highest-leverage micro-skills
- **N2**: Will NOT port gstack's `/learn` (wisdom system already covers this) or `/autoplan` (Atlas/Athena cover this)
- **N3**: Will NOT port gstack's GStack Browser binary or its Pretext layout engine
- **N4**: Will NOT introduce new npm dependencies (Node.js built-ins only, consistent with existing scripts/ convention)
- **N5**: Will NOT modify hook signatures or run.cjs entry point (only additive)
- **N6**: Will NOT break the autonomy.json schema; new fields are optional
- **N7**: STRIDE security review and ship-time test bootstrap (Codex single-vote items) are deferred to v1.0.3 or v1.1.0
- **N8**: `/freeze`/`/careful`/`/guard` safety guards (Claude single-vote) deferred to v1.1.0 unless trivially small
- **N9**: Will NOT change Greek mythology agent persona structure

## Source Attribution

Five items unanimously identified by all three reviewers (Claude + Codex + Gemini) as the highest-leverage adoptions:

| Item | Source | Consensus |
|---|---|---|
| Anti-pattern registry / UI slop blacklist | impeccable | 3/3 |
| Modular design reference pack (7 modules) | impeccable | 3/3 |
| Project-specific design identity briefing | impeccable | 3/3 |
| Precision style-pass micro-skills | impeccable | 3/3 |
| Change-aware review router | gstack | 3/3 |

Five additional items reached 2-of-3 consensus and are included as lower-priority stories:

| Item | Source | Consensus |
|---|---|---|
| Browser handoff/resume | gstack | Codex + Gemini |
| Cascade artifact pipe (inbox/outbox per stage) | gstack | Claude + Gemini |
| Sequential remediation chain (audit→normalize→polish→harden) | impeccable | Codex + Gemini |
| Taste memory | gstack | Claude + Gemini |
| TTHW benchmarking | gstack | Claude + Gemini |

## Success Metrics

- **Reviewer cost reduction**: median Athena run uses ≥40% fewer reviewer agent invocations on diffs scoped to a single layer (frontend-only, infra-only, docs-only)
- **Anti-pattern catch rate**: ui-smell-scan detects ≥3 of the 5 canonical slop patterns (Inter font, pure black, card-nesting, bounce easing, gray-on-color) on a known-bad seed fixture
- **Design identity adoption**: ≥80% of design-critique invocations on a project with `design-identity.json` reference at least one project-specific token
- **Brownfield TTHW**: TTHW measured and recorded for ≥1 reference project
- **All existing tests pass**: zero regression in `node --test 'scripts/test/**/*.test.mjs'`

## Architecture Overview

```
.ao/state/
├── design-identity.json     ← NEW (US-003): brand/tokens/typography snapshot
├── taste.jsonl              ← NEW (US-009): aesthetic preference accumulation
└── tthw-history.jsonl       ← NEW (US-010): clone-to-running-tests timing log

.ao/artifacts/
├── pipe/<runId>/<stage>/    ← NEW (US-007): inbox/outbox per orchestrator stage
└── runs/<runId>/
    └── ui-remediation.json  ← NEW (US-008): chain audit/normalize/polish/harden results

config/
├── design-blacklist.jsonc   ← NEW (US-001): anti-pattern rules + grep patterns
└── review-routing.jsonc     ← NEW (US-005): diff-scope → reviewer mapping

scripts/lib/
├── ui-smell-scan.mjs        ← NEW (US-001): executable anti-pattern detector
├── design-identity.mjs      ← NEW (US-003): identity loader + injector
├── review-router.mjs        ← NEW (US-005): diff-aware reviewer selection
├── browser-handoff.mjs      ← NEW (US-006): pause/resume protocol
├── artifact-pipe.mjs        ← NEW (US-007): inbox/outbox helper
├── taste-memory.mjs         ← NEW (US-009): taste log read/write
└── tthw-bench.mjs           ← NEW (US-010): clone-to-tests timing

skills/
├── teach-design/            ← NEW (US-003): identity capture flow
├── normalize/               ← NEW (US-004): token/style normalization pass
├── polish/                  ← NEW (US-004): final-pass micro-skill
├── typeset/                 ← NEW (US-004): typography fix-only pass
├── arrange/                 ← NEW (US-004): layout/spacing fix-only pass
├── ui-remediate/            ← NEW (US-008): deterministic remediation chain
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

- **`scripts/subagent-start.mjs`** (existing): inject design-identity + taste-memory into designer/aphrodite/ui-review subagent context
- **`skills/finish-branch/SKILL.md`** (existing): add ui-smell-scan as a new gate before merge
- **`skills/atlas/SKILL.md`** & **`skills/athena/SKILL.md`** (existing): consult review-router before reviewer fan-out
- **`scripts/lib/run-artifacts.mjs`** (existing): record ui-remediation results under existing run artifacts
- **`scripts/lib/wisdom.mjs`** (existing): taste-memory is parallel/sibling, NOT a wisdom field
- **`config/model-routing.jsonc`** (existing): no changes — review-routing is a separate config

## User Story Catalog

See `prd.json` for full acceptance criteria. Summary:

| ID | Title | Source | Scale | Group |
|---|---|---|---|---|
| US-001 | Anti-pattern registry + executable UI smell scan | impeccable | M | A |
| US-002 | Modular design reference pack (7 modules) | impeccable | S | A |
| US-003 | `/teach-design` identity briefing + auto-injection | impeccable | M | B |
| US-004 | Precision style-pass micro-skills (4) | impeccable | M | C |
| US-005 | Change-aware review router | gstack | M | B |
| US-006 | Browser handoff/resume protocol | gstack | L | D |
| US-007 | Cascade artifact pipe (inbox/outbox per stage) | gstack | L | D |
| US-008 | Sequential frontend remediation chain | impeccable | M | C |
| US-009 | Taste memory (`.ao/state/taste.jsonl`) | gstack | S | B |
| US-010 | TTHW benchmarking on finish-branch | gstack | M | E |

**Parallel groups** (independent within group):
- **A**: US-001, US-002 (both touch ui-review skill, but different files)
- **B**: US-003, US-005, US-009 (state/config additions, no overlap)
- **C**: US-004, US-008 (US-008 depends on US-004 micro-skills existing)
- **D**: US-006, US-007 (both add new lib modules, independent)
- **E**: US-010 (extends finish-branch alone)

Suggested execution order: A → B → C → D → E (D can run in parallel with C if worker capacity allows).

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| ui-smell-scan false positives on legitimate Inter usage in non-default contexts | Allow per-project override in `design-identity.json` (e.g., `allowedFonts: ["Inter"]`) |
| review-router misses edge cases and skips a needed reviewer | Default to "include if uncertain"; add `routing.alwaysInclude` array for manual override |
| Browser handoff state file leaks credentials | Persist only session ID + URL, never cookies/headers; document as user-data-only |
| Cascade pipe doubles disk I/O | Use append-only JSONL + 24h auto-cleanup via existing SessionEnd hook |
| Taste memory drifts with stale preferences | Cap at 200 entries, FIFO; user can prune via `sessions` skill |
| TTHW benchmark blocks finish-branch on slow machines | Bench is async, write-only; never blocks critical path |

## Out of Scope (Future)

- **v1.0.3 candidates**: STRIDE security review + false-positive registry, ship-time test bootstrap, local analytics + retro dashboard (all Codex single-vote items)
- **v1.1.0 candidates**: `/freeze`/`/careful`/`/guard` safety guards, `/canary` post-deploy watcher, `/overdrive` ambitious mode

## References

- [pbakaus/impeccable](https://github.com/pbakaus/impeccable) — Apache 2.0 — 7-module design reference pack + 20 steering commands + anti-pattern enforcement
- [garrytan/gstack](https://github.com/garrytan/gstack) — MIT — 23-skill AI software factory with sprint cascade + browser handoff + multi-agent coordination
- 3-way cross-review session: Claude (this conversation) + Codex 0.118.0 + Gemini 0.36.0
