/**
 * Unit tests for scripts/lib/host-sandbox-detect.mjs
 *
 * All tests are hermetic: they inject a fake `fs` and `env` so no real
 * filesystem or environment state is read.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectHostSandbox,
  _detectContainer,
  _detectLinuxSeccomp,
  _detectLinuxLsm,
  _detectMacosSignals,
  _detectPlatform,
  _resolveExplicitOverride,
} from '../lib/host-sandbox-detect.mjs';

// ---------------------------------------------------------------------------
// Mock fs factory — builds an `{ existsSync, readFileSync }` pair from a map.
// Paths present in the map exist; their values are returned by readFileSync.
// ---------------------------------------------------------------------------
function mockFs(fileMap = {}) {
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(fileMap, p),
    readFileSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(fileMap, p)) {
        throw new Error(`ENOENT: ${p}`);
      }
      return fileMap[p];
    },
  };
}

// ---------------------------------------------------------------------------
// _resolveExplicitOverride
// ---------------------------------------------------------------------------

describe('_resolveExplicitOverride', () => {
  it('env AO_HOST_SANDBOX_LEVEL=unrestricted → env-explicit', () => {
    const r = _resolveExplicitOverride({ env: { AO_HOST_SANDBOX_LEVEL: 'unrestricted' } });
    assert.deepEqual(r, { tier: 'unrestricted', source: 'env-explicit' });
  });

  it('env workspace-write → env-explicit', () => {
    const r = _resolveExplicitOverride({ env: { AO_HOST_SANDBOX_LEVEL: 'workspace-write' } });
    assert.equal(r.tier, 'workspace-write');
  });

  it('env read-only → env-explicit', () => {
    const r = _resolveExplicitOverride({ env: { AO_HOST_SANDBOX_LEVEL: 'read-only' } });
    assert.equal(r.tier, 'read-only');
  });

  it('invalid env value → null (not silent accept)', () => {
    const r = _resolveExplicitOverride({ env: { AO_HOST_SANDBOX_LEVEL: 'yolo' } });
    assert.equal(r, null);
  });

  it('empty env → null', () => {
    const r = _resolveExplicitOverride({ env: {} });
    assert.equal(r, null);
  });

  it('autonomyConfig.codex.hostSandbox → autonomy-explicit', () => {
    const r = _resolveExplicitOverride({
      env: {},
      autonomyConfig: { codex: { hostSandbox: 'read-only' } },
    });
    assert.deepEqual(r, { tier: 'read-only', source: 'autonomy-explicit' });
  });

  it('env wins over autonomy when both present', () => {
    const r = _resolveExplicitOverride({
      env: { AO_HOST_SANDBOX_LEVEL: 'workspace-write' },
      autonomyConfig: { codex: { hostSandbox: 'read-only' } },
    });
    assert.equal(r.source, 'env-explicit');
    assert.equal(r.tier, 'workspace-write');
  });

  it('invalid autonomy value → null', () => {
    const r = _resolveExplicitOverride({
      env: {},
      autonomyConfig: { codex: { hostSandbox: 'bogus' } },
    });
    assert.equal(r, null);
  });

  it('missing autonomyConfig → null', () => {
    assert.equal(_resolveExplicitOverride({ env: {} }), null);
    assert.equal(_resolveExplicitOverride({ env: {}, autonomyConfig: null }), null);
    assert.equal(_resolveExplicitOverride({ env: {}, autonomyConfig: {} }), null);
  });
});

// ---------------------------------------------------------------------------
// _detectContainer
// ---------------------------------------------------------------------------

describe('_detectContainer', () => {
  it('/.dockerenv present → true', () => {
    assert.equal(_detectContainer({ fs: mockFs({ '/.dockerenv': '' }) }), true);
  });

  it('/run/.containerenv present → true', () => {
    assert.equal(_detectContainer({ fs: mockFs({ '/run/.containerenv': '' }) }), true);
  });

  it('/proc/1/cgroup mentions docker → true', () => {
    assert.equal(
      _detectContainer({
        fs: mockFs({
          '/proc/1/cgroup': '0::/docker/abc123',
        }),
      }),
      true,
    );
  });

  it('cgroup mentions podman → true', () => {
    assert.equal(
      _detectContainer({
        fs: mockFs({ '/proc/1/cgroup': '0::/machine.slice/podman-123.scope' }),
      }),
      true,
    );
  });

  it('cgroup mentions containerd → true', () => {
    assert.equal(
      _detectContainer({ fs: mockFs({ '/proc/1/cgroup': '0::/system.slice/containerd.service/abc' }) }),
      true,
    );
  });

  it('cgroup mentions kubepods → true', () => {
    assert.equal(
      _detectContainer({ fs: mockFs({ '/proc/1/cgroup': '0::/kubepods/abc' }) }),
      true,
    );
  });

  it('cgroup mentions lxc → true', () => {
    assert.equal(
      _detectContainer({ fs: mockFs({ '/proc/1/cgroup': '0::/lxc/container-1' }) }),
      true,
    );
  });

  it('cgroup with no container markers → false', () => {
    assert.equal(
      _detectContainer({ fs: mockFs({ '/proc/1/cgroup': '0::/user.slice/user-1000.slice' }) }),
      false,
    );
  });

  it('no relevant files → false', () => {
    assert.equal(_detectContainer({ fs: mockFs({}) }), false);
  });
});

// ---------------------------------------------------------------------------
// _detectLinuxSeccomp
// ---------------------------------------------------------------------------

describe('_detectLinuxSeccomp', () => {
  it('Seccomp: 0 → inactive', () => {
    const r = _detectLinuxSeccomp({
      fs: mockFs({ '/proc/self/status': 'Seccomp:\t0\nNoNewPrivs:\t0\n' }),
    });
    assert.deepEqual(r, { seccompActive: false, noNewPrivs: false });
  });

  it('Seccomp: 1 (strict) → active', () => {
    const r = _detectLinuxSeccomp({
      fs: mockFs({ '/proc/self/status': 'Seccomp:\t1\nNoNewPrivs:\t1\n' }),
    });
    assert.deepEqual(r, { seccompActive: true, noNewPrivs: true });
  });

  it('Seccomp: 2 (filter) → active', () => {
    const r = _detectLinuxSeccomp({
      fs: mockFs({ '/proc/self/status': 'Seccomp:\t2\nNoNewPrivs:\t0\n' }),
    });
    assert.deepEqual(r, { seccompActive: true, noNewPrivs: false });
  });

  it('missing /proc/self/status → inactive', () => {
    const r = _detectLinuxSeccomp({ fs: mockFs({}) });
    assert.deepEqual(r, { seccompActive: false, noNewPrivs: false });
  });

  it('malformed status → inactive', () => {
    const r = _detectLinuxSeccomp({
      fs: mockFs({ '/proc/self/status': 'Name:\tclaude\n' }),
    });
    assert.deepEqual(r, { seccompActive: false, noNewPrivs: false });
  });
});

// ---------------------------------------------------------------------------
// _detectLinuxLsm
// ---------------------------------------------------------------------------

describe('_detectLinuxLsm', () => {
  it('AppArmor enforce profile → apparmor', () => {
    assert.equal(
      _detectLinuxLsm({
        fs: mockFs({ '/proc/self/attr/current': 'claude-profile (enforce)\n' }),
      }),
      'apparmor',
    );
  });

  it('AppArmor complain profile → null (not enforcing)', () => {
    assert.equal(
      _detectLinuxLsm({
        fs: mockFs({ '/proc/self/attr/current': 'claude-profile (complain)\n' }),
      }),
      null,
    );
  });

  it('AppArmor unconfined → null', () => {
    assert.equal(
      _detectLinuxLsm({
        fs: mockFs({ '/proc/self/attr/current': 'unconfined\n' }),
      }),
      null,
    );
  });

  it('SELinux enforcing + non-unconfined context → selinux', () => {
    assert.equal(
      _detectLinuxLsm({
        fs: mockFs({
          '/sys/fs/selinux/enforce': '1\n',
          '/proc/self/attr/current': 'system_u:system_r:claude_t:s0',
        }),
      }),
      'selinux',
    );
  });

  it('SELinux enforcing but unconfined_t → null', () => {
    assert.equal(
      _detectLinuxLsm({
        fs: mockFs({
          '/sys/fs/selinux/enforce': '1\n',
          '/proc/self/attr/current': 'system_u:system_r:unconfined_t:s0',
        }),
      }),
      null,
    );
  });

  it('Landlock active in /proc/self/status → landlock', () => {
    assert.equal(
      _detectLinuxLsm({
        fs: mockFs({ '/proc/self/status': 'Landlock:\t3\n' }),
      }),
      'landlock',
    );
  });

  it('no LSM signals → null', () => {
    assert.equal(_detectLinuxLsm({ fs: mockFs({}) }), null);
  });
});

// ---------------------------------------------------------------------------
// _detectMacosSignals
// ---------------------------------------------------------------------------

describe('_detectMacosSignals', () => {
  it('OPERON_SANDBOXED_NETWORK=1 → networkRestricted true', () => {
    const r = _detectMacosSignals({ env: { OPERON_SANDBOXED_NETWORK: '1' } });
    assert.equal(r.networkRestricted, true);
  });

  it('OPERON_SANDBOXED_NETWORK=0 → false', () => {
    const r = _detectMacosSignals({ env: { OPERON_SANDBOXED_NETWORK: '0' } });
    assert.equal(r.networkRestricted, false);
  });

  it('unset → false', () => {
    const r = _detectMacosSignals({ env: {} });
    assert.equal(r.networkRestricted, false);
  });
});

// ---------------------------------------------------------------------------
// _detectPlatform
// ---------------------------------------------------------------------------

describe('_detectPlatform', () => {
  it('darwin → darwin', () => {
    assert.equal(_detectPlatform({ platformOverride: 'darwin' }), 'darwin');
  });

  it('win32 → win32', () => {
    assert.equal(_detectPlatform({ platformOverride: 'win32' }), 'win32');
  });

  it('linux without WSL marker → linux', () => {
    assert.equal(
      _detectPlatform({
        platformOverride: 'linux',
        fs: mockFs({ '/proc/version': 'Linux version 6.1.0 (gcc 12.2.0)\n' }),
      }),
      'linux',
    );
  });

  it('linux with Microsoft marker → wsl', () => {
    assert.equal(
      _detectPlatform({
        platformOverride: 'linux',
        fs: mockFs({ '/proc/version': 'Linux version 5.15.0-microsoft-standard-WSL2\n' }),
      }),
      'wsl',
    );
  });

  it('linux with WSL marker → wsl', () => {
    assert.equal(
      _detectPlatform({
        platformOverride: 'linux',
        fs: mockFs({ '/proc/version': 'Linux version 5.15.0 (WSL build 23456)\n' }),
      }),
      'wsl',
    );
  });

  it('unknown platform → other', () => {
    assert.equal(_detectPlatform({ platformOverride: 'aix' }), 'other');
  });
});

// ---------------------------------------------------------------------------
// detectHostSandbox — top-level integration
// ---------------------------------------------------------------------------

describe('detectHostSandbox: explicit override priority', () => {
  it('env override wins over everything', () => {
    const r = detectHostSandbox({
      env: { AO_HOST_SANDBOX_LEVEL: 'read-only' },
      autonomyConfig: { codex: { hostSandbox: 'unrestricted' } },
      fs: mockFs({ '/.dockerenv': '', '/proc/self/status': 'Landlock:\t1\n' }),
      platformOverride: 'linux',
    });
    assert.equal(r.tier, 'read-only');
    assert.equal(r.source, 'env-explicit');
    assert.equal(r.signals.explicitOverride, true);
  });

  it('autonomy override used when env absent', () => {
    const r = detectHostSandbox({
      env: {},
      autonomyConfig: { codex: { hostSandbox: 'workspace-write' } },
      fs: mockFs({}),
      platformOverride: 'linux',
    });
    assert.equal(r.tier, 'workspace-write');
    assert.equal(r.source, 'autonomy-explicit');
  });
});

describe('detectHostSandbox: Linux LSM', () => {
  it('AppArmor enforce → workspace-write', () => {
    const r = detectHostSandbox({
      env: {},
      fs: mockFs({ '/proc/self/attr/current': 'claude (enforce)\n' }),
      platformOverride: 'linux',
    });
    assert.equal(r.tier, 'workspace-write');
    assert.equal(r.source, 'platform-linux-lsm');
    assert.equal(r.signals.lsm, 'apparmor');
  });

  it('SELinux enforcing → workspace-write', () => {
    const r = detectHostSandbox({
      env: {},
      fs: mockFs({
        '/sys/fs/selinux/enforce': '1',
        '/proc/self/attr/current': 'system_u:system_r:claude_t:s0',
      }),
      platformOverride: 'linux',
    });
    assert.equal(r.tier, 'workspace-write');
    assert.equal(r.signals.lsm, 'selinux');
  });

  it('Landlock active → workspace-write', () => {
    const r = detectHostSandbox({
      env: {},
      fs: mockFs({ '/proc/self/status': 'Landlock:\t1\n' }),
      platformOverride: 'linux',
    });
    assert.equal(r.tier, 'workspace-write');
    assert.equal(r.signals.lsm, 'landlock');
  });
});

describe('detectHostSandbox: ambiguous signals do NOT downgrade', () => {
  it('container alone → unknown tier, containerized=true signal', () => {
    const r = detectHostSandbox({
      env: {},
      fs: mockFs({ '/.dockerenv': '' }),
      platformOverride: 'linux',
    });
    assert.equal(r.tier, 'unknown');
    assert.equal(r.source, 'unknown');
    assert.equal(r.signals.containerized, true);
  });

  it('OPERON_SANDBOXED_NETWORK alone → unknown tier, network signal', () => {
    const r = detectHostSandbox({
      env: { OPERON_SANDBOXED_NETWORK: '1' },
      fs: mockFs({}),
      platformOverride: 'darwin',
    });
    assert.equal(r.tier, 'unknown');
    assert.equal(r.signals.networkRestricted, true);
  });

  it('seccomp active alone → unknown tier (too weak)', () => {
    const r = detectHostSandbox({
      env: {},
      fs: mockFs({ '/proc/self/status': 'Seccomp:\t2\nNoNewPrivs:\t1\n' }),
      platformOverride: 'linux',
    });
    assert.equal(r.tier, 'unknown');
    assert.equal(r.signals.seccompActive, true);
    assert.equal(r.signals.noNewPrivs, true);
  });

  it('empty signals → unknown', () => {
    const r = detectHostSandbox({
      env: {},
      fs: mockFs({}),
      platformOverride: 'darwin',
    });
    assert.equal(r.tier, 'unknown');
    assert.equal(r.signals.networkRestricted, false);
    assert.equal(r.signals.containerized, false);
    assert.equal(r.signals.lsm, null);
  });
});

describe('detectHostSandbox: signal record shape', () => {
  it('always returns all signal fields', () => {
    const r = detectHostSandbox({
      env: {},
      fs: mockFs({}),
      platformOverride: 'darwin',
    });
    assert.ok('networkRestricted' in r.signals);
    assert.ok('containerized' in r.signals);
    assert.ok('explicitOverride' in r.signals);
    assert.ok('seccompActive' in r.signals);
    assert.ok('noNewPrivs' in r.signals);
    assert.ok('lsm' in r.signals);
    assert.ok('platform' in r.signals);
  });

  it('fail-safe on fs errors', () => {
    // fs.readFileSync that always throws → should not propagate
    const throwingFs = {
      existsSync: () => true, // claim everything exists
      readFileSync: () => { throw new Error('boom'); },
    };
    const r = detectHostSandbox({
      env: {},
      fs: throwingFs,
      platformOverride: 'linux',
    });
    assert.equal(r.tier, 'unknown');
  });
});
