/** Crash-reclaimable election claims for exact stale filesystem generations. */

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { readProcStartId as realReadProcStartId } from './proc-identity.mjs';

const CLAIM_SCHEMA_VERSION = 1;
const CLAIM_STALE_MS = 30_000;
const MAX_CLAIM_BYTES = 4096;
const MAX_FUTURE_SKEW_MS = 60_000;
const NAMESPACE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const TOKEN = /^[a-f0-9-]{36}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const NO_FOLLOW = fsConstants.O_NOFOLLOW || 0;

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function rootClaimPath(dir, namespace, generationDigest) {
  return join(dir, `.${namespace}-recovery-${generationDigest}.claim`);
}

function successorClaimPath(dir, namespace, generationDigest, predecessorToken) {
  return join(
    dir,
    `.${namespace}-recovery-${generationDigest}-successor-${digest(predecessorToken)}.claim`,
  );
}

function isCanonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    && new Date(timestamp).toISOString() === value
    && timestamp <= Date.now() + MAX_FUTURE_SKEW_MS;
}

function validateOwner(owner, generationDigest) {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) return false;
  const keys = ['schemaVersion', 'token', 'pid', 'startId', 'generationDigest', 'createdAt'];
  return Object.keys(owner).length === keys.length
    && keys.every(key => Object.hasOwn(owner, key))
    && owner.schemaVersion === CLAIM_SCHEMA_VERSION
    && TOKEN.test(owner.token)
    && Number.isSafeInteger(owner.pid)
    && owner.pid >= 1
    && (owner.startId === null || (
      typeof owner.startId === 'string'
      && owner.startId.length > 0
      && owner.startId.length <= 512
    ))
    && owner.generationDigest === generationDigest
    && DIGEST.test(owner.generationDigest)
    && isCanonicalTimestamp(owner.createdAt);
}

function validateClaimStat(stat) {
  // nlink=2 is the tiny, expected interval between no-replace publication of
  // a fully closed intent and unlinking that intent. Claims are never removed,
  // so accepting that transient cannot redirect a later destructive action.
  return stat.isFile()
    && !stat.isSymbolicLink()
    && (stat.nlink === 1 || stat.nlink === 2)
    && stat.size > 0
    && stat.size <= MAX_CLAIM_BYTES
    && (process.platform === 'win32' || (stat.mode & 0o777) === 0o600);
}

function sameObjectAndSize(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function readClaim(path, generationDigest) {
  const before = lstatSync(path);
  if (!validateClaimStat(before)) throw new Error('recovery claim is unsafe');
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | NO_FOLLOW);
    const opened = fstatSync(fd);
    if (!validateClaimStat(opened) || !sameObjectAndSize(before, opened)) {
      throw new Error('recovery claim changed before read');
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error('recovery claim was truncated during read');
      offset += count;
    }
    const after = fstatSync(fd);
    if (!validateClaimStat(after) || !sameObjectAndSize(opened, after)) {
      throw new Error('recovery claim changed during read');
    }
    let owner;
    try { owner = JSON.parse(bytes.toString('utf8')); }
    catch { throw new Error('recovery claim is corrupt'); }
    if (!validateOwner(owner, generationDigest)) throw new Error('recovery claim is corrupt');
    return owner;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function ownerRecord(generationDigest, opts = {}) {
  const now = Number(opts.now ?? Date.now());
  return {
    schemaVersion: CLAIM_SCHEMA_VERSION,
    token: randomUUID(),
    pid: process.pid,
    startId: realReadProcStartId(process.pid),
    generationDigest,
    createdAt: new Date(now).toISOString(),
  };
}

function writeFully(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset);
    if (count <= 0) throw new Error('recovery claim intent could not be written');
    offset += count;
  }
}

function publishNoReplace(path, dir, owner) {
  const intentPath = join(dir, `.recovery-claim-${owner.token}.intent`);
  const bytes = Buffer.from(`${JSON.stringify(owner)}\n`, 'utf8');
  let fd;
  try {
    fd = openSync(intentPath, 'wx', 0o600);
    writeFully(fd, bytes);
    closeSync(fd);
    fd = undefined;
    linkSync(intentPath, path);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    try { unlinkSync(intentPath); } catch {}
  }
}

function generationIsCurrent(opts) {
  if (typeof opts.isGenerationCurrent !== 'function') return true;
  try { return opts.isGenerationCurrent() === true; }
  catch { return false; }
}

function definitelyStale(owner, opts = {}) {
  const staleMs = Number.isFinite(opts.staleMs)
    ? Math.max(0, opts.staleMs)
    : CLAIM_STALE_MS;
  const now = Number(opts.now ?? Date.now());
  if (now - Date.parse(owner.createdAt) <= staleMs) return false;
  const kill = opts.processKill || process.kill.bind(process);
  try { kill(owner.pid, 0); }
  catch (error) { return error?.code === 'ESRCH'; }
  const readStartId = opts.readProcStartId || realReadProcStartId;
  const currentStartId = readStartId(owner.pid);
  return owner.startId !== null
    && currentStartId !== null
    && currentStartId !== owner.startId;
}

/**
 * Elect one recoverer for an exact target generation. The first owner is
 * published at the stable root claim path. If that owner dies, contenders
 * append one no-replace successor keyed by the dead owner's token. This keeps
 * the ABA fence durable while allowing a later process to recover a claimant
 * that crashed before it could repair the guarded lock.
 *
 * `isGenerationCurrent` must revalidate the guarded lock generation. It is
 * consulted before every publication and again after a winning publication;
 * callers still re-read the target immediately before removing it.
 *
 * @param {string} dir
 * @param {string} namespace
 * @param {*} generation
 * @param {object} [opts]
 * @param {number} [opts.staleMs=30000]
 * @param {() => boolean} [opts.isGenerationCurrent]
 * @returns {{won:boolean,path:string,owner:object|null}}
 */
export function acquireRecoveryClaim(dir, namespace, generation, opts = {}) {
  if (typeof dir !== 'string' || dir.length === 0 || dir.includes('\0')) {
    throw new TypeError('recovery claim directory is invalid');
  }
  if (!NAMESPACE.test(namespace || '')) throw new TypeError('recovery claim namespace is invalid');
  const generationDigest = digest(generation);
  const rootPath = rootClaimPath(dir, namespace, generationDigest);
  const candidate = ownerRecord(generationDigest, opts);
  let path = rootPath;
  const visited = new Set();

  // A legitimate lineage is finite because every live contender either finds
  // a missing successor path or stops at a live owner. Do not impose a crash
  // count cap that would eventually recreate the permanent-stall bug; only a
  // repeated predecessor token (corrupt/cyclic lineage) fails closed.
  while (!visited.has(path)) {
    visited.add(path);
    if (!generationIsCurrent(opts)) return { won: false, path, owner: null };
    if (publishNoReplace(path, dir, candidate)) {
      if (!generationIsCurrent(opts)) return { won: false, path, owner: null };
      return { won: true, path, owner: candidate };
    }

    const existing = readClaim(path, generationDigest);
    if (!definitelyStale(existing, opts)) return { won: false, path, owner: null };
    path = successorClaimPath(dir, namespace, generationDigest, existing.token);
  }

  return { won: false, path, owner: null };
}

export function statGeneration(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}
