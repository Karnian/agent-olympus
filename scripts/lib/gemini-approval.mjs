/**
 * Gemini Approval Mode — mirrors Claude's permission level to Gemini CLI.
 *
 * Detects Claude Code's current permission configuration and maps it to
 * a Gemini approval mode so Gemini workers run with equivalent permissions.
 *
 * Mapping:
 *   Claude "Bash(*)" + "Write(*)" in allow → gemini "--approval-mode yolo"
 *   Claude "Write(*)" or "Edit(*)" in allow  → gemini "--approval-mode auto_edit"
 *   Otherwise / detection fails               → gemini "--approval-mode default" (no flag)
 *
 * Users can override via `.ao/autonomy.json`:
 *   { "gemini": { "approval": "yolo" } }
 *
 * The "auto" setting (default) triggers detection from Claude settings.
 *
 * Zero npm dependencies — uses Node.js built-ins only.
 */

import { detectClaudePermissions } from './permission-detect.mjs';

// Re-export for backward compatibility
export { detectClaudePermissions as _detectClaudePermissions };

/** Valid Gemini approval modes. */
const VALID_MODES = ['default', 'auto_edit', 'yolo', 'plan'];

/**
 * Resolve the Gemini approval mode from autonomy config + Claude detection.
 *
 * @param {object} [autonomyConfig] - Loaded autonomy config (from loadAutonomyConfig)
 * @param {object} [opts]
 * @param {string} [opts.cwd] - Project root
 * @param {string} [opts.home] - Home directory override (for testing)
 * @returns {'default' | 'auto_edit' | 'yolo' | 'plan'}
 */
export function resolveGeminiApproval(autonomyConfig, opts = {}) {
  try {
    const explicit = autonomyConfig?.gemini?.approval;

    // If user set a specific non-auto mode, use it (validated)
    if (explicit && explicit !== 'auto' && VALID_MODES.includes(explicit)) {
      return explicit;
    }

    // "auto" or unset → detect from Claude permissions
    const { hasBashStar, hasWriteStar, hasEditStar } = detectClaudePermissions(opts);

    // Bash(*) + Write(*) → equivalent to full autonomy
    if (hasBashStar && hasWriteStar) {
      return 'yolo';
    }

    // Write or Edit permissions → can modify files but not arbitrary shell
    if (hasWriteStar || hasEditStar) {
      return 'auto_edit';
    }

    return 'default';
  } catch {
    return 'default';
  }
}

/**
 * Build the Gemini CLI approval flag string for a given mode.
 *
 * @param {'default' | 'auto_edit' | 'yolo' | 'plan'} mode
 * @returns {string} CLI flag string (e.g. "--approval-mode yolo") or empty string
 */
export function geminiApprovalFlag(mode) {
  switch (mode) {
    case 'yolo':     return '--approval-mode yolo';
    case 'auto_edit': return '--approval-mode auto_edit';
    case 'plan':     return '--approval-mode plan';
    case 'default':
    default:
      return '';
  }
}
