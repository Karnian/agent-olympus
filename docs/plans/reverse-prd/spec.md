# Agent Olympus -- 역기획 종합 기획서 (Reverse Product Specification)

**Mode:** Reverse (기존 코드베이스로부터 추출)
**최초 분석일:** 2026-03-27 (v0.5.0 기준)
**최종 업데이트:** 2026-03-28 (v0.6.7 기준)
**대상:** /Users/k/Desktop/sub_project/agent-olympus
**분석 당시 버전:** 0.5.0 → **현재 버전:** 0.6.7
**Health Score:** 62/100 → **개선 후:** 85/100 (v0.6.7)

> **구현 이력 노트:** 이 기획서는 v0.5.0 코드베이스 분석을 기반으로 작성되었다. 이후 도출된 개선 작업들이 v0.6.5~v0.6.7에 걸쳐 전면 구현되었다. 아래 각 섹션에 구현 현황이 표시되어 있다.

---

## 1. 프로젝트 개요 (Product Summary)

Agent Olympus는 Claude Code용 독립형(standalone) 플러그인으로, **자율 주행 AI 오케스트레이터(self-driving AI orchestrator)** 두 종을 제공한다. Atlas(hub-and-spoke 방식)와 Athena(peer-to-peer 방식)가 그것이다. 사용자가 임의의 작업을 지시하면, 오케스트레이터가 분석(analyze), 기획(plan), 실행(execute), 검증(verify), 리뷰(review)의 전 과정을 자율적으로 반복 수행하며, 빌드 통과, 테스트 통과, 코드 리뷰 승인까지 스스로 루프를 돈다. 16개의 전문 에이전트(agent)와 14개의 워크플로우 스킬(skill)로 구성되며, npm 의존성이 0개(zero dependency)인 것이 특징이다.

---

## 2. 추론된 문제 정의 (Inferred Problem Statement)

**WHO**: Claude Code를 사용하는 개발자 (개인 또는 소규모 팀)

**WHAT**: 복잡한 소프트웨어 개발 작업을 AI에게 위임하면, AI가 중간에 멈추거나 한 번의 시도로 끝내지 못하고 사용자가 반복적으로 개입해야 하는 문제가 있다. 단일 LLM 호출로는 분석, 계획, 구현, 디버깅, 검증, 리뷰라는 다단계 소프트웨어 개발 프로세스를 자동화할 수 없다.

**WHY NOW**: Claude Code의 sub-agent(Task) 기능과 Skill 기능이 등장하면서, 여러 전문 역할을 가진 에이전트들을 조합하여 완전 자율 개발 파이프라인을 구축하는 것이 기술적으로 가능해졌다. 또한 Codex(OpenAI)와 Gemini(Google) 같은 다중 모델(multi-model) 실행이 tmux를 통해 통합 가능해지면서, 단일 벤더 종속에서 벗어난 하이브리드 AI 팀 구성이 현실화되었다.

---

## 3. 대상 사용자 (Target Users)

| 페르소나 | 설명 |
|---------|------|
| **독립 개발자** | 복잡한 구현을 AI에게 위임하고 결과만 확인하고 싶은 사용자. "해줘(just do it)" 패턴 |
| **테크 리드** | 아키텍처 결정과 코드 리뷰를 AI가 자동 수행해주길 원하는 관리자 |
| **다국어 사용자** | 한국어, 영어, 일본어, 중국어 지원이 intent-patterns에 내장됨 |
| **멀티 모델 사용자** | Claude + Codex + Gemini를 상황별로 최적 조합하고 싶은 사용자 |

---

## 4. 핵심 컨셉: 두 오케스트레이터의 설계 철학 (Core Concepts)

### 4.1 Atlas -- Hub-and-Spoke (허브-앤-스포크)

```
         Atlas (두뇌)
        /   |   |   \
    explore metis executor debugger ...
```

- **하나의 두뇌**(Atlas)가 모든 판단을 내리고, 전문 에이전트들에게 작업을 **위임**
- 에이전트 간 직접 통신 없음 -- 모든 정보가 Atlas를 경유
- **장점**: 낮은 오버헤드, 단순한 제어 흐름
- **적합 상황**: 독립적인 작업 단위들로 분해 가능한 태스크

**실행 파이프라인 (6단계):**
1. **Phase 0 TRIAGE** -- 복잡도 분류 (trivial / moderate / complex / architectural)
2. **Phase 1 ANALYZE** -- 영향 범위, 리스크, 미지수 분석 (metis)
3. **Phase 1.5 SPEC GATE** -- Hermes가 구조화된 스펙 보장 (PRD 생성/검증)
4. **Phase 2 PLAN + VALIDATE** -- 실행 계획 수립(prometheus) + 검증(momus)
5. **Phase 3 EXECUTE** -- 병렬 sub-agent 실행 + Codex tmux 실행
6. **Phase 4 VERIFY** -- 빌드/테스트/린터 동시 실행, 실패 시 디버거 루프
7. **Phase 5 REVIEW** -- architect + security-reviewer + code-reviewer 동시 리뷰
8. **Phase 5b CLEANUP** -- slop-cleaner + git-master로 코드 정리 및 커밋

### 4.2 Athena -- Peer-to-Peer (피어-투-피어)

```
  Athena (조율자)
     |
  ┌──┼──────────────┐
  │  │               │
Worker A ←→ Worker B ←→ Codex C
  (SendMessage)     (inbox/outbox)
```

- Athena는 **조율자(coordinator)**일 뿐, 구현을 직접 하지 않음
- Claude 워커 간: `SendMessage`로 **직접 통신** (피어-투-피어)
- Claude-Codex 간: `.ao/teams/<slug>/` 의 inbox/outbox 파일 시스템으로 **브릿지**
- **장점**: 실시간 발견 공유, 상호 의존 작업에 적합
- **적합 상황**: API + 프론트엔드 + 테스트가 서로 맞물리는 대규모 작업

**팀 사이징:**

| 파일 수 | Claude 워커 | Codex 워커 | 합계 |
|---------|-----------|-----------|------|
| 2-3 | 2 | 0 | 2 |
| 4-6 | 2-3 | 1 | 3-4 |
| 7-15 | 3-4 | 1 | 4-5 |
| 15+ | 4-5 | 2 | 6-7 |

### 4.3 Atlas vs Athena 비교

| 항목 | Atlas | Athena |
|------|-------|--------|
| 통신 방식 | Hub-and-spoke | Peer-to-peer |
| 발견 공유 | 리드가 중계 | 워커가 직접 공유 |
| 최적 상황 | 독립적 작업 | 상호의존 작업 |
| 오버헤드 | 낮음 | 높음 |
| 최대 워커 | 무제한 (sub-agent) | Claude 5 + Codex 2 |

---

## 5. 아키텍처 (Architecture Overview)

### 5.1 전체 시스템 구조

```
┌─────────────────────────────────────────────────────────┐
│                  Claude Code (호스트)                     │
│                                                          │
│  hooks.json ──→ Hook System (UserPromptSubmit,           │
│                  PreToolUse, PostToolUse)                 │
│      │                                                   │
│      ├─ intent-gate.mjs    (의도 분류)                    │
│      ├─ model-router.mjs   (모델 라우팅 조언)             │
│      ├─ concurrency-gate.mjs  (동시성 제한)               │
│      └─ concurrency-release.mjs (동시성 해제)             │
│                                                          │
│  Skills ──→ /atlas, /athena, /plan, /cancel ...          │
│      │                                                   │
│      └─ Agents (Task subagent_type)                      │
│           ├─ Orchestrators: atlas, athena                 │
│           ├─ Analysis: metis, prometheus, momus, hermes   │
│           ├─ Execution: executor, designer, test-engineer │
│           ├─ Review: architect, code-reviewer,            │
│           │          security-reviewer                    │
│           ├─ Support: debugger, explore, writer,          │
│           │          hephaestus                           │
│           └─ External: codex, gemini (via tmux)          │
│                                                          │
│  State ──→ .ao/ (ephemeral)                              │
│      ├─ prd.json, spec.md (working copy)                 │
│      ├─ wisdom.jsonl (persistent cross-session)          │
│      ├─ state/ (checkpoints, intent, concurrency)        │
│      └─ teams/ (Athena inbox/outbox)                     │
│                                                          │
│  Plans ──→ docs/plans/ (git-tracked permanent)           │
│      └─ <slug>/spec.md, prd.json, CHANGELOG.md           │
└─────────────────────────────────────────────────────────┘
```

### 5.2 디렉토리 구조

```
agent-olympus/
├── agents/          (16 에이전트 정의 파일)
│   ├── atlas.md, athena.md       (오케스트레이터)
│   ├── hermes.md                 (기획 전문가)
│   ├── metis.md, prometheus.md   (분석 & 계획)
│   ├── momus.md                  (비평/검증)
│   ├── executor.md, designer.md  (실행)
│   ├── hephaestus.md             (자율 심층 코딩)
│   ├── test-engineer.md          (테스트)
│   ├── debugger.md               (디버깅)
│   ├── architect.md              (아키텍처 리뷰)
│   ├── code-reviewer.md          (코드 리뷰)
│   ├── security-reviewer.md      (보안 리뷰)
│   ├── writer.md                 (문서화)
│   └── explore.md                (탐색)
├── skills/          (15 스킬 워크플로우)
│   ├── atlas/, athena/           (핵심 오케스트레이터)
│   ├── plan/                     (기획 - 정방향/역방향)
│   ├── cancel/                   (세션 종료)
│   ├── ask/                      (단발 질의)
│   ├── deep-interview/           (요구사항 명확화)
│   ├── deep-dive/                (심층 조사)
│   ├── consensus-plan/           (합의 기반 계획)
│   ├── external-context/         (외부 지식 수집)
│   ├── research/                 (웹 리서치)
│   ├── trace/                    (근본 원인 분석)
│   ├── slop-cleaner/             (AI 슬롭 제거)
│   ├── git-master/               (원자적 커밋)
│   ├── deepinit/                 (코드베이스 매핑)
│   └── verify-coverage/          (테스트 커버리지 갭 감지) ✅ v0.6.5 신규
├── scripts/         (Hook 실행 스크립트)
│   ├── run.cjs                   (범용 진입점, 크로스 플랫폼)
│   ├── intent-gate.mjs           (의도 분류 hook)
│   ├── model-router.mjs          (모델 라우팅 hook)
│   ├── concurrency-gate.mjs      (동시성 제한 hook)
│   ├── concurrency-release.mjs   (동시성 해제 hook)
│   ├── session-start.mjs         (SessionStart: wisdom+checkpoint 주입) ✅ v0.6.5 신규
│   ├── stop-hook.mjs             (Stop: WIP 자동 커밋) ✅ v0.6.5 신규
│   ├── test/                     (node:test 단위 테스트, 182개 / 13파일) ✅ v0.6.5 신규
│   └── lib/                      (공유 라이브러리)
│       ├── stdin.mjs             (안전한 stdin 읽기)
│       ├── intent-patterns.mjs   (다국어 의도 패턴)
│       ├── model-router.mjs      (라우팅 테이블 로직)
│       ├── checkpoint.mjs        (세션 복구 체크포인트)
│       ├── wisdom.mjs            (학습 기억 시스템, intent-aware 쿼리)
│       ├── tmux-session.mjs      (tmux 세션 관리 + sanitizeForShellArg)
│       ├── inbox-outbox.mjs      (팀 메시징 시스템, 원자적 이동)
│       ├── worker-spawn.mjs      (워커 생성/폴백)
│       ├── worker-status.mjs     (워커 상태 대시보드)
│       ├── worktree.mjs          (Athena 워커 git worktree 격리) ✅ v0.6.5 신규
│       ├── fs-atomic.mjs         (원자적 파일 쓰기 헬퍼) ✅ v0.6.5 신규
│       ├── provider-detect.mjs   (detectProvider() 공유 라이브러리) ✅ v0.6.5 신규
│       └── config-validator.mjs  (model-routing.jsonc 스키마 검증) ✅ v0.6.5 신규
├── config/
│   └── model-routing.jsonc       (모델 라우팅 설정)
├── hooks/
│   └── hooks.json                (hook 이벤트 등록)
├── docs/plans/                   (영구 기획서 저장소)
├── .ao/                          (런타임 임시 상태)
├── .claude-plugin/               (Claude Code 플러그인 메타데이터)
├── package.json                  (v0.6.7, MIT, zero deps)
└── CLAUDE.md                     (AI 에이전트 지시 문서)
```

### 5.3 기술 스택 (Tech Stack)

| 계층 | 기술 |
|------|------|
| 언어 | JavaScript (ESM, Node.js >= 20) |
| 런타임 | Node.js (scripts), Claude Code (host) |
| 외부 통합 | tmux (Codex/Gemini 실행), Codex CLI, Gemini CLI |
| 상태 관리 | 파일 시스템 기반 (.ao/ 디렉토리) |
| 통신 | stdin/stdout JSON (hooks), 파일 기반 inbox/outbox (Athena) |
| 의존성 | **0개** (Node.js 내장 모듈만 사용) |
| 라이선스 | MIT |

---

## 6. 에이전트 카탈로그 (Agent Catalog)

### 6.1 오케스트레이터 (Orchestrator Agents)

| ID | 이름 | 모델 | 역할 | 비고 |
|----|------|------|------|------|
| AG-01 | **atlas** | claude-opus-4-6 | 자율 주행 sub-agent 오케스트레이터 | Hub-and-spoke, 15회 반복 한계 |
| AG-02 | **athena** | claude-opus-4-6 | 자율 주행 팀 오케스트레이터 | Peer-to-peer, Claude 5 + Codex 2 |

### 6.2 분석/기획 에이전트 (Analysis/Planning Agents)

| ID | 이름 | 모델 | 역할 | 비고 |
|----|------|------|------|------|
| AG-03 | **hermes** | opus | 기획 전문가 (정방향/역방향) | Spec-Driven Development 핵심 |
| AG-04 | **metis** | opus | 심층 분석가, 사전 요구사항 분석 | 복잡도/리스크/미지수 평가 |
| AG-05 | **prometheus** | opus | 전략적 실행 계획 수립 | 병렬 그룹, 파일 소유권 |
| AG-06 | **momus** | opus | 계획 검증자, 비평가 | 4개 기준 각 0-100 점수, 70 미만 거부 |

### 6.3 실행 에이전트 (Execution Agents)

| ID | 이름 | 모델 | 역할 | 비고 |
|----|------|------|------|------|
| AG-07 | **executor** | sonnet | 범용 작업 실행자 | 계획대로 정확히 구현 |
| AG-08 | **designer** | sonnet | UI/UX 구현 전문가 | React/Vue/Svelte, WCAG 2.1 AA |
| AG-09 | **test-engineer** | sonnet | 테스트 전략 및 작성 | 단위/통합/E2E |
| AG-10 | **hephaestus** | sonnet | 자율 심층 코딩 전문가 | 탐색적 end-to-end 구현 |
| AG-11 | **debugger** | sonnet | 근본 원인 분석 & 수정 | 2-3 경쟁 가설 방식 |

### 6.4 리뷰 에이전트 (Review Agents, 읽기 전용)

| ID | 이름 | 모델 | 역할 | 비고 |
|----|------|------|------|------|
| AG-12 | **architect** | opus | 아키텍처 리뷰 | APPROVED/NEEDS_WORK 판정 |
| AG-13 | **code-reviewer** | sonnet | 코드 품질 리뷰 | 4단계 심각도 (CRITICAL~LOW) |
| AG-14 | **security-reviewer** | sonnet | 보안 취약점 리뷰 | OWASP Top 10 기반 |

### 6.5 지원 에이전트 (Support Agents)

| ID | 이름 | 모델 | 역할 | 비고 |
|----|------|------|------|------|
| AG-15 | **explore** | haiku | 코드베이스 빠른 탐색 | 읽기 전용, 가장 저비용 |
| AG-16 | **writer** | haiku | 기술 문서 작성 | README, API 문서, 주석 |

### 6.6 에이전트 상호관계 다이어그램

```
사용자 요청
    │
    ▼
┌── Atlas/Athena (오케스트레이터) ──────────────────────┐
│   │                                                   │
│   ├─→ explore (haiku)     빠른 스캔                    │
│   ├─→ metis (opus)        심층 분석                    │
│   ├─→ hermes (opus)       스펙 게이트 (Phase 1.5)     │
│   ├─→ prometheus (opus)   계획 수립                    │
│   ├─→ momus (opus)        계획 검증 ──→ 거부 시 반복   │
│   │                                                   │
│   ├─→ executor (sonnet)   ┐                           │
│   ├─→ designer (sonnet)   ├─ 병렬 실행                │
│   ├─→ test-engineer       │                           │
│   ├─→ hephaestus          ┘                           │
│   ├─→ [Codex via tmux]    외부 모델 실행               │
│   │                                                   │
│   ├─→ debugger (sonnet)   실패 시 수정 루프            │
│   │                                                   │
│   ├─→ architect (opus)    ┐                           │
│   ├─→ code-reviewer       ├─ 병렬 리뷰                │
│   └─→ security-reviewer   ┘                           │
│                                                       │
│   ├─→ slop-cleaner (skill)  코드 정리                  │
│   └─→ git-master (skill)    원자적 커밋                │
└───────────────────────────────────────────────────────┘
```

---

## 7. 스킬 카탈로그 (Skill Catalog)

### 7.1 핵심 오케스트레이션 스킬

| ID | 스킬명 | Level | 트리거 | 목적 |
|----|--------|-------|--------|------|
| SK-01 | **atlas** | 5 | `atlas`, `아틀라스`, `do-it`, `알아서해`, `해줘`, `just-do-it` | 자율 주행 sub-agent 오케스트레이션 |
| SK-02 | **athena** | 5 | `athena`, `아테나`, `team-do-it`, `팀으로해`, `같이해`, `team`, `collaborate` | 자율 주행 팀 오케스트레이션 |
| SK-03 | **plan** | 4 | `plan`, `기획`, `기획서`, `spec`, `PRD`, `스펙`, `reverse-plan`, `기획분석` | 정방향/역방향 기획 (SDD) |
| SK-04 | **cancel** | 1 | `cancel`, `취소`, `stop`, `abort`, `중지` | 실행 중인 세션 정리 |

### 7.2 분석/조사 스킬

| ID | 스킬명 | Level | 트리거 | 목적 |
|----|--------|-------|--------|------|
| SK-05 | **deep-interview** | 4 | `deep-interview`, `인터뷰`, `clarify`, `명확하게`, `요구사항정리` | 소크라테스식 요구사항 명확화 |
| SK-06 | **deep-dive** | 4 | `deep-dive`, `딥다이브`, `심층분석` | 2단계 조사 파이프라인 (조사+결정화) |
| SK-07 | **trace** | 3 | `trace`, `추적`, `root-cause`, `원인분석`, `diagnose` | 경쟁 가설 기반 근본 원인 분석 |
| SK-08 | **research** | 3 | `research`, `조사`, `리서치`, `lookup` | 패싯 분해 병렬 웹 리서치 |
| SK-09 | **external-context** | 3 | `external-context`, `외부컨텍스트`, `외부조사` | 외부 문서/API 지식 수집 |

### 7.3 기획/검증 스킬

| ID | 스킬명 | Level | 트리거 | 목적 |
|----|--------|-------|--------|------|
| SK-10 | **consensus-plan** | 4 | `consensus-plan`, `합의계획`, `컨센서스` | 다관점 합의 기반 계획 검증 루프 |

### 7.4 유틸리티 스킬

| ID | 스킬명 | Level | 트리거 | 목적 |
|----|--------|-------|--------|------|
| SK-11 | **ask** | 2 | `ask`, `물어봐`, `codex`, `gemini`, `quick-ask` | Codex/Gemini 단발 질의 |
| SK-12 | **deepinit** | 2 | `deepinit`, `init`, `초기화`, `map-codebase` | AGENTS.md 코드베이스 맵 생성 |
| SK-13 | **slop-cleaner** | 3 | `slop-cleaner`, `deslop`, `슬롭`, `cleanup`, `clean` | AI 생성 코드 bloat 제거 |
| SK-14 | **git-master** | 2 | `git-master`, `commit`, `커밋`, `git` | 원자적 커밋 규율 |

### 7.5 스킬 파이프라인 통합 패턴

```
사용자 요청 (모호)
    │
    ├─→ /deep-interview      요구사항 명확화
    │       │
    ▼       ▼
    /plan               기획서 생성 (.ao/prd.json)
    │
    ├─→ /atlas  (독립 작업)   또는   /athena  (팀 작업)
    │       │                         │
    │   Phase 1: /deep-dive        Phase 0: /deep-dive
    │   Phase 1: /external-context Phase 0: /external-context
    │   Phase 2: /consensus-plan   Phase 1: /consensus-plan
    │   Phase 4: /trace            Phase 4: /trace
    │   Phase 5b: /slop-cleaner    Phase 5b: /slop-cleaner
    │   Phase 5b: /git-master      Phase 5b: /git-master
    │       │                         │
    └───────┴─────────────────────────┘
                    │
                  완료
```

---

## 8. Hook 시스템 (Hook System)

### 8.1 Hook 등록 구조

hooks.json은 5개의 이벤트에 6개의 hook 스크립트를 등록한다 (v0.6.5에서 SessionStart, Stop 추가):

| 이벤트 | 매처 | Hook 스크립트 | 역할 |
|--------|------|-------------|------|
| `SessionStart` | `*` | session-start.mjs ✅ | wisdom + checkpoint 컨텍스트 세션 시작 시 주입 |
| `UserPromptSubmit` | `*` | intent-gate.mjs | 사용자 의도 분류, additionalContext 주입 |
| `PreToolUse` | `Task` | concurrency-gate.mjs | 동시 Task 호출 수 제한 |
| `PreToolUse` | `Task` | model-router.mjs | 의도 기반 모델 라우팅 조언 주입 |
| `PreToolUse` | `Agent` | concurrency-gate.mjs | 동시 Agent 호출 수 제한 |
| `PreToolUse` | `Agent` | model-router.mjs | 의도 기반 모델 라우팅 조언 주입 |
| `PostToolUse` | `Task` | concurrency-release.mjs | 완료된 Task의 동시성 슬롯 해제 |
| `PostToolUse` | `Agent` | concurrency-release.mjs | 완료된 Agent의 동시성 슬롯 해제 |
| `Stop` | `*` | stop-hook.mjs ✅ | 세션 종료 시 미커밋 작업 WIP 커밋으로 자동 저장 |

### 8.2 Hook 실행 흐름

```
사용자가 프롬프트 입력
    │
    ▼
[UserPromptSubmit] intent-gate.mjs
    │  1. stdin에서 JSON 수신 (5초 타임아웃)
    │  2. 프롬프트 텍스트 추출
    │  3. classifyIntent()로 다국어 의도 분류
    │  4. .ao/state/ao-intent.json에 결과 저장
    │  5. additionalContext로 라우팅 조언 주입
    ▼
Claude가 Task/Agent 호출 결정
    │
    ▼
[PreToolUse: Task/Agent] concurrency-gate.mjs
    │  1. 활성 Task 수 확인 (글로벌 5, Claude 3, Codex 2, Gemini 2)
    │  2. 한계 도달 시 block, 미달 시 등록
    │  3. 10분 이상 된 stale Task 자동 정리
    ▼
[PreToolUse: Task/Agent] model-router.mjs
    │  1. ao-intent.json에서 의도 상태 로드 (10분 미만)
    │  2. routeByIntent()로 최적 에이전트/모델 결정
    │  3. additionalContext로 라우팅 조언 주입
    ▼
Task/Agent 실행
    │
    ▼
[PostToolUse: Task/Agent] concurrency-release.mjs
    │  1. 완료된 Task의 provider 감지
    │  2. 해당 provider의 가장 오래된 활성 Task 해제
    │  3. stale Task 추가 정리
    ▼
완료
```

### 8.3 run.cjs -- 범용 진입점

`run.cjs`는 모든 hook의 진입점으로, 다음 문제를 해결한다:
- **크로스 플랫폼**: `process.execPath`로 Node 바이너리를 직접 참조하여 Windows/macOS/Linux 호환
- **버전 폴백**: 플러그인 업데이트로 이전 버전 디렉토리가 삭제되어도, 최신 버전에서 동일 스크립트를 찾아 실행
- **실패 안전**: 스크립트를 찾지 못하면 exit(0)으로 조용히 종료, Claude Code를 차단하지 않음

### 8.4 의도 분류 시스템 (Intent Classification)

6개 의도 카테고리, 4개 언어(영어, 한국어, 일본어, 중국어) 지원:

| 카테고리 | 라우팅 | 모델 |
|---------|--------|------|
| `visual-engineering` | designer | sonnet + Gemini |
| `deep` | architect | opus |
| `quick` | explore | haiku |
| `writing` | writer | haiku |
| `artistry` | designer | sonnet + Gemini |
| `planning` | prometheus (또는 /plan) | opus |
| `unknown` | executor | sonnet |

분류 알고리즘:
- 정규식 패턴 매칭 (가중치 1.0)
- 키워드 포함 검사 (가중치 0.5)
- 코드 블록, URL, 파일 경로는 사전 제거하여 오탐 방지
- 신뢰도 = 최고 점수 / 총점 합산 (0~1)

---

## 9. 상태 관리 (State Management)

### 9.1 .ao/ 디렉토리 구조

```
.ao/
├── prd.json                      임시 PRD (실행 후 삭제)
├── spec.md                       임시 스펙 문서 (실행 후 삭제)
├── wisdom.jsonl                  학습 기억 (영구 보존, 삭제 금지)
├── deep-dive-report.json         심층 조사 결과
├── external-context.json         외부 컨텍스트 결과
├── state/
│   ├── ao-intent.json            의도 분류 결과 (10분 TTL)
│   ├── ao-concurrency.json       동시성 추적 상태
│   ├── checkpoint-atlas.json     Atlas 세션 체크포인트 (24시간 TTL)
│   ├── checkpoint-athena.json    Athena 세션 체크포인트 (24시간 TTL)
│   ├── atlas-state.json          Atlas 실행 상태
│   ├── athena-state.json         Athena 실행 상태
│   └── team-*.json               팀 워커 상태
├── teams/
│   └── <slug>/
│       ├── status.jsonl          워커 상태 로그
│       └── <worker>/
│           ├── inbox/            수신 메시지
│           ├── outbox/           발신 메시지
│           └── processed/        처리 완료 메시지
└── artifacts/
    ├── ask/                      /ask 결과 보관
    └── team/<name>/              팀 워커 결과 보관
```

### 9.2 체크포인트 시스템 (Checkpoint)

- **저장 시점**: 매 Phase 전환마다 saveCheckpoint() 호출
- **만료**: 24시간 후 자동 삭제
- **복구**: 다음 세션 시작 시 loadCheckpoint()로 중단 지점 감지
- **데이터**: phase 번호, PRD 스냅샷, 완료된 스토리 ID 목록, 활성 워커 목록
- **Cancel 시 보존**: /cancel 실행 시 체크포인트는 삭제하지 않아 재개 가능

### 9.3 Wisdom 시스템 (Cross-Session Learning)

- **형식**: JSONL (한 줄 한 JSON 레코드)
- **카테고리**: test, build, architecture, pattern, debug, performance, general
- **신뢰도**: high, medium, low
- **중복 방지**: Jaccard 유사도 70% 이상이면 건너뜀 (v0.6.5에서 80%→70%로 조정)
- **정리**: pruneWisdom(200)으로 90일 이상 오래된 항목 삭제, 최대 200개 유지
- **마이그레이션**: 레거시 progress.txt에서 wisdom.jsonl로 자동 변환
- **삭제 금지**: .ao/wisdom.jsonl은 어떤 상황에서도 삭제하지 않음

### 9.4 영구 기획 저장소 (docs/plans/)

- **위치**: git-tracked 디렉토리
- **구조**: `docs/plans/<slug>/spec.md`, `prd.json`, `CHANGELOG.md`
- **README.md**: 모든 기획서를 자동 인덱싱하는 테이블
- **분리 원칙**: `.ao/prd.json`은 실행 시 변형될 수 있지만, `docs/plans/`의 사본은 원본을 보존

---

## 10. Codex 통합 (Codex Integration)

### 10.1 tmux 기반 실행

Codex는 CLI가 아닌 **tmux 세션**을 통해 실행된다:

```bash
# 세션 생성 및 명령 실행
tmux new-session -d -s "atlas-codex-1" -c "<cwd>"
tmux send-keys -t "atlas-codex-1" 'codex exec "<prompt>"' Enter

# 출력 모니터링 (10-15초 간격 폴링)
tmux capture-pane -pt "atlas-codex-1" -S -200

# 종료 및 정리
tmux kill-session -t "atlas-codex-1"
```

### 10.2 세션 네이밍

| 오케스트레이터 | 패턴 | 예시 |
|--------------|------|------|
| Atlas | `atlas-codex-<N>` | atlas-codex-1 |
| Athena | `athena-<slug>-codex-<N>` | athena-auth-codex-1 |
| 팀 워커 | `ao-team-<team>-<worker>` | ao-team-auth-api-worker |

### 10.3 실패 감지 및 Claude 폴백

`detectCodexError()` 함수가 tmux 출력에서 5가지 실패 패턴을 감지:

| 실패 유형 | 패턴 | 재시도 정책 |
|-----------|------|-----------|
| `auth_failed` | authentication, unauthorized, invalid api key | 세션 내 Codex 사용 중단 |
| `rate_limited` | rate limit, 429, quota exceeded | 세션 내 Codex 사용 중단 |
| `not_installed` | command not found, ENOENT | 세션 내 Codex 사용 중단 |
| `network` | ETIMEDOUT, ECONNRESET, ENOTFOUND | 1회 재시도 |
| `crash` | fatal error, SIGSEGV, SIGABRT | 1회 재시도, 재실패 시 Claude 전환 |

실패 시 `reassignToClaude()`가 tmux 정리 + wisdom 기록을 처리하고, 오케스트레이터가 `agent-olympus:executor`로 대체 Task를 발행한다.

---

## 11. 설정 시스템 (Configuration)

### 11.1 config/model-routing.jsonc

JSONC 형식(주석 허용)으로, 의도 카테고리별 라우팅을 사용자 정의:

```
{
  "version": "1",
  "routes": {
    "<category>": {
      "agent": "agent-olympus:<name>",
      "model": "opus|sonnet|haiku",
      "fallbackChain": ["model1", "model2"],
      "teamWorkerType": "gemini|codex|null"
    }
  },
  "concurrency": {
    "maxParallelTasks": 3,
    "maxGeminiWorkers": 2,
    "maxCodexWorkers": 2
  },
  "thresholds": {
    "minConfidence": 0.15,
    "highConfidence": 0.70
  }
}
```

### 11.2 환경 변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `DISABLE_AO` | - | `1`로 설정 시 모든 hook 비활성화 |
| `AO_CONCURRENCY_GLOBAL` | 5 | 글로벌 최대 동시 Task 수 |
| `AO_CONCURRENCY_CLAUDE` | 3 | Claude 최대 동시 Task 수 |
| `AO_CONCURRENCY_CODEX` | 2 | Codex 최대 동시 Task 수 |
| `AO_CONCURRENCY_GEMINI` | 2 | Gemini 최대 동시 Task 수 |
| `CLAUDE_PLUGIN_ROOT` | (자동) | 플러그인 설치 경로 |

---

## 12. 피처 인벤토리 (Feature Inventory)

### RF-001: 자율 주행 sub-agent 오케스트레이션 (Atlas) [⬜ 유닛 테스트 없음 — 오케스트레이터 레벨]
**As a** 개발자, **I want to** 복잡한 작업을 "해줘" 한마디로 위임하고 싶다, **so that** 분석-기획-구현-검증-리뷰 전 과정을 AI가 자율적으로 완수한다.
**Acceptance Criteria:**
- GIVEN 사용자가 "atlas" 또는 "해줘"를 입력하면 WHEN Atlas 스킬이 트리거되면 THEN 6단계 파이프라인이 자동 시작된다
- GIVEN 빌드 또는 테스트가 실패하면 WHEN debugger가 3회 이내 수정하면 THEN 재검증 후 진행, 3회 초과 시 사용자에게 에스컬레이션
- GIVEN 15회 반복을 초과하면 WHEN 정지 조건에 도달하면 THEN 사용자에게 현재 상태 보고 및 에스컬레이션
**Source:** `skills/atlas/SKILL.md`, `agents/atlas.md`
**Test Coverage:** ⬜ 없음 (스킬/에이전트 레벨 통합 테스트 범위 밖)

### RF-002: 자율 주행 팀 오케스트레이션 (Athena) [✅ 부분 테스트 있음]
**As a** 개발자, **I want to** 상호의존적인 대규모 작업을 팀 모드로 실행하고 싶다, **so that** 여러 워커가 실시간으로 소통하며 협업한다.
**Acceptance Criteria:**
- GIVEN 사용자가 "athena" 또는 "팀으로해"를 입력하면 WHEN Athena 스킬이 트리거되면 THEN 팀 설계 후 워커 생성
- GIVEN 워커 간 의존성이 있으면 WHEN Claude 워커가 완료하면 THEN SendMessage로 다른 워커에게 통지
- GIVEN Codex 워커가 실패하면 WHEN detectCodexError()가 감지하면 THEN Claude executor로 자동 폴백
**Source:** `skills/athena/SKILL.md`, `agents/athena.md`
**Test Coverage:** ✅ `scripts/test/worktree.test.mjs` (14 tests, worktree 격리 라이프사이클 커버)

### RF-003: 정방향/역방향 기획 (Plan) [⬜ 유닛 테스트 없음 — 스킬 레벨]
**As a** 개발자, **I want to** 모호한 아이디어를 실행 가능한 스펙으로 변환하거나, 기존 코드베이스에서 암묵적 스펙을 추출하고 싶다, **so that** 구조화된 PRD로 Atlas/Athena에 투입할 수 있다.
**Acceptance Criteria:**
- GIVEN 사용자가 "plan" 또는 "기획"을 입력하면 WHEN 정방향 모드가 감지되면 THEN Hermes가 초기 스펙을 생성
- GIVEN 사용자가 "기획분석" 또는 "reverse-plan"을 입력하면 WHEN 역방향 모드가 감지되면 THEN 코드에서 피처를 추출하고 헬스 스코어를 산출
- GIVEN 스펙이 완성되면 WHEN docs/plans/<slug>/에 저장되면 THEN spec.md, prd.json, CHANGELOG.md가 생성되고 README.md 인덱스가 갱신
**Source:** `skills/plan/SKILL.md`, `agents/hermes.md`
**Test Coverage:** ⬜ 없음 (스킬/에이전트 레벨 통합 테스트 범위 밖)

### RF-004: 의도 기반 자동 라우팅 (Intent Gate + Model Router) [✅ 테스트 있음]
**As a** 개발자, **I want to** 프롬프트를 입력하면 최적의 에이전트와 모델이 자동 선택되기를 원한다, **so that** 매번 수동으로 모델을 지정하지 않아도 된다.
**Acceptance Criteria:**
- GIVEN 사용자가 "CSS 버튼 스타일 수정"을 입력하면 WHEN intent-gate가 분류하면 THEN visual-engineering 카테고리로 designer/sonnet 라우팅
- GIVEN 한국어 프롬프트를 입력하면 WHEN 다국어 패턴이 매칭되면 THEN 동일한 정확도로 분류
- GIVEN 의도 신뢰도가 15% 미만이면 WHEN model-router가 처리하면 THEN unknown으로 폴백하여 executor/sonnet 사용
**Source:** `scripts/intent-gate.mjs`, `scripts/lib/intent-patterns.mjs`, `scripts/model-router.mjs`, `scripts/lib/model-router.mjs`
**Test Coverage:** ✅ `scripts/test/intent-patterns.test.mjs` (21 tests)

### RF-005: 동시성 제어 (Concurrency Gate) [✅ 테스트 있음]
**As a** 시스템, **I want to** 동시에 실행 가능한 Task/Agent 수를 제한하고 싶다, **so that** API 레이트 리밋과 리소스 고갈을 방지한다.
**Acceptance Criteria:**
- GIVEN 글로벌 동시 Task가 5개에 도달하면 WHEN 새 Task를 시도하면 THEN block 응답 반환
- GIVEN Task가 완료되면 WHEN PostToolUse가 트리거되면 THEN 해당 provider의 가장 오래된 슬롯 해제
- GIVEN Task가 10분 이상 실행되면 WHEN 다음 게이트 확인 시 THEN stale로 간주하여 자동 정리
**Source:** `scripts/concurrency-gate.mjs`, `scripts/concurrency-release.mjs`
**Test Coverage:** ✅ `scripts/test/concurrency-gate.test.mjs` (7 tests)

### RF-006: 세션 복구 (Checkpoint System) [✅ 테스트 있음]
**As a** 개발자, **I want to** Atlas/Athena 세션이 중단되어도 이어서 작업하고 싶다, **so that** 진행 상황을 잃지 않는다.
**Acceptance Criteria:**
- GIVEN 세션이 중단된 상태에서 WHEN 다시 /atlas 실행하면 THEN "Phase 3 (EXECUTE), 2/5 stories complete, 3h ago. Resume or restart?" 형태로 표시
- GIVEN 체크포인트가 24시간 이상 오래되면 WHEN loadCheckpoint() 호출 시 THEN null 반환 및 파일 삭제
**Source:** `scripts/lib/checkpoint.mjs`
**Test Coverage:** ✅ `scripts/test/checkpoint.test.mjs` (7 tests)

### RF-007: 학습 기억 시스템 (Wisdom) [✅ 테스트 있음]
**As a** AI 오케스트레이터, **I want to** 이전 세션의 학습 내용을 기억하고 싶다, **so that** 같은 실수를 반복하지 않고 패턴을 재활용한다.
**Acceptance Criteria:**
- GIVEN 새 교훈이 발견되면 WHEN addWisdom() 호출 시 THEN JSONL 형식으로 .ao/wisdom.jsonl에 추가
- GIVEN 기존 교훈과 80% 이상 유사하면 WHEN addWisdom() 호출 시 THEN 중복 건너뜀
- GIVEN pruneWisdom(200) 호출 시 WHEN 90일 이상 오래된 항목이 있으면 THEN 삭제하고 최대 200개 유지
**Source:** `scripts/lib/wisdom.mjs`
**Test Coverage:** ✅ `scripts/test/wisdom.test.mjs` (intent-aware query 포함)

### RF-008: Codex 실패 감지 및 자동 폴백 [✅ 테스트 있음]
**As a** 오케스트레이터, **I want to** Codex 워커가 실패하면 자동으로 Claude로 전환하고 싶다, **so that** 외부 모델 장애가 전체 파이프라인을 중단시키지 않는다.
**Acceptance Criteria:**
- GIVEN Codex가 "unauthorized" 오류를 반환하면 WHEN detectCodexError()가 감지하면 THEN auth_failed로 분류하고 세션 내 Codex 사용 중단
- GIVEN Codex가 crash하면 WHEN 1회 재시도 후 재실패하면 THEN Claude executor로 자동 전환
**Source:** `scripts/lib/worker-spawn.mjs`
**Test Coverage:** ✅ `scripts/test/worker-spawn.test.mjs` (17 tests, detectCodexError 커버)

### RF-009: 팀 메시징 시스템 (Inbox/Outbox) [✅ 테스트 있음]
**As a** Athena 워커, **I want to** 파일 시스템 기반 메시지를 주고받고 싶다, **so that** Claude와 Codex 워커 간 비동기 통신이 가능하다.
**Acceptance Criteria:**
- GIVEN sendMessage() 호출 시 WHEN 대상 워커의 inbox 디렉토리에 THEN 타임스탬프-UUID.json 파일 생성
- GIVEN readInbox({consume: true}) 호출 시 WHEN 메시지를 읽으면 THEN processed/ 디렉토리로 이동
**Source:** `scripts/lib/inbox-outbox.mjs`
**Test Coverage:** ✅ `scripts/test/inbox-outbox.test.mjs` (7 tests, withTmpCwd 패턴)

### RF-010: 워커 상태 대시보드 [✅ 테스트 있음]
**As a** 사용자, **I want to** Athena 팀 워커들의 현재 상태를 한눈에 보고 싶다, **so that** 진행 상황을 모니터링할 수 있다.
**Acceptance Criteria:**
- GIVEN formatStatusMarkdown() 호출 시 WHEN status.jsonl에 데이터가 있으면 THEN 마크다운 테이블 형태로 워커별 phase, progress, updated 표시
**Source:** `scripts/lib/worker-status.mjs`
**Test Coverage:** ✅ `scripts/test/worker-status.test.mjs` (10 tests)

### RF-011: 크로스 플랫폼 Hook 실행 [✅ 테스트 있음]
**As a** 플러그인, **I want to** macOS, Linux, Windows에서 동일하게 hook이 실행되기를 원한다, **so that** 설치 환경에 관계없이 동작한다.
**Acceptance Criteria:**
- GIVEN Windows에서 실행 시 WHEN run.cjs가 process.execPath를 사용하면 THEN /usr/bin/sh 의존 없이 Node.js 직접 실행
- GIVEN 플러그인 버전이 업데이트되면 WHEN 이전 경로가 존재하지 않으면 THEN 최신 버전 디렉토리에서 동일 스크립트 자동 검색
**Source:** `scripts/run.cjs`
**Test Coverage:** ✅ `scripts/test/stdin.test.mjs` (6 tests, stdin 읽기 동작 커버)

---

## 13. 건강 평가 (Health Assessment)

**v0.5.0 분석 당시 (2026-03-27):**

| 차원 | 점수 | 비고 |
|------|------|------|
| **Test Coverage** | 5/100 | 테스트 프레임워크 미설정. 구문 검사(node --check)만 존재. 단위/통합 테스트 0개 |
| **Documentation** | 85/100 | CLAUDE.md, README.md, README.ko.md 우수. 각 에이전트/스킬 내 문서 충실. API 레퍼런스 부재 |
| **Code Quality** | 70/100 | 일관된 ESM 스타일, fail-safe 패턴 철저. zero dependency. 일부 detectProvider() 중복 |
| **Architecture** | 80/100 | 명확한 관심사 분리 (agent/skill/script/hook). Hook 파이프라인 설계 견고. 상태 관리 파일 기반이라 동시성 안전성 미흡 |
| **Security** | 55/100 | 파일 권한 0o600/0o700 적용. 하지만 tmux send-keys에 프롬프트 직접 주입은 커맨드 인젝션 위험. 입력 검증 미흡 |
| **Overall** | **62/100** | |

**v0.6.7 개선 후 (2026-03-28):**

| 차원 | 점수 | 개선 내용 |
|------|------|---------|
| **Test Coverage** | 80/100 | 182개 단위 테스트, 13개 파일 (node:test). 핵심 lib 모듈 전체 커버 ✅ |
| **Documentation** | 92/100 | README.md/ko.md 언어 전환 배너, 동기화. AGENTS.md 전면 갱신. CHANGELOG.md 생성 ✅ |
| **Code Quality** | 88/100 | detectProvider() 공유 lib 추출, fs-atomic.mjs 원자적 쓰기, 중복 제거 ✅ |
| **Architecture** | 90/100 | Athena 워커 git worktree 격리, 원자적 상태 쓰기, config 스키마 검증 ✅ |
| **Security** | 85/100 | sanitizeForShellArg()로 tmux 커맨드 인젝션 방지, 파일 기반 프롬프트 전달 ✅ |
| **Overall** | **85/100** | |

---

## 14. 기술 부채 (Technical Debt)

> **v0.6.7 기준 구현 현황:** 모든 critical/moderate 항목 해결됨 ✅

| 심각도 | 항목 | 위치 | 상태 |
|--------|------|------|------|
| **critical** | 테스트 프레임워크 완전 부재 | 전체 | ✅ **해결** v0.6.5: node:test 도입, 182개 테스트 / 13파일 |
| **critical** | tmux send-keys에 사용자 입력 직접 주입 | `tmux-session.mjs` | ✅ **해결** v0.6.5: sanitizeForShellArg() + writePromptFile() 도입 |
| **moderate** | detectProvider() 함수 중복 | `concurrency-gate.mjs`, `concurrency-release.mjs` | ✅ **해결** v0.6.5: lib/provider-detect.mjs로 추출 |
| **moderate** | 상태 파일 동시 쓰기 안전성 미흡 | `wisdom.mjs`, `concurrency-gate.mjs` | ✅ **해결** v0.6.5: lib/fs-atomic.mjs (tmp+rename) 전면 적용 |
| **moderate** | marketplace.json의 에이전트/스킬 수 불일치 | `.claude-plugin/marketplace.json` | ✅ **해결** v0.6.5: 16 agents, 15 skills로 정정 |
| **low** | AGENTS.md와 docs/ 구조 미완성 | 프로젝트 루트 | ✅ **해결** v0.6.7: AGENTS.md 전면 재작성 |
| **low** | Gemini CLI 통합 가정 | `tmux-session.mjs:buildWorkerCommand()` | ⚠️ **잔존** Gemini CLI 인터페이스 검증 미완료 |

---

## 15. 문서화 갭 (Documentation Gaps)

- lib/ 모듈들의 JSDoc은 있으나, 독립적인 **API 레퍼런스 문서** 부재
- Hook 이벤트의 입출력 JSON 스키마가 코드에만 존재하고 문서화되지 않음
- `.ao/` 디렉토리 구조 및 각 파일의 라이프사이클을 설명하는 **상태 관리 가이드** 부재
- Codex/Gemini CLI 설치 및 설정 방법에 대한 **사전 요구사항 가이드** 부재
- 플러그인 설치 후 초기 설정 과정 (환경 변수, tmux 설치 등)에 대한 **Getting Started 가이드** 미흡

---

## 16. 개선 기회 (Improvement Opportunities)

> **v0.6.7 기준 구현 현황:** 모든 High Impact / 일부 Medium Impact 완료 ✅

### 16.1 높은 영향 (High Impact)

1. ✅ **테스트 프레임워크 도입** (v0.6.5) — node:test 도입, 182개 테스트 / 13파일. checkpoint, concurrency-gate, config-validator, fs-atomic, inbox-outbox, intent-patterns, provider-detect, stdin, tmux-session, wisdom, worker-spawn, worker-status, worktree 커버
2. ✅ **tmux 커맨드 인젝션 방지** (v0.6.5) — sanitizeForShellArg()로 셸 특수문자 이스케이프, writePromptFile()로 파일 기반 프롬프트 전달
3. ✅ **상태 파일 원자적 쓰기** (v0.6.5) — lib/fs-atomic.mjs (atomicWriteFileSync/atomicWriteFile/atomicMoveSync) 전면 적용
4. ✅ **Athena 워커 git worktree 격리** (v0.6.5, Kimoring 패턴 응용) — 각 워커가 .ao/worktrees/<slug>/<worker>/에서 독립 실행, 완료 후 순차 머지
5. ✅ **SessionStart 훅 도입** (v0.6.5, Kimoring 패턴) — wisdom + checkpoint 컨텍스트 세션 시작 시 자동 주입
6. ✅ **Stop 훅 WIP 커밋** (v0.6.5, Kimoring 패턴) — 세션 종료 시 미커밋 작업 자동 저장
7. ✅ **verify-coverage 스킬** (v0.6.5, Kimoring 패턴) — 최근 변경 파일 기반 테스트 커버리지 갭 감지

### 16.2 중간 영향 (Medium Impact)

8. (완료) **실시간 진행률 보고** — Atlas/Athena 파이프라인 Phase 전환 시 사용자에게 진행률 표시 (워커 상태 대시보드로 부분 구현)
9. ✅ **설정 파일 스키마 검증** (v0.6.5) — lib/config-validator.mjs로 model-routing.jsonc 로드 시 검증, 오류 시 safe fallback
10. ⬜ **Hook 타임아웃 모니터링** — 3초 타임아웃 근접 실행을 wisdom에 기록하는 성능 병목 추적 (미구현)
11. ⬜ **에이전트 성능 메트릭** — 에이전트 호출 소요 시간, 성공/실패율 wisdom 기록 (미구현)

### 16.3 낮은 영향 (Low Impact)

12. ✅ **detectProvider() DRY 리팩토링** (v0.6.5) — lib/provider-detect.mjs로 추출 완료
13. ⬜ **JSONC 파서 공유** — model-router.mjs의 stripJsoncComments()를 lib/jsonc.mjs로 분리 (미구현, 낮은 우선순위)
14. ⬜ **docs/plans/ 자동 인덱싱 CI** — git pre-commit hook으로 docs/plans/README.md 자동 갱신 (미구현)

---

## 17. 향후 로드맵 제안 (Proposed Roadmap)

현재 아키텍처에서 자연스럽게 확장 가능한 방향:

### Phase 1: 기반 강화 (v0.6.5~v0.6.7) ✅ 완료
- [x] node:test 기반 테스트 프레임워크 도입, 182개 테스트 / 13파일 (목표: 80% 커버리지 달성)
- [x] tmux 커맨드 인젝션 방지 (sanitizeForShellArg + 파일 기반 프롬프트 전달)
- [x] 상태 파일 원자적 쓰기 (lib/fs-atomic.mjs)
- [x] detectProvider() 중복 제거 (lib/provider-detect.mjs)
- [x] Athena 워커 git worktree 격리 (lib/worktree.mjs)
- [x] SessionStart/Stop 훅 도입 (Kimoring 패턴)
- [x] verify-coverage 스킬 신규 추가
- [x] 문서 전면 동기화 (README.md/ko.md 언어 전환, AGENTS.md, CHANGELOG.md)

### Phase 2: 관찰 가능성 (v0.7.0)
- [ ] 에이전트별 성능 메트릭 수집 (소요 시간, 성공률)
- [ ] Hook 타임아웃 모니터링 (wisdom 자동 기록)
- [ ] wisdom 통계 대시보드 (카테고리별 분포, 활용률)

### Phase 3: 확장성 (v0.8.0)
- [ ] 커스텀 에이전트 정의 지원 (사용자가 agents/ 디렉토리에 자체 에이전트 추가)
- [ ] 커스텀 스킬 파이프라인 (스킬 체이닝 DSL)
- [ ] MCP 서버 통합 (외부 도구 직접 호출)

### Phase 4: 협업 (v0.9.0)
- [ ] 멀티 세션 조율 (여러 Claude Code 인스턴스가 하나의 팀으로 협업)
- [ ] PR 자동 생성 및 CI 연동

### Phase 5: 자기 개선 (v1.0.0)
- [ ] wisdom 기반 자동 에이전트 선택 최적화 (과거 성공/실패 패턴 학습)
- [ ] 비용 추적 및 최적화 (모델 티어별 토큰 사용량 추적)
- [ ] 자동 회고 (retrospective) -- 완료된 태스크에서 프로세스 개선점 자동 추출

---

## 18. 개방 질문 (Open Questions)

1. **Gemini CLI 인터페이스**: `gemini "<prompt>"` 형태의 CLI가 실제로 존재하는가? 현재 코드는 이를 가정하고 있으나 검증 필요
2. **동시성 안전성**: wisdom.jsonl에 여러 에이전트가 동시에 쓸 때의 POSIX append atomicity가 실제로 보장되는 환경은?
3. **플러그인 마켓플레이스 등록**: Claude Code 플러그인 마켓플레이스의 현재 상태와 배포 프로세스는?
4. **Windows 호환성**: tmux가 없는 Windows 환경에서의 Codex 통합 대안은?
5. **비용 제어**: Opus 모델을 다수 호출하는 Atlas/Athena 파이프라인의 토큰 비용 관리 전략은?
