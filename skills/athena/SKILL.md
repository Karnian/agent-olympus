---
name: athena
description: Self-driving team orchestrator — spawns Claude + Codex + Gemini peer-to-peer team and loops until task is fully complete
---

<Athena_Orchestrator>

## Purpose

Athena is the self-driving team orchestrator. Unlike Atlas (one brain, many hands), Athena spawns a real team where workers talk to EACH OTHER. She never stops until every worker's output is integrated, tested, and reviewed.

Atlas = one brain delegating.
Athena = many brains collaborating.

## Use_When

- User says "athena", "아테나", "팀으로 해", "같이 해", "team", "collaborate"
- Task has interdependent parts (API + frontend + tests)
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
import { createRun, finalizeRun, getActiveRunId } from './scripts/lib/run-artifacts.mjs';
import { recoverOrphanedRun } from './scripts/lib/orphan-run-recovery.mjs';
import { loadCheckpoint } from './scripts/lib/checkpoint.mjs';

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
// no TeamCreate, Task, adapter spawn, or native teammate launch may follow.
const recoveredCheckpointRunId = orphanRecovery?.ok ? orphanRecovery.runId : null;
const createdAthenaRun = (activeAthenaRunId || recoveredCheckpointRunId)
  ? null
  : createRun('athena', <user_request>);
if (createdAthenaRun && !createdAthenaRun.ok) {
  throw new Error(`Athena run creation failed: ${createdAthenaRun.reason}; preserve all artifacts and stop`);
}
const runId = activeAthenaRunId
  || recoveredCheckpointRunId
  || createdAthenaRun.runId;
if (activeAthenaRunId && pendingCheckpoint?.runId && pendingCheckpoint.runId !== activeAthenaRunId) {
  throw new Error('Athena checkpoint belongs to a different active run; preserve both and stop');
}
const pipelineInit = initPipeline(runId, 'athena');
if (!pipelineInit.ok || pipelineInit.degraded) {
  throw new Error('Athena pipeline ledger is unavailable or corrupt; preserve all teams/worktrees and stop');
}
const { resumePhase, resumePolicy } = pipelineInit;
// On resume, jump to resumePhase. Earlier completed phases return skip:true;
// recover phases return reason:'recover' and MUST adopt persisted state.
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
  │ Native  │◄─────►│ Workers │◄──►│ Workers │
  │ Team    │       │         │    │         │
  └────┬────┘       └────┬────┘    └────┬────┘
       │                  │              │
  SendMessage        adapter-based    message queue
  TaskList           (appserver/      (enqueueMessage →
  (peer-to-peer)      exec/tmux)      auto-drain)
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
     supervisor state, and all worktrees. Do not call `createRun`, `TeamCreate`,
     `Task`, adapter spawn, or any native teammate launch.
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
  Max workers: <hasCodex ? '5 Claude + 2 Codex' : '5 Claude'> + <hasGeminiCli ? '2 Gemini' : '0 Gemini'>

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
await completePhase(runId, 'triage', undefined, {
  checkpointData: { teamDesign: metis_output, completedStories: [], activeWorkers: [] },
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
Does .ao/prd.json exist AND is it non-empty?
```

#### Case A: .ao/prd.json exists (user ran /plan beforehand)

Hermes validates the existing spec against the current task:
```
Task(subagent_type="agent-olympus:hermes", model="opus",
  prompt="VALIDATE this existing specification against the task and team design.

  Existing spec: <contents of .ao/prd.json>
  Task: <user_request>
  Team design: <metis_team_design>

  Check:
  1. Does the spec's problem statement match the actual task?
  2. Are user stories complete with GIVEN/WHEN/THEN acceptance criteria?
  3. Are there untestable words (robust, fast, user-friendly, seamless, efficient)?
  4. Are scope boundaries clear (goals vs non-goals)?
  5. Can stories be cleanly assigned to independent workers?

  If spec is SUFFICIENT: respond with 'VERDICT: PASS' and a one-line summary.
  If spec needs updates: respond with 'VERDICT: UPDATE' and the corrected spec
    in the same JSON format, preserving existing fields that are still valid.
  If spec is fundamentally mismatched: respond with 'VERDICT: RECREATE' and
    produce a new spec from scratch.")
```

If VERDICT is UPDATE or RECREATE → overwrite `.ao/prd.json` and `.ao/spec.md` with Hermes output.

#### Case B: .ao/prd.json does NOT exist (user skipped /plan)

Hermes creates a spec from the team design:
```
Task(subagent_type="agent-olympus:hermes", model="opus",
  prompt="Create a product specification for this task.

  Task: <user_request>
  Team design: <metis_team_design>
  External context (if gathered): <external_context>

  Produce a structured spec with:
  1. Problem Statement — WHO has this problem, WHAT is the pain, WHY now
  2. Target Users — specific personas
  3. Goals — specific, measurable objectives
  4. Non-Goals — explicitly out of scope
  5. User Stories — each with ID (US-001), JTBD format, GIVEN/WHEN/THEN acceptance criteria
  6. Success Metrics — measurable outcomes with target values
  7. Constraints — from team design analysis
  8. Risks & Unknowns — areas needing caution

  IMPORTANT: Replace untestable words (robust, fast, user-friendly, seamless,
  efficient, intuitive) with measurable alternatives.
  Ensure stories have clear boundaries so they can be assigned to independent workers.")
```

**Sub-agent output validation (Hermes) — MANDATORY:**
```
hermes_output = <result from Hermes Task() call above>

If hermes_output is empty OR hermes_output.length < 50:
  Output: "[Athena] ⚠ Hermes spec creation returned empty. Retrying with reduced input..."
  import { extractStructuralSummary } from './scripts/lib/input-guard.mjs';
  const { summary } = extractStructuralSummary(<user_request>, 100);
  hermes_output = Task(subagent_type="agent-olympus:hermes", model="sonnet",
    prompt="Create a product spec for: " + summary)

  If hermes_output is STILL empty:
    Output: "[Athena] ✗ Spec Gate FAILED — Hermes could not create spec after retry."
    Output: "[Athena] Try: (1) run /plan first, or (2) provide a smaller task scope."
    await addWisdom({ category: 'debug', lesson: 'Athena Spec Gate failed: Hermes empty output.', confidence: 'high' });
    STOP — do not proceed.
```

Write Hermes output to `.ao/spec.md` and `.ao/prd.json`.
Output: "[Athena] Spec gate passed — <N> user stories ready for team planning."

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

**[OPTIONAL] Consensus Plan** <!-- AO-CONTRACT:consensus-plan --> — for complex tasks with 3 or more user stories, replace the standard Prometheus + Momus single pass with the consensus-plan skill for a higher-confidence PRD:
```
Skill(skill="agent-olympus:consensus-plan",
  args="Run consensus planning for this task.
  Task: <user_request>
  Analysis: <metis_team_design>
  Spec: <contents of .ao/prd.json>
  Wisdom: <formatWisdomForPrompt()>
  External context (if gathered): <external_context>")
```
If consensus-plan is used, skip the standard Prometheus + Momus steps below and go directly to PRD generation.

**Standard path** (fewer than 3 stories or moderate complexity):
```
Task(subagent_type="agent-olympus:prometheus", model="opus",
  prompt="Team execution plan:
  - Assign tasks to workers by name
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

**Generate PRD** with worker assignments:
```json
{
  "projectName": "athena-<task-slug>",
  "userStories": [
    {
      "id": "US-001",
      "title": "...",
      "assignedWorker": "api-worker",
      "workerType": "claude",
      "acceptanceCriteria": ["GET /users returns 200", "POST creates user"],
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
- ✅ "GET /api/users returns 200 with User[] body"
- ✅ "Test file tests/auth.test.ts exists and all cases pass"

```javascript
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
import { readFileSync } from 'node:fs';
import { createWorkerWorktree } from './scripts/lib/worktree.mjs';
import { allocateTeamRunId, monitorTeam } from './scripts/lib/worker-spawn.mjs';
import {
  computeAthenaWorktreeDigest,
  planAthenaSpawnRecovery,
  validateAthenaCheckpointBinding,
} from './scripts/lib/athena-recovery.mjs';

const prd = JSON.parse(readFileSync('.ao/prd.json', 'utf-8'));
if (!/^athena-[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(prd.projectName)) {
  throw new Error('Unsafe Athena projectName for worker state');
}
const teamSlug = prd.projectName;
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
const storiesByWorker = new Map();
for (const story of prd.userStories) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(story.assignedWorker)) {
    throw new Error(`Unsafe assignedWorker: ${story.assignedWorker}`);
  }
  if (!['claude', 'codex', 'gemini'].includes(story.workerType)) {
    throw new Error(`Unsupported workerType: ${story.workerType}`);
  }
  const group = storiesByWorker.get(story.assignedWorker) || [];
  group.push(story);
  storiesByWorker.set(story.assignedWorker, group);
}
const workerDefinitions = [...storiesByWorker.entries()].map(([name, stories]) => {
  const workerType = stories[0].workerType;
  if (stories.some((story) => story.workerType !== workerType)) {
    throw new Error(`Worker ${name} has mixed provider types in one assignment`);
  }
  const requestedModels = new Set(stories.map((story) => story.model).filter(Boolean));
  if (requestedModels.size > 1) {
    throw new Error(`Worker ${name} has conflicting model assignments`);
  }
  return {
    name,
    type: workerType,
    // `sonnet` is a Claude tier, not a valid Codex/Gemini default. External
    // adapters select their own default unless the PRD supplies a
    // provider-specific model through a future explicit contract.
    model: workerType === 'claude' ? (stories[0].model || 'sonnet') : undefined,
    stories,
    prompt: stories.map((story) => [
      `${story.id}: ${story.title}`,
      `Acceptance criteria:\n${story.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}`,
    ].join('\n')).join('\n\n'),
  };
});

// AO-CONTRACT:spawn-progress — persist exact bounded identity BEFORE the first
// createWorkerWorktree / TeamCreate / Agent / spawnTeam call.
const intendedWorkers = workerDefinitions.map((worker) => worker.name).sort().join(',');
const adapterOnly = workerDefinitions.every((worker) => worker.type !== 'claude');
const hasAdapterWorkers = workerDefinitions.some((worker) => (
  worker.type === 'codex' || worker.type === 'gemini'
));
const plannedSpawnPath = adapterOnly
  ? 'adapter-only'
  : (hasNativeTeamTools ? 'native-or-mixed' : 'fallback-or-mixed');
const recoverySpawnIdentity = getPipelineState(runId).phases.spawn?.outputs;
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
const nativeTaskList = !adapterOnly && hasNativeTeamTools ? TaskList(teamSlug) : null;
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
if (workerDefinitions.length > 1 && Object.values(worktrees).some((item) => !item.created)) {
  throw new Error('Athena parallel execution requires isolated git worktrees; use Atlas or run workers serially');
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
    baseCommit,
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

**Claude workers** — dispatch depends on runtime capabilities:

#### Path A: Native Agent Teams (`hasNativeTeamTools === true`)

When `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set, use native team tools directly:

```
IF spawnRecoveryMode !== 'spawn': skip this entire block.
TeamCreate("athena-<slug>")
// If TeamCreate fails (tool unavailable, error response) → fall back to Path B for ALL workers.
// Log wisdom: "Native teams unavailable at runtime — fell back to adapter chain"
addEvent(runId, { type: 'native_team_created', detail: { teamName: "athena-<slug>" } })

For each Claude worker:
  1. Read `{ path: worktreePath, branch: branchName }` from `worktrees[worker.name]` created above.
  2. Task(team_name=teamSlug, name="<worker>",
       subagent_type="agent-olympus:<agentType>", model="<model>",
       prompt="You are <worker> on team athena.
       YOUR SCOPE: <files>
       YOUR TASK: <stories>
       YOUR WORKTREE: <worktreePath>  (work only inside this directory)
       PROTOCOL: Commit your progress to branch <branchName> before signalling done.
                 SendMessage to <workers> when done.
       CONSTRAINT: Do NOT edit files outside your scope or worktree.
       TDD_INSTRUCTION: If your story has testable acceptance criteria, follow TDD discipline:
         write a failing test first (RED), then minimum code to pass (GREEN), then refactor.
         Do not write production code before tests.
       [OPTIONAL] For new functionality: follow /tdd discipline when implementing testable features.
       [If harness_context exists:]
       ## Harness Constraints
       Follow these golden principles: <harness_context>
       Respect dependency layers defined in docs/ARCHITECTURE.md.")
  3. addEvent(runId, { type: 'native_teammate_spawned', detail: { worker: "<worker>", agentType: "<agentType>" } })
```

#### Path B: Fallback (`hasNativeTeamTools === false` or TeamCreate failed)

When native teams are unavailable, Claude workers are spawned as independent subagents:

```
IF spawnRecoveryMode !== 'spawn': skip this entire block.
For each Claude worker:
  1. Read `{ path: worktreePath, branch: branchName }` from `worktrees[worker.name]` created above.
  2. Agent(subagent_type="agent-olympus:<agentType>", model="<model>",
       prompt="You are <worker>.
       YOUR SCOPE: <files>
       YOUR TASK: <stories>
       YOUR WORKTREE: <worktreePath>  (work only inside this directory)
       PROTOCOL: Commit your progress to branch <branchName> before completion.
       CONSTRAINT: Do NOT edit files outside your scope or worktree.
       TDD_INSTRUCTION: (same as Path A)
       [If harness_context exists:] (same as Path A)")
```

Note: In Path B, Claude workers are independent batch executors — no inter-worker SendMessage.
The orchestrator bridges communication by reading worker outputs and injecting context into subsequent tasks.

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
const spawnCompletion = await completePhase(runId, 'spawn', {
  launchState: 'durable',
  worktreeDigest,
  adapterRunId,
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
// reason:'recover' adopts the persisted teamSlug/worktrees and polls only that
// team. It never calls createWorkerWorktree, TeamCreate, Agent, or spawnTeam.
const monitorCheckpoint = await loadCheckpoint('athena');
const monitorSpawnIdentity = getPipelineState(runId).phases.spawn?.outputs;
const phase3TeamSlug = monitorSpawnIdentity?.teamSlug;
const phase3IntendedWorkers = monitorSpawnIdentity?.intendedWorkers;
const phase3SpawnPath = monitorSpawnIdentity?.spawnPath;
const phase3AdapterRunId = monitorSpawnIdentity?.adapterRunId;
const phase3BaseCommit = monitorSpawnIdentity?.baseCommit;
const phase3WorktreeDigest = monitorSpawnIdentity?.worktreeDigest;
if (!validateAthenaCheckpointBinding(monitorCheckpoint, monitorSpawnIdentity, { cwd })
  || monitorCheckpoint.worktreeDigest !== phase3WorktreeDigest) {
  throw new Error('Athena monitor checkpoint does not belong to this run/team; preserve all workers and stop');
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
│     Check TaskList("athena-<slug>") for Claude worker status [LLM tool call]
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
  // w.errorReason / w.errorMessage: set for failures (auth_failed/rate_limited/crash/timeout/…)
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
- If `errorCheck.reason` is `'auth_failed'`, `'rate_limited'`, or `'not_installed'`, do NOT retry Codex for that error type again for any worker in this session.
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
}, {
  checkpointData: {
    runId,
    teamSlug: phase3TeamSlug,
    intendedWorkers: phase3IntendedWorkers,
    spawnPath: phase3SpawnPath,
    adapterRunId: phase3AdapterRunId,
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

// Sort workers by dependency order (dependents last)
const orderedWorkers = sortByDependency(completedWorkers);
const phase4Worktrees = integrationCheckpoint.worktrees;
const mergedWorkers = new Set(integrationCheckpoint.mergedWorkers ?? []);
const integrationProviderTeams = new Set(integrationCheckpoint.providerTeamsToShutdown ?? []);
if (!phase4Worktrees || typeof phase4Worktrees !== 'object') {
  throw new Error('Phase 4 checkpoint has no worktree mapping; preserve .ao/worktrees and recover the checkpoint before integration');
}

for (const worker of orderedWorkers) {
  if (mergedWorkers.has(worker.name)) continue;  // idempotent resume after a durable merge checkpoint

  const { branch, path, created } = phase4Worktrees[worker.name] ?? {};
  if (!created || !branch || !path || path === cwd) continue;  // fallback/shared-root mode

  const dirty = execFileSync('git', ['-C', path, 'status', '--porcelain'], {
    encoding: 'utf-8',
  }).trim();
  if (dirty) {
    throw new Error(`Worker ${worker.name} completed with uncommitted work; preserve its worktree and resume integration`);
  }

  const result = mergeWorkerBranch(cwd, branch, worker.name);
  if (!result.success) {
    // mergeWorkerBranch aborts the failed merge. Preserve the branch/worktree;
    // route the conflict through the normal bounded retry path before cleanup.
    throw new Error(`Worker ${worker.name} merge failed: ${result.conflicts.join(', ')}`);
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
    baseCommit: integrationSpawnIdentity.baseCommit,
    launchState: integrationSpawnIdentity.launchState,
    worktreeDigest: integrationSpawnIdentity.worktreeDigest,
    prdSnapshot: <prd.json>,
    completedStories,
    activeWorkers: [],
    worktrees: phase4Worktrees,
    mergedWorkers: [...mergedWorkers],
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

**Codex Cross-Validation** <!-- AO-CONTRACT:cross-validation --> (per story) — MANDATORY: before marking a story `passes: true`:
```bash
# CRITICAL: resolve binary path first — worktree shells may not inherit full PATH
CODEX_BIN=$(which codex 2>/dev/null || echo /opt/homebrew/bin/codex)
tmux new-session -d -s "athena-<slug>-codex-xval-<story-id>" -c "<cwd>"
tmux send-keys -t "athena-<slug>-codex-xval-<story-id>" "\"$CODEX_BIN\" <approval-flag> exec \"Cross-validate implementation of <US-ID> (<story title>). Files changed in merged tree: <post-merge files>. Acceptance criteria: <criteria>. Golden principles: <harness_context or 'none'>. Check: (1) all acceptance criteria met with evidence, (2) no architectural layer violations, (3) golden principles followed. Reply: PASS or FAIL with specific findings.\"" Enter
# Poll: tmux capture-pane -pt "athena-<slug>-codex-xval-<story-id>" -S -200 (every 15s)
# Cleanup: tmux kill-session -t "athena-<slug>-codex-xval-<story-id>"
```
- **PASS** → `addVerification(runId, { story_id, verdict: 'pass', evidence: 'codex xval passed', verifiedBy: 'codex' })` → mark `passes: true`, proceed.
- **FAIL** → `addVerification(runId, { story_id, verdict: 'fail', evidence: '<specific findings>', verifiedBy: 'codex' })` → route findings back to the responsible worker via inbox for fix, re-validate (max 2 cycles).
- **Codex unavailable BUT Gemini available** → use Gemini as alternative cross-validator:
```bash
GEMINI_BIN=$(which gemini 2>/dev/null || echo /opt/homebrew/bin/gemini)
tmux new-session -d -s "athena-<slug>-gemini-xval-<story-id>" -c "<cwd>"
tmux send-keys -t "athena-<slug>-gemini-xval-<story-id>" "\"$GEMINI_BIN\" <approval-flag> -p \"Cross-validate implementation of <US-ID>. Files: <files>. Criteria: <criteria>. Reply PASS or FAIL with findings.\"" Enter
```
  Record: `addVerification(runId, { story_id, verdict: 'pass'|'fail', evidence: '<findings>', verifiedBy: 'gemini' })`
- **Neither Codex nor Gemini available** → **MUST explicitly record the skip**: `addVerification(runId, { story_id, verdict: 'skip', evidence: 'no external validator available: cross-validation skipped', verifiedBy: 'athena' })`. Log: `[Athena] Cross-validation skipped for <story-id>: no external validator available.`
- **Note**: Run xval against post-merge file paths, not per-worker file paths, to catch violations introduced during conflict resolution.

> **IMPORTANT**: "skip silently" does NOT mean "do nothing". Every story MUST have a verification record — pass, fail, or explicit skip. The PR verification gate will block if any story lacks a record.

Mark stories `passes: true` in prd.json only after Codex cross-validation passes (or is unavailable with explicit skip recorded).

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
- CONDITIONAL → log, proceed
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

```bash
node -e '
  import("./scripts/lib/review-router.mjs").then(async (m) => {
    const { execSync } = await import("node:child_process");
    // Use full branch diff vs origin/HEAD (not just HEAD~1) so multi-commit branches route correctly.
    const base = (() => {
      try { return execSync("git symbolic-ref refs/remotes/origin/HEAD", { encoding: "utf-8" }).trim().replace(/^refs\/remotes\/origin\//, ""); }
      catch { return "main"; }
    })();
    const range = `origin/${base}...HEAD`;
    const paths = execSync(`git diff --name-only ${range}`, { encoding: "utf-8" })
      .split("\n").filter(Boolean);
    const content = execSync(`git diff ${range}`, { encoding: "utf-8" });
    const r = m.routeReviewers({ diffPaths: paths, diffContent: content });
    console.log(JSON.stringify(r, null, 2));
  });
'
```

Spawn ONLY the reviewers in `r.reviewers`, in parallel.

**Step 5.1 — Handle reviewer escalation** <!-- AO-CONTRACT:review-escalation -->

If any reviewer emits `{type: 'RE-REVIEW-REQUESTED', additionalReviewer, reason}`,
call `handleEscalation(currentSet, flag)` and spawn the requested reviewer in the
**same iteration** (not the next loop).

```
┌─→ loopTick(runId, 'review') → if !allowed: stop the review loop, escalate unresolved findings
│   ALL APPROVED → DONE ✓
│   ANY ESCALATION → spawn additional reviewer same iteration (does NOT consume a round)
│   ANY REJECTED → use the bounded reattempt below, fix in the root integration tree, re-review
└── Loop until ALL APPROVED or loopTick('review') returns !allowed (default cap 3)
```

```javascript
// AO-CONTRACT:review-reject-reattempt
const reviewRetry = reattempt(runId, {
  reopen: ['integrate'],
  reason: 'review_reject',
});
if (!reviewRetry.allowed) {
  // STOP + preserve run/worktrees; the 15-attempt cap is authoritative.
}
// Athena has no `verify` phase. Never target that Atlas-only phase; return through the
// integrate recovery path and then start the next review round.
```

**Rollback**: `.ao/autonomy.json` → `{ "reviewRouter": { "disabled": true } }`.

After all required reviewers approve:

```javascript
await completePhase(runId, 'review', undefined, {
  checkpointData: {
    runId,
    teamSlug: reviewSpawnIdentity.teamSlug,
    intendedWorkers: reviewSpawnIdentity.intendedWorkers,
    spawnPath: reviewSpawnIdentity.spawnPath,
    adapterRunId: reviewSpawnIdentity.adapterRunId,
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

### Phase 5b — SLOP CLEAN + COMMIT

Finalize is `reexecute` on resume. Use `runId` as an idempotency marker for the
changelog and exec-plan row: update an existing row/entry for this run instead
of appending a duplicate.

Resolve the release policy before invoking any helper that can offer or perform
shipping. Explicit shipping constraints in the original task brief always take
precedence over `.ao/autonomy.json`, including `ship.mode: "auto"`.

```javascript
import { loadAutonomyConfig, resolveShipMode } from './scripts/lib/autonomy.mjs';

const config = loadAutonomyConfig(cwd);
const taskForbidsShipping = <true only when the original task explicitly forbids push or PR>;
const configuredShipMode = resolveShipMode(config);
const shipMode = taskForbidsShipping ? 'never' : configuredShipMode;
const noShip = shipMode === 'never';
```

The orchestrator model answering its own y/n prompt is not user approval. In
`ask` mode, only an actual human response from an interactive user channel
counts as approval.

After review approved:
1. Run `Skill(skill="agent-olympus:slop-cleaner")` on all changed files
2. Re-run build + tests to verify no regression
3. Run `Skill(skill="agent-olympus:git-master")` for atomic commits
4. **Optional branch completion**: only when `shipMode === 'auto'`, invoke
   `Skill(skill="agent-olympus:finish-branch")` for its local verification
   checklist. Explicitly stop it before any push, PR, merge, or option prompt;
   Phase 6 below is the sole owner of outward shipping actions. Skip this helper
   entirely for `never` and `ask`.

### Phase 5c — CHANGELOG UPDATE

Skip the entire changelog update when
`noShip || config.ship.updateChangelog === false`. In particular,
`ship.mode: "never"` suppresses this release side effect.

Generate a CHANGELOG entry from the completed PRD:
```bash
node -e "
  import { generateChangelogEntry, prependToChangelog } from './scripts/lib/changelog.mjs';
  import { readFileSync } from 'fs';
  const prd = JSON.parse(readFileSync('.ao/prd.json', 'utf8'));
  const entry = generateChangelogEntry({ prd, version: '<detected or specified>', date: new Date().toISOString().slice(0,10) });
  prependToChangelog('CHANGELOG.md', entry);
"
```
If no CHANGELOG.md exists, one is created. Include in the next commit.

### Phase 5d — EXEC-PLAN UPDATE

Skip the entire tracker update (including moving an active plan) when
`noShip || config.ship.updateTechDebtTracker === false`. In particular,
`ship.mode: "never"` suppresses this release side effect.

If `docs/exec-plans/` exists, record this task as a completed plan entry:
```bash
# Ensure tracker has header row on first use
if [ ! -f docs/exec-plans/tech-debt-tracker.md ]; then
  printf "# Tech Debt Tracker\n| Date | Task | Files | Stories | Notes |\n|------|------|-------|---------|-------|\n" \
    > docs/exec-plans/tech-debt-tracker.md
fi
echo "| $(date +%Y-%m-%d) | <task-slug> | <N files changed> | <N stories> | <one-line summary> |" \
  >> docs/exec-plans/tech-debt-tracker.md
```
If an active exec-plan file exists in `docs/exec-plans/active/`, move it to `docs/exec-plans/completed/`.
Include this file in the commit.

```javascript
await completePhase(runId, 'finalize', undefined, {
  checkpointData: {
    runId,
    teamSlug: finalizeSpawnIdentity.teamSlug,
    intendedWorkers: finalizeSpawnIdentity.intendedWorkers,
    spawnPath: finalizeSpawnIdentity.spawnPath,
    adapterRunId: finalizeSpawnIdentity.adapterRunId,
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
In unattended/headless `ask` mode, optionally send the blocked notification,
halt shipping without a push, terminally skip ship/CI, and proceed safely to
COMPLETION. The notification is gated by `config.notify.onBlocked`:

```javascript
import { execFileSync } from 'node:child_process';
import { preflightCheck } from './scripts/lib/pr-create.mjs';

const shippingCheckpoint = await loadCheckpoint('athena');
const shippingSpawnIdentity = getPipelineState(runId).phases.spawn?.outputs;
if (!validateAthenaCheckpointBinding(shippingCheckpoint, shippingSpawnIdentity, { cwd })) {
  throw new Error('Athena shipping checkpoint does not belong to this run/team; stop before any push');
}

const hasInteractiveUserChannel = <true only when an actual human can answer now>;
let userApprovedPush = false;
let pushPerformed = false;
let createdPrUrl = null;

if (shipMode === 'ask' && hasInteractiveUserChannel) {
  userApprovedPush = <true only after the actual human answers yes>;
} else if (shipMode === 'ask') {
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
  || (shipMode === 'ask' && userApprovedPush === true);
const preflight = shippingApproved
  ? preflightCheck()
  : { ok: true, errors: [] };
const shippingApplicable = preflight.ok && shippingApproved;
// `user-declined` is the runner's allowlisted no-approval bucket; it also
// covers headless ask where no human approval channel existed.
const shipSkipReason = noShip
  ? 'not-applicable'
  : (!preflight.ok ? 'preflight-unavailable' : 'user-declined');
const shipGate = shippingApplicable
  ? enterPhase(runId, 'ship')
  : skipPhase(runId, 'ship', shipSkipReason);
```

For `shipMode === 'never'`, report exactly:
`branch ready: <branchName> — push/PR은 사용자가 직접`.
If preflight fails (no gh, no remote, on main branch), report its errors and do
not push. Verification and PR creation below run only when
`shippingApplicable && !shipGate.skip`.

#### Verification Gate (MANDATORY — blocks PR creation) <!-- AO-CONTRACT:verification-gate -->
Before any shipping activity, check that ALL stories have verification records:
```javascript
import { checkVerificationGate } from './scripts/lib/run-artifacts.mjs';
const storyIds = prd.userStories.map(s => s.id);
const gate = checkVerificationGate(runId, storyIds);

if (!gate.gatePass) {
  // Stories without verification records — MUST attempt xval for each
  for (const missingId of gate.missing) {
    // 1. First attempt: try Codex cross-validation (same as Phase 4 xval step)
    // 2. If Codex unavailable, record explicit skip:
    addVerification(runId, {
      story_id: missingId,
      verdict: 'skip',
      evidence: 'codex unavailable: verification gate catch-up',
      verifiedBy: 'athena'
    });
  }
  // Re-check — if STILL failing, STOP (addVerification may have silently failed)
  const recheck = checkVerificationGate(runId, storyIds);
  if (!recheck.gatePass) {
    console.error(`[Athena] VERIFICATION GATE FAILED — ${recheck.missing.length} stories still lack records: ${recheck.missing.join(', ')}`);
    console.error(`[Athena] Cannot create PR until all stories have verification records.`);
    // STOP — do not proceed to PR creation
  }
}

if (gate.skipped.length > 0) {
  console.log(`[Athena] ${gate.skipped.length} stories had Codex xval skipped — results included in PR body`);
}
```

#### Preflight

Use the cached `preflight` result above for the shipping decision; do not rerun
preflight after the runner phase transition. If it failed, shipping is already
terminally skipped with `preflight-unavailable`, so report its errors and
continue to COMPLETION.

#### Push & Create PR
If `shippingApplicable && !shipGate.skip`, push once and then reuse an existing
PR or create a new draft. The push is common to both PR branches:

```javascript
import { execFileSync } from 'node:child_process';
import {
  buildPRBody,
  createPR,
  detectBaseBranch,
  extractIssueRefs,
  findExistingPR,
} from './scripts/lib/pr-create.mjs';

execFileSync('git', ['push', '-u', 'origin', 'HEAD'], { cwd, stdio: 'inherit' });
pushPerformed = true;

const existing = findExistingPR(branchName);
if (existing.found) {
  createdPrUrl = existing.prUrl ?? null;
} else {
  const baseBranch = detectBaseBranch(cwd, config.ship.baseBranch);
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
  const created = createPR({
    title: prd.projectName,
    body: body + (issues.length ? '\n\nCloses ' + issues.map(i => '#'+i).join(', ') : ''),
    draft: config.ship.draftPR,
    baseBranch,
    cwd,
  });
  createdPrUrl = created.ok ? created.prUrl : null;
}
```

Report `createdPrUrl` to the user when present.

In `ask` mode, ask `"Push and create PR? [y/n]"` only through an actual
interactive user channel. A decline and a headless/unattended run both leave
`pushPerformed === false`.

If shipping was applicable and the verification gate plus PR operation reached a
durable terminal result, call:

```javascript
await completePhase(runId, 'ship', undefined, {
  checkpointData: { ...shippingCheckpoint, runId },
});
```

A blocked verification gate leaves the phase nonterminal for recovery.

### Phase 6b — CI WATCH (Monitor + Auto-Fix) <!-- AO-CONTRACT:ci-watch -->

```javascript
const ciApplicable = Boolean(pushPerformed && createdPrUrl && config.ci.watchEnabled);
const ciCheckpoint = await loadCheckpoint('athena');
const ciSpawnIdentity = getPipelineState(runId).phases.spawn?.outputs;
if (!validateAthenaCheckpointBinding(ciCheckpoint, ciSpawnIdentity, { cwd })) {
  throw new Error('Athena CI checkpoint does not belong to this run/team; stop polling and preserve state');
}
const ciGate = ciApplicable
  ? enterPhase(runId, 'ci')
  : skipPhase(runId, 'ci', pushPerformed && createdPrUrl ? 'watch-disabled' : 'no-pr');
```

If an actual push completed, a PR URL exists, and `config.ci.watchEnabled` is true:

```
┌─→ Poll CI status:
│     const ciTick = loopTick(runId, 'ci')
│     if (!ciTick.allowed) → STOP polling, preserve the nonterminal phase, escalate
│     node -e "import('./scripts/lib/ci-watch.mjs').then(m =>
│       m.watchCI({ branch, maxCycles: 1, pollIntervalMs: config.ci.pollIntervalMs })
│       .then(r => console.log(JSON.stringify(r))))"
│
│   ├─ status: 'passed' →
│   │   node scripts/notify-cli.mjs --event ci_passed --orchestrator athena --body "All CI checks passed."
│   │   → DONE ✓
│   │
│   ├─ status: 'failed' →
│   │   1. Notify: node scripts/notify-cli.mjs --event ci_failed --orchestrator athena --body "CI failed"
│   │   2. Fetch logs:
│   │      node -e "import('./scripts/lib/ci-watch.mjs').then(m => console.log(m.getFailedLogs('<runId>')))"
│   │   3. Diagnose and fix (same escalation chain as Phase 4):
│   │      Task(subagent_type="agent-olympus:debugger", model="sonnet",
│   │        prompt="CI failed after PR push. Fix the issue.
│   │        CI failure logs: <failed_logs>
│   │        Previous learnings: <formatWisdomForPrompt(queryWisdom(null,10))>")
│   │   4. If debugger fails → Skill(skill="agent-olympus:systematic-debug")
│   │   5. If systematic-debug fails → Skill(skill="agent-olympus:trace")
│   │   6. After fix: re-run local verify (build + test), then:
│   │      git add -A && git commit -m "fix: resolve CI failure" && git push
│   │   7. Re-poll CI (back to top of loop)
│   │
│   └─ status: 'timeout' | 'skipped' → report to user, proceed
│
└── Loop (max config.ci.maxCycles attempts, default 2)
```

If CI passes → DONE. If CI fails after max cycles → escalate to user with failure logs.
On passed, timeout, or an explicitly reported provider skip, call
`await completePhase(runId, 'ci', undefined, { checkpointData: { ...ciCheckpoint, runId } })`.
Do not separately self-count `config.ci.maxCycles`; the runner's CI counter is
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
- `clearTeamStatus(teamName)` — delete `.ao/teams/<slug>/status.jsonl` (import from `scripts/lib/worker-status.mjs`)
- IF Path A (native teams):
  - `TeamDelete("athena-<slug>")` — if TeamDelete fails, log warning but don't block
  - `addEvent(runId, { type: 'native_team_deleted', detail: { teamName: "athena-<slug>" } })`
- Shut down Codex + Gemini workers properly via adapter lifecycle:
  ```javascript
  import { shutdownTeam } from './scripts/lib/worker-spawn.mjs';
  await shutdownTeam(completionSpawnIdentity.teamSlug, cwd);  // supervisor-first: signals each worker's detached supervisor group (whose SIGTERM handler shuts the adapter down), then reaps any orphaned adapter group; tmux workers killed directly
  ```
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

```bash
# When createdPrUrl exists:
node scripts/notify-cli.mjs --event complete --orchestrator athena --body "N/N stories passed. PR: <url>"

# When pushPerformed is true but PR creation failed:
node scripts/notify-cli.mjs --event complete --orchestrator athena --body "N/N stories passed. Branch pushed; PR creation failed — create the PR manually."

# Otherwise (no push):
node scripts/notify-cli.mjs --event complete --orchestrator athena --body "N/N stories passed. branch ready: <branchName> — push/PR은 사용자가 직접"
```

Report: PRD stories (N/N), per-worker summary, files changed, coordination log,
verification results, and the shipping outcome. Include the PR URL when one
exists; report a pushed-branch/PR-failure warning when applicable; otherwise
report exactly `branch ready: <branchName> — push/PR은 사용자가 직접`.

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

**Claude ↔ Claude** (Path A — native teams): `SendMessage(to="worker", content="...")`
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
| Communication | Hub-and-spoke | Peer-to-peer |
| Discovery sharing | Lead relays | Workers share directly |
| Best for | Independent tasks | Interdependent tasks |
| Overhead | Lower | Higher |

</Athena_Orchestrator>
