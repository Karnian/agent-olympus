/**
 * Unit tests for scripts/lib/session-registry.mjs
 *
 * Uses node:test — zero npm dependencies.
 * All I/O uses temporary directories; the real .ao/ directory is never touched.
 */

import { test, describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  registerSession,
  finalizeSession,
  recoverCrashedSession,
  linkRunToSession,
  getCurrentSessionId,
  listSessions,
  getSession,
  pruneSessions,
} from '../lib/session-registry.mjs';

// ---------------------------------------------------------------------------
// Temp-dir helpers
// ---------------------------------------------------------------------------

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ao-session-test-'));
}

async function removeTmpDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// registerSession + getSession
// ---------------------------------------------------------------------------

describe('session-registry: registerSession', () => {
  let tmpDir, sessionsBase, stateBase;

  before(async () => {
    tmpDir = await makeTmpDir();
    sessionsBase = tmpDir;
    stateBase = path.join(tmpDir, 'state');
    mkdirSync(stateBase, { recursive: true });
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('creates a session record file', () => {
    registerSession('sess-001', { base: sessionsBase, stateBase });

    const record = getSession('sess-001', { base: sessionsBase });
    assert.ok(record);
    assert.equal(record.sessionId, 'sess-001');
    assert.equal(record.status, 'active');
    assert.ok(record.startedAt);
    assert.equal(record.endedAt, null);
    assert.ok(Array.isArray(record.runIds));
  });

  it('sets the current-session pointer', () => {
    const id = getCurrentSessionId({ stateBase });
    assert.equal(id, 'sess-001');
  });

  it('handles null sessionId gracefully', () => {
    registerSession(null, { base: sessionsBase, stateBase });
    // Should not throw or create a file
  });

  it('handles empty sessionId gracefully', () => {
    registerSession('', { base: sessionsBase, stateBase });
  });
});

// ---------------------------------------------------------------------------
// finalizeSession
// ---------------------------------------------------------------------------

describe('session-registry: finalizeSession', () => {
  let tmpDir, sessionsBase, stateBase;

  before(async () => {
    tmpDir = await makeTmpDir();
    sessionsBase = tmpDir;
    stateBase = path.join(tmpDir, 'state');
    mkdirSync(stateBase, { recursive: true });
    registerSession('sess-fin-001', { base: sessionsBase, stateBase });
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('updates status to ended and sets endedAt', () => {
    finalizeSession('sess-fin-001', { status: 'ended', base: sessionsBase, stateBase });

    const record = getSession('sess-fin-001', { base: sessionsBase });
    assert.equal(record.status, 'ended');
    assert.ok(record.endedAt);
  });

  it('clears the current-session pointer', () => {
    const id = getCurrentSessionId({ stateBase });
    assert.equal(id, null);
  });

  it('creates minimal record when session file is missing', () => {
    finalizeSession('sess-never-registered', { status: 'crashed', base: sessionsBase, stateBase });

    const record = getSession('sess-never-registered', { base: sessionsBase });
    assert.ok(record);
    assert.equal(record.status, 'crashed');
    assert.ok(record.endedAt);
  });
});

// ---------------------------------------------------------------------------
// recoverCrashedSession
// ---------------------------------------------------------------------------

describe('session-registry: recoverCrashedSession', () => {
  let tmpDir, sessionsBase, stateBase;

  before(async () => {
    tmpDir = await makeTmpDir();
    sessionsBase = tmpDir;
    stateBase = path.join(tmpDir, 'state');
    mkdirSync(stateBase, { recursive: true });
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('returns null when no pointer exists', () => {
    const result = recoverCrashedSession({ base: sessionsBase, stateBase });
    assert.equal(result, null);
  });

  it('marks previous session as crashed and returns its ID', () => {
    // Simulate a crash: register a session, then don't finalize it
    registerSession('sess-crash-001', { base: sessionsBase, stateBase });

    // Next SessionStart calls recoverCrashedSession
    const crashedId = recoverCrashedSession({ base: sessionsBase, stateBase });
    assert.equal(crashedId, 'sess-crash-001');

    const record = getSession('sess-crash-001', { base: sessionsBase });
    assert.equal(record.status, 'crashed');
    assert.ok(record.endedAt);
  });

  it('clears the pointer after recovery', () => {
    const id = getCurrentSessionId({ stateBase });
    assert.equal(id, null);
  });
});

// ---------------------------------------------------------------------------
// linkRunToSession
// ---------------------------------------------------------------------------

describe('session-registry: linkRunToSession', () => {
  let tmpDir, sessionsBase, stateBase;

  before(async () => {
    tmpDir = await makeTmpDir();
    sessionsBase = tmpDir;
    stateBase = path.join(tmpDir, 'state');
    mkdirSync(stateBase, { recursive: true });
    registerSession('sess-run-001', { base: sessionsBase, stateBase });
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('adds runId to session record', () => {
    linkRunToSession('atlas-20260402-143022-a1b2', { base: sessionsBase, stateBase });

    const record = getSession('sess-run-001', { base: sessionsBase });
    assert.ok(record.runIds.includes('atlas-20260402-143022-a1b2'));
  });

  it('does not duplicate runIds', () => {
    linkRunToSession('atlas-20260402-143022-a1b2', { base: sessionsBase, stateBase });

    const record = getSession('sess-run-001', { base: sessionsBase });
    const count = record.runIds.filter(id => id === 'atlas-20260402-143022-a1b2').length;
    assert.equal(count, 1);
  });

  it('handles missing pointer gracefully', () => {
    // Finalize to clear pointer
    finalizeSession('sess-run-001', { base: sessionsBase, stateBase });

    // Now try to link — should not throw
    linkRunToSession('some-run', { base: sessionsBase, stateBase });
  });
});

// ---------------------------------------------------------------------------
// listSessions
// ---------------------------------------------------------------------------

describe('session-registry: listSessions', () => {
  let tmpDir, sessionsBase, stateBase;

  before(async () => {
    tmpDir = await makeTmpDir();
    sessionsBase = tmpDir;
    stateBase = path.join(tmpDir, 'state');
    mkdirSync(stateBase, { recursive: true });

    // Create several sessions with explicit timestamps to avoid timing flakiness
    const sessDir = path.join(sessionsBase, 'sessions');
    mkdirSync(sessDir, { recursive: true });

    writeFileSync(path.join(sessDir, 'sess-list-001.json'), JSON.stringify({
      sessionId: 'sess-list-001', startedAt: '2026-01-01T10:00:00Z',
      endedAt: '2026-01-01T11:00:00Z', status: 'ended', runIds: [],
    }));
    writeFileSync(path.join(sessDir, 'sess-list-002.json'), JSON.stringify({
      sessionId: 'sess-list-002', startedAt: '2026-02-01T10:00:00Z',
      endedAt: '2026-02-01T11:00:00Z', status: 'ended', runIds: [],
    }));
    writeFileSync(path.join(sessDir, 'sess-list-003.json'), JSON.stringify({
      sessionId: 'sess-list-003', startedAt: '2026-03-01T10:00:00Z',
      endedAt: null, status: 'active', runIds: [],
    }));
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('returns all sessions sorted by startedAt descending', () => {
    const sessions = listSessions({ base: sessionsBase });
    assert.ok(sessions.length >= 3);
    // Most recent should be first
    assert.equal(sessions[0].sessionId, 'sess-list-003');
  });

  it('respects limit', () => {
    const sessions = listSessions({ base: sessionsBase, limit: 2 });
    assert.equal(sessions.length, 2);
  });

  it('filters by status', () => {
    const sessions = listSessions({ base: sessionsBase, status: 'active' });
    assert.ok(sessions.length >= 1);
    assert.ok(sessions.every(s => s.status === 'active'));
  });

  it('returns empty array when directory does not exist', () => {
    const sessions = listSessions({ base: '/nonexistent/path' });
    assert.deepEqual(sessions, []);
  });
});

// ---------------------------------------------------------------------------
// pruneSessions
// ---------------------------------------------------------------------------

describe('session-registry: pruneSessions', () => {
  let tmpDir, sessionsBase;

  before(async () => {
    tmpDir = await makeTmpDir();
    sessionsBase = tmpDir;

    // Create a session and backdate it to 100 days ago
    const sessDir = path.join(sessionsBase, 'sessions');
    mkdirSync(sessDir, { recursive: true });

    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      path.join(sessDir, 'sess-old.json'),
      JSON.stringify({ sessionId: 'sess-old', startedAt: oldDate, status: 'ended' }),
    );

    const recentDate = new Date().toISOString();
    writeFileSync(
      path.join(sessDir, 'sess-recent.json'),
      JSON.stringify({ sessionId: 'sess-recent', startedAt: recentDate, status: 'ended' }),
    );
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('removes sessions older than maxAgeDays', () => {
    const pruned = pruneSessions({ maxAgeDays: 90, base: sessionsBase });
    assert.equal(pruned, 1);

    // Old session should be gone
    assert.equal(existsSync(path.join(sessionsBase, 'sessions', 'sess-old.json')), false);
    // Recent session should remain
    assert.equal(existsSync(path.join(sessionsBase, 'sessions', 'sess-recent.json')), true);
  });

  it('returns 0 when nothing to prune', () => {
    const pruned = pruneSessions({ maxAgeDays: 90, base: sessionsBase });
    assert.equal(pruned, 0);
  });
});
