/**
 * Gemini CLI adapter — spawns `gemini --output-format json -p <prompt>`.
 *
 * Wire protocol (single-turn JSON output):
 *   1. `--output-format json` causes Gemini CLI to emit one JSON object on stdout at completion.
 *   2. Expected output shape:
 *      {
 *        "response": "<assistant text>" | null,
 *        "stats": { "tokensUsed": N, "toolCalls": N, ... } | null,
 *        "error": { "message": "<string>", "code": "<string>" } | null
 *      }
 *   3. Exit code 0 = success; non-zero = failure.
 *   4. Any text written to stderr is captured for error classification.
 *
 * Provides single-turn Gemini execution as a worker:
 * - Spawns `gemini -m <model> --output-format json -p "<prompt>"`
 * - Accumulates raw stdout; parses single JSON object on process close
 * - Maps errors to standard categories (auth_failed, rate_limited, etc.)
 * - Graceful shutdown with SIGTERM → SIGKILL escalation after 5s
 *
 * Zero npm dependencies — Node.js built-ins only.
 *
 * @module gemini-exec
 */

import { spawn as nodeSpawn } from 'child_process';
import { resolveBinary, buildEnhancedPath } from './resolve-binary.mjs';
import { resolveGeminiApiKey, maskKey, invalidateCache } from './gemini-credential.mjs';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Grace period before escalating from SIGTERM to SIGKILL (ms) */
const SHUTDOWN_GRACE_MS = 5000;

// ─── Handle typedef ───────────────────────────────────────────────────────────

/**
 * @typedef {Object} GeminiHandle
 * @property {number} pid - Process ID
 * @property {import('child_process').ChildProcess} process - The child process
 * @property {import('stream').Readable} stdout - stdout stream
 * @property {Function} kill - Kill the process with optional signal
 * @property {string} _partial - Partial stdout buffer (accumulated raw text)
 * @property {string} status - 'running' | 'completed' | 'failed'
 * @property {string} _output - Final parsed text response
 * @property {Object[]} _events - Accumulated parsed events (single JSON object on close)
 * @property {Object|null} _usage - Usage stats from the JSON response
 * @property {number|null} _exitCode - Process exit code
 * @property {string[]} _stderrChunks - Accumulated stderr chunks (capped at 100)
 */

// ─── JSON output parser ───────────────────────────────────────────────────────

/**
 * Parse Gemini CLI's single-turn JSON output into a normalized result.
 *
 * Expected input shape:
 *   { response: string|null, stats: { tokensUsed, toolCalls, ... }|null, error: { message, code }|null }
 *
 * Returns:
 *   { output: string, usage: object|null, error: string|null }
 *
 * @param {string} raw - Raw stdout string from the gemini process
 * @returns {{ output: string, usage: object|null, error: string|null }}
 */
export function parseGeminiJsonOutput(raw) {
  if (!raw || !raw.trim()) {
    return { output: '', usage: null, error: 'Empty response from Gemini CLI' };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return { output: '', usage: null, error: `Malformed JSON output: ${raw.slice(0, 100)}` };
  }

  // Error field takes precedence
  if (parsed.error && parsed.error.message) {
    return {
      output: '',
      usage: parsed.stats || null,
      error: parsed.error.message,
    };
  }

  const output = typeof parsed.response === 'string' ? parsed.response : '';
  const usage = parsed.stats || null;

  return { output, usage, error: null };
}

// ─── Error mapping ────────────────────────────────────────────────────────────

/**
 * Classify a Gemini CLI error string into one of the standard error categories.
 * Maps stderr / output text to: auth_failed, rate_limited, not_installed,
 * network, context_exceeded, crash, or unknown.
 *
 * @param {string|null|undefined} errorText
 * @returns {string}
 */
export function mapGeminiExecError(errorText) {
  if (!errorText) return 'unknown';
  const text = String(errorText);

  if (/authentication|API key|not logged in|invalid.*key|unauthorized/i.test(text)) return 'auth_failed';
  if (/rate.?limit|429|quota.*exceeded|too many requests/i.test(text)) return 'rate_limited';
  if (/command not found|not found|ENOENT/i.test(text)) return 'not_installed';
  if (/ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|network error/i.test(text)) return 'network';
  if (/timeout|timed?\s*out|deadline exceeded/i.test(text)) return 'timeout';
  if (/context.*window|context.*exceeded|too long|token.?limit/i.test(text)) return 'context_exceeded';
  if (/signal|SIGSEGV|SIGABRT|segmentation fault|fatal error/i.test(text)) return 'crash';

  return 'unknown';
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Flush the handle's accumulated stdout buffer into a parsed result.
 * Called when the process exits — Gemini emits a single JSON object, not streaming.
 *
 * @param {GeminiHandle} handle
 */
function _flushOutput(handle) {
  const raw = handle._partial;
  if (!raw || !raw.trim()) return;

  const { output, usage, error } = parseGeminiJsonOutput(raw);
  handle._output = output;
  handle._usage = usage;
  handle._partial = '';

  // Push a synthetic event so callers can inspect the parsed result
  const event = { type: 'gemini.result', output, usage, error };
  handle._events.push(event);

  if (error) {
    handle.status = 'failed';
    handle._stderrChunks.push(error);
  } else if (handle.status === 'running') {
    handle.status = 'completed';
  }
}

// ─── Core API ─────────────────────────────────────────────────────────────────

/**
 * Spawn a Gemini CLI process with the given prompt.
 * Uses `--output-format json -p <prompt>` for single-turn JSON output.
 *
 * @param {string} prompt - The prompt to send to Gemini
 * @param {Object} [opts] - Options
 * @param {string} [opts.cwd] - Working directory
 * @param {string} [opts.model] - Model override: 'auto' | 'pro' | 'flash' | 'flash-lite'
 * @param {string} [opts.approvalMode] - Approval mode: 'default' | 'auto_edit' | 'yolo' | 'plan'
 * @param {Object} [opts.env] - Additional environment variables merged over process.env
 * @param {number} [opts.timeout] - Timeout in milliseconds (unused here, passed to collect)
 * @returns {GeminiHandle}
 */
export function spawn(prompt, opts = {}) {
  const geminiPath = resolveBinary('gemini');

  const args = ['--output-format', 'json'];

  // Model selection: -m <model>
  if (opts.model) {
    args.push('-m', opts.model);
  }

  // Approval mode: --approval-mode <mode>
  if (opts.approvalMode) {
    args.push('--approval-mode', opts.approvalMode);
  }

  // Prompt as positional arg via -p flag
  args.push('-p', prompt);

  // Resolve GEMINI_API_KEY from the OS secret store (macOS Keychain / Linux
  // secret-tool) so users who ran `gemini /auth` don't need to ALSO export
  // the key into their shell. Null result = no injection (lets gemini CLI
  // surface its own auth error if the user also lacks env). opts.env wins
  // last — caller override is always respected.
  const credOpts = opts.credential || {};
  const resolvedKey = resolveGeminiApiKey({
    useKeychain: credOpts.useKeychain !== false,
    account: credOpts.account || 'default-api-key',
  });
  const mergedEnv = {
    ...process.env,
    PATH: buildEnhancedPath(),
    ...(resolvedKey ? { GEMINI_API_KEY: resolvedKey } : {}),
    ...opts.env,
  };
  if (process.env.AO_DEBUG_GEMINI) {
    try {
      process.stderr.write(
        `gemini-exec: GEMINI_API_KEY=${maskKey(mergedEnv.GEMINI_API_KEY)}\n`
      );
    } catch { /* never throw from logging */ }
  }

  const child = nodeSpawn(geminiPath, args, {
    cwd: opts.cwd || process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: mergedEnv,
    detached: true, // Required for process-group cleanup
  });

  /** @type {GeminiHandle} */
  const handle = {
    pid: child.pid,
    process: child,
    stdout: child.stdout,
    kill: (signal = 'SIGTERM') => {
      try { child.kill(signal); } catch {}
    },
    _events: [],
    _partial: '',
    status: 'running',
    _output: '',
    _usage: null,
    _exitCode: null,
    _stderrChunks: [],
    // Account name used to resolve GEMINI_API_KEY for this spawn — the error
    // classifier reads this to invalidate the right cache entry on auth
    // failure, so the next spawn re-reads the keychain.
    _credentialAccount: credOpts.account || 'default-api-key',
  };

  // Accumulate stdout — Gemini emits a single JSON object at the end, not streaming
  child.stdout.on('data', (chunk) => {
    handle._partial += chunk.toString();
  });

  // Accumulate stderr (capped at 100 entries to prevent memory leak)
  child.stderr.on('data', (chunk) => {
    if (handle._stderrChunks.length < 100) {
      handle._stderrChunks.push(chunk.toString());
    }
  });

  // On exit: parse accumulated JSON output, determine final status
  child.on('exit', (code) => {
    handle._exitCode = code;
    _flushOutput(handle);
    // Non-zero exit with no parsed content → failed
    if (code !== 0 && handle.status === 'running') {
      handle.status = 'failed';
    }
  });

  // Spawn errors (e.g. ENOENT when gemini binary is missing)
  child.on('error', (err) => {
    handle._stderrChunks.push(err.message);
    handle.status = 'failed';
  });

  // Close stdin immediately — prompt is passed as -p arg, not via stdin
  try { child.stdin.end(); } catch {}

  return handle;
}

// ─── Monitoring ───────────────────────────────────────────────────────────────

/**
 * @typedef {Object} GeminiMonitorResult
 * @property {string} status - 'running' | 'completed' | 'failed'
 * @property {string} output - Parsed text response
 * @property {Object[]} events - All parsed events so far
 * @property {Object} [error] - Error info if failed
 * @property {Object} [usage] - Token usage stats if available
 */

/**
 * Monitor a running Gemini handle. Returns current status and accumulated output.
 * Non-destructive — the handle retains all state for subsequent calls.
 *
 * @param {GeminiHandle} handle
 * @returns {GeminiMonitorResult}
 */
export function monitor(handle) {
  const result = {
    status: handle.status,
    output: handle._output,
    events: [...handle._events],
  };

  if (handle.status === 'failed') {
    const stderr = handle._stderrChunks.join('');
    const category = mapGeminiExecError(stderr || handle._output);
    result.error = {
      category,
      message: stderr || 'Gemini process failed',
      exitCode: handle._exitCode,
    };
    // Auth failure means the cached key is stale (rotated, revoked, or the
    // entry points at a different project). Invalidate so the next spawn
    // re-reads the keychain — supports in-session /auth recovery.
    if (category === 'auth_failed' && handle._credentialAccount) {
      try { invalidateCache(handle._credentialAccount, 'auth_failed'); } catch { /* never throw */ }
    }
  }

  if (handle._usage) {
    result.usage = handle._usage;
  }

  return result;
}

/**
 * Collect the final result from a Gemini handle.
 * If the process is still running, waits for it to exit (up to timeoutMs).
 * On timeout, marks the handle as failed and resolves immediately.
 *
 * @param {GeminiHandle} handle
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<GeminiMonitorResult>}
 */
export function collect(handle, timeoutMs = 30000) {
  return new Promise((resolve) => {
    if (handle.status !== 'running') {
      resolve(monitor(handle));
      return;
    }

    // Guard: if exit already happened before we attached the listener
    if (handle._exitCode !== null) {
      _flushOutput(handle);
      resolve(monitor(handle));
      return;
    }

    const timeout = setTimeout(() => {
      handle.status = 'failed';
      // Resolve immediately with timeout error; shutdown is fire-and-forget
      // to prevent the process exit event from racing and overwriting this result
      resolve({
        status: 'failed',
        output: handle._output,
        events: [...handle._events],
        error: {
          category: 'timeout',
          message: `Gemini process did not complete within ${timeoutMs}ms`,
        },
      });
      // Kill the detached process after resolving to prevent orphan leak
      try { shutdown(handle, 3000); } catch {}
    }, timeoutMs);

    handle.process.on('exit', () => {
      clearTimeout(timeout);
      resolve(monitor(handle));
    });
  });
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────

/**
 * Shutdown a Gemini process gracefully.
 * Registers exit listener BEFORE sending SIGTERM to avoid race conditions.
 * Escalates to SIGKILL on the process group after graceMs milliseconds.
 *
 * @param {GeminiHandle} handle
 * @param {number} [graceMs=5000] - Grace period before SIGKILL
 * @returns {Promise<void>}
 */
export function shutdown(handle, graceMs = SHUTDOWN_GRACE_MS) {
  if (!handle.process || handle.process.killed) return Promise.resolve();

  // If the process already exited, no need to send signals (avoids PID reuse risk)
  if (handle._exitCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    // Register exit listener FIRST to avoid race with immediate exit
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

    handle.process.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });

    // Now send signals — after listener is registered
    try { handle.process.stdin.end(); } catch {}
    try { handle.process.kill('SIGTERM'); } catch {}
  });
}
