/**
 * Codex Permission Mirroring — sandbox-axis (Codex 0.118+).
 *
 * Mirrors the host Claude session's permission level into Codex worker invocations
 * via the SANDBOX axis (not the approval axis). Codex 0.118+ removed the
 * `--auto-edit` CLI flag and the docs explicitly recommend `never` approval for
 * non-interactive runs ("Prefer `on-request` for interactive runs or `never` for
 * non-interactive runs"). Both `codex exec` and `codex app-server` workers in
 * Agent Olympus are non-interactive — there is no TTY to prompt for approvals —
 * so we hold approval at `never` and vary the sandbox to express trust.
 *
 * Mapping:
 *   Claude `Bash(*) + Write(*)` in allow → sandbox `danger-full-access`
 *   Claude `Write(*)` or `Edit(*)` only  → sandbox `workspace-write`
 *   Otherwise (suggest)                  → caller MUST demote codex worker
 *
 * `suggest` level workers cannot run usefully under `read-only` sandbox (no
 * shell, no writes), so callers must check `shouldDemoteCodexWorker(level)`
 * BEFORE selecting a Codex adapter and route the work to a different worker
 * type instead. The mapping for `suggest` returns `read-only` only as a last-
 * resort safety value; production callers should never reach it.
 *
 * Users can override via `.ao/autonomy.json`:
 *   { "codex": { "approval": "full-auto" } }     // forces danger-full-access
 *   { "codex": { "approval": "auto-edit" } }     // forces workspace-write
 *   { "codex": { "approval": "suggest" } }       // forces demotion
 *   { "codex": { "approval": "auto" } }          // detect from Claude settings (default)
 *
 * The `codex.approval` key keeps its v1 name for backward compatibility, but
 * the value now controls the sandbox tier rather than the approval flag.
 *
 * Zero npm dependencies — uses Node.js built-ins only.
 */

import {
  detectClaudePermissions,
  detectClaudePermissionLevel,
} from './permission-detect.mjs';
import { detectHostSandbox } from './host-sandbox-detect.mjs';

// Re-export for backward compatibility
export { detectClaudePermissionLevel };
// Re-export so callers (worker-spawn wisdom warning) can access the same
// detection as resolveCodexApproval.
export { detectHostSandbox };

/** Valid abstract permission levels (shared with claude-cli, gemini adapters). */
const VALID_LEVELS = ['suggest', 'auto-edit', 'full-auto'];

/** Level → Codex sandbox mode (Codex 0.118+ enum). */
const SANDBOX_BY_LEVEL = {
  'full-auto': 'danger-full-access',
  'auto-edit': 'workspace-write',
  'suggest':   'read-only',
};

/**
 * Numeric tiers used to pick the more restrictive of two permission signals
 * (permissions.allow vs. host sandbox). Higher = more permissive.
 */
const PERM_TIER = { 'full-auto': 3, 'auto-edit': 2, 'suggest': 1 };
const TIER_TO_LEVEL = { 3: 'full-auto', 2: 'auto-edit', 1: 'suggest' };
/**
 * Host sandbox tier mapping. `'unknown'` maps to `3` (unrestricted) so that
 * detection failure does NOT silently downgrade the permission level —
 * a silent downgrade would be worse than no detection. Callers surface the
 * `unknown` case via wisdom warnings so the user can set an explicit override.
 */
const HOST_TIER = {
  'unrestricted': 3,
  'workspace-write': 2,
  'read-only': 1,
  'unknown': 3,
};

/**
 * Compute the effective Codex permission level by intersecting the
 * permissions.allow-derived level with the detected host sandbox tier.
 * Returns the more restrictive of the two (the min tier).
 *
 * @param {'suggest'|'auto-edit'|'full-auto'} permLevel
 * @param {import('./host-sandbox-detect.mjs').HostSandboxRecord} hostSandbox
 * @returns {'suggest'|'auto-edit'|'full-auto'}
 */
export function effectiveCodexLevel(permLevel, hostSandbox) {
  const pt = PERM_TIER[permLevel] || 1;
  const ht = HOST_TIER[hostSandbox?.tier] || 3;
  return TIER_TO_LEVEL[Math.min(pt, ht)];
}

/**
 * Resolve the effective codex permission level. Always intersects with the
 * detected host sandbox tier — the host sandbox is ground truth and is never
 * bypassed, even by an explicit `autonomyConfig.codex.approval`.
 *
 * Resolution steps:
 *   1. Derive a starting permLevel:
 *      - If `autonomyConfig.codex.approval` is a valid explicit tier, use it
 *        as the starting permLevel (user expresses a CEILING, not an override
 *        of the host sandbox).
 *      - Otherwise, detect from `permissions.allow`.
 *   2. Detect host sandbox via `detectHostSandbox` (same `opts` + autonomyConfig,
 *      so `AO_HOST_SANDBOX_LEVEL` / `codex.hostSandbox` are honored).
 *   3. Return `effectiveCodexLevel(permLevel, hostSandbox)` — the min tier.
 *
 * Rationale for not letting `codex.approval` bypass the host sandbox:
 * the whole point of host-sandbox detection is to prevent codex from
 * attempting operations the host cannot actually perform. A user who sets
 * `codex.approval = full-auto` inside a `read-only` host would otherwise
 * get codex workers that fail in confusing ways. If the user truly wants
 * to override the host detection, they must explicitly set
 * `codex.hostSandbox` (or `AO_HOST_SANDBOX_LEVEL`) to a higher tier.
 *
 * @param {object} [autonomyConfig] - Loaded autonomy config (from loadAutonomyConfig)
 * @param {object} [opts]
 * @param {string} [opts.cwd] - Project root
 * @param {string} [opts.home] - Home directory override (for testing)
 * @param {object} [opts.env] - Environment override (for testing)
 * @param {object} [opts.fs] - FS override (for testing)
 * @param {string} [opts.platformOverride] - Platform override (for testing)
 * @returns {'suggest' | 'auto-edit' | 'full-auto'}
 */
export function resolveCodexApproval(autonomyConfig, opts = {}) {
  try {
    // 1. Starting permLevel:
    //    - Explicit codex.approval becomes the ceiling permLevel
    //    - Otherwise detect from permissions.allow
    const explicit = autonomyConfig?.codex?.approval;
    const permLevel = (explicit && VALID_LEVELS.includes(explicit))
      ? explicit
      : detectClaudePermissionLevel(opts);

    // 2. Host sandbox detection (passive signals + explicit override)
    const hostSandbox = detectHostSandbox({ ...opts, autonomyConfig });

    // 3. Conservative intersection — host sandbox is ground truth and ALWAYS
    //    applied. The only way to force codex past the detected host tier is
    //    to explicitly set `codex.hostSandbox` / `AO_HOST_SANDBOX_LEVEL`.
    return effectiveCodexLevel(permLevel, hostSandbox);
  } catch {
    return 'suggest';
  }
}

/**
 * Map a permission level to a Codex sandbox mode string.
 *
 * @param {'suggest' | 'auto-edit' | 'full-auto'} level
 * @returns {'read-only' | 'workspace-write' | 'danger-full-access'}
 */
export function codexSandboxForLevel(level) {
  return SANDBOX_BY_LEVEL[level] || 'read-only';
}

/**
 * Build the Codex CLI argument list for the given permission level.
 *
 * IMPORTANT: These flags are GLOBAL Codex CLI flags and MUST appear BEFORE
 * the `exec` subcommand. The full invocation is:
 *
 *   codex -a never -s <sandbox> exec --json --ephemeral -
 *
 * Putting `-a`/`-s` after `exec` triggers `error: unexpected argument '-a'`
 * in Codex 0.118+.
 *
 * @param {'suggest' | 'auto-edit' | 'full-auto'} level
 * @returns {string[]} Argv fragment, e.g. ['-a', 'never', '-s', 'workspace-write']
 */
export function buildCodexExecArgs(level) {
  return ['-a', 'never', '-s', codexSandboxForLevel(level)];
}

/**
 * Build the Codex app-server `thread/start` params for the given permission level.
 *
 * Mirrors the same axis as `buildCodexExecArgs` but expressed as JSON-RPC
 * params (the app-server protocol carries `approvalPolicy` and `sandbox` as
 * fields rather than CLI flags).
 *
 * @param {'suggest' | 'auto-edit' | 'full-auto'} level
 * @returns {{ approvalPolicy: 'never', sandbox: string }}
 */
export function buildCodexAppServerParams(level) {
  return {
    approvalPolicy: 'never',
    sandbox: codexSandboxForLevel(level),
  };
}

/**
 * Build a human-readable host-sandbox warning message for Atlas/Athena wisdom
 * logging. Returns `null` when no warning is needed.
 *
 * Trigger conditions (filesystem tier only):
 *   - `hostSandbox.tier === 'unknown'` AND signals show a FILESYSTEM-scoped
 *     restriction hint: containerized, seccompActive, or noNewPrivs. These
 *     signals plausibly constrain filesystem access, so recommending a
 *     filesystem-tier override (`AO_HOST_SANDBOX_LEVEL`) is meaningful.
 *   - `networkRestricted` is intentionally NOT a trigger: it's a
 *     network-only signal (e.g. macOS OPERON_SANDBOXED_NETWORK) and the
 *     override this warning recommends sets a filesystem sandbox tier,
 *     not a network policy. Suggesting the override for a network-only
 *     signal would be misleading.
 *
 * @param {'suggest'|'auto-edit'|'full-auto'} effectiveLevel
 * @param {import('./host-sandbox-detect.mjs').HostSandboxRecord} hostSandbox
 * @returns {?string} Warning message, or null if none
 */
export function buildHostSandboxWarning(effectiveLevel, hostSandbox) {
  if (!hostSandbox || hostSandbox.tier !== 'unknown') return null;
  const s = hostSandbox.signals || {};
  const hints = [];
  if (s.containerized) hints.push('container');
  if (s.seccompActive) hints.push('seccomp filter');
  if (s.noNewPrivs) hints.push('NoNewPrivs');
  // No filesystem-scoped signals → nothing to warn about. networkRestricted
  // alone (e.g. macOS OPERON_SANDBOXED_NETWORK) does NOT trigger the warning
  // because AO_HOST_SANDBOX_LEVEL only controls filesystem tier.
  if (hints.length === 0) return null;

  return (
    `Host sandbox is unknown but detected filesystem-scoped signals: ${hints.join(', ')}. ` +
    `Codex workers will run at "${effectiveLevel}" — if the host is actually ` +
    `restricted, set AO_HOST_SANDBOX_LEVEL=workspace-write (or read-only) ` +
    `to prevent codex from attempting operations the host cannot perform.`
  );
}

/**
 * Should this Codex worker be demoted to a different worker type?
 *
 * `suggest` level means the host has neither `Bash(*)` nor `Write(*)/Edit(*)`,
 * so a `read-only` Codex worker would silently complete with "I can only
 * suggest changes" and confuse Atlas/Athena into marking the task done. The
 * caller must demote the worker (typically to `claude`) before adapter
 * selection so the task is actually executed.
 *
 * @param {'suggest' | 'auto-edit' | 'full-auto'} level
 * @returns {boolean}
 */
export function shouldDemoteCodexWorker(level) {
  return level === 'suggest';
}
