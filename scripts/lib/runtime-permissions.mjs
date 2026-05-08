/**
 * Runtime Permission Mode Capture & Read.
 *
 * Bridges the gap between Claude Code's settings-file permission detection
 * (which `permission-detect.mjs` does) and the SESSION-RUNTIME permission
 * mode that Claude Code itself observes (e.g. `--dangerously-skip-permissions`,
 * `--permission-mode bypassPermissions`, mid-session Shift+Tab toggles).
 *
 * Why this exists
 * ───────────────
 * Issues #67 / #68 / #69 reported `/ask codex` exiting with code 2 ("demoted")
 * on hosts where the user had launched Claude Code with bypass permissions but
 * had no broad allow grants in their settings files. The settings-only mirror
 * had no way to see the launch flag, so it correctly returned `suggest` from
 * the on-disk view but missed that the actual session was running in
 * `bypassPermissions`.
 *
 * Solution shape
 * ──────────────
 * SessionStart and UserPromptSubmit hooks observe the JSON payload Claude Code
 * writes to stdin and capture any `permission_mode` field they find. The
 * captured value is persisted to `.ao/state/ao-runtime-permissions.json` and
 * read by `permission-detect.mjs` as an UPGRADE-ONLY override on top of the
 * settings union — runtime mode can promote a tier (because it represents
 * actual host trust) but cannot demote one (because explicit allow lists are
 * still authoritative).
 *
 * Single-writer rule
 * ──────────────────
 * The capture hook is the only writer. Every other module is read-only.
 * Writes are atomic (write-temp + rename) so a partially-written file can
 * never be observed.
 *
 * TTL
 * ───
 * 30 minutes. After that the cache is treated as expired and ignored. This
 * window covers a typical work session without making mid-session mode flips
 * (Shift+Tab) silently persist into the next launch. Users who want a longer
 * window can set the value explicitly via `.ao/autonomy.json codex.approval`.
 *
 * Schema (schemaVersion: 1)
 * ─────────────────────────
 *   {
 *     "schemaVersion": 1,
 *     "capturedAt": "2026-05-08T12:34:56.789Z",
 *     "sessionId": "<claude session id> | null",
 *     "permissionMode": "default" | "acceptEdits" | "bypassPermissions" | "plan" | null,
 *     "source": "hook_stdin" | "env" | "manual",
 *     "rawStdinKeys": ["array of top-level keys observed for diagnostics"]
 *   }
 *
 * Forward-compat: any file with `schemaVersion > 1` returns `null` (loader
 * refuses unknown schemas). Per .ao/memory loader rule.
 *
 * Zero npm dependencies — Node.js built-ins only. Fail-safe: every export
 * catches all errors and returns null/false on failure.
 *
 * @module runtime-permissions
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const CACHE_REL_PATH = '.ao/state/ao-runtime-permissions.json';
const TTL_MS = 30 * 60 * 1000; // 30 minutes
const SCHEMA_VERSION = 1;

/** Permission modes Claude Code is documented to use at runtime. */
const VALID_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan']);

/** Capture sources, in order of trust. */
const VALID_SOURCES = new Set(['hook_stdin', 'env', 'manual']);

/**
 * Resolve the cache file path under cwd.
 * @param {string} cwd
 * @returns {string}
 */
function cachePath(cwd) {
  return join(cwd, CACHE_REL_PATH);
}

/**
 * Atomic write helper: write to a sibling temp file, then rename.
 * Mode 0o600 for the cache (state dir already 0o700 by convention).
 * Silent on any error — callers must not depend on visible success.
 * @param {string} dest
 * @param {string} content
 */
function atomicWrite(dest, content) {
  const tmp = `${dest}.tmp.${process.pid}.${Date.now()}`;
  try {
    mkdirSync(join(dest, '..'), { recursive: true, mode: 0o700 });
  } catch { /* parent may already exist with different mode */ }
  try {
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, dest);
  } catch {
    // Best-effort cleanup on failure
    try { unlinkSync(tmp); } catch { /* ignored */ }
    throw new Error('atomic_write_failed');
  }
}

/**
 * Extract a `permission_mode` value from a Claude Code hook stdin payload.
 *
 * Claude Code's hook payload schema is documented in evolving terms across
 * releases — this function tries multiple PLAUSIBLE/OBSERVED shapes so the
 * capture is robust against future schema additions. None of the variants
 * below are independently confirmed by an authoritative spec; the fallback
 * chain is best-effort. First match wins, and unknown fields are ignored
 * (rawStdinKeys is captured for diagnostics):
 *
 *   - top-level `permission_mode` (snake_case, expected primary form)
 *   - top-level `permissionMode` (camelCase, defensive)
 *   - `data.session.permission_mode`
 *   - `data.session.permissionMode`
 *   - `data.permissions.mode`
 *
 * Unknown values are dropped (returns null). This protects against schema
 * drift where Claude Code adds a new mode value we don't recognize yet.
 *
 * @param {unknown} stdinData - Parsed JSON from hook stdin
 * @returns {{ mode: string|null, sessionId: string|null, observedKeys: string[] }}
 */
export function extractPermissionModeFromStdin(stdinData) {
  if (!stdinData || typeof stdinData !== 'object') {
    return { mode: null, sessionId: null, observedKeys: [] };
  }
  const observedKeys = Object.keys(stdinData).filter(k => typeof k === 'string').slice(0, 20);

  // Try multiple plausible shapes. First match wins.
  const candidates = [
    stdinData.permission_mode,
    stdinData.permissionMode,
    stdinData.session?.permission_mode,
    stdinData.session?.permissionMode,
    stdinData.permissions?.mode,
  ];
  let mode = null;
  for (const c of candidates) {
    if (typeof c === 'string' && VALID_MODES.has(c)) {
      mode = c;
      break;
    }
  }

  const sessionId = (typeof stdinData.session_id === 'string' && stdinData.session_id) ||
    (typeof stdinData.sessionId === 'string' && stdinData.sessionId) ||
    null;

  return { mode, sessionId, observedKeys };
}

/**
 * Extract a `permission_mode` value from environment variables. Used as a
 * secondary signal when stdin doesn't carry the field. Recognized vars:
 *
 *   CLAUDE_PERMISSION_MODE       (preferred — explicit, scoped)
 *   CLAUDE_CODE_PERMISSION_MODE  (alternative naming)
 *
 * Unknown values are dropped.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string|null}
 */
export function extractPermissionModeFromEnv(env = process.env) {
  const candidates = [env.CLAUDE_PERMISSION_MODE, env.CLAUDE_CODE_PERMISSION_MODE];
  for (const v of candidates) {
    if (typeof v === 'string' && VALID_MODES.has(v)) return v;
  }
  return null;
}

/**
 * Persist a runtime permission record. Single-writer entry point.
 *
 * @param {object} record
 * @param {string} record.permissionMode  One of VALID_MODES
 * @param {string} [record.source='hook_stdin']  One of VALID_SOURCES
 * @param {string|null} [record.sessionId]
 * @param {string[]} [record.rawStdinKeys]
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {Date} [opts.now]
 * @returns {boolean} true on successful write, false on any failure
 */
export function captureRuntimePermissions(record, opts = {}) {
  try {
    if (!record || !VALID_MODES.has(record.permissionMode)) return false;
    const source = record.source || 'hook_stdin';
    if (!VALID_SOURCES.has(source)) return false;

    const cwd = opts.cwd || process.cwd();
    const now = opts.now || new Date();

    const payload = {
      schemaVersion: SCHEMA_VERSION,
      capturedAt: now.toISOString(),
      sessionId: record.sessionId || null,
      permissionMode: record.permissionMode,
      source,
      rawStdinKeys: Array.isArray(record.rawStdinKeys) ? record.rawStdinKeys.slice(0, 20) : [],
    };
    atomicWrite(cachePath(cwd), JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the runtime permission record. Returns null when the file is missing,
 * unparseable, has an unknown schema version, has an invalid permissionMode,
 * or has expired past TTL.
 *
 * Callers should treat null as "no runtime override available — fall back to
 * settings-only detection".
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {Date} [opts.now]
 * @param {number} [opts.ttlMs=TTL_MS]  Override TTL (testing only)
 * @returns {{
 *   permissionMode: string,
 *   source: string,
 *   capturedAt: string,
 *   sessionId: string|null,
 *   ageMs: number,
 *   rawStdinKeys: string[],
 * } | null}
 */
export function loadRuntimePermissions(opts = {}) {
  try {
    const cwd = opts.cwd || process.cwd();
    const now = opts.now || new Date();
    const ttl = typeof opts.ttlMs === 'number' && opts.ttlMs >= 0 ? opts.ttlMs : TTL_MS;

    const raw = readFileSync(cachePath(cwd), 'utf-8');
    const parsed = JSON.parse(raw);

    // Forward-compat: refuse unknown schema versions
    if (parsed?.schemaVersion !== SCHEMA_VERSION) return null;

    if (!VALID_MODES.has(parsed.permissionMode)) return null;
    if (!VALID_SOURCES.has(parsed.source)) return null;

    const capturedMs = Date.parse(parsed.capturedAt || '');
    if (!Number.isFinite(capturedMs)) return null;
    const ageMs = now.getTime() - capturedMs;
    if (ageMs > ttl) return null;

    return {
      permissionMode: parsed.permissionMode,
      source: parsed.source,
      capturedAt: parsed.capturedAt,
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
      ageMs,
      rawStdinKeys: Array.isArray(parsed.rawStdinKeys) ? parsed.rawStdinKeys : [],
    };
  } catch {
    return null;
  }
}

/**
 * Map a Claude Code permission_mode to a Codex-style permission level (the
 * abstraction codex-approval.mjs uses for sandbox tier mapping).
 *
 * Mapping:
 *   bypassPermissions → full-auto   (broad Bash + Write + Edit)
 *   acceptEdits       → auto-edit   (broad Write + Edit)
 *   default           → suggest     (no broad grants)
 *   plan              → suggest     (read-only intent)
 *
 * Returns null for unknown / unset modes so callers can distinguish "no
 * runtime signal" from "runtime explicitly says minimum tier".
 *
 * @param {string} permissionMode
 * @returns {'full-auto' | 'auto-edit' | 'suggest' | null}
 */
export function permissionModeToLevel(permissionMode) {
  switch (permissionMode) {
    case 'bypassPermissions': return 'full-auto';
    case 'acceptEdits':       return 'auto-edit';
    case 'default':           return 'suggest';
    case 'plan':              return 'suggest';
    default:                  return null;
  }
}

/**
 * Constants exported for tests and diagnostics.
 */
export const _internal = {
  CACHE_REL_PATH,
  TTL_MS,
  SCHEMA_VERSION,
  VALID_MODES,
  VALID_SOURCES,
};
