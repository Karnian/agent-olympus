import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { atomicWriteFileSync } from './fs-atomic.mjs';
import { readRegularArtifact } from './hardened-fs.mjs';
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

export const CONCURRENCY_SCHEMA_VERSION = 1;

const STALE_HOOK_MS = 3 * 60 * 1000;
const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 5000;
const MAX_LEDGER_BYTES = 1024 * 1024;
const MAX_TEAM_STATE_BYTES = 4 * 1024 * 1024;
const MAX_SUPERVISOR_SNAPSHOT_BYTES = 64 * 1024;
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
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (process.platform !== 'win32' && (stat.mode & 0o022) !== 0)) {
    throw new Error(`${label} is unsafe`);
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
  ensurePrivateDirectory(aoDir, '.ao directory');
  ensurePrivateDirectory(stateDir, 'concurrency state directory');
  return {
    projectRoot,
    stateDir,
    ledgerPath: join(stateDir, 'ao-concurrency.json'),
    lockPath: join(stateDir, 'ao-concurrency.lock'),
    reclaimPath: join(stateDir, 'ao-concurrency.reclaim'),
  };
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
  const kind = entry.kind ?? 'hook';
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
  }
  return { ...entry, kind };
}

function readLedger(paths) {
  if (!existsSync(paths.ledgerPath)) {
    return { schemaVersion: CONCURRENCY_SCHEMA_VERSION, activeTasks: [], queue: [] };
  }
  const parsed = readSafeJson(paths.ledgerPath, 'concurrency ledger', MAX_LEDGER_BYTES);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || (parsed.schemaVersion != null && parsed.schemaVersion !== CONCURRENCY_SCHEMA_VERSION)
    || !Array.isArray(parsed.activeTasks)
    || (parsed.queue != null && !Array.isArray(parsed.queue))) {
    throw new Error('concurrency ledger is malformed');
  }
  return {
    schemaVersion: CONCURRENCY_SCHEMA_VERSION,
    activeTasks: parsed.activeTasks.map(normalizeEntry),
    queue: parsed.queue || [],
  };
}

function writeLedger(paths, state) {
  atomicWriteFileSync(paths.ledgerPath, JSON.stringify({
    schemaVersion: CONCURRENCY_SCHEMA_VERSION,
    activeTasks: state.activeTasks,
    queue: state.queue || [],
  }, null, 2), { mode: 0o600, durable: true });
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
  if (worker?._concurrencyEntryId !== entry.id || worker?.name !== entry.workerName) {
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
  return processDefinitelyGone(entry.ownerPid, entry.ownerStartId || null);
}

function pruneStaleEntries(paths, state, now) {
  state.activeTasks = state.activeTasks.filter(entry => !shouldReclaimEntry(paths, entry, now));
}

function countEntries(activeTasks) {
  const counts = emptyCounts();
  for (const entry of activeTasks) {
    counts.global += 1;
    counts[entry.provider] += 1;
  }
  return counts;
}

function withLockedLedger(cwd, options, operation) {
  const paths = ledgerPaths(cwd);
  const lock = acquireLedgerLock(paths, options);
  try {
    const state = readLedger(paths);
    const now = Number.isFinite(options?.now) ? options.now : Date.now();
    pruneStaleEntries(paths, state, now);
    const result = operation(state, paths, now);
    writeLedger(paths, state);
    return result;
  } finally {
    releaseLedgerLock(paths, lock);
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
    return withLockedLedger(cwd, options, state => countEntries(state.activeTasks));
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
    return withLockedLedger(cwd, options, (state, _paths, now) => {
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
