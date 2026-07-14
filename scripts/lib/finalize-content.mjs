/**
 * Crash-resumable final-content writers used by Atlas and Athena.
 *
 * Finalize phases are intentionally re-executed after an interrupted run. Each
 * mutation therefore carries a run-scoped marker and replaces its own prior
 * value instead of appending a duplicate.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import {
  bindSafeDirectoryPath,
  isWithinPath,
  lstatOrMissing,
  revalidateDirectoryBinding,
  sameFileGeneration,
} from './hardened-fs.mjs';

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NO_FOLLOW = fsConstants.O_NOFOLLOW || 0;
const CHANGELOG_MAX_BYTES = 4 * 1024 * 1024;
const TRACKER_MAX_BYTES = 2 * 1024 * 1024;

function assertRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    throw new TypeError('runId must be a safe non-empty identifier of at most 128 characters');
  }
}

function assertSafeDocumentStat(stat, label, maxBytes) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.size > maxBytes
    || (process.platform !== 'win32' && ((stat.mode & 0o022) !== 0 || (stat.mode & 0o111) !== 0))) {
    throw new Error(`${label} is not a bounded, non-writable regular document`);
  }
}

function bindDocumentPath(filePath, cwd, label) {
  const root = resolve(cwd);
  const target = resolve(root, filePath);
  if (target === root || !isWithinPath(root, target)) {
    throw new Error(`${label} must stay inside cwd`);
  }
  const directory = bindSafeDirectoryPath(dirname(target), `${label} directory`, {
    trustedRoot: root,
    requirePrivateMode: false,
  });
  return { root, target, directory };
}

function readOptionalDocument(filePath, cwd, label, maxBytes) {
  const bound = bindDocumentPath(filePath, cwd, label);
  revalidateDirectoryBinding(bound.directory, `${label} directory`);
  const pathStat = lstatOrMissing(bound.target);
  if (!pathStat) return { ...bound, present: false, text: '', stat: null };
  assertSafeDocumentStat(pathStat, label, maxBytes);

  let fd;
  try {
    fd = openSync(bound.target, fsConstants.O_RDONLY | NO_FOLLOW);
    const opened = fstatSync(fd);
    assertSafeDocumentStat(opened, label, maxBytes);
    if (!sameFileGeneration(pathStat, opened, 'full')) {
      throw new Error(`${label} changed before open`);
    }
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count <= 0) throw new Error(`${label} was truncated during read`);
      offset += count;
    }
    const after = fstatSync(fd);
    if (!sameFileGeneration(opened, after, 'full')) {
      throw new Error(`${label} changed during read`);
    }
    revalidateDirectoryBinding(bound.directory, `${label} directory`);
    return { ...bound, present: true, text: buffer.toString('utf8'), stat: after };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeDocument(bound, content, label, maxBytes) {
  const size = Buffer.byteLength(content, 'utf8');
  if (size > maxBytes) throw new Error(`${label} exceeds its size bound`);
  revalidateDirectoryBinding(bound.directory, `${label} directory`);
  const current = lstatOrMissing(bound.target);
  if (bound.stat === null ? current !== null : !sameFileGeneration(bound.stat, current, 'full')) {
    throw new Error(`${label} changed before write`);
  }
  const mode = bound.stat === null ? 0o644 : (bound.stat.mode & 0o777);
  atomicWriteFileSync(bound.target, content, { durable: true, mode });
  const written = lstatOrMissing(bound.target);
  if (!written) throw new Error(`${label} disappeared after write`);
  assertSafeDocumentStat(written, label, maxBytes);
  revalidateDirectoryBinding(bound.directory, `${label} directory`);
}

function markerPair(runId, kind) {
  assertRunId(runId);
  return {
    start: `<!-- ao-finalize:${runId}:${kind}:start -->`,
    end: `<!-- ao-finalize:${runId}:${kind}:end -->`,
  };
}

function replaceMarkedBlock(existing, content, markers) {
  const startIndex = existing.indexOf(markers.start);
  const secondStart = startIndex < 0 ? -1 : existing.indexOf(markers.start, startIndex + 1);
  const endIndex = existing.indexOf(markers.end);
  const secondEnd = endIndex < 0 ? -1 : existing.indexOf(markers.end, endIndex + 1);

  if (startIndex < 0 && endIndex < 0) return null;
  if (
    startIndex < 0 || endIndex < startIndex || secondStart >= 0 || secondEnd >= 0
  ) {
    throw new Error('finalize marker block is missing, duplicated, or out of order');
  }

  const replacement = `${markers.start}\n${content.trim()}\n${markers.end}`;
  return `${existing.slice(0, startIndex)}${replacement}${existing.slice(endIndex + markers.end.length)}`;
}

function countUnescapedPipes(row) {
  let count = 0;
  for (let index = 0; index < row.length; index += 1) {
    if (row[index] !== '|') continue;
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && row[cursor] === '\\'; cursor -= 1) {
      slashes += 1;
    }
    if (slashes % 2 === 0) count += 1;
  }
  return count;
}

function decorateTrackerRow(row, markers) {
  const withoutClosingPipe = row.slice(0, -1).trimEnd();
  return `${withoutClosingPipe} ${markers.start}${markers.end} |`;
}

/** Replace either the current inline marker row or the pre-fix three-line block. */
function replaceMarkedTrackerRow(existing, row, markers) {
  const startIndex = existing.indexOf(markers.start);
  const secondStart = startIndex < 0 ? -1 : existing.indexOf(markers.start, startIndex + 1);
  const endIndex = existing.indexOf(markers.end);
  const secondEnd = endIndex < 0 ? -1 : existing.indexOf(markers.end, endIndex + 1);
  if (startIndex < 0 && endIndex < 0) return null;
  if (startIndex < 0 || endIndex < startIndex || secondStart >= 0 || secondEnd >= 0) {
    throw new Error('finalize marker row is missing, duplicated, or out of order');
  }

  const lineStart = existing.lastIndexOf('\n', startIndex - 1) + 1;
  const newlineAfterEnd = existing.indexOf('\n', endIndex + markers.end.length);
  const lineEnd = newlineAfterEnd < 0 ? existing.length : newlineAfterEnd;
  return `${existing.slice(0, lineStart)}${decorateTrackerRow(row, markers)}${existing.slice(lineEnd)}`;
}

/**
 * Insert or replace one run-owned changelog entry.
 *
 * @param {string} filePath
 * @param {string} entry Keep-a-Changelog entry beginning with `## `
 * @param {{ runId: string, cwd?: string }} options
 */
export function upsertChangelogEntry(filePath, entry, { runId, cwd = process.cwd() } = {}) {
  if (typeof entry !== 'string' || !entry.trim().startsWith('## ')) {
    throw new TypeError('entry must be a non-empty changelog section beginning with "## "');
  }
  const markers = markerPair(runId, 'changelog');
  const block = `${markers.start}\n${entry.trim()}\n${markers.end}`;
  const document = readOptionalDocument(filePath, cwd, 'changelog', CHANGELOG_MAX_BYTES);
  const existing = document.present ? document.text : null;

  if (existing === null) {
    writeDocument(document, `# Changelog\n\n${block}\n`, 'changelog', CHANGELOG_MAX_BYTES);
    return;
  }

  const replaced = replaceMarkedBlock(existing, entry, markers);
  if (replaced !== null) {
    writeDocument(document, replaced, 'changelog', CHANGELOG_MAX_BYTES);
    return;
  }

  const lines = existing.split('\n');
  const firstVersion = lines.findIndex(line => line.startsWith('## '));
  if (firstVersion < 0) {
    const prefix = existing.trimEnd();
    writeDocument(
      document,
      `${prefix}${prefix ? '\n\n' : ''}${block}\n`,
      'changelog',
      CHANGELOG_MAX_BYTES,
    );
    return;
  }
  lines.splice(firstVersion, 0, ...`${block}\n`.split('\n'));
  writeDocument(document, lines.join('\n'), 'changelog', CHANGELOG_MAX_BYTES);
}

/**
 * Insert or replace one run-owned Markdown tech-debt tracker row.
 *
 * @param {string} filePath
 * @param {string} row A single Markdown table row
 * @param {{ runId: string, cwd?: string }} options
 */
export function upsertTechDebtTrackerRow(filePath, row, { runId, cwd = process.cwd() } = {}) {
  const normalizedRow = typeof row === 'string' ? row.trim() : '';
  if (
    typeof row !== 'string' || row.includes('\n') ||
    !normalizedRow.startsWith('|') || !normalizedRow.endsWith('|') ||
    /<!--\s*ao-finalize:/i.test(normalizedRow) ||
    countUnescapedPipes(normalizedRow) !== 6
  ) {
    throw new TypeError('row must be one safe five-column Markdown table row');
  }
  const markers = markerPair(runId, 'tech-debt');
  const markedRow = decorateTrackerRow(normalizedRow, markers);
  const document = readOptionalDocument(filePath, cwd, 'tech-debt tracker', TRACKER_MAX_BYTES);
  const existing = document.present ? document.text : null;

  if (existing === null) {
    const header = '# Tech Debt Tracker\n\n| Date | Task | Files | Stories | Notes |\n' +
      '|------|------|-------|---------|-------|';
    writeDocument(document, `${header}\n${markedRow}\n`, 'tech-debt tracker', TRACKER_MAX_BYTES);
    return;
  }

  const replaced = replaceMarkedTrackerRow(existing, normalizedRow, markers);
  if (replaced !== null) {
    writeDocument(document, replaced, 'tech-debt tracker', TRACKER_MAX_BYTES);
    return;
  }

  const prefix = existing.trimEnd();
  writeDocument(
    document,
    `${prefix}${prefix ? '\n' : ''}${markedRow}\n`,
    'tech-debt tracker',
    TRACKER_MAX_BYTES,
  );
}
