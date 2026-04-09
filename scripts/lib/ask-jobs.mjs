/**
 * scripts/lib/ask-jobs.mjs — Pure helpers for the job-based `/ask` system.
 *
 * See docs/plans/ask-job-based/spec.md (rev 4, APPROVED) for the full design.
 *
 * This module is the "single-writer" rule's storage layer: every writer/reader
 * of `.ao/state/ask-jobs/<jobId>.json` goes through these helpers. All helpers
 * are dependency-light (Node built-ins only), pure where possible, and carry
 * injection seams for tests (`_inject*`).
 *
 * Exports:
 *   - allocateJobId(adapterName, clock?)            → jobId string
 *   - computePromptHash(model, prompt)              → sha256 hex
 *   - metadataPath(jobId, cwd?)                     → absolute path
 *   - promptPath(jobId, cwd?)                       → absolute path
 *   - artifactJsonlPath(jobId, cwd?)                → absolute path
 *   - artifactMdPath(jobId, cwd?)                   → absolute path
 *   - ensureJobDirs(cwd?)                           → mkdirs (idempotent)
 *   - writeMetadata(jobId, meta, opts?)             → atomic tmp+rename
 *   - readMetadata(jobId, opts?)                    → meta | null
 *   - writePromptFile(jobId, prompt, opts?)         → path
 *   - readAndUnlinkPromptFile(jobId, opts?)         → prompt string
 *   - writeRunnerSentinel(jsonlPath, sentinelData)  → appendFileSync (sync)
 *   - jsonlFindRunnerSentinel(jsonlPath)            → sentinel object | null
 *   - isProcessAlive(pid, _killImpl?)               → bool
 *   - reconcileStatus(meta, opts?)                  → { status, error? }
 *   - maybeFlushMetadata(meta, flushImpl, clock?)   → bool (flushed)
 *   - parseAskArgs(argv)                            → dispatch descriptor
 *   - listJobs(opts?)                               → meta[]
 *
 * Test injection seams:
 *   - _injectClock(fn): overrides the Date-returning clock
 *   - _injectLiveness(map): overrides isProcessAlive; map is { [pid]: bool }
 *   - _injectRandom(fn): overrides the jobId random suffix source
 *
 * Schema version: 1. A `schemaVersion` field is included in every metadata
 * write and every runner sentinel. Loaders refuse `schemaVersion > 1` and
 * return the empty default (null) instead, per the project convention.
 */

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  unlinkSync,
  readdirSync,
  appendFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const SCHEMA_VERSION = 1;
const JOB_STATE_DIR = '.ao/state/ask-jobs';
const JOB_ARTIFACT_DIR = '.ao/artifacts/ask';

// ───── Test injection seams ─────────────────────────────────────────────────

let _clock = () => new Date();
let _livenessMap = null;
let _random = (n) => randomBytes(n);

/** Override the clock. Pass `null` or no arg to reset. */
export function _injectClock(fn) {
  _clock = typeof fn === 'function' ? fn : () => new Date();
}

/**
 * Override isProcessAlive for tests. Pass `{ [pid]: true|false }` or `null`
 * to reset. A pid not in the map reverts to the real `process.kill(pid, 0)`.
 */
export function _injectLiveness(map) {
  _livenessMap = map && typeof map === 'object' ? map : null;
}

/** Override the random-byte source for jobId allocation. */
export function _injectRandom(fn) {
  _random = typeof fn === 'function' ? fn : (n) => randomBytes(n);
}

// ───── Path helpers ─────────────────────────────────────────────────────────

/** Return `<cwd>/.ao/state/ask-jobs/<jobId>.json` */
export function metadataPath(jobId, cwd = process.cwd()) {
  return join(cwd, JOB_STATE_DIR, `${jobId}.json`);
}

/** Return `<cwd>/.ao/state/ask-jobs/<jobId>.prompt` */
export function promptPath(jobId, cwd = process.cwd()) {
  return join(cwd, JOB_STATE_DIR, `${jobId}.prompt`);
}

/** Return `<cwd>/.ao/artifacts/ask/<jobId>.jsonl` */
export function artifactJsonlPath(jobId, cwd = process.cwd()) {
  return join(cwd, JOB_ARTIFACT_DIR, `${jobId}.jsonl`);
}

/** Return `<cwd>/.ao/artifacts/ask/<jobId>.md` */
export function artifactMdPath(jobId, cwd = process.cwd()) {
  return join(cwd, JOB_ARTIFACT_DIR, `${jobId}.md`);
}

/**
 * Create `.ao/state/ask-jobs/` and `.ao/artifacts/ask/` with mode 0o700.
 * Idempotent — safe to call from every code path.
 */
export function ensureJobDirs(cwd = process.cwd()) {
  mkdirSync(join(cwd, JOB_STATE_DIR), { recursive: true, mode: 0o700 });
  mkdirSync(join(cwd, JOB_ARTIFACT_DIR), { recursive: true, mode: 0o700 });
}

// ───── jobId allocation ─────────────────────────────────────────────────────

/**
 * Allocate a jobId: `ask-<label>-YYYYMMDD-HHMMSS-XXXX`.
 * `label` is derived from adapterName (`codex-exec` → `codex`).
 */
export function allocateJobId(adapterName) {
  const label =
    adapterName === 'codex-exec' ? 'codex' :
    adapterName === 'gemini-exec' ? 'gemini' :
    'ask';
  const now = _clock();
  const pad = (n) => String(n).padStart(2, '0');
  const ts =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = _random(2).toString('hex');
  return `ask-${label}-${ts}-${rand}`;
}

/** `sha256(model + '\n' + prompt)` as lowercase hex. */
export function computePromptHash(model, prompt) {
  return createHash('sha256').update(`${model}\n${prompt}`).digest('hex');
}

// ───── Metadata I/O (atomic, single-writer enforced by convention) ─────────

/**
 * Atomic write via tmp+rename. File mode 0o600, parent dir 0o700.
 * Always injects `schemaVersion: 1` into the written object.
 */
export function writeMetadata(jobId, meta, { cwd = process.cwd() } = {}) {
  ensureJobDirs(cwd);
  const path = metadataPath(jobId, cwd);
  const payload = { schemaVersion: SCHEMA_VERSION, ...meta, jobId };
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

/**
 * Read metadata. Returns `null` on ENOENT or malformed JSON or unknown
 * schemaVersion. Never throws — callers handle null explicitly.
 */
export function readMetadata(jobId, { cwd = process.cwd() } = {}) {
  const path = metadataPath(jobId, cwd);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    // Forward-compat: refuse unknown schemaVersion per CLAUDE.md convention.
    if (typeof parsed.schemaVersion === 'number' && parsed.schemaVersion > SCHEMA_VERSION) {
      process.stderr.write(
        `[ask-jobs] refusing metadata ${jobId}: schemaVersion=${parsed.schemaVersion} > ${SCHEMA_VERSION}\n`
      );
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// ───── Prompt sidecar ───────────────────────────────────────────────────────

export function writePromptFile(jobId, prompt, { cwd = process.cwd() } = {}) {
  ensureJobDirs(cwd);
  const path = promptPath(jobId, cwd);
  writeFileSync(path, prompt, { mode: 0o600 });
  return path;
}

/**
 * Read the prompt sidecar, delete it, return the prompt.
 * Throws ENOENT if missing — the runner converts that to exit 1.
 */
export function readAndUnlinkPromptFile(jobId, { cwd = process.cwd() } = {}) {
  const path = promptPath(jobId, cwd);
  const prompt = readFileSync(path, 'utf-8');
  try { unlinkSync(path); } catch {}
  return prompt;
}

// ───── Runner sentinel (adapter-agnostic completion oracle) ────────────────

/**
 * Append a `runner_done` sentinel line to the JSONL artifact via SYNCHRONOUS
 * appendFileSync. Bypasses any WriteStream buffer so the bytes hit disk
 * before `process.exit(0)` can race the flush.
 *
 * Spec rev 4 §4.3.2. `data.reason` is 'completed' | 'failed' | 'cancelled'.
 * The sentinel carries `text` verbatim (handle._output) so `collect`
 * fallback synthesis is adapter-agnostic.
 */
export function writeRunnerSentinel(jsonlPath, data) {
  const line = {
    schemaVersion: SCHEMA_VERSION,
    type: 'runner_done',
    status: data.reason || 'failed',
    ts: _clock().toISOString(),
    text: typeof data.text === 'string' ? data.text : '',
  };
  if (data.category) line.category = data.category;
  if (data.message) line.message = data.message;
  if (typeof data.bytes === 'number') line.bytes = data.bytes;

  try {
    mkdirSync(dirname(jsonlPath), { recursive: true, mode: 0o700 });
    appendFileSync(jsonlPath, JSON.stringify(line) + '\n', { mode: 0o600 });
  } catch (err) {
    // Last-resort: the runner has no place to report this. Swallow and
    // let reconciliation fall back to 'crashed'.
    try {
      process.stderr.write(`[ask-jobs] sentinel write failed: ${err.message}\n`);
    } catch {}
  }
  return line;
}

/**
 * Scan a JSONL file for the last `runner_done` sentinel.
 * Returns the parsed object or `null`.
 *
 * Reads the whole file (small, typically < 1 MB). Scans lines back-to-front
 * to find the final sentinel if multiple were written (shouldn't happen given
 * the once-only finalize flag, but cheap insurance).
 */
export function jsonlFindRunnerSentinel(jsonlPath) {
  if (!existsSync(jsonlPath)) return null;
  let raw;
  try { raw = readFileSync(jsonlPath, 'utf-8'); }
  catch { return null; }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && obj.type === 'runner_done') return obj;
    } catch { /* skip malformed */ }
  }
  return null;
}

// ───── Process liveness ─────────────────────────────────────────────────────

/**
 * `process.kill(pid, 0)` semantics: success=alive, ENOENT/ESRCH=dead,
 * EPERM=alive (cross-uid; we cannot signal but the process exists).
 * Invalid pid (0, negative, non-finite) → false.
 *
 * Test injection: `_injectLiveness({123: true, 456: false})` overrides the
 * real syscall for mapped pids. Unmapped pids still use the real kill call.
 */
export function isProcessAlive(pid, _killImpl = null) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (_livenessMap && Object.prototype.hasOwnProperty.call(_livenessMap, pid)) {
    return !!_livenessMap[pid];
  }
  const kill = _killImpl || process.kill.bind(process);
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

// ───── Status reconciliation ────────────────────────────────────────────────

/**
 * Pure reconciliation logic: given a metadata object, determine the
 * authoritative status by combining the stored value with the runner's
 * liveness and the JSONL sentinel.
 *
 * Spec rev 4 §4.4. Returns `{ status, runnerAlive, adapterAlive, error? }`.
 * Never mutates anything.
 */
export function reconcileStatus(meta, {
  sentinelScanner = jsonlFindRunnerSentinel,
} = {}) {
  const runnerAlive = meta.runnerPid ? isProcessAlive(meta.runnerPid) : false;
  const adapterAlive = meta.adapterPid ? isProcessAlive(meta.adapterPid) : null;

  const out = {
    status: meta.status,
    runnerAlive,
    adapterAlive,
  };

  // Terminal states already in metadata → trust them.
  if (meta.status !== 'running') {
    if (meta.errorCategory) out.error = { category: meta.errorCategory, message: meta.errorMessage };
    return out;
  }

  // Metadata says running. If runner OR adapter is still alive, the job is
  // still making progress (even if the runner crashed and left the detached
  // adapter running). Report running so cancel has something to kill.
  if (runnerAlive || adapterAlive) return out;

  // BOTH processes are dead. Look for the sentinel.
  const sentinel = sentinelScanner(meta.artifactJsonlPath);
  if (sentinel && ['completed', 'failed', 'cancelled'].includes(sentinel.status)) {
    out.status = sentinel.status;
    if (sentinel.status === 'failed') {
      out.error = {
        category: sentinel.category || 'unknown',
        message: sentinel.message || 'runner reported failure without message',
      };
    }
    return out;
  }

  // No sentinel → real crash.
  out.status = 'failed';
  out.error = {
    category: 'crashed',
    message: 'runner exited without writing a completion sentinel',
  };
  return out;
}

// ───── Debounced metadata flush (runner-side helper) ───────────────────────

const FLUSH_FLOOR_MS = 5_000;

/**
 * Decide whether to flush metadata based on the debounce rules from
 * spec §4.3.1:
 *   - now - meta._lastFlushAt > 5s, OR
 *   - status changed, OR
 *   - adapterPid first set.
 *
 * The caller supplies the actual writer (so tests can spy). Returns the
 * updated meta._lastFlushAt (or the previous one if not flushed).
 */
export function maybeFlushMetadata(meta, {
  flushImpl,
  force = false,
} = {}) {
  const now = _clock().getTime();
  const lastFlush = meta._lastFlushAt || 0;
  const elapsed = now - lastFlush;

  const statusChanged = meta._prevFlushedStatus !== meta.status;
  const adapterPidSet = meta._prevFlushedAdapterPid === null && meta.adapterPid != null;

  if (force || statusChanged || adapterPidSet || elapsed > FLUSH_FLOOR_MS) {
    if (typeof flushImpl === 'function') flushImpl(meta);
    meta._lastFlushAt = now;
    meta._prevFlushedStatus = meta.status;
    meta._prevFlushedAdapterPid = meta.adapterPid ?? null;
    return true;
  }
  return false;
}

// ───── Argv parser (pure) ───────────────────────────────────────────────────

const VALID_MODELS = ['codex', 'gemini', 'auto'];
const SUBCOMMANDS = new Set(['async', 'status', 'collect', 'cancel', 'list', '_run-job']);

/**
 * Parse ask.mjs's argv into a dispatch descriptor.
 * Returns `{ command, ...params }` or `{ command: 'error', reason }`.
 *
 * Pure — no I/O, no stdin, no env. Tests can feed arbitrary argv arrays.
 *
 * Accepted forms:
 *   [node, ask.mjs, codex]                        → sync
 *   [node, ask.mjs, async, codex]                 → async launch
 *   [node, ask.mjs, status, <jobId>]              → status
 *   [node, ask.mjs, collect, <jobId>, --wait]     → collect (wait)
 *   [node, ask.mjs, collect, <jobId>, --timeout, N]
 *   [node, ask.mjs, cancel, <jobId>]              → cancel
 *   [node, ask.mjs, list]                         → list
 *   [node, ask.mjs, list, --status, running]
 *   [node, ask.mjs, list, --older-than, 600]
 *   [node, ask.mjs, _run-job, <jobId>]            → runner
 */
export function parseAskArgs(argv) {
  // argv may be process.argv (starts with [node, script, ...]) or a trimmed array.
  // Detect and normalize.
  let args = argv;
  if (args.length >= 2 && typeof args[1] === 'string' && args[1].endsWith('ask.mjs')) {
    args = args.slice(2);
  } else if (args.length >= 1 && typeof args[0] === 'string' && args[0].endsWith('ask.mjs')) {
    args = args.slice(1);
  } else if (args.length >= 2 && typeof args[0] === 'string' && args[0].includes('node')) {
    args = args.slice(2);
  }

  const first = args[0];
  if (!first) return { command: 'error', reason: 'missing subcommand or model arg' };

  // Legacy sync path: first arg is a model name.
  if (VALID_MODELS.includes(first)) {
    return { command: 'sync', model: first };
  }

  if (!SUBCOMMANDS.has(first)) {
    return { command: 'error', reason: `unknown subcommand: ${first}` };
  }

  if (first === 'async') {
    const model = args[1];
    if (!model || !VALID_MODELS.includes(model)) {
      return { command: 'error', reason: 'async requires a model arg (codex|gemini|auto)' };
    }
    return { command: 'async', model };
  }

  if (first === 'status' || first === 'cancel' || first === '_run-job') {
    const jobId = args[1];
    if (!jobId) return { command: 'error', reason: `${first} requires a jobId` };
    return { command: first === '_run-job' ? 'run-job' : first, jobId };
  }

  if (first === 'collect') {
    const jobId = args[1];
    if (!jobId) return { command: 'error', reason: 'collect requires a jobId' };
    const rest = args.slice(2);
    let wait = false;
    let timeoutSec = 600;
    for (let i = 0; i < rest.length; i++) {
      const token = rest[i];
      if (token === '--wait') {
        wait = true;
      } else if (token === '--timeout') {
        const val = rest[i + 1];
        if (val == null) return { command: 'error', reason: '--timeout requires a value' };
        const parsed = Number(val);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return { command: 'error', reason: `--timeout must be a positive number, got: ${val}` };
        }
        timeoutSec = parsed;
        i++;
      } else {
        return { command: 'error', reason: `unknown collect flag: ${token}` };
      }
    }
    return { command: 'collect', jobId, wait, timeoutSec };
  }

  if (first === 'list') {
    const rest = args.slice(1);
    let statusFilter = null;
    let olderThanSec = null;
    for (let i = 0; i < rest.length; i++) {
      const token = rest[i];
      if (token === '--status') {
        statusFilter = rest[i + 1];
        if (!statusFilter) return { command: 'error', reason: '--status requires a value' };
        i++;
      } else if (token === '--older-than') {
        const val = rest[i + 1];
        if (val == null) return { command: 'error', reason: '--older-than requires a value' };
        const parsed = Number(val);
        if (!Number.isFinite(parsed) || parsed < 0) {
          return { command: 'error', reason: `--older-than must be >= 0, got: ${val}` };
        }
        olderThanSec = parsed;
        i++;
      } else {
        return { command: 'error', reason: `unknown list flag: ${token}` };
      }
    }
    return { command: 'list', statusFilter, olderThanSec };
  }

  return { command: 'error', reason: `unhandled subcommand: ${first}` };
}

// ───── listJobs ─────────────────────────────────────────────────────────────

/**
 * Enumerate `.ao/state/ask-jobs/*.json` entries (excludes `.prompt` files).
 * Returns an array of metadata objects, sorted by `startedAt` descending.
 * NOT liveness-reconciled — callers needing ground truth should run
 * `status <jobId>` on each.
 */
export function listJobs({
  cwd = process.cwd(),
  statusFilter = null,
  olderThanSec = null,
} = {}) {
  const dir = join(cwd, JOB_STATE_DIR);
  if (!existsSync(dir)) return [];
  let entries;
  try { entries = readdirSync(dir); }
  catch { return []; }

  const out = [];
  const now = _clock().getTime();
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const jobId = name.slice(0, -5);
    const meta = readMetadata(jobId, { cwd });
    if (!meta) continue;
    if (statusFilter && meta.status !== statusFilter) continue;
    if (olderThanSec != null) {
      const startedMs = Date.parse(meta.startedAt || '');
      if (!Number.isFinite(startedMs)) continue;
      if ((now - startedMs) / 1000 <= olderThanSec) continue;
    }
    out.push(meta);
  }

  out.sort((a, b) => {
    const ta = Date.parse(a.startedAt || '') || 0;
    const tb = Date.parse(b.startedAt || '') || 0;
    return tb - ta;
  });
  return out;
}

/**
 * Synthesize a markdown body from the JSONL sentinel's `text` field.
 * Used by `collect` as a fallback when the runner crashed between
 * writing the sentinel and writing `.md`. Adapter-agnostic because
 * `handle._output` is the common contract both adapters fulfill.
 *
 * Returns null if no sentinel or no usable text.
 */
export function synthesizeMdFromSentinel(jsonlPath) {
  const sentinel = jsonlFindRunnerSentinel(jsonlPath);
  if (!sentinel || typeof sentinel.text !== 'string' || !sentinel.text.trim()) {
    return null;
  }
  const text = sentinel.text.trim();
  return text + (text.endsWith('\n') ? '' : '\n');
}
