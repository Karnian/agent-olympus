/**
 * Durable memory namespace for agent-olympus (v1.0.2 F-002)
 *
 * Provides `.ao/memory/` — a namespace for long-lived, worktree-shared
 * learning/preference data that must survive SessionEnd's 24h cleanup.
 * Mirrors scripts/lib/wisdom.mjs's git-common-dir resolution so Athena
 * workers in worktrees see the same memory as the host project.
 *
 * Public API:
 *   resolveMemoryDir()              → absolute path of .ao/memory/ at project root
 *   memoryFilePath(name)            → absolute path under memory dir
 *   isMemoryDisabled(cwd?)          → reads autonomy.json { memory: { disabled } }
 *   readJsonFile(name)              → read & parse JSON; returns {} on any error
 *   writeJsonFile(name, data)       → atomic JSON write with mode 0o600
 *   readJsonlFile(name)             → read JSONL; returns [] on any error
 *   appendJsonlLine(name, entry)    → append a single JSON-serialized line
 *   writeJsonlFile(name, entries)   → atomic full rewrite (FIFO pruning etc.)
 *
 * Behavior & constraints (per prd.json F-002 acceptance criteria):
 *   - ALL paths resolve via resolveMemoryDir() (git-common-dir → worktree share)
 *   - Loaders are fail-safe: corrupted files/missing dirs → empty default
 *   - Loaders NEVER create the memory directory — only writers do
 *   - schemaVersion > 1 on any loaded file → return empty default (forward compat)
 *   - autonomy.json { memory: { disabled: true } } → all loaders short-circuit
 *     to empty default without touching disk
 *   - File mode 0o600, directory mode 0o700
 *   - NEVER throws
 */

import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { atomicWriteFile } from './fs-atomic.mjs';

const KNOWN_SCHEMA_VERSION = 1;

// -----------------------------------------------------------------------------
// Project root resolution (mirrors wisdom.mjs)
// -----------------------------------------------------------------------------

function resolveProjectRoot() {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return path.resolve(commonDir, '..');
  } catch {
    return process.cwd();
  }
}

/**
 * Resolve the project root on every call. We intentionally do NOT cache
 * this value because .ao/memory/ is consumed by hooks that run in a
 * fresh Node process per invocation — the cost is bounded to one git
 * rev-parse per hook run (~5ms). Avoiding cache also keeps test semantics
 * predictable under chdir() between cases and under module-cache busting.
 */
function getProjectRoot() {
  return resolveProjectRoot();
}

/**
 * No-op retained for backwards compat with early test drafts.
 */
export function _resetProjectRootCache() { /* no cache */ }

/**
 * Absolute path to the .ao/memory/ directory at the project root.
 * In a worktree this returns the HOST project's memory dir, not the
 * worktree-local one — guaranteeing all Athena workers share memory.
 *
 * @returns {string}
 */
export function resolveMemoryDir() {
  return path.join(getProjectRoot(), '.ao', 'memory');
}

/**
 * Absolute path to a file under the memory directory.
 * Hardened against path traversal: rejects '..', '/', and absolute paths.
 *
 * @param {string} name - bare filename (e.g. 'design-identity.json')
 * @returns {string}
 * @throws {Error} on illegal filename
 */
export function memoryFilePath(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`memoryFilePath: invalid name (${name})`);
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..') || path.isAbsolute(name)) {
    throw new Error(`memoryFilePath: illegal filename (must be a bare filename): ${name}`);
  }
  return path.join(resolveMemoryDir(), name);
}

// -----------------------------------------------------------------------------
// Autonomy disable flag
// -----------------------------------------------------------------------------

/**
 * Check autonomy.json for { memory: { disabled: true } } so loaders can
 * short-circuit without any disk I/O under the memory dir.
 *
 * Uses a lightweight direct read rather than importing autonomy.mjs to avoid
 * a circular import when autonomy.mjs ever consumes memory loaders.
 *
 * @param {string} [cwd=process.cwd()]
 * @returns {boolean}
 */
export function isMemoryDisabled(cwd = process.cwd()) {
  try {
    const raw = readFileSync(path.join(cwd, '.ao', 'autonomy.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed?.memory?.disabled === true;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// JSON read/write
// -----------------------------------------------------------------------------

/**
 * Read a JSON file under the memory dir.
 * Returns {} on: file missing, parse error, memory disabled, or
 * schemaVersion > KNOWN_SCHEMA_VERSION.
 *
 * @param {string} name
 * @returns {Promise<object>}
 */
export async function readJsonFile(name) {
  try {
    if (isMemoryDisabled()) return {};
    const filePath = memoryFilePath(name);
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const ver = parsed.schemaVersion;
    if (typeof ver === 'number' && ver > KNOWN_SCHEMA_VERSION) {
      // Forward-compat fail-safe: refuse to load unknown-future schemas, but
      // emit a clear stderr line so the operator knows why the file is empty.
      try {
        process.stderr.write(
          `[memory] ${name}: refusing to load schemaVersion=${ver} (> known=${KNOWN_SCHEMA_VERSION}); upgrade required.\n`,
        );
      } catch { /* fail-safe */ }
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

/**
 * Atomic JSON write under the memory dir.
 * Creates the memory directory with mode 0o700 if missing. Writes with 0o600.
 * The caller is responsible for including schemaVersion in `data`.
 *
 * @param {string} name
 * @param {object} data
 * @returns {Promise<boolean>} true on success, false on failure
 */
export async function writeJsonFile(name, data) {
  try {
    if (isMemoryDisabled()) return false;
    const dir = resolveMemoryDir();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const filePath = memoryFilePath(name);
    await atomicWriteFile(filePath, JSON.stringify(data, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// JSONL read/append/rewrite
// -----------------------------------------------------------------------------

/**
 * Read all valid lines from a JSONL file under the memory dir.
 * Lines that fail to parse or have schemaVersion > KNOWN_SCHEMA_VERSION are skipped.
 * Returns [] on any error, memory disabled, or missing file.
 *
 * @param {string} name
 * @returns {Promise<Array<object>>}
 */
export async function readJsonlFile(name) {
  try {
    if (isMemoryDisabled()) return [];
    const filePath = memoryFilePath(name);
    const content = await fs.readFile(filePath, 'utf-8');
    const out = [];
    let forwardSchemaSkipped = 0;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== 'object') continue;
        const ver = parsed.schemaVersion;
        if (typeof ver === 'number' && ver > KNOWN_SCHEMA_VERSION) {
          forwardSchemaSkipped += 1;
          continue;
        }
        out.push(parsed);
      } catch {
        // Skip malformed lines
      }
    }
    if (forwardSchemaSkipped > 0) {
      try {
        process.stderr.write(
          `[memory] ${name}: skipped ${forwardSchemaSkipped} line(s) with schemaVersion > ${KNOWN_SCHEMA_VERSION} (forward-compat).\n`,
        );
      } catch { /* fail-safe */ }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Append a single JSON-serialized line to a JSONL file under the memory dir.
 * Creates the dir/file as needed.
 *
 * @param {string} name
 * @param {object} entry
 * @returns {Promise<boolean>}
 */
export async function appendJsonlLine(name, entry) {
  try {
    if (isMemoryDisabled()) return false;
    const dir = resolveMemoryDir();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const filePath = memoryFilePath(name);
    await fs.appendFile(filePath, JSON.stringify(entry) + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomic full rewrite of a JSONL file under the memory dir. Used for FIFO
 * pruning and explicit `prune` operations.
 *
 * @param {string} name
 * @param {Array<object>} entries
 * @returns {Promise<boolean>}
 */
export async function writeJsonlFile(name, entries) {
  try {
    if (isMemoryDisabled()) return false;
    const dir = resolveMemoryDir();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const filePath = memoryFilePath(name);
    const content = entries.length
      ? entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
      : '';
    await atomicWriteFile(filePath, content);
    return true;
  } catch {
    return false;
  }
}
