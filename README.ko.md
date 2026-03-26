# Agent Olympus

> Claude Code용 자율 주행 AI 오케스트레이터 플러그인 — 의존성 제로, 최대 자율성.

## Agent Olympus란?

Agent Olympus는 Claude Code를 위한 독립형 플러그인으로, 두 가지 자율 주행 AI 오케스트레이터를 제공합니다. 이 플러그인을 통해 복잡한 개발 작업을 15개의 전문화된 에이전트, 13개의 워크플로우 스킬, Claude + Codex 멀티 모델 실행, tmux 기반 팀 인프라를 활용하여 완전히 자동화된 방식으로 처리할 수 있습니다.

사용자가 작업을 요청하면 Atlas 또는 Athena가 자동으로 선택되어, 요구사항 분석부터 구현, 검증, 코드 리뷰, 최종 커밋까지 전 과정을 자율적으로 진행합니다. 빌드가 성공하고, 테스트가 통과하고, 모든 검토가 승인될 때까지 자동으로 반복 실행됩니다. npm 패키지 의존성이 전혀 없으므로 설치와 관리가 간단합니다.

이 플러그인은 소프트웨어 개발 전 과정을 자동화하는 것을 목표로 설계되었으며, 에이전트들이 협력하여 고품질의 결과물을 만들어낼 수 있도록 구축되었습니다.

## 주요 기능

- **Atlas 오케스트레이터** — 허브-앤-스포크(hub-and-spoke) 구조의 자율 주행 파이프라인: 분류 → 분석 → 계획 → 실행 → 검증 → 리뷰 → 정리 → 커밋
- **Athena 오케스트레이터** — 피어-투-피어(peer-to-peer) 팀 협력: Claude와 Codex 워커가 tmux를 통해 동시에 작업
- **15개 전문화된 에이전트** — 각각의 역할: 분석가(metis), 전략가(prometheus), 비판가(momus), 개발자(executor), 디자이너(designer), 테스트 엔지니어, 보안 검수자, 코드 리뷰어 등
- **13개 워크플로우 스킬** — /atlas, /athena, /ask, /deep-interview, /deepinit, /research, /trace, /slop-cleaner, /git-master, /cancel, /deep-dive, /consensus-plan, /external-context
- **워커 상태 대시보드** — Athena 팀 실행 중 모든 워커의 실시간 상태를 인라인 마크다운으로 표시
- **세션 복구** — checkpoint 시스템으로 24시간 이내에 중단된 세션을 자동 복구
- **학습 누적** — wisdom.jsonl 형식의 구조화된 학습 데이터베이스로 반복마다 더 스마트한 처리 가능
- **멀티 모델 라우팅** — Claude Haiku/Sonnet/Opus와 OpenAI Codex를 작업 유형에 맞게 자동 할당
- **의존성 제로** — Node.js 표준 라이브러리만 사용, npm 패키지 불필요

## 설치

### Marketplace에서 추가

Claude Code의 Marketplace에서 "Agent Olympus"를 검색하고 설치합니다.

### 플러그인 수동 설치

```bash
# 플러그인 디렉토리에 복제
git clone https://github.com/Karnian/agent-olympus ~/.claude/plugins/agent-olympus

# Claude Code 재시작
```

플러그인이 활성화되면 `/atlas`, `/athena`, `/ask` 등의 스킬을 사용할 수 있습니다.

## 빠른 시작

### 간단한 작업은 Atlas로

어떤 작업을 자동으로 처리하려면 `/atlas`를 사용합니다.

```
/atlas 커스텀 버튼 컴포넌트 만들어줘. Button 태그에 variant와 size prop을 지원해야 해.
```

Atlas가 자동으로:
1. 요구사항 분석 (triage)
2. 깊이 있는 분석 (analyze)
3. 실행 계획 수립 (plan) + PRD 생성
4. 구현 (execute)
5. 검증 (verify)
6. 코드 리뷰 (review)
7. 불필요한 코드 정리 (slop clean)
8. 원자적 커밋 (commit)

를 수행하고, 모든 조건이 통과될 때까지 자동 반복합니다.

### 팀 협력이 필요하면 Athena로

대규모 리팩토링이나 복잡한 기능 개발에는 `/athena`를 사용합니다.

```
/athena 기존 REST API를 GraphQL로 마이그레이션해. 기존 엔드포인트는 유지하되, GraphQL 스키마를 새로 구성해야 해.
```

Athena가 자동으로:
1. 요구사항 분석
2. 실행 계획 수립
3. 팀 워커 생성 (tmux 세션)
4. 팀 멤버들의 병렬 작업 모니터링
5. 결과물 통합 및 검증
6. 코드 리뷰
7. 최종 커밋

을 처리합니다.

### 빠른 쿼리는 /ask로

Codex나 Gemini에게 빠르게 질문하려면:

```
/ask React의 useCallback과 useMemo의 차이점을 설명해줄 수 있어?
```

### 요구사항 명확히 하기

뭔가 모호한 작업이면 먼저 `/deep-interview`를 사용합니다.

```
/deep-interview 우리 프로젝트의 인증 시스템을 개선하고 싶은데, 어떻게 접근해야 할까?
```

시스템이 소크라테스식 대화를 통해 요구사항을 명확히 한 후, Atlas나 Athena에게 자동으로 넘깁니다.

## 오케스트레이터

### Atlas (허브-앤-스포크)

하나의 두뇌(Atlas)가 여러 전문가를 조율합니다.

**8단계 파이프라인:**

| 단계 | 역할 | 담당 에이전트 |
|------|------|--------------|
| **Triage** | 요청 분류 및 초기 평가 | atlas |
| **Analyze** | 깊이 있는 분석 (범위, 위험, 미지의 것) | metis (분석가) |
| **Plan** | 전략적 계획 + PRD 생성 | prometheus (전략가) + momus (비판가) |
| **Execute** | 실제 코드 작성 | executor (개발자), designer (디자이너), test-engineer (테스터) 등 |
| **Verify** | 기능 검증 및 테스트 | debugger (디버거) |
| **Review** | 코드 및 보안 리뷰 | architect, code-reviewer, security-reviewer |
| **Slop Clean** | AI 생성 코드의 불필요한 부분 제거 | atlas |
| **Commit** | 원자적 커밋 생성 및 푸시 | atlas |

각 단계가 완료되면 다음 단계로 자동 진행합니다. 테스트 실패나 리뷰 불통과 시 자동 반복합니다. 최대 15회 반복까지 시도합니다.

### Athena (피어-투-피어 팀)

여러 에이전트(각각 tmux 세션)가 협력하여 병렬로 작업합니다.

**8단계 파이프라인:**

| 단계 | 역할 | 설명 |
|------|------|------|
| **Triage** | 요청 분류 | 팀 편성의 기초 |
| **Plan** | 실행 계획 수립 | 병렬화 가능한 작업 그룹화 |
| **Spawn Team** | 팀 워커 생성 | 각 그룹마다 tmux 세션 + Claude 워커 시작 |
| **Monitor** | 진행 상황 모니터링 | inbox/outbox 파일로 통신 |
| **Integrate & Verify** | 결과물 통합 및 검증 | 모든 워커의 산출물 병합 |
| **Review** | 코드 리뷰 | 아키텍처, 보안, 품질 검증 |
| **Slop Clean** | 코드 정리 | 반복되거나 불필요한 부분 제거 |
| **Commit** | 커밋 | 각 기능 그룹별로 원자적 커밋 |

Athena는 대규모 작업에 적합하며, 여러 팀 멤버가 동시에 다른 부분을 작업할 수 있습니다.

## 에이전트

총 15개의 전문화된 에이전트가 협력합니다.

### 오케스트레이터 (Opus)

| 에이전트 | 역할 |
|---------|------|
| **atlas** | 허브-앤-스포크 구조: 한 가지 두뇌가 여러 전문가를 조율 |
| **athena** | 피어-투-피어 팀: 여러 워커가 tmux를 통해 협력 |

### 분석 & 계획 (Opus)

| 에이전트 | 역할 |
|---------|------|
| **metis** | 심화 분석: 범위, 위험, 미지의 것, 의존성 파악 |
| **prometheus** | 전략적 계획: 작업 항목, 병렬화 그룹, 수용 기준 정의 |
| **momus** | 계획 검증: 4개 기준(명확성/검증/컨텍스트/완성도) 각 70점 이상 확인 |

### 구현 (Sonnet)

| 에이전트 | 역할 |
|---------|------|
| **executor** | 표준 구현 작업자 |
| **designer** | UI/UX 전문가 |
| **test-engineer** | 테스트 전략, TDD, 커버리지 |
| **debugger** | 근본 원인 분석 및 수정 |
| **hephaestus** | Codex 고급 워커 (대규모 리팩토링, 알고리즘) |

### 검수 (읽기 전용)

| 에이전트 | 역할 |
|---------|------|
| **architect** (Opus) | 기능 완성도, 아키텍처 정렬성 검증 |
| **security-reviewer** (Sonnet) | OWASP Top 10, 시크릿 노출, 인젝션 공격 검증 |
| **code-reviewer** (Sonnet) | 논리 결함, SOLID 원칙, DRY, AI 생성 코드 검증 |

### 유틸리티

| 에이전트 | 역할 |
|---------|------|
| **explore** (Haiku) | 빠른 코드베이스 스캔 (Glob/Grep/Read 활용) |
| **writer** (Haiku) | 기술 문서 작성 |

## 스킬

총 13개의 사용자 대면 스킬이 제공됩니다.

### 핵심 오케스트레이션

| 스킬 | 트리거 | 설명 |
|------|--------|------|
| **/atlas** | "해줘", "do it" | 전체 자율 파이프라인: 분류 → 분석 → 계획 → 실행 → 검증 → 리뷰 → 정리 → 커밋 |
| **/athena** | "팀으로 해", "team" | 동일 파이프라인이지만 tmux 팀 워커 사용 |

### 전처리

| 스킬 | 트리거 | 설명 |
|------|--------|------|
| **/deep-interview** | "명확하게", "clarify" | 소크라테스식 대화로 요구사항 명확화 → atlas/athena로 자동 이관 |
| **/deepinit** | "초기화", "map codebase" | 코드베이스 분석 후 AGENTS.md 계층구조 생성 |

### 중간 파이프라인 도구

| 스킬 | 트리거 | 설명 |
|------|--------|------|
| **/ask** | "물어봐", "codex" | 빠른 단일 Codex/Gemini 쿼리 (tmux 경유) |
| **/research** | "조사해", "리서치" | 병렬 웹 조사: 분해 → 페치 → 종합 |
| **/trace** | "추적", "원인분석" | 3개 가설을 경쟁시키는 근본 원인 분석 (반박 라운드 포함) |

### 후처리

| 스킬 | 트리거 | 설명 |
|------|--------|------|
| **/slop-cleaner** | "정리", "deslop" | 회귀 안전 AI 생성 코드 제거 (4 패스) |
| **/git-master** | "커밋", "commit" | 스타일 감지 원자적 커밋 (3+ 파일 → 2+ 커밋) |
| **/cancel** | "취소", "stop" | 우아한 종료: tmux 종료, 상태 정리, 진행도 보존 |

### 리서치 & 계획

| 스킬 | 트리거 | 설명 |
|------|--------|------|
| **/deep-dive** | "깊게파봐", "deep-dive" | 단일 주제 심층 조사: 다각도 검색 후 종합 |
| **/consensus-plan** | "합의", "consensus" | 다중 에이전트 계획 합의 (Prometheus + Momus 합의 후 실행) |
| **/external-context** | "외부문서", "docs" | 외부 문서/스펙을 가져와 활성 컨텍스트에 주입 |

## 아키텍처

### 디렉토리 구조

```
agent-olympus/
├── .claude-plugin/
│   ├── plugin.json          — 플러그인 manifest (v0.5.0)
│   └── marketplace.json     — Marketplace 메타데이터
├── agents/                  — 15개 에이전트 페르소나 (.md)
│   ├── atlas.md
│   ├── athena.md
│   ├── metis.md
│   ├── prometheus.md
│   ├── momus.md
│   ├── executor.md
│   ├── designer.md
│   ├── test-engineer.md
│   ├── debugger.md
│   ├── architect.md
│   ├── security-reviewer.md
│   ├── code-reviewer.md
│   ├── explore.md
│   ├── writer.md
│   └── hephaestus.md
├── skills/                  — 13개 사용자 대면 스킬 (workflow)
│   ├── atlas/SKILL.md
│   ├── athena/SKILL.md
│   ├── ask/SKILL.md
│   ├── deep-interview/SKILL.md
│   ├── deepinit/SKILL.md
│   ├── research/SKILL.md
│   ├── trace/SKILL.md
│   ├── slop-cleaner/SKILL.md
│   ├── git-master/SKILL.md
│   ├── cancel/SKILL.md
│   ├── deep-dive/SKILL.md
│   ├── consensus-plan/SKILL.md
│   └── external-context/SKILL.md
├── scripts/                 — Hook 스크립트 (Node.js ESM)
│   ├── run.cjs              — 범용 hook runner (버전 fallback)
│   ├── intent-gate.mjs      — 사용자 의도 분류 (EN/KO/JA/ZH)
│   ├── model-router.mjs     — 모델 라우팅 조언 주입
│   ├── concurrency-gate.mjs — 병렬 작업 제한 (진입)
│   ├── concurrency-release.mjs — 병렬 작업 해제 (퇴출)
│   └── lib/
│       ├── stdin.mjs        — 타임아웃 포함 stdin 리더
│       ├── intent-patterns.mjs — 의도 분류 (7개 범주, 다국어)
│       ├── model-router.mjs — 라우팅 로직 + JSONC 설정 병합
│       ├── tmux-session.mjs — tmux 세션 생명주기
│       ├── inbox-outbox.mjs — Claude↔Codex 파일 기반 메시지 큐
│       ├── worker-spawn.mjs — 팀 워커 생명주기 (시작/모니터/수집/종료)
│       ├── checkpoint.mjs   — 세션 복구 checkpoint 시스템
│       ├── wisdom.mjs       — 구조화된 학습 데이터베이스
│       └── worker-status.mjs — 실시간 워커 상태 대시보드 (인라인 마크다운)
├── config/
│   └── model-routing.jsonc  — 의도 → 모델 라우팅 설정
└── hooks/
    └── hooks.json           — Hook 이벤트 등록
```

### 상태 관리

| 파일 | 목적 | 생명주기 |
|------|------|---------|
| `.ao/state/checkpoint-atlas.json` | Atlas 페이즈 추적 | 시작 시 생성, 완료 시 삭제 |
| `.ao/state/checkpoint-athena.json` | Athena 페이즈 추적 | 시작 시 생성, 완료 시 삭제 |
| `.ao/prd.json` | 사용자 스토리 + 수용 기준 | Plan 페이즈에서 생성, 완료 시 삭제 |
| `.ao/wisdom.jsonl` | 교차 반복 학습 (JSONL) | 누적, 절대 삭제 안 함 (/cancel 이후에도 보존) |
| `.ao/state/ao-intent.json` | 마지막 분류 의도 | 매 프롬프트마다 갱신 |
| `.ao/state/ao-concurrency.json` | 활성 작업 추적 | 작업 생성/완료 시 갱신 |
| `.ao/teams/<slug>/` | Codex 워커 inbox/outbox | Athena가 생성, 완료 시 정리 |

## 세션 복구

### Checkpoint 시스템

Atlas나 Athena 실행 중 Claude Code가 중단되면, **checkpoint 시스템**이 자동으로 세션 상태를 저장합니다.

- **저장 위치:** `.ao/state/checkpoint-{atlas|athena}.json`
- **생존 기간:** 24시간 (초과 시 자동 삭제)
- **복구:** 다음 `/atlas` 또는 `/athena` 실행 시, 이전 checkpoint이 있으면 자동으로 해당 페이즈에서 재개

예를 들어, Execute 페이즈 중에 중단되었다면, 다시 실행할 때 Execute 페이즈부터 시작합니다.

**Checkpoint에 저장되는 정보:**
- 현재 페이즈 (단계)
- 완료된 사용자 스토리
- Athena의 경우, 활성 워커 목록
- PRD 스냅샷
- 시작 시간

### 활성 워커 목록

Athena 실행 중에는 각 tmux 세션별로 워커 상태가 추적됩니다. 중단된 경우, 복구 시에도 같은 워커들이 재개됩니다.

## 학습 시스템 (Wisdom)

### wisdom.jsonl이란?

`wisdom.jsonl`은 구조화된 학습 데이터베이스입니다. Atlas/Athena가 반복할 때마다, 발견한 버그, 설계 패턴, 테스트 전략 등을 자동으로 기록합니다.

**특징:**
- **형식:** JSONL (JSON Lines) — 각 행이 하나의 학습 항목
- **영속성:** 프로젝트 디렉토리 내 `.ao/wisdom.jsonl`에 저장
- **보존:** `/cancel` 명령 후에도 삭제되지 않음
- **자동 정리:** 90일 이상된 항목 또는 200개 초과 항목은 자동 제거
- **중복 제거:** 유사도 80% 이상인 항목은 자동으로 중복 제거

### Wisdom 항목 구조

```json
{
  "timestamp": "2026-03-23T14:30:00.000Z",
  "project": "my-app",
  "category": "test",
  "lesson": "useCallback 의존성 배열에 이벤트 핸들러를 포함하지 않으면 무한 루프 발생",
  "filePatterns": ["src/hooks/*.js"],
  "confidence": "high"
}
```

**category 값들:**
- `test` — 테스트 관련 학습
- `build` — 빌드/번들 관련
- `architecture` — 아키텍처 설계
- `pattern` — 코드 패턴
- `debug` — 디버깅 기법
- `performance` — 성능 최적화
- `general` — 기타

### Wisdom 쿼리

Atlas/Athena가 실행될 때, 이전 학습들이 자동으로 프롬프트에 주입됩니다. 예를 들어:

```
## Prior Learnings
- [test] useCallback 의존성 배열에 이벤트 핸들러를 포함하지 않으면 무한 루프 발생
- [build] webpack 5에서 dynamic import가 작동하려면 output.chunkLoading을 설정해야 함
- [architecture] 전역 상태는 Context API보다는 Zustand를 사용하면 리렌더링 감소
```

### 마이그레이션 (progress.txt → wisdom.jsonl)

이전 버전에서 사용하던 `progress.txt`가 있다면, 첫 실행 시 자동으로 `wisdom.jsonl`로 마이그레이션됩니다. 기존 파일은 `progress.txt.bak`으로 백업됩니다.

## 요구 사항

- **Node.js ≥ 20.0.0** — ESM 지원 필수
- **Claude Code** — 최신 버전
- **선택사항: tmux** — Codex 통합 및 Athena 팀 모드 필수
- **선택사항: codex CLI** — 고급 모델 실행 (npm install -g @openai/codex)

## 감사의 말

이 프로젝트는 아래 두 프로젝트의 아이디어와 설계 철학을 참고하여 만들어졌습니다:

- [Oh My Claude Code](https://github.com/Yeachan-Heo/oh-my-claudecode) — Claude Code용 멀티 에이전트 오케스트레이션 플러그인
- [Oh My OpenAgent](https://github.com/code-yeongyu/oh-my-openagent) — 멀티 모델 오케스트레이션을 지원하는 에이전트 하네스

## 라이선스

MIT

---

**더 알아보기:** [Agent Olympus GitHub Repository](https://github.com/Karnian/agent-olympus)
