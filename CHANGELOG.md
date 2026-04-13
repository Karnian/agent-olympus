# Changelog

## [1.0.9] - 2026-04-14

### Fix — Remove invalid `agents` field from plugin.json

Plugin failed to load on Claude Code 2.1.92+ due to manifest validation error.

**Root cause:**
- `plugin.json` contained `"agents": "./agents/"` (directory path)
- Claude Code's Zod schema (`W91 = kn().endsWith(".md")`) only accepts `.md` file paths, not directory paths
- This caused `agents: Invalid input` validation error, preventing the entire plugin from loading (skills, agents, hooks all unavailable)

**Fix:**
- Removed `agents` field from `plugin.json`
- Claude Code auto-discovers `agents/` directory when the field is absent (confirmed via CLI source analysis)
- Verified with `claude plugin validate` — passes cleanly
- Cross-validated with Codex (GPT-5.4): confirmed fix is correct and auto-discovery risk is low

**Note:** Claude Code public docs still show directory-style `agents` examples, but the actual CLI schema rejects them. The docs appear stale relative to v2.1.92.

## [1.0.6] - 2026-04-10

### Chore — Documentation sync + git cleanup

Full codebase-documentation consistency audit with Codex cross-review.

**Documentation sync (CLAUDE.md, AGENTS.md, docs/plans/README.md):**
- Add `ask` agent to agent listings (18 → 19)
- Add 14 missing skills to AGENTS.md, 8 to CLAUDE.md (26/26 → 34/34)
- Add 17 missing scripts/lib entries to CLAUDE.md project structure
- Document IntentGate and ModelRouter hooks in CLAUDE.md
- Add 5 missing hooks to AGENTS.md hooks table (SubagentStart/Stop, Notification, SessionEnd, PlanExecuteGate)
- Fix concurrency defaults in CLAUDE.md: (5/3/2/2) → (10/8/5/5)
- Update test counts: 1000+/50 → 1500+/69 (all references)
- Fix broken v0.10-deferred → v0.9.5-deferred link in plans index
- Add 4 missing plan entries (gemini-adapter, native-agent-teams, ask-adapter-migration, ask-job-based)

**Codex review fixes:**
- Fix Athena description from tmux to adapter system
- Split SubagentStop hooks table into subagent-stop + concurrency-release
- Fix `.ao/teams/` description from "Codex workers" to generic team workers
- Fix v1.0.2 story count 10 → 9 (US-010 deferred)

**Git cleanup:**
- Remove 4 stale worktrees + 5 local branches + 13 remote branches

## [1.0.5] - 2026-04-10

### Feature — `/ask` job-based async path (async/status/collect/cancel/list)

`scripts/ask.mjs`를 **단일 entry point 2-mode** 구조로 리팩터. 기존 sync 경로 (`echo ... | node scripts/ask.mjs codex`) 는 byte-identical 보존, 그 위에 detached fire-and-forget job 시스템 추가. Codex 교차검증 4 라운드 (REWORK → APPROVE-WITH-FIXES × 2 → APPROVE) + step 구현 교차검증 2 라운드. 총 8 건 blocker + 5 건 medium 흡수.

**Problem**
- Sync 경로의 `COLLECT_TIMEOUT_MS = 120_000`이 2-5분 걸리는 Codex review를 SIGKILL하고 출력을 폐기. 지난 세션에서 사용자가 매번 `tmux new-session` 우회로 대응 → shell-quoting 사고, 백그라운드 프로세스 알림 폭탄, `tmux capture-pane -S -500` 트렁케이션 발생. 이번 PR 목적: **그 tmux 우회를 폐기**.

**Subcommand surface**
- `echo "..." | node scripts/ask.mjs async <model>` — detach runner, stdout에 `{jobId, artifactPath, runnerPid}` JSON 한 줄 반환 후 즉시 exit.
- `node scripts/ask.mjs status <jobId>` — 메타 + liveness 재판정 (pure read). runnerPid + adapterPid 중 하나라도 alive면 `running`, 둘 다 dead면 `runner_done` sentinel을 권위로 `completed|failed|cancelled` 보정.
- `node scripts/ask.mjs collect <jobId> [--wait] [--timeout Ns]` — `.md` artifact 출력. `--wait` 없으면 running시 exit 75, `--wait`면 500ms poll (기본 600s cap). Completed + `.md` 누락 케이스는 sentinel `text` field에서 fallback 복원 (adapter-agnostic).
- `node scripts/ask.mjs cancel <jobId>` — SIGTERM → 5s grace → SIGKILL. Runner preferred, runner dead + adapter alive면 adapter 직접 시그널. Idempotent (reconcile 후 terminal이면 exit 0).
- `node scripts/ask.mjs list [--status X] [--older-than N]` — `.ao/state/ask-jobs/*.json` enumerate, sorted by startedAt desc.
- `node scripts/ask.mjs _run-job <jobId>` — internal detached runner entry point (외부 노출 X).

**Critical correctness design**
- **Single-writer rule**: `.ao/state/ask-jobs/<jobId>.json`을 쓰는 프로세스는 오직 detach된 `_run-job` runner 1개. Cancel/status/collect/list는 read-only. Race 원천 차단.
- **`runner_done` sentinel**: Runner가 finalize 직전 `{schemaVersion:1, type:"runner_done", status, text:handle._output, ...}`를 JSONL에 `appendFileSync` (동기, WriteStream 버퍼 bypass). Rev 3에서 `jsonlStream.end() + process.exit(0)`가 플러시를 보장 못한다는 Codex 지적 반영. Sentinel이 metadata 플립 실패를 견디는 authoritative 오라클.
- **Completion detection adapter-agnostic**: Rev 1은 codex-exec의 `turn.completed`를 오라클로 썼으나 gemini-exec은 stdout에 그 이벤트를 안 냄 (Codex rev-2 blocker). Runner sentinel로 전환해 양쪽 커버.
- **Dual-liveness reconciliation**: `reconcileStatus`가 runner OR adapter 중 하나라도 alive면 `running` 유지 (Codex step-1 review 지적: runner 크래시 + adapter 고아 상황을 잘못 `failed/crashed`로 보고 + cancel 단락).
- **24h collect timeout**: Runner는 `adapter.collect(handle, 86_400_000)`를 명시 전달. 기본값 30s를 생략하면 원래 120s 문제가 고스란히 재현됨 (Codex rev-1 blocker 2).
- **Dispatch-level auto fallback**: `async auto`에서 codex가 demoted (host suggest tier)면 runner spawn 전에 dispatcher가 `gemini-exec` 재선택. v1.0.3 sync 경로의 `ask.mjs:307-318` 계약 보존 (Codex rev-2 blocker 1).
- **Debounced metadata flush**: Runner tee listener가 매 chunk마다 `lastActivityAt` bump, 5초 floor나 상태 변화 시점에만 atomic tmp+rename. `status` 쿼리 freshness 5초 보장 + 디스크 트래픽 방지. Codex step-1 review 지적 흡수.
- **Launch ordering race fix**: 부모가 spawn 직후 동기 metadata write → `runner.unref()` → exit. Runner step 1에서 metadata 미존재시 2초 retry loop (50ms × 40) 방어. Codex rev-1 blocker 1.
- **mkdir 호이스트**: `_run-job` step 3에서 `mkdirSync`를 모든 branch 앞으로 이동. Demoted 조기 종료 경로도 sentinel 대상 dir이 존재해야 함 (Codex rev-3 small finding).

**Files**
- `scripts/lib/ask-jobs.mjs` NEW (~550 LOC) — pure helpers: `allocateJobId`, `computePromptHash`, `writeMetadata`/`readMetadata` (atomic tmp+rename, schemaVersion:1 forward-compat), `writePromptFile`/`readAndUnlinkPromptFile`, `writeRunnerSentinel` (appendFileSync 동기), `jsonlFindRunnerSentinel`, `isProcessAlive` (injectable map), `reconcileStatus`, `maybeFlushMetadata`, `parseAskArgs` (pure dispatcher), `listJobs`, `synthesizeMdFromSentinel`. Test seams: `_injectClock`/`_injectLiveness`/`_injectRandom`.
- `scripts/ask.mjs` REWRITE (339 → 837 LOC, sync path byte-identical) — dispatcher, `runSyncPath` (legacy preserved), `runAsyncLaunch`, `runJob` (detached runner), `runStatus`, `runCollect`, `runCancel`, `runList`. Test seams: `_inject({runJobSpawner, adapter, buildSpawnOpts, clock, liveness, pollInterval, exitFn, stdoutWrite, stderrWrite, stdinReader, capabilities, killFn})`. `liveness` injection이 `askJobs._injectLiveness`로 proxy (Codex step-3 review 지적: pid 맵을 `killImpl` positional arg로 잘못 전달해 silently false 반환하던 버그).
- `scripts/test/ask-jobs-unit.test.mjs` NEW (50 tests).
- `scripts/test/ask-async-integration.test.mjs` NEW (31 tests) — fake adapter + fake clock + fake liveness + fake runner spawner로 full lifecycle. `stdinReader`/`capabilities` 주입으로 `process.stdin` / `detectCapabilities` 부수효과 차단. 포함: 해피 패스 (codex+gemini), demoted, dispatch-level auto fallback, status 재판정 (sentinel completed/failed/cancelled), collect `.md` + sentinel fallback + mid-poll completion + timeout 75, cancel idempotent + adapter fallback + SIGKILL escalation, maybeFlush wiring, list 필터, dispatcher, AC-6 grep (tmux 부재).

**Docs**
- `skills/ask/SKILL.md` — `## Async usage` 섹션 신규. 기존 sync recipe 보존. description 업데이트.
- `CLAUDE.md` State Management — `.ao/state/ask-jobs/`, `.ao/artifacts/ask/<jobId>.{jsonl,md}` entry 추가. Single-writer rule 명시. 24h SessionEnd sweep opt-in.
- `docs/plans/ask-job-based/spec.md` — rev 4 APPROVED, 4 라운드 cross-review trail.

**Backward compat**
- 순수 additive. Sync 경로 byte-identical. Atlas/Athena/외부 호출자 영향 0. 기존 28 ask.test.mjs tests unchanged green. Baseline 1506 → 1587 tests (+81, 목표 1530 초과).
- Rollback: revert 시 `.ao/state/ask-jobs/` 고아 파일은 SessionEnd 24h sweep에 처리. 인-플라이트 runner는 detach 상태로 계속 달리다 자연 종료.
## [1.0.4] - 2026-04-09

### Fix — Athena/Atlas codex workers broken on codex-cli 0.118

Codex 0.118에서 `codex app-server --session-source` CLI 플래그가 제거됨. Olympus의 `codex-appserver` 어댑터가 여전히 이 플래그를 argv에 추가하고 있어, Athena/Atlas가 `codex-appserver` 경로(우선순위 1)로 codex 워커를 띄우려 할 때마다 codex 프로세스가 `error: unexpected argument '--session-source' found`로 즉시 종료. 권한 상향으로는 해결 불가한 argv 파서 단계 실패.

**Fix (Option D — 관측성 유지)**
- `scripts/lib/codex-appserver.mjs` `startServer()`: `opts.sessionSource` 분기 + `--session-source` argv 삽입 제거.
- `createThread()`: 신규 `opts.serviceName` 옵션 — `thread/start` RPC params에 `serviceName` 필드로 전달. Codex 0.118 `ThreadStartParams` v2 스키마에 정식으로 존재하는 필드 (`codex app-server generate-json-schema` 덤프로 검증).
- `scripts/lib/worker-spawn.mjs:463-479`: `startServer({ sessionSource })` → `startServer({ cwd })`, 태그는 `createThread({ serviceName: 'agent-olympus:${teamName}' })`로 이동.

**Verification**
- 라이브 E2E (실제 codex 0.118.0 바이너리 대상): `startServer → initializeServer → createThread(level:'full-auto', serviceName:'agent-olympus:demo-team') → executeTurn` 전 구간 성공, 모델 응답 수신, stderr clean.
- Unit tests 108/108 통과 (`codex-appserver.test.mjs` + `worker-spawn.test.mjs`).
- Codex 교차 검증: `--session-source`는 0.118에서 user-settable flag로 제거 확정. `-c` config 키 대체 없음. 0.118 권장 경로는 `thread/start` RPC params의 `serviceName` 필드 + conversation id 상관 분석 + `[otel].environment` 환경 그룹핑.

**Impact**
- codex-cli ≥ 0.118 사용자: Athena/Atlas + codex 워커 조합이 복구됨. `/ask codex`는 `codex-exec` 어댑터를 사용하므로 영향 없었음 (이 PR로도 동작 동일).
- codex-cli 0.116-0.117 사용자: `serviceName`은 해당 버전 `thread/start` 스키마에도 이미 존재하는 optional 필드 → 무해.

## [1.0.3] - 2026-04-09

### Feature — Codex permission mirroring hardening + host sandbox intersection

코덱스 권한 미러링을 approval axis에서 **sandbox axis**로 전환하고, `permissions.allow` 기반 검출에 **host sandbox 감지**를 교집합으로 적용. Codex 0.118+ 호환성 확보와 source-of-truth gap 동시 해소. Codex 교차검증 6 라운드에서 발견된 모든 지적 흡수 (총 15건).

**Codex sandbox-axis mirroring (#46)**
- 미러링 축을 approval → sandbox로 전환. 이유: Codex 0.118에서 `--auto-edit` 플래그 삭제됨, docs 명시 *"never for non-interactive runs"*. exec/appserver 모두 비대화형이라 approval은 `never` 고정, sandbox만 host trust로 변동.
- 매핑: `Bash(*)+Write(*) → -a never -s danger-full-access` / `Write(*) or Edit(*) → -a never -s workspace-write` / 그 외 → codex 워커 demote (`codex→claude`)
- `-a/-s`는 Codex 0.118+ 에서 **global flag**이며 `exec` subcommand 앞에 와야 함 (`codex exec -a never`는 `error: unexpected argument '-a'`). `scripts/lib/codex-approval.mjs` `buildCodexExecArgs` / `buildCodexAppServerParams` / `codexSandboxForLevel` / `shouldDemoteCodexWorker` / `demoteCodexWorkersIfNeeded` 신규 helper.
- `codex-appserver.mjs` server request 자동 응답을 `result:{}`에서 **JSON-RPC error `-32000`** 로 교체. 이유: Codex 0.118 schema에서 9개 ServerRequest 메서드 모두 response에 필수 필드 (`decision`/`action`/`answers`/`permissions`/`accessToken`/...)가 있어 빈 객체는 전부 schema 위반.
- suggest-tier 호스트에서 codex 워커 demote 시 **`model` 필드 strip** (Codex 모델명이 `claude-cli --model`에 누수되는 회귀 차단). `_demotedFrom` / `_demotionReason` / `_demotedModel` 필드 보존.
- `/ask` skill: demote 시 exit 2 (no artifact — 헤더 contract 보존). `/ask auto` + suggest host는 `gemini-exec`로 transparent fallback.
- Backward compat: `spawn()` / `createThread()` 모두 `opts.level` 미지정시 legacy 동작 유지. `VALID_LEVELS` strict check로 `'auto'`/typo의 silent downgrade 차단 (exec + appserver 양쪽 동일).

**Host sandbox detection + intersection (#47)**
- v1.0.2 spec §4.3 Open Question 해소. `permissions.allow`는 "도구 호출 가능 여부"지 "host shell 실제 sandbox 경계"가 아님 → 별도 passive detection 추가 후 교집합.
- `scripts/lib/host-sandbox-detect.mjs` 신규: detection 우선순위 **env `AO_HOST_SANDBOX_LEVEL` > autonomy `codex.hostSandbox` > Linux LSM enforce (AppArmor/SELinux/Landlock) > unknown**. Container (`/.dockerenv`, cgroup), seccomp, macOS `OPERON_SANDBOXED_NETWORK`, WSL은 `signals` 필드로만 기록 — 모호한 신호는 tier를 강제 downgrade하지 않음.
- 신규 `effectiveCodexLevel(permLevel, hostSandbox)` = `min(permTier, hostTier)`. `unknown` host tier는 3(unrestricted)로 매핑하여 silent downgrade 방지.
- **Breaking contract change (의도된)**: explicit `codex.approval`도 host sandbox로 intersect됨. 이전에는 `codex.approval=full-auto`가 무조건 full-auto였으나, read-only 호스트에서 codex가 실패하는 동작을 만듦. 이제 `codex.approval`은 **ceiling permLevel**이고 host sandbox는 ground truth. 호스트 검출을 override하려면 `codex.hostSandbox` / `AO_HOST_SANDBOX_LEVEL`도 함께 설정.
- `worker-spawn.mjs` `spawnTeam`에서 host sandbox가 `unknown`이고 filesystem-scoped signals (`containerized`/`seccompActive`/`noNewPrivs`)가 있으면 **wisdom 1회 경고** 기록. Jaccard dedup이 spam 차단. `networkRestricted`는 warning trigger에서 제외 (`AO_HOST_SANDBOX_LEVEL`은 fs tier용이라 network-only 신호로 권유하면 misleading).
- `autonomy.mjs` validator에 `codex.hostSandbox ∈ {auto, unrestricted, workspace-write, read-only}` 추가 (default `'auto'`).
- `scripts/diagnose-sandbox.mjs` 신규 진단 CLI. `effectiveCodexLevel`을 `resolveCodexApproval`에서 직접 가져와 runtime과 report drift 방지 (`node scripts/diagnose-sandbox.mjs`).

**spawnTeam E2E integration tests (#48)**
- `spawnTeam()`에 `_inject` 파라미터 추가 (test-only dependency injection). `_inject.adapters` / `_inject.createTeamSession` / `_inject.validateTmux` 주입 가능. Production 호출자는 4 인자로 기존 path 유지.
- `scripts/test/worker-spawn-integration.test.mjs` 신규, 14 E2E 테스트: level 전달 매트릭스 (full-auto/auto-edit), demotion E2E + model field strip, mixed team (codex+claude+gemini), `AO_HOST_SANDBOX_LEVEL=read-only` host intersection, `autonomy.codex.approval` ceiling, tmux fallback path, `validateTmux()=false` 에러, appserver init/createThread 실패 cleanup, codex-exec spawn throw.
- Fake adapter shapes가 production 불변식 (`_initialized`, `threadId`, `_sessionId`) 강제 — Codex가 지적한 drift 방지.
- Test isolation: `process.chdir()` + tmp HOME + 격리된 `AO_HOST_SANDBOX_LEVEL` → `wisdom.jsonl`/state가 repo 오염 불가.

**tmux removal X1: createTeamWorktrees helper (#49)**
- tmux 완전 제거 multi-PR 시퀀스의 첫 단계. **순수 additive** — observable behavior 변화 0.
- `scripts/lib/worktree.mjs`에 `createTeamWorktrees(teamName, workers, cwd)` batch helper 신규 export. `worktreeCreated`는 1급 필드 (Codex가 지적한 "create:false 계약 보존" 함정).
- `tmux-session.mjs` diff는 **comment-only** — 왜 `createTeamSession`이 새 helper를 사용하지 않는지 설명 (인터리빙 순서 보존, strict behavior-preserving).
- 5개 새 테스트 (batch shape, empty, fallback `worktreeCreated:false`, partial batch, sanitization pass-through).
- Follow-up: PR X2 (per-worker `executionCwd` in `worker-spawn`) / PR X2.5 (`_liveHandle` durable state) / PR X3 (tmux fallback 제거) 는 별도 plan으로 추적.

### Fix — 6-round Codex peer review 흡수
- **Plan v1 폐기**: stderr silent, legacy bypass 영구화, appserver 비결정성 (Codex가 `codex-exec` 단독 범위를 반대하여 A+B 합본으로 재설계)
- **Plan v2 → v3**: CLI flag global 위치 검증, schema-invalid `result:{}`, read-only silent completion, source-of-truth 한계 (후속 plan으로 분리)
- **Step 2**: 기본 `level='suggest'`가 미이관 호출자에서 회귀 → `opts.level` 명시될 때만 새 path. 에러 코드 `-32601`(method not found)은 의미 오용 → `-32000`(server-defined)로 교정
- **Step 3**: `opts.level='auto'`/typo의 silent downgrade → `VALID_SPAWN_LEVELS` strict check
- **Step 4**: demoted `worker.model` 누수 → strip + `_demotedModel` 보존
- **Step 5**: exit-2 artifact 계약 깨짐 → demoted 시 artifact 안 씀. test HOME isolation
- **Final**: explicit `codex.approval`이 host detection 우회 (blocker) → ceiling 패턴으로 intersection 항상 적용. `diagnose-sandbox` 필드가 runtime과 drift → single source
- **#47 final**: appserver invalid level도 strict check 추가 (exec와 동일화). `/ask auto` gemini fallback. SKILL.md stale 문구 정정
- **#48 final**: HOME isolation 불충분 → `process.chdir()`. fake adapter shapes가 `_initialized`/`threadId`/`_sessionId` 계약 미강제 → mirror
- **#49 final**: draft 1이 NOT behavior-preserving (인터리빙 순서 변화) → `createTeamSession` 수정 롤백, 순수 additive

### Test
- 1394 → **1506** (+112 신규 테스트)
- `scripts/test/codex-approval.test.mjs`: +46 (sandbox-axis helper matrix + host intersection + warning)
- `scripts/test/host-sandbox-detect.test.mjs`: **신규** 50 hermetic tests
- `scripts/test/codex-exec.test.mjs`: +10 (_buildSpawnArgs invariant + invalid level)
- `scripts/test/codex-appserver.test.mjs`: +11 (createThread sandbox matrix + server request error response)
- `scripts/test/worker-spawn.test.mjs`: +8 (demoteCodexWorkersIfNeeded matrix + model strip)
- `scripts/test/worker-spawn-integration.test.mjs`: **신규** 14 E2E
- `scripts/test/ask.test.mjs`: +6 (codex level + autonomy override + demotion + HOME isolation)
- `scripts/test/autonomy.test.mjs`: +9 (codex.hostSandbox validator)
- `scripts/test/worktree.test.mjs`: +5 (createTeamWorktrees batch)

### Docs
- `CLAUDE.md` Permission Mirroring 섹션: Codex sandbox-axis 전면 교체, host intersection 설명, known limitation 정정
- `skills/ask/SKILL.md`: 새 demotion/fallback 동작 반영
- `scripts/diagnose-sandbox.mjs` 언급 추가
- `AO_HOST_SANDBOX_LEVEL` 환경변수 문서화

### Out of Scope (이후 릴리즈)
- **PR X2**: per-worker `executionCwd` 공통화로 모든 non-tmux adapter에 worktree isolation 확장 (Athena 계약 보존)
- **PR X2.5**: `_liveHandle` durable state / crash recovery — `monitorTeam`/`collectResults`/`shutdownTeam`이 disk state에서 재구성 가능해야 X3 가능
- **PR X3**: `selectAdapter` tmux fallback 제거, `tmux-session.mjs` 삭제
- `claude-cli` / `gemini`에 host sandbox intersection 적용
- Active host-sandbox probing 자동화
- `permissions.allow`의 cwd-relative registry → project-root 공유 모델 리팩터

## [1.0.2] - 2026-04-08

### Feature — impeccable + gstack Adoption (Foundation + Group A/B/C1/C2/D)

[pbakaus/impeccable](https://github.com/pbakaus/impeccable) (Apache 2.0) 와 [garrytan/gstack](https://github.com/garrytan/gstack) (MIT) 에서 아이디어를 가져와 디자인 품질 도구와 오케스트레이션 효율성 도구를 통합. 9개 user story 구현 + Codex 교차검증 BLOCK 이슈 전부 해결.

**Foundation**
- **F-001**: SubagentStart hook 싱글패스 로더 — 2.5s 월클럭 하드캡, sync-by-default, 개별 로더 fail-safe, `schemaVersion:1` 레이턴시 로그 파일 (`.ao/state/ao-subagent-latency.log`). 이전에는 `logLatency()`가 `process.exit(0)` 전에 fire-and-forget으로 호출되어 파일이 아예 생성되지 않던 dead-code 버그 수정.
- **F-002**: `.ao/memory/` 네임스페이스 — worktree간 공유 (git common-dir 해석), SessionEnd 24h cleanup에서 exempt, forward-schema 거부 시 stderr 명확한 경고, `memoryFilePath()` path traversal 하드닝 (`../`, 절대 경로, `\\` 거부).

**Group A — 안티패턴 + 모듈화 참조 팩 (impeccable)**
- **US-001**: `ui-smell-scan.mjs` + finish-branch 게이트 (warn 기본, block opt-in, run artifact 발행). `config/design-blacklist.jsonc.example`.
- **US-002**: `ui-reference.mjs` `selectModules()` + 7개 도메인별 참조 모듈 (color-and-contrast, typography, spatial-design, motion-design, interaction-design, responsive-design, ux-writing).

**Group B — 디자인 아이덴티티 + 정밀 마이크로 스킬 (impeccable)**
- **US-003**: `/teach-design` 아이덴티티 브리핑 + subagent-start 자동 주입. 하드 2KB 캡 (우선순위 기반 필드 drop — 비제한 spacing 배열이 캡을 초과하던 Codex 블로커 수정).
- **US-004**: `/normalize`, `/polish`, `/typeset`, `/arrange` 정밀 마이크로 스킬 (`requiresTDD:true`, `micro-skill-scope.mjs` 스코프 체커).

**Group C1 — 리뷰 라우터 + 취향 메모리 (gstack)**
- **US-005**: 정규식 기반 리뷰 라우터 (`review-router.mjs` + `config/review-routing.jsonc`). CSS-only 변경은 `{aphrodite, designer}`로 최소 라우팅 (code-reviewer 제외). `alwaysInclude:["*"]` rollback 경로로 전체 폴백 세트 강제. Atlas/Athena는 `origin/$BASE...HEAD` 전체 브랜치 diff 사용 (이전 `HEAD~1`은 multi-commit 브랜치에서 오작동).
- **US-009**: `.ao/memory/taste.jsonl` 취향 메모리. `pruneTaste()`는 빈 selector 거부 (실수 nuke 방지).

**Group C2 — 순차 프론트엔드 교정 체인 (impeccable)**
- **US-008**: `/ui-remediate` audit → normalize → polish → re-audit 체인. harden 스테이지 없음. 실패 시 halt, 구조화된 outbox 전달만 (full conversation history 없음), re-audit convergence gate (smell count 증가 시 ABORT, 감소 시 성공). `ui-remediation.json` 아티팩트 (`schemaVersion:1`). finish-branch Step 2.7 연동.

**Group D — 브라우저 핸드오프 + 아카이벌 파이프 (gstack)**
- **US-006**: 브라우저 일시정지 + 수동 재개 프로토콜. `.ao/state/browser-handoff.json` (`schemaVersion:1`, 24h TTL). URL sanitize (access_token/id_token/code/state/sig/secret/key/password/auth/session/token/jwt/hmac/otp/recovery/refresh 16개 파라미터 스트립). Breadcrumb은 `{step, lastClickedSelector, screenshotPath?}` 화이트리스트만 허용 (명시적 credential-leak deny-list 테스트). `/resume-handoff` thin state-reader skill. 결정론적 exact-resume은 v1.0.3로 연기.
- **US-007**: 캐스케이드 아티팩트 **아카이벌** 파이프 (엄격한 prompt-history 격리 아님). `artifact-pipe.mjs`에 `writeOutbox(runId, stage, name, payload)` / `readInbox(runId, stage)` 제공. 정규 스테이지 이름 6개 한정 (`plan`, `decompose`, `execute`, `verify`, `review`, `finish`). 파일당 100KB / 런당 10MB 캡. Atomic write. 인프로세스 async 전용. 24h 보존 후 SessionEnd sweep. CLAUDE.md State Management 섹션 업데이트.

### Fix — Codex 교차검증 BLOCK 이슈 전부 해결
- **F-001**: `logLatency()` → `await` 추가 + `schemaVersion:1`
- **US-001/003/009**: `node -e '...' ENV=val` → `ENV=val node -e '...'` 환경변수 순서 교정 (여러 SKILL.md)
- **US-003**: 비제한 spacing/allowedFonts 배열에도 하드 2KB 캡 강제
- **US-005**: `alwaysInclude:[code-reviewer]` 제거, `frontend-styles` 규칙 신규, `alwaysInclude:["*"]` rollback 구현, Atlas/Athena diff base 교정
- **F-002**: forward-schema 거부 시 stderr 경고, `memoryFilePath()` path traversal 하드닝
- **preflight.test.mjs:310**: `cwd: tmpDir` 격리 추가로 프로젝트의 `.ao/autonomy.json` 오염 차단

### Test
- **1326 passing / 0 failing** (baseline 1174 → +152, 64 test files). 모든 fix는 regression test로 잠금.

### Docs
- **CLAUDE.md State Management 섹션** 전면 업데이트 — `.ao/memory/`, `.ao/artifacts/pipe/`, `browser-handoff.json`, `ui-remediation.json`, `schemaVersion:1` 컨벤션 명시
- **README.md / README.ko.md Acknowledgements**: impeccable (Apache 2.0), gstack (MIT) 출처와 매핑된 user story 명시

### Cross-Validation
- **Codex (gpt-5-codex)**: Foundation+A+B+C1 범위 review → BLOCK verdict 4건 blocking + 3건 suggestion → 전부 해결 후 BLOCK 해제
- **Gemini (gemini-3-flash-preview)**: rate limit + 루프 감지로 중단, Codex review로 대체

## [1.0.1] - 2026-04-06

### Fix — Concurrency Slot Zombie Bug + Config-Driven Limits

에이전트 에러 종료 시 concurrency slot이 해제되지 않아 좀비 엔트리가 남고, 10분 stale cleanup까지 새 Codex/Gemini 호출이 블록되던 버그 수정. 동시에 concurrency 제한을 config 파일에서 실제로 읽도록 연결하고 기본값 상향.

- **`scripts/concurrency-release.mjs`**: 3단계 release 전략 도입 — (1) task_id 매칭 (2) provider 매칭 (3) SubagentStop safety net (가장 오래된 태스크 강제 해제). stale timeout 10분→3분으로 단축
- **`scripts/concurrency-gate.mjs`**: `config/model-routing.jsonc`의 concurrency 섹션을 실제로 읽도록 연결. 우선순위: env var > config file > hardcoded defaults. stale timeout 10분→3분으로 동기화. 기본값 상향 (global 10, claude 8, codex 5, gemini 5)
- **`config/model-routing.jsonc`**: concurrency 섹션에 `maxClaudeWorkers` 추가, 전체 값 상향 (maxParallelTasks 3→8, maxClaudeWorkers 5 신규, maxCodexWorkers 2→3, maxGeminiWorkers 2→3). 주석에 "informational" 제거, env var override 안내 추가
- **`scripts/lib/config-validator.mjs`**: DEFAULT_ROUTING_CONFIG concurrency 값 동기화
- **`hooks/hooks.json`**: SubagentStop에 concurrency-release 등록 (PostToolUse만으로는 에러 시 누락 가능)
- **`scripts/test/concurrency-release.test.mjs`**: SubagentStop release 테스트 2건 추가, stale threshold 시간값 조정 (3분 기준)
- **`scripts/test/concurrency-gate.test.mjs`**: 테스트 설명 업데이트

## [1.0.0] - 2026-04-06

### UX — Interactive Plan Execution Routing

플랜 승인 후 Solo/Atlas/Athena 실행 방식 선택을 텍스트 기반에서 `AskUserQuestion` 인터랙티브 UI로 전환.
Codex/Gemini 교차검증 피드백 반영 (폴백, 페이로드 통일, 마커 보존, 테스트 커버리지).

- **`scripts/plan-execute-gate.mjs`**: `additionalContext`에 `AskUserQuestion` JSON payload 삽입 + 텍스트 폴백 지시. 3곳 옵션 description 통일
- **`scripts/session-start.mjs`**: Plan Pending 분기에 동일한 `AskUserQuestion` payload 적용. `unlinkSync` → `writeFileSync({ handled: true })` 로 마커 보존 (조기 삭제 방지, SessionEnd 24h cleanup에 위임)
- **`skills/plan/SKILL.md`**: Phase 5 EXECUTE에서 동일한 `AskUserQuestion` 호출 예시로 교체 + 폴백 안내
- **`scripts/test/plan-execute-gate.test.mjs`** (NEW): 11개 테스트 — DISABLE_AO, solo/ask/atlas/athena 모드, 복잡도 휴리스틱, JSON payload 파싱, 마커 파일 생성, 기본 모드 fallback
- **`package.json`**: 버전 `0.9.10` → `1.0.0`

### Cross-Validation Summary

| Reviewer | Verdict | Key Feedback |
|----------|---------|-------------|
| Gemini | ✅ APPROVE | 폴백 추가 권장, 페이로드 일관성 확인 |
| Codex | ⚠️ REQUEST CHANGES | 마커 조기 삭제, 폴백 부재, 페이로드 불일치, 테스트 미비 |

모든 피드백 반영 완료.

## [0.9.10] - 2026-04-06

### Performance — Token Efficiency Optimization

에이전트 실행 시 토큰 소비를 줄이기 위한 최적화. claude-token-efficient 기법 적용 + 3-way 교차검증(Codex/Gemini/Claude).

- **`scripts/subagent-start.mjs`**: Universal token efficiency directive 주입 (non-haiku 에이전트 한정). "No sycophancy, no narration, structured output, minimum viable output" 지침으로 출력 토큰 30-60% 감소 기대
- **`agents/atlas.md`**: tmux bash 블록 제거 (adapter chain이 처리), 에이전트 리스트를 `name (model) — role` 형식으로 간결화
- **`agents/athena.md`**: tmux bash 블록 제거, Communication Protocol 비대칭 방향 반영, 에이전트 리스트 간결화
- **`agents/aphrodite.md`**: Nielsen heuristics 2-4단어 cue로 축약, Gestalt 1줄화, a11y 체크리스트 15→10 (LLM 자체 recall 가능한 5개 제거), READ-ONLY 중복 제거
- **`agents/hermes.md`**: Core Philosophy 1줄화, Forward/Reverse 출력형식 통합, Untestable Words 축약
- **`agents/designer.md`**: Expertise 8항목→2줄, Rules 10→7 (중복 제거), Mental Models 7→4 (핵심만 유지)
- **`agents/code-reviewer.md`**: `<grounding_rules>` 4줄→2줄 축약 (XML 태그 구조는 유지)
- **`agents/debugger.md`**: systematic-debug 관계 설명 4줄→1줄
- **`scripts/test/subagent-start.test.mjs`**: Token efficiency directive 주입 테스트 3건 추가 (haiku skip, non-haiku inject, wisdom+directive 순서)

총 입력 토큰 절감: ~2,800 tokens/orchestrator cycle

## [0.9.9] - 2026-04-05

### Performance — Session Startup Optimization (P0)

세션 시작 시 1.6~3.9초 걸리던 초기화를 120~400ms로 단축.

- **`scripts/lib/preflight.mjs`**: capability cache TTL 5분→60분, `runStateCleanup()` 분리 (SessionStart에서 capability detection 제거), `detectCapabilities()` 병렬화 (`execFileSync` → `execFile` + `Promise.all`), dead import 제거
- **`scripts/lib/resolve-binary.mjs`**: `npm prefix -g` 호출을 `which` 실패 시에만 lazy fallback으로 지연 (`ensureNpmPrefixResolved()`)
- **`scripts/lib/session-registry.mjs`**: 3개의 `git rev-parse` 호출을 `resolveGitMeta()` 캐싱으로 통합 (프로세스 수명 동안 1회 실행)
- **`scripts/lib/wisdom.mjs`**: 모듈 로드 시 `PROJECT_ROOT` 즉시 평가 → lazy getter `getProjectRoot()`로 전환 (import 시 subprocess 제거)
- **`scripts/session-start.mjs`**: `runPreflight()` → `runStateCleanup()` 사용 (capability report 미출력, 가벼운 시작)

### Added — Plan Execution Auto-Routing (P1)

Plan 승인 후 자동으로 Atlas/Athena orchestrator를 활용하도록 라우팅.

- **`scripts/lib/autonomy.mjs`**: `planExecution` 필드 추가 (기본값 `"ask"`, allowlist: `solo`, `ask`, `atlas`, `athena`)
- **`skills/plan/SKILL.md`**: Phase 5: EXECUTE 추가 — complexity check 후 자동 라우팅 (S-scale 또는 스토리 ≤2개면 자동 solo)
- **`scripts/plan-execute-gate.mjs`** (NEW): PostToolUse ExitPlanMode 훅. native plan mode 사용 시 fallback 라우팅
- **`hooks/hooks.json`**: PostToolUse에 ExitPlanMode matcher 등록
- **`scripts/session-start.mjs`**: marker 파일 `ao-plan-pending.json` fallback (context-clear 대응)

### Added — Capability-Aware Multi-Model Auto-Routing (P1)

Atlas/Athena가 Codex/Gemini 가용 여부를 Metis에게 자동 전달하여, 사용자 요청 없이도 적절한 경우 멀티모델 자동 활용.

- **`skills/atlas/SKILL.md`**: `NEEDS_CODEX` → `MULTI_MODEL` 전환. Metis가 capability 기반으로 모델 추천. Gemini cross-validation fallback 추가 (Codex 없을 때). Phase 0에서 capability report 출력
- **`skills/athena/SKILL.md`**: 전체 capability 추출 (`hasCodex`, `hasGeminiCli` 등). Metis 팀 설계에 available worker types 주입. 동적 max workers. Gemini cross-validation fallback. Team_Sizing 문서에 capability-aware 노트 추가

### Configuration

`.ao/autonomy.json`에 `planExecution` 설정 추가:

| 값 | 동작 |
|---|------|
| `"ask"` (기본) | 복잡한 계획 시 Solo/Atlas/Athena 선택지 제시, 간단한 계획은 자동 solo |
| `"solo"` | 항상 Claude 단독 실행 |
| `"atlas"` | 항상 Atlas 자동 실행 |
| `"athena"` | 항상 Athena 자동 실행 |

## [0.9.8] - 2026-04-05

### Security — Claude CLI Permission Mirroring (P0)

Claude CLI workers는 기존에 `--dangerously-skip-permissions`를 하드코딩하여 사용자의 permission 설정을 무시했음.
이제 모든 Claude worker가 호스트 세션의 permission level을 자동 감지하여 미러링함.

- **`scripts/lib/permission-detect.mjs`** (NEW): 통합 permission 감지 모듈. allow/deny list 지원, deny는 모든 settings 파일에서 병합(any deny overrides allow)
- **`scripts/lib/claude-cli.mjs`**: `--dangerously-skip-permissions` 제거 → `detectClaudePermissionLevel()` 자동 감지 + `--permission-mode` 사용
- **`scripts/lib/worker-spawn.mjs`**: Claude worker spawn 시 `permissionMode` 명시적 전달
- **`scripts/lib/codex-approval.mjs`**: 중복 permission 감지 코드 제거 → `permission-detect.mjs`에 위임
- **`scripts/lib/gemini-approval.mjs`**: 중복 permission 감지 코드 제거 → `permission-detect.mjs`에 위임

### Added — Platform Alignment (P1)

Claude Code v2.1.49–v2.1.91에서 도입된 플랫폼 기능 활용.

#### Notification Hook — 스톨 감지
- **`scripts/notification.mjs`** (NEW): `idle_prompt`, `permission_prompt` 이벤트 로깅
- **`hooks/hooks.json`**: Notification hook 등록 (async, non-blocking)
- `.ao/state/ao-notifications.json`에 FIFO 50개 캡으로 기록

#### Capability Caching — 프리플라이트 성능 개선
- **`scripts/lib/preflight.mjs`**: 파일 기반 capability 캐시 (5분 TTL)
- `.ao/state/ao-capabilities.json`에 캐시 저장 (hook은 별도 프로세스이므로 in-process 캐시 불가)
- 환경 민감 필드(`hasNativeTeamTools`, `hasPreviewMCP`)는 캐시 읽기 시 재검증

#### Wisdom — 프로젝트 루트 일관성
- **`scripts/lib/wisdom.mjs`**: `process.cwd()` → `git rev-parse --git-common-dir` 기반 `resolveProjectRoot()`
- worktree 내부에서 실행해도 항상 메인 프로젝트의 `.ao/wisdom.jsonl` 참조

#### SubagentStart — 타입별 지혜 필터링
- **`scripts/subagent-start.mjs`**: `subagent_type`에 따라 관련 wisdom 카테고리만 주입
- 예: `test-engineer` → test/build/debug wisdom, `designer` → pattern/architecture wisdom

#### Claude CLI — tool_use 블록 파싱
- **`scripts/lib/claude-cli.mjs`**: stream-json assistant 메시지에서 `tool_use` content block 추출
- `handle._toolCalls` 배열로 실시간 worker 진행 상황 추적 가능

### Fixed — Hook Node Resolution (P0)

Hook 환경에서 PATH가 `/usr/bin:/bin:/usr/sbin:/sbin`으로 제한되어 `node`를 찾지 못하는 문제 해결.

- **`scripts/run.sh`** (NEW): POSIX 셸 래퍼. nvm/volta/fnm/mise → system paths 순서로 node 탐색
- **`hooks/hooks.json`**: `run.sh ... || node run.cjs ...` 패턴으로 POSIX/Windows 양쪽 지원
- **`scripts/lib/resolve-binary.mjs`**: `getDynamicSearchPaths()` 추가 — `process.execPath` parent dir + `npm prefix -g` bin을 동적 탐색
- **`scripts/lib/preflight.mjs`**: `detectCapabilities()`의 모든 `execFileSync`에 `buildEnhancedPath()` PATH 주입. `#!/usr/bin/env node` shebang 기반 CLI(codex, gemini)가 restricted PATH에서도 실행 가능

### Added — Native Teams Config Fallback (P1)

`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` env var가 hook 환경에 전달되지 않는 경우를 위한 파일 기반 fallback.

- **`scripts/lib/autonomy.mjs`**: `nativeTeams: boolean` 필드 추가 + `gemini.approval` 검증
- **`scripts/lib/preflight.mjs`**: env var 없으면 `.ao/autonomy.json`의 `nativeTeams: true`도 체크. capability cache 재검증에도 반영
- `.ao/autonomy.json`에 `"nativeTeams": true` 설정으로 env var 없이 Native Teams 활성화 가능

### Changed — Orchestrator Branding (P2)

- **`skills/athena/SKILL.md`**: `[athena]` → `[Athena]` (26곳)
- **`skills/atlas/SKILL.md`**: `[atlas]` → `[Atlas]` (25곳)
- **`scripts/lib/preflight.mjs`**: `formatCapabilityReport(caps, { orchestrator })` 및 `formatPreflightReport(report, { orchestrator })` 옵션 추가

### Fixed — Stop Hook 안전성

- **`scripts/stop-hook.mjs`**: `git add -A` → `git add -u` + 선택적 untracked 파일 스테이징
- `.env`, `.ao/state/`, `.ao/teams/`, credentials, secrets, `.key`, `.pem` 파일 자동 제외

### Documentation

- **`docs/plans/claude-code-integration/research-report.md`** (NEW): Claude Code 플랫폼 통합 리서치 보고서
  - 25개 hook 이벤트 중 8개 사용 현황 분석
  - P0–P3 우선순위별 22개 개선 권고사항
  - 경쟁 환경 분석 (Native Teams vs Community Tools vs AO)
  - v0.9.8 → v0.11.0 구현 로드맵
- **`CLAUDE.md`**: permission-detect.mjs, capability caching, notification hook, 안전한 스테이징 등 반영

## [0.9.7] - 2026-04-04

### Added — C3-R Pragmatic Memory + Full Project Audit Fixes

전체 프로젝트 3자 교차 검토(Claude+Codex+Gemini) 후 발견된 P0/P1/P2 수정.
개선 트래커 53/53 (100%) 완료.

#### C3-R Pragmatic Memory (`scripts/lib/wisdom.mjs`)
- 토큰 정규화: 47개 stop words 제거 + 13개 접미사 규칙 (min stem ≥4 chars)
- 다차원 스코링: 5축 가중 스코어 (recency/confidence/category/intent/filePattern)
- Export/Import: `exportWisdom()` / `importWisdom(json, { merge })` with Jaccard dedup
- 레거시 호환: string/null queryWisdom 호출은 기존 동작 유지

#### PID Reuse Guard (P0 — 3/3 교차 검토 합의)
- `codex-exec.mjs`, `codex-appserver.mjs`, `gemini-acp.mjs` shutdown에 `_exitCode` 2중 가드 추가
- 5개 어댑터 shutdown 함수 일관성 확보 (claude-cli.mjs, gemini-exec.mjs 패턴과 동일)

#### Gemini ACP Session Setup (P1 — 3/3 합의)
- `setSessionMode`/`setSessionModel`을 fire-and-forget에서 await + resp.error 체크로 변경
- `handle._warnings` 배열에 실패 기록, `monitor()` 통해 소비자에게 전달

#### reassignToClaude Live Handle (P1 — 3/3 합의)
- `opts.liveState` 파라미터 추가 — in-memory handle 전달 시 adapter-specific graceful shutdown 가능
- 기존 disk-loaded 경로에서 `_liveHandle` undefined → dead code 문제 해결

#### ADAPTER_REGISTRY Refactor (P2 — 3/3 합의)
- `worker-spawn.mjs`에 전략 테이블 도입: 5개 어댑터 × { loader, handleKey, monitorFn, shutdownFn, statusMap }
- 5개 monitor helper → 1개 generic `monitorAdapterWorker()` 통합
- 5개 loader → 1개 `loadRequiredAdapters()` 통합
- `monitorTeam`, `collectResults`, `shutdownTeam`, `reassignToClaude` dispatch 체인 → registry lookup
- Net -43 lines. 새 어댑터 추가 = 레지스트리 1개 엔트리

#### Session-Scoped Checkpoints (P2 — 3/3 합의)
- `checkpoint-${orch}-${sessionId}.json` 형식으로 동시 Atlas 실행 시 충돌 방지
- `loadCheckpoint` scan: sessionId 우선 → legacy → 전체 스캔(최신 선택)
- `clearCheckpoint` 세션별 삭제, `tryLoadCheckpointFile` TTL 헬퍼 추출

#### US-012 Quality-Gate Agent — Themis 흡수
- `agents/themis.md` Check #7: `.ao/prd.json` AC 라인별 PASS/FAIL + MANUAL_REVIEW_NEEDED

#### US-016 Plan-Brainstorm Integration — DROP
- Codex+Gemini 합의: 현재 "invoke or ask" 패턴이 올바른 UX

#### Documentation
- `CLAUDE.md` 테스트 파일 수 47→50, 테스트 수 870+→1000+ 수정
- `AGENTS.md` 누락 에이전트(themis), 라이브러리(7개), Gemini 지원 추가
- `docs/plans/improvements.md` → 53/53 완료

#### Cross-Validation
- 전체 프로젝트 리뷰: Claude 8-9/10, Codex 8/10, Gemini 82/100
- 교차 리뷰 후 합의 점수: 7.5~8/10
- 6건 수정 → 3자 PASS (Gemini Fix 4 1회 REJECT → resp.error 수정 → PASS)
- 4건 DROP (wisdom cwd, stop-hook, Atlas SKILL.md 크기, concurrency TOCTOU)

## [0.9.6] - 2026-04-04

### Added — G#4 Native Agent Teams

Athena에 네이티브 팀 API 런타임 감지 및 이중 제어 평면(Path A/B) 추가.
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 설정 시 Path A 활성화.

#### Feature Detection (`scripts/lib/preflight.mjs`)
- `hasTeamTools` (하드코딩 `true`) → `hasNativeTeamTools` (env var `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` 감지)
- `formatCapabilityReport()` JSDoc에 `hasClaudeCli`, `hasGeminiCli` 추가
- 기존 `hasTeamTools` 참조 전부 `hasNativeTeamTools`로 일괄 리네임

#### SKILL.md 이중 제어 평면 (`skills/athena/SKILL.md`)
- **Phase 0**: `preflightReport.capabilities.hasNativeTeamTools` 추출 + 로그
- **Phase 2 Path A** (native teams): `TeamCreate` → `Task(team_name=...)` → `addEvent(native_team_created/native_teammate_spawned)`
- **Phase 2 Path B** (fallback): `Agent(subagent_type=...)` 독립 subagent — 기존 동작 100% 동일
- **Phase 3**: 하이브리드 모니터링 — Path A `TaskList`, Path B agent completion, Codex/Gemini adapter 폴링
- **Phase 3 Gemini**: Gemini 워커 에러 감지 + Claude 폴백 경로 추가
- **COMPLETION**: `TeamDelete` + `addEvent(native_team_deleted)`, `shutdownTeam()` (Codex + Gemini adapter 정리)
- 체크포인트 복구 시 `hasNativeTeamTools` 재평가 (크래시 세션 캐시 방지)

#### Agent Persona 업데이트 (`agents/athena.md`)
- Gemini Integration 섹션 추가 (gemini-acp > gemini-exec > tmux)
- Communication Protocol에 Path A/B + Gemini 행 추가
- Constraints: Max 5 Claude + 2 Codex + 2 Gemini workers

#### Spec & Docs
- `docs/plans/native-agent-teams/spec.md` *(new)* — G#4 v2 스펙 (7 User Stories, 교차검증 결과 포함)
- `docs/plans/improvements.md` — G#4 Done, Superpowers 16/18 반영, 완료 항목 정리

#### Test Coverage
- `preflight.test.mjs` — `hasNativeTeamTools` subprocess 격리 env var 테스트
- `detectCapabilities` 테스트 3개: 10개 전체 boolean 필드 검증 (기존 5개에서 확대)
- `formatCapabilityReport` 테스트: 7개 capability 표시 행 검증
- **1002/1002 tests pass** (zero regression)

#### Cross-Validation
- Code-reviewer agent × 2 (preflight + SKILL.md) — 7 findings 발견, blocking 3 + medium 1 수정
- Gemini 호환성 리뷰 — Phase 3 모니터링 누락 + athena.md 누락 수정

## [0.9.5] - 2026-04-04

### Added — Codex Permission Mirroring

Claude 권한 수준에 따라 Codex approval 모드 자동 결정.

#### Codex Approval Module (`scripts/lib/codex-approval.mjs`) *(new)*
- `detectClaudePermissionLevel()` — Claude settings 파일에서 권한 감지 (project > user 우선순위)
  - `Bash(*) + Write(*)` → `full-auto`, `Write(*) or Edit(*)` → `auto-edit`, 그 외 → `suggest`
- `resolveCodexApproval()` — autonomy.json 설정 또는 자동 감지로 approval 모드 결정
- `codexApprovalFlag()` — approval 모드를 CLI 플래그로 변환

#### Autonomy Config 확장 (`scripts/lib/autonomy.mjs`)
- `codex.approval` 설정 추가 (값: `auto` | `suggest` | `auto-edit` | `full-auto`, 기본값: `auto`)
- 유효성 검증 추가

#### Worker Command 연동 (`scripts/lib/tmux-session.mjs`)
- `buildWorkerCommand()` — codex 워커에 approval 플래그 자동 주입

#### Skill 템플릿 업데이트
- `atlas/SKILL.md`, `athena/SKILL.md`, `ask/SKILL.md` — codex exec 명령에 `<approval-flag>` 반영

#### Bug Fix (Codex 교차검증에서 발견)
- `worker-spawn.mjs` — `buildWorkerCommand()` 호출 시 `cwd` 미전달 → worktree 경로 전달로 수정

#### New Test Coverage
- `scripts/test/codex-approval.test.mjs` *(new)* — 24 tests: codexApprovalFlag (5), detectClaudePermissionLevel project/user/no-settings/priority (11, bare Bash 포함), resolveCodexApproval (8, auto+실제 settings 포함)

### Fixed — Code Quality & Documentation Hygiene

Claude(Opus 4.6) + Codex(GPT-5.4) 교차 평가에서 발견된 이슈 수정.
Codex 계획 검증 (109K tokens) + 구현 후 교차검증.

#### Shell Execution Safety
- `stop-hook.mjs` — 모든 `execSync()` → `execFileSync()` 마이그레이션 (5건). shell injection 벡터 제거
- `session-registry.mjs` — 모든 `execSync()` → `execFileSync()` 마이그레이션 (3건). args 배열 패턴 통일
- `ci-watch.mjs` — `run()` 헬퍼에 `timeout: 30000` 추가. `gh` CLI 무한 대기 방지

#### Deterministic Session Cleanup
- `session-end.mjs` — `Math.random() < 0.1` → 카운터 기반 결정적 pruning (매 10회차). 원자적 카운터 파일 `ao-session-end-counter.json` 사용. 테스트 가능한 설계

#### Documentation Sync
- `README.md` / `README.ko.md` — 스킬 수 **25 → 26**, 테스트 수 **424+ → 600+**, 파일 수 **28 → 39**, Skills 섹션 **24 → 26**, Testing 섹션 수치 업데이트
- `AGENTS.md` — 스킬 수 **24 → 26**, 테스트 수 **390 → 601**, 파일 수 **25 → 39**

#### New Test Coverage
- `scripts/test/notify.test.mjs` *(new)* — 19 tests: detectPlatform, IS_TEST guard, notifyOrchestrator 8개 이벤트 템플릿, 특수 문자 처리
- `scripts/test/run.test.mjs` *(new)* — 7 tests: no-args exit, valid target, non-existent fallback, exit code propagation, version cache fallback
- `scripts/test/session-end.test.mjs` — 2 tests 추가: 결정적 카운터 생성 및 증분 검증

#### Stats
- Test count: **739 → 821** (+82 new tests, including v0.9.4 base)
- Test files: **39 → 44** (+5: `notify.test.mjs`, `run.test.mjs`, `codex-approval.test.mjs` + v0.9.4 adapters)
- Lib coverage: **23/24 → 25/25** (100%): `notify.mjs`, `codex-approval.mjs` 추가
- Hook coverage: **11/12 → 12/12** (100%): `run.cjs` 추가
- `execSync` in production code: **8 → 0** (전부 `execFileSync`로 전환)

## [0.9.4] - 2026-04-02

### Added — G#5 "Codex를 진짜 팀원으로" 4-Phase Worker Adapter System

Codex/Claude 워커를 tmux 없이 직접 child_process로 제어하는 4단계 어댑터 시스템.
각 Phase마다 실제 Codex CLI(GPT-5.4) 교차검증으로 와이어 프로토콜 오류 5건 발견 및 수정.

#### Phase 0+1: codex-exec adapter (`scripts/lib/codex-exec.mjs`) *(new)*
- `codex exec --json` via `child_process.spawn` — tmux 없이 JSONL 스트리밍
- 5개 이벤트 타입 파싱: `thread.started`, `item.completed`, `turn.completed` 등
- 7개 에러 카테고리 분류: auth_failed, rate_limited, not_installed, network, crash, timeout, unknown
- SIGTERM → SIGKILL 단계적 셧다운

#### Phase 2: codex-appserver adapter (`scripts/lib/codex-appserver.mjs`) *(new)*
- `codex app-server` JSON-RPC 2.0 over stdio — 멀티턴 대화 지원
- Thread/Turn 라이프사이클: createThread, startTurn, steerTurn, interruptTurn
- 실시간 알림 처리: slash-separated 와이어 프로토콜 (`turn/completed`, `item/completed`)
- `initialize` 핸드셰이크 필수 (Codex 교차검증에서 발견)
- CodexErrorInfo → 표준 에러 카테고리 매핑
- EventEmitter 'error' 충돌 방지 (`codex/error`로 네임스페이싱)

#### Phase 3: claude-cli adapter (`scripts/lib/claude-cli.mjs`) *(new)*
- `claude -p --output-format stream-json --verbose --bare` — 헤드리스 Claude Code 워커
- stream-json JSONL 파싱: system(init), assistant(content), result(cost/usage)
- 예산 초과 감지: `error_max_budget_usd` (is_error=false 엣지케이스 포함)
- macOS/Linux 버전별 바이너리 자동 발견 (`resolveClaudeBinary`)
- PID 재사용 방지: shutdown 전 _exitCode 체크
- collect() 타임아웃 시 orphan 프로세스 자동 종료

#### Binary Resolution 확장 (`scripts/lib/resolve-binary.mjs`)
- `resolveClaudeBinary()` — `~/Library/Application Support/Claude/claude-code/<version>/...` 탐색
- 버전별 디렉토리 스캔 → 최신 버전 우선 (semver 내림차순 정렬)
- macOS + Linux 경로 지원, 프로세스 수명 캐싱

#### Worker Adapter Router (`scripts/lib/worker-spawn.mjs`)
- `selectAdapter()` 4단계 우선순위:
  - Codex: `codex-appserver` > `codex-exec` > `tmux`
  - Claude: `claude-cli` > `tmux`
  - 기타: `tmux` (폴백)
- `spawnTeam()`, `monitorTeam()`, `collectResults()`, `shutdownTeam()` 전부 4-tier 대응
- `reassignToClaude()` 어댑터별 셧다운 분기

#### Preflight 확장 (`scripts/lib/preflight.mjs`)
- `hasCodexAppServer`, `hasClaudeCli` 캡빌리티 추가
- `formatCapabilityReport()` 6개 항목으로 확장

#### tmux PATH 주입 개선 (`scripts/lib/tmux-session.mjs`)
- `buildResolvedPath()` — `resolveClaudeBinary()` 경로 포함
- worktree 셸에서도 codex/claude 바이너리 발견 가능

### Fixed — Codex 교차검증 버그 수정

Phase별 Codex CLI(GPT-5.4) 실제 실행으로 발견한 이슈:

- **CRITICAL**: `initialize` 핸드셰이크 누락 — app-server가 "Not initialized" 반환. `initializeServer()` 추가
- **CRITICAL**: 알림 이름 불일치 — camelCase(`turnCompleted`) → slash(`turn/completed`) 수정
- **CRITICAL**: 응답 경로 불일치 — `result.threadId` → `result.thread.id` 수정
- **CRITICAL**: `collect()` 타임아웃 시 detached 프로세스 미종료 → `shutdown()` 호출 추가
- **HIGH**: `turn.status`가 문자열이 아닌 객체(`{type: "completed"}`) — 타입 체크 추가
- **HIGH**: 예산 초과가 성공으로 처리됨 — `subtype` 체크를 `is_error`보다 우선
- **HIGH**: `shutdown()` PID 재사용 위험 — `_exitCode` 체크로 방어
- **MEDIUM**: `buildResolvedPath()`에서 `resolveBinary('claude')` → `resolveClaudeBinary()` 변경
- **MEDIUM**: startTurn 실패 시 이전 출력 보존, collectResults 어댑터 분기 누락 수정

### Meta

- Version: **0.9.3 → 0.9.4**
- Test count: **575 → 739** (+164 new tests, 0 failures)
- Test files: **37 → 39** (`codex-exec.test.mjs`, `codex-appserver.test.mjs`, `claude-cli.test.mjs`, `resolve-binary.test.mjs`)
- New modules: 4 (`codex-exec`, `codex-appserver`, `claude-cli`, `resolve-binary`)
- Cross-validation: 각 Phase마다 Codex CLI(GPT-5.4) 실제 실행 교차검증 — CRITICAL 4건, HIGH 3건, MEDIUM 2건 발견 및 수정
- Branch: `claude/stupefied-shamir`

## [0.9.3] - 2026-04-02

### Added — Cross-Session Management System

세션 간 지식 공유 및 추적 시스템. 새 세션에서 이전 세션 작업을 조회하고, 필요 시 잠든 세션을 재개할 수 있음.
Codex(GPT-5.4) + Claude code-reviewer 교차검증 완료.

#### Session Registry (`scripts/lib/session-registry.mjs`) *(new)*
- `registerSession()` — SessionStart 훅에서 세션 메타데이터 기록
- `finalizeSession()` — SessionEnd 훅에서 세션 종료 처리
- `recoverCrashedSession()` — 비정상 종료 감지 + 자동 복구 (isSessionAlive 확인 후 마킹)
- `linkRunToSession()` — Atlas/Athena run을 세션에 연결
- `getCurrentSessionId()`, `getSession()`, `listSessions()` — 세션 조회
- `isSessionAlive()` — `~/.claude/sessions/` 확인으로 재개 가능 여부 판별
- `pruneSessions()` — 90일 TTL 기반 정리 (active 세션 보호)
- 저장소: `.ao/sessions/<sessionId>.json` (프로젝트 루트, worktree 공유)
- 포인터: `.ao/state/ao-current-session.json` (crash recovery용)

#### SessionStart Hook 확장 (`scripts/session-start.mjs`)
- crash recovery: 이전 세션 포인터 잔존 시 crashed로 마킹 + 알림
- 새 세션 등록: stdin의 `session_id`로 `registerSession()` 호출

#### SessionEnd Hook 확장 (`scripts/session-end.mjs`)
- 세션 종료 기록: `finalizeSession(sessionId, { status: 'ended' })`
- 10% 확률 자동 정리: `pruneSessions()` (오버헤드 방지)

#### Run-Artifacts 연동 (`scripts/lib/run-artifacts.mjs`)
- `createRun()` 시 현재 sessionId를 summary에 포함 + `linkRunToSession()` 호출

#### `/sessions` 스킬 *(new)* (`skills/sessions/SKILL.md`)
- `/sessions` — 최근 세션 목록 + 활성 checkpoint + resume 가능 여부
- `/sessions <id>` — 세션 상세 + 관련 run 정보
- `/sessions search <keyword>` — branch명, CWD 기반 검색
- `/sessions cleanup` — 90일+ 기록 정리 + stale state 정리
- `/sessions resume <id>` — tmux에서 `claude -r <id>` 실행으로 세션 재개

### Fixed — Cross-Validation Bug Fixes (Codex + Claude code-reviewer)

- **CRITICAL**: `currentSessionPath()` — `process.cwd()` → `resolveProjectRoot()` 변경. worktree에서 포인터 파일 경로 불일치로 crash recovery 오작동하던 문제 수정
- **HIGH**: `recoverCrashedSession()` — `isSessionAlive()` 체크 추가. 동시 세션 환경에서 살아있는 세션을 crashed로 잘못 마킹하는 문제 수정
- **HIGH**: `pruneSessions()` — `status === 'active'` 세션 skip 가드 추가. active 세션이 TTL에 의해 삭제되는 문제 수정

### Meta

- Version: **0.9.2 → 0.9.3**
- Test count: **550 → 575** (+25 new tests, 0 failures)
- Test files: **36 → 37** (`session-registry.test.mjs`)
- Skill count: **25 → 26** (`sessions`)
- Cross-validation: Codex (GPT-5.4) + Claude code-reviewer — CRITICAL 1건, HIGH 2건, MEDIUM 1건 발견 및 수정
- Branch: `claude/vigorous-rhodes`

## [0.9.0] - 2026-04-01

### Added — Source-Informed Improvements (PR #11)

Claude Code 소스 구조(claw-code) 분석 + Codex 교차검증을 통해 도출한 4개 모듈 구현.
Athena 팀 오케스트레이션(4 workers)으로 병렬 구현 후 코드리뷰에서 Critical 2건 수정.

#### E1. Stuck Recovery Policy (`scripts/lib/stuck-recovery.mjs`) *(new)*
- 스톨된 워커 자동 복구 3-tier 체인: reframe → switch-agent → escalate
- 에이전트 에스컬레이션 래더: executor → debugger → hephaestus
- `worker-spawn.mjs`의 stall 감지 시 자동 호출, wisdom에 stuck 패턴 기록
- **Critical fix**: `buildRecoveryStrategy`를 async→sync로 변경 — fire-and-forget `.then()`이 workerEntry 반환 후 mutate하는 레이스 컨디션 해결

#### E2. Team Blackboard (`scripts/lib/inbox-outbox.mjs`)
- `writeBlackboard(teamName, workerName, entry)` — JSONL append-only 공유 지식 보드
- `readBlackboard(teamName, opts)` — category/limit/since 필터링
- 카테고리: discovery, decision, warning, api-note
- 기존 inbox/outbox 시스템 보완 (대체 아님)

#### E3. Run Artifacts (`scripts/lib/run-artifacts.mjs`) *(new)*
- `createRun`, `addEvent`, `addVerification`, `finalizeRun`, `listRuns`, `getRun`
- Run ID: `<orchestrator>-YYYYMMDD-HHmmss-<rand4hex>`
- 이벤트: `events.jsonl` (append-only), 요약: `summary.json` (atomic write), 검증: `verification.jsonl`
- **Critical fix**: `addVerification`을 JSON read-modify-write → JSONL append-only로 변경 — 동시 접근 시 데이터 유실 방지

#### E6. Capability Detection (`scripts/lib/preflight.mjs`)
- `detectCapabilities()` — tmux, codex, git worktree, team tools, preview MCP 런타임 감지
- `formatCapabilityReport(caps)` — ✓/✗ 기호로 세션 시작 시 자동 리포트
- **Fix**: clean run에서 리포트가 누락되던 early-return 가드 제거

### Meta

- Version: **0.8.8 → 0.9.0**
- Test count: **424 → 470** (+46 new tests, 0 failures)
- Test files: **28 → 30**
- New test files: `stuck-recovery.test.mjs` (13), `run-artifacts.test.mjs` (14), blackboard tests (+10), capability tests (+9)
- Codex cross-validation: 4/4 PASS
- Code review: Critical 2건 해결 (fire-and-forget race, read-modify-write race)
- Branch: `feat/v0.9-source-informed`
- Reference: [claw-code](https://github.com/instructkr/claw-code) — Claude Code Python clean-room rewrite

## [0.8.8] - 2026-04-01

### Fixed — Silent failure on L-scale tasks (Issue #9)

Three root causes were identified and resolved:

**Root cause 1: L-scale input exceeded sub-agent effective context limits**
- **`scripts/lib/input-guard.mjs`** *(new)* — Input size guard library. Estimates token count from text (CJK-aware), checks against per-tier effective limits (haiku: 30k tokens/500 lines, sonnet: 80k/1500, opus: 150k/3000), and extracts structural summaries when limits are exceeded. Structural extraction preserves headings, user story IDs (US-NNN, RF-NNN), GIVEN/WHEN/THEN acceptance criteria, list items, and table rows — stripping verbose prose. Summary target is tier limit ÷ 4 to leave headroom for orchestrator prompt + response generation. Bug fix: heading-embedded story IDs (e.g. `### US-001: Title`) now correctly extracted alongside body-level story IDs
- **`skills/plan/SKILL.md`** — Phase 1 now runs `checkInputSize()` before calling Hermes; for unsafe inputs calls `prepareSubAgentInput()` to produce a structural summary first, then passes `prepared.text` to Hermes instead of the raw document
- **`skills/athena/SKILL.md`** — Phase 0 runs `checkInputSize()` before calling Metis; same summarization path
- **`skills/atlas/SKILL.md`** — Phase 0 runs `checkInputSize()` before calling Metis/Explore; same summarization path

**Root cause 2: Stale pointer files blocked spec creation**
- **`scripts/lib/preflight.mjs`** *(new)* — Preflight validation library. Detects pointer files in `.ao/spec.md` and `.ao/prd.json` (pattern matching: `# Pointer` heading, bare file paths ≤2 lines, JSON with only `canonical`/`ref` field), removes them, and warns about orphaned team state files (>2h old, still running). Also cleans expired checkpoints (>24h) that `loadCheckpoint()` would have silently ignored
- **`scripts/session-start.mjs`** — Now calls `runPreflight()` on every session start before loading checkpoints or wisdom; actions/warnings injected into `additionalContext` under `## Preflight`

**Root cause 3: No checkpoint before Phase 0 sub-agent calls**
- **`skills/athena/SKILL.md`** — `saveCheckpoint()` now called **before** Metis invocation (was: after). Phase 0 checkpoint (`phase: 0`) is written immediately on skill entry so any failure is detectable
- **`skills/atlas/SKILL.md`** — Same: `saveCheckpoint()` before Explore+Metis parallel spawn

**Sub-agent output validation (all three skills)**
- After every sub-agent call (Hermes, Metis, Explore), output is validated: empty/minimal results trigger one retry with sonnet + aggressively condensed input (100-line summary). If retry also fails, skill stops explicitly with a user-facing diagnosis message and records the failure to `wisdom.jsonl` for future sessions. No more silent continuation

### Added

- **`scripts/lib/preflight.mjs`** — `detectPointerFile()`, `cleanStalePointers()`, `runPreflight()`, `formatPreflightReport()`
- **`scripts/lib/input-guard.mjs`** — `estimateTokens()`, `countLines()`, `checkInputSize()`, `extractStructuralSummary()`, `prepareSubAgentInput()`
- **`scripts/test/preflight.test.mjs`** — 16 tests covering pointer detection, stale cleanup, expired checkpoints, orphaned team state
- **`scripts/test/input-guard.test.mjs`** — 18 tests covering token estimation, tier limits, structural summary extraction, chunking correctness

### Meta

- Test count: **390 → 424** (+34 new tests, 0 failures)
- Test files: **26 → 28**
- Codex cross-validation: confirmed chunking correctness (8000 lines → 128 lines for haiku tier, safe=true)
- Fix branch: `worktree-fix+silent-failure-lscale`

## [0.8.7] - 2026-03-30

### Fixed — Post-review fixes (Themis + Architect + Codex 3-way review)

- **`skills/harness-init/SKILL.md`** — Phase 2 agent changed from `architect` (read-only, cannot write files) to `executor`. Section numbering corrected (1–8, no duplicates). Added `docs/exec-plans/active/` and `docs/exec-plans/completed/` to scaffold output
- **`skills/atlas/SKILL.md`** — `harness_context` injection extended to `designer` and `test-engineer` prompts (was previously only in `executor` prompt)
- **`skills/athena/SKILL.md`** — Added `deepinit` and `harness-init` to External_Skills list (was missing, causing asymmetry with Atlas). Added Phase 5d exec-plan tracking (symmetric with Atlas)
- **`CLAUDE.md`** — Added `harness-init` to Available skills list (24 → 25). Added xval session naming convention (`atlas-codex-xval-<story-id>`, `athena-<slug>-codex-xval-<story-id>`) alongside existing `atlas-codex-<N>` pattern
- **`docs/plans/improvements.md`** — Fixed D4 phase reference: "Athena Phase 3" → "Athena Phase 4"

### Meta

- Review methodology: Themis (quality gate) + Architect (structural) + Codex (gpt-5.4, independent) running in parallel
- Themis verdict: PASS — 390/390 tests, 26/26 scripts syntax clean, all versions aligned
- Architect verdict: CONDITIONAL → resolved
- Codex verdict: FAIL → resolved (architect read-only bug was the critical finding)

## [0.8.6] - 2026-03-30

### Added — Harness Engineering Integration

- **`skills/harness-init/SKILL.md`** — New skill: initialize OpenAI-style harness engineering structure for any project. 4-phase workflow: SCAN → DESIGN HARNESS (generates AGENTS.md as TOC ≤100 lines, `docs/ARCHITECTURE.md`, `docs/golden-principles.md`, `docs/design-docs/index.md`, `docs/exec-plans/`, `docs/QUALITY_SCORE.md`) → STRUCTURAL CONSTRAINTS (arch constraint test stubs) → VERIFY. Aliases: `harness-init`, `setup-harness`, `하네스초기화`
- **`skills/atlas/SKILL.md`** — Phase 0 Harness Check: loads `docs/golden-principles.md` + `docs/ARCHITECTURE.md` as `<harness_context>`, injected into all executor and Codex worker prompts. Phase 3: Codex cross-validation per story via tmux (`atlas-codex-xval-<story-id>`) with `detectCodexError()` unavailability guard. Phase 5d: exec-plan completion record in `docs/exec-plans/tech-debt-tracker.md` with markdown header guard on first use
- **`skills/athena/SKILL.md`** — Phase 0 Harness Check (same as Atlas). Phase 2 worker spawn: harness_context injected inline into all Claude and Codex worker prompts. Phase 3: Codex cross-validation (`athena-<slug>-codex-xval-<story-id>`) against post-merge file paths to catch conflict-resolution violations

### Changed

- **`skills/deepinit/SKILL.md`** — Phase 3 now generates AGENTS.md as table of contents (≤100 lines) pointing to `docs/`, not a monolithic file. New Phase 3.5 creates minimal `docs/` stubs when absent; skips if harness-init already ran. Stale "Phase 0.5" cross-reference corrected
- **`skills/atlas/SKILL.md`** — Codex worker prompts include harness constraints when available. `harness-init` added to External_Skills list
- **`skills/athena/SKILL.md`** — Codex worker prompts include harness constraints. Inbox broadcast note clarified to match actual inline injection

### Design Rationale

Follows OpenAI's harness engineering principles (Feb 2026): AGENTS.md as map not encyclopedia, `docs/` as system of record, golden principles encoded mechanically, architectural constraints enforced via structural tests, entropy management via exec-plan tracking, and Codex cross-validation per story before acceptance.

- Skill count: **24 → 25** (`harness-init`)
- Cross-validation: Claude code-reviewer + Codex (gpt-5.4) independent review

## [0.8.4] - 2026-03-30

### Fixed — Cross-Validation Bug Fixes (Claude × Codex 3-way review)

- **`scripts/lib/tmux-session.mjs`** — Replaced all `execSync` shell-string tmux commands with `execFileSync` + args array throughout (`resolveBinary`, `validateTmux`, `createTeamSession`, `spawnWorkerInSession`, `capturePane`, `killSession`, `killTeamSessions`, `listTeamSessions`). Eliminates shell injection via `sessionCwd`, session name, or binary path. Removed now-unused `execSync` import
- **`scripts/lib/worker-spawn.mjs`** — Fixed zsh prompt detection: completion check now matches both `$` (bash) and `%` (zsh) prompts, preventing orchestrator hang on macOS default shell
- **`scripts/lib/worktree.mjs`** — Added `git merge --abort` after failed `mergeWorkerBranch()` so the repo is never left in a half-merged state
- **`scripts/lib/changelog.mjs`** — Replaced `writeFileSync` with `atomicWriteFileSync` in `prependToChangelog()` to prevent CHANGELOG.md corruption on mid-write crash. Consistent with all other state-file writes in the codebase
- **`scripts/session-start.mjs`** — Replaced `execSync('git log ... 2>/dev/null')` shell invocation with `execFileSync('git', [...])` — the `stdio` option already suppressed stderr, making the shell redirect redundant
- **`skills/consensus-plan/SKILL.md`** — Fixed caller pattern: `Task(subagent_type="agent-olympus:consensus-plan")` → `Skill(skill="agent-olympus:consensus-plan")`. `consensus-plan` is a skill, not an agent — the previous form would fail at runtime with "agent type not found"
- **`skills/deep-dive/SKILL.md`** — Same fix: `Task(subagent_type="agent-olympus:deep-dive")` → `Skill(skill="agent-olympus:deep-dive")`
- **`scripts/lib/notify.mjs`** — Fixed iTerm app name: `'iTerm'` → `'iTerm2'` in `detectTerminalApp()`

### Changed

- **`agents/atlas.md`, `agents/athena.md`** — `model: claude-opus-4-6` → `model: opus` to conform to CLAUDE.md convention (haiku | sonnet | opus aliases only)
- **`skills/design-critique/SKILL.md`** — Removed duplicate alias `UI리뷰` (conflicted with `ui-review` skill, causing non-deterministic intent routing)
- **`scripts/lib/worker-spawn.mjs`** — Removed unused `sendMessage` import
- **`scripts/session-start.mjs`** — Removed unused `formatWisdomForPrompt` import
- **`scripts/concurrency-release.mjs`** — Added missing `#!/usr/bin/env node` shebang (consistent with all other hook scripts)
- **`CLAUDE.md`** — Updated `scripts/lib` module list: corrected `intent` → `intent-patterns`, `tmux` → `tmux-session`, added missing `model-router` and `worker-spawn`. Updated test file count: 25 → 26

### Meta

- Review methodology: 3-way cross-validation — arch-reviewer (Claude/opus), scripts-reviewer (Claude/sonnet), codex-1 (Codex/gpt-5.4) running independently in parallel via Athena orchestrator

## [0.8.3] - 2026-03-30

### Added — UI/UX Design Reinforcement

- **`agents/aphrodite.md`** — New agent: Aphrodite, goddess of beauty. READ-ONLY UI/UX design reviewer using hybrid framework (Nielsen 10 Heuristics + Gestalt Principles + WCAG 2.2 AA). Structured 4-stage review protocol with severity-rated output and 15-point accessibility checklist
- **`skills/design-critique/SKILL.md`** — Structured design critique skill using Nielsen heuristics, Gestalt principles, and WCAG standards. Spawns Aphrodite for evidence-based evaluation with prioritized severity report
- **`skills/a11y-audit/SKILL.md`** — WCAG 2.2 AA accessibility audit via code review only (no browser tools required). 15 critical checks across 4 WCAG principles with compliance scorecard output
- **`skills/design-system-audit/SKILL.md`** — Design system health audit: token leak detection (colors, spacing, typography, shadows), component API consistency checks, state coverage matrix, remediation plan
- **`skills/ux-copy-review/SKILL.md`** — UX copy quality review: error messages, CTAs, empty states, labels, tooltips. Checks clarity, consistency, tone, and inclusivity with style guide extraction
- **`skills/ui-review/SKILL.md`** — Umbrella skill that chains all 4 UI/UX review skills in parallel (design-critique + a11y-audit + design-system-audit + ux-copy-review) with unified verdict

### Changed

- **`agents/designer.md`** — Enhanced from 20 lines to 40 lines: added WCAG 2.2 AA + WAI-ARIA APG expertise, design systems/tokens/theming, i18n/RTL support, reduced-motion, 10 hard rules (state coverage, focus styles, token usage), 7 mental models (task-first, hierarchy-before-color, recognition-over-recall)
- **`scripts/lib/intent-patterns.mjs`** — Added 12 design-specific keywords to visual-engineering category: design critique, design review, design system, design token, usability, heuristic, gestalt, ux copy, microcopy, empty state, visual regression, responsive test, a11y audit, accessibility audit
- **`scripts/test/intent-patterns.test.mjs`** — Added 9 new tests for UI/UX design review intent classification (design critique, a11y audit, design system audit, ux copy review, Korean design review, usability heuristics, responsive/visual regression)
- **`config/model-routing.jsonc`** — New `design-review` intent route: maps design critique/audit/copy review intents to `agent-olympus:aphrodite` (sonnet + gemini). Separated from `visual-engineering` (implementation) for clean routing
- **`scripts/lib/intent-patterns.mjs`** — New `design-review` intent category (weight 1.2) with dedicated patterns for critique, audit, copy review, heuristic evaluation keywords (EN/KO/JA). Cleaned `visual-engineering` keywords to avoid routing conflicts
- **`skills/atlas/SKILL.md`** — Phase 5 REVIEW: Aphrodite now spawns conditionally alongside architect, security-reviewer, code-reviewer when frontend files (`.tsx`, `.jsx`, `.vue`, `.svelte`, `.css`, `.scss`, `.html`) are in the changeset
- **`skills/athena/SKILL.md`** — Phase 5 REVIEW: same conditional Aphrodite review for frontend changes
- **`scripts/test/fixtures/a11y-violations.jsx`** — Seeded fixture with 15 planted WCAG violations (img alt, div onClick, missing labels, heading skip, outline:none, bad links, tabindex, small touch targets, missing aria-live, low contrast)
- **`scripts/test/fixtures/a11y-clean.jsx`** — Zero-violation reference fixture for false-positive testing
- **`scripts/test/a11y-fixtures.test.mjs`** — 18 tests verifying detection patterns match violations and produce zero false positives on clean fixture
- Agent count: **17 → 18**, Skill count: **19 → 24**, Intent categories: **6 → 7**, Test count: **363 → 390**

### Research & Cross-Validation

- Codex (GPT-5.4, xhigh effort, 210K tokens) cross-validated priority ranking, skill decomposition, and framework selection
- Claude research agent surveyed Nielsen NN/g, W3C WCAG 2.2, WAI-ARIA APG, Atomic Design, Storybook/Chromatic patterns, React Testing Library best practices
- Key decisions validated by both models: designer/reviewer role separation, many-focused-skills over monolithic, code-review-only a11y auditing feasibility

## [0.8.1] - 2026-03-30

### Fixed
- **`hooks/hooks.json`** — Hook timeout values corrected from `3` (3ms) to `3000` (3s). All `PreToolUse` and `UserPromptSubmit` hooks were silently killed before completing, effectively disabling intent gate, concurrency gate, and model router
- **`scripts/concurrency-gate.mjs`** — Now gates both `Task` and `Agent` tool invocations. Previously only checked `toolName === 'Task'`, allowing `Agent`-spawned sub-agents to bypass concurrency limits entirely
- **`.claude-plugin/marketplace.json`** — Version bumped from stale `0.7.2` to `0.8.1` (was out of sync with `plugin.json` and `package.json` since v0.8.0 release)
- **`CHANGELOG.md`** + **`README.md`** + **`README.ko.md`** — Removed incorrect claim of Windows PowerShell toast notification support; `notify.mjs` only supports macOS (`osascript`), Linux (`notify-send`), and terminal bell fallback
- **`scripts/test/cost-estimate.test.mjs`** — Fixed `tier: 'opus'` → `model: 'opus'` key mismatch; the wrong key caused opus pricing to silently compute as $0 in the test assertion
- **`CLAUDE.md`** — Added missing `security-reviewer` to available agents list (17 agents, was listing only 16)
- **`scripts/lib/notify.mjs`** — Improved fallback for unknown notification events: added `done`, `started`, `progress` aliases; unregistered events now show humanized title instead of raw event string

## [0.8.0] - 2026-03-30

### Added — Post-Code Automation (A1–A4)
- **`scripts/lib/pr-create.mjs`** — PR automation library: `preflightCheck()`, `extractIssueRefs()`, `buildPRBody()`, `findExistingPR()`, `createPR()`. Atlas/Athena auto-create PRs after commit with issue references parsed from branch names and commit messages
- **`scripts/lib/ci-watch.mjs`** — CI monitoring: async `watchCI({branch, maxCycles, pollIntervalMs})` polls `gh run list` until completion; `getFailedLogs(runId)` fetches failure logs for auto-fix loop
- **`scripts/lib/changelog.mjs`** — CHANGELOG automation: `generateChangelogEntry({prd, version, date})` builds entries from passing PRD stories; `prependToChangelog(filePath, entry)` atomically prepends to existing file
- **`skills/atlas/SKILL.md`** + **`skills/athena/SKILL.md`** — Phase 5c: auto-generate CHANGELOG entry from PRD stories after review approval
- **`skills/atlas/SKILL.md`** + **`skills/athena/SKILL.md`** — Phase 6 SHIP: reads `.ao/autonomy.json`, auto-pushes branch and creates PR (A1+A3), auto-closes referenced issues
- **`skills/atlas/SKILL.md`** + **`skills/athena/SKILL.md`** — Phase 6b CI WATCH: full auto-fix loop — poll CI → fetch failed logs → spawn debugger → systematic-debug → trace → verify locally → push → re-poll (max 3 cycles)

### Added — User Communication (B1–B3)
- **`scripts/lib/notify.mjs`** — OS-aware notifications: macOS via `osascript`, Linux via `notify-send`, terminal bell fallback on other platforms. Fires on task complete, blocked, and CI events
- **`scripts/notify-cli.mjs`** — CLI entry: `node scripts/notify-cli.mjs --event done --orchestrator atlas --summary "3 stories"`
- **`scripts/lib/cost-estimate.mjs`** — Token cost estimator with `PRICING` table (opus/sonnet/haiku rates). Shown before long runs when `costAwareness: true`
- **`skills/atlas/SKILL.md`** + **`skills/athena/SKILL.md`** — Phase 0: cost estimate display + periodic progress briefing (B2+B3)

### Added — Context Intelligence (C1–C2)
- **`skills/atlas/SKILL.md`** + **`skills/athena/SKILL.md`** — Phase 0 auto-onboarding: runs `deepinit` automatically if `AGENTS.md` missing (C1)
- **`skills/atlas/SKILL.md`** + **`skills/athena/SKILL.md`** — Phase 4: optional visual verification via Claude Preview MCP after UI changes detected (C2)

### Added — Ship Policy Config
- **`scripts/lib/autonomy.mjs`** — Ship policy loader/validator. Controls `autoPush`, `draftPR`, `ci.maxCycles`, `notify.*`, `costAwareness`, `progressBriefing` via `.ao/autonomy.json`
- **`skills/finish-branch/SKILL.md`** — Auto-Ship option respects `autonomy.json` for non-interactive workflows

### Added — Tests
- 6 new test files: `autonomy.test.mjs` (24), `cost-estimate.test.mjs` (7), `changelog.test.mjs` (7), `pr-create.test.mjs` (14), `ci-watch.test.mjs` (7), `notify-cli.test.mjs` (9)
- Total test suite: **363+ tests across 25 files** (was 295 across 19)

## [0.7.2] - 2026-03-29

### Security
- **`scripts/stop-hook.mjs`** — Replaced `execSync(git commit -m "${message}")` with `execFileSync('git', ['commit', '-m', message])` to eliminate shell injection vector (P0)
- **`scripts/lib/worktree.mjs`** — Converted ALL `execSync` git calls to `execFileSync` with array arguments throughout the entire file (12 call sites), eliminating shell injection via `cwd`, `worktreePath`, and `branchName`

### Added
- **Activity-based liveness detection** (`scripts/lib/worker-spawn.mjs`) — Tracks output changes via MD5 hash comparison; reports `stalled` status when output is unchanged for 5+ minutes. Informational only — never auto-kills workers; the orchestrator decides how to respond
- **Persistent worktree registry** (`scripts/lib/worktree.mjs`) — New `.ao/state/worktree-registry.json` tracks created worktrees for orphan cleanup. Failed-to-remove entries are retained for retry on next session
- **Extended config validation** (`scripts/lib/config-validator.mjs`) — Now validates `fallbackChain` arrays (must contain valid model names), `teamWorkerType` values (`"gemini"`, `"codex"`, or `null`), `highConfidence` threshold, and `minConfidence < highConfidence` consistency
- **6 new test files** (113 tests): `intent-gate.test.mjs`, `session-start.test.mjs`, `stop-hook.test.mjs`, `model-router-hook.test.mjs`, `model-router.test.mjs` (lib), `concurrency-release.test.mjs`
- Total test suite: **295 tests across 19 files** (was 182 across 13)

### Fixed
- **`scripts/concurrency-gate.mjs`** — `parseInt` of env vars now guards against NaN; invalid values like `AO_CONCURRENCY_GLOBAL=abc` safely fall back to defaults instead of silently disabling concurrency limits
- **`scripts/lib/worker-spawn.mjs`** — Improved `isDone` detection: now checks only the last 5 lines of pane output for shell prompt (`$`), reducing false positives from inline `$` in code output. Removed duplicate if/else branch. Fixed `stateChanged` flag to cover activity/stall metadata updates
- **`scripts/lib/model-router.mjs`** — Added `.catch(() => {})` to fire-and-forget `recordValidationWarning()` call to prevent unhandled promise rejections
- **`scripts/lib/inbox-outbox.mjs`** — Failed `atomicMoveSync` during message consume now logs to `failed-moves.log` instead of silently swallowing errors
- **`scripts/lib/wisdom.mjs`** — Auto-prunes every 50 entries via `pruneWisdom()` to prevent unbounded JSONL growth
- **`CLAUDE.md`** — Added `hephaestus` to Available agents list (was missing); updated test count to 295+/19 files

## [0.7.1] - 2026-03-29

### Fixed
- **`skills/athena/SKILL.md`** — Updated skills list and recommended workflow table to reflect 4-step debug escalation chain (debugger → debugger+wisdom → systematic-debug → trace); was stale "use when debugger fails 2x"
- **`skills/atlas/SKILL.md`** — Same stale trace description fixed in recommended workflow table
- **`skills/brainstorm/SKILL.md`** — Fixed CONVERGE gate to require two-evaluator consensus (Architect marks `feasible: true` AND Momus marks `acceptable: true` on same option); was incorrectly referencing single combined score. Fixed Stop_Conditions to match. Added partial change request re-approval flow.
- **`skills/systematic-debug/SKILL.md`** — Fixed phase gate reference from "Phase 1, 3, and 5" to "Phase 1 (REPRODUCE), Phase 4 (FIX), Phase 5 (VERIFY)"; Phase 3 (UNDERSTAND) has no gate
- **`skills/finish-branch/SKILL.md`** — Replaced AO-hardcoded lint path (`scripts/*.mjs`) with project-aware detection; replaced temp file with inline variable for changed files list
- **`agents/code-reviewer.md`** — Removed internal "Superpowers" methodology branding from agent definition
- **`skills/tdd/SKILL.md`**, **`skills/brainstorm/SKILL.md`**, **`skills/plan/SKILL.md`** — Replaced `Skill()` primitive invocations with inline prose (`invoke /X`); `Skill()` is only valid inside atlas/athena orchestrators
- **`agents/themis.md`** — Replaced non-existent `.ao/teams/superpowers/rules-manifest.json` reference with concrete grep patterns

## [0.7.0] - 2026-03-29

### Added
- **`agents/themis.md`** — New agent: Themis, goddess of law and order. READ-ONLY quality gate enforcer that runs tests, syntax checks, namespace hygiene, and forbidden pattern scans. Returns structured `PASS | FAIL | CONDITIONAL` verdict.
- **`skills/tdd/SKILL.md`** — Test-driven development skill with strict RED→GREEN→REFACTOR discipline. Enforces test-first iron law via `test-engineer` + `executor` + `code-reviewer` agents.
- **`skills/systematic-debug/SKILL.md`** — Root-cause-first debugging: reproduce → isolate → understand → fix → verify. Hard gate: never fix without reproducing first.
- **`skills/brainstorm/SKILL.md`** — Design-before-code methodology: diverge → converge → refine. Hard gate for complex/architectural tasks; outputs design decision record to `.ao/brainstorm-<slug>.md`.
- **`skills/finish-branch/SKILL.md`** — Structured branch completion: tests → lint → coverage → review → present merge options (merge / PR / keep / discard).

### Changed
- **`agents/code-reviewer.md`** — Added two-stage review protocol (Stage 1: spec compliance, Stage 2: code quality)
- **`agents/debugger.md`** — Added Step 0 "Reproduce First" iron law + Forbidden section (no shotgun debugging, no printf-and-pray)
- **`skills/atlas/SKILL.md`** — Added optional Phase 4.5 Themis quality gate checkpoint (standalone-safe: skipped if Themis absent)
- **`skills/athena/SKILL.md`** — Added optional quality gate in integration phase + TDD note for worker dispatch
- **`skills/plan/SKILL.md`** — Added brainstorm pre-processing hint for complex/architectural tasks
- **`skills/consensus-plan/SKILL.md`** — Added TDD enforcement note in finalize phase
- **`skills/trace/SKILL.md`** — Added escalation path to `/systematic-debug` from VERDICT phase
- **`skills/verify-coverage/SKILL.md`** — Added integration note with `/finish-branch`
- **`CLAUDE.md`** — Updated agent/skill inventory; test count updated to 182+
- Agent count: **16 → 17**, Skill count: **15 → 19**

### Inspired By
- [Superpowers](https://github.com/obra/superpowers) — TDD discipline, systematic debugging, brainstorm-first gate, verification-before-completion iron law, two-stage code review protocol

## [0.6.7] - 2026-03-28

### Added
- **Test coverage expansion**: Unit tests for all previously untested lib modules
  - `scripts/test/config-validator.test.mjs` — 24 tests for `validateRoutingConfig()` and `DEFAULT_ROUTING_CONFIG`
  - `scripts/test/stdin.test.mjs` — 6 tests for `readStdin()` including child-process behavioral tests
  - `scripts/test/worker-status.test.mjs` — 10 tests for `reportWorkerStatus`, `readTeamStatus`, `formatStatusMarkdown`, `clearTeamStatus`
  - `scripts/test/worktree.test.mjs` — 14 tests for full worktree lifecycle (create, remove, list, merge, cleanup)
- Total test suite: **182 tests across 13 files** (was 128 across 9)

### Changed
- Corrected skill count from 14 → 15 in `README.md`, `plugin.json`, `marketplace.json`, `CHANGELOG.md`

## [0.6.5] - 2026-03-27

### Added
- **Athena worktree isolation**: Each parallel worker now runs in an isolated git worktree (`scripts/lib/worktree.mjs`), preventing silent file overwrites between concurrent workers
- **SessionStart hook**: Automatically injects prior wisdom and interrupted checkpoint context at session start (`scripts/session-start.mjs`)
- **Stop hook WIP commit**: Auto-saves uncommitted work as a WIP commit on session end (`scripts/stop-hook.mjs`)
- **verify-coverage skill**: Detects test coverage gaps for recently changed files (`skills/verify-coverage/SKILL.md`)
- **128 unit tests**: Comprehensive test suite using `node:test` across 9 test files (`scripts/test/`)
- **Atomic writes**: All state files now use tmp+rename pattern (`scripts/lib/fs-atomic.mjs`)
- **Intent-aware wisdom queries**: `queryWisdom()` now supports filtering by intent, confidence, and file pattern
- **Config schema validation**: `model-routing.jsonc` validated on load with safe fallback (`scripts/lib/config-validator.mjs`)
- **tmux command injection prevention**: `sanitizeForShellArg()` escapes shell special chars before `send-keys`
- **detectProvider() extracted**: Shared library for provider detection (`scripts/lib/provider-detect.mjs`)

### Changed
- `scripts/lib/inbox-outbox.mjs` — uses `atomicMoveSync` for all writes
- `scripts/concurrency-gate.mjs`, `concurrency-release.mjs` — atomic writes + `detectProvider` separated into shared lib
- `scripts/model-router.mjs` — validates config schema on load
- `hooks/hooks.json` — SessionStart and Stop events registered
- `skills/athena/SKILL.md` — worktree isolation added to Phase 2, Phase 4, and COMPLETION
- `skills/cancel/SKILL.md` — worktree cleanup step added
- `.claude-plugin/marketplace.json` — updated to 16 agents, 15 skills

### Inspired By
- [Kimoring AI Skills](https://github.com/codefactory-co/kimoring-ai-skills) — SessionStart/Stop hook patterns, coverage gap detection concept

## [0.5.0] - 2026-03-17

Initial release with Atlas and Athena orchestrators.
