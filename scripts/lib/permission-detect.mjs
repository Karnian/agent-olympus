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
 * Extract permissions.defaultMode from a Claude settings file.
 * Recognized Claude Code modes: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions'
 * Returns null if not set or unrecognized.
 */
function getDefaultMode(filePath) {
  const data = readJson(filePath);
  const mode = data?.permissions?.defaultMode;
  if (typeof mode !== 'string') return null;
  return mode;
}

/**
 * Match a permission entry against a tool name, broadened to any-argument form.
 * Matches bare name (`Bash`) or any parenthesized form (`Bash(*)`, `Bash(git:*)`, etc.).
 * Anchored to start-of-string so `NotebookEdit` does NOT match `Edit`.
 */
function matchesTool(entry, tool) {
  if (typeof entry !== 'string') return false;
  if (entry === tool) return true;
  return entry.startsWith(`${tool}(`);
}

/**
 * Detect Claude Code's permission flags from settings files.
 *
 * Checks (in priority order):
 *   1. Project-level: `<cwd>/.claude/settings.local.json`
 *   2. Project-level: `<cwd>/.claude/settings.json`    (team-committed)
 *   3. User-level:    `~/.claude/settings.local.json`
 *   4. User-level:    `~/.claude/settings.json`
 *
 * Permission signals combined (first-wins for allow/mode, union for deny):
 *   - `permissions.defaultMode`:
 *       'bypassPermissions' → implicit Bash + Write + Edit (all true)
 *       'acceptEdits'       → implicit Write + Edit (no Bash)
 *       other modes         → no implicit grant
 *   - `permissions.allow` entries: matched via any-argument form.
 *       `Bash`, `Bash(*)`, `Bash(git:*)`, `Bash(*:*)` → hasBashStar
 *       Same for `Write(...)`, `Edit(...)`.
 *   - `permissions.deny`: union across ALL files; any literal deny (`Bash(*)` /
 *     `Bash`) overrides the corresponding grant. Scoped deny entries
 *     (`Bash(curl:*)`) are NOT treated as full deny to avoid false negatives.
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
      join(cwd, '.claude', 'settings.json'),
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

    // Get defaultMode (first non-null wins, same priority as allow)
    let defaultMode = null;
    for (const src of sources) {
      const mode = getDefaultMode(src);
      if (mode) { defaultMode = mode; break; }
    }

    // Merge deny lists from ALL sources (any deny blocks the permission)
    const denyList = [];
    for (const src of sources) {
      denyList.push(...getDenyList(src));
    }

    // Broadened allow matching: any `Bash`/`Bash(...)` entry counts.
    // Rationale: users commonly scope Bash like `Bash(git:*)`. The host-Claude
    // session still runs those commands non-interactively once approved, so
    // treat the presence of any Bash grant as evidence that non-interactive
    // shell usage is acceptable for codex workers. If a user wants codex to
    // stay read-only despite broad Claude permissions, they override via
    // `.ao/autonomy.json` { codex: { approval: 'suggest' } }.
    const hasBashFromAllow  = allowList.some(p => matchesTool(p, 'Bash'));
    const hasWriteFromAllow = allowList.some(p => matchesTool(p, 'Write'));
    const hasEditFromAllow  = allowList.some(p => matchesTool(p, 'Edit'));

    // defaultMode implicit grants
    const bypass = defaultMode === 'bypassPermissions';
    const accept = defaultMode === 'acceptEdits';
    const hasBashFromMode  = bypass;
    const hasWriteFromMode = bypass || accept;
    const hasEditFromMode  = bypass || accept;

    // Deny is LITERAL only (strict). A scoped deny like `Bash(curl:*)` does
    // not imply a full Bash ban — the user only wanted to block curl.
    const bashDenied  = denyList.some(p => p === 'Bash(*)'  || p === 'Bash');
    const writeDenied = denyList.some(p => p === 'Write(*)' || p === 'Write');
    const editDenied  = denyList.some(p => p === 'Edit(*)'  || p === 'Edit');

    return {
      hasBashStar:  (hasBashFromAllow  || hasBashFromMode)  && !bashDenied,
      hasWriteStar: (hasWriteFromAllow || hasWriteFromMode) && !writeDenied,
      hasEditStar:  (hasEditFromAllow  || hasEditFromMode)  && !editDenied,
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
