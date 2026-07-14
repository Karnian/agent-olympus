import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  assertCompleteReviewPackageIntegrity,
  assertCurrentReviewTree,
  assertReviewPackageCurrent,
  assertReviewPackageHeadTree,
  assertReviewPackageIntegrity,
  attachReviewContext,
  buildReviewPackage,
  captureCurrentReviewTree,
  computeReviewPackageDigest,
  ReviewPackageError,
  resolveReviewBase,
} from '../lib/review-package.mjs';
import { routeReviewers } from '../lib/review-router.mjs';

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');

const tempRepos = new Set();

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function initRepository() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-review-package-test-'));
  tempRepos.add(cwd);
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.email', 'review-package@example.invalid']);
  git(cwd, ['config', 'user.name', 'Review Package Test']);
  git(cwd, ['checkout', '-q', '-b', 'main']);
  await fs.writeFile(path.join(cwd, 'tracked-staged.txt'), 'base staged\n');
  await fs.writeFile(path.join(cwd, 'tracked-unstaged.txt'), 'base unstaged\n');
  git(cwd, ['add', '--', 'tracked-staged.txt', 'tracked-unstaged.txt']);
  git(cwd, ['commit', '-q', '-m', 'base']);
  return cwd;
}

function prdStory(overrides = {}) {
  return {
    id: 'US-001',
    passes: true,
    acceptanceCriteria: ['Tests complete successfully'],
    ...overrides,
  };
}

function verificationRecord(reviewTreeOid, overrides = {}) {
  return {
    story_id: 'US-001',
    verdict: 'pass',
    evidence: 'npm test passed',
    verifiedBy: 'themis',
    reviewTreeOid,
    criteria: [{
      criterion_index: 0,
      criterion_text: 'Tests complete successfully',
      verdict: 'pass',
      evidence: 'npm test: 12/12 passing',
    }],
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all([...tempRepos].map((cwd) => fs.rm(cwd, { recursive: true, force: true })));
  tempRepos.clear();
});

describe('buildReviewPackage integration', () => {
  it('captures clean or dirty current trees for sequential scope guards', async () => {
    const cwd = await initRepository();
    const clean = captureCurrentReviewTree({ cwd });
    assert.equal(clean.reviewTreeOid, git(cwd, ['rev-parse', 'HEAD^{tree}']));
    assert.equal(assertCurrentReviewTree(clean, { cwd }), true);

    await fs.writeFile(path.join(cwd, 'tracked-staged.txt'), 'worker change\n');
    const dirty = captureCurrentReviewTree({ cwd });
    assert.notEqual(dirty.reviewTreeOid, clean.reviewTreeOid);
    assert.equal(assertCurrentReviewTree(dirty, { cwd }), true);
    assert.throws(
      () => assertCurrentReviewTree(clean, { cwd }),
      (error) => error instanceof ReviewPackageError && error.code === 'WORKTREE_CHANGED',
    );
  });
  it('binds committed, staged, unstaged, and untracked changes into one package', async () => {
    const cwd = await initRepository();
    git(cwd, ['checkout', '-q', '-b', 'feature/review-evidence']);

    await fs.writeFile(path.join(cwd, 'committed.txt'), 'committed branch change\n');
    git(cwd, ['add', '--', 'committed.txt']);
    git(cwd, ['commit', '-q', '-m', 'feature commit']);

    await fs.writeFile(path.join(cwd, 'staged-new.txt'), 'staged content\n');
    git(cwd, ['add', '--', 'staged-new.txt']);
    await fs.writeFile(path.join(cwd, 'tracked-unstaged.txt'), 'unstaged content\n');
    await fs.writeFile(path.join(cwd, 'untracked file.txt'), 'untracked content\n');

    const realIndexTreeBefore = git(cwd, ['write-tree']);
    const reviewPackage = buildReviewPackage({ cwd, baseRef: 'main' });
    assert.equal(git(cwd, ['write-tree']), realIndexTreeBefore,
      'building reviewTreeOid must not modify the real index');

    assert.deepEqual(reviewPackage.diffPaths, [
      'committed.txt',
      'staged-new.txt',
      'tracked-unstaged.txt',
      'untracked file.txt',
    ]);
    assert.deepEqual(reviewPackage.untrackedPaths, ['untracked file.txt']);
    assert.match(reviewPackage.patches.baseToHead, /committed\.txt/);
    assert.match(reviewPackage.patches.baseToHead, /committed branch change/);
    assert.match(reviewPackage.patches.staged, /staged-new\.txt/);
    assert.match(reviewPackage.patches.staged, /staged content/);
    assert.match(reviewPackage.patches.unstaged, /tracked-unstaged\.txt/);
    assert.match(reviewPackage.patches.unstaged, /unstaged content/);
    assert.match(reviewPackage.patches.headToWorktree, /staged-new\.txt/);
    assert.match(reviewPackage.patches.headToWorktree, /tracked-unstaged\.txt/);
    assert.match(reviewPackage.patches.headToWorktree, /untracked file\.txt/);
    assert.match(reviewPackage.diff, /committed branch change/);
    assert.match(reviewPackage.diff, /staged content/);
    assert.match(reviewPackage.diff, /unstaged content/);
    assert.match(reviewPackage.diff, /untracked content/);
    assert.equal(reviewPackage.evidenceDigest.algorithm, 'sha256');
    assert.match(reviewPackage.reviewTreeOid, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
    assert.equal(reviewPackage.evidenceDigest.value, computeReviewPackageDigest(reviewPackage));
    assert.equal(assertReviewPackageIntegrity(reviewPackage), true);
    assert.equal(Object.isFrozen(reviewPackage), true);
    assert.equal(Object.isFrozen(reviewPackage.patches), true);
  });

  it('fails closed when the merge-base through worktree diff is empty', async () => {
    const cwd = await initRepository();
    assert.throws(
      () => buildReviewPackage({ cwd, baseRef: 'main' }),
      (error) => error instanceof ReviewPackageError && error.code === 'EMPTY_DIFF',
    );
  });

  it('represents an empty untracked file as reviewable evidence', async () => {
    const cwd = await initRepository();
    await fs.writeFile(path.join(cwd, 'empty-untracked.txt'), '');
    const reviewPackage = buildReviewPackage({ cwd, baseRef: 'main' });
    assert.deepEqual(reviewPackage.diffPaths, ['empty-untracked.txt']);
    assert.deepEqual(reviewPackage.untrackedPaths, ['empty-untracked.txt']);
    assert.match(reviewPackage.patches.headToWorktree, /new file mode/);
    assert.equal(assertReviewPackageIntegrity(reviewPackage), true);
  });

  it('retains an index-only staged add deleted from the worktree in routing evidence', async () => {
    const cwd = await initRepository();
    await fs.writeFile(path.join(cwd, 'staged-secret.txt'), 'client_secret=index-only-value\n');
    git(cwd, ['add', '--', 'staged-secret.txt']);
    await fs.unlink(path.join(cwd, 'staged-secret.txt'));
    await fs.writeFile(path.join(cwd, 'innocent.txt'), 'ordinary untracked content\n');

    const reviewPackage = buildReviewPackage({ cwd, baseRef: 'main' });
    assert.deepEqual(reviewPackage.diffPaths, ['innocent.txt', 'staged-secret.txt']);
    assert.match(reviewPackage.patches.staged, /client_secret=index-only-value/);
    assert.match(reviewPackage.diff, /client_secret=index-only-value/);

    const routed = routeReviewers({
      diffPaths: reviewPackage.diffPaths,
      diffContent: reviewPackage.diff,
      baseDir: REPO_ROOT,
    });
    assert.equal(routed.securityHit, true);
    assert.ok(routed.reviewers.includes('security-reviewer'));
  });

  it('detects evidence tampering after serialization', async () => {
    const cwd = await initRepository();
    await fs.writeFile(path.join(cwd, 'untracked.txt'), 'original evidence\n');
    const reviewPackage = buildReviewPackage({ cwd, baseRef: 'main' });
    const copy = JSON.parse(JSON.stringify(reviewPackage));
    copy.patches.headToWorktree = copy.patches.headToWorktree.replace('original', 'tampered');
    copy.diff = copy.diff.replace('original', 'tampered');
    assert.throws(
      () => assertReviewPackageIntegrity(copy),
      (error) => error instanceof ReviewPackageError && error.code === 'DIGEST_MISMATCH',
    );
  });

  it('proves a complete review package is current and rejects post-review worktree changes', async () => {
    const cwd = await initRepository();
    await fs.writeFile(path.join(cwd, 'untracked.txt'), 'reviewed content\n');
    const gitEvidence = buildReviewPackage({ cwd, baseRef: 'main' });
    const reviewPackage = attachReviewContext(
      gitEvidence,
      {
        prd: { userStories: [prdStory()] },
        verification: [verificationRecord(gitEvidence.reviewTreeOid)],
      },
    );
    assert.equal(assertReviewPackageCurrent(reviewPackage, { cwd }), true);

    const tamperedContext = JSON.parse(JSON.stringify(reviewPackage));
    tamperedContext.prd.auditNote = 'context replaced after review';
    assert.throws(
      () => assertReviewPackageCurrent(tamperedContext, { cwd }),
      (error) => error instanceof ReviewPackageError && error.code === 'DIGEST_MISMATCH',
    );

    await fs.writeFile(path.join(cwd, 'untracked.txt'), 'changed after review\n');
    assert.throws(
      () => assertReviewPackageCurrent(reviewPackage, { cwd }),
      (error) => error instanceof ReviewPackageError && error.code === 'STALE_EVIDENCE',
    );
  });

  it('rejects index, HEAD, and base-ref changes made after review evidence was built', async () => {
    const stagedCwd = await initRepository();
    await fs.writeFile(path.join(stagedCwd, 'staged.txt'), 'reviewed index content\n');
    git(stagedCwd, ['add', '--', 'staged.txt']);
    const stagedPackage = buildReviewPackage({ cwd: stagedCwd, baseRef: 'main' });
    await fs.writeFile(path.join(stagedCwd, 'staged.txt'), 'changed index content\n');
    git(stagedCwd, ['add', '--', 'staged.txt']);
    assert.throws(
      () => assertReviewPackageCurrent(stagedPackage, { cwd: stagedCwd }),
      (error) => error instanceof ReviewPackageError && error.code === 'STALE_EVIDENCE',
    );

    const headCwd = await initRepository();
    git(headCwd, ['checkout', '-q', '-b', 'feature/head-change']);
    await fs.writeFile(path.join(headCwd, 'feature.txt'), 'reviewed commit\n');
    git(headCwd, ['add', '--', 'feature.txt']);
    git(headCwd, ['commit', '-q', '-m', 'reviewed feature']);
    const headPackage = buildReviewPackage({ cwd: headCwd, baseRef: 'main' });
    await fs.writeFile(path.join(headCwd, 'after-review.txt'), 'late commit\n');
    git(headCwd, ['add', '--', 'after-review.txt']);
    git(headCwd, ['commit', '-q', '-m', 'change after review']);
    assert.throws(
      () => assertReviewPackageCurrent(headPackage, { cwd: headCwd }),
      (error) => error instanceof ReviewPackageError && error.code === 'STALE_EVIDENCE',
    );

    const baseCwd = await initRepository();
    git(baseCwd, ['checkout', '-q', '-b', 'feature/base-change']);
    await fs.writeFile(path.join(baseCwd, 'feature.txt'), 'feature content\n');
    git(baseCwd, ['add', '--', 'feature.txt']);
    git(baseCwd, ['commit', '-q', '-m', 'feature']);
    const basePackage = buildReviewPackage({ cwd: baseCwd, baseRef: 'main' });
    git(baseCwd, ['checkout', '-q', 'main']);
    git(baseCwd, ['commit', '-q', '--allow-empty', '-m', 'move review base']);
    git(baseCwd, ['checkout', '-q', 'feature/base-change']);
    assert.throws(
      () => assertReviewPackageCurrent(basePackage, { cwd: baseCwd }),
      (error) => error instanceof ReviewPackageError && error.code === 'STALE_EVIDENCE',
    );
  });

  it('binds the reviewed filesystem tree to the final HEAD tree', async () => {
    const approvedCwd = await initRepository();
    await fs.writeFile(path.join(approvedCwd, 'approved.txt'), 'approved content\n');
    const approvedPackage = buildReviewPackage({ cwd: approvedCwd, baseRef: 'main' });
    assert.throws(
      () => assertReviewPackageHeadTree(approvedPackage, { cwd: approvedCwd }),
      (error) => error instanceof ReviewPackageError && error.code === 'COMMITTED_TREE_MISMATCH',
    );
    git(approvedCwd, ['add', '-A', '--']);
    git(approvedCwd, ['commit', '-q', '-m', 'commit reviewed tree']);
    assert.equal(assertReviewPackageHeadTree(approvedPackage, { cwd: approvedCwd }), true);

    const changedCwd = await initRepository();
    await fs.writeFile(path.join(changedCwd, 'approved.txt'), 'approved content\n');
    const changedPackage = buildReviewPackage({ cwd: changedCwd, baseRef: 'main' });
    await fs.writeFile(path.join(changedCwd, 'unreviewed.txt'), 'unreviewed content\n');
    git(changedCwd, ['add', '-A', '--']);
    git(changedCwd, ['commit', '-q', '-m', 'commit extra unreviewed content']);
    assert.throws(
      () => assertReviewPackageHeadTree(changedPackage, { cwd: changedCwd }),
      (error) => error instanceof ReviewPackageError && error.code === 'COMMITTED_TREE_MISMATCH',
    );
  });

  it('rejects an unsafe or missing base instead of invoking a shell expression', async () => {
    const cwd = await initRepository();
    await fs.writeFile(path.join(cwd, 'untracked.txt'), 'change\n');
    assert.throws(
      () => buildReviewPackage({ cwd, baseRef: '--output=/tmp/unsafe' }),
      (error) => error instanceof ReviewPackageError && error.code === 'UNSAFE_BASE_REF',
    );
    assert.throws(
      () => buildReviewPackage({ cwd, baseRef: 'does-not-exist' }),
      (error) => error instanceof ReviewPackageError && error.code === 'GIT_COMMAND_FAILED',
    );
  });

  it('discovers a conventional develop base when origin/HEAD and main are absent', async () => {
    const cwd = await initRepository();
    git(cwd, ['branch', '-m', 'develop']);
    git(cwd, ['checkout', '-q', '-b', 'feature/from-develop']);
    await fs.writeFile(path.join(cwd, 'feature.txt'), 'change from develop\n');

    const resolved = resolveReviewBase({ cwd, env: {} });
    assert.equal(resolved.baseRef, 'develop');
    assert.equal(resolved.baseRefCommit, git(cwd, ['rev-parse', 'develop']));
    assert.equal(resolved.source, 'conventional');

    const reviewPackage = buildReviewPackage({ cwd });
    assert.equal(reviewPackage.baseRef, 'develop');
    assert.deepEqual(reviewPackage.diffPaths, ['feature.txt']);
  });

  it('uses validated CI target metadata and fails closed when it is unsafe or unresolved', async () => {
    const cwd = await initRepository();
    git(cwd, ['branch', '-m', 'release']);
    git(cwd, ['checkout', '-q', '-b', 'feature/ci-base']);

    const resolved = resolveReviewBase({ cwd, env: { GITHUB_BASE_REF: 'release' } });
    assert.equal(resolved.baseRef, 'release');
    assert.equal(resolved.source, 'env:GITHUB_BASE_REF');

    assert.throws(
      () => resolveReviewBase({ cwd, env: { GITHUB_BASE_REF: '--upload-pack=evil' } }),
      (error) => error instanceof ReviewPackageError && error.code === 'UNSAFE_BASE_REF',
    );
    assert.throws(
      () => resolveReviewBase({ cwd, env: { GITHUB_BASE_REF: 'missing-target' } }),
      (error) => error instanceof ReviewPackageError && error.code === 'BASE_REF_REQUIRED',
    );

    for (const [key, value] of [
      ['CI_MERGE_REQUEST_TARGET_BRANCH_NAME', 'release'],
      ['CHANGE_TARGET', 'release'],
      ['SYSTEM_PULLREQUEST_TARGETBRANCH', 'refs/heads/release'],
    ]) {
      const ciResolved = resolveReviewBase({ cwd, env: { [key]: value } });
      assert.equal(ciResolved.baseRefCommit, git(cwd, ['rev-parse', 'release']));
      assert.equal(ciResolved.source, `env:${key}`);
    }
  });

  it('supports a durable pinned base commit even when the symbolic branch moves', async () => {
    const cwd = await initRepository();
    git(cwd, ['checkout', '-q', '-b', 'feature/pinned-base']);
    await fs.writeFile(path.join(cwd, 'feature.txt'), 'pinned review content\n');
    git(cwd, ['add', '--', 'feature.txt']);
    git(cwd, ['commit', '-q', '-m', 'feature']);

    const pinned = resolveReviewBase({ cwd, baseRef: 'main' });
    const reviewPackage = buildReviewPackage({ cwd, baseRef: pinned.baseRefCommit });
    git(cwd, ['checkout', '-q', 'main']);
    git(cwd, ['commit', '-q', '--allow-empty', '-m', 'move symbolic base']);
    git(cwd, ['checkout', '-q', 'feature/pinned-base']);

    assert.equal(assertReviewPackageCurrent(reviewPackage, { cwd }), true);
    assert.equal(reviewPackage.baseRef, pinned.baseRefCommit);
  });

  it('binds terminal PRD verification to the immutable review package', async () => {
    const cwd = await initRepository();
    await fs.writeFile(path.join(cwd, 'untracked.txt'), 'change\n');
    const gitEvidence = buildReviewPackage({ cwd, baseRef: 'main' });
    const reviewPackage = attachReviewContext(gitEvidence, {
      prd: { userStories: [prdStory()] },
      verification: [verificationRecord(gitEvidence.reviewTreeOid)],
    });
    assert.equal(assertCompleteReviewPackageIntegrity(reviewPackage), true);
    assert.equal(Object.isFrozen(reviewPackage.prd), true);
    assert.equal(Object.isFrozen(reviewPackage.verification), true);

    const tampered = JSON.parse(JSON.stringify(reviewPackage));
    tampered.verification[0].verdict = 'fail';
    assert.throws(
      () => assertCompleteReviewPackageIntegrity(tampered),
      (error) => error instanceof ReviewPackageError
        && ['INCOMPLETE_VERIFICATION', 'INCONSISTENT_VERIFICATION', 'DIGEST_MISMATCH']
          .includes(error.code),
    );
  });

  it('rejects incomplete or failed story verification before review', async () => {
    const cwd = await initRepository();
    await fs.writeFile(path.join(cwd, 'untracked.txt'), 'change\n');
    const gitEvidence = buildReviewPackage({ cwd, baseRef: 'main' });
    assert.throws(
      () => attachReviewContext(gitEvidence, {
        prd: { userStories: [prdStory()] },
        verification: [verificationRecord(gitEvidence.reviewTreeOid, {
          verdict: 'fail',
          criteria: [{ criterion_index: 0, verdict: 'fail', evidence: 'test failed' }],
        })],
      }),
      (error) => error instanceof ReviewPackageError && error.code === 'INCOMPLETE_VERIFICATION',
    );
    assert.throws(
      () => attachReviewContext(gitEvidence, {
        prd: { userStories: [prdStory({ passes: false })] },
        verification: [verificationRecord(gitEvidence.reviewTreeOid)],
      }),
      (error) => error instanceof ReviewPackageError && error.code === 'INVALID_PRD',
    );
  });

  it('rejects missing criterion evidence and a false top-level pass', async () => {
    const cwd = await initRepository();
    await fs.writeFile(path.join(cwd, 'untracked.txt'), 'change\n');
    const gitEvidence = buildReviewPackage({ cwd, baseRef: 'main' });

    assert.throws(
      () => attachReviewContext(gitEvidence, {
        prd: { userStories: [prdStory({ acceptanceCriteria: [] })] },
        verification: [verificationRecord(gitEvidence.reviewTreeOid)],
      }),
      (error) => error instanceof ReviewPackageError && error.code === 'INVALID_PRD',
    );

    assert.throws(
      () => attachReviewContext(gitEvidence, {
        prd: { userStories: [prdStory()] },
        verification: [verificationRecord(gitEvidence.reviewTreeOid, { criteria: [] })],
      }),
      (error) => error instanceof ReviewPackageError && error.code === 'INVALID_VERIFICATION',
    );
    assert.throws(
      () => attachReviewContext(gitEvidence, {
        prd: { userStories: [prdStory()] },
        verification: [verificationRecord(gitEvidence.reviewTreeOid, {
          criteria: [{ criterion_index: 0, verdict: 'fail', evidence: 'assertion failed' }],
        })],
      }),
      (error) => error instanceof ReviewPackageError && error.code === 'INCONSISTENT_VERIFICATION',
    );
    for (const override of [{ evidence: '' }, { verifiedBy: '' }]) {
      assert.throws(
        () => attachReviewContext(gitEvidence, {
          prd: { userStories: [prdStory()] },
          verification: [verificationRecord(gitEvidence.reviewTreeOid, override)],
        }),
        (error) => error instanceof ReviewPackageError && error.code === 'INVALID_VERIFICATION',
      );
    }
  });

  it('uses the latest complete verification record for terminal status', async () => {
    const cwd = await initRepository();
    await fs.writeFile(path.join(cwd, 'untracked.txt'), 'change\n');
    const gitEvidence = buildReviewPackage({ cwd, baseRef: 'main' });
    const failed = verificationRecord(gitEvidence.reviewTreeOid, {
      verdict: 'fail',
      evidence: 'initial test failed',
      criteria: [{ criterion_index: 0, verdict: 'fail', evidence: 'initial failure' }],
    });
    assert.doesNotThrow(() => attachReviewContext(gitEvidence, {
      prd: { userStories: [prdStory()] },
      verification: [failed, verificationRecord(gitEvidence.reviewTreeOid)],
    }));
    assert.throws(
      () => attachReviewContext(gitEvidence, {
        prd: { userStories: [prdStory()] },
        verification: [verificationRecord(gitEvidence.reviewTreeOid), failed],
      }),
      (error) => error instanceof ReviewPackageError && error.code === 'INCOMPLETE_VERIFICATION',
    );
  });

  it('requires every terminal verification record to name the exact reviewed tree', async () => {
    const cwd = await initRepository();
    await fs.writeFile(path.join(cwd, 'untracked.txt'), 'change\n');
    const gitEvidence = buildReviewPackage({ cwd, baseRef: 'main' });
    const staleTree = '0'.repeat(gitEvidence.reviewTreeOid.length);

    assert.throws(
      () => attachReviewContext(gitEvidence, {
        prd: { userStories: [prdStory()] },
        verification: [verificationRecord(undefined)],
      }),
      (error) => error instanceof ReviewPackageError && error.code === 'STALE_VERIFICATION',
    );
    assert.throws(
      () => attachReviewContext(gitEvidence, {
        prd: { userStories: [prdStory()] },
        verification: [verificationRecord(staleTree)],
      }),
      (error) => error instanceof ReviewPackageError && error.code === 'STALE_VERIFICATION',
    );
    assert.doesNotThrow(() => attachReviewContext(gitEvidence, {
      prd: { userStories: [prdStory()] },
      verification: [
        verificationRecord(staleTree, { verdict: 'fail', criteria: [{
          criterion_index: 0,
          criterion_text: 'Tests complete successfully',
          verdict: 'fail',
          evidence: 'historical failure on an older tree',
        }] }),
        verificationRecord(gitEvidence.reviewTreeOid),
      ],
    }));
  });

  it('allows legacy historical records without criteria when the latest record is complete', async () => {
    const cwd = await initRepository();
    await fs.writeFile(path.join(cwd, 'untracked.txt'), 'change\n');
    const gitEvidence = buildReviewPackage({ cwd, baseRef: 'main' });
    const legacy = {
      story_id: 'US-001',
      verdict: 'fail',
      evidence: 'legacy run failed before criterion capture existed',
      verifiedBy: 'themis',
    };
    assert.doesNotThrow(() => attachReviewContext(gitEvidence, {
      prd: { userStories: [prdStory()] },
      verification: [legacy, verificationRecord(gitEvidence.reviewTreeOid)],
    }));
    assert.throws(
      () => attachReviewContext(gitEvidence, {
        prd: { userStories: [prdStory()] },
        verification: [verificationRecord(gitEvidence.reviewTreeOid), legacy],
      }),
      (error) => error instanceof ReviewPackageError && error.code === 'INVALID_VERIFICATION',
    );
  });
});
