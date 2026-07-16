import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { basename, join, resolve } from 'node:path';

import { atomicWriteFileSync } from './fs-atomic.mjs';
import {
  readRegularArtifact,
  revalidateRegularArtifact,
  writeExclusiveRegularArtifact,
} from './hardened-fs.mjs';
import { readProcStartId } from './proc-identity.mjs';
import {
  snapshotPath as supervisorSnapshotPath,
  SUPERVISOR_SCHEMA_VERSION,
} from './supervisor-state.mjs';

export const DEFAULT_CONCURRENCY_LIMITS = Object.freeze({
  global: 10,
  claude: 8,
  codex: 5,
  gemini: 5,
});

// v2 makes the fail-closed recovery barrier visible to older readers. The v1
// reader rejects v2 instead of silently discarding the v2-only `recovery`
// metadata and authorizing work from an apparently empty ledger.
export const CONCURRENCY_SCHEMA_VERSION = 2;
const LEGACY_CONCURRENCY_SCHEMA_VERSION = 1;

const STALE_HOOK_MS = 3 * 60 * 1000;
const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 5000;
const MAX_LEDGER_BYTES = 1024 * 1024;
const MAX_TEAM_STATE_BYTES = 4 * 1024 * 1024;
const MAX_SUPERVISOR_SNAPSHOT_BYTES = 64 * 1024;
const LEDGER_CONTENT_ERROR = 'AO_CONCURRENCY_LEDGER_CONTENT';
const CONCURRENCY_STATE_ERROR = 'AO_CONCURRENCY_STATE_UNAVAILABLE';
const PROVIDERS = new Set(['claude', 'codex', 'gemini']);
const TERMINAL_WORKER_STATUSES = new Set(['completed', 'failed', 'cancelled', 'canceled', 'stopped']);
const SAFE_TEAM_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODULE_PLUGIN_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

function stripJsoncComments(source) {
  let result = source.replace(/\/\*[\s\S]*?\*\//g, '');
  result = result.replace(/\/\/[^\n]*/g, '');
  return result;
}

function positiveInteger(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function emptyCounts() {
  return { global: 0, claude: 0, codex: 0, gemini: 0 };
}

function infinityCounts() {
  return { global: Infinity, claude: Infinity, codex: Infinity, gemini: Infinity };
}

function sleepSync(ms) {
  Atomics.wait(SLEEP_CELL, 0, 0, ms);
}

function assertSafeDirectory(path, label) {
  const stat = lstatSync(path);
  const wrongOwner = typeof process.getuid === 'function' && stat.uid !== process.getuid();
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || wrongOwner
    || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700)) {
    throw new Error(`${label} (${path}) is unsafe`);
  }
  return stat;
}

function ensurePrivateDirectory(path, label) {
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  return assertSafeDirectory(path, label);
}

function ledgerPaths(cwd) {
  const projectRoot = resolve(cwd || process.cwd());
  const aoDir = join(projectRoot, '.ao');
  const stateDir = join(aoDir, 'state');
  return {
    projectRoot,
    aoDir,
    stateDir,
    ledgerPath: join(stateDir, 'ao-concurrency.json'),
    lockPath: join(stateDir, 'ao-concurrency.lock'),
    reclaimPath: join(stateDir, 'ao-concurrency.reclaim'),
  };
}

function ensureLedgerDirectories(paths) {
  ensurePrivateDirectory(paths.aoDir, '.ao directory');
  ensurePrivateDirectory(paths.stateDir, 'concurrency state directory');
}

function assertCurrentOwner(stat, path, label) {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} (${path}) has the wrong owner`);
  }
}

function contentError(message, artifact) {
  const error = new Error(message);
  error.code = LEDGER_CONTENT_ERROR;
  error.artifact = artifact;
  return error;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function stateUnavailableError(paths, cause) {
  if (cause?.code === CONCURRENCY_STATE_ERROR) return cause;
  const detail = cause?.message || String(cause);
  const error = new Error(
    `concurrency state unavailable (state: ${paths.stateDir}; ledger: ${paths.ledgerPath}): `
    + `${detail}. Remediation: restore owner-only access (0700 directories, 0600 single-link `
    + `regular files), repair or remove the unsafe artifact, then retry`,
  );
  error.code = CONCURRENCY_STATE_ERROR;
  error.cause = cause;
  return error;
}

function readSafeJson(path, label, maxBytes) {
  const { text } = readRegularArtifact(path, label, maxBytes, {
    generationPolicy: 'full',
  });
  try { return JSON.parse(text); }
  catch { throw new Error(`${label} is malformed`); }
}

function processDefinitelyGone(pid, expectedStartId) {
  if (!Number.isInteger(pid) || pid <= 1) return true;
  const currentStartId = readProcStartId(pid);
  if (expectedStartId && currentStartId && expectedStartId !== currentStartId) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

function inspectExistingLock(lockPath) {
  assertSafeDirectory(lockPath, 'concurrency lock');
  const ownerPath = join(lockPath, 'owner.json');
  // A missing owner is ambiguous (the holder may have been descheduled during
  // an upgrade-era mkdir+write acquisition), so it fails closed.
  if (!existsSync(ownerPath)) return { reclaim: false };
  const owner = readSafeJson(ownerPath, 'concurrency lock owner', 4096);
  if (!owner || typeof owner !== 'object' || typeof owner.token !== 'string'
    || !Number.isInteger(owner.pid) || owner.pid <= 1
    || !Number.isFinite(Date.parse(owner.acquiredAt))
    || (owner.startId != null && typeof owner.startId !== 'string')) {
    throw new Error('concurrency lock owner is malformed');
  }
  return { reclaim: processDefinitelyGone(owner.pid, owner.startId || null) };
}

function acquireLedgerLock(paths, options = {}) {
  const timeoutMs = Number.isFinite(options.lockTimeoutMs) ? options.lockTimeoutMs : LOCK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  const candidatePath = `${paths.lockPath}.claim-${token}`;
  let acquired = false;
  try {
    mkdirSync(candidatePath, { mode: 0o700 });
    writeFileSync(join(candidatePath, 'owner.json'), JSON.stringify({
      schemaVersion: 1,
      token,
      pid: process.pid,
      startId: readProcStartId(process.pid),
      acquiredAt: new Date().toISOString(),
    }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    while (true) {
      if (existsSync(paths.reclaimPath)) {
        assertSafeDirectory(paths.reclaimPath, 'concurrency lock reclaim guard');
        if (Date.now() >= deadline) throw new Error('concurrency ledger lock timed out');
        sleepSync(LOCK_WAIT_MS);
        continue;
      }
      try {
        // The fully populated candidate becomes the lock in one atomic rename,
        // so observers never see a live lock without owner identity.
        renameSync(candidatePath, paths.lockPath);
        acquired = true;
        return { token };
      } catch (error) {
        const contention = existsSync(paths.lockPath)
          && ['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error?.code);
        if (!contention) throw error;
      }

      const inspection = inspectExistingLock(paths.lockPath);
      if (inspection.reclaim) {
        let ownsReclaimGuard = false;
        try {
          try {
            mkdirSync(paths.reclaimPath, { mode: 0o700 });
            ownsReclaimGuard = true;
          } catch (guardError) {
            if (guardError?.code !== 'EEXIST') throw guardError;
            assertSafeDirectory(paths.reclaimPath, 'concurrency lock reclaim guard');
          }
          if (ownsReclaimGuard) {
            // Re-check after winning the guard. A new live owner may have
            // acquired between the first observation and guard creation.
            const confirmed = inspectExistingLock(paths.lockPath);
            if (confirmed.reclaim) {
              const tombstone = `${paths.lockPath}.stale-${randomUUID()}`;
              renameSync(paths.lockPath, tombstone);
              rmSync(tombstone, { recursive: true, force: true });
            }
          }
        } finally {
          if (ownsReclaimGuard) {
            try { rmSync(paths.reclaimPath, { recursive: true, force: false }); } catch {}
          }
        }
        continue;
      }
      if (Date.now() >= deadline) throw new Error('concurrency ledger lock timed out');
      sleepSync(LOCK_WAIT_MS);
    }
  } finally {
    if (!acquired) {
      try { rmSync(candidatePath, { recursive: true, force: true }); } catch {}
    }
  }
}

function releaseLedgerLock(paths, lock) {
  try {
    const owner = readSafeJson(join(paths.lockPath, 'owner.json'), 'concurrency lock owner', 4096);
    if (owner?.token !== lock.token) return;
    rmSync(paths.lockPath, { recursive: true, force: false });
  } catch {
    // Never delete a lock whose ownership can no longer be proven.
  }
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('concurrency ledger contains an invalid entry');
  }
  if (typeof entry.id !== 'string' || entry.id.length === 0 || entry.id.length > 200) {
    throw new Error('concurrency ledger entry id is invalid');
  }
  if (!PROVIDERS.has(entry.provider) || !Number.isFinite(Date.parse(entry.startedAt))) {
    throw new Error('concurrency ledger entry provider or timestamp is invalid');
  }
  // Only the genuinely absent legacy-v1 field defaults to a hook. An explicit
  // null is corrupt content: treating it as a hook would let hook-release and
  // hook-TTL semantics steal a durable team reservation.
  const kind = hasOwn(entry, 'kind') ? entry.kind : 'hook';
  if (kind !== 'hook' && kind !== 'team') {
    throw new Error('concurrency ledger entry kind is invalid');
  }
  if (kind === 'team') {
    if (typeof entry.reservationId !== 'string' || entry.reservationId.length === 0
      || !SAFE_TEAM_NAME.test(entry.teamName || '')
      || !/^[a-f0-9]{16}$/.test(entry.runId || '')
      || !Number.isInteger(entry.workerIndex) || entry.workerIndex < 0
      || typeof entry.workerName !== 'string' || entry.workerName.length === 0
      || !Number.isInteger(entry.ownerPid) || entry.ownerPid <= 1
      || (entry.ownerStartId != null && typeof entry.ownerStartId !== 'string')) {
      throw new Error('concurrency ledger team entry is invalid');
    }
    if ((entry.recoveredUntil != null
      && !Number.isFinite(Date.parse(entry.recoveredUntil)))
      || (entry.sourceEntryId != null
        && (typeof entry.sourceEntryId !== 'string' || entry.sourceEntryId.length === 0))) {
      throw new Error('concurrency ledger recovered team entry is invalid');
    }
  }
  return { ...entry, kind };
}

function normalizeRecovery(recovery) {
  if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)
    || recovery.kind !== 'corrupt-ledger'
    || typeof recovery.reason !== 'string' || recovery.reason.length === 0
    || !Number.isFinite(Date.parse(recovery.quarantinedAt))
    || !Number.isFinite(Date.parse(recovery.unresolvedUntil))
    || typeof recovery.quarantineFile !== 'string'
    || basename(recovery.quarantineFile) !== recovery.quarantineFile
    || !recovery.quarantineFile.startsWith('ao-concurrency.json.corrupt-')
    || !Array.isArray(recovery.unresolvedArtifacts)
    || recovery.unresolvedArtifacts.some(item => typeof item !== 'string'
      || basename(item) !== item)) {
    throw new Error('concurrency ledger recovery metadata is invalid');
  }
  return {
    kind: 'corrupt-ledger',
    reason: recovery.reason,
    quarantinedAt: recovery.quarantinedAt,
    unresolvedUntil: recovery.unresolvedUntil,
    quarantineFile: recovery.quarantineFile,
    unresolvedArtifacts: [...recovery.unresolvedArtifacts],
  };
}

function emptyLedger() {
  return { schemaVersion: CONCURRENCY_SCHEMA_VERSION, activeTasks: [], queue: [] };
}

function serializeLedger(state) {
  // Compact JSON is canonical for this high-churn bounded ledger. Besides
  // reducing write volume, it avoids turning a valid compact legacy artifact
  // into an oversized pretty-printed replacement during migration.
  const serialized = JSON.stringify({
    schemaVersion: CONCURRENCY_SCHEMA_VERSION,
    activeTasks: state.activeTasks,
    queue: state.queue || [],
    ...(state.recovery ? { recovery: state.recovery } : {}),
  });
  if (Buffer.byteLength(serialized, 'utf8') > MAX_LEDGER_BYTES) {
    throw new Error(`concurrency ledger serialization exceeds ${MAX_LEDGER_BYTES} bytes`);
  }
  return serialized;
}

function parseLedgerArtifact(artifact) {
  if (!Buffer.from(artifact.text, 'utf8').equals(artifact.bytes)) {
    throw contentError('concurrency ledger is not valid UTF-8', artifact);
  }
  let parsed;
  try { parsed = JSON.parse(artifact.text); }
  catch { throw contentError('concurrency ledger contains malformed JSON', artifact); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw contentError('concurrency ledger schema is malformed', artifact);
  }
  const hasSchemaVersion = hasOwn(parsed, 'schemaVersion');
  if (hasSchemaVersion && !Number.isSafeInteger(parsed.schemaVersion)) {
    // Only concrete integer versions participate in the compatibility
    // boundary. A string/boolean/fractional/unsafe-integer value is damaged
    // schema content, not a future format whose semantics must be preserved.
    throw contentError('concurrency ledger schemaVersion is malformed', artifact);
  }
  const schemaVersion = hasSchemaVersion
    ? parsed.schemaVersion
    : LEGACY_CONCURRENCY_SCHEMA_VERSION;
  if (schemaVersion !== LEGACY_CONCURRENCY_SCHEMA_VERSION
    && schemaVersion !== CONCURRENCY_SCHEMA_VERSION) {
    // An unknown version may carry admission semantics this reader cannot
    // preserve. Leave the artifact untouched and block instead of quarantining
    // it as corruption and eventually treating it as empty.
    throw new Error(
      `concurrency ledger schemaVersion ${String(schemaVersion)} is unsupported; `
      + `supported versions are ${LEGACY_CONCURRENCY_SCHEMA_VERSION} and `
      + `${CONCURRENCY_SCHEMA_VERSION}`,
    );
  }
  const hasQueue = hasOwn(parsed, 'queue');
  if (!Array.isArray(parsed.activeTasks)
    || (hasQueue && !Array.isArray(parsed.queue))) {
    throw contentError('concurrency ledger schema is malformed', artifact);
  }
  const hasRecovery = hasOwn(parsed, 'recovery');
  if (schemaVersion === LEGACY_CONCURRENCY_SCHEMA_VERSION && hasRecovery) {
    // Recovery metadata was never part of the published v1 contract. Accepting
    // it would recreate the mixed-version bypass that v2 exists to prevent.
    throw new Error('concurrency ledger v1 contains unsupported recovery metadata');
  }
  try {
    return {
      state: {
        schemaVersion: CONCURRENCY_SCHEMA_VERSION,
        activeTasks: parsed.activeTasks.map(normalizeEntry),
        queue: hasQueue ? parsed.queue : [],
        ...(schemaVersion === CONCURRENCY_SCHEMA_VERSION && hasRecovery
          ? { recovery: normalizeRecovery(parsed.recovery) }
          : {}),
      },
      needsMigration: schemaVersion !== CONCURRENCY_SCHEMA_VERSION
        || !hasQueue
        || parsed.activeTasks.some(entry => entry && !hasOwn(entry, 'kind')),
    };
  } catch (error) {
    throw contentError(error?.message || 'concurrency ledger content is malformed', artifact);
  }
}

function writeLedger(paths, state) {
  atomicWriteFileSync(paths.ledgerPath, serializeLedger(state), { mode: 0o600, durable: true });
}

function durableQuarantineCopy(paths, artifact) {
  revalidateRegularArtifact(
    paths.ledgerPath,
    artifact.stat,
    `concurrency ledger (${paths.ledgerPath})`,
    MAX_LEDGER_BYTES,
    { allowEmpty: true, generationPolicy: 'full' },
  );
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const quarantinePath = `${paths.ledgerPath}.corrupt-${Date.now()}-${randomUUID()}`;
    try {
      const quarantineStat = writeExclusiveRegularArtifact(
        quarantinePath,
        `concurrency ledger quarantine (${quarantinePath})`,
        artifact.bytes,
        MAX_LEDGER_BYTES,
        { allowEmpty: true },
      );
      assertCurrentOwner(quarantineStat, quarantinePath, 'concurrency ledger quarantine');
      let fd;
      if (process.platform !== 'win32') {
        fd = openSync(paths.stateDir, 'r');
        try { fsyncSync(fd); } finally { closeSync(fd); }
      }
      const current = revalidateRegularArtifact(
        paths.ledgerPath,
        artifact.stat,
        `concurrency ledger (${paths.ledgerPath})`,
        MAX_LEDGER_BYTES,
        { allowEmpty: true, generationPolicy: 'full' },
      );
      assertCurrentOwner(current, paths.ledgerPath, 'concurrency ledger');
      return quarantinePath;
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error(`unable to allocate a collision-safe quarantine in ${paths.stateDir}`);
}

function durableTeamRecovery(paths, unresolvedUntil) {
  const activeTasks = [];
  const unresolved = new Set();
  const seenEntryIds = new Set();
  const stateFiles = readdirSync(paths.stateDir, { withFileTypes: true })
    .filter(item => item.name.startsWith('team-') && item.name.endsWith('.json'));

  for (const item of stateFiles) {
    const teamName = item.name.slice('team-'.length, -'.json'.length);
    const teamPath = join(paths.stateDir, item.name);
    if (!SAFE_TEAM_NAME.test(teamName) || !item.isFile() || item.isSymbolicLink()) {
      throw new Error(`durable team state (${teamPath}) is unsafe`);
    }
    const artifact = readRegularArtifact(teamPath, `durable team state (${teamPath})`,
      MAX_TEAM_STATE_BYTES, { allowEmpty: true, generationPolicy: 'full' });
    assertCurrentOwner(artifact.stat, teamPath, 'durable team state');
    let team;
    try { team = JSON.parse(artifact.text); }
    catch {
      unresolved.add(item.name);
      continue;
    }
    if (!team || typeof team !== 'object' || Array.isArray(team)
      || team.teamName !== teamName || !/^[a-f0-9]{16}$/.test(team.runId || '')
      || !Array.isArray(team.workers)) {
      unresolved.add(item.name);
      continue;
    }

    const possibleWorkers = team.workers.filter(worker => {
      if (!worker || typeof worker !== 'object' || typeof worker.status !== 'string') {
        unresolved.add(item.name);
        return false;
      }
      if (TERMINAL_WORKER_STATUSES.has(worker.status)) return false;
      if (worker._concurrencyReleasedAt != null) {
        if (Number.isFinite(Date.parse(worker._concurrencyReleasedAt))) return false;
        unresolved.add(item.name);
        return false;
      }
      return true;
    });
    if (possibleWorkers.length === 0) continue;

    const reservation = team._concurrencyReservation;
    if (!reservation || typeof reservation !== 'object'
      || typeof reservation.reservationId !== 'string' || reservation.reservationId.length === 0
      || !Array.isArray(reservation.entryIds)
      || !Number.isFinite(Date.parse(reservation.reservedAt))) {
      unresolved.add(item.name);
      continue;
    }

    for (const worker of possibleWorkers) {
      const sourceEntryId = worker._concurrencyEntryId;
      if (typeof sourceEntryId !== 'string' || sourceEntryId.length === 0
        || sourceEntryId.length > 200 || !reservation.entryIds.includes(sourceEntryId)
        || !PROVIDERS.has(worker.type) || typeof worker.name !== 'string'
        || worker.name.length === 0) {
        unresolved.add(item.name);
        continue;
      }
      const workerIndex = team.workers.indexOf(worker);
      const handle = worker._handle && typeof worker._handle === 'object' ? worker._handle : {};
      const supervisorOwner = Number.isInteger(handle.supervisorPid) && handle.supervisorPid > 1;
      const directOwner = Number.isInteger(handle.pid) && handle.pid > 1;
      const ownerPid = supervisorOwner ? handle.supervisorPid
        : (directOwner ? handle.pid : (process.pid > 1 ? process.pid : Number.MAX_SAFE_INTEGER));
      const ownerStartId = supervisorOwner ? handle.supervisorStartId
        : (directOwner ? handle.startId : readProcStartId(ownerPid));
      const duplicate = seenEntryIds.has(sourceEntryId);
      const entry = {
        id: duplicate ? `recovered-${randomUUID()}` : sourceEntryId,
        reservationId: reservation.reservationId,
        kind: 'team',
        provider: worker.type,
        model: worker.model || worker.subagent_type || worker.type,
        startedAt: Number.isFinite(Date.parse(worker.startedAt))
          ? worker.startedAt : reservation.reservedAt,
        ownerPid,
        ownerStartId: ownerStartId || null,
        teamName,
        runId: team.runId,
        workerName: worker.name,
        workerIndex,
        recoveredUntil: unresolvedUntil,
        ...(duplicate ? { sourceEntryId } : {}),
      };
      try {
        activeTasks.push(normalizeEntry(entry));
        seenEntryIds.add(sourceEntryId);
      } catch {
        unresolved.add(item.name);
      }
    }
  }
  return { activeTasks, unresolvedArtifacts: [...unresolved].slice(0, 64) };
}

function recoveredTeamIdentity(entry) {
  return JSON.stringify([
    entry.teamName,
    entry.runId,
    entry.workerIndex,
    entry.workerName,
    entry.sourceEntryId || entry.id,
  ]);
}

function mergeRecoveredTeamEntries(state, recoveredEntries) {
  const existingByIdentity = new Map();
  const occupiedIds = new Set(state.activeTasks.map(entry => entry.id));
  for (const entry of state.activeTasks) {
    if (entry.kind === 'team' && entry.recoveredUntil) {
      existingByIdentity.set(recoveredTeamIdentity(entry), entry);
    }
  }

  for (const candidate of recoveredEntries) {
    const identity = recoveredTeamIdentity(candidate);
    const existing = existingByIdentity.get(identity);
    if (existing) {
      // Refresh liveness-derived fields while retaining the stable ledger ID
      // that exact release paths may already hold.
      const stableId = existing.id;
      Object.assign(existing, candidate, { id: stableId });
      continue;
    }

    let recovered = candidate;
    if (occupiedIds.has(recovered.id)) {
      recovered = {
        ...recovered,
        id: `recovered-${randomUUID()}`,
        sourceEntryId: recovered.sourceEntryId || recovered.id,
      };
    }
    state.activeTasks.push(recovered);
    occupiedIds.add(recovered.id);
    existingByIdentity.set(recoveredTeamIdentity(recovered), recovered);
  }
}

function recoverCorruptLedger(paths, error, now) {
  const artifact = error.artifact;
  assertCurrentOwner(artifact.stat, paths.ledgerPath, 'concurrency ledger');
  const unresolvedUntil = new Date(now + STALE_HOOK_MS).toISOString();
  // Scan before replacing the live artifact. Filesystem/permission failures
  // therefore leave the corrupt ledger in place and admission remains blocked.
  const durable = durableTeamRecovery(paths, unresolvedUntil);
  const quarantinePath = durableQuarantineCopy(paths, artifact);
  const state = {
    schemaVersion: CONCURRENCY_SCHEMA_VERSION,
    activeTasks: durable.activeTasks,
    queue: [],
    recovery: {
      kind: 'corrupt-ledger',
      reason: error.message,
      quarantinedAt: new Date(now).toISOString(),
      unresolvedUntil,
      quarantineFile: basename(quarantinePath),
      unresolvedArtifacts: durable.unresolvedArtifacts,
    },
  };
  // The collision-safe quarantine is durable before this atomic replacement.
  writeLedger(paths, state);
  return state;
}

function readLedger(paths, now) {
  const artifact = readRegularArtifact(
    paths.ledgerPath,
    `concurrency ledger (${paths.ledgerPath})`,
    MAX_LEDGER_BYTES,
    { allowMissing: true, allowEmpty: true, generationPolicy: 'full' },
  );
  if (!artifact.present) {
    return { state: emptyLedger(), present: false, needsMigration: false };
  }
  assertCurrentOwner(artifact.stat, paths.ledgerPath, 'concurrency ledger');
  try {
    const parsed = parseLedgerArtifact(artifact);
    return { ...parsed, present: true };
  } catch (error) {
    if (error?.code !== LEDGER_CONTENT_ERROR) throw error;
    return {
      state: recoverCorruptLedger(paths, error, now),
      present: true,
      needsMigration: false,
    };
  }
}

function readDurableTeamLiveness(paths, entry) {
  if (!SAFE_TEAM_NAME.test(entry.teamName || '')) return { state: 'unknown' };
  const teamPath = join(paths.stateDir, `team-${entry.teamName}.json`);
  if (!existsSync(teamPath)) return { state: 'missing' };
  let team;
  try { team = readSafeJson(teamPath, 'team state', MAX_TEAM_STATE_BYTES); }
  catch { return { state: 'unknown' }; }
  if (!team || typeof team !== 'object' || typeof team.runId !== 'string'
    || !Array.isArray(team.workers)) return { state: 'unknown' };
  if (team.runId !== entry.runId) return { state: 'superseded' };
  const worker = team.workers[entry.workerIndex];
  if (worker?._concurrencyEntryId !== (entry.sourceEntryId || entry.id)
    || worker?.name !== entry.workerName) {
    return { state: 'unknown' };
  }
  if (!worker || typeof worker.status !== 'string') return { state: 'unknown' };
  if (TERMINAL_WORKER_STATUSES.has(worker.status)) return { state: 'terminal' };

  // Detached supervisors publish their own generation-bound terminal snapshot
  // before a later orchestrator poll updates team-*.json. Consulting that
  // durable worker evidence prevents a crashed orchestrator from pinning a
  // completed worker's capacity forever.
  const workerRunId = worker._handle?.workerRunId;
  if (team.projectRoot === paths.projectRoot && workerRunId) {
    try {
      const { text } = readRegularArtifact(
        supervisorSnapshotPath(team.projectRoot, entry.runId, workerRunId),
        'supervisor snapshot',
        MAX_SUPERVISOR_SNAPSHOT_BYTES,
        { generationPolicy: 'full' },
      );
      const snapshot = JSON.parse(text);
      const terminal = ['completed', 'failed', 'cancelled'].includes(snapshot?.status);
      const identityMatches = snapshot?.schemaVersion === SUPERVISOR_SCHEMA_VERSION
        && snapshot.runId === entry.runId
        && snapshot.workerRunId === workerRunId
        && Number.isSafeInteger(snapshot.updatedAt)
        && Number.isSafeInteger(snapshot.supervisorPid)
        && snapshot.supervisorPid > 0;
      const failureShapeValid = snapshot?.status !== 'failed'
        || (snapshot.error && typeof snapshot.error.category === 'string');
      if (terminal && identityMatches && failureShapeValid) {
        return { state: 'terminal' };
      }
    } catch {
      // Missing, malformed, mismatched, or path-unsafe worker evidence is not a
      // license to reclaim. The durable team record remains fail-closed active.
    }
  }
  return { state: 'active' };
}

function shouldReclaimEntry(paths, entry, now) {
  const age = now - Date.parse(entry.startedAt);
  if (entry.kind !== 'team') return age >= STALE_HOOK_MS;

  const durable = readDurableTeamLiveness(paths, entry);
  if (durable.state === 'terminal' || durable.state === 'superseded') return true;
  if (durable.state === 'active' || durable.state === 'unknown') return false;

  // A reservation exists briefly before team state is written. During that
  // window its owner identity protects it. A missing durable team is reclaimed
  // only when that exact owner generation is provably gone; elapsed wall time
  // alone can never steal capacity from a legitimately slow launch.
  if (entry.recoveredUntil) return now >= Date.parse(entry.recoveredUntil);
  return processDefinitelyGone(entry.ownerPid, entry.ownerStartId || null);
}

function pruneStaleEntries(paths, state, now) {
  state.activeTasks = state.activeTasks.filter(entry => !shouldReclaimEntry(paths, entry, now));
  if (state.recovery && now >= Date.parse(state.recovery.unresolvedUntil)) {
    // Team state can become durable (or be repaired) after the first corrupt-
    // ledger scan. Refresh it at the boundary before removing the global
    // unknown-reservation barrier, otherwise a still-running detached worker
    // can disappear from accounting exactly when admission reopens.
    const durable = durableTeamRecovery(paths, state.recovery.unresolvedUntil);
    mergeRecoveredTeamEntries(state, durable.activeTasks);
    delete state.recovery;
  }
}

function countEntries(activeTasks) {
  const counts = emptyCounts();
  for (const entry of activeTasks) {
    counts.global += 1;
    counts[entry.provider] += 1;
  }
  return counts;
}

function recoveryBlock(state, paths) {
  if (!state.recovery) return null;
  const quarantinePath = join(paths.stateDir, state.recovery.quarantineFile);
  return {
    ok: false,
    unsafe: true,
    errors: [
      `${state.recovery.reason}; recovery barrier blocks admission until `
      + `${state.recovery.unresolvedUntil} (state: ${paths.stateDir}; ledger: ${paths.ledgerPath}; `
      + `quarantine: ${quarantinePath}). Remediation: inspect durable team state and the `
      + `quarantine, then wait for the stale window or repair the state before retrying`,
    ],
  };
}

function withLockedLedger(cwd, options, operation) {
  const paths = ledgerPaths(cwd);
  let lock;
  try {
    ensureLedgerDirectories(paths);
    lock = acquireLedgerLock(paths, options);
    const now = Number.isFinite(options?.now) ? options.now : Date.now();
    const loaded = readLedger(paths, now);
    const state = loaded.state;
    const before = serializeLedger(state);
    pruneStaleEntries(paths, state, now);
    const result = operation(state, paths, now);
    const after = serializeLedger(state);
    if (loaded.needsMigration || before !== after) writeLedger(paths, state);
    return result;
  } catch (error) {
    throw stateUnavailableError(paths, error);
  } finally {
    if (lock) releaseLedgerLock(paths, lock);
  }
}

export function loadConcurrencyLimits(options = {}) {
  const env = options.env || process.env;
  const pluginRoot = resolve(options.pluginRoot || env.CLAUDE_PLUGIN_ROOT || MODULE_PLUGIN_ROOT);
  let configured = DEFAULT_CONCURRENCY_LIMITS;
  try {
    const parsed = JSON.parse(stripJsoncComments(
      readFileSync(join(pluginRoot, 'config', 'model-routing.jsonc'), 'utf8'),
    ));
    const value = parsed?.concurrency;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      configured = {
        global: positiveInteger(value.maxParallelTasks, DEFAULT_CONCURRENCY_LIMITS.global),
        claude: positiveInteger(value.maxClaudeWorkers, DEFAULT_CONCURRENCY_LIMITS.claude),
        codex: positiveInteger(value.maxCodexWorkers, DEFAULT_CONCURRENCY_LIMITS.codex),
        gemini: positiveInteger(value.maxGeminiWorkers, DEFAULT_CONCURRENCY_LIMITS.gemini),
      };
    }
  } catch {
    configured = DEFAULT_CONCURRENCY_LIMITS;
  }
  return Object.freeze({
    global: positiveInteger(env.AO_CONCURRENCY_GLOBAL, configured.global),
    claude: positiveInteger(env.AO_CONCURRENCY_CLAUDE, configured.claude),
    codex: positiveInteger(env.AO_CONCURRENCY_CODEX, configured.codex),
    gemini: positiveInteger(env.AO_CONCURRENCY_GEMINI, configured.gemini),
  });
}

export function readActiveConcurrencyCounts(cwd, options = {}) {
  try {
    return withLockedLedger(cwd, options,
      state => (state.recovery ? infinityCounts() : countEntries(state.activeTasks)));
  } catch {
    // A malformed, unsafe, or locked counter cannot safely authorize work.
    return infinityCounts();
  }
}

export function validateWorkerBatchConcurrency(workers, options = {}) {
  if (!Array.isArray(workers)) {
    return { ok: false, errors: ['workers must be an array'] };
  }
  const limits = options.limits || loadConcurrencyLimits(options);
  const active = options.active || emptyCounts();
  const requested = { global: workers.length, claude: 0, codex: 0, gemini: 0 };
  const errors = [];
  for (const [index, worker] of workers.entries()) {
    if (!worker || typeof worker !== 'object' || !PROVIDERS.has(worker.type)) {
      errors.push(`workers[${index}].type must be claude, codex, or gemini`);
      continue;
    }
    requested[worker.type] += 1;
  }
  for (const provider of ['global', 'claude', 'codex', 'gemini']) {
    const current = Number(active[provider] || 0);
    if (!Number.isFinite(current) || current + requested[provider] > limits[provider]) {
      errors.push(
        `${provider} concurrency limit exceeded (${current}+${requested[provider]}/${limits[provider]})`,
      );
    }
  }
  return { ok: errors.length === 0, errors, limits, active, requested };
}

/** Atomically admit and reserve one ledger entry per detached worker. */
export function reserveWorkerBatchConcurrency(cwd, workers, options = {}) {
  try {
    return withLockedLedger(cwd, options, (state, paths, now) => {
      const recovery = recoveryBlock(state, paths);
      if (recovery) return recovery;
      const actual = countEntries(state.activeTasks);
      const supplied = options.active || null;
      const active = supplied
        ? Object.fromEntries(['global', 'claude', 'codex', 'gemini'].map(key => [
          key, Math.max(actual[key], Number(supplied[key] || 0)),
        ]))
        : actual;
      const validation = validateWorkerBatchConcurrency(workers, {
        limits: options.limits || loadConcurrencyLimits(options),
        active,
      });
      if (!validation.ok) return validation;

      const reservationId = options.reservationId || randomUUID();
      const kind = options.kind === 'hook' ? 'hook' : 'team';
      const ownerPid = process.pid;
      const ownerStartId = readProcStartId(ownerPid);
      const startedAt = new Date(now).toISOString();
      const entries = workers.map((worker, index) => ({
        id: options.entryIds?.[index] || randomUUID(),
        reservationId,
        kind,
        provider: worker.type,
        model: worker.model || worker.subagent_type || worker.type,
        startedAt,
        ownerPid,
        ownerStartId,
        ...(kind === 'team' ? {
          teamName: options.teamName,
          runId: options.runId,
          workerName: String(worker.name || `worker-${index}`),
          workerIndex: index,
        } : {}),
      }));
      // Validate newly constructed entries before making them durable.
      state.activeTasks.push(...entries.map(normalizeEntry));
      return {
        ...validation,
        ok: true,
        reservationId,
        entryIds: entries.map(entry => entry.id),
        entries,
      };
    });
  } catch (error) {
    return {
      ok: false,
      errors: [`concurrency ledger unavailable: ${error?.message || String(error)}`],
      unsafe: true,
    };
  }
}

/** Atomically reserve the same ledger for a PreToolUse Task/Agent call. */
export function reserveHookConcurrency(cwd, request, options = {}) {
  return reserveWorkerBatchConcurrency(cwd, [{
    name: 'hook-task',
    type: request.provider,
    model: request.model,
  }], {
    ...options,
    kind: 'hook',
    entryIds: request.taskId ? [request.taskId] : undefined,
  });
}

/** Exact, idempotent release used by worker terminal and launch-failure paths. */
export function releaseConcurrencyEntries(cwd, entryIds, options = {}) {
  const ids = new Set(Array.isArray(entryIds) ? entryIds.filter(id => typeof id === 'string') : []);
  try {
    return withLockedLedger(cwd, options, state => {
      const before = state.activeTasks.length;
      state.activeTasks = state.activeTasks.filter(entry => !ids.has(entry.id));
      return { ok: true, released: before - state.activeTasks.length, entryIds: [...ids] };
    });
  } catch (error) {
    return { ok: false, released: 0, error: error?.message || String(error) };
  }
}

export function releaseConcurrencyReservation(cwd, reservationId, options = {}) {
  try {
    return withLockedLedger(cwd, options, state => {
      const before = state.activeTasks.length;
      state.activeTasks = state.activeTasks.filter(entry => entry.reservationId !== reservationId);
      return { ok: true, released: before - state.activeTasks.length, reservationId };
    });
  } catch (error) {
    return { ok: false, released: 0, error: error?.message || String(error) };
  }
}

/** Provider/ID fallback release for hook events; detached team entries are never touched. */
export function releaseHookConcurrency(cwd, request = {}, options = {}) {
  try {
    return withLockedLedger(cwd, options, state => {
      const hooks = state.activeTasks.filter(entry => entry.kind !== 'team');
      let target = request.taskId
        ? hooks.find(entry => entry.id === request.taskId)
        : null;
      // PostToolUse carries the same tool_use_id reserved by PreToolUse. If that
      // exact ID is already absent (for example SubagentStop released it first),
      // do not steal another same-provider task. SubagentStop IDs are a
      // different namespace, so that safety-net event may still use provider
      // fallback when its ID has no direct match.
      if (!target && (!request.taskId || request.isSubagentStop)
        && PROVIDERS.has(request.provider)) {
        target = hooks
          .filter(entry => entry.provider === request.provider)
          .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))[0];
      }
      if (!target && request.isSubagentStop) {
        target = hooks.sort(
          (left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt),
        )[0];
      }
      if (target) state.activeTasks = state.activeTasks.filter(entry => entry.id !== target.id);
      return { ok: true, released: target ? 1 : 0, entryId: target?.id || null };
    });
  } catch (error) {
    return { ok: false, released: 0, error: error?.message || String(error) };
  }
}
