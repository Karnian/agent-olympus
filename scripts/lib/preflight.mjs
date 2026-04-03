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
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { resolveBinary } from './tmux-session.mjs';
import { resolveClaudeBinary } from './resolve-binary.mjs';

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
 * Parse a semver-like version string and check if it meets the minimum.
 * Accepts formats like "0.116.0" or "codex-cli 0.116.0".
 *
 * @param {string} versionStr
 * @param {number} minMajor
 * @param {number} minMinor
 * @param {number} minPatch
 * @returns {boolean}
 */
export function meetsMinVersion(versionStr, minMajor, minMinor, minPatch) {
  const match = String(versionStr).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  if (major > minMajor) return true;
  if (major < minMajor) return false;
  if (minor > minMinor) return true;
  if (minor < minMinor) return false;
  return patch >= minPatch;
}

/**
 * Detect available capabilities for orchestrator execution.
 * All checks are fail-safe: if detection fails, capability is marked false.
 *
 * @returns {Promise<{
 *   hasTmux: boolean,
 *   hasCodex: boolean,
 *   hasCodexExecJson: boolean,
 *   hasCodexAppServer: boolean,
 *   hasGeminiCli: boolean,
 *   hasGeminiAcp: boolean,
 *   hasGitWorktree: boolean,
 *   hasNativeTeamTools: boolean,
 *   hasPreviewMCP: boolean
 * }>}
 */
export async function detectCapabilities() {
  let hasTmux = false;
  try {
    // Use resolveBinary which checks PATH + fallback paths (homebrew, /usr/local, etc.)
    const tmuxBin = resolveBinary('tmux');
    if (tmuxBin && tmuxBin !== 'tmux') {
      hasTmux = true;
    } else {
      // bare name returned — try running it to see if the OS can find it
      execFileSync('which', ['tmux'], { stdio: 'ignore' });
      hasTmux = true;
    }
  } catch {
    // tmux not found
  }

  let hasCodex = false;
  try {
    const codexBin = resolveBinary('codex');
    if (codexBin && codexBin !== 'codex') {
      hasCodex = true;
    } else {
      execFileSync('which', ['codex'], { stdio: 'ignore' });
      hasCodex = true;
    }
  } catch {
    // codex not found
  }

  // Detect codex exec --json support (requires codex-cli >= 0.116.0)
  let hasCodexExecJson = false;
  let hasCodexAppServer = false;
  try {
    const codexVersion = execFileSync(resolveBinary('codex'), ['--version'], {
      stdio: 'pipe', encoding: 'utf-8', timeout: 5000,
    }).trim();
    hasCodexExecJson = meetsMinVersion(codexVersion, 0, 116, 0);
    // app-server is available in the same version range as exec --json
    // Detect by checking if 'codex app-server --help' succeeds
    if (hasCodexExecJson) {
      try {
        execFileSync(resolveBinary('codex'), ['app-server', '--help'], {
          stdio: 'pipe', encoding: 'utf-8', timeout: 5000,
        });
        hasCodexAppServer = true;
      } catch {
        // app-server subcommand not available in this build
        hasCodexAppServer = false;
      }
    }
  } catch {
    hasCodexExecJson = false;
    hasCodexAppServer = false;
  }

  // Detect Gemini CLI
  let hasGeminiCli = false;
  let hasGeminiAcp = false;
  try {
    const geminiBin = resolveBinary('gemini');
    if (geminiBin && geminiBin !== 'gemini') {
      hasGeminiCli = true;
    } else {
      execFileSync('which', ['gemini'], { stdio: 'ignore' });
      hasGeminiCli = true;
    }
  } catch {
    // gemini not found
  }

  if (hasGeminiCli) {
    try {
      // Detect ACP support by checking if --acp flag is mentioned in help
      const helpOutput = execFileSync(resolveBinary('gemini'), ['--help'], {
        stdio: 'pipe', encoding: 'utf-8', timeout: 5000,
      });
      hasGeminiAcp = /--acp|--experimental-acp/i.test(helpOutput);
    } catch {
      hasGeminiAcp = false;
    }
  }

  // Detect Claude CLI (claude -p mode for headless worker execution)
  let hasClaudeCli = false;
  try {
    const claudePath = resolveClaudeBinary();
    if (claudePath && claudePath !== 'claude') {
      // Binary found via versioned path discovery
      hasClaudeCli = true;
    } else {
      // Try running --version to verify it works
      execFileSync(claudePath, ['--version'], {
        stdio: 'pipe', encoding: 'utf-8', timeout: 5000,
      });
      hasClaudeCli = true;
    }
  } catch {
    hasClaudeCli = false;
  }

  let hasGitWorktree = false;
  try {
    execFileSync('git', ['worktree', 'list'], { stdio: 'ignore' });
    hasGitWorktree = true;
  } catch {
    // git worktree not available
  }

  // Native Agent Teams require experimental env var
  const hasNativeTeamTools = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === '1';

  // Preview MCP is available if .claude/launch.json exists
  const hasPreviewMCP = existsSync('.claude/launch.json');

  return { hasTmux, hasCodex, hasCodexExecJson, hasCodexAppServer, hasClaudeCli, hasGeminiCli, hasGeminiAcp, hasGitWorktree, hasNativeTeamTools, hasPreviewMCP };
}

/**
 * Format capability report for human-readable display.
 * @param {{ hasTmux: boolean, hasCodex: boolean, hasClaudeCli: boolean, hasGeminiCli: boolean, hasGitWorktree: boolean, hasNativeTeamTools: boolean, hasPreviewMCP: boolean }} caps
 * @returns {string}
 */
export function formatCapabilityReport(caps) {
  const fmt = (flag, name, desc) => `  ${flag ? '✓' : '✗'} ${name} — ${desc}`;
  const lines = [
    'Capabilities:',
    fmt(caps.hasTmux, 'tmux       ', 'parallel worker sessions'),
    fmt(caps.hasCodex, 'codex      ', 'cross-validation & multi-model'),
    fmt(caps.hasClaudeCli, 'claude-cli ', 'headless Claude Code workers'),
    fmt(caps.hasGeminiCli, 'gemini-cli ', 'Gemini CLI workers'),
    fmt(caps.hasGitWorktree, 'git worktree', 'isolated parallel workspaces'),
    fmt(caps.hasNativeTeamTools, 'Native Agent Teams', 'peer-to-peer team orchestration (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS)'),
    fmt(caps.hasPreviewMCP, 'preview MCP', caps.hasPreviewMCP
      ? 'visual verification'
      : 'visual verification (no .claude/launch.json)'),
  ];
  return lines.join('\n');
}

/**
 * Validate .ao/ directory state before orchestrator execution.
 * Returns a report of issues found and actions taken.
 *
 * @returns {Promise<{ valid: boolean, actions: string[], warnings: string[], capabilities: object }>}
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

  const capabilities = await detectCapabilities();

  return {
    valid: warnings.length === 0,
    actions,
    warnings,
    capabilities,
  };
}

/**
 * Format preflight report for prompt injection.
 * @param {{ valid: boolean, actions: string[], warnings: string[] }} report
 * @returns {string}
 */
export function formatPreflightReport(report) {
  const parts = [];
  if (report.actions.length > 0) {
    parts.push('Preflight actions:\n' + report.actions.map(a => `  ✓ ${a}`).join('\n'));
  }
  if (report.warnings.length > 0) {
    parts.push('Preflight warnings:\n' + report.warnings.map(w => `  ⚠ ${w}`).join('\n'));
  }
  // Always include capability report when available — orchestrators need this
  // at startup to choose fallback paths
  if (report.capabilities) {
    parts.push(formatCapabilityReport(report.capabilities));
  }
  return parts.join('\n');
}
