/**
 * Materialize an exact Git tree into a dedicated validator-only directory.
 *
 * Cross-validation must never run against the live repository and merely echo
 * a tree OID. This module uses a temporary index to check out that exact tree,
 * excludes ignored/live-only files by construction, and re-hashes the materialized
 * bytes before dispatch and result acceptance.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bindSafeDirectoryPath,
  ensureSafeDirectoryPath,
  readRegularArtifact,
  revalidateDirectoryBinding,
  revalidateRegularArtifact,
  sameFsObject,
  writeExclusiveRegularArtifact,
} from './hardened-fs.mjs';
import { readProcStartId } from './proc-identity.mjs';
import { acquireRecoveryClaim, statGeneration } from './recovery-claim.mjs';

const SCHEMA_VERSION = 1;
const REVIEW_TREE_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;
const SNAPSHOT_ID = /^xval-[0-9a-f]{32}$/;
const LOCK_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;

function defaultBaseDir() {
  const identity = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return path.join(os.tmpdir(), `agent-olympus-review-snapshots-${identity}`);
}

function runGit(cwd, args, options = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: options.encoding ?? 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', ...options.env },
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function resolveRepository(cwd) {
  if (typeof cwd !== 'string' || !cwd || cwd.includes('\0')) {
    throw new Error('review snapshot cwd is invalid');
  }
  const root = runGit(path.resolve(cwd), ['rev-parse', '--show-toplevel']).trim();
  if (!path.isAbsolute(root)) throw new Error('review snapshot repository root is invalid');
  return path.resolve(root);
}

function validateIdentity(reviewTreeOid, ownerId) {
  if (!REVIEW_TREE_OID.test(reviewTreeOid || '')) {
    throw new Error('review snapshot requires an exact lowercase tree OID');
  }
  if (!OWNER_ID.test(ownerId || '')) throw new Error('review snapshot owner is invalid');
}

function snapshotId(repository, ownerId, reviewTreeOid) {
  return `xval-${createHash('sha256')
    .update(JSON.stringify([repository, ownerId, reviewTreeOid]), 'utf8')
    .digest('hex').slice(0, 32)}`;
}

function bindBase(baseDir, trustedRoot) {
  const base = path.resolve(baseDir || defaultBaseDir());
  const anchor = trustedRoot
    ? path.resolve(trustedRoot)
    : path.dirname(base);
  const binding = ensureSafeDirectoryPath(base, 'review snapshot base', {
    trustedRoot: anchor,
    requirePrivateMode: true,
    requirePrivateAnchor: false,
  });
  return { base, binding };
}

function revalidateSnapshotDirectory(snapshotPath, baseBinding) {
  revalidateDirectoryBinding(baseBinding, 'review snapshot base');
  const snapshotBinding = bindSafeDirectoryPath(snapshotPath, 'review snapshot directory', {
    trustedRoot: baseBinding.path,
    requirePrivateMode: true,
  });
  revalidateDirectoryBinding(snapshotBinding, 'review snapshot directory');
  revalidateDirectoryBinding(baseBinding, 'review snapshot base');
  return snapshotBinding;
}

function manifestPathFor(snapshotPath) {
  return `${snapshotPath}.json`;
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    && new Date(timestamp).toISOString() === value
    && timestamp <= Date.now() + 60_000;
}

function buildLockOwner(descriptor) {
  return {
    schemaVersion: 1,
    snapshotId: descriptor.snapshotId,
    ownerId: descriptor.ownerId,
    reviewTreeOid: descriptor.reviewTreeOid,
    token: randomUUID(),
    pid: process.pid,
    pidStartId: readProcStartId(process.pid),
    claimedAt: new Date().toISOString(),
  };
}

function validateLockOwner(value, descriptor) {
  const keys = [
    'schemaVersion', 'snapshotId', 'ownerId', 'reviewTreeOid',
    'token', 'pid', 'pidStartId', 'claimedAt',
  ];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))
    || value.schemaVersion !== 1
    || value.snapshotId !== descriptor.snapshotId
    || value.ownerId !== descriptor.ownerId
    || value.reviewTreeOid !== descriptor.reviewTreeOid
    || !LOCK_TOKEN.test(value.token || '')
    || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || !(value.pidStartId === null || (
      typeof value.pidStartId === 'string'
      && value.pidStartId.length > 0
      && value.pidStartId.length <= 512
    ))
    || !canonicalTimestamp(value.claimedAt)) {
    throw new Error('review snapshot owner lock is malformed');
  }
  return value;
}

function readSnapshotLock(lockPath, descriptor, baseBinding) {
  const artifact = readRegularArtifact(
    lockPath,
    'review snapshot owner lock',
    MAX_MANIFEST_BYTES,
    { revalidateContext: () => revalidateDirectoryBinding(baseBinding, 'review snapshot base') },
  );
  let owner;
  try { owner = JSON.parse(artifact.text); }
  catch { throw new Error('review snapshot owner lock is invalid JSON'); }
  validateLockOwner(owner, descriptor);
  revalidateRegularArtifact(
    lockPath,
    artifact.stat,
    'review snapshot owner lock',
    MAX_MANIFEST_BYTES,
  );
  return { owner, stat: artifact.stat };
}

function lockOwnerDefinitelyStale(owner, options = {}) {
  const processKill = options.processKill || process.kill.bind(process);
  try { processKill(owner.pid, 0); }
  catch (error) {
    if (error?.code === 'ESRCH') return true;
    return false;
  }
  const readStart = options.readProcStartId || readProcStartId;
  const currentStartId = readStart(owner.pid);
  return owner.pidStartId !== null
    && currentStartId !== null
    && currentStartId !== owner.pidStartId;
}

function sameGenerationAt(pathname, expectedStat) {
  try {
    const current = lstatSync(pathname);
    return sameFsObject(current, expectedStat)
      && statGeneration(current) === statGeneration(expectedStat);
  } catch {
    return false;
  }
}

function replaceStaleSnapshotLock({
  base,
  binding,
  descriptor,
  lockPath,
  staleStat,
  options,
}) {
  const generation = statGeneration(staleStat);
  const claim = acquireRecoveryClaim(
    base,
    `review-snapshot-${descriptor.snapshotId.slice(5)}`,
    generation,
    {
      staleMs: 0,
      isGenerationCurrent: () => sameGenerationAt(lockPath, staleStat),
      ...(options?._recovery || {}),
    },
  );
  if (!claim.won) throw new Error('review snapshot stale-owner recovery was not elected');
  if (!sameGenerationAt(lockPath, staleStat)) {
    throw new Error('review snapshot owner changed during stale recovery');
  }
  if (existsSync(manifestPathFor(descriptor.path))) {
    throw new Error('review snapshot completed during stale recovery');
  }

  const replacementOwner = buildLockOwner(descriptor);
  const intentPath = `${lockPath}.${replacementOwner.token}.replacement`;
  let intentStat = null;
  try {
    intentStat = writeExclusiveRegularArtifact(
      intentPath,
      'review snapshot replacement lock',
      JSON.stringify(replacementOwner),
      MAX_MANIFEST_BYTES,
    );
    revalidateDirectoryBinding(binding, 'review snapshot base');
    if (!sameGenerationAt(lockPath, staleStat)) {
      throw new Error('review snapshot owner changed before stale-lock replacement');
    }
    renameSync(intentPath, lockPath);
    const replaced = lstatSync(lockPath);
    if (!sameFsObject(intentStat, replaced)) {
      throw new Error('review snapshot stale-lock replacement was not atomic');
    }
    return replaced;
  } finally {
    try {
      if (intentStat) {
        const current = lstatSync(intentPath);
        if (!current.isSymbolicLink() && sameFsObject(intentStat, current)) unlinkSync(intentPath);
      }
    } catch {}
  }
}

function validateDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 5
    || value.schemaVersion !== SCHEMA_VERSION
    || !SNAPSHOT_ID.test(value.snapshotId || '')
    || !OWNER_ID.test(value.ownerId || '')
    || !REVIEW_TREE_OID.test(value.reviewTreeOid || '')
    || typeof value.path !== 'string'
    || !path.isAbsolute(value.path)
    || value.path.includes('\0')
    || path.basename(value.path) !== value.snapshotId) {
    throw new Error('review snapshot descriptor is invalid');
  }
  return value;
}

function validateManifest(value, descriptor, repository) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 8
    || value.schemaVersion !== SCHEMA_VERSION
    || value.snapshotId !== descriptor.snapshotId
    || value.ownerId !== descriptor.ownerId
    || value.reviewTreeOid !== descriptor.reviewTreeOid
    || value.path !== descriptor.path
    || value.repository !== repository
    || value.status !== 'ready'
    || typeof value.createdAt !== 'string'
    || new Date(value.createdAt).toISOString() !== value.createdAt) {
    throw new Error('review snapshot manifest is invalid');
  }
  return value;
}

function readManifest(descriptor, repository, baseBinding) {
  revalidateDirectoryBinding(baseBinding, 'review snapshot base');
  const manifestPath = manifestPathFor(descriptor.path);
  const artifact = readRegularArtifact(
    manifestPath,
    'review snapshot manifest',
    MAX_MANIFEST_BYTES,
    { revalidateContext: () => revalidateDirectoryBinding(baseBinding, 'review snapshot base') },
  );
  let value;
  try { value = JSON.parse(artifact.text); }
  catch { throw new Error('review snapshot manifest is invalid JSON'); }
  validateManifest(value, descriptor, repository);
  revalidateRegularArtifact(
    manifestPath,
    artifact.stat,
    'review snapshot manifest',
    MAX_MANIFEST_BYTES,
  );
  revalidateDirectoryBinding(baseBinding, 'review snapshot base');
  return value;
}

function rejectUnsafeTreeEntries(repository, reviewTreeOid) {
  const listing = runGit(repository, ['ls-tree', '-r', '-z', reviewTreeOid], { encoding: 'buffer' });
  const decoded = listing.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(listing)) {
    throw new Error('review tree contains non-UTF-8 paths');
  }
  for (const record of decoded.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const header = tab < 0 ? record : record.slice(0, tab);
    const mode = header.split(' ')[0];
    // Symlinks can escape the snapshot when read; gitlinks have no tree bytes
    // for checkout-index to materialize. Both are rejected rather than faked.
    if (mode === '120000' || mode === '160000') {
      throw new Error('review tree contains a symlink or submodule and cannot be isolated safely');
    }
  }
}

function withTemporaryIndex(base, label, callback) {
  const indexPath = path.join(
    base,
    `.index-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  try {
    return callback(indexPath);
  } finally {
    try { unlinkSync(indexPath); } catch {}
    try { unlinkSync(`${indexPath}.lock`); } catch {}
  }
}

function materializeTree(repository, reviewTreeOid, snapshotPath, base) {
  rejectUnsafeTreeEntries(repository, reviewTreeOid);
  withTemporaryIndex(base, 'checkout', indexPath => {
    const env = { GIT_INDEX_FILE: indexPath };
    runGit(repository, ['read-tree', reviewTreeOid], { env });
    runGit(repository, [
      'checkout-index',
      '--all',
      '--force',
      `--prefix=${snapshotPath}${path.sep}`,
    ], { env });
  });
}

function computeSnapshotTree(repository, snapshotPath, base) {
  return withTemporaryIndex(base, 'verify', indexPath => {
    const gitDir = runGit(repository, ['rev-parse', '--absolute-git-dir']).trim();
    const env = {
      GIT_INDEX_FILE: indexPath,
      GIT_DIR: gitDir,
      GIT_WORK_TREE: snapshotPath,
    };
    runGit(repository, ['read-tree', '--empty'], { env });
    runGit(snapshotPath, ['add', '--all', '--force', '--', '.'], { env });
    return runGit(snapshotPath, ['write-tree'], { env }).trim();
  });
}

/** Re-hash the materialized bytes and prove the sidecar's exact ownership. */
export function assertReviewSnapshotCurrent(snapshot, options = {}) {
  const descriptor = validateDescriptor(snapshot);
  const repository = resolveRepository(options.cwd);
  const { base, binding } = bindBase(
    options.baseDir || path.dirname(descriptor.path),
    options.trustedRoot,
  );
  if (path.dirname(descriptor.path) !== base) throw new Error('review snapshot base mismatch');
  const expectedId = snapshotId(repository, descriptor.ownerId, descriptor.reviewTreeOid);
  if (descriptor.snapshotId !== expectedId) throw new Error('review snapshot identity mismatch');
  readManifest(descriptor, repository, binding);
  const snapshotBinding = revalidateSnapshotDirectory(descriptor.path, binding);
  const actual = computeSnapshotTree(repository, descriptor.path, base);
  revalidateDirectoryBinding(snapshotBinding, 'review snapshot directory');
  revalidateDirectoryBinding(binding, 'review snapshot base');
  if (actual !== descriptor.reviewTreeOid) {
    throw new Error('review snapshot bytes no longer match the review tree');
  }
  return true;
}

/** Create or safely resume the deterministic snapshot owned by one xval team. */
export function materializeReviewSnapshot({
  cwd,
  reviewTreeOid,
  ownerId,
  baseDir,
  trustedRoot,
  _inject,
  _recovery,
} = {}) {
  validateIdentity(reviewTreeOid, ownerId);
  const repository = resolveRepository(cwd);
  const objectType = runGit(repository, ['cat-file', '-t', reviewTreeOid]).trim();
  if (objectType !== 'tree') throw new Error('review snapshot OID is not a tree');
  const { base, binding } = bindBase(baseDir, trustedRoot);
  const id = snapshotId(repository, ownerId, reviewTreeOid);
  const snapshotPath = path.join(base, id);
  const descriptor = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    snapshotId: id,
    ownerId,
    reviewTreeOid,
    path: snapshotPath,
  });
  const manifestPath = manifestPathFor(snapshotPath);
  const lockPath = `${snapshotPath}.lock`;

  if (existsSync(manifestPath)) {
    assertReviewSnapshotCurrent(descriptor, { cwd: repository, baseDir: base, trustedRoot });
    return descriptor;
  }

  let createdStat = null;
  let lockStat = null;
  let manifestStat = null;
  try {
    revalidateDirectoryBinding(binding, 'review snapshot base');
    try {
      const lockOwner = buildLockOwner(descriptor);
      lockStat = writeExclusiveRegularArtifact(
        lockPath,
        'review snapshot owner lock',
        JSON.stringify(lockOwner),
        MAX_MANIFEST_BYTES,
      );
    } catch (error) {
      if (error?.code === 'EEXIST') {
        // The owner may have completed between our first check and O_EXCL.
        // A ready manifest can be reused; otherwise fail closed and retry later.
        if (existsSync(manifestPath)) {
          assertReviewSnapshotCurrent(descriptor, { cwd: repository, baseDir: base, trustedRoot });
          return descriptor;
        }
        const staleLock = readSnapshotLock(lockPath, descriptor, binding);
        if (!lockOwnerDefinitelyStale(staleLock.owner, _recovery)) {
          throw new Error('review snapshot materialization is already in progress');
        }
        lockStat = replaceStaleSnapshotLock({
          base,
          binding,
          descriptor,
          lockPath,
          staleStat: staleLock.stat,
          options: { _recovery },
        });
        // The replacement lock is now ours without an unlocked interval.
        // Remove only the private deterministic directory guarded by the exact
        // stale generation; manifest publication was checked above.
        if (existsSync(snapshotPath)) {
          const staleDirectory = revalidateSnapshotDirectory(snapshotPath, binding);
          revalidateDirectoryBinding(staleDirectory, 'review snapshot directory');
          rmSync(snapshotPath, { recursive: true, force: true });
          if (existsSync(snapshotPath)) {
            throw new Error('review snapshot stale partial directory cleanup failed');
          }
          revalidateDirectoryBinding(binding, 'review snapshot base');
        }
      }
      else throw error;
    }
    revalidateDirectoryBinding(binding, 'review snapshot base');
    if (typeof _inject?.afterLock === 'function') _inject.afterLock();
    if (existsSync(manifestPath)) {
      assertReviewSnapshotCurrent(descriptor, { cwd: repository, baseDir: base, trustedRoot });
      return descriptor;
    }
    if (existsSync(snapshotPath)) {
      throw new Error('review snapshot directory exists without durable ownership');
    }
    mkdirSync(snapshotPath, { mode: 0o700 });
    createdStat = lstatSync(snapshotPath);
    if (typeof _inject?.afterDirectory === 'function') _inject.afterDirectory();
    const snapshotBinding = revalidateSnapshotDirectory(snapshotPath, binding);
    materializeTree(repository, reviewTreeOid, snapshotPath, base);
    revalidateDirectoryBinding(snapshotBinding, 'review snapshot directory');
    const actual = computeSnapshotTree(repository, snapshotPath, base);
    if (actual !== reviewTreeOid) throw new Error('materialized review snapshot tree mismatch');
    const manifest = {
      ...descriptor,
      repository,
      status: 'ready',
      createdAt: new Date().toISOString(),
    };
    manifestStat = writeExclusiveRegularArtifact(
      manifestPath,
      'review snapshot manifest',
      JSON.stringify(manifest, null, 2),
      MAX_MANIFEST_BYTES,
    );
    if (typeof _inject?.afterManifest === 'function') _inject.afterManifest();
    assertReviewSnapshotCurrent(descriptor, { cwd: repository, baseDir: base, trustedRoot });
    return descriptor;
  } catch (error) {
    try {
      if (createdStat) {
        const current = lstatSync(snapshotPath);
        if (!current.isSymbolicLink()
          && current.dev === createdStat.dev
          && current.ino === createdStat.ino) {
          rmSync(snapshotPath, { recursive: true, force: true });
        }
      }
    } catch {}
    try {
      if (manifestStat) {
        const currentManifest = lstatSync(manifestPath);
        if (!currentManifest.isSymbolicLink() && sameFsObject(manifestStat, currentManifest)) {
          unlinkSync(manifestPath);
        }
      }
    } catch {}
    throw error;
  } finally {
    try {
      if (lockStat) {
        const currentLock = lstatSync(lockPath);
        if (!currentLock.isSymbolicLink() && sameFsObject(lockStat, currentLock)) {
          unlinkSync(lockPath);
        }
      }
    } catch {}
  }
}

/** Remove only the snapshot whose manifest proves the caller's exact owner. */
export function cleanupReviewSnapshot(snapshot, {
  cwd,
  ownerId,
  baseDir,
  trustedRoot,
  _recovery,
} = {}) {
  const descriptor = validateDescriptor(snapshot);
  if (ownerId !== descriptor.ownerId) throw new Error('review snapshot cleanup owner mismatch');
  const repository = resolveRepository(cwd);
  const { base, binding } = bindBase(
    baseDir || path.dirname(descriptor.path),
    trustedRoot,
  );
  if (path.dirname(descriptor.path) !== base) throw new Error('review snapshot cleanup base mismatch');
  readManifest(descriptor, repository, binding);
  const lockPath = `${descriptor.path}.lock`;
  if (existsSync(lockPath)) {
    const staleLock = readSnapshotLock(lockPath, descriptor, binding);
    if (!lockOwnerDefinitelyStale(staleLock.owner, _recovery)) {
      throw new Error('review snapshot cleanup refused a live owner lock');
    }
    const generation = statGeneration(staleLock.stat);
    const claim = acquireRecoveryClaim(
      base,
      `review-snapshot-cleanup-${descriptor.snapshotId.slice(5)}`,
      generation,
      {
        staleMs: 0,
        isGenerationCurrent: () => sameGenerationAt(lockPath, staleLock.stat),
        ...(_recovery || {}),
      },
    );
    if (!claim.won || !sameGenerationAt(lockPath, staleLock.stat)) {
      throw new Error('review snapshot cleanup did not win stale-lock recovery');
    }
    unlinkSync(lockPath);
    revalidateDirectoryBinding(binding, 'review snapshot base');
  }
  const snapshotBinding = revalidateSnapshotDirectory(descriptor.path, binding);
  const stat = lstatSync(descriptor.path);
  revalidateDirectoryBinding(snapshotBinding, 'review snapshot directory');
  rmSync(descriptor.path, { recursive: true, force: true });
  if (existsSync(descriptor.path)) throw new Error('review snapshot cleanup failed');
  revalidateDirectoryBinding(binding, 'review snapshot base');
  const manifestPath = manifestPathFor(descriptor.path);
  revalidateRegularArtifact(
    manifestPath,
    lstatSync(manifestPath),
    'review snapshot manifest',
    MAX_MANIFEST_BYTES,
  );
  unlinkSync(manifestPath);
  revalidateDirectoryBinding(binding, 'review snapshot base');
  return stat.isDirectory();
}
