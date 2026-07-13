import { createHash, randomBytes } from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { readProcStartId } from './proc-identity.mjs';
import { acquireRecoveryClaim, statGeneration } from './recovery-claim.mjs';
import { createTeamSession, spawnWorkerInSession, capturePane, killTeamSessions, buildWorkerCommand, sessionName, validateTmux, killSession, WORKER_EXIT_MARKER } from './tmux-session.mjs';
import { readOutbox, readAllOutboxes, cleanupTeam } from './inbox-outbox.mjs';
import { addWisdom } from './wisdom.mjs';
import { cleanupTeamWorktrees } from './worktree.mjs';
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  existsSync,
  statSync,
  unlinkSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join, resolve } from 'path';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { buildRecoveryStrategy } from './stuck-recovery.mjs';
import { loadAutonomyConfig } from './autonomy.mjs';
import {
  manifestPath as supManifestPath,
  snapshotPath as supSnapshotPath,
  outputPath as supOutputPath,
  readSnapshot as supReadSnapshot,
  isValidId as supIsValidId,
  isTerminalStatus as supIsTerminalStatus,
  isHeartbeatFresh as supIsHeartbeatFresh,
  STARTUP_GRACE_MS as SUP_STARTUP_GRACE_MS,
} from './supervisor-state.mjs';
import {
  resolveCodexApproval,
  shouldDemoteCodexWorker,
  detectHostSandbox,
  buildHostSandboxWarning,
} from './codex-approval.mjs';

/** Absolute path to the supervisor CLI (launched detached per adapter worker). */
const SUPERVISOR_SCRIPT = fileURLToPath(new URL('./adapter-worker-supervisor.mjs', import.meta.url));

const STATE_DIR = '.ao/state';
const ARTIFACTS_DIR = '.ao/artifacts';

/** Default stall threshold in milliseconds (5 minutes of zero output change) */
const STALL_THRESHOLD_MS = 5 * 60 * 1000;
const CLAUDE_FALLBACK_LOCK_TIMEOUT_MS = 5 * 1000;
const TEAM_RUN_ID = /^[a-f0-9]{16}$/;

/** Allocate the generation before launch so an orchestrator can persist it first. */
export function allocateTeamRunId() {
  return randomBytes(8).toString('hex');
}

/**
 * Grace period (ms) before escalating an orphaned-process-group kill from
 * SIGTERM to SIGKILL in the disk-loaded shutdown fallback. Matches the
 * per-adapter shutdown contract (codex/gemini/claude all SIGTERM → SIGKILL).
 * The fallback polls for early exit, so a healthy worker that honors SIGTERM
 * returns well before this ceiling.
 */
const KILL_GRACE_MS = 2000;

/** Promise-based sleep — zero deps, used by the kill-escalation poll loop. */
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Compute a short hash of a string for cheap equality comparison.
 * @param {string} str
 * @returns {string}
 */
function quickHash(str) {
  return createHash('md5').update(str || '').digest('hex');
}

/**
 * Error patterns that indicate a Codex worker has failed unrecoverably (tmux path).
 * @type {Array<{ pattern: RegExp, reason: string }>}
 */
const CODEX_ERROR_PATTERNS = [
  { pattern: /authentication|unauthorized|invalid.*api.*key|API key/i, reason: 'auth_failed' },
  { pattern: /rate.?limit|429|quota.*exceeded|too many requests/i, reason: 'rate_limited' },
  { pattern: /command not found|ENOENT|codex:.*not found|No such file or directory|not found in PATH/i, reason: 'not_installed' },
  { pattern: /ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|network error/i, reason: 'network' },
  { pattern: /fatal error|unhandled exception|panic:|SIGSEGV|SIGABRT|segmentation fault/i, reason: 'crash' },
];

const PROVIDER_EXHAUSTION_PATTERN = /rate.?limit|\b429\b|quota.*exceeded|resource[_ ]exhausted|too many requests/i;
const PROVIDER_UNAVAILABLE_CATEGORIES = new Set(['network', 'timeout']);
const CAPABILITY_KEYS = [
  'hasCodexAppServer',
  'hasCodexExecJson',
  'hasClaudeCli',
  'hasGeminiAcp',
  'hasGeminiCli',
];

// ─── Adapter registry (strategy table) ─────────────────────────────────────
// Maps adapter name → { loader, handleKey, monitorFn, shutdownFn, statusMap, errorLabel }
// Adding a new adapter requires only one new entry here.

const ADAPTER_REGISTRY = {
  'codex-appserver': {
    loader: () => import('./codex-appserver.mjs'),
    handleKey: '_liveHandle',
    monitorFn: 'monitor',
    shutdownFn: 'shutdownServer',
    statusMap: { ready: 'running' },
    errorLabel: 'Codex app-server',
  },
  'codex-exec': {
    loader: () => import('./codex-exec.mjs'),
    handleKey: '_liveHandle',
    monitorFn: 'monitor',
    shutdownFn: 'shutdown',
    statusMap: null,
    errorLabel: 'Codex exec',
  },
  'claude-cli': {
    loader: () => import('./claude-cli.mjs'),
    handleKey: '_liveHandle',
    monitorFn: 'monitor',
    shutdownFn: 'shutdown',
    statusMap: null,
    errorLabel: 'Claude CLI',
  },
  'gemini-acp': {
    loader: () => import('./gemini-acp.mjs'),
    handleKey: '_liveHandle',
    monitorFn: 'monitor',
    shutdownFn: 'shutdownServer',
    statusMap: null,
    errorLabel: 'Gemini ACP',
  },
  'gemini-exec': {
    loader: () => import('./gemini-exec.mjs'),
    handleKey: '_liveHandle',
    monitorFn: 'monitor',
    shutdownFn: 'shutdown',
    statusMap: null,
    errorLabel: 'Gemini exec',
  },
};

// ─── State persistence ──────────────────────────────────────────────────────

/**
 * Worker keys that hold a LIVE, non-serializable adapter handle and MUST be
 * stripped before the team state is written to disk.
 *
 * `_liveHandle` is the live ChildProcess (gemini-exec/claude-cli/codex-exec)
 * or JSON-RPC client (codex-appserver/gemini-acp) returned by `adapter.spawn`.
 * `JSON.stringify` does NOT throw on it — it deep-serializes the enumerable
 * props into a ~7KB+ blob that (a) leaks `spawnargs` (the full prompt for
 * gemini-exec/claude-cli) and in-flight stream buffers into `.ao/state`, and
 * (b) silently drops the `.kill`/`.process` methods, producing a truthy
 * husk that LOOKS like a handle but cannot be signaled. Reloaded from disk in
 * a fresh process, that husk poisons `shutdownTeam` (handle.kill is not a
 * function → orphaned detached process groups), `monitorTeam` (frozen
 * save-time snapshot), and `collectResults` (empty `_output`).
 *
 * The serializable subset the orchestrator actually needs across process
 * boundaries lives on `_handle` ({ pid, threadId, sessionId, ... }), which is
 * preserved. Stripping `_liveHandle` here restores the documented invariant:
 * a disk-loaded `_liveHandle` is always `undefined`.
 * @type {ReadonlySet<string>}
 */
const NON_SERIALIZABLE_WORKER_KEYS = new Set(['_liveHandle']);

function saveTeamState(teamName, state) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  atomicWriteFileSync(
    join(STATE_DIR, `team-${teamName}.json`),
    // Replacer runs for every key at every depth; returning `undefined` for an
    // object property omits it entirely (and never recurses into the live
    // handle, so circular ChildProcess refs can't blow up serialization).
    JSON.stringify(
      state,
      (key, value) => (NON_SERIALIZABLE_WORKER_KEYS.has(key) ? undefined : value),
      2
    )
  );
}

function loadTeamState(teamName) {
  const path = join(STATE_DIR, `team-${teamName}.json`);
  try { return JSON.parse(readFileSync(path, 'utf-8')); }
  catch { return null; }
}

/**
 * True only for a REAL in-process adapter handle — one that still owns its live
 * methods. A handle deserialized from disk (a pre-fix "husk" written by the old
 * no-replacer `saveTeamState`) loses every function to JSON, so it is truthy
 * but useless: dispatching it to the adapter shutdown throws "kill is not a
 * function" and the real process group is never signaled. Callers MUST gate the
 * adapter-shutdown path on this and fall back to PID-group cleanup otherwise.
 *
 * All adapter handles wrap a live ChildProcess on `.process` (with a `.kill`
 * method); exec/cli handles also expose a top-level `.kill`. A husk has neither.
 * @param {any} h
 * @returns {boolean}
 */
function isLiveHandle(h) {
  return !!h && (typeof h.kill === 'function' || typeof h.process?.kill === 'function');
}

/**
 * Read a stable, per-process START-TIME identity for `pid` — a value a recycled
 * PID cannot reproduce. Used to detect PID reuse before signaling a stored pid
 * (F3). Recorded on `_handle.startId` at spawn and re-checked at shutdown.
 *
 * Linux: `/proc/<pid>/stat` field 22 (starttime in clock ticks since boot).
 * macOS/BSD: `ps -o lstart=` (1-second resolution — PID reuse within 1s is
 * implausible). Returns `null` on any failure so callers FAIL OPEN (fall back to
 * the documented group-signal) rather than skip a needed kill.
 *
 * @param {number} pid
 * @returns {string|null}
 */
// `readProcStartId` is imported at the top from ./proc-identity.mjs (so the
// detached supervisor can share it without importing all of worker-spawn) and
// re-exported here for back-compat (callers/tests importing it from worker-spawn).
export { readProcStartId };

/**
 * Signal one or more detached worker process GROUPS, escalating SIGTERM →
 * SIGKILL. Used as the disk-loaded shutdown fallback when the in-memory
 * `_liveHandle` is gone (stripped by `saveTeamState`) but the serializable
 * `_handle` survives.
 *
 * Accepts `{ pid, startId }` items (preferred — enables PID-reuse validation) or
 * bare pids (back-compat). All non-tmux adapters spawn with `detached: true`, so
 * each worker pid is a process-group leader (pgid === pid). Hardening choices:
 *
 *  - PID-REUSE GUARD (F3). When a `startId` was recorded at spawn and the leader
 *    pid is STILL ALIVE with a DIFFERENT start-time, the pid was recycled by an
 *    unrelated process — we NEVER signal its group (protect the stranger over
 *    reaping our own orphan). When the start-time can't be read (the leader
 *    already exited but a descendant keeps the group alive, or the platform
 *    doesn't expose it), we FAIL OPEN to the group-signal — preserving the
 *    descendant-survival reap below.
 *  - GROUP-scoped liveness & signaling only. We probe and signal `-pid` (the
 *    whole group), never the bare pid. `kill(-pgid, 0)` reports the group alive
 *    while ANY member survives, so a descendant that outlives the leader is
 *    still caught and SIGKILLed.
 *  - `pid > 1` guard. `process.kill(-0, ...)` targets the CALLER's own group and
 *    `-1` broadcasts to every signalable process; only real worker pids ≥ 2 are
 *    eligible.
 *
 * @param {Array<number|{pid:number,startId?:string|null}>} targets
 * @param {number} [graceMs=KILL_GRACE_MS] - Ceiling before SIGKILL escalation
 * @returns {Promise<void>}
 */
async function killProcessGroups(targets, graceMs = KILL_GRACE_MS) {
  const items = (Array.isArray(targets) ? targets : [])
    .map((t) => (typeof t === 'number' ? { pid: t, startId: null } : t))
    .filter((t) => t && Number.isInteger(t.pid) && t.pid > 1);
  if (items.length === 0) return;

  // Probe the GROUP, not the leader: succeeds while any member is alive, throws
  // ESRCH only once the whole group is gone.
  const groupAlive = (pgid) => {
    try { process.kill(-pgid, 0); return true; }
    catch { return false; }
  };
  const signalGroup = (pgid, sig) => {
    try { process.kill(-pgid, sig); } catch { /* group gone or not permitted */ }
  };
  // True only when we have a recorded baseline AND the live leader's identity
  // DIFFERS — i.e. the pid was provably recycled. Unknown/unreadable → false
  // (fail open).
  const isRecycled = (item) => {
    if (!item.startId) return false;
    const cur = readProcStartId(item.pid);
    return cur !== null && cur !== item.startId;
  };

  const alive = new Map(); // pid → item, retained for re-validation before SIGKILL
  for (const item of items) {
    if (isRecycled(item)) continue;       // recycled pid — protect the stranger
    if (!groupAlive(item.pid)) continue;  // whole group already gone
    signalGroup(item.pid, 'SIGTERM');
    alive.set(item.pid, item);
  }
  if (alive.size === 0) return;

  // Poll the group for graceful exit so a SIGTERM-honoring worker returns fast;
  // escalate the survivors' groups to SIGKILL once the grace ceiling is hit.
  const deadline = Date.now() + Math.max(0, graceMs);
  while (alive.size > 0 && Date.now() < deadline) {
    await sleep(50);
    for (const pgid of [...alive.keys()]) {
      if (!groupAlive(pgid)) alive.delete(pgid);
    }
  }
  // RE-VALIDATE identity before the hard kill: during the grace window the
  // original group can exit and its pgid be recycled, so a still-"alive" entry
  // may now be a stranger's group. Skip any that became recycled. (F3-2)
  for (const [pgid, item] of alive) {
    if (isRecycled(item)) continue;
    signalGroup(pgid, 'SIGKILL');
  }
}

// ─── Adapter selection ──────────────────────────────────────────────────────

/**
 * Select the appropriate spawn adapter for a worker.
 * Pure function — no side effects.
 *
 * Priority for codex workers: codex-appserver > codex-exec > tmux
 * Priority for claude workers: claude-cli > tmux
 * Default (all others): tmux
 *
 * - codex-appserver: multi-turn, structured errors, turn steering (Phase 2)
 * - codex-exec: single-turn JSONL, child_process.spawn (Phase 1)
 * - claude-cli: headless Claude Code via `-p --output-format stream-json` (Phase 3)
 * - tmux: legacy fallback for all worker types
 *
 * @param {Object} worker - Worker descriptor with { type, name, prompt }
 * @param {Object} capabilities - From preflight.detectCapabilities()
 * @returns {'codex-appserver' | 'codex-exec' | 'claude-cli' | 'gemini-acp' | 'gemini-exec' | 'tmux'}
 */
export function selectAdapter(worker, capabilities = {}) {
  if (worker.type === 'codex') {
    if (capabilities.hasCodexAppServer) return 'codex-appserver';
    if (capabilities.hasCodexExecJson) return 'codex-exec';
  }
  if (worker.type === 'claude') {
    if (capabilities.hasClaudeCli) return 'claude-cli';
  }
  if (worker.type === 'gemini') {
    if (capabilities.hasGeminiAcp) return 'gemini-acp';
    if (capabilities.hasGeminiCli) return 'gemini-exec';
  }
  return 'tmux';
}

// ─── Generic adapter monitor helper ────────────────────────────────────────

/**
 * Monitor a non-tmux worker via its adapter module.
 * Replaces the 5 per-adapter monitor functions with a single generic one.
 *
 * @param {Object} worker - Worker state from team state
 * @param {Object} adapterModule - The loaded adapter module
 * @param {Object} registryEntry - The ADAPTER_REGISTRY entry for this adapter
 * @returns {{ status: string, output: string, error?: { category: string, message: string } }}
 */
function monitorAdapterWorker(worker, adapterModule, registryEntry) {
  const handle = worker[registryEntry.handleKey];
  if (!handle) {
    return { status: 'failed', output: '', error: { category: 'crash', message: `No ${registryEntry.errorLabel} handle` } };
  }
  try {
    const snapshot = adapterModule[registryEntry.monitorFn](handle);
    let status = snapshot.status;
    if (registryEntry.statusMap && registryEntry.statusMap[status]) {
      status = registryEntry.statusMap[status];
    }
    const result = { status, output: (snapshot.output || '').slice(-500) };
    if (snapshot.error) {
      const category = typeof snapshot.error === 'string'
        ? snapshot.error
        : (snapshot.error.category || 'unknown');
      const message = typeof snapshot.error === 'object' && snapshot.error.message
        ? snapshot.error.message
        : `${registryEntry.errorLabel} error: ${category}`;
      result.error = { category, message };
    }
    return result;
  } catch {
    return { status: worker.status || 'running', output: '' };
  }
}

// ─── Supervisor (disk-snapshot) worker helpers (F1) ─────────────────────────
// A supervisor worker is monitored/collected/shutdown via the DISK snapshot the
// detached supervisor writes — the only reliable channel across the
// fresh-process-per-poll boundary. Gated on an EXPLICIT descriptor so these
// paths stay dormant until spawnTeam actually launches supervisors (P4): every
// disk-loaded adapter worker already lacks a live handle, so "known adapter +
// no live handle" alone is NOT a sufficient gate.

/** Grace for the supervisor process group — must exceed the adapter's own 5s. */
const SUPERVISOR_KILL_GRACE_MS = 8000;

/** True only for a worker launched via the supervisor (P4 sets these fields). */
export function isSupervisorWorker(state, worker) {
  return !!(
    state && supIsValidId(state.runId) && typeof state.projectRoot === 'string' &&
    worker && worker._handle &&
    supIsValidId(worker._handle.workerRunId) &&
    Number.isInteger(worker._handle.supervisorPid) && worker._handle.supervisorPid > 1
  );
}

/**
 * Tri-state liveness for MONITORING (distinct from readProcStartId's kill-path
 * fail-open): identity match → 'alive'; different identity → 'dead'; pid exists
 * (incl. EPERM — exists but not signalable) but identity unreadable →
 * 'alive-unverified'; ESRCH → 'dead'.
 */
export function probePidLiveness(pid, startId) {
  if (!Number.isInteger(pid) || pid <= 1) return 'dead';
  const cur = readProcStartId(pid);
  if (cur !== null && startId) return cur === startId ? 'alive' : 'dead';
  try { process.kill(pid, 0); return 'alive-unverified'; }
  catch (e) { return e && e.code === 'EPERM' ? 'alive-unverified' : 'dead'; }
}

/** Monitor a supervisor worker from its disk snapshot. Returns a MonitorResult. */
export function monitorSupervisorWorker(state, worker, now) {
  const h = worker._handle;
  let snapPath;
  try { snapPath = supSnapshotPath(state.projectRoot, state.runId, h.workerRunId); }
  catch { return { status: 'failed', output: '', error: { category: 'supervisor_invalid', message: 'invalid supervisor paths' } }; }

  const r = supReadSnapshot(snapPath, { runId: state.runId, workerRunId: h.workerRunId });

  if (r.kind === 'ok') {
    const s = r.snapshot;
    const tail = typeof s.outputTail === 'string' ? s.outputTail : '';
    if (supIsTerminalStatus(s.status)) {
      if (s.status === 'completed') return { status: 'completed', output: tail };
      // failed | cancelled → failed, preserving category (cancelled → 'cancelled').
      const cat = (s.error && s.error.category) || (s.status === 'cancelled' ? 'cancelled' : 'unknown');
      const msg = (s.error && s.error.message) || s.status;
      return { status: 'failed', output: tail, error: { category: cat, message: msg } };
    }
    // running → a DEAD supervisor is a definitive crash (immediate).
    if (probePidLiveness(s.supervisorPid, s.supervisorStartId) === 'dead') {
      return { status: 'failed', output: tail, error: { category: 'crash', message: 'supervisor died before completion' } };
    }
    // A stale heartbeat on a still-alive pid (wedged worker, but also a transient
    // suspend/resume or >stale-threshold GC pause): require confirmation across
    // TWO consecutive polls before declaring a crash, so a healthy-but-paused
    // worker isn't false-crashed. `_staleSeen` latches the first observation.
    if (!supIsHeartbeatFresh(s, now)) {
      if (worker._supStaleSeen) {
        return { status: 'failed', output: tail, error: { category: 'crash', message: 'supervisor heartbeat stale across two polls' } };
      }
      return { status: 'running', output: tail, _staleSeen: true };
    }
    return { status: 'running', output: tail };
  }

  if (r.kind === 'missing') {
    const startedMs = Date.parse(worker.startedAt || '') || 0;
    const age = now - startedMs;
    // Within the startup grace (and NOT future-dated) → still starting up.
    if (startedMs && age >= 0 && age <= SUP_STARTUP_GRACE_MS) return { status: 'running', output: '' };
    // Past grace (or a future/invalid startedAt) with NO snapshot → the
    // supervisor failed to come up (it writes its first snapshot immediately).
    return { status: 'failed', output: '', error: { category: 'crash', message: 'supervisor produced no snapshot' } };
  }

  // corrupt | unsupported | mismatch → state is untrustworthy; fail DIRECTLY
  // (a non-'crash' category so monitorTeam does NOT retry a corrupt run).
  return { status: 'failed', output: '', error: { category: 'supervisor_invalid', message: `supervisor snapshot ${r.kind}` } };
}

/**
 * Shut down a supervisor worker SUPERVISOR-FIRST: signal the supervisor group
 * (its SIGTERM handler gracefully shuts the adapter down), WAIT for it, then
 * re-read the snapshot and reap a SURVIVING adapter group as the orphan fallback
 * (in case the supervisor died before cleanup). Both via F3 startId-checked kills.
 */
export async function shutdownSupervisorWorker(state, worker) {
  const h = worker._handle;
  // Phase 1: the supervisor (longer grace than the adapter's own 5s).
  await killProcessGroups([{ pid: h.supervisorPid, startId: h.supervisorStartId }], SUPERVISOR_KILL_GRACE_MS);
  // Phase 2: re-read AFTER phase 1 so an adapterPid recorded during the race is
  // seen; reap it only if it survived the supervisor's graceful shutdown.
  try {
    const r = supReadSnapshot(supSnapshotPath(state.projectRoot, state.runId, h.workerRunId), { runId: state.runId, workerRunId: h.workerRunId });
    if (r.kind === 'ok' && Number.isInteger(r.snapshot.adapterPid) && r.snapshot.adapterPid > 1) {
      await killProcessGroups([{ pid: r.snapshot.adapterPid, startId: r.snapshot.adapterStartId }], KILL_GRACE_MS);
    }
  } catch { /* supervisor-only kill already done */ }
  // Phase 3: scrub the prompt-bearing manifest. The supervisor truncates+unlinks
  // it on startup, but a shutdown in the launch race (SIGTERM before main() read
  // it) would leave the prompt on disk until the 24h sweep — clear it here too.
  try {
    const mPath = supManifestPath(state.projectRoot, state.runId, h.workerRunId);
    try { atomicWriteFileSync(mPath, ''); } catch { /* best-effort */ }
    try { unlinkSync(mPath); } catch { /* best-effort */ }
  } catch { /* bad ids → nothing to scrub */ }
}

// ─── Tmux adapter helpers (inline — wraps existing tmux-session functions) ──

/**
 * Parse the explicit `__AO_EXIT__[:<nonce>]:<code>` sentinel that
 * buildWorkerCommand emits after a worker's CLI exits (see WORKER_EXIT_MARKER
 * in tmux-session.mjs).
 *
 * Two anti-forgery measures:
 *   - LINE ANCHORING (`^`, multiline): the typed command line is echoed into
 *     the pane too, but there the marker is preceded by `echo "`, so it is
 *     never at line start — only the EXECUTED echo's output, alone on its line,
 *     matches. (Also dodges the unexpanded `$__ao_ec`, which has no digit.)
 *   - NONCE: when `nonce` is supplied (production), the marker must carry that
 *     per-invocation random token. Worker OUTPUT that prints a bare
 *     `__AO_EXIT__:0` therefore cannot forge a completion — it doesn't know the
 *     nonce. With no nonce (legacy/tests) the unscoped marker is accepted.
 *
 * The LAST match wins so a re-polled or re-run pane reports the most recent exit.
 *
 * @param {string} output - captured pane text
 * @param {string|null} [nonce] - per-invocation token the marker must carry
 * @returns {number|null} exit code, or null if no matching sentinel is present
 */
export function parseExitMarker(output, nonce = null) {
  if (!output || typeof output !== 'string') return null;
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const esc = escRe(WORKER_EXIT_MARKER);
  const noncePart = (typeof nonce === 'string' && nonce.length) ? `${escRe(nonce)}:` : '';
  // Anchor the code to line end (`[ \t\r]*$`) so (a) CRLF panes parse, and (b) an
  // unscoped parse can NEVER misread a nonce-scoped line: `__AO_EXIT__:0abc:7`
  // no longer matches `(\d+)` as `0`, because `abc` (not EOL) follows the digit.
  const re = new RegExp(`^${esc}:${noncePart}(\\d+)[ \\t\\r]*$`, 'gm');
  let m;
  let last = null;
  while ((m = re.exec(output)) !== null) last = m[1];
  return last === null ? null : Number.parseInt(last, 10);
}

/**
 * Pure classifier for a tmux worker's status from its captured pane text.
 * Extracted from monitorTmuxWorker so the completion/failure decision is unit
 * testable without a live tmux process.
 *
 * Decision order:
 *   1. EXPLICIT exit sentinel (`parseExitMarker`) is authoritative and
 *      provider-agnostic — `0` → completed, non-zero → failed. This replaces
 *      the old "a shell prompt came back" heuristic, which reported every
 *      failed/no-op/syntax-error worker (codex, claude, AND gemini) as
 *      `completed` — a silent success.
 *   2. No sentinel yet, but a known Codex error signature is present → failed
 *      fast (richer category than a bare non-zero exit).
 *   3. Otherwise → still `running`. We do NOT infer completion from a returned
 *      prompt; a genuine hang is caught by the activity-based stall detector in
 *      monitorTeam, not by guessing.
 *
 * @param {Object} worker - { status, type, session, ... }
 * @param {string|null} paneOutput - captured pane text (or null)
 * @returns {{ status: string, output: string, error?: { category: string, message: string } }}
 */
export function classifyTmuxWorker(worker, paneOutput) {
  const hasPane = !!paneOutput;

  // The exit sentinel is AUTHORITATIVE and provider-agnostic. Parse it whenever
  // the worker is still resolvable — 'running', OR a provisional 'failed'/'retry'
  // from an EARLIER signature-only poll — so a transient error line (e.g. "rate
  // limit … retrying") the worker recovered from cannot permanently mask a later
  // `__AO_EXIT__:0`. A terminal 'completed' (or not-yet-started 'pending') is
  // never re-classified. (F3) The nonce scopes the marker against forgery. (F2)
  const resolvable =
    worker?.status === 'running' || worker?.status === 'failed' || worker?.status === 'retry';
  const exitCode = (hasPane && resolvable) ? parseExitMarker(paneOutput, worker?._exitNonce) : null;

  // Supplementary Codex-only signature scan for a STILL-RUNNING worker: enables
  // fast-fail BEFORE the sentinel lands. Gated to 'running' so it can never
  // prematurely collapse a 'retry' worker that has no exit code yet.
  let runningSig = { failed: false };
  if (worker?.type === 'codex' && worker?.status === 'running' && hasPane) {
    runningSig = detectCodexError(paneOutput);
  }

  let status = worker?.status;
  let error;

  if (exitCode !== null) {
    if (exitCode === 0) {
      status = 'completed';
    } else {
      status = 'failed';
      // Re-derive the Codex category from the pane (not just the running-only
      // scan) so a worker re-evaluated from 'failed'/'retry' keeps its richer
      // category — e.g. 'crash', which preserves the crash→retry path in
      // monitorTeam — instead of decaying to a generic 'nonzero_exit' on the
      // next poll. (F6)
      const sig = runningSig.failed
        ? runningSig
        : (worker?.type === 'codex' && hasPane ? detectCodexError(paneOutput) : { failed: false });
      if (sig.failed) {
        error = { category: sig.reason, message: sig.message || 'Codex tmux error' };
      } else if (worker?.errorReason && worker.errorReason !== 'nonzero_exit') {
        // The signature line scrolled out of the 200-line pane window, but an
        // earlier poll already persisted a richer category — keep it rather than
        // decay to nonzero_exit. (Codex F4 on the F6 fix)
        error = {
          category: worker.errorReason,
          message: worker.errorMessage || `Worker command exited with status ${exitCode}`,
        };
      } else {
        error = { category: 'nonzero_exit', message: `Worker command exited with status ${exitCode}` };
      }
    }
  } else if (runningSig.failed) {
    status = 'failed';
    error = {
      category: runningSig.reason,
      message: runningSig.message || 'Codex tmux error',
    };
  }

  const result = {
    status,
    output: paneOutput ? paneOutput.slice(-500) : '',
  };
  if (error) result.error = error;
  return result;
}

/**
 * Monitor a tmux-based worker via capturePane + the explicit exit sentinel.
 * Thin wrapper around the pure classifyTmuxWorker().
 *
 * @param {Object} worker - Worker state object with session, type, etc.
 * @returns {{ status: string, output: string, error?: { category: string, message: string } }}
 */
function monitorTmuxWorker(worker) {
  const paneOutput = worker.session ? capturePane(worker.session, 200) : null;
  return classifyTmuxWorker(worker, paneOutput);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Scan tmux pane output for known Codex failure signatures.
 * Returns the first matching error, or `{ failed: false }` if none match.
 *
 * @param {string} output - Raw captured pane text
 * @returns {{ failed: boolean, reason?: string, message?: string }}
 */
export function detectCodexError(output) {
  try {
    if (!output || typeof output !== 'string') return { failed: false };

    for (const { pattern, reason } of CODEX_ERROR_PATTERNS) {
      const match = output.match(pattern);
      if (match) {
        return { failed: true, reason, message: match[0].slice(0, 200) };
      }
    }
    return { failed: false };
  } catch {
    return { failed: false };
  }
}

/**
 * Distinguish provider exhaustion from a generic worker failure. Structured
 * adapter categories win; textual matching is a fallback for tmux/legacy
 * results. Network/timeouts require two distinct failed attempts so a single
 * transient disconnect does not trigger a provider switch.
 */
export function detectProviderExhaustion(error, unavailableAttempts = 0) {
  const category = typeof error === 'string' ? error : error?.category;
  const message = typeof error === 'string' ? error : error?.message;
  if (category === 'rate_limited' || category === 'provider_exhausted') {
    return { exhausted: true, reason: category };
  }
  if (PROVIDER_EXHAUSTION_PATTERN.test(String(message || ''))) {
    return { exhausted: true, reason: 'rate_limited' };
  }
  if (PROVIDER_UNAVAILABLE_CATEGORIES.has(category) && unavailableAttempts >= 2) {
    return { exhausted: true, reason: 'repeated_unavailability' };
  }
  return { exhausted: false, reason: null };
}

function providerForWorker(worker) {
  if (worker?.type === 'codex' || String(worker?._adapterName || '').startsWith('codex-')) return 'codex';
  if (worker?.type === 'gemini' || String(worker?._adapterName || '').startsWith('gemini-')) return 'gemini';
  if (worker?.type === 'claude' || worker?._adapterName === 'claude-cli') return 'claude';
  return 'unknown';
}

function normalizeCapabilities(capabilities) {
  const out = {};
  for (const key of CAPABILITY_KEYS) out[key] = Boolean(capabilities?.[key]);
  return out;
}

function stripProviderFields(worker, fields) {
  for (const field of fields) {
    if (field in worker) {
      worker[`_demoted${field[0].toUpperCase()}${field.slice(1)}`] = worker[field];
      delete worker[field];
    }
  }
}

/**
 * Build the replacement descriptor consumed by the orchestrator. Exhausted
 * Codex prefers Gemini when a Gemini adapter is available; exhausted Gemini
 * (or Codex without Gemini) falls through to Claude. The prompt and ordinary
 * task fields are retained, while stale runtime handles and source-provider
 * model fields are removed.
 */
export function planProviderFailover(worker, failureReason, capabilities = {}) {
  const sourceProvider = providerForWorker(worker);
  const failureCategory = typeof failureReason === 'string' ? failureReason : failureReason?.category;
  const recordedUnavailableAttempts = Number(worker?._providerUnavailableAttempts) || 0;
  const crashAttempts = Number(worker?._providerCrashAttempts) || 0;
  // A structured network/timeout failure is itself attempt one even when it
  // came from a legacy tmux caller that has no persisted monitor counter.
  const unavailableAttempts = PROVIDER_UNAVAILABLE_CATEGORIES.has(failureCategory)
    ? Math.max(1, recordedUnavailableAttempts)
    : recordedUnavailableAttempts;
  const exhaustion = detectProviderExhaustion(
    failureReason,
    unavailableAttempts,
  );
  const retryUnavailable = PROVIDER_UNAVAILABLE_CATEGORIES.has(failureCategory)
    && unavailableAttempts < 2
    && sourceProvider !== 'unknown';
  const retryCrash = failureCategory === 'crash'
    && crashAttempts < 1
    && (sourceProvider === 'codex' || sourceProvider === 'gemini');
  const retryProvider = retryUnavailable || retryCrash;
  const hasGemini = Boolean(capabilities?.hasGeminiAcp || capabilities?.hasGeminiCli);
  const targetProvider = retryProvider
    ? sourceProvider
    : exhaustion.exhausted && sourceProvider === 'codex' && hasGemini
      ? 'gemini'
      : sourceProvider === 'claude' ? null : 'claude';

  if (!targetProvider) {
    return {
      fallbackNeeded: false,
      sourceProvider,
      targetProvider: null,
      retry: false,
      exhaustion,
      reason: typeof failureReason === 'string' ? failureReason : failureReason?.category || 'unknown',
      replacementWorker: null,
    };
  }

  const reason = typeof failureReason === 'string'
    ? failureReason
    : failureReason?.category || exhaustion.reason || 'unknown';
  const replacementWorker = { ...worker, type: targetProvider };
  // Attempt counters are per-provider retry budgets. They are always cleared
  // here and re-set explicitly on the retry branch below, so a provider SWITCH
  // (codex→gemini) starts the new provider with a fresh retry budget instead of
  // inheriting the exhausted provider's counters (which would deny the
  // documented retry-once-on-unavailable to the replacement provider).
  for (const field of [
    'status', 'startedAt', 'completedAt', 'retryCount', 'lastActivityAt',
    'lastOutputHash', 'stalled', 'stalledMs', 'error', 'errorReason',
    'errorMessage', '_adapterName', '_handle', '_liveHandle', '_exitNonce',
    'session',
    '_supStaleSeen', '_providerUnavailableAttemptKey',
    '_providerUnavailableAttempts', '_providerCrashAttempts', '_providerRetryReason',
  ]) {
    delete replacementWorker[field];
  }
  // A replacement continues the SAME bounded task. When the source worker was
  // already operating inside an Athena worktree, keep that exact filesystem
  // affinity instead of silently falling back to the project root (or creating
  // a throwaway child-team branch whose successful edits are later deleted).
  const executionCwd = worker?.worktreePath || worker?.cwd;
  if (executionCwd) {
    replacementWorker.cwd = executionCwd;
    if (worker?.worktreePath) {
      replacementWorker.worktreePath = worker.worktreePath;
      replacementWorker.worktreeCreated = false;
      replacementWorker._inheritedWorktree = true;
    }
  }
  if (retryProvider) {
    // Same-provider retries share one bounded history even when the failure
    // category alternates (for example crash -> network -> crash). Preserve
    // both counters; only a provider SWITCH receives a fresh budget.
    if (recordedUnavailableAttempts > 0) {
      replacementWorker._providerUnavailableAttempts = recordedUnavailableAttempts;
    }
    if (crashAttempts > 0) replacementWorker._providerCrashAttempts = crashAttempts;
    if (retryUnavailable) replacementWorker._providerUnavailableAttempts = unavailableAttempts;
    if (retryCrash) replacementWorker._providerCrashAttempts = crashAttempts + 1;
    replacementWorker._providerRetryReason = retryUnavailable
      ? `${failureCategory}: attempt ${unavailableAttempts + 1}`
      : `crash: attempt ${crashAttempts + 2}`;
  } else {
    replacementWorker._providerFailoverOrigin = worker?._providerFailoverOrigin || sourceProvider;
    replacementWorker._demotedFrom = sourceProvider;
    replacementWorker._demotionReason = exhaustion.exhausted
      ? `provider exhaustion (${exhaustion.reason}): ${sourceProvider} -> ${targetProvider}`
      : `worker failure (${reason}): ${sourceProvider} -> ${targetProvider}`;
    if (sourceProvider === 'codex') stripProviderFields(replacementWorker, CODEX_PROVIDER_FIELDS);
    if (sourceProvider === 'gemini') stripProviderFields(replacementWorker, ['model']);
  }

  return {
    fallbackNeeded: true,
    sourceProvider,
    targetProvider,
    retry: retryProvider,
    exhaustion,
    reason,
    replacementWorker,
  };
}

/**
 * Kill a failed worker, record the failure in wisdom, and return a descriptor
 * for the orchestrator to spawn the next provider. A legacy alias is retained
 * for callers; provider exhaustion prefers Codex → Gemini → Claude.
 * Adapter-aware: calls the correct shutdown method based on _adapterName.
 *
 * IMPORTANT: `_liveHandle` is an in-memory adapter handle that is STRIPPED by
 * `saveTeamState` (see NON_SERIALIZABLE_WORKER_KEYS), so a state loaded from
 * disk never carries it. Callers with an in-process reference to the live team
 * state should pass it via `opts.liveState` to enable adapter-specific graceful
 * shutdown. For disk-loaded state, this falls back to signaling the detached
 * process group via the serializable `_handle.pid`, and finally to tmux session
 * cleanup when no pid was recorded (tmux workers, or spawn-time failures).
 *
 * @param {string} teamName
 * @param {string} workerName
 * @param {string} originalPrompt
 * @param {string|{category?:string,message?:string}} failureReason
 * @param {string} [sessionOverride] - tmux session name override
 * @param {{ liveState?: object, worker?: object, capabilities?: object }} [opts]
 * @returns {Promise<{ fallbackNeeded: boolean, teamName: string, workerName: string, prompt: string, reason: string, targetProvider: string|null, replacementWorker: object|null }>}
 */
export async function reassignProvider(teamName, workerName, originalPrompt, failureReason, sessionOverride, opts = {}) {
  let plan = null;
  try {
    // Prefer in-memory live state (has _liveHandle), fall back to disk-loaded state
    const state = opts.liveState || loadTeamState(teamName);
    const worker = state?.workers?.find(w => w.name === workerName) || opts.worker;
    const adapterName = worker?._adapterName || 'tmux';
    const registryEntry = ADAPTER_REGISTRY[adapterName];
    plan = planProviderFailover(
      worker || { name: workerName, prompt: originalPrompt, type: 'unknown' },
      failureReason,
      opts.capabilities || state?.capabilities || {},
    );
    if (plan.replacementWorker) plan.replacementWorker.prompt = originalPrompt;

    if (isSupervisorWorker(state, worker)) {
      // Supervisor worker: supervisor-first graceful shutdown + adapter reap (F3).
      await shutdownSupervisorWorker(state, worker);
    } else if (registryEntry && isLiveHandle(worker?._liveHandle)) {
      // In-process live handle (opts.liveState): graceful adapter shutdown.
      try {
        const adapterModule = await registryEntry.loader();
        await adapterModule[registryEntry.shutdownFn](worker._liveHandle);
      } catch {}
    } else if (registryEntry && Number.isInteger(worker?._handle?.pid)) {
      // Disk-loaded state: _liveHandle was stripped on save (or survives only as
      // a function-less husk from a pre-fix state file). Either way isLiveHandle
      // is false, so signal the detached process group via the serializable pid
      // so a failed worker's process can't be orphaned. Pass startId so a
      // recycled pid is detected and skipped (F3).
      await killProcessGroups([{ pid: worker._handle.pid, startId: worker._handle.startId }]);
    } else {
      // tmux worker (or no recorded pid): session cleanup.
      const session = sessionOverride || sessionName(teamName, workerName);
      try { killSession(session); } catch {}
    }

    // The orchestrator's fresh-process monitor loop re-runs reassignProvider on
    // every poll while the parent worker stays 'failed' (that re-run is what
    // makes dispatchProviderFallback idempotent). The resulting repeated,
    // near-identical lessons are absorbed by addWisdom's built-in similarity
    // dedup (Jaccard ≥ 0.7), so no occurrence bookkeeping is needed here.
    await addWisdom({
      category: 'tool',
      lesson: `Worker "${workerName}" failed (${plan.reason}) — failover target: ${plan.targetProvider || 'none'}. Avoid worker type "${worker?.type || 'unknown'}" for reason "${plan.reason}" in this session.`,
      confidence: 'high',
    });

    return {
      ...plan,
      teamName,
      workerName,
      prompt: originalPrompt,
      parentRunId: state?.runId || opts.parentRunId || null,
      parentWorkerRunId: workerRunIdentity(worker) || opts.parentWorkerRunId || null,
      rootTeamName: opts.rootTeamName || teamName,
      rootWorkerName: opts.rootWorkerName || workerName,
      rootRunId: opts.rootRunId || state?.runId || opts.parentRunId || null,
      rootWorkerRunId: opts.rootWorkerRunId || workerRunIdentity(worker) || opts.parentWorkerRunId || null,
      rootPrompt: opts.rootPrompt || originalPrompt,
    };
  } catch {
    const fallbackPlan = plan || planProviderFailover(
      { name: workerName, prompt: originalPrompt, type: 'unknown' },
      failureReason,
      opts.capabilities || {},
    );
    if (fallbackPlan.replacementWorker) fallbackPlan.replacementWorker.prompt = originalPrompt;
    return {
      ...fallbackPlan,
      teamName,
      workerName,
      prompt: originalPrompt,
      parentRunId: opts.parentRunId || null,
      parentWorkerRunId: opts.parentWorkerRunId || null,
      rootTeamName: opts.rootTeamName || teamName,
      rootWorkerName: opts.rootWorkerName || workerName,
      rootRunId: opts.rootRunId || opts.parentRunId || null,
      rootWorkerRunId: opts.rootWorkerRunId || opts.parentWorkerRunId || null,
      rootPrompt: opts.rootPrompt || originalPrompt,
    };
  }
}

/** Backward-compatible alias for callers that still use the old Claude-only name. */
export async function reassignToClaude(...args) {
  return reassignProvider(...args);
}

function workerRunIdentity(worker) {
  return worker?._attemptId
    || worker?._handle?.workerRunId
    || worker?._exitNonce
    || worker?.startedAt
    || null;
}

function fallbackRootIdentity(fallback) {
  return {
    teamName: fallback?.rootTeamName || fallback?.teamName || null,
    workerName: fallback?.rootWorkerName || fallback?.workerName || null,
    runId: fallback?.rootRunId || fallback?.parentRunId || null,
    workerRunId: fallback?.rootWorkerRunId || fallback?.parentWorkerRunId || null,
    prompt: fallback?.rootPrompt || fallback?.prompt || fallback?.replacementWorker?.prompt || '',
  };
}

function hasCompleteFallbackRoot(identity) {
  return Boolean(
    identity?.teamName
    && identity?.workerName
    && identity?.runId
    && identity?.workerRunId,
  );
}

function fallbackRootId(fallback) {
  const root = fallbackRootIdentity(fallback);
  return createHash('sha256').update(JSON.stringify([
    root.teamName,
    root.workerName,
    root.runId,
    root.workerRunId,
    root.prompt,
  ])).digest('hex').slice(0, 24);
}

function claudeFallbackStatePath(handoffId) {
  return join(STATE_DIR, `provider-fallback-${handoffId}.json`);
}

function claudeFallbackOutputPath(handoffId) {
  return join(ARTIFACTS_DIR, 'provider-fallback', `${handoffId}.json`);
}

function fallbackLockPath(handoffId, lockDir = STATE_DIR) {
  return join(lockDir, `provider-fallback-${handoffId}.lock`);
}

function processIsAlive(pid) {
  // PID 1 is a valid long-running Node owner in containers. The >1 guard used
  // for process-group signalling must not leak into non-signalling liveness
  // checks or a second caller can steal a live lock from the orchestrator.
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function fallbackLockIsStale(lockPath, opts = {}) {
  try {
    const owner = JSON.parse(readFileSync(lockPath, 'utf-8'));
    if (owner?.schemaVersion !== 1 || !Number.isInteger(owner.pid) || !owner.token) {
      // Older builds published the path before owner metadata was complete.
      // An empty/malformed file may therefore still belong to a paused live
      // creator; elapsed time alone cannot prove otherwise. Fail closed.
      return false;
    }
    if (!processIsAlive(owner.pid)) return true;
    if (typeof owner.startId === 'string' && owner.startId.length > 0) {
      const currentStartId = readProcStartId(owner.pid);
      if (currentStartId !== null && currentStartId !== owner.startId) return true;
    }
    return false;
  } catch { return false; }
}

function fallbackTakeoverIsStale(takeoverPath, opts = {}) {
  try {
    const owner = JSON.parse(readFileSync(join(takeoverPath, 'owner.json'), 'utf-8'));
    if (owner?.schemaVersion !== 1 || !Number.isInteger(owner.pid) || !owner.token) {
      // A legacy takeover directory without authenticated owner metadata may
      // be in the old publish window. Never recursively reclaim it by age.
      return false;
    }
    if (!processIsAlive(owner.pid)) return true;
    if (typeof owner.startId === 'string' && owner.startId.length > 0) {
      const currentStartId = readProcStartId(owner.pid);
      if (currentStartId !== null && currentStartId !== owner.startId) return true;
    }
    return false;
  } catch { return false; }
}

async function withFallbackLock(handoffId, fn, opts = {}) {
  if (opts.withLock) return opts.withLock(handoffId, fn);
  const lockDir = opts.lockDir || STATE_DIR;
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const lockPath = fallbackLockPath(handoffId, lockDir);
  const takeoverPath = `${lockPath}.takeover`;
  const startedAt = Date.now();
  const lockTimeoutMs = Number.isFinite(opts.lockTimeoutMs)
    ? Math.max(0, opts.lockTimeoutMs)
    : CLAUDE_FALLBACK_LOCK_TIMEOUT_MS;
  const owner = {
    schemaVersion: 1,
    pid: process.pid,
    startId: readProcStartId(process.pid),
    createdAt: startedAt,
    token: randomBytes(16).toString('hex'),
  };
  const createOwnedLock = () => {
    // Publish only a fully initialized owner record. Writing directly through
    // open('wx') exposes an empty pathname before writeFileSync; a paused
    // creator could then be misclassified as stale and enter the critical
    // section alongside its replacement. A same-directory hard link is an
    // atomic no-replace publication of the already closed intent file.
    const intentPath = join(lockDir, `.provider-fallback-${handoffId}-${owner.token}.intent`);
    const fd = openSync(intentPath, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(owner)); }
    finally { closeSync(fd); }
    try {
      linkSync(intentPath, lockPath);
    } finally {
      try { unlinkSync(intentPath); } catch {}
    }
  };
  while (true) {
    if (existsSync(takeoverPath)) {
      if (fallbackTakeoverIsStale(takeoverPath, opts)) {
        const observed = statSync(takeoverPath);
        const claim = acquireRecoveryClaim(
          lockDir, `provider-takeover-${handoffId}`, statGeneration(observed),
        );
        if (!claim.won) throw new Error(`Provider fallback takeover recovery already claimed for ${handoffId}`);
        const current = statSync(takeoverPath);
        if (statGeneration(current) === statGeneration(observed)) {
          rmSync(takeoverPath, { recursive: true, force: true });
        }
        continue;
      }
      if (Date.now() - startedAt >= lockTimeoutMs) {
        throw new Error(`Timed out acquiring provider fallback lock for ${handoffId}`);
      }
      await sleep(25);
      continue;
    }
    try {
      createOwnedLock();
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (fallbackLockIsStale(lockPath, opts)) {
        const observedStat = statSync(lockPath);
        let observedOwner = null;
        try { observedOwner = JSON.parse(readFileSync(lockPath, 'utf8')); } catch {}
        const generation = observedOwner?.token || statGeneration(observedStat);
        const claim = acquireRecoveryClaim(
          lockDir, `provider-fallback-${handoffId}`, generation,
        );
        if (!claim.won) throw new Error(`Provider fallback recovery already claimed for ${handoffId}`);
        const currentStat = statSync(lockPath);
        let currentOwner = null;
        try { currentOwner = JSON.parse(readFileSync(lockPath, 'utf8')); } catch {}
        const sameGeneration = observedOwner?.token
          ? currentOwner?.token === observedOwner.token
          : statGeneration(currentStat) === statGeneration(observedStat);
        if (!sameGeneration || !fallbackLockIsStale(lockPath, opts)) {
          throw new Error(`Provider fallback owner changed during recovery for ${handoffId}`);
        }
        unlinkSync(lockPath);
        try {
          createOwnedLock();
          break;
        } catch (createError) {
          if (createError?.code !== 'EEXIST') throw createError;
        }
        continue;
      }
      if (Date.now() - startedAt >= lockTimeoutMs) {
        throw new Error(`Timed out acquiring provider fallback lock for ${handoffId}`);
      }
      await sleep(25);
    }
  }
  try {
    const published = JSON.parse(readFileSync(lockPath, 'utf-8'));
    if (published?.token !== owner.token) {
      throw new Error(`Provider fallback lock ownership changed for ${handoffId}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Provider fallback lock ownership changed')) {
      throw error;
    }
    throw new Error(`Provider fallback lock ownership could not be verified for ${handoffId}`);
  }
  try {
    return await fn();
  } finally {
    try {
      const current = JSON.parse(readFileSync(lockPath, 'utf-8'));
      if (current?.token === owner.token) unlinkSync(lockPath);
    } catch {}
  }
}

function readClaudeFallback(handoffId) {
  try {
    const value = JSON.parse(readFileSync(claudeFallbackStatePath(handoffId), 'utf-8'));
    return value?.schemaVersion === 1 && value.handoffId === handoffId ? value : null;
  } catch {
    return null;
  }
}

function readClaudeFallbackOutput(handoffId) {
  try {
    const value = JSON.parse(readFileSync(claudeFallbackOutputPath(handoffId), 'utf-8'));
    return value?.schemaVersion === 1 && value.handoffId === handoffId
      ? { output: String(value.output ?? ''), claimToken: value.claimToken || null }
      : null;
  } catch {
    return null;
  }
}

function writeClaudeFallback(handoffId, value) {
  atomicWriteFileSync(claudeFallbackStatePath(handoffId), JSON.stringify({
    schemaVersion: 1,
    handoffId,
    ...value,
  }, null, 2));
}

function writeClaudeFallbackOutput(handoffId, output, claimToken, root = null) {
  atomicWriteFileSync(claudeFallbackOutputPath(handoffId), JSON.stringify({
    schemaVersion: 1,
    handoffId,
    claimToken,
    ...(root ? { root } : {}),
    output: String(output ?? ''),
  }));
}

function fallbackIdentityFields(fallback) {
  const root = fallbackRootIdentity(fallback);
  return {
    rootTeamName: root.teamName,
    rootWorkerName: root.workerName,
    rootRunId: root.runId,
    rootWorkerRunId: root.workerRunId,
    rootPrompt: root.prompt,
    handoffId: fallbackRootId(fallback),
  };
}

function matchesFallbackRoot(record, identity) {
  const root = record?.root;
  return record?.schemaVersion === 1
    && root?.teamName === identity.teamName
    && root?.workerName === identity.workerName
    && root?.runId === identity.runId
    && root?.workerRunId === identity.workerRunId;
}

function readCompletedFallback(fallback) {
  const identity = fallbackRootIdentity(fallback);
  if (!hasCompleteFallbackRoot(identity)) return null;
  const handoffId = fallbackRootId(fallback);
  const record = readClaudeFallback(handoffId);
  const outputRecord = readClaudeFallbackOutput(handoffId);
  if (
    record?.status !== 'completed'
    || !matchesFallbackRoot(record, identity)
    || !record.claimToken
    || outputRecord?.claimToken !== record.claimToken
  ) return null;
  return {
    handoffId,
    provider: record.provider || null,
    completedAt: record.completedAt || null,
    output: outputRecord.output,
  };
}

function readCompletedFallbackForWorker(state, worker) {
  return readCompletedFallback({
    rootTeamName: state?.teamName,
    rootWorkerName: worker?.name,
    rootRunId: state?.runId,
    rootWorkerRunId: workerRunIdentity(worker),
    rootPrompt: worker?.originalPrompt || worker?.prompt || '',
  });
}

async function markParentFallbackCompleted(dispatched, handoffId, output, completedAt, opts = {}) {
  const root = fallbackRootIdentity(dispatched);
  if (!hasCompleteFallbackRoot(root)) return false;
  const loadParentState = opts.loadParentState || loadTeamState;
  const saveParentState = opts.saveParentState || saveTeamState;
  const parent = await loadParentState(root.teamName);
  if (!parent || parent.runId !== root.runId || !Array.isArray(parent.workers)) return false;
  const worker = parent.workers.find((candidate) => (
    candidate?.name === root.workerName
    && workerRunIdentity(candidate) === root.workerRunId
  ));
  if (!worker) return false;
  worker.status = 'completed';
  worker.completedAt = new Date(completedAt).toISOString();
  worker._providerFallback = {
    schemaVersion: 1,
    handoffId,
    provider: dispatched?.replacementWorker?.type || dispatched?.targetProvider || null,
    completedAt,
    outputBytes: Buffer.byteLength(String(output ?? ''), 'utf-8'),
  };
  delete worker.error;
  delete worker.errorReason;
  delete worker.errorMessage;
  await saveParentState(root.teamName, parent);
  return true;
}

async function persistProviderFallbackCompletion(dispatched, output, opts = {}) {
  const root = fallbackRootIdentity(dispatched);
  if (!hasCompleteFallbackRoot(root)) return false;
  const handoffId = fallbackRootId(dispatched);
  const completedAt = Number(opts.now ?? Date.now());
  const claimToken = dispatched?.claimToken || `provider-${createHash('sha256').update(JSON.stringify([
    handoffId,
    dispatched?.teamName,
    dispatched?.replacementWorker?.type,
  ])).digest('hex').slice(0, 24)}`;
  const writeStateFn = opts.writeFallbackState || writeClaudeFallback;
  const writeOutputFn = opts.writeFallbackOutput || writeClaudeFallbackOutput;
  return withFallbackLock(handoffId, async () => {
    const existing = await (opts.readFallbackState || readClaudeFallback)(handoffId);
    if (existing?.status === 'completed' && matchesFallbackRoot(existing, root)) {
      const existingOutput = await (opts.readFallbackOutput || readClaudeFallbackOutput)(handoffId);
      const canonicalOutput = existingOutput?.claimToken === existing.claimToken
        ? existingOutput.output
        : String(output ?? '');
      if (existingOutput?.claimToken !== existing.claimToken) {
        await writeOutputFn(handoffId, canonicalOutput, existing.claimToken, root);
      }
      await markParentFallbackCompleted(dispatched, handoffId, canonicalOutput, completedAt, opts);
      return true;
    }
    await writeOutputFn(handoffId, output, claimToken, root);
    await writeStateFn(handoffId, {
      status: 'completed',
      claimToken,
      claimedAt: dispatched?.claimedAt || null,
      completedAt,
      provider: dispatched?.replacementWorker?.type || dispatched?.targetProvider || null,
      childTeamName: dispatched?.teamName || null,
      root,
    });
    await markParentFallbackCompleted(dispatched, handoffId, output, completedAt, opts);
    return true;
  }, opts);
}

/** Record the native Claude Task result so fresh-process polls can reuse it. */
export async function completeClaudeFallback(dispatched, output, opts = {}) {
  if (dispatched?.dispatch !== 'claude-task' || !dispatched.handoffId || !dispatched.claimToken) {
    throw new Error('completeClaudeFallback requires a claimed claude-task dispatch');
  }
  const readStateFn = opts.readState || readClaudeFallback;
  const writeOutputFn = opts.writeOutput || writeClaudeFallbackOutput;
  const writeStateFn = opts.writeState || writeClaudeFallback;
  const now = Number(opts.now ?? Date.now());
  const root = fallbackRootIdentity(dispatched);
  return withFallbackLock(dispatched.handoffId, async () => {
    const current = await readStateFn(dispatched.handoffId);
    if (current?.status !== 'pending' || current.claimToken !== dispatched.claimToken) {
      throw new Error(`Claude fallback lease lost for ${dispatched.handoffId}`);
    }
    await writeOutputFn(dispatched.handoffId, output, dispatched.claimToken, root);
    await writeStateFn(dispatched.handoffId, {
      status: 'completed',
      claimToken: dispatched.claimToken,
      claimedAt: dispatched.claimedAt,
      completedAt: now,
      provider: 'claude',
      root,
    });
    await markParentFallbackCompleted(dispatched, dispatched.handoffId, output, now, opts);
    return { handoffId: dispatched.handoffId, output: String(output ?? '') };
  }, opts);
}

/**
 * Execute the provider portion of a reassignment descriptor. Codex/Gemini
 * replacements run through the existing spawnTeam path under a distinct child
 * team; Claude remains a native executor handoff owned by the orchestrator.
 */
export async function dispatchProviderFallback(fallback, cwd, capabilities = {}, opts = {}) {
  if (!fallback?.fallbackNeeded || !fallback.replacementWorker || !fallback.targetProvider) {
    return { dispatch: 'none', teamName: null, workerName: fallback?.workerName ?? null };
  }
  const rootIdentity = fallbackRootIdentity(fallback);
  if (!hasCompleteFallbackRoot(rootIdentity)) {
    return {
      dispatch: 'none',
      teamName: null,
      workerName: fallback.workerName ?? null,
      reason: 'incomplete provider fallback root identity',
    };
  }
  const identityFields = fallbackIdentityFields(fallback);
  const durableCompletion = readCompletedFallback(fallback);
  if (durableCompletion) {
    return {
      dispatch: fallback.targetProvider === 'claude' ? 'claude-completed' : 'fallback-completed',
      teamName: null,
      workerName: fallback.workerName,
      prompt: fallback.replacementWorker.prompt,
      replacementWorker: fallback.replacementWorker,
      output: durableCompletion.output,
      ...identityFields,
    };
  }
  if (fallback.targetProvider === 'claude') {
    const handoffId = identityFields.handoffId;
    const readStateFn = opts.readState || readClaudeFallback;
    const readOutputFn = opts.readOutput || readClaudeFallbackOutput;
    const writeStateFn = opts.writeState || writeClaudeFallback;
    const now = Number(opts.now ?? Date.now());
    return withFallbackLock(handoffId, async () => {
      const existing = await readStateFn(handoffId);
      const completedOutput = await readOutputFn(handoffId);
      const outputValue = typeof completedOutput === 'string'
        ? { output: completedOutput, claimToken: existing?.claimToken }
        : completedOutput;
      // completeClaudeFallback writes the authenticated output before flipping
      // the lease to completed. If the process dies in that narrow window, the
      // matching output token is sufficient proof that the native Task already
      // returned; promote it instead of waiting for lease expiry and running the
      // same bounded task again.
      if (
        existing?.status === 'pending'
        && existing.claimToken
        && outputValue?.claimToken === existing.claimToken
      ) {
        await writeStateFn(handoffId, {
          status: 'completed',
          claimToken: existing.claimToken,
          claimedAt: existing.claimedAt,
          completedAt: now,
          provider: 'claude',
          root: existing.root || fallbackRootIdentity(fallback),
        });
        await markParentFallbackCompleted(fallback, handoffId, outputValue.output, now, opts);
        return {
          dispatch: 'claude-completed',
          handoffId,
          teamName: null,
          workerName: fallback.workerName,
          prompt: fallback.replacementWorker.prompt,
          replacementWorker: fallback.replacementWorker,
          output: outputValue.output,
          ...identityFields,
        };
      }
      if (
        existing?.status === 'completed'
        && existing.claimToken
        && outputValue?.claimToken === existing.claimToken
      ) {
        return {
          dispatch: 'claude-completed',
          handoffId,
          teamName: null,
          workerName: fallback.workerName,
          prompt: fallback.replacementWorker.prompt,
          replacementWorker: fallback.replacementWorker,
          output: outputValue.output,
          ...identityFields,
        };
      }
      if (existing?.status === 'pending') {
        // A native Task has no durable process handle or cancellation/adoption
        // proof. Time alone can never prove it stopped, so an expired lease is
        // ambiguous and must remain owned by the original claim. Re-dispatching
        // here would run two agents concurrently in the same worktree.
        return {
          dispatch: 'claude-pending',
          handoffId,
          teamName: null,
          workerName: fallback.workerName,
          replacementWorker: fallback.replacementWorker,
          ...identityFields,
        };
      }
      const claimToken = (opts.createClaimToken || (() => randomBytes(16).toString('hex')))();
      await writeStateFn(handoffId, {
        status: 'pending',
        claimToken,
        claimedAt: now,
        completedAt: null,
        provider: 'claude',
        root: fallbackRootIdentity(fallback),
      });
      return {
        dispatch: 'claude-task',
        handoffId,
        claimToken,
        claimedAt: now,
        teamName: null,
        workerName: fallback.workerName,
        prompt: fallback.replacementWorker.prompt,
        replacementWorker: fallback.replacementWorker,
        ...identityFields,
      };
    }, opts);
  }

  const failoverIdentity = JSON.stringify([
    fallback.teamName,
    fallback.workerName,
    fallback.parentRunId,
    fallback.parentWorkerRunId,
    fallback.targetProvider,
    fallback.retry,
    fallback.replacementWorker._providerUnavailableAttempts || 0,
    fallback.replacementWorker._providerCrashAttempts || 0,
    createHash('sha256').update(String(fallback.replacementWorker.prompt || '')).digest('hex'),
  ]);
  const childTeamName = opts.teamName || (
    `failover-${fallback.targetProvider}-` +
    createHash('sha256').update(failoverIdentity).digest('hex').slice(0, 12)
  );
  // Complete root identities share the SAME lock with completion persistence.
  // This closes the cleanup race where a stale parent reads "not completed",
  // the winning poll persists + deletes its child, and the stale caller then
  // observes no child state and spawns the already-finished task again.
  const providerClaimId = hasCompleteFallbackRoot(fallbackRootIdentity(fallback))
    ? identityFields.handoffId
    : `dispatch-${createHash('sha256').update(childTeamName).digest('hex').slice(0, 24)}`;
  return withFallbackLock(providerClaimId, async () => {
    const completionAfterClaim = readCompletedFallback(fallback);
    if (completionAfterClaim) {
      return {
        dispatch: 'fallback-completed',
        teamName: null,
        workerName: fallback.workerName,
        prompt: fallback.replacementWorker.prompt,
        replacementWorker: fallback.replacementWorker,
        output: completionAfterClaim.output,
        ...identityFields,
      };
    }
    const loadTeamStateFn = opts.loadTeamState || loadTeamState;
    const existingState = await loadTeamStateFn(childTeamName);
    if (existingState) {
      const existingWorker = existingState.workers?.[0];
      const existingPrompt = existingWorker?.originalPrompt ?? existingWorker?.prompt;
      const sameWorker = existingState.workers?.length === 1
        && existingWorker?.name === fallback.replacementWorker.name
        && existingWorker?.type === fallback.replacementWorker.type
        && existingPrompt === fallback.replacementWorker.prompt;
      if (sameWorker) {
        return {
          dispatch: 'provider-team',
          teamName: childTeamName,
          workerName: fallback.replacementWorker.name,
          prompt: fallback.replacementWorker.prompt,
          replacementWorker: fallback.replacementWorker,
          state: existingState,
          reused: true,
          ...identityFields,
        };
      }
      const shutdownTeamFn = opts.shutdownTeam || shutdownTeam;
      await shutdownTeamFn(childTeamName, cwd);
    }
    const spawnTeamFn = opts.spawnTeam || spawnTeam;
    const state = await spawnTeamFn(
      childTeamName,
      [fallback.replacementWorker],
      cwd,
      capabilities,
      opts.spawnInject ?? null,
    );
    return {
      dispatch: 'provider-team',
      teamName: childTeamName,
      workerName: fallback.replacementWorker.name,
      prompt: fallback.replacementWorker.prompt,
      replacementWorker: fallback.replacementWorker,
      state,
      reused: false,
      ...identityFields,
    };
  }, opts);
}

/**
 * Poll a dispatched child provider chain. Failed children are reassigned and
 * followed in the same call; deterministic child names make repeated parent
 * polls idempotent. Returns only when the active child is running, completed,
 * needs a native Claude task, or the bounded chain is exhausted.
 */
export async function pollProviderFallback(dispatched, cwd, capabilities = {}, opts = {}) {
  const monitorTeamFn = opts.monitorTeam || monitorTeam;
  const collectResultsFn = opts.collectResults || collectResults;
  const reassignProviderFn = opts.reassignProvider || reassignProvider;
  const dispatchProviderFallbackFn = opts.dispatchProviderFallback || dispatchProviderFallback;
  const persistCompletionFn = opts.persistCompletion
    || ((value, output) => persistProviderFallbackCompletion(value, output, opts));
  let current = dispatched;
  const teamNames = [];

  // Worst valid network path is four observable nodes:
  // Codex retry -> Gemini attempt -> Gemini retry -> Claude. Keep a little
  // headroom for a pre-existing child or one crash retry without turning this
  // into an unbounded self-driving loop.
  const maxDepth = Number.isInteger(opts.maxDepth) ? opts.maxDepth : 8;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (!current || current.dispatch === 'none') return { status: 'none', dispatched: current, teamNames };
    if (current.dispatch === 'claude-completed' || current.dispatch === 'fallback-completed') {
      await persistCompletionFn(current, current.output ?? '');
      return { status: 'completed', dispatched: current, teamNames, output: current.output };
    }
    if (current.dispatch === 'claude-pending') {
      return { status: 'running', dispatched: current, teamNames };
    }
    if (current.dispatch === 'claude-task') return { status: 'claude-task', dispatched: current, teamNames };
    if (!teamNames.includes(current.teamName)) teamNames.push(current.teamName);

    const status = monitorTeamFn(current.teamName);
    const workers = Array.isArray(status?.workers) ? status.workers : [];
    if (workers.some((worker) => worker.status === 'running' || worker.status === 'retry')) {
      return { status: 'running', dispatched: current, teamNames };
    }
    if (workers.length > 0 && workers.every((worker) => worker.status === 'completed')) {
      const results = collectResultsFn(current.teamName);
      const completedWorker = workers.find((worker) => worker.name === current.workerName);
      const hasDurableOutput = Object.hasOwn(results || {}, current.workerName);
      const output = hasDurableOutput
        ? results[current.workerName]
        : typeof completedWorker?.lastOutput === 'string'
          ? completedWorker.lastOutput
          : null;
      if (output === null) {
        return {
          status: 'failed',
          dispatched: current,
          teamNames,
          reason: 'completed provider child has no durable output or snapshot tail',
        };
      }
      await persistCompletionFn(current, output);
      return {
        status: 'completed',
        dispatched: current,
        output,
        teamNames,
      };
    }

    const failed = workers.find((worker) => worker.status === 'failed');
    if (!failed) return { status: 'failed', dispatched: current, teamNames, reason: 'missing child worker status' };
    const root = fallbackRootIdentity(current);
    const fallback = await reassignProviderFn(
      current.teamName,
      current.workerName,
      current.prompt,
      { category: failed.errorReason, message: failed.errorMessage },
      undefined,
      {
        capabilities,
        rootTeamName: root.teamName,
        rootWorkerName: root.workerName,
        rootRunId: root.runId,
        rootWorkerRunId: root.workerRunId,
        rootPrompt: root.prompt,
      },
    );
    const chainedFallback = {
      ...fallback,
      rootTeamName: root.teamName,
      rootWorkerName: root.workerName,
      rootRunId: root.runId,
      rootWorkerRunId: root.workerRunId,
      rootPrompt: root.prompt,
    };
    current = await dispatchProviderFallbackFn(chainedFallback, cwd, capabilities);
  }
  return { status: 'failed', dispatched: current, teamNames, reason: 'provider failover depth exceeded' };
}

/**
 * Provider-specific worker fields that must NOT survive a codex→claude
 * demotion. `model` is the canonical example: a Codex model name like
 * `gpt-5` would be passed straight through to `claude-cli --model` and
 * fail. Stripping the field forces the demoted worker to use the Claude
 * default model instead.
 */
const CODEX_PROVIDER_FIELDS = ['model'];

/**
 * Demote codex-typed workers to claude when the host permission level is
 * too low for non-interactive codex execution. Mutates each worker in-place:
 * sets `type: 'claude'`, records `_demotedFrom: 'codex'` /
 * `_demotionReason: ...`, and strips provider-specific fields (`model`)
 * that would break the Claude path. Returns the count of demoted workers.
 * Exported for hermetic unit testing.
 *
 * Why demote: a `'suggest'` level → `read-only` sandbox would let codex
 * silently complete with "I can only suggest changes" and confuse Atlas/
 * Athena into marking the task done.
 *
 * @param {Array<{type: string}>} workers - Worker descriptors (mutated in place)
 * @param {'suggest'|'auto-edit'|'full-auto'} level - Resolved permission level
 * @returns {number} Count of demoted workers
 */
export function demoteCodexWorkersIfNeeded(workers, level) {
  if (!shouldDemoteCodexWorker(level)) return 0;
  let demoted = 0;
  for (const w of workers) {
    if (w && w.type === 'codex') {
      w._demotedFrom = 'codex';
      w._demotionReason = (
        `host permission level (${level}) too low for non-interactive codex worker. ` +
        `Codex's coarse sandbox cannot honor scoped Bash grants or scoped deny/ask ` +
        `rules in your Claude settings. Fix: add \`"codex": { "approval": "full-auto" }\` ` +
        `to .ao/autonomy.json (explicit override), or add LITERAL "Bash(*)" + "Write(*)" ` +
        `to permissions.allow (and remove scoped Bash/Write deny/ask), or set ` +
        `permissions.defaultMode = "bypassPermissions" in .claude/settings.local.json.`
      );
      w.type = 'claude';
      // Strip provider-specific fields that would corrupt the Claude path.
      stripProviderFields(w, CODEX_PROVIDER_FIELDS);
      demoted++;
    }
  }
  return demoted;
}

/**
 * Spawn a team of workers via the appropriate adapters.
 *
 * Production call signature is `spawnTeam(teamName, workers, cwd, capabilities)`.
 * Callers may pass a fifth options object with a preallocated `runId`. Tests
 * also use that object to supply a fake `spawnSupervisor`
 * (recorder / fake child instead of a real detached supervisor), a `supervisor`
 * override ({ adapterName, env } — used to route the manifest to the env-gated
 * fixture adapter), and a fake `createTeamSession` (bypassing real tmux).
 * Production callers must not use the test-only injection keys.
 *
 * @param {string} teamName
 * @param {Array<Object>} workers
 * @param {string} cwd
 * @param {Object} [capabilities]
 * @param {Object} [_inject] - Test-only dependency injection
 * @param {string} [_inject.runId] - Preallocated 16-character team generation
 * @param {Function} [_inject.spawnSupervisor] - Replaces the detached supervisor spawn (recorder / fake child)
 * @param {Object} [_inject.supervisor] - { adapterName?, env? } — route the manifest to the env-gated fixture adapter
 * @param {Function} [_inject.createTeamSession] - Replaces tmux session creation
 * @param {Function} [_inject.validateTmux] - Replaces tmux install check
 */
export async function spawnTeam(teamName, workers, cwd, capabilities = {}, _inject = null) {
  const runId = _inject?.runId ?? allocateTeamRunId();
  if (!TEAM_RUN_ID.test(runId)) {
    throw new Error('spawnTeam runId must be a 16-character lowercase hex generation');
  }
  // ─── Codex permission mirroring + demotion + host sandbox warning ──────
  // Resolve the effective codex level once (intersects permissions.allow
  // with host sandbox detection).
  const autonomy = loadAutonomyConfig(cwd);
  const codexLevel = resolveCodexApproval(autonomy, { cwd });
  demoteCodexWorkersIfNeeded(workers, codexLevel);

  // Build credential resolver opts once (used by every gemini spawn below).
  // gemini-exec / gemini-acp inject the resolved key into child process env
  // at spawn time, so users with `gemini /auth` completed can run team
  // sessions without exporting GEMINI_API_KEY.
  const geminiCredential = {
    credentialSource: autonomy.gemini?.credentialSource,
    service: autonomy.gemini?.keychainService,
    useKeychain: autonomy.gemini?.useKeychain,
    account: autonomy.gemini?.keychainAccount || 'default-api-key',
  };

  // Surface host-sandbox ambiguity to the user via wisdom. When the host is
  // clearly sandboxed (container/seccomp/etc) but detection couldn't pin
  // down a tier, silently trusting `permissions.allow` would be wrong.
  // `addWisdom` dedupes on Jaccard similarity, so this won't spam the log
  // on repeated Atlas/Athena runs.
  try {
    const hostSandbox = detectHostSandbox({ cwd, autonomyConfig: autonomy });
    const warning = buildHostSandboxWarning(codexLevel, hostSandbox);
    if (warning && workers.some(w => w && w.type === 'codex')) {
      // Fire-and-forget — never block spawnTeam on wisdom logging
      addWisdom({
        category: 'architecture',
        lesson: warning,
        confidence: 'medium',
      }).catch(() => {});
    }
  } catch {
    // Wisdom warning is best-effort; never let it block spawnTeam
  }

  // Determine adapter per worker (after demotion)
  const adapterNames = workers.map(w => selectAdapter(w, capabilities));
  const needsTmux = adapterNames.some(a => a === 'tmux');

  // Tmux availability check — tests can inject a fake validator
  const tmuxValidator = _inject?.validateTmux || validateTmux;
  if (needsTmux && !tmuxValidator()) {
    throw new Error('tmux is not installed. Run: brew install tmux');
  }

  // FLIP (P4): adapter workers no longer spawn in-process here — each is run by
  // a DETACHED supervisor that loads the adapter itself and writes disk
  // snapshots/output. So spawnTeam no longer loads adapter modules.

  // FLIP (P4): a run identity scopes the supervisor's disk files so a STALE
  // supervisor from a prior same-name run can't be read as current. projectRoot
  // is ABSOLUTE so a detached supervisor (different cwd) resolves paths correctly.
  const projectRoot = resolve(cwd);
  const state = {
    teamName,
    runId,
    projectRoot,
    capabilities: normalizeCapabilities(capabilities),
    workers: workers.map((w, i) => ({
      ...w,
      // Exists before any adapter/tmux launch can fail, so every logical root
      // attempt has a durable identity suitable for idempotent failover.
      _attemptId: randomBytes(8).toString('hex'),
      status: 'pending',
      startedAt: null,
      completedAt: null,
      retryCount: 0,
      originalPrompt: w.prompt || '',
      _adapterName: adapterNames[i],
    })),
    phase: 'spawning',
    startedAt: new Date().toISOString(),
    cwd
  };

  // Launch a DETACHED supervisor for one adapter worker. The manifest carries
  // DATA only (paths are derived from the run IDs, never trusted from it); the
  // fixture adapter is unreachable in production (AO_SUPERVISOR_ALLOW_FIXTURE is
  // stripped from the child env). Tests inject `_inject.spawnSupervisor` (a
  // recorder / fake child) and `_inject.supervisor` (fixture adapterName + env).
  const spawnSupervisorFn = _inject?.spawnSupervisor
    || ((script, mPath, opts) => {
      const c = spawn(process.execPath, [script, mPath], opts);
      // An ASYNC spawn failure (ENOENT/EAGAIN/resource limit) is reported via the
      // child's 'error' event — with no listener Node re-throws it as an uncaught
      // exception in the orchestrator. Swallow it here (single-line stderr note);
      // the worker writes no snapshot, so monitorSupervisorWorker's
      // missing-snapshot-past-grace path (P3) marks it crashed on the next poll.
      c.on('error', (err) => {
        try { process.stderr.write(JSON.stringify({ event: 'supervisor_spawn_error', message: String(err?.message || err) }) + '\n'); } catch {}
      });
      c.unref();
      return c;
    });
  const launchSupervisor = (i) => {
    const worker = workers[i];
    const adapterName = adapterNames[i];
    const workerRunId = randomBytes(8).toString('hex');
    const wantsGemini = adapterName === 'gemini-exec' || adapterName === 'gemini-acp';
    const manifest = {
      schemaVersion: 1, runId, workerRunId, teamName,
      workerName: worker.name, adapterName,
      projectRoot, cwd: worker.cwd || projectRoot, prompt: worker.prompt || '',
      level: codexLevel, model: worker.model || null,
      systemPrompt: worker.systemPrompt || null, maxBudgetUsd: worker.maxBudgetUsd || null,
      approvalMode: worker.approvalMode || null,
      geminiCredential: wantsGemini ? geminiCredential : null,
      timeoutMs: Number.isInteger(worker.timeoutMs) ? worker.timeoutMs : 600000,
    };
    if (worker.fixture) manifest.fixture = worker.fixture;                       // test-only params
    if (_inject?.supervisor?.adapterName) manifest.adapterName = _inject.supervisor.adapterName; // test-only
    let mPath = null;
    try {
      mPath = supManifestPath(projectRoot, runId, workerRunId);
      atomicWriteFileSync(mPath, JSON.stringify(manifest));
      const env = { ...process.env };
      delete env.AO_SUPERVISOR_ALLOW_FIXTURE;                                    // never expose the fixture in prod
      if (_inject?.supervisor?.env) Object.assign(env, _inject.supervisor.env); // test-only
      const child = spawnSupervisorFn(SUPERVISOR_SCRIPT, mPath, { detached: true, stdio: 'ignore', cwd: projectRoot, env });
      // A failed spawn can return a handle with pid === undefined (the 'error'
      // fires async). Treat a missing pid as a launch failure NOW rather than
      // persisting an unmonitorable "running" worker with no supervisor pid.
      if (!child || !Number.isInteger(child.pid)) {
        throw new Error('supervisor spawn returned no pid (launch failed)');
      }
      state.workers[i].status = 'running';
      state.workers[i].startedAt = new Date().toISOString();
      state.workers[i]._handle = { supervisorPid: child.pid, supervisorStartId: readProcStartId(child.pid), runId, workerRunId };
    } catch (err) {
      state.workers[i].status = 'failed';
      state.workers[i].error = err.message;
      // The manifest carries the raw prompt; on a launch failure the supervisor
      // never started to clear it (it truncates+unlinks on startup), so do that
      // here rather than leak the prompt until the 24h stale sweep.
      if (mPath) {
        try { atomicWriteFileSync(mPath, ''); } catch { /* best-effort */ }
        try { unlinkSync(mPath); } catch { /* best-effort */ }
      }
    }
  };

  // Spawn tmux workers first (need sessions created in batch).
  // Tests can inject a fake createTeamSession to avoid real tmux.
  //
  // For gemini tmux workers, attach GEMINI_API_KEY to worker.env so
  // createTeamSession passes it via `tmux new-session -e` — the key enters
  // the shell's initial environment without being typed through send-keys,
  // so it never appears in capture-pane output or shell history. If the
  // resolver returns null (no key configured), we skip injection.
  const createTeamSessionFn = _inject?.createTeamSession || createTeamSession;
  const tmuxWorkers = workers.map((w, i) => ({ ...w, idx: i })).filter((_, i) => adapterNames[i] === 'tmux');
  if (tmuxWorkers.length > 0) {
    try {
      const { resolveGeminiApiKey } = await import('./gemini-credential.mjs');
      for (const tw of tmuxWorkers) {
        if (tw.type !== 'gemini') continue;
        // Respect an explicit caller override (including empty string for
        // "explicitly disabled") — only auto-resolve when unset.
        const existing = tw.env && Object.prototype.hasOwnProperty.call(tw.env, 'GEMINI_API_KEY');
        if (existing) continue;
        const key = resolveGeminiApiKey(geminiCredential);
        if (key) {
          tw.env = { ...(tw.env || {}), GEMINI_API_KEY: key };
        }
      }
    } catch { /* resolver missing or failed — fall through without env injection */ }
  }
  let sessions = [];
  if (tmuxWorkers.length > 0) {
    sessions = createTeamSessionFn(teamName, tmuxWorkers, cwd);
  }

  let tmuxIdx = 0;
  for (let i = 0; i < workers.length; i++) {
    const worker = workers[i];

    if (adapterNames[i] !== 'tmux') {
      // FLIP (P4): a DETACHED supervisor owns the adapter's live handle and
      // writes the disk snapshot/output a fresh-process orchestrator reads.
      // No in-process adapter spawn / _liveHandle anymore.
      launchSupervisor(i);
    } else {
      // Spawn via tmux
      const session = sessions[tmuxIdx++];
      if (!session || session.status !== 'created') {
        state.workers[i].status = 'failed';
        state.workers[i].error = session?.error || 'Session creation failed';
        state.workers[i].worktreePath = session?.worktreePath || null;
        state.workers[i].branchName = session?.branchName || null;
        state.workers[i].worktreeCreated = session?.worktreeCreated || false;
        state.workers[i].worktreeInherited = session?.worktreeInherited || false;
        continue;
      }

      // Per-invocation nonce scopes this worker's exit sentinel so its own
      // output can't forge a completion. Persisted on the worker (serializable
      // string) and read back by classifyTmuxWorker → parseExitMarker.
      const exitNonce = randomBytes(8).toString('hex');
      const command = buildWorkerCommand(worker, { cwd: session?.worktreePath || cwd, exitNonce });
      const env = {
        AO_TEAM_NAME: teamName,
        AO_WORKER_NAME: worker.name,
        AO_WORKER_TYPE: worker.type
      };

      const spawned = spawnWorkerInSession(session.session, command, env);
      state.workers[i].status = spawned ? 'running' : 'failed';
      state.workers[i].startedAt = new Date().toISOString();
      state.workers[i]._exitNonce = exitNonce;
      state.workers[i].session = session.session;
      state.workers[i].worktreePath = session?.worktreePath || null;
      state.workers[i].branchName = session?.branchName || null;
      state.workers[i].worktreeCreated = session?.worktreeCreated || false;
      state.workers[i].worktreeInherited = session?.worktreeInherited || false;
    }

    // Capture this worker's process-group start-time identity IMMEDIATELY after
    // spawn (NOT in a post-loop pass): an early, short-lived adapter worker whose
    // pid is recycled during a LATER worker's (possibly slow/awaited) spawn must
    // not have a stranger's identity recorded as its baseline (F3 race). The
    // serializable string survives the disk round-trip a fresh-process shutdown
    // relies on. tmux workers have no `_handle.pid` and are skipped.
    const _wh = state.workers[i]?._handle;
    if (_wh && Number.isInteger(_wh.pid)) _wh.startId = readProcStartId(_wh.pid);
  }

  state.phase = 'running';
  saveTeamState(teamName, state);
  return state;
}

export function monitorTeam(teamName, _codexExecModule, _codexAppServerModule, _claudeCliModule, _geminiExecModule, _geminiAcpModule) {
  const state = loadTeamState(teamName);
  if (!state) return null;

  // Build adapter modules map from positional args (backward-compatible signature)
  const adapterModules = {
    'codex-exec': _codexExecModule || null,
    'codex-appserver': _codexAppServerModule || null,
    'claude-cli': _claudeCliModule || null,
    'gemini-exec': _geminiExecModule || null,
    'gemini-acp': _geminiAcpModule || null,
  };

  const status = {
    teamName,
    runId: state.runId,
    phase: state.phase,
    workers: [],
    outboxes: readAllOutboxes(teamName)
  };

  let stateChanged = false;

  for (let i = 0; i < state.workers.length; i++) {
    const worker = state.workers[i];
    const adapterName = worker._adapterName || 'tmux';

    // ─── Dispatch monitoring to correct adapter via registry ───
    let monitorResult;
    const registryEntry = ADAPTER_REGISTRY[adapterName];
    const adapterModule = registryEntry ? adapterModules[adapterName] : null;
    const now = Date.now();
    const fallbackCompletion = readCompletedFallbackForWorker(state, worker);

    // Reader order (Codex-mandated): an in-process live handle → the supervisor's
    // disk snapshot → tmux/legacy. The supervisor branch is gated on an explicit
    // descriptor (isSupervisorWorker) so it stays dormant until spawnTeam (P4)
    // launches supervisors; a disk-loaded handle is stripped/husk so isLiveHandle
    // rejects it.
    if (fallbackCompletion) {
      // A completed fallback is the canonical outcome for the root task. This
      // overlay is read from the run+worker-scoped durable record, so cleaning
      // a child team or resuming in a fresh process cannot resurrect the
      // original failed adapter attempt.
      monitorResult = { status: 'completed', output: fallbackCompletion.output };
    } else if (registryEntry && adapterModule && isLiveHandle(worker[registryEntry.handleKey])) {
      monitorResult = monitorAdapterWorker(worker, adapterModule, registryEntry);
    } else if (isSupervisorWorker(state, worker)) {
      monitorResult = monitorSupervisorWorker(state, worker, now);
    } else {
      monitorResult = monitorTmuxWorker(worker);
    }

    // Latch the supervisor stale-heartbeat 2-poll confirmation across polls.
    if (monitorResult._staleSeen) {
      if (!worker._supStaleSeen) { state.workers[i]._supStaleSeen = true; stateChanged = true; }
    } else if (worker._supStaleSeen) {
      delete state.workers[i]._supStaleSeen; stateChanged = true;
    }

    // ─── Activity-based stall detection (adapter-agnostic) ───
    const currentHash = quickHash(monitorResult.output);
    const prevHash = worker.lastOutputHash || null;

    if (currentHash !== prevHash) {
      state.workers[i].lastOutputHash = currentHash;
      state.workers[i].lastActivityAt = new Date(now).toISOString();
      stateChanged = true;
    } else if (worker.status === 'running' && worker.lastActivityAt) {
      const stalledMs = now - new Date(worker.lastActivityAt).getTime();
      if (stalledMs > STALL_THRESHOLD_MS && !worker.stalled) {
        state.workers[i].stalled = true;
        state.workers[i].stalledMs = stalledMs;
        stateChanged = true;
      }
    }
    if (!state.workers[i].lastActivityAt && worker.status === 'running') {
      state.workers[i].lastActivityAt = new Date(now).toISOString();
      state.workers[i].lastOutputHash = currentHash;
      stateChanged = true;
    }

    // Count distinct provider-unavailability failures. A worker already marked
    // failed is the same terminal attempt being re-polled, so it must not
    // increment the counter again.
    if (monitorResult.error && PROVIDER_UNAVAILABLE_CATEGORIES.has(monitorResult.error.category)) {
      // The same terminal snapshot may be polled repeatedly. Count only a new
      // execution identity, never monitor polls, as another unavailable attempt.
      const attemptKey = worker._handle?.workerRunId || worker._exitNonce || worker.startedAt || null;
      if (attemptKey && attemptKey !== worker._providerUnavailableAttemptKey) {
        state.workers[i]._providerUnavailableAttempts = (worker._providerUnavailableAttempts || 0) + 1;
        state.workers[i]._providerUnavailableAttemptKey = attemptKey;
        stateChanged = true;
      }
      const exhaustion = detectProviderExhaustion(
        monitorResult.error,
        state.workers[i]._providerUnavailableAttempts || 0,
      );
      if (exhaustion.exhausted) {
        monitorResult = {
          ...monitorResult,
          error: {
            category: 'provider_exhausted',
            message: `${monitorResult.error.message} (repeated provider unavailability)`,
          },
        };
      }
    } else if (monitorResult.status === 'completed' && worker._providerUnavailableAttempts) {
      delete state.workers[i]._providerUnavailableAttempts;
      delete state.workers[i]._providerUnavailableAttemptKey;
      stateChanged = true;
    }

    // ─── Resolve final status ───
    let resolvedStatus = worker.status;
    if (monitorResult.status === 'completed') {
      resolvedStatus = 'completed';
    } else if (monitorResult.error) {
      // A retry must be a NEW provider execution, not a status flip over the
      // same terminal snapshot. planProviderFailover + dispatch own retries.
      resolvedStatus = 'failed';
    }

    const workerEntry = {
      name: worker.name,
      type: worker.type,
      status: resolvedStatus,
      originalPrompt: worker.originalPrompt || worker.prompt || '',
      lastOutput: monitorResult.output || null,
    };
    if (fallbackCompletion) {
      workerEntry.fallbackProvider = fallbackCompletion.provider;
      workerEntry.fallbackHandoffId = fallbackCompletion.handoffId;
    }

    if (monitorResult.error) {
      workerEntry.errorReason = monitorResult.error.category;
      workerEntry.errorMessage = monitorResult.error.message;
    }

    // ─── Stall recovery (adapter-agnostic) ───
    if (state.workers[i].stalled && !state.workers[i].recovered) {
      workerEntry.stalled = true;
      workerEntry.stalledMs = state.workers[i].stalledMs;

      if (state.workers[i].recoveryAttempts == null) {
        state.workers[i].recoveryAttempts = 0;
      }
      try {
        workerEntry.recoveryStrategy = buildRecoveryStrategy(
          { name: worker.name, type: worker.type, status: worker.status, lastOutput: workerEntry.lastOutput, stalledMs: state.workers[i].stalledMs, recoveryAttempts: state.workers[i].recoveryAttempts },
          { teamName, orchestrator: 'athena', availableAgents: [] }
        );
      } catch {}
      state.workers[i].recoveryAttempts = (state.workers[i].recoveryAttempts || 0) + 1;
      stateChanged = true;
    }

    status.workers.push(workerEntry);

    // Persist status changes
    if (resolvedStatus !== state.workers[i].status) {
      state.workers[i].status = resolvedStatus;
      if (workerEntry.errorReason) {
        state.workers[i].errorReason = workerEntry.errorReason;
        state.workers[i].errorMessage = workerEntry.errorMessage;
      } else if (resolvedStatus === 'completed') {
        delete state.workers[i].errorReason;
        delete state.workers[i].errorMessage;
      }
      stateChanged = true;
    }
    if (fallbackCompletion && state.workers[i]._providerFallback?.handoffId !== fallbackCompletion.handoffId) {
      state.workers[i]._providerFallback = {
        schemaVersion: 1,
        handoffId: fallbackCompletion.handoffId,
        provider: fallbackCompletion.provider,
        completedAt: fallbackCompletion.completedAt,
        outputBytes: Buffer.byteLength(fallbackCompletion.output, 'utf-8'),
      };
      stateChanged = true;
    }
  }

  if (stateChanged) saveTeamState(teamName, state);
  return status;
}

export function collectResults(teamName) {
  const outboxes = readAllOutboxes(teamName);
  const results = {};

  for (const [worker, messages] of Object.entries(outboxes)) {
    results[worker] = messages.map(m => m.body).join('\n\n');
  }

  const state = loadTeamState(teamName);
  if (state) {
    for (const worker of state.workers) {
      // A fallback completion supersedes partial output from the failed root
      // attempt (including an outbox message). It is the canonical result.
      const fallbackCompletion = readCompletedFallbackForWorker(state, worker);
      if (fallbackCompletion) {
        results[worker.name] = fallbackCompletion.output;
        continue;
      }

      // Skip workers that already have outbox results
      if (results[worker.name]) continue;

      const adapter = worker._adapterName || 'tmux';

      // Non-tmux adapters expose live output on _liveHandle._output, but that
      // only exists for a REAL in-process handle. Across process boundaries
      // (the common case — orchestrator steps reload state from disk where
      // _liveHandle is stripped) adapter output is NOT recoverable here; those
      // workers deliver results via the outbox (read above). Reaching a
      // function-less husk's _output is also pointless — it was empty at save
      // time. Proper cross-process adapter-output capture needs a supervisor /
      // adapter-owned state file (tracked separately).
      const registryEntry = ADAPTER_REGISTRY[adapter];
      if (isSupervisorWorker(state, worker)) {
        // Supervisor worker: the durable output file is authoritative across the
        // fresh-process boundary.
        try {
          const op = supOutputPath(state.projectRoot, state.runId, worker._handle.workerRunId);
          if (existsSync(op)) { const o = readFileSync(op, 'utf-8'); if (o) results[worker.name] = o; }
        } catch { /* best-effort */ }
      } else if (registryEntry && isLiveHandle(worker._liveHandle)) {
        const output = worker._liveHandle._output;
        if (output) results[worker.name] = output;
      } else if (worker.session) {
        // Tmux: capture pane output
        const output = capturePane(worker.session, 200);
        if (output) results[worker.name] = output;
      }
    }
  }

  const artifactsDir = join(ARTIFACTS_DIR, 'team', teamName);
  mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });

  for (const [worker, result] of Object.entries(results)) {
    atomicWriteFileSync(
      join(artifactsDir, `${worker}.md`),
      `# ${worker} Output\n\n${result}`
    );
  }

  return results;
}

export async function shutdownTeam(teamName, cwd) {
  // Shutdown non-tmux workers first (appserver + codex-exec child processes)
  const state = loadTeamState(teamName);
  const orphanPids = [];
  const supWorkers = [];
  if (state && Array.isArray(state.workers)) {
    for (const worker of state.workers) {
      if (isSupervisorWorker(state, worker)) {
        // Handled supervisor-first below (signal supervisor → wait → reap adapter).
        supWorkers.push(worker);
        continue;
      }
      const adapter = worker._adapterName || 'tmux';
      const registryEntry = ADAPTER_REGISTRY[adapter];
      if (!registryEntry) continue; // tmux workers handled by killTeamSessions below

      if (isLiveHandle(worker._liveHandle)) {
        // In-process live handle (same-process shutdown — rare, since callers
        // re-load state from disk in a fresh node process). Graceful adapter
        // shutdown owns its own SIGTERM → SIGKILL escalation.
        try {
          const adapterModule = await registryEntry.loader();
          await adapterModule[registryEntry.shutdownFn](worker._liveHandle);
        } catch {
          // Best-effort cleanup
        }
      } else if (Number.isInteger(worker._handle?.pid) && worker._handle.pid > 1) {
        // Disk-loaded state: _liveHandle was stripped by saveTeamState, or it
        // survives only as a function-less husk from a PRE-FIX state file (old
        // no-replacer saveTeamState). isLiveHandle() rejects the husk so we
        // don't waste the shutdown on a no-op and skip the kill — without this
        // the real detached process group is never signaled and codex/gemini/
        // claude workers leak as orphans. Collect {pid,startId} and signal in
        // one pass — startId lets killProcessGroups skip a recycled pid (F3).
        orphanPids.push({ pid: worker._handle.pid, startId: worker._handle.startId });
      }
    }
  }

  // Supervisor workers: supervisor-first graceful shutdown, then adapter reap.
  for (const w of supWorkers) { await shutdownSupervisorWorker(state, w); }
  // Signal orphaned detached process groups (SIGTERM → grace → SIGKILL).
  await killProcessGroups(orphanPids);

  // Kill tmux sessions
  const killed = killTeamSessions(teamName);
  cleanupTeam(teamName);

  if (cwd) {
    try { cleanupTeamWorktrees(cwd, teamName); } catch {}
  }

  const statePath = join(STATE_DIR, `team-${teamName}.json`);
  try { unlinkSync(statePath); } catch {}

  return { killed };
}
