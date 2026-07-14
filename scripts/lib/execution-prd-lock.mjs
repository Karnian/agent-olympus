/** Shared crash-reclaimable mutation lock for every `.ao/prd.json` writer. */

import { randomUUID } from 'node:crypto';
import { lstatSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  HARDENED_FS_VIOLATION_CODE,
  bindSafeDirectoryPath,
  ensureSafeDirectoryPath,
  lstatOrMissing,
  readRegularArtifact,
  revalidateDirectoryBinding,
  revalidateRegularArtifact,
  sameFileGeneration,
  validateRegularArtifact,
  writeExclusiveRegularArtifact,
} from './hardened-fs.mjs';
import { readProcStartId as realReadProcStartId } from './proc-identity.mjs';

export const EXECUTION_PRD_CONFLICT_CODE = 'AO_EXECUTION_PRD_CONFLICT';
export const EXECUTION_PRD_LOCK_RELATIVE_PATH = '.ao/state/execution-prd.lock';

const LOCK_LABEL = 'execution PRD mutation lock';
const LOCK_SCHEMA_VERSION = 1;
const MAX_LOCK_BYTES = 4096;
const DEFAULT_LOCK_STALE_MS = 30_000;
const MAX_FUTURE_SKEW_MS = 60_000;
const TOKEN = /^[a-f0-9-]{36}$/;

function lockError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function conflict(message) {
  return lockError(EXECUTION_PRD_CONFLICT_CODE, message);
}

function hardenedViolation(message) {
  return lockError(HARDENED_FS_VIOLATION_CODE, message);
}

function assertAoDirectoryMode(binding) {
  if (process.platform === 'win32') return;
  const leaf = binding.chain[binding.chain.length - 1]?.stat;
  if (!leaf || (leaf.mode & 0o022) !== 0) {
    throw hardenedViolation('execution PRD .ao directory is group/world-writable');
  }
}

function bindLockContext(options = {}) {
  const cwd = resolve(options.cwd || process.cwd());
  const trustedRoot = resolve(options.trustedRoot || cwd);
  const aoPath = join(cwd, '.ao');
  const aoBinding = bindSafeDirectoryPath(aoPath, 'execution PRD .ao directory', {
    trustedRoot,
    requirePrivateMode: false,
  });
  assertAoDirectoryMode(aoBinding);
  const statePath = join(aoPath, 'state');
  const stateBinding = ensureSafeDirectoryPath(statePath, 'execution PRD state directory', {
    trustedRoot,
    requirePrivateMode: true,
    requirePrivateAnchor: false,
  });
  const context = {
    cwd,
    trustedRoot,
    aoPath,
    statePath,
    lockPath: join(cwd, EXECUTION_PRD_LOCK_RELATIVE_PATH),
    revalidate() {
      revalidateDirectoryBinding(aoBinding, 'execution PRD .ao directory');
      assertAoDirectoryMode(aoBinding);
      revalidateDirectoryBinding(stateBinding, 'execution PRD state directory');
    },
  };
  context.revalidate();
  return context;
}

function lockOwner(options = {}) {
  const inject = options._inject || {};
  const now = Number(inject.now ?? Date.now());
  const readStartId = inject.readProcStartId || realReadProcStartId;
  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    token: randomUUID(),
    pid: process.pid,
    startId: readStartId(process.pid),
    createdAt: new Date(now).toISOString(),
  };
}

function validCanonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    && new Date(timestamp).toISOString() === value
    && timestamp <= Date.now() + MAX_FUTURE_SKEW_MS;
}

function validLockOwner(owner) {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) return false;
  const keys = ['schemaVersion', 'token', 'pid', 'startId', 'createdAt'];
  return Object.keys(owner).length === keys.length
    && keys.every(key => Object.hasOwn(owner, key))
    && owner.schemaVersion === LOCK_SCHEMA_VERSION
    && TOKEN.test(owner.token)
    && Number.isSafeInteger(owner.pid)
    && owner.pid >= 1
    && (owner.startId === null || (
      typeof owner.startId === 'string'
      && owner.startId.length > 0
      && owner.startId.length <= 512
    ))
    && validCanonicalTimestamp(owner.createdAt);
}

function readLockSnapshot(context, { allowCorrupt = false } = {}) {
  context.revalidate();
  const pathStat = lstatOrMissing(context.lockPath);
  if (!pathStat) return null;
  validateRegularArtifact(pathStat, LOCK_LABEL, MAX_LOCK_BYTES, { allowEmpty: true });
  let artifact;
  try {
    artifact = readRegularArtifact(context.lockPath, LOCK_LABEL, MAX_LOCK_BYTES, {
      allowEmpty: true,
      generationPolicy: 'full',
      revalidateContext: () => context.revalidate(),
    });
  } catch (error) {
    if (!allowCorrupt) throw error;
    return { owner: null, stat: pathStat };
  }
  let owner = null;
  try { owner = JSON.parse(artifact.text); } catch {}
  if (!validLockOwner(owner)) {
    if (!allowCorrupt) throw hardenedViolation(`${LOCK_LABEL} is corrupt`);
    owner = null;
  }
  return { owner, stat: artifact.stat };
}

function lockSnapshotIsDefinitelyStale(snapshot, options = {}) {
  const inject = options._inject || {};
  const now = Number(inject.now ?? Date.now());
  const staleMs = Number.isFinite(inject.lockStaleMs)
    ? Math.max(0, Number(inject.lockStaleMs))
    : DEFAULT_LOCK_STALE_MS;
  const createdAt = snapshot.owner
    ? Date.parse(snapshot.owner.createdAt)
    : snapshot.stat.mtimeMs;
  if (!Number.isFinite(createdAt)
    || createdAt > now + MAX_FUTURE_SKEW_MS
    || now - createdAt <= staleMs) return false;
  if (!snapshot.owner) return true;
  const processKill = inject.processKill || process.kill.bind(process);
  try { processKill(snapshot.owner.pid, 0); }
  catch (error) { return error?.code === 'ESRCH'; }
  const readStartId = inject.readProcStartId || realReadProcStartId;
  const currentStartId = readStartId(snapshot.owner.pid);
  return snapshot.owner.startId !== null
    && currentStartId !== null
    && currentStartId !== snapshot.owner.startId;
}

function sameLockGeneration(context, expectedStat) {
  try {
    context.revalidate();
    const current = lstatSync(context.lockPath);
    validateRegularArtifact(current, LOCK_LABEL, MAX_LOCK_BYTES, { allowEmpty: true });
    return sameFileGeneration(current, expectedStat, 'full');
  } catch {
    return false;
  }
}

function recoverStaleLock(context, snapshot, options = {}) {
  if (!lockSnapshotIsDefinitelyStale(snapshot, options)) return false;
  try {
    const current = readLockSnapshot(context, { allowCorrupt: true });
    if (!current
      || !sameFileGeneration(current.stat, snapshot.stat, 'full')
      || !lockSnapshotIsDefinitelyStale(current, options)) return true;
    revalidateRegularArtifact(context.lockPath, snapshot.stat, LOCK_LABEL, MAX_LOCK_BYTES, {
      allowEmpty: true,
      generationPolicy: 'full',
    });
    context.revalidate();
    unlinkSync(context.lockPath);
    context.revalidate();
    return true;
  } catch (error) {
    if (!sameLockGeneration(context, snapshot.stat)) return true;
    throw error;
  }
}

function acquireMutationLock(context, options = {}) {
  const owner = lockOwner(options);
  const content = `${JSON.stringify(owner)}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    context.revalidate();
    let publishedStat = null;
    try {
      publishedStat = writeExclusiveRegularArtifact(
        context.lockPath,
        LOCK_LABEL,
        content,
        MAX_LOCK_BYTES,
      );
      context.revalidate();
      const persisted = readLockSnapshot(context);
      if (!persisted
        || persisted.owner.token !== owner.token
        || !sameFileGeneration(persisted.stat, publishedStat, 'full')) {
        throw hardenedViolation(`${LOCK_LABEL} changed during acquisition`);
      }
      return { owner, stat: persisted.stat };
    } catch (error) {
      if (publishedStat) {
        try {
          const current = readLockSnapshot(context);
          if (current?.owner.token === owner.token
            && sameFileGeneration(current.stat, publishedStat, 'full')) {
            revalidateRegularArtifact(
              context.lockPath,
              current.stat,
              LOCK_LABEL,
              MAX_LOCK_BYTES,
              { generationPolicy: 'full' },
            );
            context.revalidate();
            unlinkSync(context.lockPath);
            context.revalidate();
          }
        } catch {}
      }
      if (error?.code !== 'EEXIST') throw error;
      const existing = readLockSnapshot(context, { allowCorrupt: true });
      if (!existing || !recoverStaleLock(context, existing, options)) {
        throw conflict('execution PRD is locked by another live mutation');
      }
    }
  }
  throw conflict('execution PRD mutation lock could not be reclaimed');
}

function releaseMutationLock(context, lock) {
  const current = readLockSnapshot(context);
  if (!current || current.owner.token !== lock.owner.token) {
    throw hardenedViolation(`${LOCK_LABEL} ownership changed before release`);
  }
  revalidateRegularArtifact(context.lockPath, current.stat, LOCK_LABEL, MAX_LOCK_BYTES, {
    generationPolicy: 'full',
  });
  context.revalidate();
  unlinkSync(context.lockPath);
  context.revalidate();
}

export function withExecutionPrdMutationLock(options = {}, action) {
  if (typeof action !== 'function') throw new TypeError('execution PRD lock action is required');
  const context = bindLockContext(options);
  const lock = acquireMutationLock(context, options);
  let actionError = null;
  try {
    options._inject?.afterLock?.();
    return action();
  } catch (error) {
    actionError = error;
    throw error;
  } finally {
    try {
      releaseMutationLock(context, lock);
    } catch (releaseError) {
      if (!actionError) throw releaseError;
    }
  }
}
