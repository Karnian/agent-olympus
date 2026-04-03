/**
 * Codex App-Server v2 adapter — JSON-RPC 2.0 over stdio.
 *
 * Wire protocol verified against codex-cli 0.116.0 via live stdio probe:
 *   1. Client sends `initialize` with `clientInfo: { name, version }`
 *   2. Server responds with `result.userAgent`
 *   3. Client sends `thread/start` → server responds with `result.thread.id`
 *   4. Notifications use slash-separated names: `thread/started`, `turn/started`,
 *      `item/started`, `item/completed`, `turn/completed`, `error`
 *   5. Response paths: `result.thread.id` (not `result.threadId`),
 *      `result.turn.id` (from turn/start or notifications)
 *
 * Provides multi-turn conversation support:
 * - Initialize handshake (required before any other method)
 * - Thread creation and lifecycle (start, resume, fork, rollback)
 * - Turn management (start, steer, interrupt)
 * - Real-time notification handling
 * - Structured error mapping (CodexErrorInfo → error categories)
 * - Graceful shutdown with SIGTERM → SIGKILL escalation
 *
 * Zero npm dependencies — Node.js built-ins only.
 *
 * @module codex-appserver
 */

import { spawn as nodeSpawn } from 'child_process';
import { EventEmitter } from 'events';
import { resolveBinary, buildEnhancedPath } from './resolve-binary.mjs';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Grace period before escalating from SIGTERM to SIGKILL (ms) */
const SHUTDOWN_GRACE_MS = 5000;

/** Default timeout for RPC requests (ms) */
const RPC_TIMEOUT_MS = 30000;

/** Client info sent during initialize handshake */
const CLIENT_INFO = { name: 'agent-olympus', version: '0.9.2' };

// ─── JSON-RPC helpers ─────────────────────────────────────────────────────────

let _nextId = 0;

/**
 * Create a JSON-RPC 2.0 request object.
 * @param {string} method
 * @param {Object} [params]
 * @returns {{ jsonrpc: string, id: number, method: string, params?: Object }}
 */
export function createRpcRequest(method, params) {
  const req = { jsonrpc: '2.0', id: ++_nextId, method };
  if (params !== undefined) req.params = params;
  return req;
}

/**
 * Parse a line of JSON-RPC output into a message object.
 * Returns null for non-JSON lines.
 *
 * @param {string} line
 * @returns {Object|null}
 */
export function parseRpcMessage(line) {
  const trimmed = (line || '').trim();
  if (!trimmed) return null;
  try {
    const msg = JSON.parse(trimmed);
    if (msg && typeof msg === 'object') return msg;
    return null;
  } catch {
    return null;
  }
}

/**
 * Determine if a parsed JSON-RPC message is a response, notification, or server request.
 * @param {Object} msg
 * @returns {'response'|'notification'|'request'|'unknown'}
 */
export function classifyMessage(msg) {
  if (!msg || typeof msg !== 'object') return 'unknown';
  // Response: has id + result or error
  if ('id' in msg && (msg.result !== undefined || msg.error !== undefined)) return 'response';
  // Notification: has method, no id
  if (msg.method && !('id' in msg)) return 'notification';
  // Server request: has id + method but no result/error
  if ('id' in msg && msg.method) return 'request';
  return 'unknown';
}

// ─── Error mapping ────────────────────────────────────────────────────────────

/**
 * Map a CodexErrorInfo variant to one of our standard error categories.
 *
 * CodexErrorInfo is a discriminated union that can be:
 * - A simple string: "contextWindowExceeded", "usageLimitExceeded", "unauthorized", etc.
 * - A complex object: { httpConnectionFailed: { httpStatusCode: N } }
 *
 * Maps to: auth_failed, rate_limited, context_exceeded, network, crash, timeout, unknown
 *
 * @param {string|Object|null|undefined} codexErrorInfo
 * @param {string} [fallbackMessage] - Fallback error text for heuristic matching
 * @returns {string} Error category
 */
export function mapAppServerErrorCode(codexErrorInfo, fallbackMessage) {
  if (!codexErrorInfo) {
    return _heuristicCategory(fallbackMessage);
  }

  if (typeof codexErrorInfo === 'string') {
    switch (codexErrorInfo) {
      case 'unauthorized':
        return 'auth_failed';
      case 'usageLimitExceeded':
        return 'rate_limited';
      case 'contextWindowExceeded':
        return 'context_exceeded';
      case 'serverOverloaded':
        return 'rate_limited';
      case 'internalServerError':
        return 'crash';
      case 'sandboxError':
        return 'crash';
      case 'badRequest':
        return 'crash';
      case 'threadRollbackFailed':
        return 'crash';
      case 'other':
        return _heuristicCategory(fallbackMessage);
      default:
        return 'unknown';
    }
  }

  if (typeof codexErrorInfo === 'object') {
    if (codexErrorInfo.httpConnectionFailed) return 'network';
    if (codexErrorInfo.responseStreamConnectionFailed) return 'network';
    if (codexErrorInfo.responseStreamDisconnected) return 'network';
    if (codexErrorInfo.responseTooManyFailedAttempts) return 'network';
    return 'unknown';
  }

  return 'unknown';
}

/**
 * Heuristic error classification from error message text.
 * Mirrors mapJsonlErrorToCategory from codex-exec.mjs.
 * @param {string|null|undefined} text
 * @returns {string}
 */
function _heuristicCategory(text) {
  if (!text) return 'unknown';
  const s = String(text);
  if (/authentication|unauthorized|invalid.*api.*key|API key/i.test(s)) return 'auth_failed';
  if (/rate.?limit|429|quota.*exceeded|too many requests/i.test(s)) return 'rate_limited';
  if (/command not found|ENOENT|codex:.*not found/i.test(s)) return 'not_installed';
  if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|network error/i.test(s)) return 'network';
  if (/fatal error|unhandled exception|panic:|SIGSEGV|SIGABRT|segmentation fault/i.test(s)) return 'crash';
  if (/timeout|timed?\s*out|did not complete within/i.test(s)) return 'timeout';
  return 'unknown';
}

// ─── Notification method names (slash-separated, verified against codex 0.116.0) ──

/** @type {Object<string, string>} Canonical notification method names from the wire protocol */
const NOTIFY = {
  THREAD_STARTED: 'thread/started',
  TURN_STARTED: 'turn/started',
  ITEM_STARTED: 'item/started',
  ITEM_COMPLETED: 'item/completed',
  TURN_COMPLETED: 'turn/completed',
  ERROR: 'codex/error',  // Namespaced to avoid conflict with EventEmitter's built-in 'error' event
};

// ─── AppServerHandle ──────────────────────────────────────────────────────────

/**
 * @typedef {Object} AppServerHandle
 * @property {number} pid - Process ID of the app-server
 * @property {import('child_process').ChildProcess} process - The child process
 * @property {EventEmitter} events - Event emitter for notifications
 * @property {string|null} threadId - Current thread ID
 * @property {string|null} turnId - Current active turn ID
 * @property {string} status - 'starting' | 'ready' | 'running' | 'completed' | 'failed'
 * @property {string} _partial - Partial line buffer
 * @property {Map<number, Object>} _pending - Pending RPC response handlers
 * @property {Object[]} _items - Accumulated items from the current turn
 * @property {string} _output - Aggregated text output
 * @property {Object|null} _turnError - Error from turn completion
 * @property {number|null} _exitCode - Process exit code
 * @property {string[]} _stderrChunks - Accumulated stderr
 * @property {boolean} _initialized - Whether initialize handshake completed
 * @property {string} _adapterName - Always 'codex-appserver'
 */

/**
 * Start the codex app-server subprocess.
 * Returns a handle for sending RPC requests and receiving notifications.
 *
 * NOTE: The handle is NOT ready until initializeServer() completes the handshake.
 *
 * @param {Object} [opts]
 * @param {string} [opts.cwd] - Working directory
 * @param {Object} [opts.env] - Additional environment variables
 * @param {string} [opts.sessionSource] - Session source tag (default: 'agent-olympus')
 * @returns {AppServerHandle}
 */
export function startServer(opts = {}) {
  const codexPath = resolveBinary('codex');
  const args = [
    'app-server',
    '--listen', 'stdio://',
  ];
  if (opts.sessionSource) {
    args.push('--session-source', opts.sessionSource);
  }

  const child = nodeSpawn(codexPath, args, {
    cwd: opts.cwd || process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PATH: buildEnhancedPath(), ...opts.env },
    detached: true,
  });

  const emitter = new EventEmitter();

  /** @type {AppServerHandle} */
  const handle = {
    pid: child.pid,
    process: child,
    events: emitter,
    threadId: null,
    turnId: null,
    status: 'starting',
    _partial: '',
    _pending: new Map(),
    _items: [],
    _output: '',
    _turnError: null,
    _exitCode: null,
    _stderrChunks: [],
    _initialized: false,
    _adapterName: 'codex-appserver',
  };

  // Parse stdout as JSONL — each line is a JSON-RPC response or notification
  child.stdout.on('data', (chunk) => {
    const text = handle._partial + chunk.toString();
    const lines = text.split('\n');
    handle._partial = lines.pop() || '';

    for (const line of lines) {
      const msg = parseRpcMessage(line);
      if (!msg) continue;

      const kind = classifyMessage(msg);

      if (kind === 'response') {
        const handler = handle._pending.get(msg.id);
        if (handler) {
          handle._pending.delete(msg.id);
          handler.resolve(msg);
        }
      } else if (kind === 'notification') {
        _processNotification(handle, msg);
        emitter.emit('notification', msg);
        if (msg.method) {
          // Map wire 'error' to 'codex/error' to avoid EventEmitter collision
          const emitName = msg.method === 'error' ? NOTIFY.ERROR : msg.method;
          emitter.emit(emitName, msg.params || msg);
        }
      } else if (kind === 'request') {
        // Server-initiated request (e.g., approval prompts).
        // Auto-respond with empty result — we use approvalPolicy: 'never'.
        try {
          const resp = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} });
          handle.process.stdin.write(resp + '\n');
        } catch {
          // stdin may be closed
        }
      }
    }
  });

  // Accumulate stderr (capped at 100 entries to prevent memory leak)
  child.stderr.on('data', (chunk) => {
    if (handle._stderrChunks.length < 100) {
      handle._stderrChunks.push(chunk.toString());
    }
  });

  // Process exit — register BEFORE any signals to avoid missing immediate exits
  child.on('exit', (code) => {
    handle._exitCode = code;
    if (handle.status === 'starting' || handle.status === 'ready' || handle.status === 'running') {
      handle.status = 'failed';
    }
    _flushPartial(handle);
    for (const [id, handler] of handle._pending) {
      handler.resolve({ jsonrpc: '2.0', id, error: { code: -1, message: 'Server process exited' } });
    }
    handle._pending.clear();
    emitter.emit('exit', code);
  });

  child.on('error', (err) => {
    handle._stderrChunks.push(err.message);
    handle.status = 'failed';
    emitter.emit('error', err);
  });

  return handle;
}

/**
 * Perform the required `initialize` handshake with the app-server.
 * Must be called after startServer() and before any other method.
 *
 * Wire protocol: Client sends `initialize` with `clientInfo`, server responds
 * with `userAgent` and platform info. No separate `initialized` notification.
 *
 * @param {AppServerHandle} handle
 * @param {Object} [clientInfo] - Override client info (for testing)
 * @returns {Promise<{ error?: Object }>}
 */
export async function initializeServer(handle, clientInfo) {
  const response = await sendRequest(handle, 'initialize', {
    clientInfo: clientInfo || CLIENT_INFO,
  });

  if (response.error) {
    return { error: response.error };
  }

  handle._initialized = true;
  handle.status = 'ready';
  return {};
}

/**
 * Process a JSON-RPC notification and update handle state.
 *
 * Notification method names are slash-separated per the codex app-server wire protocol:
 *   thread/started, turn/started, item/started, item/completed, turn/completed, error
 *
 * @param {AppServerHandle} handle
 * @param {Object} notification
 */
function _processNotification(handle, notification) {
  const method = notification.method || '';
  const params = notification.params || {};

  switch (method) {
    case NOTIFY.THREAD_STARTED: {
      // Wire: params.thread.id (not params.threadId)
      const threadId = params.thread?.id;
      if (threadId) handle.threadId = threadId;
      break;
    }
    case NOTIFY.TURN_STARTED: {
      handle.status = 'running';
      // Wire: params.turn.id
      if (params.turn?.id) handle.turnId = params.turn.id;
      handle._items = [];
      handle._output = '';
      handle._turnError = null;
      break;
    }
    case NOTIFY.ITEM_STARTED: {
      if (params.item) {
        handle._items.push({ ...params.item, _phase: 'started' });
      }
      break;
    }
    case NOTIFY.ITEM_COMPLETED: {
      const item = params.item;
      if (!item) break;

      const idx = handle._items.findIndex(i => i.id === item.id);
      if (idx >= 0) {
        handle._items[idx] = { ...item, _phase: 'completed' };
      } else {
        handle._items.push({ ...item, _phase: 'completed' });
      }

      if (item.type === 'agentMessage' && item.text) {
        handle._output += item.text + '\n';
      } else if (item.type === 'commandExecution' && item.aggregatedOutput) {
        handle._output += item.aggregatedOutput;
      }
      break;
    }
    case NOTIFY.TURN_COMPLETED: {
      // Wire: params.turn.status.type (status is an object like {type: "completed"})
      const turn = params.turn || params;
      const statusObj = turn.status;
      const turnStatus = (typeof statusObj === 'object' && statusObj !== null)
        ? statusObj.type
        : (statusObj || 'completed');

      if (turnStatus === 'completed') {
        handle.status = 'completed';
      } else if (turnStatus === 'interrupted') {
        handle.status = 'completed';
      } else if (turnStatus === 'failed') {
        handle.status = 'failed';
        handle._turnError = turn.error || null;
      }
      break;
    }
    case 'error': {
      // Wire method name is 'error' — maps to NOTIFY.ERROR ('codex/error') for emitting
      if (!params.willRetry) {
        handle._turnError = params.error || { message: 'Unknown error' };
      }
      break;
    }
    // Ignore other notifications (thread/statusChanged, tokenUsageUpdated, etc.)
  }
}

/**
 * Flush remaining partial buffer when process exits.
 * @param {AppServerHandle} handle
 */
function _flushPartial(handle) {
  if (!handle._partial || !handle._partial.trim()) return;
  const msg = parseRpcMessage(handle._partial);
  if (msg) {
    const kind = classifyMessage(msg);
    if (kind === 'response') {
      const handler = handle._pending.get(msg.id);
      if (handler) {
        handle._pending.delete(msg.id);
        handler.resolve(msg);
      }
    } else if (kind === 'notification') {
      _processNotification(handle, msg);
      handle.events.emit('notification', msg);
    }
  }
  handle._partial = '';
}

// ─── RPC request layer ────────────────────────────────────────────────────────

/**
 * Send a JSON-RPC request and wait for the response.
 *
 * @param {AppServerHandle} handle
 * @param {string} method - RPC method name
 * @param {Object} [params] - Method parameters
 * @param {number} [timeoutMs=30000] - Request timeout
 * @returns {Promise<Object>} The JSON-RPC response (result or error)
 */
export function sendRequest(handle, method, params, timeoutMs = RPC_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (handle.status === 'failed' || handle._exitCode !== null) {
      resolve({ jsonrpc: '2.0', id: -1, error: { code: -1, message: 'Server not running' } });
      return;
    }

    const req = createRpcRequest(method, params);

    const timer = setTimeout(() => {
      handle._pending.delete(req.id);
      resolve({ jsonrpc: '2.0', id: req.id, error: { code: -2, message: `Request timed out after ${timeoutMs}ms` } });
    }, timeoutMs);

    handle._pending.set(req.id, {
      resolve: (response) => {
        clearTimeout(timer);
        resolve(response);
      },
    });

    try {
      handle.process.stdin.write(JSON.stringify(req) + '\n');
    } catch (err) {
      clearTimeout(timer);
      handle._pending.delete(req.id);
      resolve({ jsonrpc: '2.0', id: req.id, error: { code: -3, message: `Write failed: ${err.message}` } });
    }
  });
}

// ─── Thread/Turn lifecycle ────────────────────────────────────────────────────

/**
 * Create a new conversation thread.
 *
 * Wire: thread/start → result.thread.id
 *
 * @param {AppServerHandle} handle
 * @param {Object} [opts]
 * @param {string} [opts.cwd] - Working directory
 * @param {string} [opts.model] - Model override
 * @param {string} [opts.baseInstructions] - System prompt
 * @param {string} [opts.approvalPolicy='never'] - Approval policy
 * @param {boolean} [opts.ephemeral=true] - Whether thread persists
 * @returns {Promise<{ threadId?: string, error?: Object }>}
 */
export async function createThread(handle, opts = {}) {
  if (!handle._initialized) {
    return { error: { code: -10, message: 'Server not initialized. Call initializeServer() first.' } };
  }

  const params = {
    ephemeral: opts.ephemeral !== false,
    approvalPolicy: opts.approvalPolicy || 'never',
  };
  if (opts.cwd) params.cwd = opts.cwd;
  if (opts.model) params.model = opts.model;
  if (opts.baseInstructions) params.baseInstructions = opts.baseInstructions;

  const response = await sendRequest(handle, 'thread/start', params);

  if (response.error) {
    return { error: response.error };
  }

  // Wire: result.thread.id (not result.threadId)
  const threadId = response.result?.thread?.id || handle.threadId;
  if (threadId) handle.threadId = threadId;

  return { threadId };
}

/**
 * Start a new turn in the current thread.
 *
 * Wire: turn/start → result.turn.id (from response or turn/started notification)
 *
 * @param {AppServerHandle} handle
 * @param {string} prompt - User input text
 * @param {Object} [opts]
 * @param {string} [opts.model] - Per-turn model override
 * @param {string} [opts.effort] - Reasoning effort level
 * @returns {Promise<{ turnId?: string, error?: Object }>}
 */
export async function startTurn(handle, prompt, opts = {}) {
  if (!handle.threadId) {
    return { error: { code: -10, message: 'No active thread. Call createThread first.' } };
  }

  const params = {
    threadId: handle.threadId,
    input: [{ type: 'text', text: prompt }],
  };
  if (opts.model) params.model = opts.model;
  if (opts.effort) params.effort = opts.effort;

  const response = await sendRequest(handle, 'turn/start', params);

  if (response.error) {
    // Do NOT reset state on failure — preserve prior turn's output
    return { error: response.error };
  }

  // Reset turn state only after successful RPC response
  handle._items = [];
  handle._output = '';
  handle._turnError = null;
  handle.status = 'running';

  // Wire: result.turn.id (not result.turnId)
  const turnId = response.result?.turn?.id || handle.turnId;
  if (turnId) handle.turnId = turnId;

  return { turnId };
}

/**
 * Inject additional input into an active turn (live steering).
 *
 * @param {AppServerHandle} handle
 * @param {string} input - Additional user input
 * @returns {Promise<{ error?: Object }>}
 */
export async function steerTurn(handle, input) {
  if (!handle.threadId || !handle.turnId) {
    return { error: { code: -10, message: 'No active turn to steer.' } };
  }

  const params = {
    threadId: handle.threadId,
    expectedTurnId: handle.turnId,
    input: [{ type: 'text', text: input }],
  };

  const response = await sendRequest(handle, 'turn/steer', params);
  return response.error ? { error: response.error } : {};
}

/**
 * Interrupt (abort) the current active turn.
 *
 * @param {AppServerHandle} handle
 * @returns {Promise<{ error?: Object }>}
 */
export async function interruptTurn(handle) {
  if (!handle.threadId || !handle.turnId) {
    return { error: { code: -10, message: 'No active turn to interrupt.' } };
  }

  const response = await sendRequest(handle, 'turn/interrupt', {
    threadId: handle.threadId,
    turnId: handle.turnId,
  });

  return response.error ? { error: response.error } : {};
}

// ─── Monitoring ───────────────────────────────────────────────────────────────

/**
 * @typedef {Object} AppServerMonitorResult
 * @property {string} status - 'running' | 'completed' | 'failed'
 * @property {string} output - Aggregated text output
 * @property {Object[]} items - All items from the current turn
 * @property {Object} [error] - Error info if failed
 */

/**
 * Get current status of the app-server handle. Non-destructive.
 *
 * @param {AppServerHandle} handle
 * @returns {AppServerMonitorResult}
 */
export function monitor(handle) {
  const result = {
    status: handle.status,
    output: handle._output,
    items: [...handle._items],
    threadId: handle.threadId,
    turnId: handle.turnId,
  };

  if (handle.status === 'failed') {
    const stderr = handle._stderrChunks.join('');
    const turnErr = handle._turnError;
    const codexErrorInfo = turnErr?.codexErrorInfo || null;
    const message = turnErr?.message || stderr || 'App-server process failed';
    const category = mapAppServerErrorCode(codexErrorInfo, message);

    result.error = {
      category,
      message,
      codexErrorInfo,
      exitCode: handle._exitCode,
    };
  }

  return result;
}

/**
 * Wait for the current turn to complete.
 * Resolves when turn/completed notification arrives, process exits, or timeout.
 *
 * @param {AppServerHandle} handle
 * @param {number} [timeoutMs=120000] - Max wait time (2 minutes default)
 * @returns {Promise<AppServerMonitorResult>}
 */
export function collectTurnResult(handle, timeoutMs = 120000) {
  return new Promise((resolve) => {
    if (handle.status === 'completed' || handle.status === 'failed') {
      resolve(monitor(handle));
      return;
    }

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve(monitor(handle));
    };

    const timer = setTimeout(() => {
      handle.status = 'failed';
      handle._turnError = { message: `Turn did not complete within ${timeoutMs}ms` };
      settle();
    }, timeoutMs);

    // Listen for turn completion (slash-separated notification name)
    const onTurnCompleted = () => {
      clearTimeout(timer);
      handle.events.removeListener('exit', onExit);
      settle();
    };

    const onExit = () => {
      clearTimeout(timer);
      handle.events.removeListener(NOTIFY.TURN_COMPLETED, onTurnCompleted);
      settle();
    };

    handle.events.once(NOTIFY.TURN_COMPLETED, onTurnCompleted);
    handle.events.once('exit', onExit);
  });
}

// ─── Multi-turn convenience ───────────────────────────────────────────────────

/**
 * Execute a single prompt as a complete turn: start turn → wait for completion → return result.
 * The thread must already be created.
 *
 * @param {AppServerHandle} handle
 * @param {string} prompt
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs=120000]
 * @param {string} [opts.model]
 * @param {string} [opts.effort]
 * @returns {Promise<AppServerMonitorResult>}
 */
export async function executeTurn(handle, prompt, opts = {}) {
  const startResult = await startTurn(handle, prompt, opts);
  if (startResult.error) {
    return {
      status: 'failed',
      output: '',
      items: [],
      error: {
        category: 'crash',
        message: startResult.error.message || 'Failed to start turn',
      },
    };
  }

  return collectTurnResult(handle, opts.timeoutMs || 120000);
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────

/**
 * Shutdown the app-server process gracefully.
 * Registers exit listener BEFORE sending SIGTERM to avoid missing immediate exits.
 * Escalates to SIGKILL on the process group after graceMs.
 *
 * @param {AppServerHandle} handle
 * @param {number} [graceMs=5000]
 * @returns {Promise<void>}
 */
export function shutdownServer(handle, graceMs = SHUTDOWN_GRACE_MS) {
  if (!handle.process || handle.process.killed) return Promise.resolve();

  return new Promise((resolve) => {
    // Register exit listener FIRST to avoid race with immediate exit
    const timer = setTimeout(() => {
      // Escalate: SIGKILL the entire process group
      try { process.kill(-handle.pid, 'SIGKILL'); } catch {}
      // Fallback: kill just the process
      try { handle.process.kill('SIGKILL'); } catch {}
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

// ─── Register notification listener ───────────────────────────────────────────

/**
 * Register a callback for a specific notification type.
 * Use slash-separated names: 'item/completed', 'turn/completed', etc.
 *
 * @param {AppServerHandle} handle
 * @param {string} method - Notification method name (e.g., 'item/completed', 'turn/completed')
 * @param {Function} callback - Handler function
 * @returns {Function} Unsubscribe function
 */
export function onNotification(handle, method, callback) {
  handle.events.on(method, callback);
  return () => handle.events.removeListener(method, callback);
}

// Re-export NOTIFY for tests and consumers
export { NOTIFY };
