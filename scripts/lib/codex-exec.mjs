import { spawn as nodeSpawn } from 'child_process';
import { resolveBinary, buildEnhancedPath } from './resolve-binary.mjs';
import { buildCodexExecArgs } from './codex-approval.mjs';

/** Valid resolved permission levels (mirrors codex-approval VALID_LEVELS). */
const VALID_SPAWN_LEVELS = new Set(['suggest', 'auto-edit', 'full-auto']);

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
 * Maps stderr / output text to: auth_failed, rate_limited, not_installed,
 * network, crash, or unknown.
 *
 * @param {string|null|undefined} errorText
 * @returns {string}
 */
/**
 * Full error category set (7 categories):
 * - auth_failed, rate_limited, not_installed, network, crash (original 5)
 * - timeout, unknown (new in G#5a)
 */
export function mapJsonlErrorToCategory(errorText) {
  if (!errorText) return 'unknown';
  const text = String(errorText);

  if (/authentication|unauthorized|invalid.*api.*key|API key/i.test(text)) return 'auth_failed';
  if (/rate.?limit|429|quota.*exceeded|too many requests/i.test(text)) return 'rate_limited';
  if (/command not found|ENOENT|codex:.*not found/i.test(text)) return 'not_installed';
  if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|network error/i.test(text)) return 'network';
  if (/fatal error|unhandled exception|panic:|SIGSEGV|SIGABRT|segmentation fault/i.test(text)) return 'crash';
  if (/timeout|timed?\s*out|did not complete within/i.test(text)) return 'timeout';

  return 'unknown';
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
 * @returns {string[]}
 */
export function _buildSpawnArgs(opts = {}) {
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
  return [
    ...approvalArgs,
    'exec',
    '--json',
    '--ephemeral',
    '-',
  ];
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
 * @param {Object} [opts.env] - Additional environment variables merged over process.env
 * @returns {CodexHandle}
 */
export function spawn(prompt, opts = {}) {
  const codexPath = resolveBinary('codex');
  const args = _buildSpawnArgs(opts);

  const child = nodeSpawn(codexPath, args, {
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

export function collect(handle, timeoutMs = 30000) {
  return new Promise((resolve) => {
    if (handle.status !== 'running') {
      flushPartial(handle);
      resolve(monitor(handle));
      return;
    }

    const timeout = setTimeout(() => {
      handle.status = 'failed';
      resolve({
        ...monitor(handle),
        error: {
          category: 'timeout',
          message: `Codex process did not complete within ${timeoutMs}ms`,
        },
      });
    }, timeoutMs);

    // Bug B fix (issue #64): listen on 'close' instead of 'exit'. The 'exit'
    // event can fire while stdout 'data' events containing turn.completed are
    // still queued in the libuv pipe — resolving on exit captures stale state
    // before the final event drains. 'close' fires only after both the process
    // has exited AND the stdio streams have closed, guaranteeing all 'data'
    // events have been processed. Caveat: if a descendant inherits stdout fd
    // and keeps it open, 'close' can be delayed; the timeout above protects
    // that path. spawn()'s own 'exit' handler is intentionally untouched —
    // it owns _exitCode/PID lifecycle, not the completion contract.
    handle.process.on('close', () => {
      clearTimeout(timeout);
      flushPartial(handle);
      resolve(monitor(handle));
    });
  });
}

/** Grace period before escalating from SIGTERM to SIGKILL (ms) */
const SHUTDOWN_GRACE_MS = 5000;

/**
 * Shutdown a Codex process gracefully.
 * Sends SIGTERM first; if the process doesn't exit within SHUTDOWN_GRACE_MS,
 * escalates to SIGKILL on the process group (negative PID).
 *
 * @param {CodexHandle} handle
 * @param {number} [graceMs=5000] - Grace period before SIGKILL
 * @returns {Promise<void>}
 */
export function shutdown(handle, graceMs = SHUTDOWN_GRACE_MS) {
  if (!handle.process || handle.process.killed) return Promise.resolve();

  // If the process already exited, no need to send signals (avoids PID reuse risk)
  if (handle._exitCode !== null) return Promise.resolve();

  // Send SIGTERM
  handle.kill('SIGTERM');

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Double-check exit code before SIGKILL to prevent PID reuse
      if (handle._exitCode !== null) {
        resolve();
        return;
      }
      // Escalate: SIGKILL the entire process group
      try { process.kill(-handle.pid, 'SIGKILL'); } catch {}
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
