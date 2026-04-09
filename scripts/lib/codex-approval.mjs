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

// Re-export for backward compatibility
export { detectClaudePermissionLevel };

/** Valid abstract permission levels (shared with claude-cli, gemini adapters). */
const VALID_LEVELS = ['suggest', 'auto-edit', 'full-auto'];

/** Level → Codex sandbox mode (Codex 0.118+ enum). */
const SANDBOX_BY_LEVEL = {
  'full-auto': 'danger-full-access',
  'auto-edit': 'workspace-write',
  'suggest':   'read-only',
};

/**
 * Resolve the abstract permission level from autonomy config + Claude detection.
 *
 * Reads `autonomyConfig.codex.approval`. Valid explicit values pass through.
 * `'auto'` (default) or any unrecognized value falls back to detection from
 * Claude settings files via `detectClaudePermissionLevel`.
 *
 * @param {object} [autonomyConfig] - Loaded autonomy config (from loadAutonomyConfig)
 * @param {object} [opts]
 * @param {string} [opts.cwd] - Project root
 * @param {string} [opts.home] - Home directory override (for testing)
 * @returns {'suggest' | 'auto-edit' | 'full-auto'}
 */
export function resolveCodexApproval(autonomyConfig, opts = {}) {
  try {
    const explicit = autonomyConfig?.codex?.approval;
    if (explicit && VALID_LEVELS.includes(explicit)) {
      return explicit;
    }
    // 'auto' or unset → detect from Claude permissions
    return detectClaudePermissionLevel(opts);
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
