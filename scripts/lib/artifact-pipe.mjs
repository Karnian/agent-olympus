/**
 * Cascade Artifact ARCHIVAL Pipe (v1.0.2 US-007)
 *
 * ARCHIVAL ONLY — this is NOT prompt-history isolation. Continuous-session
 * orchestrators (Atlas/Athena) cannot deliver strict prompt-history isolation;
 * that would require a fresh-process stage runner architecture which is out
 * of scope for v1.0.2 (per spec.md Non-Goals N12).
 *
 * Purpose: record each Atlas/Athena stage's outputs to
 * .ao/artifacts/pipe/<runId>/<stage>/{inbox,outbox}/ for postmortem analysis
 * and structured handoff manifests between stages.
 *
 * Key constraints:
 *  - Stage names MUST be from the canonical 6-item set (schema-validated)
 *  - Per-file 100KB cap with tail-truncation warning
 *  - Per-run 10MB cap: additional writes are dropped with a logged warning
 *  - Atomic writes via fs-atomic.mjs to prevent partial-write corruption
 *  - In-process async only — NO subagent spawns, NO child_process
 *  - Lives at .ao/artifacts/pipe/ (OUTSIDE .ao/memory/) — SessionEnd CAN sweep it after 24h
 *
 * Public API:
 *   CANONICAL_STAGES                    — string[] of the 6 allowed stage names
 *   writeOutbox(runId, stage, name, payload, opts?)
 *                                        — write to outbox dir; returns { truncated?, dropped? }
 *   readInbox(runId, stage, opts?)       — read all JSON files from inbox dir; returns Array<object>
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './fs-atomic.mjs';

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Canonical stage names allowed by the pipe.
 * Free-form names are rejected (schema validation in writeOutbox).
 */
export const CANONICAL_STAGES = ['plan', 'decompose', 'execute', 'verify', 'review', 'finish'];
const CANONICAL_STAGES_SET = new Set(CANONICAL_STAGES);

const DEFAULT_PIPE_BASE = path.join('.ao', 'artifacts', 'pipe');
const FILE_CAP_BYTES = 100 * 1024;          // 100KB per-file cap
const RUN_CAP_BYTES = 10 * 1024 * 1024;     // 10MB per-run cap

// In-memory per-run byte counter (resets when process exits).
// Each key is a runId; value is the accumulated byte count.
const _runByteCounts = new Map();

// ── Input validation ─────────────────────────────────────────────────────────

function _validateRunId(runId) {
  if (!runId || typeof runId !== 'string' || runId.trim() === '') {
    throw new Error('artifact-pipe: runId must be a non-empty string');
  }
  // Path traversal guard
  if (runId.includes('/') || runId.includes('\\') || runId.includes('..') || path.isAbsolute(runId)) {
    throw new Error(`artifact-pipe: invalid runId — path traversal not allowed: ${runId}`);
  }
}

function _validateStageName(stage) {
  if (!CANONICAL_STAGES_SET.has(stage)) {
    throw new Error(
      `artifact-pipe: invalid stage name "${stage}". ` +
      `Must be one of the canonical stages: ${CANONICAL_STAGES.join(', ')}`,
    );
  }
}

function _validateFileName(name) {
  if (!name || typeof name !== 'string' || name.trim() === '') {
    throw new Error('artifact-pipe: file name must be a non-empty string');
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..') || path.isAbsolute(name)) {
    throw new Error(`artifact-pipe: invalid file name — path traversal not allowed: ${name}`);
  }
}

// ── writeOutbox ──────────────────────────────────────────────────────────────

/**
 * Write a payload to .ao/artifacts/pipe/<runId>/<stage>/outbox/<name>.
 *
 * Each file carries schemaVersion:1 merged into the payload.
 * Applies per-file 100KB cap (with tail-truncation warning) and
 * per-run 10MB cap (drops + warning on exceed).
 *
 * @param {string} runId   - Run identifier (no path separators)
 * @param {string} stage   - Must be in CANONICAL_STAGES
 * @param {string} name    - File name (e.g. 'result.json')
 * @param {object} payload - Data to write
 * @param {{ pipeBase?: string }} [opts]
 * @returns {Promise<{ truncated?: boolean, dropped?: boolean }>}
 */
export async function writeOutbox(runId, stage, name, payload, opts = {}) {
  _validateRunId(runId);
  _validateStageName(stage);
  _validateFileName(name);

  const pipeBase = opts.pipeBase ?? DEFAULT_PIPE_BASE;
  const outboxDir = path.join(pipeBase, runId, stage, 'outbox');

  // ── Per-run cap check ──────────────────────────────────────────────────
  const runBytes = _runByteCounts.get(runId) ?? 0;
  // Build the JSON string first so we can measure its untruncated size
  const docPreCheck = { schemaVersion: 1, ...payload };
  const contentPreCheck = JSON.stringify(docPreCheck, null, 2) + '\n';
  const originalSize = Buffer.byteLength(contentPreCheck, 'utf-8');

  // Count original (untruncated) payload size against the per-run cap so that
  // truncation cannot be exploited to bypass the limit.
  if (runBytes + originalSize > RUN_CAP_BYTES) {
    // Drop this write with a warning
    try {
      process.stderr.write(
        `[artifact-pipe] run ${runId}: per-run cap (${RUN_CAP_BYTES / 1024 / 1024}MB) exceeded. ` +
        `Dropping write: ${stage}/outbox/${name}\n`,
      );
    } catch { /* fail-safe */ }
    // Still increment counter so future writes are also blocked
    _runByteCounts.set(runId, runBytes + originalSize);
    return { dropped: true };
  }

  // ── Build JSON string (reuse from pre-cap-check) ──────────────────────
  let content = contentPreCheck;
  let truncated = false;

  // ── Per-file 100KB cap ─────────────────────────────────────────────────
  if (originalSize > FILE_CAP_BYTES) {
    truncated = true;
    // Truncate at byte boundary and add a warning suffix
    const truncMsg = '\n[TRUNCATED: payload exceeded 100KB per-file cap]\n';
    const available = FILE_CAP_BYTES - Buffer.byteLength(truncMsg, 'utf-8');
    const contentBuf = Buffer.from(content, 'utf-8');
    content = contentBuf.slice(0, available).toString('utf-8') + truncMsg;

    try {
      process.stderr.write(
        `[artifact-pipe] run ${runId}: ${stage}/outbox/${name} truncated at 100KB.\n`,
      );
    } catch { /* fail-safe */ }
  }

  // ── Atomic write ───────────────────────────────────────────────────────
  try {
    await fsp.mkdir(outboxDir, { recursive: true, mode: 0o700 });
    await atomicWriteFile(path.join(outboxDir, name), content);
  } catch (err) {
    // Fail-safe — log error but do not propagate
    try {
      process.stderr.write(`[artifact-pipe] write error: ${err.message}\n`);
    } catch { /* fail-safe */ }
    return { dropped: true };
  }

  // ── Update run byte counter (use original untruncated size) ───────────
  _runByteCounts.set(runId, runBytes + originalSize);

  return truncated ? { truncated: true } : {};
}

// ── readInbox ────────────────────────────────────────────────────────────────

/**
 * Read all JSON files from .ao/artifacts/pipe/<runId>/<stage>/inbox/.
 *
 * The orchestrator is responsible for explicitly copying a prior stage's
 * outbox into the next stage's inbox (a new manifest, not symlinks), so
 * the next agent reads via tool call rather than filesystem race.
 *
 * Returns [] if the inbox dir is missing or all files are corrupt.
 * Skips files that fail to parse (fail-safe).
 *
 * @param {string} runId
 * @param {string} stage  - Must be in CANONICAL_STAGES
 * @param {{ pipeBase?: string }} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function readInbox(runId, stage, opts = {}) {
  _validateRunId(runId);
  _validateStageName(stage);

  const pipeBase = opts.pipeBase ?? DEFAULT_PIPE_BASE;
  const inboxDir = path.join(pipeBase, runId, stage, 'inbox');

  let entries;
  try {
    entries = await fsp.readdir(inboxDir);
  } catch {
    // Dir doesn't exist — return empty
    return [];
  }

  const results = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = await fsp.readFile(path.join(inboxDir, entry), 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        results.push(parsed);
      }
    } catch {
      // Skip corrupt files — fail-safe
    }
  }

  return results;
}
