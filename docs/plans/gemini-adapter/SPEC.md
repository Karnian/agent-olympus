# Gemini CLI Adapter Integration -- Product Specification

**Version**: 1.0
**Date**: 2026-04-04
**Scale**: L (estimated 3-5 days across 5 parallel streams)
**Status**: Draft

---

## Problem Statement

Agent Olympus orchestrators (Atlas/Athena) currently support two worker backends: Codex (via codex-exec and codex-appserver adapters) and Claude (via claude-cli adapter), with tmux as a universal fallback. Google's Gemini CLI (`gemini`) offers a third high-quality model family with competitive pricing and distinct strengths (large context window, grounding). Users who have the Gemini CLI installed cannot use it as a native worker -- they are forced to use tmux send-keys, which loses structured output, error classification, and approval mirroring. This limits Agent Olympus to a two-vendor ecosystem when the architecture was designed to be model-agnostic.

## Target Users

- **Power users** running Atlas/Athena who have `gemini` CLI installed and want to use Gemini models (pro, flash, flash-lite) as first-class workers alongside Codex and Claude workers.
- **Cost-conscious users** who want to route low-complexity tasks to cheaper Gemini flash-lite workers while reserving Claude/Codex for complex reasoning.
- **Multi-model teams** using Athena peer-to-peer mode where different workers run on different model providers for diversity of thought.

## Appetite

L-scale: up to 5 working days. The work decomposes cleanly into 5 parallel streams with well-defined interfaces. Each stream maps 1:1 to an existing adapter pattern (codex-exec, codex-appserver, codex-approval, worker-spawn integration), minimizing design uncertainty.

## Goals

| ID | Goal | Measure |
|----|------|---------|
| G1 | Gemini workers spawn, execute, and return structured results via `gemini --output-format json` (single-turn) | `gemini-exec.mjs` passes 30+ unit tests covering spawn/monitor/collect/shutdown/error-classification |
| G2 | Gemini workers support multi-turn conversations via `gemini --acp` JSON-RPC 2.0 (ACP protocol) | `gemini-acp.mjs` passes 30+ unit tests covering initialize/newSession/prompt/cancel/shutdown |
| G3 | Claude permission level automatically maps to Gemini `--approval-mode` | `gemini-approval.mjs` passes 15+ unit tests covering all 4 mapping paths |
| G4 | `selectAdapter()` routes `type: 'gemini'` workers through the correct adapter based on detected capabilities | Integration tests confirm adapter selection priority: gemini-acp > gemini-exec > tmux |
| G5 | `detectCapabilities()` discovers Gemini CLI presence and version | `hasGeminiCli` and `hasGeminiAcp` capabilities detected in preflight |
| G6 | All new code has zero npm dependencies, uses ESM, and follows the fail-safe pattern | Syntax check passes; no `require()` calls; all errors caught and mapped |

## Non-Goals

- **Gemini API (REST) adapter**: We are integrating the CLI tool only, not the HTTP API. Direct API calls are out of scope.
- **Gemini-specific model routing**: The existing model-router.mjs will not be modified. Model selection (`-m auto|pro|flash|flash-lite`) is passed through from worker config, not routed by Agent Olympus.
- **Gemini authentication management**: We assume the user has already authenticated (`gemini auth`). We detect auth failures but do not attempt to fix them.
- **GUI/interactive features**: No interactive approval prompts. Gemini workers run headless only.
- **Streaming UI**: We parse stream-json JSONL for monitoring but do not expose a real-time streaming UI.

---

## User Stories

### US-001: Single-Turn Gemini Worker Execution (gemini-exec)

**As** an Atlas orchestrator delegating a code generation task,
**I want to** spawn a Gemini worker via `gemini --output-format json -p "prompt"` and collect the structured result,
**So that** I get parsed output with token usage and error classification without tmux overhead.

**Priority**: Must

**Acceptance Criteria**:

- **AC-001a**: GIVEN the Gemini CLI is installed and authenticated, WHEN `spawn(prompt, { cwd })` is called, THEN a child process is created with args `['--output-format', 'json', '-p', prompt]` and the process handle is returned with `{ pid, process, stdout, status: 'running' }`.
- **AC-001b**: GIVEN a running gemini-exec process, WHEN `monitor(handle)` is called, THEN it returns `{ status, output, events, error?, usage? }` by parsing accumulated JSONL/JSON output.
- **AC-001c**: GIVEN a completed gemini-exec process (exit code 0), WHEN `collect(handle)` is called, THEN it returns the final response text and token usage stats extracted from the JSON output.
- **AC-001d**: GIVEN a running gemini-exec process, WHEN `shutdown(handle)` is called, THEN SIGTERM is sent first, followed by SIGKILL after 5 seconds if the process has not exited.
- **AC-001e**: GIVEN stderr output containing "authentication" or "API key", WHEN `mapGeminiExecError(text)` is called, THEN it returns `'auth_failed'`.
- **AC-001f**: GIVEN stderr output containing "rate limit" or "429", WHEN `mapGeminiExecError(text)` is called, THEN it returns `'rate_limited'`.
- **AC-001g**: GIVEN stderr output containing "command not found", WHEN `mapGeminiExecError(text)` is called, THEN it returns `'not_installed'`.
- **AC-001h**: GIVEN a model override `opts.model = 'flash'`, WHEN `spawn()` is called, THEN the args include `['-m', 'flash']`.
- **AC-001i**: GIVEN `opts.approvalMode = 'yolo'`, WHEN `spawn()` is called, THEN the args include `['--approval-mode', 'yolo']`.

### US-002: Multi-Turn Gemini Worker via ACP Protocol (gemini-acp)

**As** an Athena orchestrator running a long-running coding task,
**I want to** maintain a multi-turn conversation with a Gemini worker via the ACP JSON-RPC 2.0 protocol,
**So that** I can steer, cancel, and resume conversations without losing context.

**Priority**: Must

**Acceptance Criteria**:

- **AC-002a**: GIVEN Gemini CLI supports `--acp`, WHEN `startServer({ cwd })` is called, THEN a child process is spawned with `gemini --acp` and the server handle is returned.
- **AC-002b**: GIVEN a running ACP server, WHEN `initializeServer(handle)` sends `{ jsonrpc: "2.0", method: "initialize", params: { clientInfo } }`, THEN the server responds with `result` containing server capabilities.
- **AC-002c**: GIVEN an initialized ACP server, WHEN `createSession(handle, { cwd })` sends `{ method: "newSession", params: { workingDirectory } }`, THEN the server responds with `result.sessionId`.
- **AC-002d**: GIVEN an active session, WHEN `sendPrompt(handle, prompt)` sends `{ method: "prompt", params: { sessionId, text } }`, THEN the server streams notifications (`prompt/started`, `item/started`, `item/completed`, `prompt/completed`) and finally responds with the turn result.
- **AC-002e**: GIVEN a running prompt, WHEN `cancelPrompt(handle)` sends `{ method: "cancel", params: { sessionId } }`, THEN the current prompt is cancelled and the session remains usable.
- **AC-002f**: GIVEN an active session, WHEN `setSessionMode(handle, mode)` sends `{ method: "setSessionMode", params: { sessionId, mode } }`, THEN the approval mode is updated without restarting.
- **AC-002g**: GIVEN a server handle, WHEN `shutdownServer(handle, timeoutMs)` is called, THEN stdin is closed, SIGTERM is sent, and SIGKILL follows after `timeoutMs` if the process has not exited.
- **AC-002h**: GIVEN JSON-RPC notifications arriving on stdout, WHEN `classifyMessage(msg)` is called, THEN it correctly returns `'response'`, `'notification'`, or `'request'` following the same contract as codex-appserver.
- **AC-002i**: GIVEN `unstable_setSessionModel` is available, WHEN `setModel(handle, 'flash')` is called, THEN the method is forwarded and the response acknowledged (no error on success).

### US-003: Permission Mirroring for Gemini Workers (gemini-approval)

**As** an orchestrator spawning Gemini workers,
**I want** Claude's permission level to automatically map to the equivalent Gemini `--approval-mode`,
**So that** Gemini workers have the same autonomy as the orchestrating Claude session without manual configuration.

**Priority**: Must

**Acceptance Criteria**:

- **AC-003a**: GIVEN Claude settings have `Bash(*)` + `Write(*)` in allow, WHEN `resolveGeminiApproval()` is called, THEN it returns `'yolo'`.
- **AC-003b**: GIVEN Claude settings have `Write(*)` or `Edit(*)` only, WHEN `resolveGeminiApproval()` is called, THEN it returns `'auto_edit'`.
- **AC-003c**: GIVEN Claude settings have no broad permissions, WHEN `resolveGeminiApproval()` is called, THEN it returns `'default'`.
- **AC-003d**: GIVEN `.ao/autonomy.json` contains `{ "gemini": { "approval": "plan" } }`, WHEN `resolveGeminiApproval()` is called, THEN it returns `'plan'` regardless of Claude settings.
- **AC-003e**: GIVEN `.ao/autonomy.json` contains `{ "gemini": { "approval": "auto" } }`, WHEN `resolveGeminiApproval()` is called, THEN it falls through to Claude permission detection (same as no override).
- **AC-003f**: GIVEN the valid Gemini approval modes are `['default', 'auto_edit', 'yolo', 'plan']`, WHEN an invalid mode is provided in autonomy.json, THEN the function falls back to `'default'`.

### US-004: Adapter Selection and Integration (worker-spawn / preflight)

**As** the worker-spawn module routing workers to adapters,
**I want** `selectAdapter()` to recognize `type: 'gemini'` and route to the highest-capability Gemini adapter available,
**So that** Gemini workers get the same structured-output treatment as Codex and Claude workers.

**Priority**: Must

**Acceptance Criteria**:

- **AC-004a**: GIVEN `worker.type === 'gemini'` and `capabilities.hasGeminiAcp === true`, WHEN `selectAdapter(worker, capabilities)` is called, THEN it returns `'gemini-acp'`.
- **AC-004b**: GIVEN `worker.type === 'gemini'` and `capabilities.hasGeminiAcp === false` and `capabilities.hasGeminiCli === true`, WHEN `selectAdapter(worker, capabilities)` is called, THEN it returns `'gemini-exec'`.
- **AC-004c**: GIVEN `worker.type === 'gemini'` and `capabilities.hasGeminiCli === false`, WHEN `selectAdapter(worker, capabilities)` is called, THEN it returns `'tmux'`.
- **AC-004d**: GIVEN `detectCapabilities()` is called and `gemini --version` succeeds, THEN the result includes `hasGeminiCli: true`.
- **AC-004e**: GIVEN `detectCapabilities()` is called and `gemini --acp --help` succeeds, THEN the result includes `hasGeminiAcp: true`.
- **AC-004f**: GIVEN `detectCapabilities()` is called and `gemini` is not installed, THEN the result includes `hasGeminiCli: false` and `hasGeminiAcp: false`.
- **AC-004g**: GIVEN `formatCapabilityReport(caps)` is called with Gemini capabilities, THEN the output includes a `gemini-cli` line showing presence/absence.

### US-005: Binary Resolution for Gemini CLI (resolve-binary)

**As** the resolve-binary module,
**I want to** discover the `gemini` binary path using the same `which` + fallback-scan pattern used for `codex` and `claude`,
**So that** Gemini adapters can find the binary in non-standard installation locations.

**Priority**: Must

**Acceptance Criteria**:

- **AC-005a**: GIVEN `gemini` is on PATH, WHEN `resolveGeminiBinary()` is called, THEN the full path returned by `which gemini` is returned and cached.
- **AC-005b**: GIVEN `gemini` is not on PATH but exists at `/opt/homebrew/bin/gemini`, WHEN `resolveGeminiBinary()` is called, THEN `/opt/homebrew/bin/gemini` is returned.
- **AC-005c**: GIVEN `gemini` is not found anywhere, WHEN `resolveGeminiBinary()` is called, THEN the bare string `'gemini'` is returned (let the OS attempt resolution).
- **AC-005d**: GIVEN `resolveGeminiBinary()` has been called once, WHEN called again, THEN the cached result is returned without executing `which` again.

### US-006: Tmux Fallback for Gemini Workers (tmux-session)

**As** the tmux-session module building worker commands,
**I want** `buildWorkerCommand()` to construct the correct `gemini` invocation when the worker type is `'gemini'`,
**So that** Gemini workers degrade gracefully to tmux when structured adapters are unavailable.

**Priority**: Must

**Acceptance Criteria**:

- **AC-006a**: GIVEN `worker.type === 'gemini'`, WHEN `buildWorkerCommand(worker, { cwd })` is called, THEN the command string contains the resolved gemini binary path, the prompt, and `--approval-mode` from `resolveGeminiApproval()`.
- **AC-006b**: GIVEN `worker.model === 'flash'`, WHEN the tmux command is built, THEN it includes `-m flash`.
- **AC-006c**: GIVEN session naming conventions, WHEN a Gemini tmux worker is spawned, THEN the session name follows the pattern `atlas-gemini-<N>` or `athena-<slug>-gemini-<N>`.

### US-007: Monitor and Collect for Gemini Workers

**As** the monitorTeam function in worker-spawn.mjs,
**I want** Gemini worker monitoring to be dispatched to the correct adapter-specific monitor function,
**So that** the orchestrator sees consistent `{ status, output, error? }` results regardless of adapter.

**Priority**: Must

**Acceptance Criteria**:

- **AC-007a**: GIVEN a running gemini-exec worker with `_adapterName === 'gemini-exec'`, WHEN `monitorTeam()` is called, THEN `monitorGeminiExecWorker()` is dispatched and returns `{ status, output }`.
- **AC-007b**: GIVEN a running gemini-acp worker with `_adapterName === 'gemini-acp'`, WHEN `monitorTeam()` is called, THEN `monitorGeminiAcpWorker()` is dispatched and returns `{ status, output }`.
- **AC-007c**: GIVEN a failed gemini worker, WHEN `reassignToClaude()` is called, THEN the correct shutdown method is invoked (gemini-acp `shutdownServer` or gemini-exec `shutdown`) before recording wisdom and returning fallback descriptor.

### US-008: Cross-Validation with Codex

**As** the quality assurance process,
**I want** every new Gemini adapter file to be cross-validated by a Codex worker,
**So that** implementation correctness is verified by an independent model.

**Priority**: Must

**Acceptance Criteria**:

- **AC-008a**: GIVEN `gemini-exec.mjs` is implemented, WHEN Codex cross-validation runs, THEN Codex confirms the module exports `spawn`, `monitor`, `collect`, `shutdown`, `mapGeminiExecError`, `parseGeminiJsonEvents` and all unit tests pass.
- **AC-008b**: GIVEN `gemini-acp.mjs` is implemented, WHEN Codex cross-validation runs, THEN Codex confirms JSON-RPC 2.0 message format compliance and all unit tests pass.
- **AC-008c**: GIVEN integration changes to `worker-spawn.mjs`, WHEN Codex cross-validation runs, THEN Codex confirms no regressions in existing Codex/Claude adapter paths and all 821+ existing tests still pass.

---

## Architecture

### Adapter Priority (updated)

```
Codex workers  (type: 'codex'):   codex-appserver > codex-exec > tmux
Claude workers (type: 'claude'):  claude-cli > tmux
Gemini workers (type: 'gemini'):  gemini-acp > gemini-exec > tmux  [NEW]
All others:                       tmux
```

### New Files

| File | Pattern Source | Description |
|------|---------------|-------------|
| `scripts/lib/gemini-exec.mjs` | `codex-exec.mjs` | Single-turn adapter: spawn, monitor, collect, shutdown, error mapping |
| `scripts/lib/gemini-acp.mjs` | `codex-appserver.mjs` | Multi-turn ACP adapter: JSON-RPC 2.0 client over stdio |
| `scripts/lib/gemini-approval.mjs` | `codex-approval.mjs` | Permission mirroring: Claude perms to Gemini --approval-mode |
| `scripts/test/gemini-exec.test.mjs` | `codex-exec.test.mjs` | 30+ unit tests |
| `scripts/test/gemini-acp.test.mjs` | `codex-appserver.test.mjs` | 30+ unit tests |
| `scripts/test/gemini-approval.test.mjs` | `codex-approval.test.mjs` | 15+ unit tests |

### Modified Files

| File | Changes |
|------|---------|
| `scripts/lib/worker-spawn.mjs` | Add `gemini-acp` and `gemini-exec` to `selectAdapter()`, `spawnTeam()`, `monitorTeam()`, `reassignToClaude()` |
| `scripts/lib/preflight.mjs` | Add `hasGeminiCli` and `hasGeminiAcp` capability detection to `detectCapabilities()`, update `formatCapabilityReport()` |
| `scripts/lib/resolve-binary.mjs` | Add `resolveGeminiBinary()` export |
| `scripts/lib/tmux-session.mjs` | Update `buildWorkerCommand()` for `type: 'gemini'`, import `resolveGeminiBinary` and `resolveGeminiApproval` |

### Protocol Mapping

| Gemini CLI | Codex CLI (equivalent) | Claude CLI (equivalent) |
|------------|----------------------|------------------------|
| `gemini --output-format json -p "..."` | `codex exec --json -` | `claude -p --output-format stream-json` |
| `gemini --acp` (JSON-RPC 2.0) | `codex app-server` (JSON-RPC 2.0) | N/A |
| `--approval-mode yolo` | `--full-auto` | N/A (inherits from Claude session) |
| `--approval-mode auto_edit` | `--auto-edit` | N/A |
| `--approval-mode default` | `suggest` | N/A |
| `--approval-mode plan` | N/A | N/A |
| `-m flash` | N/A (single model) | `--model` |

### Permission Mapping Table

| Claude Settings | Codex Flag | Gemini --approval-mode |
|----------------|------------|----------------------|
| `Bash(*)` + `Write(*)` | `--full-auto` | `yolo` |
| `Write(*)` or `Edit(*)` | `--auto-edit` | `auto_edit` |
| No broad perms | (none/suggest) | `default` |
| Override: `.ao/autonomy.json` | `{ codex: { approval } }` | `{ gemini: { approval } }` |

---

## Success Metrics

| Metric | Target |
|--------|--------|
| New unit tests added | 75+ (30 gemini-exec + 30 gemini-acp + 15 gemini-approval) |
| All existing tests pass (no regressions) | 821+ tests, 0 failures |
| Syntax check passes for all new/modified files | 100% |
| Cross-validation by Codex | All 5 streams validated |
| Zero npm dependencies introduced | 0 |
| Adapter selection correctness | 100% of `type: 'gemini'` workers routed to correct adapter |

## Constraints

1. **Zero npm dependencies**: All code must use Node.js built-ins only (child_process, events, fs, path, crypto, os).
2. **ESM only**: All new files must be `.mjs` with `import`/`export` syntax. No `require()`.
3. **Fail-safe pattern**: Every public function must catch errors and return safe defaults. No uncaught exceptions may propagate to the orchestrator.
4. **Backward compatibility**: All existing exports from modified files must remain unchanged. No breaking changes to `selectAdapter()`, `detectCapabilities()`, `spawnTeam()`, or `monitorTeam()` signatures.
5. **File permissions**: State files written to `.ao/` must use `mode: 0o600` (files) and `0o700` (directories).
6. **Process lifecycle**: All spawned child processes must be tracked and cleanable. SIGTERM before SIGKILL with configurable grace period (default 5s).
7. **Gemini CLI version**: The ACP protocol requires a minimum Gemini CLI version. Detection must be version-gated (similar to `meetsMinVersion()` for Codex).
8. **Output via stdout**: All hook-context code must use `process.stdout.write(JSON.stringify(...))`, not `console.log`.

## Risks and Unknowns

| Risk | Severity | Mitigation |
|------|----------|------------|
| **R1**: Gemini CLI ACP protocol is unstable (`unstable_setSessionModel`) and may change between versions | High | Version-gate ACP detection. Wrap unstable methods in try/catch. Document minimum version requirement. |
| **R2**: Gemini CLI `--output-format json` output schema is not formally documented | Medium | Spike: capture actual output from `gemini --output-format json -p "hello"` and `gemini --output-format stream-json -p "hello"` to define the parse contract. Write snapshot tests. |
| **R3**: Gemini CLI may not be widely installed among current users | Low | Graceful degradation to tmux. Gemini capabilities are optional -- no orchestrator functionality is lost if gemini is absent. |
| **R4**: Permission mapping may not cover all Gemini approval-mode edge cases (e.g., `plan` mode has no Codex equivalent) | Low | Map `plan` to its own category. Override via `.ao/autonomy.json` covers edge cases. |
| **R5**: ACP JSON-RPC 2.0 method names may differ from Codex app-server conventions (slash vs dot separators) | Medium | Spike: run `gemini --acp` and capture the initialize handshake to confirm method naming convention. |
| **R6**: Gemini CLI may require Google Cloud authentication (gcloud) vs API key, adding complexity to auth-failure detection | Medium | Add Gemini-specific auth error patterns (`gcloud auth`, `GOOGLE_API_KEY`, `not authenticated`) to error classifier. |

## Open Questions

1. **What is the minimum Gemini CLI version that supports `--acp`?** Needed for `meetsMinVersion()` gating in preflight.
2. **What is the exact JSON schema of `gemini --output-format json` response?** Needed to write the parser. A spike should capture sample output.
3. **Does `gemini --acp` use newline-delimited JSON-RPC (like Codex) or length-prefixed messages?** Needed to choose the correct stdio framing.
4. **What is the notification naming convention for ACP?** Codex uses `thread/started`, `turn/started`. Does Gemini use the same slash-separated convention or something different?
5. **Does `gemini --output-format stream-json` exist as a separate mode from `--output-format json`?** If so, we may want `gemini-exec` to prefer streaming mode for real-time monitoring (like claude-cli uses `stream-json`).
6. **Should `.ao/autonomy.json` support `{ "gemini": { "model": "flash" } }` as a default model override?** Currently out of scope but worth considering.

---

## Stream Decomposition (Implementation Plan)

| Stream | File(s) | Assignee | Depends On | Estimated Effort |
|--------|---------|----------|------------|-----------------|
| S1 | `gemini-exec.mjs`, `gemini-exec.test.mjs` | Claude sonnet | Open Question 2 (JSON schema spike) | 1 day |
| S2 | `gemini-acp.mjs`, `gemini-acp.test.mjs` | Claude sonnet | Open Question 3-4 (ACP wire format spike) | 1.5 days |
| S3 | `gemini-approval.mjs`, `gemini-approval.test.mjs` | Claude haiku | None | 0.5 day |
| S4 | Integration: `worker-spawn.mjs`, `preflight.mjs`, `resolve-binary.mjs`, `tmux-session.mjs` | Codex | S1, S2, S3 complete | 1 day |
| S5 | Cross-validation of all streams | Codex | S1-S4 complete | 0.5 day |

**Critical path**: S1 and S2 can run in parallel. S3 can run in parallel with S1/S2. S4 depends on S1+S2+S3. S5 depends on S4.

```
S1 (gemini-exec) ────────┐
S2 (gemini-acp)  ────────┤─→ S4 (integration) ─→ S5 (cross-validation)
S3 (gemini-approval) ────┘
```
