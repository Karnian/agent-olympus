import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'node:path';

function readRepoFile(path) {
  return readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');
}

describe('provider-aware planning and Athena applicability', () => {
  it('Prometheus never invents Codex availability', () => {
    const prometheus = readRepoFile('agents/prometheus.md');
    const atlas = readRepoFile('skills/atlas/reference.md');
    assert.match(prometheus, /caller reports Codex available/);
    assert.match(prometheus, /never invent provider availability/);
    assert.doesNotMatch(prometheus, /Include Codex assignments for:/);
    assert.match(atlas, /Provider availability: Codex=\$\{hasCodex \? 'available' : 'unavailable'\}/);
    assert.match(atlas, /Assign only available providers/);
    assert.match(atlas, /const _prometheusCodexHint = hasCodex/);
    assert.match(atlas, /Codex is unavailable; do not assign any Codex worker/);
    assert.doesNotMatch(atlas, /- Codex assignments for algorithmic\/refactoring work/);
  });

  it('Athena is consistently limited to non-overlapping collaborative packages', () => {
    const english = readRepoFile('README.md');
    const korean = readRepoFile('README.ko.md');
    const athena = readRepoFile('skills/athena/SKILL.md');
    for (const source of [english, athena]) {
      assert.match(source, /Non-overlapping work packages that benefit from discovery sharing/i);
      assert.doesNotMatch(source, /Interdependent tasks/i);
    }
    assert.match(korean, /발견 공유가 유용한 비중첩 작업 패키지/);
    assert.doesNotMatch(korean, /상호의존적 작업/);
  });
});

describe('typed Hermes artifact integration', () => {
  const hermes = readRepoFile('agents/hermes.md');
  const orchestrators = [
    ['atlas', readRepoFile('skills/atlas/reference.md')],
    ['athena', readRepoFile('skills/athena/SKILL.md')],
  ];

  it('defines one strict AO_SPEC_V1 envelope', () => {
    assert.match(hermes, /OUTPUT_CONTRACT: AO_SPEC_V1/);
    assert.match(hermes, /"verdict": "CREATE"/);
    assert.doesNotMatch(hermes, /"verdict": "CREATE \| PASS \| UPDATE \| RECREATE"/,
      'the copyable JSON example must contain one production-valid verdict');
    assert.match(hermes, /PASS[^\n]*specMarkdown[^\n]*prd[^\n]*null/);
    for (const field of ['mode', 'scale', 'goals', 'nonGoals', 'constraints', 'risks', 'openQuestions']) {
      assert.match(hermes, new RegExp(`"${field}"`));
    }
    assert.match(hermes, /uppercase `GIVEN \.\.\. WHEN \.\.\. THEN \.\.\.`/);
    assert.match(hermes, /passes: false/);
  });

  for (const [name, skill] of orchestrators) {
    it(`${name} validates and separately persists Hermes artifacts`, () => {
      assert.ok((skill.match(/OUTPUT_CONTRACT: AO_SPEC_V1/g) || []).length >= 3);
      assert.match(skill, /writeHermesSpecArtifacts\(hermes_output\)/);
      assert.match(skill, /PASS cannot create the missing specification/);
      assert.doesNotMatch(skill, /Write Hermes output to `\.ao\/spec\.md` and `\.ao\/prd\.json`/);
      assert.doesNotMatch(skill, /overwrite `\.ao\/prd\.json` and `\.ao\/spec\.md` with Hermes output/);
      assert.match(skill, /legacy \/plan shape requires UPDATE/);
      assert.match(skill, /never PASS after artifact validation failure/);
    });
  }

  it('/plan emits the AO_SPEC_V1 common PRD fields consumed by validation', () => {
    const plan = readRepoFile('skills/plan/SKILL.md');
    for (const field of ['mode', 'scale', 'goals', 'nonGoals', 'constraints', 'risks', 'openQuestions']) {
      assert.match(plan, new RegExp(`"${field}"`));
    }
    assert.match(plan, /"passes": false/);
    assert.match(plan, /AO_SPEC_V1 common field/);
  });
});

describe('typed review-gate integration', () => {
  const atlasRuntime = readRepoFile('scripts/orchestrator-runtime.mjs');
  const atlasEvidence = readRepoFile('scripts/lib/orchestrator-review-evidence.mjs');
  const orchestrators = [
    ['atlas', readRepoFile('skills/atlas/reference.md')],
    ['athena', readRepoFile('skills/athena/SKILL.md')],
  ];

  for (const [name, skill] of orchestrators) {
    it(`${name} prepares evidence and fails closed through AO_REVIEW_V1`, () => {
      assert.match(skill, /buildReviewPackage\(\{ cwd, baseRef: pinnedReviewBaseCommit \}\)/);
      assert.doesNotMatch(skill, /buildReviewPackage\(\{ cwd \}\)/);
      assert.match(skill, /attachReviewContext\(gitEvidence/);
      assert.match(skill, /const rawReviewerOutputsByName = new Map\(\)/);
      assert.match(skill, /OUTPUT_CONTRACT: AO_REVIEW_V1/);
      assert.match(skill, /aggregateReviewResults\(rawReviewerOutputsByName/);
      assert.match(skill, /allowedReviewers: r\.allowedReviewers/);
      assert.match(skill, /reviewPackage,/);
      assert.match(skill, /aggregate\.verdict === 'BLOCKED'/);
      assert.match(skill, /routed\.escalated/);
      assert.match(skill, /routed\.rejected \|\| routed\.warning/);
      assert.match(skill, /rawReviewerOutputsByName under its bare name/);
      assert.match(skill, /currentReviewers\.length > r\.allowedReviewers\.length/);
      assert.match(skill, /const handledEscalations = new Set\(\)/);
      assert.match(skill, /requestersToRerun\.add\(requestingResult\.reviewer\)/);
      assert.match(skill, /Replace that requester's prior raw output/);
      assert.match(skill, /repeated an already-fulfilled escalation/);
      assert.match(skill, /reviewTreeOid: verificationGitEvidence\.reviewTreeOid/);
      assert.match(skill, /verification evidence was not persisted/);
      assert.match(skill, /latest record for every story/);
      assert.doesNotMatch(skill, /git diff --name-only \$\{range\}/);

      if (name === 'atlas') {
        assert.match(skill, /AO-CONTRACT:verification-evidence/);
        assert.match(skill, /runtime `verification-start`/);
        assert.match(skill, /runtime owns `reviewTreeOid`, generation ID,/);
        assert.match(atlasRuntime, /startBoundVerification\(runId, phase/);
        assert.match(atlasRuntime, /recordBoundVerification\(runId, generationId, record/);
        assert.match(atlasRuntime, /approveBoundReview\(runId, phase, generationId, payload/);
        assert.match(atlasEvidence, /assertReviewPackageCurrent\(gitEvidence, \{ cwd \}\)/);
        assert.match(atlasEvidence, /addVerification\(runId, \{/);
        assert.match(atlasEvidence, /assertReviewPackageCurrent\(persisted\.reviewPackage/);
      } else {
        const storyPackage = skill.indexOf(
          'const verificationGitEvidence = buildReviewPackage({ cwd, baseRef: pinnedReviewBaseCommit });',
        );
        const storyChecks = skill.indexOf(
          'criteria checks and read-only validator now, against this snapshot',
          storyPackage,
        );
        const storyPrePersistCurrent = skill.indexOf(
          'assertReviewPackageCurrent(verificationGitEvidence, { cwd });',
          storyChecks,
        );
        const storyWrite = skill.indexOf('const verificationWrite = addVerification(runId', storyPrePersistCurrent);
        const storyPostPersistCurrent = skill.indexOf(
          'assertReviewPackageCurrent(verificationGitEvidence, { cwd });',
          storyPrePersistCurrent + 1,
        );
        assert.ok(storyPackage >= 0 && storyPackage < storyChecks
          && storyChecks < storyPrePersistCurrent && storyPrePersistCurrent < storyWrite
          && storyWrite < storyPostPersistCurrent);
      }
    });
  }
});

describe('post-mutation final review integration', () => {
  const orchestrators = [
    ['atlas', readRepoFile('skills/atlas/reference.md'), 'verify'],
    ['athena', readRepoFile('skills/athena/SKILL.md'), 'integrate'],
  ];

  for (const [name, skill, rewind] of orchestrators) {
    it(`${name} upserts resumable final content and commits only the final reviewed tree`, () => {
      assert.match(skill, /upsertChangelogEntry\('CHANGELOG\.md', entry, \{ runId, cwd \}\)/);
      assert.match(skill, /upsertTechDebtTrackerRow\([\s\S]*?\{ runId, cwd \}/);
      assert.doesNotMatch(skill, /prependToChangelog\('CHANGELOG\.md'/);
      assert.doesNotMatch(skill, /echo "\| \$\(date[\s\S]*?>> docs\/exec-plans\/tech-debt-tracker\.md/);
      assert.match(
        skill,
        name === 'atlas'
          ? /runtimeTick\(runId, 'final-review'\)/
          : /loopTick\(runId, 'final-review'\)/,
      );
      assert.match(skill, /const finalHandledEscalations = new Set\(\)/);
      assert.match(skill, /replace its stale escalating result in finalRawOutputsByName/);
      assert.match(
        skill,
        new RegExp(`reopen: \\['${rewind}'\\],[\\s\\S]*?reason: 'final_review_reject'`),
      );

      const cleanup = skill.indexOf('### Phase 5b — SLOP CLEAN + FINAL CONTENT');
      const finalPackage = skill.indexOf(
        'const finalGitEvidence = buildReviewPackage({ cwd, baseRef: pinnedReviewBaseCommit })',
        cleanup,
      );
      const generationBegin = skill.indexOf(
        'let finalGenerationStart = beginVerificationGeneration(runId',
        finalPackage,
      );
      const generationProgress = skill.indexOf(
        'const finalGenerationProgress = getVerificationGenerationProgress(',
        generationBegin,
      );
      const snapshotCurrent = skill.indexOf(
        'assertReviewPackageCurrent(finalGitEvidence, { cwd });',
        finalPackage,
      );
      const prePersistCurrent = skill.indexOf(
        'assertReviewPackageCurrent(finalGitEvidence, { cwd });',
        generationProgress,
      );
      const finalTreeBinding = skill.indexOf(
        'reviewTreeOid: finalGitEvidence.reviewTreeOid',
        prePersistCurrent,
      );
      const postPersistCurrent = skill.indexOf(
        'assertReviewPackageCurrent(finalGitEvidence, { cwd });',
        finalTreeBinding,
      );
      const generationSeal = skill.indexOf(
        'const finalGenerationSeal = sealVerificationGeneration(runId, finalGenerationId)',
        postPersistCurrent,
      );
      const sealedRead = skill.indexOf(
        'const finalSealedGeneration = getSealedVerificationGeneration(runId, finalGenerationId)',
        generationSeal,
      );
      const current = skill.indexOf('assertReviewPackageCurrent(finalReviewPackage', finalPackage);
      const commit = name === 'atlas'
        ? skill.indexOf('runtimeCompleteFinalize(', current)
        : skill.indexOf('Skill(skill="agent-olympus:git-master")', current);
      const headTree = name === 'atlas'
        ? skill.indexOf('finalizedStatus = runtimeStatus(runId)', commit)
        : skill.indexOf('assertReviewPackageHeadTree(finalReviewPackage', commit);
      assert.ok(cleanup >= 0 && cleanup < finalPackage && finalPackage < snapshotCurrent
        && snapshotCurrent < generationBegin && generationBegin < generationProgress
        && generationProgress < prePersistCurrent && prePersistCurrent < finalTreeBinding
        && finalTreeBinding < postPersistCurrent
        && postPersistCurrent < generationSeal && generationSeal < sealedRead
        && sealedRead < current && current < commit && commit < headTree);
      if (name === 'atlas') {
        assert.doesNotMatch(
          skill.slice(current, skill.indexOf('<!-- AO-PHASE:finalize:end -->', current)),
          /Skill\(skill="agent-olympus:git-master"\)/,
          'Atlas finalization must commit only through the fixed runtime',
        );
      }
      assert.match(skill, /verificationGenerationId: finalGenerationId/);
      assert.match(skill, /verification: finalSealedGeneration\.records/);
      assert.match(skill, /currentReviewTreeOid !== finalGitEvidence\.reviewTreeOid/);
      assert.match(skill, /supersedeGenerationId: finalGenerationStart\.currentGenerationId/);
      assert.doesNotMatch(skill, /freshFinalVerificationRecords/);
      assert.doesNotMatch(skill, /const finalStrict = getRunVerificationsStrict/);
    });
  }
});

describe('immutable review-base integration', () => {
  const atlasEvidence = readRepoFile('scripts/lib/orchestrator-review-evidence.mjs');
  const atlasRuntime = readRepoFile('scripts/orchestrator-runtime.mjs');
  const orchestrators = [
    ['atlas', readRepoFile('skills/atlas/reference.md')],
    ['athena', readRepoFile('skills/athena/SKILL.md')],
  ];

  for (const [name, skill] of orchestrators) {
    it(`${name} resolves once, persists the triage pin, and reuses only its commit`, () => {
      if (name === 'atlas') {
        assert.doesNotMatch(skill, /getPipelineState\(runId\)/);
        assert.match(skill, /bootstrapStatus\s*=\s*runtimeStatus\(runId\)/);
        assert.match(skill, /fixed[\s\S]*?runtime independently re-resolves it and owns the immutable pin write/);
        assert.doesNotMatch(skill, /pinRunReviewBase\(runId/);
        assert.match(atlasRuntime, /function pinTriageReviewBase\([\s\S]*?pinRunReviewBase\(runId/);
        assert.match(atlasRuntime, /review-base-evidence-mismatch/);
      } else {
        assert.match(skill, /const persistedTriageOutputs = getPipelineState\(runId\)\.phases\.triage\?\.outputs/);
        assert.match(skill, /pinRunReviewBase\(runId, resolvedReviewBase\)/);
        assert.match(skill, /pipeline replica disagrees with the immutable review-base pin/);
      }
      assert.match(skill, /const durableReviewBase = getRunReviewBasePin\(runId\)/);
      assert.match(skill, /baseRef: pinnedReviewBase\.baseRefCommit/);
      assert.match(skill, /resumed without a valid immutable review-base pin/);
      assert.match(skill, /reviewBaseRef: pinnedReviewBase\.baseRef/);
      assert.match(skill, /reviewBaseCommit: pinnedReviewBaseCommit/);
      assert.match(skill, /reviewBaseSource: pinnedReviewBase\.source/);
      assert.match(skill, /checkpointData: \{[\s\S]*?reviewBaseCommit: pinnedReviewBaseCommit/);

      const calls = [...skill.matchAll(/buildReviewPackage\(([^\n]*)\)/g)];
      assert.ok(
        calls.length >= (name === 'atlas' ? 3 : 4),
        `${name} should bind every documented review snapshot to the pin`,
      );
      for (const call of calls) {
        assert.match(call[1], /baseRef: pinnedReviewBaseCommit/);
      }
      assert.doesNotMatch(skill, /buildReviewPackage\(\{ cwd \}\)/);
      if (name === 'atlas') {
        assert.match(atlasEvidence, /getRunReviewBasePin\(runId, runOpts\(opts\)\)/);
        assert.match(atlasEvidence, /resolveReviewBase\(\{ cwd, baseRef: pin\.baseRefCommit \}\)/);
        assert.match(atlasEvidence, /buildReviewPackage\(\{ cwd, baseRef: pin\.baseRefCommit \}\)/);
      }
    });
  }
});

describe('execution PRD integration', () => {
  const atlas = readRepoFile('skills/atlas/reference.md');
  const athena = readRepoFile('skills/athena/SKILL.md');

  it('validates Atlas plans before completion and dispatch', () => {
    assert.match(atlas, /readPlanningPrdForExecution\(\{ cwd \}\)/);
    assert.match(atlas, /enrichExecutionPrd\(executionCandidate/);
    assert.match(atlas, /readExecutionPrd\(\{ cwd, orchestrator: 'atlas' \}\)/);
    assert.match(atlas, /setExecutionStoryPasses\(\[story\.id\], true/);
    assert.match(atlas, /assertExecutionPrd\(plannedPrd, \{ orchestrator: 'atlas', allowCompleted: false \}\)/);
    assert.match(atlas, /assertExecutionPrd\(prd, \{ orchestrator: 'atlas', allowCompleted: true \}\)/);
    assert.match(atlas, /buildAtlasStoryDefinitions\(prd, \{ allowCompleted: true \}\)/);
    assert.match(atlas, /subagent_type: story\.subagentType/);
    assert.match(atlas, /captureCurrentReviewTree\(\{ cwd \}\)/);
    assert.match(atlas, /parseNulDelimitedGitPaths\(changedPathBuffer\)/);
    assert.match(atlas, /validateChangedPathsAgainstScope\(changedPaths, story\.scope\)/);
    assert.match(atlas, /beforeTree\.reviewTreeOid, afterTree\.reviewTreeOid/);
    assert.doesNotMatch(atlas, /Promise\.all\(claudeStories/);
    assert.doesNotMatch(atlas, /await Agent\(\{[\s\S]{0,300}?isolation:/);
    assert.match(atlas, /provider-homogeneous/);
    assert.match(atlas, /external Codex or[\s\S]*?must precede every Claude group/);
    assert.match(atlas, /AUTHORIZED SCOPE \(validated; edit nothing else\)/);
    assert.doesNotMatch(atlas, /JSON\.parse\(readFileSync\('\.ao\/prd\.json/);
    assert.doesNotMatch(atlas, /setStoriesPassesFalse/);

    const externalIntegration = atlas.slice(
      atlas.indexOf('Atlas-created external worktrees are execution state'),
      atlas.indexOf('Rules:', atlas.indexOf('Atlas-created external worktrees are execution state')),
    );
    assert.match(externalIntegration, /'--name-only', '-z'/);
    assert.match(externalIntegration, /\{ encoding: null \}/);
    assert.match(externalIntegration, /parseNulDelimitedGitPaths\(changedPathBuffer\)/);
    assert.doesNotMatch(externalIntegration, /\.trim\(\)\.split\('\\n'\)/);
  });

  it('makes Athena scope ownership part of the persisted launch contract', () => {
    assert.match(athena, /"scope": \["api\/users\.mjs", "test\/users\.test\.mjs"\]/);
    assert.match(athena, /readPlanningPrdForExecution\(\{ cwd \}\)/);
    assert.match(athena, /enrichExecutionPrd\(executionCandidate/);
    assert.match(athena, /readExecutionPrd\(\{ cwd, orchestrator: 'athena' \}\)/);
    assert.match(athena, /setExecutionStoryPasses\(\[story\.id\], true/);
    assert.match(athena, /assertExecutionPrd\(plannedExecutionPrd,/);
    assert.match(athena, /assertExecutionPrd\(prd, \{ orchestrator: 'athena', allowCompleted: true \}\)/);
    assert.match(athena, /story\.scope\.map/);
    assert.match(athena, /dependency references\/cycles/);
    assert.match(athena, /wildcard\/unsafe paths/);
    assert.match(athena, /overlapping scopes across every concurrently launched worker/);
    assert.match(athena, /buildAthenaWorkerDefinitions\(prd, \{ allowCompleted: true \}\)/);
    assert.match(athena, /"agentType": "executor"/);
    assert.doesNotMatch(athena, /agent-olympus:<agentType>/);
    assert.doesNotMatch(athena, /JSON\.parse\(readFileSync\('\.ao\/prd\.json/);
  });
});

describe('canonical external validation lifecycle', () => {
  const orchestrators = [
    ['atlas', readRepoFile('skills/atlas/reference.md')],
    ['athena', readRepoFile('skills/athena/SKILL.md')],
  ];

  it('bans raw tmux command construction from every skill', () => {
    const skillsRoot = fileURLToPath(new URL('../../skills', import.meta.url));
    const skillFiles = readdirSync(skillsRoot, { recursive: true })
      .filter(path => String(path).endsWith('SKILL.md'));
    assert.ok(skillFiles.length >= 37);
    for (const path of skillFiles) {
      const source = readFileSync(join(skillsRoot, String(path)), 'utf8');
      assert.doesNotMatch(source, /\bsend-keys\b/, `${path} must use a reviewed helper`);
    }
  });

  for (const [name, skill] of orchestrators) {
    it(`${name} routes cross-validation through adapters and bounded failover`, () => {
      const crossValidation = skill.slice(skill.indexOf('AO-CONTRACT:cross-validation'));
      for (const symbol of [
        'spawnTeam',
        'monitorTeam',
        'collectResults',
        'reassignProvider',
        'dispatchProviderFallback',
        'pollProviderFallback',
        'shutdownTeam',
      ]) {
        assert.match(crossValidation, new RegExp(`\\b${symbol}\\b`));
      }
      assert.match(crossValidation, /preferredValidationProvider/);
      assert.match(crossValidation, /buildCrossValidationTeamName/);
      assert.match(crossValidation, /materializeReviewSnapshot/);
      assert.match(crossValidation, /snapshot: validationSnapshot/);
      assert.match(crossValidation, /assertReviewSnapshotCurrent\(validationSnapshot, \{ cwd \}\)/);
      assert.match(crossValidation, /assertCrossValidationTeamState\(existingValidationState, validationRequest\)/);
      assert.match(crossValidation, /parseCrossValidationResult\([\s\S]*?validationRequest\.identity/);
      assert.match(crossValidation, /cleanupReviewSnapshot/);
      assert.doesNotMatch(crossValidation, /worktreePath: cwd/);
      assert.match(crossValidation, /validator\.fallbackProvider \|\| validator\.type[\s\S]*?validationState\.workers\[0\]\.type/);
      assert.match(crossValidation, /actualProvider === 'codex' \|\| actualProvider === 'gemini'/);
      assert.doesNotMatch(crossValidation, /CODEX_BIN|GEMINI_BIN|\bsend-keys\b/);
    });
  }
});

describe('deterministic Claude execution context', () => {
  const atlas = readRepoFile('skills/atlas/reference.md');
  const athena = readRepoFile('skills/athena/SKILL.md');
  const athenaAgent = readRepoFile('agents/athena.md');

  it('never dispatches an unresolved role placeholder', () => {
    for (const source of [atlas, athena, athenaAgent]) {
      assert.doesNotMatch(source, /agent-olympus:<agentType>/);
    }
    assert.match(atlas, /buildAtlasStoryDefinitions/);
    assert.match(athena, /buildAthenaWorkerDefinitions/);
    assert.match(athenaAgent, /worker\.subagentType/);
  });

  it('sends the bootstrap worker the same validated START context as its peers', () => {
    for (const field of [
      'storyIds',
      'stories',
      'scope',
      'worktreePath',
      'branchName',
      'sharedTaskIds',
      'constraints',
      'baseCommit',
    ]) {
      assert.match(athena, new RegExp(`\\b${field}\\b`));
    }
    assert.match(athena, /buildClaudeWorkerExecutionContext\(worker, nativeTaskIdsByStory\)/);
    assert.ok((athena.match(/claudeWorkers\.length === 0/g) || []).length >= 2);
    assert.match(athena, /initializeAthenaStartLedger\(\{/);
    assert.match(athena, /planAthenaStartResume\(nativeStartLedger, \{ nativeSessionId \}\)/);
    assert.match(athena, /buildAthenaStartMessage\([\s\S]*?claudeExecutionContextByWorker\.get\(workerName\)/);
    assert.match(athena, /acknowledgeAthenaStart\(nativeStartLedger, \{/);
    assert.match(athena, /buildAthenaStartConfirmation\(nativeStartLedger, workerName\)/);
    assert.match(athena, /allAthenaStartsAcknowledged\(nativeStartLedger\)/);
    assert.match(athena, /START\s+before verified ownership is forbidden/);

    const pendingSave = athena.indexOf("const nativeTaskCheckpoint = await saveCheckpoint('athena'");
    const reread = athena.indexOf('const persistedNativeTasks = await loadCheckpoint', pendingSave);
    const contexts = athena.indexOf('claudeExecutionContextByWorker = new Map', reread);
    const remainingLaunch = athena.indexOf('Agent(name="<worker>"', contexts);
    const ownershipProof = athena.indexOf('assignedNativeTasks = TaskList()', remainingLaunch);
    const uniformStart = athena.indexOf('message: buildAthenaStartMessage', ownershipProof);
    const ack = athena.indexOf('acknowledgeAthenaStart(nativeStartLedger', uniformStart);
    const ackSave = athena.indexOf("const ackCheckpoint = await saveCheckpoint('athena'", ack);
    const ackReread = athena.indexOf("nativeStartCheckpoint = await loadCheckpoint('athena')", ackSave);
    const confirmation = athena.indexOf('message: buildAthenaStartConfirmation', ackReread);
    assert.ok(pendingSave >= 0 && pendingSave < reread && reread < contexts
      && contexts < remainingLaunch && remainingLaunch < ownershipProof
      && ownershipProof < uniformStart && uniformStart < ack
      && ack < ackSave && ackSave < ackReread && ackReread < confirmation);
  });
});

describe('public orchestration documentation', () => {
  const english = readRepoFile('README.md');
  const korean = readRepoFile('README.ko.md');
  const agents = readRepoFile('AGENTS.md');

  it('documents the post-mutation final-tree review boundary', () => {
    for (const source of [english, korean, agents]) {
      assert.match(source, /reviewTreeOid|Final Review|Final-tree lock|Final review/);
    }
    assert.match(english, /Re-verify \+ Final Review/);
    assert.match(korean, /Re-verify \+ Final Review/);
  });

  it('documents native bootstrap and provider-specific PRD assignments', () => {
    for (const source of [english, korean]) {
      assert.match(source, /Bootstrap Native Team/);
      assert.match(source, /targetUsers/);
      assert.match(source, /successMetrics/);
      assert.match(source, /assignedWorker/);
      assert.match(source, /workerType/);
    }
    assert.doesNotMatch(readRepoFile('.claude-plugin/marketplace.json'), /peer-to-peer/);
  });

  it('lists all 37 skills in both detailed README tables', () => {
    const countRows = (source, start, end) => source
      .slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))
      .split('\n')
      .filter(line => /^\| \*\*/.test(line)).length;
    assert.equal(countRows(english, '## Skills (37 Total)', '## Architecture'), 37);
    assert.equal(countRows(korean, '## 스킬 (37개)', '## 아키텍처'), 37);
    for (const skill of ['codex-goal', 'codex-review']) {
      assert.match(english, new RegExp(`\\*\\*${skill}\\*\\*`));
      assert.match(korean, new RegExp(`\\*\\*${skill}\\*\\*`));
    }
  });
});
