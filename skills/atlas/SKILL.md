---
name: atlas
description: Self-driving sub-agent orchestrator — analyzes, plans, executes, and loops until task is fully complete
---

<Atlas_Orchestrator>

## Purpose

Atlas is the self-driving orchestrator. Give it ANY task and it will autonomously complete it using sub-agents. It never stops early — it keeps looping until every acceptance criterion is met, every test passes, and every review is approved.

You say it. Atlas finishes it. No exceptions.

## Use_When

- User says "atlas", "아틀라스", "do it", "알아서 해", "해줘", "just do it", "figure it out"
- Any task that needs autonomous completion
- User doesn't want to babysit — just wants it done

## Do_Not_Use_When

- User explicitly says "athena" or "팀으로 해" (use athena for team mode)
- User wants to co-author interactively

## Core_Principle

**NEVER STOP UNTIL DONE.** After each phase, evaluate:
- Are all acceptance criteria met? If NO → fix and re-verify
- Does the build pass? If NO → debug and fix
- Do all tests pass? If NO → debug and fix
- Is the code review clean? If NO → fix issues and re-review
- Only stop when ALL checks pass, or when the **Phase Runner** (below) returns a stop signal.

## Phase_Runner (deterministic phase ledger + loop-guard chokepoint — MANDATORY)

The phase order AND the loop bounds are NOT self-counted by you. They are owned by
`scripts/lib/phase-runner.mjs`, which persists a per-run phase ledger to
`.ao/artifacts/runs/<runId>/pipeline.json` and is the **sole** caller of the
loop-guard caps (15 iterations / 3 review rounds / same-error-3×). The runner is the
chokepoint: you reach every cap consult THROUGH a runner method and you do NOT import
`loop-guard` directly. Phase state + counts survive context compaction / fresh-process
polling, and completed phases are never re-run on resume (exactly-once).

```javascript
// AO-CONTRACT:runner-init
import {
  initPipeline, enterPhase, beginAttempt, reattempt, loopTick,
  recordPhaseError, completePhase, skipPhase, reopenPhase, getPipelineState,
  isComplete,
} from './scripts/lib/phase-runner.mjs';
import {
  addEvent, appendUserTaskUpdate, createRun, finalizeRun, getActiveRunId,
  getRun, getUserTaskUpdates,
} from './scripts/lib/run-artifacts.mjs';
import { loadAutonomyConfig, resolveRunShipMode } from './scripts/lib/autonomy.mjs';
const currentAtlasRequest = <user_request>;
if (typeof currentAtlasRequest !== 'string' || !currentAtlasRequest.trim()) {
  throw new Error('Atlas current user request is unavailable; stop before creating or resuming a run');
}
const activeAtlasRunId = getActiveRunId('atlas');
const createdAtlasRun = activeAtlasRunId ? null : createRun('atlas', currentAtlasRequest);
if (createdAtlasRun && !createdAtlasRun.ok) {
  throw new Error(`Atlas run creation failed: ${createdAtlasRun.reason}; preserve state and stop`);
}
// runId is the exact active/created id — the SAME one passed to
// addVerification() / checkVerificationGate().
const runId = activeAtlasRunId || createdAtlasRun.runId;
// Every invocation, including a follow-up that resumes an active run, must
// atomically append the current user-authored constraint to the strict task
// ledger before the pipeline can continue. The best-effort event JSONL remains
// audit-only and is never a shipping-policy source.
const appendedTaskUpdate = appendUserTaskUpdate(runId, currentAtlasRequest, {
  allowCreate: createdAtlasRun !== null,
});
if (!appendedTaskUpdate.ok
  || appendedTaskUpdate.updates?.at(-1)?.task !== currentAtlasRequest) {
  throw new Error('Atlas current user request was not durably appended; preserve the run and stop');
}
const readDurableTaskBrief = action => {
  const runRecord = getRun(runId);
  const strictUpdates = getUserTaskUpdates(runId);
  if (runRecord.summary?.runId !== runId
    || runRecord.summary?.orchestrator !== 'atlas'
    || typeof runRecord.summary?.task !== 'string'
    || !runRecord.summary.task.trim()
    || strictUpdates.ok !== true
    || strictUpdates.updates.length < 1
    || strictUpdates.updates.some((update, index) => (
      update?.sequence !== index + 1
      || typeof update?.task !== 'string'
      || !update.task.trim()
    ))) {
    throw new Error(`Atlas durable task provenance is unavailable before ${action}; stop outward actions`);
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
const pipelineInit = initPipeline(runId, 'atlas');
if (!pipelineInit.ok || pipelineInit.degraded) {
  throw new Error('Atlas pipeline ledger is unavailable or corrupt; preserve all artifacts and stop');
}
const { resumePhase, resumePolicy } = pipelineInit;
// On resume, jump to resumePhase; every earlier enterPhase below returns { skip:true }.
```

The runner methods replace the old direct loop-guard calls one-for-one:

- **Each phase boundary:** `const g = enterPhase(runId, '<id>'); if (!g.skip) { …phase
  work verbatim… await completePhase(runId, '<id>'); }`. `completePhase` writes the
  ledger first, then the checkpoint payload — you no longer call `saveCheckpoint` with
  a phase number.
- **Outer NEVER-STOP loop** (each execute→verify→review pass): `beginAttempt(runId)`
  once at the head (cap 15); a review reject re-enters via `reattempt(runId,
  {reopen:['verify'], reason:'review_reject'})`, which ticks the cap atomically.
  `!allowed` ⇒ STOP + escalate "15 iteration limit exceeded".
- **On every verify/build/test failure** (Phase 4), before retrying: `const e =
  recordPhaseError(runId, 'verify', <first error line OR error code>)`;
  `e.shouldEscalate` (same error 3×) ⇒ STOP + escalate, do NOT retry the same fix. The
  runner normalizes volatile line numbers / hex / ANSI so shifting positions across
  attempts still count as "the same error".
- **Top of every Phase 5 review round:** `loopTick(runId, 'review')` (cap 3);
  `!allowed` ⇒ stop the review loop, escalate unresolved findings.

**Persistence safety:** initialization failure, `unsafe-run-path`, a terminal result,
or a transition denial is authoritative — preserve the active run and STOP. A normal
non-security `degraded:true` observation can use the prose bounds only as a backstop;
it never authorizes bypassing a phase boundary, spawning work, or finalizing. A genuine
`allowed:false` / `shouldEscalate:true` with `degraded:false` is likewise authoritative — STOP.

## Architecture

```
User Request
    │
    ▼
Phase 0: TRIAGE + ANALYZE (single metis call) ──→ trivial? ──→ EXECUTE DIRECTLY
    │
    ▼ (moderate+)
Phase 1: OPTIONAL DEEP-DIVE / EXTERNAL CONTEXT
    │   (reuses Phase 0 analysis fields — no second metis call)
    ▼
Phase 1.5: SPEC GATE (hermes agent)
    │   ├── .ao/prd.json exists → validate spec
    │   └── .ao/prd.json missing → create spec
    ▼
Phase 2: PLAN (prometheus agent) ←──┐
    │                                │ REJECTED
    ▼                                │
Phase 2b: VALIDATE PLAN (momus) ────┘
    │ APPROVED
    ▼
Phase 3: EXECUTE (parallel sub-agents + Codex)
    │
    ▼
Phase 4: VERIFY (build + test + lint)
    │                    │
    │ ALL PASS           │ ANY FAIL
    ▼                    ▼
Phase 5: REVIEW ←── Fix & Retry (debugger agent)
    │                    │
    │ ALL APPROVED       │ ANY REJECTED
    ▼                    ▼
  DONE ←──────────── Fix & Re-review
```

## Steps

### Phase 0 — TRIAGE

#### Light-Mode Resolution (Phase 4, 2026-04-22) <!-- AO-CONTRACT:light-mode-resolution -->

Before any sub-agent is spawned, resolve the orchestrator mode. Light mode
skips momus + architect review stages. Source precedence (highest first):
CLI flag `--light` → `.ao/autonomy.json` `mode: "light"` → default `full`.

```javascript
import { loadAutonomyConfig } from './scripts/lib/autonomy.mjs';
import {
  resolveMode, buildConfirmMessage, stageFilter, logLightModeEvent,
} from './scripts/lib/light-mode.mjs';

const _autonomy = loadAutonomyConfig(process.cwd());
// Note on CLI args: Claude Code skills are NOT Node CLI entrypoints; the
// orchestrator scans the user request for a literal "--light" token and
// synthesises a cliArgs array. Example: if the user wrote
// "/atlas --light rename the button", pass ['--light'] here.
const _cliArgs = /(^|\s)--light(\s|$)/.test(<user_request>) ? ['--light'] : [];
const _modeResolve = resolveMode(_autonomy, _cliArgs);
let orchMode = _modeResolve.mode;  // mutable — auto-escalate below may flip it

if (orchMode === 'light' && _modeResolve.requiresConfirm) {
  // CLI-requested light mode. Need explicit user confirmation before skipping.
  if (!_modeResolve.safeToAutoAccept) {
    // Non-interactive (CI / no TTY / pipe). Never auto-accept. Fall back.
    orchMode = 'full';
    await logLightModeEvent({
      event: 'exited',
      reason: 'non-interactive environment — cannot confirm light mode, running full',
    });
    Output: "[Atlas] Non-interactive environment detected — running full pipeline (set `mode:\"light\"` in .ao/autonomy.json to enable light in CI).";
  } else {
    const msg = buildConfirmMessage({ taskDescription: <user_request>, stagesSkipped: ['momus', 'architect'] });
    const answer = await (typeof AskUserQuestion === 'function'
      ? AskUserQuestion({ title: msg.title, body: msg.body, options: msg.options })
      : (Output: msg.body, null));
    if (!answer || !/^Yes/i.test(String(answer))) {
      orchMode = 'full';
      Output: "[Atlas] User declined (or no response) — running full pipeline.";
    } else {
      await logLightModeEvent({
        event: 'entered', reason: 'user confirmed CLI --light',
        stagesSkipped: ['momus', 'architect'], riskyMatches: msg.riskyMatches,
      });
      Output: "[Atlas] Light mode ACTIVE — skipping: momus, architect. Any review reject will auto-escalate.";
    }
  }
} else if (orchMode === 'light' && _modeResolve.source === 'autonomy') {
  // Config-level opt-in — no confirm, but log for observability.
  await logLightModeEvent({
    event: 'entered', reason: 'autonomy.json mode=light',
    stagesSkipped: ['momus', 'architect'],
  });
  Output: "[Atlas] Light mode ACTIVE (autonomy.json) — skipping: momus, architect.";
}

const _stageFilter = stageFilter(orchMode);
```

After each review stage (Phase 2b momus, architect), if `orchMode === 'light'`
and the reviewer REJECTs, import `autoEscalateOnReject` (and `registerEscalation` from
`scripts/lib/stage-escalation.mjs`), flip `orchMode = 'full'`,
update `_stageFilter = stageFilter(orchMode)`, call `logLightModeEvent({ event: 'escalated', rejectingStage, rejectReason })`,
then **rewind to Phase 2b** through the runner's policy door:
```javascript
// AO-CONTRACT:light-mode-rewind — a POLICY rewind, NOT an outer attempt: it does NOT tick the 15-cap.
const esc = registerEscalation(runId, 'light-mode-rewind', { cap: 2 });  // its OWN cap (stage-escalation.mjs, NOT loop-guard)
if (!esc.allowed) {
  // 2-rewind cap reached — STOP + escalate to user, do NOT rewind again
} else {
  reopenPhase(runId, 'plan', { reason: 'light_mode_rewind' });           // reopens the plan phase for re-validation
}
```
re-run momus on the current plan, then architect review, before returning to Phase 3.

**Phase 2 re-entry regimen (Codex Phase 4 #3)** — when auto-escalation
fires AFTER Phase 3 execution has started (e.g. code-reviewer rejects in
Phase 5), the orchestrator saves the current iteration's work, then runs **the same
cap-checked rewind block above** (`registerEscalation` → if `!esc.allowed` STOP, else
`reopenPhase('plan', {reason:'light_mode_rewind'})`) to insert the skipped momus
validation on the *actual* plan that was executed, then continues Phase 5 re-review with
architect. If
momus rejects retroactively, feed back to prometheus (same retry flow as full mode) and
re-execute the affected stories via `reattempt(runId, { reopen: ['execute', 'verify'],
reason: 'light_mode_reexec' })` — `reopenPhase('plan')` alone leaves execute/verify
`completed` (they would skip in `enterPhase`), so re-execution must reopen them, and that
re-execution legitimately consumes an outer iteration. The 2-rewind cap
(`registerEscalation(runId, 'light-mode-rewind', { cap: 2 })`, checked for `allowed`
above) prevents runaway loops — a SEPARATE budget from the 15-iteration cap.

#### Checkpoint Recovery + Phase-Ledger Init

Before starting any work, establish the run id and the phase ledger:
1. Resolve `activeAtlasRunId = getActiveRunId('atlas')`; only when absent call `createdAtlasRun = createRun('atlas', <user_request>)`. If `!createdAtlasRun.ok`, STOP and preserve state. Otherwise use `runId = activeAtlasRunId || createdAtlasRun.runId` (from `run-artifacts.mjs`).
2. `const { resumePhase, resumePolicy } = initPipeline(runId, 'atlas')` — the runner's resume point (see Phase_Runner section).
3. Check for an interrupted session: `loadCheckpoint('atlas')` (carries the rich payload).
4. If `resumePhase` is past `triage` OR a checkpoint is found, present to user: "[formatCheckpoint output]. Resume or restart?"
   - **Resume** → jump to `resumePhase`; every earlier `enterPhase` returns `{ skip:true }` (completed phases are never re-run). Restore the rich payload (`prdSnapshot`) from the checkpoint, but read **story-level truth** (which stories passed) from `.ao/prd.json` + the verification ledger, NOT from a possibly-stale `completedStories`.
   - **Restart** → first terminalize the exact active run through the categorized `cancelled/user_cancelled` failure path and verify its active pointer was cleared. Then `clearCheckpoint('atlas')`, call `createRun('atlas', <user_request>)`, and check its `ok` result before initializing a fresh ledger. If terminalization, pointer clearing, or new-run creation fails, STOP and preserve the old run; never overwrite its pointer.

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
  Store as `<harness_context>` — inject into every executor prompt in Phase 3.
  Log: `[Atlas] Harness loaded: <N> golden principles, architecture layers defined.`

- **HARNESS_MISSING**:
  - For `complex` or `architectural` tasks → suggest to user:
    `"[Atlas] Harness not initialized. Run /harness-init for full setup (recommended). Proceeding without it."`
  - For trivial/moderate tasks → skip silently, proceed.

**Phase Guard — early checkpoint + preflight:**

```javascript
// Step 1: Enter the triage phase (resume-aware ledger entry; replaces the early checkpoint)
// The earlier Phase 0 steps (light-mode resolution, checkpoint recovery, wisdom load,
// onboarding, harness check) are IDEMPOTENT pre-phase setup that runs every pass — they
// establish orchMode / runId / context, are cheap to re-run, and are NOT ledger phases.
// On resume past 'triage', the Checkpoint Recovery jump skips ahead after this setup.
const _triage = enterPhase(runId, 'triage');   // runId + initPipeline established in Checkpoint Recovery above
Output: "[Atlas] Phase 0: TRIAGE started (phase ledger entered)"

// Step 2: Clean stale .ao/ state + detect capabilities
import { runPreflight, formatCapabilityReport } from './scripts/lib/preflight.mjs';
const preflightReport = await runPreflight();
for (const action of preflightReport.actions) {
  Output: "[Atlas] Preflight: " + action;
}
const { hasCodex, hasCodexAppServer, hasCodexExecJson, hasGeminiCli, hasGeminiAcp, hasTmux } = preflightReport.capabilities;
const cwd = process.cwd();
const capabilities = preflightReport.capabilities;
Output: formatCapabilityReport(preflightReport.capabilities, { orchestrator: 'Atlas' })

// Step 3: Guard input size
import { prepareSubAgentInput, checkInputSize } from './scripts/lib/input-guard.mjs';
const inputCheck = checkInputSize(<combined_input>, 'opus');
if (!inputCheck.safe) {
  Output: "[Atlas] L-scale input detected (" + inputCheck.lines + " lines, ~" + inputCheck.tokens + " tokens)"
  const prepared = prepareSubAgentInput(<combined_input>, 'opus', <source_file_path>);
  Output: "[Atlas] Structural summary: " + prepared.originalLines + " → " + countLines(prepared.text) + " lines"
  <metis_input> = prepared.text
} else {
  <metis_input> = <combined_input>
}
```

<!-- AO-CONTRACT:explore-before-metis -->
Pick strategy. **Run Explore FIRST (fast, haiku), then Metis** — metis
requires explore_results as input, so the previous "simultaneous" pattern
was unsafe (metis started with an empty `<explore_results>` placeholder).
Explore is haiku-tier (< 2s typical), so the added latency is negligible.

```
Output: "[Atlas] Running Explore (haiku) before Metis..."

# Step 1 — Explore first (haiku, ~1-2s)
Agent A (fast): Task(subagent_type="agent-olympus:explore", model="haiku",
  prompt="Scan codebase: architecture, relevant files, tech stack, test framework.
  Report as bullet points. Context: <user_request>")

explore_results = <Explore output>

# Step 2 — Metis consumes explore_results
Output: "[Atlas] Spawning Metis with codebase context..."
Agent B (deep): Task(subagent_type="agent-olympus:metis", model="opus",
  prompt="Classify AND analyze this task in a single pass. Produce BOTH the
  classification (needed for Phase 0 routing) AND the deep analysis (needed
  for Phase 2 planning). Downstream stages will reuse these fields — no
  second metis call will be made.

  === PROCEDURE (ordered — follow exactly) ===
  1. Read the codebase evidence below (explore_results) FIRST.
  2. Draft PART B (AFFECTED_FILES / HIDDEN_REQUIREMENTS / RISKS /
     UNKNOWNS / KNOWLEDGE_GAPS) from the evidence.
  3. ONLY THEN classify the task in PART A.
     (Rationale: evidence-first ordering prevents false-trivial
     shortcutting — classify cannot justify a shallow analysis if
     analysis was already written.)
  4. If PART B genuinely shows trivial scope (single file, <10 lines,
     no risks), set COMPLEXITY=trivial. Do NOT use trivial as a
     shortcut to skip analysis — PART B must be written first.

  === PART A — CLASSIFICATION (always required, written LAST) ===
  [[PART_A_BEGIN]]
  COMPLEXITY: trivial / moderate / complex / architectural
  SCOPE: single-file / multi-file / cross-system
  MULTI_MODEL: recommend which external models to use (if any)

  Available capabilities:
  - Codex: <hasCodex ? 'AVAILABLE (app-server: ' + hasCodexAppServer + ', exec: ' + hasCodexExecJson + ')' : 'NOT AVAILABLE'>
  - Gemini: <hasGeminiCli ? 'AVAILABLE (ACP: ' + hasGeminiAcp + ')' : 'NOT AVAILABLE'>
  - tmux: <hasTmux ? 'available' : 'NOT available'>

  Multi-model guidelines:
  - Codex excels at: algorithms, large refactoring, batch code transformations, cross-validation
  - Gemini excels at: visual/multimodal, design review, creative tasks, alternative cross-validation
  - Use external models ONLY when the task genuinely benefits (NOT for trivial fixes)
  - If a model is NOT AVAILABLE above, do not recommend it
  - When both available: use Codex for cross-validation, Gemini for visual/creative tasks
  [[PART_A_END]]

  === PART B — DEEP ANALYSIS (written FIRST per PROCEDURE, emitted here) ===
  [[PART_B_BEGIN]]
  AFFECTED_FILES: bullet list of paths the change is likely to touch
                  (every entry MUST be a concrete path from explore_results,
                   not a generic noun like 'source files')
  HIDDEN_REQUIREMENTS: non-obvious constraints inferred from the codebase
  RISKS: things that could break (integration, perf, security, UX)
  UNKNOWNS: what needs clarification or deeper investigation
  KNOWLEDGE_GAPS: unfamiliar APIs / libraries / protocols that external-context should research

  Anti-laziness rules:
  - Every field MUST have at least 1 concrete bullet, or the literal word 'none'.
  - 'SKIPPED — trivial task' is permitted ONLY when PART A COMPLEXITY=trivial
    AND all five fields are honestly 'none'. Never use SKIPPED as a shortcut
    for 'I don't want to analyze'.

  === Output format (strict, delimiter-bracketed) ===
  [[PART_B_BEGIN]]
  AFFECTED_FILES:
    - <concrete path>
    - ...
  HIDDEN_REQUIREMENTS:
    - ...  (or 'none')
  RISKS:
    - ...  (or 'none')
  UNKNOWNS:
    - ...  (or 'none')
  KNOWLEDGE_GAPS:
    - ...  (or 'none')
  [[PART_B_END]]

  [[PART_A_BEGIN]]
  COMPLEXITY: <value>
  SCOPE: <value>
  MULTI_MODEL: { codex: yes/no (reason), gemini: yes/no (reason) }
  [[PART_A_END]]

  Codebase context (Explore ran first, below is its output): <explore_results>
  Prior learnings: <formatWisdomForPrompt()>
  Task: <user_request>")
```

**NOTE (Phase 1 optimization, 2026-04-21)**: This single metis call replaces
the previous two-call pattern (Phase 0 classify + Phase 1 analyze). Output
reused by Phase 2/3/4/5 via `metis_output`. No second metis call — see
Phase 1 below.

**Sub-agent output validation — MANDATORY:** <!-- AO-CONTRACT:subagent-validation -->

After Metis and Explore return, validate before proceeding:
```
metis_output = <result from Metis Task() call>
explore_output = <result from Explore Task() call>

# Phase 1 optimization: metis_output must carry BOTH classification AND
# analysis fields in a single response. Retry criteria cover both.
If metis_output is empty OR does not contain COMPLEXITY classification:
  Output: "[Atlas] ⚠ Metis returned empty/invalid classification. Retrying with reduced input..."
  import { extractStructuralSummary } from './scripts/lib/input-guard.mjs';
  const { summary } = extractStructuralSummary(<combined_input>, 100);
  metis_output = Task(subagent_type="agent-olympus:metis", model="sonnet",
    prompt="Classify + analyze in one pass. Output: COMPLEXITY, SCOPE, MULTI_MODEL, AFFECTED_FILES, HIDDEN_REQUIREMENTS, RISKS, UNKNOWNS, KNOWLEDGE_GAPS.\nAvailable: Codex=" + hasCodex + ", Gemini=" + hasGeminiCli + ". Only recommend available models.\nIf trivial, skip analysis fields with 'SKIPPED — trivial task'.\nTask: " + summary)

  If metis_output is STILL empty:
    Output: "[Atlas] ✗ Phase 0 FAILED — triage could not complete after retry."
    Output: "[Atlas] Try: provide a simpler task description or use /plan first."
    import { addWisdom } from './scripts/lib/wisdom.mjs';
    await addWisdom({ category: 'debug', lesson: 'Atlas Phase 0 failed: Metis empty output on L-scale input.', confidence: 'high' });
    STOP — do not proceed.

# False-trivial guard (AO-CONTRACT:false-trivial-guard): a "trivial" classification is only acceptable when
# PART B analysis fields are honestly 'none'. If PART A says trivial but
# PART B has concrete bullets, that's a lazy classification — escalate
# complexity to 'moderate' (conservative) without re-calling metis.
If metis_output.COMPLEXITY == 'trivial' AND
   (metis_output.AFFECTED_FILES has bullets OR
    metis_output.RISKS has bullets OR
    metis_output.HIDDEN_REQUIREMENTS has bullets):
  Output: "[Atlas] ⚠ False-trivial detected — analysis fields show real scope. Escalating COMPLEXITY to 'moderate'."
  metis_output.COMPLEXITY = 'moderate'
  import { addWisdom } from './scripts/lib/wisdom.mjs';
  await addWisdom({ category: 'pattern', lesson: 'metis returned trivial but analysis fields had content — suspect lazy classification.', confidence: 'medium' });

# Non-trivial tasks: verify PART B analysis fields are populated.
If metis_output.COMPLEXITY != 'trivial' AND
   (metis_output.AFFECTED_FILES is empty OR metis_output.RISKS is empty):
  Output: "[Atlas] ⚠ Metis classification OK but analysis fields incomplete — requesting follow-up..."
  # One-shot targeted refill (still a single metis call budget per Phase 1).
  # Only the missing fields are requested; classification is trusted.
  metis_output.AFFECTED_FILES, metis_output.HIDDEN_REQUIREMENTS,
  metis_output.RISKS, metis_output.UNKNOWNS, metis_output.KNOWLEDGE_GAPS =
    Task(subagent_type="agent-olympus:metis", model="opus",
      prompt="Fill the missing analysis fields for this task.\nClassification already decided: COMPLEXITY=" + metis_output.COMPLEXITY + ", SCOPE=" + metis_output.SCOPE + ".\nOutput: AFFECTED_FILES, HIDDEN_REQUIREMENTS, RISKS, UNKNOWNS, KNOWLEDGE_GAPS.\nExplore context: " + explore_output + "\nTask: " + <user_request>)

Output: "[Atlas] Triage + Analysis complete — complexity: <complexity>, scope: <scope>"
```

```javascript
await completePhase(runId, 'triage');   // canonical boundary before any later phase can complete or skip
```

**Trivial tasks**: Skip phases 1-2, execute directly (Atlas CAN implement simple things itself).
On the trivial path, mark the skipped phases in the ledger and synthesize a minimal
PRD so the downstream finalize/ship contract still holds:
```javascript
// AO-CONTRACT:trivial-prd — synthetic one-story PRD (passes:false; execute→verify flips it true)
skipPhase(runId, 'context', 'trivial');
skipPhase(runId, 'spec', 'trivial');
skipPhase(runId, 'plan', 'trivial');
// Write .ao/prd.json = { projectName:'atlas-<slug>',
//   userStories:[{ id:'US-001', title:<task>, acceptanceCriteria:[<derived>], passes:false }] }
// Do NOT self-verify here. The normal execute→verify path sets passes:true and records
// the US-001 verification, so the changelog (passes:true only) and PR body both include it.
```
**Ambiguous tasks** (ambiguity > 60): Invoke `Skill(skill="agent-olympus:deep-interview")` to clarify before proceeding.
**Moderate+**: Full pipeline.

### Phase 1 — OPTIONAL DEEP-DIVE / EXTERNAL CONTEXT (skip for trivial)

**Phase entry/exit (runner):** `const g = enterPhase(runId, 'context')`. If `g.skip` (trivial path skipped it in Phase 0, or resume), jump straight to Phase 1.5. Otherwise run this phase; when its optional deep-dive / external-context steps are done (or determined unnecessary), call `await completePhase(runId, 'context')` before Phase 1.5.

**Analysis reuse**: `metis_output.AFFECTED_FILES`, `.HIDDEN_REQUIREMENTS`,
`.RISKS`, `.UNKNOWNS`, `.KNOWLEDGE_GAPS` were already produced in Phase 0.
Reference them as `<metis_analysis>` in downstream prompts. **Do NOT call
metis again here** — the Phase 0 call was intentionally consolidated.

```
# metis_analysis is synthesised from Phase 0 fields:
metis_analysis = {
  affected_files: metis_output.AFFECTED_FILES,
  hidden_requirements: metis_output.HIDDEN_REQUIREMENTS,
  risks: metis_output.RISKS,
  unknowns: metis_output.UNKNOWNS,
  knowledge_gaps: metis_output.KNOWLEDGE_GAPS,
}
```

If `NEEDS_CODEX`, simultaneously spawn Codex (batch executor — adapter auto-selected):
```bash
# Adapter auto-selected by worker-spawn.mjs selectAdapter():
#   codex-appserver (preferred) → multi-turn JSON-RPC, live steering
#   codex-exec → single-turn JSONL
#   tmux (fallback) → legacy pane capture, resolves binary + injects PATH
# Codex approval mode mirrors Claude's permission level automatically (codex-approval.mjs).
# Override: set codex.approval in .ao/autonomy.json to "suggest", "auto-edit", or "full-auto".
CODEX_BIN=$(which codex 2>/dev/null || echo /opt/homebrew/bin/codex)
tmux new-session -d -s "atlas-codex-analyze" -c "<cwd>"
tmux send-keys -t "atlas-codex-analyze" "\"$CODEX_BIN\" <approval-flag> exec \"<analysis prompt>\"" Enter
```

**[OPTIONAL] Deep Dive** — if metis classifies complexity as `complex` or `architectural` AND ambiguity > 40:
```
Skill(skill="agent-olympus:deep-dive",
  args="Run deep-dive investigation on: <user_request>
  Context from codebase scan: <explore_results>
  Return path to .ao/deep-dive-report.json when complete.")
```
Read `.ao/deep-dive-report.json` after completion. If `pipeline_ready: false`, escalate to user before proceeding.
Use `recommended_approaches[0]` to inform Phase 2 planning.

**[OPTIONAL] External Context** — if metis identifies an external knowledge gap (unfamiliar API, library, or protocol):
```
Skill(skill="agent-olympus:external-context",
  args="Research external context needed for: <user_request>
  Specific gap: <identified_knowledge_gap>")
```
Inject the returned markdown brief as `<external_context>` into the Phase 2 prompt for prometheus.

### Phase 1.5 — SPEC GATE (Hermes validation/creation) <!-- AO-CONTRACT:spec-gate -->

**Phase entry/exit (runner):** `const g = enterPhase(runId, 'spec')`. If `g.skip` (trivial/resume), jump to Phase 2. Otherwise run the spec gate below; finish with `await completePhase(runId, 'spec')`.

Output: "[Atlas] Phase 1.5: SPEC GATE — validating/creating specification..."

Before implementation planning, ensure a structured spec exists. Hermes acts as the quality gate between analysis and execution planning.

**Check for existing spec:**
```
Does .ao/prd.json exist AND is it non-empty?
```

#### Case A: .ao/prd.json exists (user ran /plan beforehand)

Hermes validates the existing spec against the current task:
```
Task(subagent_type="agent-olympus:hermes", model="opus",
  prompt="VALIDATE this existing specification against the task and analysis.

  Existing spec: <contents of .ao/prd.json>
  Task: <user_request>
  Analysis: <metis_analysis>

  Check:
  1. Does the spec's problem statement match the actual task?
  2. Are user stories complete with GIVEN/WHEN/THEN acceptance criteria?
  3. Are there untestable words (robust, fast, user-friendly, seamless, efficient)?
  4. Are scope boundaries clear (goals vs non-goals)?
  5. Do constraints and risks reflect what metis found in the codebase?

  If spec is SUFFICIENT: respond with 'VERDICT: PASS' and a one-line summary.
  If spec needs updates: respond with 'VERDICT: UPDATE' and the corrected spec
    in the same JSON format, preserving existing fields that are still valid.
  If spec is fundamentally mismatched: respond with 'VERDICT: RECREATE' and
    produce a new spec from scratch.")
```

If VERDICT is UPDATE or RECREATE → overwrite `.ao/prd.json` and `.ao/spec.md` with Hermes output.

#### Case B: .ao/prd.json does NOT exist (user skipped /plan)

Hermes creates a spec from the analysis results:
```
Task(subagent_type="agent-olympus:hermes", model="opus",
  prompt="Create a product specification for this task.

  Task: <user_request>
  Analysis: <metis_analysis>
  Codebase context: <explore_results>
  External context (if gathered): <external_context>

  Scale assessment: <detected_scale from Phase 0>

  Produce a structured spec with:
  1. Problem Statement — WHO has this problem, WHAT is the pain, WHY now
  2. Target Users — specific personas
  3. Goals — specific, measurable objectives
  4. Non-Goals — explicitly out of scope
  5. User Stories — each with ID (US-001), JTBD format, GIVEN/WHEN/THEN acceptance criteria
  6. Success Metrics — measurable outcomes with target values
  7. Constraints — from codebase analysis
  8. Risks & Unknowns — areas needing caution

  IMPORTANT: Replace untestable words (robust, fast, user-friendly, seamless,
  efficient, intuitive) with measurable alternatives.

  For S-scale: concise, 1 page max. No open questions — use sensible defaults.
  For M-scale: standard depth. Up to 2 open questions with recommended defaults.
  For L-scale: comprehensive. Up to 5 open questions with defaults + impact analysis.")
```

**Sub-agent output validation (Hermes) — MANDATORY:**
```
hermes_output = <result from Hermes Task() call above>

If hermes_output is empty OR hermes_output.length < 50:
  Output: "[Atlas] ⚠ Hermes spec creation returned empty. Retrying with reduced input..."
  import { extractStructuralSummary } from './scripts/lib/input-guard.mjs';
  const { summary } = extractStructuralSummary(<user_request>, 100);
  hermes_output = Task(subagent_type="agent-olympus:hermes", model="sonnet",
    prompt="Create a product spec for: " + summary)

  If hermes_output is STILL empty:
    Output: "[Atlas] ✗ Spec Gate FAILED — Hermes could not create spec after retry."
    Output: "[Atlas] Try: (1) run /plan first, or (2) provide a smaller task scope."
    await addWisdom({ category: 'debug', lesson: 'Atlas Spec Gate failed: Hermes empty output.', confidence: 'high' });
    STOP — do not proceed.
```

Write Hermes output to `.ao/spec.md` and `.ao/prd.json`.
Output: "[Atlas] Spec gate passed — <N> user stories ready for planning."

#### After Spec Gate

Proceed to Phase 2 with a guaranteed spec. Prometheus now receives structured requirements, not raw user intent.

### Phase 2 — PLAN + VALIDATE (skip for trivial)

**Phase entry/exit (runner):** `const g = enterPhase(runId, 'plan')`. If `g.skip` (trivial/resume), jump to Phase 3. Otherwise run planning + validation below; finish with `await completePhase(runId, 'plan', null, { checkpointData: { prdSnapshot: <.ao/prd.json> } })` (this replaces the numeric plan-phase `saveCheckpoint` calls).

Output: "[Atlas] Phase 2: PLAN + VALIDATE — creating execution plan..."

<!-- AO-CONTRACT:consensus-plan -->
**[OPTIONAL] Consensus Plan** — for complex tasks with 3 or more user stories, replace the standard Prometheus + Momus single pass with the consensus-plan skill for a higher-confidence PRD:
```
Skill(skill="agent-olympus:consensus-plan",
  args="Run consensus planning for this task.
  Task: <user_request>
  Analysis: <metis_analysis>
  Spec: <contents of .ao/prd.json>
  Wisdom: <formatWisdomForPrompt()>
  External context (if gathered): <external_context>")
```
If consensus-plan is used, skip the standard Prometheus + Momus steps below and go directly to PRD generation.

**Standard path** (trivial–moderate tasks, or fewer than 3 stories):

```javascript
// Inject ORCH_MODE=light marker so prometheus runs its self-audit
// (agents/prometheus.md "Light-Mode Self-Audit" section) when momus is skipped.
const _orchModeHint = (orchMode === 'light') ? 'ORCH_MODE=light\n' : '';
```

```
Task(subagent_type="agent-olympus:prometheus", model="opus",
  prompt=_orchModeHint + "Create implementation plan with:
  - Exact file paths per task
  - Agent type and model tier
  - Parallel groups (non-overlapping file scopes)
  - Concrete acceptance criteria
  - Codex assignments for algorithmic/refactoring work
  Spec: <contents of .ao/prd.json>
  Analysis: <metis_analysis>. Task: <user_request>
  External context (if gathered): <external_context>")
```

Validate (SKIP when `_stageFilter.skipMomus === true`):

```javascript
if (_stageFilter.skipMomus) {
  Output: "[Atlas] Light mode: skipping momus plan validation.";
} else {
```

```
Task(subagent_type="agent-olympus:momus", model="opus",
  prompt="Validate plan. Score Clarity/Verification/Context/BigPicture 0-100.
  REJECT if ANY < 70. Plan: <plan>")
```

```javascript
}  // end skipMomus guard
```

If REJECTED → feed back to prometheus, retry (max 3 rounds). Additionally,
if `orchMode === 'light'` at this point, call `autoEscalateOnReject`, flip
`orchMode = 'full'`, update `_stageFilter = stageFilter(orchMode)`, record
the event with `logLightModeEvent({ event: 'escalated', rejectingStage: 'momus', rejectReason: <...> })`,
and re-run any skipped stages before proceeding.

```
// plan-phase checkpoint is performed by completePhase(runId, 'plan') at the phase exit (see Phase 2 entry).
```

**Generate PRD** (after plan approved):
Write `.ao/prd.json` with user stories from the plan:
```json
{
  "projectName": "atlas-<task-slug>",
  "userStories": [
    {
      "id": "US-001",
      "title": "...",
      "acceptanceCriteria": ["specific", "measurable", "testable"],
      "passes": false,
      "assignTo": "claude|codex|gemini",
      "model": "opus|sonnet|haiku",
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

**PRD QUALITY RULE**: Generic criteria are FORBIDDEN. These are NOT acceptable:
- ❌ "Implementation is complete"
- ❌ "Code compiles without errors"
- ❌ "Works correctly"

These ARE acceptable:
- ✅ "GET /api/users returns 200 with User[] body"
- ✅ "Function parseConfig() handles missing keys by returning defaults"
- ✅ "Test file tests/auth.test.ts exists and all 5 cases pass"

```
// await completePhase(runId, 'plan', null, { checkpointData: { prdSnapshot: <prd.json contents> } })  — see Phase 2 entry; carries the PRD snapshot into the checkpoint.
```

### Phase 3 — EXECUTE (story-by-story)

**Phase entry + OUTER-LOOP head (runner):**
```javascript
// AO-CONTRACT:outer-attempt — execute→verify→review is the NEVER-STOP outer loop.
// Open the outer loop with beginAttempt ONCE per run. The concrete first-pass test is the
// ledger's outer-attempt counter: `attempt === 0` ⇒ no outer attempt has ticked yet. A
// later reattempt (review_reject / quality_fail) re-enters BELOW this line with attempt>0,
// so beginAttempt is correctly skipped here — it never double-counts the 15-cap (Codex HU-06.2).
if (getPipelineState(runId).attempt === 0) {
  const a = beginAttempt(runId);   // ticks the 15-iteration cap exactly once, at loop open
  if (!a.allowed) {
    // 15 iteration limit reached — STOP + escalate, do NOT loop again
    // node scripts/notify-cli.mjs --event escalated --orchestrator atlas --body "15 iteration limit exceeded"
  }
}
const g = enterPhase(runId, 'execute');  // skipped on resume, or when a review-reject reopened only 'verify'
// if (!g.skip) { …run the stories below; finish with completePhase(runId, 'execute', …) … }
```
A later **review reject** re-enters via `reattempt(runId, {reopen:['verify'], reason:'review_reject'})`
(back to Phase 4); a **quality-gate fail** re-enters via `reattempt(runId, {reopen:['execute','verify'],
reason:'quality_fail'})` (back here). Each `reattempt` ticks the 15-cap atomically; `!allowed` ⇒ STOP.

**Progress Briefing** — during execution, output periodic status updates:
- After each parallel group completes, output a compact summary:
  ```
  ┌ Atlas Progress ─────────────────────────────────
  │ Stories: 3/6 passed │ Phase: Execute │ Elapsed: 4m
  │ ✓ US-001 (sonnet)  ✓ US-002 (sonnet)  ✓ US-003 (haiku)
  │ ▶ US-004 (opus)    ◎ US-005 (pending)  ◎ US-006 (pending)
  └─────────────────────────────────────────────────
  ```
- Also output a brief line when each individual story starts and finishes:
  `[Atlas] US-001 "Add auth endpoint" → executor (sonnet) started`
  `[Atlas] US-001 ✓ passed (2m 15s)`
- If any story takes longer than 5 minutes, output a reminder:
  `[Atlas] US-004 still in progress (7m elapsed)...`

For each story in prd.json with `passes: false`, execute and verify:

1. Group independent stories by `parallelGroup` — fire simultaneously
2. Route to the right executor:

**Claude sub-agents:**
```
Task(subagent_type="agent-olympus:executor", model="sonnet|opus", prompt="...
  [If harness_context exists, append:]
  ## Harness Constraints
  Follow these golden principles: <harness_context>
  Respect dependency layers: <docs/ARCHITECTURE.md summary>")
Task(subagent_type="agent-olympus:designer", model="sonnet", prompt="...
  [If harness_context exists:]
  ## Harness Constraints
  Follow these golden principles: <harness_context>")
Task(subagent_type="agent-olympus:test-engineer", model="sonnet", prompt="...
  [If harness_context exists:]
  ## Harness Constraints
  Follow these golden principles: <harness_context>")
```

**Codex/Gemini workers** (canonical adapter spawn per parallel group):

Do not launch external workers with ad-hoc tmux commands. For each parallel
group, build all Codex/Gemini worker descriptors and call `spawnTeam()` exactly
once. `spawnTeam` owns adapter selection (Codex appserver→exec→tmux; Gemini
ACP→exec→tmux), permission mirroring, supervisor persistence, and tmux fallback.

```javascript
import { spawnTeam } from './scripts/lib/worker-spawn.mjs';
import { execFileSync } from 'node:child_process';
import {
  createWorkerWorktree,
  mergeWorkerBranch,
  removeWorkerWorktree,
} from './scripts/lib/worktree.mjs';

// Scope this identity to the current PRD + parallel group. Reuse it unchanged
// for every monitor/collect/failover poll for this group.
if (!/^atlas-[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(prd.projectName)) {
  throw new Error('Unsafe Atlas projectName for worker state');
}
const safeGroup = String(parallelGroup).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40);
const teamSlug = `${prd.projectName}-${safeGroup}`;
const rootStatus = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], {
  encoding: 'utf-8',
}).trim();
if (rootStatus) {
  throw new Error(
    'External worktrees must branch from a committed Atlas checkpoint; preserve current changes and route this group serially until the root is clean',
  );
}
const externalStories = groupStories
  .filter((story) => story.assignTo === 'codex' || story.assignTo === 'gemini');
const externalWorkers = externalStories.map((story) => {
  const name = story.id.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  const worktree = createWorkerWorktree(cwd, teamSlug, name);
  if (!worktree.created && externalStories.length > 1) {
    throw new Error('Parallel external workers require isolated git worktrees');
  }
  return {
    type: story.assignTo,
    name,
    prompt: [
      `Implement ${story.id}: ${story.title}`,
      `Acceptance criteria:\n${story.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}`,
      worktree.created
        ? `MANDATORY WORKTREE: ${worktree.worktreePath}\nWork only in this directory and commit the completed changes to ${worktree.branchName} before reporting success.`
        : 'Work in the current project directory; no isolated worktree was created.',
      harness_context ? `Harness constraints:\n${harness_context}` : '',
    ].filter(Boolean).join('\n\n'),
    // story.model is a Claude tier (opus/sonnet/haiku), not a portable
    // Codex/Gemini model selector. External adapters choose their own default.
    model: undefined,
    cwd: worktree.created ? worktree.worktreePath : cwd,
    worktreePath: worktree.created ? worktree.worktreePath : null,
    branchName: worktree.created ? worktree.branchName : null,
  };
});

const externalTeamState = externalWorkers.length > 0
  ? await spawnTeam(teamSlug, externalWorkers, cwd, capabilities)
  : null;
```

When `teamWorkerType === 'gemini'` for visual/multimodal work, set the worker
descriptor's `type` to `gemini`; do not bypass this canonical spawn path.

**Worker execution & monitoring model (supervisor).** Non-tmux adapter workers (codex-exec, codex-appserver, claude-cli, gemini-exec, gemini-acp) run inside a **detached supervisor** that `spawnTeam()` launches per worker — NOT in your process. The supervisor owns the adapter and writes completion/failure/output to disk, so `monitorTeam(teamSlug)` (re-reading disk on every call) is the canonical monitor and survives the fresh-process polling model. The per-adapter failure detection below happens inside that supervisor and surfaces through `monitorTeam`'s returned `w.status` / `w.errorReason`; `collectResults(teamSlug)` returns each worker's durable output, and `shutdownTeam(teamSlug)` reaps the supervisor (and any orphaned adapter group). You do NOT `capturePane` supervisor workers — that is the tmux-fallback path only.

**Codex/Gemini failure detection and provider fallback:**

The monitoring system detects failures via the active adapter (inside the supervisor for non-tmux workers):

```javascript
import {
  collectResults,
  completeClaudeFallback,
  detectCodexError,
  dispatchProviderFallback,
  monitorTeam,
  pollProviderFallback,
  reassignProvider,
  selectAdapter,
  shutdownTeam,
} from './scripts/lib/worker-spawn.mjs';
const providerTeamsToShutdown = new Set(); // initialize once before the monitor loop
// teamSlug is the exact per-group name passed to spawnTeam() above. Do not
// recompute or invent it while polling: team state is keyed by this identity.

// monitorTeam() handles adapter dispatch automatically (supervisor snapshot or tmux pane).
// For codex-appserver: failures detected via structured CodexErrorInfo + mapAppServerErrorCode()
// For codex-exec: failures detected via item.status="failed" + mapJsonlErrorToCategory()
// For tmux: failures detected via detectCodexError(paneOutput) regex patterns
// Error categories: mcp_auth, auth_failed, rate_limited, not_installed, network, crash, context_exceeded, timeout, unknown

const status = monitorTeam(teamSlug);
const results = status ? collectResults(teamSlug) : {};
for (const failedWorker of (status?.workers || []).filter((worker) => worker.status === 'failed')) {
  const fallback = await reassignProvider(
    teamSlug,
    failedWorker.name,
    failedWorker.originalPrompt,
    { category: failedWorker.errorReason, message: failedWorker.errorMessage },
    failedWorker.session,
    { worker: failedWorker, capabilities },
  );
  if (!fallback.targetProvider) continue;
  const dispatched = await dispatchProviderFallback(fallback, cwd, capabilities);
  const progress = await pollProviderFallback(dispatched, cwd, capabilities);
  for (const childTeam of progress.teamNames || []) providerTeamsToShutdown.add(childTeam);

  if (progress.status === 'running') continue;
  if (progress.status === 'completed') {
    results[failedWorker.name] = progress.output;
  } else if (progress.status === 'claude-task') {
    const replacementWorker = progress.dispatched.replacementWorker;
    const replacementCwd = replacementWorker.worktreePath || replacementWorker.cwd || cwd;
    const claudeOutput = Task(subagent_type="agent-olympus:executor", model="sonnet",
      prompt=`${replacementWorker.prompt}\n\nMANDATORY WORKTREE: ${replacementCwd}\nWork only in this directory; preserve the existing branch, commit completed changes before returning, and do not edit the project root.`)
    await completeClaudeFallback(progress.dispatched, claudeOutput);
    results[failedWorker.name] = claudeOutput;
  } else {
    // No provider remained or the bounded chain failed: mark the story blocked.
  }
}

// Cleanup is terminal-only. A running provider child must survive into the next
// monitor iteration; shutting it down here would restart the bounded task.
if (status?.workers.every((worker) => worker.status === 'completed')) {
  // Atlas-created external worktrees are execution state, not disposable
  // scratch space. Integrate every clean, committed branch before any team
  // cleanup; otherwise shutdownTeam() would delete the successful changes.
  for (const worker of externalWorkers.filter((item) => item.worktreePath && item.branchName)) {
    const dirty = execFileSync(
      'git', ['-C', worker.worktreePath, 'status', '--porcelain'],
      { encoding: 'utf-8' },
    ).trim();
    if (dirty) {
      throw new Error(`External worker ${worker.name} completed with uncommitted work; preserve its worktree and resume integration`);
    }
    const merged = mergeWorkerBranch(cwd, worker.branchName, worker.name);
    if (!merged.success) {
      throw new Error(`External worker ${worker.name} merge failed: ${merged.conflicts.join(', ')}`);
    }
    removeWorkerWorktree(cwd, worker.worktreePath, worker.branchName);
  }
  for (const childTeam of providerTeamsToShutdown) await shutdownTeam(childTeam, cwd);
  await shutdownTeam(teamSlug, cwd);
}
```

Rules:
- If a failed worker reports `'mcp_auth'`, `'auth_failed'`, `'rate_limited'`, or `'not_installed'`, do NOT manually retry that provider; let the failover chain select the next provider.
- Crash/timeout/network retries are OWNED by the failover chain: `planProviderFailover` already retries the same provider once (crash, or first unavailable attempt) before switching. Do NOT manually respawn the failed provider yourself — that would double the retry.
- `reassignProvider()` handles adapter-specific cleanup and records the reason; `dispatchProviderFallback()` retries one unavailable execution, then follows Codex → Gemini → Claude while preserving the worker prompt/task fields.
- A provider replacement always uses a deterministic distinct child team name. Re-polling reuses it instead of spawning duplicates; reusing `teamSlug` would overwrite the parent team state.

**Task Chaining** (for iterative Codex work):
With codex-appserver, use `steerTurn()` for live mid-turn input. For exec/tmux adapters, multi-step work uses sequential calls:
```
exec #1: "Analyze the API" → Result A
Atlas: merges Result A + own analysis
exec #2: "Implement changes based on: {merged feedback}" → Result B
```

**TDD Routing** (per story, before spawning executor):
If story has `requiresTDD: true` OR `acceptanceCriteria` contains testable/behavioral conditions:
  → Instruct the executor: "Implement this story using TDD: write a failing test first (RED),
    then minimum code to pass (GREEN), then refactor. Do not write production code before tests."
If story is a pure refactor / docs / config change (no runtime behavior change):
  → Standard executor dispatch (no TDD gate required)

3. After each story completes, verify its acceptance criteria with FRESH evidence

4. **Codex Cross-Validation** (per story) — MANDATORY: spawn a Codex validator before marking passes: <!-- AO-CONTRACT:cross-validation -->
```bash
# CRITICAL: resolve binary path first — worktree shells may not inherit full PATH
CODEX_BIN=$(which codex 2>/dev/null || echo /opt/homebrew/bin/codex)
tmux new-session -d -s "atlas-codex-xval-<story-id>" -c "<cwd>"
tmux send-keys -t "atlas-codex-xval-<story-id>" "\"$CODEX_BIN\" <approval-flag> exec \"Cross-validate implementation of <US-ID> (<story title>). Files changed: <files>. Acceptance criteria: <criteria>. Golden principles: <harness_context or 'none'>. Check: (1) all acceptance criteria genuinely met with evidence, (2) no architectural layer violations, (3) golden principles followed. Reply: PASS or FAIL with specific findings.\"" Enter
# Poll: tmux capture-pane -pt "atlas-codex-xval-<story-id>" -S -200 (every 15s)
# Cleanup: tmux kill-session -t "atlas-codex-xval-<story-id>"
```
- **PASS** → `addVerification(runId, { story_id, verdict: 'pass', evidence: 'codex xval passed', verifiedBy: 'codex' })` → mark `passes: true`, proceed.
- **FAIL** → `addVerification(runId, { story_id, verdict: 'fail', evidence: '<specific findings>', verifiedBy: 'codex' })` → fix the specific violation, re-run acceptance criteria, re-validate (max 2 cycles).
- **Codex unavailable BUT Gemini available** → use Gemini as alternative cross-validator:
```bash
GEMINI_BIN=$(which gemini 2>/dev/null || echo /opt/homebrew/bin/gemini)
tmux new-session -d -s "atlas-gemini-xval-<story-id>" -c "<cwd>"
tmux send-keys -t "atlas-gemini-xval-<story-id>" "\"$GEMINI_BIN\" <approval-flag> -p \"Cross-validate implementation of <US-ID>. Files: <files>. Criteria: <criteria>. Reply PASS or FAIL with findings.\"" Enter
```
  Record: `addVerification(runId, { story_id, verdict: 'pass'|'fail', evidence: '<findings>', verifiedBy: 'gemini' })`
- **Neither Codex nor Gemini available** → detect via `detectCodexError(paneOutput)` from `scripts/lib/worker-spawn.mjs`. **MUST explicitly record the skip**: `addVerification(runId, { story_id, verdict: 'skip', evidence: 'no external validator available: cross-validation skipped', verifiedBy: 'atlas' })`. Log: `[Atlas] Cross-validation skipped for <story-id>: no external validator available.`

> **IMPORTANT**: "skip silently" does NOT mean "do nothing". Every story MUST have a verification record — pass, fail, or explicit skip. The PR verification gate will block if any story lacks a record.

5. Mark `passes: true` in prd.json only when ALL criteria verified AND Codex cross-validation passes (or is unavailable with explicit skip recorded)
6. Record learnings via wisdom calls after each story:
   ```
   addWisdom({ category: 'pattern', lesson: '<codebase convention discovered>', confidence: 'high' })
   addWisdom({ category: 'debug',   lesson: '<pitfall to avoid>',              confidence: 'high' })
   addWisdom({ category: 'build',   lesson: '<build/test learning>',           confidence: 'medium' })
   ```
6. After each story passes: mark `passes: true` in `.ao/prd.json` — the authoritative story-level state the runner reads on resume (no per-story checkpoint needed; `completePhase('execute')` checkpoints the phase).

**Wisdom tracking** — call `addWisdom()` after each story with appropriate category:
- `'test'` — test framework quirks, test patterns that work
- `'build'` — build tool behavior, compilation requirements
- `'architecture'` — structural decisions, module boundaries
- `'pattern'` — codebase conventions, naming, error handling
- `'debug'` — pitfalls encountered, root causes found
- `'performance'` — optimization findings
- `'general'` — anything that doesn't fit the above

Wisdom persists across iterations so later stories benefit from earlier learnings.

```
await completePhase(runId, 'execute', null, { checkpointData: { prdSnapshot: <prd.json>, completedStories } });   // execute complete — replaces saveCheckpoint({phase:4})
```

### Phase 4 — VERIFY (loop until pass)

**Phase entry (runner):** `const g = enterPhase(runId, 'verify')`. On resume / after a
review-reject reopened it, this re-enters cleanly. The 15-iteration **outer** cap was
already ticked by `beginAttempt`/`reattempt` at the Phase 3 head — this phase's
**internal** fix loop is bounded by `recordPhaseError` (same-error-3×) + a ~5-cycle soft
budget, NOT a fresh iteration tick.

Run **simultaneously**: build, tests, linter, type checker. The fix/debug escalation
chain (debugger → systematic-debug → trace) is recorded through the runner.
<!-- AO-CONTRACT:debug-escalation -->

```
┌─→ Run all checks
│   ├─ ALL PASS → proceed to Phase 4.2 / 4.5, then Phase 5
│   └─ ANY FAIL →
│       const e = recordPhaseError(runId, 'verify', <first error line or error code>)
│         → if e.shouldEscalate (same error 3×): STOP + escalate, do NOT retry the same fix
│       else spawn debugger:
│       Task(subagent_type="agent-olympus:debugger", model="sonnet",
│         prompt="Fix: <error_output>. Previous learnings: <formatWisdomForPrompt(queryWisdom(null,10))>")
│       Debug escalation chain:
│         1. First attempt: spawn debugger agent
│         2. Debugger fails once: spawn debugger again with additional context from wisdom
│         3. Debugger fails twice: invoke Skill(skill="agent-olympus:systematic-debug")
│            for root-cause-first investigation
│         4. systematic-debug fails: escalate via Skill(skill="agent-olympus:trace")
│            for evidence-driven hypothesis analysis
│       Re-run checks
└── Loop until ALL PASS or recordPhaseError signals shouldEscalate (same error 3×; soft budget ~5 cycles)
```

`completePhase(runId, 'verify')` is called AFTER the optional Phase 4.2 (visual) and
Phase 4.5 (quality) sub-steps below — verify is not complete until those gates pass.

### Phase 4.2 — VISUAL VERIFICATION [OPTIONAL]

If changed files include frontend code (`.tsx`, `.jsx`, `.vue`, `.svelte`, `.css`, `.scss`, `.html`):

1. **Detect frontend changes** (use full branch diff vs main, not just HEAD~1 — multi-commit branches need the cumulative diff):
   ```bash
   BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||' || echo "main")
   git diff --name-only "origin/$BASE...HEAD" | grep -E '\.(tsx|jsx|vue|svelte|css|scss|html)$'
   ```
   If no frontend files changed → skip this phase entirely.

2. **Start preview server** (requires `.claude/launch.json`):
   ```
   preview_start(name="<dev-server-name>")
   ```
   If `.claude/launch.json` doesn't exist or preview server fails to start → skip with warning:
   `[Atlas] Visual verification skipped: no preview server configured.`

3. **Capture screenshots** of affected pages:
   ```
   preview_screenshot(serverId="<id>")
   ```
   Take screenshots of key routes/pages that were likely affected by the changes.

4. **Evaluate visual correctness**:
   - Check for: blank pages, layout breakage, missing elements, error boundaries, console errors
   - Use `preview_console_logs(serverId="<id>", level="error")` to detect runtime errors
   - Use `preview_snapshot(serverId="<id>")` to check element presence via accessibility tree

5. **If visual issues found**:
   ```
   Task(subagent_type="agent-olympus:designer", model="sonnet",
     prompt="Fix visual regression: <description of issue>
     Screenshot shows: <issue>. Console errors: <errors>.
     Affected files: <files>")
   ```
   After fix → re-capture screenshot → verify again (max 2 fix cycles).

6. **Stop preview server**:
   ```
   preview_stop(serverId="<id>")
   ```

**Note**: This phase is OPT-IN. It requires Claude Preview MCP and a configured dev server. Skip silently if unavailable.

### Phase 4.5 — QUALITY GATE [OPTIONAL]

If `agent-olympus:themis` agent is available:
```
Task(subagent_type="agent-olympus:themis", model="sonnet",
  prompt="Run quality gate checks on all changed files.")
```
- If verdict is FAIL → remediate via the outer loop (NOT a no-op reopen):
  ```javascript
  // AO-CONTRACT:quality-fail
  const q = loopTick(runId, 'quality');     // code-owned 2-cycle budget (QUALITY_CAP=2)
  if (!q.allowed) {
    // quality budget exhausted — escalate to user with the specific failure reasons
  } else {
    // STEP 1 (REQUIRED): mark the quality-failed stories passes:false in .ao/prd.json.
    //   Atlas execute only re-runs passes:false stories, so WITHOUT this flip the
    //   reopen below is a no-op (burns an attempt doing nothing).
    setStoriesPassesFalse(<quality-failed story ids>);   // mutate .ao/prd.json
    // STEP 2: re-enter the outer loop. reattempt ALREADY ticks the 15-cap; the re-entry
    //   resumes at enterPhase('execute') and does NOT re-call beginAttempt (no double-tick).
    reattempt(runId, { reopen: ['execute', 'verify'], reason: 'quality_fail' });
  }
  ```
- If verdict is CONDITIONAL → log warnings, proceed to Phase 5
- If verdict is PASS → proceed to Phase 5
Note: This phase is OPTIONAL. If Themis agent is absent, skip and proceed.

**Phase exit (runner):** once the verify checks + the optional visual (4.2) and quality
(4.5) gates all pass, call `await completePhase(runId, 'verify')` before Phase 5.

### Phase 5 — REVIEW (loop until approved)

**Phase entry (runner):** `enterPhase(runId, 'review')`. Each review round is bounded by `loopTick(runId, 'review')` (cap 3); a reject re-enters the outer loop via `reattempt`; ALL APPROVED → `await completePhase(runId, 'review')`.

**Step 5.0 — Consult review router (US-005)** <!-- AO-CONTRACT:review-router -->

Before fanning out reviewers, call `scripts/lib/review-router.mjs` to compute the
minimal reviewer set for the actual diff scope. This eliminates 60-80% of wasted
reviewer tokens on irrelevant diffs while still catching security-relevant code
in shared utilities via the `securityPatterns` regex set.

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

Spawn ONLY the reviewers in `r.reviewers`, in parallel. Honor `securityHit=true`
by always including `agent-olympus:security-reviewer`. If `r.warning` is set,
log it but proceed with the fallback set.

**Step 5.1 — Spawn reviewer fan-out**

```
For each reviewer in r.reviewers, fire in parallel:
  Task(subagent_type="agent-olympus:<reviewer>", model="sonnet|opus", prompt="...")
```

**Step 5.2 — Handle reviewer escalation** <!-- AO-CONTRACT:review-escalation -->

Reviewers may emit a structured escalation flag mid-run:
```json
{ "type": "RE-REVIEW-REQUESTED",
  "additionalReviewer": "security-reviewer",
  "reason": "detected hardcoded API key in shared util" }
```

When you see this flag, call `handleEscalation(currentSet, flag)` and spawn the
requested reviewer in the **same iteration** (not the next loop). This catches
the case where code-reviewer notices security-relevant code that the path-based
router missed.

```
┌─→ const rr = loopTick(runId, 'review')  → if !rr.allowed: stop the review loop, escalate unresolved findings to user (cap 3)
│   Collect verdicts
│   ├─ ALL APPROVED → await completePhase(runId, 'review'); DONE ✓
│   ├─ ANY ESCALATION → spawn additional reviewer same iteration (does NOT consume a round)
│   └─ ANY REJECTED → fix issues, then re-enter the outer loop:
│        reattempt(runId, { reopen: ['verify'], reason: 'review_reject' })   // AO-CONTRACT:review-reject-reattempt
│          → ticks the 15-cap; if !allowed: STOP + escalate. Else loop back to Phase 4 (verify), then re-review.
└── Loop until ALL APPROVED (→ completePhase) or loopTick / reattempt returns !allowed
```

**Rollback**: set `.ao/autonomy.json` → `{ "reviewRouter": { "disabled": true } }`
to bypass the router entirely and always run the full reviewer set.

### Phase 5b — SLOP CLEAN + COMMIT

**Phase entry (runner):** `enterPhase(runId, 'finalize')` — covers 5b (slop+commit), 5c (changelog), 5d (exec-plan). After 5d, `await completePhase(runId, 'finalize')`.

Resolve the release policy before invoking any helper that can offer or perform
shipping. Explicit shipping constraints in the original task brief or any
durably appended user follow-up always take precedence over
`.ao/autonomy.json`, including `ship.mode: "auto"`.

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
2. Re-run build + tests to verify no regression from cleanup
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
  throw new Error('Atlas completed ship phase lacks a durable push/PR/base/branch/HEAD/repository outcome; stop recovery');
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
  throw new Error('Atlas found multiple ship intents; stop rather than choosing a replacement');
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
  throw new Error('Atlas current checkout/HEAD/base/repository does not match the durable ship intent; stop recovery');
}
if (!shipAlreadyTerminal && !noShip && preflight.ok === true && !durableShipIntent) {
  const intentRepoIdentity = detectRepositoryIdentity(cwd);
  if (!repositoryIdentitiesEqual(intentRepoIdentity, preflight.repoIdentity)) {
    throw new Error('Atlas repository changed after preflight; stop before recording ship intent');
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
    throw new Error('Atlas ship intent was not durably recorded exactly once; stop before approval');
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
    throw new Error(`Atlas repository identity changed before ${action}; stop outward actions`);
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
    throw new Error(`Atlas shipping was revoked before ${action}; stop outward actions`);
  }
  return currentPolicy;
};
const requireCurrentShippingAuthorization = action => {
  const currentPolicy = requireShippingNotRevoked(action);
  durableHumanApproval = getRun(runId).events.some(matchesCurrentHumanApproval);
  if (currentPolicy.shipMode === 'ask' && !durableHumanApproval) {
    throw new Error(`Atlas shipping now requires fresh human approval before ${action}`);
  }
  if (!['auto', 'ask'].includes(currentPolicy.shipMode)) {
    throw new Error(`Atlas shipping policy is invalid before ${action}`);
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
    // node scripts/notify-cli.mjs --event blocked --orchestrator atlas --body "branch ready to ship: <branchName>"
    try {
      execFileSync('node', [
        'scripts/notify-cli.mjs', '--event', 'blocked', '--orchestrator', 'atlas',
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
  throw new Error('Atlas in-progress ship recovery lost approval/preflight/policy; leave it nonterminal');
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
  throw new Error('Atlas ship phase is terminally failed; do not continue to CI/completion');
}
if (shipAlreadyTerminal && (shipGate.skip !== true || shipGate.degraded === true)) {
  throw new Error('Atlas terminal ship outcome could not be restored; stop before CI/completion');
}
if (shippingApplicable && shipGate.skip !== true && !shipCanAct) {
  throw new Error('Atlas ship phase transition was denied or degraded; stop before push/PR');
}
if (!shipAlreadyTerminal && !shippingApplicable
  && (shipGate.ok !== true || shipGate.degraded === true)) {
  throw new Error('Atlas ship skip was not durable; stop before completion');
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
      // 1. First attempt: try Codex cross-validation (same as Phase 3 step 4).
      // 2. If Codex unavailable, record explicit skip.
      addVerification(runId, {
        story_id: missingId,
        verdict: 'skip',
        evidence: 'codex unavailable: verification gate catch-up',
        verifiedBy: 'atlas',
      });
    }
    verificationGate = checkVerificationGate(runId, storyIds);
  }
  if (!verificationGate.gatePass) {
    throw new Error(
      `Atlas verification gate failed for: ${verificationGate.missing.join(', ')}; leave ship nonterminal`,
    );
  }
  if (verificationGate.skipped.length > 0) {
    console.log(`[Atlas] ${verificationGate.skipped.length} stories had Codex xval skipped — results included in PR body`);
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
    throw new Error(`Atlas existing-PR lookup failed: ${existing.error}; stop to avoid a duplicate PR`);
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
    throw new Error('Atlas branch/HEAD changed after approval; stop before push and request fresh approval');
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
      throw new Error(`Atlas PR update failed: ${updated.error ?? 'missing PR URL'}; leave ship nonterminal`);
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
      throw new Error(`Atlas PR creation failed: ${created.error ?? 'missing PR URL'}; leave ship nonterminal`);
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
    checkpointData: { runId, ...shipOutputs },
  });
  if (!shipCompletion.ok || shipCompletion.degraded) {
    throw new Error('Atlas ship outcome was not durably checkpointed; preserve the run for recovery');
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
ledger outputs and checkpoint. On resume the identity object is reconstructed
before CI and completion reporting. A blocked
verification gate leaves the entered phase nonterminal for recovery. A terminal
skipped phase reports `restoredShipBranchName ?? observedBranchName`, never a
synthetic empty branch name.

### Phase 6b — CI WATCH (Monitor + Auto-Fix) <!-- AO-CONTRACT:ci-watch -->

**Phase entry (runner):** CI is applicable only after an actual successful push,
a PR URL, and enabled watching. Otherwise call
`skipPhase(runId, 'ci', pushPerformed && createdPrUrl ? 'watch-disabled' : 'no-pr')`
and go to COMPLETION. Otherwise `enterPhase(runId, 'ci')`; each poll cycle is
bounded by `loopTick(runId, 'ci')` (cap 2 = CI_CAP); on exit,
`await completePhase(runId, 'ci')`.

```javascript
import { getFailedLogs, watchCI } from './scripts/lib/ci-watch.mjs';

refreshRunShipPolicy('CI phase entry');
const ciApplicable = Boolean(!noShip && pushPerformed && createdPrUrl && config.ci.watchEnabled);
const persistedCIStatus = getPipelineState(runId).phases.ci?.status;
const ciAlreadyTerminal = ['completed', 'skipped'].includes(persistedCIStatus);
const ciRecoveryInProgress = persistedCIStatus === 'in_progress';
if (ciRecoveryInProgress && !ciApplicable) {
  throw new Error('Atlas in-progress CI recovery became inapplicable; preserve it instead of skipping');
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
  throw new Error('Atlas CI phase is terminally failed; do not continue to completion');
}
if (ciAlreadyTerminal && (ciGate.skip !== true || ciGate.degraded === true)) {
  throw new Error('Atlas terminal CI outcome could not be restored; stop before completion');
}
if (ciApplicable && ciGate.skip !== true && !ciCanAct) {
  throw new Error('Atlas CI phase transition was denied or degraded; stop before polling/fixing/pushing');
}
if (!ciAlreadyTerminal && !ciApplicable
  && (ciGate.ok !== true || ciGate.degraded === true)) {
  throw new Error('Atlas CI skip was not durable; stop before completion');
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
  throw new Error('Atlas durable CI target history is malformed or belongs to another ship identity');
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
    throw new Error('Atlas initial CI target was not durably recorded; stop before polling');
  }
  expectedCIHeadCommit = ciTargetEvents[0].detail.headCommit;
}
```

Only when `ciCanAct` is true may Atlas poll a provider, notify about CI, launch a
fixer, commit, or push. At the top of every poll/fix cycle, require both fields
from the durable runner tick:

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
      throw new Error(`Atlas branch/HEAD changed before ${action}; stop CI recovery`);
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
      throw new Error('Atlas shipped remote branch is missing or ambiguous');
    }
    const [remoteHead, remoteRef, ...extra] = rows[0].split(/\s+/);
    if (extra.length || remoteRef !== `refs/heads/${branchName}`
      || !/^[0-9a-f]{40}$/.test(remoteHead)) {
      throw new Error('Atlas shipped remote branch response is malformed');
    }
    return remoteHead;
  };
  const assertRemoteCITarget = action => {
    const remoteHead = readRemoteCIHead();
    if (remoteHead !== expectedCIHeadCommit) {
      throw new Error(`Atlas remote branch changed before ${action}; stop CI recovery`);
    }
  };
  const requireCurrentCIPolicy = action => {
    const currentPolicy = refreshRunShipPolicy(action);
    if (currentPolicy.noShip) {
      throw new Error(`Atlas shipping was revoked before ${action}; stop CI side effects`);
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
      throw new Error('Atlas CI fix candidate lacks an exact durable start transition');
    }
    if (!isDescendantCommit(expectedCIHeadCommit, candidateHeadCommit)) {
      throw new Error('Atlas CI fix candidate is not a descendant of the confirmed CI target');
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
      throw new Error('Atlas CI fix candidate was not durably recorded; stop before approval/push');
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
      throw new Error('Atlas confirmed CI fix target was not durably recorded; stop recovery');
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
      throw new Error('Atlas CI fix candidate provenance is invalid');
    }
    const {
      sourceHeadCommit, candidateHeadCommit, failureRunId, fixAttempt, recoveryMode,
    } = candidate.detail;
    const current = readCurrentCIState();
    if (current.branchName !== branchName || current.headCommit !== candidateHeadCommit) {
      throw new Error('Atlas CI fix checkout no longer matches the durable candidate');
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
      throw new Error('Atlas CI fix push lacks verified human approval; keep the fix local');
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
      throw new Error('Atlas remote branch changed outside the durable CI fix transition');
    }
    if (readRemoteCIHead() !== candidateHeadCommit) {
      throw new Error('Atlas CI fix push could not be confirmed on the pinned remote');
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
      throw new Error('Atlas pending CI fix history is malformed or ambiguous');
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
      throw new Error('Atlas local CI state drifted without a durable fix-start record');
    }
    return expectedCIHeadCommit;
  };
  expectedCIHeadCommit = await recoverPendingCIFix();

  for (;;) {
    const ciTick = loopTick(runId, 'ci');
    const ciTickCanAct = ciTick.allowed === true && ciTick.degraded === false;
    if (!ciTickCanAct) {
      throw new Error('Atlas CI loop tick was denied or degraded; stop before all CI side effects');
    }
    const pushCIFix = async () => {
      if (!ciCanAct || !ciTickCanAct) {
        throw new Error('Atlas CI fix push escaped its phase/tick gate');
      }
      const ciFixBranchName = execFileSync(
        'git', ['branch', '--show-current'], { cwd, encoding: 'utf8' },
      ).trim();
      const ciFixHeadCommit = execFileSync(
        'git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' },
      ).trim();
      if (ciFixBranchName !== branchName) {
        throw new Error(`Atlas CI fix checkout ${ciFixBranchName} is not shipped branch ${branchName}`);
      }
      if (ciFixHeadCommit === expectedCIHeadCommit) {
        throw new Error('Atlas CI fixer did not produce a new commit');
      }
      const started = getRun(runId).events.filter(matchesCIFixStarted).at(-1);
      if (!started) {
        throw new Error('Atlas CI fix candidate lacks a durable fix-start record');
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
      throw new Error('Atlas CI watcher rejected its pinned repository/commit inputs');
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
        throw new Error('Atlas could not read failed logs from the pinned CI run');
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
        throw new Error('Atlas CI fix start was not durably recorded; stop before launching the fixer');
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
    throw new Error('Atlas CI result was not durably recorded; preserve the run for recovery');
  }
}
```

The guarded watch/fix behavior is:

```
┌─→ Poll CI status:
│     node -e "import('./scripts/lib/ci-watch.mjs').then(m =>
│       m.watchCI({ cwd, repository: repoIdentity.repository, branch: branchName,
│         expectedHeadSha: expectedCIHeadCommit, maxCycles: ciPollCycles,
│         pollIntervalMs: config.ci.pollIntervalMs })
│       .then(r => console.log(JSON.stringify(r))))"
│
│   ├─ status: 'passed' →
│   │   node scripts/notify-cli.mjs --event ci_passed --orchestrator atlas --body "All CI checks passed."
│   │   → DONE ✓
│   │
│   ├─ status: 'failed' →
│   │   1. Notify: node scripts/notify-cli.mjs --event ci_failed --orchestrator atlas --body "CI failed"
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
└── Loop, bounded by loopTick(runId, 'ci') (cap 2 = CI_CAP) — denied or degraded ⇒ stop before side effects
```

If CI passes → DONE. If CI fails after max cycles → escalate to user with failure logs.

### COMPLETION <!-- AO-CONTRACT:cleanup -->

**Phase entry (runner):** `enterPhase(runId, 'complete')`. Do the cleanup below,
then durably complete and finalize the same run identity:

```javascript
// AO-CONTRACT:run-finalize
const completion = await completePhase(runId, 'complete');
if (!completion.ok || !isComplete(runId)) {
  throw new Error('Atlas completion ledger did not reach a terminal state; preserve the active run for recovery');
}
finalizeRun(runId, { result: 'success' });
if (getActiveRunId('atlas') === runId) {
  throw new Error('Atlas run finalization did not clear the matching active-run pointer; preserve it for recovery');
}
```

`finalizeRun()` updates the companion run summary to `completed` and clears the
matching active-run pointer. Never clear or replace that pointer before the
`complete` phase is durably recorded. Treat a still-matching pointer as a
finalization failure instead of reporting success.

Prune wisdom to prevent unbounded growth:
- Call `pruneWisdom(200)` to remove entries older than 90 days and cap at 200 most recent

Clean up:
- `clearCheckpoint('atlas')`
- Remove `.ao/state/atlas-state.json`
- Remove `.ao/prd.json`
- Kill any tmux sessions: `tmux kill-session -t "atlas-*"`
- Keep `.ao/wisdom.jsonl` (useful for future sessions — never delete)

Notify user of the actual completion outcome. Never claim a PR exists on a
no-ship, declined, headless, preflight-failed, or PR-failed path:

A PR lookup/update/create failure after a successful push is **not** a
completion path: report that the branch was pushed, retain the nonterminal ship
phase, and retry safely on resume. Do not send an `--event complete`
notification until a PR URL is durably recorded.

```bash
# When createdPrUrl exists:
node scripts/notify-cli.mjs --event complete --orchestrator atlas --body "N/N stories passed. PR: <url>"

# Otherwise (a terminal no-push ship outcome):
node scripts/notify-cli.mjs --event complete --orchestrator atlas --body "N/N stories passed. branch ready: <branchName> — push/PR은 사용자가 직접"
```

Report to user:
- Strategy used (DIRECT/LITE/STANDARD/FULL)
- PRD stories completed (N/N)
- Files changed with descriptions
- Key decisions made
- All verification results
- Shipping outcome: the PR URL when one exists; otherwise exactly
  `branch ready: <branchName> — push/PR은 사용자가 직접`.

## Model_Selection

| Task Type | Model | External Worker |
|-----------|-------|-----------------|
| Trivial fix | Haiku | — |
| Standard impl | Sonnet | — |
| Complex refactor | Opus | Codex |
| Algorithm | Opus | Codex (primary) |
| Codebase scan | Haiku (explore) | — |
| Architecture | Opus | Codex (2nd opinion) |
| Tests | Sonnet | — |
| UI/UX / Visual | Sonnet (designer) | Gemini (multimodal) |
| Design review | Sonnet (aphrodite) | Gemini (visual eval) |
| Creative / Art | Sonnet (designer) | Gemini (generative) |
| Docs | Haiku (writer) | — |

## External_Skills

Beyond agent-olympus agents, you can invoke ANY installed skill or plugin agent.
Check what's available in the session and use them when they fit better than a generic executor.

Common examples:
- `ui-ux-pro-max:ui-ux-pro-max` — advanced UI/UX design with style presets and palettes
- `anthropic-skills:pdf` — PDF reading, creation, manipulation
- `anthropic-skills:xlsx` — spreadsheet creation and editing
- `anthropic-skills:docx` — Word document generation
- `anthropic-skills:pptx` — presentation creation
- `anthropic-skills:canvas-design` — visual art and poster design
- `anthropic-skills:web-artifacts-builder` — complex React/Tailwind web artifacts
- `anthropic-skills:mcp-builder` — MCP server creation
**Agent Olympus built-in skills (always available):**

> **IMPORTANT**: These are **skills**, NOT agents. Invoke them via `Skill(skill="agent-olympus:<name>")`, NOT via `Task(subagent_type=...)`. Using `Task(subagent_type=...)` will fail with "agent type not found".

- `agent-olympus:ask` — quick Codex/Gemini single-shot query
- `agent-olympus:deep-interview` — Socratic requirements clarification
- `agent-olympus:deep-dive` — 2-stage investigation pipeline for complex + ambiguous tasks (Phase 1)
- `agent-olympus:consensus-plan` — multi-perspective plan validation loop for 3+ story tasks (Phase 2)
- `agent-olympus:external-context` — facet-decomposed parallel research; enriches agent context with external docs and best practices (Phase 1)
- `agent-olympus:systematic-debug` — root-cause-first debugging (use when debugger fails 2x)
- `agent-olympus:trace` — evidence-driven hypothesis analysis (use when systematic-debug also fails)
- `agent-olympus:slop-cleaner` — AI bloat cleanup (use before final commit)
- `agent-olympus:git-master` — atomic commit discipline (use as final step)
- `agent-olympus:deepinit` — generate AGENTS.md codebase map (use on unfamiliar projects)
- `agent-olympus:harness-init` — initialize harness engineering structure (docs/, golden principles, arch constraints)
- `agent-olympus:research` — parallel web research for external docs/APIs

**Recommended Atlas workflow integration:**
```
Phase 1 (Analyze) → Skill(skill="agent-olympus:deep-dive") (if complexity=complex/architectural AND ambiguity > 40)
Phase 1 (Analyze) → Skill(skill="agent-olympus:external-context") (if external API/library knowledge gap detected)
Phase 2 (Plan)    → Skill(skill="agent-olympus:consensus-plan") (if 3+ stories; replaces standard Prometheus pass)
Phase 4 (Verify)  → Skill(skill="agent-olympus:systematic-debug") (if debugger fails 2x); Skill(skill="agent-olympus:trace") (if systematic-debug also fails)
Phase 5 (Review)  → Skill(skill="agent-olympus:slop-cleaner") → Skill(skill="agent-olympus:git-master") → DONE
```

**Rule**: If a specialized skill exists for the task, prefer it over a generic executor.
For example, use `anthropic-skills:xlsx` for spreadsheets instead of writing xlsx code manually.

## Stop_Conditions

STOP only when:
- ✅ All acceptance criteria met AND build passes AND tests pass AND reviews approved
- ❌ Same error 3 times — signaled by `recordPhaseError(runId, '<phase>', sig).shouldEscalate` once consulted (see Phase_Runner), not eyeballed
  ```
  node scripts/notify-cli.mjs --event escalated --orchestrator atlas --body "Same error 3 times: <error summary>"
  ```
- ❌ 15 total iterations exceeded — signaled by `beginAttempt(runId).allowed === false` (first pass) or `reattempt(...).allowed === false` (re-pass) once consulted (see Phase_Runner)
  ```
  node scripts/notify-cli.mjs --event escalated --orchestrator atlas --body "15 iteration limit exceeded"
  ```
- ❌ Max review rounds exceeded — signaled by `loopTick(runId, 'review').allowed === false` once consulted (default cap 3)
- ❌ Critical security vulnerability found (escalate to user)

> These limits are owned by the deterministic phase runner (`scripts/lib/phase-runner.mjs`),
> the sole caller of the underlying loop-guard caps — not self-counted. Consult the runner
> at each loop point; a `degraded:true` result means tracking was unavailable or state was
> not readable — fall back to the prose numbers above as a backstop.

**Explicit terminal failure (HU-17, review queue only).** <!-- AO-CONTRACT:terminal-failure-ingestion -->
Use the categorized marker only after all bounded recovery/fix paths are
exhausted and the run is genuinely terminal:

```javascript
import { finalizeFailedRun } from './scripts/lib/run-failure.mjs';
finalizeFailedRun(runId, {
  orchestrator: 'atlas',
  failureClass: 'task-outcome', // or 'orchestration'
  code: 'verification_exhausted',
  phase: 'verify',
});
```

Choose only an allowlisted class/code pair. Never store raw errors or reasons.
Do **not** finalize an infrastructure failure, cancellation, resumable
checkpoint, or a run with live workers; preserve it for recovery instead. This
marker merely makes the failed run eligible for a local human-review candidate
at SessionEnd—it never creates, edits, stages, or commits a golden task.

**NEVER stop because "it seems done" — verify EVERYTHING.**

</Atlas_Orchestrator>
