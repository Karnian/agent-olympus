# v0.9.5 Deferred Items Specification

**Status**: Backlog (deferred from v0.9.1, re-versioned from v0.10 to v0.9.5)
**Last Updated**: 2026-04-02

## Overview

These items were identified during the v0.9.1 self-evaluation and external ecosystem research but deferred for separate implementation due to their scope and complexity. D1 was redefined in v0.9.3 after Codex cross-validation (207K tokens) revealed the core problem was not transport replacement but bidirectional communication capability. D3 was implemented in v0.9.2 as part of G#1 (Event-Backed Run System).

---

## D1: Codex를 진짜 팀원으로 — 🔄 Redefined (was: codex-plugin-cc Integration)

**Priority**: Should-have (Phase 0-1 즉시 가능)
**Effort**: Medium (Phase 0-1), High (Phase 2-3)
**Source**: OpenAI codex-plugin-cc (Apache 2.0, 2026-03-30) + Codex 교차검증 (207K tokens, 2026-04-02)
**Tracks**: Improvement Tracker G#5

### Problem Discovery

Codex 교차검증 + Advocate/Critic 독립 분석을 통해 근본 문제 발견:

1. **Codex 워커는 one-shot 실행** — `codex exec`는 fire-and-forget. 실행 중 inbox 읽기, 메시지 수신 불가
2. **양방향 통신 미구현** — Athena SKILL.md에 "Claude → Codex inbox 쓰기" 명시되어 있으나, Codex가 실제로 읽는 코드 없음
3. **원래 정의의 한계** — "app-server JSON-RPC로 트랜스포트 교체"는 문제의 본질(통신 역량 부재)을 놓침

### Redefined Goal

"Codex를 진짜 팀원으로 만들기" — 트랜스포트 교체가 아닌 통신 역량 구현.

### Phase 0: 즉시 실행 가능 (코드 변경 최소)

**의존성**: 없음

1. **문서 정정**: Athena SKILL.md에서 허위 양방향 통신 문서 정리. Codex를 "배치 실행자"로 명확화
2. **Adversarial review prompt 차용**: codex-plugin-cc의 `<attack_surface>`, `<finding_bar>`, `<calibration_rules>`, `<grounding_rules>` 구조를 `agents/code-reviewer.md`에 적용
3. **`codex exec review` 활용**: 기존 xval 세션을 `codex exec review --uncommitted` 서브커맨드로 개선

#### Reference: codex-plugin-cc Adversarial Review Structure

```markdown
<attack_surface>
  - Logic errors, off-by-one, race conditions
  - Security: injection, auth bypass, path traversal
  - API contract violations
</attack_surface>

<finding_bar>
  BLOCK: correctness/security issues that will cause bugs in production
  ALLOW: style preferences, minor optimizations, theoretical concerns
</finding_bar>

<calibration_rules>
  - Only flag issues you can point to specific code for
  - Err on the side of ALLOW for ambiguous cases
</calibration_rules>

<grounding_rules>
  - Quote the exact line(s) of code for each finding
  - Explain the concrete failure scenario
</grounding_rules>
```

### Phase 1: `codex exec --json` + 태스크 체이닝 (tmux 분리)

**의존성**: 없음 (`codex exec --json`은 codex-cli 0.116.0에서 이미 지원)

1. **`scripts/lib/codex-exec.mjs` 신규 생성**:
   - `child_process.spawn("codex", ["exec", "--json", "-"])` + stdin 프롬프트
   - JSONL 이벤트 파싱: `thread.started`, `turn.completed`, `turn.failed`, `item.*`, `error`
   - 구조화된 완료/에러 감지 → `detectCodexError()` regex 6개 대체
   - 기존 에러 분류 보존: `auth_failed`, `rate_limited`, `not_installed`, `network`, `crash`

2. **`worker-spawn.mjs` 어댑터**:
   - Codex 워커를 tmux 의존에서 분리 → `spawnCodexDirect()` 추가
   - `preflight.mjs`에 `hasCodexExecJson` 탐지 추가
   - Claude/Gemini은 tmux 유지

3. **태스크 체이닝 (의사-양방향)**:
   ```
   exec #1: "API 스키마 설계해줘" → 결과 A
   오케스트레이터: 결과 A + Claude 워커 피드백 합침
   exec #2: "이 피드백 반영해서 수정해줘: {피드백}" → 결과 B
   ```
   오케스트레이터가 중개하는 연속 호출로 간접 대화 구현

4. **병렬 실행 (tmux 없이)**:
   ```javascript
   // Node.js event loop이 여러 child process를 자연스럽게 병렬 관리
   const codex1 = spawn('codex', ['exec', '--json', '-'], { cwd: worktree1 });
   const codex2 = spawn('codex', ['exec', '--json', '-'], { cwd: worktree2 });
   ```

#### Key Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `scripts/lib/codex-exec.mjs` | **NEW** | Direct Codex execution via child_process (~200 lines) |
| `scripts/lib/worker-spawn.mjs` | MODIFY | Add `spawnCodexDirect()` adapter, branch on capability (~80 lines) |
| `scripts/lib/preflight.mjs` | MODIFY | Add `hasCodexExecJson` detection (~10 lines) |
| `scripts/test/codex-exec.test.mjs` | **NEW** | Unit tests with mocked child_process (~150 lines) |
| `scripts/test/worker-spawn.test.mjs` | MODIFY | Add direct-exec adapter tests (~40 lines) |
| `skills/athena/SKILL.md` | MODIFY | Update Codex communication docs (~20 lines) |
| `skills/atlas/SKILL.md` | MODIFY | Update Codex invocation docs (~20 lines) |

### Phase 2: `codex app-server` multi-turn (진짜 양방향)

**의존성**: `codex app-server` 안정화 (codex-cli 0.116.0 기준 `[experimental]`)

1. **`scripts/lib/codex-appserver.mjs` 신규 생성**:
   - JSON-RPC client over stdio
   - Thread 기반 multi-turn 대화: `initialize` → `createThread` → `submitTurn` → events
   - mid-execution steer/interrupt, 후속 turn 추가 가능
   - Orchestrator당 1 app-server 인스턴스 (글로벌 broker 아님)

2. **진짜 양방향 통신**:
   ```
   Athena → thread 생성
   Athena → turn 1: "API 스키마 설계해줘"
   Codex  ← turn 1 결과
   Athena → turn 2: "Claude가 이렇게 피드백함. 반영해"
   Codex  ← turn 2 결과
   Athena → steer: "방향 전환"
   ```

3. **Codex 버전 피닝**: 테스트된 Codex 버전을 `.ao/autonomy.json`에 기록

#### codex-plugin-cc Reference Files

| File | Pattern | Relevance |
|------|---------|-----------|
| `plugins/codex/scripts/lib/codex.mjs` | App Server client, turn capture | Phase 2 client 구현 참고 |
| `plugins/codex/scripts/lib/app-server.mjs` | JSON-RPC transport | Phase 2 transport 구현 참고 |
| `plugins/codex/scripts/lib/state.mjs` | Job lifecycle management | Phase 2 상태 관리 참고 |
| `plugins/codex/prompts/adversarial-review.md` | Adversarial review template | Phase 0에서 즉시 차용 |

### Phase 3: 네이티브 팀 통합 (G#4 합류)

**의존성**: D2 (Native Agent Teams) 해소 시

- G#4 Native Agent Teams와 합류
- Codex를 first-class 팀원으로 — Native Teams에서 양방향 메시지 채널
- app-server thread를 Native Team의 `SendMessage` 채널로 브릿지

### Dropped Plans

- ~~**Broker Pattern**~~ → DROP. one-shot `codex exec` 패턴에 공유 런타임 불필요. Codex 교차검증 AGREE
- ~~**Stop Hook Review Gate (900s BLOCK)**~~ → DEFER Phase 2+. 현재 `stop-hook.mjs`의 비차단 WIP 자동커밋(`"Never blocks session termination"`)과 설계 충돌. Codex 교차검증에서 발견

### Codex Cross-Validation Results (207K tokens, 2026-04-02)

| # | Claude 판단 | Codex 판정 | 근거 |
|---|------------|-----------|------|
| 1 | Broker 불필요 | **AGREE** | one-shot에 공유 런타임 불필요 |
| 2 | 폴링 trivial | **DISAGREE** | CPU는 trivial이지만 UX 지연 5-7.5초 평균은 의미 있음 |
| 3 | 셸 인젝션 방어 충분 | **MODIFY** | decent하지만 `codex exec` stdin 지원으로 단순화 가능 |
| 4 | Phase 1에서 Broker skip | **MODIFY** | 외부 broker skip, in-process 클라이언트 매니저는 필요할 수 있음 |
| 5 | 3-Phase 시퀀싱 | **MODIFY** | Phase 1은 app-server가 아니라 `codex exec --json`이어야 함 |
| 6 | 놓친 사항 | **AGREE** | `exec --json`, Stop hook 충돌, 공식 문서의 자동화 vs 리치 클라이언트 구분 |

**Codex 참고**: OpenAI 공식 문서는 app-server를 rich client 통합(VS Code 등)용으로, 자동화/CI는 SDK 사용 권장. AO는 자동화에 더 가까움.

---

## D2: Native Agent Teams Migration — 🔒 Blocked

**Priority**: Must-evaluate (High when unblocked)
**Effort**: High
**Source**: Claude Code v2.1.32+ (experimental)
**Tracks**: Improvement Tracker G#4

### Background

Claude Code now has built-in Agent Teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`) that closely mirror Athena's architecture:

| Capability | Athena (ours) | Native Agent Teams |
|-----------|--------------|-------------------|
| Worker spawning | Manual via skill prompt | `TeamCreate` tool |
| Communication | `.ao/teams/` inbox/outbox | `SendMessage` + shared mailbox |
| Task tracking | Custom task files | Built-in task list with dependencies |
| Worktree isolation | Manual `.ao/worktrees/` | Built-in git worktree per teammate |
| File locking | None | Built-in for task claiming |
| Codex integration | tmux-based (→ D1 Phase 1+) | Not built-in |

### Evaluation Questions

1. Can Athena become a thin wrapper around native teams, adding Codex integration and agent personas as value-add?
2. What native team features would we lose by not migrating (dependency resolution, file locking)?
3. How do native teams interact with our hook system (SubagentStart/Stop)?
4. What happens when `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is not set?

### Relevant Hook Events

- `TaskCreated` / `TaskCompleted` — native task lifecycle
- `TeammateIdle` — worker idle detection
- `WorktreeCreate` / `WorktreeRemove` — worktree lifecycle

### Migration Strategy

1. Feature-flag approach: detect native teams availability
2. If available: use native primitives for coordination, inject our agent personas
3. If unavailable: fall back to current Athena implementation
4. Codex integration via D1 Phase 1+ (child_process, not tmux) as unique value-add

### Dependency

- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` leaving experimental status

---

## D3: Event-Sourced Orchestration State — ✅ Implemented (v0.9.2)

**Priority**: ~~Should-have~~ Done
**Effort**: ~~Medium~~ Completed
**Tracks**: Improvement Tracker G#1

Implemented as part of v0.9.2 Event-Backed Run System:
- `scripts/lib/run-artifacts.mjs` — `createRun()`, `addEvent()`, `replayEvents()`, `finalizeRun()`
- `scripts/lib/checkpoint.mjs` — phase transition events, checkpoint save/clear events
- `scripts/subagent-stop.mjs` — `subagent_completed` events via `discoverActiveRun()`
- Append-only event log (`events.jsonl`) per run with full replay capability
- See [event-backed-runs/spec.md](../event-backed-runs/spec.md) for implementation details

---

## Dependencies

- D1 Phase 0-1: None (즉시 착수 가능)
- D1 Phase 2: Codex CLI app-server stability (`[experimental]` 졸업)
- D1 Phase 3: D2 (Native Agent Teams) 해소
- D2: Native Agent Teams leaving experimental status
- ~~D3~~: Implemented

## Success Criteria

- [x] D3: All orchestration state changes are captured in event log (v0.9.2)
- [ ] D1 Phase 0: Codex 역할 문서 정정 + adversarial review prompt 적용
- [ ] D1 Phase 1: `codex exec --json` 직접 실행 + tmux 분리 + 태스크 체이닝
- [ ] D1 Phase 2: app-server multi-turn으로 진짜 양방향 통신
- [ ] D2: Athena runs on native teams when available, falls back gracefully
