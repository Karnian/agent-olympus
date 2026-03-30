# Agent Olympus — Improvement Tracker

> 전체 개선 항목의 구현 현황을 추적하는 문서. 버전 무관, 카테고리별 정리.

**Last Updated**: 2026-03-30

---

## Summary

| Category | Total | Done | Partial | Remaining |
|----------|-------|------|---------|-----------|
| Post-Code Automation | 4 | 4 | 0 | 0 |
| User Communication | 3 | 3 | 0 | 0 |
| Context Intelligence | 3 | 2 | 1 | 0 |
| **Total** | **10** | **9** | **1** | **0** |

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

### C3. Semantic Memory — 🟡 Partial

- **구현된 부분**: `scripts/lib/wisdom.mjs`
  - JSONL 기반 구조화된 학습 기록 (`wisdom.jsonl`)
  - 카테고리/신뢰도/인텐트 기반 필터링
  - Jaccard 유사도(≥0.7) 기반 중복 제거
  - 90일 자동 정리, 200개 상한
- **미구현 부분**:
  - 벡터 임베딩 기반 시맨틱 검색
  - 외부 임베딩 API 연동
  - 크로스 프로젝트 지식 공유
- **비고**: 현재 키워드/카테고리 검색으로 충분히 동작. 시맨틱 검색은 wisdom이 200개 이상 또는 다중 프로젝트로 확장될 때 가치가 커짐

---

## Origin

이 항목들은 `docs/plans/v0.8-post-code-automation/spec.md`에서 최초 정의됨.
원본 스펙의 상세 요구사항, Acceptance Criteria, 구현 노트는 해당 문서 참조.
