/**
 * Gemini Credential Resolver — pulls GEMINI_API_KEY from the OS secret store
 * for headless `gemini -p` spawns, so users don't need to export the key.
 *
 * Credential sources (select via `credentialSource` in `.ao/autonomy.json`):
 *   - 'auto' (default): env → shared-keychain (`gemini-cli-api-key`) → miss.
 *     Does NOT try ao-keychain automatically — stale AO items must not silently
 *     shadow a freshly-updated gemini CLI key.
 *   - 'env': process.env.GEMINI_API_KEY only; keychain not consulted.
 *   - 'shared-keychain': skip env, read `gemini-cli-api-key`. This is the
 *     service gemini CLI writes to via `keytar`; macOS ACL may trigger a
 *     prompt on each read (see docs/gemini-keychain-setup.md).
 *   - 'ao-keychain': skip env, read `agent-olympus.gemini-api-key`. Created
 *     by `scripts/setup-gemini-key.mjs`; wizard grants `/usr/bin/security`
 *     trusted access so reads never prompt.
 *
 * Backend per platform:
 *   - macOS:   `security find-generic-password -s <service> -a <account> -w`
 *   - Linux:   `secret-tool lookup service <service> account <account>`
 *   - Windows: unsupported in v1; one-time stderr notice on first call.
 *
 * Design:
 * - SYNC API (execFileSync). All callers (gemini-exec.spawn, gemini-acp.startServer,
 *   tmux-session.buildWorkerCommand, ask.mjs) are synchronous contracts — making this
 *   async would require cascading refactors.
 * - Per-(platform, service, account) cache with split TTL: 24h on hit,
 *   60s on error (timeout/ACL-denied/binary-missing), 30s on empty miss.
 *   See SUCCESS_TTL_MS / ERROR_TTL_MS / MISS_TTL_MS for rationale.
 * - Fail-safe: every error path returns null. Nothing throws.
 * - Zero secret leakage: stdout from the child is trimmed only, never logged.
 *   Diagnostic events go to stderr as single-line JSON with masked keys.
 *
 * @module gemini-credential
 */

import { execFileSync as nodeExecFileSync } from 'node:child_process';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Service name under which gemini CLI stores its API key via `keytar`.
 * Kept on the default path so existing users who authenticated with
 * `gemini /auth` work unchanged. This is the "shared" source.
 */
const SHARED_KEYCHAIN_SERVICE = 'gemini-cli-api-key';

/**
 * Service name for the Agent-Olympus-owned keychain item created by the
 * setup wizard (`scripts/setup-gemini-key.mjs`). The wizard grants
 * `/usr/bin/security` trusted access to this item, so the resolver reads
 * it without triggering the "security wants to use your keychain" dialog.
 */
const AO_KEYCHAIN_SERVICE = 'agent-olympus.gemini-api-key';

const DEFAULT_ACCOUNT = 'default-api-key';

/**
 * Cache TTL is split by result kind so a transient miss doesn't lock out a
 * fresh keychain write for the full success window:
 *
 *   SUCCESS_TTL_MS (24h) — once we have a working key, trust it until the
 *     next hour-scale rotation. Parent processes for Atlas/Athena orchestrators
 *     can stay warm across many worker spawns without re-hammering keychain.
 *
 *   MISS_TTL_MS (30s) — when the resolver came back empty (item missing, user
 *     dismissed prompt, etc.), cache briefly to prevent rapid re-prompt storms
 *     but recover quickly once the user fixes the underlying issue (runs the
 *     wizard, sets the env var, clicks Always Allow). 30s is long enough to
 *     absorb a batch of worker spawns in one orchestrator tick, short enough
 *     that the user doesn't wonder why their fix "isn't taking".
 *
 *   ERROR_TTL_MS (60s) — for stderrClass='error' paths (timeout, acl_denied,
 *     binary_not_found). Slightly longer than miss because these indicate a
 *     structural problem the user has to address, not a transient empty slot.
 *
 * Explicit `forceRefresh: true` bypasses all of the above.
 */
const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 30 * 1000;
const ERROR_TTL_MS = 60 * 1000;
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
 * Per-(platform, service, account) cache.
 * Map<string cacheKey, { platform, service, account, key: string|null, expiresAt: number }>
 * cacheKey = `${platform}:${service}:${account}` — invalidation uses the
 * stored `account` field for exact match (not string suffix), so accounts
 * containing ':' are handled correctly, and all services under the same
 * account are invalidated together (desired behavior for auth_failed, where
 * the key is bad regardless of which service it was read from).
 * Entry TTL is set at write time based on result kind; see SUCCESS_TTL_MS
 * / ERROR_TTL_MS / MISS_TTL_MS.
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

// ─── Tracing helpers ──────────────────────────────────────────────────────────

/**
 * True when credential resolution tracing should emit events to stderr.
 * Enabled by either AO_DEBUG_CREDENTIAL=1 (specific) or AO_DEBUG_GEMINI=1
 * (broader umbrella). Both accept '1' exactly — no truthy coercion so that
 * accidental values like 'false' or '0' don't turn tracing on.
 */
function _traceEnabled() {
  return process.env.AO_DEBUG_CREDENTIAL === '1'
    || process.env.AO_DEBUG_GEMINI === '1';
}

/**
 * Emit a single diagnostic event as one JSON line on stderr.
 * No-op unless tracing is enabled; never throws.
 *
 * @param {object} event
 */
function _emitEvent(event) {
  if (!_traceEnabled()) return;
  try {
    process.stderr.write(JSON.stringify(event) + '\n');
  } catch {
    // never throw from logging
  }
}

/**
 * Classify an execFileSync error into a coarse category useful for
 * distinguishing "keychain item missing" from "macOS prompt dismissed" from
 * "`security` binary not on PATH". The stderrClass/exitCode fields are
 * safe for logs — no secret material and no PII.
 *
 * macOS `security` CLI exit codes used below are the low byte of the
 * Security framework OSStatus returned by the underlying call. Only the
 * two we have high confidence in are mapped:
 *   44 = errSecItemNotFound (-25300 & 0xff) — item missing from keychain
 *   51 = errSecAuthFailed   (-25293 & 0xff) — auth/ACL denied
 *
 * Everything else (including user cancel, which shows up as the mangled
 * low byte of -60006 or -128 depending on the path) is surfaced as
 * `unknown` with the raw exit code. Operators can look up the original
 * OSStatus via `security error <n>` without us claiming a meaning we
 * can't cleanly prove.
 *
 * @param {unknown} err
 * @returns {{ stderrClass: string, exitCode: (number|null), errnoCode: (string|null) }}
 */
function _classifyError(err) {
  if (!err || typeof err !== 'object') {
    return { stderrClass: 'unknown', exitCode: null, errnoCode: null };
  }
  const e = /** @type {any} */ (err);
  // Node child_process timeout kills the child with SIGTERM and sets killed=true.
  // Some Node versions also set err.code === 'ETIMEDOUT'. Handle both.
  if (e.code === 'ETIMEDOUT'
    || (e.killed === true && (e.signal === 'SIGTERM' || e.signal === 'SIGKILL'))) {
    return { stderrClass: 'timeout', exitCode: null, errnoCode: e.code ?? null };
  }
  if (e.code === 'ENOENT') {
    return { stderrClass: 'binary_not_found', exitCode: null, errnoCode: 'ENOENT' };
  }
  if (typeof e.status === 'number') {
    switch (e.status) {
      case 44: return { stderrClass: 'not_found', exitCode: 44, errnoCode: null };
      case 51: return { stderrClass: 'acl_denied', exitCode: 51, errnoCode: null };
      default: return { stderrClass: 'unknown', exitCode: e.status, errnoCode: null };
    }
  }
  return { stderrClass: 'unknown', exitCode: null, errnoCode: e.code ?? null };
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
/**
 * @typedef {Object} FetchResult
 * @property {string|null} key - extracted API key on success, null otherwise
 * @property {'hit'|'miss'|'error'} result - classification for tracing + downstream
 * @property {string|null} [stderrClass] - present when result='miss'|'error' with a known cause
 * @property {number|null} [exitCode]
 * @property {string|null} [errnoCode]
 */

/**
 * Fetch API key from macOS Keychain.
 *
 * @param {string} account
 * @param {string} service - keychain service name (shared or AO-owned)
 * @returns {FetchResult}
 */
function fromKeychainMacOS(account, service) {
  const startedAt = Date.now();
  try {
    const stdout = _execFileSync(
      MACOS_SECURITY_BIN,
      ['find-generic-password', '-s', service, '-a', account, '-w'],
      {
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    const trimmed = typeof stdout === 'string' ? stdout.trim() : '';
    const key = _extractKey(trimmed);
    _emitEvent({
      event: 'gemini_cred_resolve',
      stage: 'fetch_end',
      backend: 'macos_security',
      account,
      service,
      result: key ? 'hit' : 'miss',
      elapsedMs: Date.now() - startedAt,
      keyMask: key ? maskKey(key) : null,
    });
    return { key, result: key ? 'hit' : 'miss' };
  } catch (err) {
    const cls = _classifyError(err);
    const result = cls.stderrClass === 'not_found' ? 'miss' : 'error';
    _emitEvent({
      event: 'gemini_cred_resolve',
      stage: 'fetch_end',
      backend: 'macos_security',
      account,
      service,
      result,
      elapsedMs: Date.now() - startedAt,
      stderrClass: cls.stderrClass,
      exitCode: cls.exitCode,
      errnoCode: cls.errnoCode,
    });
    return {
      key: null,
      result,
      stderrClass: cls.stderrClass,
      exitCode: cls.exitCode,
      errnoCode: cls.errnoCode,
    };
  }
}

/**
 * Fetch API key from Linux libsecret via secret-tool.
 * Returns the trimmed key on success; null on miss, ENOENT, or D-Bus unavailable.
 *
 * @param {string} account
 * @returns {string|null}
 */
/**
 * Fetch API key from Linux libsecret via secret-tool.
 *
 * @param {string} account
 * @param {string} service - keychain service name (shared or AO-owned)
 * @returns {FetchResult}
 */
function fromSecretToolLinux(account, service) {
  // Try each known absolute path in order, then plain 'secret-tool' (PATH lookup).
  // execFileSync with bin name (no slash) uses the env PATH in the child spec
  // — safe because args are argv (no shell interpolation).
  const candidates = [...LINUX_SECRET_TOOL_BINS, 'secret-tool'];
  const startedAt = Date.now();
  for (const bin of candidates) {
    try {
      const stdout = _execFileSync(
        bin,
        ['lookup', 'service', service, 'account', account],
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
      const key = _extractKey(trimmed);
      _emitEvent({
        event: 'gemini_cred_resolve',
        stage: 'fetch_end',
        backend: 'linux_secret_tool',
        account,
        service,
        result: key ? 'hit' : 'miss',
        elapsedMs: Date.now() - startedAt,
        binary: bin,
        keyMask: key ? maskKey(key) : null,
      });
      return { key, result: key ? 'hit' : 'miss' };
    } catch (err) {
      // ENOENT means THIS path doesn't have the binary — try the next candidate.
      // Any other error (exit!=0, D-Bus failure, etc.) means we reached the tool
      // but it couldn't resolve the key — stop and return error (don't retry
      // with a different path, we already found a working binary).
      if (err && err.code === 'ENOENT') continue;
      const cls = _classifyError(err);
      _emitEvent({
        event: 'gemini_cred_resolve',
        stage: 'fetch_end',
        backend: 'linux_secret_tool',
        account,
        service,
        result: 'error',
        elapsedMs: Date.now() - startedAt,
        binary: bin,
        stderrClass: cls.stderrClass,
        exitCode: cls.exitCode,
        errnoCode: cls.errnoCode,
      });
      return {
        key: null,
        result: 'error',
        stderrClass: cls.stderrClass,
        exitCode: cls.exitCode,
        errnoCode: cls.errnoCode,
      };
    }
  }
  _emitEvent({
    event: 'gemini_cred_resolve',
    stage: 'fetch_end',
    backend: 'linux_secret_tool',
    account,
    service,
    result: 'error',
    elapsedMs: Date.now() - startedAt,
    stderrClass: 'binary_not_found',
    exitCode: null,
    errnoCode: 'ENOENT',
  });
  return {
    key: null,
    result: 'error',
    stderrClass: 'binary_not_found',
    exitCode: null,
    errnoCode: 'ENOENT',
  };
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
 * @typedef {('auto'|'env'|'shared-keychain'|'ao-keychain')} CredentialSource
 */

/**
 * @typedef {Object} ResolveOpts
 * @property {string} [account='default-api-key']
 * @property {CredentialSource} [credentialSource='auto']
 * @property {string|null} [service] - explicit keychain service name override; null = derive from credentialSource
 * @property {boolean} [useKeychain=true] - DEPRECATED; `useKeychain: false` normalizes to `credentialSource: 'env'`
 * @property {boolean} [forceRefresh=false]
 */

/**
 * Normalize legacy `useKeychain` + new `credentialSource` opts into one value.
 * Explicit credentialSource wins; falls back to useKeychain=false → env, else auto.
 * Invalid credentialSource strings silently fall through to auto (fail-safe).
 *
 * @param {ResolveOpts} opts
 * @returns {CredentialSource}
 */
function _normalizeCredentialSource(opts) {
  const raw = opts.credentialSource;
  if (typeof raw === 'string') {
    if (raw === 'auto' || raw === 'env' || raw === 'shared-keychain' || raw === 'ao-keychain') {
      return raw;
    }
    // invalid value → emit a diagnostic so the caller knows we ignored it
    try {
      process.stderr.write(JSON.stringify({
        event: 'gemini_cred_resolve_config_invalid',
        field: 'credentialSource',
        received: raw,
        fallback: 'auto',
      }) + '\n');
    } catch { /* never throw from logging */ }
  }
  if (opts.useKeychain === false) return 'env';
  return 'auto';
}

/**
 * Pick the keychain service name for a given source.
 * Explicit `opts.service` override wins (non-empty string).
 * For shared-keychain/auto, use the gemini CLI default `gemini-cli-api-key`.
 * For ao-keychain, use the AO-owned service name.
 *
 * @param {CredentialSource} source
 * @param {string|null|undefined} explicit
 * @returns {string}
 */
function _resolveServiceName(source, explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  if (source === 'ao-keychain') return AO_KEYCHAIN_SERVICE;
  return SHARED_KEYCHAIN_SERVICE;
}

/**
 * Resolve GEMINI_API_KEY for a gemini CLI spawn.
 *
 * Credential-source semantics:
 *   - 'auto' (default): env → shared-keychain → miss. Does NOT try ao-keychain
 *     automatically — stale AO items must not silently shadow fresh gemini CLI keys.
 *   - 'env': process.env.GEMINI_API_KEY only, no keychain consulted.
 *   - 'shared-keychain': skip env, read gemini CLI's own `gemini-cli-api-key` item.
 *   - 'ao-keychain': skip env, read AO-owned `agent-olympus.gemini-api-key` item.
 *
 * Env precedence explanation: for 'auto', if `process.env.GEMINI_API_KEY` is defined
 * (any value including empty string), the keychain is never consulted. Empty env
 * means "explicitly no key"; exporting `GEMINI_API_KEY=""` to disable the keychain
 * path is supported. For the explicit keychain sources, env is bypassed entirely.
 *
 * Per-(platform, service, account) cache with split TTL (24h hit / 30s miss
 * / 60s error). Never throws.
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
  const credentialSource = _normalizeCredentialSource(safeOpts);
  const service = _resolveServiceName(credentialSource, safeOpts.service);
  const forceRefresh = safeOpts.forceRefresh === true;
  const startedAt = Date.now();

  _emitEvent({
    event: 'gemini_cred_resolve',
    stage: 'start',
    account,
    service,
    credentialSource,
    platform: process.platform,
    forceRefresh,
  });

  // 1. env is consulted ONLY for 'auto'. Explicit 'shared-keychain'/'ao-keychain'
  //    skip env — those sources are a user statement of intent. 'env' reads env
  //    and stops regardless of whether the var is set.
  if (credentialSource === 'auto' || credentialSource === 'env') {
    const envVal = process.env.GEMINI_API_KEY;
    if (envVal !== undefined) {
      const key = envVal.length > 0 ? envVal : null;
      _emitEvent({
        event: 'gemini_cred_resolve',
        stage: 'end',
        source: 'env',
        credentialSource,
        service,
        result: key ? 'hit' : 'miss',
        account,
        elapsedMs: Date.now() - startedAt,
        keyMask: key ? maskKey(key) : null,
      });
      return key;
    }
    if (credentialSource === 'env') {
      _emitEvent({
        event: 'gemini_cred_resolve',
        stage: 'end',
        source: 'env',
        credentialSource,
        service,
        result: 'miss',
        account,
        elapsedMs: Date.now() - startedAt,
      });
      return null;
    }
  }

  // Cache key INCLUDES service name so shared-keychain and ao-keychain hits
  // don't collide. Without this a prior resolve from shared could shadow an
  // ao-keychain lookup for the same account.
  const cacheKey = `${process.platform}:${service}:${account}`;
  if (!forceRefresh) {
    const hit = _cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      _emitEvent({
        event: 'gemini_cred_resolve',
        stage: 'end',
        source: 'cache',
        credentialSource,
        service,
        result: hit.key ? 'hit' : 'miss',
        account,
        elapsedMs: Date.now() - startedAt,
        keyMask: hit.key ? maskKey(hit.key) : null,
      });
      return hit.key;
    }
  }

  /** @type {FetchResult} */
  let fetchResult = { key: null, result: 'miss' };
  let backend = 'unsupported';
  if (process.platform === 'darwin') {
    backend = 'macos_security';
    fetchResult = fromKeychainMacOS(account, service);
  } else if (process.platform === 'linux') {
    backend = 'linux_secret_tool';
    fetchResult = fromSecretToolLinux(account, service);
  } else if (process.platform === 'win32') {
    backend = 'windows_unsupported';
    showWindowsNoticeOnce();
    fetchResult = {
      key: null,
      result: 'error',
      stderrClass: 'windows_unsupported',
      exitCode: null,
      errnoCode: null,
    };
  }

  const resolved = fetchResult.key;
  // Split TTL by result kind (PR 4): 24h for hit, 30s for miss, 60s for error.
  // See SUCCESS_TTL_MS / MISS_TTL_MS / ERROR_TTL_MS block for rationale.
  let ttl;
  if (fetchResult.result === 'hit') ttl = SUCCESS_TTL_MS;
  else if (fetchResult.result === 'error') ttl = ERROR_TTL_MS;
  else ttl = MISS_TTL_MS;
  _cache.set(cacheKey, {
    platform: process.platform,
    account,
    service,
    key: resolved,
    expiresAt: Date.now() + ttl,
  });
  // Carry the fetch-time classification up to the `end` event so downstream
  // tooling can filter on stage=="end" alone and still distinguish miss from
  // error without having to also watch `fetch_end`.
  const endEvent = {
    event: 'gemini_cred_resolve',
    stage: 'end',
    source: backend,
    credentialSource,
    service,
    result: fetchResult.result,
    account,
    elapsedMs: Date.now() - startedAt,
    keyMask: resolved ? maskKey(resolved) : null,
  };
  if (fetchResult.stderrClass !== undefined) endEvent.stderrClass = fetchResult.stderrClass;
  if (fetchResult.exitCode !== undefined) endEvent.exitCode = fetchResult.exitCode;
  if (fetchResult.errnoCode !== undefined) endEvent.errnoCode = fetchResult.errnoCode;
  _emitEvent(endEvent);
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
