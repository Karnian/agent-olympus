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
// Partition identifiers that grant `/usr/bin/security` (Apple-signed) zero-prompt
// read access. On Sonoma+, the `-T <app>` ACL alone is not sufficient — the
// keychain item also checks its partition list. `apple-tool:` covers the
// signed /usr/bin/security binary, `apple:` covers other Apple-signed tools.
// No `teamid:` needed because we never read via a third-party signed binary.
const PARTITION_LIST = 'apple-tool:,apple:';

// Test hooks for injecting a mock spawnSync / TTY state without polluting callers.
let _spawnSync = nodeSpawnSync;
let _isTty = () => process.stdin.isTTY === true;
/** @internal */
export function __setSpawnSyncForTest(fn) {
  _spawnSync = typeof fn === 'function' ? fn : nodeSpawnSync;
}
/** @internal */
export function __resetSpawnSyncForTest() {
  _spawnSync = nodeSpawnSync;
}
/** @internal */
export function __setIsTtyForTest(fn) {
  _isTty = typeof fn === 'function' ? fn : () => process.stdin.isTTY === true;
}
/** @internal */
export function __resetIsTtyForTest() {
  _isTty = () => process.stdin.isTTY === true;
}

/**
 * @typedef {Object} WriteResult
 * @property {boolean} ok - true when the `add-generic-password` step succeeded.
 *   NOTE: partition-list status is reported separately via `partitionListSet`.
 *   Callers that want zero-prompt future reads must check BOTH fields.
 * @property {string|null} error - human-readable error message on failure, else null
 * @property {number|null} exitCode - exit code of `add-generic-password`
 * @property {string|null} stderr - stderr from `add-generic-password` (sanitized; NO secret)
 * @property {boolean} partitionListSet - true when the partition-list step succeeded.
 *   When false, the item was still written but `/usr/bin/security` may prompt
 *   for the login password on future reads.
 * @property {boolean} partitionSkipped - true when the partition-list step was
 *   skipped (e.g. non-TTY stdin). Callers can distinguish "skipped" from
 *   "attempted and failed" for clearer user messaging.
 * @property {string|null} partitionWarning - user-facing remediation hint when
 *   the partition-list step did not succeed; null on full success.
 * @property {number|null} partitionExitCode - exit code of
 *   `set-generic-password-partition-list`; null if skipped or spawn-errored.
 */

/**
 * Write the AO-owned keychain item in two sequential `security` calls:
 *
 * 1. `security add-generic-password -U -T ... -w` (existing behavior).
 * 2. `security set-generic-password-partition-list -S "apple-tool:,apple:"`
 *    (NEW — required on Sonoma+ for `/usr/bin/security` to read without a
 *    login-password prompt).
 *
 * Step 2 is ONLY attempted when stdin is a TTY (the child `security` process
 * prompts for the login password via `readpassphrase(3)` on /dev/tty). In
 * piped/CI mode the step is SKIPPED with a clear warning telling the user
 * how to run the command manually on a TTY. Step 1 succeeding alone still
 * returns `ok: true` — the item IS written and some environments may not
 * need partition-list grants (older macOS, custom keychains).
 *
 * Semantics of step 1 (per `security help add-generic-password`):
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
 * @param {number} [opts.timeoutMs=60000]
 * @param {'auto'|'skip'} [opts.partitionList='auto'] - 'auto' runs the
 *   partition-list step when stdin is TTY, skips otherwise. 'skip' disables
 *   the step entirely (for tests or callers who set partitions separately).
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
    return _failedAdd(
      `spawn failed: ${result.error.code || result.error.message}`,
      null,
      null,
    );
  }
  if (typeof result.status !== 'number') {
    // Killed by signal (usually timeout SIGTERM)
    return _failedAdd(
      `security exited via signal ${result.signal || 'unknown'}`,
      null,
      _sanitizeStderr(result.stderr, apiKey),
    );
  }
  if (result.status !== 0) {
    return _failedAdd(
      `security exited with status ${result.status}`,
      result.status,
      _sanitizeStderr(result.stderr, apiKey),
    );
  }

  // Step 2: partition-list. Non-fatal if it fails — the item is already
  // written, just future reads may prompt. See _runPartitionListStep docstring.
  const partitionMode = safeOpts.partitionList === 'skip' ? 'skip' : 'auto';
  const partition = _runPartitionListStep({
    account, service, timeoutMs, mode: partitionMode,
  });

  return {
    ok: true,
    error: null,
    exitCode: 0,
    stderr: null,
    partitionListSet: partition.ok,
    partitionSkipped: partition.skipped,
    partitionWarning: partition.warning,
    partitionExitCode: partition.exitCode,
  };
}

/**
 * Build a failure WriteResult for the `add-generic-password` step. Keeps the
 * partition fields consistent (null/false) so callers can rely on shape.
 */
function _failedAdd(error, exitCode, stderr) {
  return {
    ok: false,
    error,
    exitCode,
    stderr,
    partitionListSet: false,
    partitionSkipped: true,
    partitionWarning: null,
    partitionExitCode: null,
  };
}

/**
 * Run `security set-generic-password-partition-list -S "apple-tool:,apple:"`.
 *
 * This requires the login keychain password, which `security` reads via
 * `readpassphrase(3)` on /dev/tty. We therefore only attempt the step when
 * `process.stdin.isTTY` — piped / CI callers get a skip + warning instead.
 *
 * `stdio: 'inherit'` is used so the `password to unlock default:` prompt
 * reaches the user's terminal and typed input reaches `security`. This
 * trades stderr capture for correct UX — if the call fails we surface the
 * exit code with a remediation hint, not raw stderr.
 *
 * We do NOT pass `-k <password>` — that would either require capturing the
 * user's login password in our process (expanding attack surface) or place
 * it on argv (visible in `ps`). The TTY prompt is the documented, safe path.
 *
 * @param {{account: string, service: string, timeoutMs: number, mode: 'auto'|'skip'}} params
 * @returns {{ok: boolean, skipped: boolean, warning: string|null, exitCode: number|null}}
 */
function _runPartitionListStep({ account, service, timeoutMs, mode }) {
  const manualCmd = `security set-generic-password-partition-list -s "${service}" -a "${account}" -S "${PARTITION_LIST}"`;

  if (mode === 'skip') {
    return {
      ok: false,
      skipped: true,
      warning:
        `partition-list step skipped by caller. To grant /usr/bin/security zero-prompt read access, run on a TTY:\n  ${manualCmd}`,
      exitCode: null,
    };
  }
  if (!_isTty()) {
    return {
      ok: false,
      skipped: true,
      warning:
        `partition-list step skipped: stdin is not a TTY (piped / CI mode) so ` +
        `security cannot prompt for the login password. Run on a TTY:\n  ${manualCmd}`,
      exitCode: null,
    };
  }

  const args = [
    'set-generic-password-partition-list',
    '-s', service,
    '-a', account,
    '-S', PARTITION_LIST,
  ];

  const result = _spawnSync(SECURITY_BIN, args, {
    stdio: 'inherit',
    timeout: timeoutMs,
  });

  if (result.error) {
    return {
      ok: false,
      skipped: false,
      warning:
        `partition-list spawn failed: ${result.error.code || result.error.message}. ` +
        `Future reads may trigger the keychain password prompt. Run manually:\n  ${manualCmd}`,
      exitCode: null,
    };
  }
  if (typeof result.status !== 'number') {
    return {
      ok: false,
      skipped: false,
      warning:
        `partition-list killed by signal ${result.signal || 'unknown'}. ` +
        `Future reads may trigger the keychain password prompt. Run manually:\n  ${manualCmd}`,
      exitCode: null,
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      skipped: false,
      warning:
        `partition-list exited with status ${result.status}. ` +
        `Future reads may trigger the keychain password prompt. Run manually:\n  ${manualCmd}`,
      exitCode: result.status,
    };
  }
  return { ok: true, skipped: false, warning: null, exitCode: 0 };
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

export const _consts = { SECURITY_BIN, DEFAULT_AO_SERVICE, DEFAULT_ACCOUNT, PARTITION_LIST };
