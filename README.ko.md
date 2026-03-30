# Agent Olympus

**Language / 언어:** [English](README.md) | [한국어](README.ko.md)

> Claude Code용 자율 주행 AI 오케스트레이터 플러그인 — 의존성 제로, 최대 자율성.

Agent Olympus는 Claude Code를 위한 독립형 플러그인으로, 소프트웨어 개발 전 과정을 자동화합니다. 작업을 요청하면 전문화된 AI 에이전트들이 요구사항 분석부터 구현, 검증, 코드 리뷰, 최종 커밋까지 자율적으로 처리합니다. 빌드가 성공하고 테스트가 통과하고 모든 검토가 승인될 때까지 자동으로 반복합니다.

2개의 오케스트레이터, 18개의 전문 에이전트, 24개의 워크플로우 스킬. npm 의존성 제로.

## 무엇을 하는가

Agent Olympus는 **감독 문제**를 해결합니다. AI에게 일일이 지시하는 대신, 목표만 설명하면 오케스트레이터가 모든 복잡성을 처리합니다. 계획 수립, 전문 에이전트에게 작업 분배, 결과 통합, 실패 처리, 모든 기준이 충족될 때까지 반복.

두 가지 모드:

- **Atlas** — 허브-앤-스포크 오케스트레이션. 하나의 두뇌가 작업을 분석하고, 계획을 세우고, 전문 에이전트를 병렬로 실행하고, 결과를 검증하고, 문제를 자율적으로 수정. 독립적이고 병렬화 가능한 작업에 최적.
- **Athena** — 피어-투-피어 팀 오케스트레이션. 여러 에이전트가 SendMessage로 서로 직접 협력하고, Codex 워커는 tmux를 통해 실행. 실시간 조율이 필요한 상호의존적 작업에 최적.

두 모드 모두 수용 기준 충족, 빌드 통과, 테스트 통과, 코드 리뷰 승인될 때까지 루프하거나 해결 불가 시 증거와 함께 에스컬레이션합니다.

## 주요 기능

- **2개의 오케스트레이터**: Atlas (허브-앤-스포크)와 Athena (피어-투-피어 팀)
- **18개 전문 에이전트**: 분석가(Metis), 전략가(Prometheus), 검증자(Momus), 기획자(Hermes), 개발자(Executor), 디자이너, **Aphrodite(디자인 리뷰)**, 테스트 엔지니어, 디버거, 아키텍트, 보안 검수자, 코드 리뷰어, 작가(Writer), 탐색가(Explore), Hephaestus, Themis(품질 게이트), Atlas, Athena
- **24개 워크플로우 스킬**: atlas, athena, plan, ask, deep-interview, research, trace, cancel, slop-cleaner, git-master, deepinit, deep-dive, consensus-plan, external-context, verify-coverage, tdd, systematic-debug, brainstorm, finish-branch, **design-critique, a11y-audit, design-system-audit, ux-copy-review, ui-review**
- **세션 복구**: 체크포인트 시스템으로 중단 후 어느 단계에서든 재개
- **구조화된 Wisdom**: JSONL 형식의 세션 간 학습 데이터베이스; Intent-aware 쿼리 확장 지원
- **npm 의존성 제로**: Node.js 내장 모듈만 사용
- **멀티 모델 지원**: Claude (Opus/Sonnet/Haiku) + tmux 통한 Codex/Gemini
- **다국어 의도 감지**: 모든 스킬에 영어, 한국어, 일본어, 중국어 별칭 지원
- **워커 상태 대시보드**: Athena 팀 실행 중 실시간 인라인 마크다운 상태 표시
- **Athena 워크트리 격리**: 각 병렬 워커가 독립된 git worktree에서 실행, 파일 충돌 방지
- **SessionStart 훅**: 세션 시작 시 이전 wisdom과 중단된 체크포인트 컨텍스트 자동 주입
- **Stop 훅 WIP 커밋**: 세션 종료 시 미커밋 작업을 WIP 커밋으로 자동 저장
- **원자적 파일 쓰기**: 모든 상태 파일이 tmp+rename 패턴으로 기록 (충돌 방지)
- **Superpowers 방법론 통합**: TDD 규율, 체계적 디버깅, 브레인스토밍 우선 게이트, 2단계 코드 리뷰 — 네이티브 스킬로 내장 (Superpowers 별도 설치 불필요)
- **코드 후 자동화** *(v0.8)*: 커밋 후 — PR 자동 생성, 이슈 참조 파싱, CI 감시, 실패 자동 수정, CHANGELOG 업데이트
- **Ship 정책 설정** *(v0.8)*: `.ao/autonomy.json`으로 `autoPush`, `draftPR`, `ci.maxCycles`, `notify.*`, `costAwareness` 제어
- **OS 알림** *(v0.8)*: 작업 완료/차단/CI 이벤트 시 데스크탑 알림 — macOS, Linux, 터미널 벨 폴백
- **비용 인식** *(v0.8)*: 장시간 실행 전 토큰 비용 추정 표시
- **자동 온보딩** *(v0.8)*: `AGENTS.md` 없으면 `deepinit` 자동 실행
- **비주얼 검증** *(v0.8)*: UI 변경 감지 시 Claude Preview MCP 스크린샷으로 선택적 검증
- **UI/UX 디자인 리뷰** *(v0.8.3)*: Aphrodite 에이전트 + 5개 디자인 스킬 — 디자인 비평(Nielsen+Gestalt), 접근성 감사(WCAG 2.2 AA), 디자인 시스템 감사(토큰 누수), UX 카피 리뷰, 통합 UI 리뷰
- **390개+ 단위 테스트**: `node:test` 기반 25개 파일의 종합 테스트 스위트
- **페일-세이프 아키텍처**: 훅이 Claude Code를 절대 차단하지 않음; 에러 시 우아한 저하

## 설치

### Marketplace에서 설치 (권장)

1. Claude Code 실행
2. **Marketplace** → **Productivity** 이동
3. Karnian의 **Agent Olympus** 검색
4. **Install** 클릭

### 수동 설치

저장소를 클론하여 Claude Code 플러그인 디렉토리에 배치:

```bash
git clone https://github.com/Karnian/agent-olympus.git ~/.claude/plugins/agent-olympus
```

## 빠른 시작

### Atlas (허브-앤-스포크)

자율 작업 시작:

```
/atlas 로그인과 회원가입이 포함된 사용자 인증 시스템을 구축해줘
```

다국어 별칭도 사용 가능:

```
/아틀라스 사용자 로그인 시스템을 구현해줘
/해줘 결제 처리 파이프라인을 재구축해줘
```

Atlas가 자동으로:

1. **Triage** — 작업 분류 (단순 vs 복잡)
2. **Analyze** — 영향 받는 파일과 의존성 분석
3. **Plan** — 수용 기준이 포함된 구조화된 작업 분해 계획 수립
4. **Validate** — 계획 검증 (조기에 블로킹 이슈 발견)
5. **Execute** — 전문 에이전트를 병렬로 실행
6. **Verify** — 빌드, 테스트, 린팅 실행
7. **Review** — 아키텍처, 보안, 코드 품질 검토
8. **Loop** — 실패 시 디버그하고 모든 기준 통과까지 반복

### Athena (피어-투-피어 팀)

협력 팀 소환:

```
/athena API, 프론트엔드, 테스트, 문서를 포함한 풀스택 기능을 구축해줘
```

Athena가 자동으로:

1. **Team Design** — Claude 워커 + Codex 워커 팀 설계
2. **Plan** — 작업 배정 및 핸드오프 포인트 정의
3. **Spawn** — 모든 워커를 동시에 실행 (각각 독립 git worktree)
4. **Monitor** — Claude↔Codex 통신 중계, 워커 블로킹 해소
5. **Integrate** — 결과물 병합 및 빌드+테스트 실행
6. **Review** — 전체 리뷰어 실행, 반려 시 수정
7. **Loop** — 모든 워커 출력이 테스트되고 승인될 때까지 반복

### 중단된 작업 재개

세션이 중단되었다면:

```
/atlas [이전 작업]
```

오케스트레이터가 체크포인트를 감지하고 재개 여부를 제안합니다:

```
[이전 세션 발견: Phase 3/EXECUTE. 완료: 2/5 스토리.
Phase 3에서 재개하시겠습니까, 아니면 새로 시작하시겠습니까?]
```

`resume`로 답하면 중단된 곳에서 이어집니다.

### 코드 후 자동화 (v0.8.0 신규)

`/atlas` 또는 `/athena`가 커밋까지 완료하면 SHIP 단계가 자동으로 실행됩니다:

1. `.ao/autonomy.json`에서 ship 정책 읽기 (`autoPush`, `draftPR`, `ci.maxCycles`)
2. 브랜치 푸시 및 PR 생성 (브랜치/커밋에서 이슈 참조 자동 파싱)
3. `gh run list`로 CI 감시 (통과 또는 실패까지)
4. CI 실패 시: 실패 로그 수집 → 디버거 실행 → 수정 → 재푸시 → 재확인 (최대 3회)
5. 완료 또는 차단 시 데스크탑 알림 전송

프로젝트에 `.ao/autonomy.json` 생성으로 설정:

```json
{
  "autoPush": true,
  "draftPR": false,
  "ci": { "maxCycles": 3, "pollIntervalMs": 10000 },
  "notify": { "onDone": true, "onBlocked": true, "onCIFail": true },
  "costAwareness": true,
  "progressBriefing": true
}
```

### 방법론 스킬 (v0.7.0 신규)

- **`/tdd`** — 테스트 주도 개발: 실패 테스트 먼저 작성 → 통과할 최소 코드 → 리팩토링
- **`/brainstorm`** — 설계 우선 방법론: 발산(다양한 옵션) → 수렴(필터링) → 정제(승인) 후 구현
- **`/systematic-debug`** — 근본 원인 우선 디버깅: 재현 → 격리 → 이해 → 최소 수정 → 검증
- **`/finish-branch`** — 구조화된 브랜치 완료: 테스트 → 린트 → 커버리지 → 리뷰 → 병합 옵션 제시

### 기타 스킬

- **`/plan`** — 전방향(아이디어→스펙) 및 역방향(코드→스펙) 제품 기획
- **`/ask`** — Codex 또는 Gemini에 빠른 단일 쿼리
- **`/research`** — 외부 문서와 API를 위한 병렬 웹 조사
- **`/deep-interview`** — 모호한 요구사항을 위한 소크라테스식 명확화
- **`/trace`** — 디버거가 막혔을 때 증거 기반 근본 원인 분석
- **`/slop-cleaner`** — 최종 커밋 전 AI 생성 bloat 정리
- **`/git-master`** — 원자적이고 잘 구조화된 커밋 관리
- **`/deepinit`** — 코드베이스 맵 (AGENTS.md) 생성으로 방향 잡기
- **`/cancel`** — 실행 중인 오케스트레이터 중지 및 상태 정리
- **`/deep-dive`** — 다각도 종합을 통한 단일 주제 심층 조사
- **`/consensus-plan`** — 실행 전 다중 에이전트 계획 합의 (Prometheus + Momus)
- **`/external-context`** — 외부 문서나 스펙을 활성 컨텍스트에 주입
- **`/verify-coverage`** — 최근 변경 파일의 테스트 커버리지 갭 감지

## 오케스트레이터

### Atlas: 허브-앤-스포크

**언제 사용:**
- 독립적이고 병렬화 가능한 컴포넌트가 있는 작업
- 하나의 오케스트레이터 두뇌가 모든 라우팅 결정을 내리길 원할 때
- 표준 구현, 테스트, 리뷰 워크플로우

**아키텍처:**

```
사용자 요청
    ↓
[Triage] → 단순? → 직접 실행
    ↓ 보통+
[Analyze] (Metis: 심층 요구사항, 위험, 미지)
    ↓
[Plan] (Prometheus: 구조화된 작업 분해)
    ↓
[Validate] (Momus: 블로킹 이슈 조기 발견)
    ↓
[Execute] (병렬 에이전트: executor, designer, test-engineer, debugger 등)
    ↓
[Verify] (빌드 + 테스트 + 린트)
    ↓ 실패?
[Debug] (Debugger가 수정하고 루프백)
    ↓
[Review] (Architect + Security + Code Quality 리뷰어)
    ↓ 반려?
[Fix & Re-review] (승인될 때까지 루프)
    ↓
[Done] (정리, wisdom 저장)
```

**단계:**

1. **Triage** — 복잡도 분류, 전략 결정
2. **Analyze** — 요구사항, 위험, 의존성
3. **Plan + Validate** — 수용 기준이 포함된 작업 분해
4. **Execute** — 병렬 에이전트 작업
5. **Verify** — 빌드, 테스트, 린트
6. **Review** — 아키텍처, 보안, 코드 품질
7. **Slop Clean + Commit** — 정리 및 원자적 커밋

### Athena: 피어-투-피어 팀

**언제 사용:**
- 상호의존적인 파트가 있는 작업 (API + 프론트엔드 동시 개발)
- 워커들이 발견 사항을 실시간으로 공유해야 할 때
- 여러 파일과 전문 분야에 걸친 대규모 작업

**아키텍처:**

```
[Athena Lead] ← 오케스트레이터 (구현 절대 안 함, 조율만)
    ↓
    ├─→ Claude 네이티브 팀 (SendMessage, 각자 독립 worktree)
    │   ├─ API 워커 (executor)
    │   ├─ 프론트엔드 워커 (designer)
    │   ├─ 테스트 워커 (test-engineer)
    │   └─ 문서 워커 (writer)
    │
    └─→ Codex 워커 (tmux 경유, inbox/outbox)
        ├─ 알고리즘 워커
        └─ 리팩토링 워커
```

**단계:**

1. **Triage & Team Design** — 작업을 독립 범위로 분해
2. **Plan** — 작업 배정, 의존성, 핸드오프 프로토콜
3. **Spawn Team** — 모든 워커 동시 실행 (각각 git worktree 격리)
4. **Monitor & Coordinate** — 통신 중계, 워커 블로킹 해소
5. **Integrate & Verify** — 출력 병합, 빌드+테스트 실행
6. **Review** — 전체 리뷰어, 반려 수정
7. **Slop Clean + Commit** — 최종 정리 및 커밋

**Atlas vs Athena 비교:**

| 항목 | Atlas | Athena |
|------|-------|--------|
| 통신 | 허브-앤-스포크 (리드가 전체 제어) | 피어-투-피어 (워커들이 직접 대화) |
| 발견 공유 | 리드가 인사이트 중계 | 워커들이 직접 발견 공유 |
| 최적 용도 | 독립적 작업 | 상호의존적 작업 |
| 오버헤드 | 낮음 | 높지만 더 협력적 |

## 에이전트 (18개)

| 에이전트 | 모델 | 역할 |
|---------|------|------|
| **atlas** | Opus 4.6 | 허브-앤-스포크 오케스트레이터 — triage, 분석, 계획, 실행, 검증, 리뷰, 루프 |
| **athena** | Opus 4.6 | 피어-투-피어 팀 오케스트레이터 — 팀 설계, 워커 실행, 조율, 중계, 통합 |
| **metis** | Opus | 심층 분석 — 영향 파일, 숨겨진 요구사항, 위험, 미지, 권장사항 |
| **prometheus** | Opus | 전략적 기획자 — 작업 분해, 병렬화, 수용 기준, 파일 소유권 |
| **momus** | Opus | 계획 검증자 — 실행 전 블로킹 이슈 발견 (명확성, 검증, 컨텍스트) |
| **hermes** | Opus | 제품 기획 전문가 — 모호한 아이디어를 실행 가능한 스펙으로 변환 (순방향/역방향 PRD) |
| **explore** | Haiku | 빠른 코드베이스 스캐너 — 아키텍처, 파일 구조, 기술 스택, 테스트 프레임워크 |
| **executor** | Sonnet/Opus | 구현 전문가 — 표준 코딩 작업 처리, 집중 실행 |
| **designer** | Sonnet | UI/UX 구현 전문가 — 디자인 시스템 규율에 따른 접근성 있고 반응형인 인터페이스 구현 |
| **aphrodite** | Sonnet | UI/UX 디자인 리뷰어 (읽기 전용) — Nielsen 휴리스틱, Gestalt 원칙, WCAG 2.2 AA 비평 |
| **test-engineer** | Sonnet | 테스트 전문가 — 포괄적 테스트 전략 설계, 강건한 테스트 작성 |
| **debugger** | Sonnet | 근본 원인 분석가 — 체계적으로 버그 진단 및 수정 |
| **hephaestus** | Sonnet | 심층 자율 코더 — 탐색적 엔드-투-엔드 다중 파일 작업 |
| **architect** | Opus | 아키텍처 리뷰어 (읽기 전용) — 구조적 무결성, 모듈 경계 |
| **security-reviewer** | Sonnet | 보안 리뷰어 (읽기 전용) — OWASP Top 10, 일반 취약점 |
| **code-reviewer** | Sonnet | 코드 품질 리뷰어 (읽기 전용) — 표준, 패턴, 유지보수성 |
| **themis** | Sonnet | 품질 게이트 집행자 (읽기 전용) — 테스트·문법·네임스페이스 검사; PASS/FAIL/CONDITIONAL 판정 |
| **writer** | Haiku | 문서 전문가 — 명확하고 정확한 기술 문서 및 코드 주석 |

## 스킬 (24개)

| 스킬 | 레벨 | 별칭 | 용도 |
|------|------|------|------|
| **atlas** | 5 | `atlas`, `아틀라스`, `do-it`, `해줘`, `just-do-it` | 자율 허브-앤-스포크 오케스트레이션 |
| **athena** | 5 | `athena`, `아테나`, `team-do-it`, `팀으로해`, `collaborate` | 자율 피어-투-피어 팀 오케스트레이션 |
| **plan** | 4 | `plan`, `계획`, `spec`, `기획`, `prd`, `역기획` | 제품 기획 — 순방향(아이디어→스펙), 역방향(코드→스펙) |
| **tdd** | 3 | `tdd`, `테스트주도개발`, `red-green-refactor` | TDD: 실패 테스트 먼저 → 최소 구현 → 리팩토링 |
| **brainstorm** | 3 | `brainstorm`, `브레인스토밍`, `설계먼저`, `design-first` | 설계 우선: 발산 → 수렴 → 정제 → 승인 후 구현 |
| **systematic-debug** | 3 | `systematic-debug`, `체계적디버깅`, `디버그`, `root-cause-debug` | 근본 원인 우선: 재현 → 격리 → 이해 → 최소 수정 → 검증 |
| **finish-branch** | 2 | `finish-branch`, `브랜치완료`, `완료`, `finish` | 브랜치 완료: 테스트 → 린트 → 리뷰 → 병합 옵션 제시 |
| **ask** | 2 | `ask`, `물어봐`, `codex`, `gemini`, `quick-ask` | Codex/Gemini에 빠른 단일 쿼리 |
| **deep-interview** | 4 | `deep-interview`, `인터뷰`, `clarify`, `명확하게` | 소크라테스식 요구사항 명확화 |
| **research** | 3 | `research`, `조사`, `외부정보`, `lookup` | 외부 지식을 위한 병렬 웹 조사 |
| **trace** | 3 | `trace`, `추적`, `root-cause`, `원인분석` | 증거 기반 근본 원인 분석 |
| **slop-cleaner** | 3 | `slop-cleaner`, `deslop`, `슬롭`, `cleanup` | 회귀 안전한 AI bloat 제거 |
| **git-master** | 2 | `git-master`, `commit`, `커밋`, `atomic` | 원자적 커밋 관리 및 히스토리 정리 |
| **deepinit** | 2 | `deepinit`, `init`, `초기화`, `map-codebase` | AGENTS.md 코드베이스 문서 생성 |
| **cancel** | 1 | `cancel`, `취소`, `stop`, `abort` | 세션 중지 및 리소스 정리 |
| **deep-dive** | 3 | `deep-dive`, `깊게파봐`, `exhaustive` | 다각도 종합을 통한 단일 주제 심층 조사 |
| **consensus-plan** | 4 | `consensus-plan`, `합의`, `consensus` | 실행 전 다중 에이전트 계획 합의 |
| **external-context** | 2 | `external-context`, `외부문서`, `docs`, `inject-docs` | 외부 문서/스펙을 컨텍스트에 주입 |
| **verify-coverage** | 3 | `verify-coverage`, `coverage`, `커버리지`, `test-gaps` | 최근 변경 파일의 테스트 커버리지 갭 감지 |
| **ui-review** | 3 | `ui-review`, `UI리뷰`, `종합UI검토`, `full-design-review` | 종합 UI 리뷰 — 4개 디자인 리뷰 스킬 병렬 실행 |
| **design-critique** | 2 | `design-critique`, `디자인리뷰`, `디자인비평`, `design-review` | 구조적 디자인 비평 (Nielsen + Gestalt + WCAG) |
| **a11y-audit** | 2 | `a11y-audit`, `접근성검사`, `접근성감사`, `accessibility-audit` | WCAG 2.2 AA 접근성 감사 (코드 리뷰 기반, 브라우저 불필요) |
| **design-system-audit** | 2 | `design-system-audit`, `디자인시스템검사`, `ds-audit`, `토큰검사` | 디자인 시스템 건강도: 토큰 누수, 컴포넌트 API 일관성, 상태 커버리지 |
| **ux-copy-review** | 2 | `ux-copy-review`, `카피리뷰`, `문구검토`, `copy-review` | UX 카피 품질: 명확성, 일관성, 톤, 포용성, 에러 메시지 |

## 아키텍처

### 디렉토리 구조

```
agents/              에이전트 페르소나 정의 (모델 + 역할이 있는 .md 파일)
skills/              사용자 대면 워크플로우 스킬 (트리거, 단계가 있는 SKILL.md)
scripts/             훅 스크립트 (Node.js ESM, 의존성 없음)
  lib/               공유 라이브러리 (stdin, intent, tmux, wisdom, checkpoint, worktree 등)
  run.cjs            버전 폴백이 있는 범용 훅 진입점
config/              모델 라우팅 설정 (JSONC)
hooks/               훅 이벤트 등록 (hooks.json)
.claude-plugin/      플러그인 메타데이터 (plugin.json, marketplace.json)
```

### 핵심 설계 원칙

1. **페일-세이프 훅**: 모든 훅은 에러를 잡고 JSON을 출력하며, 절대 throw하지 않음
2. **상태 격리**: 오케스트레이터별 체크포인트, `.ao/state/`의 임시 상태 파일
3. **Wisdom 지속성**: `.ao/wisdom.jsonl`의 세션 간 학습 (JSONL 형식)
4. **체크포인트 복구**: 24시간 TTL; 중단 후 어느 단계에서든 재개
5. **의존성 없음**: Node.js ≥ 20.0만 필요; 런타임에 npm 패키지 없음

### 세션 상태 관리

**체크포인트** (`.ao/state/checkpoint-<orchestrator>.json`):
- 각 단계 전환 후 저장
- 포함 내용: 오케스트레이터, 단계, prdSnapshot, 완료된 스토리, 활성 워커, 작업 설명
- TTL: 24시간 (만료 시 자동 삭제)
- 목적: 중단된 세션 재개

**PRD** (`.ao/prd.json`):
- 수용 기준이 있는 사용자 스토리
- 스토리 상태: `passes: true/false`
- 스토리 배정: `assignTo`, `model`, `parallelGroup`
- 목적: 요구사항에 대한 실행 진행 추적

**Wisdom** (`.ao/wisdom.jsonl`):
- JSONL 형식 (한 줄에 하나의 항목)
- 카테고리: test, build, architecture, pattern, debug, performance, general
- 세션 간 지속 (절대 자동 삭제 안 함)
- 완료 후 자동으로 최근 200개 항목으로 정리, 90일 이상 된 항목 제거
- 유사도 70% 이상 항목 자동 중복 제거
- 목적: 세션 간 학습으로 향후 실행 가속화

**Teams** (`.ao/teams/<slug>/`) — Athena 전용:
- Codex 통신을 위한 워커별 inbox/outbox 디렉토리
- 팀 완료 후 자동 정리

**Worktrees** (`.ao/worktrees/<slug>/<worker>/`) — Athena 전용:
- 각 병렬 워커를 위한 격리된 git worktree
- 워커 간 파일 충돌 방지
- 팀 완료 후 병합 및 정리

## 세션 복구

Claude Code가 오케스트레이션 중 충돌하거나 닫히면:

1. `/atlas [이전 작업]` 또는 `/athena [이전 작업]` 실행
2. 오케스트레이터가 오래된 체크포인트 감지 (24시간 미만)
3. 옵션 제시: **재개** 또는 **재시작**
   - **재개** → 완료된 단계 건너뛰고, 스토리 상태 복원, 중단된 곳에서 계속
   - **재시작** → 체크포인트 삭제, 처음부터 시작

각 단계 전환 후 체크포인트가 저장되고 PRD 스냅샷이 포함되므로 작동합니다.

## Wisdom 시스템

Agent Olympus는 모든 실행에서 학습합니다. 각 스토리 완료 후 에이전트들이 학습 내용을 기여합니다:

```javascript
addWisdom({
  category: 'pattern',
  lesson: '코드베이스는 API 응답 키에 snake_case를 사용',
  confidence: 'high'
})

addWisdom({
  category: 'debug',
  lesson: 'TypeScript strict 모드는 async 함수에 명시적 반환 타입 필요',
  confidence: 'high'
})
```

**카테고리:**
- `test` — 테스트 프레임워크 특이사항, 작동하는 패턴
- `build` — 빌드 도구 동작, 컴파일 요구사항
- `architecture` — 구조적 결정, 모듈 경계
- `pattern` — 코드베이스 규칙, 네이밍, 에러 처리
- `debug` — 함정, 근본 원인, 안티패턴
- `performance` — 최적화 발견
- `general` — 기타

이후 세션들은 wisdom을 쿼리하여 분석 가속화, 실수 반복 방지, 코드베이스 지식 활용.

## 멀티 모델 지원

### Claude 모델

- **Haiku** — 빠른 탐색 작업 (코드베이스 스캔, 문서)
- **Sonnet** — 표준 구현 (대부분의 executor, designer, test 작업)
- **Opus** — 복잡한 추론 (분석, 계획, 아키텍처, 보안 리뷰)

### Codex / Gemini (tmux 경유)

알고리즘 작업, 대규모 리팩토링, 탐색적 코딩을 위해 오케스트레이터가 tmux를 통해 Codex 워커를 실행:

```bash
tmux new-session -d -s "atlas-codex-<N>" -c "<cwd>"
tmux send-keys -t "atlas-codex-<N>" 'codex exec "<prompt>"' Enter
tmux capture-pane -pt "atlas-codex-<N>" -S -200  # 출력 모니터링
tmux kill-session -t "atlas-codex-<N>"            # 정리
```

세션 명명 규칙:
- Atlas: `atlas-codex-<N>`
- Athena: `athena-<slug>-codex-<N>`

## 요구사항

- **Node.js** ≥ 20.0.0 (ESM 지원용)
- **선택사항**: tmux (Codex/Gemini 통합 및 Athena 팀 모드에 필요)
- **선택사항**: codex CLI 또는 동등한 것 (Codex를 직접 사용하는 경우)
- **npm 패키지**: 없음 (런타임 의존성 제로)

## 기여자를 위한 프로젝트 구조

### 새 에이전트 추가

1. frontmatter가 있는 `agents/<name>.md` 생성:

```yaml
---
model: sonnet  # haiku | sonnet | opus
description: 한 줄 설명
---
```

2. frontmatter 아래에 페르소나 프롬프트 작성
3. 스킬/SKILL.md에서 `agent-olympus:<name>`으로 참조

### 새 스킬 추가

1. frontmatter가 있는 `skills/<name>/SKILL.md` 생성:

```yaml
---
name: <name>
description: 한 줄 설명
level: 1-5
aliases: [trigger, words, 한국어도가능]
---
```

2. 워크플로우 단계 작성
3. `Task(subagent_type="agent-olympus:<agent>", model="<tier>", prompt="...")`로 에이전트 참조

### 새 훅 추가

1. 페일-세이프 패턴으로 `scripts/<hook-name>.mjs` 생성:

```javascript
import { readStdin } from './lib/stdin.mjs';
async function main() {
  try {
    const raw = await readStdin(3000);
    const data = JSON.parse(raw);
    // ... 훅 로직 ...
    process.stdout.write(JSON.stringify({ /* 출력 */ }));
  } catch {
    process.stdout.write('{}');
  }
  process.exit(0);
}
main();
```

2. 적절한 이벤트 아래 `hooks/hooks.json`에 등록
3. 버전 안전 해결을 위해 `run.cjs`를 명령 래퍼로 사용

### 문법 검사

모든 스크립트가 유효한지 확인:

```bash
for f in scripts/*.mjs scripts/lib/*.mjs; do node --check "$f" && echo "OK: $f"; done
```

오래된 네임스페이스 참조 확인:

```bash
grep -r "oh-my-claude:" agents/ skills/ scripts/ config/
grep -r "oh-my-claudecode:" skills/ agents/
grep -r '\.omc/' scripts/ skills/ agents/
```

## 테스트

`node:test` 기반 테스트 스위트 (25개 파일, 363개+ 테스트)가 핵심 훅 라이브러리를 커버합니다:

```bash
node --test 'scripts/test/**/*.test.mjs'
# 또는
npm test
```

**커버된 모듈:** checkpoint, concurrency-gate, config-validator, fs-atomic, inbox-outbox, intent-patterns, provider-detect, stdin, tmux-session, wisdom, worker-spawn, worker-status, worktree

추가 통합 검증:

1. 모든 스크립트 문법 검사 (위 참조)
2. Claude Code에서 간단한 `/atlas` 작업 실행
3. tmux가 사용 가능하면 `/athena` 작업 실행
4. 완료 후 `.ao/wisdom.jsonl`이 채워졌는지 확인
5. 중단 후 체크포인트 재개 가능 여부 검증

## 철학

Agent Olympus는 세 가지 핵심 원칙을 구현합니다:

1. **자율성**: 목표를 설명하면 오케스트레이터가 세부사항을 처리합니다. AI를 감독할 필요 없음.
2. **검증**: 모든 기준이 충족될 때까지 루프합니다. 실패는 수정되며, 무시되지 않습니다.
3. **학습**: Wisdom이 세션 간에 지속됩니다. 각 실행이 다음 실행을 더 빠르게 만듭니다.

이름은 의도적입니다. Atlas는 세상을 짊어집니다. Athena는 팀을 이끕니다. 함께, 당신이 요청하는 모든 작업을 완료합니다.

## 감사의 말

이 프로젝트는 아래 프로젝트들의 아이디어를 참고하였습니다:

- [Oh My Claude Code](https://github.com/Yeachan-Heo/oh-my-claudecode) — Claude Code용 멀티 에이전트 오케스트레이션 플러그인
- [Oh My OpenAgent](https://github.com/code-yeongyu/oh-my-openagent) — 멀티 모델 오케스트레이션을 지원하는 에이전트 하네스
- [Kimoring AI Skills](https://github.com/codefactory-co/kimoring-ai-skills) — SessionStart/Stop 훅 패턴, 커버리지 갭 탐지 아이디어
- [Superpowers](https://github.com/obra/superpowers) — TDD 규율, 체계적 디버깅 방법론, 브레인스토밍 우선 게이트, 검증 철칙, 2단계 코드 리뷰 프로토콜 (v0.7.0)

## 라이선스

MIT

## 작성자

Karnian

## 링크

- **저장소**: [https://github.com/Karnian/agent-olympus](https://github.com/Karnian/agent-olympus)
- **이슈**: [https://github.com/Karnian/agent-olympus/issues](https://github.com/Karnian/agent-olympus/issues)
