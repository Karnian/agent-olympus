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
  assert.match(skill, /const current(?:Atlas|Athena)Request\s*=\s*<user_request>/,
    'the current user-authored request must be captured on every invocation');
  assert.match(skill, /appendUserTaskUpdate,[\s\S]*?getUserTaskUpdates/,
    'shipping policy must use the strict atomic task-update ledger API');
  assert.match(skill, /const appendedTaskUpdate\s*=\s*appendUserTaskUpdate\(runId,\s*current(?:Atlas|Athena)Request,\s*\{[\s\S]*?allowCreate:\s*created(?:Atlas|Athena)Run\s*!==\s*null/,
    'the current request must be atomically appended, with creation allowed only for a new run');
  assert.match(skill, /!appendedTaskUpdate\.ok[\s\S]*?appendedTaskUpdate\.updates\?\.at\(-1\)\?\.task[\s\S]*?throw new Error/,
    'a lost or mismatched follow-up append must fail closed');
  const taskUpdateAppend = skill.indexOf('const appendedTaskUpdate = appendUserTaskUpdate(');
  const pipelineInit = skill.indexOf(`initPipeline(runId, '${orchestrator}')`);
  assert.ok(taskUpdateAppend >= 0 && taskUpdateAppend < pipelineInit,
    'the latest user constraint must be durable before pipeline work resumes');
  assert.match(skill, /const readDurableTaskBrief\s*=\s*action\s*=>[\s\S]*?const runRecord\s*=\s*getRun\(runId\)[\s\S]*?const strictUpdates\s*=\s*getUserTaskUpdates\(runId\)/,
    'shipping policy must read the durable run record');
  assert.match(skill, new RegExp(`runRecord\\.summary\\?\\.orchestrator !== ['"]${orchestrator}['"]`));
  assert.match(skill, /typeof runRecord\.summary\?\.task !== ['"]string['"][\s\S]*?throw new Error/,
    'missing original-task provenance must fail closed');
  assert.match(skill, /strictUpdates\.ok\s*!==\s*true[\s\S]*?strictUpdates\.updates\.length\s*<\s*1[\s\S]*?strictUpdates\.updates\.some/,
    'missing or malformed strict task-update provenance must fail closed');
  assert.match(skill, /return\s*\[[\s\S]*?runRecord\.summary\.task,[\s\S]*?strictUpdates\.updates\.map\(update => update\.task\)[\s\S]*?\];/,
    'shipping policy must include every durable user follow-up');
  assert.match(
    skill,
    /const resolved\s*=\s*resolveRunShipMode\(config,\s*readDurableTaskBrief\(action\)\)[\s\S]*?configuredShipMode\s*=\s*resolved\.configuredMode[\s\S]*?taskForbidsShipping\s*=\s*resolved\.taskForbidsShipping[\s\S]*?shipMode\s*=\s*resolved\.effectiveMode/,
    'effective ship mode must be derived from config plus all durable user requests',
  );
  assert.match(skill, /refreshRunShipPolicy\(['"]pipeline resume['"]\)[\s\S]*?initPipeline/,
    'fresh-process resume must resolve current task policy before phase restoration');
  assert.doesNotMatch(skill, /taskForbidsShipping\s*=\s*</, 'no task-policy placeholder may remain');
  assert.doesNotMatch(skill, /hasInteractiveUserChannel|userApprovedPush/,
    'shipping must not rely on model-populated approval booleans');
  assert.match(skill, /orchestrator model answering its own y\/n prompt is not user approval/i);
  assert.match(skill, /structured `AskUserQuestion` result/);
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
  assert.match(skill, /shipMode\s*===\s*['"]ask['"]\s*&&\s*durableHumanApproval\s*===\s*true/);
  assert.match(skill, /branch ready: <branchName> — push\/PR은 사용자가 직접/);

  const policyResolution = skill.indexOf('resolveRunShipMode(config, readDurableTaskBrief(action))');
  const finishBranch = skill.indexOf('Skill(skill="agent-olympus:finish-branch")', policyResolution);
  assert.ok(
    policyResolution >= 0 && finishBranch > policyResolution,
    'ship policy must resolve before the optional finish-branch helper',
  );
  assert.match(
    skill,
    /only when `shipMode === 'auto'`[\s\S]*?finish-branch[\s\S]*?stop it before any push, PR,\s+merge/i,
  );
  assert.match(skill, /may not mutate source files or create commits/i);
  assert.match(skill, /Phase 6 below is the sole owner of outward shipping actions/);

  assert.doesNotMatch(skill, /baseBranch:\s*['"]main['"]/);
  assert.doesNotMatch(skill, /git diff --stat main\.\.\.HEAD/);
  assert.match(skill, /detectBaseBranch\(cwd,\s*config\.ship\.baseBranch\)/);
  assert.match(skill, /detectRepositoryIdentity,[\s\S]*?repositoryIdentitiesEqual,/,
    'ship safety must use the shared repository identity helpers');
  assert.match(skill, /\['diff',\s*'--stat',\s*`origin\/\$\{baseBranch\}\.\.\.HEAD`\]/);
  assert.match(skill, /baseBranch,\s*\n\s*cwd,/);

  const phase6Start = skill.indexOf('### Phase 6 — SHIP');
  const phase6End = skill.indexOf('### Phase 6b — CI WATCH', phase6Start);
  const phase6 = skill.slice(phase6Start, phase6End);
  assert.match(phase6, /refreshRunShipPolicy\(['"]ship phase entry['"]\)[\s\S]*?getPipelineState\(runId\)\.phases\.ship/,
    'ship policy must be recomputed on every resume even when finalize is terminal');
  assert.match(phase6, /const requireShippingNotRevoked\s*=\s*action\s*=>[\s\S]*?refreshRunShipPolicy\(action\)[\s\S]*?const requireCurrentShippingAuthorization\s*=\s*action\s*=>[\s\S]*?shipMode\s*===\s*['"]ask['"][\s\S]*?!durableHumanApproval[\s\S]*?requirePinnedRepository\(action\)/,
    'every outward ship action must re-read policy and enforce current approval');

  assert.match(phase6, /AskUserQuestion\(\{\s*questions:\s*\[\{/s,
    'ask mode must use the real structured question schema');
  assert.match(phase6, /approvalResponse\?\.answers\?\.\[approvalQuestion\]/,
    'approval must come from the returned question-to-answer map');
  assert.match(phase6, /hasOwnProperty\.call\(approvalResponse,\s*['"]afkTimeoutMs['"]\)/,
    'AFK auto-resolution must not count as a human response');
  assert.match(phase6, /selectedAnswer\s*===\s*['"]Approve shipping['"]/,
    'only the exact affirmative option may approve shipping');
  assert.match(phase6, /type:\s*['"]human_ship_approval['"]/);
  assert.match(phase6, /source:\s*['"]AskUserQuestion['"][\s\S]*?decision:\s*['"]approved['"][\s\S]*?branchName,[\s\S]*?baseBranch,[\s\S]*?headCommit,[\s\S]*?repoIdentity,/,
    'human approval must bind branch, base, HEAD, and repository identity');
  assert.match(phase6, /matchesCurrentHumanApproval[\s\S]*?repositoryIdentitiesEqual\(event\?\.detail\?\.repoIdentity,\s*repoIdentity\)/,
    'durable approval re-read must compare repository identity');
  assert.ok(
    (phase6.match(/getRun\(runId\)\.events\.some\(matchesCurrentHumanApproval\)/g) || []).length >= 2,
    'approval must be checked from artifacts before asking and re-read after append',
  );
  const exactApproval = phase6.indexOf("selectedAnswer === 'Approve shipping'");
  const approvalRepoReread = phase6.indexOf("requirePinnedRepository('shipping approval recording')", exactApproval);
  const approvalWrite = phase6.indexOf('addEvent(runId, {', approvalRepoReread);
  const approvalReread = phase6.indexOf('getRun(runId).events.some(matchesCurrentHumanApproval)', approvalWrite);
  assert.ok(exactApproval >= 0 && exactApproval < approvalRepoReread
    && approvalRepoReread < approvalWrite && approvalWrite < approvalReread,
  'the exact human answer must precede repository revalidation, artifact append, and durable re-read');

  assert.equal(
    (phase6.match(/\bpreflightCheck\(\{\s*cwd,\s*baseBranch:\s*observedBaseBranch\s*\}\)/g) || []).length,
    1,
    'Phase 6 must make one cached preflight decision',
  );
  assert.doesNotMatch(phase6, /\bpreflightCheck\(\s*\)/);

  const shippingDecision = skill.indexOf('const shippingApplicable = preflight.ok && shippingApproved;', phase6Start);
  const restoredPhase = skill.indexOf('getPipelineState(runId).phases.ship', phase6Start);
  const restoredOutputs = skill.indexOf('const persistedShipOutputs = persistedShipPhase?.outputs;', restoredPhase);
  const restoredPush = skill.indexOf('persistedShipOutputs?.pushPerformed === true', restoredOutputs);
  const restoredPr = skill.indexOf("typeof persistedShipOutputs?.createdPrUrl === 'string'", restoredOutputs);
  const restoredBase = skill.indexOf("typeof persistedShipOutputs?.baseBranch === 'string'", restoredOutputs);
  const restoredBranch = skill.indexOf("typeof persistedShipOutputs?.branchName === 'string'", restoredOutputs);
  const restoredHead = skill.indexOf("typeof persistedShipOutputs?.headCommit === 'string'", restoredOutputs);
  const restoredRepoOrigin = skill.indexOf('persistedShipOutputs?.repoOriginUrl', restoredOutputs);
  const restoredRepoPush = skill.indexOf('persistedShipOutputs?.repoPushUrl', restoredOutputs);
  const restoredRepository = skill.indexOf('persistedShipOutputs?.repoRepository', restoredOutputs);
  const restoredRepoDefault = skill.indexOf('persistedShipOutputs?.repoDefaultBranch', restoredOutputs);
  assert.ok(restoredPhase >= phase6Start && restoredOutputs > restoredPhase && restoredPush > restoredOutputs
    && restoredPr > restoredOutputs && restoredBase > restoredOutputs
    && restoredBranch > restoredBase && restoredHead > restoredBranch
    && restoredRepoOrigin > restoredHead && restoredRepoPush > restoredRepoOrigin
    && restoredRepository > restoredRepoPush && restoredRepoDefault > restoredRepository
    && restoredRepoDefault < shippingDecision,
  'ship state must restore push/PR/branch/base/HEAD/repository before the shipping decision');
  assert.match(phase6, /persistedShipPhase\?\.status === ['"]completed['"][\s\S]*?!pushPerformed[\s\S]*?!createdPrUrl\?\.trim\(\)[\s\S]*?!restoredBaseBranch\?\.trim\(\)[\s\S]*?!restoredShipBranchName\?\.trim\(\)[\s\S]*?!restoredHeadCommit\?\.trim\(\)[\s\S]*?!restoredRepoIdentity[\s\S]*?throw new Error/,
    'completed ship recovery must reject missing durable push/PR/branch/base/HEAD/repository outputs');
  assert.match(phase6, /typeof persistedShipOutputs\?\.repoOriginUrl === ['"]string['"][\s\S]*?typeof persistedShipOutputs\?\.repoPushUrl === ['"]string['"][\s\S]*?typeof persistedShipOutputs\?\.repoRepository === ['"]string['"][\s\S]*?typeof persistedShipOutputs\?\.repoDefaultBranch === ['"]string['"][\s\S]*?originUrl:\s*persistedShipOutputs\.repoOriginUrl,[\s\S]*?pushUrl:\s*persistedShipOutputs\.repoPushUrl,[\s\S]*?repository:\s*persistedShipOutputs\.repoRepository,[\s\S]*?defaultBranch:\s*persistedShipOutputs\.repoDefaultBranch,/,
    'completed repository identity must be reconstructed from scalar ledger outputs');
  assert.match(phase6, /restoredShipBranchName\s*\?\?\s*observedBranchName/,
    'terminal skipped reporting must fall back to the observed branch instead of an empty name');

  const intentScan = phase6.indexOf('const shipIntentEvents = getRun(runId).events.filter');
  const duplicateIntentGuard = phase6.indexOf('shipIntentEvents.length > 1', intentScan);
  const recoveryIdentityGuard = phase6.indexOf('const recoveringDurableIntent = !shipAlreadyTerminal', duplicateIntentGuard);
  const identityMatcher = phase6.indexOf('const matchesObservedShipIdentity = detail =>', intentScan);
  const intentWrite = phase6.indexOf("type: 'ship_intent'", recoveryIdentityGuard);
  const intentReread = phase6.indexOf('const durableIntentEvents = getRun(runId).events.filter', intentWrite);
  const approvalAsk = phase6.indexOf('const approvalResponse = await AskUserQuestion({', intentReread);
  assert.ok(intentScan >= 0 && duplicateIntentGuard > intentScan
    && identityMatcher > intentScan && recoveryIdentityGuard > identityMatcher
    && intentWrite > recoveryIdentityGuard && intentReread > intentWrite
    && approvalAsk > intentReread,
  'one immutable durable ship intent must be recovered or appended and re-read before approval');
  assert.equal((phase6.match(/type:\s*['"]ship_intent['"]/g) || []).length, 1,
    'there must be exactly one ship-intent append site, never a replacement site');
  assert.match(phase6, /const proposedShipIntent\s*=\s*\{\s*branchName:\s*observedBranchName,\s*baseBranch:\s*observedBaseBranch,\s*headCommit:\s*observedHeadCommit,\s*repoIdentity:\s*preflight\.repoIdentity,\s*\}[\s\S]*?type:\s*['"]ship_intent['"][\s\S]*?detail:\s*proposedShipIntent/,
    'the initial durable ship intent must atomically bind branch, base, HEAD, and repository');
  assert.match(phase6, /matchesObservedShipIdentity\s*=\s*detail\s*=>\s*\([\s\S]*?detail\?\.branchName\s*===\s*observedBranchName[\s\S]*?detail\?\.baseBranch\s*===\s*observedBaseBranch[\s\S]*?detail\?\.headCommit\s*===\s*observedHeadCommit[\s\S]*?repositoryIdentitiesEqual\(detail\?\.repoIdentity,\s*preflight\.repoIdentity\)/,
    'ship-intent recovery must require exact current branch/base/HEAD/repository identity');
  assert.match(phase6, /recoveringDurableIntent[\s\S]*?!durableShipIntent\s*\|\|\s*preflight\.ok\s*!==\s*true[\s\S]*?!matchesObservedShipIdentity\(durableShipIntent\.detail\)[\s\S]*?throw new Error/,
    'an existing intent or in-progress recovery must fail closed instead of replacing its identity');
  assert.match(phase6, /const requirePinnedRepository\s*=\s*action\s*=>\s*\{[\s\S]*?detectRepositoryIdentity\(cwd\)[\s\S]*?!repositoryIdentitiesEqual\(currentRepoIdentity,\s*repoIdentity\)[\s\S]*?throw new Error/,
    'every repository revalidation must use current origin identity against the pinned identity');
  assert.match(phase6, /shipRecoveryInProgress\s*=\s*persistedShipPhase\?\.status\s*===\s*['"]in_progress['"][\s\S]*?shipRecoveryInProgress\s*&&\s*!shippingApplicable[\s\S]*?throw new Error[\s\S]*?const shipGate/,
    'an in-progress ship must never be converted to a skip when policy/preflight/approval drifts');
  assert.match(phase6, /shipAlreadyTerminal\s*=\s*\[['"]completed['"],\s*['"]skipped['"]\][\s\S]*?shipGate\s*=\s*shipAlreadyTerminal\s*\?\s*enterPhase\(runId,\s*['"]ship['"]\)/,
    'completed/skipped ship phases must be idempotently entered so restored outputs reach CI');

  const baseDetection = phase6.indexOf('detectBaseBranch(cwd, config.ship.baseBranch)');
  const preflightCall = phase6.indexOf('preflightCheck({ cwd, baseBranch: observedBaseBranch })');
  assert.ok(baseDetection >= 0 && baseDetection < preflightCall,
    'base branch must be detected before preflight');

  assert.match(phase6, /const shipCanAct\s*=\s*shippingApplicable[\s\S]*?shipGate\.proceed\s*===\s*true[\s\S]*?shipGate\.degraded\s*===\s*false/);
  assert.match(phase6, /shipGate\.status\s*===\s*['"]failed['"][\s\S]*?throw new Error/,
    'a terminally failed ship phase must never fall through to CI');
  assert.match(phase6, /shippingApplicable\s*&&\s*shipGate\.skip\s*!==\s*true\s*&&\s*!shipCanAct[\s\S]*?throw new Error/,
    'a denied/degraded ship transition must fail closed');

  const shipGuardStart = phase6.indexOf('if (shipCanAct) {');
  const shipGuardOpen = phase6.indexOf('{', shipGuardStart);
  const shipGuardClose = findMatchingBrace(phase6, shipGuardOpen);
  assert.ok(shipGuardStart >= 0 && shipGuardClose > shipGuardOpen,
    'outward ship actions must have one balanced strict gate');

  const diffBody = phase6.indexOf('const body = buildPRBody({ prd, diffStat, verifyResults });', shipGuardStart);
  const linkedBody = phase6.indexOf('const linkedBody = body +', diffBody);
  const lookupRepoCheck = phase6.indexOf("requirePinnedRepository('existing-PR lookup')", linkedBody);
  const existingLookup = phase6.indexOf('const existing = findExistingPR(branchName, {', lookupRepoCheck);
  const lookupFailure = phase6.indexOf('existing.ok !== true', existingLookup);
  const pushBranchRead = phase6.indexOf("const pushBranchName = execFileSync(", lookupFailure);
  const pushHeadRead = phase6.indexOf("const pushHeadCommit = execFileSync(", pushBranchRead);
  const toctouCheck = phase6.indexOf('pushBranchName !== branchName || pushHeadCommit !== headCommit', pushHeadRead);
  const pushRepoCheck = phase6.indexOf("requirePinnedRepository('push')", toctouCheck);
  const pushCall = phase6.indexOf("'push', repoIdentity.pushUrl, `${headCommit}:refs/heads/${branchName}`", pushRepoCheck);
  const pushed = phase6.indexOf('pushPerformed = true;', pushCall);
  assert.ok(diffBody >= shipGuardStart && diffBody < linkedBody && linkedBody < lookupRepoCheck
    && lookupRepoCheck < existingLookup
    && existingLookup < lookupFailure && lookupFailure < pushBranchRead
    && pushBranchRead < pushHeadRead && pushHeadRead < toctouCheck
    && toctouCheck < pushRepoCheck && pushRepoCheck < pushCall,
  'repository, lookup failure, and branch/HEAD drift must fail closed immediately before push');
  assert.ok(pushCall < shipGuardClose, 'push must be enclosed by the strict ship gate');
  assert.ok(pushCall >= 0 && pushed > pushCall, 'pushPerformed becomes true only after successful push');
  assert.doesNotMatch(phase6, /\['push',\s*'-u',\s*'origin',\s*'HEAD'\]/,
    'ship push must use the pinned push URL and immutable commit refspec');
  assert.match(phase6, /if \(existing\.found\)\s*\{[\s\S]*?requirePinnedRepository\(['"]PR update['"]\)[\s\S]*?updateExistingPR\(\{[\s\S]*?prNumber:\s*existing\.prNumber,[\s\S]*?body:\s*linkedBody,[\s\S]*?baseBranch,[\s\S]*?labels:\s*config\.ship\.labels,[\s\S]*?repository:\s*repoIdentity\.repository,[\s\S]*?updated\.ok !== true[\s\S]*?throw new Error[\s\S]*?createdPrUrl = existing\.prUrl;[\s\S]*?\}\s*else\s*\{[\s\S]*?requirePinnedRepository\(['"]PR creation['"]\)[\s\S]*?createPR\(\{/,
    'every existing PR must be refreshed; creation is only the successful no-match branch');
  const createCall = phase6.indexOf('const created = createPR({', pushed);
  const createFailure = phase6.indexOf('created.ok !== true', createCall);
  const createThrow = phase6.indexOf('throw new Error', createFailure);
  const prAssigned = phase6.indexOf('createdPrUrl = created.prUrl;', createThrow);
  assert.ok(createCall > pushed && prAssigned > createCall && prAssigned < shipGuardClose,
    'PR URL is assigned only after guarded createPR returns');
  assert.ok(createCall < createFailure && createFailure < createThrow && createThrow < prAssigned,
    'PR creation failure or missing URL must leave ship nonterminal for retry');
  assert.match(phase6, /findExistingPR\(branchName,\s*\{[\s\S]*?repository:\s*repoIdentity\.repository/,
    'existing PR lookup must target the pinned repository explicitly');
  assert.match(phase6, /createPR\(\{[\s\S]*?headBranch:\s*branchName,[\s\S]*?repository:\s*repoIdentity\.repository/,
    'PR creation must target the pinned head branch and repository explicitly');
  assert.match(phase6, /const shipOutputs\s*=\s*\{\s*pushPerformed,\s*createdPrUrl,\s*branchName,\s*baseBranch,\s*headCommit,[\s\S]*?repoOriginUrl:\s*repoIdentity\.originUrl,[\s\S]*?repoPushUrl:\s*repoIdentity\.pushUrl,[\s\S]*?repoRepository:\s*repoIdentity\.repository,[\s\S]*?repoDefaultBranch:\s*repoIdentity\.defaultBranch,\s*\}/,
    'ship identity must be flattened because completePhase persists scalar outputs only');
  assert.doesNotMatch(phase6, /const shipOutputs\s*=\s*\{[\s\S]*?\brepoIdentity,\s*\}/,
    'a nested repository object would be silently discarded by the phase output sanitizer');
  assert.match(phase6, /completePhase\(runId,\s*['"]ship['"],\s*shipOutputs,\s*\{[\s\S]*?checkpointData:[\s\S]*?shipOutputs/,
    'ship outcome must be present in both ledger outputs and checkpoint data');
  assert.ok(phase6.indexOf("completePhase(runId, 'ship', shipOutputs", pushed) < shipGuardClose,
    'ship completion must remain inside the strict gate');

  const ciStart = skill.indexOf('### Phase 6b — CI WATCH', phase6End);
  const completionStart = skill.indexOf('### COMPLETION', ciStart);
  const ci = skill.slice(ciStart, completionStart);
  assert.match(ci, /import\s*\{\s*getFailedLogs,\s*watchCI\s*\}\s*from\s*['"][^'"]*ci-watch\.mjs['"]/,
    'CI must use the pinned repository/commit watcher API');
  assert.match(ci, /refreshRunShipPolicy\(['"]CI phase entry['"]\)[\s\S]*?const ciApplicable/,
    'CI applicability must use a fresh durable no-ship policy on resume');
  assert.match(
    ci,
    /Boolean\(!noShip\s*&&\s*pushPerformed\s*&&\s*createdPrUrl\s*&&\s*config\.ci\.watchEnabled\)/,
    'CI requires current ship permission, an actual push, PR URL, and enabled watching',
  );
  assert.match(ci, /const ciCanAct\s*=\s*ciApplicable[\s\S]*?ciGate\.proceed\s*===\s*true[\s\S]*?ciGate\.degraded\s*===\s*false/);
  assert.match(ci, /ciGate\.status\s*===\s*['"]failed['"][\s\S]*?throw new Error/,
    'a terminally failed CI phase must not reach completion');
  assert.match(ci, /ciAlreadyTerminal\s*=\s*\[['"]completed['"],\s*['"]skipped['"]\][\s\S]*?ciGate\s*=\s*ciAlreadyTerminal\s*\?\s*enterPhase\(runId,\s*['"]ci['"]\)/,
    'a terminal CI phase must resume without repeating a watcher or skip mutation');
  assert.match(ci, /type:\s*['"]ci_head_target['"][\s\S]*?detail:\s*\{\s*branchName,\s*baseBranch,\s*headCommit,\s*repoIdentity\s*\}[\s\S]*?getRun\(runId\)\.events\.filter/,
    'the initial CI HEAD target must be appended and durably re-read');
  assert.match(ci, /let expectedCIHeadCommit\s*=\s*ciTargetEvents\.at\(-1\)\?\.detail\?\.headCommit\s*\?\?\s*headCommit/,
    'CI recovery must restore the latest durable target SHA');
  assert.match(ci, /const ciPollCycles\s*=\s*Math\.max\([\s\S]*?Math\.ceil\(config\.ci\.timeoutMs\s*\/\s*config\.ci\.pollIntervalMs\)/,
    'one runner CI attempt must poll for the configured timeout window');
  assert.match(ci, /requirePinnedRepository\(['"]CI polling['"]\)[\s\S]*?assertCurrentCITarget\(['"]CI polling['"]\)[\s\S]*?watchCI\(\{[\s\S]*?cwd,[\s\S]*?repository:\s*repoIdentity\.repository,[\s\S]*?branch:\s*branchName,[\s\S]*?expectedHeadSha:\s*expectedCIHeadCommit,[\s\S]*?maxCycles:\s*ciPollCycles/,
    'every CI poll must bind cwd, repository, branch, and exact durable HEAD');
  assert.match(ci, /requirePinnedRepository\(['"]CI failed-log fetch['"]\)[\s\S]*?assertCurrentCITarget\(['"]CI failed-log fetch['"]\)[\s\S]*?getFailedLogs\(\{[\s\S]*?cwd,[\s\S]*?repository:\s*repoIdentity\.repository,[\s\S]*?runId:\s*ciResult\.runId/,
    'failed logs must come from the pinned repository and current CI target');
  assert.match(ci, /requirePinnedRepository\(['"]CI fixer launch['"]\)[\s\S]*?assertCurrentCITarget\(['"]CI fixer launch['"]\)/,
    'repository and checkout identity must be revalidated before a fixer starts');
  assert.match(ci, /type:\s*['"]ci_fix_started['"][\s\S]*?sourceHeadCommit:\s*expectedCIHeadCommit,[\s\S]*?failureRunId:\s*ciResult\.runId,[\s\S]*?startedEvents\.length\s*!==\s*startedCountBefore\s*\+\s*1[\s\S]*?!matchesCIFixStarted\(appendedStart\)/,
    'a CI fixer must have a durably re-read start record before it can mutate the checkout');
  assert.match(ci, /const recordCIFixCandidate\s*=\s*\(candidateHeadCommit,\s*startedEvent,\s*recoveryMode\s*=\s*['"]live['"]\)\s*=>\s*\{[\s\S]*?!matchesCIFixStarted\(startedEvent\)[\s\S]*?!isDescendantCommit\(expectedCIHeadCommit,\s*candidateHeadCommit\)[\s\S]*?type:\s*['"]ci_fix_candidate['"][\s\S]*?failureRunId,[\s\S]*?fixAttempt,[\s\S]*?recoveryMode,[\s\S]*?!findLinkedCIFixStart\(candidate\)/,
    'a new fix commit must be linked to a start, be a descendant, and be durably recorded');
  assert.match(ci, /const findLinkedCIFixStart\s*=\s*candidate\s*=>[\s\S]*?candidateIndexes\.length\s*!==\s*1[\s\S]*?startIndexes\.length\s*!==\s*1[\s\S]*?startIndexes\[0\]\s*>=\s*candidateIndexes\[0\]/,
    'a recovered candidate must have exactly one earlier start transition');
  assert.match(ci, /const confirmCITarget\s*=\s*candidateHeadCommit\s*=>\s*\{[\s\S]*?type:\s*['"]ci_head_target['"][\s\S]*?headCommit:\s*candidateHeadCommit,[\s\S]*?const updatedTargets\s*=\s*getRun\(runId\)\.events\.filter[\s\S]*?updatedTargets\.length\s*!==\s*targetCountBefore\s*\+\s*1[\s\S]*?!matchesCITarget\(appendedTarget\)/,
    'a remotely confirmed CI fix SHA must be durably appended before the next poll');
  assert.match(ci, /expectedCIHeadCommit\s*=\s*await pushCIFix\(\)/,
    'the next CI poll must switch to the exact pushed fix SHA');
  assert.match(ci, /ciRecoveryInProgress\s*=\s*persistedCIStatus\s*===\s*['"]in_progress['"][\s\S]*?ciRecoveryInProgress\s*&&\s*!ciApplicable[\s\S]*?throw new Error/,
    'an in-progress CI phase must not be skipped after policy/config drift');
  assert.match(ci, /ciApplicable\s*&&\s*ciGate\.skip\s*!==\s*true\s*&&\s*!ciCanAct[\s\S]*?throw new Error/);
  assert.match(ci, /ciTick\.allowed\s*===\s*true\s*&&\s*ciTick\.degraded\s*===\s*false/,
    'each CI cycle must fail closed on a denied or degraded tick');
  const ciGuardStart = ci.indexOf('if (ciCanAct) {');
  const ciGuardOpen = ci.indexOf('{', ciGuardStart);
  const ciGuardClose = findMatchingBrace(ci, ciGuardOpen);
  assert.ok(ciGuardStart >= 0 && ci.indexOf("loopTick(runId, 'ci')", ciGuardStart) < ciGuardClose,
    'CI polling must remain inside the strict phase gate');
  const ciRecoveryCall = ci.indexOf('expectedCIHeadCommit = await recoverPendingCIFix();', ciGuardStart);
  const ciLoopTick = ci.indexOf("loopTick(runId, 'ci')", ciGuardStart);
  assert.ok(ciRecoveryCall > ciGuardStart && ciRecoveryCall < ciLoopTick,
    'an interrupted CI fix must reconcile before consuming another bounded loop tick');
  assert.match(ci, /const recoverPendingCIFix\s*=\s*async\s*\(\)\s*=>\s*\{[\s\S]*?pendingEvents[\s\S]*?candidates\.length\s*>\s*1[\s\S]*?throw new Error[\s\S]*?candidates\.length\s*===\s*1[\s\S]*?pushOrConfirmCIFix\(candidates\[0\]\)[\s\S]*?starts\.length\s*>\s*0[\s\S]*?current\.headCommit\s*!==\s*expectedCIHeadCommit[\s\S]*?recordCIFixCandidate[\s\S]*?pushOrConfirmCIFix\(candidate\)[\s\S]*?drifted without a durable fix-start record/,
    'recovery must reject ambiguous history and reconcile durable or locally committed candidates');
  assert.match(ci, /const readRemoteCIHead\s*=\s*\(\)\s*=>\s*\{[\s\S]*?requirePinnedRepository\(['"]CI remote-ref verification['"]\)[\s\S]*?['"]ls-remote['"],\s*repoIdentity\.pushUrl,\s*`refs\/heads\/\$\{branchName\}`[\s\S]*?rows\.length\s*!==\s*1[\s\S]*?remoteRef\s*!==\s*`refs\/heads\/\$\{branchName\}`/,
    'recovery must read exactly one pinned remote branch ref before deciding whether to push');
  assert.match(ci, /assertRemoteCITarget\(['"]CI polling['"]\)[\s\S]*?watchCI\(\{[\s\S]*?assertRemoteCITarget\(['"]CI poll result['"]\)/,
    'remote HEAD must match the durable target both before and after a long CI poll');
  assert.match(ci, /assertRemoteCITarget\(['"]CI completion['"]\)[\s\S]*?completePhase\(runId,\s*['"]ci['"]/,
    'remote HEAD must be revalidated immediately before CI completion');
  const ciPushHelper = ci.indexOf('const pushOrConfirmCIFix = async candidate => {', ciGuardStart);
  const ciCandidateRead = ci.indexOf('const current = readCurrentCIState();', ciPushHelper);
  const ciCandidateDriftCheck = ci.indexOf('current.branchName !== branchName || current.headCommit !== candidateHeadCommit', ciCandidateRead);
  const ciRepoBeforeApproval = ci.indexOf("requirePinnedRepository('CI approval')", ciCandidateDriftCheck);
  const ciAsk = ci.indexOf('const ciApprovalResponse = await AskUserQuestion({', ciRepoBeforeApproval);
  const ciAnswer = ci.indexOf('ciApprovalResponse?.answers?.[ciApprovalQuestion]', ciAsk);
  const ciExactApproval = ci.indexOf("selectedCIAnswer === 'Approve CI push'", ciAnswer);
  const ciRepoBeforeApprovalWrite = ci.indexOf("requirePinnedRepository('CI approval recording')", ciExactApproval);
  const ciApprovalWrite = ci.indexOf('addEvent(runId, {', ciRepoBeforeApprovalWrite);
  const ciApprovalReread = ci.indexOf('getRun(runId).events.some(matchesCIFixApproval)', ciApprovalWrite);
  const ciRemoteRead = ci.indexOf('const remoteHead = readRemoteCIHead();', ciApprovalReread);
  const ciSourceRemoteGuard = ci.indexOf('remoteHead === sourceHeadCommit', ciRemoteRead);
  const ciRepoBeforePush = ci.indexOf("requirePinnedRepository('CI push')", ciSourceRemoteGuard);
  const ciPushCall = ci.indexOf('`${candidateHeadCommit}:refs/heads/${branchName}`', ciRepoBeforePush);
  const ciUnexpectedRemoteGuard = ci.indexOf('remoteHead !== candidateHeadCommit', ciPushCall);
  const ciRemoteConfirmation = ci.indexOf('readRemoteCIHead() !== candidateHeadCommit', ciUnexpectedRemoteGuard);
  const ciTargetConfirmation = ci.indexOf('confirmCITarget(candidateHeadCommit);', ciRemoteConfirmation);
  assert.ok(ciPushHelper > ciGuardStart && ciCandidateRead > ciPushHelper
    && ciCandidateDriftCheck > ciCandidateRead && ciRepoBeforeApproval > ciCandidateDriftCheck
    && ciAsk > ciRepoBeforeApproval && ciAnswer > ciAsk
    && ciExactApproval > ciAnswer && ciRepoBeforeApprovalWrite > ciExactApproval
    && ciApprovalWrite > ciRepoBeforeApprovalWrite
    && ciApprovalReread > ciApprovalWrite && ciRemoteRead > ciApprovalReread
    && ciSourceRemoteGuard > ciRemoteRead && ciRepoBeforePush > ciSourceRemoteGuard
    && ciPushCall > ciRepoBeforePush && ciUnexpectedRemoteGuard > ciPushCall
    && ciRemoteConfirmation > ciUnexpectedRemoteGuard
    && ciTargetConfirmation > ciRemoteConfirmation && ciTargetConfirmation < ciGuardClose,
  'every CI fix push must bind the candidate, exact approval, remote transition, and durable confirmation');
  assert.match(ci, /humanResolvedCI[\s\S]*?afkTimeoutMs/,
    'AFK CI approval must fail closed');
  assert.match(ci, /action:\s*['"]ci_fix_push['"][\s\S]*?branchName,[\s\S]*?baseBranch,[\s\S]*?headCommit:\s*candidateHeadCommit,[\s\S]*?repoIdentity/,
    'CI approval provenance must bind the exact branch, base, fix commit, and repository');
  assert.match(ci, /sourceHeadCommit,[\s\S]*?failureRunId,[\s\S]*?fixAttempt,[\s\S]*?recovered:\s*recoveryMode\s*===\s*['"]local-drift['"]/,
    'CI approval must bind the exact fix transition and inferred-recovery provenance');
  assert.match(ci, /requiresHumanCIFixApproval\s*=\s*shipMode\s*===\s*['"]ask['"]\s*\|\|\s*recoveryMode\s*===\s*['"]local-drift['"]/,
    'an inferred local candidate must require human approval even in auto mode');
  assert.match(ci, /repositoryIdentitiesEqual\(event\?\.detail\?\.repoIdentity,\s*repoIdentity\)/,
    'CI approval re-read must compare the pinned repository identity');
  assert.match(ci, /ciFixBranchName\s*!==\s*branchName[\s\S]*?throw new Error[\s\S]*?ciFixHeadCommit\s*===\s*expectedCIHeadCommit[\s\S]*?throw new Error[\s\S]*?recordCIFixCandidate\([\s\S]*?pushOrConfirmCIFix\(candidate\)/,
    'CI fixes must run only from the durably restored shipped branch');
  assert.match(ci, /if \(!ciFixApproved\)[\s\S]*?throw new Error[\s\S]*?const remoteHead\s*=\s*readRemoteCIHead\(\)[\s\S]*?execFileSync\(['"]git['"],\s*\[\s*['"]push['"]/,
    'CI push must be unreachable without auto mode or durable human approval');
  assert.match(ci, /['"]push['"],\s*repoIdentity\.pushUrl,[\s\S]*?`\$\{candidateHeadCommit\}:refs\/heads\/\$\{branchName\}`/,
    'CI push must target the pinned push URL with the exact approved fix commit');
  assert.ok(ci.indexOf("completePhase(runId, 'ci'", ciGuardStart) < ciGuardClose,
    'CI completion must remain inside the strict phase gate');
  assert.match(ci, /checkpointData:\s*\{[\s\S]*?branchName,[\s\S]*?baseBranch,[\s\S]*?headCommit,[\s\S]*?repoIdentity,/,
    'CI checkpoint must retain the persisted ship branch/base/HEAD/repository identity');

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
    assert.match(skill, /setExecutionStoryPasses\([\s\S]*?<quality-failed story ids>[\s\S]*?false[\s\S]*?expectedGeneration:/,
      'quality-fail must CAS-rollback failed stories passes:false through the hardened store');
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
    assert.match(skill, /Do not call `createRun`, dispatch an[\s\S]*?`Agent`\/`Task`, spawn an adapter worker[\s\S]*?native teammate/);
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
    const bootstrapAgent = skill.indexOf('Agent(name="<first-worker>"', record);
    const nativeAgent = skill.indexOf('Agent(name="<worker>"', bootstrapAgent);
    const pathBFallback = skill.indexOf('#### Path B: Fallback', nativeAgent);
    const fallbackAgent = skill.indexOf('Agent(description="Execute isolated Athena stories"', pathBFallback);
    const adapter = skill.indexOf('await spawnTeam(teamSlug', record);
    assert.ok(enter >= 0 && enter < record, 'spawn must enter before recording recovery identity');
    assert.ok(
      enter < allocateGeneration && allocateGeneration < record,
      'adapter generation must be allocated before the durable launch identity',
    );
    assert.ok(record < checked, 'recordPhaseOutputs result must be checked');
    for (const [name, index] of Object.entries({
      worktree,
      bootstrapAgent,
      nativeAgent,
      pathBFallback,
      fallbackAgent,
      adapter,
    })) {
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

  test('native-team recovery is session-bound while adapter recovery stays durable', () => {
    assert.match(skill, /getCurrentSessionId/);
    assert.match(skill, /getRun\(runId\)\.summary\?\.sessionId/);
    assert.match(skill, /proven:[\s\S]*?currentSessionId\s*===\s*originSessionId/);
    assert.match(skill, /expectedSpawn\s*=\s*\{[^}]*nativeSessionId,/s);
    assert.match(skill, /spawnCheckpointPayload\s*=\s*\{[^}]*nativeSessionId,/s);

    const recoveryFence = skill.indexOf(
      "if (spawnGate.reason === 'recover' && nativeSessionRequired && !nativeSessionMatches)",
    );
    const taskList = skill.indexOf('TaskList()', recoveryFence);
    const recoveryPlan = skill.indexOf('planAthenaSpawnRecovery({', taskList);
    assert.ok(
      recoveryFence >= 0 && recoveryFence < taskList && taskList < recoveryPlan,
      'native session mismatch must stop before TaskList proof or recovery adoption',
    );

    const taskListCalls = [...skill.matchAll(/\bTaskList\s*\(([^)]*)\)/g)];
    assert.ok(taskListCalls.length >= 3);
    assert.ok(
      taskListCalls.every((call) => call[1].trim() === ''),
      'Claude Code 2.1.178+ TaskList calls must not pass a team slug or any argument',
    );

    const monitorFence = skill.indexOf("phase3SpawnPath === 'native-or-mixed'");
    const adapterMonitor = skill.indexOf('monitorTeam(phase3TeamSlug)', monitorFence);
    assert.ok(monitorFence >= 0 && monitorFence < adapterMonitor,
      'monitor recovery must fence native state before normal polling');
    assert.match(skill, /const nativeSessionRequired\s*=\s*plannedSpawnPath\s*===\s*['"]native-or-mixed['"]/);
    assert.match(skill, /const durableAdapterState\s*=\s*hasAdapterWorkers\s*\?\s*monitorTeam\(teamSlug\)/);
    assert.match(skill, /native cleanup is outside the originating Claude session/);
    assert.match(skill, /replacement generation[\s\S]*?must never[\s\S]*?old native team/i);
  });

  test('Athena validates the persisted execution PRD at plan and spawn boundaries', () => {
    assert.match(
      skill,
      /import\s*\{[^}]*\bassertExecutionPrd\b[^}]*\}\s*from\s*['"][^'"]*execution-prd\.mjs['"]/s,
    );
    assert.match(
      skill,
      /const planningPrdState\s*=\s*readPlanningPrdForExecution\(\{ cwd \}\)[\s\S]*?const plannedExecutionPrdState\s*=\s*enrichExecutionPrd\([\s\S]*?expectedGeneration:\s*planningPrdState\.generation[\s\S]*?assertExecutionPrd\(plannedExecutionPrd,\s*\{[\s\S]*?orchestrator:\s*['"]athena['"][\s\S]*?allowCompleted:\s*false/,
    );
    assert.match(
      skill,
      /const executionPrdState\s*=\s*readExecutionPrd\(\{ cwd, orchestrator:\s*['"]athena['"] \}\)[\s\S]*?const prd\s*=\s*executionPrdState\.prd[\s\S]*?assertExecutionPrd\(prd,\s*\{\s*orchestrator:\s*['"]athena['"],\s*allowCompleted:\s*true\s*\}\)/,
    );
    const planValidation = skill.indexOf('assertExecutionPrd(plannedExecutionPrd');
    const planCompletion = skill.indexOf("completePhase(runId, 'plan'", planValidation);
    const spawnValidation = skill.indexOf("assertExecutionPrd(prd, { orchestrator: 'athena', allowCompleted: true })");
    const worktreeCreation = skill.indexOf('const info = createWorkerWorktree(', spawnValidation);
    assert.ok(planValidation >= 0 && planValidation < planCompletion,
      'fresh planning must validate before completing the plan phase');
    assert.ok(spawnValidation >= 0 && spawnValidation < worktreeCreation,
      'spawn/resume must validate before creating a worktree or dispatching workers');
    assert.doesNotMatch(skill, /JSON\.parse\(readFileSync\('\.ao\/prd\.json/,
      'Athena must use hardened execution PRD reads after enrichment');

    assert.match(skill, /dependency references\/cycles/);
    assert.match(skill, /machine-readable[\s\S]{0,20}scope ownership/);
    assert.match(skill, /wildcard\/unsafe paths/);
    assert.match(skill, /overlapping scopes across every concurrently launched worker/);
    assert.match(skill, /JSON[\s\S]{0,20}parsing or planner prose alone is never launch authority/);
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
