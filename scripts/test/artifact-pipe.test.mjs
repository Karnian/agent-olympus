/**
 * Tests for scripts/lib/artifact-pipe.mjs (v1.0.2 US-007)
 *
 * Cascade artifact ARCHIVAL pipe (NOT isolation).
 * Files: .ao/artifacts/pipe/<runId>/<stage>/{inbox,outbox}/
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ── helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'ao-artifact-pipe-test-'));
}

async function readJson(filePath) {
  const raw = await readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

// ── module import ────────────────────────────────────────────────────────────

let mod;

describe('artifact-pipe module', () => {
  before(async () => {
    mod = await import('../lib/artifact-pipe.mjs');
  });

  // ── Public API surface ──────────────────────────────────────────────────

  describe('exports', () => {
    it('exports writeOutbox', () => {
      assert.strictEqual(typeof mod.writeOutbox, 'function');
    });

    it('exports readInbox', () => {
      assert.strictEqual(typeof mod.readInbox, 'function');
    });

    it('exports CANONICAL_STAGES', () => {
      assert.ok(Array.isArray(mod.CANONICAL_STAGES));
    });

    it('CANONICAL_STAGES contains exactly the allowed stage names', () => {
      const expected = ['plan', 'decompose', 'execute', 'verify', 'review', 'finish'];
      assert.deepStrictEqual([...mod.CANONICAL_STAGES].sort(), [...expected].sort());
    });
  });

  // ── CANONICAL_STAGES validation ─────────────────────────────────────────

  describe('stage name validation', () => {
    let tmpDir;

    before(() => { tmpDir = makeTmpDir(); });
    after(() => { try { rmSync(tmpDir, { recursive: true }); } catch {} });

    it('writeOutbox accepts all 6 canonical stage names', async () => {
      for (const stage of mod.CANONICAL_STAGES) {
        await assert.doesNotReject(
          () => mod.writeOutbox('run-valid', stage, 'test.json', { x: 1 }, {
            pipeBase: path.join(tmpDir, '.ao', 'artifacts', 'pipe'),
          }),
          `${stage} must be accepted`,
        );
      }
    });

    it('writeOutbox rejects free-form stage names not in canonical list', async () => {
      const badStages = ['stage-x', 'custom', 'harden', 'audit', 'normalize', 'any'];
      for (const bad of badStages) {
        await assert.rejects(
          () => mod.writeOutbox('run-bad', bad, 'test.json', { x: 1 }, {
            pipeBase: path.join(tmpDir, '.ao', 'artifacts', 'pipe'),
          }),
          /canonical stage|invalid stage/i,
          `"${bad}" must be rejected`,
        );
      }
    });

    it('readInbox rejects free-form stage names', async () => {
      await assert.rejects(
        () => mod.readInbox('run-bad', 'nonexistent-stage', {
          pipeBase: path.join(tmpDir, '.ao', 'artifacts', 'pipe'),
        }),
        /canonical stage|invalid stage/i,
      );
    });
  });

  // ── writeOutbox ─────────────────────────────────────────────────────────

  describe('writeOutbox()', () => {
    let tmpDir;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    after(() => { try { rmSync(tmpDir, { recursive: true }); } catch {} });

    it('writes file to .ao/artifacts/pipe/<runId>/<stage>/outbox/', async () => {
      const pipeBase = path.join(tmpDir, '.ao', 'artifacts', 'pipe');
      await mod.writeOutbox('run-001', 'execute', 'result.json', { outcome: 'success' }, { pipeBase });

      const expectedPath = path.join(pipeBase, 'run-001', 'execute', 'outbox', 'result.json');
      assert.ok(existsSync(expectedPath), 'outbox file must exist at correct path');
    });

    it('written file contains schemaVersion:1', async () => {
      const pipeBase = path.join(tmpDir, '.ao', 'artifacts', 'pipe');
      await mod.writeOutbox('run-sv', 'plan', 'data.json', { steps: [1, 2, 3] }, { pipeBase });

      const filePath = path.join(pipeBase, 'run-sv', 'plan', 'outbox', 'data.json');
      const data = await readJson(filePath);
      assert.strictEqual(data.schemaVersion, 1, 'written file must carry schemaVersion:1');
    });

    it('written file preserves the original payload fields', async () => {
      const pipeBase = path.join(tmpDir, '.ao', 'artifacts', 'pipe');
      const payload = { stories: ['US-001', 'US-002'], status: 'complete', count: 2 };
      await mod.writeOutbox('run-payload', 'decompose', 'stories.json', payload, { pipeBase });

      const filePath = path.join(pipeBase, 'run-payload', 'decompose', 'outbox', 'stories.json');
      const data = await readJson(filePath);
      assert.strictEqual(data.stories[0], 'US-001');
      assert.strictEqual(data.status, 'complete');
      assert.strictEqual(data.count, 2);
    });

    it('creates directories recursively', async () => {
      const pipeBase = path.join(tmpDir, 'deeply', 'nested', 'pipe');
      await mod.writeOutbox('run-mkdir', 'verify', 'test.json', { ok: true }, { pipeBase });
      assert.ok(existsSync(path.join(pipeBase, 'run-mkdir', 'verify', 'outbox')));
    });

    it('multiple outbox files in same stage dir are allowed', async () => {
      const pipeBase = path.join(tmpDir, '.ao', 'artifacts', 'pipe');
      await mod.writeOutbox('run-multi', 'review', 'file1.json', { a: 1 }, { pipeBase });
      await mod.writeOutbox('run-multi', 'review', 'file2.json', { b: 2 }, { pipeBase });
      await mod.writeOutbox('run-multi', 'review', 'file3.json', { c: 3 }, { pipeBase });

      const outboxDir = path.join(pipeBase, 'run-multi', 'review', 'outbox');
      const files = readdirSync(outboxDir).filter((f) => !f.startsWith('.'));
      assert.strictEqual(files.length, 3);
    });

    it('uses atomic write (via fs-atomic) — safe for concurrent calls', async () => {
      const pipeBase = path.join(tmpDir, '.ao', 'artifacts', 'pipe');
      // Fire 5 concurrent writes to same stage
      const writes = Array.from({ length: 5 }, (_, i) =>
        mod.writeOutbox('run-atomic', 'execute', `item-${i}.json`, { i }, { pipeBase }),
      );
      await Promise.all(writes);

      const outboxDir = path.join(pipeBase, 'run-atomic', 'execute', 'outbox');
      const files = readdirSync(outboxDir).filter((f) => !f.startsWith('.'));
      assert.strictEqual(files.length, 5, 'all 5 concurrent writes must land');
    });

    // ── 100KB per-file cap ──────────────────────────────────────────────

    it('truncates payload at 100KB with tail-truncation warning', async () => {
      const pipeBase = path.join(tmpDir, '.ao', 'artifacts', 'pipe');
      // Build a payload that exceeds 100KB
      const bigPayload = { data: 'x'.repeat(120 * 1024) }; // 120KB string
      const result = await mod.writeOutbox('run-cap', 'execute', 'big.json', bigPayload, { pipeBase });

      const filePath = path.join(pipeBase, 'run-cap', 'execute', 'outbox', 'big.json');
      assert.ok(existsSync(filePath), 'file must still be written (truncated)');

      const raw = await readFile(filePath, 'utf-8');
      assert.ok(raw.length <= 102400 + 256, 'written file must not exceed ~100KB + header overhead');

      // Result must signal truncation
      assert.ok(result && result.truncated, 'result must include truncated:true when cap exceeded');
    });

    // ── 10MB per-run cap ────────────────────────────────────────────────

    it('drops writes beyond 10MB per-run cap with logged warning', async () => {
      const pipeBase = path.join(tmpDir, '.ao', 'artifacts', 'pipe');
      const runId = 'run-10mb';

      // Write 9 files of 1.5MB each = 13.5MB total → last few should be dropped
      const mediumPayload = { data: 'y'.repeat(1.5 * 1024 * 1024) };
      const results = [];
      for (let i = 0; i < 9; i++) {
        const r = await mod.writeOutbox(runId, 'execute', `chunk-${i}.json`, mediumPayload, { pipeBase });
        results.push(r);
      }

      // Some writes must have been dropped
      const dropped = results.filter((r) => r && r.dropped);
      assert.ok(dropped.length > 0, 'some writes must be dropped when per-run cap is exceeded');
    });
  });

  // ── readInbox ───────────────────────────────────────────────────────────

  describe('readInbox()', () => {
    let tmpDir;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    after(() => { try { rmSync(tmpDir, { recursive: true }); } catch {} });

    it('returns [] for non-existent inbox dir', async () => {
      const pipeBase = path.join(tmpDir, '.ao', 'artifacts', 'pipe');
      const result = await mod.readInbox('run-empty', 'execute', { pipeBase });
      assert.deepStrictEqual(result, [], 'missing inbox returns empty array');
    });

    it('returns files written to the outbox of the PRIOR stage as inbox of current stage', async () => {
      // Convention: the orchestrator explicitly copies outbox → next stage inbox
      // readInbox reads from .ao/artifacts/pipe/<runId>/<stage>/inbox/
      const pipeBase = path.join(tmpDir, '.ao', 'artifacts', 'pipe');

      // Manually write to the inbox dir (simulating orchestrator-managed handoff)
      const inboxDir = path.join(pipeBase, 'run-inbox', 'execute', 'inbox');
      mkdirSync(inboxDir, { recursive: true });
      writeFileSync(
        path.join(inboxDir, 'decompose-summary.json'),
        JSON.stringify({ schemaVersion: 1, stories: 5, status: 'done' }),
      );

      const result = await mod.readInbox('run-inbox', 'execute', { pipeBase });
      assert.ok(Array.isArray(result), 'must return array');
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].stories, 5);
    });

    it('returns multiple inbox files if multiple exist', async () => {
      const pipeBase = path.join(tmpDir, '.ao', 'artifacts', 'pipe');
      const inboxDir = path.join(pipeBase, 'run-multi-inbox', 'verify', 'inbox');
      mkdirSync(inboxDir, { recursive: true });
      writeFileSync(path.join(inboxDir, 'a.json'), JSON.stringify({ schemaVersion: 1, x: 1 }));
      writeFileSync(path.join(inboxDir, 'b.json'), JSON.stringify({ schemaVersion: 1, x: 2 }));
      writeFileSync(path.join(inboxDir, 'c.json'), JSON.stringify({ schemaVersion: 1, x: 3 }));

      const result = await mod.readInbox('run-multi-inbox', 'verify', { pipeBase });
      assert.strictEqual(result.length, 3);
    });

    it('skips corrupt JSON files gracefully (fail-safe)', async () => {
      const pipeBase = path.join(tmpDir, '.ao', 'artifacts', 'pipe');
      const inboxDir = path.join(pipeBase, 'run-corrupt', 'finish', 'inbox');
      mkdirSync(inboxDir, { recursive: true });
      writeFileSync(path.join(inboxDir, 'good.json'), JSON.stringify({ schemaVersion: 1, ok: true }));
      writeFileSync(path.join(inboxDir, 'bad.json'), 'NOT_JSON{{{{');

      const result = await mod.readInbox('run-corrupt', 'finish', { pipeBase });
      // Should return the one good file, skip the bad one
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].ok, true);
    });
  });

  // ── No subagent spawning ─────────────────────────────────────────────────

  describe('in-process async only (no subagent spawns)', () => {
    it('writeOutbox is async and does not import worker-spawn or task-spawn', async () => {
      // Check the module source doesn't import worker-spawn
      const src = await readFile(
        new URL('../lib/artifact-pipe.mjs', import.meta.url),
        'utf-8',
      );
      assert.ok(!src.includes('worker-spawn'), 'must not import worker-spawn');
      assert.ok(!src.includes('Task('), 'must not spawn Task subagents');
      // Check that child_process is not imported (it may appear in comments as a design note)
      assert.ok(!src.includes("from 'node:child_process'") && !src.includes('require(\'child_process\')'),
        'must not import child_process');
    });
  });

  // ── Archival-only disclaimer (AC: spec.md inspection) ───────────────────

  describe('archival-only disclaimer', () => {
    it('module exports an ARCHIVAL_ONLY flag or documentation note', async () => {
      // The module must make its archival-only nature clear.
      // Either via a named export or a comment in the source.
      const src = await readFile(
        new URL('../lib/artifact-pipe.mjs', import.meta.url),
        'utf-8',
      );
      // Should document that this is ARCHIVAL ONLY (not prompt-history isolation)
      const hasDisclaimer = src.includes('ARCHIVAL') || src.includes('archival');
      assert.ok(hasDisclaimer, 'module must document its archival-only nature');
    });
  });

  // ── Path safety ─────────────────────────────────────────────────────────

  describe('path safety', () => {
    let tmpDir;

    before(() => { tmpDir = makeTmpDir(); });
    after(() => { try { rmSync(tmpDir, { recursive: true }); } catch {} });

    it('writeOutbox rejects path traversal in name parameter', async () => {
      const pipeBase = path.join(tmpDir, '.ao', 'artifacts', 'pipe');
      await assert.rejects(
        () => mod.writeOutbox('run-trav', 'execute', '../../../etc/passwd', { bad: true }, { pipeBase }),
        /invalid|traversal|illegal/i,
      );
    });

    it('writeOutbox rejects absolute paths in name parameter', async () => {
      const pipeBase = path.join(tmpDir, '.ao', 'artifacts', 'pipe');
      await assert.rejects(
        () => mod.writeOutbox('run-abs', 'execute', '/etc/shadow', { bad: true }, { pipeBase }),
        /invalid|traversal|illegal/i,
      );
    });

    it('writeOutbox rejects runId with path traversal', async () => {
      const pipeBase = path.join(tmpDir, '.ao', 'artifacts', 'pipe');
      await assert.rejects(
        () => mod.writeOutbox('../evil-run', 'execute', 'data.json', { bad: true }, { pipeBase }),
        /invalid|traversal|illegal/i,
      );
    });
  });

  // ── AC-specific: complete stage names ───────────────────────────────────

  describe('AC: 6 canonical stage names exactly', () => {
    it('plan is canonical', () => assert.ok(mod.CANONICAL_STAGES.includes('plan')));
    it('decompose is canonical', () => assert.ok(mod.CANONICAL_STAGES.includes('decompose')));
    it('execute is canonical', () => assert.ok(mod.CANONICAL_STAGES.includes('execute')));
    it('verify is canonical', () => assert.ok(mod.CANONICAL_STAGES.includes('verify')));
    it('review is canonical', () => assert.ok(mod.CANONICAL_STAGES.includes('review')));
    it('finish is canonical', () => assert.ok(mod.CANONICAL_STAGES.includes('finish')));
    it('exactly 6 canonical stages', () => assert.strictEqual(mod.CANONICAL_STAGES.length, 6));
  });

  // ── SessionEnd / 24h preservation ───────────────────────────────────────
  // artifact-pipe lives OUTSIDE .ao/memory/ so SessionEnd CAN sweep it.
  // This is tested indirectly by confirming the path convention.

  describe('path convention (outside .ao/memory/)', () => {
    it('pipe base path is .ao/artifacts/pipe, not .ao/memory/', async () => {
      const src = await readFile(
        new URL('../lib/artifact-pipe.mjs', import.meta.url),
        'utf-8',
      );
      assert.ok(src.includes('artifacts/pipe') || src.includes("'pipe'"), 'pipe base must be under artifacts/pipe');
      // The memory path should not appear as an import/require (may appear in design comments)
      const hasMemoryImport = src.includes("from './memory.mjs'") || src.includes("require('./memory.mjs')");
      assert.ok(!hasMemoryImport, 'pipe must NOT import memory.mjs (not under .ao/memory/ namespace)');
    });
  });
});
