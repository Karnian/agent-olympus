/**
 * Host sandbox detection — answers the question
 * "what sandbox is Claude Code actually running inside?"
 *
 * This is distinct from `permission-detect.mjs`, which answers
 * "what tool calls has the user given Claude permission to make?"
 * The two axes can differ: a user may grant `Bash(*) + Write(*)` while
 * running Claude Code inside a Docker container that only allows writes
 * to `/work`. Mirroring permissions to codex workers without knowing the
 * host sandbox produces codex workers that believe they have more power
 * than the host actually has.
 *
 * This module returns a best-effort view of the host sandbox as a
 * structured record, NOT a direct decision. The caller
 * (`codex-approval.effectiveCodexLevel`) intersects the permission level
 * with this record to derive the effective codex level.
 *
 * Detection is passive-only: no active probes (write outside cwd, network
 * requests). Active probing is out of scope for this module and is tracked
 * as a follow-up. `scripts/diagnose-sandbox.mjs` only prints the passive
 * detection record — it does not probe either.
 *
 * Zero npm dependencies — Node.js built-ins only.
 *
 * @module host-sandbox-detect
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @typedef {Object} HostSandboxSignals
 * @property {boolean} networkRestricted - Host network sandboxed (e.g. OPERON_SANDBOXED_NETWORK)
 * @property {boolean} containerized     - Running inside Docker/podman/containerd
 * @property {boolean} explicitOverride  - User set AO_HOST_SANDBOX_LEVEL or autonomy.codex.hostSandbox
 * @property {boolean} seccompActive     - Linux Seccomp >= 1 (filter mode)
 * @property {boolean} noNewPrivs        - Linux NoNewPrivs == 1
 * @property {?('apparmor'|'selinux'|'landlock')} lsm - Linux LSM enforcing (if any)
 * @property {'darwin'|'linux'|'win32'|'wsl'|'other'} platform - Runtime platform
 */

/**
 * @typedef {Object} HostSandboxRecord
 * @property {'unrestricted'|'workspace-write'|'read-only'|'unknown'} tier
 *   Best-effort sandbox tier. `unknown` means detection could not derive
 *   a safe answer — callers should NOT downgrade the permission level on
 *   `unknown` (silent downgrade is worse than no detection).
 * @property {'env-explicit'|'autonomy-explicit'|'platform-linux-lsm'|'container'|'macos-signals'|'unknown'} source
 *   Which signal family produced the tier.
 * @property {HostSandboxSignals} signals - Raw signals for observability/wisdom
 */

/** Valid tier values for the explicit override inputs. */
const VALID_TIERS = new Set(['unrestricted', 'workspace-write', 'read-only']);

/**
 * Read a file, returning null on any error (fail-safe).
 * @param {string} path
 * @param {object} [fs] - Injected fs module (for tests)
 * @returns {string|null}
 */
function safeRead(path, fs = { readFileSync, existsSync }) {
  try {
    if (!fs.existsSync(path)) return null;
    return fs.readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Detect whether we're running inside a container. Returns signal data
 * only — the top-level `detectHostSandbox` decides what to do with it.
 *
 * Signals (any one is enough to mark containerized=true):
 *   - /.dockerenv file
 *   - /run/.containerenv file (Podman/CRI)
 *   - /proc/1/cgroup contains docker/podman/containerd/kubepods/lxc
 *
 * @param {object} [opts]
 * @param {object} [opts.fs] - Injected fs module for tests
 * @returns {boolean}
 */
export function _detectContainer(opts = {}) {
  const fs = opts.fs || { readFileSync, existsSync };
  try {
    if (fs.existsSync('/.dockerenv')) return true;
    if (fs.existsSync('/run/.containerenv')) return true;
    const cgroup = safeRead('/proc/1/cgroup', fs);
    if (cgroup && /\b(docker|podman|containerd|kubepods|lxc)\b/.test(cgroup)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Detect Linux Seccomp state from /proc/self/status.
 *
 * Seccomp field semantics:
 *   0 = disabled, 1 = strict mode, 2 = filter mode (BPF)
 * NoNewPrivs field:
 *   0 = off, 1 = set (typical for sandboxed processes)
 *
 * @param {object} [opts]
 * @param {object} [opts.fs]
 * @returns {{ seccompActive: boolean, noNewPrivs: boolean }}
 */
export function _detectLinuxSeccomp(opts = {}) {
  const fs = opts.fs || { readFileSync, existsSync };
  const status = safeRead('/proc/self/status', fs);
  if (!status) return { seccompActive: false, noNewPrivs: false };

  // Seccomp: 0/1/2
  const seccompMatch = /^Seccomp:\s*([012])\s*$/m.exec(status);
  const seccompActive = seccompMatch ? Number(seccompMatch[1]) >= 1 : false;

  // NoNewPrivs: 0/1
  const nnpMatch = /^NoNewPrivs:\s*([01])\s*$/m.exec(status);
  const noNewPrivs = nnpMatch ? nnpMatch[1] === '1' : false;

  return { seccompActive, noNewPrivs };
}

/**
 * Detect which Linux LSM (if any) is enforcing restrictions on this process.
 * Returns 'apparmor' | 'selinux' | 'landlock' | null.
 *
 * Note: "running on a system with LSM X" is not the same as "LSM X is
 * enforcing against this process". We look for process-specific markers.
 *
 * @param {object} [opts]
 * @param {object} [opts.fs]
 * @returns {?string}
 */
export function _detectLinuxLsm(opts = {}) {
  const fs = opts.fs || { readFileSync, existsSync };

  // AppArmor: /proc/self/attr/current contains profile name + mode.
  // "unconfined" (no profile) or "<name> (enforce)" / "<name> (complain)"
  const apparmor = safeRead('/proc/self/attr/current', opts.fs || { readFileSync, existsSync });
  if (apparmor && /\(enforce\)/.test(apparmor)) return 'apparmor';

  // SELinux: /proc/self/attr/current in a different format, and
  // /sys/fs/selinux/enforce == 1 means enforcing.
  const selinuxEnforce = safeRead('/sys/fs/selinux/enforce', fs);
  if (selinuxEnforce && selinuxEnforce.trim() === '1') {
    // Additionally check the context is not "unconfined_t"
    const context = safeRead('/proc/self/attr/current', fs);
    if (context && !/unconfined_t/.test(context)) return 'selinux';
  }

  // Landlock: /proc/self/status lists "Landlock: X" in recent kernels.
  const status = safeRead('/proc/self/status', fs);
  if (status && /^Landlock:\s*[1-9]\d*$/m.test(status)) return 'landlock';

  return null;
}

/**
 * Detect macOS-specific Claude Code signals.
 *
 * Known signals (private to Claude Code, may disappear):
 *   - `OPERON_SANDBOXED_NETWORK=1` — host network sandbox active
 *     (NOTE: network-only; does NOT imply filesystem restriction)
 *
 * @param {object} [opts]
 * @param {object} [opts.env] - Injected env (for tests)
 * @returns {{ networkRestricted: boolean }}
 */
export function _detectMacosSignals(opts = {}) {
  const env = opts.env || process.env;
  return {
    networkRestricted: env.OPERON_SANDBOXED_NETWORK === '1',
  };
}

/**
 * Detect the runtime platform, including WSL distinction.
 *
 * `process.platform` reports 'linux' for WSL, so we check /proc/version
 * for a "Microsoft" or "WSL" marker.
 *
 * @param {object} [opts]
 * @param {object} [opts.fs]
 * @param {string} [opts.platformOverride] - Test override for process.platform
 * @returns {'darwin'|'linux'|'win32'|'wsl'|'other'}
 */
export function _detectPlatform(opts = {}) {
  const fs = opts.fs || { readFileSync, existsSync };
  const plat = opts.platformOverride || process.platform;
  if (plat === 'darwin' || plat === 'win32') return plat;
  if (plat === 'linux') {
    const version = safeRead('/proc/version', fs) || '';
    if (/microsoft|wsl/i.test(version)) return 'wsl';
    return 'linux';
  }
  return 'other';
}

/**
 * Read the explicit override from env var OR autonomyConfig.
 * Env takes priority. Returns null if no valid override present.
 *
 * @param {object} [opts]
 * @param {object} [opts.env]
 * @param {object} [opts.autonomyConfig]
 * @returns {?{ tier: string, source: 'env-explicit'|'autonomy-explicit' }}
 */
export function _resolveExplicitOverride(opts = {}) {
  const env = opts.env || process.env;

  const envValue = env.AO_HOST_SANDBOX_LEVEL;
  if (envValue && VALID_TIERS.has(envValue)) {
    return { tier: envValue, source: 'env-explicit' };
  }

  const autonomyValue = opts.autonomyConfig?.codex?.hostSandbox;
  if (autonomyValue && VALID_TIERS.has(autonomyValue)) {
    return { tier: autonomyValue, source: 'autonomy-explicit' };
  }

  return null;
}

/**
 * Top-level host sandbox detection. Layered, passive, fail-safe.
 *
 * Priority:
 *   1. Explicit override (env or autonomy)  → tier from override
 *   2. Linux LSM enforcing                   → 'workspace-write' (strong signal)
 *   3. Otherwise                              → 'unknown' (container/macOS/seccomp
 *                                                 are recorded as SIGNALS but do
 *                                                 not downgrade the tier — they
 *                                                 are too ambiguous)
 *
 * `unknown` means "caller should not downgrade" — silent downgrade on detection
 * failure is worse than no detection. Callers surface the signals to the user
 * via wisdom warning so they can set an explicit override.
 *
 * @param {object} [opts]
 * @param {object} [opts.env]         - Injected env for tests
 * @param {object} [opts.fs]          - Injected fs for tests
 * @param {string} [opts.platformOverride] - Platform override for tests
 * @param {object} [opts.autonomyConfig]
 * @returns {HostSandboxRecord}
 */
export function detectHostSandbox(opts = {}) {
  try {
    const platform = _detectPlatform(opts);
    const containerized = _detectContainer(opts);
    const seccomp = platform === 'linux' || platform === 'wsl'
      ? _detectLinuxSeccomp(opts)
      : { seccompActive: false, noNewPrivs: false };
    const lsm = platform === 'linux' || platform === 'wsl'
      ? _detectLinuxLsm(opts)
      : null;
    const macos = platform === 'darwin'
      ? _detectMacosSignals(opts)
      : { networkRestricted: false };

    const explicit = _resolveExplicitOverride(opts);

    const signals = {
      networkRestricted: macos.networkRestricted,
      containerized,
      explicitOverride: !!explicit,
      seccompActive: seccomp.seccompActive,
      noNewPrivs: seccomp.noNewPrivs,
      lsm,
      platform,
    };

    // Priority 1: explicit override wins
    if (explicit) {
      return { tier: explicit.tier, source: explicit.source, signals };
    }

    // Priority 2: Linux LSM enforcing = strong signal for workspace-write.
    // We don't go to read-only because LSM can still permit cwd writes;
    // the safest non-destructive downgrade is workspace-write.
    if (lsm) {
      return { tier: 'workspace-write', source: 'platform-linux-lsm', signals };
    }

    // Container + macOS signals are recorded but do NOT force a tier change.
    // They are ambiguous: a docker container can be unrestricted inside,
    // and OPERON_SANDBOXED_NETWORK only speaks to network, not filesystem.
    // Caller should see `signals.containerized` / `signals.networkRestricted`
    // and react via wisdom warning, not via automatic downgrade.
    return { tier: 'unknown', source: 'unknown', signals };
  } catch {
    // Fail-safe: any exception → unknown with empty signals
    return {
      tier: 'unknown',
      source: 'unknown',
      signals: {
        networkRestricted: false,
        containerized: false,
        explicitOverride: false,
        seccompActive: false,
        noNewPrivs: false,
        lsm: null,
        platform: 'other',
      },
    };
  }
}
