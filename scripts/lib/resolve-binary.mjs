import { execFileSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

// Common binary search paths across platforms
export const SEARCH_PATHS = [
  '/opt/homebrew/bin',   // macOS ARM (Apple Silicon)
  '/usr/local/bin',      // macOS Intel / Linux manual installs
  '/usr/bin',            // Linux system
  '/usr/sbin',           // Linux system
  '/home/linuxbrew/.linuxbrew/bin', // Linuxbrew
];

export const _binCache = new Map();

/**
 * Resolve a binary name to its full path.
 * Checks PATH first (via `which`), then falls back to common locations.
 * Results are cached for the lifetime of the process.
 */
export function resolveBinary(name) {
  if (_binCache.has(name)) return _binCache.get(name);

  // Try which first (works if PATH is correct)
  try {
    const resolved = execFileSync('which', [name], { stdio: 'pipe', encoding: 'utf-8' }).trim();
    if (resolved) { _binCache.set(name, resolved); return resolved; }
  } catch {}

  // Fallback: scan known paths
  for (const dir of SEARCH_PATHS) {
    const candidate = `${dir}/${name}`;
    if (existsSync(candidate)) { _binCache.set(name, candidate); return candidate; }
  }

  // Last resort: return bare name, let the OS figure it out
  _binCache.set(name, name);
  return name;
}

/**
 * Clear the binary resolution cache.
 * Primarily useful in tests to reset state between cases.
 */
export function clearBinCache() {
  _binCache.clear();
}

/**
 * Resolve the Claude Code CLI binary path.
 *
 * Claude Code installs to a non-standard, versioned path with spaces:
 *   macOS: ~/Library/Application Support/Claude/claude-code/<version>/claude.app/Contents/MacOS/claude
 *   Linux: ~/.local/share/claude-code/<version>/claude (hypothetical)
 *
 * Discovery order:
 * 1. `which claude` (if user added to PATH or symlinked)
 * 2. macOS Application Support versioned directories (newest version first)
 * 3. Linux .local/share fallback
 *
 * Results are cached under the key 'claude-cli'.
 *
 * @returns {string} Full path to the claude binary
 */
export function resolveClaudeBinary() {
  if (_binCache.has('claude-cli')) return _binCache.get('claude-cli');

  // 1. Try `which claude` first
  try {
    const resolved = execFileSync('which', ['claude'], { stdio: 'pipe', encoding: 'utf-8' }).trim();
    if (resolved && existsSync(resolved)) {
      _binCache.set('claude-cli', resolved);
      return resolved;
    }
  } catch {}

  // 2. macOS: ~/Library/Application Support/Claude/claude-code/<version>/claude.app/Contents/MacOS/claude
  const home = homedir();
  const macBase = join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
  try {
    if (existsSync(macBase)) {
      const versions = readdirSync(macBase)
        .filter(v => /^\d+\.\d+\.\d+/.test(v))
        .sort(_semverCompareDesc);
      for (const ver of versions) {
        const candidate = join(macBase, ver, 'claude.app', 'Contents', 'MacOS', 'claude');
        if (existsSync(candidate)) {
          _binCache.set('claude-cli', candidate);
          return candidate;
        }
      }
    }
  } catch {}

  // 3. Linux: ~/.local/share/claude-code/<version>/claude
  const linuxBase = join(home, '.local', 'share', 'claude-code');
  try {
    if (existsSync(linuxBase)) {
      const versions = readdirSync(linuxBase)
        .filter(v => /^\d+\.\d+\.\d+/.test(v))
        .sort(_semverCompareDesc);
      for (const ver of versions) {
        const candidate = join(linuxBase, ver, 'claude');
        if (existsSync(candidate)) {
          _binCache.set('claude-cli', candidate);
          return candidate;
        }
      }
    }
  } catch {}

  // Last resort: bare name
  _binCache.set('claude-cli', 'claude');
  return 'claude';
}

/**
 * Compare two semver strings in descending order (newest first).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function _semverCompareDesc(a, b) {
  const pa = a.match(/(\d+)\.(\d+)\.(\d+)/);
  const pb = b.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pb[i]) - Number(pa[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Build a robust PATH string that includes all known binary directories.
 * Merges the current process PATH, SEARCH_PATHS, and parent directories of
 * resolved binaries (codex, claude, tmux, git, node).
 *
 * Used to inject PATH into child processes (adapters, tmux sessions) so
 * workers can find CLIs regardless of sandbox PATH restrictions.
 *
 * @returns {string} colon-separated PATH string
 */
export function buildEnhancedPath() {
  const dirs = new Set();

  // Collect from current process PATH
  if (process.env.PATH) {
    for (const p of process.env.PATH.split(':')) {
      if (p) dirs.add(p);
    }
  }

  // Add known search paths that actually exist
  for (const p of SEARCH_PATHS) {
    try { if (existsSync(p)) dirs.add(p); } catch {}
  }

  // Add parent directories of resolved key binaries
  for (const bin of ['codex', 'gemini', 'tmux', 'git', 'node']) {
    try {
      const resolved = resolveBinary(bin);
      if (resolved && resolved !== bin && resolved.includes('/')) {
        dirs.add(dirname(resolved));
      }
    } catch {}
  }

  // Claude CLI lives in a versioned app bundle path — use dedicated resolver
  try {
    const claudePath = resolveClaudeBinary();
    if (claudePath && claudePath !== 'claude' && claudePath.includes('/')) {
      dirs.add(dirname(claudePath));
    }
  } catch {}

  return [...dirs].join(':');
}

/**
 * Create a resolver with injected dependencies — for unit testing only.
 * Returns { resolveBinary, cache } where cache is an isolated Map instance.
 *
 * @param {object} deps
 * @param {function} deps.which  - (name) => string | throws
 * @param {function} deps.stat   - (path) => boolean (existsSync substitute)
 * @param {string[]} [deps.searchPaths] - override SEARCH_PATHS
 */
export function _createResolver({ which, stat, searchPaths = SEARCH_PATHS } = {}) {
  const cache = new Map();
  return {
    cache,
    resolveBinary(name) {
      if (cache.has(name)) return cache.get(name);

      try {
        const resolved = which(name);
        if (resolved && resolved.trim()) {
          const r = resolved.trim();
          cache.set(name, r);
          return r;
        }
      } catch {}

      for (const dir of searchPaths) {
        const candidate = `${dir}/${name}`;
        if (stat(candidate)) { cache.set(name, candidate); return candidate; }
      }

      cache.set(name, name);
      return name;
    },
  };
}
