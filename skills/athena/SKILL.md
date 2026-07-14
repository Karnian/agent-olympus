---
name: athena
description: Self-driving hybrid team orchestrator — native Claude collaboration plus bridged Codex/Gemini workers
---

<Athena_Orchestrator>

## Purpose

Athena is the self-driving team orchestrator. Unlike Atlas (one brain, many
hands), Athena gives native Claude teammates a shared task list and direct
messaging. Adapter-backed Codex and Gemini workers remain external executors;
Athena relays their results and follow-up context. She never stops until every
worker's output is integrated, tested, and reviewed.

Atlas = one brain delegating.
Athena = many brains collaborating.

## Use_When

- User says "athena", "아테나", "팀으로 해", "같이 해", "team", "collaborate"
- Task splits into non-overlapping work packages that benefit from shared discoveries (for example, API + frontend + tests with explicit ownership)
- Workers need to share discoveries in real-time
- Large-scale work across many files

## Do_Not_Use_When

- User explicitly says "atlas" (use atlas for hub-and-spoke)
- Task has no parallelizable components
- Simple single-file task (atlas handles this fine)

## Core_Principle

**NEVER STOP UNTIL DONE.** After spawning the team:
- Monitor continuously until all workers complete
- Bridge ALL Claude↔Codex↔Gemini communication
- If integration fails → debug and retry
- If reviews reject → fix and re-review
- Only stop when ALL checks pass, or when the **Loop Guard** (below) returns a stop signal.

## Phase_Runner (deterministic phase ledger + loop-guard chokepoint — MANDATORY)

Athena phase order, resume policy, and loop bounds are owned by
`scripts/lib/phase-runner.mjs`. It persists `pipeline.json` beside the run
artifacts and is the sole caller of `loop-guard.mjs`; Athena never imports or
calls loop-guard directly. `spawn`, `monitor`, and `integrate` use the runner's
`recover` policy because blindly re-running any of them can delete worktrees,
duplicate supervisors, or merge the same branch twice.

```javascript
// AO-CONTRACT:runner-init
import {
  initPipeline, enterPhase, beginAttempt, reattempt, loopTick,
  recordPhaseError, recordPhaseOutputs, completePhase, skipPhase,
  reopenPhase, getPipelineState, isComplete,
} from './scripts/lib/phase-runner.mjs';
import {
  addEvent, appendUserTaskUpdate, createRun, finalizeRun, getActiveRunId,
  getRun, getRunReviewBasePin, getUserTaskUpdates, pinRunReviewBase,
} from './scripts/lib/run-artifacts.mjs';
import { loadAutonomyConfig, resolveRunShipMode } from './scripts/lib/autonomy.mjs';
import { recoverOrphanedRun } from './scripts/lib/orphan-run-recovery.mjs';
import { loadCheckpoint, saveCheckpoint } from './scripts/lib/checkpoint.mjs';
import { loadRuntimeSessionIdentity } from './scripts/lib/runtime-permissions.mjs';
import {
  getCurrentSessionId,
  getSession,
  isSessionAlive,
} from './scripts/lib/session-registry.mjs';

const currentAthenaRequest = <user_request>;
if (typeof currentAthenaRequest !== 'string' || !currentAthenaRequest.trim()) {
  throw new Error('Athena current user request is unavailable; stop before creating or resuming a run');
}
const pendingCheckpoint = await loadCheckpoint('athena');
const activeAthenaRunId = getActiveRunId('athena');
const orphanRecovery = !activeAthenaRunId && pendingCheckpoint?.runId
  ? recoverOrphanedRun('athena', pendingCheckpoint.runId)
  : null;
if (orphanRecovery && !orphanRecovery.ok && !orphanRecovery.canCreateNewRun) {
  throw new Error(`Athena active-run recovery conflict: ${orphanRecovery.reason}; preserve all artifacts and stop`);
}
// canCreateNewRun is true only for an exact terminal summary revalidated under
// the transition lock. A missing run directory is not worker-liveness proof.
// Unknown, absent, corrupt, linked, or identity-unproven evidence stops here;
// no Task/Agent dispatch, adapter spawn, or native teammate launch may follow.
const recoveredCheckpointRunId = orphanRecovery?.ok ? orphanRecovery.runId : null;
const createdAthenaRun = (activeAthenaRunId || recoveredCheckpointRunId)
  ? null
  : createRun('athena', currentAthenaRequest);
if (createdAthenaRun && !createdAthenaRun.ok) {
  throw new Error(`Athena run creation failed: ${createdAthenaRun.reason}; preserve all artifacts and stop`);
}
const runId = activeAthenaRunId
  || recoveredCheckpointRunId
  || createdAthenaRun.runId;
// Native Claude teammates exist only inside the Claude session that launched
// them. The project-scoped current-session pointer is conservative: a missing
// pointer or a concurrent session that moved it makes native ownership
// unprovable and therefore fail-closed. Adapter supervisors do not use this
// fence because their on-disk generation is independently recoverable.
const readClaudeSessionBinding = () => {
  const currentSessionId = getCurrentSessionId();
  const originSessionId = getRun(runId).summary?.sessionId;
  // Session identity intentionally ignores the permission-upgrade cache's
  // 30-minute TTL. It authorizes nothing by itself and is accepted only with
  // the same live registry session and current-session pointer below.
  const runtimeIdentity = loadRuntimeSessionIdentity({ cwd });
  const originSession = getSession(originSessionId);
  const validCurrent = typeof currentSessionId === 'string' && currentSessionId.trim().length > 0;
  const validOrigin = typeof originSessionId === 'string' && originSessionId.trim().length > 0;
  const runtimeMatches = runtimeIdentity?.source === 'hook_stdin'
    && runtimeIdentity.sessionId === originSessionId;
  const registryMatches = originSession?.sessionId === originSessionId
    && originSession.status === 'active'
    && isSessionAlive(originSessionId);
  return {
    currentSessionId: validCurrent ? currentSessionId : null,
    originSessionId: validOrigin ? originSessionId : null,
    proven: validCurrent && validOrigin && currentSessionId === originSessionId
      && runtimeMatches && registryMatches,
  };
};
// Every invocation, including a follow-up that resumes an active/recovered
// run, must atomically append the current user-authored constraint to the
// strict task ledger before the pipeline can continue. The best-effort event
// JSONL remains audit-only and is never a shipping-policy source.
const appendedTaskUpdate = appendUserTaskUpdate(runId, currentAthenaRequest, {
  allowCreate: createdAthenaRun !== null,
});
if (!appendedTaskUpdate.ok
  || appendedTaskUpdate.updates?.at(-1)?.task !== currentAthenaRequest) {
  throw new Error('Athena current user request was not durably appended; preserve the run and stop');
}
const readDurableTaskBrief = action => {
  const runRecord = getRun(runId);
  const strictUpdates = getUserTaskUpdates(runId);
  if (runRecord.summary?.runId !== runId
    || runRecord.summary?.orchestrator !== 'athena'
    || typeof runRecord.summary?.task !== 'string'
    || !runRecord.summary.task.trim()
    || strictUpdates.ok !== true
    || strictUpdates.updates.length < 1
    || strictUpdates.updates.some((update, index) => (
      update?.sequence !== index + 1
      || typeof update?.task !== 'string'
      || !update.task.trim()
    ))) {
    throw new Error(`Athena durable task provenance is unavailable before ${action}; stop outward actions`);
  }
  return [
    runRecord.summary.task,
    ...strictUpdates.updates.map(update => update.task),
  ];
};
let config;
let configuredShipMode;
let taskForbidsShipping;
let shipMode;
let noShip;
const refreshRunShipPolicy = action => {
  config = loadAutonomyConfig(process.cwd());
  const resolved = resolveRunShipMode(config, readDurableTaskBrief(action));
  configuredShipMode = resolved.configuredMode;
  taskForbidsShipping = resolved.taskForbidsShipping;
  shipMode = resolved.effectiveMode;
  noShip = shipMode === 'never';
  return { configuredShipMode, taskForbidsShipping, shipMode, noShip };
};
refreshRunShipPolicy('pipeline resume');
if (activeAthenaRunId && pendingCheckpoint?.runId && pendingCheckpoint.runId !== activeAthenaRunId) {
  throw new Error('Athena checkpoint belongs to a different active run; preserve both and stop');
}
const pipelineInit = initPipeline(runId, 'athena');
if (!pipelineInit.ok || pipelineInit.degraded) {
  throw new Error('Athena pipeline ledger is unavailable or corrupt; preserve all teams/worktrees and stop');
}
const { resumePhase, resumePolicy } = pipelineInit;
// On resume, jump to resumePhase. Earlier completed phases return skip:true;
// recover phases return reason:'recover' and MUST reconcile persisted state.
// Adopt only with the required provider/session proof; otherwise preserve it
// and stop at the runner boundary.
```

Runner consult points:
- Each phase calls `enterPhase(runId, '<id>')`; terminal phases skip, while
  successful work ends with `completePhase(runId, '<id>', outputs, {checkpointData})`.
- The first integrate attempt calls `beginAttempt`; a rejected review calls
  `reattempt(runId, {reopen:['integrate'], reason:'review_reject'})`.
- Every monitor/review/CI loop pass calls `loopTick(runId, 'monitor'|'review'|'ci')`.
- Integration failures call `recordPhaseError(runId, 'integrate', signature)`.
- Before any worker launch, `recordPhaseOutputs(runId, 'spawn', {teamSlug,
  intendedWorkers, spawnPath, adapterRunId})` persists bounded recovery identity without
  prematurely completing the phase.

**Persistence failure:** initialization with `degraded:true` is fail-closed for
Athena because resetting a ledger can destroy a live team. Preserve every
team/worktree and stop. A later guard result with `degraded:true` must likewise
preserve live state and stop at the current boundary; a healthy `allowed:false`
or `shouldEscalate:true` is authoritative.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    ATHENA LEAD                           │
│  (orchestrates, monitors, bridges, NEVER                 │
│   implements — only coordinates)                         │
└──────┬──────────────────┬──────────────┬────────────────┘
       │                  │              │
  ┌────┴────┐       ┌────┴────┐    ┌────┴────┐
  │ Claude  │       │ Codex   │    │ Gemini  │
  │ Native  │       │ Workers │    │ Workers │
  │ Team    │       │         │    │         │
  └────┬────┘       └────┬────┘    └────┬────┘
       │                  │              │
  SendMessage        lead relay via   lead relay via
  TaskList           appserver/       ACP/exec/tmux
  (native peers)      exec/tmux       message queue
```

## Steps

### Phase 0 — TRIAGE & TEAM DESIGN

**Runner entry:** `const triageGate = enterPhase(runId, 'triage')`. If it skips,
jump to the runner's `resumePhase`; otherwise perform the team design below.

#### Light-Mode Resolution (Phase 4, 2026-04-22) <!-- AO-CONTRACT:light-mode-resolution -->

Identical pattern to Atlas — resolve mode before sub-agent spawning. See
[skills/atlas/SKILL.md](../atlas/SKILL.md) "Light-Mode Resolution" for the
canonical code block (replace `[Atlas]` log prefixes with `[Athena]`).

In Athena, `skipMomus` additionally wraps the Phase 2 momus validation
(Task line ~330). Any reviewer REJECT while in light mode triggers
`autoEscalateOnReject` → `orchMode = 'full'` → re-run skipped stages before
continuing the loop.

Every light-mode rejection uses the same cap-checked policy rewind; never call
`reopenPhase()` outside this block:

```javascript
// AO-CONTRACT:light-mode-rewind
const esc = registerEscalation(runId, 'light-mode-rewind', { cap: 2 });
if (!esc.allowed) {
  // STOP and preserve the active team/run for user recovery.
} else {
  reopenPhase(runId, 'plan', { reason: 'light_mode_rewind' });
}
```
If a late reviewer triggers this after integration started, re-run the same
cap-checked rewind block. If the corrected plan changes implementation scope,
use `reattempt(runId, {reopen:['integrate'], reason:'review_reject'})` before
continuing review; never reopen `integrate` without ticking the outer cap.

#### Checkpoint Recovery

Before starting any work:
1. Resolve the active run and call `initPipeline()` before trusting the payload
   checkpoint. If the pointer is absent, `recoverOrphanedRun()` first proves a
   regular/no-follow `summary.json` with the exact running run identity and an
   existing valid Athena `pipeline.json`, then publishes the pointer with an
   exclusive create. `pipeline.json` is phase authority; the checkpoint is
   only the rich payload cache. A regex-shaped `checkpoint.runId` alone is
   never an adoption proof.
2. Check for an interrupted session: `loadCheckpoint('athena')`
3. If found, present to user: "[formatCheckpoint output]. Resume or restart?"
   - **Resume** → only when the checkpoint matched the active run or
     `orphanRecovery.ok === true`; re-run `runPreflight()` to re-evaluate
     `hasNativeTeamTools` (do NOT cache from crashed session), then skip to
     saved phase, restore `completedStories`, `activeWorkers`, `worktrees`, and
     `mergedWorkers` from checkpoint. For Phase 4+, a missing `worktrees` map
     is unsafe: stop and preserve `.ao/worktrees/<slug>/` for manual recovery;
     never infer that missing state means the branches were merged.
   - **Proven terminal old run** → only when `orphanRecovery.ok === false`
     and `canCreateNewRun === true`, do not consume the checkpoint as a resume
     payload. A new run may be created only because an exact terminal summary
     was revalidated under the transition lock.
   - **Unproven or absent run** → a missing run directory is not proof that
     native teammates, adapter supervisors, or external workers stopped.
     Missing/corrupt/symlinked summary or pipeline, identity drift, unsafe
     ancestry, an absent run directory, and unknown pre-launch state all return
     `canCreateNewRun === false`. STOP and preserve the checkpoint, any team or
     supervisor state, and all worktrees. Do not call `createRun`, dispatch an
     `Agent`/`Task`, spawn an adapter worker, or launch any native teammate.
   - **Restart** → allowed only after the old run is positively terminal or
     explicitly terminalized and its active pointer is cleared. Otherwise
     preserve state and STOP; clearing the checkpoint or observing a missing
     run directory alone never authorizes a new run or team.

#### Load Prior Wisdom
1. Run `migrateProgressTxt()` if `.ao/progress.txt` exists (one-time migration to wisdom.jsonl)
2. Call `queryWisdom(null, 20)` to get recent learnings
3. Inject into analysis context via `formatWisdomForPrompt()`

#### Auto Project Onboarding
If AGENTS.md does not exist in the project root, auto-generate it:
```
Skill(skill="agent-olympus:deepinit")
```
This runs once per project — subsequent runs skip when AGENTS.md is present.
Feed the generated AGENTS.md context into metis analysis.

#### Harness Check
After AGENTS.md is confirmed, load the harness engineering context:

```bash
test -f docs/golden-principles.md && echo "HARNESS_FOUND" || echo "HARNESS_MISSING"
```

- **HARNESS_FOUND**: Read `docs/golden-principles.md` and `docs/ARCHITECTURE.md` (if exists).
  Store as `<harness_context>` — inject inline into each worker prompt in Phase 2 spawn.
  Log: `[Athena] Harness loaded: <N> golden principles, architecture layers defined.`

- **HARNESS_MISSING**:
  - For `complex` or `architectural` tasks → suggest to user:
    `"[Athena] Harness not initialized. Run /harness-init for full setup (recommended). Proceeding without it."`
  - For trivial/moderate tasks → skip silently, proceed.

**Phase Guard — durable runner entry + preflight:**

```javascript
// Step 1: enterPhase('triage') already made the in-progress ledger durable
// before any sub-agent call. The rich checkpoint is written by completePhase.
Output: "[Athena] Phase 0: TRIAGE & TEAM DESIGN started (pipeline recorded)"

// Step 2: Clean stale .ao/ state + detect capabilities
import { runPreflight } from './scripts/lib/preflight.mjs';
const preflightReport = await runPreflight();
for (const action of preflightReport.actions) {
  Output: "[Athena] Preflight: " + action;
}
const { hasNativeTeamTools, hasCodex, hasCodexAppServer, hasCodexExecJson, hasGeminiCli, hasGeminiAcp, hasTmux } = preflightReport.capabilities;
const cwd = process.cwd();
const capabilities = preflightReport.capabilities;
import { resolveReviewBase } from './scripts/lib/review-package.mjs';
const persistedTriageOutputs = getPipelineState(runId).phases.triage?.outputs;
let pinnedReviewBase;
const durableReviewBase = getRunReviewBasePin(runId);
if (durableReviewBase.ok) {
  pinnedReviewBase = durableReviewBase.pin;
  const revalidatedBase = resolveReviewBase({
    cwd,
    baseRef: pinnedReviewBase.baseRefCommit,
  });
  if (revalidatedBase.baseRefCommit !== pinnedReviewBase.baseRefCommit) {
    throw new Error('BLOCKED: Athena immutable review-base commit no longer resolves exactly');
  }
  if (persistedTriageOutputs && (
    persistedTriageOutputs.reviewBaseRef !== pinnedReviewBase.baseRef
    || persistedTriageOutputs.reviewBaseCommit !== pinnedReviewBase.baseRefCommit
    || persistedTriageOutputs.reviewBaseSource !== pinnedReviewBase.source
  )) {
    throw new Error('BLOCKED: Athena pipeline replica disagrees with the immutable review-base pin');
  }
  const checkpointHasReviewBase = pendingCheckpoint
    && ['reviewBaseRef', 'reviewBaseCommit', 'reviewBaseSource']
      .some((key) => Object.hasOwn(pendingCheckpoint, key));
  if (checkpointHasReviewBase && (
    pendingCheckpoint.reviewBaseRef !== pinnedReviewBase.baseRef
    || pendingCheckpoint.reviewBaseCommit !== pinnedReviewBase.baseRefCommit
    || pendingCheckpoint.reviewBaseSource !== pinnedReviewBase.source
  )) {
    throw new Error('BLOCKED: Athena checkpoint disagrees with the immutable review-base pin');
  }
} else {
  if (!createdAthenaRun || triageGate.skip) {
    throw new Error(`BLOCKED: Athena resumed without a valid immutable review-base pin (${durableReviewBase.reason})`);
  }
  const resolvedReviewBase = resolveReviewBase({ cwd });
  const pinned = pinRunReviewBase(runId, resolvedReviewBase);
  if (!pinned.ok) {
    throw new Error(`BLOCKED: Athena could not durably pin the review base before analysis (${pinned.reason})`);
  }
  pinnedReviewBase = pinned.pin;
}
const pinnedReviewBaseCommit = pinnedReviewBase.baseRefCommit;
import { formatCapabilityReport } from './scripts/lib/preflight.mjs';
Output: formatCapabilityReport(preflightReport.capabilities, { orchestrator: 'Athena' })

// Step 3: Guard input size
import { prepareSubAgentInput, checkInputSize } from './scripts/lib/input-guard.mjs';
const inputCheck = checkInputSize(<combined_input>, 'opus');
if (!inputCheck.safe) {
  Output: "[Athena] L-scale input detected (" + inputCheck.lines + " lines, ~" + inputCheck.tokens + " tokens)"
  const prepared = prepareSubAgentInput(<combined_input>, 'opus', <source_file_path>);
  Output: "[Athena] Structural summary: " + prepared.originalLines + " → " + countLines(prepared.text) + " lines"
  <metis_input> = prepared.text
} else {
  <metis_input> = <combined_input>
}
```

Output: "[Athena] Spawning Metis for team design..."

Analyze task and design team:
```
Task(subagent_type="agent-olympus:metis", model="opus",
  prompt="Design a team:
  1. Break into INDEPENDENT work streams
  2. Each stream: scope (files), worker type, model tier, dependencies
  3. Identify coordination points
  4. Recommend team size based on AVAILABLE capabilities below

  Available capabilities:
  - Codex: <hasCodex ? 'AVAILABLE (app-server: ' + hasCodexAppServer + ', exec: ' + hasCodexExecJson + ')' : 'NOT AVAILABLE — do not assign Codex workers'>
  - Gemini: <hasGeminiCli ? 'AVAILABLE (ACP: ' + hasGeminiAcp + ')' : 'NOT AVAILABLE — do not assign Gemini workers'>
  - tmux: <hasTmux ? 'available' : 'NOT available — parallel workers need native teams'>
  - Native Teams: <hasNativeTeamTools ? 'enabled (SendMessage available)' : 'disabled (orchestrator-mediated relay)'>
  Concurrency policy:
  - Treat config/model-routing.jsonc concurrency.maxParallelTasks,
    maxClaudeWorkers, maxCodexWorkers, and maxGeminiWorkers as authoritative.
  - AO_CONCURRENCY_GLOBAL, AO_CONCURRENCY_CLAUDE, AO_CONCURRENCY_CODEX, and
    AO_CONCURRENCY_GEMINI may tighten or override those values at runtime.
  - The concurrency gate enforces the effective limits. Recommend a conservative
    team within them and never substitute a numeric cap embedded in this prompt.

  Worker assignment rules:
  - ONLY assign Codex workers if Codex is AVAILABLE above
  - ONLY assign Gemini workers if Gemini is AVAILABLE above
  - If unavailable, assign those tasks to Claude instead (universal fallback)
  - Codex best for: algorithms, large refactoring, batch code transformations, cross-validation
  - Gemini best for: visual/multimodal, design review, creative tasks
  - Trivial tasks: Claude only, no external models needed
  - Claude handles everything else

  Prior learnings: <formatWisdomForPrompt()>
  Task: <user_request>")
```

**Sub-agent output validation — MANDATORY:** <!-- AO-CONTRACT:subagent-validation -->

After Metis returns, validate before proceeding:
```
metis_output = <result from Metis Task() call above>

If metis_output is empty OR does not contain worker/stream assignments:
  Output: "[Athena] ⚠ Metis returned empty/invalid team design. Retrying with reduced input..."

  // Force-summarize and retry with sonnet (more resilient to long inputs)
  import { extractStructuralSummary } from './scripts/lib/input-guard.mjs';
  const { summary } = extractStructuralSummary(<combined_input>, 100);
  metis_output = Task(subagent_type="agent-olympus:metis", model="sonnet",
    prompt="Design a team. Available: Codex=" + hasCodex + ", Gemini=" + hasGeminiCli + ". Only assign available worker types.\nBreak into independent streams with worker type and scope.\nTask summary: " + summary)

  If metis_output is STILL empty:
    Output: "[Athena] ✗ Phase 0 FAILED — Metis could not design team after retry."
    Output: "[Athena] Try: (1) split into per-phase tasks, or (2) use /atlas for sequential execution."
    import { addWisdom } from './scripts/lib/wisdom.mjs';
    await addWisdom({
      category: 'debug',
      lesson: 'Athena Phase 0 failed: Metis empty output on L-scale input (' + inputCheck.lines + ' lines).',
      confidence: 'high',
    });
    STOP — do not proceed to Phase 0.5.

Output: "[Athena] Metis team design complete — <N> workers proposed."
```

```javascript
await completePhase(runId, 'triage', {
  reviewBaseRef: pinnedReviewBase.baseRef,
  reviewBaseCommit: pinnedReviewBaseCommit,
  reviewBaseSource: pinnedReviewBase.source,
}, {
  checkpointData: {
    teamDesign: metis_output,
    completedStories: [],
    activeWorkers: [],
    reviewBaseRef: pinnedReviewBase.baseRef,
    reviewBaseCommit: pinnedReviewBaseCommit,
    reviewBaseSource: pinnedReviewBase.source,
  },
});
const contextGate = enterPhase(runId, 'context');
```

The optional context work below runs only when `!contextGate.skip`. A resumed
completed context phase is never repeated.

**[OPTIONAL] Deep Dive** — if metis classifies complexity as `complex` or `architectural` AND ambiguity > 40:
```
Skill(skill="agent-olympus:deep-dive",
  args="Run deep-dive investigation on: <user_request>
  Context from codebase scan: <explore_results>
  Return path to .ao/deep-dive-report.json when complete.")
```
Read `.ao/deep-dive-report.json` after completion. If `pipeline_ready: false`, escalate to user before proceeding.
Use `recommended_approaches[0]` and `affected_files` to inform Phase 1 team design.

**[OPTIONAL] External Context** — if metis identifies an external knowledge gap (unfamiliar API, library, or protocol):
```
Skill(skill="agent-olympus:external-context",
  args="Research external context needed for: <user_request>
  Specific gap: <identified_knowledge_gap>")
```
Broadcast the returned markdown brief to all workers via team inbox before Phase 2 spawn.

After optional context gathering (including the valid "nothing needed" case),
durably close the phase:

```javascript
await completePhase(runId, 'context', undefined, {
  checkpointData: { completedStories: [], activeWorkers: [], teamDesign: <metis_team_design> },
});
```

### Phase 0.5 — SPEC GATE (Hermes validation/creation) <!-- AO-CONTRACT:spec-gate -->

**Runner entry:** `const specGate = enterPhase(runId, 'spec')`. Run Hermes only
when `!specGate.skip`.

Output: "[Athena] Phase 0.5: SPEC GATE — validating/creating specification..."

Before team planning, ensure a structured spec exists. Hermes acts as the quality gate between triage and execution planning.

**Check for existing spec:**
```
let hermes_output;
Does .ao/prd.json exist AND is it non-empty?
```

#### Case A: .ao/prd.json exists (user ran /plan beforehand)

Hermes validates the existing spec against the current task:
```
hermes_output = Task(subagent_type="agent-olympus:hermes", model="opus",
  prompt="MODE: validate
  OUTPUT_CONTRACT: AO_SPEC_V1

  Validate this existing specification against the task and team design.

  Existing spec: <contents of .ao/prd.json>
  Task: <user_request>
  Team design: <metis_team_design>

  Check:
  1. Does the spec's problem statement match the actual task?
  2. Are user stories complete with GIVEN/WHEN/THEN acceptance criteria?
  3. Are there untestable words (robust, fast, user-friendly, seamless, efficient)?
  4. Are scope boundaries clear (goals vs non-goals)?
  5. Can stories be cleanly assigned to independent workers?

  Return exactly one AO_SPEC_V1 JSON object.
  If sufficient: verdict PASS with specMarkdown:null and prd:null.
  If updates are needed: verdict UPDATE with complete specMarkdown and prd.
  If fundamentally mismatched: verdict RECREATE with complete replacements.
  PASS only when both paired artifacts exist and the current PRD already has
  every AO_SPEC_V1 PRD field (including mode, risks, and passes:false) with
  uppercase GIVEN/WHEN/THEN criteria. A legacy /plan shape requires UPDATE.
  Paired .ao/spec.md exists: <true|false>.
  Preserve every still-valid field and set every returned story's passes to false.")
```

Never write the raw Hermes response to either artifact. The shared validation step
below preserves both existing files for PASS and writes separate typed artifacts
for UPDATE or RECREATE.

#### Case B: .ao/prd.json does NOT exist (user skipped /plan)

Hermes creates a spec from the team design:
```
hermes_output = Task(subagent_type="agent-olympus:hermes", model="opus",
  prompt="MODE: <product-feature|engineering-change|bugfix, selected from the task>
  OUTPUT_CONTRACT: AO_SPEC_V1

  Create an executable specification for this task.

  Task: <user_request>
  Team design: <metis_team_design>
  External context (if gathered): <external_context>

  Return exactly one AO_SPEC_V1 JSON object with verdict CREATE, complete
  specMarkdown, and a machine-readable prd. Every story must have a unique ID,
  a specific title, non-empty GIVEN/WHEN/THEN acceptance criteria, and passes:false.

  Product fields such as personas and outcome metrics are required only for a
  product-feature. Engineering changes and bug fixes instead emphasize invariants,
  compatibility, migration/rollback, failure behavior, and verification.

  IMPORTANT: Replace untestable words (robust, fast, user-friendly, seamless,
  efficient, intuitive) with measurable alternatives.
  Ensure stories have clear boundaries so they can be assigned to independent workers.")
```

**Sub-agent output validation and persistence (Hermes) — MANDATORY:**
```javascript
import { writeHermesSpecArtifacts } from './scripts/lib/spec-artifact.mjs';

let specArtifactResult;
try {
  specArtifactResult = writeHermesSpecArtifacts(hermes_output);
} catch (error) {
  Output: "[Athena] ⚠ Hermes returned an invalid AO_SPEC_V1 envelope — retrying once with reduced input...";
  const { extractStructuralSummary } = await import('./scripts/lib/input-guard.mjs');
  const { summary } = extractStructuralSummary(<user_request>, 100);
  hermes_output = Task(subagent_type="agent-olympus:hermes", model="sonnet",
    prompt="MODE: <same selected mode>\nOUTPUT_CONTRACT: AO_SPEC_V1\nThe prior envelope or persisted pair failed validation. Return a complete CREATE for Case B, or UPDATE/RECREATE for Case A; never PASS after artifact validation failure. Task: " + summary);
  try {
    specArtifactResult = writeHermesSpecArtifacts(hermes_output);
  } catch (retryError) {
    Output: "[Athena] ✗ Spec Gate FAILED — Hermes did not return a valid typed specification after retry.";
    await addWisdom({ category: 'debug', lesson: 'Athena Spec Gate failed: invalid AO_SPEC_V1 output after retry.', confidence: 'high' });
    STOP — do not proceed with missing or malformed artifacts.
  }
}

if (!specArtifactResult.written && <Case B: no existing PRD>) {
  STOP — PASS cannot create the missing specification.
}
Output: "[Athena] Spec gate passed — " + specArtifactResult.summary;
```

```javascript
await completePhase(runId, 'spec', undefined, {
  checkpointData: { prdSnapshot: <prd.json contents>, teamDesign: <metis_team_design> },
});
```

#### After Spec Gate

Proceed to Phase 1 with a guaranteed spec. Prometheus now receives structured requirements, not raw user intent.

### Phase 1 — PLAN

**Runner entry:** `const planGate = enterPhase(runId, 'plan')`. If skipped on
resume, reuse the durable `.ao/prd.json`; otherwise plan and validate below.

Output: "[Athena] Phase 1: PLAN — creating execution plan..."

```javascript
import { readPlanningPrdForExecution } from './scripts/lib/execution-prd-store.mjs';

// Pin the typed planning generation before any planner sees it. The same CAS
// generation is required when the approved assignments are persisted below.
const planningPrdState = readPlanningPrdForExecution({ cwd });
let approvedConsensusAssignmentPlan = null;
```

**[OPTIONAL] Consensus Plan** <!-- AO-CONTRACT:consensus-plan --> — for complex
tasks with 3 or more user stories, replace the standard Prometheus + Momus
assignment pass with the consensus-plan skill. It returns assignments only and
never writes the typed PRD:

```javascript
import { parseConsensusAssignmentPlan } from './scripts/lib/consensus-assignment-plan.mjs';
import { writeOutbox } from './scripts/lib/artifact-pipe.mjs';

const consensusRawOutput = Skill(skill="agent-olympus:consensus-plan",
  args="Run consensus planning for this task.
  OUTPUT_CONTRACT: AO_CONSENSUS_ASSIGNMENT_PLAN_V1
  Orchestrator: athena
  Source PRD generation: <planningPrdState.generation>
  Available providers: Claude=true, Codex=<hasCodex>, Gemini=<hasGeminiCli>
  Task: <user_request>
  Analysis: <metis_team_design>
  Spec: <planningPrdState.prd>
  Wisdom: <formatWisdomForPrompt()>
  External context (if gathered): <external_context>");
approvedConsensusAssignmentPlan = parseConsensusAssignmentPlan(consensusRawOutput, {
  orchestrator: 'athena',
});
// Audit copy only; never reload the fail-open archival pipe as authority.
await writeOutbox(
  runId,
  'plan',
  'consensus-assignment-plan.json',
  approvedConsensusAssignmentPlan,
);
```
If consensus-plan is used, skip the standard Prometheus + Momus steps below.
The common checked enrichment block later consumes
`approvedConsensusAssignmentPlan`; no consensus path may directly mutate
`.ao/prd.json`.

**Standard path** (fewer than 3 stories or moderate complexity):
```
Task(subagent_type="agent-olympus:prometheus", model="opus",
  prompt="Team execution plan:
  - Assign tasks to workers by name
  - For every Claude worker choose one execution agentType from:
    executor, designer, test-engineer, debugger, hephaestus, writer
  - Define parallel vs sequential order
  - Set acceptance criteria per task
  - Define handoff protocol: when Worker A finishes X, SendMessage to Worker B
  Spec: <contents of .ao/prd.json>
  Team design: <design>. Task: <user_request>
  External context (if gathered): <external_context>")
```

Quick validate:
```
Task(subagent_type="agent-olympus:momus", model="sonnet",
  prompt="Quick check: right worker types? clear scope boundaries? missing tasks?
  Plan: <plan>")
```

**Enrich the typed PRD** with worker assignments. Read the AO_SPEC_V1
`.ao/prd.json` created by the Spec Gate and preserve its `mode`, `scale`, goals,
non-goals, constraints, risks, open questions, and any mode-specific product
fields. Never replace it with a reduced execution-only object:
```json
{
  "projectName": "athena-<task-slug>",
  "mode": "engineering-change",
  "scale": "M",
  "goals": ["..."],
  "nonGoals": ["..."],
  "constraints": ["..."],
  "risks": ["..."],
  "openQuestions": [],
  "userStories": [
    {
      "id": "US-001",
      "title": "...",
      "assignedWorker": "api-worker",
      "workerType": "claude",
      "agentType": "executor",
      "scope": ["api/users.mjs", "test/users.test.mjs"],
      "acceptanceCriteria": [
        "GIVEN a valid request WHEN GET /users runs THEN it returns 200 with User[]",
        "GIVEN valid input WHEN POST /users runs THEN the user is persisted"
      ],
      "passes": false,
      "parallelGroup": "A"
    }
  ]
}
```

**Cost Estimation** — before execution, estimate and display projected cost:
```
node -e "import('./scripts/lib/cost-estimate.mjs').then(m => {
  const tiers = prd.userStories.map(s => ({ model: s.model || 'sonnet', count: 1 }));
  const est = m.estimateCost({ stories: tiers.length, modelTiers: tiers });
  console.log('Estimated cost: $' + est.estimatedCostUSD.toFixed(2));
})"
```
Display cost breakdown per model tier to user. If `.ao/autonomy.json` has `budget.warnThresholdUsd` set and estimate exceeds it, warn (but do not block — unattended mode must not be interrupted).

**PRD QUALITY RULE**: Generic criteria are FORBIDDEN.
- ❌ "Implementation is complete" / "Works correctly"
- ✅ "GIVEN a valid request WHEN GET /api/users runs THEN it returns 200 with User[]"
- ✅ "GIVEN the auth suite WHEN tests run THEN all named cases pass"

Every story also needs a machine-readable `scope` array. The current Athena
launcher is deliberately one parallel wave: every story uses the same
`parallelGroup`, scopes owned by different workers are globally disjoint,
case-folded explicit repo-relative paths, and wildcard scopes are rejected.
Cross-worker dependencies are rejected because dependent worktrees do not see
another worker's unmerged branch. Dependencies are allowed only between
stories assigned to the same worker, in dependency-first PRD order. Unsafe
traversal, duplicate ownership, overlap, and dependency cycles fail validation.
Every Claude story also persists one `agentType` chosen from the execution-only
allowlist (`executor`, `designer`, `test-engineer`, `debugger`, `hephaestus`,
`writer`). Stories assigned to the same worker must use the same role. Codex
and Gemini stories omit `agentType`; their adapter type is already explicit.

Persist the enriched superset PRD only through the hardened generation-CAS
store. It re-reads the AO_SPEC planning generation, proves only allowlisted
worker-assignment fields changed, validates the exact execution schema, and
durably replaces the authoritative file. Never call
`writeHermesSpecArtifacts()` again after enrichment; a new spec requires a
terminalized/restarted run.

```javascript
import {
  assertExecutionPrd,
  validateChangedPathsAgainstScope,
} from './scripts/lib/execution-prd.mjs';
import { buildConsensusExecutionPrd } from './scripts/lib/consensus-assignment-plan.mjs';
import { enrichExecutionPrd } from './scripts/lib/execution-prd-store.mjs';

const executionCandidate = approvedConsensusAssignmentPlan
  ? buildConsensusExecutionPrd(
      planningPrdState.prd,
      approvedConsensusAssignmentPlan,
      {
        orchestrator: 'athena',
        sourcePrdGeneration: planningPrdState.generation,
        hasCodex,
        hasGemini: hasGeminiCli,
      },
    )
  : <standard Prometheus-enriched AO_SPEC_V1 superset>;
const plannedExecutionPrdState = enrichExecutionPrd(executionCandidate, {
  cwd,
  orchestrator: 'athena',
  expectedGeneration: planningPrdState.generation,
});
const plannedExecutionPrd = plannedExecutionPrdState.prd;
assertExecutionPrd(plannedExecutionPrd, {
  orchestrator: 'athena',
  allowCompleted: false,
});
await completePhase(runId, 'plan', undefined, {
  checkpointData: { prdSnapshot: <prd.json contents>, completedStories: [], activeWorkers: [] },
});
```

### Phase 2 — SPAWN TEAM

Output: "[Athena] Phase 2: SPAWN TEAM — creating worktrees and launching workers..."

```javascript
// AO-CONTRACT:spawn-recover
const spawnGate = enterPhase(runId, 'spawn');
// spawnGate.reason === 'recover' enters the adoption policy below. It never
// falls through to blind worktree creation or worker launch.
```

**Worktree isolation** <!-- AO-CONTRACT:worktree-isolation --> (before spawning any worker):

Each worker operates in its own git worktree so parallel file changes never collide.
```javascript
import { execFileSync } from 'node:child_process';
import { createWorkerWorktree } from './scripts/lib/worktree.mjs';
import { allocateTeamRunId, monitorTeam } from './scripts/lib/worker-spawn.mjs';
import {
  assertExecutionPrd,
  buildExecutionTeamSlug,
  buildAthenaWorkerDefinitions,
} from './scripts/lib/execution-prd.mjs';
import {
  loadConcurrencyLimits,
  readActiveConcurrencyCounts,
  validateWorkerBatchConcurrency,
} from './scripts/lib/concurrency-limits.mjs';
import {
  computeAthenaWorktreeDigest,
  planAthenaSpawnRecovery,
  validateAthenaCheckpointBinding,
} from './scripts/lib/athena-recovery.mjs';
import {
  acknowledgeAthenaStart,
  allAthenaStartsAcknowledged,
  assertAthenaStartLedger,
  buildAthenaStartConfirmation,
  buildAthenaStartMessage,
  initializeAthenaStartLedger,
  markAthenaStartSent,
  planAthenaStartResume,
} from './scripts/lib/athena-start.mjs';
import { readExecutionPrd } from './scripts/lib/execution-prd-store.mjs';

const executionPrdState = readExecutionPrd({ cwd, orchestrator: 'athena' });
const prd = executionPrdState.prd;
assertExecutionPrd(prd, { orchestrator: 'athena', allowCompleted: true });
const teamSlug = buildExecutionTeamSlug(prd.projectName, { orchestrator: 'athena' });
const baseCommit = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
  encoding: 'utf-8',
}).trim();
if (!/^[a-f0-9]{40,64}$/.test(baseCommit)) {
  throw new Error('Athena requires a committed base HEAD before spawning workers');
}
const rootStatus = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], {
  encoding: 'utf-8',
}).trim();
if (rootStatus) {
  throw new Error(
    'Athena parallel worktrees must branch from a committed checkpoint; preserve current changes and use Atlas or commit before team execution',
  );
}
const workerDefinitions = buildAthenaWorkerDefinitions(prd, { allowCompleted: true })
  .map((worker) => ({
    ...worker,
    prompt: worker.stories.map((story) => [
      `${story.id}: ${story.title}`,
      `Scope:\n${story.scope.map((item) => `- ${item}`).join('\n')}`,
      `Acceptance criteria:\n${story.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}`,
    ].join('\n')).join('\n\n'),
  }));
const launchConcurrency = validateWorkerBatchConcurrency(workerDefinitions, {
  limits: loadConcurrencyLimits(),
  active: readActiveConcurrencyCounts(cwd),
});
if (!launchConcurrency.ok) {
  throw new Error(`Athena launch exceeds effective concurrency limits: ${launchConcurrency.errors.join('; ')}`);
}

// assertExecutionPrd owns story identity, assignment, provider/model, the
// one-wave group contract, dependency references/cycles, and machine-readable
// scope ownership. It rejects wildcard/unsafe paths, cross-worker dependencies,
// and overlapping scopes across every concurrently launched worker. JSON
// parsing or planner prose alone is never launch authority.

// AO-CONTRACT:spawn-progress — persist exact bounded identity BEFORE the first
// createWorkerWorktree / native Agent / fallback Agent / spawnTeam call.
const intendedWorkers = workerDefinitions.map((worker) => worker.name).sort().join(',');
const adapterOnly = workerDefinitions.every((worker) => worker.type !== 'claude');
const hasAdapterWorkers = workerDefinitions.some((worker) => (
  worker.type === 'codex' || worker.type === 'gemini'
));
const plannedSpawnPath = adapterOnly
  ? 'adapter-only'
  : (hasNativeTeamTools ? 'native-or-mixed' : 'fallback-or-mixed');
const recoverySpawnIdentity = getPipelineState(runId).phases.spawn?.outputs;
const nativeSessionRequired = plannedSpawnPath === 'native-or-mixed';
const spawnSessionBinding = readClaudeSessionBinding();
if (nativeSessionRequired && !spawnSessionBinding.proven) {
  throw new Error(
    'Athena native launch/recovery session is missing or differs from the originating Claude session; preserve all teams/worktrees and stop',
  );
}
const nativeSessionId = nativeSessionRequired
  ? spawnSessionBinding.currentSessionId
  : 'none';
// Fresh runs allocate the adapter generation before any launch. Recovery must
// reuse the exact ledger generation; it never mints a new one for the same run.
const adapterRunId = spawnGate.reason === 'recover'
  ? recoverySpawnIdentity?.adapterRunId
  : (hasAdapterWorkers ? allocateTeamRunId() : 'none');
const expectedSpawn = {
  runId,
  teamSlug,
  intendedWorkers,
  spawnPath: plannedSpawnPath,
  adapterRunId,
  nativeSessionId,
  launchState: 'not-started',
  baseCommit,
};
if (spawnGate.reason !== 'recover') {
  const spawnProgress = recordPhaseOutputs(runId, 'spawn', expectedSpawn);
  if (!spawnProgress.ok || spawnProgress.degraded) {
    throw new Error('Unable to persist exact Athena spawn recovery identity; no worker was launched');
  }
}

const spawnCheckpoint = await loadCheckpoint('athena');
const persistedSpawn = getPipelineState(runId).phases.spawn?.outputs;
const nativeSessionMatches = !nativeSessionRequired || (
  spawnSessionBinding.proven
  && persistedSpawn?.nativeSessionId === nativeSessionId
  && spawnCheckpoint?.nativeSessionId === nativeSessionId
);
if (spawnGate.reason === 'recover' && nativeSessionRequired && !nativeSessionMatches) {
  throw new Error(
    'Athena native teammate adoption is not proven in the originating Claude session; preserve state and stop without claiming adoption',
  );
}
// AO-CONTRACT:team-recover
const durableAdapterState = hasAdapterWorkers ? monitorTeam(teamSlug) : null;
const adapterTeamProof = durableAdapterState ? {
  source: 'adapter-state',
  teamSlug,
  runId: durableAdapterState.runId,
  workers: (durableAdapterState.workers || []).map((worker) => ({
    name: worker.name,
    status: worker.status,
  })),
} : null;
// TaskList is session-local and accepts no team identifier. Never query it as
// adoption evidence unless the current invocation, run summary, spawn ledger,
// and checkpoint all prove the same originating Claude session.
const nativeObservationAllowed = spawnGate.reason === 'recover'
  && nativeSessionRequired
  && nativeSessionMatches;
const nativeTaskList = nativeObservationAllowed ? TaskList() : null;
const nativeTaskItems = Array.isArray(nativeTaskList)
  ? nativeTaskList
  : (nativeTaskList?.tasks || []);
const nativeObservedWorkers = [...new Map(nativeTaskItems.map((item) => {
  const name = item.workerName || item.owner || item.name;
  return [name, { name, status: item.status }];
})).values()];
const nativeTeamProof = nativeTaskList ? {
  source: 'native-task-list',
  teamSlug,
  workers: nativeObservedWorkers,
} : null;
const recovery = planAthenaSpawnRecovery({
  recovering: spawnGate.reason === 'recover',
  expected: expectedSpawn,
  persisted: persistedSpawn,
  checkpoint: spawnCheckpoint,
  adapterOnly,
  adapterTeamProof,
  nativeTeamProof,
  cwd,
});
if (recovery.action === 'stop') {
  // Native/fallback/mixed state is never deleted when adoption is unproven.
  throw new Error(`Athena spawn recovery stopped safely: ${recovery.reason}; preserve all worktrees and supervisors`);
}
const spawnRecoveryMode = recovery.action;
if (recovery.destructiveCleanupAllowed && !adapterOnly) {
  throw new Error('Internal recovery policy violation: destructive cleanup is adapter-only');
}

// Every worktree/dispatch block below is guarded by
// `spawnRecoveryMode === 'spawn'`. Adopt mode jumps directly to Phase 3 and
// reuses `spawnCheckpoint.worktrees`; it does not recreate or delete anything.
const worktrees = {};
for (const worker of (spawnRecoveryMode === 'spawn' ? workerDefinitions : [])) {
  const info = createWorkerWorktree(cwd, teamSlug, worker.name);
  worktrees[worker.name] = {
    path: info.created ? info.worktreePath : cwd,
    branch: info.branchName,
    created: info.created,
  };
}
if (Object.values(worktrees).some((item) => !item.created || item.path === cwd)) {
  throw new Error('Athena scope enforcement requires an isolated git worktree for every worker; use Atlas when isolation is unavailable');
}
const preparedWorktrees = spawnRecoveryMode === 'adopt'
  ? spawnCheckpoint?.worktrees
  : worktrees;
const preparedWorktreeDigest = computeAthenaWorktreeDigest(preparedWorktrees);
if (!preparedWorktreeDigest) {
  throw new Error('Athena cannot bind START or execution to the prepared worktree mapping');
}
if (spawnRecoveryMode === 'spawn') {
  const worktreeProgress = recordPhaseOutputs(runId, 'spawn', {
    worktreeDigest: preparedWorktreeDigest,
  });
  if (!worktreeProgress.ok || worktreeProgress.degraded) {
    throw new Error('Athena worktree identity was not durable; dispatch remains forbidden');
  }
}

let spawnCheckpointPayload = null;
if (spawnRecoveryMode === 'spawn') {
  spawnCheckpointPayload = {
    phase: 2,
    runId,
    teamSlug,
    intendedWorkers,
    spawnPath: plannedSpawnPath,
    adapterRunId,
    nativeSessionId,
    baseCommit,
    prdGeneration: executionPrdState.generation,
    worktreeDigest: preparedWorktreeDigest,
    launchState: 'not-started',
    prdSnapshot: prd,
    completedStories: [],
    activeWorkers: workerDefinitions.map((worker) => worker.name),
    worktrees,
    mergedWorkers: spawnCheckpoint?.mergedWorkers ?? [],
  };
  const prelaunchCheckpoint = await saveCheckpoint('athena', spawnCheckpointPayload);
  if (!prelaunchCheckpoint.ok || prelaunchCheckpoint.degraded) {
    throw new Error('Unable to persist Athena pre-launch checkpoint; no worker was launched');
  }
}
```

Cross-session native recovery is intentionally not an adoption path. A future
replacement-worker path may resume from the durable task/PRD snapshot only after
it proves, for every worker, that the recorded worktree still matches its
canonical path and branch, `git status --porcelain` is empty, HEAD is a committed
descendant of `baseCommit`, and the worker result is not already integrated. It
must record a new replacement generation and new launch events; it must never
label replacement workers as the old native team. Those commit/ancestry/task
validators are not yet implemented, so the current behavior is to preserve all
artifacts and stop.

All Path A/Path B dispatch snippets below run only in `spawnRecoveryMode ===
'spawn'`. Immediately before the first actual dispatch, update
`recordPhaseOutputs(..., {launchState:'started'})` and the checkpoint. If that
write fails, launch nothing. `adopt` mode skips every dispatch block.

```javascript
if (spawnRecoveryMode === 'spawn') {
  const launchRecorded = recordPhaseOutputs(runId, 'spawn', { launchState: 'started' });
  if (!launchRecorded.ok || launchRecorded.degraded) {
    throw new Error('Athena launch state was not durable; refusing to dispatch workers');
  }
  const launchCheckpoint = await saveCheckpoint('athena', {
    ...spawnCheckpointPayload,
    launchState: 'started',
    worktrees,
  });
  if (!launchCheckpoint.ok) {
    throw new Error('Athena launch checkpoint failed; refusing to dispatch workers');
  }
}
```

Build every Claude execution prompt from one validated context renderer. It
accepts only the worker definitions returned by `buildAthenaWorkerDefinitions()`;
there is no free-form role interpolation at dispatch time:

```javascript
const claudeWorkers = workerDefinitions
  .filter((worker) => worker.type === 'claude')
  .sort((left, right) => left.name.localeCompare(right.name));

function buildClaudeWorkerExecutionContext(worker, nativeTaskIdsByStory = null) {
  if (!worker.subagentType || !worker.subagentType.startsWith('agent-olympus:')) {
    throw new Error(`Athena Claude worker ${worker.name} has no validated subagentType`);
  }
  const sharedTaskIds = nativeTaskIdsByStory === null
    ? null
    : Object.fromEntries(worker.storyIds.map((storyId) => {
      const taskId = nativeTaskIdsByStory[storyId];
      if (!taskId) throw new Error(`Athena worker ${worker.name} is missing task ID for ${storyId}`);
      return [storyId, taskId];
    }));
  return JSON.stringify({
    schemaVersion: 1,
    workerName: worker.name,
    subagentType: worker.subagentType,
    model: worker.model,
    storyIds: worker.storyIds,
    stories: worker.stories.map((story) => ({
      id: story.id,
      title: story.title,
      acceptanceCriteria: story.acceptanceCriteria,
      dependsOn: story.dependsOn || [],
    })),
    scope: worker.scope,
    worktreePath: preparedWorktrees[worker.name].path,
    branchName: preparedWorktrees[worker.name].branch,
    sharedTaskIds,
    constraints: prd.constraints,
    nonGoals: prd.nonGoals,
    baseCommit,
    protocol: {
      scope: 'Edit only scope entries and only inside worktreePath.',
      completion: 'Commit to branchName before reporting done.',
      taskLifecycle: sharedTaskIds
        ? 'Mark supplied task IDs in_progress before work and completed only after commit.'
        : 'No native shared task IDs on fallback path.',
    },
    harnessConstraints: harness_context || null,
  });
}
```

**Claude workers** — dispatch depends on runtime capabilities:

#### Path A: Native Agent Teams (`hasNativeTeamTools === true`, Claude Code 2.1.178+)

When `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set, use native team tools directly:

```
IF spawnRecoveryMode !== 'spawn' OR claudeWorkers.length === 0: skip this entire block.
// No explicit team-creation call and no deprecated team identifier argument.
// The first successful native teammate Agent launch forms the team automatically.
// It is a bootstrap handshake only: implementation cannot begin until the
// shared tasks and their IDs are durably checkpointed.
1. Select `firstWorker = claudeWorkers[0]` and launch:
   Agent(name="<first-worker>", description="Bootstrap Athena teammate",
       subagent_type=firstWorker.subagentType, model=firstWorker.model,
       run_in_background=true,
       prompt="Join the Athena team, report READY, and remain idle. Do not read,
       edit, test, or commit project files until the lead assigns your persisted
       shared tasks and sends START.")
2. After READY, record native_team_formed. If this launch fails or its outcome
   is ambiguous, preserve the run/worktrees and stop. Never switch this run to
   Path B after a native Agent launch was attempted.
3. Create the shared task graph for every PRD story:
   nativeTaskIdsByStory = {};
   for each story in PRD order:
     createdTask = TaskCreate(
       subject="<story.id>: <story.title>",
       description="<exact acceptance criteria and persisted scope>",
       activeForm="Implementing <story.id>")
     require a non-empty createdTask.taskId;
     nativeTaskIdsByStory[story.id] = createdTask.taskId;
   for each story.dependsOn:
     TaskUpdate(taskId=nativeTaskIdsByStory[story.id],
       addBlockedBy=story.dependsOn.map(id => nativeTaskIdsByStory[id]))
   TaskUpdate(taskId="<each first-worker story task>", owner="<first-worker>")
4. Build the deterministic START ledger from the exact run, execution-PRD
   generation, and prepared-worktree digest. Save every worker as `pending`
   together with `nativeTaskIdsByStory`, then re-read it before START:
   const nativeTaskCheckpoint = await saveCheckpoint('athena', {
     ...spawnCheckpointPayload,
     launchState: 'started',
     nativeTaskIdsByStory,
     nativeStartLedger: initializeAthenaStartLedger({
       runId,
       nativeSessionId,
       prdGeneration: executionPrdState.generation,
       worktreeDigest: preparedWorktreeDigest,
       workerNames: claudeWorkers.map((worker) => worker.name),
     }),
     worktrees,
   });
   if (!nativeTaskCheckpoint.ok || nativeTaskCheckpoint.degraded) {
     throw new Error('Athena shared task IDs were not durable; keep the bootstrap teammate idle and stop');
   }
   const persistedNativeTasks = await loadCheckpoint('athena');
   if (JSON.stringify(persistedNativeTasks?.nativeTaskIdsByStory)
     !== JSON.stringify(nativeTaskIdsByStory)
     || !assertAthenaStartLedger(persistedNativeTasks?.nativeStartLedger)
     || persistedNativeTasks.nativeStartLedger.nativeSessionId !== nativeSessionId
     || persistedNativeTasks.nativeStartLedger.prdGeneration !== executionPrdState.generation
     || persistedNativeTasks.nativeStartLedger.worktreeDigest !== preparedWorktreeDigest) {
     throw new Error('Athena task/START pending checkpoint could not be re-read; do not send START');
   }
   Failure is fatal and no implementation message or additional Agent launch follows.
5. After the durable re-read, derive the one canonical context per worker:
   `claudeExecutionContextByWorker = new Map(claudeWorkers.map(worker =>
   [worker.name, buildClaudeWorkerExecutionContext(worker, nativeTaskIdsByStory)]))`.
   Launch every remaining Claude worker in parallel:
   Agent(name="<worker>", description="Execute assigned Athena stories",
       subagent_type=worker.subagentType, model=worker.model,
       run_in_background=true,
       prompt="Join the formed Athena team, report READY, and remain idle. Do
       not read, edit, test, or commit project files until the lead assigns
       your persisted shared tasks and sends START.")
   After each successful READY, assign that worker's shared tasks with
   TaskUpdate(taskId="...", owner="<worker>") and record native_teammate_spawned.
6. Re-read `assignedNativeTasks = TaskList()` and, for every Claude story,
   require the entry whose ID is `nativeTaskIdsByStory[story.id]` to have
   `owner === story.assignedWorker`. A missing/mismatched owner stops the run
   with every teammate idle. A plain START, task-ID-only message, or START
   before verified ownership is forbidden. Continue through the durable
   handshake below; do not authorize edits directly from this step. Each
   worker must eventually use
   TaskUpdate(taskId="...", status="in_progress") and, only after its clean
   committed branch is ready, TaskUpdate(taskId="...", status="completed").

If any later launch, task assignment, or START delivery fails, preserve the live
team and worktrees and stop at the runner recovery boundary. Never relaunch an
existing worker or silently convert a partially formed native team into fallback.
```

The step-4 durability boundary is concrete and occurs before any START message
or non-bootstrap Agent call.

**Durable native START/ACK handshake (fresh launch and same-session recovery):**

This block runs for Path A when `spawnRecoveryMode` is either `spawn` or
`adopt`. On `adopt`, it launches no Agent and creates no tasks; it uses the
checkpointed roster/tasks and the already-proven `TaskList()` adoption only.

```javascript
let nativeStartCheckpoint = await loadCheckpoint('athena');
let nativeStartLedger = nativeStartCheckpoint?.nativeStartLedger;
assertAthenaStartLedger(nativeStartLedger);
if (nativeStartCheckpoint.runId !== runId
  || nativeStartCheckpoint.nativeSessionId !== nativeSessionId
  || nativeStartLedger.nativeSessionId !== nativeSessionId
  || nativeStartLedger.prdGeneration !== executionPrdState.generation
  || nativeStartLedger.worktreeDigest !== preparedWorktreeDigest) {
  throw new Error('Athena START recovery identity/session mismatch; preserve the native team and stop');
}
const startRecovery = planAthenaStartResume(nativeStartLedger, { nativeSessionId });
const claudeExecutionContextByWorker = new Map(claudeWorkers.map((worker) => [
  worker.name,
  buildClaudeWorkerExecutionContext(worker, nativeStartCheckpoint.nativeTaskIdsByStory),
]));

// pending and sent both retry the exact same deterministic token. Persisting
// `sent` happens after delivery: a crash between the two leaves `pending`, so
// same-session recovery safely resends instead of guessing whether it arrived.
for (const workerName of startRecovery.resendStart) {
  SendMessage({
    to: workerName,
    summary: 'Deliver deterministic START context',
    message: buildAthenaStartMessage(
      nativeStartLedger,
      workerName,
      claudeExecutionContextByWorker.get(workerName),
    ),
  });
  nativeStartLedger = markAthenaStartSent(nativeStartLedger, workerName);
  const sentCheckpoint = await saveCheckpoint('athena', {
    ...nativeStartCheckpoint,
    nativeStartLedger,
  });
  if (!sentCheckpoint.ok || sentCheckpoint.degraded) {
    throw new Error('Athena START delivery state was not durable; preserve the team for same-session retry');
  }
  nativeStartCheckpoint = await loadCheckpoint('athena');
  assertAthenaStartLedger(nativeStartCheckpoint?.nativeStartLedger);
  nativeStartLedger = nativeStartCheckpoint.nativeStartLedger;
}

// Teammates must emit exactly `START_ACK <token>` and remain idle. For each
// incoming teammate message, bind the sender and exact content below. No file
// read/edit/test/commit is authorized until the resulting `acked` ledger is
// saved and re-read, after which START_CONFIRMED releases that one worker.
for (const { sender: workerName, content: ackMessage } of <incoming START_ACK messages>) {
  nativeStartLedger = acknowledgeAthenaStart(nativeStartLedger, {
    workerName,
    nativeSessionId,
    message: ackMessage,
  });
  const ackCheckpoint = await saveCheckpoint('athena', {
    ...nativeStartCheckpoint,
    nativeStartLedger,
  });
  if (!ackCheckpoint.ok || ackCheckpoint.degraded) {
    throw new Error('Athena START ACK was not durable; keep the teammate idle');
  }
  nativeStartCheckpoint = await loadCheckpoint('athena');
  assertAthenaStartLedger(nativeStartCheckpoint?.nativeStartLedger);
  nativeStartLedger = nativeStartCheckpoint.nativeStartLedger;
  SendMessage({
    to: workerName,
    summary: 'Confirm acknowledged START',
    message: buildAthenaStartConfirmation(nativeStartLedger, workerName),
  });
}

// A crash after confirmation replays START_CONFIRMED only; it never reopens a
// second execution. A cross-session invocation fails inside planAthenaStartResume.
for (const workerName of startRecovery.resendConfirmation) {
  SendMessage({
    to: workerName,
    summary: 'Replay START confirmation',
    message: buildAthenaStartConfirmation(nativeStartLedger, workerName),
  });
}
if (!allAthenaStartsAcknowledged(nativeStartLedger)) {
  throw new Error('Athena cannot complete spawn until every START ACK is durably checkpointed');
}
```

#### Path B: Fallback (`hasNativeTeamTools === false` before any native launch)

When native teams are unavailable, Claude workers are spawned as independent subagents:

```
IF spawnRecoveryMode !== 'spawn' OR claudeWorkers.length === 0: skip this entire block.
For each Claude worker:
  1. Read `{ path: worktreePath, branch: branchName }` from `worktrees[worker.name]` created above.
  2. Agent(description="Execute isolated Athena stories",
       subagent_type=worker.subagentType, model=worker.model,
       run_in_background=true,
       prompt="START\n" + buildClaudeWorkerExecutionContext(worker, null))
```

Note: In Path B, Claude workers are independent batch executors — no inter-worker SendMessage.
The orchestrator bridges communication by reading worker outputs and injecting context into subsequent tasks.

<!-- AO-CONTRACT:provider-lifecycle:start -->
**Codex/Gemini workers** (batch executors — canonical adapter spawn):

The adapter is selected automatically based on detected capabilities. Do not
launch these workers with ad-hoc tmux commands: create their descriptors once,
then pass the whole external-worker batch through `spawnTeam()`. The same
`teamSlug`, `cwd`, and `capabilities` are reused by Phase 3 monitoring and
provider failover.

- Codex: codex-appserver → codex-exec → tmux
- Gemini: gemini-acp → gemini-exec → tmux

```javascript
import { spawnTeam } from './scripts/lib/worker-spawn.mjs';

const externalWorkers = workerDefinitions
  .filter((worker) => worker.type === 'codex' || worker.type === 'gemini')
  .map((worker) => ({
    ...worker,
    // These come from createWorkerWorktree() above. Passing them into
    // spawnTeam preserves branch affinity across provider replacement.
    cwd: worktrees[worker.name]?.path || cwd,
    worktreePath: worktrees[worker.name]?.created ? worktrees[worker.name].path : null,
    branchName: worktrees[worker.name]?.created ? worktrees[worker.name].branch : null,
    prompt: [
      worker.prompt,
      worktrees[worker.name]?.created
        ? `MANDATORY WORKTREE: ${worktrees[worker.name].path}\nWork only in this directory and commit the completed changes to ${worktrees[worker.name].branch} before reporting success.`
        : 'Work in the current project directory; no isolated worktree was created.',
    ].join('\n\n'),
  }));

const externalTeamState = externalWorkers.length === 0
  ? null
  : (spawnRecoveryMode === 'spawn'
    ? await spawnTeam(teamSlug, externalWorkers, cwd, capabilities, { runId: adapterRunId })
    : (spawnRecoveryMode === 'adopt' ? monitorTeam(teamSlug) : null));
if (hasAdapterWorkers && externalTeamState?.runId !== adapterRunId) {
  throw new Error('Athena adapter state belongs to a stale team generation; preserve both generations and stop');
}
```

Adapter details (owned by `spawnTeam`, not reimplemented in this skill):

**Codex workers:**

The adapter is selected automatically based on detected capabilities:
- **codex-appserver adapter** (preferred): Multi-turn JSON-RPC 2.0 via `codex app-server`. Thread/turn lifecycle, live steering, structured errors. Requires `hasCodexAppServer`.
- **codex-exec adapter**: Single-turn `codex exec --json` via child_process.spawn. Structured JSONL events. Requires `hasCodexExecJson`.
- **tmux adapter** (fallback): Legacy tmux-based `codex exec`. Used when neither exec-json nor app-server is available.

**Gemini workers** (for visual/multimodal tasks — spawned via adapter):

The adapter is selected automatically based on detected capabilities (highest priority first):
- **gemini-acp adapter** (preferred): Multi-turn JSON-RPC 2.0 via `gemini --acp`. Session lifecycle, message queue for team communication. Requires `hasGeminiAcp`.
- **gemini-exec adapter**: Single-turn `gemini --output-format json -p` via child_process.spawn. Requires `hasGeminiCli`.
- **tmux adapter** (fallback): Legacy tmux-based `gemini -p`. Used when neither ACP nor exec is available.

Workers must commit their changes to their branch before signalling completion.

**Inbox/Outbox** (Claude workers only):
```
.ao/teams/<slug>/<worker>/inbox/    — messages TO Claude worker
.ao/teams/<slug>/<worker>/outbox/   — messages FROM Claude worker
```
Note: Codex workers do NOT read inbox — they are batch executors. Use task chaining for iterative work.
Note: Gemini ACP workers receive messages via `enqueueMessage()` → auto-drain on turn completion. Gemini exec/tmux workers are batch executors like Codex.

```javascript
const activeWorktrees = spawnRecoveryMode === 'adopt'
  ? spawnCheckpoint.worktrees
  : worktrees;
if (hasAdapterWorkers && !/^[a-f0-9]{16}$/.test(adapterRunId || '')) {
  throw new Error('Athena adapter team generation is missing; preserve the team and stop');
}
if (!activeWorktrees || typeof activeWorktrees !== 'object') {
  throw new Error('Athena spawn has no durable worktree mapping; preserve workers and stop');
}
const worktreeDigest = computeAthenaWorktreeDigest(activeWorktrees);
if (!worktreeDigest) {
  throw new Error('Athena worktree mapping is invalid or cannot be bound to a digest');
}
if (worktreeDigest !== preparedWorktreeDigest) {
  throw new Error('Athena worktree mapping changed after START identity was prepared');
}
const durableNativeStart = plannedSpawnPath === 'native-or-mixed'
  ? await loadCheckpoint('athena')
  : null;
if (durableNativeStart && (
  durableNativeStart.nativeSessionId !== nativeSessionId
  || durableNativeStart.prdGeneration !== executionPrdState.generation
  || durableNativeStart.worktreeDigest !== worktreeDigest
  || !assertAthenaStartLedger(durableNativeStart.nativeStartLedger)
  || !allAthenaStartsAcknowledged(durableNativeStart.nativeStartLedger)
)) {
  throw new Error('Athena native START handshake is not durably complete; preserve the team and stop');
}
const spawnCompletion = await completePhase(runId, 'spawn', {
  launchState: 'durable',
  worktreeDigest,
  adapterRunId,
  nativeSessionId,
  prdGeneration: executionPrdState.generation,
}, {
  checkpointData: {
    runId,
    teamSlug,
    intendedWorkers,
    spawnPath: plannedSpawnPath,
    baseCommit,
    launchState: 'durable',
    worktreeDigest,
    adapterRunId,
    nativeSessionId,
    prdGeneration: executionPrdState.generation,
    ...(durableNativeStart ? {
      nativeTaskIdsByStory: durableNativeStart.nativeTaskIdsByStory,
      nativeStartLedger: durableNativeStart.nativeStartLedger,
    } : {}),
    prdSnapshot: <prd.json>,
    completedStories: [],
    activeWorkers: <spawned worker names>,
    worktrees: activeWorktrees,
    mergedWorkers: spawnCheckpoint?.mergedWorkers ?? [],
  },
});
if (!spawnCompletion.ok || spawnCompletion.degraded) {
  throw new Error('Athena spawn completion was not durable; preserve the live team and worktrees for recovery');
}
```

### Phase 3 — MONITOR & COORDINATE (loop until all complete)

```javascript
// AO-CONTRACT:monitor-recover
const monitorGate = enterPhase(runId, 'monitor');
// reason:'recover' reuses the persisted teamSlug/worktrees and polls only that
// team. Adapter generations are process-independent; a native roster is usable
// only under the originating-session fence below. This phase never creates a
// worktree, dispatches Agent, or calls spawnTeam.
const monitorCheckpoint = await loadCheckpoint('athena');
const monitorSpawnIdentity = getPipelineState(runId).phases.spawn?.outputs;
const phase3TeamSlug = monitorSpawnIdentity?.teamSlug;
const phase3IntendedWorkers = monitorSpawnIdentity?.intendedWorkers;
const phase3SpawnPath = monitorSpawnIdentity?.spawnPath;
const phase3AdapterRunId = monitorSpawnIdentity?.adapterRunId;
const phase3NativeSessionId = monitorSpawnIdentity?.nativeSessionId;
const phase3BaseCommit = monitorSpawnIdentity?.baseCommit;
const phase3WorktreeDigest = monitorSpawnIdentity?.worktreeDigest;
if (!validateAthenaCheckpointBinding(monitorCheckpoint, monitorSpawnIdentity, { cwd })
  || monitorCheckpoint.worktreeDigest !== phase3WorktreeDigest) {
  throw new Error('Athena monitor checkpoint does not belong to this run/team; preserve all workers and stop');
}
const monitorSessionBinding = readClaudeSessionBinding();
if (phase3SpawnPath === 'native-or-mixed' && (
  !monitorSessionBinding.proven
  || phase3NativeSessionId !== monitorSessionBinding.currentSessionId
  || monitorCheckpoint.nativeSessionId !== phase3NativeSessionId
)) {
  throw new Error(
    'Athena cannot monitor/adopt native teammates outside their originating Claude session; preserve state and stop',
  );
}
const monitorWorktrees = monitorCheckpoint.worktrees;
if (!monitorWorktrees || typeof monitorWorktrees !== 'object') {
  throw new Error('Athena monitor checkpoint lacks worktree mappings; preserve all workers and stop');
}
```

**Progress Briefing** — output periodic status during monitoring:
- After each monitoring iteration, output a compact team status:
  ```
  ┌ Athena Progress ────────────────────────────────
  │ Workers: 3/5 done │ Stories: 4/6 │ Elapsed: 8m
  │ ✓ api-worker (done)    ✓ test-writer (done)
  │ ✓ ui-worker (done)     ▶ codex-1 (implementing)
  │ ◎ integrator (waiting for codex-1)
  └─────────────────────────────────────────────────
  ```
- Log each worker state transition:
  `[Athena] api-worker: implementing → testing`
  `[Athena] codex-1: ✓ done (3m 42s)`
- If any worker is in the same state for 3+ iterations, flag it:
  `[Athena] ⚠ ui-worker stuck in 'implementing' for 3 iterations`

```
┌─→ MONITOR LOOP (adapts to spawn path used)
│   loopTick(runId, 'monitor')
│     → if !allowed: stop monitoring, force-collect results + escalate any stalled workers
│
│   IF Path A (native teams):
│     Check TaskList() for Claude worker status [LLM tool call; zero arguments]
│     If TaskList shows a worker with no progress for 5+ minutes → treat as stalled
│
│   IF Path B (fallback):
│     Claude workers are independent agents — check if they returned results
│     No TaskList available — rely on agent completion signals
│
│   ALWAYS (both paths):
│     Check Codex worker output (via adapter — codex-exec JSONL or tmux pane)
│     Check Gemini worker output (via adapter — gemini-exec JSONL, ACP message queue, or tmux pane)
│     ├─ Claude completes something Codex/Gemini needs → include in next task chain prompt
│     ├─ Codex/Gemini completes something Claude needs →
│     │     Path A: SendMessage to Claude worker
│     │     Path B: include in next agent prompt (no SendMessage available)
│     ├─ Codex worker exhausted → retry once if unavailable, then Gemini, then Claude
│     ├─ Gemini worker exhausted → retry once if unavailable, then Claude executor
│     ├─ Worker blocked → unblock or escalate
│     └─ All done? → proceed to Phase 4
└── Loop until all workers done or loopTick('monitor') returns !allowed (cap 10)
```

**Worker execution & monitoring model (supervisor).** <!-- AO-CONTRACT:provider-failover --> Non-tmux adapter workers (codex-exec, codex-appserver, claude-cli, gemini-exec, gemini-acp) do NOT run in your process — `spawnTeam()` launches a **detached supervisor** per worker that owns the adapter and writes its completion/failure/output to disk. So the canonical monitor loop is:

```javascript
import { execFileSync } from 'node:child_process';
import {
  collectResults,
  completeClaudeFallback,
  dispatchProviderFallback,
  monitorTeam,
  pollProviderFallback,
  reassignProvider,
  shutdownTeam,
} from './scripts/lib/worker-spawn.mjs';

const providerTeamsToShutdown = new Set(monitorCheckpoint.providerTeamsToShutdown || []);
const monitorTick = loopTick(runId, 'monitor');
if (!monitorTick.allowed) {
  // Force-collect available output, record stalled workers, and STOP without
  // completing the monitor phase. Resume retains the same bounded counter.
}
const status = phase3AdapterRunId === 'none'
  ? null
  : monitorTeam(phase3TeamSlug);
if (phase3AdapterRunId !== 'none' && status?.runId !== phase3AdapterRunId) {
  throw new Error('Athena monitor observed a stale adapter generation; preserve both generations and stop');
}
for (const w of status?.workers || []) {
  // w.status: 'running' | 'completed' | 'failed'
  // w.errorReason / w.errorMessage: set for failures (mcp_auth/auth_failed/rate_limited/crash/timeout/…)
  // w.lastOutput: latest snapshot output tail
}
const results = status ? collectResults(phase3TeamSlug) : {};  // durable supervisor output
for (const w of (status?.workers || []).filter((worker) => worker.status === 'failed')) {
  const fallback = await reassignProvider(
    phase3TeamSlug,
    w.name,
    w.originalPrompt,
    { category: w.errorReason, message: w.errorMessage },
  );
  if (!fallback.targetProvider) continue;
  const dispatched = await dispatchProviderFallback(fallback, cwd, capabilities);
  const progress = await pollProviderFallback(dispatched, cwd, capabilities);
  for (const childTeam of progress.teamNames || []) providerTeamsToShutdown.add(childTeam);
  if (progress.status === 'running') continue;
  if (progress.status === 'completed') {
    results[w.name] = progress.output;
  }
  if (progress.status === 'claude-task') {
    const replacementWorker = progress.dispatched.replacementWorker;
    const replacementCwd = replacementWorker.worktreePath || replacementWorker.cwd || cwd;
    const claudeOutput = Task(subagent_type="agent-olympus:executor", model="sonnet",
      prompt=`${replacementWorker.prompt}\n\nMANDATORY WORKTREE: ${replacementCwd}\nWork only in this directory; preserve the existing branch, commit completed changes before returning, and do not edit the project root.`)
    await completeClaudeFallback(progress.dispatched, claudeOutput);
    results[w.name] = claudeOutput;
  }
}
// Cleanup is terminal-only. Running children remain registered for the next
// fresh-process monitor iteration.
if (status?.workers.every((worker) => worker.status === 'completed')) {
  for (const childTeam of providerTeamsToShutdown) await shutdownTeam(childTeam, cwd);
}
```

`monitorTeam` classifies supervisor workers from their disk snapshot. Actual retry/failover is owned by `reassignProvider()` + `dispatchProviderFallback()` + `pollProviderFallback()` so every retry is a new execution. You do NOT need to `capturePane` supervisor workers. The per-worker `capturePane` + `detectCodexError` snippets below are the **tmux-fallback path** only.
<!-- AO-CONTRACT:provider-lifecycle:end -->

**Legacy checkpoint recovery only (pre-canonical tmux sessions):**

Do **not** run the snippets below for workers created by the Phase 2
`spawnTeam()` call: `monitorTeam()` already classifies its tmux fallback and the
canonical loop above owns reassignment. Use this section only when resuming an
older checkpoint that contains a raw tmux session name but has no matching
`team-<teamSlug>.json` state.

**Codex failure detection and provider fallback:**

During each monitoring iteration, for every active **tmux** Codex worker, pass its pane output to `detectCodexError()` (from `scripts/lib/worker-spawn.mjs`):

```javascript
import { detectCodexError } from './scripts/lib/worker-spawn.mjs';
import { reportWorkerStatus } from './scripts/lib/worker-status.mjs';

// Inside the monitoring loop, for each Codex worker:
const paneOutput = capturePane(codexSession, 200);
const errorCheck = detectCodexError(paneOutput);

if (errorCheck.failed) {
  // Update status dashboard immediately
  reportWorkerStatus(teamName, workerName, 'failed', `Codex error: ${errorCheck.reason}`);

  // Kill tmux session and record wisdom.
  // Pass the session name explicitly to avoid the default sessionName() mismatch
  // (athena uses 'athena-<slug>-codex-N' directly, not 'omc-team-athena-...-codex-N').
  const fallback = await reassignProvider(
    teamName,
    workerName,
    originalPrompt,
    { category: errorCheck.reason, message: errorCheck.message },
    codexSession,
    { worker: failedWorker, capabilities },
  );
  const dispatched = await dispatchProviderFallback(fallback, cwd, capabilities);
  const progress = await pollProviderFallback(dispatched, cwd, capabilities);
  for (const childTeam of progress.teamNames || []) providerTeamsToShutdown.add(childTeam);

  // Report the reassignment so the status table shows the transition
  reportWorkerStatus(teamName, workerName, 'implementing', `Codex → ${fallback.targetProvider}: ${errorCheck.reason}`);

  if (progress.status === 'running') continue;
  if (progress.status === 'completed') {
    results[workerName] = progress.output;
  }
  if (progress.status === 'claude-task') {
    const replacementWorker = progress.dispatched.replacementWorker;
    const replacementCwd = replacementWorker.worktreePath || replacementWorker.cwd || cwd;
    const claudeOutput = Task(subagent_type="agent-olympus:executor", model="sonnet",
      prompt=`${replacementWorker.prompt}\n\nMANDATORY WORKTREE: ${replacementCwd}\nWork only in this directory; preserve the existing branch, commit completed changes before returning, and do not edit the project root.`)
    await completeClaudeFallback(progress.dispatched, claudeOutput);
    results[workerName] = claudeOutput;
  }
}
```

Rules:
- If `errorCheck.reason` is `'mcp_auth'`, `'auth_failed'`, `'rate_limited'`, or `'not_installed'`, do NOT retry Codex for that error type again for any worker in this session.
- Crash/timeout/network retries are OWNED by the failover chain: `planProviderFailover` already retries the same provider once before switching. Do NOT manually respawn the failed provider yourself — that would double the retry.
- Always call `await reassignProvider()` before dispatching the replacement — it handles cleanup and wisdom recording in one step.
- Never reuse the parent `teamName` for a provider replacement; `dispatchProviderFallback()` creates a distinct child team so parent state is not overwritten.

**Gemini failure detection and provider fallback:**

Apply the same pattern for Gemini workers. During each monitoring iteration, for every active Gemini worker, check adapter output for errors:

```javascript
// Inside the monitoring loop, for each Gemini worker:
// For gemini-exec: check JSONL output for error events
// For gemini-acp: check message queue for error/timeout signals
// For tmux fallback: capture pane and check for error patterns

if (geminiWorkerFailed) {
  reportWorkerStatus(teamName, workerName, 'failed', `Gemini error: ${reason}`);
  const fallback = await reassignProvider(
    teamName,
    workerName,
    originalPrompt,
    { category: reason, message: errorMessage },
    geminiSession,
    { worker: failedWorker, capabilities },
  );
  const dispatched = await dispatchProviderFallback(fallback, cwd, capabilities);
  const progress = await pollProviderFallback(dispatched, cwd, capabilities);
  for (const childTeam of progress.teamNames || []) providerTeamsToShutdown.add(childTeam);
  reportWorkerStatus(teamName, workerName, 'implementing', `Gemini → ${fallback.targetProvider}: ${reason}`);
  if (progress.status === 'running') continue;
  if (progress.status === 'completed') {
    results[workerName] = progress.output;
  }
  if (progress.status === 'claude-task') {
    const replacementWorker = progress.dispatched.replacementWorker;
    const replacementCwd = replacementWorker.worktreePath || replacementWorker.cwd || cwd;
    const claudeOutput = Task(subagent_type="agent-olympus:executor", model="sonnet",
      prompt=`${replacementWorker.prompt}\n\nMANDATORY WORKTREE: ${replacementCwd}\nWork only in this directory; preserve the existing branch, commit completed changes before returning, and do not edit the project root.`)
    await completeClaudeFallback(progress.dispatched, claudeOutput);
    results[workerName] = claudeOutput;
  }
}
```

Rules (same as Codex):
- If `reason` is `'auth_failed'`, `'quota_exceeded'`, or `'not_installed'`, do NOT retry Gemini for that error type again.
- Crash/timeout/network retries are owned by `planProviderFailover`; do not manually respawn Gemini.
- ACP-specific: if message queue shows `dead_letter` entries, treat as partial failure and collect available output before reassigning.

After checking each worker's status, record it via worker-status (import from `scripts/lib/worker-status.mjs`):
```javascript
// After each status check — call once per worker per iteration
reportWorkerStatus(teamName, workerName, phase, progressSummary)
// phase: one of planning|implementing|testing|reviewing|done|blocked|failed
// progressSummary: short free-text description of current progress
```

After the monitoring loop ends (all workers done or max iterations reached), render and output the final status table:
```javascript
const statusTable = formatStatusMarkdown(teamName)
// Output statusTable to the user so they can see per-worker phase + progress
```

After each worker completes a story, carry the integration state forward instead of replacing it.
The save is a mandatory terminal-transition boundary; if it fails, keep that
worker/worktree intact and stop without acknowledging the transition:
```javascript
const workerTerminalCheckpoint = await saveCheckpoint('athena', {
  phase: 3,
  runId,
  teamSlug: phase3TeamSlug,
  intendedWorkers: phase3IntendedWorkers,
  spawnPath: phase3SpawnPath,
  adapterRunId: phase3AdapterRunId,
  nativeSessionId: phase3NativeSessionId,
  baseCommit: phase3BaseCommit,
  launchState: 'durable',
  worktreeDigest: phase3WorktreeDigest,
  prdSnapshot: <updated prd.json>,
  completedStories: <all passing story IDs>,
  activeWorkers: <remaining in-flight workers>,
  worktrees: monitorWorktrees,
  mergedWorkers: monitorCheckpoint.mergedWorkers ?? [],
  providerTeamsToShutdown: [...providerTeamsToShutdown],
  startedAt,
  taskDescription,
});
if (!workerTerminalCheckpoint.ok || workerTerminalCheckpoint.degraded) {
  throw new Error('Athena worker terminal transition was not durable; preserve its worktree and resume monitoring');
}
```

Only after every intended Claude/Codex/Gemini worker has a durable terminal
result—not merely when `monitorTeam()` returns null or all external workers are
done—close the phase:

```javascript
const monitorCompletion = await completePhase(runId, 'monitor', {
  teamSlug: phase3TeamSlug,
  intendedWorkers: phase3IntendedWorkers,
  terminalWorkers: phase3IntendedWorkers,
  worktreeDigest: phase3WorktreeDigest,
  adapterRunId: phase3AdapterRunId,
  nativeSessionId: phase3NativeSessionId,
}, {
  checkpointData: {
    runId,
    teamSlug: phase3TeamSlug,
    intendedWorkers: phase3IntendedWorkers,
    spawnPath: phase3SpawnPath,
    adapterRunId: phase3AdapterRunId,
    nativeSessionId: phase3NativeSessionId,
    baseCommit: phase3BaseCommit,
    launchState: 'durable',
    worktreeDigest: phase3WorktreeDigest,
    prdSnapshot: <updated prd.json>,
    completedStories: <all passing story IDs>,
    activeWorkers: [],
    worktrees: monitorWorktrees,
    mergedWorkers: monitorCheckpoint.mergedWorkers ?? [],
    providerTeamsToShutdown: [...providerTeamsToShutdown],
  },
});
if (!monitorCompletion.ok || monitorCompletion.degraded) {
  throw new Error('Athena monitor completion was not durable; preserve team state for recovery');
}
```

### Phase 3b — WISDOM TRACKING

```javascript
// AO-CONTRACT:wisdom-tracking
const wisdomGate = enterPhase(runId, 'wisdom');
const wisdomCheckpoint = await loadCheckpoint('athena');
const wisdomSpawnIdentity = getPipelineState(runId).phases.spawn?.outputs;
if (!validateAthenaCheckpointBinding(wisdomCheckpoint, wisdomSpawnIdentity, { cwd })) {
  throw new Error('Athena wisdom checkpoint does not belong to this run/team; preserve state and stop');
}
```

After each worker completes, call `addWisdom()` with learnings:
```
addWisdom({ category: 'pattern',      lesson: '<codebase convention discovered>',      confidence: 'high' })
addWisdom({ category: 'architecture', lesson: '<structural decision or boundary note>', confidence: 'high' })
addWisdom({ category: 'debug',        lesson: '<pitfall encountered by this worker>',   confidence: 'high' })
addWisdom({ category: 'general',      lesson: '<coordination note for future teams>',   confidence: 'medium' })
```

Use appropriate category per learning:
- `'test'` / `'build'` / `'architecture'` / `'pattern'` / `'debug'` / `'performance'` / `'general'`

Wisdom persists across sessions so future runs benefit from team discoveries.

```javascript
const wisdomCompletion = await completePhase(runId, 'wisdom', undefined, {
  checkpointData: {
    runId,
    teamSlug: wisdomSpawnIdentity.teamSlug,
    intendedWorkers: wisdomSpawnIdentity.intendedWorkers,
    spawnPath: wisdomSpawnIdentity.spawnPath,
    adapterRunId: wisdomSpawnIdentity.adapterRunId,
    nativeSessionId: wisdomSpawnIdentity.nativeSessionId,
    baseCommit: wisdomSpawnIdentity.baseCommit,
    launchState: wisdomSpawnIdentity.launchState,
    worktreeDigest: wisdomSpawnIdentity.worktreeDigest,
    prdSnapshot: <prd.json>,
    completedStories,
    activeWorkers: [],
    worktrees: wisdomCheckpoint.worktrees,
    mergedWorkers: wisdomCheckpoint.mergedWorkers ?? [],
    providerTeamsToShutdown: wisdomCheckpoint.providerTeamsToShutdown ?? [],
  },
});
if (!wisdomCompletion.ok || wisdomCompletion.checkpointDegraded) {
  throw new Error('Unable to persist Athena worktree mapping; preserve all worker worktrees and retry checkpointing before integration');
}
```

### Phase 4 — INTEGRATE & VERIFY (loop until pass)

```javascript
// AO-CONTRACT:outer-attempt
if (getPipelineState(runId).attempt === 0) {
  const attempt = beginAttempt(runId);
  if (!attempt.allowed) {
    // STOP + escalate; do not enter integration.
  }
}
// AO-CONTRACT:integrate-recover
const integrateGate = enterPhase(runId, 'integrate');
// reason:'recover' restores worktrees/mergedWorkers from the checkpoint and
// resumes the idempotent merge loop. Missing mapping is fail-closed below.
const integrationCheckpoint = await loadCheckpoint('athena');
const integrationSpawnIdentity = getPipelineState(runId).phases.spawn?.outputs;
if (!validateAthenaCheckpointBinding(integrationCheckpoint, integrationSpawnIdentity, { cwd })) {
  throw new Error('Athena integration checkpoint does not belong to this run/team; preserve all worktrees and stop');
}
```

**Merge worker branches** (sequential, dependency order first):
```javascript
import { execFileSync } from 'node:child_process';
import { mergeWorkerBranch, removeWorkerWorktree } from './scripts/lib/worktree.mjs';
import {
  parseNulDelimitedGitPaths,
  validateChangedPathsAgainstScope,
} from './scripts/lib/execution-prd.mjs';

// Execution validation rejects cross-worker dependencies, so integration order
// is deterministic by worker identity; per-worker story dependencies were
// already executed sequentially inside that worker in PRD order.
const orderedWorkers = [...completedWorkers]
  .sort((left, right) => left.name.localeCompare(right.name));
const phase4Worktrees = integrationCheckpoint.worktrees;
const mergedWorkers = new Set(integrationCheckpoint.mergedWorkers ?? []);
const integrationProviderTeams = new Set(integrationCheckpoint.providerTeamsToShutdown ?? []);
if (!phase4Worktrees || typeof phase4Worktrees !== 'object') {
  throw new Error('Phase 4 checkpoint has no worktree mapping; preserve .ao/worktrees and recover the checkpoint before integration');
}
const integrationRootHead = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const integrationRootStatus = execFileSync('git', [
  '-C', cwd, 'status', '--porcelain=v1', '-z',
], { encoding: null });
const expectedIntegrationRootHead = mergedWorkers.size === 0
  ? integrationSpawnIdentity.baseCommit
  : integrationCheckpoint.integratedRootHead;
if (!/^[a-f0-9]{40,64}$/.test(expectedIntegrationRootHead || '')
  || integrationRootHead !== expectedIntegrationRootHead
  || integrationRootStatus.length !== 0) {
  throw new Error(
    'Athena project root changed before integration; a teammate may have escaped its worktree. Preserve every branch/worktree and stop',
  );
}

for (const worker of orderedWorkers) {
  if (mergedWorkers.has(worker.name)) continue;  // idempotent resume after a durable merge checkpoint

  const preMergeRootStatus = execFileSync('git', [
    '-C', cwd, 'status', '--porcelain=v1', '-z',
  ], { encoding: null });
  if (preMergeRootStatus.length !== 0) {
    throw new Error(`Athena project root became dirty before merging ${worker.name}; preserve state and stop`);
  }

  const { branch, path, created } = phase4Worktrees[worker.name] ?? {};
  if (!created || !branch || !path || path === cwd) {
    throw new Error(`Worker ${worker.name} lacks the isolated worktree required for scope validation`);
  }

  const dirty = execFileSync('git', ['-C', path, 'status', '--porcelain'], {
    encoding: 'utf-8',
  }).trim();
  if (dirty) {
    throw new Error(`Worker ${worker.name} completed with uncommitted work; preserve its worktree and resume integration`);
  }

  // Do not trust the prompt-level scope instruction. Prove the committed
  // worker branch changed only its persisted scope before merge. NUL framing
  // and fatal UTF-8 decoding prevent path splitting or replacement tricks.
  const changedPathBuffer = execFileSync('git', [
    '-C', cwd, 'diff', '--name-only', '-z',
    `${integrationSpawnIdentity.baseCommit}...${branch}`, '--',
  ], { encoding: null });
  const changedPaths = parseNulDelimitedGitPaths(changedPathBuffer);
  const ownedScope = prd.userStories
    .filter((story) => story.assignedWorker === worker.name)
    .flatMap((story) => story.scope);
  const scopeCheck = validateChangedPathsAgainstScope(changedPaths, ownedScope);
  if (!scopeCheck.ok) {
    throw new Error(
      `Worker ${worker.name} changed files outside its persisted scope: ${scopeCheck.outsideScope.join(', ')}`,
    );
  }

  const result = mergeWorkerBranch(cwd, branch, worker.name);
  if (!result.success) {
    // mergeWorkerBranch aborts the failed merge. Preserve the branch/worktree;
    // route the conflict through the normal bounded retry path before cleanup.
    throw new Error(`Worker ${worker.name} merge failed: ${result.conflicts.join(', ')}`);
  }
  const postMergeRootStatus = execFileSync('git', [
    '-C', cwd, 'status', '--porcelain=v1', '-z',
  ], { encoding: null });
  if (postMergeRootStatus.length !== 0) {
    throw new Error(`Athena merge for ${worker.name} left the project root dirty; preserve all integration evidence and stop`);
  }
  const postMergeRootHead = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  if (!/^[a-f0-9]{40,64}$/.test(postMergeRootHead)) {
    throw new Error(`Athena merge for ${worker.name} produced an invalid root HEAD`);
  }

  // Persist the merge before deleting its only isolated worktree. If this save
  // degrades, keep the branch/worktree; a resumed merge is idempotent.
  mergedWorkers.add(worker.name);
  // AO-CONTRACT:merge-checkpoint
  const mergeCheckpoint = await saveCheckpoint('athena', {
    phase: 4,
    runId,
    teamSlug: integrationSpawnIdentity.teamSlug,
    intendedWorkers: integrationSpawnIdentity.intendedWorkers,
    spawnPath: integrationSpawnIdentity.spawnPath,
    adapterRunId: integrationSpawnIdentity.adapterRunId,
    nativeSessionId: integrationSpawnIdentity.nativeSessionId,
    baseCommit: integrationSpawnIdentity.baseCommit,
    launchState: integrationSpawnIdentity.launchState,
    worktreeDigest: integrationSpawnIdentity.worktreeDigest,
    prdSnapshot: <prd.json>,
    completedStories,
    activeWorkers: [],
    worktrees: phase4Worktrees,
    mergedWorkers: [...mergedWorkers],
    integratedRootHead: postMergeRootHead,
    providerTeamsToShutdown: [...integrationProviderTeams],
    startedAt,
    taskDescription,
  });
  if (!mergeCheckpoint.ok) {
    mergedWorkers.delete(worker.name);
    throw new Error(`Worker ${worker.name} merged but its checkpoint could not be persisted; preserve its worktree and retry integration`);
  }

  // Only a clean, committed, successfully merged, durably checkpointed worktree is disposable.
  removeWorkerWorktree(cwd, path, branch);
}
```

Apply any remaining Codex outputs if needed:
```
Task(subagent_type="agent-olympus:executor", model="sonnet",
  prompt="Integrate Codex output: <codex_result>. Target files: <scope>")
```

**External Cross-Validation** <!-- AO-CONTRACT:cross-validation --> (per story)
— MANDATORY before marking a story `passes: true`. Prefer Codex, then Gemini,
and use only the canonical adapter lifecycle:

```javascript
import {
  allocateTeamRunId,
  collectResults,
  dispatchProviderFallback,
  monitorTeam,
  pollProviderFallback,
  reassignProvider,
  shutdownTeam,
  spawnTeam,
} from './scripts/lib/worker-spawn.mjs';
import {
  assertCrossValidationTeamState,
  buildCrossValidationRequest,
  buildCrossValidationTeamName,
  parseCrossValidationResult,
} from './scripts/lib/cross-validation.mjs';
import {
  assertReviewSnapshotCurrent,
  cleanupReviewSnapshot,
  materializeReviewSnapshot,
} from './scripts/lib/review-snapshot.mjs';

const verificationGitEvidence = buildReviewPackage({ cwd, baseRef: pinnedReviewBaseCommit });
const preferredValidationProvider = hasCodex
  ? 'codex'
  : ((hasGeminiAcp || hasGeminiCli) ? 'gemini' : null);
const validationTeamSlug = buildCrossValidationTeamName({
  orchestrator: 'athena',
  runId,
  storyId: story.id,
  reviewTreeOid: verificationGitEvidence.reviewTreeOid,
});
const validationTeamsToShutdown = new Set([validationTeamSlug]);
let validationOutput = null;
let validationProviderUsed = null;
let validationSnapshot = null;

if (preferredValidationProvider) {
  validationSnapshot = materializeReviewSnapshot({
    cwd,
    reviewTreeOid: verificationGitEvidence.reviewTreeOid,
    ownerId: validationTeamSlug,
  });
  assertReviewSnapshotCurrent(validationSnapshot, { cwd });
  const validationRequest = buildCrossValidationRequest({
    orchestrator: 'athena',
    runId,
    storyId: story.id,
    storyTitle: story.title,
    reviewTreeOid: verificationGitEvidence.reviewTreeOid,
    provider: preferredValidationProvider,
    snapshot: validationSnapshot,
    scope: story.scope,
    acceptanceCriteria: story.acceptanceCriteria,
    harnessContext: harness_context,
  });
  const existingValidationState = monitorTeam(validationTeamSlug);
  const validationState = existingValidationState
    ? assertCrossValidationTeamState(existingValidationState, validationRequest)
    : await spawnTeam(
    validationTeamSlug,
    [validationRequest.worker],
    cwd,
    capabilities,
    { runId: allocateTeamRunId() },
  );

  // Repeat this canonical monitor step at the runner boundary until terminal.
  const validationStatus = monitorTeam(validationTeamSlug);
  const validator = validationStatus?.workers?.[0];
  if (validator?.status === 'running' || validator?.status === 'retry') {
    // Persist/yield and poll this same identity again. Never stop or respawn it.
    continue;
  } else if (validator?.status === 'completed') {
    const actualProvider = validator.fallbackProvider || validator.type
      || validationState.workers[0].type;
    if (actualProvider === 'codex' || actualProvider === 'gemini') {
      assertCrossValidationTeamState(validationStatus, validationRequest);
      assertReviewSnapshotCurrent(validationSnapshot, { cwd });
      validationOutput = parseCrossValidationResult(
        collectResults(validationTeamSlug)['external-validator'],
        validationRequest.identity,
      );
      assertReviewSnapshotCurrent(validationSnapshot, { cwd });
      validationProviderUsed = actualProvider;
    }
  } else if (validator?.status === 'failed') {
    const fallback = await reassignProvider(
      validationTeamSlug,
      validator.name,
      validator.originalPrompt,
      { category: validator.errorReason, message: validator.errorMessage },
      validator.session,
      { worker: validator, capabilities },
    );
    const dispatched = await dispatchProviderFallback(fallback, cwd, capabilities);
    const progress = await pollProviderFallback(dispatched, cwd, capabilities);
    for (const childTeam of progress.teamNames || []) validationTeamsToShutdown.add(childTeam);
    if (progress.status === 'running') {
      // Persist/yield and poll the same dispatched child; cleanup is terminal-only.
      continue;
    } else if (progress.status === 'completed') {
      const actualProvider = progress.dispatched?.replacementWorker?.type;
      if (actualProvider === 'codex' || actualProvider === 'gemini') {
        assertReviewSnapshotCurrent(validationSnapshot, { cwd });
        validationOutput = parseCrossValidationResult(
          progress.output,
          validationRequest.identity,
        );
        assertReviewSnapshotCurrent(validationSnapshot, { cwd });
        validationProviderUsed = actualProvider;
      }
    }
    // A native Claude handoff is not independent external validation. Treat
    // claude-task/exhausted/ambiguous outcomes as the explicit skip below.
  }
}

for (const validationTeam of validationTeamsToShutdown) {
  await shutdownTeam(validationTeam, cwd);
}
if (validationSnapshot) {
  cleanupReviewSnapshot(validationSnapshot, {
    cwd,
    ownerId: validationTeamSlug,
  });
}
```
Every `addVerification` call must include one criterion record for every PRD
acceptance criterion, indexed from zero. Copy `criterion_text` exactly. A pass
uses `pass` for every criterion; a fail marks each failed criterion `fail` and
records fresh evidence for every remaining criterion; an unavailable validator
uses `skip` for every criterion. The top-level verdict is the exact rollup (any
fail → fail, else any skip → skip, else pass). Before the fresh post-merge
local criteria checks or external validation, build
`verificationGitEvidence = buildReviewPackage({ cwd, baseRef: pinnedReviewBaseCommit })`. Run every check with
the validator read-only against that exact snapshot, prove the tree is still
current before persistence, and bind the record to its tree OID. A failed
append or any tree mutation during validation is a hard verification failure:
```javascript
// Run the fresh post-merge criteria checks and read-only validator now, against this snapshot.
assertReviewPackageCurrent(verificationGitEvidence, { cwd });
const verificationWrite = addVerification(runId, {
  story_id: story.id,
  verdict: '<pass|fail|skip>',
  evidence: '<overall fresh evidence>',
  verifiedBy: '<codex|gemini|athena>',
  reviewTreeOid: verificationGitEvidence.reviewTreeOid,
  criteria: story.acceptanceCriteria.map((criterion_text, criterion_index) => ({
    criterion_index,
    criterion_text,
    verdict: '<criterion pass|fail|skip>',
    evidence: '<criterion-specific fresh evidence>',
  })),
});
if (!verificationWrite.ok) {
  throw new Error(`verification evidence was not persisted: ${verificationWrite.reason}`);
}
assertReviewPackageCurrent(verificationGitEvidence, { cwd });
```
- **PASS** → write the complete criterion-level record with `verdict:'pass'`,
  then transition the story through the hardened generation-CAS store (an
  explicit policy-authorized all-criteria `skip` follows the same transition):
  ```javascript
  import {
    readExecutionPrd,
    setExecutionStoryPasses,
  } from './scripts/lib/execution-prd-store.mjs';

  const storyPrdState = readExecutionPrd({ cwd, orchestrator: 'athena' });
  const passedStoryPrdState = setExecutionStoryPasses([story.id], true, {
    cwd,
    orchestrator: 'athena',
    expectedGeneration: storyPrdState.generation,
  });
  ```
- **FAIL** → write the complete criterion-level record with the correct fail rollup → route findings back to the responsible worker via inbox for fix, re-validate (max 2 cycles).
- **Codex unavailable BUT Gemini available** → the preferred-provider selection
  above starts Gemini through the same adapter lifecycle. Record the same
  complete criterion-level shape with `verifiedBy:'gemini'`.
- **Neither external provider returns a terminal independent result** → **MUST
  explicitly record the skip** with every criterion marked `skip`,
  criterion-specific evidence, and `verifiedBy:'athena'`. Log: `[Athena]
  Cross-validation skipped for <story-id>: no external validator available.`
- **Note**: Run xval against post-merge file paths, not per-worker file paths, to catch violations introduced during conflict resolution.

> **IMPORTANT**: "skip silently" does NOT mean "do nothing". Every story MUST have a verification record — pass, fail, or explicit skip. The PR verification gate will block if any story lacks a record.

Call `setExecutionStoryPasses([story.id], true, ...)` only after Codex
cross-validation passes (or is unavailable with explicit skip recorded). On a
stale generation, re-read and re-evaluate the transition; never overwrite the
file or bypass CAS. Use `passedStoryPrdState.prd` for the next checkpoint.

Run **simultaneously**: build, tests, linter.

**[OPTIONAL] Visual Verification** — if any worker's branch includes frontend file changes (`.tsx`, `.jsx`, `.vue`, `.svelte`, `.css`, `.scss`, `.html`):

1. Detect frontend changes: `BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||' || echo main); git diff --name-only "origin/$BASE...HEAD" | grep -E '\.(tsx|jsx|vue|svelte|css|scss|html)$'`
2. If found AND `.claude/launch.json` exists:
   - `preview_start(name="<dev-server>")` → `preview_screenshot()` → evaluate for blank pages, layout breakage, console errors
   - `preview_console_logs(level="error")` to detect runtime errors
   - If issues found → `Task(subagent_type="agent-olympus:designer", model="sonnet", prompt="Fix visual regression: <issue>")` → re-verify (max 2 cycles)
   - `preview_stop()` after verification
3. If no frontend changes or no preview server → skip silently
Note: This phase is OPT-IN. Requires Claude Preview MCP.

**[OPTIONAL] Quality Gate Checkpoint** — after all workers complete and before final review:
If `agent-olympus:themis` agent is available:
```
Task(subagent_type="agent-olympus:themis", model="sonnet",
  prompt="Run quality gate checks on integration output.")
```
- FAIL → debug and retry (max 2 retry cycles); debug path follows the 4-step escalation chain above
- CONDITIONAL → BLOCKED unless every unavailable check is an explicit
  policy-authorized skip already recorded in verification evidence; otherwise
  preserve the run/worktrees and do not enter review
- PASS → proceed to Phase 5
Note: Skip this checkpoint if Themis agent is absent.

```
┌─→ Internal integration fix loop (the outer attempt was opened once above)
│   ALL PASS → complete the integrate phase, then Phase 5
│   ANY FAIL →
│     recordPhaseError(runId, 'integrate', <first error line or error code>)
│       → if shouldEscalate (same error 3×): STOP + escalate, do NOT retry the same fix
│     else spawn debugger (with wisdom learnings: formatWisdomForPrompt(queryWisdom(null,10))), fix, re-verify
│   Debug escalation chain:
│     1. First attempt: spawn debugger agent
│     2. Debugger fails once: spawn debugger again with additional context from wisdom
│     3. Debugger fails twice: invoke Skill(skill="agent-olympus:systematic-debug")
│        for root-cause-first investigation
│     4. systematic-debug fails: escalate via Skill(skill="agent-olympus:trace")
│        for evidence-driven hypothesis analysis
└── Loop until ALL PASS or a Loop Guard stop signal fires (local soft budget: ~5 fix cycles)
```

Before completing `integrate`, perform a mandatory final-tree verification
sweep: build one fresh `verificationGitEvidence`, rerun every story's acceptance
criteria and read-only cross-validation against that unchanged merged tree,
append one complete record per story with
`reviewTreeOid: verificationGitEvidence.reviewTreeOid`, require every
`addVerification(...).ok === true`, and finish with
`assertReviewPackageCurrent(verificationGitEvidence, { cwd })`. Any mutation,
missing story, or failed append keeps integrate nonterminal. This sweep
supersedes records created before later workers or conflict resolution changed
the merged tree.

```javascript
// AO-CONTRACT:debug-escalation — the loop above uses recordPhaseError and the
// debugger → systematic-debug → trace escalation chain.
const isolatedWorkerNames = Object.entries(phase4Worktrees)
  .filter(([, item]) => item?.created && item.path !== cwd)
  .map(([workerName]) => workerName)
  .sort();
const mergedWorkerNames = [...mergedWorkers].sort();
if (mergedWorkerNames.join(',') !== isolatedWorkerNames.join(',')) {
  throw new Error('Athena integration cannot complete before every isolated worker is durably merged');
}
const integrationCommit = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
  encoding: 'utf-8',
}).trim();
if (!/^[a-f0-9]{40,64}$/.test(integrationCommit)) {
  throw new Error('Athena integration result lacks a committed identity');
}
const integrateCompletion = await completePhase(runId, 'integrate', {
  teamSlug: integrationSpawnIdentity.teamSlug,
  intendedWorkers: integrationSpawnIdentity.intendedWorkers,
  isolatedWorkers: isolatedWorkerNames.join(','),
  mergedWorkers: mergedWorkerNames.join(','),
  worktreeDigest: integrationSpawnIdentity.worktreeDigest,
  verificationPassed: true,
  integrationCommit,
}, {
  checkpointData: {
    runId,
    teamSlug: integrationSpawnIdentity.teamSlug,
    intendedWorkers: integrationSpawnIdentity.intendedWorkers,
    spawnPath: integrationSpawnIdentity.spawnPath,
    adapterRunId: integrationSpawnIdentity.adapterRunId,
    nativeSessionId: integrationSpawnIdentity.nativeSessionId,
    baseCommit: integrationSpawnIdentity.baseCommit,
    launchState: integrationSpawnIdentity.launchState,
    worktreeDigest: integrationSpawnIdentity.worktreeDigest,
    prdSnapshot: <prd.json>,
    completedStories,
    activeWorkers: [],
    worktrees: phase4Worktrees,
    mergedWorkers: [...mergedWorkers],
    providerTeamsToShutdown: [...integrationProviderTeams],
  },
});
if (!integrateCompletion.ok || integrateCompletion.checkpointDegraded) {
  throw new Error('Athena integration result was not durable; preserve merged branches and worktrees');
}
```

### Phase 5 — REVIEW (loop until approved)

```javascript
const reviewGate = enterPhase(runId, 'review');
const reviewCheckpoint = await loadCheckpoint('athena');
const reviewSpawnIdentity = getPipelineState(runId).phases.spawn?.outputs;
if (!validateAthenaCheckpointBinding(reviewCheckpoint, reviewSpawnIdentity, { cwd })) {
  throw new Error('Athena review checkpoint does not belong to this run/team; preserve integration state and stop');
}
```

**Step 5.0 — Consult review router (US-005)** <!-- AO-CONTRACT:review-router -->

Before fanning out, call `scripts/lib/review-router.mjs` → `routeReviewers()`
to compute the minimal reviewer set for the actual diff scope. Cuts 60-80% of
reviewer overhead while still catching security-relevant code via the
`securityPatterns` regex set.

```javascript
import {
  assertReviewPackageCurrent,
  attachReviewContext,
  buildReviewPackage,
} from './scripts/lib/review-package.mjs';
import {
  handleEscalation,
  routeReviewers,
} from './scripts/lib/review-router.mjs';
import { getRunVerificationsStrict } from './scripts/lib/run-artifacts.mjs';
import { readExecutionPrd } from './scripts/lib/execution-prd-store.mjs';

let reviewPackage;
let r;
try {
  const gitEvidence = buildReviewPackage({ cwd, baseRef: pinnedReviewBaseCommit });
  r = routeReviewers({
    diffPaths: gitEvidence.diffPaths,
    diffContent: gitEvidence.diff,
    baseDir: cwd,
  });
  if (r.reviewers.length === 0 || r.allowedReviewers.length === 0
    || r.rejectedReviewers.length > 0
    || r.reviewers.some((reviewer) => !r.allowedReviewers.includes(reviewer))) {
    throw new Error('review routing selected an empty or non-approval reviewer set');
  }
  const strictVerification = getRunVerificationsStrict(runId);
  if (!strictVerification.ok) {
    throw new Error(`review verification evidence is unsafe: ${strictVerification.reason}`);
  }
  const prd = readExecutionPrd({ cwd, orchestrator: 'athena' }).prd;
  reviewPackage = attachReviewContext(gitEvidence, {
    prd,
    verification: strictVerification.verifications,
  });
} catch (error) {
  STOP — review evidence is incomplete or unsafe; preserve integration state and do not approve.
}
```

Spawn ONLY the reviewers in `r.reviewers`, in parallel. Each receives the exact
same immutable, dual-digested `reviewPackage` and this caller instruction, which
overrides any legacy prose output format. A normal no-rule fallback warning may
be logged, but a rejected reviewer or empty active allowlist blocks the phase:

```
OUTPUT_CONTRACT: AO_REVIEW_V1
Review only the supplied reviewPackage. Return exactly one JSON object with:
schemaVersion:1, reviewer:<reviewer>,
reviewDigest:<copy reviewPackage.reviewDigest.value exactly>,
verdict:APPROVE|REVISE|REJECT|BLOCKED,
findings:[{severity:critical|high|medium|low|info, confidence:0..1,
file:string|null, line:positive-integer|null, evidence:string,
recommendation:string}], escalations:[{additionalReviewer,reason}].
APPROVE requires empty findings and escalations; every other verdict requires at
least one finding. A non-null finding.file must be in reviewPackage.diffPaths.
Copy the complete reviewDigest exactly; never substitute evidenceDigest.
Escalate only to one of: <serialized r.allowedReviewers>.
reviewPackage: <serialized reviewPackage>
```

If the diff, PRD, or verification evidence cannot be loaded, or any story is not
`passes:true` with terminal `pass`/explicit `skip` verification whose
`reviewTreeOid` exactly equals the package tree, stop as BLOCKED instead of
sending a partial package or approving from an implementer summary. Historical
records may describe older trees; the latest record for every story may not.

**Step 5.1 — Handle reviewer escalation** <!-- AO-CONTRACT:review-escalation -->

Parse and aggregate every result before acting:

```javascript
import { aggregateReviewResults } from './scripts/lib/review-contract.mjs';

const reviewRound = loopTick(runId, 'review');
if (!reviewRound.allowed) STOP and preserve the run/worktrees;

let currentReviewers = [...r.reviewers];
const rawReviewerOutputsByName = new Map();
let reviewApproved = false;
Fire every initial reviewer in parallel with reviewPackage, then store each raw
AO_REVIEW_V1 response under its bare reviewer name. Missing output remains
missing so aggregation fails closed; do not substitute summaries.
const handledEscalations = new Set();
let aggregate;
for (;;) {
  aggregate = aggregateReviewResults(rawReviewerOutputsByName, currentReviewers, {
    allowedReviewers: r.allowedReviewers,
    reviewPackage,
  });
  if (aggregate.errors.length > 0) STOP and report aggregate.errors plus findings;

  const requestersToRerun = new Set();
  for (const requestingResult of aggregate.results) {
    for (const escalation of requestingResult.escalations) {
      const escalationKey = `${requestingResult.reviewer}\0${escalation.additionalReviewer}`;
      if (handledEscalations.has(escalationKey)) {
        STOP — a reviewer repeated an already-fulfilled escalation instead of issuing a final verdict.
      }
      const routed = handleEscalation(currentReviewers, escalation, {
        allowedReviewers: r.allowedReviewers,
        baseDir: cwd,
      });
      if (routed.rejected || routed.warning) {
        STOP — rejected or downgraded escalation is a review blocker.
      }
      currentReviewers = routed.reviewers;
      if (currentReviewers.length > r.allowedReviewers.length || currentReviewers.length > 5) {
        STOP — reviewer escalation exceeded the active allowlisted bound;
      }
      if (routed.escalated) {
        spawn the additional reviewer in this same iteration with reviewPackage;
        collect its AO_REVIEW_V1 output into rawReviewerOutputsByName under its bare name;
      }
      handledEscalations.add(escalationKey);
      requestersToRerun.add(requestingResult.reviewer);
    }
  }
  if (requestersToRerun.size > 0) {
    After every requested specialist output is stored, rerun each requesting
    reviewer with those raw specialist results and the unchanged reviewPackage.
    Replace that requester's prior raw output in rawReviewerOutputsByName so its
    next response is a final verdict, not the stale escalating verdict.
    continue;
  }
  if (aggregate.verdict === 'BLOCKED') STOP and report aggregate findings;
  break;
}
if (aggregate.verdict === 'APPROVE') {
  assertReviewPackageCurrent(reviewPackage, { cwd });
  reviewApproved = true; // continue to the checkpoint-preserving completion block below
}

// AO-CONTRACT:review-reject-reattempt
if (aggregate.verdict === 'REVISE' || aggregate.verdict === 'REJECT') {
  delegate only the grounded findings to an executor/debugger scoped to the
  root integration tree; the Athena lead coordinates and never edits them itself;
  const reviewRetry = reattempt(runId, {
    reopen: ['integrate'],
    reason: 'review_reject',
  });
  if (!reviewRetry.allowed) {
    // STOP + preserve run/worktrees; the 15-attempt cap is authoritative.
  }
}
// Athena has no `verify` phase. Never target that Atlas-only phase; return through the
// integrate recovery path and then start the next review round.
```

**Rollback**: `.ao/autonomy.json` → `{ "reviewRouter": { "disabled": true } }`.

Only when `reviewApproved === true`, preserve the full Athena checkpoint and complete the phase:

```javascript
await completePhase(runId, 'review', {
  approvedReviewDigest: reviewPackage.reviewDigest.value,
  approvedReviewTreeOid: reviewPackage.reviewTreeOid,
}, {
  checkpointData: {
    runId,
    teamSlug: reviewSpawnIdentity.teamSlug,
    intendedWorkers: reviewSpawnIdentity.intendedWorkers,
    spawnPath: reviewSpawnIdentity.spawnPath,
    adapterRunId: reviewSpawnIdentity.adapterRunId,
    nativeSessionId: reviewSpawnIdentity.nativeSessionId,
    baseCommit: reviewSpawnIdentity.baseCommit,
    launchState: reviewSpawnIdentity.launchState,
    worktreeDigest: reviewSpawnIdentity.worktreeDigest,
    prdSnapshot: <prd.json>,
    completedStories,
    worktrees: reviewCheckpoint.worktrees,
    mergedWorkers: reviewCheckpoint.mergedWorkers,
    providerTeamsToShutdown: reviewCheckpoint.providerTeamsToShutdown ?? [],
  },
});
const finalizeGate = enterPhase(runId, 'finalize');
const finalizeCheckpoint = await loadCheckpoint('athena');
const finalizeSpawnIdentity = getPipelineState(runId).phases.spawn?.outputs;
if (!validateAthenaCheckpointBinding(finalizeCheckpoint, finalizeSpawnIdentity, { cwd })) {
  throw new Error('Athena finalize checkpoint does not belong to this run/team; preserve integration state and stop');
}
```

### Phase 5b — SLOP CLEAN + FINAL CONTENT

Finalize is `reexecute` on resume. Use `runId` as an idempotency marker for the
changelog and exec-plan row: update an existing row/entry for this run instead
of appending a duplicate.

Resolve the release policy before invoking any helper that can offer or perform
shipping. Explicit shipping constraints in the original task brief always take
precedence over `.ao/autonomy.json`, including `ship.mode: "auto"`.

```javascript
// This helper is initialized in the resume-aware runner setup on every skill
// invocation, even when finalize was already completed in an earlier process.
refreshRunShipPolicy('finalize release policy');
```

The orchestrator model answering its own y/n prompt is not user approval. In
`ask` mode, only an actual human response from an interactive user channel
counts as approval.

After review approved:
1. Run `Skill(skill="agent-olympus:slop-cleaner")` on all changed files
2. Re-run build + tests to verify no regression
3. **Optional branch completion**: only when `shipMode === 'auto'`, invoke
   `Skill(skill="agent-olympus:finish-branch")` for its local verification
   checklist before the final review. Explicitly stop it before any push, PR,
   merge, or option prompt. It also may not mutate source files or create commits;
   Phase 6 below is the sole owner of outward shipping actions. Skip this helper
   entirely for `never` and `ask`.

### Phase 5c — CHANGELOG UPDATE

Skip the entire changelog update when
`noShip || config.ship.updateChangelog === false`. In particular,
`ship.mode: "never"` suppresses this release side effect.

Generate or replace this run's CHANGELOG entry from the completed PRD:
```javascript
import { generateChangelogEntry } from './scripts/lib/changelog.mjs';
import { upsertChangelogEntry } from './scripts/lib/finalize-content.mjs';
import { readExecutionPrd } from './scripts/lib/execution-prd-store.mjs';

const prd = readExecutionPrd({ cwd, orchestrator: 'athena' }).prd;
const entry = generateChangelogEntry({
  prd,
  version: '<detected or specified>',
  date: new Date().toISOString().slice(0, 10),
});
upsertChangelogEntry('CHANGELOG.md', entry, { runId, cwd });
```
If no CHANGELOG.md exists, one is created. Include in the next commit.

### Phase 5d — EXEC-PLAN UPDATE

Skip the entire tracker update (including moving an active plan) when
`noShip || config.ship.updateTechDebtTracker === false`. In particular,
`ship.mode: "never"` suppresses this release side effect.

If `docs/exec-plans/` exists, upsert this run's completed plan entry:
```javascript
import { upsertTechDebtTrackerRow } from './scripts/lib/finalize-content.mjs';

upsertTechDebtTrackerRow(
  'docs/exec-plans/tech-debt-tracker.md',
  '| <date> | <task-slug> | <N files changed> | <N stories> | <one-line summary> |',
  { runId, cwd },
);
```
If an active exec-plan file exists in `docs/exec-plans/active/`, move it to
`docs/exec-plans/completed/` atomically. On resume, an existing destination with
the source absent proves the move already completed; any other collision is a
blocker rather than permission to overwrite.
Include this file in the commit.

### Phase 5e — FINAL REVIEW LOCK + COMMIT

Cleanup, changelog, tracker, and checklist activity occurred after the first
review, so that approval is not commit authority. Build Git evidence for the
final filesystem tree first. Then, without mutating it, re-run all required
checks and per-story acceptance/cross-validation against that exact snapshot
and collect one fresh record per story. Prove the snapshot is still current
before persisting those records, append them with its exact tree OID, and create
a fresh complete review package from strict evidence. Never reuse the Phase 5
package or reviewer outputs.

```javascript
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  assertReviewPackageCurrent,
  assertReviewPackageHeadTree,
  attachReviewContext,
  buildReviewPackage,
} from './scripts/lib/review-package.mjs';
import { aggregateReviewResults } from './scripts/lib/review-contract.mjs';
import { handleEscalation, routeReviewers } from './scripts/lib/review-router.mjs';
import {
  addVerification,
  beginVerificationGeneration,
  getSealedVerificationGeneration,
  getVerificationGenerationProgress,
  sealVerificationGeneration,
} from './scripts/lib/run-artifacts.mjs';
import { readExecutionPrd } from './scripts/lib/execution-prd-store.mjs';

const finalPrd = readExecutionPrd({ cwd, orchestrator: 'athena' }).prd;
const finalGitEvidence = buildReviewPackage({ cwd, baseRef: pinnedReviewBaseCommit });
assertReviewPackageCurrent(finalGitEvidence, { cwd });
const finalGenerationInput = {
  reviewTreeOid: finalGitEvidence.reviewTreeOid,
  storyIds: finalPrd.userStories.map(story => story.id),
  phase: 'final-review',
};
let finalGenerationStart = beginVerificationGeneration(runId, finalGenerationInput);
if (!finalGenerationStart.ok
  && finalGenerationStart.reason === 'different-verification-generation-already-open'
  && finalGenerationStart.currentReviewTreeOid !== finalGitEvidence.reviewTreeOid) {
  finalGenerationStart = beginVerificationGeneration(runId, finalGenerationInput, {
    supersedeGenerationId: finalGenerationStart.currentGenerationId,
  });
}
if (!finalGenerationStart.ok) {
  throw new Error(`final verification generation did not start: ${finalGenerationStart.reason}`);
}
const finalGenerationId = finalGenerationStart.generation.generationId;
const finalGenerationProgress = getVerificationGenerationProgress(
  runId,
  finalGenerationId,
);
if (!finalGenerationProgress.ok) {
  throw new Error(`final verification progress is unsafe: ${finalGenerationProgress.reason}`);
}
const missingFinalStoryIds = new Set(finalGenerationProgress.missingStoryIds);
for (const story of finalPrd.userStories.filter(item => missingFinalStoryIds.has(item.id))) {
  // Re-run this story's named acceptance criteria and independent read-only
  // cross-validation now against finalGitEvidence. Bind the concrete result;
  // no historical ledger record or prior reviewer output may populate it.
  const freshFinalRecord = {
    story_id: story.id,
    verdict: '<pass|skip exact criterion rollup>',
    evidence: '<fresh overall evidence from this final-tree sweep>',
    verifiedBy: '<codex|gemini|athena>',
    criteria: story.acceptanceCriteria.map((criterion_text, criterion_index) => ({
      criterion_index,
      criterion_text,
      verdict: '<pass|skip>',
      evidence: '<fresh criterion-specific evidence>',
    })),
  };
  assertReviewPackageCurrent(finalGitEvidence, { cwd });
  const persisted = addVerification(runId, {
    ...freshFinalRecord,
    reviewTreeOid: finalGitEvidence.reviewTreeOid,
    verificationGenerationId: finalGenerationId,
  });
  if (!persisted.ok) {
    throw new Error(`final verification evidence was not persisted: ${persisted.reason}`);
  }
}
assertReviewPackageCurrent(finalGitEvidence, { cwd });
const finalGenerationSeal = sealVerificationGeneration(runId, finalGenerationId);
if (!finalGenerationSeal.ok) {
  throw new Error(`final verification generation did not seal: ${finalGenerationSeal.reason}`);
}
const finalSealedGeneration = getSealedVerificationGeneration(runId, finalGenerationId);
if (!finalSealedGeneration.ok) {
  throw new Error(`sealed final verification is unsafe: ${finalSealedGeneration.reason}`);
}
assertReviewPackageCurrent(finalGitEvidence, { cwd });
const finalRoute = routeReviewers({
  diffPaths: finalGitEvidence.diffPaths,
  diffContent: finalGitEvidence.diff,
  baseDir: cwd,
});
const finalReviewPackage = attachReviewContext(finalGitEvidence, {
  prd: finalPrd,
  verification: finalSealedGeneration.records,
});
if (finalRoute.reviewers.length === 0 || finalRoute.allowedReviewers.length === 0
  || finalRoute.rejectedReviewers.length > 0
  || finalRoute.reviewers.some((reviewer) => !finalRoute.allowedReviewers.includes(reviewer))) {
  throw new Error('final review routing selected an empty or non-approval reviewer set');
}
const finalRound = loopTick(runId, 'final-review');
if (!finalRound.allowed || finalRound.degraded) {
  throw new Error('final review iteration budget or ledger is unavailable');
}
let finalReviewers = [...finalRoute.reviewers];
const finalRawOutputsByName = new Map();
// Spawn every final reviewer with finalReviewPackage and the AO_REVIEW_V1
// contract, then store each raw response under its bare reviewer name.
Fire every initial finalReviewers member in parallel with finalReviewPackage.
For each completed response:
  finalRawOutputsByName.set(<bare reviewer name>, <raw AO_REVIEW_V1 response>);
Do not aggregate until every initial reviewer either has a stored response or
is deliberately absent so aggregation returns BLOCKED.
const finalHandledEscalations = new Set();
let finalAggregate;
for (;;) {
  finalAggregate = aggregateReviewResults(finalRawOutputsByName, finalReviewers, {
    allowedReviewers: finalRoute.allowedReviewers,
    reviewPackage: finalReviewPackage,
  });
  if (finalAggregate.errors.length > 0) break;
  const finalRequestersToRerun = new Set();
  for (const requestingResult of finalAggregate.results) {
    for (const escalation of requestingResult.escalations) {
      const escalationKey = `${requestingResult.reviewer}\0${escalation.additionalReviewer}`;
      if (finalHandledEscalations.has(escalationKey)) {
        throw new Error('final reviewer repeated an already-fulfilled escalation');
      }
      const routed = handleEscalation(finalReviewers, escalation, {
        allowedReviewers: finalRoute.allowedReviewers,
        baseDir: cwd,
      });
      if (routed.rejected || routed.warning) {
        throw new Error('final review escalation was rejected or downgraded');
      }
      finalReviewers = routed.reviewers;
      if (routed.escalated) {
        Fire escalation.additionalReviewer with the same finalReviewPackage;
        finalRawOutputsByName.set(
          escalation.additionalReviewer,
          <raw AO_REVIEW_V1 response>,
        );
      }
      finalHandledEscalations.add(escalationKey);
      finalRequestersToRerun.add(requestingResult.reviewer);
    }
  }
  if (finalRequestersToRerun.size > 0) {
    Rerun each requesting reviewer with all fulfilled specialist raw results,
    then replace its stale escalating result in finalRawOutputsByName.
    continue;
  }
  break;
}
if (finalAggregate.verdict === 'BLOCKED') {
  throw new Error(`final post-mutation review is blocked: ${finalAggregate.errors.join('; ')}`);
}
if (finalAggregate.verdict === 'REVISE' || finalAggregate.verdict === 'REJECT') {
  const finalRetry = reattempt(runId, {
    reopen: ['integrate'],
    reason: 'final_review_reject',
  });
  if (!finalRetry.allowed || finalRetry.degraded) {
    throw new Error('final review rejected and the bounded integration retry was unavailable');
  }
  Delegate only the findings in finalAggregate.results to a scoped executor/debugger
  under the reopened integrate path. The Athena lead coordinates and never
  edits the integration tree; rebuild verification and the final package after
  the delegated fixes.
  throw new Error('final post-mutation review did not approve; reopen integrate/review and do not commit');
}
assertReviewPackageCurrent(finalReviewPackage, { cwd });
Skill(skill="agent-olympus:git-master");
assertReviewPackageHeadTree(finalReviewPackage, { cwd });
if (execFileSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) {
  throw new Error('git-master left content outside the reviewed commit tree');
}
const finalCommit = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
```

No source, documentation, generated artifact, index, or worktree mutation is
allowed between `assertReviewPackageCurrent` and `git-master`; after the commit,
the HEAD tree must equal the reviewer-bound `reviewTreeOid` exactly.

```javascript
await completePhase(runId, 'finalize', {
  finalReviewDigest: finalReviewPackage.reviewDigest.value,
  finalReviewTreeOid: finalReviewPackage.reviewTreeOid,
  finalCommit,
}, {
  checkpointData: {
    runId,
    teamSlug: finalizeSpawnIdentity.teamSlug,
    intendedWorkers: finalizeSpawnIdentity.intendedWorkers,
    spawnPath: finalizeSpawnIdentity.spawnPath,
    adapterRunId: finalizeSpawnIdentity.adapterRunId,
    nativeSessionId: finalizeSpawnIdentity.nativeSessionId,
    baseCommit: finalizeSpawnIdentity.baseCommit,
    launchState: finalizeSpawnIdentity.launchState,
    worktreeDigest: finalizeSpawnIdentity.worktreeDigest,
    prdSnapshot: <prd.json>,
    completedStories,
    worktrees: finalizeCheckpoint.worktrees,
    mergedWorkers: finalizeCheckpoint.mergedWorkers,
    providerTeamsToShutdown: finalizeCheckpoint.providerTeamsToShutdown ?? [],
  },
});
```

### Phase 6 — SHIP (PR Creation + Issue Linking)

Resolve approval without allowing the orchestrator to approve its own prompt.
Approval is valid only when the structured `AskUserQuestion` result records the
exact approval option and that approval is then durably re-read from this run's
artifact log. Bind both the first durable `ship_intent` and approval to the
current branch, base, HEAD, and repository identity so a later commit, retarget,
or remote swap invalidates recovery. In unattended/headless `ask` mode,
optionally send the blocked notification, halt shipping without a push,
terminally skip ship/CI, and proceed safely to COMPLETION. The notification is
gated by `config.notify.onBlocked`:

```javascript
import { execFileSync } from 'node:child_process';
import {
  buildPRBody,
  createPR,
  detectBaseBranch,
  detectRepositoryIdentity,
  extractIssueRefs,
  findExistingPR,
  preflightCheck,
  repositoryIdentitiesEqual,
  updateExistingPR,
} from './scripts/lib/pr-create.mjs';

// Runs on every invocation even when finalize is already terminal, so a new
// durable follow-up can revoke auto shipping before Phase 6 resumes.
refreshRunShipPolicy('ship phase entry');
const shippingCheckpoint = await loadCheckpoint('athena');
const shippingSpawnIdentity = getPipelineState(runId).phases.spawn?.outputs;
if (!validateAthenaCheckpointBinding(shippingCheckpoint, shippingSpawnIdentity, { cwd })) {
  throw new Error('Athena shipping checkpoint does not belong to this run/team; stop before any push');
}

const persistedShipPhase = getPipelineState(runId).phases.ship;
const persistedShipOutputs = persistedShipPhase?.outputs;
const shipAlreadyTerminal = ['completed', 'skipped'].includes(persistedShipPhase?.status);
const shipRecoveryInProgress = persistedShipPhase?.status === 'in_progress';
let pushPerformed = persistedShipOutputs?.pushPerformed === true;
let createdPrUrl = typeof persistedShipOutputs?.createdPrUrl === 'string'
  ? persistedShipOutputs.createdPrUrl
  : null;
const restoredBaseBranch = typeof persistedShipOutputs?.baseBranch === 'string'
  ? persistedShipOutputs.baseBranch
  : null;
const restoredShipBranchName = typeof persistedShipOutputs?.branchName === 'string'
  ? persistedShipOutputs.branchName
  : null;
const restoredHeadCommit = typeof persistedShipOutputs?.headCommit === 'string'
  ? persistedShipOutputs.headCommit
  : null;
const restoredRepoIdentity = typeof persistedShipOutputs?.repoOriginUrl === 'string'
  && typeof persistedShipOutputs?.repoPushUrl === 'string'
  && typeof persistedShipOutputs?.repoRepository === 'string'
  && typeof persistedShipOutputs?.repoDefaultBranch === 'string'
  ? {
      originUrl: persistedShipOutputs.repoOriginUrl,
      pushUrl: persistedShipOutputs.repoPushUrl,
      repository: persistedShipOutputs.repoRepository,
      defaultBranch: persistedShipOutputs.repoDefaultBranch,
    }
  : null;
if (persistedShipPhase?.status === 'completed'
  && (!pushPerformed || !createdPrUrl?.trim()
    || !restoredBaseBranch?.trim() || !restoredShipBranchName?.trim()
    || !restoredHeadCommit?.trim() || !restoredRepoIdentity)) {
  throw new Error('Athena completed ship phase lacks a durable push/PR/base/branch/HEAD/repository outcome; stop recovery');
}
let observedBranchName = '';
let observedHeadCommit = '';
try {
  observedBranchName = execFileSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8' }).trim();
  observedHeadCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
} catch { /* the cached preflight below rejects an unusable repository */ }
const observedBaseBranch = detectBaseBranch(cwd, config.ship.baseBranch);

// Detect the base first and make exactly one cached preflight decision. This
// is read-only; no push, PR mutation, or CI action is permitted yet.
const preflight = shipAlreadyTerminal || noShip
  ? { ok: true, errors: [] }
  : preflightCheck({ cwd, baseBranch: observedBaseBranch });

// The first durable intent owns the outward-action identity for the lifetime
// of this nonterminal ship attempt. Never replace it with a newer checkout.
const shipIntentEvents = getRun(runId).events.filter(event => (
  event?.phase === 'ship' && event?.type === 'ship_intent'
));
if (shipIntentEvents.length > 1) {
  throw new Error('Athena found multiple ship intents; stop rather than choosing a replacement');
}
let durableShipIntent = shipIntentEvents[0] ?? null;
const matchesObservedShipIdentity = detail => (
  detail?.branchName === observedBranchName
  && detail?.baseBranch === observedBaseBranch
  && detail?.headCommit === observedHeadCommit
  && repositoryIdentitiesEqual(detail?.repoIdentity, preflight.repoIdentity)
);
const recoveringDurableIntent = !shipAlreadyTerminal
  && (durableShipIntent !== null || shipRecoveryInProgress);
if (recoveringDurableIntent
  && (!durableShipIntent || preflight.ok !== true
    || !matchesObservedShipIdentity(durableShipIntent.detail))) {
  throw new Error('Athena current checkout/HEAD/base/repository does not match the durable ship intent; stop recovery');
}
if (!shipAlreadyTerminal && !noShip && preflight.ok === true && !durableShipIntent) {
  const intentRepoIdentity = detectRepositoryIdentity(cwd);
  if (!repositoryIdentitiesEqual(intentRepoIdentity, preflight.repoIdentity)) {
    throw new Error('Athena repository changed after preflight; stop before recording ship intent');
  }
  const proposedShipIntent = {
    branchName: observedBranchName,
    baseBranch: observedBaseBranch,
    headCommit: observedHeadCommit,
    repoIdentity: preflight.repoIdentity,
  };
  addEvent(runId, {
    phase: 'ship',
    type: 'ship_intent',
    detail: proposedShipIntent,
  });
  const durableIntentEvents = getRun(runId).events.filter(event => (
    event?.phase === 'ship' && event?.type === 'ship_intent'
  ));
  if (durableIntentEvents.length !== 1
    || !matchesObservedShipIdentity(durableIntentEvents[0]?.detail)) {
    throw new Error('Athena ship intent was not durably recorded exactly once; stop before approval');
  }
  durableShipIntent = durableIntentEvents[0];
}
const branchName = shipAlreadyTerminal
  ? (restoredShipBranchName ?? observedBranchName)
  : (durableShipIntent?.detail?.branchName ?? observedBranchName);
const baseBranch = shipAlreadyTerminal
  ? (restoredBaseBranch ?? observedBaseBranch)
  : (durableShipIntent?.detail?.baseBranch ?? observedBaseBranch);
const headCommit = shipAlreadyTerminal
  ? (restoredHeadCommit ?? observedHeadCommit)
  : (durableShipIntent?.detail?.headCommit ?? observedHeadCommit);
const repoIdentity = shipAlreadyTerminal
  ? restoredRepoIdentity
  : (durableShipIntent?.detail?.repoIdentity ?? preflight.repoIdentity ?? null);
const requirePinnedRepository = action => {
  const currentRepoIdentity = detectRepositoryIdentity(cwd);
  if (!repositoryIdentitiesEqual(currentRepoIdentity, repoIdentity)) {
    throw new Error(`Athena repository identity changed before ${action}; stop outward actions`);
  }
};
const approvalQuestion = `Push ${branchName}@${headCommit} in ${repoIdentity?.repository} and create/update a PR targeting ${baseBranch}?`;
const matchesCurrentHumanApproval = event => (
  event?.phase === 'ship'
  && event?.type === 'human_ship_approval'
  && event?.detail?.source === 'AskUserQuestion'
  && event?.detail?.decision === 'approved'
  && event?.detail?.branchName === branchName
  && event?.detail?.baseBranch === baseBranch
  && event?.detail?.headCommit === headCommit
  && repositoryIdentitiesEqual(event?.detail?.repoIdentity, repoIdentity)
);
let durableHumanApproval = getRun(runId).events.some(matchesCurrentHumanApproval);
const requireShippingNotRevoked = action => {
  const currentPolicy = refreshRunShipPolicy(action);
  if (currentPolicy.noShip) {
    throw new Error(`Athena shipping was revoked before ${action}; stop outward actions`);
  }
  return currentPolicy;
};
const requireCurrentShippingAuthorization = action => {
  const currentPolicy = requireShippingNotRevoked(action);
  durableHumanApproval = getRun(runId).events.some(matchesCurrentHumanApproval);
  if (currentPolicy.shipMode === 'ask' && !durableHumanApproval) {
    throw new Error(`Athena shipping now requires fresh human approval before ${action}`);
  }
  if (!['auto', 'ask'].includes(currentPolicy.shipMode)) {
    throw new Error(`Athena shipping policy is invalid before ${action}`);
  }
  requirePinnedRepository(action);
};

if (!shipAlreadyTerminal && shipMode === 'ask' && preflight.ok && !durableHumanApproval
  && typeof AskUserQuestion === 'function') {
  requireShippingNotRevoked('shipping approval');
  requirePinnedRepository('shipping approval');
  const approvalResponse = await AskUserQuestion({
    questions: [{
      question: approvalQuestion,
      header: 'Ship branch',
      multiSelect: false,
      options: [
        {
          label: 'Approve shipping',
          description: `Push ${branchName}@${headCommit} and create or update the ${baseBranch} PR.`,
        },
        {
          label: 'Keep branch local',
          description: 'Do not push or mutate a pull request.',
        },
      ],
    }],
  });
  const selectedAnswer = approvalResponse?.answers?.[approvalQuestion];
  const humanResolved = approvalResponse
    && !Object.prototype.hasOwnProperty.call(approvalResponse, 'afkTimeoutMs');
  if (humanResolved && selectedAnswer === 'Approve shipping') {
    requirePinnedRepository('shipping approval recording');
    // This is the sole write site for approval provenance. The orchestrator
    // must never call addEvent to synthesize approval without this exact result.
    addEvent(runId, {
      phase: 'ship',
      type: 'human_ship_approval',
      detail: {
        source: 'AskUserQuestion',
        decision: 'approved',
        branchName,
        baseBranch,
        headCommit,
        repoIdentity,
      },
    });
    durableHumanApproval = getRun(runId).events.some(matchesCurrentHumanApproval);
  }
}

if (!shipAlreadyTerminal && shipMode === 'ask' && !durableHumanApproval) {
  if (config.notify.onBlocked) {
    // node scripts/notify-cli.mjs --event blocked --orchestrator athena --body "branch ready to ship: <branchName>"
    try {
      execFileSync('node', [
        'scripts/notify-cli.mjs', '--event', 'blocked', '--orchestrator', 'athena',
        '--body', `branch ready to ship: ${branchName}`,
      ], { cwd, stdio: 'inherit' });
    } catch { /* notification failure must never authorize or block completion */ }
  }
}

const shippingApproved = shipMode === 'auto'
  || (shipMode === 'ask' && durableHumanApproval === true);
const shippingApplicable = preflight.ok && shippingApproved;
// `user-declined` is the runner's allowlisted no-approval bucket; it also
// covers headless ask where no human approval channel existed.
const shipSkipReason = noShip
  ? 'not-applicable'
  : (!preflight.ok ? 'preflight-unavailable' : 'user-declined');
if (shipRecoveryInProgress && !shippingApplicable) {
  throw new Error('Athena in-progress ship recovery lost approval/preflight/policy; leave it nonterminal');
}
const shipGate = shipAlreadyTerminal
  ? enterPhase(runId, 'ship')
  : (shippingApplicable
    ? enterPhase(runId, 'ship')
    : skipPhase(runId, 'ship', shipSkipReason));
const shipCanAct = shippingApplicable
  && shipGate.proceed === true
  && shipGate.degraded === false;
if (shipGate.status === 'failed') {
  throw new Error('Athena ship phase is terminally failed; do not continue to CI/completion');
}
if (shipAlreadyTerminal && (shipGate.skip !== true || shipGate.degraded === true)) {
  throw new Error('Athena terminal ship outcome could not be restored; stop before CI/completion');
}
if (shippingApplicable && shipGate.skip !== true && !shipCanAct) {
  throw new Error('Athena ship phase transition was denied or degraded; stop before push/PR');
}
if (!shipAlreadyTerminal && !shippingApplicable
  && (shipGate.ok !== true || shipGate.degraded === true)) {
  throw new Error('Athena ship skip was not durable; stop before completion');
}
```

For `shipMode === 'never'`, report exactly:
`branch ready: <branchName> — push/PR은 사용자가 직접`.
If preflight fails (no gh, no remote, unavailable GitHub default-branch
metadata, detached HEAD, or a base branch), report
its errors and do not push. Verification, push, PR mutation, and phase
completion below run only inside `if (shipCanAct)`. A gate denial or any
`degraded:true` result is fail-closed and never authorizes an outward action.

#### Verification Gate (MANDATORY — blocks PR creation) <!-- AO-CONTRACT:verification-gate -->
Before any shipping activity, check that ALL stories have verification records:
```javascript
import { checkVerificationGate } from './scripts/lib/run-artifacts.mjs';
if (shipCanAct) {
  const storyIds = prd.userStories.map(s => s.id);
  let verificationGate = checkVerificationGate(runId, storyIds);

  if (!verificationGate.gatePass) {
    // Stories without verification records — MUST attempt xval for each.
    for (const missingId of verificationGate.missing) {
      // 1. First attempt: try Codex cross-validation (same as Phase 4 xval step).
      // 2. If Codex unavailable, record explicit skip.
      const catchupWrite = addVerification(runId, {
        story_id: missingId,
        verdict: 'skip',
        evidence: 'codex unavailable: verification gate catch-up',
        verifiedBy: 'athena',
        reviewTreeOid: finalReviewPackage.reviewTreeOid,
        criteria: prd.userStories.find(story => story.id === missingId)
          .acceptanceCriteria.map((criterion_text, criterion_index) => ({
            criterion_index,
            criterion_text,
            verdict: 'skip',
            evidence: 'codex unavailable: criterion not externally cross-validated',
          })),
      });
      if (!catchupWrite.ok) {
        throw new Error(`verification catch-up was not persisted: ${catchupWrite.reason}`);
      }
    }
    verificationGate = checkVerificationGate(runId, storyIds);
  }
  if (!verificationGate.gatePass) {
    throw new Error(
      `Athena verification gate failed for: ${verificationGate.missing.join(', ')}; leave ship nonterminal`,
    );
  }
  if (verificationGate.skipped.length > 0) {
    console.log(`[Athena] ${verificationGate.skipped.length} stories had Codex xval skipped — results included in PR body`);
  }

  // Prepare the final base, body, issue links, and existing-PR decision before
  // push. This keeps both the create and update branches on identical content.
  let diffStat = '';
  try {
    diffStat = execFileSync(
      'git',
      ['diff', '--stat', `origin/${baseBranch}...HEAD`],
      { cwd, encoding: 'utf8' },
    ).trim();
  } catch { /* PR body keeps the safe no-diff fallback */ }
  const body = buildPRBody({ prd, diffStat, verifyResults });
  const issues = extractIssueRefs(commitMessages + branchName);
  const linkedBody = body + (issues.length
    ? '\n\nCloses ' + issues.map(issue => `#${issue}`).join(', ')
    : '');
  requireCurrentShippingAuthorization('existing-PR lookup');
  requirePinnedRepository('existing-PR lookup');
  const existing = findExistingPR(branchName, {
    cwd,
    baseBranch,
    repository: repoIdentity.repository,
  });
  if (existing.ok !== true) {
    throw new Error(`Athena existing-PR lookup failed: ${existing.error}; stop to avoid a duplicate PR`);
  }

  // Close the approval/gate TOCTOU window immediately before the outward write.
  // A changed branch or commit requires a fresh pass through approval/preflight.
  const pushBranchName = execFileSync(
    'git', ['branch', '--show-current'], { cwd, encoding: 'utf8' },
  ).trim();
  const pushHeadCommit = execFileSync(
    'git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' },
  ).trim();
  if (pushBranchName !== branchName || pushHeadCommit !== headCommit) {
    throw new Error('Athena branch/HEAD changed after approval; stop before push and request fresh approval');
  }
  requireCurrentShippingAuthorization('push');
  requirePinnedRepository('push');
  execFileSync('git', [
    'push', repoIdentity.pushUrl, `${headCommit}:refs/heads/${branchName}`,
  ], { cwd, stdio: 'inherit' });
  pushPerformed = true;

  if (existing.found) {
    requireCurrentShippingAuthorization('PR update');
    requirePinnedRepository('PR update');
    const updated = updateExistingPR({
      prNumber: existing.prNumber,
      title: prd.projectName,
      body: linkedBody,
      baseBranch,
      cwd,
      labels: config.ship.labels,
      repository: repoIdentity.repository,
    });
    if (updated.ok !== true
      || typeof existing.prUrl !== 'string'
      || !existing.prUrl.trim()) {
      throw new Error(`Athena PR update failed: ${updated.error ?? 'missing PR URL'}; leave ship nonterminal`);
    }
    createdPrUrl = existing.prUrl;
  } else {
    requireCurrentShippingAuthorization('PR creation');
    requirePinnedRepository('PR creation');
    const created = createPR({
      title: prd.projectName,
      body: linkedBody,
      draft: config.ship.draftPR,
      headBranch: branchName,
      baseBranch,
      cwd,
      labels: config.ship.labels,
      repository: repoIdentity.repository,
    });
    if (created.ok !== true
      || typeof created.prUrl !== 'string'
      || !created.prUrl.trim()) {
      throw new Error(`Athena PR creation failed: ${created.error ?? 'missing PR URL'}; leave ship nonterminal`);
    }
    createdPrUrl = created.prUrl;
  }

  const shipOutputs = {
    pushPerformed,
    createdPrUrl,
    branchName,
    baseBranch,
    headCommit,
    // completePhase() deliberately preserves scalar outputs only. Flatten the
    // repository identity so a completed ship can be recovered after a crash.
    repoOriginUrl: repoIdentity.originUrl,
    repoPushUrl: repoIdentity.pushUrl,
    repoRepository: repoIdentity.repository,
    repoDefaultBranch: repoIdentity.defaultBranch,
  };
  const shipCompletion = await completePhase(runId, 'ship', shipOutputs, {
    checkpointData: {
      ...shippingCheckpoint,
      runId,
      ...shipOutputs,
    },
  });
  if (!shipCompletion.ok || shipCompletion.degraded) {
    throw new Error('Athena ship outcome was not durably checkpointed; preserve the run for recovery');
  }
}
```

#### Preflight

Use the cached `preflight` result above for the shipping decision; do not rerun
preflight after the runner phase transition. If it failed, shipping is already
terminally skipped with `preflight-unavailable`, so report its errors and
continue to COMPLETION.

#### Push & Create PR
The guarded block above prepares the base and complete linked PR body before
push. When `findExistingPR(branchName, { cwd, baseBranch, repository })` returns a PR, call
`updateExistingPR` even when its base already matches so title, body, issue
links, base, and labels cannot remain stale. Create a PR only when no open PR
exists for the head branch and the lookup itself succeeded. A lookup/tool/JSON
failure is not equivalent to "no PR" and stops before push or create.

Report `createdPrUrl` to the user when present.

In `ask` mode, use only the structured `AskUserQuestion` call above. A decline,
free-form response, AFK auto-resolution, unavailable tool, and headless run all
leave `durableHumanApproval === false` and `pushPerformed === false`.

`completePhase` persists `{ pushPerformed, createdPrUrl, branchName, baseBranch,
headCommit }` plus the four scalar repository-identity fields in both the ship
ledger outputs and Athena checkpoint. On resume the identity object is
reconstructed before CI and completion reporting. A blocked verification gate
leaves the phase nonterminal for
recovery. A terminal skipped phase reports
`restoredShipBranchName ?? observedBranchName`, never a synthetic empty branch
name.

### Phase 6b — CI WATCH (Monitor + Auto-Fix) <!-- AO-CONTRACT:ci-watch -->

```javascript
import { getFailedLogs, watchCI } from './scripts/lib/ci-watch.mjs';

refreshRunShipPolicy('CI phase entry');
const ciApplicable = Boolean(!noShip && pushPerformed && createdPrUrl && config.ci.watchEnabled);
const persistedCIStatus = getPipelineState(runId).phases.ci?.status;
const ciAlreadyTerminal = ['completed', 'skipped'].includes(persistedCIStatus);
const ciRecoveryInProgress = persistedCIStatus === 'in_progress';
if (ciRecoveryInProgress && !ciApplicable) {
  throw new Error('Athena in-progress CI recovery became inapplicable; preserve it instead of skipping');
}
const ciCheckpoint = await loadCheckpoint('athena');
const ciSpawnIdentity = getPipelineState(runId).phases.spawn?.outputs;
if (!validateAthenaCheckpointBinding(ciCheckpoint, ciSpawnIdentity, { cwd })) {
  throw new Error('Athena CI checkpoint does not belong to this run/team; stop polling and preserve state');
}
const ciGate = ciAlreadyTerminal
  ? enterPhase(runId, 'ci')
  : (ciApplicable
    ? enterPhase(runId, 'ci')
    : skipPhase(runId, 'ci', pushPerformed && createdPrUrl ? 'watch-disabled' : 'no-pr'));
const ciCanAct = ciApplicable
  && ciGate.proceed === true
  && ciGate.degraded === false;
if (ciGate.status === 'failed') {
  throw new Error('Athena CI phase is terminally failed; do not continue to completion');
}
if (ciAlreadyTerminal && (ciGate.skip !== true || ciGate.degraded === true)) {
  throw new Error('Athena terminal CI outcome could not be restored; stop before completion');
}
if (ciApplicable && ciGate.skip !== true && !ciCanAct) {
  throw new Error('Athena CI phase transition was denied or degraded; stop before polling/fixing/pushing');
}
if (!ciAlreadyTerminal && !ciApplicable
  && (ciGate.ok !== true || ciGate.degraded === true)) {
  throw new Error('Athena CI skip was not durable; stop before completion');
}

const matchesCITarget = event => (
  event?.phase === 'ci'
  && event?.type === 'ci_head_target'
  && event?.detail?.branchName === branchName
  && event?.detail?.baseBranch === baseBranch
  && typeof event?.detail?.headCommit === 'string'
  && /^[0-9a-f]{40}$/.test(event.detail.headCommit)
  && repositoryIdentitiesEqual(event?.detail?.repoIdentity, repoIdentity)
);
let ciTargetEvents = getRun(runId).events.filter(event => (
  event?.phase === 'ci' && event?.type === 'ci_head_target'
));
if (ciTargetEvents.some(event => !matchesCITarget(event))) {
  throw new Error('Athena durable CI target history is malformed or belongs to another ship identity');
}
let expectedCIHeadCommit = ciTargetEvents.at(-1)?.detail?.headCommit ?? headCommit;
const ciPollCycles = Math.max(
  1,
  Math.ceil(config.ci.timeoutMs / config.ci.pollIntervalMs),
);
if (ciCanAct && ciTargetEvents.length === 0) {
  requirePinnedRepository('CI target recording');
  addEvent(runId, {
    phase: 'ci',
    type: 'ci_head_target',
    detail: { branchName, baseBranch, headCommit, repoIdentity },
  });
  ciTargetEvents = getRun(runId).events.filter(event => (
    event?.phase === 'ci' && event?.type === 'ci_head_target'
  ));
  if (ciTargetEvents.length !== 1 || !matchesCITarget(ciTargetEvents[0])) {
    throw new Error('Athena initial CI target was not durably recorded; stop before polling');
  }
  expectedCIHeadCommit = ciTargetEvents[0].detail.headCommit;
}
```

Only when `ciCanAct` is true may Athena poll a provider, notify about CI, launch
a fixer, commit, or push. At the top of every poll/fix cycle, require both
fields from the durable runner tick:

```javascript
if (ciCanAct) {
  const readCurrentCIState = () => ({
    branchName: execFileSync(
      'git', ['branch', '--show-current'], { cwd, encoding: 'utf8' },
    ).trim(),
    headCommit: execFileSync(
      'git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' },
    ).trim(),
  });
  const assertCurrentCITarget = action => {
    const current = readCurrentCIState();
    if (current.branchName !== branchName || current.headCommit !== expectedCIHeadCommit) {
      throw new Error(`Athena branch/HEAD changed before ${action}; stop CI recovery`);
    }
  };
  const isDescendantCommit = (ancestor, candidate) => {
    try {
      execFileSync(
        'git', ['merge-base', '--is-ancestor', ancestor, candidate],
        { cwd, stdio: 'ignore' },
      );
      return true;
    } catch {
      return false;
    }
  };
  const readRemoteCIHead = () => {
    requirePinnedRepository('CI remote-ref verification');
    const output = execFileSync(
      'git', ['ls-remote', repoIdentity.pushUrl, `refs/heads/${branchName}`],
      { cwd, encoding: 'utf8' },
    ).trim();
    const rows = output.split(/\r?\n/).filter(Boolean);
    if (rows.length !== 1) {
      throw new Error('Athena shipped remote branch is missing or ambiguous');
    }
    const [remoteHead, remoteRef, ...extra] = rows[0].split(/\s+/);
    if (extra.length || remoteRef !== `refs/heads/${branchName}`
      || !/^[0-9a-f]{40}$/.test(remoteHead)) {
      throw new Error('Athena shipped remote branch response is malformed');
    }
    return remoteHead;
  };
  const assertRemoteCITarget = action => {
    const remoteHead = readRemoteCIHead();
    if (remoteHead !== expectedCIHeadCommit) {
      throw new Error(`Athena remote branch changed before ${action}; stop CI recovery`);
    }
  };
  const requireCurrentCIPolicy = action => {
    const currentPolicy = refreshRunShipPolicy(action);
    if (currentPolicy.noShip) {
      throw new Error(`Athena shipping was revoked before ${action}; stop CI side effects`);
    }
    return currentPolicy;
  };
  const matchesCIFixStarted = event => (
    event?.phase === 'ci'
    && event?.type === 'ci_fix_started'
    && event?.detail?.branchName === branchName
    && event?.detail?.baseBranch === baseBranch
    && event?.detail?.sourceHeadCommit === expectedCIHeadCommit
    && /^[1-9]\d*$/.test(event?.detail?.failureRunId ?? '')
    && Number.isSafeInteger(event?.detail?.fixAttempt)
    && event.detail.fixAttempt > 0
    && repositoryIdentitiesEqual(event?.detail?.repoIdentity, repoIdentity)
  );
  const matchesCIFixCandidate = event => (
    event?.phase === 'ci'
    && event?.type === 'ci_fix_candidate'
    && event?.detail?.branchName === branchName
    && event?.detail?.baseBranch === baseBranch
    && event?.detail?.sourceHeadCommit === expectedCIHeadCommit
    && typeof event?.detail?.candidateHeadCommit === 'string'
    && /^[0-9a-f]{40}$/.test(event.detail.candidateHeadCommit)
    && event.detail.candidateHeadCommit !== expectedCIHeadCommit
    && /^[1-9]\d*$/.test(event?.detail?.failureRunId ?? '')
    && Number.isSafeInteger(event?.detail?.fixAttempt)
    && event.detail.fixAttempt > 0
    && ['live', 'local-drift'].includes(event?.detail?.recoveryMode)
    && repositoryIdentitiesEqual(event?.detail?.repoIdentity, repoIdentity)
  );
  const findLinkedCIFixStart = candidate => {
    if (!matchesCIFixCandidate(candidate)) return null;
    const events = getRun(runId).events;
    const candidateIndexes = events.flatMap((event, index) => (
      matchesCIFixCandidate(event)
      && event.detail.candidateHeadCommit === candidate.detail.candidateHeadCommit
      && event.detail.failureRunId === candidate.detail.failureRunId
      && event.detail.fixAttempt === candidate.detail.fixAttempt
        ? [index]
        : []
    ));
    const startIndexes = events.flatMap((event, index) => (
      matchesCIFixStarted(event)
      && event.detail.failureRunId === candidate.detail.failureRunId
      && event.detail.fixAttempt === candidate.detail.fixAttempt
        ? [index]
        : []
    ));
    if (candidateIndexes.length !== 1 || startIndexes.length !== 1
      || startIndexes[0] >= candidateIndexes[0]) {
      return null;
    }
    return events[startIndexes[0]];
  };
  const recordCIFixCandidate = (candidateHeadCommit, startedEvent, recoveryMode = 'live') => {
    if (!matchesCIFixStarted(startedEvent)
      || !['live', 'local-drift'].includes(recoveryMode)) {
      throw new Error('Athena CI fix candidate lacks an exact durable start transition');
    }
    if (!isDescendantCommit(expectedCIHeadCommit, candidateHeadCommit)) {
      throw new Error('Athena CI fix candidate is not a descendant of the confirmed CI target');
    }
    const { failureRunId, fixAttempt } = startedEvent.detail;
    const before = getRun(runId).events.filter(event => (
      event?.phase === 'ci' && event?.type === 'ci_fix_candidate'
    )).length;
    addEvent(runId, {
      phase: 'ci',
      type: 'ci_fix_candidate',
      detail: {
        branchName,
        baseBranch,
        sourceHeadCommit: expectedCIHeadCommit,
        candidateHeadCommit,
        failureRunId,
        fixAttempt,
        recoveryMode,
        repoIdentity,
      },
    });
    const candidates = getRun(runId).events.filter(event => (
      event?.phase === 'ci' && event?.type === 'ci_fix_candidate'
    ));
    const candidate = candidates[before];
    if (candidates.length !== before + 1
      || !matchesCIFixCandidate(candidate)
      || !findLinkedCIFixStart(candidate)) {
      throw new Error('Athena CI fix candidate was not durably recorded; stop before approval/push');
    }
    return candidate;
  };
  const confirmCITarget = candidateHeadCommit => {
    const targetCountBefore = getRun(runId).events.filter(event => (
      event?.phase === 'ci' && event?.type === 'ci_head_target'
    )).length;
    addEvent(runId, {
      phase: 'ci',
      type: 'ci_head_target',
      detail: {
        branchName,
        baseBranch,
        headCommit: candidateHeadCommit,
        repoIdentity,
      },
    });
    const updatedTargets = getRun(runId).events.filter(event => (
      event?.phase === 'ci' && event?.type === 'ci_head_target'
    ));
    const appendedTarget = updatedTargets[targetCountBefore];
    if (updatedTargets.length !== targetCountBefore + 1 || !matchesCITarget(appendedTarget)) {
      throw new Error('Athena confirmed CI fix target was not durably recorded; stop recovery');
    }
  };
  const pushOrConfirmCIFix = async candidate => {
    const linkedStart = findLinkedCIFixStart(candidate);
    if (!matchesCIFixCandidate(candidate)
      || !linkedStart
      || !isDescendantCommit(
        candidate.detail.sourceHeadCommit,
        candidate.detail.candidateHeadCommit,
      )) {
      throw new Error('Athena CI fix candidate provenance is invalid');
    }
    const {
      sourceHeadCommit, candidateHeadCommit, failureRunId, fixAttempt, recoveryMode,
    } = candidate.detail;
    const current = readCurrentCIState();
    if (current.branchName !== branchName || current.headCommit !== candidateHeadCommit) {
      throw new Error('Athena CI fix checkout no longer matches the durable candidate');
    }
    requireCurrentCIPolicy('CI fix approval');
    requirePinnedRepository('CI approval');
    const ciApprovalQuestion = `Push CI fix ${branchName}@${candidateHeadCommit} in ${repoIdentity.repository} to ${baseBranch}?`;
    const matchesCIFixApproval = event => (
      event?.phase === 'ci'
      && event?.type === 'human_ship_approval'
      && event?.detail?.source === 'AskUserQuestion'
      && event?.detail?.decision === 'approved'
      && event?.detail?.action === 'ci_fix_push'
      && event?.detail?.branchName === branchName
      && event?.detail?.baseBranch === baseBranch
      && event?.detail?.headCommit === candidateHeadCommit
      && event?.detail?.sourceHeadCommit === sourceHeadCommit
      && event?.detail?.failureRunId === failureRunId
      && event?.detail?.fixAttempt === fixAttempt
      && event?.detail?.recovered === (recoveryMode === 'local-drift')
      && repositoryIdentitiesEqual(event?.detail?.repoIdentity, repoIdentity)
    );
    const requiresHumanCIFixApproval = shipMode === 'ask' || recoveryMode === 'local-drift';
    let ciFixApproved = shipMode === 'auto' && !requiresHumanCIFixApproval;
    if (requiresHumanCIFixApproval) {
      let durableCIFixApproval = getRun(runId).events.some(matchesCIFixApproval);
      if (!durableCIFixApproval && typeof AskUserQuestion === 'function') {
        const ciApprovalResponse = await AskUserQuestion({
          questions: [{
            question: ciApprovalQuestion,
            header: 'CI fix push',
            multiSelect: false,
            options: [
              {
                label: 'Approve CI push',
                description: `Push CI fix ${branchName}@${candidateHeadCommit}.`,
              },
              {
                label: 'Keep fix local',
                description: 'Do not push the CI fix commit.',
              },
            ],
          }],
        });
        const selectedCIAnswer = ciApprovalResponse?.answers?.[ciApprovalQuestion];
        const humanResolvedCI = ciApprovalResponse
          && !Object.prototype.hasOwnProperty.call(ciApprovalResponse, 'afkTimeoutMs');
        if (humanResolvedCI && selectedCIAnswer === 'Approve CI push') {
          requirePinnedRepository('CI approval recording');
          addEvent(runId, {
            phase: 'ci',
            type: 'human_ship_approval',
            detail: {
              source: 'AskUserQuestion',
              decision: 'approved',
              action: 'ci_fix_push',
              branchName,
              baseBranch,
              headCommit: candidateHeadCommit,
              sourceHeadCommit,
              failureRunId,
              fixAttempt,
              recovered: recoveryMode === 'local-drift',
              repoIdentity,
            },
          });
          durableCIFixApproval = getRun(runId).events.some(matchesCIFixApproval);
        }
      }
      ciFixApproved = durableCIFixApproval;
    }
    if (!ciFixApproved) {
      throw new Error('Athena CI fix push lacks verified human approval; keep the fix local');
    }

    requireCurrentCIPolicy('CI fix remote reconciliation');
    const remoteHead = readRemoteCIHead();
    if (remoteHead === sourceHeadCommit) {
      requirePinnedRepository('CI push');
      execFileSync('git', [
        'push', repoIdentity.pushUrl,
        `${candidateHeadCommit}:refs/heads/${branchName}`,
      ], { cwd, stdio: 'inherit' });
    } else if (remoteHead !== candidateHeadCommit) {
      throw new Error('Athena remote branch changed outside the durable CI fix transition');
    }
    if (readRemoteCIHead() !== candidateHeadCommit) {
      throw new Error('Athena CI fix push could not be confirmed on the pinned remote');
    }
    confirmCITarget(candidateHeadCommit);
    return candidateHeadCommit;
  };
  const recoverPendingCIFix = async () => {
    const events = getRun(runId).events;
    let lastTargetIndex = -1;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]?.phase === 'ci' && events[index]?.type === 'ci_head_target') {
        lastTargetIndex = index;
        break;
      }
    }
    const pendingEvents = events.slice(lastTargetIndex + 1);
    const starts = pendingEvents.filter(event => event?.type === 'ci_fix_started');
    const candidates = pendingEvents.filter(event => event?.type === 'ci_fix_candidate');
    if (starts.some(event => !matchesCIFixStarted(event))
      || candidates.some(event => !matchesCIFixCandidate(event))
      || candidates.some(candidate => !findLinkedCIFixStart(candidate))
      || candidates.length > 1) {
      throw new Error('Athena pending CI fix history is malformed or ambiguous');
    }
    const current = readCurrentCIState();
    if (candidates.length === 1) {
      return pushOrConfirmCIFix(candidates[0]);
    }
    if (starts.length > 0 && current.branchName === branchName
      && current.headCommit !== expectedCIHeadCommit) {
      const candidate = recordCIFixCandidate(current.headCommit, starts.at(-1), 'local-drift');
      return pushOrConfirmCIFix(candidate);
    }
    if (current.branchName !== branchName || current.headCommit !== expectedCIHeadCommit) {
      throw new Error('Athena local CI state drifted without a durable fix-start record');
    }
    return expectedCIHeadCommit;
  };
  expectedCIHeadCommit = await recoverPendingCIFix();

  for (;;) {
    const ciTick = loopTick(runId, 'ci');
    const ciTickCanAct = ciTick.allowed === true && ciTick.degraded === false;
    if (!ciTickCanAct) {
      throw new Error('Athena CI loop tick was denied or degraded; stop before all CI side effects');
    }
    const pushCIFix = async () => {
      if (!ciCanAct || !ciTickCanAct) {
        throw new Error('Athena CI fix push escaped its phase/tick gate');
      }
      const ciFixBranchName = execFileSync(
        'git', ['branch', '--show-current'], { cwd, encoding: 'utf8' },
      ).trim();
      const ciFixHeadCommit = execFileSync(
        'git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' },
      ).trim();
      if (ciFixBranchName !== branchName) {
        throw new Error(`Athena CI fix checkout ${ciFixBranchName} is not shipped branch ${branchName}`);
      }
      if (ciFixHeadCommit === expectedCIHeadCommit) {
        throw new Error('Athena CI fixer did not produce a new commit');
      }
      const started = getRun(runId).events.filter(matchesCIFixStarted).at(-1);
      if (!started) {
        throw new Error('Athena CI fix candidate lacks a durable fix-start record');
      }
      const candidate = recordCIFixCandidate(
        ciFixHeadCommit,
        started,
        'live',
      );
      return pushOrConfirmCIFix(candidate);
    };
    requireCurrentCIPolicy('CI polling');
    requirePinnedRepository('CI polling');
    assertCurrentCITarget('CI polling');
    assertRemoteCITarget('CI polling');
    const ciResult = await watchCI({
      cwd,
      repository: repoIdentity.repository,
      branch: branchName,
      expectedHeadSha: expectedCIHeadCommit,
      maxCycles: ciPollCycles,
      pollIntervalMs: config.ci.pollIntervalMs,
    });
    requireCurrentCIPolicy('CI poll result');
    requirePinnedRepository('CI poll result');
    assertCurrentCITarget('CI poll result');
    assertRemoteCITarget('CI poll result');
    if (ciResult.conclusion === 'invalid-input') {
      throw new Error('Athena CI watcher rejected its pinned repository/commit inputs');
    }
    if (ciResult.status === 'passed') break;
    if (ciResult.status === 'failed') {
      requirePinnedRepository('CI failed-log fetch');
      assertCurrentCITarget('CI failed-log fetch');
      assertRemoteCITarget('CI failed-log fetch');
      const failedLogs = getFailedLogs({
        cwd,
        repository: repoIdentity.repository,
        runId: ciResult.runId,
      });
      if (!failedLogs) {
        throw new Error('Athena could not read failed logs from the pinned CI run');
      }
      requirePinnedRepository('CI fixer launch');
      assertCurrentCITarget('CI fixer launch');
      assertRemoteCITarget('CI fixer launch');
      const startedCountBefore = getRun(runId).events.filter(event => (
        event?.phase === 'ci' && event?.type === 'ci_fix_started'
      )).length;
      addEvent(runId, {
        phase: 'ci',
        type: 'ci_fix_started',
        detail: {
          branchName,
          baseBranch,
          sourceHeadCommit: expectedCIHeadCommit,
          failureRunId: ciResult.runId,
          fixAttempt: startedCountBefore + 1,
          repoIdentity,
        },
      });
      const startedEvents = getRun(runId).events.filter(event => (
        event?.phase === 'ci' && event?.type === 'ci_fix_started'
      ));
      const appendedStart = startedEvents[startedCountBefore];
      if (startedEvents.length !== startedCountBefore + 1
        || !matchesCIFixStarted(appendedStart)) {
        throw new Error('Athena CI fix start was not durably recorded; stop before launching the fixer');
      }
      // Run the documented debugger → local verify → commit workflow below
      // with failedLogs. pushCIFix() then records the candidate before any
      // approval/push and reconciles the exact remote ref idempotently.
      expectedCIHeadCommit = await pushCIFix();
      continue;
    }
    // Timeout or an explicitly reported provider skip is reported to the user.
    break;
  }
  requireCurrentCIPolicy('CI completion');
  requirePinnedRepository('CI completion');
  assertCurrentCITarget('CI completion');
  assertRemoteCITarget('CI completion');
  const ciCompletion = await completePhase(runId, 'ci', undefined, {
    checkpointData: {
      ...ciCheckpoint,
      runId,
      pushPerformed,
      createdPrUrl,
      branchName,
      baseBranch,
      headCommit,
      ciHeadCommit: expectedCIHeadCommit,
      repoIdentity,
    },
  });
  if (!ciCompletion.ok || ciCompletion.degraded) {
    throw new Error('Athena CI result was not durably recorded; preserve the run for recovery');
  }
}
```

The guarded watch/fix behavior is:

```
┌─→ Poll CI status:
│     const ciTick = loopTick(runId, 'ci')
│     if (ciTick.allowed !== true || ciTick.degraded !== false) → STOP before side effects
│     node -e "import('./scripts/lib/ci-watch.mjs').then(m =>
│       m.watchCI({ cwd, repository: repoIdentity.repository, branch: branchName,
│         expectedHeadSha: expectedCIHeadCommit, maxCycles: ciPollCycles,
│         pollIntervalMs: config.ci.pollIntervalMs })
│       .then(r => console.log(JSON.stringify(r))))"
│
│   ├─ status: 'passed' →
│   │   node scripts/notify-cli.mjs --event ci_passed --orchestrator athena --body "All CI checks passed."
│   │   → DONE ✓
│   │
│   ├─ status: 'failed' →
│   │   1. Notify: node scripts/notify-cli.mjs --event ci_failed --orchestrator athena --body "CI failed"
│   │   2. Fetch logs:
│   │      getFailedLogs({ cwd, repository: repoIdentity.repository, runId: ciResult.runId })
│   │   3. Diagnose and fix (same escalation chain as Phase 4):
│   │      Task(subagent_type="agent-olympus:debugger", model="sonnet",
│   │        prompt="CI failed after PR push. Fix the issue.
│   │        CI failure logs: <failed_logs>
│   │        Previous learnings: <formatWisdomForPrompt(queryWisdom(null,10))>")
│   │   4. If debugger fails → Skill(skill="agent-olympus:systematic-debug")
│   │   5. If systematic-debug fails → Skill(skill="agent-olympus:trace")
│   │   6. After fix: re-run local verify (build + test), commit locally, then:
│   │      expectedCIHeadCommit = await pushCIFix()
│   │      # ask mode requires fresh approval; the pushed HEAD is durably recorded
│   │   7. Re-poll CI (back to top of loop)
│   │
│   └─ status: 'timeout' | 'skipped' → report to user, proceed
│
└── Loop (max config.ci.maxCycles attempts, default 2)
```

If CI passes → DONE. If CI fails after max cycles → escalate to user with failure logs.
On passed, timeout, or an explicitly reported provider skip, the guarded code
durably completes CI while retaining the ship outcome in the checkpoint. Do not
separately self-count `config.ci.maxCycles`; the runner's CI counter is
authoritative.

### COMPLETION <!-- AO-CONTRACT:cleanup -->

```javascript
import { join } from 'node:path';

const completeGate = enterPhase(runId, 'complete');
const completionCheckpoint = await loadCheckpoint('athena');
const completionSpawnIdentity = getPipelineState(runId).phases.spawn?.outputs;
if (!validateAthenaCheckpointBinding(completionCheckpoint, completionSpawnIdentity, { cwd })) {
  throw new Error('Athena completion checkpoint does not belong to this run/team; preserve it and stop');
}

// Crash recovery after completePhase but before finalizeRun: cleanup already
// succeeded, so finalize the exact run idempotently and clear the checkpoint.
if (completeGate.skip) {
  const cleanupOutputs = getPipelineState(runId).phases.complete?.outputs;
  if (cleanupOutputs?.teamSlug !== completionSpawnIdentity.teamSlug
    || cleanupOutputs?.worktreeDigest !== completionSpawnIdentity.worktreeDigest
    || cleanupOutputs?.cleanupState !== 'done') {
    throw new Error('Athena completed ledger lacks a cleanup marker bound to this team; retain checkpoint');
  }
  if (!isComplete(runId)) {
    throw new Error('Athena complete phase is terminal but the pipeline is not complete; preserve state');
  }
  if (getActiveRunId('athena') === runId) {
    finalizeRun(runId, { result: 'success', storiesCompleted: completedStories.length });
  }
  const resumedSummary = JSON.parse(readFileSync(
    join(cwd, '.ao', 'artifacts', 'runs', runId, 'summary.json'),
    'utf-8',
  ));
  if (resumedSummary.runId !== runId
    || resumedSummary.orchestrator !== 'athena'
    || resumedSummary.status !== 'completed'
    || resumedSummary.result !== 'success'
    || getActiveRunId('athena') === runId) {
    throw new Error('Athena resumed finalization was not durable; retain the recovery checkpoint');
  }
  await clearCheckpoint('athena');
  // Report the already-completed run; do not repeat destructive cleanup.
  return;
}
const completionUsesNativeTeam = completionSpawnIdentity?.spawnPath === 'native-or-mixed';
const completionSessionBinding = readClaudeSessionBinding();
if (completionUsesNativeTeam && (
  !completionSessionBinding.proven
  || completionSpawnIdentity.nativeSessionId !== completionSessionBinding.currentSessionId
  || completionCheckpoint.nativeSessionId !== completionSpawnIdentity.nativeSessionId
)) {
  throw new Error(
    'Athena native cleanup is outside the originating Claude session; preserve checkpoint, team artifacts, and worktrees',
  );
}
```

Prune wisdom to prevent unbounded growth:
- Call `pruneWisdom(200)` to remove entries older than 90 days and cap at 200 most recent

Clean up:
- Before any destructive cleanup, prove that every isolated worker result was merged:
  ```javascript
  if (!completionCheckpoint?.worktrees || !Array.isArray(completionCheckpoint?.mergedWorkers)) {
    throw new Error('Athena completion checkpoint lacks integration evidence; preserve checkpoint and worktrees');
  }
  const requiredMerges = Object.entries(completionCheckpoint.worktrees)
    .filter(([, item]) => item?.created && item.path !== cwd)
    .map(([workerName]) => workerName);
  const finalMergedWorkers = new Set(completionCheckpoint.mergedWorkers);
  const unmergedWorkers = requiredMerges.filter((workerName) => !finalMergedWorkers.has(workerName));
  if (unmergedWorkers.length > 0) {
    throw new Error(`Refusing Athena cleanup with unmerged workers: ${unmergedWorkers.join(', ')}`);
  }
  ```
- IF Path A (native teams), use the supported task and teammate lifecycle:
  - Read `TaskList()` and require every task to be terminal. Correct a stale task
    with `TaskUpdate(taskId="...", status="completed")` only when the run artifacts
    already prove its work completed; never manufacture completion for cleanup.
  - For every spawned native teammate, send
    `SendMessage({ to: "<worker>", message: { type: "shutdown_request", reason: "Athena run complete" } })`.
  - Wait for shutdown acknowledgements and teammate exits. If any teammate is
    active or its state is unknown, preserve the checkpoint, native team, `.ao/`
    artifacts, and worktrees and STOP before destructive cleanup.
  - Once no native teammate or task is active, let the lead/runtime perform its
    supported shared-resource cleanup and record
    `addEvent(runId, { type: 'native_team_shutdown_complete' })`. Never edit or
    remove `~/.claude/teams/` or `~/.claude/tasks/` directly.
- Shut down Codex + Gemini workers properly via adapter lifecycle:
  ```javascript
  import { shutdownTeam } from './scripts/lib/worker-spawn.mjs';
  await shutdownTeam(completionSpawnIdentity.teamSlug, cwd);  // supervisor-first: signals each worker's detached supervisor group (whose SIGTERM handler shuts the adapter down), then reaps any orphaned adapter group; tmux workers killed directly
  ```
- `clearTeamStatus(teamName)` — delete `.ao/teams/<slug>/status.jsonl` (import from `scripts/lib/worker-status.mjs`)
- Remove `.ao/teams/<slug>/`
- Remove `.ao/state/athena-state.json`, `.ao/prd.json`
- Clean up any remaining worktrees:
  ```javascript
  import { cleanupTeamWorktrees } from './scripts/lib/worktree.mjs';
  const cleanupResult = cleanupTeamWorktrees(cwd, completionSpawnIdentity.teamSlug);
  if (cleanupResult.errors > 0) {
    throw new Error('Athena worktree cleanup was incomplete; retain checkpoint and resume cleanup');
  }
  ```
- Keep `.ao/wisdom.jsonl` (useful for future sessions — never delete)

Only after every cleanup precondition succeeds, durably close and finalize the
same run identity. Keep the checkpoint through both transitions so either crash
window is resumable; clear it only after the summary and active-pointer
postconditions pass. `saveCheckpoint:false` prevents overwriting the retained
integration checkpoint.

```javascript
// AO-CONTRACT:run-finalize
const completion = await completePhase(runId, 'complete', {
  teamSlug: completionSpawnIdentity.teamSlug,
  worktreeDigest: completionSpawnIdentity.worktreeDigest,
  cleanupState: 'done',
}, {
  saveCheckpoint: false,
});
if (!completion.ok || !isComplete(runId)) {
  throw new Error('Athena completion ledger did not reach a terminal state; preserve the active run for recovery');
}
finalizeRun(runId, {
  result: 'success',
  storiesCompleted: completedStories.length,
});
if (getActiveRunId('athena') === runId) {
  throw new Error('Athena finalization did not clear the matching active-run pointer; preserve it for recovery');
}
const finalSummary = JSON.parse(readFileSync(
  join(cwd, '.ao', 'artifacts', 'runs', runId, 'summary.json'),
  'utf-8',
));
if (finalSummary.runId !== runId
  || finalSummary.orchestrator !== 'athena'
  || finalSummary.status !== 'completed'
  || finalSummary.result !== 'success') {
  throw new Error('Athena final summary postcondition failed; retain the recovery checkpoint');
}
await clearCheckpoint('athena');
```

Notify user of the actual completion outcome. Never claim a PR exists on a
no-ship, declined, headless, preflight-failed, or PR-failed path:

A PR lookup/update/create failure after a successful push is **not** a
completion path: report that the branch was pushed, retain the nonterminal ship
phase, and retry safely on resume. Do not send an `--event complete`
notification until a PR URL is durably recorded.

```bash
# When createdPrUrl exists:
node scripts/notify-cli.mjs --event complete --orchestrator athena --body "N/N stories passed. PR: <url>"

# Otherwise (a terminal no-push ship outcome):
node scripts/notify-cli.mjs --event complete --orchestrator athena --body "N/N stories passed. branch ready: <branchName> — push/PR은 사용자가 직접"
```

Report: PRD stories (N/N), per-worker summary, files changed, coordination log,
verification results, and the shipping outcome. Include the PR URL when one
exists; otherwise report exactly
`branch ready: <branchName> — push/PR은 사용자가 직접`.

## Team_Sizing

| Scope | Claude | Codex | Gemini | Total |
|-------|--------|-------|--------|-------|
| 2-3 files | 2 | 0 | 0 | 2 |
| 4-6 files | 2-3 | 1 | 0-1 | 3-5 |
| 7-15 files | 3-4 | 1 | 0-1 | 4-6 |
| 15+ files | 4-5 | 2 | 0-2 | 6-9 |

**Capability-aware sizing**: The table above shows MAXIMUM worker counts. Metis adjusts based on actual capabilities detected at runtime:
- If Codex unavailable: Codex slots reassigned to Claude workers
- If Gemini unavailable: Gemini slots reassigned to Claude workers
- If neither external model available: pure Claude team (existing behavior preserved)

Gemini workers are assigned when the task involves visual/multimodal work, or when `teamWorkerType: "gemini"` is set in model-routing config.

## Worker_Types

| Work | Agent | Model | Worker Type |
|------|-------|-------|-------------|
| API/backend | executor | sonnet | claude |
| UI/frontend | designer | sonnet | claude or **gemini** |
| Business logic | executor | sonnet/opus | claude |
| Algorithm | **codex** | — | codex |
| Tests | test-engineer | sonnet | claude |
| Large refactor | **codex** | — | codex |
| Visual/multimodal | designer | sonnet | **gemini** |
| Design review | aphrodite | sonnet | **gemini** |
| Creative/art | designer | sonnet | **gemini** |
| Docs | writer | haiku | claude |
| Security-critical | executor | opus | claude |

## Communication_Protocol

**Claude ↔ Claude** (Path A — native teams): `SendMessage({ to: "worker", summary: "Relay coordination update", message: "..." })`
**Claude ↔ Claude** (Path B — fallback): No direct messaging. Orchestrator reads agent output and injects context into subsequent agent prompts (orchestrator-mediated relay).

**Codex** communication depends on the adapter:
- **codex-appserver**: True bidirectional — `steerTurn()` injects input mid-execution, `turn/interrupt` aborts.
- **codex-exec / tmux**: Batch executor — one-shot tasks, no mid-execution communication.

**Gemini** communication depends on the adapter:
- **gemini-acp**: Message queue — `enqueueMessage(handle, msg, { from })` queues messages during active turns, auto-drains as new turns on completion. Failed messages retry once then dead-letter.
- **gemini-exec / tmux**: Batch executor — one-shot tasks, no mid-execution communication.

**Claude → Codex**: With app-server, use `steerTurn()` for live input. With exec/tmux, include all context in spawn prompt or use **task chaining** (below).
**Claude → Gemini**: With ACP, use `enqueueMessage(handle, message, { from: workerName })`. Messages delivered after current turn completes.
**Codex/Gemini → Claude** (Path A): Orchestrator reads output (via adapter), relays to Claude workers via SendMessage.
**Codex/Gemini → Claude** (Path B): Orchestrator reads output, includes in next agent prompt to Claude worker.

### Adapter Selection
Workers are spawned via the adapter that matches runtime capabilities (priority order):

**Codex**: codex-appserver > codex-exec > tmux
**Gemini**: gemini-acp > gemini-exec > tmux
**Claude**: claude-cli > tmux

The adapter is selected automatically by `selectAdapter(worker, capabilities)` in `worker-spawn.mjs`.

### Task Chaining (pseudo-bidirectional for exec/tmux adapters)
For codex-exec, gemini-exec, and tmux adapters (which cannot receive messages mid-execution), multi-step work uses sequential calls:
```
exec #1: "Design the API schema" → Result A
Orchestrator: merges Result A + Claude worker feedback
exec #2: "Revise based on this feedback: {feedback}" → Result B
```

## External_Skills

Beyond agent-olympus agents, workers can invoke ANY installed skill or plugin.
When assigning tasks, consider whether a specialized skill fits better than a generic executor.

Common examples:
- `ui-ux-pro-max:ui-ux-pro-max` — advanced UI/UX design with style presets
- `anthropic-skills:pdf` / `xlsx` / `docx` / `pptx` — document generation
- `anthropic-skills:canvas-design` — visual art and poster design
- `anthropic-skills:web-artifacts-builder` — complex React/Tailwind artifacts
- `anthropic-skills:mcp-builder` — MCP server creation
**Agent Olympus built-in skills (always available):**

> **IMPORTANT**: These are **skills**, NOT agents. Invoke them via `Skill(skill="agent-olympus:<name>")`, NOT via `Task(subagent_type=...)`. Using `Task(subagent_type=...)` will fail with "agent type not found".

- `agent-olympus:ask` — quick Codex/Gemini single-shot query
- `agent-olympus:deep-interview` — Socratic requirements clarification
- `agent-olympus:deep-dive` — 2-stage investigation pipeline for complex + ambiguous tasks (Phase 0)
- `agent-olympus:consensus-plan` — multi-perspective plan validation loop for 3+ story tasks (Phase 1)
- `agent-olympus:external-context` — facet-decomposed parallel research; enriches team context with external docs and best practices (Phase 0)
- `agent-olympus:systematic-debug` — root-cause-first debugging (use when debugger fails 2x)
- `agent-olympus:trace` — evidence-driven hypothesis analysis (use when systematic-debug also fails)
- `agent-olympus:slop-cleaner` — AI bloat cleanup (use before final commit)
- `agent-olympus:git-master` — atomic commit discipline (use as final step)
- `agent-olympus:deepinit` — generate AGENTS.md codebase map (use on unfamiliar projects)
- `agent-olympus:harness-init` — initialize harness engineering structure (docs/, golden principles, arch constraints)
- `agent-olympus:research` — parallel web research for external docs/APIs

**Recommended Athena workflow integration:**
```
Phase 0 (Design) → Skill(skill="agent-olympus:deep-dive") (if complexity=complex/architectural AND ambiguity > 40)
Phase 0 (Design) → Skill(skill="agent-olympus:external-context") (if external API/library knowledge gap detected)
Phase 1 (Plan)   → Skill(skill="agent-olympus:consensus-plan") (if 3+ stories; replaces standard Prometheus pass)
Phase 4 (Verify) → Skill(skill="agent-olympus:systematic-debug") (if debugger fails 2x); Skill(skill="agent-olympus:trace") (if systematic-debug also fails)
Phase 5 (Review) → Skill(skill="agent-olympus:slop-cleaner") → Skill(skill="agent-olympus:git-master") → DONE
```

**Rule**: If a specialized skill exists, prefer it over a generic executor.

## Stop_Conditions

STOP only when:
- ✅ All workers complete + integrated + build passes + tests pass + reviews approved
- ❌ Same error 3 times — signaled by `recordPhaseError(runId, 'integrate', sig).shouldEscalate` once consulted
  ```
  node scripts/notify-cli.mjs --event escalated --orchestrator athena --body "Same error 3 times: <error summary>"
  ```
- ❌ 15 iterations exceeded — signaled by `beginAttempt` / `reattempt` returning `allowed:false`
  ```
  node scripts/notify-cli.mjs --event escalated --orchestrator athena --body "15 iteration limit exceeded"
  ```
- ❌ Critical security issue (escalate)
- ❌ Workers in circular deadlock (escalate)

> These limits are reached only through the persistent phase-runner chokepoints, not self-counted.
> A `degraded:true` result means tracking was unavailable or state was not readable.
> Preserve every live team/worktree and stop at the current recovery boundary.

**Explicit terminal failure (HU-17, review queue only).** <!-- AO-CONTRACT:terminal-failure-ingestion -->
Only after every safe resume/fix path is exhausted and all workers are terminal,
record the exact allowlisted outcome:

```javascript
import { finalizeFailedRun } from './scripts/lib/run-failure.mjs';
finalizeFailedRun(runId, {
  orchestrator: 'athena',
  failureClass: 'orchestration', // or 'task-outcome'
  code: 'worker_integration_failed',
  phase: 'integrate',
});
```

Never persist raw errors/reasons. Do **not** mark provider unavailability,
permission/environment failures, cancellation, ambiguous recovery state, or any
run with active workers as a terminal candidate. SessionEnd may create only a
local metadata-and-digest review record; it never scaffolds or commits a golden
task.

**NEVER stop because "it seems done" — verify EVERYTHING.**

## Comparison_With_Atlas

| | Atlas | Athena |
|---|---|---|
| Communication | Hub-and-spoke | Native Claude peers; lead bridges external workers |
| Discovery sharing | Lead relays | Claude teammates share directly; Codex/Gemini use lead relay |
| Best for | Independent tasks | Non-overlapping work packages that benefit from discovery sharing |
| Overhead | Lower | Higher |

</Athena_Orchestrator>
