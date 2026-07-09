import { spawnSync } from 'child_process';

const VERSION_RE = /\bv?(\d+\.\d+(?:\.\d+)?)\b/i;
const _cache = new Map();

/**
 * Probe a CLI binary for its version string.
 *
 * Fail-safe by design: spawn errors, timeouts, non-zero exits, and unparseable
 * output all return `{ version: null, raw }` instead of throwing.
 *
 * @param {string} binPath - Binary path or command name.
 * @param {Object} [opts]
 * @param {string[]} [opts.args=['--version']] - Version command args.
 * @param {number} [opts.timeoutMs=5000] - spawnSync timeout in milliseconds.
 * @param {Function} [opts.spawn] - Injectable spawnSync-compatible function.
 * @returns {{ version: string|null, raw: string }}
 */
export function probeCliVersion(binPath, { args = ['--version'], timeoutMs = 5000, spawn } = {}) {
  const key = String(binPath || '');
  if (_cache.has(key)) return _cache.get(key);

  const spawnImpl = typeof spawn === 'function' ? spawn : spawnSync;
  let result;
  let raw = '';

  try {
    result = spawnImpl(binPath, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    });
  } catch (err) {
    raw = err && err.message ? String(err.message) : '';
    const failure = { version: null, raw };
    _cache.set(key, failure);
    return failure;
  }

  raw = rawFromSpawnResult(result);

  if (!result || result.error || result.status !== 0) {
    const failure = { version: null, raw };
    _cache.set(key, failure);
    return failure;
  }

  const match = raw.match(VERSION_RE);
  const value = match ? { version: match[1], raw } : { version: null, raw };
  _cache.set(key, value);
  return value;
}

/**
 * Compare two semver-ish numeric versions.
 *
 * Missing patch numbers are treated as zero (`1.2` equals `1.2.0`).
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1|0|1}
 */
export function compareSemver(a, b) {
  const left = parseSemverTriplet(a) || [0, 0, 0];
  const right = parseSemverTriplet(b) || [0, 0, 0];

  for (let i = 0; i < 3; i += 1) {
    if (left[i] < right[i]) return -1;
    if (left[i] > right[i]) return 1;
  }
  return 0;
}

/**
 * Advisory minimum-version gate.
 *
 * Unknown or unparseable versions fail open so callers can warn only when a
 * concrete older version is known.
 *
 * @param {string|null} version
 * @param {string} minimum
 * @returns {boolean}
 */
export function meetsMinimum(version, minimum) {
  if (!parseSemverTriplet(version)) return true;
  if (!parseSemverTriplet(minimum)) return true;
  return compareSemver(version, minimum) >= 0;
}

/** Clear the in-process version cache. Intended for tests. */
export function _clearVersionCache() {
  _cache.clear();
}

function rawFromSpawnResult(result) {
  if (!result) return '';
  const stdout = result.stdout === undefined || result.stdout === null ? '' : String(result.stdout);
  const stderr = result.stderr === undefined || result.stderr === null ? '' : String(result.stderr);
  const error = result.error && result.error.message ? String(result.error.message) : '';
  return stdout + stderr + (stdout || stderr || !error ? '' : error);
}

function parseSemverTriplet(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^v?(\d+)\.(\d+)(?:\.(\d+))?$/i);
  if (!match) return null;
  return [
    Number(match[1]),
    Number(match[2]),
    match[3] === undefined ? 0 : Number(match[3]),
  ];
}
