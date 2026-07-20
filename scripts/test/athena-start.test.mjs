import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acknowledgeAthenaStart,
  allAthenaStartsAcknowledged,
  assertAthenaStartLedger,
  buildAthenaStartConfirmation,
  buildAthenaStartMessage,
  computeAthenaStartToken,
  expectedAthenaStartAck,
  initializeAthenaStartLedger,
  markAthenaStartSent,
  planAthenaStartResume,
} from '../lib/athena-start.mjs';

const IDENTITY = Object.freeze({
  runId: 'athena-20260715-120000-abcd',
  nativeSessionId: 'session-123',
  prdGeneration: 'a'.repeat(64),
  worktreeDigest: 'b'.repeat(64),
  workerNames: ['worker-b', 'worker-a'],
});

test('Athena START tokens are deterministic and bind run, worker, PRD, and worktrees', () => {
  const first = initializeAthenaStartLedger(IDENTITY);
  const second = initializeAthenaStartLedger({
    ...IDENTITY,
    workerNames: [...IDENTITY.workerNames].reverse(),
  });
  assert.deepEqual(first, second);
  assert.deepEqual(first.workerNames, ['worker-a', 'worker-b']);
  assert.equal(first.workers['worker-a'].startToken, computeAthenaStartToken({
    runId: IDENTITY.runId,
    workerName: 'worker-a',
    prdGeneration: IDENTITY.prdGeneration,
    worktreeDigest: IDENTITY.worktreeDigest,
  }));
  assert.notEqual(
    first.workers['worker-a'].startToken,
    initializeAthenaStartLedger({
      ...IDENTITY,
      worktreeDigest: 'c'.repeat(64),
    }).workers['worker-a'].startToken,
  );
});

test('Athena START survives a crash after the first send with same-session idempotent retry', () => {
  const initial = initializeAthenaStartLedger(IDENTITY);
  const beforeFirstSendCheckpoint = structuredClone(initial);
  const sent = markAthenaStartSent(initial, 'worker-a');
  assert.equal(sent.workers['worker-a'].state, 'sent');
  assert.equal(sent.workers['worker-a'].sendAttempts, 1);

  // Simulate a crash after delivery but before the updated checkpoint write:
  // recovery sees the original pending ledger and resends the exact token.
  const recovery = planAthenaStartResume(beforeFirstSendCheckpoint, {
    nativeSessionId: IDENTITY.nativeSessionId,
  });
  assert.deepEqual(recovery.resendStart, ['worker-a', 'worker-b']);
  const firstMessage = buildAthenaStartMessage(initial, 'worker-a', '{"scope":["src/a.mjs"]}');
  const retryMessage = buildAthenaStartMessage(
    beforeFirstSendCheckpoint,
    'worker-a',
    '{"scope":["src/a.mjs"]}',
  );
  assert.equal(retryMessage, firstMessage);
  assert.match(firstMessage, /Before reading, editing, testing, or committing/);
  assert.match(firstMessage, /remain idle until you receive exactly: START_CONFIRMED/);
});

test('Athena START requires exact ACK, persists acked state, then releases work', () => {
  let ledger = initializeAthenaStartLedger(IDENTITY);
  assert.throws(
    () => acknowledgeAthenaStart(ledger, {
      workerName: 'worker-a',
      nativeSessionId: IDENTITY.nativeSessionId,
      message: expectedAthenaStartAck(ledger, 'worker-a'),
    }),
    /before durable delivery/,
  );
  ledger = markAthenaStartSent(ledger, 'worker-a');
  assert.throws(
    () => acknowledgeAthenaStart(ledger, {
      workerName: 'worker-a',
      nativeSessionId: IDENTITY.nativeSessionId,
      message: `${expectedAthenaStartAck(ledger, 'worker-a')} trailing`,
    }),
    /ACK is invalid/,
  );
  assert.throws(
    () => buildAthenaStartConfirmation(ledger, 'worker-a'),
    /not durably acknowledged/,
  );

  ledger = markAthenaStartSent(ledger, 'worker-b');
  ledger = acknowledgeAthenaStart(ledger, {
    workerName: 'worker-a',
    nativeSessionId: IDENTITY.nativeSessionId,
    message: expectedAthenaStartAck(ledger, 'worker-a'),
  });
  assert.equal(ledger.workers['worker-a'].state, 'acked');
  assert.equal(
    buildAthenaStartConfirmation(ledger, 'worker-a'),
    `START_CONFIRMED ${ledger.workers['worker-a'].startToken}`,
  );
  assert.deepEqual(planAthenaStartResume(ledger, {
    nativeSessionId: IDENTITY.nativeSessionId,
  }), {
    resendStart: ['worker-b'],
    resendConfirmation: ['worker-a'],
  });
  assert.equal(allAthenaStartsAcknowledged(ledger), false);

  ledger = acknowledgeAthenaStart(ledger, {
    workerName: 'worker-b',
    nativeSessionId: IDENTITY.nativeSessionId,
    message: expectedAthenaStartAck(ledger, 'worker-b'),
  });
  assert.equal(allAthenaStartsAcknowledged(ledger), true);
});

test('Athena START resume and ACK fail closed across native sessions', () => {
  const ledger = initializeAthenaStartLedger(IDENTITY);
  assert.throws(
    () => planAthenaStartResume(ledger, { nativeSessionId: 'different-session' }),
    /crossed native sessions/,
  );
  assert.throws(
    () => acknowledgeAthenaStart(ledger, {
      workerName: 'worker-a',
      nativeSessionId: 'different-session',
      message: expectedAthenaStartAck(ledger, 'worker-a'),
    }),
    /different native session/,
  );
});

test('Athena START ledger rejects token, roster, and state tampering', () => {
  const ledger = structuredClone(initializeAthenaStartLedger(IDENTITY));
  ledger.workers['worker-a'].startToken = `ao-start-v1-${'f'.repeat(64)}`;
  assert.throws(() => assertAthenaStartLedger(ledger), /entry is invalid/);

  const invalidAcked = structuredClone(initializeAthenaStartLedger(IDENTITY));
  invalidAcked.workers['worker-a'].state = 'acked';
  assert.throws(() => assertAthenaStartLedger(invalidAcked), /entry is invalid/);
});
