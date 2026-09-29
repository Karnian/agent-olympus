# File Map

Complete inventory of the executable surface under `scripts/`. `AGENTS.md`
keeps only the top-level layout and links here. `scripts/test/file-map-docs.test.mjs`
fails when a `scripts/*.mjs` or `scripts/lib/*.mjs` file is missing from this
page, so add a row whenever you add a module.

Agents and skills are not repeated here: see the Agent Roles and Skills tables
in [AGENTS.md](../../AGENTS.md), or the `agents/` and `skills/` directories.

## Hook entry points (`scripts/`)

Registered in `hooks/hooks.json` (or skill frontmatter) — see [hooks.md](hooks.md).

| File | Purpose |
|------|---------|
| `run.sh` | POSIX wrapper that locates `node` when hook `PATH` is minimal, then delegates to `run.cjs` |
| `run.cjs` | Cross-platform hook runner with versioned plugin-path fallback |
| `session-start.mjs` | SessionStart: inject wisdom + interrupted checkpoint context |
| `runtime-permissions-capture.mjs` | SessionStart + UserPromptSubmit: bind hook identity to the external runtime permission grant |
| `intent-gate.mjs` | UserPromptSubmit: classify intent (EN/KO/JA/ZH) |
| `orchestrator-skill-init.mjs` | UserPromptExpansion + PreToolUse:Skill: Atlas bootstrap and executable control |
| `orchestrator-stop-gate.mjs` | Skill-scoped Stop gate registered by `skills/atlas/SKILL.md` |
| `concurrency-gate.mjs` | PreToolUse Task/Agent: enforce parallel task limits (fail-closed) |
| `model-router.mjs` | PreToolUse Task/Agent: inject model routing advice |
| `concurrency-release.mjs` | PostToolUse Task/Agent + SubagentStop: release concurrency slots |
| `plan-execute-gate.mjs` | PostToolUse ExitPlanMode: inject execution routing |
| `subagent-start.mjs` | SubagentStart: token-efficiency directive + wisdom context |
| `subagent-stop.mjs` | SubagentStop: capture subagent results |
| `notification.mjs` | Notification idle/permission prompts: stall-detection log |
| `session-end.mjs` | SessionEnd: sweep stale state, collect failed-run candidates |

## CLI helpers (`scripts/`)

Invoked by skills, CI, or maintainers — not registered as hooks.

| File | Purpose |
|------|---------|
| `orchestrator-runtime.mjs` | Code-owned Atlas/Athena phase-control CLI (positional commands only) |
| `ask.mjs` | `/ask` helper: sync query plus async job subcommands |
| `codex-goal.mjs` | `/codex-goal` helper: one Codex spawn/resume turn with structured result |
| `codex-review.mjs` | `/codex-review` helper: read-only Codex review gate for the current diff |
| `notify-cli.mjs` | Desktop notification CLI wrapper for skills |
| `setup-gemini-key.mjs` | `/setup-gemini-auth` wizard: AO-owned macOS Keychain item |
| `diagnose-sandbox.mjs` | Dump host sandbox + permission detection and derived Codex level |
| `usage-report.mjs` | Per-agent model-usage summary from recorded JSONL |
| `eval-candidates.mjs` | Local HU-17 failed-run review queue CLI (`npm run eval:candidates`) |
| `run-tests.mjs` | Cross-platform test entry point (`npm test`) |
| `check-version-sync.mjs` | Verify every manifest carries the same version |
| `check-agents-size.mjs` | Keep `AGENTS.md` under the 28 KiB shared-instruction budget |

## Library modules (`scripts/lib/`)

### Hook plumbing and routing

| File | Purpose |
|------|---------|
| `stdin.mjs` | Shared stdin reader with timeout |
| `intent-patterns.mjs` | Intent classifier (13 categories + unknown fallback, multilingual) |
| `model-router.mjs` | Routing logic with JSONC config merge |
| `config-validator.mjs` | Schema validation for `model-routing.jsonc` |
| `stage-escalation.mjs` | Escalation-first model routing for orchestrator stages |
| `review-router.mjs` | Reviewer-set routing for the review chain |
| `subagent-context.mjs` | Subagent context builder for hook injection |
| `provider-detect.mjs` | Shared `detectProvider()` for concurrency hooks |
| `concurrency-limits.mjs` | Schema-v2 concurrency ledger: limits, reservations, and release |

### Orchestration pipeline

| File | Purpose |
|------|---------|
| `phase-runner.mjs` | Durable phase ledger and event-backed transitions |
| `preflight.mjs` | Preflight validation for Atlas/Athena/Plan |
| `light-mode.mjs` | Atlas/Athena lightweight execution path |
| `loop-guard.mjs` | Persistent cooperative termination guard for the autonomous loop |
| `checkpoint.mjs` | Session checkpoint save/restore (24h expiry) |
| `athena-start.mjs` | Checkpoint-friendly START handshake for Athena native teammates |
| `athena-recovery.mjs` | Generation-bound Athena resume/adoption |
| `orphan-run-recovery.mjs` | Fail-closed orphan terminalization |
| `recovery-claim.mjs` | Crash-reclaimable stale-owner election |
| `run-artifacts.mjs` | Hardened run events, summaries, and verification |
| `run-failure.mjs` | Terminal failure evidence and policy |
| `run-finalization-lock.mjs` | Generation-fenced terminalization lock |
| `finalize-content.mjs` | Crash-resumable final-content writers for Atlas/Athena |
| `artifact-pipe.mjs` | Cascade artifact archival pipe for orchestrator stages |
| `stuck-recovery.mjs` | Stuck-worker recovery policy |
| `input-guard.mjs` | Input size guard for sub-agent calls |
| `cost-estimate.mjs` | Cost estimation utilities |
| `architect-scope.mjs` | Architect scope/blast-radius calculator |

### PRD and spec artifacts

| File | Purpose |
|------|---------|
| `spec-artifact.mjs` | Parse Hermes spec envelopes and write the hardened spec/PRD artifact pair |
| `execution-prd.mjs` | Execution PRD validation, story/worker definitions, and changed-path scope checks |
| `execution-prd-store.mjs` | Authoritative `.ao/prd.json` store with allowlisted mutations + CAS |
| `execution-prd-lock.mjs` | Shared crash-reclaimable lock for every `.ao/prd.json` writer |
| `consensus-assignment-plan.mjs` | Merge validated assignment fields onto immutable planning stories |

### Review and cross-validation evidence

| File | Purpose |
|------|---------|
| `review-contract.mjs` | Canonical repository-relative path contract for review evidence |
| `review-package.mjs` | Reviewable dirty set, excluding only AO-owned untracked files |
| `review-snapshot.mjs` | Materialize an exact Git tree into a validator-only directory |
| `orchestrator-review-evidence.mjs` | Code-owned Atlas review evidence and approval ledger |
| `cross-validation.mjs` | Codex/Gemini cross-validation requests, team state, and result parsing |
| `cross-validation-identity.mjs` | Self-referential prompt-digest identity contract |

### Workers and adapters

| File | Purpose |
|------|---------|
| `worker-spawn.mjs` | Team lifecycle, supervisors, and provider failover |
| `adapter-worker-supervisor.mjs` | Detached adapter owner and disk reporter |
| `supervisor-state.mjs` | Run-scoped snapshots and heartbeat |
| `supervisor-opts.mjs` | Pure manifest→adapter option builders |
| `proc-identity.mjs` | PID start-time identity and reuse detection |
| `worker-status.mjs` | Real-time worker status dashboard (inline markdown) |
| `worktree.mjs` | Git worktree isolation for Athena parallel workers |
| `tmux-session.mjs` | Tmux session lifecycle + `sanitizeForShellArg()` |
| `inbox-outbox.mjs` | File-based message queue (legacy, tmux fallback) |
| `claude-cli.mjs` | Claude CLI adapter (headless stream-json) |
| `codex-exec.mjs` | Codex exec adapter (single-turn JSONL) |
| `codex-appserver.mjs` | Codex app-server adapter (multi-turn JSON-RPC 2.0) |
| `codex-error-classifier.mjs` | Ordered Codex failure classifier |
| `codex-release-reaper.mjs` | Detached group reaper for a Codex process released at turn.completed |
| `codex-version-gate.mjs` | Authoritative Codex minimum-version gates for adapter flags |
| `gemini-exec.mjs` | Gemini exec adapter (single-turn JSON spawn) |
| `gemini-acp.mjs` | Gemini ACP adapter (multi-turn JSON-RPC 2.0) |
| `gemini-binary.mjs` | Gemini binary resolution (`gemini` → `agy` fallback) |
| `gemini-readonly.mjs` | Fail-closed Gemini configuration for read-only validators |
| `resolve-binary.mjs` | Binary resolution with caching + `buildEnhancedPath()` |
| `cli-version.mjs` | Fail-open CLI version probe + advisory minimum-version gate |
| `ask-jobs.mjs` | Job lifecycle for the async `/ask` path |

### Permissions, sandbox, and credentials

| File | Purpose |
|------|---------|
| `permission-detect.mjs` | Unified permission detection (settings + runtime layers) |
| `runtime-permissions.mjs` | Runtime `permission_mode` capture/load helpers |
| `codex-approval.mjs` | Claude permissions → Codex sandbox axes + host-sandbox intersection |
| `gemini-approval.mjs` | Claude permissions → Gemini approval mode |
| `host-sandbox-detect.mjs` | Passive host sandbox detection (LSM, container, seccomp) |
| `gemini-credential.mjs` | Gemini API key auto-resolver (env/Keychain/libsecret) |
| `ao-keychain-write.mjs` | macOS Keychain item writer with partition-list grant |
| `trusted-vcs.mjs` | Resolve Git/`gh` from fixed roots without consulting `PATH` |

### State, memory, and filesystem

| File | Purpose |
|------|---------|
| `fs-atomic.mjs` | Atomic write helpers (tmp+rename) |
| `hardened-fs.mjs` | Shared no-follow artifact I/O and append validation |
| `session-registry.mjs` | Cross-session metadata tracking and crash recovery |
| `wisdom.mjs` | Structured learning store (JSONL, intent-aware query) |
| `memory.mjs` | Durable memory namespace manager (`.ao/memory/`) |
| `design-identity.mjs` | Brand identity loader/writer |
| `taste-memory.mjs` | Aesthetic preference accumulation (`taste.jsonl`) |
| `autonomy.mjs` | Ship policy loader/validator (`.ao/autonomy.json`) |
| `model-usage.mjs` | Per-subagent model usage logger |
| `eval-failure-candidates.mjs` | Sanitized failed-run review queue |
| `browser-handoff.mjs` | Browser pause state for `/resume-handoff` |

### Release, CI, and notifications

| File | Purpose |
|------|---------|
| `changelog.mjs` | Changelog utilities |
| `pr-create.mjs` | GitHub pull request helpers via `gh` |
| `ci-watch.mjs` | Poll GitHub Actions for one pinned repository and commit |
| `notify.mjs` | Desktop notification utilities |

### UI design passes

| File | Purpose |
|------|---------|
| `micro-skill-scope.mjs` | Scope detection for design micro-skills |
| `ui-reference.mjs` | UI reference material loader |
| `ui-remediate.mjs` | UI remediation chain orchestrator |
| `ui-smell-scan.mjs` | UI smell detection heuristics |

## Other directories

| Path | Purpose |
|------|---------|
| `config/` | `model-routing.jsonc`, `review-routing.jsonc`, `design-blacklist.jsonc.example` |
| `schemas/` | Tracked JSON schemas for Codex goal/review structured output |
| `evals/` | Eval harness: fixture vs live runner, deterministic graders, golden tasks — see `evals/README.md` |
| `.codex/agents/` | Committed Codex sub-agent definitions (explorer, tester, reviewer) |
| `scripts/test/` | `node:test` suites plus `fixtures/` and `helpers/` |
| `docs/plans/` | Design history and roadmaps |
