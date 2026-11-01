/** Generation-bound durable command ingress. No live adapter handles cross this boundary. */
import { randomBytes } from 'node:crypto';
import { readdirSync, unlinkSync, mkdirSync, rmdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { supervisorRunDir, isValidId } from './supervisor-state.mjs';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import {
  ensureSafeDirectoryPath, revalidateDirectoryBinding, readRegularArtifact,
  writeExclusiveRegularArtifact,
} from './hardened-fs.mjs';

export const MAILBOX_SCHEMA_VERSION = 1;
const MAX_BYTES = 1024 * 1024;
const ACTIONS = new Set(['assign', 'steer', 'interrupt', 'shutdown']);
const STATUSES = new Set(['accepted', 'completed', 'failed', 'cancelled', 'rejected']);

function binding(identity) {
  if (!identity || !isValidId(identity.workerRunId)) throw new Error('invalid workerRunId');
  const dir = join(supervisorRunDir(identity.projectRoot, identity.runId), `${identity.workerRunId}.mailbox`);
  return ensureSafeDirectoryPath(dir, 'supervisor mailbox', { trustedRoot: identity.projectRoot });
}

function readBound(file, context) {
  const artifact = readRegularArtifact(file, 'mailbox artifact', MAX_BYTES, {
    allowMissing: true, generationPolicy: 'full',
    revalidateContext: () => revalidateDirectoryBinding(context, 'supervisor mailbox'),
  });
  return artifact.present ? JSON.parse(artifact.text) : null;
}

function validateCommand(value, identity) {
  if (!value || value.schemaVersion !== MAILBOX_SCHEMA_VERSION
    || !isValidId(value.id) || value.runId !== identity.runId
    || value.workerRunId !== identity.workerRunId || !ACTIONS.has(value.type)
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) {
    throw new Error('invalid or unsupported mailbox command');
  }
  if (['assign', 'steer'].includes(value.type)
    && (typeof value.prompt !== 'string' || !value.prompt.trim()
      || Buffer.byteLength(value.prompt) > 65536)) throw new Error('invalid command prompt');
  if (['steer', 'interrupt'].includes(value.type) && !isValidId(value.expectedTaskId)) {
    throw new Error('command requires an expected task identity');
  }
  return value;
}

export function submitCommand(identity, input) {
  if (input.schemaVersion !== undefined && input.schemaVersion !== MAILBOX_SCHEMA_VERSION) {
    throw new Error('unsupported command schemaVersion');
  }
  const context = binding(identity);
  const command = validateCommand({
    schemaVersion: MAILBOX_SCHEMA_VERSION,
    id: input.id || randomBytes(16).toString('hex'),
    runId: identity.runId, workerRunId: identity.workerRunId,
    type: input.type, createdAt: input.createdAt ?? Date.now(),
    ...(['assign', 'steer'].includes(input.type) ? { prompt: input.prompt } : {}),
    ...(input.expectedTaskId ? { expectedTaskId: input.expectedTaskId } : {}),
  }, identity);
  const path = join(context.path, `${command.id}.command.json`);
  const publicationLock = join(context.path, `.publish-${command.id}.lock`);
  const existingCommand = () => {
    const raw = readBound(path, context);
    if (!raw) return null;
    const existing = validateCommand(raw, identity);
    if (JSON.stringify({ ...existing, createdAt: 0 }) !== JSON.stringify({ ...command, createdAt: 0 })) {
      throw new Error('command id conflict');
    }
    return existing;
  };
  try { mkdirSync(publicationLock, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const prior = existingCommand();
    if (prior) return prior;
    throw new Error('command publication in progress or interrupted; retry after reconciliation');
  }
  // Serialize publishers of the same id, then atomically publish an fsynced
  // single-link file. Readers cannot observe partial writes or the nlink=2
  // interval of hard-link publication, which hardened readers rightly reject.
  const candidate = join(context.path, `.publish-${randomBytes(16).toString('hex')}`);
  try {
    const prior = existingCommand();
    if (prior) return prior;
    writeExclusiveRegularArtifact(candidate, 'mailbox publication', JSON.stringify(command), MAX_BYTES);
    revalidateDirectoryBinding(context, 'supervisor mailbox');
    renameSync(candidate, path);
    revalidateDirectoryBinding(context, 'supervisor mailbox');
    return command;
  } finally {
    try { unlinkSync(candidate); } catch {}
    rmdirSync(publicationLock);
  }
}

export function readCommands(identity) {
  const context = binding(identity);
  const files = readdirSync(context.path).filter(name => /^[0-9a-f]{8,64}\.command\.json$/.test(name));
  if (files.length > 10000) throw new Error('mailbox command limit exceeded');
  return files.map(file => validateCommand(readBound(join(context.path, file), context), identity))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function readCommandResult(identity, commandId) {
  if (!isValidId(commandId)) throw new Error('invalid command id');
  const context = binding(identity);
  const value = readBound(join(context.path, `${commandId}.result.json`), context);
  if (!value) return null;
  if (value.schemaVersion !== MAILBOX_SCHEMA_VERSION || value.id !== commandId
    || value.runId !== identity.runId || value.workerRunId !== identity.workerRunId
    || !STATUSES.has(value.status)) throw new Error('invalid or unsupported command result');
  return value;
}

export function writeCommandResult(identity, commandId, result) {
  if (!isValidId(commandId) || !STATUSES.has(result.status)) throw new Error('invalid command result');
  const context = binding(identity);
  const path = join(context.path, `${commandId}.result.json`);
  const prior = readCommandResult(identity, commandId);
  if (prior && prior.status !== 'accepted') return prior;
  const value = {
    schemaVersion: MAILBOX_SCHEMA_VERSION, id: commandId,
    runId: identity.runId, workerRunId: identity.workerRunId,
    status: result.status, updatedAt: Date.now(),
    ...(typeof result.output === 'string' ? { output: result.output } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error('command result exceeds byte limit');
  revalidateDirectoryBinding(context, 'supervisor mailbox');
  atomicWriteFileSync(path, serialized, { durable: true });
  revalidateDirectoryBinding(context, 'supervisor mailbox');
  return value;
}
