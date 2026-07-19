import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  approveBoundReview,
  loadBoundApproval,
  recordBoundVerification,
  sealBoundVerification,
  startBoundVerification,
  validateFinalizePhaseCompletion,
  validateReviewPhaseCompletion,
} from '../lib/orchestrator-review-evidence.mjs';
import {
  createRun,
  pinRunReviewBase,
} from '../lib/run-artifacts.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function executionPrd() {
  return {
    projectName: 'atlas-review-evidence',
    mode: 'engineering-change',
    scale: 'S',
    goals: ['Bind approval to verified Git evidence.'],
    nonGoals: ['Change worker routing.'],
    constraints: ['Use zero runtime dependencies.'],
    risks: ['Stale evidence could authorize an unreviewed tree.'],
    openQuestions: [],
    userStories: [{
      id: 'US-001',
      title: 'Persist review evidence',
      acceptanceCriteria: [
        'GIVEN a changed tree WHEN review completes THEN the exact verified tree is approved',
      ],
      passes: true,
      parallelGroup: 'claude',
      scope: ['src/value.mjs'],
      assignTo: 'claude',
      model: 'sonnet',
      agentType: 'executor',
    }],
  };
}

function verificationRecord(overrides = {}) {
  return verificationRecordFor(executionPrd().userStories[0], overrides);
}

function verificationRecordFor(story, overrides = {}) {
  const criterion = story.acceptanceCriteria[0];
  return {
    story_id: story.id,
    verdict: 'pass',
    evidence: 'node:test passed for the changed value module',
    verifiedBy: 'themis',
    criteria: [{
      criterion_index: 0,
      criterion_text: criterion,
      verdict: 'pass',
      evidence: 'focused test: 1 passing, 0 failing',
    }],
    ...overrides,
  };
}

function multiStoryExecutionPrd() {
  const prd = executionPrd();
  prd.userStories[0].scope = ['src'];
  prd.userStories.push({
    id: 'US-002',
    title: 'Persist review documentation',
    acceptanceCriteria: [
      'GIVEN a changed tree WHEN review completes THEN its documentation is approved',
    ],
    passes: true,
    parallelGroup: 'documentation',
    scope: ['docs'],
    assignTo: 'claude',
    model: 'haiku',
    agentType: 'writer',
  });
  return prd;
}

function approvalPayload(sealed, overrides = {}) {
  return Object.fromEntries(sealed.reviewers.map(reviewer => [reviewer, {
    schemaVersion: 1,
    reviewer,
    reviewDigest: sealed.reviewDigest,
    verdict: 'APPROVE',
    findings: [],
    escalations: [],
    ...overrides[reviewer],
  }]));
}

function setup({ prd = executionPrd(), ignoreAo = true } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'ao-orchestrator-review-evidence-'));
  chmodSync(cwd, 0o700);
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.email', 'review-evidence@example.invalid']);
  git(cwd, ['config', 'user.name', 'Review Evidence Test']);
  git(cwd, ['checkout', '-q', '-b', 'main']);
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(join(cwd, 'config'), { recursive: true });
  writeFileSync(join(cwd, '.gitignore'), ignoreAo ? '.ao/\n' : '# AO runtime is not ignored\n');
  writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1;\n');
  writeFileSync(
    join(cwd, 'config', 'review-routing.jsonc'),
    readFileSync(join(ROOT, 'config', 'review-routing.jsonc'), 'utf8'),
  );
  git(cwd, ['add', '--', '.gitignore', 'src/value.mjs', 'config/review-routing.jsonc']);
  git(cwd, ['commit', '-q', '-m', 'base']);
  const baseCommit = git(cwd, ['rev-parse', 'HEAD']);

  writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 2;\n');
  const base = join(cwd, '.ao', 'artifacts', 'runs');
  const created = createRun('atlas', 'review evidence fixture', {
    base,
    trustedRoot: cwd,
    activate: false,
  });
  assert.equal(created.ok, true, created.reason);
  const aoDir = join(cwd, '.ao');
  chmodSync(aoDir, 0o700);
  writeFileSync(join(aoDir, 'prd.json'), `${JSON.stringify(prd, null, 2)}\n`, {
    mode: 0o600,
  });
  const pinned = pinRunReviewBase(created.runId, {
    baseRef: 'main',
    baseRefCommit: baseCommit,
    source: 'explicit',
  }, { base, trustedRoot: cwd });
  assert.equal(pinned.ok, true, pinned.reason);
  return {
    cwd,
    base,
    runId: created.runId,
    runDir: created.runDir,
    opts: { cwd, base, trustedRoot: cwd },
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

function verified(context, phase = 'review') {
  const started = startBoundVerification(context.runId, phase, context.opts);
  assert.equal(started.ok, true);
  const recorded = recordBoundVerification(
    context.runId,
    started.generationId,
    verificationRecord(),
    context.opts,
  );
  assert.equal(recorded.ok, true);
  assert.deepEqual(recorded.missingStoryIds, []);
  const sealed = sealBoundVerification(
    context.runId,
    phase,
    started.generationId,
    context.opts,
  );
  return { started, sealed };
}

function approvalLeaf(phase, digest) {
  return `review-approval-${phase}-${digest}.json`;
}

describe('code-owned Atlas review evidence', () => {
  it('rejects skipped stories and skipped acceptance criteria as completion evidence', () => {
    const allSkipped = setup();
    try {
      const started = startBoundVerification(allSkipped.runId, 'review', allSkipped.opts);
      assert.throws(
        () => recordBoundVerification(
          allSkipped.runId,
          started.generationId,
          verificationRecord({
            verdict: 'skip',
            evidence: 'asserted unavailable without executing the check',
            criteria: [{
              criterion_index: 0,
              criterion_text: executionPrd().userStories[0].acceptanceCriteria[0],
              verdict: 'skip',
              evidence: 'asserted unavailable without executing the check',
            }],
          }),
          allSkipped.opts,
        ),
        /skip cannot authorize completion/i,
      );
    } finally {
      allSkipped.cleanup();
    }

    const criterionSkipped = setup();
    try {
      const started = startBoundVerification(
        criterionSkipped.runId,
        'review',
        criterionSkipped.opts,
      );
      assert.throws(
        () => recordBoundVerification(
          criterionSkipped.runId,
          started.generationId,
          verificationRecord({
            verdict: 'pass',
            criteria: [{
              criterion_index: 0,
              criterion_text: executionPrd().userStories[0].acceptanceCriteria[0],
              verdict: 'skip',
              evidence: 'manual review was deferred',
            }],
          }),
          criterionSkipped.opts,
        ),
        /skip cannot authorize completion|criterion is malformed/i,
      );
    } finally {
      criterionSkipped.cleanup();
    }
  });

  it('rejects review and final-review trees containing paths outside every PRD story scope', () => {
    for (const phase of ['review', 'final-review']) {
      const context = setup();
      try {
        writeFileSync(join(context.cwd, 'outside-scope.txt'), 'not authorized by the PRD\n');
        assert.throws(
          () => startBoundVerification(context.runId, phase, context.opts),
          /exceeds authoritative execution PRD scope.*outside-scope\.txt/i,
        );
      } finally {
        context.cleanup();
      }
    }
  });

  it('accepts a collective tree covered by the union of all PRD story scopes', () => {
    for (const phase of ['review', 'final-review']) {
      const prd = multiStoryExecutionPrd();
      const context = setup({ prd });
      try {
        mkdirSync(join(context.cwd, 'docs'));
        writeFileSync(join(context.cwd, 'docs', 'review.md'), '# Reviewed behavior\n');
        const started = startBoundVerification(context.runId, phase, context.opts);
        for (const story of prd.userStories) {
          const recorded = recordBoundVerification(
            context.runId,
            started.generationId,
            verificationRecordFor(story),
            context.opts,
          );
          assert.equal(recorded.ok, true);
        }
        const sealed = sealBoundVerification(
          context.runId,
          phase,
          started.generationId,
          context.opts,
        );
        const approved = approveBoundReview(
          context.runId,
          phase,
          started.generationId,
          approvalPayload(sealed),
          context.opts,
        );
        assert.equal(approved.ok, true);
        assert.deepEqual(
          approved.reviewTreeOid,
          loadBoundApproval(
            context.runId,
            phase,
            sealed.reviewDigest,
            context.opts,
          ).reviewPackage.reviewTreeOid,
        );
      } finally {
        context.cleanup();
      }
    }
  });

  it('rejects a caller-invented approval digest', () => {
    const context = setup();
    try {
      assert.throws(
        () => validateReviewPhaseCompletion(context.runId, 'a'.repeat(64), context.opts),
        /approval artifact.*missing/i,
      );
    } finally {
      context.cleanup();
    }
  });

  it('requires a result from every initially routed reviewer', () => {
    const context = setup();
    try {
      const { started, sealed } = verified(context);
      const payload = approvalPayload(sealed);
      delete payload[sealed.reviewers[0]];
      assert.throws(
        () => approveBoundReview(
          context.runId,
          'review',
          started.generationId,
          payload,
          context.opts,
        ),
        /missing routed reviewers/i,
      );
    } finally {
      context.cleanup();
    }
  });

  it('rejects a verification generation after the reviewed tree changes', () => {
    const context = setup();
    try {
      const { started, sealed } = verified(context);
      writeFileSync(join(context.cwd, 'src', 'value.mjs'), 'export const value = 3;\n');
      assert.throws(
        () => approveBoundReview(
          context.runId,
          'review',
          started.generationId,
          approvalPayload(sealed),
          context.opts,
        ),
        /generation identity|tree|stale/i,
      );
    } finally {
      context.cleanup();
    }
  });

  it('rejects same-story verification after any authoritative PRD generation change', () => {
    const context = setup();
    try {
      const started = startBoundVerification(context.runId, 'review', context.opts);
      recordBoundVerification(
        context.runId,
        started.generationId,
        verificationRecord(),
        context.opts,
      );
      const prdPath = join(context.cwd, '.ao', 'prd.json');
      const changedPrd = JSON.parse(readFileSync(prdPath, 'utf8'));
      changedPrd.userStories[0].title = 'Changed after verification started';
      writeFileSync(prdPath, `${JSON.stringify(changedPrd, null, 2)}\n`, { mode: 0o600 });
      assert.throws(
        () => sealBoundVerification(
          context.runId,
          'review',
          started.generationId,
          context.opts,
        ),
        /verification binding identity/i,
      );
    } finally {
      context.cleanup();
    }
  });

  it('rejects routing-state changes between sealing and approval', () => {
    const context = setup();
    try {
      const { started, sealed } = verified(context);
      writeFileSync(
        join(context.cwd, '.ao', 'autonomy.json'),
        `${JSON.stringify({ reviewRouter: { disabled: true } }, null, 2)}\n`,
        { mode: 0o600 },
      );
      assert.throws(
        () => approveBoundReview(
          context.runId,
          'review',
          started.generationId,
          approvalPayload(sealed),
          context.opts,
        ),
        /routing state changed/i,
      );
    } finally {
      context.cleanup();
    }
  });

  it('persists and reloads one immutable valid review approval', () => {
    const context = setup();
    try {
      const { started, sealed } = verified(context);
      const first = approveBoundReview(
        context.runId,
        'review',
        started.generationId,
        approvalPayload(sealed),
        context.opts,
      );
      assert.equal(first.ok, true);
      assert.equal(first.created, true);
      const retry = approveBoundReview(
        context.runId,
        'review',
        started.generationId,
        approvalPayload(sealed),
        context.opts,
      );
      assert.equal(retry.created, false);

      const artifact = loadBoundApproval(
        context.runId,
        'review',
        sealed.reviewDigest,
        context.opts,
      );
      assert.equal(artifact.reviewPackage.reviewDigest.value, sealed.reviewDigest);
      assert.deepEqual(
        validateReviewPhaseCompletion(context.runId, sealed.reviewDigest, context.opts),
        {
          approvedReviewDigest: sealed.reviewDigest,
          approvedReviewTreeOid: sealed.reviewTreeOid,
        },
      );
    } finally {
      context.cleanup();
    }
  });

  it('floors immutable review timestamps when the wall clock moves backward', () => {
    const context = setup();
    const originalNow = Date.now;
    let clock = originalNow();
    Date.now = () => clock;
    try {
      const started = startBoundVerification(context.runId, 'review', context.opts);
      const bindingPath = join(
        context.runDir,
        `review-verification-review-${started.generationId}.json`,
      );
      const binding = JSON.parse(readFileSync(bindingPath, 'utf8'));
      const startedAt = Date.parse(
        JSON.parse(readFileSync(join(context.runDir, 'verification-generation.json'), 'utf8'))
          .startedAt,
      );
      assert.ok(Date.parse(binding.boundAt) >= startedAt);

      clock = Date.parse(binding.boundAt) - 1;
      recordBoundVerification(
        context.runId,
        started.generationId,
        verificationRecord(),
        context.opts,
      );
      const record = JSON.parse(
        readFileSync(join(context.runDir, 'verification.jsonl'), 'utf8').trim(),
      );
      assert.ok(Date.parse(record.timestamp) >= Date.parse(binding.boundAt));

      clock = Date.parse(record.timestamp) - 1;
      const sealed = sealBoundVerification(
        context.runId,
        'review',
        started.generationId,
        context.opts,
      );
      const generation = JSON.parse(
        readFileSync(join(context.runDir, 'verification-generation.json'), 'utf8'),
      );
      assert.ok(Date.parse(generation.sealedAt) >= Date.parse(record.timestamp));

      clock = Date.parse(generation.sealedAt) - 1;
      approveBoundReview(
        context.runId,
        'review',
        started.generationId,
        approvalPayload(sealed),
        context.opts,
      );
      const approval = JSON.parse(readFileSync(
        join(context.runDir, approvalLeaf('review', sealed.reviewDigest)),
        'utf8',
      ));
      assert.ok(Date.parse(approval.approvedAt) >= Date.parse(generation.sealedAt));
      assert.ok(Date.parse(approval.approvedAt) >= Date.parse(binding.boundAt));
      assert.doesNotThrow(() => loadBoundApproval(
        context.runId,
        'review',
        sealed.reviewDigest,
        context.opts,
      ));
    } finally {
      Date.now = originalNow;
      context.cleanup();
    }
  });

  it('derives the real final commit only after the approved tree is committed cleanly', () => {
    const context = setup();
    try {
      const { started, sealed } = verified(context, 'final-review');
      approveBoundReview(
        context.runId,
        'final-review',
        started.generationId,
        approvalPayload(sealed),
        context.opts,
      );
      const final = validateFinalizePhaseCompletion(
        context.runId,
        sealed.reviewDigest,
        context.opts,
      );
      const approval = loadBoundApproval(
        context.runId,
        'final-review',
        sealed.reviewDigest,
        context.opts,
      );
      const binding = JSON.parse(readFileSync(join(
        context.runDir,
        `review-verification-final-review-${started.generationId}.json`,
      ), 'utf8'));
      assert.equal(final.finalReviewDigest, sealed.reviewDigest);
      assert.equal(final.finalReviewTreeOid, sealed.reviewTreeOid);
      assert.equal(final.finalCommit, git(context.cwd, ['rev-parse', 'HEAD']));
      assert.equal(final.finalCommit, approval.reviewPackage.finalCommitProposal.objectId);
      assert.deepEqual(
        binding.finalCommitProposal,
        approval.reviewPackage.finalCommitProposal,
      );
      assert.deepEqual(
        validateFinalizePhaseCompletion(context.runId, sealed.reviewDigest, context.opts),
        final,
      );
    } finally {
      context.cleanup();
    }
  });

  it('does not let untracked AO runtime state self-invalidate finalization', () => {
    const context = setup({ ignoreAo: false });
    try {
      const { started, sealed } = verified(context, 'final-review');
      approveBoundReview(
        context.runId,
        'final-review',
        started.generationId,
        approvalPayload(sealed),
        context.opts,
      );
      writeFileSync(join(context.runDir, 'runtime-heartbeat.json'), '{"alive":true}\n', {
        mode: 0o600,
      });
      const final = validateFinalizePhaseCompletion(
        context.runId,
        sealed.reviewDigest,
        context.opts,
      );
      assert.equal(final.finalCommit, git(context.cwd, ['rev-parse', 'HEAD']));
    } finally {
      context.cleanup();
    }
  });

  it('rejects an untracked mutation introduced after the approved commit', () => {
    const context = setup();
    try {
      const { started, sealed } = verified(context, 'final-review');
      approveBoundReview(
        context.runId,
        'final-review',
        started.generationId,
        approvalPayload(sealed),
        context.opts,
      );
      validateFinalizePhaseCompletion(
        context.runId,
        sealed.reviewDigest,
        context.opts,
      );
      writeFileSync(join(context.cwd, 'not-reviewed.txt'), 'dirty\n');
      assert.throws(
        () => validateFinalizePhaseCompletion(
          context.runId,
          sealed.reviewDigest,
          context.opts,
        ),
        /dirty|worktree changed|no longer matches/i,
      );
    } finally {
      context.cleanup();
    }
  });

  it('fails closed on a symlink or permissive approval artifact leaf', () => {
    const symlinkContext = setup();
    try {
      const { started, sealed } = verified(symlinkContext);
      const external = join(symlinkContext.runDir, 'external-approval.json');
      writeFileSync(external, '{}\n', { mode: 0o600 });
      symlinkSync(
        external,
        join(symlinkContext.runDir, approvalLeaf('review', sealed.reviewDigest)),
      );
      assert.throws(
        () => approveBoundReview(
          symlinkContext.runId,
          'review',
          started.generationId,
          approvalPayload(sealed),
          symlinkContext.opts,
        ),
        /regular file|symbolic|artifact/i,
      );
    } finally {
      symlinkContext.cleanup();
    }

    if (process.platform === 'win32') return;
    const modeContext = setup();
    try {
      const { started, sealed } = verified(modeContext);
      approveBoundReview(
        modeContext.runId,
        'review',
        started.generationId,
        approvalPayload(sealed),
        modeContext.opts,
      );
      const artifactPath = join(
        modeContext.runDir,
        approvalLeaf('review', sealed.reviewDigest),
      );
      chmodSync(artifactPath, 0o644);
      assert.throws(
        () => loadBoundApproval(
          modeContext.runId,
          'review',
          sealed.reviewDigest,
          modeContext.opts,
        ),
        /mode|private|artifact/i,
      );
    } finally {
      modeContext.cleanup();
    }
  });
});
