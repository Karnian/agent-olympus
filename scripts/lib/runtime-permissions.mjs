/**
 * Runtime permission capture with a split trust boundary.
 *
 * Claude hook identity/diagnostics live in the project at
 * `.ao/state/ao-runtime-permissions.json`. That file is deliberately not an
 * authority for permission promotion: project code can write project state.
 *
 * The authoritative, short-lived grant lives outside the project under the
 * user's private runtime cache, keyed by the canonical project root. A grant
 * is usable only when its session and capture ID match the hardened local hook
 * identity supplied by the current Claude session. Unsafe ancestry, links,
 * modes, oversized data, replacement races, or an unavailable external cache
 * all disable runtime promotion and leave settings-only detection intact.
 *
 * Zero npm dependencies. Every public operation is fail-closed and returns a
 * neutral value instead of throwing.
 *
 * @module runtime-permissions
 */

import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import {
  bindSafeDirectoryPath,
  ensureSafeDirectoryPath,
  isWithinPath,
  readRegularArtifact,
  revalidateDirectoryBinding,
  revalidateRegularArtifact,
} from './hardened-fs.mjs';

/** Project-local, non-authoritative hook identity/diagnostic record. */
const CACHE_REL_PATH = '.ao/state/ao-runtime-permissions.json';
/** User-private authoritative grant directory, relative to the real home. */
const GRANT_REL_DIR = join('.cache', 'agent-olympus', 'runtime-permissions');
const TTL_MS = 30 * 60 * 1000;
const SCHEMA_VERSION = 1;
const MAX_CACHE_BYTES = 16 * 1024;
const CAPTURE_ID_PATTERN = /^[0-9a-f-]{36}$/i;
const IDENTITY_KIND = 'runtime-permission-identity';
const GRANT_KIND = 'runtime-permission-grant';
const CURRENT_SESSION_FILE = 'ao-current-session.json';
const MAX_POINTER_BYTES = 4 * 1024;

/** Permission modes Claude Code is documented to use at runtime. */
const VALID_MODES = new Set([
  'default',
  'plan',
  'acceptEdits',
  'auto',
  'dontAsk',
  'bypassPermissions',
]);

/** Capture sources, in order of trust. */
const VALID_SOURCES = new Set(['hook_stdin', 'env', 'manual']);
const VALID_OBSERVATIONS = new Set(['recognized', 'unknown', 'absent']);

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validCaptureId(value) {
  return typeof value === 'string' && CAPTURE_ID_PATTERN.test(value);
}

function canonicalProjectRoot(cwd) {
  return realpathSync(resolve(cwd || process.cwd()));
}

function localIdentityPaths(cwd) {
  const projectRoot = canonicalProjectRoot(cwd);
  const file = join(projectRoot, CACHE_REL_PATH);
  return { projectRoot, dir: dirname(file), file };
}

function projectKey(projectRoot) {
  const normalized = process.platform === 'win32'
    ? projectRoot.toLowerCase()
    : projectRoot;
  return createHash('sha256').update(normalized).digest('hex');
}

function assertOwnedNonWritableAncestry(binding, label) {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    throw new Error(`${label}_ownership_unverifiable`);
  }
  const uid = process.getuid();
  for (const item of binding.chain) {
    const stat = lstatSync(item.path);
    if (stat.uid !== uid || (stat.mode & 0o022) !== 0) {
      throw new Error(`${label}_ancestry_not_user_private`);
    }
  }
}

function revalidateBinding(binding, label, privateAncestry = false) {
  revalidateDirectoryBinding(binding, label);
  if (privateAncestry) assertOwnedNonWritableAncestry(binding, label);
}

function runtimeGrantPaths(opts = {}) {
  // hardened-fs can verify POSIX mode bits, but this repository has no
  // equivalent owner-only ACL proof on Windows. Do not promote there until an
  // ACL-aware backend exists; settings-only detection remains available.
  if (process.platform === 'win32') {
    throw new Error('runtime_permission_cache_acl_unverifiable');
  }
  const projectRoot = canonicalProjectRoot(opts.cwd);
  const configuredHome = resolve(opts.runtimeHome || homedir());
  const homeRoot = realpathSync(configuredHome);
  const dir = join(homeRoot, GRANT_REL_DIR);

  // A test/project-controlled "home" must never move the authority back into
  // the workspace (or make the workspace a child of the authority directory).
  if (isWithinPath(projectRoot, dir) || isWithinPath(dir, projectRoot)) {
    throw new Error('runtime_permission_cache_overlaps_project');
  }

  const key = projectKey(projectRoot);
  return {
    projectRoot,
    homeRoot,
    dir,
    key,
    file: join(dir, `${key}.json`),
  };
}

function readBoundJson(file, binding, label, opts = {}) {
  const result = readRegularArtifact(file, label, MAX_CACHE_BYTES, {
    allowMissing: opts.allowMissing === true,
    generationPolicy: 'full',
    revalidateContext: () => revalidateBinding(binding, label, opts.privateAncestry),
  });
  if (!result.present) return null;

  // Test-only race seam: replacement after descriptor read must be detected
  // before any parsed value can influence authorization.
  if (typeof opts.beforeFinalRevalidate === 'function') {
    opts.beforeFinalRevalidate(file);
  }
  revalidateBinding(binding, label, opts.privateAncestry);
  revalidateRegularArtifact(file, result.stat, label, MAX_CACHE_BYTES, {
    generationPolicy: 'full',
  });
  return JSON.parse(result.text);
}

function writeBoundJson(file, binding, label, payload, opts = {}) {
  const content = JSON.stringify(payload);
  if (Buffer.byteLength(content, 'utf8') <= 0
    || Buffer.byteLength(content, 'utf8') > MAX_CACHE_BYTES) {
    throw new Error('runtime_permission_cache_too_large');
  }

  // Refuse to repair an attacker-controlled link/mode in place. A missing or
  // already-hardened target may be atomically replaced.
  readRegularArtifact(file, label, MAX_CACHE_BYTES, {
    allowMissing: true,
    generationPolicy: 'full',
    revalidateContext: () => revalidateBinding(binding, label, opts.privateAncestry),
  });
  revalidateBinding(binding, label, opts.privateAncestry);
  atomicWriteFileSync(file, content, { mode: 0o600, durable: true });

  if (typeof opts.afterWrite === 'function') opts.afterWrite(file);
  revalidateBinding(binding, label, opts.privateAncestry);
  const persisted = readRegularArtifact(file, label, MAX_CACHE_BYTES, {
    generationPolicy: 'full',
    revalidateContext: () => revalidateBinding(binding, label, opts.privateAncestry),
  });
  revalidateRegularArtifact(file, persisted.stat, label, MAX_CACHE_BYTES, {
    generationPolicy: 'full',
  });
  if (persisted.text !== content) throw new Error('runtime_permission_cache_mismatch');
  return true;
}

function bindLocalIdentityForRead(cwd) {
  const paths = localIdentityPaths(cwd);
  const binding = bindSafeDirectoryPath(paths.dir, 'runtime permission identity directory', {
    trustedRoot: paths.projectRoot,
    requirePrivateMode: false,
  });
  assertOwnedNonWritableAncestry(binding, 'runtime permission identity directory');
  return { ...paths, binding };
}

function bindLocalIdentityForWrite(cwd) {
  const paths = localIdentityPaths(cwd);
  const binding = ensureSafeDirectoryPath(paths.dir, 'runtime permission identity directory', {
    trustedRoot: paths.projectRoot,
    requirePrivateMode: false,
    requirePrivateAnchor: false,
  });
  assertOwnedNonWritableAncestry(binding, 'runtime permission identity directory');
  return { ...paths, binding };
}

function bindRuntimeGrantForRead(opts) {
  const paths = runtimeGrantPaths(opts);
  const binding = bindSafeDirectoryPath(paths.dir, 'runtime permission grant directory', {
    trustedRoot: paths.homeRoot,
    requirePrivateMode: true,
  });
  assertOwnedNonWritableAncestry(binding, 'runtime permission grant directory');
  return { ...paths, binding };
}

function bindRuntimeGrantForWrite(opts) {
  const paths = runtimeGrantPaths(opts);
  const binding = ensureSafeDirectoryPath(paths.dir, 'runtime permission grant directory', {
    trustedRoot: paths.homeRoot,
    requirePrivateMode: true,
    requirePrivateAnchor: false,
  });
  assertOwnedNonWritableAncestry(binding, 'runtime permission grant directory');
  return { ...paths, binding };
}

function currentSessionPaths(opts = {}) {
  const cwdRoot = canonicalProjectRoot(opts.cwd);
  if (opts.stateBase) {
    const stateDir = realpathSync(resolve(opts.stateBase));
    if (!isWithinPath(cwdRoot, stateDir)) {
      throw new Error('runtime_session_pointer_outside_project');
    }
    return { trustedRoot: cwdRoot, stateDir, file: join(stateDir, CURRENT_SESSION_FILE) };
  }

  let commonRoot = cwdRoot;
  try {
    const commonDir = execFileSync(
      'git',
      ['-C', cwdRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (commonDir) commonRoot = realpathSync(dirname(commonDir));
  } catch { /* non-git project: cwd is the state root */ }
  const stateDir = join(commonRoot, '.ao', 'state');
  return { trustedRoot: commonRoot, stateDir, file: join(stateDir, CURRENT_SESSION_FILE) };
}

function readLocalIdentity(cwd, opts = {}) {
  const paths = bindLocalIdentityForRead(cwd);
  const parsed = readBoundJson(paths.file, paths.binding, 'runtime permission identity', {
    allowMissing: opts.allowMissing,
    beforeFinalRevalidate: opts.beforeFinalRevalidate,
    privateAncestry: true,
  });
  if (!parsed) return null;
  if (parsed.schemaVersion !== SCHEMA_VERSION
    || parsed.kind !== IDENTITY_KIND
    || parsed.source !== 'hook_stdin'
    || !nonEmptyString(parsed.sessionId)
    || !validCaptureId(parsed.captureId)
    || !VALID_OBSERVATIONS.has(parsed.permissionObservation)
    || !Number.isFinite(Date.parse(parsed.capturedAt || ''))) {
    return null;
  }
  if (parsed.permissionObservation === 'recognized'
    && !Number.isFinite(Date.parse(parsed.permissionObservedAt || ''))) {
    return null;
  }
  return parsed;
}

/**
 * Extract a `permission_mode` value from a Claude Code hook stdin payload.
 * Multiple observed schema shapes are accepted; first valid match wins.
 */
export function extractPermissionModeFromStdin(stdinData) {
  if (!stdinData || typeof stdinData !== 'object') {
    return { mode: null, modeObserved: false, sessionId: null, observedKeys: [] };
  }
  const observedKeys = Object.keys(stdinData).filter(k => typeof k === 'string').slice(0, 20);
  const candidates = [
    stdinData.permission_mode,
    stdinData.permissionMode,
    stdinData.session?.permission_mode,
    stdinData.session?.permissionMode,
    stdinData.permissions?.mode,
  ];
  const modeObserved = candidates.some(candidate => candidate !== undefined);
  let mode = null;
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && VALID_MODES.has(candidate)) {
      mode = candidate;
      break;
    }
  }
  const sessionId = (nonEmptyString(stdinData.session_id) && stdinData.session_id)
    || (nonEmptyString(stdinData.sessionId) && stdinData.sessionId)
    || null;
  return { mode, modeObserved, sessionId, observedKeys };
}

/** Extract a recognized runtime mode from supported environment variables. */
export function extractPermissionModeFromEnv(env = process.env) {
  for (const value of [env.CLAUDE_PERMISSION_MODE, env.CLAUDE_CODE_PERMISSION_MODE]) {
    if (typeof value === 'string' && VALID_MODES.has(value)) return value;
  }
  return null;
}

/**
 * Persist hook identity and, when eligible, an external permission grant.
 *
 * A valid Claude hook session ID and an explicitly observed hook-stdin mode
 * are mandatory for every authoritative grant. Environment-derived modes are
 * diagnostic-only because project configuration can influence hook env.
 * Existing project-local permissionMode fields are never migrated or trusted.
 */
export function captureRuntimePermissions(record, opts = {}) {
  try {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    const source = record.source || 'hook_stdin';
    if (!VALID_SOURCES.has(source)) return false;
    if (record.permissionSource !== undefined && record.permissionSource !== null
      && !VALID_SOURCES.has(record.permissionSource)) return false;

    const validHookIdentity = source === 'hook_stdin' && nonEmptyString(record.sessionId);
    if (!validHookIdentity) return false;
    const validMode = VALID_MODES.has(record.permissionMode);
    const permissionSource = record.permissionSource || source;
    // Only a recognized mode that was present in authenticated hook stdin may
    // authorize promotion. Environment variables can be injected by project
    // configuration and therefore remain diagnostic-only.
    const authoritativeMode = validMode
      && record.permissionModeObserved === true
      && permissionSource === 'hook_stdin';
    const explicitUnknownMode = record.permissionModeObserved === true && !validMode;

    const cwd = opts.cwd || process.cwd();
    const now = opts.now || new Date();
    const capturedAt = now.toISOString();
    if (!Number.isFinite(Date.parse(capturedAt))) return false;

    let captureId = randomUUID();
    let preservedSameSession = false;
    let permissionObservation = authoritativeMode
      ? 'recognized'
      : (explicitUnknownMode ? 'unknown' : 'absent');
    let permissionObservedAt = authoritativeMode || explicitUnknownMode ? capturedAt : null;

    // Identity-only UserPromptSubmit payloads preserve the current same-session
    // capture binding without extending the permission TTL. The prior read is
    // itself hardened; unsafe/legacy state is treated as absent.
    if (!authoritativeMode && !explicitUnknownMode) {
      try {
        const prior = readLocalIdentity(cwd, { allowMissing: true });
        if (prior?.sessionId === record.sessionId) {
          preservedSameSession = true;
          captureId = prior.captureId;
          permissionObservation = prior.permissionObservation;
          permissionObservedAt = prior.permissionObservedAt || null;
        }
      } catch { /* start a non-authorizing identity generation */ }

      // Local state alone is not authoritative. Preserve a same-session
      // binding only if the external grant independently validates against it
      // and is still inside its original TTL. Otherwise rotate to a fresh,
      // non-authorizing capture generation and tombstone the external record.
      if (preservedSameSession) {
        const priorGrant = loadRuntimePermissions({
          cwd,
          runtimeHome: opts.runtimeHome,
          expectedSessionId: record.sessionId,
          expectedCaptureId: captureId,
          now,
        });
        if (!priorGrant) {
          preservedSameSession = false;
          captureId = randomUUID();
          permissionObservation = 'absent';
          permissionObservedAt = null;
        }
      }
    }

    const identityPaths = bindLocalIdentityForWrite(cwd);
    const identity = {
      schemaVersion: SCHEMA_VERSION,
      kind: IDENTITY_KIND,
      capturedAt,
      sessionId: record.sessionId,
      captureId,
      permissionObservation,
      permissionObservedAt,
      source: 'hook_stdin',
      rawStdinKeys: Array.isArray(record.rawStdinKeys)
        ? record.rawStdinKeys.filter(key => typeof key === 'string').slice(0, 20)
        : [],
    };
    writeBoundJson(
      identityPaths.file,
      identityPaths.binding,
      'runtime permission identity',
      identity,
      { afterWrite: opts._afterIdentityWrite, privateAncestry: true },
    );

    // An identity-only refresh preserves an already-bound same-session grant.
    // A new/unbound session instead writes an external tombstone so a stale
    // prior-session grant cannot become usable again by forging workspace
    // pointer/identity files while its TTL is still live.
    if (!authoritativeMode && !explicitUnknownMode && preservedSameSession) return true;

    const grantPaths = bindRuntimeGrantForWrite({ cwd, runtimeHome: opts.runtimeHome });
    const grant = {
      schemaVersion: SCHEMA_VERSION,
      kind: GRANT_KIND,
      projectKey: grantPaths.key,
      projectRoot: grantPaths.projectRoot,
      sessionId: record.sessionId,
      captureId,
      permissionMode: authoritativeMode ? record.permissionMode : null,
      permissionCapturedAt: authoritativeMode ? capturedAt : null,
      permissionSource: authoritativeMode ? 'hook_stdin' : null,
    };
    return writeBoundJson(
      grantPaths.file,
      grantPaths.binding,
      'runtime permission grant',
      grant,
      { afterWrite: opts._afterGrantWrite, privateAncestry: true },
    );
  } catch {
    return false;
  }
}

/**
 * Read the current-session pointer through the same bounded, no-follow,
 * private-state policy as the local hook identity. The pointer is a fence,
 * never a permission authority.
 */
export function loadRuntimeCurrentSessionId(opts = {}) {
  try {
    const paths = currentSessionPaths(opts);
    const binding = bindSafeDirectoryPath(
      paths.stateDir,
      'runtime current-session directory',
      { trustedRoot: paths.trustedRoot, requirePrivateMode: false },
    );
    assertOwnedNonWritableAncestry(binding, 'runtime current-session directory');
    const result = readRegularArtifact(
      paths.file,
      'runtime current-session pointer',
      MAX_POINTER_BYTES,
      {
        allowMissing: true,
        generationPolicy: 'full',
        revalidateContext: () => revalidateBinding(
          binding,
          'runtime current-session directory',
          true,
        ),
      },
    );
    if (!result.present) return null;
    if (typeof opts._beforePointerRevalidate === 'function') {
      opts._beforePointerRevalidate(paths.file);
    }
    revalidateBinding(binding, 'runtime current-session directory', true);
    revalidateRegularArtifact(
      paths.file,
      result.stat,
      'runtime current-session pointer',
      MAX_POINTER_BYTES,
      { generationPolicy: 'full' },
    );
    const parsed = JSON.parse(result.text);
    return nonEmptyString(parsed?.sessionId) ? parsed.sessionId : null;
  } catch {
    return null;
  }
}

/**
 * Revoke this project's external runtime grant at SessionEnd. Missing caches
 * remain a no-op; no external directory is created merely to store a revoke.
 */
export function revokeRuntimePermissions(sessionId, opts = {}) {
  try {
    if (!nonEmptyString(sessionId)) return false;
    const paths = bindRuntimeGrantForRead(opts);
    const prior = readBoundJson(paths.file, paths.binding, 'runtime permission grant', {
      allowMissing: true,
      privateAncestry: true,
    });
    if (!prior) return true;
    if (prior.schemaVersion !== SCHEMA_VERSION
      || prior.kind !== GRANT_KIND
      || prior.projectKey !== paths.key
      || prior.projectRoot !== paths.projectRoot
      || !nonEmptyString(prior.sessionId)
      || !validCaptureId(prior.captureId)) {
      return false;
    }
    // A late SessionEnd from session A must not revoke a newer grant owned by
    // concurrent session B in the same project.
    if (prior.sessionId !== sessionId) return true;

    const captureId = randomUUID();
    const tombstone = {
      schemaVersion: SCHEMA_VERSION,
      kind: GRANT_KIND,
      projectKey: paths.key,
      projectRoot: paths.projectRoot,
      sessionId,
      captureId,
      permissionMode: null,
      permissionCapturedAt: null,
      permissionSource: null,
      revokedAt: (opts.now || new Date()).toISOString(),
    };
    return writeBoundJson(
      paths.file,
      paths.binding,
      'runtime permission grant',
      tombstone,
      { privateAncestry: true, afterWrite: opts._afterGrantWrite },
    );
  } catch {
    return false;
  }
}

/**
 * Load an authoritative external grant.
 *
 * Both expectedSessionId and expectedCaptureId are mandatory. Callers obtain
 * them from a separately hardened current hook identity; absence or mismatch
 * means settings-only detection.
 */
export function loadRuntimePermissions(opts = {}) {
  try {
    if (!nonEmptyString(opts.expectedSessionId) || !validCaptureId(opts.expectedCaptureId)) {
      return null;
    }
    const now = opts.now || new Date();
    const ttl = typeof opts.ttlMs === 'number' && opts.ttlMs >= 0 ? opts.ttlMs : TTL_MS;
    const paths = bindRuntimeGrantForRead(opts);
    const parsed = readBoundJson(paths.file, paths.binding, 'runtime permission grant', {
      allowMissing: true,
      beforeFinalRevalidate: opts._beforeGrantRevalidate,
      privateAncestry: true,
    });
    if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION
      || parsed.kind !== GRANT_KIND
      || parsed.projectKey !== paths.key
      || parsed.projectRoot !== paths.projectRoot
      || parsed.sessionId !== opts.expectedSessionId
      || parsed.captureId !== opts.expectedCaptureId
      || !VALID_MODES.has(parsed.permissionMode)
      || parsed.permissionSource !== 'hook_stdin') {
      return null;
    }

    const capturedMs = Date.parse(parsed.permissionCapturedAt || '');
    const ageMs = now.getTime() - capturedMs;
    if (!Number.isFinite(capturedMs) || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > ttl) {
      return null;
    }
    return {
      permissionMode: parsed.permissionMode,
      source: parsed.permissionSource,
      capturedAt: parsed.permissionCapturedAt,
      sessionId: parsed.sessionId,
      captureId: parsed.captureId,
      ageMs,
      rawStdinKeys: [],
    };
  } catch {
    return null;
  }
}

/**
 * Read the project-local hook identity only. This API never returns a
 * permission mode and must not independently authorize a tool or sandbox.
 */
export function loadRuntimeSessionIdentity(opts = {}) {
  try {
    const parsed = readLocalIdentity(opts.cwd || process.cwd(), {
      allowMissing: true,
      beforeFinalRevalidate: opts._beforeIdentityRevalidate,
    });
    if (!parsed) return null;
    return {
      sessionId: parsed.sessionId,
      captureId: parsed.captureId,
      permissionObservation: parsed.permissionObservation,
      permissionObservedAt: parsed.permissionObservedAt || null,
      source: 'hook_stdin',
      capturedAt: parsed.capturedAt,
    };
  } catch {
    return null;
  }
}

/** Map a Claude permission mode to the Codex-style permission tier. */
export function permissionModeToLevel(permissionMode) {
  switch (permissionMode) {
    case 'bypassPermissions': return 'full-auto';
    case 'acceptEdits':       return 'auto-edit';
    case 'auto':
    case 'dontAsk':
    case 'default':
    case 'plan':              return 'suggest';
    default:                  return null;
  }
}

export const _internal = {
  CACHE_REL_PATH,
  GRANT_REL_DIR,
  TTL_MS,
  SCHEMA_VERSION,
  MAX_CACHE_BYTES,
  MAX_POINTER_BYTES,
  IDENTITY_KIND,
  GRANT_KIND,
  VALID_MODES,
  VALID_SOURCES,
  runtimeGrantPaths,
};
