/**
 * Unified Claude Code permission detection — shared by codex-approval.mjs and gemini-approval.mjs.
 *
 * Reads Claude Code's permission configuration from settings files and detects
 * the current permission level. Also checks deny lists for safety.
 *
 * Zero npm dependencies — uses Node.js built-ins only.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read and parse a JSON file, returning null on any error.
 */
function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Extract permissions.allow array from a Claude settings file.
 */
function getAllowList(filePath) {
  const data = readJson(filePath);
  if (!data?.permissions?.allow || !Array.isArray(data.permissions.allow)) {
    return [];
  }
  return data.permissions.allow;
}

/**
 * Extract permissions.deny array from a Claude settings file.
 */
function getDenyList(filePath) {
  const data = readJson(filePath);
  if (!data?.permissions?.deny || !Array.isArray(data.permissions.deny)) {
    return [];
  }
  return data.permissions.deny;
}

/**
 * Detect Claude Code's permission flags from settings files.
 *
 * Checks (in priority order):
 *   1. Project-level: `<cwd>/.claude/settings.local.json`
 *   2. User-level: `~/.claude/settings.local.json`
 *   3. User-level: `~/.claude/settings.json`
 *
 * The first file with a non-empty allow list wins.
 * Deny lists from ALL files are merged (any deny blocks the permission).
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd] - Project root (default: process.cwd())
 * @param {string} [opts.home] - Home directory override (for testing)
 * @returns {{ hasBashStar: boolean, hasWriteStar: boolean, hasEditStar: boolean }}
 */
export function detectClaudePermissions(opts = {}) {
  try {
    const cwd = opts.cwd || process.cwd();
    const home = opts.home || process.env.HOME || process.env.USERPROFILE || '';

    const sources = [
      join(cwd, '.claude', 'settings.local.json'),
      join(home, '.claude', 'settings.local.json'),
      join(home, '.claude', 'settings.json'),
    ];

    // Get allow list (first file with non-empty list wins)
    let allowList = [];
    for (const src of sources) {
      const list = getAllowList(src);
      if (list.length > 0) {
        allowList = list;
        break;
      }
    }

    // Merge deny lists from ALL sources (any deny blocks the permission)
    const denyList = [];
    for (const src of sources) {
      denyList.push(...getDenyList(src));
    }

    // Check for broad permissions in allow list
    const hasBashStar = allowList.some(p => p === 'Bash(*)' || p === 'Bash');
    const hasWriteStar = allowList.some(p => p === 'Write(*)' || p === 'Write');
    const hasEditStar = allowList.some(p => p === 'Edit(*)' || p === 'Edit');

    // Check deny list — if a permission is explicitly denied, override
    const bashDenied = denyList.some(p => p === 'Bash(*)' || p === 'Bash');
    const writeDenied = denyList.some(p => p === 'Write(*)' || p === 'Write');
    const editDenied = denyList.some(p => p === 'Edit(*)' || p === 'Edit');

    return {
      hasBashStar: hasBashStar && !bashDenied,
      hasWriteStar: hasWriteStar && !writeDenied,
      hasEditStar: hasEditStar && !editDenied,
    };
  } catch {
    return { hasBashStar: false, hasWriteStar: false, hasEditStar: false };
  }
}

/**
 * Map detected Claude permissions to a Codex-style approval level string.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {string} [opts.home]
 * @returns {'full-auto' | 'auto-edit' | 'suggest'}
 */
export function detectClaudePermissionLevel(opts = {}) {
  const { hasBashStar, hasWriteStar, hasEditStar } = detectClaudePermissions(opts);
  if (hasBashStar && hasWriteStar) return 'full-auto';
  if (hasWriteStar || hasEditStar) return 'auto-edit';
  return 'suggest';
}

/**
 * Map a Codex-style permission level to a Claude CLI --permission-mode value.
 *
 * @param {'full-auto' | 'auto-edit' | 'suggest'} level
 * @returns {string} Claude CLI --permission-mode value
 */
export function claudePermissionModeFlag(level) {
  switch (level) {
    case 'full-auto': return 'bypassPermissions';
    case 'auto-edit': return 'acceptEdits';
    case 'suggest':
    default:
      return 'default';
  }
}
