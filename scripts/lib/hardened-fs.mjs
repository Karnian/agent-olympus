/**
 * Hardened filesystem primitives shared by phase and run artifacts.
 *
 * Policy differences are explicit instead of being hidden in parallel copies:
 * - phase artifacts use `object-size` generation checks for compatibility with
 *   their original dev/ino/size snapshots;
 * - run finalization uses `full` checks (mode, size, mtime, and ctime);
 * - creation paths normally require a private 0700 leaf, while read-only audit
 *   paths may opt into legacy directory modes without ever accepting symlinks;
 * - callers may provide `revalidateContext` to re-prove bound ancestry before
 *   data is exposed or after an append.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const NO_FOLLOW = fsConstants.O_NOFOLLOW || 0;
const GENERATION_POLICIES = new Set(['object', 'object-size', 'object-mode', 'full']);
export const HARDENED_FS_VIOLATION_CODE = 'AO_HARDENED_FS_VIOLATION';

function hardenedFsViolation(message) {
  const error = new Error(message);
  error.code = HARDENED_FS_VIOLATION_CODE;
  return error;
}

function assertGenerationPolicy(policy) {
  if (!GENERATION_POLICIES.has(policy)) {
    throw hardenedFsViolation('invalid file generation policy');
  }
}

/** Compare filesystem identity, including mode by default for hardened state. */
export function sameFsObject(left, right, { includeMode = true } = {}) {
  return Boolean(left && right)
    && left.dev === right.dev
    && left.ino === right.ino
    && (!includeMode || left.mode === right.mode);
}

/**
 * Compare stat snapshots under an explicit compatibility policy.
 * `object-size` is the historical phase policy; `full` is the stricter run
 * finalization policy. `object-mode` is used for directory bindings.
 */
export function sameFileGeneration(left, right, policy = 'full') {
  assertGenerationPolicy(policy);
  if (!sameFsObject(left, right, { includeMode: policy === 'object-mode' || policy === 'full' })) {
    return false;
  }
  if (policy === 'object') return true;
  if (policy === 'object-mode') return true;
  if (left.size !== right.size) return false;
  return policy !== 'full'
    || (left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs);
}

export function lstatOrMissing(path) {
  try { return lstatSync(path); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function isWithinPath(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Validate a real directory, optionally enforcing a private 0700 leaf. */
export function requireSafeDirectory(path, label, { requirePrivateMode = false } = {}) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (requirePrivateMode && process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700)) {
    throw hardenedFsViolation(`${label} is unsafe`);
  }
  return stat;
}

function trustedAnchorFor(target, explicitRoot) {
  const absoluteTarget = resolve(target);
  const candidates = explicitRoot
    ? [resolve(explicitRoot)]
    : [resolve(process.cwd()), resolve(tmpdir())];
  const matches = candidates.filter(root => isWithinPath(root, absoluteTarget));
  if (matches.length === 0) {
    throw hardenedFsViolation('finalization path is outside a trusted root');
  }
  return matches.sort((left, right) => right.length - left.length)[0];
}

/**
 * Bind every directory from a trusted anchor to a target without following a
 * symlink. Set `requirePrivateMode:false` only for legacy-compatible reads;
 * identity and ancestry checks remain mandatory in that mode.
 */
export function bindSafeDirectoryPath(target, label, {
  trustedRoot,
  requirePrivateMode = false,
} = {}) {
  const absoluteTarget = resolve(target);
  const anchor = trustedAnchorFor(absoluteTarget, trustedRoot);
  const rel = relative(anchor, absoluteTarget);
  const components = rel === '' ? [] : rel.split(sep);
  const chain = [];
  let current = anchor;
  const anchorStat = requireSafeDirectory(current, `${label} trusted root`);
  chain.push({ path: current, stat: anchorStat, privateMode: false });
  for (let index = 0; index < components.length; index += 1) {
    current = join(current, components[index]);
    const privateMode = requirePrivateMode && index === components.length - 1;
    chain.push({
      path: current,
      stat: requireSafeDirectory(current, label, { requirePrivateMode: privateMode }),
      privateMode,
    });
  }
  return { path: absoluteTarget, anchor, chain };
}

export function revalidateDirectoryBinding(binding, label) {
  for (const item of binding.chain) {
    const current = requireSafeDirectory(item.path, label, {
      requirePrivateMode: item.privateMode,
    });
    if (!sameFileGeneration(current, item.stat, 'object-mode')) {
      throw hardenedFsViolation(`${label} ancestry changed`);
    }
  }
  return true;
}

/**
 * Create missing directory components as 0700 and bind the resulting chain.
 * Creation/finalization paths keep the private leaf default; callers reading
 * pre-hardening artifacts may explicitly set `requirePrivateMode:false`.
 */
export function ensureSafeDirectoryPath(target, label, {
  trustedRoot,
  requirePrivateMode = true,
  requirePrivateAnchor = requirePrivateMode,
} = {}) {
  const absoluteTarget = resolve(target);
  const anchor = trustedAnchorFor(absoluteTarget, trustedRoot);
  const rel = relative(anchor, absoluteTarget);
  const components = rel === '' ? [] : rel.split(sep);
  const chain = [];
  let current = anchor;
  // Run creation historically hardens an anchor that is itself the target;
  // phase creation historically treats the already-trusted anchor as legacy
  // and enforces 0700 only on newly traversed leaf components.
  const privateAnchor = requirePrivateAnchor && components.length === 0;
  chain.push({
    path: current,
    stat: requireSafeDirectory(current, `${label} trusted root`, {
      requirePrivateMode: privateAnchor,
    }),
    privateMode: privateAnchor,
  });
  for (let index = 0; index < components.length; index += 1) {
    current = join(current, components[index]);
    try { mkdirSync(current, { mode: 0o700 }); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const privateMode = requirePrivateMode && index === components.length - 1;
    chain.push({
      path: current,
      stat: requireSafeDirectory(current, label, { requirePrivateMode: privateMode }),
      privateMode,
    });
  }
  const binding = { path: absoluteTarget, anchor, chain };
  revalidateDirectoryBinding(binding, label);
  return binding;
}

/** Validate a private, single-link regular artifact within a byte bound. */
export function validateRegularArtifact(stat, label, maxBytes, { allowEmpty = false } = {}) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.size > maxBytes || (!allowEmpty && stat.size <= 0)
    || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)) {
    throw hardenedFsViolation(`${label} is unsafe`);
  }
}

/**
 * Read a regular artifact through O_NOFOLLOW.
 *
 * @param {object} [options]
 * @param {boolean} [options.allowMissing=false]
 * @param {boolean} [options.allowEmpty=false] Phase callers pass true to keep
 * their historical empty-file tolerance; run artifact reads default false.
 * @param {'object'|'object-size'|'object-mode'|'full'} [options.generationPolicy='full']
 * @param {()=>unknown} [options.revalidateContext] Re-proves bound ancestry
 * after the descriptor read and before returning data.
 * @returns {{present:boolean,text:string,bytes:Buffer,stat:object|null}} The
 * decoded text plus the exact validated bytes for callers that must preserve
 * malformed encodings without a lossy UTF-8 round trip.
 */
export function readRegularArtifact(path, label, maxBytes, {
  allowMissing = false,
  allowEmpty = false,
  generationPolicy = 'full',
  revalidateContext = null,
} = {}) {
  assertGenerationPolicy(generationPolicy);
  if (revalidateContext) revalidateContext();
  const pathStat = lstatOrMissing(path);
  if (!pathStat) {
    if (allowMissing) {
      return { present: false, text: '', bytes: Buffer.alloc(0), stat: null };
    }
    throw hardenedFsViolation(`${label} is missing`);
  }
  validateRegularArtifact(pathStat, label, maxBytes, { allowEmpty });
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | NO_FOLLOW);
    const opened = fstatSync(fd);
    validateRegularArtifact(opened, label, maxBytes, { allowEmpty });
    if (!sameFileGeneration(pathStat, opened, generationPolicy)) {
      throw hardenedFsViolation(`${label} changed before open`);
    }
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count <= 0) throw hardenedFsViolation(`${label} was truncated during read`);
      offset += count;
    }
    const after = fstatSync(fd);
    if (!sameFileGeneration(opened, after, generationPolicy)) {
      throw hardenedFsViolation(`${label} changed during read`);
    }
    if (revalidateContext) revalidateContext();
    // Keep the validated original bytes alongside the decoded convenience
    // string. Forensic/quarantine callers must not round-trip malformed UTF-8
    // through replacement characters.
    return { present: true, text: buffer.toString('utf8'), bytes: buffer, stat: after };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function revalidateRegularArtifact(path, expected, label, maxBytes, {
  allowEmpty = false,
  generationPolicy = 'full',
} = {}) {
  const current = lstatSync(path);
  validateRegularArtifact(current, label, maxBytes, { allowEmpty });
  if (!sameFileGeneration(current, expected, generationPolicy)) {
    throw hardenedFsViolation(`${label} changed during finalization`);
  }
  return current;
}

/**
 * Append through O_NOFOLLOW and return the exact byte range occupied by the
 * requested content plus its post-append stat snapshot. With
 * `ensureLineBoundary`, a missing LF is inserted before content; `startOffset`
 * points after that repair byte so callers can validate only the new record.
 */
export function appendRegularArtifact(path, label, content, maxBytes, {
  generationPolicy = 'full',
  ensureLineBoundary = false,
  revalidateContext = null,
  expectedStat = undefined,
} = {}) {
  assertGenerationPolicy(generationPolicy);
  if (revalidateContext) revalidateContext();
  const before = lstatOrMissing(path);
  if (before) validateRegularArtifact(before, label, maxBytes, { allowEmpty: true });
  if (expectedStat !== undefined && (expectedStat === null
    ? before !== null
    : !sameFileGeneration(before, expectedStat, generationPolicy))) {
    throw hardenedFsViolation(`${label} changed before append`);
  }
  const bytes = Buffer.from(content, 'utf8');
  let fd;
  try {
    const access = ensureLineBoundary ? fsConstants.O_RDWR : fsConstants.O_WRONLY;
    const exclusiveCreate = expectedStat === null ? fsConstants.O_EXCL : 0;
    try {
      fd = openSync(
        path,
        access | fsConstants.O_APPEND | fsConstants.O_CREAT | exclusiveCreate | NO_FOLLOW,
        0o600,
      );
    } catch (error) {
      if (expectedStat === null && error?.code === 'EEXIST') {
        throw hardenedFsViolation(`${label} changed before append`);
      }
      throw error;
    }
    const opened = fstatSync(fd);
    validateRegularArtifact(opened, label, maxBytes, { allowEmpty: true });
    if (before && !sameFileGeneration(before, opened, generationPolicy)) {
      throw hardenedFsViolation(`${label} changed before append`);
    }

    let boundary = null;
    if (ensureLineBoundary && opened.size > 0) {
      const lastByte = Buffer.alloc(1);
      if (readSync(fd, lastByte, 0, 1, opened.size - 1) !== 1) {
        throw hardenedFsViolation(`${label} could not inspect its line boundary`);
      }
      if (lastByte[0] !== 0x0a) boundary = Buffer.from('\n');
    }
    const boundaryBytes = boundary?.length || 0;
    if (opened.size + boundaryBytes + bytes.length > maxBytes) {
      throw hardenedFsViolation(`${label} exceeds its size bound`);
    }
    if (boundary) {
      if (writeSync(fd, boundary, 0, boundary.length) !== boundary.length) {
        throw hardenedFsViolation(`${label} line boundary could not be repaired`);
      }
    }
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset);
      if (count <= 0) throw hardenedFsViolation(`${label} could not be appended`);
      offset += count;
    }
    const after = fstatSync(fd);
    validateRegularArtifact(after, label, maxBytes, { allowEmpty: true });
    const startOffset = opened.size + boundaryBytes;
    const endOffset = startOffset + bytes.length;
    if (!sameFileGeneration(opened, after, 'object-mode') || after.size !== endOffset) {
      throw hardenedFsViolation(`${label} changed during append`);
    }
    if (revalidateContext) revalidateContext();
    return {
      startOffset,
      endOffset,
      stat: after,
      boundaryRepaired: boundaryBytes === 1,
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Read only a previously appended byte range while proving the same post-write
 * generation. `requireEof` is used for terminal records so a concurrent suffix
 * cannot invalidate the invariant that run_finalized is the final event.
 */
export function readRegularArtifactRange(path, label, maxBytes, {
  startOffset,
  endOffset,
  expectedStat,
  allowEmpty = false,
  generationPolicy = 'full',
  requireEof = false,
  revalidateContext = null,
} = {}) {
  assertGenerationPolicy(generationPolicy);
  if (!Number.isSafeInteger(startOffset) || startOffset < 0
    || !Number.isSafeInteger(endOffset) || endOffset < startOffset
    || !expectedStat) throw hardenedFsViolation(`${label} range is invalid`);
  if (revalidateContext) revalidateContext();
  const pathStat = lstatSync(path);
  validateRegularArtifact(pathStat, label, maxBytes, { allowEmpty });
  if (!sameFileGeneration(pathStat, expectedStat, generationPolicy)) {
    throw hardenedFsViolation(`${label} changed before range read`);
  }
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | NO_FOLLOW);
    const opened = fstatSync(fd);
    validateRegularArtifact(opened, label, maxBytes, { allowEmpty });
    if (!sameFileGeneration(opened, expectedStat, generationPolicy)
      || endOffset > opened.size || (requireEof && endOffset !== opened.size)) {
      throw hardenedFsViolation(`${label} changed before range read`);
    }
    const buffer = Buffer.alloc(endOffset - startOffset);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(
        fd,
        buffer,
        offset,
        buffer.length - offset,
        startOffset + offset,
      );
      if (count <= 0) throw hardenedFsViolation(`${label} was truncated during range read`);
      offset += count;
    }
    const after = fstatSync(fd);
    if (!sameFileGeneration(after, expectedStat, generationPolicy)
      || (requireEof && endOffset !== after.size)) {
      throw hardenedFsViolation(`${label} changed during range read`);
    }
    if (revalidateContext) revalidateContext();
    return { text: buffer.toString('utf8'), stat: after };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Exclusively create a durable private artifact from a UTF-8 string or exact Buffer bytes. */
export function writeExclusiveRegularArtifact(path, label, content, maxBytes, {
  allowEmpty = false,
} = {}) {
  const bytes = Buffer.isBuffer(content)
    ? Buffer.from(content)
    : Buffer.from(content, 'utf8');
  if ((!allowEmpty && bytes.length <= 0) || bytes.length > maxBytes) {
    throw hardenedFsViolation(`${label} exceeds its size bound`);
  }
  let fd;
  let opened = null;
  try {
    fd = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    opened = fstatSync(fd);
    validateRegularArtifact(opened, label, maxBytes, { allowEmpty: true });
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset);
      if (count <= 0) throw hardenedFsViolation(`${label} could not be written`);
      offset += count;
    }
    fsyncSync(fd);
    const persisted = fstatSync(fd);
    validateRegularArtifact(persisted, label, maxBytes, { allowEmpty });
    if (!sameFileGeneration(opened, persisted, 'object-mode') || persisted.size !== bytes.length) {
      throw hardenedFsViolation(`${label} was not durable`);
    }
    return persisted;
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
      fd = undefined;
    }
    if (opened) {
      try {
        const current = lstatSync(path);
        if (!current.isSymbolicLink() && sameFileGeneration(opened, current, 'object-mode')) {
          unlinkSync(path);
        }
      } catch {}
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
