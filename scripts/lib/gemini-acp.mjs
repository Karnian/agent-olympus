/**
 * Gemini ACP adapter — JSON-RPC 2.0 over stdio.
 *
 * Wire protocol for `gemini --acp` (ACP = Agent Communication Protocol):
 *   1. Client sends `initialize` with `clientInfo` and `protocolVersion`.
 *      Server responds with server info / capabilities.
 *   2. Client sends `newSession` with `workingDirectory`.
 *      Server responds with `result.sessionId`.
 *   3. Client sends `prompt` with `{ sessionId, text }`.
 *      Server streams notifications then responds with the final result.
 *   4. Notifications use camelCase method names:
 *      `sessionStarted`, `promptStarted`, `itemStarted`,
 *      `itemCompleted`, `promptCompleted`
 *   5. Cancel: `cancel` with `{ sessionId }`.
 *   6. Mode change: `setSessionMode` with `{ sessionId, mode }`.
 *   7. Model change: `unstable_setSessionModel` with `{ sessionId, model }`.
 *   8. Session resume: `loadSession` with `{ sessionId }` → `result.sessionId`.
 *
 * Key differences from codex-appserver:
 *   - camelCase method names (not slash-separated)
 *   - `newSession` / `loadSession` instead of `thread/start`
 *   - `prompt` instead of `turn/start`
 *   - `cancel` instead of `turn/interrupt`
 *   - `sessionId` (string) instead of `thread.id`
 *   - ACP has known stability issues — aggressive timeouts + reconnection logic
 *
 * Defensive parsing accepts both camelCase and slash-separated formats so tests
 * and partial protocol changes are handled gracefully.
 *
 * Zero npm dependencies — Node.js built-ins only.
 *
 * @module gemini-acp
 */

import { spawn as nodeSpawn } from 'child_process';
import { EventEmitter } from 'events';
import { resolveBinary, buildEnhancedPath } from './resolve-binary.mjs';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Grace period before escalating from SIGTERM to SIGKILL (ms) */
const SHUTDOWN_GRACE_MS = 5000;

/** Default timeout for generic RPC requests (ms) */
const RPC_TIMEOUT_MS = 30000;

/** Initialize handshake timeout — ACP has higher startup latency than Codex (ms) */
const INIT_TIMEOUT_MS = 10000;

/** Default prompt turn timeout (ms) */
const PROMPT_TIMEOUT_MS = 120000;

/** Max stderr chunks retained to prevent unbounded memory growth */
const MAX_STDERR_CHUNKS = 100;

/** Max queued messages to prevent unbounded memory growth if worker is stuck */
const MAX_QUEUE_DEPTH = 200;

/** Protocol version used in the initialize handshake */
const PROTOCOL_VERSION = '2025-07-01';

/** Client info sent during initialize handshake */
const CLIENT_INFO = { name: 'agent-olympus', version: '1.0' };

// ─── Notification method names (camelCase, per Gemini ACP wire protocol) ──────

/**
 * Canonical notification method names — camelCase per the Gemini ACP protocol.
 * Defensive: the JSONL parser also accepts slash-separated equivalents in case
 * a future protocol revision reverts to that style.
 *
 * NOTE: 'error' is remapped to 'gemini/error' when emitting events to avoid
 * colliding with Node.js EventEmitter's built-in 'error' event.
 *
 * @type {Object<string, string>}
 */
const NOTIFY = {
  SESSION_STARTED: 'sessionStarted',
  PROMPT_STARTED: 'promptStarted',
  ITEM_STARTED: 'itemStarted',
  ITEM_COMPLETED: 'itemCompleted',
  PROMPT_COMPLETED: 'promptCompleted',
  ERROR: 'gemini/error', // remapped to avoid EventEmitter collision
};

// ─── JSON-RPC helpers ─────────────────────────────────────────────────────────

let _nextId = 0;

/**
 * Create a JSON-RPC 2.0 request object with an auto-incrementing id.
 *
 * @param {string} method - RPC method name
 * @param {Object} [params] - Method parameters (omitted if undefined)
 * @returns {{ jsonrpc: string, id: number, method: string, params?: Object }}
 */
export function createRpcRequest(method, params) {
  const req = { jsonrpc: '2.0', id: ++_nextId, method };
  if (params !== undefined) req.params = params;
  return req;
}

/**
 * Parse a JSONL line into a message object.
 * Returns null for blank lines and unparseable input.
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
 * Classify a parsed JSON-RPC message as response, notification, request, or unknown.
 *
 * @param {Object} msg
 * @returns {'response'|'notification'|'request'|'unknown'}
 */
export function classifyMessage(msg) {
  if (!msg || typeof msg !== 'object') return 'unknown';
  // Response: has id + (result or error)
  if ('id' in msg && (msg.result !== undefined || msg.error !== undefined)) return 'response';
  // Notification: has method, no id
  if (msg.method && !('id' in msg)) return 'notification';
  // Server request: has id + method, no result/error yet
  if ('id' in msg && msg.method) return 'request';
  return 'unknown';
}

// ─── Error mapping ────────────────────────────────────────────────────────────

/**
 * Map a JSON-RPC error response object to one of our standard error categories.
 *
 * Categories: auth_failed, rate_limited, not_installed, network, crash,
 *             timeout, context_exceeded, unknown
 *
 * @param {Object|null|undefined} errorObj - The JSON-RPC error object `{ code, message, data? }`
 * @returns {string} Error category string
 */
export function mapGeminiAcpError(errorObj) {
  if (!errorObj) return 'unknown';

  const code = typeof errorObj.code === 'number' ? errorObj.code : 0;
  const message = String(errorObj.message || '');
  const data = errorObj.data;

  // Check structured data field first (may carry a specific error type)
  if (data) {
    const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
    const fromData = _heuristicCategory(dataStr);
    if (fromData !== 'unknown') return fromData;
  }

  // Heuristic match on message text takes priority over generic JSON-RPC code mapping
  // so that specific categories (auth_failed, rate_limited, etc.) are not swallowed
  // by generic codes like -32603 (internal error).
  const fromMessage = _heuristicCategory(message);
  if (fromMessage !== 'unknown') return fromMessage;

  // Application-level codes (Gemini ACP uses HTTP-mapped codes)
  if (code === 401 || code === 403) return 'auth_failed';
  if (code === 429) return 'rate_limited';
  if (code === 400) return 'crash';
  if (code === 500 || code === 503) return 'crash';

  // JSON-RPC standard codes (fall-through: message heuristic already checked above)
  if (code === -32600 || code === -32601 || code === -32602) return 'crash'; // invalid request/method/params
  if (code === -32603) return 'crash'; // internal error

  return 'unknown';
}

/**
 * Heuristic error classification from free-text message.
 * Mirrors the pattern from codex-appserver.mjs / codex-exec.mjs.
 *
 * @param {string|null|undefined} text
 * @returns {string}
 */
function _heuristicCategory(text) {
  if (!text) return 'unknown';
  const s = String(text);
  if (/authentication|unauthorized|invalid.*api.*key|API key/i.test(s)) return 'auth_failed';
  if (/rate.?limit|429|quota.*exceeded|too many requests/i.test(s)) return 'rate_limited';
  if (/command not found|ENOENT|gemini:.*not found/i.test(s)) return 'not_installed';
  if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|network error/i.test(s)) return 'network';
  if (/fatal error|unhandled exception|panic:|SIGSEGV|SIGABRT|segmentation fault/i.test(s)) return 'crash';
  if (/timeout|timed?\s*out|did not complete within/i.test(s)) return 'timeout';
  if (/context.*window.*exceeded|context.*length|too many tokens/i.test(s)) return 'context_exceeded';
  return 'unknown';
}

// ─── GeminiAcpHandle ──────────────────────────────────────────────────────────

/**
 * @typedef {Object} GeminiAcpHandle
 * @property {number} pid - Process ID of the gemini --acp server
 * @property {import('child_process').ChildProcess} process - The child process
 * @property {EventEmitter} events - Event emitter for notifications
 * @property {string|null} _sessionId - Current ACP session ID
 * @property {string} status - 'starting' | 'ready' | 'running' | 'completed' | 'failed'
 * @property {string} _partial - Partial line buffer for JSONL parsing
 * @property {Map<number, Object>} _pending - Pending RPC response handlers keyed by request id
 * @property {Object[]} _items - Accumulated items from the current prompt turn
 * @property {string} _output - Aggregated text output from the current turn
 * @property {Object|null} _turnError - Error captured from a failed prompt turn
 * @property {number|null} _exitCode - Process exit code (null while running)
 * @property {string[]} _stderrChunks - Accumulated stderr (capped at MAX_STDERR_CHUNKS)
 * @property {boolean} _initialized - Whether the initialize handshake completed
 * @property {string} _adapterName - Always 'gemini-acp'
 * @property {Object[]} _messageQueue - Pending messages to deliver after current turn completes
 * @property {boolean} _draining - Whether the queue drain loop is active
 * @property {Object[]} _deadLetters - Messages that failed delivery after retry
 */

// ─── Server lifecycle ─────────────────────────────────────────────────────────

/**
 * Spawn the `gemini --acp` subprocess and return a handle for RPC communication.
 *
 * NOTE: The handle is NOT ready until initializeServer() completes the handshake.
 *
 * ACP stability note: the Gemini ACP interface has known reliability issues.
 * Callers should set aggressive timeouts on all operations and implement retry
 * logic at a higher level if needed.
 *
 * @param {Object} [opts]
 * @param {string} [opts.cwd] - Working directory for the child process
 * @param {Object} [opts.env] - Additional environment variables
 * @returns {GeminiAcpHandle}
 */
export function startServer(opts = {}) {
  const geminiPath = resolveBinary('gemini');
  const args = ['--acp'];

  const child = nodeSpawn(geminiPath, args, {
    cwd: opts.cwd || process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: buildEnhancedPath(),
      ...opts.env,
    },
    detached: true,
  });

  const emitter = new EventEmitter();

  /** @type {GeminiAcpHandle} */
  const handle = {
    pid: child.pid,
    process: child,
    events: emitter,
    _sessionId: null,
    status: 'starting',
    _partial: '',
    _pending: new Map(),
    _items: [],
    _output: '',
    _turnError: null,
    _exitCode: null,
    _stderrChunks: [],
    _initialized: false,
    _adapterName: 'gemini-acp',
    _messageQueue: [],
    _draining: false,
    _deadLetters: [],
  };

  // Parse stdout as JSONL — each newline-terminated line is a JSON-RPC message
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
          // Remap bare 'error' to 'gemini/error' to avoid EventEmitter collision
          const emitName = msg.method === 'error' ? NOTIFY.ERROR : msg.method;
          emitter.emit(emitName, msg.params || msg);
        }
      } else if (kind === 'request') {
        // Server-initiated request (e.g. approval prompt).
        // Auto-respond with an empty result — we rely on session mode for permissions.
        try {
          const resp = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} });
          handle.process.stdin.write(resp + '\n');
        } catch {
          // stdin may be closed during shutdown — ignore
        }
      }
      // 'unknown' lines are silently dropped
    }
  });

  // Cap stderr accumulation to prevent unbounded memory growth
  child.stderr.on('data', (chunk) => {
    if (handle._stderrChunks.length < MAX_STDERR_CHUNKS) {
      handle._stderrChunks.push(chunk.toString());
    }
  });

  // Register exit handler BEFORE sending any signals to avoid missing early exits
  child.on('exit', (code) => {
    handle._exitCode = code;
    if (handle.status === 'starting' || handle.status === 'ready' || handle.status === 'running') {
      handle.status = 'failed';
    }
    _flushPartial(handle);
    // Reject all pending promises so callers don't hang
    for (const [id, handler] of handle._pending) {
      handler.resolve({
        jsonrpc: '2.0',
        id,
        error: { code: -1, message: 'Server process exited' },
      });
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
 * Process a JSON-RPC notification and mutate handle state accordingly.
 *
 * Accepts both camelCase (Gemini ACP canonical) and slash-separated (Codex-style)
 * notification names for defensive compatibility.
 *
 * @param {GeminiAcpHandle} handle
 * @param {Object} notification
 */
function _processNotification(handle, notification) {
  const method = notification.method || '';
  const params = notification.params || {};

  switch (method) {
    case NOTIFY.SESSION_STARTED:
    case 'session/started': {
      // Server may echo back the sessionId in the notification
      const sid = params.sessionId || params.session?.id;
      if (sid) handle._sessionId = sid;
      break;
    }

    case NOTIFY.PROMPT_STARTED:
    case 'prompt/started':
    case 'turn/started': {
      handle.status = 'running';
      handle._items = [];
      handle._output = '';
      handle._turnError = null;
      break;
    }

    case NOTIFY.ITEM_STARTED:
    case 'item/started': {
      if (params.item) {
        handle._items.push({ ...params.item, _phase: 'started' });
      }
      break;
    }

    case NOTIFY.ITEM_COMPLETED:
    case 'item/completed': {
      const item = params.item;
      if (!item) break;

      const idx = handle._items.findIndex(i => i.id === item.id);
      if (idx >= 0) {
        handle._items[idx] = { ...item, _phase: 'completed' };
      } else {
        handle._items.push({ ...item, _phase: 'completed' });
      }

      // Accumulate text output from assistant messages
      if (item.type === 'agentMessage' && item.text) {
        handle._output += item.text + '\n';
      } else if (item.type === 'commandExecution' && item.aggregatedOutput) {
        handle._output += item.aggregatedOutput;
      }
      break;
    }

    case NOTIFY.PROMPT_COMPLETED:
    case 'prompt/completed':
    case 'turn/completed': {
      const statusObj = params.status;
      const promptStatus = (typeof statusObj === 'object' && statusObj !== null)
        ? statusObj.type
        : (statusObj || 'completed');

      if (promptStatus === 'completed' || promptStatus === 'done') {
        handle.status = 'completed';
      } else if (promptStatus === 'interrupted' || promptStatus === 'cancelled') {
        handle.status = 'completed';
      } else if (promptStatus === 'failed' || promptStatus === 'error') {
        handle.status = 'failed';
        handle._turnError = params.error || null;
      } else {
        // Unknown status — treat as completed to avoid hanging callers
        handle.status = 'completed';
      }
      // Auto-drain message queue when turn completes (non-blocking)
      if (handle.status === 'completed' && handle._messageQueue?.length > 0 && !handle._draining) {
        _drainQueue(handle).catch(() => {});
      }
      break;
    }

    case 'error': {
      // Wire method name is bare 'error' — emitted as 'gemini/error' to avoid
      // colliding with EventEmitter's reserved 'error' event
      if (!params.willRetry) {
        handle._turnError = params.error || { message: 'Unknown ACP error' };
      }
      break;
    }

    // All other notifications (e.g. tokenUsage, statusChanged) are emitted
    // via the EventEmitter above but do not mutate handle state here.
  }
}

/**
 * Flush any remaining partial line buffer when the process exits.
 * This handles the case where the server sends a final message without a trailing newline.
 *
 * @param {GeminiAcpHandle} handle
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
 * Send a JSON-RPC request to the server and await the matching response.
 *
 * Uses an aggressive timeout by default — ACP has stability issues and callers
 * should not block indefinitely on unresponsive server processes.
 *
 * @param {GeminiAcpHandle} handle
 * @param {string} method - JSON-RPC method name
 * @param {Object} [params] - Method parameters
 * @param {number} [timeoutMs=30000] - Request timeout in milliseconds
 * @returns {Promise<Object>} JSON-RPC response (has result or error)
 */
export function sendRequest(handle, method, params, timeoutMs = RPC_TIMEOUT_MS) {
  return new Promise((resolve) => {
    // Fast-fail if the server is not running
    if (handle.status === 'failed' || handle._exitCode !== null) {
      resolve({ jsonrpc: '2.0', id: -1, error: { code: -1, message: 'Server not running' } });
      return;
    }

    const req = createRpcRequest(method, params);

    const timer = setTimeout(() => {
      handle._pending.delete(req.id);
      resolve({
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -2, message: `Request timed out after ${timeoutMs}ms` },
      });
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
      resolve({
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -3, message: `Write failed: ${err.message}` },
      });
    }
  });
}

// ─── Session lifecycle ────────────────────────────────────────────────────────

/**
 * Perform the required `initialize` handshake.
 * Must be called after startServer() and before any other method.
 *
 * Uses a 10-second timeout (longer than Codex) to account for ACP startup latency.
 *
 * @param {GeminiAcpHandle} handle
 * @param {Object} [clientInfo] - Override client info (primarily for testing)
 * @returns {Promise<{ serverInfo?: Object, error?: Object }>}
 */
export async function initializeServer(handle, clientInfo) {
  const response = await sendRequest(
    handle,
    'initialize',
    {
      clientInfo: clientInfo || CLIENT_INFO,
      protocolVersion: PROTOCOL_VERSION,
    },
    INIT_TIMEOUT_MS,
  );

  if (response.error) {
    return { error: response.error };
  }

  handle._initialized = true;
  handle.status = 'ready';
  return { serverInfo: response.result || {} };
}

/**
 * Create a new ACP session.
 *
 * Wire: `newSession` → `result.sessionId`
 *
 * Optionally sets the approval mode and model immediately after session creation.
 *
 * @param {GeminiAcpHandle} handle
 * @param {Object} [opts]
 * @param {string} [opts.cwd] - Working directory for the session
 * @param {string} [opts.approvalMode] - Approval mode: 'default' | 'auto_edit' | 'yolo' | 'plan'
 * @param {string} [opts.model] - Model identifier override
 * @returns {Promise<{ sessionId?: string, error?: Object }>}
 */
export async function createSession(handle, opts = {}) {
  if (!handle._initialized) {
    return { error: { code: -10, message: 'Server not initialized. Call initializeServer() first.' } };
  }

  const params = {};
  if (opts.cwd) params.workingDirectory = opts.cwd;

  const response = await sendRequest(handle, 'newSession', params);

  if (response.error) {
    return { error: response.error };
  }

  const sessionId = response.result?.sessionId;
  if (sessionId) handle._sessionId = sessionId;

  // Optionally configure approval mode and model right after session creation
  if (sessionId && opts.approvalMode) {
    // Fire-and-forget — errors here are non-fatal
    sendRequest(handle, 'setSessionMode', { sessionId, mode: opts.approvalMode }).catch(() => {});
  }
  if (sessionId && opts.model) {
    sendRequest(handle, 'unstable_setSessionModel', { sessionId, model: opts.model }).catch(() => {});
  }

  return { sessionId };
}

/**
 * Resume an existing ACP session by ID.
 *
 * Wire: `loadSession` → `result.sessionId`
 *
 * @param {GeminiAcpHandle} handle
 * @param {string} sessionId - The session ID to resume
 * @returns {Promise<{ sessionId?: string, error?: Object }>}
 */
export async function loadSession(handle, sessionId) {
  if (!handle._initialized) {
    return { error: { code: -10, message: 'Server not initialized. Call initializeServer() first.' } };
  }

  const response = await sendRequest(handle, 'loadSession', { sessionId });

  if (response.error) {
    return { error: response.error };
  }

  const resumedId = response.result?.sessionId || sessionId;
  handle._sessionId = resumedId;
  return { sessionId: resumedId };
}

/**
 * Send a prompt to the active session and wait for the turn to complete.
 *
 * Wire: `prompt` → streams notifications → final result
 *
 * @param {GeminiAcpHandle} handle
 * @param {string} prompt - User input text
 * @param {Object} [opts]
 * @param {number} [opts.timeout=120000] - Turn timeout in milliseconds
 * @param {string} [opts.sessionId] - Override session ID (defaults to handle._sessionId)
 * @returns {Promise<GeminiAcpMonitorResult>}
 */
export async function sendPrompt(handle, prompt, opts = {}) {
  if (!handle._sessionId) {
    return {
      status: 'failed',
      output: '',
      items: [],
      error: { category: 'crash', message: 'No active session. Call createSession() first.' },
    };
  }

  const sessionId = opts.sessionId || handle._sessionId;
  const timeoutMs = opts.timeout || PROMPT_TIMEOUT_MS;

  // Reset turn state before sending
  handle._items = [];
  handle._output = '';
  handle._turnError = null;
  handle.status = 'running';

  const response = await sendRequest(handle, 'prompt', { sessionId, text: prompt }, timeoutMs);

  if (response.error) {
    handle.status = 'failed';
    handle._turnError = response.error;
    return {
      status: 'failed',
      output: '',
      items: [],
      error: {
        category: mapGeminiAcpError(response.error),
        message: response.error.message || 'Prompt failed',
      },
    };
  }

  // If the server returned a final result synchronously (no streaming),
  // extract output from the result payload
  if (response.result) {
    const syncOutput = response.result.text || response.result.output || handle._output;
    if (syncOutput && !handle._output) handle._output = syncOutput;
    if (handle.status === 'running') handle.status = 'completed';
  }

  return collectPromptResult(handle, timeoutMs);
}

/**
 * Abort the current in-flight prompt turn.
 *
 * Wire: `cancel` with `{ sessionId }`
 *
 * @param {GeminiAcpHandle} handle
 * @returns {Promise<{ error?: Object }>}
 */
export async function cancelPrompt(handle) {
  if (!handle._sessionId) {
    return { error: { code: -10, message: 'No active session to cancel.' } };
  }

  const response = await sendRequest(handle, 'cancel', { sessionId: handle._sessionId });
  return response.error ? { error: response.error } : {};
}

// ─── Monitoring ───────────────────────────────────────────────────────────────

/**
 * @typedef {Object} GeminiAcpMonitorResult
 * @property {string} status - 'running' | 'completed' | 'failed'
 * @property {string} output - Aggregated text output from the current turn
 * @property {Object[]} items - All items from the current turn
 * @property {string|null} sessionId - Current session ID
 * @property {Object} [error] - Error details if status is 'failed'
 */

/**
 * Return a snapshot of the current handle state. Non-destructive.
 *
 * @param {GeminiAcpHandle} handle
 * @returns {GeminiAcpMonitorResult}
 */
export function monitor(handle) {
  const result = {
    status: handle.status,
    output: handle._output,
    items: [...handle._items],
    sessionId: handle._sessionId,
  };

  if (handle.status === 'failed') {
    const stderr = handle._stderrChunks.join('');
    const turnErr = handle._turnError;
    const message = (turnErr && turnErr.message) || stderr || 'Gemini ACP process failed';
    const category = mapGeminiAcpError(turnErr || { message });

    result.error = {
      category,
      message,
      exitCode: handle._exitCode,
    };
  }

  return result;
}

/**
 * Wait for the current prompt turn to complete (or fail/timeout).
 *
 * Resolves when a `promptCompleted` notification arrives, the process exits,
 * or the timeout fires.
 *
 * @param {GeminiAcpHandle} handle
 * @param {number} [timeoutMs=120000]
 * @returns {Promise<GeminiAcpMonitorResult>}
 */
export function collectPromptResult(handle, timeoutMs = PROMPT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    // Already settled — return immediately
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
      handle._turnError = { message: `Prompt did not complete within ${timeoutMs}ms` };
      settle();
    }, timeoutMs);

    const onCompleted = () => {
      clearTimeout(timer);
      handle.events.removeListener('exit', onExit);
      settle();
    };

    const onExit = () => {
      clearTimeout(timer);
      handle.events.removeListener(NOTIFY.PROMPT_COMPLETED, onCompleted);
      settle();
    };

    // Listen on both camelCase and slash-separated names for defensive compatibility
    handle.events.once(NOTIFY.PROMPT_COMPLETED, onCompleted);
    handle.events.once('prompt/completed', onCompleted);
    handle.events.once('turn/completed', onCompleted);
    handle.events.once('exit', onExit);
  });
}

// ─── Message Queue (team communication) ──────────────────────────────────────

/**
 * Enqueue a message for delivery after the current turn completes.
 *
 * When a Gemini worker is executing a turn, other workers may need to send it
 * information (e.g., API schema from a Claude worker). Unlike Codex app-server
 * which supports `steerTurn()` for mid-turn injection, Gemini ACP only accepts
 * new prompts between turns.
 *
 * This function queues messages and automatically drains the queue when the
 * current turn finishes. Each queued message becomes a new turn with the
 * previous turn's context preserved (ACP session continuity).
 *
 * @param {GeminiAcpHandle} handle
 * @param {string} message - The message/context to deliver
 * @param {Object} [opts]
 * @param {string} [opts.from] - Source worker name (for context in the prompt)
 * @param {string} [opts.priority='normal'] - 'high' pushes to front of queue
 * @returns {{ queued: boolean, position: number, queueLength: number }}
 */
export function enqueueMessage(handle, message, opts = {}) {
  if (!handle || !message) return { queued: false, position: -1, queueLength: 0 };

  // Reject if queue is at capacity to prevent unbounded memory growth
  if (handle._messageQueue.length >= MAX_QUEUE_DEPTH) {
    return { queued: false, position: -1, queueLength: handle._messageQueue.length };
  }

  const entry = {
    text: message,
    from: opts.from || 'orchestrator',
    enqueuedAt: new Date().toISOString(),
  };

  let position;
  if (opts.priority === 'high') {
    handle._messageQueue.unshift(entry);
    position = 0;
  } else {
    position = handle._messageQueue.length; // will be at this index after push
    handle._messageQueue.push(entry);
  }

  // If the worker is idle (turn completed), start draining immediately
  if ((handle.status === 'completed' || handle.status === 'ready') && !handle._draining) {
    _drainQueue(handle).catch(() => {});
  }

  return { queued: true, position, queueLength: handle._messageQueue.length };
}

/**
 * Drain the message queue by sending each message as a new turn.
 * Waits for each turn to complete before sending the next.
 * Automatically triggered when a turn completes and the queue is non-empty.
 *
 * Failed messages are re-queued at the front (up to 1 retry per message).
 * Messages that fail twice are placed in `handle._deadLetters` for inspection.
 * If the server dies mid-drain, remaining messages stay in the queue (not consumed).
 *
 * @param {GeminiAcpHandle} handle
 * @returns {Promise<{ delivered: number, failed: number, deadLettered: number }>}
 */
export async function _drainQueue(handle) {
  if (handle._draining) return { delivered: 0, failed: 0, deadLettered: 0 };
  handle._draining = true;

  let delivered = 0;
  let failed = 0;
  let deadLettered = 0;

  // Ensure dead letter list exists
  if (!handle._deadLetters) handle._deadLetters = [];

  try {
    while (handle._messageQueue.length > 0) {
      // Don't drain if the server is dead — leave remaining messages in queue
      if (handle.status === 'failed' || handle._exitCode !== null) break;

      const entry = handle._messageQueue.shift();
      const prompt = entry.from !== 'orchestrator'
        ? `[Message from ${entry.from}]: ${entry.text}`
        : entry.text;

      let success = false;
      try {
        const result = await sendPrompt(handle, prompt);
        success = result.status !== 'failed';
      } catch {
        success = false;
      }

      if (success) {
        delivered++;
      } else {
        failed++;
        // Re-queue once; if already retried, move to dead letters
        if (!entry._retried) {
          entry._retried = true;
          handle._messageQueue.unshift(entry);
        } else {
          deadLettered++;
          if (handle._deadLetters.length < MAX_QUEUE_DEPTH) {
            handle._deadLetters.push(entry);
          }
        }
      }
    }
  } finally {
    handle._draining = false;
  }

  return { delivered, failed, deadLettered };
}

/**
 * Get the current message queue state.
 *
 * @param {GeminiAcpHandle} handle
 * @returns {{ length: number, draining: boolean, deadLetters: number, messages: Array<{ from: string, enqueuedAt: string, preview: string }> }}
 */
export function getQueueState(handle) {
  if (!handle) return { length: 0, draining: false, deadLetters: 0, messages: [] };
  return {
    length: handle._messageQueue.length,
    draining: handle._draining,
    deadLetters: (handle._deadLetters || []).length,
    messages: handle._messageQueue.map(e => ({
      from: e.from,
      enqueuedAt: e.enqueuedAt,
      preview: e.text.substring(0, 100),
    })),
  };
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────

/**
 * Gracefully shut down the gemini --acp server process.
 *
 * Registers the exit listener BEFORE sending SIGTERM to avoid a race where
 * an immediately-dying process fires 'exit' before the listener is attached.
 * Escalates to SIGKILL (on the process group) after graceMs milliseconds.
 *
 * All pending RPC promises are rejected during the exit handler above.
 *
 * @param {GeminiAcpHandle} handle
 * @param {number} [graceMs=5000]
 * @returns {Promise<void>}
 */
export function shutdownServer(handle, graceMs = SHUTDOWN_GRACE_MS) {
  if (!handle.process || handle.process.killed) return Promise.resolve();

  return new Promise((resolve) => {
    // Register exit listener FIRST to avoid missing an immediate exit
    const timer = setTimeout(() => {
      // Escalate: kill the entire detached process group
      try { process.kill(-handle.pid, 'SIGKILL'); } catch {}
      // Fallback: kill just the process
      try { handle.process.kill('SIGKILL'); } catch {}
      resolve();
    }, graceMs);

    handle.process.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });

    // Send termination signals AFTER listener is registered
    try { handle.process.stdin.end(); } catch {}
    try { handle.process.kill('SIGTERM'); } catch {}
  });
}

// ─── Notification subscription helper ────────────────────────────────────────

/**
 * Register a callback for a specific notification type.
 * Use the camelCase names defined in NOTIFY, or bare method name strings.
 *
 * @param {GeminiAcpHandle} handle
 * @param {string} method - Notification method name (e.g., 'itemCompleted', 'promptCompleted')
 * @param {Function} callback - Handler function
 * @returns {Function} Unsubscribe function
 */
export function onNotification(handle, method, callback) {
  handle.events.on(method, callback);
  return () => handle.events.removeListener(method, callback);
}

// Re-export for tests and downstream consumers
export { NOTIFY };
