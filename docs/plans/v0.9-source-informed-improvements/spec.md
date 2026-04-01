# v0.9 Source-Informed Improvements

> Claude Code 소스 구조 분석 + Codex 교차검증 기반 개선 계획
> Date: 2026-04-01

## Background

Claude Code 소스 구조([claw-code](https://github.com/instructkr/claw-code) 레포, Python clean-room rewrite)를 분석하여 내부 아키텍처를 파악.
12개 개선 항목(G1-G12) 도출 후 Codex 교차검증 완료.

**Codex Verdict**: 2 AGREE, 7 MODIFY, 3 DISAGREE (96K tokens consumed)

## Prioritized Improvement Items

### Tier 1 — HIGH (바로 착수)

#### E1. Stuck Recovery Policy (was G3)
**Codex: AGREE** | Feasibility: Yes | Value: High | Risk: Low-Medium

- **현황**: `worker-spawn.mjs:232`에 stall detection 존재 (5분 무활동 감지)
- **갭**: 감지 후 복구 정책 없음 — stalled=true 플래그만 설정
- **구현**:
  - `scripts/lib/stuck-recovery.mjs` 신규 모듈
  - 복구 전략 체인: reframe prompt → switch agent → escalate to user
  - Atlas Phase 3/4, Athena Phase 3에서 stall 감지 시 자동 호출
  - wisdom에 stuck 패턴 기록하여 반복 회피

#### E2. Team Shared Blackboard (was G1)
**Codex: MODIFY** | Feasibility: Partial | Value: High | Risk: Medium

- **현황**: Athena workers가 inbox/outbox + worker-status로 소통
- **갭**: 공유 메모리/블랙보드 없음 — 워커 간 학습 전파 불가
- **구현**:
  - `.ao/teams/<slug>/blackboard.jsonl` — append-only shared knowledge
  - `scripts/lib/inbox-outbox.mjs`에 `writeBlackboard()`, `readBlackboard()` 추가
  - 워커가 중요 결정/발견사항을 블랙보드에 기록, 다른 워커가 참조
  - 기존 inbox/outbox 시스템 보완 (대체 아님)

### Tier 2 — MEDIUM (다음 스프린트)

#### E3. Agent Summary Artifacts (was G7)
**Codex: MODIFY** | Feasibility: Partial | Value: Medium | Risk: Low

- **현황**: 오케스트레이션 완료 시 텍스트 보고서만 출력
- **갭**: 구조화된 실행 요약 없음
- **구현**:
  - `.ao/artifacts/runs/<id>/summary.json` — 실행 메타데이터
  - `.ao/artifacts/runs/<id>/events.jsonl` — 타임라인 이벤트
  - `.ao/artifacts/runs/<id>/verification.json` — 검증 결과
  - 메트릭: duration, files_changed, tests_passed, review_verdicts, fallbacks_used
  - Note: token usage는 플러그인에서 접근 불가 → 제외

#### E4. Per-Agent Snapshot (was G2)
**Codex: MODIFY** | Feasibility: Partial | Value: Medium | Risk: Low-Medium

- **현황**: checkpoint에 phase-level state만 저장
- **갭**: 개별 에이전트의 결정/발견사항 보존 안됨
- **구현**:
  - `.ao/state/agent-snapshots/<agent>-<run-id>.json`
  - 에이전트 완료 시 key decisions, blockers, artifacts 저장
  - 오케스트레이터가 다음 스토리 실행 시 관련 스냅샷 참조
  - 기존 wisdom + checkpoint와 상호보완

#### E5. Stronger AC Verification (was G4, refined)
**Codex: MODIFY** | Feasibility: Yes | Value: Medium | Risk: Low

- **현황**: Themis가 코드 품질 게이트 수행, Codex xval이 AC 검증
- **갭**: AC(Acceptance Criteria) 검증이 Codex 의존적 — Codex 없으면 빈약
- **구현**:
  - Themis 프롬프트에 AC checklist 기반 검증 단계 추가
  - PRD의 각 AC를 명시적으로 체크하는 구조화된 검증
  - Codex xval은 보조 수단으로 유지

#### E6. Capability Detection at Startup (Codex 추가 제안)
**Codex: NEW** | Feasibility: Yes | Value: Medium | Risk: Low

- **현황**: Team*, Preview MCP, tmux, codex 등의 존재 여부를 런타임에 암묵적 체크
- **갭**: 명시적 capability detection 없음 — 실패 시 에러 메시지 불명확
- **구현**:
  - `scripts/lib/preflight.mjs`에 capability matrix 추가
  - Phase 0에서 `{ hasTeamTools, hasPreviewMCP, hasTmux, hasCodex, hasGitWorktree }` 감지
  - 부재 시 명시적 fallback 경로 문서화 및 사용자 알림

#### E7. Session Replay via Event Log (was G11, refined)
**Codex: MODIFY** | Feasibility: Partial | Value: Medium | Risk: Low

- **현황**: wisdom.jsonl에 고수준 학습만 기록
- **갭**: 오케스트레이션 결정 흐름 재현 불가
- **구현**:
  - E3의 `events.jsonl`을 기반으로 replay 스킬 추가
  - `/replay <run-id>` — 과거 실행의 결정 트리 시각화
  - 의존성: E3 완료 후 구현 가능

#### E8. TaskUpdate Enrichment (was G5)
**Codex: MODIFY** | Feasibility: Conditional | Value: Medium-Low | Risk: Low

- **현황**: Athena가 Team*/Task* 도구 사용 (agents/athena.md:39-45)
- **갭**: TaskUpdate로 더 풍부한 상태 업데이트 가능하나 활용 부족
- **구현**:
  - feature detection으로 TaskUpdate 가용 시 활용
  - 기존 file-backed status는 fallback으로 유지
  - Phase 3 worker monitoring에서 TaskUpdate 호출 추가

### Tier 3 — LOW (백로그)

#### E9. Next-Step Suggestion (was G8)
**Codex: MODIFY** | Feasibility: Yes | Value: Low-Medium | Risk: Low

- opt-in only, 명확한 다음 액션이 있을 때만 표시
- Atlas/Athena 완료 후 "deploy?", "add tests?", "refactor?" 제안

#### E10. Batch Skill (was G10)
**Codex: AGREE** | Feasibility: Yes | Value: Low-Medium | Risk: Medium

- `/batch` 스킬로 여러 스킬 순차 실행
- ui-review의 기존 체이닝 패턴 참고
- 스코프 제한 필수 (무분별한 매크로 방지)

### DONE / DROPPED

#### G12. Marketplace Integration — ALREADY DONE
- `.claude-plugin/marketplace.json` 이미 존재

#### G6. MCP-to-Skill Bridge — DROPPED
- Codex: static SKILL.md 모델과 호환 안됨
- 큐레이팅된 개별 wrapper는 필요 시 추가

#### G9. Plugin Auto-Update — DROPPED
- Codex: 진정한 auto-update는 플러그인 영역 아님
- SessionStart 5초 예산 내 네트워크 호출 비현실적

---

## Codex 추가 제안 (반영됨)

1. **Capability detection** → E6으로 반영
2. **Structured per-run artifacts** → E3으로 반영 (G7 + G11 동시 해결 기반)
3. **Hook duration monitoring** → E6 preflight에 포함
4. **Story-level verification evidence in checkpoints** → E5에 포함

## Implementation Order

```
Phase 1: E1 (Stuck Recovery) + E2 (Team Blackboard)
Phase 2: E3 (Run Artifacts) + E6 (Capability Detection)
Phase 3: E4 (Agent Snapshots) + E5 (AC Verification)
Phase 4: E7 (Session Replay) + E8 (TaskUpdate)
Phase 5: E9 (Next-Step) + E10 (Batch)
```

## File Impact

| Module | Files Affected |
|--------|---------------|
| E1 | `scripts/lib/stuck-recovery.mjs` (new), `scripts/lib/worker-spawn.mjs`, Atlas SKILL.md, Athena SKILL.md |
| E2 | `scripts/lib/inbox-outbox.mjs`, Athena SKILL.md |
| E3 | `scripts/lib/run-artifacts.mjs` (new), Atlas SKILL.md, Athena SKILL.md |
| E4 | `scripts/lib/agent-snapshot.mjs` (new), Atlas SKILL.md |
| E5 | `agents/themis.md`, Atlas SKILL.md, Athena SKILL.md |
| E6 | `scripts/lib/preflight.mjs`, Atlas SKILL.md, Athena SKILL.md |
| E7 | `skills/replay/SKILL.md` (new), depends on E3 |
| E8 | `scripts/lib/worker-spawn.mjs`, Athena SKILL.md |
| E9 | Atlas SKILL.md, Athena SKILL.md |
| E10 | `skills/batch/SKILL.md` (new) |
