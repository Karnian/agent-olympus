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

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Valid Codex approval modes. */
const VALID_MODES = ['suggest', 'auto-edit', 'full-auto'];

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
 * Detect Claude Code's permission level from settings files.
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
 * @returns {'full-auto' | 'auto-edit' | 'suggest'}
 */
export function detectClaudePermissionLevel(opts = {}) {
  try {
    const cwd = opts.cwd || process.cwd();
    const home = opts.home || process.env.HOME || process.env.USERPROFILE || '';

    // Collect allow entries from all settings files (project-level first)
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

    if (allowList.length === 0) {
      return 'suggest';
    }

    // Check for broad permissions
    const hasBash = allowList.some(p => p === 'Bash(*)' || p === 'Bash');
    const hasWrite = allowList.some(p => p === 'Write(*)' || p === 'Write');
    const hasEdit = allowList.some(p => p === 'Edit(*)' || p === 'Edit');

    // Bash(*) + Write(*) → equivalent to full autonomy
    if (hasBash && hasWrite) {
      return 'full-auto';
    }

    // Write or Edit permissions → can modify files but not arbitrary shell
    if (hasWrite || hasEdit) {
      return 'auto-edit';
    }

    // Read-only or restricted permissions
    return 'suggest';
  } catch {
    return 'suggest';
  }
}

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
