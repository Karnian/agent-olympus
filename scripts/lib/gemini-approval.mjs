/**
 * Gemini Approval Mode — mirrors Claude's permission level to Gemini CLI.
 *
 * Detects Claude Code's current permission configuration and maps it to
 * a Gemini approval mode so Gemini workers run with equivalent permissions.
 *
 * Security-first mapping (Plan A, 2026-04-14):
 *   - Literal broad `Bash` + `Write` in allow (no ask/deny interference)
 *                                         → `yolo`
 *   - defaultMode `bypassPermissions` (not disabled)
 *                                         → `yolo`
 *   - defaultMode `acceptEdits`           → `auto_edit`
 *   - Any broad/scoped Write/Edit grant, or scoped Bash grant
 *                                         → `auto_edit`
 *   - Otherwise                            → `default`
 *
 * Scoped Bash does NOT map to `yolo` — Gemini's `yolo` mode bypasses all
 * confirmations, including ones outside the user's scoped grant.
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

    // "auto" or unset → detect from Claude permissions.
    // defaultMode is already baked into per-tool flags by detectClaudePermissions
    // (bypassPermissions → all broad, acceptEdits → write/edit broad), with
    // deny/ask fail-closed applied uniformly.
    const p = detectClaudePermissions(opts);

    // Literal broad Bash + Write (no ask/deny interference) → yolo
    if (p.hasBashStar && p.hasWriteStar) {
      return 'yolo';
    }

    // Any Write/Edit grant (broad or scoped), or scoped Bash → auto_edit.
    // Scoped Bash does NOT promote to yolo: gemini's yolo bypasses all
    // confirmations and cannot honor the user's scoped restriction.
    if (
      p.hasWriteStar || p.hasEditStar ||
      p.hasWriteScoped || p.hasEditScoped ||
      p.hasBashScoped
    ) {
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
