import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertCrossValidationTeamState,
  buildCrossValidationRequest,
  buildCrossValidationTeamName,
  parseCrossValidationResult,
} from '../lib/cross-validation.mjs';

const oidA = 'a'.repeat(40);
const oidB = 'b'.repeat(40);

function request(overrides = {}) {
  const input = {
    orchestrator: 'atlas',
    runId: 'run-1',
    storyId: 'US-001',
    storyTitle: 'Verify the immutable tree',
    reviewTreeOid: oidA,
    provider: 'codex',
    scope: ['src/api.mjs'],
    acceptanceCriteria: ['GIVEN a tree WHEN reviewed THEN evidence is returned'],
    ...overrides,
  };
  const teamName = buildCrossValidationTeamName(input);
  return buildCrossValidationRequest({
    ...input,
    snapshot: Object.hasOwn(overrides, 'snapshot') ? overrides.snapshot : {
      schemaVersion: 1,
      snapshotId: `xval-${'1'.repeat(32)}`,
      ownerId: teamName,
      reviewTreeOid: input.reviewTreeOid,
      path: '/private/snapshot',
    },
  });
}

describe('cross-validation identity', () => {
  it('binds the exact tree into the team key, worker state, and prompt digest', () => {
    const built = request();
    assert.match(built.teamName, new RegExp(`^atlas-xval-${oidA}-[0-9a-f]{16}$`));
    assert.equal(built.worker.readOnly, true);
    assert.equal(built.worker.reviewTreeOid, oidA);
    assert.equal(built.worker.validationIdentity.reviewTreeOid, oidA);
    assert.equal(built.worker.cwd, '/private/snapshot');
    assert.equal(built.worker.worktreePath, '/private/snapshot');
    assert.notEqual(built.worker.cwd, '/repo');
    assert.equal(built.worker.validationIdentity.snapshotId, built.snapshot.snapshotId);
    assert.match(built.worker.prompt, new RegExp(`Review tree OID: ${oidA}`));
    assert.match(built.worker.prompt, new RegExp(`Validation prompt digest: ${built.identity.promptDigest}`));
  });

  it('rejects a live-root or mismatched snapshot descriptor', () => {
    assert.throws(() => request({ snapshot: null }), /exact-tree snapshot/);
    const input = {
      orchestrator: 'atlas', runId: 'run-1', storyId: 'US-001', reviewTreeOid: oidA,
    };
    assert.throws(() => request({ snapshot: {
      schemaVersion: 1,
      snapshotId: `xval-${'2'.repeat(32)}`,
      ownerId: buildCrossValidationTeamName(input),
      reviewTreeOid: oidB,
      path: '/repo',
    } }), /exact-tree snapshot/);
  });

  it('uses the platform absolute-path contract for snapshot roots', () => {
    if (process.platform !== 'win32') return;
    const built = request({ snapshot: {
      schemaVersion: 1,
      snapshotId: `xval-${'3'.repeat(32)}`,
      ownerId: buildCrossValidationTeamName({
        orchestrator: 'atlas', runId: 'run-1', storyId: 'US-001', reviewTreeOid: oidA,
      }),
      reviewTreeOid: oidA,
      path: 'C:\\ao-review\\snapshot',
    } });
    assert.equal(built.worker.cwd, 'C:\\ao-review\\snapshot');
  });

  it('never reuses state from another tree or prompt identity', () => {
    const built = request();
    const state = {
      teamName: built.teamName,
      workers: [{
        ...built.worker,
        originalPrompt: built.worker.prompt,
      }],
    };
    assert.equal(assertCrossValidationTeamState(state, built), state);
    assert.throws(
      () => assertCrossValidationTeamState({
        ...state,
        workers: [{ ...state.workers[0], reviewTreeOid: oidB }],
      }, built),
      /stale or unbound/,
    );
    for (const field of ['cwd', 'worktreePath']) {
      assert.throws(
        () => assertCrossValidationTeamState({
          ...state,
          workers: [{ ...state.workers[0], [field]: '/repo/live-root' }],
        }, built),
        /stale or unbound/,
        `${field} must stay bound to the immutable snapshot`,
      );
    }
    assert.throws(
      () => assertCrossValidationTeamState({
        ...state,
        workers: [{
          ...state.workers[0],
          validationIdentity: { ...built.identity, storyId: 'US-999' },
        }],
      }, built),
      /stale or unbound/,
      'all seven validation identity fields must match',
    );
  });
});

describe('cross-validation result', () => {
  it('accepts only a structured result echoing the exact tree', () => {
    const built = request();
    assert.deepEqual(parseCrossValidationResult(JSON.stringify({
      schemaVersion: 1,
      reviewTreeOid: oidA,
      snapshotId: built.identity.snapshotId,
      promptDigest: built.identity.promptDigest,
      verdict: 'PASS',
      findings: [],
    }), built.identity), {
      schemaVersion: 1,
      reviewTreeOid: oidA,
      snapshotId: built.identity.snapshotId,
      promptDigest: built.identity.promptDigest,
      verdict: 'PASS',
      findings: [],
    });
    assert.throws(() => parseCrossValidationResult(JSON.stringify({
      schemaVersion: 1,
      reviewTreeOid: oidB,
      snapshotId: built.identity.snapshotId,
      promptDigest: built.identity.promptDigest,
      verdict: 'PASS',
      findings: [],
    }), built.identity), /requested review tree/);
    assert.throws(() => parseCrossValidationResult(JSON.stringify({
      schemaVersion: 1,
      reviewTreeOid: oidA,
      snapshotId: `xval-${'f'.repeat(32)}`,
      promptDigest: built.identity.promptDigest,
      verdict: 'PASS',
      findings: [],
    }), built.identity), /requested review tree/);
    assert.throws(() => parseCrossValidationResult('PASS', built.identity), /not one JSON object/);
    assert.throws(
      () => parseCrossValidationResult('{}', { ...built.identity, runId: undefined }),
      /expected identity is invalid/,
      'the expected identity must be the complete seven-field envelope',
    );
  });

  it('requires findings exactly when the verdict fails', () => {
    const built = request();
    assert.throws(() => parseCrossValidationResult(JSON.stringify({
      schemaVersion: 1,
      reviewTreeOid: oidA,
      snapshotId: built.identity.snapshotId,
      promptDigest: built.identity.promptDigest,
      verdict: 'FAIL',
      findings: [],
    }), built.identity), /verdict and findings disagree/);
    const failed = parseCrossValidationResult(JSON.stringify({
      schemaVersion: 1,
      reviewTreeOid: oidA,
      snapshotId: built.identity.snapshotId,
      promptDigest: built.identity.promptDigest,
      verdict: 'FAIL',
      findings: [{
        severity: 'high',
        evidence: 'US-001 criterion is not covered',
        recommendation: 'Add the missing assertion',
      }],
    }), built.identity);
    assert.equal(failed.verdict, 'FAIL');
  });
});
