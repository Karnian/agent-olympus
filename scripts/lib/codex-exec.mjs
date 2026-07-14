import { spawn as nodeSpawn } from 'child_process';
import { resolveBinary, buildEnhancedPath } from './resolve-binary.mjs';
import { buildCodexExecArgs } from './codex-approval.mjs';
import { codexVersionMeta, meetsMinimum } from './cli-version.mjs';
import { classifyCodexDiagnostic } from './codex-error-classifier.mjs';

/** Valid resolved permission levels (mirrors codex-approval VALID_LEVELS). */
const VALID_SPAWN_LEVELS = new Set(['suggest', 'auto-edit', 'full-auto']);
const CODEX_EXEC_VERSION_NOTE =
  'codex {version} predates the 0.142.5 security fix (WebSocket payloads written to trace logs); upgrade recommended';
const IGNORE_USER_CONFIG_MIN_VERSION = '0.122.0';
const IGNORE_RULES_MIN_VERSION = '0.143.0';
const STRICT_CONFIG_MIN_VERSION = '0.143.0';

/**
 * @typedef {Object} CodexHandle
 * @property {number} pid - Process ID
 * @property {import('child_process').ChildProcess} process - The child process
 * @property {import('stream').Readable} stdout - stdout stream
 * @property {Function} kill - Kill the process with optional signal
 * @property {Object[]} _events - Accumulated parsed events
 * @property {string} _partial - Partial line buffer for incomplete JSONL
 * @property {string|null} threadId - Thread ID from thread.started
 * @property {string} status - 'running' | 'completed' | 'failed'
 * @property {string} _output - Aggregated text output
 * @property {Object|null} _usage - Token usage from turn.completed
 * @property {number|null} _exitCode - Process exit code
 * @property {string[]} _stderrChunks - Accumulated stderr chunks
 */

/**
 * @typedef {Object} MonitorResult
 * @property {string} status - 'running' | 'completed' | 'failed'
 * @property {string} output - Aggregated text output
 * @property {Object[]} events - All parsed events since last monitor call
 * @property {Object} [error] - Error info if failed
 * @property {Object} [usage] - Token usage if completed
 */

/**
 * Parse a buffer of JSONL text into an array of event objects.
 * Handles partial lines gracefully — returns { events, remainder }.
 *
 * @param {string} buffer
 * @returns {{ events: Object[], remainder: string }}
 */
export function parseJSONLEvents(buffer) {
  const events = [];
  const lines = buffer.split('\n');
  const remainder = lines.pop(); // Last element may be an incomplete line

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines — codex may emit non-JSON diagnostic output
    }
  }

  return { events, remainder: remainder || '' };
}

/**
 * Classify a Codex error into one of the standard error categories.
 * Maps stderr / output text to: mcp_auth, auth_failed, rate_limited,
 * not_installed, network, crash, timeout, or unknown.
 *
 * @param {string|null|undefined} errorText
 * @returns {string}
 */
/**
 * Full error category set (8 categories):
 * - mcp_auth, auth_failed, rate_limited, not_installed, network, crash
 * - timeout, unknown (new in G#5a)
 */
export function mapJsonlErrorToCategory(errorText) {
  if (!errorText) return 'unknown';
  const text = String(errorText);

  const diagnosticCategory = classifyCodexDiagnostic(text);
  if (diagnosticCategory) return diagnosticCategory;
  if (/command not found|ENOENT|codex:.*not found/i.test(text)) return 'not_installed';
  if (/fatal error|unhandled exception|panic:|SIGSEGV|SIGABRT|segmentation fault/i.test(text)) return 'crash';
  if (/timeout|timed?\s*out|did not complete within/i.test(text)) return 'timeout';

  return 'unknown';
}

function buildApprovalArgs(opts = {}) {
  // Approval-related flags are GLOBAL Codex CLI flags — they go BEFORE `exec`.
  // codex 0.118+: `codex exec -a never` → `error: unexpected argument '-a'`.
  //
  // Strict level validation: only resolved level strings ('suggest',
  // 'auto-edit', 'full-auto') trigger the new permission-mirroring path.
  // Anything else — `'auto'`, typos, undefined — falls through to legacy
  // bypass so a future caller bug cannot silently downgrade workers to
  // `read-only` sandbox without us noticing.
  let approvalArgs;
  if (opts.level && VALID_SPAWN_LEVELS.has(opts.level)) {
    approvalArgs = buildCodexExecArgs(opts.level); // ['-a', 'never', '-s', '<sandbox>']
  } else {
    // Legacy: keep the v1 bypass behavior so unmigrated callers don't regress.
    approvalArgs = ['--dangerously-bypass-approvals-and-sandbox'];
  }

  return approvalArgs;
}

function buildConfigOverrideArgs(opts = {}) {
  const overrides = Array.isArray(opts.configOverrides) ? opts.configOverrides : [];
  const args = [];

  for (const entry of overrides) {
    args.push('-c', entry);
  }

  return args;
}

function buildExecConfigArgs(opts = {}) {
  const args = [];
  if (opts.ignoreUserConfig === true) args.push('--ignore-user-config');
  if (opts.ignoreRules === true) args.push('--ignore-rules');
  if (opts.skipGitRepoCheck === true) args.push('--skip-git-repo-check');
  return args;
}

/**
 * Build the Codex CLI argv for `spawn()`. Exposed for hermetic testing.
 *
 * Permission mirroring: when `opts.level` is set, approval flags are derived
 * via `buildCodexExecArgs(level)` and placed BEFORE the `exec` subcommand.
 * Without `opts.level`, falls back to the legacy bypass flag for backward
 * compatibility with unmigrated callers.
 *
 * @param {Object} [opts]
 * @param {'suggest'|'auto-edit'|'full-auto'} [opts.level]
 * @param {string[]} [opts.configOverrides] - Global Codex `-c key=value`
 *   overrides placed before `exec`, after approval flags
 * @param {boolean} [opts.strictConfig] - Fail if an explicit isolation
 *   override is unsupported instead of silently ignoring it
 * @param {boolean} [opts.ignoreUserConfig] - Add Codex exec's
 *   `--ignore-user-config` option after `exec`; authentication and explicit
 *   command-line config overrides remain available
 * @param {boolean} [opts.ignoreRules] - Add Codex exec's `--ignore-rules`
 *   option after `exec` to skip user/project execpolicy rules
 * @param {boolean} [opts.skipGitRepoCheck] - Permit an exact-tree snapshot
 *   materialized without live `.git` metadata
 * @param {boolean} [opts.persist] - When true, omit --ephemeral so Codex can resume the session
 * @returns {string[]}
 */
export function _buildSpawnArgs(opts = {}) {
  const approvalArgs = buildApprovalArgs(opts);
  const globalArgs = [
    ...approvalArgs,
    ...(opts.strictConfig === true ? ['--strict-config'] : []),
    ...buildConfigOverrideArgs(opts),
  ];

  if (opts.persist === true) {
    return [
      ...globalArgs,
      'exec',
      ...buildExecConfigArgs(opts),
      '--json',
      '-',
    ];
  }

  return [
    ...globalArgs,
    'exec',
    ...buildExecConfigArgs(opts),
    '--json',
    '--ephemeral',
    '-',
  ];
}

/**
 * Build the Codex CLI argv for `spawnResume()`. Exposed for hermetic testing.
 *
 * codex 0.140 documents the resume form as:
 *   codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]
 * so JSONL output is a resume option and `-` is the prompt argument after the
 * session id. Approval flags remain GLOBAL and precede `exec`.
 *
 * @param {string} threadId - Persisted Codex session/thread id or thread name
 * @param {Object} [opts]
 * @param {'suggest'|'auto-edit'|'full-auto'} [opts.level]
 * @param {string[]} [opts.configOverrides] - Global Codex `-c key=value`
 *   overrides placed before `exec`, after approval flags
 * @param {boolean} [opts.strictConfig] - Fail on invalid explicit config overrides
 * @param {boolean} [opts.ignoreUserConfig] - Add the resume subcommand's
 *   `--ignore-user-config` option after `resume`
 * @param {boolean} [opts.ignoreRules] - Add `--ignore-rules` after `resume`
 * @param {boolean} [opts.skipGitRepoCheck] - Add `--skip-git-repo-check`
 * @returns {string[]}
 */
export function _buildResumeArgs(threadId, opts = {}) {
  if (typeof threadId !== 'string' || threadId.trim().length === 0) {
    throw new TypeError('threadId must be a non-empty string');
  }

  return [
    ...buildApprovalArgs(opts),
    ...(opts.strictConfig === true ? ['--strict-config'] : []),
    ...buildConfigOverrideArgs(opts),
    'exec',
    'resume',
    ...buildExecConfigArgs(opts),
    '--json',
    threadId,
    '-',
  ];
}

function spawnCodexProcess(args, prompt, opts = {}) {
  const codexPath = resolveBinary('codex');
  const workerMeta = probeCodexWorkerMeta(codexPath, opts);

  if (opts.ignoreUserConfig === true) {
    if (
      workerMeta.codexVersion === null
      || !meetsMinimum(workerMeta.codexVersion, IGNORE_USER_CONFIG_MIN_VERSION)
    ) {
      const detected = workerMeta.codexVersion || 'unknown';
      throw new Error(
        `--no-mcp requires Codex >=${IGNORE_USER_CONFIG_MIN_VERSION} `
        + `(--ignore-user-config support); detected ${detected}. `
        + 'Upgrade with: npm install -g @openai/codex@latest',
      );
    }
  }
  if (opts.ignoreRules === true) {
    if (
      workerMeta.codexVersion === null
      || !meetsMinimum(workerMeta.codexVersion, IGNORE_RULES_MIN_VERSION)
    ) {
      const detected = workerMeta.codexVersion || 'unknown';
      throw new Error(
        `read-only rule isolation requires Codex >=${IGNORE_RULES_MIN_VERSION} `
        + `(--ignore-rules support); detected ${detected}. `
        + 'Upgrade with: npm install -g @openai/codex@latest',
      );
    }
  }
  if (opts.strictConfig === true) {
    if (
      workerMeta.codexVersion === null
      || !meetsMinimum(workerMeta.codexVersion, STRICT_CONFIG_MIN_VERSION)
    ) {
      const detected = workerMeta.codexVersion || 'unknown';
      throw new Error(
        `strict validator config requires Codex >=${STRICT_CONFIG_MIN_VERSION} `
        + `(--strict-config support); detected ${detected}. `
        + 'Upgrade with: npm install -g @openai/codex@latest',
      );
    }
  }

  const spawnImpl = typeof opts.spawn === 'function' ? opts.spawn : nodeSpawn;
  const child = spawnImpl(codexPath, args, {
    cwd: opts.cwd || process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PATH: buildEnhancedPath(), ...opts.env },
    detached: true, // Required for process-group cleanup in the lifecycle manager (US-005)
  });

  const handle = {
    pid: child.pid,
    process: child,
    stdout: child.stdout,
    kill: (signal = 'SIGTERM') => {
      try { child.kill(signal); } catch {}
    },
    _events: [],
    _partial: '',
    threadId: null,
    status: 'running',
    _output: '',
    _usage: null,
    _exitCode: null,
    _stderrChunks: [],
    _hadItemFailure: false,
    workerMeta,
  };

  // Write prompt to stdin then close so Codex gets EOF
  child.stdin.write(prompt);
  child.stdin.end();

  // Stream stdout and parse JSONL events incrementally
  child.stdout.on('data', (chunk) => {
    const text = handle._partial + chunk.toString();
    const { events, remainder } = parseJSONLEvents(text);
    handle._partial = remainder;

    for (const event of events) {
      handle._events.push(event);

      // Capture thread identity
      if (event.type === 'thread.started' && event.thread_id) {
        handle.threadId = event.thread_id;
      }

      // Accumulate readable output; track item-level failures without committing
      // handle.status — turn.completed is the authoritative terminal signal
      if (event.type === 'item.completed' && event.item) {
        if (event.item.type === 'agent_message' && event.item.text) {
          handle._output += event.item.text + '\n';
        } else if (event.item.type === 'command_execution' && event.item.aggregated_output) {
          handle._output += event.item.aggregated_output;
        }
        if (event.item.status === 'failed') {
          handle._hadItemFailure = true;
        }
      }

      // turn.completed is Codex's authoritative final signal — always wins over
      // intermediate item failures (e.g. auth retries that succeeded)
      if (event.type === 'turn.completed') {
        handle.status = 'completed';
        if (event.usage) handle._usage = event.usage;
      }
    }
  });

  // Accumulate stderr for error classification
  child.stderr.on('data', (chunk) => {
    handle._stderrChunks.push(chunk.toString());
  });

  // Non-zero exit with no prior completion signal → treat as failure
  child.on('exit', (code) => {
    handle._exitCode = code;
    if (code !== 0 && handle.status === 'running') {
      handle.status = 'failed';
    }
  });

  // Spawn errors (e.g. ENOENT when codex is missing)
  child.on('error', (err) => {
    handle._stderrChunks.push(err.message);
    handle.status = 'failed';
  });

  return handle;
}

function probeCodexWorkerMeta(codexPath, opts = {}) {
  const workerMeta = codexVersionMeta(codexPath, { versionProbe: opts.versionProbe });

  if (workerMeta.versionWarning) {
    emitVersionLog(
      opts,
      'info',
      CODEX_EXEC_VERSION_NOTE.replace('{version}', workerMeta.codexVersion),
    );
  }

  return workerMeta;
}

function emitVersionLog(opts, level, message) {
  try {
    if (typeof opts.log === 'function') {
      opts.log(level, message);
      return;
    }
    process.stderr.write(`${message}\n`);
  } catch {
    // Advisory logging must never affect worker startup.
  }
}

/**
 * Spawn a Codex exec --json process with the given prompt.
 * The prompt is written to stdin; Codex reads it via `-` (stdin mode).
 *
 * Permission mirroring: pass `opts.level` to mirror the host Claude session's
 * permission tier into the Codex sandbox via `buildCodexExecArgs(level)`.
 * The resulting `-a never -s <sandbox>` flags are GLOBAL Codex CLI flags and
 * MUST appear BEFORE the `exec` subcommand (Codex 0.118+).
 *
 * Backward compatibility: when `opts.level` is omitted, the function preserves
 * the legacy behavior of `--dangerously-bypass-approvals-and-sandbox`. New
 * callers should always pass `opts.level`. Once all callers are migrated, the
 * legacy branch will be removed.
 *
 * @param {string} prompt - The prompt to send to Codex
 * @param {Object} [opts] - Options
 * @param {string} [opts.cwd] - Working directory
 * @param {'suggest'|'auto-edit'|'full-auto'} [opts.level] - Host Claude
 *   permission tier; resolved by callers via `resolveCodexApproval`. When set,
 *   replaces the legacy `--dangerously-bypass-approvals-and-sandbox` flag with
 *   the appropriate `-a never -s <sandbox>` global flags.
 * @param {string[]} [opts.configOverrides] - Global Codex `-c key=value`
 *   overrides placed before `exec`, after approval flags
 * @param {boolean} [opts.strictConfig] - Fail if an isolation override is unsupported
 * @param {boolean} [opts.ignoreUserConfig] - Skip CODEX_HOME/config.toml for
 *   this execution while retaining authentication and CLI overrides
 * @param {boolean} [opts.ignoreRules] - Skip user/project execpolicy rules
 * @param {boolean} [opts.skipGitRepoCheck] - Permit a metadata-free tree snapshot
 * @param {boolean} [opts.persist] - When true, omit --ephemeral so Codex writes
 *   a resumable session
 * @param {Object} [opts.env] - Additional environment variables merged over process.env
 * @returns {CodexHandle}
 */
export function spawn(prompt, opts = {}) {
  return spawnCodexProcess(_buildSpawnArgs(opts), prompt, opts);
}

/**
 * Resume a persisted Codex exec session with the given prompt.
 * The prompt is written to stdin; Codex reads it via `-` after the session id.
 *
 * @param {string} threadId - Persisted Codex session/thread id or thread name
 * @param {string} prompt - The prompt to send to Codex
 * @param {Object} [opts] - Options
 * @param {string} [opts.cwd] - Working directory
 * @param {'suggest'|'auto-edit'|'full-auto'} [opts.level] - Host Claude
 *   permission tier; resolved by callers via `resolveCodexApproval`
 * @param {string[]} [opts.configOverrides] - Global Codex `-c key=value`
 *   overrides placed before `exec`, after approval flags
 * @param {boolean} [opts.strictConfig] - Fail if an isolation override is unsupported
 * @param {boolean} [opts.ignoreUserConfig] - Skip CODEX_HOME/config.toml for
 *   the resumed execution while retaining authentication and CLI overrides
 * @param {boolean} [opts.ignoreRules] - Skip user/project execpolicy rules
 * @param {boolean} [opts.skipGitRepoCheck] - Permit a metadata-free tree snapshot
 * @param {Object} [opts.env] - Additional environment variables merged over process.env
 * @returns {CodexHandle}
 */
export function spawnResume(threadId, prompt, opts = {}) {
  return spawnCodexProcess(_buildResumeArgs(threadId, opts), prompt, opts);
}

/**
 * Monitor a running Codex handle. Returns current status and accumulated events.
 * Non-destructive — the handle retains all state for subsequent calls.
 *
 * @param {CodexHandle} handle
 * @returns {MonitorResult}
 */
export function monitor(handle) {
  // Bug C fix (issue #64): turn.completed is Codex's authoritative final
  // signal. If it has been parsed into handle._events, treat the turn as
  // completed regardless of whether handle.status was transiently flipped to
  // 'failed' by the spawn-side exit handler racing ahead of a queued
  // turn.completed 'data' event. Defense-in-depth — Bug B (collect() listening
  // on 'close' instead of 'exit') is the primary fix; this guard catches any
  // remaining ordering hazard at monitor() time.
  const hasTurnCompleted = handle._events.some((e) => e && e.type === 'turn.completed');
  if (hasTurnCompleted && handle.status !== 'completed') {
    handle.status = 'completed';
  }

  const result = {
    status: handle.status,
    output: handle._output,
    events: [...handle._events],
  };

  if (handle.status === 'failed') {
    // Bug A fix (issue #64): NEVER fall back to handle._output for error
    // classification. handle._output carries agent_message body text, and the
    // classifier's first rule (/authentication|API key/i) trivially matches
    // legitimate code-review responses, producing false `auth_failed` labels.
    // If stderr is empty, return 'unknown' rather than misclassifying response
    // text. Structured error fields from parsed JSONL events are a future
    // enhancement (separate PR).
    const stderr = handle._stderrChunks.join('');
    const category = mapJsonlErrorToCategory(stderr);
    result.error = {
      category,
      message: stderr || 'Codex process failed',
      exitCode: handle._exitCode,
    };
  }

  if (handle._usage) {
    result.usage = handle._usage;
  }

  return result;
}

/**
 * Collect the final result from a Codex handle.
 * If the process is still running, waits for it to exit (up to timeoutMs).
 * On timeout the handle is marked failed and the promise resolves immediately.
 *
 * @param {CodexHandle} handle
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<MonitorResult>}
 */
/**
 * Flush any remaining partial JSONL data in the handle's buffer.
 * Called when the process exits — the last event may not have a trailing newline.
 */
function flushPartial(handle) {
  if (handle._partial && handle._partial.trim()) {
    try {
      const event = JSON.parse(handle._partial.trim());
      handle._events.push(event);

      if (event.type === 'thread.started' && event.thread_id) {
        handle.threadId = event.thread_id;
      }
      if (event.type === 'item.completed' && event.item) {
        if (event.item.type === 'agent_message' && event.item.text) {
          handle._output += event.item.text + '\n';
        } else if (event.item.type === 'command_execution' && event.item.aggregated_output) {
          handle._output += event.item.aggregated_output;
        }
        if (event.item.status === 'failed') handle._hadItemFailure = true;
      }
      if (event.type === 'turn.completed') {
        handle.status = 'completed';
        if (event.usage) handle._usage = event.usage;
      }
      handle._partial = '';
    } catch {
      // Not valid JSON — discard
    }
  }
}

// ── Issue #74: process-group reap seam ──────────────────────────────────────
// Test seam for the process-group signal used to reap lingering codex
// descendants. Defaults to process.kill; tests override via _setGroupKill so
// the reap can be asserted without issuing a real OS signal.
let _groupKill = (pgid, signal) => process.kill(pgid, signal);

/** @internal Override the process-group signal fn (tests only). Returns prev. */
export function _setGroupKill(fn) {
  const prev = _groupKill;
  _groupKill = typeof fn === 'function' ? fn : (pgid, signal) => process.kill(pgid, signal);
  return prev;
}

/**
 * Reap lingering descendants of an exited codex child (issue #74).
 *
 * When codex runs tool calls it spawns `bash -c` grandchildren that inherit
 * its stdout pipe write-end. If they outlive codex they keep that fd open,
 * which delays the adapter's 'close' event and exposes the *.output ENOENT
 * race (a late grandchild evals a temp file codex already deleted → non-zero
 * exit → a spurious "failed" background shell). SIGTERM to the process group
 * (negative PID) reaps them. `detached:true` made the codex child a group
 * leader, so handle.pid doubles as the PGID; the group stays valid while any
 * member is alive, so -pid reaches the grandchildren after the leader exits
 * (no PID-reuse hazard while they linger). Best-effort — an already-empty
 * group throws ESRCH, which we swallow.
 *
 * @param {CodexHandle} handle
 */
function reapDescendants(handle) {
  if (!handle || typeof handle.pid !== 'number') return;
  try { _groupKill(-handle.pid, 'SIGTERM'); } catch { /* group already gone */ }
}

export function collect(handle, timeoutMs = 30000) {
  return new Promise((resolve) => {
    if (handle.status !== 'running') {
      flushPartial(handle);
      resolve(monitor(handle));
      return;
    }

    let settled = false;
    let reapTimer = null;
    let timeout = null;

    const cleanup = () => {
      if (reapTimer) { clearImmediate(reapTimer); reapTimer = null; }
      if (timeout) { clearTimeout(timeout); timeout = null; }
      handle.process.removeListener('exit', onExit);
      handle.process.removeListener('close', onClose);
    };

    // Issue #74: when the direct codex child exits, a tool-call grandchild may
    // still hold codex's inherited stdout pipe write-end open. That delays the
    // ChildProcess 'close' event and exposes the *.output ENOENT race (a late
    // grandchild evals a temp file codex already deleted → non-zero exit → a
    // spurious "failed" background shell) while collect() blocks on 'close'.
    //
    // On 'exit', re-check ONE tick later whether stdout is still open. A still-
    // open stdout is a strong indicator that a descendant inherited the pipe and
    // is keeping it — and the process group — alive, so we reap the group. If
    // stdout is already closed there is no straggler, so we skip entirely (no
    // spurious SIGTERM). The discriminator is NOT perfectly race-free: a
    // descendant could exit (kernel-side) between the check and the kill, or
    // stdout's 'close' could lag a no-descendant exit past this tick — in either
    // case the group is empty and _groupKill() simply throws ESRCH, which we
    // swallow. The only residual risk is PID reuse, which would require the
    // leader PID to be recycled AND re-made a group leader within one event-loop
    // turn — not realistically reachable, and the same posture shutdown()'s
    // negative-PID escalation already accepts.
    //
    // NOTE: real child_process 'close' is a libuv event, NOT a microtask, so it
    // is NOT guaranteed to precede a setImmediate queued here (verified on
    // Node/macOS: exit → setImmediate → close occurs). Correctness therefore
    // rests on the stdout-still-open re-check, not on event ordering. If 'close'
    // does win the race, cleanup() clears this immediate before it runs.
    function onExit() {
      reapTimer = setImmediate(() => {
        reapTimer = null;
        if (settled) return;
        const out = handle.process.stdout;
        if (out && out.closed === false) reapDescendants(handle);
      });
    }

    // Bug B fix (issue #64): resolve on 'close', NOT 'exit'. The 'exit' event
    // can fire while stdout 'data' events containing turn.completed are still
    // queued in the libuv pipe — resolving on exit captures stale state before
    // the final event drains. 'close' fires only after the process has exited
    // AND the stdio streams have closed, guaranteeing all 'data' events were
    // processed. The timeout below and the onExit reap protect the descendant-
    // lingering path. spawn()'s own 'exit' handler is intentionally untouched —
    // it owns _exitCode/PID lifecycle, not the completion contract.
    function onClose() {
      if (settled) return;
      settled = true;
      cleanup();
      flushPartial(handle);
      resolve(monitor(handle));
    }

    timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      handle.status = 'failed';
      resolve({
        ...monitor(handle),
        error: {
          category: 'timeout',
          message: `Codex process did not complete within ${timeoutMs}ms`,
        },
      });
    }, timeoutMs);

    handle.process.once('exit', onExit);
    handle.process.once('close', onClose);
  });
}

/** Grace period before escalating from SIGTERM to SIGKILL (ms) */
const SHUTDOWN_GRACE_MS = 5000;

/**
 * Shutdown a Codex process gracefully.
 * Sends SIGTERM to the process group first; if the process doesn't exit within
 * SHUTDOWN_GRACE_MS, escalates to SIGKILL on the process group (negative PID).
 *
 * NOTE: this body only runs while the DIRECT child is still alive
 * (handle._exitCode === null) — e.g. a timeout or cancel. The happy-path
 * "lingering grandchild" case (issue #74) is handled by collect()'s 'exit'
 * reap, because shutdown() early-returns once _exitCode is set.
 *
 * @param {CodexHandle} handle
 * @param {number} [graceMs=5000] - Grace period before SIGKILL
 * @returns {Promise<void>}
 */
export function shutdown(handle, graceMs = SHUTDOWN_GRACE_MS) {
  if (!handle.process || handle.process.killed) return Promise.resolve();

  // If the process already exited, no need to send signals (avoids PID reuse risk)
  if (handle._exitCode !== null) return Promise.resolve();

  // Send SIGTERM to the whole process group first (negative PID) so orphaned
  // grandchildren that inherited codex's stdout pipe are reaped alongside the
  // direct child — mirroring the SIGKILL-on-group escalation below — then the
  // direct child itself. (Issue #74: SIGTERM previously hit only the direct
  // child, leaving the group for the SIGKILL grace window to clean up.)
  try { _groupKill(-handle.pid, 'SIGTERM'); } catch { /* group already gone */ }
  handle.kill('SIGTERM');

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Double-check exit code before SIGKILL to prevent PID reuse
      if (handle._exitCode !== null) {
        resolve();
        return;
      }
      // Escalate: SIGKILL the entire process group
      try { _groupKill(-handle.pid, 'SIGKILL'); } catch {}
      // Fallback: kill just the process if group kill fails
      try { handle.kill('SIGKILL'); } catch {}
      resolve();
    }, graceMs);

    // If process exits before grace period, clean up timer
    handle.process.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
