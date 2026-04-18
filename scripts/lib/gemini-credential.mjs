/**
 * Gemini Credential Resolver — pulls GEMINI_API_KEY from the OS secret store
 * for headless `gemini -p` spawns, so users don't need to export the key.
 *
 * Resolution priority (first hit wins):
 *   1. process.env.GEMINI_API_KEY  — never cached (user controls it)
 *   2. macOS Keychain              — `security find-generic-password -s gemini-cli-api-key -a <account> -w`
 *   3. Linux libsecret             — `secret-tool lookup service gemini-cli-api-key account <account>`
 *   4. null                        — lets the gemini CLI surface its own auth error
 *
 * Windows is not supported in v1; a one-time stderr notice is emitted on first call.
 *
 * Design:
 * - SYNC API (execFileSync). All callers (gemini-exec.spawn, gemini-acp.startServer,
 *   tmux-session.buildWorkerCommand, ask.mjs) are synchronous contracts — making this
 *   async would require cascading refactors.
 * - Per-account cache keyed on `${platform}:${account}` (5-minute TTL). Null results
 *   are also cached to avoid re-hammering the keychain on every spawn.
 * - Fail-safe: every error path returns null. Nothing throws.
 * - Zero secret leakage: stdout from the child is trimmed only, never logged.
 *   Diagnostic events go to stderr as single-line JSON with masked keys.
 *
 * @module gemini-credential
 */

import { execFileSync as nodeExecFileSync } from 'node:child_process';

// ─── Constants ────────────────────────────────────────────────────────────────

const KEYCHAIN_SERVICE = 'gemini-cli-api-key';
const DEFAULT_ACCOUNT = 'default-api-key';
const TTL_MS = 5 * 60 * 1000; // 5 minutes
/**
 * Hard cap on each secret-store invocation.
 *
 * 10s accommodates the macOS Keychain access dialog.
 *
 * Root-cause note (2026-04-19): the dialog is NOT triggered by Node itself.
 * The resolver shells out to `/usr/bin/security find-generic-password`, and
 * `/usr/bin/security` is the binary whose trust macOS checks against the
 * keychain item. gemini CLI (via `keytar`) stores its API key with a default
 * ACL trusting only the creating executable (typically the Node binary that
 * ran gemini CLI at save time), so `/usr/bin/security` is an untrusted
 * caller and each read prompts. Clicking "Always Allow" on that dialog
 * authorizes the `security` tool for future access on that item — after
 * which subsequent reads complete in <100ms.
 *
 * If the user dismisses the prompt, execFileSync hits this timeout and we
 * fall back to null — gemini CLI then surfaces its own auth error, no hang.
 *
 * For permanent fix see docs/gemini-keychain-setup.md (manual ACL edit) or
 * the `ao-keychain` credentialSource which writes an AO-owned keychain item
 * with `/usr/bin/security` pre-listed as trusted.
 */
const EXEC_TIMEOUT_MS = 10000;
const MAX_BUFFER = 64 * 1024;

const MACOS_SECURITY_BIN = '/usr/bin/security';
/** Linux secret-tool paths tried in order. First one that exists wins. */
const LINUX_SECRET_TOOL_BINS = [
  '/usr/bin/secret-tool',
  '/usr/local/bin/secret-tool',
  '/run/current-system/sw/bin/secret-tool', // NixOS
  '/nix/var/nix/profiles/default/bin/secret-tool', // Nix default profile
];

// ─── Module state (test-hookable) ─────────────────────────────────────────────

/**
 * Per-account cache.
 * Map<string cacheKey, { platform, account, key: string|null, expiresAt: number }>
 * cacheKey = `${platform}:${account}` — but invalidation uses the stored
 * `account` field for exact match (not string suffix), so accounts containing
 * ':' are handled correctly.
 */
const _cache = new Map();

/** One-time Windows unsupported notice (dedup) */
let _windowsNoticeShown = false;

/** Test hook for execFileSync injection */
let _execFileSync = nodeExecFileSync;

// ─── Public helpers ───────────────────────────────────────────────────────────

/**
 * Mask an API key for safe logging. Preserves prefix/suffix for debugging.
 *
 * @param {string|null|undefined} key
 * @returns {string}
 */
export function maskKey(key) {
  if (!key || typeof key !== 'string') return '<none>';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-2)}`;
}

/**
 * Invalidate cached credential for a specific account, or all accounts.
 * Call this from adapter error classifiers when an auth failure is detected —
 * the next resolveGeminiApiKey() call will re-read the keychain.
 *
 * @param {string} accountOrAll - account name, or 'all' to flush every entry
 * @param {string} [reason='manual'] - for diagnostic logging
 */
export function invalidateCache(accountOrAll, reason = 'manual') {
  if (accountOrAll === 'all') {
    _cache.clear();
  } else {
    // Exact account match against stored value (handles accounts containing ':')
    for (const [k, v] of Array.from(_cache.entries())) {
      if (v && v.account === accountOrAll) _cache.delete(k);
    }
  }
  try {
    process.stderr.write(
      JSON.stringify({
        event: 'gemini_credential_cache_invalidated',
        account: accountOrAll,
        reason,
      }) + '\n'
    );
  } catch {
    // never throw from logging
  }
}

// ─── Platform-specific fetchers ───────────────────────────────────────────────

/**
 * Normalize a secret-store payload into a bare API key.
 *
 * Gemini CLI's `saveApiKey()` stores keys via HybridTokenStorage, which wraps
 * the value in a JSON envelope like:
 *   {"serverName":"default-api-key","token":{"accessToken":"AIza...","tokenType":"ApiKey"},"updatedAt":...}
 *
 * But users (or other tools) may also write a BARE string via
 * `security add-generic-password -w "AIza..."`.
 *
 * This helper tolerates both: if stdout parses as JSON with a recognized
 * shape, extract the bare key; otherwise treat stdout as the key itself.
 *
 * @param {string} raw - trimmed stdout from security/secret-tool
 * @returns {string|null}
 */
function _extractKey(raw) {
  if (!raw) return null;
  // Try JSON envelope first (gemini CLI's storage format)
  if (raw.startsWith('{')) {
    try {
      const obj = JSON.parse(raw);
      // Gemini CLI shape: { token: { accessToken, tokenType } }
      const tokAcc = obj?.token?.accessToken;
      if (typeof tokAcc === 'string' && tokAcc.length > 0) return tokAcc;
      // Fallback shapes seen across tools: { accessToken }, { apiKey }, { key }
      for (const field of ['accessToken', 'apiKey', 'api_key', 'key', 'value']) {
        const v = obj?.[field];
        if (typeof v === 'string' && v.length > 0) return v;
      }
      // JSON but no recognized field → treat as unusable
      return null;
    } catch {
      // Not valid JSON despite leading '{' — fall through to bare-string path
    }
  }
  return raw;
}

/**
 * Fetch API key from macOS Keychain.
 * Returns the bare API key on success; null on any failure (miss, locked, timeout).
 *
 * @param {string} account
 * @returns {string|null}
 */
function fromKeychainMacOS(account) {
  try {
    const stdout = _execFileSync(
      MACOS_SECURITY_BIN,
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'],
      {
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    const trimmed = typeof stdout === 'string' ? stdout.trim() : '';
    return _extractKey(trimmed);
  } catch {
    return null;
  }
}

/**
 * Fetch API key from Linux libsecret via secret-tool.
 * Returns the trimmed key on success; null on miss, ENOENT, or D-Bus unavailable.
 *
 * @param {string} account
 * @returns {string|null}
 */
function fromSecretToolLinux(account) {
  // Try each known absolute path in order, then plain 'secret-tool' (PATH lookup).
  // execFileSync with bin name (no slash) uses the env PATH in the child spec
  // — safe because args are argv (no shell interpolation).
  const candidates = [...LINUX_SECRET_TOOL_BINS, 'secret-tool'];
  for (const bin of candidates) {
    try {
      const stdout = _execFileSync(
        bin,
        ['lookup', 'service', KEYCHAIN_SERVICE, 'account', account],
        {
          timeout: EXEC_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      const trimmed = typeof stdout === 'string' ? stdout.trim() : '';
      // gemini CLI's cross-platform storage writes JSON envelopes to
      // libsecret too, not just macOS Keychain — apply the same unwrap.
      return _extractKey(trimmed);
    } catch (err) {
      // ENOENT means THIS path doesn't have the binary — try the next candidate.
      // Any other error (exit!=0, D-Bus failure, etc.) means we reached the tool
      // but it couldn't resolve the key — stop and return null (don't retry
      // with a different path, we already found a working binary).
      if (err && err.code === 'ENOENT') continue;
      return null;
    }
  }
  return null;
}

/**
 * Emit one-time Windows unsupported notice.
 */
function showWindowsNoticeOnce() {
  if (_windowsNoticeShown) return;
  _windowsNoticeShown = true;
  try {
    process.stderr.write(
      'gemini-credential: Windows keychain not supported in v1. ' +
      'Set GEMINI_API_KEY env var directly.\n'
    );
  } catch {
    // never throw
  }
}

// ─── Resolver core ────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ResolveOpts
 * @property {string} [account='default-api-key']
 * @property {boolean} [useKeychain=true]
 * @property {boolean} [forceRefresh=false]
 */

/**
 * Resolve GEMINI_API_KEY for a gemini CLI spawn.
 *
 * Priority: env → macOS keychain → Linux secret-tool → null.
 * Per-account 5-minute TTL cache (null results cached too).
 * Never throws.
 *
 * @param {ResolveOpts} [opts]
 * @returns {string|null}
 */
export function resolveGeminiApiKey(opts) {
  // Guard: opts may be null/undefined/non-object. Contract: never throws.
  const safeOpts = (opts && typeof opts === 'object') ? opts : {};
  const account = typeof safeOpts.account === 'string' && safeOpts.account
    ? safeOpts.account
    : DEFAULT_ACCOUNT;
  const useKeychain = safeOpts.useKeychain !== false;
  const forceRefresh = safeOpts.forceRefresh === true;

  // 1. Env precedence with explicit-disable semantics:
  //    - undefined  → fall through to keychain
  //    - non-empty  → use as-is
  //    - empty str  → user explicitly wants no key → return null, SKIP keychain
  //      (otherwise we'd inject a keychain key against user intent)
  const envVal = process.env.GEMINI_API_KEY;
  if (envVal !== undefined) {
    return envVal.length > 0 ? envVal : null;
  }

  if (!useKeychain) {
    return null;
  }

  const cacheKey = `${process.platform}:${account}`;
  if (!forceRefresh) {
    const hit = _cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      return hit.key;
    }
  }

  let resolved = null;
  if (process.platform === 'darwin') {
    resolved = fromKeychainMacOS(account);
  } else if (process.platform === 'linux') {
    resolved = fromSecretToolLinux(account);
  } else if (process.platform === 'win32') {
    showWindowsNoticeOnce();
  }

  _cache.set(cacheKey, {
    platform: process.platform,
    account,
    key: resolved,
    expiresAt: Date.now() + TTL_MS,
  });
  return resolved;
}

// ─── Test hooks ───────────────────────────────────────────────────────────────

/**
 * Reset all module state. Call in test beforeEach.
 */
export function __resetForTest() {
  _cache.clear();
  _windowsNoticeShown = false;
  _execFileSync = nodeExecFileSync;
}

/**
 * Inject a mock execFileSync for unit tests.
 *
 * @param {Function} fn
 */
export function __setExecFileSyncForTest(fn) {
  _execFileSync = typeof fn === 'function' ? fn : nodeExecFileSync;
}
