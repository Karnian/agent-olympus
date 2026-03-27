/**
 * Unit tests for scripts/lib/inbox-outbox.mjs
 * Uses node:test — zero npm dependencies.
 *
 * inbox-outbox.mjs uses TEAMS_DIR = '.ao/teams' (a relative constant).
 * All fs calls resolve that path relative to process.cwd() at call time.
 * We use withTmpCwd() to keep cwd pointed at a fresh temp directory for the
 * entire duration of each test so every sendMessage/readInbox call writes
 * into the isolated temp directory and never touches the real .ao/ folder.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ao-inbox-test-'));
}

async function removeTmpDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Run fn(mod, tmpDir) with process.cwd() set to a fresh temp directory.
 * A cache-buster query string forces Node to re-evaluate inbox-outbox.mjs
 * for each test so the module instance is always fresh.
 * cwd is held at tmpDir for the entire duration of fn() so that all
 * relative-path fs calls inside inbox-outbox resolve to tmpDir/.ao/teams.
 */
async function withTmpCwd(fn) {
  const tmpDir = await makeTmpDir();
  const original = process.cwd();
  process.chdir(tmpDir);
  const buster = Buffer.from(tmpDir).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
  const modPath = new URL('../lib/inbox-outbox.mjs?cb=' + buster, import.meta.url).href;
  try {
    const mod = await import(modPath);
    await fn(mod, tmpDir);
  } finally {
    process.chdir(original);
    await removeTmpDir(tmpDir);
  }
}

// ---------------------------------------------------------------------------
// Test: sendMessage → readInbox round-trip
// ---------------------------------------------------------------------------

test('sendMessage → readInbox: message is delivered to the correct inbox', async () => {
  await withTmpCwd(async ({ sendMessage, readInbox }) => {
    const msgId = sendMessage('team-a', 'alice', 'bob', { text: 'hello from alice' });
    assert.ok(typeof msgId === 'string' && msgId.length > 0, 'sendMessage should return a UUID string');

    const messages = readInbox('team-a', 'bob');
    assert.equal(messages.length, 1, 'bob should have exactly one message');
    assert.equal(messages[0].from, 'alice');
    assert.equal(messages[0].to, 'bob');
    assert.deepEqual(messages[0].body, { text: 'hello from alice' });
    assert.equal(messages[0].id, msgId);
  });
});

// ---------------------------------------------------------------------------
// Test: empty inbox returns []
// ---------------------------------------------------------------------------

test('readInbox: empty inbox returns an empty array', async () => {
  await withTmpCwd(async ({ readInbox }) => {
    const messages = readInbox('team-b', 'nobody');
    assert.deepEqual(messages, []);
  });
});

// ---------------------------------------------------------------------------
// Test: consume: true moves messages to processed/
// ---------------------------------------------------------------------------

test('readInbox consume:true: messages are moved to processed/ directory', async () => {
  await withTmpCwd(async ({ sendMessage, readInbox }, tmpDir) => {
    sendMessage('team-c', 'sender', 'receiver', 'payload-1');
    sendMessage('team-c', 'sender', 'receiver', 'payload-2');

    const consumed = readInbox('team-c', 'receiver', { consume: true });
    assert.equal(consumed.length, 2, 'both messages should be returned on consume');

    const remaining = readInbox('team-c', 'receiver');
    assert.equal(remaining.length, 0, 'inbox should be empty after consume');

    const processedDir = path.join(tmpDir, '.ao', 'teams', 'team-c', 'receiver', 'processed');
    assert.ok(existsSync(processedDir), 'processed/ directory should exist');
    const processedFiles = readdirSync(processedDir).filter(f => f.endsWith('.json'));
    assert.equal(processedFiles.length, 2, 'processed/ should contain 2 files');
  });
});

// ---------------------------------------------------------------------------
// Test: consume: true does not affect a second readInbox call (idempotent)
// ---------------------------------------------------------------------------

test('readInbox consume:true: inbox is empty on subsequent read after consume', async () => {
  await withTmpCwd(async ({ sendMessage, readInbox }) => {
    sendMessage('team-d', 'x', 'y', 'first message');
    readInbox('team-d', 'y', { consume: true });
    const second = readInbox('team-d', 'y', { consume: true });
    assert.deepEqual(second, [], 'second consume on empty inbox should return []');
  });
});

// ---------------------------------------------------------------------------
// Test: messages are sorted in chronological order (timestamp prefix)
// ---------------------------------------------------------------------------

test('readInbox: messages are returned in timestamp (chronological) order', async () => {
  await withTmpCwd(async ({ sendMessage, readInbox }) => {
    sendMessage('team-e', 'writer', 'reader', 'message-1');
    await new Promise(r => setTimeout(r, 5));
    sendMessage('team-e', 'writer', 'reader', 'message-2');
    await new Promise(r => setTimeout(r, 5));
    sendMessage('team-e', 'writer', 'reader', 'message-3');

    const messages = readInbox('team-e', 'reader');
    assert.equal(messages.length, 3);
    assert.equal(messages[0].body, 'message-1', 'first sent should be first returned');
    assert.equal(messages[1].body, 'message-2');
    assert.equal(messages[2].body, 'message-3', 'last sent should be last returned');
  });
});

// ---------------------------------------------------------------------------
// Test: messages from different senders accumulate in the same inbox
// ---------------------------------------------------------------------------

test('readInbox: messages from multiple senders accumulate in recipient inbox', async () => {
  await withTmpCwd(async ({ sendMessage, readInbox }) => {
    sendMessage('team-f', 'alice', 'charlie', 'from alice');
    sendMessage('team-f', 'bob', 'charlie', 'from bob');

    const messages = readInbox('team-f', 'charlie');
    assert.equal(messages.length, 2);
    const senders = messages.map(m => m.from).sort();
    assert.deepEqual(senders, ['alice', 'bob']);
  });
});

// ---------------------------------------------------------------------------
// Test: _file property is not exposed on returned messages
// ---------------------------------------------------------------------------

test('readInbox: returned messages do not expose internal _file property', async () => {
  await withTmpCwd(async ({ sendMessage, readInbox }) => {
    sendMessage('team-g', 'p', 'q', 'hidden file test');
    const [msg] = readInbox('team-g', 'q');
    assert.ok(!('_file' in msg), '_file should not be exposed on returned messages');
  });
});
