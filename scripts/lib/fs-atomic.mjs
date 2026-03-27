/**
 * Atomic file write helpers for agent-olympus state files.
 * Uses a temp file + rename pattern to prevent partial writes and
 * concurrent corruption.
 */

import { writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { promises as fsp } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';

/**
 * Atomically move a file from srcPath to destPath using rename (sync).
 * rename(2) is atomic on the same filesystem, so this is safe for
 * "mark-as-processed" patterns where a crash between read and delete
 * would otherwise cause duplicate processing.
 *
 * Creates destPath's parent directory if it does not exist.
 *
 * @param {string} srcPath  - Source file path
 * @param {string} destPath - Destination file path
 */
export function atomicMoveSync(srcPath, destPath) {
  const destDir = dirname(destPath);
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true, mode: 0o700 });
  renameSync(srcPath, destPath);
}

/**
 * Atomically write content to filePath using a temp file + rename (sync).
 * Safe for use inside hooks where async is not available or desirable.
 *
 * @param {string} filePath - Destination file path
 * @param {string} content  - File content
 * @param {object} [options] - Optional overrides (encoding, mode) merged on top of defaults
 */
export function atomicWriteFileSync(filePath, content, options = {}) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  try {
    writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: 0o600, ...options });
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

/**
 * Atomically write content to filePath using a temp file + rename (async).
 * Use this in async contexts (e.g. wisdom.mjs) to avoid blocking the event loop.
 *
 * @param {string} filePath - Destination file path
 * @param {string} content  - File content
 * @param {object} [options] - Optional overrides (encoding, mode) merged on top of defaults
 */
export async function atomicWriteFile(filePath, content, options = {}) {
  const dir = dirname(filePath);
  try {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  } catch {}
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  try {
    await fsp.writeFile(tmpPath, content, { encoding: 'utf-8', mode: 0o600, ...options });
    await fsp.rename(tmpPath, filePath);
  } catch (err) {
    try { await fsp.unlink(tmpPath); } catch {}
    throw err;
  }
}
