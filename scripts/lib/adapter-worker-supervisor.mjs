#!/usr/bin/env node
/**
 * adapter-worker-supervisor.mjs — F1 supervisor (P2).
 *
 * Run DETACHED, one per non-tmux adapter worker:
 *   node adapter-worker-supervisor.mjs <manifestPath>
 *
 * It owns the adapter's live handle (which the orchestrator's stripped, disk-
 * loaded state cannot), runs ONE prompt to terminal completion, and writes
 * atomic DISK snapshots + durable output so a later fresh orchestrator process
 * can read the worker's outcome.
 *
 * Key invariants (per the Codex plan reviews):
 *  - Paths are DERIVED from validated hex IDs + the absolute projectRoot in the
 *    manifest — never module/output paths from the manifest (no code-load /
 *    arbitrary-write capability). adapterName is checked against a FIXED
 *    allowlist; a built-in `fixture` flow is selectable ONLY when
 *    AO_SUPERVISOR_ALLOW_FIXTURE==='1' (tests), behavior from params only.
 *  - Killing the supervisor's process group does NOT reach the adapter (adapters
 *    spawn their own detached group), so SIGTERM/SIGINT handlers gracefully shut
 *    the adapter down here.
 *  - The terminal path (shutdown → output → terminal snapshot → exit) runs
 *    EXACTLY ONCE via a `settled` guard, across the signal, watchdog,
 *    completion, and uncaught paths.
 *  - records adapterPid + adapterStartId for the orchestrator's F3 orphan kill.
 *
 * Fail-safe: any error → a terminal `failed` snapshot, never a hang.
 * Zero npm deps.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { readProcStartId } from './proc-identity.mjs';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import {
  snapshotPath, outputPath, writeSnapshot, isValidId, sanitizeWorkerMeta,
  HEARTBEAT_INTERVAL_MS,
} from './supervisor-state.mjs';
import { buildExecOpts, buildAppserverThreadOpts, buildGeminiAcpSessionOpts } from './supervisor-opts.mjs';

/** Practical ceiling so a manifest can't overflow Node's 32-bit timer (→ 1ms). */
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h
const FIXTURE_MAX_OUTPUT_BYTES = 64 * 1024;

const ADAPTER_ALLOWLIST = new Set([
  'codex-exec', 'codex-appserver', 'claude-cli', 'gemini-exec', 'gemini-acp',
]);
// Adapter graceful-shutdown ceiling. The orchestrator's supervisor-group kill
// grace must exceed this (set in P5) so the supervisor finishes cleanup first.
const ADAPTER_SHUTDOWN_GRACE_MS = 5000;
const FIXTURE_MAX_DELAY_MS = 30_000;

// ─── shared terminal state ──────────────────────────────────────────────────
let settled = false;
let heartbeatTimer = null;
let watchdogTimer = null;
let liveHandle = null;            // current adapter handle (for signal cleanup)
let liveShutdown = null;          // (h, graceMs) => Promise | void
let base = null;                  // base snapshot fields (identity)
let snapPath = null;
let outPath = null;

function nowMs() { return Date.now(); }

function writeRunningSnapshot(extra = {}) {
  if (settled || !snapPath || !base) return;
  try { writeSnapshot(snapPath, { ...base, status: 'running', ...extra }, nowMs()); } catch { /* best-effort */ }
}

async function shutdownAdapter() {
  if (liveHandle && liveShutdown) {
    const h = liveHandle; liveHandle = null;
    try { await liveShutdown(h, ADAPTER_SHUTDOWN_GRACE_MS); } catch { /* best-effort */ }
  }
  // The adapter shutdowns signal only the GROUP LEADER and stop escalating once
  // it exits — leaving descendants alive. The adapter child is its own detached
  // group leader (pgid === adapterPid), so reap any survivors here. The window
  // between the graceful shutdown and this reap is microseconds, so PID reuse is
  // negligible; probe first to avoid signaling an already-gone group.
  const apid = base && base.adapterPid;
  if (Number.isInteger(apid) && apid > 1) {
    try { process.kill(-apid, 0); process.kill(-apid, 'SIGKILL'); } catch { /* group already gone */ }
  }
}

/**
 * Run the terminal sequence EXACTLY once: stop timers, shut the adapter down,
 * write the full output (durable) + the terminal snapshot, then exit.
 */
async function settle(status, error, output, extra = {}) {
  if (settled) return;
  settled = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (watchdogTimer) clearTimeout(watchdogTimer);
  await shutdownAdapter();

  const text = typeof output === 'string' ? output : '';
  let outputBytes = 0;
  try {
    if (outPath) { atomicWriteFileSync(outPath, text); outputBytes = Buffer.byteLength(text, 'utf-8'); }
  } catch { /* full output is best-effort; the inline tail in the snapshot remains */ }

  // The terminal SNAPSHOT is the authoritative record the orchestrator reads. If
  // it cannot be persisted we must NOT exit `0` claiming success — retry once,
  // then exit non-zero so a fresh reader sees `missing` → crash (after grace)
  // rather than a phantom completion.
  let snapshotWritten = false;
  for (let attempt = 0; attempt < 2 && !snapshotWritten; attempt++) {
    try {
      writeSnapshot(snapPath, {
        ...base,
        status,
        completedAt: nowMs(),
        error: error || null,
        outputTail: text, // writeSnapshot clamps to MAX_OUTPUT_TAIL_BYTES
        outputBytes,
        ...extra,
      }, nowMs());
      snapshotWritten = true;
    } catch { /* retry once */ }
  }

  process.exit(status === 'completed' && snapshotWritten ? 0 : 1);
}

function fail(category, message) {
  // Schedule on the microtask queue so handlers can be installed first.
  return settle('failed', { category, message: String(message || category) }, '');
}

// ─── adapter flavors → normalized {status, output, error} ───────────────────

function normalize(res) {
  const output = typeof res?.output === 'string' ? res.output : '';
  if (res && res.status === 'completed') return { status: 'completed', output, error: null };
  const e = res && res.error;
  return {
    status: 'failed',
    output,
    error: e
      ? { category: e.category || 'unknown', message: e.message || 'worker failed' }
      : { category: 'unknown', message: 'worker reported no completion' },
  };
}

function onAdapterPid(pid) {
  const adapterPid = Number.isInteger(pid) && pid > 0 ? pid : null;
  if (adapterPid) {
    base.adapterPid = adapterPid;
    base.adapterStartId = readProcStartId(adapterPid);
    writeRunningSnapshot();
  }
}

// Adapters may expose a serializable `workerMeta` bag on the handle they
// return (e.g. probed CLI version, resolved binary flavor). Persist the
// sanitized bag on every snapshot so post-mortems can see which binary/
// version actually served the worker. sanitizeWorkerMeta enforces the
// flat-scalars-only contract; anything else is silently dropped.
function onWorkerMeta(h) {
  const meta = sanitizeWorkerMeta(h && h.workerMeta);
  if (meta) {
    base.workerMeta = meta;
    writeRunningSnapshot();
  }
}

// Pure manifest → adapter-call option builders live in ./supervisor-opts.mjs so
// they are unit-testable without importing this CLI (which runs main() on
// import). run* below MUST use them so the tested contract is what production runs.

async function runExec(mod, m) {
  const h = mod.spawn(m.prompt, buildExecOpts(m));
  liveHandle = h; liveShutdown = mod.shutdown;
  onAdapterPid(h.pid);
  onWorkerMeta(h);
  return normalize(await mod.collect(h, m.timeoutMs));
}

async function runCodexAppserver(mod, m) {
  const h = mod.startServer({ cwd: m.cwd });
  liveHandle = h; liveShutdown = mod.shutdownServer;
  onAdapterPid(h.pid);
  onWorkerMeta(h);
  // Preserve each step's error CATEGORY (auth_failed/rate_limited/…) instead of
  // throwing → generic crash, so P3 retry/reassignment routes correctly.
  const init = await mod.initializeServer(h);
  if (init && init.error) return normalize({ status: 'failed', error: init.error });
  const thread = await mod.createThread(h, buildAppserverThreadOpts(m));
  if (thread && thread.error) return normalize({ status: 'failed', error: thread.error });
  const turn = await mod.startTurn(h, m.prompt);
  if (turn && turn.error) return normalize({ status: 'failed', error: turn.error });
  return normalize(await mod.collectTurnResult(h, m.timeoutMs));
}

async function runGeminiAcp(mod, m) {
  // model belongs on createSession (→ unstable_setSessionModel), NOT startServer
  // which ignores it. Mirrors the pre-FLIP in-process worker-spawn path.
  const h = mod.startServer({ cwd: m.cwd, credential: m.geminiCredential });
  liveHandle = h; liveShutdown = mod.shutdownServer;
  onAdapterPid(h.pid);
  onWorkerMeta(h);
  const init = await mod.initializeServer(h);
  if (init && init.error) return normalize({ status: 'failed', error: init.error });
  const sess = await mod.createSession(h, buildGeminiAcpSessionOpts(m));
  if (sess && sess.error) return normalize({ status: 'failed', error: sess.error });
  // sendPrompt collects internally (do NOT double-collect). Fall back to
  // collectPromptResult only if it resolves without a status.
  let res = await mod.sendPrompt(h, m.prompt, { timeout: m.timeoutMs });
  if (!res || res.status === undefined) res = await mod.collectPromptResult(h, m.timeoutMs);
  return normalize(res);
}

async function runFixture(m) {
  const fx = m.fixture || {};
  const delay = Math.min(Math.max(0, Number(fx.delayMs) || 0), FIXTURE_MAX_DELAY_MS);
  let out = typeof fx.output === 'string' ? fx.output : '';
  if (Buffer.byteLength(out, 'utf-8') > FIXTURE_MAX_OUTPUT_BYTES) {
    out = Buffer.from(out, 'utf-8').slice(0, FIXTURE_MAX_OUTPUT_BYTES).toString('utf-8');
  }
  // Optionally spawn a real detached child GROUP so the descendant-reap path in
  // shutdownAdapter() can be exercised end-to-end (the adapter's own shutdown is
  // a no-op here, so only the group reap can kill it).
  if (fx.spawnChild) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    child.unref();
    liveHandle = { pid: child.pid };
    liveShutdown = () => {};
    onAdapterPid(child.pid);
  }
  if (delay) await new Promise((r) => setTimeout(r, delay));
  // Test-only gate (deterministic ordering proofs, e.g. orphan-survival): block
  // completion until a file appears, bounded by the worker timeout (the watchdog
  // at timeoutMs+2000 is the ultimate backstop if the gate is never created).
  if (typeof fx.waitForFile === 'string' && fx.waitForFile) {
    const deadline = nowMs() + (Number.isInteger(m.timeoutMs) ? m.timeoutMs : 600_000);
    while (!existsSync(fx.waitForFile) && nowMs() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  const exitCode = Number.isInteger(fx.exitCode) ? fx.exitCode : 0;
  if (exitCode === 0) return { status: 'completed', output: out, error: null };
  const category = typeof fx.category === 'string' && /^[a-z_]+$/.test(fx.category) ? fx.category : 'nonzero_exit';
  return { status: 'failed', output: out, error: { category, message: `fixture exit ${exitCode}` } };
}

async function runAdapter(m) {
  if (m.adapterName === 'fixture') return runFixture(m);
  const mod = await import(`./${m.adapterName}.mjs`); // adapterName is allowlisted
  if (m.adapterName === 'codex-appserver') return runCodexAppserver(mod, m);
  if (m.adapterName === 'gemini-acp') return runGeminiAcp(mod, m);
  return runExec(mod, m); // codex-exec | claude-cli | gemini-exec
}

// ─── entry ──────────────────────────────────────────────────────────────────

async function main() {
  // Signal handlers FIRST so a kill during startup still writes a terminal snapshot.
  process.on('SIGTERM', () => { settle('cancelled', { category: 'cancelled', message: 'SIGTERM' }, ''); });
  process.on('SIGINT', () => { settle('cancelled', { category: 'cancelled', message: 'SIGINT' }, ''); });
  process.on('uncaughtException', (e) => { fail('crash', e && e.message); });
  process.on('unhandledRejection', (e) => { fail('crash', e && (e.message || e)); });

  const manifestPathArg = process.argv[2];
  if (!manifestPathArg) { process.stderr.write('supervisor: no manifest path\n'); process.exit(2); return; }

  let m;
  try {
    m = JSON.parse(readFileSync(manifestPathArg, 'utf-8'));
  } catch (e) {
    process.stderr.write(`supervisor: cannot read manifest: ${e && e.message}\n`);
    process.exit(2); return;
  }
  // Clear THEN unlink immediately — it carries the raw prompt. Truncating first
  // ensures the secret is gone even if unlink fails (e.g. read-only dir).
  try { writeFileSync(manifestPathArg, ''); } catch { /* best-effort */ }
  try { unlinkSync(manifestPathArg); } catch { /* best-effort */ }

  // Validate manifest (DATA only; paths are derived, not trusted from manifest).
  const fixtureAllowed = process.env.AO_SUPERVISOR_ALLOW_FIXTURE === '1';
  const adapterOk = ADAPTER_ALLOWLIST.has(m.adapterName) || (m.adapterName === 'fixture' && fixtureAllowed);
  if (m.schemaVersion !== 1 || !isValidId(m.runId) || !isValidId(m.workerRunId) ||
      typeof m.projectRoot !== 'string' || !adapterOk || typeof m.prompt !== 'string') {
    process.stderr.write('supervisor: invalid manifest\n');
    process.exit(2); return;
  }
  m.timeoutMs = Number.isInteger(m.timeoutMs) && m.timeoutMs > 0 ? m.timeoutMs : 600_000;
  m.timeoutMs = Math.min(m.timeoutMs, MAX_TIMEOUT_MS); // clamp → no 32-bit timer overflow

  // Derive trusted paths from IDs (NOT from the manifest).
  let basePaths;
  try {
    snapPath = snapshotPath(m.projectRoot, m.runId, m.workerRunId);
    outPath = outputPath(m.projectRoot, m.runId, m.workerRunId);
    basePaths = true;
  } catch (e) {
    process.stderr.write(`supervisor: bad ids/root: ${e && e.message}\n`);
    process.exit(2); return;
  }
  if (!basePaths) return;

  base = {
    runId: m.runId, workerRunId: m.workerRunId, teamName: m.teamName,
    workerName: m.workerName, adapterName: m.adapterName,
    startedAt: nowMs(),
    supervisorPid: process.pid, supervisorStartId: readProcStartId(process.pid),
    adapterPid: null, adapterStartId: null,
  };
  writeRunningSnapshot();

  heartbeatTimer = setInterval(writeRunningSnapshot, HEARTBEAT_INTERVAL_MS);
  if (heartbeatTimer.unref) heartbeatTimer.unref();
  watchdogTimer = setTimeout(() => {
    settle('failed', { category: 'timeout', message: `worker exceeded ${m.timeoutMs}ms` }, '');
  }, m.timeoutMs + 2000); // backstop margin over the adapter's own collect timeout
  if (watchdogTimer.unref) watchdogTimer.unref();

  try {
    const res = await runAdapter(m);
    await settle(res.status, res.error, res.output);
  } catch (e) {
    await fail('crash', e && e.message);
  }
}

// Runs unconditionally as the detached CLI (node adapter-worker-supervisor.mjs
// <manifest>). NOT importable for unit tests — the pure option builders that need
// testing live in ./supervisor-opts.mjs precisely so this can stay unconditional
// (a path-equality guard was not symlink/realpath-alias safe).
main();
