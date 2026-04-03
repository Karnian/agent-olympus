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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Valid Gemini approval modes. */
const VALID_MODES = ['default', 'auto_edit', 'yolo', 'plan'];

/**
 * Read and parse a JSON file, returning null on any error.
 * @param {string} filePath
 * @returns {object|null}
 */
function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Extract the permissions.allow array from a Claude settings file.
 * Returns an empty array if the file doesn't exist or is malformed.
 *
 * @param {string} filePath
 * @returns {string[]}
 */
function getAllowList(filePath) {
  const data = readJson(filePath);
  if (!data?.permissions?.allow || !Array.isArray(data.permissions.allow)) {
    return [];
  }
  return data.permissions.allow;
}

/**
 * Detect Claude Code's permission level from settings files and return
 * the corresponding Gemini approval mode.
 *
 * Checks (in priority order):
 *   1. Project-level: `<cwd>/.claude/settings.local.json`
 *   2. User-level: `~/.claude/settings.local.json`
 *   3. User-level: `~/.claude/settings.json`
 *
 * The first file with a non-empty allow list wins.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd] - Project root (default: process.cwd())
 * @param {string} [opts.home] - Home directory override (for testing)
 * @returns {{ hasBashStar: boolean, hasWriteStar: boolean, hasEditStar: boolean }}
 */
export function _detectClaudePermissions(opts = {}) {
  try {
    const cwd = opts.cwd || process.cwd();
    const home = opts.home || process.env.HOME || process.env.USERPROFILE || '';

    const sources = [
      join(cwd, '.claude', 'settings.local.json'),
      join(home, '.claude', 'settings.local.json'),
      join(home, '.claude', 'settings.json'),
    ];

    let allowList = [];
    for (const src of sources) {
      const list = getAllowList(src);
      if (list.length > 0) {
        allowList = list;
        break;
      }
    }

    const hasBashStar = allowList.some(p => p === 'Bash(*)' || p === 'Bash');
    const hasWriteStar = allowList.some(p => p === 'Write(*)' || p === 'Write');
    const hasEditStar = allowList.some(p => p === 'Edit(*)' || p === 'Edit');

    return { hasBashStar, hasWriteStar, hasEditStar };
  } catch {
    return { hasBashStar: false, hasWriteStar: false, hasEditStar: false };
  }
}

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
    const { hasBashStar, hasWriteStar, hasEditStar } = _detectClaudePermissions(opts);

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
