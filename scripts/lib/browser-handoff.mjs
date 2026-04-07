/**
 * Browser Pause + Manual Continue Protocol (v1.0.2 US-006)
 *
 * When autonomous browser-based QA hits CAPTCHA/auth/MFA gates, this module
 * persists enough context (session ID + sanitized URL + sanitized breadcrumb)
 * for the user to manually complete the step and then confirm the new state
 * via /resume-handoff.
 *
 * Key constraints:
 *  - URL sanitization: strip query params matching the SENSITIVE_PARAM_PATTERNS list
 *  - Breadcrumb allow-list: ONLY {step, lastClickedSelector, screenshotPath?}
 *    Everything else is stripped — enforced by explicit deny-list
 *  - Handoff state is stale after 24h
 *  - autonomy.json { browserHandoff: { disabled: true } } → skip all writes
 *  - Deterministic exact-resume is DEFERRED to v1.0.3
 *
 * Public API:
 *   SENSITIVE_PARAM_PATTERNS  — Array<RegExp|string> matched against URL query param names
 *   sanitizeUrl(url)          — strip sensitive query params from URL
 *   sanitizeBreadcrumb(bc)    — allow-list filter for breadcrumb object
 *   isHandoffStale(state)     — returns true if createdAt is older than 24h
 *   saveHandoff({sessionId, url, breadcrumb, stateDir, cwd?})
 *                              — write .ao/state/browser-handoff.json (schemaVersion: 1)
 *   readHandoff({stateDir, includeStale?})
 *                              — read state; returns null if missing/stale/corrupt
 *                                (unless includeStale:true — then returns with stale:true flag)
 */

import { promises as fsp } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './fs-atomic.mjs';

const STATE_FILE = 'browser-handoff.json';
const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours
const SCHEMA_VERSION = 1;

// ── Sensitive URL parameter patterns ──────────────────────────────────────
//
// These patterns are matched against query parameter NAMES (not values).
// Matching is case-insensitive. Parameters matching any pattern have their
// values replaced with [REDACTED].
//
// Required by AC: access_token, id_token, code, state, sig, signature,
// secret, key, password, auth, session, token, jwt, hmac, otp, recovery, refresh
//
export const SENSITIVE_PARAM_PATTERNS = [
  /^access_token$/i,
  /^id_token$/i,
  /^code$/i,
  /^state$/i,
  /^sig(nature)?$/i,
  /^secret$/i,
  /^key$/i,
  /^password$/i,
  /^auth$/i,
  /^session$/i,
  /^token$/i,
  /^jwt$/i,
  /^hmac$/i,
  /^otp$/i,
  /^recovery$/i,
  /^refresh$/i,
];

/**
 * Breadcrumb allow-list. ONLY these keys are permitted to pass through.
 * Everything else is stripped (deny by default).
 */
const BREADCRUMB_ALLOWED = new Set(['step', 'lastClickedSelector', 'screenshotPath']);

// ── sanitizeUrl ─────────────────────────────────────────────────────────────

/**
 * Strip sensitive query parameters from a URL. Matching is done against
 * parameter names using SENSITIVE_PARAM_PATTERNS (case-insensitive regex).
 *
 * Non-matching parameters are preserved unchanged.
 * Returns the original URL if parsing fails (fail-safe).
 *
 * @param {string} url
 * @returns {string}
 */
export function sanitizeUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return url ?? '';

  let parsed;
  try {
    // Attempt absolute URL parse
    parsed = new URL(url);
  } catch {
    // For relative or malformed URLs, try attaching a dummy base
    try {
      parsed = new URL(url, 'https://placeholder.invalid');
      // After sanitization, strip the dummy base
      const params = parsed.searchParams;
      const toDelete = [];
      for (const [name] of params.entries()) {
        if (_isSensitiveParam(name)) {
          toDelete.push(name);
        }
      }
      for (const name of toDelete) params.delete(name);

      // Reconstruct — strip the dummy base, keep path+query+hash
      const qs = params.toString();
      const pathPart = parsed.pathname + (qs ? '?' + qs : '') + parsed.hash;
      return pathPart;
    } catch {
      // Truly unparseable — return as-is
      return url;
    }
  }

  const params = parsed.searchParams;
  const toDelete = [];
  for (const [name] of params.entries()) {
    if (_isSensitiveParam(name)) {
      toDelete.push(name);
    }
  }
  for (const name of toDelete) params.delete(name);

  return parsed.toString();
}

/**
 * @param {string} name - URL query parameter name
 * @returns {boolean}
 */
function _isSensitiveParam(name) {
  return SENSITIVE_PARAM_PATTERNS.some((pattern) => {
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
    return re.test(name);
  });
}

// ── sanitizeBreadcrumb ───────────────────────────────────────────────────────

/**
 * Filter a breadcrumb object to ONLY allow-listed keys.
 * All other keys — including formValues, localStorage, headers, cookies,
 * fetchPayloads, requestBody, sessionStorage, indexedDB, and any unknown keys —
 * are STRIPPED (deny by default).
 *
 * This is the credential-leak fence: the breadcrumb must never carry
 * authentication material into persistent state.
 *
 * @param {object|null|undefined} bc
 * @returns {object}
 */
export function sanitizeBreadcrumb(bc) {
  if (!bc || typeof bc !== 'object' || Array.isArray(bc)) return {};

  const out = {};
  for (const key of BREADCRUMB_ALLOWED) {
    if (key in bc) {
      out[key] = bc[key];
    }
  }
  return out;
}

// ── isHandoffStale ───────────────────────────────────────────────────────────

/**
 * Returns true if the handoff state is older than 24h or if createdAt is missing.
 *
 * @param {object|null} state
 * @returns {boolean}
 */
export function isHandoffStale(state) {
  if (!state || typeof state !== 'object') return true;
  if (!state.createdAt) return true;

  try {
    const createdMs = new Date(state.createdAt).getTime();
    if (isNaN(createdMs)) return true;
    return Date.now() - createdMs >= STALE_MS;
  } catch {
    return true;
  }
}

// ── autonomy disabled check ──────────────────────────────────────────────────

function _isBrowserHandoffDisabled(cwd) {
  try {
    const raw = readFileSync(path.join(cwd || process.cwd(), '.ao', 'autonomy.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed?.browserHandoff?.disabled === true;
  } catch {
    return false;
  }
}

// ── saveHandoff ──────────────────────────────────────────────────────────────

/**
 * Persist browser handoff state to .ao/state/browser-handoff.json.
 * Automatically sanitizes the URL and breadcrumb before writing.
 *
 * Returns early without writing if autonomy.json has browserHandoff.disabled:true.
 *
 * @param {{
 *   sessionId?: string,
 *   url: string,
 *   breadcrumb: object,
 *   stateDir: string,
 *   cwd?: string
 * }} opts
 * @returns {Promise<void>}
 */
export async function saveHandoff({ sessionId, url, breadcrumb, stateDir, cwd } = {}) {
  // Autonomy disable check
  if (_isBrowserHandoffDisabled(cwd)) return;

  const state = {
    schemaVersion: SCHEMA_VERSION,
    sessionId: sessionId ?? '',
    url: sanitizeUrl(url || ''),
    breadcrumb: sanitizeBreadcrumb(breadcrumb),
    createdAt: new Date().toISOString(),
  };

  try {
    await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
    await atomicWriteFile(
      path.join(stateDir, STATE_FILE),
      JSON.stringify(state, null, 2) + '\n',
    );
  } catch {
    // Fail-safe: do not propagate write errors
  }
}

// ── readHandoff ──────────────────────────────────────────────────────────────

/**
 * Read browser handoff state from .ao/state/browser-handoff.json.
 *
 * Returns:
 *  - null  if file is missing, corrupt, or stale (unless includeStale:true)
 *  - state object if fresh
 *  - state object with stale:true if stale AND includeStale:true
 *
 * @param {{ stateDir: string, includeStale?: boolean }} opts
 * @returns {Promise<object|null>}
 */
export async function readHandoff({ stateDir, includeStale = false } = {}) {
  try {
    const filePath = path.join(stateDir, STATE_FILE);
    const raw = await fsp.readFile(filePath, 'utf-8');
    const state = JSON.parse(raw);

    if (!state || typeof state !== 'object') return null;

    const stale = isHandoffStale(state);
    if (stale) {
      if (includeStale) {
        return { ...state, stale: true };
      }
      return null;
    }

    return state;
  } catch {
    return null;
  }
}
