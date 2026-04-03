import { spawn as nodeSpawn } from 'child_process';
import { resolveBinary, buildEnhancedPath } from './resolve-binary.mjs';

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
 * Spawn a Codex exec --json process with the given prompt.
 * The prompt is written to stdin; Codex reads it via `-` (stdin mode).
 *
 * @param {string} prompt - The prompt to send to Codex
 * @param {Object} [opts] - Options
 * @param {string} [opts.cwd] - Working directory
 * @param {Object} [opts.env] - Additional environment variables merged over process.env
 * @returns {CodexHandle}
 */
export function spawn(prompt, opts = {}) {
  const codexPath = resolveBinary('codex');
  const args = [
    'exec',
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '--ephemeral',
    '-',
  ];

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

      // Accumulate readable output and detect item-level failures
      if (event.type === 'item.completed' && event.item) {
        if (event.item.type === 'agent_message' && event.item.text) {
          handle._output += event.item.text + '\n';
        } else if (event.item.type === 'command_execution' && event.item.aggregated_output) {
          handle._output += event.item.aggregated_output;
        }
        // item.status === 'failed' means a command exited non-zero
        if (event.item.status === 'failed') {
          handle.status = 'failed';
        }
      }

      // turn.completed signals the end of a successful turn
      if (event.type === 'turn.completed') {
        if (handle.status !== 'failed') handle.status = 'completed';
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
  const result = {
    status: handle.status,
    output: handle._output,
    events: [...handle._events],
  };

  if (handle.status === 'failed') {
    const stderr = handle._stderrChunks.join('');
    const category = mapJsonlErrorToCategory(stderr || handle._output);
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
        if (event.item.status === 'failed') handle.status = 'failed';
      }
      if (event.type === 'turn.completed') {
        if (handle.status !== 'failed') handle.status = 'completed';
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

    handle.process.on('exit', () => {
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

  // Send SIGTERM
  handle.kill('SIGTERM');

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
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
