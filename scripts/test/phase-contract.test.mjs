/**
 * Phase-contract linter — structural regression net for the HU-06.2/.3 SKILL.md
 * rewrites onto the phase-runner.
 *
 * A string-anchor check proves text survived; it does NOT prove behavior. So this
 * linter asserts the RUNNER GRAPH + the explicit `AO-CONTRACT:<key>` markers that
 * tag each load-bearing behavior the rewrite must preserve. It is deliberately
 * RED until the rewrite lands (TDD): it defines the target the rewrite closes.
 * Claude's content review + a fresh `claude -p` smoke cover what a linter cannot.
 *
 * HU-06.2 = atlas (this file). HU-06.3 will extend it with the athena block.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getPhaseSequence } from '../lib/phase-runner.mjs';

function readSkill(rel) {
  return readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf-8');
}

// Whitespace/quote/arg-name tolerant call matchers.
function callsPhaseFn(text, fn, phaseId) {
  return new RegExp(`${fn}\\(\\s*[A-Za-z0-9_.]+\\s*,\\s*['"]${phaseId}['"]`).test(text);
}
function callsLoopTick(text, key) {
  return new RegExp(`loopTick\\([^)]*['"]${key}['"]`).test(text);
}

function assertShipSafetyContract(skill, orchestrator) {
  assert.match(skill, /resolveShipMode\(config\)/, 'ship mode must resolve through the compatibility helper');
  assert.match(
    skill,
    /taskForbidsShipping\s*\?\s*['"]never['"]\s*:\s*configuredShipMode/,
    'an explicit task no-ship constraint must override configured auto mode',
  );
  assert.match(skill, /orchestrator model answering its own y\/n prompt is not user approval/i);
  assert.match(skill, /only an actual human response[^\n]*interactive user channel/i);
  assert.match(skill, /noShip\s*\|\|\s*config\.ship\.updateChangelog\s*===\s*false/);
  assert.match(skill, /noShip\s*\|\|\s*config\.ship\.updateTechDebtTracker\s*===\s*false/);
  assert.match(skill, /ship\.mode:\s*["']never["'][\s\S]*?suppresses this release side effect/i);
  assert.match(skill, /unattended\/headless[\s\S]*?halt shipping without a push/i);
  assert.match(skill, /config\.notify\.onBlocked/);
  assert.ok(
    skill.includes(
      `node scripts/notify-cli.mjs --event blocked --orchestrator ${orchestrator} --body "branch ready to ship: <branchName>"`,
    ),
    'headless ask must emit the documented blocked notification',
  );
  assert.match(skill, /shipMode\s*===\s*['"]auto['"]/);
  assert.match(skill, /shipMode\s*===\s*['"]ask['"]\s*&&\s*userApprovedPush\s*===\s*true/);
  assert.match(skill, /branch ready: <branchName> — push\/PR은 사용자가 직접/);

  const policyResolution = skill.indexOf('const configuredShipMode = resolveShipMode(config);');
  const finishBranch = skill.indexOf('Skill(skill="agent-olympus:finish-branch")', policyResolution);
  assert.ok(
    policyResolution >= 0 && finishBranch > policyResolution,
    'ship policy must resolve before the optional finish-branch helper',
  );
  assert.match(skill, /only when `shipMode === 'auto'`[\s\S]*?finish-branch[\s\S]*?stop it before any push, PR, merge/i);
  assert.match(skill, /Phase 6 below is the sole owner of outward shipping actions/);

  assert.doesNotMatch(skill, /baseBranch:\s*['"]main['"]/);
  assert.doesNotMatch(skill, /git diff --stat main\.\.\.HEAD/);
  assert.match(skill, /detectBaseBranch\(cwd,\s*config\.ship\.baseBranch\)/);
  assert.match(skill, /\['diff',\s*'--stat',\s*`origin\/\$\{baseBranch\}\.\.\.HEAD`\]/);
  assert.match(skill, /baseBranch,\s*\n\s*cwd,/);

  const phase6Start = skill.indexOf('### Phase 6 — SHIP');
  const phase6End = skill.indexOf('### Phase 6b — CI WATCH', phase6Start);
  const phase6 = skill.slice(phase6Start, phase6End);
  assert.equal(
    (phase6.match(/\bpreflightCheck\(\)/g) || []).length,
    1,
    'Phase 6 must make one cached preflight decision',
  );

  const shippingDecision = skill.indexOf('const shippingApplicable = preflight.ok && shippingApproved;', phase6Start);
  const pushDefault = skill.indexOf('let pushPerformed = false;', phase6Start);
  const prDefault = skill.indexOf('let createdPrUrl = null;', phase6Start);
  assert.ok(pushDefault >= phase6Start && pushDefault < shippingDecision);
  assert.ok(prDefault >= phase6Start && prDefault < shippingDecision);
  assert.equal((phase6.match(/let pushPerformed = false;/g) || []).length, 1);
  assert.equal((phase6.match(/let createdPrUrl = null;/g) || []).length, 1);

  const pushCall = skill.indexOf("execFileSync('git', ['push', '-u', 'origin', 'HEAD']", phase6Start);
  const pushed = skill.indexOf('pushPerformed = true;', pushCall);
  assert.ok(pushCall >= 0 && pushed > pushCall, 'pushPerformed becomes true only after successful push');
  assert.match(phase6, /findExistingPR\(branchName\)[\s\S]*?existing\.found[\s\S]*?createdPrUrl = existing\.prUrl/);
  const createCall = skill.indexOf('const created = createPR({', pushed);
  const prAssigned = skill.indexOf('createdPrUrl = created.ok ? created.prUrl : null;', createCall);
  assert.ok(createCall > pushed && prAssigned > createCall, 'PR URL is assigned only after createPR returns');
  assert.match(
    skill,
    /Boolean\(pushPerformed\s*&&\s*createdPrUrl\s*&&\s*config\.ci\.watchEnabled\)/,
    'CI requires an actual push, PR URL, and enabled watching',
  );
  assert.match(skill, /Never claim a PR exists on a[\s\S]*?no-ship, declined, headless, preflight-failed, or PR-failed path/);
  assert.ok(
    skill.includes(`--orchestrator ${orchestrator} --body "N/N stories passed. branch ready: <branchName> — push/PR은 사용자가 직접"`),
    'completion notification must preserve the branch-ready outcome when no PR exists',
  );
}

function findMatchingBrace(text, openIndex) {
  assert.equal(text[openIndex], '{', 'openIndex must point at an opening brace');
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = openIndex; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      i += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  return -1;
}

// loop-guard functions that the rewrite must NOT call directly (the runner is the
// sole caller). registerEscalation is intentionally excluded — it lives in
// stage-escalation.mjs and owns the light-mode-rewind cap, a separate concern.
const FORBIDDEN_LOOPGUARD_CALLS = [
  /\bregisterIteration\s*\(/,
  /\bregisterReviewRound\s*\(/,
  /\bregisterCounter\s*\(/,
  /\brecordError\s*\(/,
];
const LOOPGUARD_IMPORT = /from\s+['"][^'"]*loop-guard\.mjs['"]/;

const ATLAS_MARKERS = [
  'runner-init', 'outer-attempt', 'review-reject-reattempt', 'quality-fail',
  'light-mode-resolution', 'light-mode-rewind', 'false-trivial-guard', 'trivial-prd',
  'explore-before-metis', 'subagent-validation', 'spec-gate', 'consensus-plan',
  'cross-validation', 'debug-escalation', 'review-router', 'review-escalation',
  'verification-gate', 'ci-watch', 'cleanup', 'run-finalize',
  'terminal-failure-ingestion',
];

const ATHENA_MARKERS = [
  'runner-init', 'outer-attempt', 'spawn-recover', 'monitor-recover',
  'integrate-recover', 'spawn-progress', 'team-recover',
  'light-mode-resolution', 'light-mode-rewind', 'subagent-validation',
  'spec-gate', 'consensus-plan', 'worktree-isolation', 'provider-failover',
  'wisdom-tracking', 'merge-checkpoint', 'cross-validation',
  'debug-escalation', 'review-router', 'review-escalation',
  'review-reject-reattempt', 'verification-gate', 'ci-watch', 'cleanup',
  'run-finalize', 'terminal-failure-ingestion',
];

describe('atlas SKILL.md phase-runner contract', () => {
  const skill = readSkill('skills/atlas/SKILL.md');
  const phaseIds = getPhaseSequence('atlas').map(p => p.id);

  test('imports the phase-runner (and the runner is the loop-guard owner)', () => {
    assert.match(skill, /from\s+['"][^'"]*phase-runner\.mjs['"]/, 'must import phase-runner.mjs');
  });

  test('run creation failure stops before pipeline initialization', () => {
    assert.match(skill, /const createdAtlasRun\s*=\s*activeAtlasRunId\s*\?\s*null\s*:\s*createRun\(['"]atlas['"]/);
    assert.match(skill, /createdAtlasRun\s*&&\s*!createdAtlasRun\.ok[\s\S]*?throw new Error/);
    assert.match(skill, /const runId\s*=\s*activeAtlasRunId\s*\|\|\s*createdAtlasRun\.runId/);
    assert.ok(
      skill.indexOf('createdAtlasRun && !createdAtlasRun.ok') < skill.indexOf("initPipeline(runId, 'atlas')"),
      'create failure must stop before initPipeline',
    );
    assert.match(skill, /const pipelineInit\s*=\s*initPipeline\(runId,\s*['"]atlas['"]\)/);
    assert.match(skill, /!pipelineInit\.ok\s*\|\|\s*pipelineInit\.degraded[\s\S]*?throw new Error/);
    assert.match(skill, /Restart[\s\S]*?cancelled\/user_cancelled[\s\S]*?active pointer was cleared/);
  });

  test('every atlas phase has enterPhase + completePhase wiring', () => {
    for (const id of phaseIds) {
      assert.ok(callsPhaseFn(skill, 'enterPhase', id), `missing enterPhase('${id}')`);
      assert.ok(callsPhaseFn(skill, 'completePhase', id), `missing completePhase('${id}')`);
    }
  });

  test('outer attempt loop uses beginAttempt + reattempt (the 15-cap chokepoint)', () => {
    assert.match(skill, /beginAttempt\(/, 'missing beginAttempt(');
    assert.match(skill, /reattempt\(/, 'missing reattempt(');
  });

  test('loop phases tick the right bounded counters', () => {
    assert.ok(callsLoopTick(skill, 'review'), "missing loopTick(_,'review')");
    assert.ok(callsLoopTick(skill, 'quality'), "missing loopTick(_,'quality')");
    assert.ok(callsLoopTick(skill, 'ci'), "missing loopTick(_,'ci')");
  });

  test('verify fix loop records errors through the runner', () => {
    assert.match(skill, /recordPhaseError\(/, 'missing recordPhaseError(');
  });

  test('light-mode rewind goes through reopenPhase, keeping its own escalation cap', () => {
    assert.match(skill, /reopenPhase\([^)]*light_mode_rewind/, "missing reopenPhase('plan',{reason:'light_mode_rewind'})");
    assert.match(skill, /registerEscalation\([^)]*light-mode-rewind/, 'must KEEP registerEscalation light-mode-rewind cap (not loop-guard)');
  });

  test('NO direct loop-guard imports or calls remain', () => {
    assert.doesNotMatch(skill, LOOPGUARD_IMPORT, 'must not import loop-guard.mjs directly');
    for (const re of FORBIDDEN_LOOPGUARD_CALLS) {
      assert.doesNotMatch(skill, re, `direct loop-guard call must be replaced by a runner call: ${re}`);
    }
  });

  test('the 7 numeric saveCheckpoint phase calls are gone (completePhase checkpoints instead)', () => {
    assert.doesNotMatch(skill, /saveCheckpoint\(\s*['"]atlas['"]\s*,\s*\{\s*phase:\s*\d/, 'numeric saveCheckpoint({phase:N}) must be replaced by completePhase');
  });

  test('every AO-CONTRACT behavior marker is present', () => {
    for (const key of ATLAS_MARKERS) {
      assert.ok(skill.includes(`AO-CONTRACT:${key}`), `missing AO-CONTRACT:${key}`);
    }
  });

  // Codex review (HU-06.2) caught these wiring pitfalls; assert the fixes survive future edits.
  test('outer-attempt first-pass guard is a CONCRETE predicate (not a placeholder), preventing double-tick', () => {
    // Must test the ledger's attempt counter, not a prose comment, so a reattempt re-entry
    // (attempt>0) deterministically skips beginAttempt. (Codex HU-06.2 re-review finding.)
    assert.match(skill, /getPipelineState\(runId\)\.attempt\s*===\s*0/,
      'beginAttempt must be guarded by getPipelineState(runId).attempt === 0 (concrete first-pass test)');
    assert.match(skill, /beginAttempt\(/, 'beginAttempt must still be called');
  });

  test('light-mode rewind checks the escalation cap BEFORE reopening, on every path', () => {
    assert.match(skill, /registerEscalation\([^)]*light-mode-rewind/, 'must keep registerEscalation light-mode-rewind');
    assert.match(skill, /esc\.allowed/, 'must check registerEscalation(...).allowed before reopenPhase');
    // The Phase-2 retroactive re-entry must reuse the cap-checked block, not call reopenPhase unguarded.
    assert.match(skill, /same\s+cap-checked\s+rewind\s+block/i,
      'the retroactive re-entry must reference the cap-checked rewind block (no unguarded reopenPhase)');
  });

  test('quality-fail explicitly flips failed stories passes:false (else execute no-ops)', () => {
    assert.match(skill, /setStoriesPassesFalse|quality-failed stories passes:false/,
      'quality-fail must mark the failed stories passes:false as an explicit step');
  });

  test('dynamic ship/ci skips use skipPhase, not enterPhase().skip', () => {
    assert.match(skill, /skipPhase\(runId, 'ship'/, "ship's not-applicable path must call skipPhase('ship')");
    assert.match(skill, /skipPhase\(runId, 'ci'/, "ci's not-applicable path must call skipPhase('ci')");
  });

  test('ship safety contract gates release effects, approval, base detection, and CI', () => {
    assertShipSafetyContract(skill, 'atlas');
  });

  test('completion finalizes the exact run only after the pipeline is complete', () => {
    assert.match(skill, /import\s*\{[^}]*finalizeRun[^}]*\}\s*from\s*['"][^'"]*run-artifacts\.mjs['"]/s);
    assert.match(skill, /isComplete\(runId\)/);
    assert.match(skill, /finalizeRun\(runId,\s*\{\s*result:\s*['"]success['"]\s*\}\)/);
    assert.match(skill, /getActiveRunId\(['"]atlas['"]\)\s*===\s*runId/);
    assert.ok(
      skill.lastIndexOf("completePhase(runId, 'complete')")
        < skill.lastIndexOf("finalizeRun(runId, { result: 'success' })"),
      'finalizeRun must run only after completePhase writes the terminal ledger',
    );
  });
});

describe('agents/atlas.md references the runner chokepoint, not loop-guard', () => {
  const agent = readSkill('agents/atlas.md');

  test('points at the phase-runner / its chokepoints', () => {
    assert.ok(
      /phase-runner|beginAttempt|loopTick|recordPhaseError/.test(agent),
      'agents/atlas.md must reference the runner chokepoints',
    );
  });

  test('no direct loop-guard import or call', () => {
    assert.doesNotMatch(agent, LOOPGUARD_IMPORT, 'must not import loop-guard.mjs');
    for (const re of FORBIDDEN_LOOPGUARD_CALLS) {
      assert.doesNotMatch(agent, re, `direct loop-guard call must be replaced: ${re}`);
    }
  });
});

describe('athena SKILL.md phase-runner contract', () => {
  const skill = readSkill('skills/athena/SKILL.md');
  const phaseIds = getPhaseSequence('athena').map(p => p.id);

  test('imports the phase-runner and wires every Athena phase', () => {
    assert.match(skill, /from\s+['"][^'"]*phase-runner\.mjs['"]/, 'must import phase-runner.mjs');
    for (const id of phaseIds) {
      assert.ok(callsPhaseFn(skill, 'enterPhase', id), `missing enterPhase('${id}')`);
      assert.ok(callsPhaseFn(skill, 'completePhase', id), `missing completePhase('${id}')`);
    }
  });

  test('orphan checkpoint adoption requires artifact proof and exclusive pointer recovery', () => {
    assert.match(
      skill,
      /import\s*\{\s*recoverOrphanedRun\s*\}\s*from\s*['"][^'"]*orphan-run-recovery\.mjs['"]/,
    );
    assert.match(
      skill,
      /const orphanRecovery\s*=\s*!activeAthenaRunId\s*&&\s*pendingCheckpoint\?\.runId[\s\S]*?recoverOrphanedRun\(['"]athena['"],\s*pendingCheckpoint\.runId\)/,
    );
    assert.match(skill, /!orphanRecovery\.ok\s*&&\s*!orphanRecovery\.canCreateNewRun/);
    assert.match(skill, /const recoveredCheckpointRunId\s*=\s*orphanRecovery\?\.ok\s*\?/);
    assert.match(skill, /const createdAthenaRun\s*=\s*\(activeAthenaRunId\s*\|\|\s*recoveredCheckpointRunId\)[\s\S]*?createRun\(['"]athena['"]/);
    assert.match(skill, /createdAthenaRun\s*&&\s*!createdAthenaRun\.ok[\s\S]*?throw new Error/);
    assert.match(skill, /activeAthenaRunId\s*\|\|\s*recoveredCheckpointRunId\s*\|\|\s*createdAthenaRun\.runId/);
    assert.match(skill, /canCreateNewRun is true only for an exact terminal summary revalidated/);
    assert.match(skill, /missing run directory is not worker-liveness proof/);
    assert.match(skill, /absent run directory[\s\S]*?canCreateNewRun === false/);
    assert.match(skill, /Missing\/corrupt\/symlinked summary or pipeline[\s\S]*?canCreateNewRun === false/);
    assert.match(skill, /Do not call `createRun`, `TeamCreate`,[\s\S]*?`Task`, adapter[\s\S]*?native teammate launch/);
    assert.match(skill, /clearing the checkpoint or observing a missing[\s\S]*?never authorizes a new run or team/);
    assert.doesNotMatch(
      skill,
      /orphanedCheckpointRunId[\s\S]{0,300}(?:RegExp|\/\^athena-)/,
      'a regex-shaped checkpoint runId must never be sufficient for adoption',
    );
    assert.match(skill, /regular\/no-follow `summary\.json`/);
    assert.match(skill, /existing valid Athena `pipeline\.json`/);
    assert.match(skill, /exclusive create/);
  });

  test('all Athena loop caps and errors go through runner chokepoints', () => {
    assert.match(skill, /getPipelineState\(runId\)\.attempt\s*===\s*0/);
    assert.match(skill, /beginAttempt\(runId\)/);
    assert.ok(callsLoopTick(skill, 'monitor'));
    assert.ok(callsLoopTick(skill, 'review'));
    assert.ok(callsLoopTick(skill, 'ci'));
    assert.match(skill, /recordPhaseError\(runId,\s*['"]integrate['"]/);
    assert.doesNotMatch(skill, LOOPGUARD_IMPORT);
    for (const re of FORBIDDEN_LOOPGUARD_CALLS) assert.doesNotMatch(skill, re);
  });

  test('review rejection reopens integrate, never Atlas-only verify', () => {
    assert.match(skill, /reattempt\(runId,\s*\{\s*reopen:\s*\[\s*['"]integrate['"]\s*\],\s*reason:\s*['"]review_reject['"]/s);
    assert.doesNotMatch(skill, /reopen:\s*\[\s*['"]verify['"]\s*\]/);
  });

  test('spawn recovery identity is durable before every launch primitive', () => {
    const enter = skill.indexOf("enterPhase(runId, 'spawn')");
    const allocateGeneration = skill.indexOf('allocateTeamRunId()', enter);
    const record = skill.indexOf("recordPhaseOutputs(runId, 'spawn'", enter);
    const checked = skill.indexOf('if (!spawnProgress.ok || spawnProgress.degraded)', record);
    const worktree = skill.indexOf('const info = createWorkerWorktree(', record);
    const nativeTeam = skill.indexOf('TeamCreate("athena-<slug>")', record);
    const fallbackAgent = skill.indexOf('Task(subagent_type=', nativeTeam);
    const adapter = skill.indexOf('await spawnTeam(teamSlug', record);
    assert.ok(enter >= 0 && enter < record, 'spawn must enter before recording recovery identity');
    assert.ok(
      enter < allocateGeneration && allocateGeneration < record,
      'adapter generation must be allocated before the durable launch identity',
    );
    assert.ok(record < checked, 'recordPhaseOutputs result must be checked');
    for (const [name, index] of Object.entries({ worktree, nativeTeam, fallbackAgent, adapter })) {
      assert.ok(checked < index, `${name} launch must follow durable recovery identity`);
    }
    assert.match(skill, /spawnGate\.reason\s*===\s*['"]recover['"]/);
    assert.match(skill, /monitorTeam\(teamSlug\)/, 'adapter recovery must adopt durable team state');
    assert.match(skill, /planAthenaSpawnRecovery\(/);
    assert.match(skill, /expectedSpawn\s*=\s*\{\s*runId,/s);
    assert.match(skill, /expectedSpawn\s*=\s*\{[^}]*adapterRunId,/s);
    assert.match(skill, /checkpoint:\s*spawnCheckpoint/);
    assert.match(skill, /adapterTeamProof/);
    assert.match(skill, /runId:\s*durableAdapterState\.runId/);
    assert.match(skill, /nativeTeamProof/);
    assert.doesNotMatch(skill, /TaskList\(teamSlug\)\s*!==\s*null/);
    assert.match(skill, /spawn recovery stopped safely/);
    assert.match(
      skill,
      /spawnTeam\(teamSlug,\s*externalWorkers,\s*cwd,\s*capabilities,\s*\{\s*runId:\s*adapterRunId\s*\}\)/,
      'spawnTeam must receive the preallocated generation',
    );
    assert.match(skill, /status\?\.runId !== phase3AdapterRunId/);
    const payloadDeclaration = skill.indexOf('let spawnCheckpointPayload = null;');
    assert.ok(payloadDeclaration >= 0, 'missing prelaunch payload declaration');
    const guardStart = skill.indexOf("if (spawnRecoveryMode === 'spawn') {", payloadDeclaration);
    assert.ok(guardStart > payloadDeclaration, 'missing spawn guard after prelaunch payload declaration');
    const guardOpen = skill.indexOf('{', guardStart);
    const guardClose = findMatchingBrace(skill, guardOpen);
    const fenceClose = skill.indexOf('\n```', guardOpen);
    assert.ok(guardOpen >= 0 && guardOpen < guardClose, 'spawn guard must have a balanced closing brace');
    assert.ok(guardClose < fenceClose, 'spawn guard must close within its JavaScript fence');

    const payloadAssignments = [...skill.matchAll(/\bspawnCheckpointPayload\s*=\s*\{/g)];
    assert.equal(payloadAssignments.length, 1, 'prelaunch payload must have exactly one creation site');
    const payloadOpen = skill.indexOf('{', payloadAssignments[0].index);
    const payloadClose = findMatchingBrace(skill, payloadOpen);
    assert.ok(
      payloadAssignments[0].index > guardOpen && payloadClose < guardClose,
      'prelaunch payload creation must remain inside the spawn guard',
    );
    assert.match(
      skill.slice(payloadOpen + 1, payloadClose),
      /launchState:\s*['"]not-started['"]/,
      'prelaunch payload must persist not-started state',
    );
    const prelaunchSave = /const prelaunchCheckpoint = await saveCheckpoint\('athena', spawnCheckpointPayload\)/g;
    const saveCalls = [...skill.matchAll(prelaunchSave)];
    assert.equal(saveCalls.length, 1, 'prelaunch checkpoint must have exactly one save site');
    assert.ok(
      saveCalls[0].index > guardOpen && saveCalls[0].index < guardClose,
      'prelaunch checkpoint save must remain inside the spawn guard',
    );
    assert.doesNotMatch(
      skill,
      /worktrees:\s*spawnRecoveryMode === 'adopt'/,
      'adopt must preserve the validated checkpoint instead of downgrading it',
    );
  });

  test('runner initialization and every destructive recovery boundary fail closed', () => {
    assert.match(skill, /if \(!pipelineInit\.ok \|\| pipelineInit\.degraded\)/);
    assert.match(skill, /pipeline ledger is unavailable or corrupt/);
    assert.ok(
      (skill.match(/validateAthenaCheckpointBinding\(/g) || []).length >= 6,
      'spawn/monitor/wisdom/integrate/review/finalize/ship/ci/complete must bind checkpoints',
    );
    assert.match(skill, /worktrees: monitorWorktrees/);
    assert.match(skill, /providerTeamsToShutdown \|\| \[\]/);
    assert.match(skill, /teamSlug: integrationSpawnIdentity\.teamSlug/);
  });

  test('Athena live evidence outputs prove terminal workers and complete merges', () => {
    assert.match(skill, /worktreeDigest/);
    assert.match(skill, /terminalWorkers: phase3IntendedWorkers/);
    assert.match(skill, /isolatedWorkers: isolatedWorkerNames\.join\(','\)/);
    assert.match(skill, /mergedWorkers: mergedWorkerNames\.join\(','\)/);
    assert.match(skill, /verificationPassed: true/);
    assert.match(skill, /integrationCommit/);
  });

  test('only recovery-critical mid-phase numeric checkpoints remain', () => {
    const numeric = [...skill.matchAll(/phase:\s*(\d+)/g)].map((match) => Number(match[1]));
    assert.ok(numeric.length > 0);
    assert.ok(numeric.every((phase) => [2, 3, 4].includes(phase)), `unexpected phase checkpoint: ${numeric}`);
  });

  test('dynamic ship and CI paths are terminal in the ledger', () => {
    assert.match(skill, /skipPhase\(runId, 'ship'/);
    assert.match(skill, /skipPhase\(runId, 'ci'/);
    assert.match(skill, /completePhase\(runId, 'ship'/);
    assert.match(skill, /completePhase\(runId, 'ci'/);
  });

  test('ship safety contract gates release effects, approval, base detection, and CI', () => {
    assertShipSafetyContract(skill, 'athena');
  });

  test('every Athena behavior marker is present', () => {
    for (const key of ATHENA_MARKERS) {
      assert.ok(skill.includes(`AO-CONTRACT:${key}`), `missing AO-CONTRACT:${key}`);
    }
  });

  test('completion finalizes the exact Athena run after complete', () => {
    assert.match(skill, /isComplete\(runId\)/);
    assert.match(skill, /finalizeRun\(runId,\s*\{[\s\S]*?result:\s*['"]success['"]/);
    assert.match(skill, /getActiveRunId\(['"]athena['"]\)\s*===\s*runId/);
    assert.ok(
      skill.lastIndexOf("completePhase(runId, 'complete'")
        < skill.lastIndexOf('finalizeRun(runId, {'),
      'finalizeRun must follow completePhase',
    );
  });

  test('completion preserves its checkpoint across cleanup and both finalization crash windows', () => {
    const cleanup = skill.indexOf('const cleanupResult = cleanupTeamWorktrees(');
    const complete = skill.lastIndexOf("completePhase(runId, 'complete'");
    const finalize = skill.lastIndexOf('finalizeRun(runId, {');
    const clear = skill.lastIndexOf("clearCheckpoint('athena')");
    assert.ok(cleanup >= 0 && cleanup < complete && complete < finalize && finalize < clear);
    assert.match(skill, /if \(completeGate\.skip\)[\s\S]*?isComplete\(runId\)[\s\S]*?finalizeRun\(runId,[\s\S]*?clearCheckpoint\('athena'\)[\s\S]*?return;/);
    assert.match(skill, /if \(cleanupResult\.errors > 0\)/);
    assert.match(skill, /cleanupState: 'done'/);
  });
});

describe('agents/athena.md references the runner chokepoint, not loop-guard', () => {
  const agent = readSkill('agents/athena.md');

  test('points at the phase-runner chokepoints', () => {
    assert.match(agent, /phase-runner\.mjs/);
    assert.match(agent, /beginAttempt|reattempt/);
    assert.match(agent, /loopTick/);
    assert.match(agent, /recordPhaseError/);
  });

  test('has no direct loop-guard import or call', () => {
    assert.doesNotMatch(agent, LOOPGUARD_IMPORT);
    for (const re of FORBIDDEN_LOOPGUARD_CALLS) assert.doesNotMatch(agent, re);
  });
});
