# G#4: Native Agent Teams — Specification (v2, Post Cross-Validation)

**Status**: Draft v2 (updated v0.9.8: autonomy.json fallback)
**Created**: 2026-04-04
**Tracks**: Improvement Tracker G#4
**Version Target**: v0.10.0
**Cross-Validation**: Codex (109K tokens) + Architect (Advocate) + Momus (Critic)

---

## Cross-Validation Summary (v1 → v2)

v1 스펙은 `native-teams.mjs`를 Node.js 어댑터로 worker-spawn.mjs에 Tier 0로 삽입하는 구조를 제안했으나,
3개 리뷰어 모두 **핵심 구조 오류**를 발견:

| 발견 | 심각도 | 리뷰어 |
|------|--------|--------|
| TeamCreate/SendMessage는 LLM tool call — Node.js에서 호출 불가 | CRITICAL | Codex + Critic |
| 통합 지점은 worker-spawn.mjs가 아닌 SKILL.md | CRITICAL | Critic |
| SKILL.md가 이미 네이티브 팀을 직접 사용 중 | HIGH | Codex + Critic |
| Hybrid mode는 동일 adapter 경로로 불가 — 다른 제어 평면 | CRITICAL | Codex |
| collectResults() 매핑 누락 | HIGH | Codex + Advocate |
| 워크트리 자동 관리 가정 오류 | HIGH | Codex + Critic |
| hasTeamTools 이름 충돌 | HIGH | Critic |

**v2 핵심 변경**: SKILL.md를 통합 지점으로, worker-spawn.mjs는 Codex+fallback 전용.

---

## Problem Statement

**WHO:** Developers using Athena (Agent Olympus team orchestrator).
**WHAT:** Athena SKILL.md는 이미 네이티브 팀 도구(TeamCreate, SendMessage, TaskList)를 프롬프트에서 참조하지만, 실제로는 `hasTeamTools = true` 하드코딩이라 런타임 감지/폴백 없이 동작. 네이티브 팀 미지원 환경에서는 Claude 워커가 기존 claude-cli/tmux로 폴백하지만, 이 분기가 명시적이지 않음.
**WHY NOW:** SKILL.md가 이미 네이티브 구조를 사용 중. 부족한 것은 (1) 런타임 감지, (2) 명시적 폴백 분기, (3) 워크트리/이벤트 통합.

## Architecture: Dual Control Plane

```
SKILL.md Phase 2 — SPAWN
  │
  ├─ IF hasNativeTeamTools (env var detected):
  │   └─ Claude workers: TeamCreate + Task(team_name=...) [LLM tool call]
  │   └─ Codex workers:  worker-spawn.mjs 4-tier adapter [Node.js]
  │   └─ Worktrees: pre-create via worktree.mjs for ALL workers
  │
  └─ ELSE (fallback):
      └─ ALL workers: worker-spawn.mjs 4-tier adapter [Node.js]
      └─ Worktrees: pre-create via worktree.mjs (현재 동작과 동일)

SKILL.md Phase 3 — MONITOR
  │
  ├─ Native Claude workers: TaskList tool call (LLM level)
  ├─ Codex workers: monitorTeam() in worker-spawn.mjs (Node.js level)
  └─ Hybrid: SKILL.md가 양쪽 모두 체크

SKILL.md Phase 4 — INTEGRATE
  │
  └─ mergeWorkerBranch() — 양 경로 모두 동일 (git merge)
```

---

## Goals

- G1: 런타임에 네이티브 팀 가용성 감지 (`hasNativeTeamTools` in preflight — env var `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 또는 `.ao/autonomy.json` `nativeTeams: true`)
- G2: SKILL.md에 명시적 native/fallback 분기 추가 (Phase 2, 3, COMPLETION)
- G3: Codex 워커는 기존 4-tier adapter 유지 (변경 없음)
- G4: 워크트리는 항상 수동 생성 (네이티브 자동 관리 가정하지 않음)
- G5: 폴백 시 기존 동작과 100% 동일 (zero regression)
- G6: 이벤트 로그에 네이티브 팀 활동 기록 (SKILL.md에서 수동 emit)
- G7: 기존 테스트 전부 통과

## Non-Goals

- N1: `native-teams.mjs` Node.js tool wrapper 만들지 않음 (LLM tool call은 감쌀 수 없음)
- N2: worker-spawn.mjs에 native-teams tier 추가하지 않음
- N3: Atlas 변경하지 않음 (subagent 패턴, 팀 아님)
- N4: 워크트리 자동 관리 가정하지 않음 — 항상 수동 생성
- N5: npm 의존성 추가하지 않음

---

## User Stories

### US-001: Feature Detection

**As a** orchestrator, **I want** to detect native teams availability at runtime, **so that** SKILL.md can branch to the correct execution path.

**Acceptance Criteria:**
- GIVEN `preflight.detectCapabilities()` runs WHEN `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` env var is `"1"` THEN `hasNativeTeamTools` is `true`
- GIVEN env var is not set or not `"1"` THEN `hasNativeTeamTools` is `false`
- GIVEN existing `hasTeamTools` field WHEN renamed to `hasNativeTeamTools` THEN all references updated (preflight.mjs, preflight.test.mjs, formatCapabilityReport)
- GIVEN capability report WHEN formatted THEN includes `✓/✗ Native Agent Teams — peer-to-peer team orchestration`

### US-002: SKILL.md Phase 2 — Native/Fallback Branch

**As a** orchestrator, **I want** SKILL.md Phase 2 to explicitly branch on native teams availability, **so that** Claude workers use the optimal spawn path.

**Acceptance Criteria:**
- GIVEN `hasNativeTeamTools === true` WHEN Phase 2 spawns Claude workers THEN SKILL.md instructs: call `TeamCreate("athena-<slug>")`, then `Task(team_name=..., ...)` for each Claude worker
- GIVEN `hasNativeTeamTools === true` WHEN Phase 2 spawns Codex workers THEN Codex workers are dispatched via `worker-spawn.mjs` 4-tier adapter (unchanged)
- GIVEN `hasNativeTeamTools === false` WHEN Phase 2 spawns ALL workers THEN all workers go through `worker-spawn.mjs` (current behavior, zero regression)
- GIVEN `TeamCreate` fails at runtime (tool unavailable, error response) WHEN the LLM detects failure THEN SKILL.md falls back to `worker-spawn.mjs` for all workers + logs wisdom entry

### US-003: Worktree Pre-Creation for All Workers

**As a** orchestrator, **I want** worktrees pre-created for all workers regardless of native/fallback path, **so that** file isolation is guaranteed.

**Acceptance Criteria:**
- GIVEN native teams path WHEN Claude workers are spawned THEN `createWorkerWorktree()` is called BEFORE `Task(team_name=...)`, and `worktreePath` is injected into the worker prompt
- GIVEN fallback path WHEN workers are spawned THEN worktree creation is unchanged (current behavior)
- GIVEN worktrees are created WHEN tracked in checkpoint THEN `worktrees` map includes all workers (native + codex)

### US-004: SKILL.md Phase 3 — Hybrid Monitoring

**As a** orchestrator, **I want** the monitoring loop to handle both native and Codex workers, **so that** progress tracking works in hybrid mode.

**Acceptance Criteria:**
- GIVEN native Claude workers WHEN monitoring THEN SKILL.md calls `TaskList("athena-<slug>")` (LLM tool call) to check status
- GIVEN Codex workers WHEN monitoring THEN SKILL.md uses `monitorTeam()` from worker-spawn.mjs (current behavior)
- GIVEN a worker is stuck for 3+ iterations WHEN detected THEN stuck recovery applies (unchanged)
- GIVEN a native Claude worker fails silently WHEN TaskList shows no progress for 5 minutes THEN treat as stalled + apply recovery strategy

### US-005: SKILL.md COMPLETION — Team Cleanup

**As a** orchestrator, **I want** team cleanup to handle native teams, **so that** resources are released properly.

**Acceptance Criteria:**
- GIVEN native teams path WHEN all work is done THEN SKILL.md calls `TeamDelete("athena-<slug>")`
- GIVEN Codex workers WHEN cleanup THEN `shutdownTeam()` from worker-spawn.mjs is called (unchanged)
- GIVEN mixed mode WHEN cleanup THEN both TeamDelete AND shutdownTeam are called
- GIVEN TeamDelete fails WHEN error THEN log warning but don't block completion

### US-006: Event Log Integration (Manual Emit)

**As a** orchestrator, **I want** native team events recorded in the run event log, **so that** run history is complete.

**Acceptance Criteria:**
- GIVEN SKILL.md calls TeamCreate WHEN it succeeds THEN SKILL.md emits via inline code: `addEvent(runId, { type: 'native_team_created', detail: { teamName } })`
- GIVEN SKILL.md spawns native teammate WHEN Task returns THEN SKILL.md emits `native_teammate_spawned` event
- GIVEN SKILL.md calls TeamDelete WHEN cleanup completes THEN SKILL.md emits `native_team_deleted` event
- GIVEN fallback path WHEN worker-spawn.mjs is used THEN existing event emission applies (no change)

### US-007: Fallback Robustness

**As a** plugin, **I want** guaranteed zero-regression fallback, **so that** users without native teams support see no change.

**Acceptance Criteria:**
- GIVEN `hasNativeTeamTools === false` WHEN Athena runs end-to-end THEN behavior is identical to v0.9.5
- GIVEN `hasNativeTeamTools === true` but TeamCreate fails WHEN LLM detects error THEN full fallback + wisdom entry: "Native teams unavailable at runtime — fell back to adapter chain"
- GIVEN fallback occurs WHEN session resumes (checkpoint recovery) THEN `hasNativeTeamTools` is re-evaluated (not cached from crashed session)

---

## Implementation Plan

### Work Division: Claude + Codex

| Worker | 담당 | 파일 |
|--------|------|------|
| **Claude** | SKILL.md 분기 로직 + 이벤트 통합 | `skills/athena/SKILL.md`, `agents/athena.md` |
| **Codex** | Feature detection + 테스트 | `scripts/lib/preflight.mjs`, `scripts/test/preflight.test.mjs` |
| **Claude** | Codex 결과 교차검증 | preflight 코드 리뷰 |
| **Codex** | Claude SKILL.md 변경 교차검증 | SKILL.md 리뷰 |

### Phase 1: Feature Detection (Codex 담당, Claude 교차검증)

| File | Action | Description |
|------|--------|-------------|
| `scripts/lib/preflight.mjs` | MODIFY | `hasTeamTools` → `hasNativeTeamTools`, env var 감지 |
| `scripts/test/preflight.test.mjs` | MODIFY | 기존 `hasTeamTools` 테스트 업데이트 + 새 감지 테스트 |

### Phase 2: SKILL.md 분기 로직 (Claude 담당, Codex 교차검증)

| File | Action | Description |
|------|--------|-------------|
| `skills/athena/SKILL.md` | MODIFY | Phase 2/3/COMPLETION에 explicit native/fallback 분기 |
| `agents/athena.md` | MODIFY | 네이티브 팀 관련 문서 명확화 |

### Phase 3: 통합 + 교차검증

| Task | Owner |
|------|-------|
| preflight 코드 리뷰 | Claude |
| SKILL.md 변경 리뷰 | Codex |
| 테스트 실행 | 양쪽 |

---

## Risks

| ID | Risk | Severity | Mitigation |
|----|------|----------|------------|
| R1 | Native Teams API 변경 (experimental) | High | SKILL.md 프롬프트만 수정하면 됨 — 코드 변경 최소 |
| R2 | TeamCreate 런타임 실패 | High | SKILL.md에서 감지 → 즉시 fallback |
| R3 | 워크트리 파일 충돌 | Medium | 항상 수동 생성으로 해결 |
| R4 | Codex 워커와 native Claude 워커 간 통신 | Medium | 오케스트레이터가 중개 (현재와 동일) |
| R5 | hasTeamTools 리네임 regression | Low | 모든 참조 일괄 변경 + 테스트 검증 |

## Success Criteria

| Metric | Target |
|--------|--------|
| 기존 테스트 | 전부 통과 (575+ tests) |
| 새 테스트 | preflight detection 5+ tests |
| Fallback 동작 | v0.9.5와 100% 동일 |
| Native 경로 | env var 설정 시 TeamCreate/TaskList 사용 |
| SKILL.md 변경량 | ~50-80 lines (분기 로직) |
