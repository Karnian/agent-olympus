/**
 * Pure recovery policy for Athena's non-idempotent spawn phase.
 *
 * The caller owns all I/O. This module only decides whether persisted state is
 * safe to adopt, safe to spawn from a proven pre-launch point, or must be
 * preserved for manual recovery.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

const TEAM_SLUG = /^athena-[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const RUN_ID = /^athena-[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const WORKER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const BASE_COMMIT = /^[a-f0-9]{40,64}$/;
const ADAPTER_RUN_ID = /^[a-f0-9]{16}$/;
const SPAWN_PATHS = new Set(['adapter-only', 'native-or-mixed', 'fallback-or-mixed']);
const LAUNCH_STATES = new Set(['not-started', 'started', 'durable']);
const ADOPTION_SOURCES = new Set(['adapter-state', 'native-task-list']);
const WORKER_STATES = new Set([
  'pending', 'running', 'in_progress', 'blocked', 'completed', 'failed',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalWorkers(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return null;
  const names = value.split(',');
  if (names.some((name) => !WORKER_NAME.test(name))) return null;
  const canonical = [...new Set(names)].sort();
  return canonical.length === names.length && canonical.join(',') === value
    ? value
    : null;
}

function hasExactKeys(value, keys) {
  return isPlainObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

/** Deterministically bind worker names, canonical paths, branches, and isolation flags. */
export function computeAthenaWorktreeDigest(worktrees) {
  if (!isPlainObject(worktrees)) return null;
  const entries = Object.entries(worktrees).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return null;
  const normalized = [];
  for (const [name, item] of entries) {
    if (!WORKER_NAME.test(name)
      || !hasExactKeys(item, ['path', 'branch', 'created'])
      || typeof item.path !== 'string'
      || item.path.length === 0
      || item.path.includes('\0')
      || typeof item.branch !== 'string'
      || !/^ao-worker-[a-zA-Z0-9_-]{1,240}$/.test(item.branch)
      || typeof item.created !== 'boolean') return null;
    normalized.push([name, path.resolve(item.path), item.branch, item.created]);
  }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function validateWorktreeMap(checkpoint, persisted, cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.includes('\0')) return false;
  const expectedWorkers = persisted.intendedWorkers.split(',');
  if (!isPlainObject(checkpoint.worktrees)
    || JSON.stringify(Object.keys(checkpoint.worktrees).sort()) !== JSON.stringify(expectedWorkers)) {
    return false;
  }
  const projectRoot = path.resolve(cwd);
  const managedRoot = path.join(projectRoot, '.ao', 'worktrees');
  if (expectedWorkers.length > 1
    && Object.values(checkpoint.worktrees).some((item) => item?.created !== true)) {
    return false;
  }
  for (const item of Object.values(checkpoint.worktrees)) {
    if (!hasExactKeys(item, ['path', 'branch', 'created'])) return false;
    const resolved = path.resolve(item.path);
    if (item.created) {
      const relative = path.relative(managedRoot, resolved);
      if (!path.isAbsolute(item.path)
        || relative === ''
        || relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)) return false;
    } else if (resolved !== projectRoot) {
      return false;
    }
  }
  const digest = computeAthenaWorktreeDigest(checkpoint.worktrees);
  return digest !== null
    && digest === checkpoint.worktreeDigest
    && digest === persisted.worktreeDigest;
}

export function validateAthenaSpawnIdentity(identity) {
  if (!isPlainObject(identity)) return false;
  const adapterGenerationValid = identity.spawnPath === 'adapter-only'
    ? ADAPTER_RUN_ID.test(identity.adapterRunId || '')
    : identity.adapterRunId === 'none' || ADAPTER_RUN_ID.test(identity.adapterRunId || '');
  return RUN_ID.test(identity.runId || '')
    && TEAM_SLUG.test(identity.teamSlug || '')
    && canonicalWorkers(identity.intendedWorkers) !== null
    && SPAWN_PATHS.has(identity.spawnPath)
    && LAUNCH_STATES.has(identity.launchState)
    && BASE_COMMIT.test(identity.baseCommit || '')
    && adapterGenerationValid;
}

/**
 * Prove adoption from the provider/native runtime's observed roster. A mere
 * truthy TaskList/monitorTeam response is intentionally insufficient.
 */
export function validateAthenaTeamAdoptionProof(proof, identity, source) {
  const workers = observedTeamWorkers(proof, identity, source);
  return workers !== null && workers.join(',') === identity.intendedWorkers;
}

function observedTeamWorkers(proof, identity, source) {
  if (!isPlainObject(proof) || !validateAthenaSpawnIdentity(identity)) return null;
  if (!ADOPTION_SOURCES.has(source) || proof.source !== source) return null;
  if (proof.teamSlug !== identity.teamSlug || !Array.isArray(proof.workers) || proof.workers.length === 0) return null;
  if (source === 'adapter-state'
    && (!ADAPTER_RUN_ID.test(identity.adapterRunId || '') || proof.runId !== identity.adapterRunId)) return null;
  const workers = proof.workers.map((worker) => {
    if (!isPlainObject(worker)
      || !WORKER_NAME.test(worker.name || '')
      || !WORKER_STATES.has(worker.status)) return null;
    return worker.name;
  });
  if (workers.some((worker) => worker === null)) return null;
  const observed = [...new Set(workers)].sort();
  return observed.length === workers.length ? observed : null;
}

function validateCombinedTeamProof(adapterProof, nativeProof, identity) {
  const adapter = observedTeamWorkers(adapterProof, identity, 'adapter-state');
  const native = observedTeamWorkers(nativeProof, identity, 'native-task-list');
  if (!adapter || !native) return false;
  const combined = [...adapter, ...native];
  const canonical = [...new Set(combined)].sort();
  return canonical.length === combined.length && canonical.join(',') === identity.intendedWorkers;
}

function checkpointSpawnIdentity(checkpoint) {
  if (!isPlainObject(checkpoint)) return null;
  return {
    runId: checkpoint.runId,
    teamSlug: checkpoint.teamSlug,
    intendedWorkers: checkpoint.intendedWorkers,
    spawnPath: checkpoint.spawnPath,
    adapterRunId: checkpoint.adapterRunId,
    launchState: checkpoint.launchState,
    baseCommit: checkpoint.baseCommit,
  };
}

/** Bind a rich singleton/session checkpoint to the spawn identity in this run's ledger. */
export function validateAthenaCheckpointBinding(checkpoint, persisted, opts = {}) {
  const checkpointIdentity = checkpointSpawnIdentity(checkpoint);
  if (!validateAthenaSpawnIdentity(checkpointIdentity)
    || !validateAthenaSpawnIdentity(persisted)) return false;
  if (!['runId', 'teamSlug', 'intendedWorkers', 'spawnPath', 'adapterRunId', 'launchState', 'baseCommit']
    .every((key) => checkpointIdentity[key] === persisted[key])) return false;
  if (Object.hasOwn(persisted, 'worktreeDigest')) {
    return typeof persisted.worktreeDigest === 'string'
      && /^[a-f0-9]{64}$/.test(persisted.worktreeDigest)
      && checkpoint.worktreeDigest === persisted.worktreeDigest
      && validateWorktreeMap(checkpoint, persisted, opts.cwd);
  }
  return true;
}

function validateCheckpointAhead(checkpoint, persisted, cwd) {
  if (persisted.launchState !== 'started' || checkpoint?.launchState !== 'durable') return false;
  const durableIdentity = {
    ...persisted,
    launchState: 'durable',
    worktreeDigest: checkpoint.worktreeDigest,
  };
  return validateAthenaCheckpointBinding(checkpoint, durableIdentity, { cwd });
}

/**
 * @param {object} input
 * @param {boolean} input.recovering
 * @param {object} input.expected Current PRD-derived spawn identity.
 * @param {object} input.persisted Ledger/checkpoint spawn identity.
 * @param {object} input.checkpoint Rich global/session checkpoint loaded for recovery.
 * @param {boolean} input.adapterOnly
 * @param {object|null} input.adapterTeamProof Exact monitorTeam roster proof.
 * @param {object|null} input.nativeTeamProof Exact TaskList roster proof.
 * @param {string} input.cwd Project root used to validate checkpoint worktree paths.
 * @returns {{action:'spawn'|'adopt'|'stop', reason:string, destructiveCleanupAllowed:boolean}}
 */
export function planAthenaSpawnRecovery({
  recovering,
  expected,
  persisted,
  checkpoint,
  adapterOnly,
  adapterTeamProof,
  nativeTeamProof,
  cwd,
} = {}) {
  if (!validateAthenaSpawnIdentity(expected) || !validateAthenaSpawnIdentity(persisted)) {
    return { action: 'stop', reason: 'invalid-recovery-identity', destructiveCleanupAllowed: false };
  }
  for (const key of ['runId', 'teamSlug', 'intendedWorkers', 'spawnPath', 'adapterRunId', 'baseCommit']) {
    if (expected[key] !== persisted[key]) {
      return { action: 'stop', reason: 'recovery-identity-mismatch', destructiveCleanupAllowed: false };
    }
  }
  if (!recovering) {
    return { action: 'spawn', reason: 'fresh-spawn', destructiveCleanupAllowed: false };
  }

  const checkpointIdentity = checkpointSpawnIdentity(checkpoint);
  if (!validateAthenaSpawnIdentity(checkpointIdentity)) {
    return { action: 'stop', reason: 'checkpoint-identity-invalid', destructiveCleanupAllowed: false };
  }
  const exactCheckpoint = validateAthenaCheckpointBinding(checkpoint, persisted, { cwd });
  const checkpointAhead = validateCheckpointAhead(checkpoint, persisted, cwd);
  if (!exactCheckpoint && !checkpointAhead) {
    return { action: 'stop', reason: 'checkpoint-ledger-mismatch', destructiveCleanupAllowed: false };
  }

  if (adapterOnly) {
    if (validateAthenaTeamAdoptionProof(adapterTeamProof, persisted, 'adapter-state')) {
      return {
        action: 'adopt',
        reason: checkpointAhead ? 'durable-checkpoint-ahead' : 'durable-adapter-team',
        destructiveCleanupAllowed: false,
      };
    }
    if (persisted.launchState === 'not-started') {
      return { action: 'spawn', reason: 'proven-pre-launch', destructiveCleanupAllowed: true };
    }
    return { action: 'stop', reason: 'ambiguous-adapter-launch', destructiveCleanupAllowed: false };
  }
  if (validateAthenaTeamAdoptionProof(nativeTeamProof, persisted, 'native-task-list')) {
    return {
      action: 'adopt',
      reason: checkpointAhead ? 'durable-checkpoint-ahead' : 'native-team-adopted',
      destructiveCleanupAllowed: false,
    };
  }
  if (validateCombinedTeamProof(adapterTeamProof, nativeTeamProof, persisted)) {
    return {
      action: 'adopt',
      reason: checkpointAhead ? 'durable-checkpoint-ahead' : 'mixed-team-adopted',
      destructiveCleanupAllowed: false,
    };
  }
  return { action: 'stop', reason: 'native-or-mixed-state-unproven', destructiveCleanupAllowed: false };
}
