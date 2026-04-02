import { execFileSync } from 'child_process';
import { existsSync } from 'fs';

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
