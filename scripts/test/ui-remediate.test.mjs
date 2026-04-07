/**
 * Tests for scripts/lib/ui-remediate.mjs (v1.0.2 US-008)
 *
 * Sequential frontend remediation chain: audit → normalize → polish → re-audit
 * with convergence check. NO retry loop, NO harden stage.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ── helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal fake run-artifacts dir so tests don't depend on real .ao/ */
function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'ao-remediate-test-'));
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

// ── import the module under test ────────────────────────────────────────────

// We import lazily after changing cwd in some tests; for most tests we import once.
let mod;

describe('ui-remediate module', () => {
  before(async () => {
    mod = await import('../lib/ui-remediate.mjs');
  });

  // ── Public API surface ──────────────────────────────────────────────────

  describe('exports', () => {
    it('exports buildChain', () => {
      assert.strictEqual(typeof mod.buildChain, 'function', 'buildChain must be a function');
    });

    it('exports runChain', () => {
      assert.strictEqual(typeof mod.runChain, 'function', 'runChain must be a function');
    });

    it('exports computeConvergence', () => {
      assert.strictEqual(typeof mod.computeConvergence, 'function', 'computeConvergence must be a function');
    });

    it('exports STAGES constant', () => {
      assert.ok(Array.isArray(mod.STAGES), 'STAGES must be an array');
      assert.deepStrictEqual(mod.STAGES, ['audit', 'normalize', 'polish', 're-audit'],
        'STAGES must be exactly [audit, normalize, polish, re-audit]');
    });
  });

  // ── buildChain ──────────────────────────────────────────────────────────

  describe('buildChain()', () => {
    it('returns an array of 4 stage descriptors', () => {
      const chain = mod.buildChain({ target: 'src/Button.tsx' });
      assert.strictEqual(chain.length, 4);
    });

    it('stage names match STAGES constant', () => {
      const chain = mod.buildChain({ target: 'src/Button.tsx' });
      assert.deepStrictEqual(chain.map((s) => s.name), mod.STAGES);
    });

    it('each stage descriptor has name, description, skill fields', () => {
      const chain = mod.buildChain({ target: 'src/Button.tsx' });
      for (const stage of chain) {
        assert.ok(stage.name, 'stage must have a name');
        assert.ok(stage.description, 'stage must have a description');
        assert.ok(stage.skill, 'stage must have a skill');
      }
    });

    it('stage order is strict: audit → normalize → polish → re-audit', () => {
      const chain = mod.buildChain({ target: 'src/Button.tsx' });
      assert.strictEqual(chain[0].name, 'audit');
      assert.strictEqual(chain[1].name, 'normalize');
      assert.strictEqual(chain[2].name, 'polish');
      assert.strictEqual(chain[3].name, 're-audit');
    });

    it('no harden stage present', () => {
      const chain = mod.buildChain({ target: 'src/Button.tsx' });
      const hasHarden = chain.some((s) => s.name === 'harden');
      assert.strictEqual(hasHarden, false, 'harden stage must NOT be present in v1.0.2');
    });

    it('throws if target is missing', () => {
      assert.throws(
        () => mod.buildChain({}),
        /target/i,
        'must throw if target is missing',
      );
    });
  });

  // ── computeConvergence ──────────────────────────────────────────────────

  describe('computeConvergence()', () => {
    it('returns improved when finalSmellCount < initialSmellCount', () => {
      const result = mod.computeConvergence({ initialSmellCount: 5, finalSmellCount: 2 });
      assert.strictEqual(result.status, 'improved');
      assert.strictEqual(result.delta, -3);
      assert.strictEqual(result.regressed, false);
    });

    it('returns unchanged when counts are equal', () => {
      const result = mod.computeConvergence({ initialSmellCount: 3, finalSmellCount: 3 });
      assert.strictEqual(result.status, 'unchanged');
      assert.strictEqual(result.delta, 0);
      assert.strictEqual(result.regressed, false);
    });

    it('returns regressed when finalSmellCount > initialSmellCount', () => {
      const result = mod.computeConvergence({ initialSmellCount: 2, finalSmellCount: 5 });
      assert.strictEqual(result.status, 'regressed');
      assert.strictEqual(result.delta, 3);
      assert.strictEqual(result.regressed, true);
    });

    it('handles zero initial smell count (all clear from start)', () => {
      const result = mod.computeConvergence({ initialSmellCount: 0, finalSmellCount: 0 });
      assert.strictEqual(result.status, 'unchanged');
      assert.strictEqual(result.delta, 0);
    });

    it('contains all required convergence fields', () => {
      const result = mod.computeConvergence({ initialSmellCount: 3, finalSmellCount: 1 });
      assert.ok('initialSmellCount' in result, 'must have initialSmellCount');
      assert.ok('finalSmellCount' in result, 'must have finalSmellCount');
      assert.ok('delta' in result, 'must have delta');
      assert.ok('status' in result, 'must have status');
      assert.ok('regressed' in result, 'must have regressed');
    });

    it('throws on missing initialSmellCount', () => {
      assert.throws(() => mod.computeConvergence({ finalSmellCount: 1 }), /initialSmellCount/i);
    });

    it('throws on missing finalSmellCount', () => {
      assert.throws(() => mod.computeConvergence({ initialSmellCount: 1 }), /finalSmellCount/i);
    });

    it('throws on non-numeric input', () => {
      assert.throws(() => mod.computeConvergence({ initialSmellCount: 'bad', finalSmellCount: 1 }));
    });
  });

  // ── runChain ────────────────────────────────────────────────────────────

  describe('runChain() — dry-run via executor injection', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = makeTmpDir();
    });

    after(() => {
      try { rmSync(tmpDir, { recursive: true }); } catch {}
    });

    it('runs each stage in order and writes ui-remediation.json artifact', async () => {
      // Inject a dry executor that records calls and returns fake smell counts
      const calls = [];
      let callIndex = 0;
      const smellCounts = [4, 2, 1, 1]; // audit:4, normalize:n/a, polish:n/a, re-audit:1

      const executor = async ({ stage, target }) => {
        calls.push(stage);
        const count = smellCounts[callIndex++] ?? 0;
        return { ok: true, smellCount: count, summary: `${stage} done`, filesTouched: [target] };
      };

      const artifactDir = path.join(tmpDir, '.ao', 'artifacts', 'runs', 'run-001');
      mkdirSync(artifactDir, { recursive: true });

      const result = await mod.runChain({
        target: 'src/Button.tsx',
        runId: 'run-001',
        artifactBase: path.join(tmpDir, '.ao', 'artifacts', 'runs'),
        executor,
      });

      assert.ok(result.ok, 'chain should succeed');
      assert.strictEqual(result.stagesCompleted, 4);
      assert.deepStrictEqual(calls, ['audit', 'normalize', 'polish', 're-audit']);

      // Artifact file should exist
      const artifactPath = path.join(tmpDir, '.ao', 'artifacts', 'runs', 'run-001', 'ui-remediation.json');
      assert.ok(existsSync(artifactPath), 'ui-remediation.json must be written');

      const artifact = readJson(artifactPath);
      assert.strictEqual(artifact.schemaVersion, 1);
      assert.ok(Array.isArray(artifact.stages), 'stages must be array');
      assert.strictEqual(artifact.stages.length, 4);
      assert.ok('convergence' in artifact, 'must have convergence block');
    });

    it('halts chain on stage failure and records failure in artifact', async () => {
      let callCount = 0;
      const executor = async ({ stage }) => {
        callCount++;
        if (stage === 'normalize') {
          return { ok: false, error: 'normalize failed — no tokens found', smellCount: 0 };
        }
        return { ok: true, smellCount: 3, summary: 'ok', filesTouched: [] };
      };

      const artifactDir = path.join(tmpDir, '.ao', 'artifacts', 'runs', 'run-halt');
      mkdirSync(artifactDir, { recursive: true });

      const result = await mod.runChain({
        target: 'src/Card.tsx',
        runId: 'run-halt',
        artifactBase: path.join(tmpDir, '.ao', 'artifacts', 'runs'),
        executor,
      });

      assert.strictEqual(result.ok, false, 'chain should fail');
      assert.ok(result.haltedAt, 'haltedAt should be set');
      assert.strictEqual(result.haltedAt, 'normalize');
      // audit ran, normalize failed → polish + re-audit should NOT run
      assert.strictEqual(callCount, 2);
    });

    it('ABORTS (not halts) when re-audit shows regression and marks status=regressed', async () => {
      let callIndex = 0;
      const smellCounts = [2, 1, 0, 5]; // audit:2, normalize:1, polish:0, re-audit:5 (regression!)
      const executor = async ({ stage }) => {
        const count = smellCounts[callIndex++] ?? 0;
        return { ok: true, smellCount: count, summary: `${stage} done`, filesTouched: [] };
      };

      const artifactDir = path.join(tmpDir, '.ao', 'artifacts', 'runs', 'run-regress');
      mkdirSync(artifactDir, { recursive: true });

      const result = await mod.runChain({
        target: 'src/Card.tsx',
        runId: 'run-regress',
        artifactBase: path.join(tmpDir, '.ao', 'artifacts', 'runs'),
        executor,
      });

      assert.strictEqual(result.ok, false, 'should abort on regression');
      assert.strictEqual(result.regression, true, 'regression flag must be set');
      assert.ok(result.convergence, 'convergence must be in result');
      assert.strictEqual(result.convergence.status, 'regressed');

      const artifactPath = path.join(tmpDir, '.ao', 'artifacts', 'runs', 'run-regress', 'ui-remediation.json');
      const artifact = readJson(artifactPath);
      assert.strictEqual(artifact.convergence.status, 'regressed');
    });

    it('artifact contains schemaVersion:1 on every run', async () => {
      const executor = async () => ({ ok: true, smellCount: 2, summary: 'ok', filesTouched: [] });

      const artifactDir = path.join(tmpDir, '.ao', 'artifacts', 'runs', 'run-schema');
      mkdirSync(artifactDir, { recursive: true });

      await mod.runChain({
        target: 'src/index.tsx',
        runId: 'run-schema',
        artifactBase: path.join(tmpDir, '.ao', 'artifacts', 'runs'),
        executor,
      });

      const artifactPath = path.join(tmpDir, '.ao', 'artifacts', 'runs', 'run-schema', 'ui-remediation.json');
      const artifact = readJson(artifactPath);
      assert.strictEqual(artifact.schemaVersion, 1);
    });

    it('artifact contains per-stage records with required fields', async () => {
      const executor = async ({ stage }) => ({
        ok: true, smellCount: 1, summary: `${stage} summary`, filesTouched: ['a.css'], timeElapsed: 100,
      });

      const artifactDir = path.join(tmpDir, '.ao', 'artifacts', 'runs', 'run-fields');
      mkdirSync(artifactDir, { recursive: true });

      await mod.runChain({
        target: 'src/index.tsx',
        runId: 'run-fields',
        artifactBase: path.join(tmpDir, '.ao', 'artifacts', 'runs'),
        executor,
      });

      const artifact = readJson(
        path.join(tmpDir, '.ao', 'artifacts', 'runs', 'run-fields', 'ui-remediation.json'),
      );

      for (const stage of artifact.stages) {
        assert.ok('name' in stage, 'stage must have name');
        assert.ok('status' in stage, 'stage must have status');
        assert.ok('summary' in stage, 'stage must have summary');
        assert.ok('filesTouched' in stage, 'stage must have filesTouched');
        assert.ok('timeElapsed' in stage, 'stage must have timeElapsed');
      }
    });

    it('chain executes exactly ONCE (no retry loop)', async () => {
      const calls = [];
      const executor = async ({ stage }) => {
        calls.push(stage);
        return { ok: true, smellCount: 1, summary: 'ok', filesTouched: [] };
      };

      const artifactDir = path.join(tmpDir, '.ao', 'artifacts', 'runs', 'run-once');
      mkdirSync(artifactDir, { recursive: true });

      await mod.runChain({
        target: 'src/App.tsx',
        runId: 'run-once',
        artifactBase: path.join(tmpDir, '.ao', 'artifacts', 'runs'),
        executor,
      });

      // Exactly 4 calls — no repeated passes
      assert.strictEqual(calls.length, 4);
      assert.deepStrictEqual(calls, ['audit', 'normalize', 'polish', 're-audit']);
    });

    it('each stage receives prior stage outbox payload (not full history)', async () => {
      const receivedInboxes = [];
      let callIndex = 0;
      const executor = async ({ stage, inbox }) => {
        receivedInboxes.push({ stage, inbox });
        callIndex++;
        return { ok: true, smellCount: 3 - callIndex, summary: 'ok', filesTouched: [], outbox: { stageData: stage } };
      };

      const artifactDir = path.join(tmpDir, '.ao', 'artifacts', 'runs', 'run-inbox');
      mkdirSync(artifactDir, { recursive: true });

      await mod.runChain({
        target: 'src/index.tsx',
        runId: 'run-inbox',
        artifactBase: path.join(tmpDir, '.ao', 'artifacts', 'runs'),
        executor,
      });

      // First stage (audit) has no prior inbox
      assert.strictEqual(receivedInboxes[0].inbox, null, 'audit has no prior inbox');
      // Subsequent stages receive prior outbox
      assert.ok(receivedInboxes[1].inbox, 'normalize must receive audit outbox');
      assert.ok(receivedInboxes[2].inbox, 'polish must receive normalize outbox');
      assert.ok(receivedInboxes[3].inbox, 're-audit must receive polish outbox');
    });

    it('unchanged smell count logs warning but does not fail', async () => {
      let callIndex = 0;
      const smellCounts = [3, 2, 1, 3]; // audit:3, normalize:2, polish:1, re-audit:3 (back up = regressed vs initial)
      // Wait — 3 → 3: regressed per spec (finalCount > initialCount from re-audit perspective)
      // Actually re-audit 3 equals initial audit 3 → unchanged
      const executor = async () => {
        const count = smellCounts[callIndex++] ?? 0;
        return { ok: true, smellCount: count, summary: 'ok', filesTouched: [] };
      };

      // For unchanged test: initial=3, final=3
      callIndex = 0;
      const smellCountsUnchanged = [3, 2, 2, 3];
      const executorUnchanged = async () => {
        const count = smellCountsUnchanged[callIndex++] ?? 0;
        return { ok: true, smellCount: count, summary: 'ok', filesTouched: [] };
      };

      const artifactDir = path.join(tmpDir, '.ao', 'artifacts', 'runs', 'run-unchanged');
      mkdirSync(artifactDir, { recursive: true });

      const result = await mod.runChain({
        target: 'src/index.tsx',
        runId: 'run-unchanged',
        artifactBase: path.join(tmpDir, '.ao', 'artifacts', 'runs'),
        executor: executorUnchanged,
      });

      // unchanged does not abort — warn only
      assert.strictEqual(result.ok, true, 'unchanged should succeed (warn only)');
      assert.strictEqual(result.convergence.status, 'unchanged');
    });

    it('handles executor throw gracefully — halts and records error', async () => {
      const executor = async ({ stage }) => {
        if (stage === 'polish') throw new Error('polish executor crashed');
        return { ok: true, smellCount: 2, summary: 'ok', filesTouched: [] };
      };

      const artifactDir = path.join(tmpDir, '.ao', 'artifacts', 'runs', 'run-throw');
      mkdirSync(artifactDir, { recursive: true });

      const result = await mod.runChain({
        target: 'src/index.tsx',
        runId: 'run-throw',
        artifactBase: path.join(tmpDir, '.ao', 'artifacts', 'runs'),
        executor,
      });

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.haltedAt, 'polish');
      assert.ok(result.error, 'must carry error message');
    });

    it('missing executor throws immediately before any stage runs', async () => {
      await assert.rejects(
        () => mod.runChain({
          target: 'src/index.tsx',
          runId: 'run-no-exec',
          artifactBase: path.join(tmpDir, '.ao', 'artifacts', 'runs'),
          // no executor
        }),
        /executor/i,
      );
    });

    it('missing runId throws before any stage runs', async () => {
      const executor = async () => ({ ok: true, smellCount: 0, summary: 'ok', filesTouched: [] });
      await assert.rejects(
        () => mod.runChain({
          target: 'src/index.tsx',
          artifactBase: path.join(tmpDir, '.ao', 'artifacts', 'runs'),
          executor,
        }),
        /runId/i,
      );
    });

    it('concurrent calls to runChain with different runIds do not conflict', async () => {
      const makeExec = (smells) => {
        let i = 0;
        return async () => ({ ok: true, smellCount: smells[i++] ?? 0, summary: 'ok', filesTouched: [] });
      };

      for (const id of ['run-c1', 'run-c2', 'run-c3']) {
        mkdirSync(path.join(tmpDir, '.ao', 'artifacts', 'runs', id), { recursive: true });
      }

      const [r1, r2, r3] = await Promise.all([
        mod.runChain({
          target: 'src/A.tsx', runId: 'run-c1',
          artifactBase: path.join(tmpDir, '.ao', 'artifacts', 'runs'),
          executor: makeExec([4, 3, 2, 1]),
        }),
        mod.runChain({
          target: 'src/B.tsx', runId: 'run-c2',
          artifactBase: path.join(tmpDir, '.ao', 'artifacts', 'runs'),
          executor: makeExec([2, 1, 0, 0]),
        }),
        mod.runChain({
          target: 'src/C.tsx', runId: 'run-c3',
          artifactBase: path.join(tmpDir, '.ao', 'artifacts', 'runs'),
          executor: makeExec([1, 0, 0, 0]),
        }),
      ]);

      assert.ok(r1.ok);
      assert.ok(r2.ok);
      assert.ok(r3.ok);
    });
  });

  // ── Finish-branch integration contract ─────────────────────────────────

  describe('finish-branch integration contract', () => {
    it('runChain resolves before finish-branch can continue (is async/awaitable)', async () => {
      // Chain must be awaitable — finish-branch waits for completion
      const executor = async () => ({ ok: true, smellCount: 1, summary: 'ok', filesTouched: [] });
      const tmpRun = makeTmpDir();
      mkdirSync(path.join(tmpRun, '.ao', 'artifacts', 'runs', 'run-fb'), { recursive: true });

      const promise = mod.runChain({
        target: 'src/index.tsx',
        runId: 'run-fb',
        artifactBase: path.join(tmpRun, '.ao', 'artifacts', 'runs'),
        executor,
      });

      assert.ok(promise instanceof Promise, 'runChain must return a Promise');
      const result = await promise;
      assert.ok('ok' in result, 'result must have ok field');
      rmSync(tmpRun, { recursive: true });
    });

    it('ZERO parallel subagent spawns — executor is called sequentially (not concurrently)', async () => {
      let concurrentCalls = 0;
      let maxConcurrent = 0;

      const executor = async ({ stage }) => {
        concurrentCalls++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
        await new Promise((r) => setTimeout(r, 10)); // simulate work
        concurrentCalls--;
        return { ok: true, smellCount: 1, summary: `${stage} ok`, filesTouched: [] };
      };

      const tmpRun2 = makeTmpDir();
      mkdirSync(path.join(tmpRun2, '.ao', 'artifacts', 'runs', 'run-seq'), { recursive: true });

      await mod.runChain({
        target: 'src/index.tsx',
        runId: 'run-seq',
        artifactBase: path.join(tmpRun2, '.ao', 'artifacts', 'runs'),
        executor,
      });

      assert.strictEqual(maxConcurrent, 1, 'never more than 1 executor active at a time (sequential)');
      rmSync(tmpRun2, { recursive: true });
    });
  });

  // ── AC edge cases ───────────────────────────────────────────────────────

  describe('AC edge cases', () => {
    it('missing normalize/polish skills: executor returns ok:false with clear error', async () => {
      const executor = async ({ stage }) => {
        if (stage === 'normalize') return { ok: false, error: 'skill /normalize not found' };
        return { ok: true, smellCount: 2, summary: 'ok', filesTouched: [] };
      };

      const tmpRun3 = makeTmpDir();
      mkdirSync(path.join(tmpRun3, '.ao', 'artifacts', 'runs', 'run-missing'), { recursive: true });

      const result = await mod.runChain({
        target: 'src/index.tsx',
        runId: 'run-missing',
        artifactBase: path.join(tmpRun3, '.ao', 'artifacts', 'runs'),
        executor,
      });

      assert.strictEqual(result.ok, false);
      assert.ok(result.error || result.haltedAt, 'must carry error or haltedAt');
      rmSync(tmpRun3, { recursive: true });
    });

    it('artifact is still written even when chain halts mid-way', async () => {
      const executor = async ({ stage }) => {
        if (stage === 'normalize') return { ok: false, error: 'failed' };
        return { ok: true, smellCount: 2, summary: 'ok', filesTouched: [] };
      };

      const tmpRun4 = makeTmpDir();
      const runsDir = path.join(tmpRun4, '.ao', 'artifacts', 'runs');
      mkdirSync(path.join(runsDir, 'run-write-on-halt'), { recursive: true });

      await mod.runChain({
        target: 'src/index.tsx',
        runId: 'run-write-on-halt',
        artifactBase: runsDir,
        executor,
      });

      const artifactPath = path.join(runsDir, 'run-write-on-halt', 'ui-remediation.json');
      assert.ok(existsSync(artifactPath), 'artifact must be written even on halt');
      const artifact = readJson(artifactPath);
      assert.strictEqual(artifact.schemaVersion, 1);
      rmSync(tmpRun4, { recursive: true });
    });
  });
});
