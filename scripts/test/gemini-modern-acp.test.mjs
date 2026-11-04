import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { startServer, initializeServer, createSession, sendPrompt, cancelPrompt, shutdownServer } from '../lib/gemini-acp.mjs';
function fixture(stopReason = 'end_turn') {
  const child = new EventEmitter();
  const calls = [];
  child.pid = 12345; child.killed = false;
  child.stdout = new Readable({ read() {} }); child.stderr = new Readable({ read() {} });
  const reply = (id, result) => child.stdout.push(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  child.stdin = new Writable({ write(chunk, encoding, done) {
    const request = JSON.parse(chunk.toString()); calls.push(request);
    queueMicrotask(() => {
      if (request.method === 'session/cancel') return;
      if (request.method === 'session/new') reply(request.id, { sessionId: 'session-one' });
      else if (request.method === 'session/prompt') {
        child.stdout.push(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-one',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first ' } } } }) + '\n');
        child.stdout.push(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-one',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'second' } } } }) + '\n');
        reply(request.id, { stopReason });
      } else reply(request.id, {});
    }); done();
  } });
  child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('exit', 0)); };
  const handle = startServer({ modernAcp: true, cwd: '/tmp', credential: { useKeychain: false },
    spawn: () => child, resolveGeminiBinary: () => ({ path: 'fixture', flavor: 'gemini', resolved: true }) });
  return { handle, calls };
}
test('managed ACP uses current session RPC methods, typed prompt content, streaming updates, and cancellation notifications', async () => {
  const { handle, calls } = fixture();
  try {
    await initializeServer(handle);
    assert.equal((await createSession(handle, { cwd: '/tmp', approvalMode: 'auto_edit', requireApprovalMode: true, model: 'model' })).sessionId, 'session-one');
    assert.deepEqual(calls.find(call => call.method === 'session/new').params, { cwd: '/tmp', mcpServers: [] });
    assert.equal(calls.find(call => call.method === 'session/set_mode').params.modeId, 'auto_edit');
    assert.equal(calls.find(call => call.method === 'session/set_model').params.modelId, 'model');
    const result = await sendPrompt(handle, 'work');
    assert.equal(result.status, 'completed'); assert.equal(result.output, 'first second');
    assert.deepEqual(calls.find(call => call.method === 'session/prompt').params.prompt, [{ type: 'text', text: 'work' }]);
    await cancelPrompt(handle);
    assert.equal(Object.hasOwn(calls.at(-1), 'id'), false); assert.equal(calls.at(-1).method, 'session/cancel');
  } finally { await shutdownServer(handle); }
});
test('managed ACP does not report a cancelled prompt as successful work', async () => {
  const { handle } = fixture('cancelled');
  try {
    await initializeServer(handle); await createSession(handle, { cwd: '/tmp' });
    const result = await sendPrompt(handle, 'work');
    assert.equal(result.status, 'failed'); assert.equal(result.error.category, 'cancelled');
  } finally { await shutdownServer(handle); }
});
