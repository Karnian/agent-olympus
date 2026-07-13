/** Shared crash-reclaimable lock for run and pipeline transitions. */

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { readProcStartId } from './proc-identity.mjs';
import { acquireRecoveryClaim, statGeneration } from './recovery-claim.mjs';

export const RUN_FINALIZATION_LOCK_FILE = '.terminal-failure.lock';
const OWNER_FILE = 'owner.json';
const LOCK_SCHEMA_VERSION = 1;
const LOCK_STALE_MS = 30_000;
const MAX_LOCK_BYTES = 4096;
const TOKEN = /^[a-f0-9-]{36}$/;

function lockPath(runDir) {
  return join(runDir, RUN_FINALIZATION_LOCK_FILE);
}

function ownerRecord() {
  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    token: randomUUID(),
    pid: process.pid,
    startId: readProcStartId(process.pid),
    createdAt: new Date().toISOString(),
  };
}

export function isValidRunFinalizationLockOwner(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = ['schemaVersion', 'token', 'pid', 'startId', 'createdAt'];
  if (Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) return false;
  if (value.schemaVersion !== LOCK_SCHEMA_VERSION || !TOKEN.test(value.token)) return false;
  if (!Number.isSafeInteger(value.pid) || value.pid < 1) return false;
  if (!(value.startId === null || (
    typeof value.startId === 'string' && value.startId.length > 0 && value.startId.length <= 512
  ))) return false;
  const time = Date.parse(value.createdAt);
  return Number.isFinite(time)
    && new Date(time).toISOString() === value.createdAt
    && time <= Date.now() + 60_000;
}

function readOwner(path) {
  const lockStat = lstatSync(path);
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink()
    || (process.platform !== 'win32' && (lockStat.mode & 0o777) !== 0o700)) {
    throw new Error('run finalization lock is unsafe');
  }
  const ownerPath = join(path, OWNER_FILE);
  const stat = lstatSync(ownerPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_LOCK_BYTES
    || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)) {
    throw new Error('run finalization lock is unsafe');
  }
  let owner;
  try { owner = JSON.parse(readFileSync(ownerPath, 'utf8')); }
  catch { throw new Error('run finalization lock is unsafe'); }
  if (!isValidRunFinalizationLockOwner(owner)) throw new Error('run finalization lock is unsafe');
  return owner;
}

function sameOwner(left, right) {
  return Boolean(left && right)
    && left.token === right.token
    && left.pid === right.pid
    && left.startId === right.startId;
}

function definitelyStale(owner) {
  if (Date.now() - Date.parse(owner.createdAt) <= LOCK_STALE_MS) return false;
  try { process.kill(owner.pid, 0); }
  catch (error) { return error?.code === 'ESRCH'; }
  const current = readProcStartId(owner.pid);
  return owner.startId !== null && current !== null && current !== owner.startId;
}

function prepareIntent(path) {
  const owner = ownerRecord();
  const intentPath = join(dirname(path), `.run-finalize-intent-${owner.token}`);
  mkdirSync(intentPath, { mode: 0o700 });
  chmodSync(intentPath, 0o700);
  atomicWriteFileSync(join(intentPath, OWNER_FILE), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  chmodSync(join(intentPath, OWNER_FILE), 0o600);
  return { intentPath, owner };
}

function removeOwnedLock(path, expectedOwner) {
  try {
    const current = readOwner(path);
    if (!sameOwner(current, expectedOwner)) return false;
    unlinkSync(join(path, OWNER_FILE));
    rmdirSync(path);
    return true;
  } catch {
    return false;
  }
}

function reclaimOwnerlessReleaseCrash(path, runDir) {
  let stat;
  try { stat = lstatSync(path); } catch { return true; }
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return false;
  let entries;
  try { entries = readFileSync(join(path, OWNER_FILE), 'utf8'); }
  catch { entries = null; }
  // Only the known empty release-crash state is automatically reclaimable.
  if (entries !== null) return false;
  try {
    if (!acquireRecoveryClaim(runDir, 'run-finalize-ownerless', statGeneration(stat)).won) return false;
    const current = lstatSync(path);
    if (statGeneration(current) !== statGeneration(stat)) return false;
    rmdirSync(path);
    return true;
  } catch {
    return false;
  }
}

export function acquireRunFinalizationLock(runDir) {
  const path = lockPath(runDir);
  const prepared = prepareIntent(path);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        renameSync(prepared.intentPath, path);
        return prepared.owner;
      } catch {
        // Destination normally exists; inspect its exact generation below.
      }
      let existing;
      try { existing = readOwner(path); }
      catch (error) {
        try { lstatSync(path); } catch { continue; }
        if (reclaimOwnerlessReleaseCrash(path, runDir)) continue;
        throw error;
      }
      if (!definitelyStale(existing)) {
        throw new Error('run finalization is already in progress');
      }
      const claim = acquireRecoveryClaim(runDir, 'run-finalize', existing.token);
      if (!claim.won) throw new Error('stale run finalization recovery is already claimed');
      const current = readOwner(path);
      if (!sameOwner(current, existing) || !definitelyStale(current)) {
        throw new Error('run finalization owner changed during recovery');
      }
      if (!removeOwnedLock(path, current)) {
        throw new Error('stale run finalization lock could not be removed');
      }
    }
    throw new Error('run finalization lock could not be acquired');
  } catch (error) {
    removeOwnedLock(prepared.intentPath, prepared.owner);
    throw error;
  }
}

export function holdsRunFinalizationLock(runDir, expectedOwner) {
  try { return sameOwner(readOwner(lockPath(runDir)), expectedOwner); }
  catch { return false; }
}

export function releaseRunFinalizationLock(runDir, expectedOwner) {
  return removeOwnedLock(lockPath(runDir), expectedOwner);
}
