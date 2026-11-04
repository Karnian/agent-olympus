import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { submitCommand, readCommands, writeCommandResult, readCommandResult } from '../lib/supervisor-mailbox.mjs';

const identity = root => ({ projectRoot: root, runId: 'a'.repeat(16), workerRunId: 'b'.repeat(16) });
test('mailbox: generation-bound commands are immutable and idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'ao-mailbox-'));
  try {
    const id = identity(root);
    const command = submitCommand(id, { id: 'c'.repeat(32), type: 'assign', prompt: 'first' });
    assert.equal(submitCommand(id, command).id, command.id);
    assert.throws(() => submitCommand(id, { ...command, prompt: 'different' }), /conflict/);
    assert.equal(readCommands(id).length, 1);
    assert.equal(readCommands({ ...id, runId: 'd'.repeat(16) }).length, 0);
    writeCommandResult(id, command.id, { status: 'accepted' });
    assert.equal(readCommandResult(id, command.id).status, 'accepted');
    writeCommandResult(id, command.id, { status: 'completed', output: 'done' });
    assert.equal(readCommandResult(id, command.id).output, 'done');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('mailbox: rejects paths, unknown formats, invalid actions and prompt overflow', () => {
  const root = mkdtempSync(join(tmpdir(), 'ao-mailbox-'));
  try {
    const id = identity(root);
    assert.throws(() => submitCommand({ ...id, workerRunId: '../bad' }, { type: 'shutdown' }));
    assert.throws(() => submitCommand(id, { type: 'run-shell', prompt: 'x' }));
    assert.throws(() => submitCommand(id, { type: 'steer', prompt: 'x' }), /task/);
    assert.throws(() => submitCommand(id, { type: 'assign', prompt: 'x'.repeat(65537) }));
    assert.throws(() => submitCommand(id, { schemaVersion: 99, type: 'shutdown' }));
    const c = submitCommand(id, { type: 'shutdown' });
    const path = join(root, '.ao/state/supervisor', id.runId, id.workerRunId + '.mailbox', c.id + '.command.json');
    const original = readFileSync(path);
    rmSync(path); symlinkSync('/etc/passwd', path);
    assert.throws(() => readCommands(id));
    assert.ok(original.length > 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
