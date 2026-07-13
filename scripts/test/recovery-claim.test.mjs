import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { acquireRecoveryClaim } from '../lib/recovery-claim.mjs';
import {
  acquireRunFinalizationLock,
  holdsRunFinalizationLock,
  isValidRunFinalizationLockOwner,
  releaseRunFinalizationLock,
} from '../lib/run-finalization-lock.mjs';

test('one stale generation elects exactly one permanent recovery claim', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ao-recovery-claim-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = acquireRecoveryClaim(dir, 'queue', 'old-token');
  const second = acquireRecoveryClaim(dir, 'queue', 'old-token');
  const nextGeneration = acquireRecoveryClaim(dir, 'queue', 'new-token');
  assert.equal(first.won, true);
  assert.equal(second.won, false);
  assert.equal(second.path, first.path);
  assert.equal(nextGeneration.won, true);
  assert.equal(readdirSync(dir).filter(name => name.endsWith('.claim')).length, 2);
  if (process.platform !== 'win32') assert.equal(lstatSync(first.path).mode & 0o777, 0o600);
});

test('PID 1 is a valid non-signalling lock owner', () => {
  assert.equal(isValidRunFinalizationLockOwner({
    schemaVersion: 1,
    token: '12345678-1234-4123-8123-123456789abc',
    pid: 1,
    startId: null,
    createdAt: new Date().toISOString(),
  }), true);
});

test('an observer of an old generation cannot remove its replacement owner', (t) => {
  const runDir = mkdtempSync(path.join(tmpdir(), 'ao-finalize-generation-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  const lockDir = path.join(runDir, '.terminal-failure.lock');
  mkdirSync(lockDir, { mode: 0o700 });
  const oldToken = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
    schemaVersion: 1,
    token: oldToken,
    pid: 999_999_999,
    startId: null,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  }), { mode: 0o600 });

  const replacement = acquireRunFinalizationLock(runDir);
  assert.equal(holdsRunFinalizationLock(runDir, replacement), true);
  assert.equal(acquireRecoveryClaim(runDir, 'run-finalize', oldToken).won, false);
  assert.throws(() => acquireRunFinalizationLock(runDir), /already in progress/);
  assert.equal(holdsRunFinalizationLock(runDir, replacement), true);
  assert.equal(releaseRunFinalizationLock(runDir, replacement), true);
});
