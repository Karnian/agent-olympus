/**
 * AO-owned keychain item writer.
 *
 * Writes `agent-olympus.gemini-api-key` (or caller-supplied service name) with
 * /usr/bin/security listed as a trusted app, so subsequent AO reads never
 * trigger the macOS keychain password prompt.
 *
 * The secret is delivered via `spawnSync`'s `input` option to `security
 * add-generic-password -w` (bare, no value). This uses `security`'s documented
 * stdin prompt mode: when `-w` is the last option without an argument, it
 * reads `password data for new item:` / `retype password for new item:`
 * prompts on stderr and expects the password twice on stdin.
 *
 * Why this matters: the obvious form `-w <KEY>` puts the raw key on argv,
 * which is observable via `ps -eo pid,args` on macOS. Using bare `-w` +
 * stdin keeps the secret out of the process-table listing entirely.
 *
 * macOS-only module. Linux has a different trust model (libsecret/D-Bus
 * doesn't have per-app ACLs in the same sense) and doesn't need this helper.
 *
 * @module ao-keychain-write
 */

import { spawnSync as nodeSpawnSync } from 'node:child_process';

const SECURITY_BIN = '/usr/bin/security';
const DEFAULT_AO_SERVICE = 'agent-olympus.gemini-api-key';
const DEFAULT_ACCOUNT = 'default-api-key';

// Test hooks for injecting a mock spawnSync without polluting callers.
let _spawnSync = nodeSpawnSync;
/** @internal */
export function __setSpawnSyncForTest(fn) {
  _spawnSync = typeof fn === 'function' ? fn : nodeSpawnSync;
}
/** @internal */
export function __resetSpawnSyncForTest() {
  _spawnSync = nodeSpawnSync;
}

/**
 * @typedef {Object} WriteResult
 * @property {boolean} ok - true when the keychain item was written successfully
 * @property {string|null} error - human-readable error message on failure, else null
 * @property {number|null} exitCode
 * @property {string|null} stderr - stderr from `security` (may contain diagnostic info; NO secret)
 */

/**
 * Write the AO-owned keychain item via `security add-generic-password -U -T ... -w`.
 *
 * Semantics (per `security help add-generic-password`):
 *   -U     = update existing item if present (idempotent wizard re-runs work)
 *   -T /usr/bin/security = grant `security` tool trusted access to this item;
 *                          can be specified MULTIPLE times to grant several apps
 *   -w     = password from stdin (prompt mode — MUST be last option)
 *
 * We also grant `/usr/bin/env` and the current Node executable trusted access,
 * since some hosts invoke gemini CLI via one of those and future enhancements
 * may want a native-keychain read path without going through /usr/bin/security.
 *
 * @param {Object} opts
 * @param {string} opts.apiKey - the raw Gemini API key (kept in memory briefly; never logged)
 * @param {string} [opts.account='default-api-key']
 * @param {string} [opts.service='agent-olympus.gemini-api-key']
 * @param {string[]} [opts.trustedApps] - additional trusted app paths; default:
 *   ['/usr/bin/security', '/usr/bin/env', process.execPath]
 * @param {number} [opts.timeoutMs=15000]
 * @returns {WriteResult}
 */
export function writeAoKeychainItem(opts) {
  const safeOpts = (opts && typeof opts === 'object') ? opts : {};
  const apiKey = safeOpts.apiKey;
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    return { ok: false, error: 'apiKey must be a non-empty string', exitCode: null, stderr: null };
  }
  if (/[\r\n]/.test(apiKey)) {
    // The stdin prompt protocol uses LF as a delimiter between password and
    // retype. An embedded newline would truncate the secret silently.
    return {
      ok: false,
      error: 'apiKey must not contain newline or carriage-return characters',
      exitCode: null,
      stderr: null,
    };
  }
  const account = typeof safeOpts.account === 'string' && safeOpts.account
    ? safeOpts.account
    : DEFAULT_ACCOUNT;
  const service = typeof safeOpts.service === 'string' && safeOpts.service
    ? safeOpts.service
    : DEFAULT_AO_SERVICE;
  const trustedApps = Array.isArray(safeOpts.trustedApps) && safeOpts.trustedApps.length
    ? safeOpts.trustedApps.filter((p) => typeof p === 'string' && p.length > 0)
    : ['/usr/bin/security', '/usr/bin/env', process.execPath];
  // 60s accommodates the macOS keychain ACL-change dialog. Writes include
  // `-T /usr/bin/security` (and possibly additional trusted apps), which on
  // first run asks the user to authenticate with their login password. A
  // 15s cap sometimes fired before the user could finish typing. Callers
  // can override via opts.timeoutMs for non-interactive/automated paths.
  const timeoutMs = typeof safeOpts.timeoutMs === 'number' && safeOpts.timeoutMs > 0
    ? safeOpts.timeoutMs
    : 60000;

  const args = ['add-generic-password', '-U', '-a', account, '-s', service];
  for (const path of trustedApps) {
    args.push('-T', path);
  }
  // `-w` must be LAST so `security` interprets it as prompt-mode.
  args.push('-w');

  // Feed the secret twice (password + retype). Trailing \n required for each.
  const stdinPayload = `${apiKey}\n${apiKey}\n`;

  const result = _spawnSync(SECURITY_BIN, args, {
    input: stdinPayload,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.error) {
    return {
      ok: false,
      error: `spawn failed: ${result.error.code || result.error.message}`,
      exitCode: null,
      stderr: null,
    };
  }
  if (typeof result.status !== 'number') {
    // Killed by signal (usually timeout SIGTERM)
    return {
      ok: false,
      error: `security exited via signal ${result.signal || 'unknown'}`,
      exitCode: null,
      stderr: _sanitizeStderr(result.stderr, apiKey),
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      error: `security exited with status ${result.status}`,
      exitCode: result.status,
      stderr: _sanitizeStderr(result.stderr, apiKey),
    };
  }
  return { ok: true, error: null, exitCode: 0, stderr: null };
}

/**
 * Strip secrets from stderr before surfacing it.
 *
 * `security add-generic-password` should never echo the password, but we
 * defensively scrub in case a future version changes its error wording or a
 * wrapper tool prepends the input. Two passes:
 *   1. Exact-match redaction of the raw API key the caller just passed in.
 *      This covers non-standard key formats (e.g. Google rotating prefixes)
 *      that the pattern pass would miss.
 *   2. Pattern-match fallback for anything resembling an `AIza…` key — catches
 *      unrelated leaked keys (e.g. stale value still in the tool's message).
 *
 * Exported for test injection of an arbitrary key.
 *
 * @param {unknown} raw
 * @param {string} [apiKey] - the key we just wrote; redacted by exact match
 * @returns {string|null}
 */
export function _sanitizeStderr(raw, apiKey) {
  if (typeof raw !== 'string' || !raw) return null;
  let out = raw;
  if (typeof apiKey === 'string' && apiKey.length >= 4) {
    const escaped = apiKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'g'), '<redacted:caller-key>');
  }
  return out.replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza****REDACTED');
}

export const _consts = { SECURITY_BIN, DEFAULT_AO_SERVICE, DEFAULT_ACCOUNT };
