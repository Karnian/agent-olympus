import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ALLOWED_ROOT_ENTRIES = new Set([
  '.claude-plugin',
  '.mcp.json',
  'agents',
  'config',
  'hooks',
  'package.json',
  'schemas',
  'scripts',
  'skills',
]);
const COPY_BUFFER_BYTES = 64 * 1024;

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function assertWithin(root, candidate, label) {
  if (!isWithin(root, candidate)) {
    throw new Error(`${label} escapes the plugin snapshot root: ${candidate}`);
  }
}

function isExcluded(relativePath, includeHooks) {
  const components = relativePath.split(path.sep);
  if (!ALLOWED_ROOT_ENTRIES.has(components[0])) return true;
  if (!includeHooks && components[0] === 'hooks') return true;
  // Runtime hook/adapter code is required, but its repository tests are not
  // part of the installed plugin and can leak fixture-specific knowledge.
  return components[0] === 'scripts' && components[1] === 'test';
}

function copyRegularFile(sourcePath, destinationPath) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let sourceFd;
  let destinationFd;

  try {
    sourceFd = openSync(sourcePath, constants.O_RDONLY | noFollow);
    const sourceStats = fstatSync(sourceFd);
    if (!sourceStats.isFile()) {
      throw new Error(`Refusing to stage non-regular file: ${sourcePath}`);
    }

    const destinationMode = (sourceStats.mode & 0o111) === 0 ? 0o600 : 0o700;
    destinationFd = openSync(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      destinationMode,
    );

    const contentHash = createHash('sha256');
    let size = 0;
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    while (true) {
      const bytesRead = readSync(sourceFd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;

      let offset = 0;
      while (offset < bytesRead) {
        const bytesWritten = writeSync(destinationFd, buffer, offset, bytesRead - offset);
        if (bytesWritten === 0) throw new Error(`Unable to copy file: ${sourcePath}`);
        offset += bytesWritten;
      }
      contentHash.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
    chmodSync(destinationPath, destinationMode);
    return {
      contentFingerprint: contentHash.digest('hex'),
      mode: destinationMode,
      size,
    };
  } finally {
    if (destinationFd !== undefined) closeSync(destinationFd);
    if (sourceFd !== undefined) closeSync(sourceFd);
  }
}

function toPosixPath(relativePath) {
  return relativePath.split(path.sep).join(path.posix.sep);
}

function fingerprintStagedFiles(files) {
  const hash = createHash('sha256');
  hash.update('agent-olympus-eval-plugin-snapshot-v1\0');
  for (const file of files) {
    hash.update(JSON.stringify([
      file.relativePath,
      file.mode.toString(8).padStart(4, '0'),
      file.size,
      file.contentFingerprint,
    ]));
    hash.update('\n');
  }
  return hash.digest('hex');
}

function copyTree(sourceRoot, destinationRoot, options, relativeDir = '') {
  const sourceDir = path.join(sourceRoot, relativeDir);
  const entries = readdirSync(sourceDir).sort();

  for (const name of entries) {
    const relativePath = path.join(relativeDir, name);
    if (isExcluded(relativePath, options.includeHooks)) continue;

    const sourcePath = path.join(sourceRoot, relativePath);
    const destinationPath = path.join(destinationRoot, relativePath);
    assertWithin(sourceRoot, sourcePath, 'Source path');
    assertWithin(destinationRoot, destinationPath, 'Destination path');

    const stats = lstatSync(sourcePath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing to stage symbolic link: ${relativePath}`);
    }

    const canonicalSourcePath = realpathSync(sourcePath);
    assertWithin(sourceRoot, canonicalSourcePath, 'Canonical source path');

    if (stats.isDirectory()) {
      mkdirSync(destinationPath, { mode: 0o700 });
      chmodSync(destinationPath, 0o700);
      copyTree(sourceRoot, destinationRoot, options, relativePath);
      continue;
    }

    if (!stats.isFile()) {
      throw new Error(`Refusing to stage non-regular entry: ${relativePath}`);
    }
    const copied = copyRegularFile(sourcePath, destinationPath);
    options.files.push({
      relativePath: toPosixPath(relativePath),
      ...copied,
    });
  }
}

/**
 * Copy a plugin into a private, disposable snapshot for a live eval.
 *
 * Only runtime plugin roots are copied; eval oracles, docs, repository tests,
 * and mutable project state are omitted. Included symlinks are rejected so
 * ordinary path traversal cannot escape the selected source tree. This only
 * reduces accidental oracle discovery; it is not an OS
 * sandbox or a security boundary against malicious code or concurrent source
 * tree mutation.
 *
 * @param {string} sourcePluginDir Plugin repository to snapshot.
 * @param {{tempParent?: string,includeHooks?: boolean}} [options] Snapshot options.
 * @returns {{pluginDir:string,tempRoot:string,cleanup:() => void,fingerprint:string,fileFingerprints:Readonly<Record<string,string>>}}
 */
export function stagePluginSnapshot(sourcePluginDir, options = {}) {
  if (typeof sourcePluginDir !== 'string' || sourcePluginDir.trim() === '') {
    throw new TypeError('sourcePluginDir must be a non-empty string');
  }
  const includeHooks = options.includeHooks ?? true;
  if (typeof includeHooks !== 'boolean') {
    throw new TypeError('includeHooks must be a boolean');
  }

  const requestedRoot = path.resolve(sourcePluginDir);
  const rootStats = lstatSync(requestedRoot);
  if (rootStats.isSymbolicLink()) {
    throw new Error(`Refusing to stage a symbolic-link plugin root: ${requestedRoot}`);
  }
  if (!rootStats.isDirectory()) {
    throw new Error(`Plugin root must be a directory: ${requestedRoot}`);
  }
  const sourceRoot = realpathSync(requestedRoot);

  const requestedTempParent = options.tempParent === undefined
    ? tmpdir()
    : path.resolve(options.tempParent);
  const tempParent = realpathSync(requestedTempParent);
  if (isWithin(sourceRoot, tempParent)) {
    throw new Error('tempParent must not be inside the source plugin tree');
  }

  const tempRoot = mkdtempSync(path.join(tempParent, 'ao-eval-plugin-'));
  const pluginDir = path.join(tempRoot, 'plugin');
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    rmSync(tempRoot, { recursive: true, force: true });
    cleaned = true;
  };

  try {
    chmodSync(tempRoot, 0o700);
    mkdirSync(pluginDir, { mode: 0o700 });
    chmodSync(pluginDir, 0o700);
    const files = [];
    copyTree(sourceRoot, pluginDir, { includeHooks, files });
    files.sort((a, b) => (
      a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0
    ));
    const fileFingerprints = Object.freeze(Object.fromEntries(
      files.map(file => [file.relativePath, file.contentFingerprint]),
    ));
    return {
      pluginDir,
      tempRoot,
      cleanup,
      fingerprint: fingerprintStagedFiles(files),
      fileFingerprints,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
