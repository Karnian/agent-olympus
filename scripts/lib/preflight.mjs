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
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);
import { resolveBinary } from './tmux-session.mjs';
import { resolveClaudeBinary, buildEnhancedPath } from './resolve-binary.mjs';
import { loadAutonomyConfig } from './autonomy.mjs';

const AO_DIR = '.ao';
const STATE_DIR = path.join(AO_DIR, 'state');
const CAPABILITY_CACHE_PATH = path.join(STATE_DIR, 'ao-capabilities.json');
const CAPABILITY_CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes (binaries rarely change mid-session)

/**
 * Read cached capabilities if still valid (within TTL).
 * @returns {object|null} Cached capabilities or null if expired/missing
 */
function readCapabilityCache() {
  try {
    const stat = statSync(CAPABILITY_CACHE_PATH);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > CAPABILITY_CACHE_TTL_MS) return null;

    const raw = readFileSync(CAPABILITY_CACHE_PATH, 'utf-8');
    const cached = JSON.parse(raw);
    // Validate shape — must have at least hasTmux key
    if (typeof cached.hasTmux !== 'boolean') return null;
    // Re-check environment-sensitive fields that are instant to compute
    let currentNativeTeam = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === '1';
    if (!currentNativeTeam) {
      try {
        const autonomy = loadAutonomyConfig(process.cwd());
        if (autonomy.nativeTeams === true) currentNativeTeam = true;
      } catch {}
    }
    const currentPreviewMCP = existsSync('.claude/launch.json');
    if (cached.hasNativeTeamTools !== currentNativeTeam) return null;
    if (cached.hasPreviewMCP !== currentPreviewMCP) return null;
    return cached;
  } catch {
    return null;
  }
}

/**
 * Write capabilities to cache file.
 * @param {object} capabilities
 */
function writeCapabilityCache(capabilities) {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(CAPABILITY_CACHE_PATH, JSON.stringify(capabilities), { mode: 0o600 });
  } catch {
    // Non-critical — caching failure doesn't affect functionality
  }
}

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
/**
 * Detect gemini CLI's `--acp` support STATICALLY (no spawn).
 *
 * Why not spawn `gemini --help` and grep the output: on macOS, the gemini CLI
 * boots its keytar layer during startup — before help text is printed. If the
 * user stores an API key in the shared `gemini-cli-api-key` keychain item
 * (the one gemini CLI creates via `gemini /auth`), keytar's ACL lookup
 * prompts the user for their login password on EVERY capability probe,
 * even though `--help` never actually needs the credential. The partition
 * list grant we apply to our AO keychain item doesn't help because keytar
 * uses Apple's Security.framework directly, not `/usr/bin/security`.
 *
 * Instead, we walk up from the binary path to find
 * `@google/gemini-cli/package.json` and compare its `version` against the
 * threshold where `--experimental-acp` first shipped (observed in ≥ 0.4.0;
 * plain `--acp` added later as the promoted alias). If the package.json
 * lookup fails (unusual install layouts, bundled single-file executables),
 * we fall back to `true` — worker-spawn will auto-demote to `gemini-exec`
 * on ACP handshake failure, so an optimistic assumption is safe.
 *
 * @param {string|null} geminiBin - resolved absolute path to gemini binary
 * @returns {boolean}
 */
export function detectGeminiAcpStatic(geminiBin) {
  if (!geminiBin) return false;
  const version = readGeminiPackageVersion(geminiBin);
  if (version === null) {
    // Package.json not found. Default true: worker-spawn's adapter selection
    // will demote to gemini-exec on ACP failure, so the downside is a single
    // failed handshake once per session, not a permanent breakage.
    return true;
  }
  return meetsMinVersion(version, 0, 4, 0);
}

/**
 * Walk up from the gemini binary's realpath looking for the
 * `@google/gemini-cli` package.json. Returns the version string or null.
 *
 * Typical layouts handled:
 *   - nvm/node:      /usr/local/lib/node_modules/@google/gemini-cli/dist/index.js
 *                    → ../package.json (name: @google/gemini-cli)
 *   - homebrew:      /opt/homebrew/lib/node_modules/@google/gemini-cli/...
 *   - pnpm:          /.../gemini-cli/.../dist/index.js
 *   - bin symlinks:  /usr/local/bin/gemini → ../lib/node_modules/@google/gemini-cli/dist/index.js
 *
 * @param {string} binPath
 * @returns {string|null}
 */
function readGeminiPackageVersion(binPath) {
  let real;
  try { real = realpathSync(binPath); } catch { return null; }
  let dir = path.dirname(real);
  // Walk up to 10 levels — enough for typical npm/pnpm layouts without being
  // unbounded on pathological inputs.
  for (let i = 0; i < 10; i++) {
    const pjPath = path.join(dir, 'package.json');
    if (existsSync(pjPath)) {
      try {
        const pj = JSON.parse(readFileSync(pjPath, 'utf8'));
        if (pj && typeof pj === 'object' && pj.name === '@google/gemini-cli'
            && typeof pj.version === 'string') {
          return pj.version;
        }
      } catch { /* bad json → keep walking */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Async helper: run a command and return stdout, or null on failure.
 */
async function tryExecAsync(cmd, args, opts) {
  try {
    const { stdout } = await execFileAsync(cmd, args, opts);
    return stdout;
  } catch {
    return null;
  }
}

export async function detectCapabilities() {
  // Check file-based cache first (hooks are separate processes, so in-memory cache doesn't work)
  const cached = readCapabilityCache();
  if (cached) return cached;

  const enhancedEnv = { ...process.env, PATH: buildEnhancedPath() };
  const execOpts = { encoding: 'utf-8', timeout: 5000, env: enhancedEnv };

  // --- Wave 1: parallel binary existence checks ---
  const [tmuxBin, codexBin, geminiBin, claudePath, gitWorktreeOut] = await Promise.all([
    // tmux
    (async () => {
      const bin = resolveBinary('tmux');
      return (bin && bin !== 'tmux') ? bin : null;
    })(),
    // codex
    (async () => {
      const bin = resolveBinary('codex');
      return (bin && bin !== 'codex') ? bin : null;
    })(),
    // gemini
    (async () => {
      const bin = resolveBinary('gemini');
      return (bin && bin !== 'gemini') ? bin : null;
    })(),
    // claude
    (async () => {
      const bin = resolveClaudeBinary();
      return (bin && bin !== 'claude') ? bin : null;
    })(),
    // git worktree
    tryExecAsync('git', ['worktree', 'list'], execOpts),
  ]);

  const hasTmux = !!tmuxBin;
  const hasCodex = !!codexBin;
  const hasGeminiCli = !!geminiBin;
  const hasClaudeCli = !!claudePath;
  const hasGitWorktree = gitWorktreeOut !== null;

  // --- Wave 2: dependent version/feature checks ---
  // codex --version: safe to spawn (no credential side effects).
  // gemini: NO SPAWN. `gemini --help` boots keytar, which prompts for login
  // password on macOS when the user has a gemini-cli-api-key keychain item.
  // We detect --acp support statically from the CLI's package.json instead.
  // See detectGeminiAcpStatic for details.
  const codexVersionOut = hasCodex
    ? await tryExecAsync(resolveBinary('codex'), ['--version'], execOpts)
    : null;

  let hasCodexExecJson = false;
  let hasCodexAppServer = false;
  if (codexVersionOut) {
    hasCodexExecJson = meetsMinVersion(codexVersionOut.trim(), 0, 116, 0);
  }

  const hasGeminiAcp = detectGeminiAcpStatic(geminiBin);

  // --- Wave 3: codex app-server (depends on Wave 2) ---
  if (hasCodexExecJson) {
    const appServerOut = await tryExecAsync(resolveBinary('codex'), ['app-server', '--help'], execOpts);
    hasCodexAppServer = appServerOut !== null;
  }

  // Instant checks (no subprocess)
  let hasNativeTeamTools = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === '1';
  if (!hasNativeTeamTools) {
    try {
      const autonomy = loadAutonomyConfig(process.cwd());
      if (autonomy.nativeTeams === true) hasNativeTeamTools = true;
    } catch {}
  }
  const hasPreviewMCP = existsSync('.claude/launch.json');

  const capabilities = { hasTmux, hasCodex, hasCodexExecJson, hasCodexAppServer, hasClaudeCli, hasGeminiCli, hasGeminiAcp, hasGitWorktree, hasNativeTeamTools, hasPreviewMCP };
  writeCapabilityCache(capabilities);
  return capabilities;
}

/**
 * Format capability report for human-readable display.
 * @param {{ hasTmux: boolean, hasCodex: boolean, hasClaudeCli: boolean, hasGeminiCli: boolean, hasGitWorktree: boolean, hasNativeTeamTools: boolean, hasPreviewMCP: boolean }} caps
 * @param {{ orchestrator?: string }} [opts] - Optional display options
 * @returns {string}
 */
export function formatCapabilityReport(caps, opts) {
  const label = opts?.orchestrator || 'Capabilities';
  const fmt = (flag, name, desc) => `  ${flag ? '✓' : '✗'} ${name} — ${desc}`;
  const lines = [
    `[${label}] Capabilities:`,
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
 * Lightweight state cleanup — runs at SessionStart.
 * Does NOT detect capabilities (deferred to first orchestrator call).
 *
 * @returns {Promise<{ valid: boolean, actions: string[], warnings: string[] }>}
 */
export async function runStateCleanup() {
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
        const started = new Date(state.startedAt).getTime();
        if (!Number.isNaN(started) && (Date.now() - started) > 2 * 60 * 60 * 1000) {
          if (state.phase === 'spawning' || state.phase === 'running') {
            warnings.push(`Potentially orphaned team state: ${file} (started ${state.startedAt})`);
          }
        }
      } catch {
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
      warnings.push('.ao/prd.json exists but is not valid JSON — will be overwritten');
    }
  }

  return { valid: warnings.length === 0, actions, warnings };
}

/**
 * Full preflight — state cleanup + capability detection.
 * Called by orchestrator skills (atlas/athena) before Phase 0, NOT at SessionStart.
 *
 * @returns {Promise<{ valid: boolean, actions: string[], warnings: string[], capabilities: object }>}
 */
export async function runPreflight() {
  const { valid, actions, warnings } = await runStateCleanup();
  const capabilities = await detectCapabilities();
  return { valid, actions, warnings, capabilities };
}

/**
 * Format preflight report for prompt injection.
 * @param {{ valid: boolean, actions: string[], warnings: string[] }} report
 * @param {{ orchestrator?: string }} [opts] - Optional display options (passed to capability report)
 * @returns {string}
 */
export function formatPreflightReport(report, opts) {
  const prefix = opts?.orchestrator ? `[${opts.orchestrator}] ` : '';
  const parts = [];
  if (report.actions.length > 0) {
    parts.push(`${prefix}Preflight actions:\n` + report.actions.map(a => `  ✓ ${a}`).join('\n'));
  }
  if (report.warnings.length > 0) {
    parts.push(`${prefix}Preflight warnings:\n` + report.warnings.map(w => `  ⚠ ${w}`).join('\n'));
  }
  // Always include capability report when available — orchestrators need this
  // at startup to choose fallback paths
  if (report.capabilities) {
    parts.push(formatCapabilityReport(report.capabilities, opts));
  }
  return parts.join('\n');
}

export { readCapabilityCache as _readCapabilityCache, writeCapabilityCache as _writeCapabilityCache };
