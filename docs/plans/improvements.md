# Agent Olympus — Improvement Tracker

> 전체 개선 항목의 구현 현황을 추적하는 문서. 완료 항목은 요약만, 남은 항목은 상세 유지.

**Last Updated**: 2026-04-04

---

## Summary

| Category | Total | Done | Remaining |
|----------|-------|------|-----------|
| A~D. Core Automation + Comms + Context + Harness | 14 | 14 | 0 |
| E. Source-Informed (v0.9) | 10 | 4 | 0 (4 merged, 2 done via G) |
| F. Hook System (v0.9.1) | 4 | 4 | 0 |
| G. Consolidated Backlog (v0.9.2~v0.9.6) | 5+1 | 6 | 0 |
| H. Cross-Session (v0.9.3) | 1 | 1 | 0 |
| I. Superpowers Methodology (v0.10) | 18 | 16 | 1 partial + 1 not started |
| **Total** | **53** | **45** | **2** |

---

## Completed Categories (archive)

<details>
<summary>A. Post-Code Automation (4/4) — PR, CI, Issue, Changelog 자동화</summary>

- A1 PR Auto-Creation (`pr-create.mjs`) ✅
- A2 CI Monitor & Auto-Fix (`ci-watch.mjs`) ✅
- A3 Issue Tracker Integration (`extractIssueRefs()`) ✅
- A4 Documentation Auto-Update (`changelog.mjs`) ✅
</details>

<details>
<summary>B. User Communication (3/3) — 알림, 진행, 비용</summary>

- B1 Desktop Notifications (`notify.mjs`) ✅
- B2 Progress Briefing (Phase 3 내장) ✅
- B3 Cost Awareness (`cost-estimate.mjs`) ✅
</details>

<details>
<summary>C. Context Intelligence (2/3) — 온보딩, 시각검증, (메모리 독립)</summary>

- C1 Auto Project Onboarding ✅
- C2 Visual Verification ✅
- C3 → 독립 항목 "Pragmatic Memory"로 이동 (아래 G+ 참조)
</details>

<details>
<summary>D. Harness Engineering (4/4) — harness-init, deepinit, 컨텍스트주입, Codex교차검증</summary>

- D1 harness-init 스킬 ✅
- D2 deepinit TOC 포맷 ✅
- D3 Atlas/Athena 하네스 컨텍스트 주입 ✅
- D4 Codex 교차검증 ✅
</details>

<details>
<summary>E. Source-Informed v0.9 (10/10 resolved) — 6 done, 4 merged/dropped</summary>

- E1 Stuck Recovery ✅ | E2 Shared Blackboard ✅ | E3 Run Artifacts ✅ | E6 Capability Detection ✅
- E4 → merged G#1 | E7 → merged G#1 | E8 → merged G#4 | E10 → dropped
- E5 → done via G#2 | E9 → done via G#3
</details>

<details>
<summary>F. Hook System v0.9.1 (4/4) — SubagentStop/Start, SessionEnd, Async</summary>

- F1 SubagentStop Hook ✅ | F2 SubagentStart Hook ✅
- F3 SessionEnd Hook ✅ | F4 Async Hook Configuration ✅
</details>

<details>
<summary>G. Consolidated Backlog v0.9.2 — 3/6 done</summary>

- G#1 Event-Backed Run System ✅ | G#2 Story-Level AC Evidence ✅ | G#3 Completion Notices ✅
- G#5 codex-plugin-cc 통합 ✅ (v0.9.4~v0.9.5: codex-exec, app-server, claude-cli adapter, permission mirroring)
</details>

<details>
<summary>H. Cross-Session v0.9.3 (1/1)</summary>

- H1 Session Registry + /sessions ✅
</details>

---

## Remaining: G — Independent

### G#4. Native Agent Teams — ✅ Done (v0.9.6)

- **구현**: `hasNativeTeamTools` env var 런타임 감지, SKILL.md Path A/B 분기, Gemini 통합
- **스펙**: `docs/plans/native-agent-teams/spec.md`

### G+. Pragmatic Memory — ✅ Done (C3-R)

- **구현**: `scripts/lib/wisdom.mjs` — 토큰 정규화 (47 stop words + 13 suffix rules), 5차원 가중 스코어링, export/import
- **스펙**: `docs/plans/c3r-pragmatic-memory/spec.md`
- **교차검증**: Architect APPROVE + Momus APPROVE (1 revision), Codex PASS + Gemini PASS (48 tests)

---

## Remaining: I — Superpowers Methodology Integration (v0.10)

> 스펙: `docs/plans/superpowers-methodology-integration/spec.md`
> TDD, Brainstorm-first, Systematic Debug, Verification Iron Law, Two-Stage Review를 Atlas/Athena에 통합

### ✅ Done (16/18)

| # | 항목 | 구현 위치 |
|---|------|-----------|
| US-001 | TDD Skill (RED-GREEN-REFACTOR) | `skills/tdd/SKILL.md` |
| US-002 | TDD Gate — Atlas Phase 3 | `skills/atlas/SKILL.md` L497-502 (requiresTDD 라우팅) |
| US-003 | TDD Gate — Athena Phase 2 | `skills/athena/SKILL.md` L395 (TDD_INSTRUCTION 주입) |
| US-004 | Brainstorm Skill (Diverge-Converge-Refine) | `skills/brainstorm/SKILL.md` |
| US-005 | Brainstorm Gate — Atlas/Athena | Atlas L109-211, Athena L96-171 (complex/architectural deep-dive) |
| US-006 | Systematic Debug Skill | `skills/systematic-debug/SKILL.md` |
| US-007 | Debugger Agent — Systematic Debug 통합 | Atlas L558-560 (debugger→systematic-debug→trace 에스컬레이션) |
| US-008 | Trace Skill — Systematic Debug 프로토콜 | `skills/trace/SKILL.md` (3 가설 + 프로브) |
| US-009 | Verification Iron Law | Atlas L515-517, Athena L584-586 (`addVerification()` 호출) |
| US-010 | Finish-Branch Skill | `skills/finish-branch/SKILL.md` |
| US-011 | Two-Stage Code Review — Phase 5 | Atlas L626-645 (architect + security + quality 동시) |
| US-013 | Code-Reviewer Agent — 3단계 리뷰 | `agents/code-reviewer.md` L26-62 (Spec + Quality + Adversarial) |
| US-014 | Debugger Agent — Root-Cause Iron Law | `agents/debugger.md` L8 ("REPRODUCE FIRST (Iron Law)") |
| US-015 | Verify-Coverage 강화 | `skills/verify-coverage/SKILL.md` (SHALLOW COVERAGE 감지) |
| US-017 | Consensus-Plan — TDD 태깅 | `skills/consensus-plan/SKILL.md` L272 (requiresTDD) |
| US-018 | Superpowers Coexistence Detection | `scripts/lib/codex-approval.mjs` (permission mirroring) |

### 🔄 Partial (1/18)

| # | 항목 | 현재 상태 | 남은 작업 |
|---|------|-----------|-----------|
| US-016 | Plan Skill — Brainstorm 연동 | 패턴 문서화됨 (L946-951) | L-scale 시 자동 호출이 아닌 "invoke or ask" 형태 |

### ❌ Not Started (1/18)

| # | 항목 | 설명 |
|---|------|------|
| US-012 | Quality-Gate Agent | `agents/quality-gate.md` 신규 생성 필요 (v0.10 deferred)

---

## Cross-Validation History

| 일시 | 대상 | 결과 |
|------|------|------|
| v0.9 | E1~E10 | 2 AGREE, 7 MODIFY, 3 DISAGREE |
| v0.9.1 | C/E/G 중복 분석 | 3 MERGE, 2 SEQUENCE, 2 KEEP SEPARATE |
| v0.9.2 | G#1~#3 spec | MODIFY (4 Critical, 3 Medium) |
| v0.9.3 | H1 코드 리뷰 | CRITICAL 1, HIGH 2, MEDIUM 1 |

## References

- [Superpowers spec](./superpowers-methodology-integration/spec.md) — 18 User Stories 상세
- [Event-Backed Runs spec](./event-backed-runs/spec.md) — G#1~#3 상세
- [v0.9.5 Deferred spec](./v0.9.5-deferred/spec.md) — G#4 (Native Teams) 상세
- [claw-code](https://github.com/instructkr/claw-code) — E 카테고리 소스 분석 기반
- [codex-plugin-cc](https://github.com/openai/codex-plugin-cc) — G#5 codex-plugin-cc 통합의 참조 구현
