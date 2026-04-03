/**
 * Unit tests for scripts/lib/codex-appserver.mjs
 * Uses node:test — zero npm dependencies.
 *
 * Tests use mock ChildProcess objects built from EventEmitter + streams,
 * so no real codex binary is needed and no processes are started.
 *
 * Wire protocol names verified against codex-cli 0.116.0 via live stdio probe:
 * - Notifications: thread/started, turn/started, item/started, item/completed, turn/completed, error
 * - Response paths: result.thread.id, result.turn.id (nested objects, not flat IDs)
 * - Handshake: initialize with clientInfo required before any other method
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

import {
  createRpcRequest,
  parseRpcMessage,
  classifyMessage,
  mapAppServerErrorCode,
  startServer,
  initializeServer,
  sendRequest,
  createThread,
  startTurn,
  steerTurn,
  interruptTurn,
  monitor,
  collectTurnResult,
  executeTurn,
  shutdownServer,
  onNotification,
  NOTIFY,
} from '../lib/codex-appserver.mjs';

// ─── Mock helpers ──────────────────────────────────────────────────────────────

function createMockChildProcess() {
  const child = new EventEmitter();
  child.stdin = new Writable({ write(chunk, enc, cb) { cb(); } });
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.pid = 99999;
  child.killed = false;
  child.kill = (signal) => {
    child.killed = true;
    child.emit('exit', 0, signal);
  };
  return child;
}

/**
 * Build an AppServerHandle manually (bypassing startServer()) for hermetic tests.
 */
function createHandle(child, initialized = false) {
  const emitter = new EventEmitter();
  const handle = {
    pid: child.pid,
    process: child,
    events: emitter,
    threadId: null,
    turnId: null,
    status: initialized ? 'ready' : 'starting',
    _partial: '',
    _pending: new Map(),
    _items: [],
    _output: '',
    _turnError: null,
    _exitCode: null,
    _stderrChunks: [],
    _initialized: initialized,
    _adapterName: 'codex-appserver',
  };

  // Wire up stdout parsing (mirrors startServer)
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
        // Auto-respond to server requests
        try {
          const resp = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} });
          child.stdin.write(resp + '\n');
        } catch {}
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    handle._stderrChunks.push(chunk.toString());
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

/** Replicate notification processing for test handle (uses NOTIFY constants) */
function _processNotificationForTest(handle, notification) {
  const method = notification.method || '';
  const params = notification.params || {};

  switch (method) {
    case NOTIFY.THREAD_STARTED: {
      const threadId = params.thread?.id;
      if (threadId) handle.threadId = threadId;
      break;
    }
    case NOTIFY.TURN_STARTED:
      handle.status = 'running';
      if (params.turn?.id) handle.turnId = params.turn.id;
      handle._items = [];
      handle._output = '';
      handle._turnError = null;
      break;
    case NOTIFY.ITEM_STARTED:
      if (params.item) handle._items.push({ ...params.item, _phase: 'started' });
      break;
    case NOTIFY.ITEM_COMPLETED: {
      const item = params.item;
      if (!item) break;
      const idx = handle._items.findIndex(i => i.id === item.id);
      if (idx >= 0) handle._items[idx] = { ...item, _phase: 'completed' };
      else handle._items.push({ ...item, _phase: 'completed' });
      if (item.type === 'agentMessage' && item.text) handle._output += item.text + '\n';
      else if (item.type === 'commandExecution' && item.aggregatedOutput) handle._output += item.aggregatedOutput;
      break;
    }
    case NOTIFY.TURN_COMPLETED: {
      const turn = params.turn || params;
      const statusObj = turn.status;
      const turnStatus = (typeof statusObj === 'object' && statusObj !== null) ? statusObj.type : (statusObj || 'completed');
      if (turnStatus === 'completed' || turnStatus === 'interrupted') handle.status = 'completed';
      else if (turnStatus === 'failed') {
        handle.status = 'failed';
        handle._turnError = turn.error || null;
      }
      break;
    }
    case 'error':
      // Wire method is 'error' — processNotification matches the wire name
      if (!params.willRetry) handle._turnError = params.error || { message: 'Unknown error' };
      break;
  }
}

/** Helper: emit a JSON-RPC response from mock stdout (direct event emit for reliability) */
function emitResponse(child, id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n';
  child.stdout.emit('data', Buffer.from(msg));
}

/** Helper: emit a JSON-RPC error response from mock stdout */
function emitErrorResponse(child, id, error) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error }) + '\n';
  child.stdout.emit('data', Buffer.from(msg));
}

/** Helper: emit a notification from mock stdout (slash-separated method names) */
function emitNotification(child, method, params) {
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
  child.stdout.emit('data', Buffer.from(msg));
}

/** Helper: emit a server-initiated request */
function emitServerRequest(child, id, method, params) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
  child.stdout.emit('data', Buffer.from(msg));
}

// ─── NOTIFY constants ──────────────────────────────────────────────────────────

test('NOTIFY: uses slash-separated method names', () => {
  assert.equal(NOTIFY.THREAD_STARTED, 'thread/started');
  assert.equal(NOTIFY.TURN_STARTED, 'turn/started');
  assert.equal(NOTIFY.ITEM_STARTED, 'item/started');
  assert.equal(NOTIFY.ITEM_COMPLETED, 'item/completed');
  assert.equal(NOTIFY.TURN_COMPLETED, 'turn/completed');
  assert.equal(NOTIFY.ERROR, 'codex/error'); // Namespaced to avoid EventEmitter 'error' collision
});

// ─── createRpcRequest ──────────────────────────────────────────────────────────

test('createRpcRequest: creates valid JSON-RPC 2.0 request', () => {
  const req = createRpcRequest('thread/start', { cwd: '/tmp' });
  assert.equal(req.jsonrpc, '2.0');
  assert.equal(req.method, 'thread/start');
  assert.deepEqual(req.params, { cwd: '/tmp' });
  assert.equal(typeof req.id, 'number');
});

test('createRpcRequest: increments id', () => {
  const a = createRpcRequest('a');
  const b = createRpcRequest('b');
  assert.ok(b.id > a.id);
});

test('createRpcRequest: omits params when undefined', () => {
  const req = createRpcRequest('test');
  assert.ok(!('params' in req));
});

// ─── parseRpcMessage ───────────────────────────────────────────────────────────

test('parseRpcMessage: parses valid JSON object', () => {
  const msg = parseRpcMessage('{"jsonrpc":"2.0","id":1,"result":{}}');
  assert.deepEqual(msg, { jsonrpc: '2.0', id: 1, result: {} });
});

test('parseRpcMessage: returns null for empty/invalid/non-object', () => {
  assert.equal(parseRpcMessage(''), null);
  assert.equal(parseRpcMessage('  '), null);
  assert.equal(parseRpcMessage('not json'), null);
  assert.equal(parseRpcMessage(null), null);
  assert.equal(parseRpcMessage(undefined), null);
});

// ─── classifyMessage ───────────────────────────────────────────────────────────

test('classifyMessage: identifies response with result', () => {
  assert.equal(classifyMessage({ id: 1, result: {} }), 'response');
});

test('classifyMessage: identifies response with error', () => {
  assert.equal(classifyMessage({ id: 1, error: { code: -1 } }), 'response');
});

test('classifyMessage: identifies notification (method, no id)', () => {
  assert.equal(classifyMessage({ method: 'turn/completed', params: {} }), 'notification');
});

test('classifyMessage: identifies server request (id + method, no result/error)', () => {
  assert.equal(classifyMessage({ id: 5, method: 'approval/request', params: {} }), 'request');
});

test('classifyMessage: returns unknown for null/empty', () => {
  assert.equal(classifyMessage(null), 'unknown');
  assert.equal(classifyMessage({}), 'unknown');
});

// ─── mapAppServerErrorCode ─────────────────────────────────────────────────────

test('mapAppServerErrorCode: maps simple string codes', () => {
  assert.equal(mapAppServerErrorCode('unauthorized'), 'auth_failed');
  assert.equal(mapAppServerErrorCode('usageLimitExceeded'), 'rate_limited');
  assert.equal(mapAppServerErrorCode('contextWindowExceeded'), 'context_exceeded');
  assert.equal(mapAppServerErrorCode('serverOverloaded'), 'rate_limited');
  assert.equal(mapAppServerErrorCode('internalServerError'), 'crash');
  assert.equal(mapAppServerErrorCode('sandboxError'), 'crash');
  assert.equal(mapAppServerErrorCode('badRequest'), 'crash');
  assert.equal(mapAppServerErrorCode('threadRollbackFailed'), 'crash');
});

test('mapAppServerErrorCode: maps complex object codes', () => {
  assert.equal(mapAppServerErrorCode({ httpConnectionFailed: { httpStatusCode: 502 } }), 'network');
  assert.equal(mapAppServerErrorCode({ responseStreamConnectionFailed: {} }), 'network');
  assert.equal(mapAppServerErrorCode({ responseStreamDisconnected: {} }), 'network');
  assert.equal(mapAppServerErrorCode({ responseTooManyFailedAttempts: {} }), 'network');
});

test('mapAppServerErrorCode: falls back to heuristic on null', () => {
  assert.equal(mapAppServerErrorCode(null, 'rate limit exceeded'), 'rate_limited');
  assert.equal(mapAppServerErrorCode(undefined, 'ETIMEDOUT'), 'network');
});

test('mapAppServerErrorCode: "other" falls to heuristic', () => {
  assert.equal(mapAppServerErrorCode('other', 'authentication failed'), 'auth_failed');
  assert.equal(mapAppServerErrorCode('other', 'nothing special'), 'unknown');
});

test('mapAppServerErrorCode: unknown string/object', () => {
  assert.equal(mapAppServerErrorCode('somethingNew'), 'unknown');
  assert.equal(mapAppServerErrorCode({ weirdKey: true }), 'unknown');
});

test('mapAppServerErrorCode: heuristic categories', () => {
  assert.equal(mapAppServerErrorCode(null, 'process timed out'), 'timeout');
  assert.equal(mapAppServerErrorCode(null, 'codex: command not found'), 'not_installed');
  assert.equal(mapAppServerErrorCode(null, 'fatal error: segmentation fault'), 'crash');
});

// ─── sendRequest ───────────────────────────────────────────────────────────────

test('sendRequest: resolves when response arrives', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);

  child.stdin.write = (data, ...args) => {
    const req = JSON.parse(data.toString().trim());
    setImmediate(() => emitResponse(child, req.id, { thread: { id: 'test-123' } }));
    return true;
  };

  const result = await sendRequest(handle, 'thread/start', { cwd: '/tmp' }, 5000);
  assert.deepEqual(result.result, { thread: { id: 'test-123' } });
});

test('sendRequest: returns error when server not running', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.status = 'failed';

  const result = await sendRequest(handle, 'test');
  assert.ok(result.error);
  assert.equal(result.error.code, -1);
});

test('sendRequest: times out if no response', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);

  const result = await sendRequest(handle, 'slow/method', {}, 50);
  assert.ok(result.error);
  assert.equal(result.error.code, -2);
  assert.match(result.error.message, /timed out/i);
});

// ─── initializeServer ──────────────────────────────────────────────────────────

test('initializeServer: sends initialize with clientInfo', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  let capturedReq;
  child.stdin.write = (data) => {
    capturedReq = JSON.parse(data.toString().trim());
    setImmediate(() => emitResponse(child, capturedReq.id, { userAgent: 'test/1.0' }));
    return true;
  };

  const result = await initializeServer(handle);
  assert.ok(!result.error);
  assert.equal(capturedReq.method, 'initialize');
  assert.ok(capturedReq.params.clientInfo);
  assert.equal(capturedReq.params.clientInfo.name, 'agent-olympus');
  assert.equal(handle._initialized, true);
  assert.equal(handle.status, 'ready');
});

test('initializeServer: returns error on failure', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  child.stdin.write = (data) => {
    const req = JSON.parse(data.toString().trim());
    setImmediate(() => emitErrorResponse(child, req.id, { code: -32600, message: 'missing clientInfo' }));
    return true;
  };

  const result = await initializeServer(handle);
  assert.ok(result.error);
  assert.equal(handle._initialized, false);
});

test('initializeServer: accepts custom clientInfo', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  let capturedReq;
  child.stdin.write = (data) => {
    capturedReq = JSON.parse(data.toString().trim());
    setImmediate(() => emitResponse(child, capturedReq.id, { userAgent: 'custom/1.0' }));
    return true;
  };

  await initializeServer(handle, { name: 'custom', version: '1.0' });
  assert.equal(capturedReq.params.clientInfo.name, 'custom');
});

// ─── Notification processing (slash-separated names) ───────────────────────────

test('notification: thread/started sets threadId from params.thread.id', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);

  // Wire: { method: "thread/started", params: { thread: { id: "..." } } }
  emitNotification(child, 'thread/started', { thread: { id: 'thread-abc' } });
  assert.equal(handle.threadId, 'thread-abc');
});

test('notification: turn/started sets status and turnId', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);

  emitNotification(child, 'turn/started', { turn: { id: 'turn-1', status: { type: 'inProgress' } } });
  assert.equal(handle.status, 'running');
  assert.equal(handle.turnId, 'turn-1');
});

test('notification: item/completed accumulates agentMessage output', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);

  emitNotification(child, 'item/completed', {
    item: { id: 'item-0', type: 'agentMessage', text: 'Hello world', status: 'completed' },
  });
  assert.ok(handle._output.includes('Hello world'));
});

test('notification: item/completed accumulates command output', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);

  emitNotification(child, 'item/completed', {
    item: { id: 'item-1', type: 'commandExecution', aggregatedOutput: 'PASS\n', exitCode: 0, status: 'completed' },
  });
  assert.ok(handle._output.includes('PASS'));
});

test('notification: item/started then item/completed replaces item', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);

  emitNotification(child, 'item/started', {
    item: { id: 'item-1', type: 'commandExecution', status: 'inProgress' },
  });
  assert.equal(handle._items.length, 1);
  assert.equal(handle._items[0]._phase, 'started');

  emitNotification(child, 'item/completed', {
    item: { id: 'item-1', type: 'commandExecution', status: 'completed', exitCode: 0, aggregatedOutput: 'ok' },
  });
  assert.equal(handle._items.length, 1);
  assert.equal(handle._items[0]._phase, 'completed');
});

test('notification: turn/completed with status object sets completed', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.status = 'running';

  // Wire: turn.status is an object { type: "completed" }
  emitNotification(child, 'turn/completed', { turn: { status: { type: 'completed' } } });
  assert.equal(handle.status, 'completed');
});

test('notification: turn/completed with string status (backward compat)', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.status = 'running';

  emitNotification(child, 'turn/completed', { turn: { status: 'completed' } });
  assert.equal(handle.status, 'completed');
});

test('notification: turn/completed failed sets error', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.status = 'running';

  emitNotification(child, 'turn/completed', {
    turn: { status: { type: 'failed' }, error: { message: 'context exceeded', codexErrorInfo: 'contextWindowExceeded' } },
  });
  assert.equal(handle.status, 'failed');
  assert.ok(handle._turnError);
});

test('notification: turn/completed interrupted is clean stop', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.status = 'running';

  emitNotification(child, 'turn/completed', { turn: { status: { type: 'interrupted' } } });
  assert.equal(handle.status, 'completed');
});

test('notification: error with willRetry=false sets turnError', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);

  emitNotification(child, 'error', {
    willRetry: false,
    error: { message: 'Unauthorized', codexErrorInfo: 'unauthorized' },
  });
  assert.ok(handle._turnError);
  assert.equal(handle._turnError.codexErrorInfo, 'unauthorized');
});

test('notification: error with willRetry=true does not set error', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);

  emitNotification(child, 'error', {
    willRetry: true,
    error: { message: 'Temporary' },
  });
  assert.equal(handle._turnError, null);
});

// ─── Server request handling ───────────────────────────────────────────────────

test('server request: auto-responds with empty result', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  let responded = null;

  const origWrite = child.stdin.write;
  child.stdin.write = (data, ...args) => {
    const parsed = JSON.parse(data.toString().trim());
    if (parsed.id === 42) responded = parsed;
    return origWrite.call(child.stdin, data, ...args);
  };

  emitServerRequest(child, 42, 'approval/request', { action: 'rm -rf /' });
  assert.ok(responded);
  assert.equal(responded.id, 42);
  assert.deepEqual(responded.result, {});
});

// ─── monitor ───────────────────────────────────────────────────────────────────

test('monitor: returns current state', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.status = 'running';
  handle.threadId = 'th-1';
  handle.turnId = 'tu-1';
  handle._output = 'test output\n';
  handle._items = [{ id: 'item-0', type: 'agentMessage' }];

  const result = monitor(handle);
  assert.equal(result.status, 'running');
  assert.equal(result.output, 'test output\n');
  assert.equal(result.threadId, 'th-1');
  assert.equal(result.items.length, 1);
  assert.ok(!result.error);
});

test('monitor: includes error info when failed with codexErrorInfo', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.status = 'failed';
  handle._turnError = { message: 'Context exceeded', codexErrorInfo: 'contextWindowExceeded' };

  const result = monitor(handle);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.category, 'context_exceeded');
  assert.equal(result.error.codexErrorInfo, 'contextWindowExceeded');
});

test('monitor: includes exitCode in error', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.status = 'failed';
  handle._exitCode = 1;
  handle._stderrChunks = ['Error: ETIMEDOUT'];

  const result = monitor(handle);
  assert.equal(result.error.category, 'network');
  assert.equal(result.error.exitCode, 1);
});

// ─── createThread ──────────────────────────────────────────────────────────────

test('createThread: requires initialization', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, false); // not initialized

  const result = await createThread(handle);
  assert.ok(result.error);
  assert.match(result.error.message, /not initialized/i);
});

test('createThread: sends thread/start and extracts result.thread.id', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);

  let capturedReq;
  child.stdin.write = (data) => {
    capturedReq = JSON.parse(data.toString().trim());
    // Wire: result.thread.id
    setImmediate(() => emitResponse(child, capturedReq.id, {
      thread: { id: 'th-new', status: { type: 'idle' }, turns: [] },
      model: 'gpt-5.4',
    }));
    return true;
  };

  const result = await createThread(handle, { cwd: '/workspace' });
  assert.equal(result.threadId, 'th-new');
  assert.equal(handle.threadId, 'th-new');
  assert.equal(capturedReq.method, 'thread/start');
  assert.equal(capturedReq.params.approvalPolicy, 'never');
  assert.equal(capturedReq.params.ephemeral, true);
});

test('createThread: returns error on RPC failure', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);

  child.stdin.write = (data) => {
    const req = JSON.parse(data.toString().trim());
    setImmediate(() => emitErrorResponse(child, req.id, { code: -1, message: 'Failed' }));
    return true;
  };

  const result = await createThread(handle);
  assert.ok(result.error);
});

// ─── startTurn ─────────────────────────────────────────────────────────────────

test('startTurn: requires active thread', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.threadId = null;

  const result = await startTurn(handle, 'Hello');
  assert.ok(result.error);
  assert.match(result.error.message, /No active thread/);
});

test('startTurn: sends turn/start and extracts result.turn.id', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.threadId = 'th-1';

  let capturedReq;
  child.stdin.write = (data) => {
    capturedReq = JSON.parse(data.toString().trim());
    // Wire: result.turn.id
    setImmediate(() => emitResponse(child, capturedReq.id, {
      turn: { id: 'tu-1', status: { type: 'inProgress' } },
    }));
    return true;
  };

  const result = await startTurn(handle, 'Run tests');
  assert.equal(result.turnId, 'tu-1');
  assert.equal(handle.turnId, 'tu-1');
  assert.equal(capturedReq.method, 'turn/start');
  assert.equal(capturedReq.params.threadId, 'th-1');
  assert.equal(capturedReq.params.input[0].text, 'Run tests');
});

test('startTurn: preserves prior output on RPC failure', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.threadId = 'th-1';
  handle._output = 'prior turn output\n';
  handle._items = [{ id: 'old', type: 'agentMessage' }];

  child.stdin.write = (data) => {
    const req = JSON.parse(data.toString().trim());
    setImmediate(() => emitErrorResponse(child, req.id, { code: -1, message: 'Failed' }));
    return true;
  };

  const result = await startTurn(handle, 'New prompt');
  assert.ok(result.error);
  assert.equal(handle._output, 'prior turn output\n');
  assert.equal(handle._items.length, 1);
});

test('startTurn: passes model and effort overrides', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.threadId = 'th-1';

  let capturedReq;
  child.stdin.write = (data) => {
    capturedReq = JSON.parse(data.toString().trim());
    setImmediate(() => emitResponse(child, capturedReq.id, { turn: { id: 'tu-2' } }));
    return true;
  };

  await startTurn(handle, 'Hello', { model: 'o1', effort: 'high' });
  assert.equal(capturedReq.params.model, 'o1');
  assert.equal(capturedReq.params.effort, 'high');
});

// ─── steerTurn ─────────────────────────────────────────────────────────────────

test('steerTurn: requires active turn', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);

  const result = await steerTurn(handle, 'more input');
  assert.ok(result.error);
});

test('steerTurn: sends turn/steer with expectedTurnId', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.threadId = 'th-1';
  handle.turnId = 'tu-1';

  let capturedReq;
  child.stdin.write = (data) => {
    capturedReq = JSON.parse(data.toString().trim());
    setImmediate(() => emitResponse(child, capturedReq.id, {}));
    return true;
  };

  const result = await steerTurn(handle, 'Also check lint');
  assert.ok(!result.error);
  assert.equal(capturedReq.method, 'turn/steer');
  assert.equal(capturedReq.params.expectedTurnId, 'tu-1');
});

// ─── interruptTurn ─────────────────────────────────────────────────────────────

test('interruptTurn: requires active turn', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);

  const result = await interruptTurn(handle);
  assert.ok(result.error);
});

test('interruptTurn: sends turn/interrupt', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.threadId = 'th-1';
  handle.turnId = 'tu-1';

  let capturedReq;
  child.stdin.write = (data) => {
    capturedReq = JSON.parse(data.toString().trim());
    setImmediate(() => emitResponse(child, capturedReq.id, {}));
    return true;
  };

  const result = await interruptTurn(handle);
  assert.ok(!result.error);
  assert.equal(capturedReq.method, 'turn/interrupt');
});

// ─── collectTurnResult ─────────────────────────────────────────────────────────

test('collectTurnResult: resolves immediately when already completed', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.status = 'completed';
  handle._output = 'done';

  const result = await collectTurnResult(handle, 1000);
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'done');
});

test('collectTurnResult: resolves on turn/completed notification', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.status = 'running';

  setImmediate(() => {
    emitNotification(child, 'turn/completed', { turn: { status: { type: 'completed' } } });
  });

  const result = await collectTurnResult(handle, 5000);
  assert.equal(result.status, 'completed');
});

test('collectTurnResult: resolves on process exit', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.status = 'running';

  setImmediate(() => {
    handle._exitCode = 1;
    handle.status = 'failed';
    handle.events.emit('exit', 1);
  });

  const result = await collectTurnResult(handle, 5000);
  assert.equal(result.status, 'failed');
});

test('collectTurnResult: times out if no completion', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.status = 'running';

  const result = await collectTurnResult(handle, 50);
  assert.equal(result.status, 'failed');
  assert.match(result.error.message, /did not complete within/);
});

// ─── executeTurn ───────────────────────────────────────────────────────────────

test('executeTurn: fails if no thread', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);

  const result = await executeTurn(handle, 'Hello');
  assert.equal(result.status, 'failed');
  assert.ok(result.error);
});

test('executeTurn: runs full turn lifecycle', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.threadId = 'th-1';

  child.stdin.write = (data) => {
    const req = JSON.parse(data.toString().trim());
    setImmediate(() => {
      emitResponse(child, req.id, { turn: { id: 'tu-1' } });
      setImmediate(() => {
        emitNotification(child, 'item/completed', {
          item: { id: 'i0', type: 'agentMessage', text: 'Result', status: 'completed' },
        });
        emitNotification(child, 'turn/completed', { turn: { status: { type: 'completed' } } });
      });
    });
    return true;
  };

  const result = await executeTurn(handle, 'Do something', { timeoutMs: 5000 });
  assert.equal(result.status, 'completed');
  assert.ok(result.output.includes('Result'));
});

// ─── shutdownServer ────────────────────────────────────────────────────────────

test('shutdownServer: resolves immediately if already killed', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  handle.process.killed = true;

  await shutdownServer(handle);
});

test('shutdownServer: registers exit listener before SIGTERM (race fix)', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  let killCalled = false;
  let exitListenerRegisteredBeforeKill = false;

  const origOnce = child.once.bind(child);
  child.once = (event, listener) => {
    if (event === 'exit' && !killCalled) {
      exitListenerRegisteredBeforeKill = true;
    }
    return origOnce(event, listener);
  };

  child.kill = (signal) => {
    killCalled = true;
    child.killed = true;
    setImmediate(() => child.emit('exit', 0));
  };

  await shutdownServer(handle, 1000);
  assert.ok(exitListenerRegisteredBeforeKill, 'exit listener must be registered before kill');
  assert.ok(killCalled);
});

// ─── onNotification ────────────────────────────────────────────────────────────

test('onNotification: registers listener with slash-separated names', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);
  let received = null;

  const unsub = onNotification(handle, 'item/completed', (params) => {
    received = params;
  });

  emitNotification(child, 'item/completed', {
    item: { id: 'i1', type: 'agentMessage', text: 'Hi' },
  });

  assert.ok(received);
  assert.equal(received.item.text, 'Hi');

  unsub();
  received = null;
  emitNotification(child, 'item/completed', {
    item: { id: 'i2', type: 'agentMessage', text: 'Bye' },
  });
  assert.equal(received, null);
});

// ─── Process exit handling ─────────────────────────────────────────────────────

test('process exit: rejects pending requests', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);

  const resultPromise = sendRequest(handle, 'test/slow', {}, 5000);

  setImmediate(() => {
    handle._exitCode = 1;
    handle.status = 'failed';
    for (const [id, handler] of handle._pending) {
      handler.resolve({ jsonrpc: '2.0', id, error: { code: -1, message: 'Server process exited' } });
    }
    handle._pending.clear();
    handle.events.emit('exit', 1);
  });

  const result = await resultPromise;
  assert.ok(result.error);
});

// ─── Partial buffer handling ───────────────────────────────────────────────────

test('partial buffer: handles split JSON lines', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child, true);

  const fullNotif = JSON.stringify({ jsonrpc: '2.0', method: 'thread/started', params: { thread: { id: 'partial-test' } } });
  const mid = Math.floor(fullNotif.length / 2);
  child.stdout.emit('data', Buffer.from(fullNotif.slice(0, mid)));
  assert.equal(handle.threadId, null);

  child.stdout.emit('data', Buffer.from(fullNotif.slice(mid) + '\n'));
  assert.equal(handle.threadId, 'partial-test');
});

// ─── selectAdapter integration ─────────────────────────────────────────────────

test('selectAdapter: prefers codex-appserver over codex-exec', async () => {
  const { selectAdapter } = await import('../lib/worker-spawn.mjs');
  assert.equal(selectAdapter({ type: 'codex', name: 'w1' }, { hasCodexAppServer: true, hasCodexExecJson: true }), 'codex-appserver');
});

test('selectAdapter: falls back to codex-exec when no appserver', async () => {
  const { selectAdapter } = await import('../lib/worker-spawn.mjs');
  assert.equal(selectAdapter({ type: 'codex', name: 'w1' }, { hasCodexAppServer: false, hasCodexExecJson: true }), 'codex-exec');
});

test('selectAdapter: falls back to tmux when no codex features', async () => {
  const { selectAdapter } = await import('../lib/worker-spawn.mjs');
  assert.equal(selectAdapter({ type: 'codex', name: 'w1' }, { hasCodexAppServer: false, hasCodexExecJson: false }), 'tmux');
});

test('selectAdapter: claude workers always use tmux', async () => {
  const { selectAdapter } = await import('../lib/worker-spawn.mjs');
  assert.equal(selectAdapter({ type: 'claude', name: 'w1' }, { hasCodexAppServer: true, hasCodexExecJson: true }), 'tmux');
});
