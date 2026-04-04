/**
 * Codex Approval Mode — mirrors Claude's permission level to Codex CLI.
 *
 * Detects Claude Code's current permission configuration and maps it to
 * a Codex approval mode so Codex workers run with equivalent permissions.
 *
 * Mapping:
 *   Claude "Bash(*)" + "Write(*)" in allow → codex "full-auto"
 *   Claude "Write(*)" or "Edit(*)" in allow  → codex "auto-edit"
 *   Otherwise / detection fails               → codex "suggest"
 *
 * Users can override via `.ao/autonomy.json`:
 *   { "codex": { "approval": "full-auto" } }
 *
 * The "auto" setting (default) triggers detection from Claude settings.
 *
 * Zero npm dependencies — uses Node.js built-ins only.
 */

import {
  detectClaudePermissions,
  detectClaudePermissionLevel,
} from './permission-detect.mjs';

// Re-export for backward compatibility
export { detectClaudePermissionLevel };

/** Valid Codex approval modes. */
const VALID_MODES = ['suggest', 'auto-edit', 'full-auto'];

/**
 * Resolve the Codex approval mode from autonomy config + Claude detection.
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

    // If user set a specific mode, use it (validated)
    if (explicit && VALID_MODES.includes(explicit)) {
      return explicit;
    }

    // "auto" or unset → detect from Claude permissions
    return detectClaudePermissionLevel(opts);
  } catch {
    return 'suggest';
  }
}

/**
 * Build the Codex CLI approval flags for a given mode.
 *
 * @param {'suggest' | 'auto-edit' | 'full-auto'} mode
 * @returns {string} CLI flag string (e.g. "--full-auto") or empty string
 */
export function codexApprovalFlag(mode) {
  switch (mode) {
    case 'full-auto': return '--full-auto';
    case 'auto-edit': return '--auto-edit';
    case 'suggest':
    default:
      return '';
  }
}
