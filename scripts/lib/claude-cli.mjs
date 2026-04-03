/**
 * Claude CLI adapter — spawns `claude -p` with stream-json output.
 *
 * Wire protocol verified against Claude Code CLI 2.1.87:
 *   1. `--output-format stream-json` requires `--verbose`
 *   2. Events are JSONL with `type` field: "system", "assistant", "user", "result"
 *   3. Init: { type: "system", subtype: "init", session_id, tools, model }
 *   4. Assistant: { type: "assistant", message: { content: [...] }, error?: string }
 *   5. Result: { type: "result", subtype: "success"|"error_max_budget_usd",
 *               is_error: bool, result: string, total_cost_usd: N, usage: {...} }
 *
 * Provides single-turn Claude Code execution as a worker:
 * - Spawns `claude -p --output-format stream-json --verbose --bare`
 * - Parses JSONL stream and accumulates text output
 * - Maps errors to standard categories (auth_failed, rate_limited, etc.)
 * - Graceful shutdown with SIGTERM → SIGKILL escalation
 *
 * Zero npm dependencies — Node.js built-ins only.
 *
 * @module claude-cli
 */

import { spawn as nodeSpawn } from 'child_process';
import { resolveClaudeBinary, buildEnhancedPath } from './resolve-binary.mjs';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Grace period before escalating from SIGTERM to SIGKILL (ms) */
const SHUTDOWN_GRACE_MS = 5000;

// ─── JSONL parsing ───────────────────────────────────────────────────────────

/**
 * Parse a buffer of JSONL text into an array of event objects.
 * Handles partial lines gracefully — returns { events, remainder }.
 *
 * @param {string} buffer
 * @returns {{ events: Object[], remainder: string }}
 */
export function parseStreamJsonEvents(buffer) {
  const events = [];
  const lines = buffer.split('\n');
  const remainder = lines.pop(); // Last element may be an incomplete line

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines — CLI may emit non-JSON diagnostic output
    }
  }

  return { events, remainder: remainder || '' };
}

// ─── Error mapping ───────────────────────────────────────────────────────────

/**
 * Classify a Claude CLI error into one of the standard error categories.
 * Maps error text to: auth_failed, rate_limited, not_installed,
 * network, crash, timeout, context_exceeded, or unknown.
 *
 * @param {string|null|undefined} errorText
 * @returns {string}
 */
export function mapClaudeCliError(errorText) {
  if (!errorText) return 'unknown';
  const text = String(errorText);

  if (/authentication|unauthorized|not logged in|invalid.*api.*key|API key/i.test(text)) return 'auth_failed';
  if (/rate.?limit|429|quota.*exceeded|too many requests|overloaded/i.test(text)) return 'rate_limited';
  if (/command not found|ENOENT|claude:.*not found/i.test(text)) return 'not_installed';
  if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|network error/i.test(text)) return 'network';
  if (/context.*window|context.*exceeded|too many tokens/i.test(text)) return 'context_exceeded';
  if (/fatal error|unhandled exception|panic:|SIGSEGV|SIGABRT|segmentation fault/i.test(text)) return 'crash';
  if (/timeout|timed?\s*out|did not complete within/i.test(text)) return 'timeout';
  if (/budget|max_budget_usd|error_max_budget_usd/i.test(text)) return 'rate_limited';

  return 'unknown';
}

/**
 * Extract error category from a stream-json result event.
 * Checks both the event's error field and subtype for known patterns.
 *
 * Note: The CLI can return `is_error: false` with `subtype: "error_max_budget_usd"`.
 * We treat budget exhaustion as an error regardless of is_error flag, because the
 * worker may not have completed its task.
 *
 * @param {Object} resultEvent - The result event from stream-json
 * @returns {string|null} Error category or null if no error
 */
export function classifyResultEvent(resultEvent) {
  if (!resultEvent) return null;

  // Budget exhaustion is always an error, even when is_error is false
  // (CLI reports is_error: false when the turn succeeded but budget stopped further work)
  if (resultEvent.subtype === 'error_max_budget_usd') return 'rate_limited';

  // Check is_error flag
  if (resultEvent.is_error) {
    // Check result text
    return mapClaudeCliError(resultEvent.result || resultEvent.error);
  }

  return null;
}

// ─── Handle type ─────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ClaudeCliHandle
 * @property {number} pid - Process ID
 * @property {import('child_process').ChildProcess} process - The child process
 * @property {import('stream').Readable} stdout - stdout stream
 * @property {Function} kill - Kill the process with optional signal
 * @property {Object[]} _events - Accumulated parsed events
 * @property {string} _partial - Partial line buffer for incomplete JSONL
 * @property {string|null} sessionId - Session ID from init event
 * @property {string} status - 'running' | 'completed' | 'failed'
 * @property {string} _output - Aggregated text output
 * @property {Object|null} _usage - Token usage from result event
 * @property {number|null} _exitCode - Process exit code
 * @property {string[]} _stderrChunks - Accumulated stderr chunks
 * @property {number|null} totalCostUsd - Total cost from result event
 * @property {string} _adapterName - Always 'claude-cli'
 * @property {Object|null} _resultEvent - The final result event
 * @property {string|null} _errorField - Error field from assistant event
 */

// ─── Core API ────────────────────────────────────────────────────────────────

/**
 * Spawn a Claude CLI process with the given prompt.
 * Uses `-p --output-format stream-json --verbose --bare` for headless JSONL streaming.
 *
 * @param {string} prompt - The prompt to send to Claude
 * @param {Object} [opts] - Options
 * @param {string} [opts.cwd] - Working directory
 * @param {Object} [opts.env] - Additional environment variables merged over process.env
 * @param {string} [opts.model] - Model override (e.g., 'sonnet', 'opus', 'haiku')
 * @param {string[]} [opts.allowedTools] - Tool whitelist (e.g., ['Bash', 'Edit', 'Read'])
 * @param {string} [opts.systemPrompt] - System prompt override
 * @param {string} [opts.appendSystemPrompt] - Append to default system prompt
 * @param {number} [opts.maxBudgetUsd] - Maximum dollar budget
 * @param {string} [opts.permissionMode] - Permission mode ('default', 'bypassPermissions', etc.)
 * @param {boolean} [opts.bare] - Run in bare mode (skip hooks/plugins). Default: true
 * @param {boolean} [opts.noSessionPersistence] - Skip session persistence. Default: true
 * @returns {ClaudeCliHandle}
 */
export function spawn(prompt, opts = {}) {
  const claudePath = resolveClaudeBinary();
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
  ];

  // Bare mode (default: true for worker usage)
  if (opts.bare !== false) {
    args.push('--bare');
  }

  // No session persistence (default: true for ephemeral workers)
  if (opts.noSessionPersistence !== false) {
    args.push('--no-session-persistence');
  }

  // Permission mode
  if (opts.permissionMode) {
    args.push('--permission-mode', opts.permissionMode);
  } else {
    // Default: bypass permissions for automated workers
    args.push('--dangerously-skip-permissions');
  }

  // Model override
  if (opts.model) {
    args.push('--model', opts.model);
  }

  // Allowed tools
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push('--allowedTools', ...opts.allowedTools);
  }

  // System prompt
  if (opts.systemPrompt) {
    args.push('--system-prompt', opts.systemPrompt);
  }

  if (opts.appendSystemPrompt) {
    args.push('--append-system-prompt', opts.appendSystemPrompt);
  }

  // Budget control
  if (opts.maxBudgetUsd != null) {
    args.push('--max-budget-usd', String(opts.maxBudgetUsd));
  }

  // Prompt as the final positional argument
  args.push(prompt);

  const child = nodeSpawn(claudePath, args, {
    cwd: opts.cwd || process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PATH: buildEnhancedPath(), ...opts.env },
    detached: true, // Required for process-group cleanup
  });

  /** @type {ClaudeCliHandle} */
  const handle = {
    pid: child.pid,
    process: child,
    stdout: child.stdout,
    kill: (signal = 'SIGTERM') => {
      try { child.kill(signal); } catch {}
    },
    _events: [],
    _partial: '',
    sessionId: null,
    status: 'running',
    _output: '',
    _usage: null,
    _exitCode: null,
    _stderrChunks: [],
    totalCostUsd: null,
    _adapterName: 'claude-cli',
    _resultEvent: null,
    _errorField: null,
  };

  // Stream stdout and parse JSONL events incrementally
  child.stdout.on('data', (chunk) => {
    const text = handle._partial + chunk.toString();
    const { events, remainder } = parseStreamJsonEvents(text);
    handle._partial = remainder;

    for (const event of events) {
      _processEvent(handle, event);
    }
  });

  // Accumulate stderr (capped at 100 entries to prevent memory leak)
  child.stderr.on('data', (chunk) => {
    if (handle._stderrChunks.length < 100) {
      handle._stderrChunks.push(chunk.toString());
    }
  });

  // Non-zero exit with no prior completion signal → treat as failure
  child.on('exit', (code) => {
    handle._exitCode = code;
    _flushPartial(handle);
    if (code !== 0 && handle.status === 'running') {
      handle.status = 'failed';
    }
  });

  // Spawn errors (e.g. ENOENT when claude binary is missing)
  child.on('error', (err) => {
    handle._stderrChunks.push(err.message);
    handle.status = 'failed';
  });

  // Close stdin immediately — prompt is passed as positional arg, not via stdin
  try { child.stdin.end(); } catch {}

  return handle;
}

/**
 * Process a single stream-json event and update handle state.
 *
 * @param {ClaudeCliHandle} handle
 * @param {Object} event
 */
function _processEvent(handle, event) {
  handle._events.push(event);

  switch (event.type) {
    case 'system': {
      // Init event: capture session ID
      if (event.subtype === 'init' && event.session_id) {
        handle.sessionId = event.session_id;
      }
      break;
    }

    case 'assistant': {
      // Assistant response — extract text from content blocks
      const message = event.message;
      if (!message) break;

      // Capture error field (e.g., "authentication_failed")
      if (event.error) {
        handle._errorField = event.error;
      }

      if (message.content && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === 'text' && block.text) {
            handle._output += block.text;
          }
        }
      }
      break;
    }

    case 'result': {
      handle._resultEvent = event;
      handle.totalCostUsd = event.total_cost_usd ?? null;

      if (event.usage) {
        handle._usage = event.usage;
      }

      // Determine success or failure
      const errorCategory = classifyResultEvent(event);
      if (errorCategory) {
        handle.status = 'failed';
      } else if (handle._errorField) {
        // Assistant-level error (e.g., auth_failed)
        handle.status = 'failed';
      } else {
        if (handle.status !== 'failed') {
          handle.status = 'completed';
        }
      }
      break;
    }
    // Ignore 'user' events (tool results) and other types
  }
}

/**
 * Flush remaining partial buffer when process exits.
 * @param {ClaudeCliHandle} handle
 */
function _flushPartial(handle) {
  if (handle._partial && handle._partial.trim()) {
    try {
      const event = JSON.parse(handle._partial.trim());
      _processEvent(handle, event);
      handle._partial = '';
    } catch {
      // Not valid JSON — discard
    }
  }
}

// ─── Monitoring ──────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ClaudeCliMonitorResult
 * @property {string} status - 'running' | 'completed' | 'failed'
 * @property {string} output - Aggregated text output
 * @property {Object[]} events - All parsed events
 * @property {Object} [error] - Error info if failed
 * @property {Object} [usage] - Token usage if available
 */

/**
 * Monitor a running Claude CLI handle. Returns current status and output.
 * Non-destructive — the handle retains all state.
 *
 * @param {ClaudeCliHandle} handle
 * @returns {ClaudeCliMonitorResult}
 */
export function monitor(handle) {
  const result = {
    status: handle.status,
    output: handle._output,
    events: [...handle._events],
  };

  if (handle.status === 'failed') {
    const stderr = handle._stderrChunks.join('');
    const resultEvt = handle._resultEvent;
    const errorText = handle._errorField || resultEvt?.result || stderr || handle._output;
    const category = classifyResultEvent(resultEvt) || mapClaudeCliError(errorText);

    result.error = {
      category,
      message: errorText || 'Claude CLI process failed',
      exitCode: handle._exitCode,
    };
  }

  if (handle._usage) {
    result.usage = handle._usage;
  }

  if (handle.totalCostUsd != null) {
    result.totalCostUsd = handle.totalCostUsd;
  }

  return result;
}

/**
 * Collect the final result from a Claude CLI handle.
 * If the process is still running, waits for it to exit (up to timeoutMs).
 * On timeout the handle is marked failed and the promise resolves immediately.
 *
 * @param {ClaudeCliHandle} handle
 * @param {number} [timeoutMs=120000]
 * @returns {Promise<ClaudeCliMonitorResult>}
 */
export function collect(handle, timeoutMs = 120000) {
  return new Promise((resolve) => {
    if (handle.status !== 'running') {
      _flushPartial(handle);
      resolve(monitor(handle));
      return;
    }

    // Guard: if exit already happened before we attached the listener,
    // check _exitCode to avoid false timeout.
    if (handle._exitCode !== null) {
      _flushPartial(handle);
      resolve(monitor(handle));
      return;
    }

    const timeout = setTimeout(async () => {
      handle.status = 'failed';
      // CRITICAL FIX: Kill the detached process on timeout to prevent orphan leak
      try { await shutdown(handle, 3000); } catch {}
      resolve({
        ...monitor(handle),
        error: {
          category: 'timeout',
          message: `Claude CLI process did not complete within ${timeoutMs}ms`,
        },
      });
    }, timeoutMs);

    handle.process.on('exit', () => {
      clearTimeout(timeout);
      _flushPartial(handle);
      resolve(monitor(handle));
    });
  });
}

// ─── Shutdown ────────────────────────────────────────────────────────────────

/**
 * Shutdown a Claude CLI process gracefully.
 * Registers exit listener BEFORE sending SIGTERM to avoid race conditions.
 * Escalates to SIGKILL on the process group after graceMs.
 *
 * @param {ClaudeCliHandle} handle
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
      // Double-check exit code before SIGKILL to prevent PID reuse attack
      if (handle._exitCode !== null) {
        resolve();
        return;
      }
      // Escalate: SIGKILL the entire process group
      try { process.kill(-handle.pid, 'SIGKILL'); } catch {}
      // Fallback: kill just the process
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
