/**
 * Gemini-compatible binary resolution.
 *
 * The Gemini worker adapters still use the existing gemini adapter stack, but
 * binary resolution may fall back from Google's `gemini` CLI to Antigravity's
 * `agy` CLI when the Gemini CLI is not actually present.
 *
 * @module gemini-binary
 */

import path from 'path';
import { resolveBinary } from './resolve-binary.mjs';

/**
 * @typedef {'gemini'|'agy'|'custom'} GeminiBinaryFlavor
 *
 * @typedef {Object} GeminiBinaryResolution
 * @property {string} path - Binary path to pass to child_process.spawn().
 * @property {GeminiBinaryFlavor} flavor - Resolved binary flavor.
 * @property {boolean} resolved - True when a real path or explicit override was found.
 * @property {string[]} attempted - Binary names attempted through the resolver.
 */

/**
 * Create a Gemini-compatible binary resolver with injectable dependencies.
 *
 * @param {Object} deps
 * @param {(name: string) => string} [deps.resolve] - Binary resolver.
 * @param {Object<string,string|undefined>} [deps.env] - Environment map.
 * @returns {() => GeminiBinaryResolution}
 */
export function _createGeminiResolver({ resolve = resolveBinary, env = process.env } = {}) {
  return function resolveGeminiBinaryWithDeps() {
    const override = env.AO_GEMINI_BINARY;
    if (override) {
      return {
        path: override,
        flavor: _flavorFromBasename(override),
        resolved: true,
        attempted: [],
      };
    }

    const attempted = [];
    for (const name of ['gemini', 'agy']) {
      attempted.push(name);
      let candidate;
      try {
        candidate = resolve(name);
      } catch {
        continue;
      }
      if (_isResolvedBinary(candidate, name)) {
        return {
          path: candidate,
          flavor: name,
          resolved: true,
          attempted,
        };
      }
    }

    return {
      path: 'gemini',
      flavor: 'gemini',
      resolved: false,
      attempted,
    };
  };
}

/**
 * Resolve the binary used by Gemini worker adapters.
 *
 * Resolution order:
 * 1. `AO_GEMINI_BINARY` verbatim override.
 * 2. `gemini` if resolveBinary finds a real path.
 * 3. `agy` if resolveBinary finds a real path.
 * 4. Bare `gemini` fallback so spawn/ENOENT behavior stays unchanged.
 *
 * @returns {GeminiBinaryResolution}
 */
export const resolveGeminiBinary = _createGeminiResolver();

/**
 * @param {string} p
 * @returns {GeminiBinaryFlavor}
 */
function _flavorFromBasename(p) {
  const base = String(p).split(/[\\/]/).filter(Boolean).pop() || '';
  if (base === 'gemini') return 'gemini';
  if (base === 'agy') return 'agy';
  return 'custom';
}

/**
 * True only for an actual resolved path, not resolveBinary's bare-name fallback.
 *
 * @param {unknown} candidate
 * @param {string} name
 * @returns {candidate is string}
 */
function _isResolvedBinary(candidate, name) {
  if (typeof candidate !== 'string' || !candidate) return false;
  if (candidate === name && !/[\\/]/.test(candidate)) return false;
  return path.isAbsolute(candidate) || path.win32.isAbsolute(candidate);
}
