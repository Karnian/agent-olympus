# Agent Olympus — Improvement Tracker

> 전체 개선 항목의 구현 현황을 추적하는 문서. 버전 무관, 카테고리별 정리.

**Last Updated**: 2026-04-02 (v0.9.3 — Cross-Session Management System 구현 완료)

---

## Summary

| Category | Total | Done | Merged/Dropped | Remaining |
|----------|-------|------|----------------|-----------|
| A. Post-Code Automation | 4 | 4 | 0 | 0 |
| B. User Communication | 3 | 3 | 0 | 0 |
| C. Context Intelligence | 3 | 2 | 0 | 1 (redefine) |
| D. Harness Engineering | 4 | 4 | 0 | 0 |
| E. Source-Informed (v0.9) | 10 | 4 | 4 (merge/drop) | 2 (done via G) |
| F. Hook System (v0.9.1) | 4 | 4 | 0 | 0 |
| G. Consolidated Backlog (v0.9.2) | 5+1 | 3 | 0 | 2 (blocked) + 1 (redefine) |
| H. Cross-Session (v0.9.3) | 1 | 1 | 0 | 0 |
| **Total** | **29+G** | **25** | **4** | **3 (2 blocked + 1 redefine)** |

### Consolidated Backlog (교차검증 후)

| # | 항목 | 구성 요소 | 우선순위 | 상태 |
|---|------|-----------|---------|------|
| 1 | Event-Backed Run System | E3확장+G3+E7+E4+F1통합 | High | ✅ Done (v0.9.2) |
| 2 | Story-Level AC Evidence | E5 재정의 | Medium | ✅ Done (v0.9.2) |
| 3 | Completion Notices | E9 재정의 | Low | ✅ Done (v0.9.2) |
| 4 | Native Agent Teams | G2+E8 | Blocked | 🔒 experimental 졸업 대기 |
| 5 | codex-plugin-cc 통합 | G1 | Blocked | 🔒 app-server 안정화 대기 |
| + | Pragmatic Memory | C3 재정의 | Low | 🔄 독립 |

**실행 이력**: 1 → 2 → 3 완료 (v0.9.2). 4, 5는 외부 의존성 해소 대기. C3-R은 독립적으로 언제든.

---

## A. Post-Code Automation

코드 작성 이후 워크플로우(PR, CI, 이슈, 문서)를 자동화하는 항목들.

### A1. PR Auto-Creation — ✅ Done

- **구현**: `scripts/lib/pr-create.mjs`
- **주요 함수**: `createPR()`, `buildPRBody()`, `extractIssueRefs()`, `findExistingPR()`
- **통합 지점**: Atlas/Athena Phase 6
- **동작**: commit message + PRD에서 PR 제목/본문 자동 생성, 이슈 링크, 라벨 부여, `gh pr create` 실행

### A2. CI Monitor & Auto-Fix — ✅ Done

- **구현**: `scripts/lib/ci-watch.mjs`
- **주요 함수**: `watchCI()`, `getFailedLogs()`
- **통합 지점**: Atlas/Athena Phase 6b
- **동작**: PR 생성 후 GitHub Actions 폴링 → 실패 시 로그 가져와 debugger 에스컬레이션 → 자동 수정 후 재푸시 (최대 2사이클)

### A3. Issue Tracker Integration — ✅ Done

- **구현**: `scripts/lib/pr-create.mjs` 내 `extractIssueRefs()`
- **통합 지점**: Phase 6 PR 생성 시
- **동작**: 브랜치명(`feat/42-description`) + 커밋 메시지에서 이슈 번호 추출 → PR body에 `Closes #42` 자동 추가

### A4. Documentation Auto-Update — ✅ Done

- **구현**: `scripts/lib/changelog.mjs`
- **주요 함수**: `generateChangelogEntry()`, `prependToChangelog()`
- **통합 지점**: Atlas/Athena Phase 5c
- **동작**: PRD 유저스토리에서 CHANGELOG 엔트리 자동 생성 → CHANGELOG.md 상단에 삽입

---

## B. User Communication

오케스트레이터와 사용자 간 커뮤니케이션 개선 항목들.

### B1. Desktop Notifications — ✅ Done

- **구현**: `scripts/lib/notify.mjs`, `scripts/notify-cli.mjs`
- **동작**: macOS(`osascript`), Linux(`notify-send`), fallback(terminal bell) 지원. 8개 이벤트 템플릿(`complete`, `blocked`, `escalated`, `ci_failed`, `ci_passed`, `started`, `progress`, `done`)
- **버그 수정 (PR #7)**:
  - 테스트 실행 시 실제 OS 알림 발사 → `IS_TEST` 가드 추가
  - "스크립트 편집기" 표시 → `detectTerminalApp()`으로 터미널 앱 감지
  - `onCIFail` 이벤트명 불일치 → `ci_failed`로 수정
- **추가 수정 (PR #8, v0.8.4)**:
  - `detectTerminalApp()`: `'iTerm'` → `'iTerm2'` 오탈자 수정

### B2. Progress Briefing — ✅ Done

- **구현**: Atlas/Athena SKILL.md Phase 3에 내장
- **동작**: 스토리/워커별 진행 로깅, 정체 감지, 컴팩트 상태 테이블 출력
- **비고**: 별도 유틸리티 없이 오케스트레이터 로직에 직접 포함

### B3. Cost Awareness — ✅ Done

- **구현**: `scripts/lib/cost-estimate.mjs`
- **주요 함수**: `estimateCost()`
- **통합 지점**: Atlas/Athena Phase 2 (Plan)
- **동작**: 모델별 토큰 단가 테이블 기반 비용 추정 → 사용자에게 표시. `.ao/autonomy.json`의 `budget.warnThresholdUsd` 설정 시 경고

---

## C. Context Intelligence

오케스트레이터의 컨텍스트 이해 및 학습 능력 개선 항목들.

### C1. Auto Project Onboarding — ✅ Done

- **구현**: Atlas/Athena Phase 0에서 `AGENTS.md` 존재 여부 확인
- **통합 지점**: Phase 0 (Triage) 시작 시
- **동작**: `AGENTS.md` 없으면 `deepinit` 스킬 자동 호출 → 코드베이스 구조 분석 후 생성. 프로젝트당 1회만 실행

### C2. Visual Verification — ✅ Done

- **구현**: Atlas SKILL.md Phase 4.2 (Optional)
- **동작**: 프론트엔드 파일 변경 감지 → 프리뷰 서버 시작 → 스크린샷 캡처 + 콘솔 에러 체크 + 접근성 트리 검증 → 이슈 발견 시 designer 에이전트 투입 (최대 2사이클)
- **의존성**: Claude Preview MCP + `.claude/launch.json` 필요. 없으면 자동 스킵

### C3. Pragmatic Memory — 🔄 Redefine

- **구현된 부분**: `scripts/lib/wisdom.mjs`
  - JSONL 기반 구조화된 학습 기록 (`wisdom.jsonl`)
  - 카테고리/신뢰도/인텐트 기반 필터링
  - Jaccard 유사도(≥0.7) 기반 중복 제거
  - 90일 자동 정리, 200개 상한
- **재정의 (Codex 교차검증)**: "Semantic Memory" → "Pragmatic Memory"로 축소
  - ~~벡터 임베딩 기반 시맨틱 검색~~ → DROP (zero npm deps 제약, 외부 API 불가)
  - ~~크로스 프로젝트 지식 공유~~ → DROP (자동 공유는 복잡도만 추가)
  - **남은 작업**: 토큰 정규화/점수 개선 + 명시적 export/import (`wisdom export/import`)
- **비고**: wisdom은 큐레이션된 학습 기록. G3 event log와는 라이프사이클이 다름 (KEEP SEPARATE 확인)

---

## D. Harness Engineering (v0.8.6)

OpenAI 하네스 엔지니어링 원칙을 agent-olympus 워크플로우에 통합.
참고: [OpenAI Harness Engineering](https://openai.com/index/harness-engineering/)

### D1. harness-init 스킬 — ✅ Done

- **구현**: `skills/harness-init/SKILL.md`
- **동작**: 새 프로젝트에 하네스 구조 초기화 — AGENTS.md(TOC), docs/golden-principles.md, docs/ARCHITECTURE.md, docs/design-docs/, docs/exec-plans/, docs/QUALITY_SCORE.md, 구조적 테스트 스텁 생성

### D2. deepinit TOC 포맷 전환 — ✅ Done

- **구현**: `skills/deepinit/SKILL.md` Phase 3 + Phase 3.5
- **동작**: AGENTS.md를 ≤100줄 목차로 생성. harness-init 실행 전이면 docs/ 스텁 자동 생성

### D3. Atlas/Athena 하네스 컨텍스트 주입 — ✅ Done

- **구현**: `skills/atlas/SKILL.md` Phase 0 Harness Check, `skills/athena/SKILL.md` Phase 0 Harness Check
- **동작**: Phase 0에서 docs/golden-principles.md 로드 → 모든 executor/Codex 워커 프롬프트에 harness_context 주입

### D4. Codex 교차검증 (매 스토리) — ✅ Done

- **구현**: Atlas Phase 3 `atlas-codex-xval-<story-id>`, Athena Phase 4 `athena-<slug>-codex-xval-<story-id>`
- **동작**: 각 스토리 완료 후 Codex가 acceptance criteria + golden principles + 아키텍처 레이어 준수 여부 검증. FAIL 시 최대 2사이클 재시도. Codex 미설치 시 graceful skip

---

## E. Source-Informed Improvements (v0.9)

Claude Code 소스 구조(claw-code) 분석 + Codex 교차검증으로 도출된 10개 항목.
상세 스펙: [v0.9 spec](./v0.9-source-informed-improvements/spec.md)
참고: [claw-code](https://github.com/instructkr/claw-code) — Claude Code Python clean-room rewrite

### E1. Stuck Recovery Policy — ✅ Done

- **구현**: `scripts/lib/stuck-recovery.mjs`
- **주요 함수**: `buildRecoveryStrategy()`, `formatRecoveryLog()`, `RECOVERY_STRATEGIES`
- **통합 지점**: `worker-spawn.mjs` monitorTeam() stall detection
- **동작**: 3-tier 복구 체인 (reframe → switch-agent → escalate), wisdom에 패턴 기록

### E2. Team Shared Blackboard — ✅ Done

- **구현**: `scripts/lib/inbox-outbox.mjs` (`writeBlackboard`, `readBlackboard`)
- **통합 지점**: Athena Phase 3 워커 간 지식 공유
- **동작**: JSONL append-only 블랙보드, category/limit/since 필터링

### E3. Run Artifacts — ✅ Done

- **구현**: `scripts/lib/run-artifacts.mjs`
- **주요 함수**: `createRun()`, `addEvent()`, `addVerification()`, `finalizeRun()`, `listRuns()`, `getRun()`
- **통합 지점**: Atlas/Athena 오케스트레이션 시작~종료
- **동작**: 구조화된 실행 기록 (events.jsonl + summary.json + verification.jsonl)

### E4. Per-Agent Snapshot — ➡️ Merged → Consolidated #1

- **원래 계획**: `.ao/state/agent-snapshots/<agent>-<run-id>.json`
- **Codex 판정**: MERGE → E3+F1. `subagent-stop.mjs`가 이미 결과 캡처. 별도 snapshot 디렉토리는 중복 저장소. run-artifacts에 runId/storyId/phase 키로 통합
- **행선지**: Consolidated Backlog #1 (Event-Backed Run System)

### E5. Story-Level AC Evidence — ✅ Done (via G#2, v0.9.2)

- **원래 계획**: Acceptance Criteria 자동 검증 프레임워크
- **Codex 판정**: REDEFINE → Consolidated Backlog #2로 이동
- **구현 완료**: `addVerification()` criteria 배열 확장, `verifyStory()`, `getRunVerificationSummary()` — v0.9.2

### E6. Capability Detection — ✅ Done

- **구현**: `scripts/lib/preflight.mjs` (`detectCapabilities`, `formatCapabilityReport`)
- **통합 지점**: `session-start.mjs` 세션 시작 시
- **동작**: tmux/codex/worktree/preview MCP 런타임 감지 + 자동 리포트

### E7. Session Replay — ➡️ Merged → Consolidated #1

- **원래 계획**: Run artifacts 기반 실행 재생
- **Codex 판정**: MERGE → G3. `events.jsonl` 인프라는 있으나 런타임 호출 부재. 리플레이 UI보다 이벤트 소싱 기반 복구/디버깅이 더 가치 있음
- **행선지**: Consolidated Backlog #1 (Event-Backed Run System)

### E8. TaskUpdate Events — ➡️ Merged → Consolidated #4

- **원래 계획**: 워커 진행률 실시간 이벤트 스트림
- **Codex 판정**: MERGE → G2. `worker-status.mjs`가 이미 상태 추적. `TaskUpdate`는 Native Teams 전환 시에만 의미. `hasTeamTools = true` 하드코딩 상태에서 별도 구현 불필요
- **행선지**: Consolidated Backlog #4 (Native Agent Teams)

### E9. Completion Notices — ✅ Done (via G#3, v0.9.2)

- **원래 계획**: 실행 완료 후 다음 액션 자동 제안
- **Codex 판정**: REDEFINE → Consolidated Backlog #3으로 이동
- **구현 완료**: `generateCompletionNotices()` 6가지 갭 타입 감지 — v0.9.2

### E10. Batch Orchestration — ❌ Dropped

- **원래 계획**: 다수 태스크 순차/병렬 배치 실행
- **Codex 판정**: DROP. Atlas는 스토리 분해로, Athena는 병렬 워커로 이미 배치 처리. 비관련 작업은 쉘 시퀀싱이 더 명확. 별도 `/batch` 스킬은 복잡도 대비 가치 없음

---

## F. Hook System Extensions (v0.9.1)

자체 평가 + 외부 생태계 연구를 기반으로 도출된 훅 시스템 확장 항목.
Claude Code 훅 API가 28개 이벤트로 확장된 것에 맞춰 신규 훅 3종 추가 + 비동기 설정 적용.

### F1. SubagentStop Hook — ✅ Done

- **구현**: `scripts/subagent-stop.mjs`
- **통합 지점**: `hooks/hooks.json` SubagentStop 이벤트 (async: true)
- **동작**: 서브에이전트 완료 시 `last_assistant_message` 등 결과를 `.ao/state/ao-subagent-results.json`에 캡처 (50개 FIFO). 수동 트랜스크립트 파싱 대체

### F2. SubagentStart Hook — ✅ Done

- **구현**: `scripts/subagent-start.mjs`
- **통합 지점**: `hooks/hooks.json` SubagentStart 이벤트 (동기)
- **동작**: 서브에이전트 스폰 시 `.ao/wisdom.jsonl`에서 최근 10개 학습 항목 로드 → `additionalContext`로 주입

### F3. SessionEnd Hook — ✅ Done

- **구현**: `scripts/session-end.mjs`
- **통합 지점**: `hooks/hooks.json` SessionEnd 이벤트 (async: true)
- **동작**: 세션 종료 시 24시간 이상 된 `.ao/state/` 파일과 `.ao/teams/` 디렉토리 정리. Stop 훅(WIP 커밋)의 보완

### F4. Async Hook Configuration — ✅ Done

- **구현**: `hooks/hooks.json` 수정
- **동작**: PostToolUse(concurrency-release), SubagentStop, SessionEnd 훅에 `"async": true` 설정. 메인 세션 블로킹 방지. SubagentStart는 의도적으로 동기(컨텍스트 주입이 스폰 전에 완료되어야 함)

---

## G. Consolidated Backlog (v0.9.2)

Codex 교차검증 2차(C/E/G 중복 분석, 213K tokens)를 거쳐 통합된 백로그.
기존 E 카테고리 백로그 6건 + G 카테고리 3건 → **5건으로 통합** (4 merged, 1 dropped, 2 redefined, 2 blocked).
상세 스펙: [event-backed-runs spec](./event-backed-runs/spec.md), [v0.10 deferred spec](./v0.10-deferred/spec.md)

### #1. Event-Backed Run System — ✅ Done (v0.9.2)

- **통합 항목**: E3 확장 + G3(이벤트 소싱) + E7(세션 리플레이) + E4(에이전트 스냅샷) + F1(subagent-stop) 통합
- **핵심**: `run-artifacts.mjs`의 `addEvent()`를 canonical append-only 이벤트 로그로 확장. `checkpoint.mjs`는 이벤트 emit + replay 지원
- **구현 내역**:
  - Active Run Identity: `getActiveRunId()`, `setActiveRunId()`, `discoverActiveRun()` — `.ao/state/ao-active-run-<orchestrator>.json`
  - `createRun()` → active-run 포인터 자동 생성, `finalizeRun()` → compare-and-delete + `run_finalized` 이벤트
  - `saveCheckpoint()` → `phase_transition` + `checkpoint_saved` 이벤트 자동 발행 (active run 있을 때만)
  - `clearCheckpoint()` → `checkpoint_cleared` 이벤트 발행
  - `subagent-stop.mjs` → `discoverActiveRun()` 으로 양쪽 orchestrator 확인 후 `subagent_completed` 이벤트 발행
  - `replayEvents(runId)` → event log에서 checkpoint 상태 재구성
  - `PHASE_NAMES` export
- **테스트**: 11 tests (checkpoint-events.test.mjs)
- **스펙**: [event-backed-runs/spec.md](./event-backed-runs/spec.md) US-001~US-005

### #2. Story-Level AC Evidence — ✅ Done (v0.9.2)

- **통합 항목**: E5 재정의
- **핵심**: Themis는 범용 품질 게이트. AC 검증은 스토리/기준별 PASS/FAIL/SKIP + 구체적 증거
- **구현 내역**:
  - `addVerification()` 확장: `criteria` 배열 지원 (criterion_index, criterion_text, verdict, evidence)
  - `verifyStory(runId, storyId)` — 스토리별 기준 집계 (fail > skip > pass 우선순위)
  - `getRunVerificationSummary(runId)` — 전체 스토리 요약 (total/passed/failed/skipped)
  - `verification_result` 이벤트: full payload 포함 (Codex 피드백 반영)
  - 기존 스키마 (criteria 없음) 하위 호환 유지
- **테스트**: 10 tests (completion-notices.test.mjs)
- **스펙**: [event-backed-runs/spec.md](./event-backed-runs/spec.md) US-006~US-007

### #3. Completion Notices — ✅ Done (v0.9.2)

- **통합 항목**: E9 재정의
- **핵심**: 범용 제안 → 미해결 갭 기반 구체적 notice만 출력
- **구현 내역**:
  - `generateCompletionNotices(runId)` — 6가지 갭 타입 감지
  - 갭 타입: `tests_skipped`, `manual_review_needed`, `preview_skipped`, `codex_unavailable`, `unresolved_warnings`, `worker_failed`
  - Story-level + Criterion-level 양쪽에서 evidence 기반 탐지
  - Event log에서 `warning`, `worker_failed` 이벤트 탐지
  - 갭 없으면 빈 배열 (노이즈 없음)
- **테스트**: 8 tests (completion-notices.test.mjs)
- **스펙**: [event-backed-runs/spec.md](./event-backed-runs/spec.md) US-008

### #4. Native Agent Teams — 🔒 Blocked (High when unblocked)

- **통합 항목**: G2 + E8(TaskUpdate)
- **핵심**: Athena를 네이티브 팀 위의 래퍼로 전환. Codex 통합 + 에이전트 페르소나가 부가가치
- **구현 계획**:
  - feature-flag: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` 감지
  - 네이티브 `TeamCreate`/`SendMessage`/`TaskUpdate`/worktree 사용
  - `worker-status.mjs`는 fallback으로만 유지, 상태 전이는 canonical event log에 기록
  - 미지원 환경 → 현재 Athena 구현으로 폴백
- **의존성**: Native Agent Teams experimental 졸업
- **참고**: #1과 event sink 공유 (상태 전이를 event log에 기록)

### #5. codex-plugin-cc 통합 — 🔒 Blocked (Should-have when unblocked)

- **통합 항목**: G1
- **핵심**: `codex app-server` JSON-RPC로 tmux 기반 Codex 호출 대체
- **구현 계획**:
  - `scripts/lib/codex-appserver.mjs` thin client
  - Broker 패턴으로 워커 간 Codex 런타임 공유
  - Adversarial review 프롬프트 참고
  - Codex job tracker는 provider-local로 유지, coarse 이벤트만 #1 event log에 emit (KEEP SEPARATE 확인)
  - review-gate는 #2의 AC evidence를 소비하는 구조
- **의존성**: Codex CLI app-server 안정화

---

## H. Cross-Session Management (v0.9.3)

세션 간 지식 공유 및 추적 시스템. Codex(GPT-5.4) + Claude code-reviewer 교차검증.

### H1. Session Registry + /sessions 스킬 — ✅ Done

- **구현**:
  - `scripts/lib/session-registry.mjs` *(new)* — 세션 레지스트리 라이브러리
  - `scripts/session-start.mjs` — crash recovery + 세션 등록 추가
  - `scripts/session-end.mjs` — 세션 종료 기록 + 자동 정리
  - `scripts/lib/run-artifacts.mjs` — `createRun()` 시 sessionId 링크
  - `skills/sessions/SKILL.md` *(new)* — on-demand 세션 브라우저 스킬
  - `scripts/test/session-registry.test.mjs` *(new)* — 19 unit tests
- **주요 기능**: 세션 등록/종료/조회, crash recovery, run 연결, alive 체크, TTL 정리, 세션 재개(tmux)
- **교차검증 수정사항**:
  - CRITICAL: `currentSessionPath()` worktree 경로 불일치 수정
  - HIGH: `recoverCrashedSession()` isSessionAlive() 미호출 수정
  - HIGH: `pruneSessions()` active 세션 보호 추가
  - MEDIUM: `listSessions` 테스트 타이밍 flaky 수정

---

## Origin

이 항목들은 `docs/plans/v0.8-post-code-automation/spec.md`에서 최초 정의됨.
원본 스펙의 상세 요구사항, Acceptance Criteria, 구현 노트는 해당 문서 참조.

## Cross-Validation History

| 일시 | 대상 | Codex tokens | 결과 |
|------|------|-------------|------|
| v0.9 | E1~E10 초기 도출 | 96K | 2 AGREE, 7 MODIFY, 3 DISAGREE |
| v0.9.1 (1차) | C3, E4~E10 재검토 | 54K | 1 REDEFINE, 3 MERGE, 2 REDEFINE, 1 DROP |
| v0.9.1 (2차) | C/E/G 전체 중복 분석 | 159K | 3 MERGE, 2 SEQUENCE, 2 KEEP SEPARATE |
| v0.9.2 (스펙) | G#1~#3 spec 교차검증 | 126K | MODIFY (4 Critical, 3 Medium) → 반영 후 구현 |
| v0.9.3 | H1 구현 + 코드 리뷰 | — | CRITICAL 1, HIGH 2, MEDIUM 1 → 전부 수정 |

## References

- [claw-code](https://github.com/instructkr/claw-code) — Claude Code Python clean-room rewrite. E 카테고리(v0.9) 개선 항목의 소스 분석 기반
- `docs/plans/v0.9-source-informed-improvements/spec.md` — v0.9 상세 스펙 (Codex 교차검증 결과 포함)
- `docs/plans/v0.10-deferred/spec.md` — Consolidated Backlog #4, #5 상세 스펙 (codex-plugin-cc, Native Teams, Event Sourcing)
