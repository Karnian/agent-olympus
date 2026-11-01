#!/usr/bin/env node
/** Narrow stdio MCP facade. Bootstrap is consumed once and never inherited by children. */
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { unlinkSync } from 'node:fs';
import { readRegularArtifact } from './lib/hardened-fs.mjs';
import { RUNTIME_BOOTSTRAP_SCHEMA_VERSION } from './lib/worker-broker.mjs';

const path = process.argv[2];
const bootstrap = JSON.parse(readRegularArtifact(path, 'runtime bootstrap', 4096).text);
unlinkSync(path);
if (bootstrap.schemaVersion !== RUNTIME_BOOTSTRAP_SCHEMA_VERSION || !Number.isInteger(bootstrap.port)
  || !/^[a-f0-9]{64}$/.test(bootstrap.token || '')) throw new Error('invalid runtime bootstrap');
const socket = connect(bootstrap.port, '127.0.0.1');
let sequence = 0, buffer = '';
const pending = new Map();
function request(value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('broker request timed out')); }, 30000);
    pending.set(id, { resolve, reject, timer });
    socket.write(JSON.stringify({ ...value, id }) + '\n');
  });
}
socket.on('data', data => {
  buffer += data.toString();
  if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) { socket.destroy(); return; }
  let boundary;
  while ((boundary = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
    let value; try { value = JSON.parse(line); } catch { socket.destroy(); return; }
    const operation = pending.get(value.id);
    if (operation) {
      clearTimeout(operation.timer); pending.delete(value.id);
      value.error ? operation.reject(new Error(value.error)) : operation.resolve(value.result);
    }
  }
});
socket.on('error', () => {});
socket.on('close', () => {
  for (const operation of pending.values()) { clearTimeout(operation.timer); operation.reject(new Error('broker disconnected')); }
  pending.clear(); process.exitCode = 1; process.stdin.destroy();
});
await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
const bound = await request({ token: bootstrap.token });
delete bootstrap.token;
const schemas = {
  spawn: { type: 'object', properties: { id: { type: 'string', description: 'Unique 16+ character lowercase hex id' },
    provider: { type: 'string', enum: ['claude', 'codex', 'gemini'] }, prompt: { type: 'string' },
    scope: { type: 'array', items: { type: 'string' } }, readOnly: { type: 'boolean' } },
    required: ['id', 'provider', 'prompt', 'scope'], additionalProperties: false },
  inspect: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  followup: { type: 'object', properties: { id: { type: 'string' }, nextId: { type: 'string' }, prompt: { type: 'string' } },
    required: ['id', 'nextId', 'prompt'], additionalProperties: false },
};
const names = bound.role === 'parent' ? ['spawn', 'inspect', 'followup', 'cancel', 'integrate', 'discard'] : [];
const descriptions = {
  spawn: 'Delegate to an admitted leaf agent in an isolated worktree. Commit a clean checkpoint first. Native child agents are disabled.',
  inspect: 'Inspect a child and collect its terminal output. Observe read-only results before finishing.',
  followup: 'Chain a new leaf task from a resolved child result and the current parent checkpoint. This is a new task, not live steering.',
  cancel: 'Cancel a child and retain its worktree for inspection.',
  integrate: 'Merge a successful, clean, scoped child branch into the parent. Re-run verification afterward.',
  discard: 'Explicitly reject a terminal child result while retaining its worktree.',
};
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (Buffer.byteLength(line) > 1024 * 1024) break;
  let call; try { call = JSON.parse(line); } catch { continue; }
  if (!Object.hasOwn(call, 'id')) continue;
  let result, error;
  try {
    if (call.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ao-runtime', version: '1' } };
    else if (call.method === 'ping') result = {};
    else if (call.method === 'tools/list') result = { tools: names.map(name => ({ name, description: descriptions[name], inputSchema: schemas[name] || schemas.inspect })) };
    else if (call.method === 'tools/call') {
      if (!names.includes(call.params?.name)) throw new Error('operation unavailable for this worker identity');
      try {
        const value = await request({ name: call.params.name, arguments: call.params.arguments });
        result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
      } catch (failure) { result = { isError: true, content: [{ type: 'text', text: failure.message }] }; }
    } else error = { code: -32601, message: 'Method not found' };
  } catch (failure) { error = { code: -32602, message: failure.message }; }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, ...(error ? { error } : { result }) }) + '\n');
}
socket.end();
