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

// ---------------------------------------------------------------------------
// Blackboard tests
// ---------------------------------------------------------------------------

test('writeBlackboard: creates entry with correct shape', async () => {
  await withTmpCwd(async ({ writeBlackboard, readBlackboard }) => {
    const id = writeBlackboard('team-bb1', 'worker-a', { category: 'discovery', content: 'Found a bug' });
    assert.ok(typeof id === 'string' && id.length > 0, 'writeBlackboard should return a UUID string');

    const entries = readBlackboard('team-bb1');
    assert.equal(entries.length, 1);
    const e = entries[0];
    assert.equal(e.id, id);
    assert.equal(e.from, 'worker-a');
    assert.equal(e.category, 'discovery');
    assert.equal(e.content, 'Found a bug');
    assert.ok(typeof e.timestamp === 'string' && e.timestamp.length > 0, 'entry should have a timestamp');
  });
});

test('readBlackboard: returns all written entries', async () => {
  await withTmpCwd(async ({ writeBlackboard, readBlackboard }) => {
    writeBlackboard('team-bb2', 'worker-a', { category: 'decision', content: 'Use REST' });
    writeBlackboard('team-bb2', 'worker-a', { category: 'warning', content: 'Rate limit' });

    const entries = readBlackboard('team-bb2');
    assert.equal(entries.length, 2);
  });
});

test('readBlackboard: category filter returns only matching entries', async () => {
  await withTmpCwd(async ({ writeBlackboard, readBlackboard }) => {
    writeBlackboard('team-bb3', 'worker-a', { category: 'discovery', content: 'D1' });
    writeBlackboard('team-bb3', 'worker-a', { category: 'warning', content: 'W1' });
    writeBlackboard('team-bb3', 'worker-a', { category: 'discovery', content: 'D2' });

    const discoveries = readBlackboard('team-bb3', { category: 'discovery' });
    assert.equal(discoveries.length, 2);
    assert.ok(discoveries.every(e => e.category === 'discovery'), 'all returned entries should be discoveries');

    const warnings = readBlackboard('team-bb3', { category: 'warning' });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].content, 'W1');
  });
});

test('readBlackboard: limit returns most recent N entries', async () => {
  await withTmpCwd(async ({ writeBlackboard, readBlackboard }) => {
    writeBlackboard('team-bb4', 'worker-a', { category: 'api-note', content: 'note-1' });
    writeBlackboard('team-bb4', 'worker-a', { category: 'api-note', content: 'note-2' });
    writeBlackboard('team-bb4', 'worker-a', { category: 'api-note', content: 'note-3' });
    writeBlackboard('team-bb4', 'worker-a', { category: 'api-note', content: 'note-4' });
    writeBlackboard('team-bb4', 'worker-a', { category: 'api-note', content: 'note-5' });

    const recent = readBlackboard('team-bb4', { limit: 2 });
    assert.equal(recent.length, 2);
    // Most recent 2 should be note-4 and note-5
    assert.equal(recent[0].content, 'note-4');
    assert.equal(recent[1].content, 'note-5');
  });
});

test('readBlackboard: since filters to entries after the given time', async () => {
  await withTmpCwd(async ({ writeBlackboard, readBlackboard }) => {
    writeBlackboard('team-bb5', 'worker-a', { category: 'decision', content: 'before' });

    // Capture a timestamp between the two writes
    await new Promise(r => setTimeout(r, 10));
    const cutoff = new Date().toISOString();
    await new Promise(r => setTimeout(r, 10));

    writeBlackboard('team-bb5', 'worker-a', { category: 'decision', content: 'after' });

    const entries = readBlackboard('team-bb5', { since: cutoff });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].content, 'after');
  });
});

test('readBlackboard: returns [] for nonexistent team', async () => {
  await withTmpCwd(async ({ readBlackboard }) => {
    const entries = readBlackboard('team-does-not-exist');
    assert.deepEqual(entries, []);
  });
});

test('writeBlackboard: multiple workers can write to the same blackboard', async () => {
  await withTmpCwd(async ({ writeBlackboard, readBlackboard }) => {
    writeBlackboard('team-bb6', 'alice', { category: 'discovery', content: 'Alice found X' });
    writeBlackboard('team-bb6', 'bob', { category: 'warning', content: 'Bob warns Y' });
    writeBlackboard('team-bb6', 'charlie', { category: 'decision', content: 'Charlie decided Z' });

    const entries = readBlackboard('team-bb6');
    assert.equal(entries.length, 3);

    const authors = entries.map(e => e.from).sort();
    assert.deepEqual(authors, ['alice', 'bob', 'charlie']);
  });
});

test('cleanupTeam: removes blackboard along with other team files', async () => {
  await withTmpCwd(async ({ writeBlackboard, sendMessage, cleanupTeam, readBlackboard }, tmpDir) => {
    writeBlackboard('team-bb7', 'worker-a', { category: 'discovery', content: 'Something' });
    sendMessage('team-bb7', 'worker-a', 'worker-b', 'hello');

    // Verify team dir exists
    const teamPath = path.join(tmpDir, '.ao', 'teams', 'team-bb7');
    assert.ok(existsSync(teamPath), 'team directory should exist before cleanup');

    cleanupTeam('team-bb7');
    assert.ok(!existsSync(teamPath), 'team directory should be gone after cleanup');

    // readBlackboard should return [] after cleanup
    const entries = readBlackboard('team-bb7');
    assert.deepEqual(entries, []);
  });
});

test('writeBlackboard: missing category defaults to "general"', async () => {
  await withTmpCwd(async ({ writeBlackboard, readBlackboard }) => {
    // Pass entry without a category field
    writeBlackboard('team-bb8', 'worker-a', { content: 'no category here' });

    const entries = readBlackboard('team-bb8');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].category, 'general');
  });
});

test('writeBlackboard: entry IDs are unique UUIDs', async () => {
  await withTmpCwd(async ({ writeBlackboard, readBlackboard }) => {
    const id1 = writeBlackboard('team-bb9', 'worker-a', { category: 'discovery', content: 'A' });
    const id2 = writeBlackboard('team-bb9', 'worker-a', { category: 'discovery', content: 'B' });
    const id3 = writeBlackboard('team-bb9', 'worker-a', { category: 'discovery', content: 'C' });

    // All IDs must be distinct strings
    const ids = [id1, id2, id3];
    assert.equal(new Set(ids).size, 3, 'all entry IDs should be unique');

    // UUID format: 8-4-4-4-12 hex chars
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const id of ids) {
      assert.match(id, uuidRe, `ID ${id} should be a valid UUID`);
    }

    // IDs in the file should also match
    const entries = readBlackboard('team-bb9');
    const fileIds = entries.map(e => e.id);
    assert.deepEqual(fileIds, ids);
  });
});
