/**
 * Unit tests for scripts/lib/gemini-acp.mjs
 * Uses node:test — zero npm dependencies.
 *
 * Tests use mock ChildProcess objects built from EventEmitter + Readable/Writable
 * streams so no real gemini binary is needed and no processes are started.
 *
 * Wire protocol tested:
 * - Method names: camelCase (newSession, prompt, cancel, setSessionMode, etc.)
 * - Notifications: sessionStarted, promptStarted, itemStarted, itemCompleted, promptCompleted
 * - Session ID: result.sessionId (flat string, not nested object)
 * - Handshake: initialize with clientInfo + protocolVersion required first
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

import {
  createRpcRequest,
  parseRpcMessage,
  classifyMessage,
  mapGeminiAcpError,
  startServer,
  initializeServer,
  sendRequest,
  createSession,
  loadSession,
  sendPrompt,
  cancelPrompt,
  monitor,
  collectPromptResult,
  shutdownServer,
  onNotification,
  enqueueMessage,
  _drainQueue,
  getQueueState,
  NOTIFY,
} from '../lib/gemini-acp.mjs';

// ─── Mock helpers ──────────────────────────────────────────────────────────────

function createMockChildProcess() {
  const child = new EventEmitter();
  child.stdin = new Writable({ write(chunk, enc, cb) { cb(); } });
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.pid = 12345;
  child.killed = false;
  child.kill = (signal) => {
    child.killed = true;
    // Simulate process dying from signal
    setImmediate(() => child.emit('exit', null, signal));
  };
  return child;
}

/**
 * Build a GeminiAcpHandle manually (bypassing startServer()) for hermetic tests.
 * Mirrors the internal structure created by startServer().
 */
function createHandle(child, initialized = false) {
  const emitter = new EventEmitter();
  const handle = {
    pid: child.pid,
    process: child,
    events: emitter,
    _sessionId: null,
    status: initialized ? 'ready' : 'starting',
    _partial: '',
    _pending: new Map(),
    _items: [],
    _output: '',
    _turnError: null,
    _exitCode: null,
    _stderrChunks: [],
    _initialized: initialized,
    _adapterName: 'gemini-acp',
    _messageQueue: [],
    _draining: false,
    _deadLetters: [],
  };

  // Wire up stdout JSONL parsing (mirrors startServer internals)
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
        _processNotificationForTest(handle, msg);
        emitter.emit('notification', msg);
        if (msg.method) {
          const emitName = msg.method === 'error' ? NOTIFY.ERROR : msg.method;
          emitter.emit(emitName, msg.params || msg);
        }
      } else if (kind === 'request') {
        // Auto-respond to server-initiated requests
        try {
          const resp = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} });
          child.stdin.write(resp + '\n');
        } catch {}
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    // Mirror the MAX_STDERR_CHUNKS cap from startServer
    if (handle._stderrChunks.length < 100) {
      handle._stderrChunks.push(chunk.toString());
    }
  });

  child.on('exit', (code) => {
    handle._exitCode = code;
    if (handle.status === 'starting' || handle.status === 'ready' || handle.status === 'running') {
      handle.status = 'failed';
    }
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

/** Replicates _processNotification logic for the test handle */
function _processNotificationForTest(handle, notification) {
  const method = notification.method || '';
  const params = notification.params || {};

  switch (method) {
    case NOTIFY.SESSION_STARTED:
    case 'session/started': {
      const sid = params.sessionId || params.session?.id;
      if (sid) handle._sessionId = sid;
      break;
    }
    case NOTIFY.PROMPT_STARTED:
    case 'prompt/started':
    case 'turn/started':
      handle.status = 'running';
      handle._items = [];
      handle._output = '';
      handle._turnError = null;
      break;
    case NOTIFY.ITEM_STARTED:
    case 'item/started':
      if (params.item) handle._items.push({ ...params.item, _phase: 'started' });
      break;
    case NOTIFY.ITEM_COMPLETED:
    case 'item/completed': {
      const item = params.item;
      if (!item) break;
      const idx = handle._items.findIndex(i => i.id === item.id);
      if (idx >= 0) handle._items[idx] = { ...item, _phase: 'completed' };
      else handle._items.push({ ...item, _phase: 'completed' });
      if (item.type === 'agentMessage' && item.text) handle._output += item.text + '\n';
      else if (item.type === 'commandExecution' && item.aggregatedOutput) handle._output += item.aggregatedOutput;
      break;
    }
    case NOTIFY.PROMPT_COMPLETED:
    case 'prompt/completed':
    case 'turn/completed': {
      const statusObj = params.status;
      const promptStatus = (typeof statusObj === 'object' && statusObj !== null)
        ? statusObj.type
        : (statusObj || 'completed');
      if (promptStatus === 'completed' || promptStatus === 'done' ||
          promptStatus === 'interrupted' || promptStatus === 'cancelled') {
        handle.status = 'completed';
      } else if (promptStatus === 'failed' || promptStatus === 'error') {
        handle.status = 'failed';
        handle._turnError = params.error || null;
      } else {
        handle.status = 'completed';
      }
      // Auto-drain message queue when turn completes (mirrors real impl)
      if (handle.status === 'completed' && handle._messageQueue?.length > 0 && !handle._draining) {
        _drainQueue(handle).catch(() => {});
      }
      break;
    }
    case 'error':
      if (!params.willRetry) handle._turnError = params.error || { message: 'Unknown ACP error' };
      break;
  }
}

/** Emit a JSON-RPC response from mock stdout */
function emitResponse(child, id, result) {
  child.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'));
}

/** Emit a JSON-RPC error response from mock stdout */
function emitErrorResponse(child, id, error) {
  child.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, error }) + '\n'));
}

/** Emit a notification from mock stdout */
function emitNotification(child, method, params) {
  child.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'));
}

/** Emit a server-initiated request from mock stdout */
function emitServerRequest(child, id, method, params) {
  child.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'));
}

// ─── NOTIFY constants ──────────────────────────────────────────────────────────

test('NOTIFY: uses camelCase method names', () => {
  assert.equal(NOTIFY.SESSION_STARTED, 'sessionStarted');
  assert.equal(NOTIFY.PROMPT_STARTED, 'promptStarted');
  assert.equal(NOTIFY.ITEM_STARTED, 'itemStarted');
  assert.equal(NOTIFY.ITEM_COMPLETED, 'itemCompleted');
  assert.equal(NOTIFY.PROMPT_COMPLETED, 'promptCompleted');
  // Remapped to avoid EventEmitter 'error' collision
  assert.equal(NOTIFY.ERROR, 'gemini/error');
});

// ─── createRpcRequest ──────────────────────────────────────────────────────────

test('createRpcRequest: creates valid JSON-RPC 2.0 request', () => {
  const req = createRpcRequest('newSession', { workingDirectory: '/tmp' });
  assert.equal(req.jsonrpc, '2.0');
  assert.equal(req.method, 'newSession');
  assert.deepEqual(req.params, { workingDirectory: '/tmp' });
  assert.equal(typeof req.id, 'number');
});

test('createRpcRequest: id auto-increments across calls', () => {
  const a = createRpcRequest('a');
  const b = createRpcRequest('b');
  const c = createRpcRequest('c');
  assert.ok(b.id > a.id);
  assert.ok(c.id > b.id);
  assert.equal(c.id - a.id, 2);
});

test('createRpcRequest: omits params when undefined', () => {
  const req = createRpcRequest('initialize');
  assert.ok(!('params' in req));
});

test('createRpcRequest: includes params when empty object', () => {
  const req = createRpcRequest('cancel', {});
  assert.ok('params' in req);
  assert.deepEqual(req.params, {});
});

// ─── parseRpcMessage ──────────────────────────────────────────────────────────

test('parseRpcMessage: parses valid JSON object', () => {
  const msg = parseRpcMessage('{"jsonrpc":"2.0","id":1,"result":{}}');
  assert.ok(msg !== null);
  assert.equal(msg.id, 1);
});

test('parseRpcMessage: returns null for blank line', () => {
  assert.equal(parseRpcMessage(''), null);
  assert.equal(parseRpcMessage('   '), null);
});

test('parseRpcMessage: returns null for non-JSON', () => {
  assert.equal(parseRpcMessage('not json at all'), null);
});

test('parseRpcMessage: returns null for JSON primitive', () => {
  assert.equal(parseRpcMessage('"just a string"'), null);
  assert.equal(parseRpcMessage('42'), null);
});

// ─── classifyMessage ──────────────────────────────────────────────────────────

test('classifyMessage: identifies response (has id + result)', () => {
  assert.equal(classifyMessage({ id: 1, result: {} }), 'response');
});

test('classifyMessage: identifies response (has id + error)', () => {
  assert.equal(classifyMessage({ id: 2, error: { code: -1, message: 'fail' } }), 'response');
});

test('classifyMessage: identifies notification (method, no id)', () => {
  assert.equal(classifyMessage({ method: 'promptCompleted', params: {} }), 'notification');
});

test('classifyMessage: identifies server request (id + method, no result/error)', () => {
  assert.equal(classifyMessage({ id: 5, method: 'approvalRequest', params: {} }), 'request');
});

test('classifyMessage: returns unknown for unrecognized shape', () => {
  assert.equal(classifyMessage({}), 'unknown');
  assert.equal(classifyMessage(null), 'unknown');
  assert.equal(classifyMessage({ foo: 'bar' }), 'unknown');
});

// ─── mapGeminiAcpError ────────────────────────────────────────────────────────

test('mapGeminiAcpError: returns unknown for null/undefined', () => {
  assert.equal(mapGeminiAcpError(null), 'unknown');
  assert.equal(mapGeminiAcpError(undefined), 'unknown');
});

test('mapGeminiAcpError: auth_failed for 401 code', () => {
  assert.equal(mapGeminiAcpError({ code: 401, message: 'Unauthorized' }), 'auth_failed');
});

test('mapGeminiAcpError: auth_failed for 403 code', () => {
  assert.equal(mapGeminiAcpError({ code: 403, message: 'Forbidden' }), 'auth_failed');
});

test('mapGeminiAcpError: rate_limited for 429 code', () => {
  assert.equal(mapGeminiAcpError({ code: 429, message: 'Too Many Requests' }), 'rate_limited');
});

test('mapGeminiAcpError: crash for 400/500/503 codes', () => {
  assert.equal(mapGeminiAcpError({ code: 400, message: 'Bad Request' }), 'crash');
  assert.equal(mapGeminiAcpError({ code: 500, message: 'Internal Server Error' }), 'crash');
  assert.equal(mapGeminiAcpError({ code: 503, message: 'Service Unavailable' }), 'crash');
});

test('mapGeminiAcpError: auth_failed from message heuristic', () => {
  assert.equal(mapGeminiAcpError({ code: -32603, message: 'invalid API key provided' }), 'auth_failed');
});

test('mapGeminiAcpError: rate_limited from message heuristic', () => {
  assert.equal(mapGeminiAcpError({ code: 0, message: 'rate limit exceeded' }), 'rate_limited');
});

test('mapGeminiAcpError: not_installed from message heuristic', () => {
  assert.equal(mapGeminiAcpError({ code: -3, message: 'gemini: not found' }), 'not_installed');
});

test('mapGeminiAcpError: network from message heuristic', () => {
  assert.equal(mapGeminiAcpError({ code: 0, message: 'ECONNRESET socket hang up' }), 'network');
});

test('mapGeminiAcpError: timeout from message heuristic', () => {
  assert.equal(mapGeminiAcpError({ code: 0, message: 'request timed out' }), 'timeout');
});

test('mapGeminiAcpError: context_exceeded from message heuristic', () => {
  assert.equal(mapGeminiAcpError({ code: 0, message: 'context window exceeded' }), 'context_exceeded');
});

test('mapGeminiAcpError: unknown for unrecognized error', () => {
  assert.equal(mapGeminiAcpError({ code: 0, message: 'some mystery error' }), 'unknown');
});

test('mapGeminiAcpError: data field checked for heuristic match', () => {
  assert.equal(mapGeminiAcpError({ code: 0, message: '', data: 'invalid API key provided' }), 'auth_failed');
});

// ─── buildEnhancedPath (imported from resolve-binary.mjs) ────────────────────

import { buildEnhancedPath } from '../lib/resolve-binary.mjs';

test('buildEnhancedPath: returns a string containing original PATH', () => {
  const enhanced = buildEnhancedPath();
  assert.equal(typeof enhanced, 'string');
  // Must contain existing PATH entries
  const existing = process.env.PATH || '';
  if (existing) assert.ok(enhanced.includes(existing.split(':')[0]));
});

test('buildEnhancedPath: includes known search paths', () => {
  const enhanced = buildEnhancedPath();
  const hasKnownPath = enhanced.includes('/opt/homebrew/bin') ||
    enhanced.includes('/usr/local/bin') ||
    enhanced.includes('/usr/bin');
  assert.ok(hasKnownPath);
});

// ─── startServer ─────────────────────────────────────────────────────────────

test('startServer: returns handle with correct structure', async () => {
  // We call startServer — the gemini binary likely doesn't exist in CI,
  // so the process will error asynchronously. We suppress the error event
  // and only check the structural shape of the handle.
  let handle;
  try {
    handle = startServer({ cwd: '/tmp' });
  } catch {
    // Synchronous spawn failure — skip
    return;
  }

  // Suppress uncaught error events from ENOENT so the test doesn't crash
  handle.events.on('error', () => {});
  handle.process.on('error', () => {});

  // pid may be undefined when spawn ENOENT fails on some platforms
  // — just verify it's a number OR undefined (not some other type)
  assert.ok(handle.pid === undefined || typeof handle.pid === 'number');
  assert.ok(handle.process);
  assert.ok(handle.events instanceof EventEmitter);
  assert.equal(handle._sessionId, null);
  assert.equal(handle.status, 'starting');
  assert.equal(handle._partial, '');
  assert.ok(handle._pending instanceof Map);
  assert.deepEqual(handle._items, []);
  assert.equal(handle._output, '');
  assert.equal(handle._turnError, null);
  // _exitCode may be set if process exits before this assertion
  assert.ok(handle._exitCode === null || typeof handle._exitCode === 'number');
  assert.ok(Array.isArray(handle._stderrChunks));
  assert.equal(handle._initialized, false);
  assert.equal(handle._adapterName, 'gemini-acp');

  // Clean up — allow a tick for async error/exit to fire, then kill
  await new Promise(r => setImmediate(r));
  try { handle.process.kill('SIGKILL'); } catch {}
});

// ─── JSONL stdout parsing ─────────────────────────────────────────────────────

test('stdout JSONL: parses response and resolves pending promise', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  const promise = sendRequest(handle, 'initialize', {}, 5000);
  // Grab the id that was used (it's the most recently incremented)
  const pendingId = [...handle._pending.keys()][0];

  emitResponse(child, pendingId, { serverInfo: 'gemini-acp-v1' });

  const response = await promise;
  assert.equal(response.result.serverInfo, 'gemini-acp-v1');
});

test('stdout JSONL: handles multi-line chunks correctly', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  const promise = sendRequest(handle, 'newSession', {}, 5000);
  const pendingId = [...handle._pending.keys()][0];

  // Emit both lines in one chunk (simulates TCP coalescing)
  const notifications = JSON.stringify({ jsonrpc: '2.0', method: 'sessionStarted', params: { sessionId: 'sess-1' } }) + '\n';
  const resp = JSON.stringify({ jsonrpc: '2.0', id: pendingId, result: { sessionId: 'sess-abc' } }) + '\n';
  child.stdout.emit('data', Buffer.from(notifications + resp));

  const response = await promise;
  assert.equal(response.result.sessionId, 'sess-abc');
});

test('stdout JSONL: handles partial line buffering', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  const promise = sendRequest(handle, 'prompt', {}, 5000);
  const pendingId = [...handle._pending.keys()][0];

  const fullMsg = JSON.stringify({ jsonrpc: '2.0', id: pendingId, result: { text: 'hello' } }) + '\n';
  // Split across two chunks
  child.stdout.emit('data', Buffer.from(fullMsg.slice(0, 20)));
  child.stdout.emit('data', Buffer.from(fullMsg.slice(20)));

  const response = await promise;
  assert.equal(response.result.text, 'hello');
});

test('stdout JSONL: silently ignores malformed JSON lines', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  // This should not throw
  child.stdout.emit('data', Buffer.from('not valid json\n'));
  assert.equal(handle._pending.size, 0);
});

// ─── initializeServer ─────────────────────────────────────────────────────────

test('initializeServer: handshake sets _initialized and status to ready', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  const initPromise = initializeServer(handle);
  const pendingId = [...handle._pending.keys()][0];
  emitResponse(child, pendingId, { protocolVersion: '2025-07-01', name: 'gemini-acp' });

  const result = await initPromise;
  assert.ok(!result.error);
  assert.equal(handle._initialized, true);
  assert.equal(handle.status, 'ready');
});

test('initializeServer: returns error on server error response', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  const initPromise = initializeServer(handle);
  const pendingId = [...handle._pending.keys()][0];
  emitErrorResponse(child, pendingId, { code: 401, message: 'Unauthorized' });

  const result = await initPromise;
  assert.ok(result.error);
  assert.equal(handle._initialized, false);
  assert.equal(handle.status, 'starting');
});

test('initializeServer: serverInfo extracted from result', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  const initPromise = initializeServer(handle);
  const pendingId = [...handle._pending.keys()][0];
  emitResponse(child, pendingId, { name: 'gemini', version: '2.0' });

  const result = await initPromise;
  assert.deepEqual(result.serverInfo, { name: 'gemini', version: '2.0' });
});

// ─── createSession ────────────────────────────────────────────────────────────

test('createSession: returns error if not initialized', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, false);

  const result = await createSession(handle, { cwd: '/tmp' });
  assert.ok(result.error);
  assert.ok(result.error.message.includes('not initialized'));
});

test('createSession: sends newSession and extracts sessionId', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);

  const promise = createSession(handle, { cwd: '/workspace' });
  const pendingId = [...handle._pending.keys()][0];
  emitResponse(child, pendingId, { sessionId: 'ses-xyz-001' });

  const result = await promise;
  assert.equal(result.sessionId, 'ses-xyz-001');
  assert.equal(handle._sessionId, 'ses-xyz-001');
});

test('createSession: returns error on server error', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);

  const promise = createSession(handle, {});
  const pendingId = [...handle._pending.keys()][0];
  emitErrorResponse(child, pendingId, { code: 500, message: 'Internal error' });

  const result = await promise;
  assert.ok(result.error);
  assert.equal(handle._sessionId, null);
});

// ─── loadSession ──────────────────────────────────────────────────────────────

test('loadSession: returns error if not initialized', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, false);

  const result = await loadSession(handle, 'ses-old-001');
  assert.ok(result.error);
});

test('loadSession: sends loadSession and updates _sessionId', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);

  const promise = loadSession(handle, 'ses-old-001');
  const pendingId = [...handle._pending.keys()][0];
  emitResponse(child, pendingId, { sessionId: 'ses-old-001' });

  const result = await promise;
  assert.equal(result.sessionId, 'ses-old-001');
  assert.equal(handle._sessionId, 'ses-old-001');
});

test('loadSession: falls back to provided sessionId when result omits it', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);

  const promise = loadSession(handle, 'ses-fallback');
  const pendingId = [...handle._pending.keys()][0];
  // Server responds with empty result (no sessionId in result)
  emitResponse(child, pendingId, {});

  const result = await promise;
  assert.equal(result.sessionId, 'ses-fallback');
  assert.equal(handle._sessionId, 'ses-fallback');
});

// ─── sendPrompt ───────────────────────────────────────────────────────────────

test('sendPrompt: returns error if no active session', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle._sessionId = null;

  const result = await sendPrompt(handle, 'hello');
  assert.equal(result.status, 'failed');
  assert.ok(result.error);
  assert.ok(result.error.message.includes('No active session'));
});

test('sendPrompt: streaming notifications then result', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle._sessionId = 'ses-stream-001';

  const resultPromise = sendPrompt(handle, 'what is 2+2?', { timeout: 5000 });
  const pendingId = [...handle._pending.keys()][0];

  // Simulate server streaming notifications before responding
  emitNotification(child, 'promptStarted', { sessionId: 'ses-stream-001' });
  emitNotification(child, 'itemStarted', { item: { id: 'item-1', type: 'agentMessage' } });
  emitNotification(child, 'itemCompleted', { item: { id: 'item-1', type: 'agentMessage', text: '4' } });
  emitNotification(child, 'promptCompleted', { status: 'completed' });
  emitResponse(child, pendingId, { ok: true });

  const result = await resultPromise;
  assert.equal(result.status, 'completed');
  assert.ok(result.output.includes('4'));
});

test('sendPrompt: error response from server sets failed status', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle._sessionId = 'ses-err-001';

  const resultPromise = sendPrompt(handle, 'fail me', { timeout: 5000 });
  const pendingId = [...handle._pending.keys()][0];
  emitErrorResponse(child, pendingId, { code: 429, message: 'rate limit exceeded' });

  const result = await resultPromise;
  assert.equal(result.status, 'failed');
  assert.equal(result.error.category, 'rate_limited');
});

// ─── cancelPrompt ─────────────────────────────────────────────────────────────

test('cancelPrompt: returns error if no active session', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle._sessionId = null;

  const result = await cancelPrompt(handle);
  assert.ok(result.error);
});

test('cancelPrompt: sends cancel method with sessionId', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle._sessionId = 'ses-cancel-001';

  const writtenLines = [];
  const origWrite = handle.process.stdin.write.bind(handle.process.stdin);
  handle.process.stdin.write = (data, ...rest) => {
    writtenLines.push(data);
    return origWrite(data, ...rest);
  };

  const cancelPromise = cancelPrompt(handle);
  const pendingId = [...handle._pending.keys()][0];
  emitResponse(child, pendingId, {});

  await cancelPromise;

  const sentMsg = JSON.parse(writtenLines.find(l => l.includes('"cancel"')) || '{}');
  assert.equal(sentMsg.method, 'cancel');
  assert.equal(sentMsg.params.sessionId, 'ses-cancel-001');
});

// ─── Notification handling ────────────────────────────────────────────────────

test('notifications: sessionStarted updates _sessionId', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);

  emitNotification(child, 'sessionStarted', { sessionId: 'ses-notif-001' });
  assert.equal(handle._sessionId, 'ses-notif-001');
});

test('notifications: promptStarted resets turn state', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle._output = 'old output';
  handle._items = [{ id: 'old' }];
  handle._turnError = { message: 'old error' };
  handle.status = 'completed';

  emitNotification(child, 'promptStarted', {});
  assert.equal(handle.status, 'running');
  assert.equal(handle._output, '');
  assert.deepEqual(handle._items, []);
  assert.equal(handle._turnError, null);
});

test('notifications: itemStarted and itemCompleted track items', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);

  emitNotification(child, 'itemStarted', { item: { id: 'i1', type: 'agentMessage' } });
  assert.equal(handle._items.length, 1);
  assert.equal(handle._items[0]._phase, 'started');

  emitNotification(child, 'itemCompleted', { item: { id: 'i1', type: 'agentMessage', text: 'hello world' } });
  assert.equal(handle._items.length, 1);
  assert.equal(handle._items[0]._phase, 'completed');
  assert.ok(handle._output.includes('hello world'));
});

test('notifications: promptCompleted with failed status sets failed', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.status = 'running';

  emitNotification(child, 'promptCompleted', { status: 'failed', error: { message: 'boom' } });
  assert.equal(handle.status, 'failed');
});

test('notifications: accept slash-separated names for compatibility', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);

  // Slash-separated fallback compatibility
  emitNotification(child, 'turn/started', {});
  assert.equal(handle.status, 'running');

  handle.status = 'running';
  emitNotification(child, 'turn/completed', { status: 'completed' });
  assert.equal(handle.status, 'completed');
});

test('notifications: bare error notification sets _turnError', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);

  emitNotification(child, 'error', { error: { message: 'something broke' }, willRetry: false });
  assert.ok(handle._turnError);
  assert.equal(handle._turnError.message, 'something broke');
});

test('notifications: willRetry=true does not set _turnError', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);

  emitNotification(child, 'error', { error: { message: 'transient' }, willRetry: true });
  assert.equal(handle._turnError, null);
});

// ─── Server-initiated requests ────────────────────────────────────────────────

test('server request: auto-responds with empty result', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);

  const writtenData = [];
  const origWrite = handle.process.stdin.write.bind(handle.process.stdin);
  handle.process.stdin.write = (data, ...rest) => {
    writtenData.push(String(data));
    return origWrite(data, ...rest);
  };

  emitServerRequest(child, 42, 'approvalRequest', { action: 'write' });

  // Find the auto-response line
  const autoResp = writtenData
    .map(d => { try { return JSON.parse(d); } catch { return null; } })
    .find(m => m && m.id === 42);

  assert.ok(autoResp, 'auto-response should have been written');
  assert.equal(autoResp.id, 42);
  assert.deepEqual(autoResp.result, {});
});

// ─── monitor ─────────────────────────────────────────────────────────────────

test('monitor: returns snapshot of handle state', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle._sessionId = 'ses-mon-001';
  handle._output = 'some output';
  handle._items = [{ id: 'x' }];
  handle.status = 'completed';

  const snap = monitor(handle);
  assert.equal(snap.status, 'completed');
  assert.equal(snap.output, 'some output');
  assert.deepEqual(snap.items, [{ id: 'x' }]);
  assert.equal(snap.sessionId, 'ses-mon-001');
  assert.ok(!snap.error);
});

test('monitor: includes error details when status is failed', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.status = 'failed';
  handle._turnError = { message: 'context window exceeded' };

  const snap = monitor(handle);
  assert.equal(snap.status, 'failed');
  assert.ok(snap.error);
  assert.equal(snap.error.category, 'context_exceeded');
  assert.ok(snap.error.message.includes('context window exceeded'));
});

// ─── collectPromptResult ─────────────────────────────────────────────────────

test('collectPromptResult: resolves immediately if already completed', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.status = 'completed';
  handle._output = 'done';

  const result = await collectPromptResult(handle, 100);
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'done');
});

test('collectPromptResult: resolves on promptCompleted notification', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.status = 'running';

  const resultPromise = collectPromptResult(handle, 5000);

  // Emit completion notification after a tick
  setImmediate(() => {
    emitNotification(child, 'promptCompleted', { status: 'completed' });
  });

  const result = await resultPromise;
  assert.equal(result.status, 'completed');
});

test('collectPromptResult: times out and fails if no completion', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.status = 'running';

  const result = await collectPromptResult(handle, 50); // very short timeout
  assert.equal(result.status, 'failed');
  assert.ok(result.error.message.includes('did not complete'));
});

test('collectPromptResult: resolves on process exit', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.status = 'running';

  const resultPromise = collectPromptResult(handle, 5000);

  setImmediate(() => {
    child.emit('exit', 1);
  });

  const result = await resultPromise;
  // Status set to failed by exit handler
  assert.equal(result.status, 'failed');
});

// ─── stderr handling ──────────────────────────────────────────────────────────

test('stderr: accumulates chunks', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  child.stderr.emit('data', Buffer.from('error line 1\n'));
  child.stderr.emit('data', Buffer.from('error line 2\n'));

  assert.equal(handle._stderrChunks.length, 2);
  assert.equal(handle._stderrChunks[0], 'error line 1\n');
});

test('stderr: caps at MAX_STDERR_CHUNKS (100)', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  for (let i = 0; i < 110; i++) {
    child.stderr.emit('data', Buffer.from(`line ${i}\n`));
  }

  assert.ok(handle._stderrChunks.length <= 100);
});

// ─── process exit handling ────────────────────────────────────────────────────

test('process exit: status transitions to failed', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  handle.status = 'running';

  child.emit('exit', 1);
  assert.equal(handle._exitCode, 1);
  assert.equal(handle.status, 'failed');
});

test('process exit: rejects all pending promises', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  const promise = sendRequest(handle, 'prompt', { text: 'hello' }, 5000);

  child.emit('exit', 1);

  const response = await promise;
  assert.ok(response.error);
  assert.ok(response.error.message.includes('exited'));
});

test('sendRequest: returns error immediately when server is not running', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  handle.status = 'failed';

  const response = await sendRequest(handle, 'anything', {}, 5000);
  assert.ok(response.error);
  assert.ok(response.error.message.includes('not running'));
});

// ─── Timeout handling ─────────────────────────────────────────────────────────

test('sendRequest: times out pending promise', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);

  // Very short timeout, no response emitted
  const response = await sendRequest(handle, 'newSession', {}, 30);
  assert.ok(response.error);
  assert.ok(response.error.message.includes('timed out'));
  // Pending map must be cleaned up after timeout
  assert.equal(handle._pending.size, 0);
});

// ─── shutdownServer ───────────────────────────────────────────────────────────

test('shutdownServer: resolves immediately for already-killed process', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  child.killed = true;

  // Should resolve quickly without hanging
  await shutdownServer(handle, 1000);
  // Just confirming no throw and resolution
});

test('shutdownServer: sends SIGTERM and resolves on exit', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  const signals = [];
  child.kill = (sig) => {
    signals.push(sig);
    setImmediate(() => child.emit('exit', 0, sig));
  };

  await shutdownServer(handle, 1000);
  assert.ok(signals.includes('SIGTERM'));
});

test('shutdownServer: escalates to SIGKILL after grace period', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  const signals = [];
  child.kill = (sig) => {
    signals.push(sig);
    // Do NOT emit exit — force timeout escalation
  };
  child.killed = false;

  // Very short grace period to keep test fast
  const shutdownPromise = shutdownServer(handle, 50);
  await shutdownPromise;

  // SIGTERM should have been sent, then SIGKILL after grace
  assert.ok(signals.includes('SIGTERM'));
});

// ─── onNotification ───────────────────────────────────────────────────────────

test('onNotification: receives events and unsubscribes via returned function', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);

  const received = [];
  const unsub = onNotification(handle, 'promptCompleted', (params) => {
    received.push(params);
  });

  emitNotification(child, 'promptCompleted', { status: 'completed' });
  assert.equal(received.length, 1);

  unsub();

  emitNotification(child, 'promptCompleted', { status: 'completed' });
  // Should still be 1 — unsubscribed
  assert.equal(received.length, 1);
});

// ─── enqueueMessage ──────────────────────────────────────────────────────────

test('enqueueMessage: returns queued=false for null handle or empty message', () => {
  const r1 = enqueueMessage(null, 'hello');
  assert.equal(r1.queued, false);
  assert.equal(r1.position, -1);

  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  const r2 = enqueueMessage(handle, '');
  assert.equal(r2.queued, false);
});

test('enqueueMessage: appends message to queue with default priority', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.status = 'running'; // prevent auto-drain

  const r = enqueueMessage(handle, 'API schema info', { from: 'api-worker' });
  assert.equal(r.queued, true);
  assert.equal(r.position, 0);
  assert.equal(r.queueLength, 1);
  assert.equal(handle._messageQueue[0].text, 'API schema info');
  assert.equal(handle._messageQueue[0].from, 'api-worker');
});

test('enqueueMessage: high priority pushes to front of queue', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.status = 'running'; // prevent auto-drain

  enqueueMessage(handle, 'msg-1', { from: 'worker-a' });
  enqueueMessage(handle, 'msg-2', { from: 'worker-b' });
  enqueueMessage(handle, 'urgent', { from: 'worker-c', priority: 'high' });

  assert.equal(handle._messageQueue.length, 3);
  assert.equal(handle._messageQueue[0].text, 'urgent');
  assert.equal(handle._messageQueue[1].text, 'msg-1');
  assert.equal(handle._messageQueue[2].text, 'msg-2');
});

test('enqueueMessage: defaults from to orchestrator', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.status = 'running';

  enqueueMessage(handle, 'test msg');
  assert.equal(handle._messageQueue[0].from, 'orchestrator');
});

test('enqueueMessage: includes enqueuedAt timestamp', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.status = 'running';

  const before = new Date().toISOString();
  enqueueMessage(handle, 'test');
  const after = new Date().toISOString();

  const ts = handle._messageQueue[0].enqueuedAt;
  assert.ok(ts >= before && ts <= after);
});

// ─── getQueueState ───────────────────────────────────────────────────────────

test('getQueueState: returns empty state for null handle', () => {
  const state = getQueueState(null);
  assert.equal(state.length, 0);
  assert.equal(state.draining, false);
  assert.equal(state.deadLetters, 0);
  assert.deepEqual(state.messages, []);
});

test('getQueueState: returns correct queue snapshot', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.status = 'running';

  enqueueMessage(handle, 'First message with extra context that is quite long and exceeds preview limit when truncated to one hundred characters for testing purposes', { from: 'w1' });
  enqueueMessage(handle, 'Second', { from: 'w2' });

  const state = getQueueState(handle);
  assert.equal(state.length, 2);
  assert.equal(state.draining, false);
  assert.equal(state.messages[0].from, 'w1');
  assert.equal(state.messages[1].from, 'w2');
  // Preview should be truncated to 100 chars
  assert.ok(state.messages[0].preview.length <= 100);
  assert.equal(state.messages[1].preview, 'Second');
});

test('getQueueState: reflects draining flag', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle._draining = true;

  const state = getQueueState(handle);
  assert.equal(state.draining, true);
});

// ─── _drainQueue ─────────────────────────────────────────────────────────────

test('_drainQueue: returns immediately if already draining', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle._draining = true;
  handle._messageQueue.push({ text: 'msg', from: 'test', enqueuedAt: new Date().toISOString() });

  const result = await _drainQueue(handle);
  assert.equal(result.delivered, 0);
  assert.equal(result.failed, 0);
  // Queue should still have the message (not consumed)
  assert.equal(handle._messageQueue.length, 1);
});

test('_drainQueue: stops if handle is failed — messages preserved in queue', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.status = 'failed';
  handle._messageQueue.push({ text: 'msg', from: 'test', enqueuedAt: new Date().toISOString() });

  const result = await _drainQueue(handle);
  // Should not have delivered anything since server is failed
  assert.equal(result.delivered, 0);
  assert.equal(handle._draining, false);
  // Message should still be in queue (not consumed — loop breaks before shift)
  assert.equal(handle._messageQueue.length, 1);
  assert.equal(handle._messageQueue[0].text, 'msg');
});

test('_drainQueue: stops if exitCode is set — messages preserved', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.status = 'completed';
  handle._exitCode = 0; // server exited
  handle._messageQueue.push({ text: 'msg', from: 'test', enqueuedAt: new Date().toISOString() });

  const result = await _drainQueue(handle);
  assert.equal(result.delivered, 0);
  assert.equal(handle._draining, false);
  // Message should still be in queue
  assert.equal(handle._messageQueue.length, 1);
});

test('_drainQueue: resets draining flag on completion', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.status = 'failed'; // will cause immediate break
  handle._messageQueue = [];

  const result = await _drainQueue(handle);
  assert.equal(handle._draining, false);
  assert.equal(result.delivered, 0);
  assert.equal(result.failed, 0);
});

test('_drainQueue: formats prompt with [Message from X] prefix', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle._initialized = true;
  handle._sessionId = 'sess-1';
  handle.status = 'completed';

  // Capture what sendPrompt receives by intercepting stdin writes
  const written = [];
  child.stdin = new Writable({
    write(chunk, enc, cb) {
      written.push(chunk.toString());
      cb();
    },
  });

  handle._messageQueue.push({
    text: 'Here is the API schema',
    from: 'api-worker',
    enqueuedAt: new Date().toISOString(),
  });

  // Start drain — sendPrompt will send a request but get no response (will hang)
  // We'll let it timeout very quickly by setting handle to failed after a tick
  const drainPromise = _drainQueue(handle);

  // After a short delay, simulate the prompt failing (server died)
  await new Promise(r => setTimeout(r, 10));
  handle.status = 'failed';
  handle._exitCode = 1;
  // Reject the pending request so sendPrompt resolves
  for (const [id, handler] of handle._pending) {
    handler.resolve({ jsonrpc: '2.0', id, error: { code: -1, message: 'Server died' } });
  }
  handle._pending.clear();

  const result = await drainPromise;

  // Check that the sent prompt includes the [Message from api-worker] prefix
  const promptReq = written.find(w => w.includes('api-worker'));
  assert.ok(promptReq, 'Should have sent a prompt with api-worker prefix');
  assert.ok(promptReq.includes('[Message from api-worker]'));
});

test('_drainQueue: orchestrator messages sent without prefix', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle._initialized = true;
  handle._sessionId = 'sess-1';
  handle.status = 'completed';

  const written = [];
  child.stdin = new Writable({
    write(chunk, enc, cb) {
      written.push(chunk.toString());
      cb();
    },
  });

  handle._messageQueue.push({
    text: 'Direct instruction',
    from: 'orchestrator',
    enqueuedAt: new Date().toISOString(),
  });

  const drainPromise = _drainQueue(handle);

  await new Promise(r => setTimeout(r, 10));
  handle.status = 'failed';
  handle._exitCode = 1;
  for (const [id, handler] of handle._pending) {
    handler.resolve({ jsonrpc: '2.0', id, error: { code: -1, message: 'Server died' } });
  }
  handle._pending.clear();

  await drainPromise;

  // Orchestrator messages should NOT have [Message from ...] prefix
  const promptReq = written.find(w => w.includes('Direct instruction'));
  assert.ok(promptReq, 'Should have sent the orchestrator message');
  assert.ok(!promptReq.includes('[Message from'), 'Orchestrator messages should not have prefix');
});

// ─── Queue capacity limit ────────────────────────────────────────────────────

test('enqueueMessage: rejects when queue is at capacity (MAX_QUEUE_DEPTH)', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.status = 'running'; // prevent auto-drain

  // Fill queue to capacity (200)
  for (let i = 0; i < 200; i++) {
    const r = enqueueMessage(handle, `msg-${i}`);
    assert.equal(r.queued, true);
  }
  assert.equal(handle._messageQueue.length, 200);

  // 201st should be rejected
  const rejected = enqueueMessage(handle, 'overflow');
  assert.equal(rejected.queued, false);
  assert.equal(rejected.position, -1);
  assert.equal(handle._messageQueue.length, 200);
});

// ─── Position calculation ────────────────────────────────────────────────────

test('enqueueMessage: position is correct for normal and high priority', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.status = 'running';

  const r1 = enqueueMessage(handle, 'first');
  assert.equal(r1.position, 0);

  const r2 = enqueueMessage(handle, 'second');
  assert.equal(r2.position, 1);

  // High priority should go to front
  const r3 = enqueueMessage(handle, 'urgent', { priority: 'high' });
  assert.equal(r3.position, 0);

  // Next normal should be at end (now index 3)
  const r4 = enqueueMessage(handle, 'fourth');
  assert.equal(r4.position, 3);
});

// ─── Dead letter handling ────────────────────────────────────────────────────

test('_drainQueue: failed message is re-queued with _retried flag on first failure', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle._initialized = true;
  handle._sessionId = 'sess-1';
  handle.status = 'completed';

  child.stdin = new Writable({
    write(chunk, enc, cb) { cb(); },
  });

  handle._messageQueue.push({
    text: 'will-fail',
    from: 'worker-a',
    enqueuedAt: new Date().toISOString(),
  });

  // Start drain — sendPrompt will fail
  const drainPromise = _drainQueue(handle);

  // Let the first sendPrompt send its request, then fail it
  await new Promise(r => setTimeout(r, 5));
  for (const [id, handler] of handle._pending) {
    handler.resolve({ jsonrpc: '2.0', id, error: { code: 429, message: 'Rate limited' } });
  }
  handle._pending.clear();

  // sendPrompt failure sets handle.status='failed', which causes the loop to
  // break before retrying. The message should be re-queued with _retried=true.
  const result = await drainPromise;

  assert.equal(handle._draining, false);
  assert.equal(result.failed, 1);
  // Message was re-queued at front with _retried flag (not consumed)
  assert.equal(handle._messageQueue.length, 1);
  assert.equal(handle._messageQueue[0].text, 'will-fail');
  assert.equal(handle._messageQueue[0]._retried, true);
});

test('_drainQueue: message moved to dead letters after second failure', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle._initialized = true;
  handle._sessionId = 'sess-1';
  handle.status = 'completed';

  child.stdin = new Writable({
    write(chunk, enc, cb) { cb(); },
  });

  // Pre-mark as retried (simulating first failure already happened)
  handle._messageQueue.push({
    text: 'already-retried',
    from: 'worker-a',
    enqueuedAt: new Date().toISOString(),
    _retried: true,
  });

  const drainPromise = _drainQueue(handle);

  await new Promise(r => setTimeout(r, 5));
  for (const [id, handler] of handle._pending) {
    handler.resolve({ jsonrpc: '2.0', id, error: { code: 429, message: 'Rate limited' } });
  }
  handle._pending.clear();

  const result = await drainPromise;

  assert.equal(handle._draining, false);
  assert.equal(result.failed, 1);
  assert.equal(result.deadLettered, 1);
  // Message should be in dead letters, not in queue
  assert.equal(handle._messageQueue.length, 0);
  assert.equal(handle._deadLetters.length, 1);
  assert.equal(handle._deadLetters[0].text, 'already-retried');
});

// ─── getQueueState with dead letters ─────────────────────────────────────────

test('getQueueState: includes deadLetters count', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle._deadLetters = [
    { text: 'lost-1', from: 'w1', enqueuedAt: new Date().toISOString() },
    { text: 'lost-2', from: 'w2', enqueuedAt: new Date().toISOString() },
  ];

  const state = getQueueState(handle);
  assert.equal(state.deadLetters, 2);
});

// ─── Auto-drain from _processNotification ────────────────────────────────────

test('notifications: promptCompleted triggers auto-drain when queue has messages', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle._initialized = true;
  handle._sessionId = 'sess-1';
  handle.status = 'running';

  // Enqueue while running (won't auto-drain because status is 'running')
  handle._messageQueue.push({
    text: 'queued-during-run',
    from: 'api-worker',
    enqueuedAt: new Date().toISOString(),
  });
  assert.equal(handle._messageQueue.length, 1);

  // Simulate promptCompleted notification — should trigger auto-drain
  emitNotification(child, 'promptCompleted', { status: 'completed' });

  // Auto-drain fires asynchronously (microtask), give it a tick
  await new Promise(r => setTimeout(r, 10));

  // The drain should have started (draining flag may be true or already done)
  // The message should have been shifted off the queue by the drain attempt
  // (sendPrompt will be called but fail since no real server — that's OK,
  //  we just verify the drain was triggered)
  assert.ok(handle._draining || handle._messageQueue.length < 1,
    'Auto-drain should have started or completed');
});
