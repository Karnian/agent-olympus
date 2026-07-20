import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_HERMES_OUTPUT_BYTES,
  parseHermesSpecEnvelope,
  validateHermesPrd,
  writeHermesSpecArtifacts,
} from '../lib/spec-artifact.mjs';

function validPrd(overrides = {}) {
  return {
    projectName: 'atlas-agent-contracts',
    mode: 'engineering-change',
    scale: 'M',
    goals: ['Persist a validated specification pair.'],
    nonGoals: ['Execute the implementation.'],
    constraints: ['Use zero runtime dependencies.'],
    risks: ['A partial write could mix generations.'],
    openQuestions: [],
    userStories: [{
      id: 'US-001',
      title: 'Persist typed spec artifacts',
      acceptanceCriteria: [
        'GIVEN a Hermes result WHEN it is persisted THEN both artifacts are valid',
      ],
      passes: false,
    }],
    ...overrides,
  };
}

function envelope(overrides = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    verdict: 'CREATE',
    summary: 'Created one executable story.',
    specMarkdown: '# Agent contracts\n\nTyped specification.',
    prd: validPrd(),
    ...overrides,
  });
}

function passEnvelope() {
  return envelope({
    verdict: 'PASS',
    summary: 'The persisted specification remains valid.',
    specMarkdown: null,
    prd: null,
  });
}

function withTempDir(prefix, callback) {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  try {
    return callback(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('Hermes AO_SPEC_V1 schema', () => {
  it('accepts a complete typed write envelope', () => {
    const parsed = parseHermesSpecEnvelope(envelope());
    assert.equal(parsed.verdict, 'CREATE');
    assert.equal(parsed.prd.mode, 'engineering-change');
    assert.equal(parsed.prd.userStories.length, 1);
  });

  it('rejects Markdown and malformed PRD output', () => {
    assert.throws(() => parseHermesSpecEnvelope('```json\n{}\n```'), /exactly one JSON object/);
    assert.throws(
      () => parseHermesSpecEnvelope(envelope({
        prd: validPrd({ projectName: '../escape', userStories: [] }),
      })),
      /invalid Hermes prd/,
    );
  });

  it('requires every AO_SPEC_V1 planning field', () => {
    for (const field of ['goals', 'nonGoals', 'constraints', 'risks', 'openQuestions']) {
      const prd = validPrd();
      delete prd[field];
      const result = validateHermesPrd(prd);
      assert.equal(result.ok, false, field);
      assert.ok(result.errors.some(error => error.includes(`prd.${field} must be an array`)));
    }
    assert.equal(validateHermesPrd(validPrd({ mode: 'validate' })).ok, false);
    assert.equal(validateHermesPrd(validPrd({ scale: 'XL' })).ok, false);
  });

  it('requires target users and measurable metrics for product features', () => {
    const missingProductFields = validateHermesPrd(validPrd({ mode: 'product-feature' }));
    assert.equal(missingProductFields.ok, false);
    assert.ok(missingProductFields.errors.some(error => /targetUsers/.test(error)));
    assert.ok(missingProductFields.errors.some(error => /successMetrics/.test(error)));

    const validProduct = validateHermesPrd(validPrd({
      mode: 'product-feature',
      targetUsers: ['Orchestrator maintainers'],
      successMetrics: [{ metric: 'mixed-generation recoveries', target: '100%' }],
    }));
    assert.deepEqual(validProduct, { ok: true, errors: [] });
  });

  it('requires unique story ids, passes:false, and GIVEN/WHEN/THEN criteria', () => {
    const duplicate = validPrd({
      userStories: [
        validPrd().userStories[0],
        { ...validPrd().userStories[0], title: 'Duplicate id' },
      ],
    });
    assert.ok(validateHermesPrd(duplicate).errors.some(error => /id must be unique/.test(error)));

    const passing = validPrd();
    passing.userStories[0].passes = true;
    assert.ok(validateHermesPrd(passing).errors.some(error => /passes must be false/.test(error)));

    const vague = validPrd();
    vague.userStories[0].acceptanceCriteria = ['Both files are valid'];
    assert.ok(validateHermesPrd(vague).errors.some(error => /GIVEN .* WHEN .* THEN/.test(error)));
  });

  it('caps unreasonable raw output before JSON parsing', () => {
    const oversized = `{"padding":"${'x'.repeat(MAX_HERMES_OUTPUT_BYTES)}"}`;
    assert.throws(() => parseHermesSpecEnvelope(oversized), /exceeds the .*byte limit/);
  });
});

describe('Hermes spec artifact persistence', () => {
  it('writes separate Markdown and JSON files and validates the committed pair', () => {
    withTempDir('ao-spec-artifact-', cwd => {
      const result = writeHermesSpecArtifacts(envelope(), { cwd });
      assert.equal(result.written, true);
      assert.equal(result.validated, true);
      assert.match(readFileSync(join(cwd, '.ao', 'spec.md'), 'utf8'), /^# Agent contracts/);
      const prd = JSON.parse(readFileSync(join(cwd, '.ao', 'prd.json'), 'utf8'));
      assert.equal(prd.projectName, 'atlas-agent-contracts');
      assert.equal(prd.userStories[0].passes, false);
      assert.equal(
        readdirSync(join(cwd, '.ao')).some(name => name.startsWith('.spec-artifact-txn-')),
        false,
      );
    });
  });

  it('removes an empty pre-manifest crash transaction before the next write', () => {
    withTempDir('ao-spec-pre-manifest-crash-', cwd => {
      const aoDir = join(cwd, '.ao');
      const transactionDir = join(
        aoDir,
        '.spec-artifact-txn-00000000-0000-4000-8000-000000000001',
      );
      mkdirSync(aoDir, { mode: 0o700 });
      mkdirSync(transactionDir, { mode: 0o700 });

      const result = writeHermesSpecArtifacts(envelope(), { cwd });

      assert.equal(result.written, true);
      assert.equal(result.validated, true);
      assert.equal(existsSync(transactionDir), false);
      assert.match(readFileSync(join(aoDir, 'spec.md'), 'utf8'), /^# Agent contracts/);
      assert.equal(
        JSON.parse(readFileSync(join(aoDir, 'prd.json'), 'utf8')).projectName,
        'atlas-agent-contracts',
      );
    });
  });

  it('keeps a non-empty manifestless transaction fail-closed for inspection', () => {
    withTempDir('ao-spec-pre-manifest-unsafe-', cwd => {
      const aoDir = join(cwd, '.ao');
      const transactionDir = join(
        aoDir,
        '.spec-artifact-txn-00000000-0000-4000-8000-000000000002',
      );
      mkdirSync(aoDir, { mode: 0o700 });
      mkdirSync(transactionDir, { mode: 0o700 });
      writeFileSync(join(transactionDir, 'next-spec.md'), '# unexplained state\n', {
        mode: 0o600,
      });

      assert.throws(
        () => writeHermesSpecArtifacts(envelope(), { cwd }),
        error => error?.code === 'AO_HARDENED_FS_VIOLATION'
          && /transaction manifest is missing/.test(error.message),
      );
      assert.equal(existsSync(transactionDir), true);
      assert.equal(existsSync(join(aoDir, 'spec.md')), false);
      assert.equal(existsSync(join(aoDir, 'prd.json')), false);
    });
  });

  it('makes PASS hardened-read and validate both existing artifacts', () => {
    withTempDir('ao-spec-pass-', cwd => {
      writeHermesSpecArtifacts(envelope(), { cwd });
      const result = writeHermesSpecArtifacts(passEnvelope(), { cwd });
      assert.equal(result.written, false);
      assert.equal(result.validated, true);
      assert.equal(result.storyCount, 1);

      writeFileSync(join(cwd, '.ao', 'prd.json'), '{}\n', { mode: 0o600 });
      assert.throws(
        () => writeHermesSpecArtifacts(passEnvelope(), { cwd }),
        /invalid existing Hermes prd/,
      );
    });
  });

  it('safely migrates legacy 0644 artifacts before PASS validation', {
    skip: process.platform === 'win32',
  }, () => {
    withTempDir('ao-spec-pass-legacy-mode-', cwd => {
      const aoDir = join(cwd, '.ao');
      const specPath = join(aoDir, 'spec.md');
      const prdPath = join(aoDir, 'prd.json');
      mkdirSync(aoDir, { mode: 0o755 });
      writeFileSync(specPath, '# Existing specification\n', { mode: 0o644 });
      writeFileSync(prdPath, `${JSON.stringify(validPrd(), null, 2)}\n`, { mode: 0o644 });

      const result = writeHermesSpecArtifacts(passEnvelope(), { cwd });
      assert.equal(result.validated, true);
      assert.equal(statSync(specPath).mode & 0o777, 0o600);
      assert.equal(statSync(prdPath).mode & 0o777, 0o600);
    });
  });

  it('prevalidates both legacy modes before changing either artifact', {
    skip: process.platform === 'win32',
  }, () => {
    withTempDir('ao-spec-pass-legacy-prevalidate-', cwd => {
      const aoDir = join(cwd, '.ao');
      const specPath = join(aoDir, 'spec.md');
      const prdPath = join(aoDir, 'prd.json');
      mkdirSync(aoDir, { mode: 0o755 });
      writeFileSync(specPath, '# Existing specification\n', { mode: 0o644 });
      writeFileSync(prdPath, `${JSON.stringify(validPrd(), null, 2)}\n`, { mode: 0o666 });
      chmodSync(prdPath, 0o666);

      assert.throws(
        () => writeHermesSpecArtifacts(passEnvelope(), { cwd }),
        error => error?.code === 'AO_HARDENED_FS_VIOLATION',
      );
      assert.equal(statSync(specPath).mode & 0o777, 0o644);
      assert.equal(statSync(prdPath).mode & 0o777, 0o666);
    });
  });

  it('rejects group/world-writable .ao directories for PASS and WRITE', {
    skip: process.platform === 'win32',
  }, () => {
    withTempDir('ao-spec-unsafe-directory-', cwd => {
      writeHermesSpecArtifacts(envelope(), { cwd });
      chmodSync(join(cwd, '.ao'), 0o777);

      for (const rawOutput of [passEnvelope(), envelope({ verdict: 'UPDATE' })]) {
        assert.throws(
          () => writeHermesSpecArtifacts(rawOutput, { cwd }),
          error => error?.code === 'AO_HARDENED_FS_VIOLATION'
            && /group\/world-writable/.test(error.message),
        );
      }
    });
  });

  it('rejects PASS when either artifact is missing', () => {
    withTempDir('ao-spec-pass-missing-', cwd => {
      mkdirSync(join(cwd, '.ao'), { mode: 0o700 });
      writeFileSync(join(cwd, '.ao', 'spec.md'), '# Existing\n', { mode: 0o600 });
      assert.throws(
        () => writeHermesSpecArtifacts(passEnvelope(), { cwd }),
        /Hermes PRD artifact is missing/,
      );
    });
  });

  it('rolls back the first artifact when the second commit fails', () => {
    withTempDir('ao-spec-rollback-', cwd => {
      writeHermesSpecArtifacts(envelope(), { cwd });
      const specPath = join(cwd, '.ao', 'spec.md');
      const prdPath = join(cwd, '.ao', 'prd.json');
      const beforeSpec = readFileSync(specPath, 'utf8');
      const beforePrd = readFileSync(prdPath, 'utf8');
      const replacement = envelope({
        verdict: 'UPDATE',
        summary: 'Replace the persisted generation.',
        specMarkdown: '# Replacement\n\nMust roll back on failure.',
        prd: validPrd({ goals: ['Replace both files as one generation.'] }),
      });

      assert.throws(
        () => writeHermesSpecArtifacts(replacement, {
          cwd,
          transactionHooks: {
            beforePrdCommit({ stagedPrdPath }) {
              unlinkSync(stagedPrdPath);
            },
          },
        }),
        error => error?.code === 'ENOENT',
      );
      assert.equal(readFileSync(specPath, 'utf8'), beforeSpec);
      assert.equal(readFileSync(prdPath, 'utf8'), beforePrd);
      assert.equal(
        readdirSync(join(cwd, '.ao')).some(name => name.startsWith('.spec-artifact-txn-')),
        false,
      );
    });
  });

  it('leaves neither artifact when a new pair fails on the second commit', () => {
    withTempDir('ao-spec-new-rollback-', cwd => {
      assert.throws(
        () => writeHermesSpecArtifacts(envelope(), {
          cwd,
          transactionHooks: {
            beforePrdCommit({ stagedPrdPath }) {
              unlinkSync(stagedPrdPath);
            },
          },
        }),
        error => error?.code === 'ENOENT',
      );
      assert.equal(existsSync(join(cwd, '.ao', 'spec.md')), false);
      assert.equal(existsSync(join(cwd, '.ao', 'prd.json')), false);
    });
  });

  it('recovers a journaled mixed generation by restoring the original pair', () => {
    withTempDir('ao-spec-crash-rollback-', cwd => {
      writeHermesSpecArtifacts(envelope(), { cwd });
      const aoDir = join(cwd, '.ao');
      const specPath = join(aoDir, 'spec.md');
      const prdPath = join(aoDir, 'prd.json');
      const beforeSpec = readFileSync(specPath, 'utf8');
      const beforePrd = readFileSync(prdPath, 'utf8');
      const replacement = envelope({
        verdict: 'UPDATE',
        summary: 'Install a replacement before the simulated crash.',
        specMarkdown: '# Replacement generation',
        prd: validPrd({ goals: ['Install the replacement generation.'] }),
      });

      assert.throws(
        () => writeHermesSpecArtifacts(replacement, {
          cwd,
          transactionHooks: { simulateCrashAfterSpecCommit: true },
        }),
        error => error?.code === 'AO_SPEC_ARTIFACT_SIMULATED_CRASH',
      );
      assert.match(readFileSync(specPath, 'utf8'), /^# Replacement generation/);
      assert.equal(existsSync(prdPath), false);
      const transactionName = readdirSync(aoDir)
        .find(name => name.startsWith('.spec-artifact-txn-'));
      assert.ok(transactionName);
      assert.equal(statSync(join(aoDir, transactionName)).mode & 0o777, 0o700);
      assert.equal(
        statSync(join(aoDir, transactionName, 'manifest.json')).mode & 0o777,
        0o600,
      );

      const recovered = writeHermesSpecArtifacts(passEnvelope(), { cwd });
      assert.equal(recovered.validated, true);
      assert.equal(readFileSync(specPath, 'utf8'), beforeSpec);
      assert.equal(readFileSync(prdPath, 'utf8'), beforePrd);
      assert.equal(
        readdirSync(aoDir).some(name => name.startsWith('.spec-artifact-txn-')),
        false,
      );
    });
  });

  it('recognizes a journaled complete pair as committed on the next entry', () => {
    withTempDir('ao-spec-crash-commit-', cwd => {
      writeHermesSpecArtifacts(envelope(), { cwd });
      const replacementPrd = validPrd({ goals: ['Retain the committed generation.'] });
      const replacement = envelope({
        verdict: 'UPDATE',
        summary: 'Install both files before the simulated crash.',
        specMarkdown: '# Committed replacement',
        prd: replacementPrd,
      });

      assert.throws(
        () => writeHermesSpecArtifacts(replacement, {
          cwd,
          transactionHooks: { simulateCrashAfterPrdCommit: true },
        }),
        error => error?.code === 'AO_SPEC_ARTIFACT_SIMULATED_CRASH',
      );
      const recovered = writeHermesSpecArtifacts(passEnvelope(), { cwd });
      assert.equal(recovered.validated, true);
      assert.match(readFileSync(join(cwd, '.ao', 'spec.md'), 'utf8'), /^# Committed replacement/);
      assert.deepEqual(
        JSON.parse(readFileSync(join(cwd, '.ao', 'prd.json'), 'utf8')).goals,
        replacementPrd.goals,
      );
      assert.equal(
        readdirSync(join(cwd, '.ao'))
          .some(name => name.startsWith('.spec-artifact-txn-')),
        false,
      );
    });
  });

  it('rejects a symlinked .ao directory without writing outside the project', {
    skip: process.platform === 'win32',
  }, () => {
    withTempDir('ao-spec-symlink-', root => {
      const project = join(root, 'project');
      const outside = join(root, 'outside');
      mkdirSync(project, { mode: 0o700 });
      mkdirSync(outside, { mode: 0o700 });
      symlinkSync(outside, join(project, '.ao'), 'dir');

      assert.throws(
        () => writeHermesSpecArtifacts(envelope(), { cwd: project, trustedRoot: root }),
        error => error?.code === 'AO_HARDENED_FS_VIOLATION',
      );
      assert.deepEqual(readdirSync(outside), []);
    });
  });

  it('rejects a project reached through symlink ancestry', {
    skip: process.platform === 'win32',
  }, () => {
    withTempDir('ao-spec-ancestry-', trustedRoot => {
      const realParent = join(trustedRoot, 'real-parent');
      const linkedParent = join(trustedRoot, 'linked-parent');
      const project = join(realParent, 'project');
      mkdirSync(realParent, { mode: 0o700 });
      mkdirSync(project, { mode: 0o700 });
      symlinkSync(realParent, linkedParent, 'dir');

      assert.throws(
        () => writeHermesSpecArtifacts(envelope(), {
          cwd: join(linkedParent, 'project'),
          trustedRoot,
        }),
        error => error?.code === 'AO_HARDENED_FS_VIOLATION',
      );
      assert.equal(existsSync(join(project, '.ao')), false);
    });
  });
});
