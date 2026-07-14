/**
 * Pure, checkpoint-friendly START handshake for Athena native teammates.
 *
 * The lead persists the initial `pending` ledger before sending anything.
 * Workers acknowledge an exact deterministic token and remain idle. Only after
 * the lead persists the `acked` transition may it send START_CONFIRMED, which
 * is the worker's authorization to touch the worktree. A crash may therefore
 * resend either message without creating a second logical execution.
 */

import { createHash } from 'node:crypto';

const RUN_ID = /^athena-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WORKER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SESSION_ID = /^[\x21-\x7e]{1,256}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const START_TOKEN = /^ao-start-v1-[0-9a-f]{64}$/;
const STATES = new Set(['pending', 'sent', 'acked']);
const MAX_EXECUTION_CONTEXT_BYTES = 256 * 1024;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isPlainObject(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function canonicalWorkerNames(workerNames) {
  if (!Array.isArray(workerNames) || workerNames.length === 0 || workerNames.length > 256
    || workerNames.some(name => !WORKER_NAME.test(name || ''))
    || new Set(workerNames).size !== workerNames.length) {
    throw new Error('Athena START worker names are invalid');
  }
  return [...workerNames].sort();
}

export function computeAthenaStartToken({
  runId,
  workerName,
  prdGeneration,
  worktreeDigest,
} = {}) {
  if (!RUN_ID.test(runId || '')
    || !WORKER_NAME.test(workerName || '')
    || !SHA256.test(prdGeneration || '')
    || !SHA256.test(worktreeDigest || '')) {
    throw new Error('Athena START token identity is invalid');
  }
  const digest = createHash('sha256').update(JSON.stringify([
    'AO_ATHENA_START_V1',
    runId,
    workerName,
    prdGeneration,
    worktreeDigest,
  ]), 'utf8').digest('hex');
  return `ao-start-v1-${digest}`;
}

export function assertAthenaStartLedger(ledger) {
  if (!exactKeys(ledger, [
    'schemaVersion',
    'runId',
    'nativeSessionId',
    'prdGeneration',
    'worktreeDigest',
    'workerNames',
    'workers',
  ])
    || ledger.schemaVersion !== 1
    || !RUN_ID.test(ledger.runId || '')
    || !SESSION_ID.test(ledger.nativeSessionId || '')
    || !SHA256.test(ledger.prdGeneration || '')
    || !SHA256.test(ledger.worktreeDigest || '')) {
    throw new Error('Athena START ledger identity is invalid');
  }
  const names = canonicalWorkerNames(ledger.workerNames);
  if (JSON.stringify(names) !== JSON.stringify(ledger.workerNames)
    || !isPlainObject(ledger.workers)
    || JSON.stringify(Object.keys(ledger.workers).sort()) !== JSON.stringify(names)) {
    throw new Error('Athena START ledger roster is invalid');
  }
  for (const workerName of names) {
    const worker = ledger.workers[workerName];
    if (!exactKeys(worker, ['startToken', 'state', 'sendAttempts'])
      || !START_TOKEN.test(worker.startToken || '')
      || !STATES.has(worker.state)
      || !Number.isSafeInteger(worker.sendAttempts)
      || worker.sendAttempts < 0
      || (worker.state === 'pending' && worker.sendAttempts !== 0)
      || (worker.state !== 'pending' && worker.sendAttempts < 1)
      || worker.startToken !== computeAthenaStartToken({
        runId: ledger.runId,
        workerName,
        prdGeneration: ledger.prdGeneration,
        worktreeDigest: ledger.worktreeDigest,
      })) {
      throw new Error(`Athena START ledger entry is invalid for ${workerName}`);
    }
  }
  return true;
}

function frozenLedger(ledger) {
  assertAthenaStartLedger(ledger);
  return Object.freeze(structuredClone(ledger));
}

export function initializeAthenaStartLedger({
  runId,
  nativeSessionId,
  prdGeneration,
  worktreeDigest,
  workerNames,
} = {}) {
  const names = canonicalWorkerNames(workerNames);
  if (!RUN_ID.test(runId || '')
    || !SESSION_ID.test(nativeSessionId || '')
    || !SHA256.test(prdGeneration || '')
    || !SHA256.test(worktreeDigest || '')) {
    throw new Error('Athena START initialization identity is invalid');
  }
  return frozenLedger({
    schemaVersion: 1,
    runId,
    nativeSessionId,
    prdGeneration,
    worktreeDigest,
    workerNames: names,
    workers: Object.fromEntries(names.map(workerName => [workerName, {
      startToken: computeAthenaStartToken({
        runId,
        workerName,
        prdGeneration,
        worktreeDigest,
      }),
      state: 'pending',
      sendAttempts: 0,
    }])),
  });
}

function mutateEntry(ledger, workerName, update) {
  assertAthenaStartLedger(ledger);
  if (!Object.hasOwn(ledger.workers, workerName)) {
    throw new Error(`Unknown Athena START worker: ${workerName}`);
  }
  const next = structuredClone(ledger);
  next.workers[workerName] = update(next.workers[workerName]);
  return frozenLedger(next);
}

/** Record a successful START delivery. Repeated delivery uses the same token. */
export function markAthenaStartSent(ledger, workerName) {
  return mutateEntry(ledger, workerName, current => {
    if (current.state === 'acked') return current;
    return {
      ...current,
      state: 'sent',
      sendAttempts: current.sendAttempts + 1,
    };
  });
}

export function expectedAthenaStartAck(ledger, workerName) {
  assertAthenaStartLedger(ledger);
  const worker = ledger.workers[workerName];
  if (!worker) throw new Error(`Unknown Athena START worker: ${workerName}`);
  return `START_ACK ${worker.startToken}`;
}

/** Accept only the exact one-line ACK from the bound native session. */
export function acknowledgeAthenaStart(ledger, {
  workerName,
  nativeSessionId,
  message,
} = {}) {
  assertAthenaStartLedger(ledger);
  if (nativeSessionId !== ledger.nativeSessionId) {
    throw new Error('Athena START ACK belongs to a different native session');
  }
  if (message !== expectedAthenaStartAck(ledger, workerName)) {
    throw new Error(`Athena START ACK is invalid for ${workerName}`);
  }
  if (ledger.workers[workerName].state === 'pending') {
    throw new Error(`Athena START ACK arrived before durable delivery for ${workerName}`);
  }
  return mutateEntry(ledger, workerName, current => ({
    ...current,
    state: 'acked',
    sendAttempts: Math.max(1, current.sendAttempts),
  }));
}

export function buildAthenaStartMessage(ledger, workerName, executionContext) {
  assertAthenaStartLedger(ledger);
  const worker = ledger.workers[workerName];
  if (!worker) throw new Error(`Unknown Athena START worker: ${workerName}`);
  if (typeof executionContext !== 'string'
    || executionContext.length === 0
    || executionContext.includes('\0')
    || Buffer.byteLength(executionContext, 'utf8') > MAX_EXECUTION_CONTEXT_BYTES) {
    throw new Error('Athena START execution context is invalid');
  }
  return [
    'START AO_ATHENA_START_V1',
    `startToken=${worker.startToken}`,
    executionContext,
    `Before reading, editing, testing, or committing any project file, reply exactly: ${expectedAthenaStartAck(ledger, workerName)}`,
    `After that ACK, remain idle until you receive exactly: START_CONFIRMED ${worker.startToken}`,
    'Duplicate START or START_CONFIRMED messages with this same token are retries of the same execution and must never restart work.',
  ].join('\n');
}

export function buildAthenaStartConfirmation(ledger, workerName) {
  assertAthenaStartLedger(ledger);
  const worker = ledger.workers[workerName];
  if (!worker) throw new Error(`Unknown Athena START worker: ${workerName}`);
  if (worker.state !== 'acked') {
    throw new Error(`Athena START is not durably acknowledged for ${workerName}`);
  }
  return `START_CONFIRMED ${worker.startToken}`;
}

/**
 * Resume is legal only in the exact native session. Pending/sent STARTs are
 * retried; acked workers receive an idempotent confirmation retry.
 */
export function planAthenaStartResume(ledger, { nativeSessionId } = {}) {
  assertAthenaStartLedger(ledger);
  if (nativeSessionId !== ledger.nativeSessionId) {
    throw new Error('Athena START recovery crossed native sessions');
  }
  const resendStart = [];
  const resendConfirmation = [];
  for (const workerName of ledger.workerNames) {
    if (ledger.workers[workerName].state === 'acked') resendConfirmation.push(workerName);
    else resendStart.push(workerName);
  }
  return Object.freeze({
    resendStart: Object.freeze(resendStart),
    resendConfirmation: Object.freeze(resendConfirmation),
  });
}

export function allAthenaStartsAcknowledged(ledger) {
  assertAthenaStartLedger(ledger);
  return ledger.workerNames.every(workerName => ledger.workers[workerName].state === 'acked');
}
