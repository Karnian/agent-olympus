/**
 * proc-identity.mjs — a stable, per-process START-TIME identity a recycled PID
 * cannot reproduce. Used to detect PID reuse before signaling a stored pid (F3),
 * shared by worker-spawn (kill path) and the adapter worker supervisor (records
 * adapterStartId in its snapshot). Zero npm deps.
 */

import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';

/**
 * @param {number} pid
 * @returns {string|null} an opaque identity string, or null if unreadable
 *   (callers FAIL OPEN — null must not be treated as a definitive "dead").
 */
export function readProcStartId(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  // Platform DISPATCH — never mix schemes. A `lin:` baseline must not be compared
  // against a `ps:` reading (e.g. if a /proc read transiently fails), which would
  // be a false mismatch → false "recycled" → a real orphan left unsignaled.
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
      // comm (field 2) is parenthesized and may contain spaces/parens → split
      // AFTER the last ')'. starttime is field 22 → index 19 (field 3 = index 0).
      const rp = stat.lastIndexOf(')');
      if (rp !== -1) {
        const starttime = stat.slice(rp + 1).trim().split(/\s+/)[19];
        if (starttime && /^\d+$/.test(starttime)) {
          // starttime is ticks-since-boot — MUST be scoped with boot_id, else a
          // post-reboot same-pid/same-tick process collides. If boot_id is
          // unreadable, return null (fail open) rather than a weak identity.
          let boot = '';
          try { boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim(); } catch { /* boot stays '' */ }
          if (boot) return `lin:${boot}:${starttime}`;
        }
      }
    } catch { /* pid gone or /proc unreadable → null (fail open) */ }
    return null;
  }
  // macOS / BSD: `ps -o lstart=` renders LOCAL time, so force TZ=UTC + LC_ALL=C
  // to make the timestamp STABLE across ambient timezone/locale changes between
  // spawn and a (possibly later, different-process) shutdown — otherwise the same
  // process yields different strings and is falsely classified as recycled.
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000,
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
    }).trim();
    if (out) return `ps:${out}`;
  } catch { /* pid gone, or ps unavailable → null (fail open) */ }
  return null;
}
