import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  computeAthenaWorktreeDigest,
  planAthenaSpawnRecovery,
  validateAthenaCheckpointBinding,
  validateAthenaSpawnIdentity,
  validateAthenaTeamAdoptionProof,
} from '../lib/athena-recovery.mjs';

const CWD = '/repo';

const BASE = {
  runId: 'athena-20260712-120000-abcd',
  teamSlug: 'athena-recovery-test',
  intendedWorkers: 'api,test',
  spawnPath: 'adapter-only',
  adapterRunId: '0123456789abcdef',
  launchState: 'not-started',
  baseCommit: 'a'.repeat(40),
};

function worktrees(names = ['api', 'test']) {
  return Object.fromEntries(names.map((name) => [name, {
    path: `${CWD}/.ao/worktrees/team/${name}`,
    branch: `ao-worker-${name}`,
    created: true,
  }]));
}

function checkpoint(identity = BASE, mapping = worktrees(identity.intendedWorkers.split(','))) {
  return { ...identity, phase: 2, worktrees: mapping };
}

function durableIdentity(identity = BASE, mapping = worktrees(identity.intendedWorkers.split(','))) {
  return {
    ...identity,
    launchState: 'durable',
    worktreeDigest: computeAthenaWorktreeDigest(mapping),
  };
}

function proof(source, names = ['api', 'test']) {
  return {
    source,
    teamSlug: BASE.teamSlug,
    ...(source === 'adapter-state' ? { runId: BASE.adapterRunId } : {}),
    workers: names.map((name) => ({ name, status: 'running' })),
  };
}

describe('Athena spawn recovery policy', () => {
  test('validates bounded canonical recovery identities', () => {
    assert.equal(validateAthenaSpawnIdentity(BASE), true);
    assert.equal(validateAthenaSpawnIdentity({ ...BASE, teamSlug: `athena-${'x'.repeat(81)}` }), false);
    assert.equal(validateAthenaSpawnIdentity({ ...BASE, intendedWorkers: 'test,api' }), false);
    assert.equal(validateAthenaSpawnIdentity({ ...BASE, intendedWorkers: 'api,api' }), false);
    assert.equal(validateAthenaSpawnIdentity({ ...BASE, baseCommit: '../escape' }), false);
    assert.equal(validateAthenaSpawnIdentity({ ...BASE, runId: '../escape' }), false);
    assert.equal(validateAthenaSpawnIdentity({ ...BASE, adapterRunId: 'none' }), false);
    assert.equal(validateAthenaSpawnIdentity({ ...BASE, adapterRunId: 'f'.repeat(15) }), false);
    assert.equal(validateAthenaSpawnIdentity({
      ...BASE,
      spawnPath: 'native-or-mixed',
      adapterRunId: 'none',
    }), true);
  });

  test('requires an exact observed roster for adapter and native adoption', () => {
    assert.equal(validateAthenaTeamAdoptionProof(proof('adapter-state'), BASE, 'adapter-state'), true);
    assert.equal(validateAthenaTeamAdoptionProof(proof('native-task-list'), BASE, 'native-task-list'), true);
    assert.equal(validateAthenaTeamAdoptionProof(proof('native-task-list', []), BASE, 'native-task-list'), false);
    assert.equal(validateAthenaTeamAdoptionProof(proof('native-task-list', ['api']), BASE, 'native-task-list'), false);
    assert.equal(validateAthenaTeamAdoptionProof(proof('native-task-list', ['api', 'other']), BASE, 'native-task-list'), false);
    assert.equal(validateAthenaTeamAdoptionProof({ ...proof('adapter-state'), teamSlug: 'athena-other' }, BASE, 'adapter-state'), false);
    assert.equal(validateAthenaTeamAdoptionProof({
      ...proof('adapter-state'),
      runId: 'fedcba9876543210',
    }, BASE, 'adapter-state'), false);
  });

  test('adopts a matching durable adapter-only team without cleanup', () => {
    assert.deepEqual(planAthenaSpawnRecovery({
      recovering: true,
      expected: BASE,
      persisted: { ...BASE, launchState: 'durable' },
      checkpoint: checkpoint({ ...BASE, launchState: 'durable' }),
      adapterOnly: true,
      adapterTeamProof: proof('adapter-state'),
      nativeTeamProof: null,
      cwd: CWD,
    }), {
      action: 'adopt',
      reason: 'durable-adapter-team',
      destructiveCleanupAllowed: false,
    });
  });

  test('permits clean respawn only for proven adapter-only pre-launch state', () => {
    assert.deepEqual(planAthenaSpawnRecovery({
      recovering: true,
      expected: BASE,
      persisted: BASE,
      checkpoint: checkpoint(),
      adapterOnly: true,
      adapterTeamProof: null,
      nativeTeamProof: null,
      cwd: CWD,
    }), {
      action: 'spawn',
      reason: 'proven-pre-launch',
      destructiveCleanupAllowed: true,
    });
    assert.equal(planAthenaSpawnRecovery({
      recovering: true,
      expected: { ...BASE, launchState: 'started' },
      persisted: { ...BASE, launchState: 'started' },
      checkpoint: checkpoint({ ...BASE, launchState: 'started' }),
      adapterOnly: true,
      adapterTeamProof: null,
      nativeTeamProof: null,
      cwd: CWD,
    }).action, 'stop');
  });

  test('preserves unproven native or mixed state and rejects identity drift', () => {
    const mixed = { ...BASE, spawnPath: 'native-or-mixed', launchState: 'started' };
    const stopped = planAthenaSpawnRecovery({
      recovering: true,
      expected: mixed,
      persisted: mixed,
      checkpoint: checkpoint(mixed),
      adapterOnly: false,
      adapterTeamProof: null,
      nativeTeamProof: null,
      cwd: CWD,
    });
    assert.deepEqual(stopped, {
      action: 'stop',
      reason: 'native-or-mixed-state-unproven',
      destructiveCleanupAllowed: false,
    });
    assert.equal(planAthenaSpawnRecovery({
      recovering: true,
      expected: mixed,
      persisted: { ...mixed, intendedWorkers: 'api,other' },
      checkpoint: checkpoint(mixed),
      adapterOnly: false,
      adapterTeamProof: null,
      nativeTeamProof: proof('native-task-list'),
      cwd: CWD,
    }).reason, 'recovery-identity-mismatch');
  });

  test('adopts a native team only after explicit re-adoption proof', () => {
    const mixed = { ...BASE, spawnPath: 'native-or-mixed', launchState: 'durable' };
    assert.equal(planAthenaSpawnRecovery({
      recovering: true,
      expected: mixed,
      persisted: mixed,
      checkpoint: checkpoint(mixed),
      adapterOnly: false,
      adapterTeamProof: null,
      nativeTeamProof: proof('native-task-list'),
      cwd: CWD,
    }).action, 'adopt');
  });

  test('binds singleton checkpoints to the exact run, team, and ledger launch state', () => {
    const persisted = { ...BASE, launchState: 'started' };
    assert.equal(validateAthenaCheckpointBinding(checkpoint(persisted), persisted), true);
    for (const badCheckpoint of [
      null,
      checkpoint({ ...persisted, runId: 'athena-20260712-120001-dead' }),
      checkpoint({ ...persisted, teamSlug: 'athena-other' }),
      checkpoint({ ...persisted, adapterRunId: 'fedcba9876543210' }),
      checkpoint({ ...persisted, launchState: 'not-started' }),
    ]) {
      const result = planAthenaSpawnRecovery({
        recovering: true,
        expected: persisted,
        persisted,
        checkpoint: badCheckpoint,
        adapterOnly: true,
        adapterTeamProof: proof('adapter-state'),
        nativeTeamProof: null,
        cwd: CWD,
      });
      assert.equal(result.action, 'stop');
      assert.match(result.reason, /^checkpoint-/);
    }
  });

  test('re-adopts a one-step-ahead durable checkpoint after ledger write failure', () => {
    const persisted = { ...BASE, launchState: 'started' };
    const mapping = worktrees();
    const ahead = checkpoint(durableIdentity(BASE, mapping), mapping);
    const result = planAthenaSpawnRecovery({
      recovering: true,
      expected: persisted,
      persisted,
      checkpoint: ahead,
      adapterOnly: true,
      adapterTeamProof: proof('adapter-state'),
      nativeTeamProof: null,
      cwd: CWD,
    });
    assert.deepEqual(result, {
      action: 'adopt',
      reason: 'durable-checkpoint-ahead',
      destructiveCleanupAllowed: false,
    });
  });

  test('adopts a mixed team only when native and adapter proof union is exact', () => {
    const mixed = {
      ...BASE,
      intendedWorkers: 'claude,codex',
      spawnPath: 'native-or-mixed',
      launchState: 'started',
    };
    const result = planAthenaSpawnRecovery({
      recovering: true,
      expected: mixed,
      persisted: mixed,
      checkpoint: checkpoint(mixed, worktrees(['claude', 'codex'])),
      adapterOnly: false,
      adapterTeamProof: {
        source: 'adapter-state', teamSlug: mixed.teamSlug, runId: mixed.adapterRunId,
        workers: [{ name: 'codex', status: 'running' }],
      },
      nativeTeamProof: {
        source: 'native-task-list', teamSlug: mixed.teamSlug,
        workers: [{ name: 'claude', status: 'running' }],
      },
      cwd: CWD,
    });
    assert.equal(result.action, 'adopt');
    assert.equal(result.reason, 'mixed-team-adopted');
  });

  test('rejects a stale same-slug adapter generation after a crash', () => {
    const started = { ...BASE, launchState: 'started' };
    const staleProof = {
      ...proof('adapter-state'),
      runId: 'fedcba9876543210',
    };
    const result = planAthenaSpawnRecovery({
      recovering: true,
      expected: started,
      persisted: started,
      checkpoint: checkpoint(started),
      adapterOnly: true,
      adapterTeamProof: staleProof,
      nativeTeamProof: null,
      cwd: CWD,
    });
    assert.deepEqual(result, {
      action: 'stop',
      reason: 'ambiguous-adapter-launch',
      destructiveCleanupAllowed: false,
    });
  });

  test('durable checkpoint binding rejects missing, partial, and unsafe worktree maps', () => {
    const mapping = worktrees();
    const persisted = durableIdentity(BASE, mapping);
    assert.equal(validateAthenaCheckpointBinding(checkpoint(persisted, mapping), persisted, { cwd: CWD }), true);
    for (const bad of [
      {},
      worktrees(['api']),
      {
        api: { path: '/tmp/wrong', branch: 'ao-worker-api', created: true },
        test: { path: `${CWD}/.ao/worktrees/team/test`, branch: 'ao-worker-test', created: true },
      },
      {
        api: { path: CWD, branch: 'ao-worker-api', created: false },
        test: { path: CWD, branch: 'ao-worker-test', created: false },
      },
    ]) {
      const candidate = checkpoint({
        ...persisted,
        worktreeDigest: computeAthenaWorktreeDigest(bad) || persisted.worktreeDigest,
      }, bad);
      assert.equal(validateAthenaCheckpointBinding(candidate, persisted, { cwd: CWD }), false);
    }
  });
});
