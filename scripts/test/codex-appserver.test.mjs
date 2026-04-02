/**
 * Unit tests for scripts/lib/codex-appserver.mjs
 * Uses node:test — zero npm dependencies.
 *
 * Tests use mock ChildProcess objects built from EventEmitter + streams,
 * so no real codex binary is needed and no processes are started.
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
function createHandle(child) {
  const emitter = new EventEmitter();
  const handle = {
    pid: child.pid,
    process: child,
    events: emitter,
    threadId: null,
    turnId: null,
    status: 'ready',
    _partial: '',
    _pending: new Map(),
    _items: [],
    _output: '',
    _turnError: null,
    _exitCode: null,
    _stderrChunks: [],
    _adapterName: 'codex-appserver',
  };

  // Wire up stdout parsing (same as startServer)
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
        if (msg.method) emitter.emit(msg.method, msg.params || msg);
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

/** Replicate notification processing for test handle (mirrors _processNotification) */
function _processNotificationForTest(handle, notification) {
  const method = notification.method || '';
  const params = notification.params || {};

  switch (method) {
    case 'threadStarted':
      if (params.threadId) handle.threadId = params.threadId;
      break;
    case 'turnStarted':
      handle.status = 'running';
      if (params.turn?.id) handle.turnId = params.turn.id;
      handle._items = [];
      handle._output = '';
      handle._turnError = null;
      break;
    case 'itemStarted':
      if (params.item) handle._items.push({ ...params.item, _phase: 'started' });
      break;
    case 'itemCompleted': {
      const item = params.item;
      if (!item) break;
      const idx = handle._items.findIndex(i => i.id === item.id);
      if (idx >= 0) handle._items[idx] = { ...item, _phase: 'completed' };
      else handle._items.push({ ...item, _phase: 'completed' });
      if (item.type === 'agentMessage' && item.text) handle._output += item.text + '\n';
      else if (item.type === 'commandExecution' && item.aggregatedOutput) handle._output += item.aggregatedOutput;
      break;
    }
    case 'turnCompleted': {
      const turn = params.turn || params;
      if (turn.status === 'completed' || turn.status === 'interrupted') handle.status = 'completed';
      else if (turn.status === 'failed') {
        handle.status = 'failed';
        handle._turnError = turn.error || null;
      }
      break;
    }
    case 'errorNotification':
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

/** Helper: emit a notification from mock stdout */
function emitNotification(child, method, params) {
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
  child.stdout.emit('data', Buffer.from(msg));
}

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

test('parseRpcMessage: returns null for empty string', () => {
  assert.equal(parseRpcMessage(''), null);
  assert.equal(parseRpcMessage('  '), null);
});

test('parseRpcMessage: returns null for invalid JSON', () => {
  assert.equal(parseRpcMessage('not json'), null);
});

test('parseRpcMessage: returns null for non-object JSON', () => {
  assert.equal(parseRpcMessage('"string"'), null);
  assert.equal(parseRpcMessage('42'), null);
});

test('parseRpcMessage: handles null/undefined input', () => {
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
  assert.equal(classifyMessage({ method: 'turnCompleted', params: {} }), 'notification');
});

test('classifyMessage: returns unknown for null', () => {
  assert.equal(classifyMessage(null), 'unknown');
});

test('classifyMessage: returns unknown for empty object', () => {
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

test('mapAppServerErrorCode: unknown string code', () => {
  assert.equal(mapAppServerErrorCode('somethingNew'), 'unknown');
});

test('mapAppServerErrorCode: unknown object shape', () => {
  assert.equal(mapAppServerErrorCode({ weirdKey: true }), 'unknown');
});

test('mapAppServerErrorCode: heuristic timeout detection', () => {
  assert.equal(mapAppServerErrorCode(null, 'process timed out'), 'timeout');
  assert.equal(mapAppServerErrorCode(null, 'did not complete within 30s'), 'timeout');
});

test('mapAppServerErrorCode: heuristic not_installed', () => {
  assert.equal(mapAppServerErrorCode(null, 'codex: command not found'), 'not_installed');
});

test('mapAppServerErrorCode: heuristic crash', () => {
  assert.equal(mapAppServerErrorCode(null, 'fatal error: segmentation fault'), 'crash');
});

// ─── sendRequest ───────────────────────────────────────────────────────────────

test('sendRequest: resolves when response arrives', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  // Intercept stdin to capture the request id
  let sentReqId;
  const origWrite = child.stdin.write.bind(child.stdin);
  child.stdin.write = (data, ...args) => {
    const req = JSON.parse(data.toString().trim());
    sentReqId = req.id;
    // Simulate response after a tick
    setImmediate(() => emitResponse(child, sentReqId, { threadId: 'test-123' }));
    return origWrite(data, ...args);
  };

  const result = await sendRequest(handle, 'thread/start', { cwd: '/tmp' }, 5000);
  assert.deepEqual(result.result, { threadId: 'test-123' });
});

test('sendRequest: returns error when server not running', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  handle.status = 'failed';

  const result = await sendRequest(handle, 'test');
  assert.ok(result.error);
  assert.equal(result.error.code, -1);
});

test('sendRequest: times out if no response', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  const result = await sendRequest(handle, 'slow/method', {}, 50);
  assert.ok(result.error);
  assert.equal(result.error.code, -2);
  assert.match(result.error.message, /timed out/i);
});

// ─── Notification processing ───────────────────────────────────────────────────

test('notification: threadStarted sets threadId', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  emitNotification(child, 'threadStarted', { threadId: 'thread-abc' });
  // Allow microtask
  assert.equal(handle.threadId, 'thread-abc');
});

test('notification: turnStarted sets status and turnId', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  emitNotification(child, 'turnStarted', { turn: { id: 'turn-1', status: 'inProgress' } });
  assert.equal(handle.status, 'running');
  assert.equal(handle.turnId, 'turn-1');
});

test('notification: itemCompleted accumulates agentMessage output', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  emitNotification(child, 'itemCompleted', {
    item: { id: 'item-0', type: 'agentMessage', text: 'Hello world', status: 'completed' },
  });
  assert.ok(handle._output.includes('Hello world'));
});

test('notification: itemCompleted accumulates command output', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  emitNotification(child, 'itemCompleted', {
    item: { id: 'item-1', type: 'commandExecution', aggregatedOutput: 'PASS\n', exitCode: 0, status: 'completed' },
  });
  assert.ok(handle._output.includes('PASS'));
});

test('notification: itemStarted then itemCompleted replaces item', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  emitNotification(child, 'itemStarted', {
    item: { id: 'item-1', type: 'commandExecution', status: 'inProgress' },
  });
  assert.equal(handle._items.length, 1);
  assert.equal(handle._items[0]._phase, 'started');

  emitNotification(child, 'itemCompleted', {
    item: { id: 'item-1', type: 'commandExecution', status: 'completed', exitCode: 0, aggregatedOutput: 'ok' },
  });
  assert.equal(handle._items.length, 1);
  assert.equal(handle._items[0]._phase, 'completed');
  assert.equal(handle._items[0].exitCode, 0);
});

test('notification: turnCompleted sets status to completed', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  handle.status = 'running';

  emitNotification(child, 'turnCompleted', { turn: { status: 'completed' } });
  assert.equal(handle.status, 'completed');
});

test('notification: turnCompleted with failed status sets error', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  handle.status = 'running';

  emitNotification(child, 'turnCompleted', {
    turn: { status: 'failed', error: { message: 'context exceeded', codexErrorInfo: 'contextWindowExceeded' } },
  });
  assert.equal(handle.status, 'failed');
  assert.ok(handle._turnError);
  assert.equal(handle._turnError.codexErrorInfo, 'contextWindowExceeded');
});

test('notification: turnCompleted interrupted is clean stop', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  handle.status = 'running';

  emitNotification(child, 'turnCompleted', { turn: { status: 'interrupted' } });
  assert.equal(handle.status, 'completed');
});

test('notification: errorNotification with willRetry=false sets turnError', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  emitNotification(child, 'errorNotification', {
    willRetry: false,
    error: { message: 'Unauthorized', codexErrorInfo: 'unauthorized' },
  });
  assert.ok(handle._turnError);
  assert.equal(handle._turnError.codexErrorInfo, 'unauthorized');
});

test('notification: errorNotification with willRetry=true does not set error', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  emitNotification(child, 'errorNotification', {
    willRetry: true,
    error: { message: 'Temporary' },
  });
  assert.equal(handle._turnError, null);
});

// ─── monitor ───────────────────────────────────────────────────────────────────

test('monitor: returns current state', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
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

test('monitor: includes error info when failed', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  handle.status = 'failed';
  handle._turnError = { message: 'Context exceeded', codexErrorInfo: 'contextWindowExceeded' };

  const result = monitor(handle);
  assert.equal(result.status, 'failed');
  assert.ok(result.error);
  assert.equal(result.error.category, 'context_exceeded');
  assert.equal(result.error.codexErrorInfo, 'contextWindowExceeded');
});

test('monitor: falls back to stderr for error classification', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  handle.status = 'failed';
  handle._stderrChunks = ['Error: ETIMEDOUT'];

  const result = monitor(handle);
  assert.equal(result.error.category, 'network');
});

// ─── createThread ──────────────────────────────────────────────────────────────

test('createThread: sends thread/start and returns threadId', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  let capturedReq;
  child.stdin.write = (data, ...args) => {
    capturedReq = JSON.parse(data.toString().trim());
    setImmediate(() => emitResponse(child, capturedReq.id, { threadId: 'th-new' }));
    return true;
  };

  const result = await createThread(handle, { cwd: '/workspace' });
  assert.equal(result.threadId, 'th-new');
  assert.equal(capturedReq.method, 'thread/start');
  assert.equal(capturedReq.params.approvalPolicy, 'never');
  assert.equal(capturedReq.params.ephemeral, true);
});

test('createThread: returns error on RPC failure', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

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
  const handle = createHandle(child);
  handle.threadId = null;

  const result = await startTurn(handle, 'Hello');
  assert.ok(result.error);
  assert.match(result.error.message, /No active thread/);
});

test('startTurn: sends turn/start with prompt', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  handle.threadId = 'th-1';

  let capturedReq;
  child.stdin.write = (data) => {
    capturedReq = JSON.parse(data.toString().trim());
    setImmediate(() => emitResponse(child, capturedReq.id, { turnId: 'tu-1' }));
    return true;
  };

  const result = await startTurn(handle, 'Run tests');
  assert.equal(result.turnId, 'tu-1');
  assert.equal(capturedReq.method, 'turn/start');
  assert.equal(capturedReq.params.threadId, 'th-1');
  assert.equal(capturedReq.params.input[0].type, 'text');
  assert.equal(capturedReq.params.input[0].text, 'Run tests');
});

test('startTurn: preserves prior output on RPC failure', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
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
  // Prior state must NOT be cleared on failure
  assert.equal(handle._output, 'prior turn output\n');
  assert.equal(handle._items.length, 1);
  assert.equal(handle._items[0].id, 'old');
});

test('startTurn: passes model override', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  handle.threadId = 'th-1';

  let capturedReq;
  child.stdin.write = (data) => {
    capturedReq = JSON.parse(data.toString().trim());
    setImmediate(() => emitResponse(child, capturedReq.id, { turnId: 'tu-2' }));
    return true;
  };

  await startTurn(handle, 'Hello', { model: 'o1', effort: 'high' });
  assert.equal(capturedReq.params.model, 'o1');
  assert.equal(capturedReq.params.effort, 'high');
});

// ─── steerTurn ─────────────────────────────────────────────────────────────────

test('steerTurn: requires active turn', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  const result = await steerTurn(handle, 'more input');
  assert.ok(result.error);
  assert.match(result.error.message, /No active turn/);
});

test('steerTurn: sends turn/steer with expectedTurnId', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
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
  assert.equal(capturedReq.params.input[0].text, 'Also check lint');
});

// ─── interruptTurn ─────────────────────────────────────────────────────────────

test('interruptTurn: requires active turn', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  const result = await interruptTurn(handle);
  assert.ok(result.error);
});

test('interruptTurn: sends turn/interrupt', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
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
  assert.equal(capturedReq.params.turnId, 'tu-1');
});

// ─── collectTurnResult ─────────────────────────────────────────────────────────

test('collectTurnResult: resolves immediately when already completed', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  handle.status = 'completed';
  handle._output = 'done';

  const result = await collectTurnResult(handle, 1000);
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'done');
});

test('collectTurnResult: resolves on turnCompleted notification', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  handle.status = 'running';

  // Emit turnCompleted after a tick
  setImmediate(() => {
    emitNotification(child, 'turnCompleted', { turn: { status: 'completed' } });
  });

  const result = await collectTurnResult(handle, 5000);
  assert.equal(result.status, 'completed');
});

test('collectTurnResult: resolves on process exit', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
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
  const handle = createHandle(child);
  handle.status = 'running';

  const result = await collectTurnResult(handle, 50);
  assert.equal(result.status, 'failed');
  assert.ok(result.error);
  assert.match(result.error.message, /did not complete within/);
});

// ─── executeTurn ───────────────────────────────────────────────────────────────

test('executeTurn: fails if no thread', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  const result = await executeTurn(handle, 'Hello');
  assert.equal(result.status, 'failed');
  assert.ok(result.error);
});

test('executeTurn: runs full turn lifecycle', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  handle.threadId = 'th-1';

  child.stdin.write = (data) => {
    const req = JSON.parse(data.toString().trim());
    // Respond to turn/start
    setImmediate(() => {
      emitResponse(child, req.id, { turnId: 'tu-1' });
      // Then emit item + turn completion
      setImmediate(() => {
        emitNotification(child, 'itemCompleted', {
          item: { id: 'i0', type: 'agentMessage', text: 'Result', status: 'completed' },
        });
        emitNotification(child, 'turnCompleted', { turn: { status: 'completed' } });
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
  const handle = createHandle(child);
  handle.process.killed = true;

  // Should not throw or hang
  await shutdownServer(handle);
});

test('shutdownServer: sends SIGTERM and resolves on exit', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  let terminated = false;
  child.kill = (signal) => {
    terminated = true;
    child.killed = true;
    setImmediate(() => child.emit('exit', 0));
  };

  await shutdownServer(handle, 1000);
  assert.ok(terminated);
});

// ─── onNotification ────────────────────────────────────────────────────────────

test('onNotification: registers listener and receives events', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  let received = null;

  const unsub = onNotification(handle, 'itemCompleted', (params) => {
    received = params;
  });

  emitNotification(child, 'itemCompleted', {
    item: { id: 'i1', type: 'agentMessage', text: 'Hi' },
  });

  assert.ok(received);
  assert.equal(received.item.text, 'Hi');

  // Unsubscribe
  unsub();
  received = null;
  emitNotification(child, 'itemCompleted', {
    item: { id: 'i2', type: 'agentMessage', text: 'Bye' },
  });
  assert.equal(received, null); // Should not fire after unsub
});

// ─── Process exit handling ─────────────────────────────────────────────────────

test('process exit: rejects pending requests', async () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  // Start a request but don't respond
  const resultPromise = sendRequest(handle, 'test/slow', {}, 5000);

  // Process exits
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

test('process exit: marks handle as failed if was running', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);
  handle.status = 'running';

  child.emit('exit', 1);
  assert.equal(handle.status, 'failed');
  assert.equal(handle._exitCode, 1);
});

// ─── Partial buffer handling ───────────────────────────────────────────────────

test('partial buffer: handles split JSON lines', () => {
  const child = createMockChildProcess();
  const handle = createHandle(child);

  // Send first half of a notification
  const fullNotif = JSON.stringify({ jsonrpc: '2.0', method: 'threadStarted', params: { threadId: 'partial-test' } });
  const mid = Math.floor(fullNotif.length / 2);
  child.stdout.emit('data', Buffer.from(fullNotif.slice(0, mid)));
  assert.equal(handle.threadId, null); // Not yet parsed

  // Send second half + newline
  child.stdout.emit('data', Buffer.from(fullNotif.slice(mid) + '\n'));
  assert.equal(handle.threadId, 'partial-test');
});

// ─── Integration: selectAdapter with codex-appserver ───────────────────────────

test('selectAdapter: prefers codex-appserver over codex-exec', async () => {
  const { selectAdapter } = await import('../lib/worker-spawn.mjs');
  const caps = { hasCodexAppServer: true, hasCodexExecJson: true };
  assert.equal(selectAdapter({ type: 'codex', name: 'w1' }, caps), 'codex-appserver');
});

test('selectAdapter: falls back to codex-exec when no appserver', async () => {
  const { selectAdapter } = await import('../lib/worker-spawn.mjs');
  const caps = { hasCodexAppServer: false, hasCodexExecJson: true };
  assert.equal(selectAdapter({ type: 'codex', name: 'w1' }, caps), 'codex-exec');
});

test('selectAdapter: falls back to tmux when no codex features', async () => {
  const { selectAdapter } = await import('../lib/worker-spawn.mjs');
  const caps = { hasCodexAppServer: false, hasCodexExecJson: false };
  assert.equal(selectAdapter({ type: 'codex', name: 'w1' }, caps), 'tmux');
});

test('selectAdapter: claude workers always use tmux', async () => {
  const { selectAdapter } = await import('../lib/worker-spawn.mjs');
  const caps = { hasCodexAppServer: true, hasCodexExecJson: true };
  assert.equal(selectAdapter({ type: 'claude', name: 'w1' }, caps), 'tmux');
});
