/**
 * Preflight validation for Atlas/Athena/Plan orchestrators.
 *
 * Detects and cleans stale .ao/ state that causes silent failures:
 * - Pointer files in .ao/spec.md or .ao/prd.json (leftover from prior projects)
 * - Expired checkpoints (>24h)
 * - Orphaned team state files
 *
 * Called by session-start.mjs and directly by orchestrator skills before Phase 0.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const AO_DIR = '.ao';
const STATE_DIR = path.join(AO_DIR, 'state');

/**
 * Detect if file content is a stale pointer (from a previous project).
 *
 * Pointer files are small files (~1-5 lines) that reference a canonical
 * spec location elsewhere. When a new orchestrator runs, these must be
 * cleared so the new spec can be written.
 *
 * @param {string} content - File content
 * @returns {{ isPointer: boolean, target?: string }}
 */
export function detectPointerFile(content) {
  if (!content || typeof content !== 'string') return { isPointer: false };

  const trimmed = content.trim();
  const lines = trimmed.split('\n').filter(l => l.trim().length > 0);

  // Pointer files are very short (≤5 non-empty lines)
  if (lines.length > 5) return { isPointer: false };

  // Pattern 1: "# Pointer — <name>\nCanonical: <path>"
  if (/^#\s*Pointer/i.test(trimmed)) {
    const canonical = trimmed.match(/Canonical:\s*(.+)/i);
    return { isPointer: true, target: canonical?.[1]?.trim() };
  }

  // Pattern 2: Only a file path reference (e.g., "docs/specs/FOO.md")
  if (lines.length <= 2 && /^[\w./-]+\.(md|json)$/i.test(lines[0])) {
    return { isPointer: true, target: lines[0] };
  }

  // Pattern 3: JSON with only a "canonical" or "ref" field
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' &&
        (parsed.canonical || parsed.ref || parsed.$ref) &&
        Object.keys(parsed).length <= 3) {
      return { isPointer: true, target: parsed.canonical || parsed.ref || parsed.$ref };
    }
  } catch {
    // not JSON — that's fine
  }

  return { isPointer: false };
}

/**
 * Clean stale pointer files from .ao/ directory.
 * Returns list of cleaned files for logging.
 *
 * @returns {Promise<string[]>} List of cleaned file paths
 */
export async function cleanStalePointers() {
  const cleaned = [];
  const targets = [
    path.join(AO_DIR, 'spec.md'),
    path.join(AO_DIR, 'prd.json'),
  ];

  for (const filePath of targets) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const { isPointer, target } = detectPointerFile(content);
      if (isPointer) {
        await fs.unlink(filePath);
        cleaned.push(`${filePath} (pointed to: ${target || 'unknown'})`);
      }
    } catch {
      // File doesn't exist or can't be read — that's fine
    }
  }

  return cleaned;
}

/**
 * Validate .ao/ directory state before orchestrator execution.
 * Returns a report of issues found and actions taken.
 *
 * @returns {Promise<{ valid: boolean, actions: string[], warnings: string[] }>}
 */
export async function runPreflight() {
  const actions = [];
  const warnings = [];

  // 1. Clean stale pointer files
  const cleaned = await cleanStalePointers();
  for (const f of cleaned) {
    actions.push(`Removed stale pointer: ${f}`);
  }

  // 2. Check for expired checkpoints (> 24h) and clean them
  const TTL_MS = 24 * 60 * 60 * 1000;
  for (const orchestrator of ['atlas', 'athena']) {
    const cpPath = path.join(STATE_DIR, `checkpoint-${orchestrator}.json`);
    try {
      const raw = await fs.readFile(cpPath, 'utf-8');
      const cp = JSON.parse(raw);
      const savedAt = new Date(cp.savedAt).getTime();
      if (!Number.isNaN(savedAt) && (Date.now() - savedAt) > TTL_MS) {
        await fs.unlink(cpPath);
        actions.push(`Expired checkpoint cleaned: ${orchestrator} (${cp.savedAt})`);
      }
    } catch {
      // no checkpoint or parse error — fine
    }
  }

  // 3. Check for orphaned team state files (teams without any tmux sessions)
  try {
    const stateFiles = await fs.readdir(STATE_DIR);
    for (const file of stateFiles) {
      if (!file.startsWith('team-') || !file.endsWith('.json')) continue;
      const statePath = path.join(STATE_DIR, file);
      try {
        const raw = await fs.readFile(statePath, 'utf-8');
        const state = JSON.parse(raw);
        // If team state is > 2h old and phase is still 'spawning' or 'running',
        // it's likely orphaned
        const started = new Date(state.startedAt).getTime();
        if (!Number.isNaN(started) && (Date.now() - started) > 2 * 60 * 60 * 1000) {
          if (state.phase === 'spawning' || state.phase === 'running') {
            warnings.push(`Potentially orphaned team state: ${file} (started ${state.startedAt})`);
          }
        }
      } catch {
        // corrupt state file
        warnings.push(`Corrupt team state file: ${file}`);
      }
    }
  } catch {
    // state dir doesn't exist — fine
  }

  // 4. Validate .ao/prd.json if it exists (non-pointer, well-formed)
  try {
    const prdContent = await fs.readFile(path.join(AO_DIR, 'prd.json'), 'utf-8');
    const prd = JSON.parse(prdContent);
    if (!prd.projectName && !prd.mode) {
      warnings.push('.ao/prd.json exists but has no projectName or mode — may be malformed');
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // File exists but can't be parsed
      warnings.push('.ao/prd.json exists but is not valid JSON — will be overwritten');
    }
  }

  return {
    valid: warnings.length === 0,
    actions,
    warnings,
  };
}

/**
 * Format preflight report for prompt injection.
 * @param {{ valid: boolean, actions: string[], warnings: string[] }} report
 * @returns {string}
 */
export function formatPreflightReport(report) {
  if (report.actions.length === 0 && report.warnings.length === 0) {
    return '';
  }

  const parts = [];
  if (report.actions.length > 0) {
    parts.push('Preflight actions:\n' + report.actions.map(a => `  ✓ ${a}`).join('\n'));
  }
  if (report.warnings.length > 0) {
    parts.push('Preflight warnings:\n' + report.warnings.map(w => `  ⚠ ${w}`).join('\n'));
  }
  return parts.join('\n');
}
