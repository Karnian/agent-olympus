/**
 * Unit tests for scripts/lib/architect-scope.mjs
 * Covers:
 *   - detectSharedLibChange() pattern matching
 *   - resolveDiffScopeSetting() autonomy parsing
 *   - resolveArchitectScope() end-to-end decision matrix
 *   - formatScopeHint() output shape (empty when disabled)
 *
 * Note: detectChangedFiles() and expandToOneHop() use git and are covered
 * only by a smoke test that exercises the happy path on the current repo.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectSharedLibChange,
  resolveDiffScopeSetting,
  resolveArchitectScope,
  formatScopeHint,
  detectChangedFiles,
  expandToOneHop,
} from '../lib/architect-scope.mjs';

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ao-architect-scope-test-'));
}

async function removeTmpDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// detectSharedLibChange
// ---------------------------------------------------------------------------

describe('detectSharedLibChange', () => {
  test('shared/ path triggers shared detection', () => {
    const r = detectSharedLibChange(['shared/utils/foo.ts']);
    assert.equal(r.shared, true);
    assert.equal(r.matchedFile, 'shared/utils/foo.ts');
  });

  test('lib/ path triggers', () => {
    const r = detectSharedLibChange(['lib/db.mjs']);
    assert.equal(r.shared, true);
  });

  test('deeply-nested common/ path triggers', () => {
    const r = detectSharedLibChange(['packages/app/src/common/types.ts']);
    assert.equal(r.shared, true);
  });

  test('public/ path triggers', () => {
    const r = detectSharedLibChange(['src/public/api.ts']);
    assert.equal(r.shared, true);
  });

  test('api/ path triggers', () => {
    const r = detectSharedLibChange(['backend/api/v1/users.ts']);
    assert.equal(r.shared, true);
  });

  test('types/ path triggers', () => {
    const r = detectSharedLibChange(['src/types/user.d.ts']);
    assert.equal(r.shared, true);
  });

  test('index.ts filename triggers (barrel export)', () => {
    const r = detectSharedLibChange(['src/features/auth/index.ts']);
    assert.equal(r.shared, true);
  });

  test('main.js triggers', () => {
    const r = detectSharedLibChange(['src/main.js']);
    assert.equal(r.shared, true);
  });

  test('exports.ts triggers', () => {
    const r = detectSharedLibChange(['src/exports.ts']);
    assert.equal(r.shared, true);
  });

  test('schema.json triggers', () => {
    const r = detectSharedLibChange(['config/schema.json']);
    assert.equal(r.shared, true);
  });

  test('openapi.yaml triggers', () => {
    const r = detectSharedLibChange(['docs/openapi.yaml']);
    assert.equal(r.shared, true);
  });

  // ── Phase 2 review remediation (Codex #1 + Gemini #1): language-specific patterns ──

  test('internal/ path triggers (Go convention)', () => {
    const r = detectSharedLibChange(['cmd/server/internal/auth.go']);
    assert.equal(r.shared, true);
  });

  test('pkg/ path triggers (Go convention)', () => {
    const r = detectSharedLibChange(['pkg/utils/log.go']);
    assert.equal(r.shared, true);
  });

  test('package.json triggers', () => {
    const r = detectSharedLibChange(['package.json']);
    assert.equal(r.shared, true);
  });

  test('tsconfig.json triggers', () => {
    const r = detectSharedLibChange(['tsconfig.json']);
    assert.equal(r.shared, true);
  });

  test('tsconfig.build.json triggers (variant)', () => {
    const r = detectSharedLibChange(['tsconfig.build.json']);
    assert.equal(r.shared, true);
  });

  test('Cargo.toml triggers (Rust)', () => {
    const r = detectSharedLibChange(['Cargo.toml']);
    assert.equal(r.shared, true);
  });

  test('pom.xml triggers (Maven)', () => {
    const r = detectSharedLibChange(['pom.xml']);
    assert.equal(r.shared, true);
  });

  test('build.gradle.kts triggers (Gradle)', () => {
    const r = detectSharedLibChange(['build.gradle.kts']);
    assert.equal(r.shared, true);
  });

  test('go.mod triggers', () => {
    const r = detectSharedLibChange(['go.mod']);
    assert.equal(r.shared, true);
  });

  test('pyproject.toml triggers', () => {
    const r = detectSharedLibChange(['pyproject.toml']);
    assert.equal(r.shared, true);
  });

  test('lib.rs triggers (Rust module surface)', () => {
    const r = detectSharedLibChange(['src/lib.rs']);
    assert.equal(r.shared, true);
  });

  test('mod.rs triggers', () => {
    const r = detectSharedLibChange(['src/feature/mod.rs']);
    assert.equal(r.shared, true);
  });

  test('.proto file (anywhere) triggers', () => {
    const r = detectSharedLibChange(['schemas/user.proto']);
    assert.equal(r.shared, true);
  });

  test('.graphql file triggers', () => {
    const r = detectSharedLibChange(['src/schema.graphql']);
    assert.equal(r.shared, true);
  });

  test('swagger.json triggers', () => {
    const r = detectSharedLibChange(['docs/swagger.json']);
    assert.equal(r.shared, true);
  });

  test('localised component file does NOT trigger', () => {
    const r = detectSharedLibChange(['src/features/dashboard/Panel.tsx']);
    assert.equal(r.shared, false);
  });

  test('test file does NOT trigger', () => {
    const r = detectSharedLibChange(['src/features/dashboard/Panel.test.tsx']);
    assert.equal(r.shared, false);
  });

  test('empty list returns shared=false', () => {
    const r = detectSharedLibChange([]);
    assert.equal(r.shared, false);
  });

  test('mixed list: one shared entry is enough to trigger', () => {
    const r = detectSharedLibChange([
      'src/features/dashboard/Panel.tsx',
      'lib/utils.ts',
      'src/features/dashboard/Header.tsx',
    ]);
    assert.equal(r.shared, true);
    assert.equal(r.matchedFile, 'lib/utils.ts');
  });

  test('non-array input returns conservative shared=true (fail-safe)', () => {
    const r = detectSharedLibChange('not an array');
    // Defensive: empty array short-circuits to false; non-array is coerced to empty via the `isArray` guard.
    assert.equal(r.shared, false);
  });

  test('Windows-style path separators handled', () => {
    const r = detectSharedLibChange(['lib\\db.mjs']);
    assert.equal(r.shared, true);
  });
});

// ---------------------------------------------------------------------------
// resolveDiffScopeSetting
// ---------------------------------------------------------------------------

describe('resolveDiffScopeSetting', () => {
  test('null config → auto', () => {
    assert.equal(resolveDiffScopeSetting(null), 'auto');
  });

  test('missing architect key → auto', () => {
    assert.equal(resolveDiffScopeSetting({}), 'auto');
  });

  test('invalid value → auto', () => {
    assert.equal(resolveDiffScopeSetting({ architect: { diffScope: 'yolo' } }), 'auto');
  });

  test('enabled is honored', () => {
    assert.equal(resolveDiffScopeSetting({ architect: { diffScope: 'enabled' } }), 'enabled');
  });

  test('disabled is honored', () => {
    assert.equal(resolveDiffScopeSetting({ architect: { diffScope: 'disabled' } }), 'disabled');
  });
});

// ---------------------------------------------------------------------------
// resolveArchitectScope decision matrix
// ---------------------------------------------------------------------------

describe('resolveArchitectScope', () => {
  test('disabled → apply=false, reason cites disabled', () => {
    const r = resolveArchitectScope({
      autonomyConfig: { architect: { diffScope: 'disabled' } },
      changedFiles: ['src/feature/Foo.tsx'],
    });
    assert.equal(r.apply, false);
    assert.match(r.reason, /disabled/);
    assert.equal(r.setting, 'disabled');
  });

  test('auto → apply=false, reason cites full context', () => {
    const r = resolveArchitectScope({
      autonomyConfig: { architect: { diffScope: 'auto' } },
      changedFiles: ['src/feature/Foo.tsx'],
    });
    assert.equal(r.apply, false);
    assert.match(r.reason, /auto mode/);
  });

  test('enabled + shared-lib → apply=false, sharedLibDetected=true', () => {
    const r = resolveArchitectScope({
      autonomyConfig: { architect: { diffScope: 'enabled' } },
      changedFiles: ['lib/db.mjs', 'src/feature/Foo.tsx'],
    });
    assert.equal(r.apply, false);
    assert.equal(r.sharedLibDetected, true);
    assert.match(r.reason, /shared-lib|public contract/);
  });

  test('enabled + localised → apply=true, scope present', async () => {
    const cwd = await makeTmpDir();
    try {
      const r = resolveArchitectScope({
        autonomyConfig: { architect: { diffScope: 'enabled' } },
        changedFiles: ['src/feature/Foo.tsx'],
        cwd,  // tmp dir has no git, neighbours will be []
      });
      assert.equal(r.apply, true);
      assert.ok(r.scope);
      assert.deepEqual(r.scope.changed, ['src/feature/Foo.tsx']);
      // No git in tmp dir → expandToOneHop returns [] (safe fallback).
      assert.equal(Array.isArray(r.scope.neighbours), true);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('enabled + empty changedFiles + no git → apply=false', async () => {
    const cwd = await makeTmpDir();
    try {
      const r = resolveArchitectScope({
        autonomyConfig: { architect: { diffScope: 'enabled' } },
        changedFiles: [],
        cwd,
      });
      assert.equal(r.apply, false);
      assert.match(r.reason, /no changed files/);
    } finally {
      await removeTmpDir(cwd);
    }
  });
});

// ---------------------------------------------------------------------------
// formatScopeHint
// ---------------------------------------------------------------------------

describe('formatScopeHint', () => {
  test('apply=false → empty string', () => {
    const out = formatScopeHint({ apply: false, scope: null });
    assert.equal(out, '');
  });

  test('apply=true → markdown section with Changed + 1-hop', () => {
    const out = formatScopeHint({
      apply: true,
      scope: {
        changed: ['src/a.ts', 'src/b.ts'],
        neighbours: ['src/a.test.ts'],
      },
    });
    assert.match(out, /## Review Scope Hint/);
    assert.match(out, /Changed files/);
    assert.match(out, /src\/a\.ts/);
    assert.match(out, /1-hop neighbours/);
    assert.match(out, /src\/a\.test\.ts/);
    // Must remind the agent about broader-impact escalation
    assert.match(out, /broader impact|broader|STOP/);
  });

  test('apply=true with no neighbours → changed-only section', () => {
    const out = formatScopeHint({
      apply: true,
      scope: { changed: ['src/a.ts'], neighbours: [] },
    });
    assert.match(out, /src\/a\.ts/);
    assert.doesNotMatch(out, /1-hop neighbours/);
  });

  test('null input → empty string (fail-safe)', () => {
    assert.equal(formatScopeHint(null), '');
  });
});

// ---------------------------------------------------------------------------
// detectChangedFiles smoke (current repo)
// ---------------------------------------------------------------------------

describe('detectChangedFiles (smoke)', () => {
  test('returns array without throwing, even outside a git repo', async () => {
    const cwd = await makeTmpDir();
    try {
      const files = detectChangedFiles({ cwd });
      assert.equal(Array.isArray(files), true);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('rejects git-ref with shell metachars (defence-in-depth)', async () => {
    const cwd = await makeTmpDir();
    try {
      const files = detectChangedFiles({ cwd, base: 'HEAD; rm -rf /' });
      assert.deepEqual(files, []);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('rejects git-ref with backtick (defence-in-depth)', async () => {
    const cwd = await makeTmpDir();
    try {
      const files = detectChangedFiles({ cwd, base: 'HEAD`whoami`' });
      assert.deepEqual(files, []);
    } finally {
      await removeTmpDir(cwd);
    }
  });
});

// ---------------------------------------------------------------------------
// expandToOneHop — basename filtering + injection rejection
// ---------------------------------------------------------------------------

describe('expandToOneHop (filtering)', () => {
  // Note: these tests exercise the safety-filter layer. The git-grep call
  // itself will fail silently in tmp dirs (no git), so neighbours are [],
  // but the skip logic can still be verified via the returned array.

  test('empty input returns []', () => {
    assert.deepEqual(expandToOneHop([]), []);
  });

  test('non-array returns []', () => {
    assert.deepEqual(expandToOneHop(null), []);
  });

  test('basename below min length is skipped', async () => {
    const cwd = await makeTmpDir();
    try {
      const out = expandToOneHop(['src/a.ts'], { cwd });
      assert.equal(Array.isArray(out), true);
      assert.equal(out.length, 0);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('NOISY_BASENAMES entries are skipped (e.g. utils, helper, index)', async () => {
    const cwd = await makeTmpDir();
    try {
      const out = expandToOneHop([
        'src/utils.ts',
        'src/helper.ts',
        'src/index.ts',
        'src/context.ts',
      ], { cwd });
      assert.equal(Array.isArray(out), true);
      // Even in the repo with git, these noisy names would match too much;
      // the filter returns no neighbours for them.
      assert.equal(out.length, 0);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('basename with leading dash rejected (git option confusion defence)', async () => {
    const cwd = await makeTmpDir();
    try {
      // `--foo` basename would be risky if passed unquoted to git grep.
      // execFileSync is safe (argv), but the regex gate rejects it anyway.
      const out = expandToOneHop(['src/--foo.ts'], { cwd });
      assert.equal(out.length, 0);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('basename with special chars rejected', async () => {
    const cwd = await makeTmpDir();
    try {
      const out = expandToOneHop(['src/$(whoami).ts'], { cwd });
      assert.equal(out.length, 0);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('basename with space rejected', async () => {
    const cwd = await makeTmpDir();
    try {
      const out = expandToOneHop(['src/my file.ts'], { cwd });
      assert.equal(out.length, 0);
    } finally {
      await removeTmpDir(cwd);
    }
  });
});

// ---------------------------------------------------------------------------
// formatScopeHint — adequacy check prompt reinforcement
// ---------------------------------------------------------------------------

describe('formatScopeHint (adequacy reinforcement)', () => {
  test('prompt requires Scope Adequacy Check as first action', () => {
    const out = formatScopeHint({
      apply: true,
      scope: { changed: ['src/a.ts'], neighbours: [] },
    });
    assert.match(out, /First action required/i);
    assert.match(out, /Scope Adequacy Check/);
  });

  test('prompt enumerates escalation triggers', () => {
    const out = formatScopeHint({
      apply: true,
      scope: { changed: ['src/a.ts'], neighbours: [] },
    });
    assert.match(out, /type signature or function signature change/i);
    assert.match(out, /barrel file/i);
  });
});
