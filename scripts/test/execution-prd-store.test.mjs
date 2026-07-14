import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  EXECUTION_PRD_CONFLICT_CODE,
  EXECUTION_PRD_INVALID_CODE,
  EXECUTION_PRD_LOCK_RELATIVE_PATH,
  enrichExecutionPrd,
  readExecutionPrd,
  readPlanningPrdForExecution,
  setExecutionStoryPasses,
} from '../lib/execution-prd-store.mjs';
import { HARDENED_FS_VIOLATION_CODE } from '../lib/hardened-fs.mjs';
import {
  MAX_HERMES_PRD_BYTES,
  writeHermesSpecArtifacts,
} from '../lib/spec-artifact.mjs';

const STORE_MODULE_URL = pathToFileURL(
  resolve(dirname(new URL(import.meta.url).pathname), '../lib/execution-prd-store.mjs'),
).href;

function withTempDir(prefix, callback) {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  try {
    return callback(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function planningStory(overrides = {}) {
  return {
    id: 'US-001',
    title: 'Persist execution state safely',
    acceptanceCriteria: [
      'GIVEN a validated plan WHEN execution state changes THEN the authoritative PRD remains valid',
    ],
    passes: false,
    rationale: 'Preserve non-execution AO_SPEC fields exactly.',
    ...overrides,
  };
}

function atlasPlanning(overrides = {}) {
  return {
    projectName: 'atlas-execution-store',
    mode: 'engineering-change',
    scale: 'M',
    goals: ['Keep one authoritative execution PRD.'],
    nonGoals: ['Change worker adapter behavior.'],
    constraints: ['Use zero runtime dependencies.'],
    risks: ['A stale writer could erase verified progress.'],
    openQuestions: [],
    userStories: [
      planningStory(),
      planningStory({
        id: 'US-002',
        title: 'Resume verified execution state',
        acceptanceCriteria: [
          'GIVEN a committed transition WHEN orchestration resumes THEN the same generation is loaded',
        ],
      }),
    ],
    ...overrides,
  };
}

function atlasExecution(source = atlasPlanning()) {
  const candidate = structuredClone(source);
  Object.assign(candidate.userStories[0], {
    parallelGroup: 'external',
    assignTo: 'codex',
    model: 'sonnet',
    scope: ['scripts/lib/execution-prd-store.mjs'],
    requiresTDD: true,
  });
  Object.assign(candidate.userStories[1], {
    parallelGroup: 'claude',
    assignTo: 'claude',
    model: 'sonnet',
    agentType: 'test-engineer',
    scope: ['scripts/test/execution-prd-store.test.mjs'],
    dependsOn: ['US-001'],
    requiresTDD: true,
  });
  return candidate;
}

function athenaPlanning() {
  return atlasPlanning({ projectName: 'athena-execution-store' });
}

function athenaExecution(source = athenaPlanning()) {
  const candidate = structuredClone(source);
  Object.assign(candidate.userStories[0], {
    parallelGroup: 'workers',
    assignedWorker: 'claude-store',
    workerType: 'claude',
    model: 'sonnet',
    agentType: 'executor',
    scope: ['scripts/lib/execution-prd-store.mjs'],
  });
  Object.assign(candidate.userStories[1], {
    parallelGroup: 'workers',
    assignedWorker: 'codex-tests',
    workerType: 'codex',
    scope: ['scripts/test/execution-prd-store.test.mjs'],
  });
  return candidate;
}

function writePlanning(cwd, prd = atlasPlanning()) {
  const aoPath = join(cwd, '.ao');
  mkdirSync(aoPath, { mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(aoPath, 0o700);
  const prdPath = join(aoPath, 'prd.json');
  writeFileSync(prdPath, `${JSON.stringify(prd, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(prdPath, 0o600);
  return prdPath;
}

function hermesEnvelope(prd) {
  return JSON.stringify({
    schemaVersion: 1,
    verdict: 'CREATE',
    summary: 'Created a planning PRD for the shared-writer lock test.',
    specMarkdown: '# Shared PRD writer lock\n\nValidated planning specification.',
    prd,
  });
}

function hermesPassEnvelope() {
  return JSON.stringify({
    schemaVersion: 1,
    verdict: 'PASS',
    summary: 'The existing planning pair remains valid.',
    specMarkdown: null,
    prd: null,
  });
}

function enrichAtlas(cwd) {
  const planning = readPlanningPrdForExecution({ cwd });
  return enrichExecutionPrd(atlasExecution(planning.prd), {
    cwd,
    orchestrator: 'atlas',
    expectedGeneration: planning.generation,
  });
}

describe('hardened execution PRD enrichment', () => {
  it('passes a normal generic Hermes projectName through plan to Atlas enrichment unchanged', () => {
    withTempDir('ao-execution-prd-generic-slug-', cwd => {
      const source = atlasPlanning({ projectName: 'example-notification-preferences' });
      writeHermesSpecArtifacts(hermesEnvelope(source), { cwd });
      const planning = readPlanningPrdForExecution({ cwd });
      const result = enrichExecutionPrd(atlasExecution(planning.prd), {
        cwd,
        orchestrator: 'atlas',
        expectedGeneration: planning.generation,
      });
      assert.equal(result.prd.projectName, source.projectName);
      assert.equal(readExecutionPrd({ cwd, orchestrator: 'atlas' }).prd.projectName, source.projectName);
    });
  });

  it('preserves AO_SPEC data and atomically enriches only assignment fields', () => {
    withTempDir('ao-execution-prd-enrich-', cwd => {
      const source = atlasPlanning();
      writePlanning(cwd, source);
      const planning = readPlanningPrdForExecution({ cwd });
      const result = enrichExecutionPrd(atlasExecution(planning.prd), {
        cwd,
        orchestrator: 'atlas',
        expectedGeneration: planning.generation,
      });

      assert.equal(result.changed, true);
      assert.notEqual(result.generation, planning.generation);
      assert.equal(result.prd.userStories[0].rationale, source.userStories[0].rationale);
      assert.equal(result.prd.userStories[0].assignTo, 'codex');
      assert.equal(result.prd.userStories[1].agentType, 'test-engineer');
      assert.deepEqual(readExecutionPrd({ cwd, orchestrator: 'atlas' }), {
        prd: result.prd,
        generation: result.generation,
        changed: false,
      });
      assert.equal(readFileSync(join(cwd, '.ao', 'prd.json'), 'utf8').endsWith('\n'), true);
    });
  });

  it('supports Athena assignment enrichment under the same store contract', () => {
    withTempDir('ao-execution-prd-athena-', cwd => {
      writePlanning(cwd, athenaPlanning());
      const planning = readPlanningPrdForExecution({ cwd });
      const result = enrichExecutionPrd(athenaExecution(planning.prd), {
        cwd,
        orchestrator: 'athena',
        expectedGeneration: planning.generation,
      });
      assert.equal(result.prd.userStories[0].assignedWorker, 'claude-store');
      assert.equal(result.prd.userStories[1].workerType, 'codex');
      assert.equal(readExecutionPrd({ cwd, orchestrator: 'athena' }).generation, result.generation);
    });
  });

  it('rejects non-assignment changes and leaves the planning generation intact', () => {
    withTempDir('ao-execution-prd-preserve-', cwd => {
      writePlanning(cwd);
      const planning = readPlanningPrdForExecution({ cwd });
      const candidate = atlasExecution(planning.prd);
      candidate.userStories[0].title = 'Silently changed requirement';
      assert.throws(
        () => enrichExecutionPrd(candidate, {
          cwd,
          orchestrator: 'atlas',
          expectedGeneration: planning.generation,
        }),
        error => error?.code === EXECUTION_PRD_INVALID_CODE && /only add or replace/.test(error.message),
      );
      assert.equal(readPlanningPrdForExecution({ cwd }).generation, planning.generation);
    });
  });

  it('serializes Hermes and execution-store writers through one shared lock', () => {
    withTempDir('ao-execution-prd-shared-writer-', cwd => {
      writeHermesSpecArtifacts(hermesEnvelope(atlasPlanning()), { cwd });
      const planning = readPlanningPrdForExecution({ cwd });
      let competingWriterError = null;
      const enriched = enrichExecutionPrd(atlasExecution(planning.prd), {
        cwd,
        orchestrator: 'atlas',
        expectedGeneration: planning.generation,
        _inject: {
          afterLock() {
            try {
              writeHermesSpecArtifacts(hermesPassEnvelope(), { cwd });
            } catch (error) {
              competingWriterError = error;
            }
          },
        },
      });
      assert.equal(competingWriterError?.code, EXECUTION_PRD_CONFLICT_CODE);
      assert.equal(enriched.changed, true);
      assert.equal(readExecutionPrd({ cwd, orchestrator: 'atlas' }).generation, enriched.generation);
    });
  });
});

describe('execution PRD CAS transitions and recovery', () => {
  it('commits pass transitions, rejects stale CAS, rolls back, and resumes idempotently', () => {
    withTempDir('ao-execution-prd-transition-', cwd => {
      writePlanning(cwd);
      const enriched = enrichAtlas(cwd);
      assert.throws(
        () => setExecutionStoryPasses(['US-002'], true, {
          cwd,
          orchestrator: 'atlas',
          expectedGeneration: enriched.generation,
        }),
        error => error?.code === EXECUTION_PRD_INVALID_CODE
          && /cannot pass before dependencies/.test(error.message),
      );
      const passed = setExecutionStoryPasses(['US-001'], true, {
        cwd,
        orchestrator: 'atlas',
        expectedGeneration: enriched.generation,
      });
      assert.equal(passed.changed, true);
      assert.equal(passed.prd.userStories[0].passes, true);

      assert.throws(
        () => setExecutionStoryPasses(['US-002'], true, {
          cwd,
          orchestrator: 'atlas',
          expectedGeneration: enriched.generation,
        }),
        error => error?.code === EXECUTION_PRD_CONFLICT_CODE && /generation changed/.test(error.message),
      );

      const dependentPassed = setExecutionStoryPasses(['US-002'], true, {
        cwd,
        orchestrator: 'atlas',
        expectedGeneration: passed.generation,
      });
      assert.equal(dependentPassed.prd.userStories[1].passes, true);
      const rolledBack = setExecutionStoryPasses(['US-001'], false, {
        cwd,
        orchestrator: 'atlas',
        expectedGeneration: dependentPassed.generation,
      });
      assert.equal(rolledBack.prd.userStories[0].passes, false);
      assert.equal(rolledBack.prd.userStories[1].passes, false);
      const resumed = readExecutionPrd({ cwd, orchestrator: 'atlas' });
      assert.equal(resumed.generation, rolledBack.generation);

      const idempotent = setExecutionStoryPasses(['US-001'], false, {
        cwd,
        orchestrator: 'atlas',
        expectedGeneration: resumed.generation,
      });
      assert.equal(idempotent.changed, false);
      assert.equal(idempotent.generation, resumed.generation);
    });
  });

  it('serializes concurrent writers before evaluating their shared CAS generation', () => {
    withTempDir('ao-execution-prd-concurrent-', cwd => {
      writePlanning(cwd);
      const enriched = enrichAtlas(cwd);
      let contender;
      const winner = setExecutionStoryPasses(['US-001'], true, {
        cwd,
        orchestrator: 'atlas',
        expectedGeneration: enriched.generation,
        _inject: {
          afterLock() {
            const script = `
              import { setExecutionStoryPasses, EXECUTION_PRD_CONFLICT_CODE } from ${JSON.stringify(STORE_MODULE_URL)};
              try {
                setExecutionStoryPasses(['US-002'], true, {
                  cwd: ${JSON.stringify(cwd)},
                  orchestrator: 'atlas',
                  expectedGeneration: ${JSON.stringify(enriched.generation)},
                });
                process.exit(3);
              } catch (error) {
                if (error?.code === EXECUTION_PRD_CONFLICT_CODE) process.exit(0);
                console.error(error?.stack || error);
                process.exit(2);
              }
            `;
            contender = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
              encoding: 'utf8',
              timeout: 10_000,
            });
          },
        },
      });
      assert.equal(contender?.status, 0, contender?.stderr);
      assert.equal(winner.prd.userStories[0].passes, true);
      assert.equal(winner.prd.userStories[1].passes, false);
    });
  });

  it('keeps pre-commit failures unchanged and reclaims a real post-rename process crash', () => {
    withTempDir('ao-execution-prd-crash-', cwd => {
      writePlanning(cwd);
      const enriched = enrichAtlas(cwd);
      assert.throws(
        () => setExecutionStoryPasses(['US-001'], true, {
          cwd,
          orchestrator: 'atlas',
          expectedGeneration: enriched.generation,
          _inject: { beforeCommit() { throw new Error('pre-commit crash'); } },
        }),
        /pre-commit crash/,
      );
      assert.equal(readExecutionPrd({ cwd, orchestrator: 'atlas' }).generation, enriched.generation);

      const crashScript = `
        import { setExecutionStoryPasses } from ${JSON.stringify(STORE_MODULE_URL)};
        setExecutionStoryPasses(['US-001'], true, {
          cwd: ${JSON.stringify(cwd)},
          orchestrator: 'atlas',
          expectedGeneration: ${JSON.stringify(enriched.generation)},
          _inject: {
            now: ${Date.now() - 60_000},
            afterAtomicWrite() { process.exit(91); },
          },
        });
        process.exit(3);
      `;
      const crashed = spawnSync(process.execPath, ['--input-type=module', '--eval', crashScript], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.equal(crashed.status, 91, crashed.stderr);
      const resumed = readExecutionPrd({ cwd, orchestrator: 'atlas' });
      assert.notEqual(resumed.generation, enriched.generation);
      assert.equal(resumed.prd.userStories[0].passes, true);

      const reclaimed = setExecutionStoryPasses(['US-002'], true, {
        cwd,
        orchestrator: 'atlas',
        expectedGeneration: resumed.generation,
        _inject: { lockStaleMs: 0 },
      });
      assert.equal(reclaimed.prd.userStories[1].passes, true);
      assert.equal(existsSync(join(cwd, EXECUTION_PRD_LOCK_RELATIVE_PATH)), false);
    });
  });

  it('reclaims a definitely-dead owner lock and resumes the pending enrichment', () => {
    withTempDir('ao-execution-prd-stale-lock-', cwd => {
      writePlanning(cwd);
      const planning = readPlanningPrdForExecution({ cwd });
      const statePath = join(cwd, '.ao', 'state');
      mkdirSync(statePath, { mode: 0o700 });
      if (process.platform !== 'win32') chmodSync(statePath, 0o700);
      const lockPath = join(cwd, EXECUTION_PRD_LOCK_RELATIVE_PATH);
      writeFileSync(lockPath, `${JSON.stringify({
        schemaVersion: 1,
        token: '00000000-0000-4000-8000-000000000001',
        pid: 999_999,
        startId: 'dead-process-start',
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      })}\n`, { mode: 0o600 });
      if (process.platform !== 'win32') chmodSync(lockPath, 0o600);

      const result = enrichExecutionPrd(atlasExecution(planning.prd), {
        cwd,
        orchestrator: 'atlas',
        expectedGeneration: planning.generation,
        _inject: {
          lockStaleMs: 0,
          processKill() {
            const error = new Error('no such process');
            error.code = 'ESRCH';
            throw error;
          },
        },
      });
      assert.equal(result.changed, true);
      assert.equal(existsSync(lockPath), false);
    });
  });
});

describe('execution PRD filesystem hardening', () => {
  it('rejects symlink and hardlink PRD artifacts', () => {
    withTempDir('ao-execution-prd-links-', cwd => {
      const prdPath = writePlanning(cwd);
      const external = join(cwd, 'external-prd.json');
      writeFileSync(external, readFileSync(prdPath), { mode: 0o600 });
      unlinkSync(prdPath);
      symlinkSync(external, prdPath);
      assert.throws(
        () => readPlanningPrdForExecution({ cwd }),
        error => error?.code === HARDENED_FS_VIOLATION_CODE,
      );
    });

    withTempDir('ao-execution-prd-hardlink-', cwd => {
      const prdPath = writePlanning(cwd);
      linkSync(prdPath, join(cwd, '.ao', 'prd-copy.json'));
      assert.throws(
        () => readPlanningPrdForExecution({ cwd }),
        error => error?.code === HARDENED_FS_VIOLATION_CODE,
      );
    });
  });

  it('rejects unsafe file/directory modes and oversized artifacts', { skip: process.platform === 'win32' }, () => {
    withTempDir('ao-execution-prd-file-mode-', cwd => {
      const prdPath = writePlanning(cwd);
      chmodSync(prdPath, 0o644);
      assert.throws(
        () => readPlanningPrdForExecution({ cwd }),
        error => error?.code === HARDENED_FS_VIOLATION_CODE,
      );
    });

    withTempDir('ao-execution-prd-dir-mode-', cwd => {
      writePlanning(cwd);
      chmodSync(join(cwd, '.ao'), 0o777);
      assert.throws(
        () => readPlanningPrdForExecution({ cwd }),
        error => error?.code === HARDENED_FS_VIOLATION_CODE,
      );
    });

    withTempDir('ao-execution-prd-oversize-', cwd => {
      const prdPath = writePlanning(cwd);
      writeFileSync(prdPath, 'x'.repeat(MAX_HERMES_PRD_BYTES + 1), { mode: 0o600 });
      chmodSync(prdPath, 0o600);
      assert.throws(
        () => readPlanningPrdForExecution({ cwd }),
        error => error?.code === HARDENED_FS_VIOLATION_CODE,
      );
    });
  });

  it('rejects symlinked .ao ancestry even when the target artifact is valid', () => {
    const external = mkdtempSync(join(tmpdir(), 'ao-execution-prd-external-'));
    try {
      withTempDir('ao-execution-prd-ancestry-', cwd => {
        writeFileSync(join(external, 'prd.json'), `${JSON.stringify(atlasPlanning())}\n`, {
          mode: 0o600,
        });
        if (process.platform !== 'win32') {
          chmodSync(external, 0o700);
          chmodSync(join(external, 'prd.json'), 0o600);
        }
        symlinkSync(external, join(cwd, '.ao'), 'dir');
        assert.throws(
          () => readPlanningPrdForExecution({ cwd }),
          error => error?.code === HARDENED_FS_VIOLATION_CODE,
        );
      });
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });
});
