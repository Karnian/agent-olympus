import assert from 'node:assert/strict';
import {
  appendFileSync,
  chmodSync,
  linkSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  addVerification,
  beginVerificationGeneration,
  createRun,
  getSealedVerificationGeneration,
  getVerificationGenerationProgress,
  sealVerificationGeneration,
} from '../lib/run-artifacts.mjs';

const REVIEW_TREE = 'a'.repeat(40);
const OTHER_TREE = 'b'.repeat(40);

async function withRun(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-verification-generation-'));
  const base = path.join(root, 'runs');
  try {
    const created = createRun('atlas', 'generation test', {
      base,
      trustedRoot: root,
      activate: false,
    });
    assert.equal(created.ok, true, created.reason);
    await fn({ root, base, ...created });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function generationRecord(generation, storyId, overrides = {}) {
  return {
    story_id: storyId,
    verdict: 'pass',
    evidence: `fresh evidence for ${storyId}`,
    verifiedBy: 'themis',
    reviewTreeOid: generation.reviewTreeOid,
    verificationGenerationId: generation.generationId,
    ...overrides,
  };
}

test('verification generation crash-resumes, seals exact fresh coverage, and reloads strictly', async () => {
  await withRun(async ({ base, runId }) => {
    const started = beginVerificationGeneration(runId, {
      reviewTreeOid: REVIEW_TREE,
      storyIds: ['US-002', 'US-001'],
      phase: 'final-review',
    }, { base });
    assert.equal(started.ok, true, started.reason);
    assert.deepEqual(started.generation.storyIds, ['US-001', 'US-002']);

    const resumed = beginVerificationGeneration(runId, {
      reviewTreeOid: REVIEW_TREE,
      storyIds: ['US-001', 'US-002'],
      phase: 'final-review',
    }, { base });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.generation.generationId, started.generation.generationId);
    const conflictingOpen = beginVerificationGeneration(runId, {
      reviewTreeOid: REVIEW_TREE,
      storyIds: ['US-001', 'US-002'],
      phase: 'verify',
    }, { base });
    assert.equal(conflictingOpen.ok, false);

    assert.deepEqual(
      addVerification(runId, generationRecord(started.generation, 'US-002'), { base }),
      { ok: true },
    );
    assert.deepEqual(
      addVerification(runId, generationRecord(started.generation, 'US-002'), { base }),
      { ok: true, reused: true },
    );
    const progress = getVerificationGenerationProgress(
      runId,
      started.generation.generationId,
      { base },
    );
    assert.equal(progress.ok, true, progress.reason);
    assert.deepEqual(progress.records.map(record => record.story_id), ['US-002']);
    assert.deepEqual(progress.missingStoryIds, ['US-001']);
    assert.deepEqual(
      addVerification(runId, generationRecord(started.generation, 'US-001'), { base }),
      { ok: true },
    );
    const sealed = sealVerificationGeneration(
      runId,
      started.generation.generationId,
      { base },
    );
    assert.equal(sealed.ok, true, sealed.reason);
    assert.deepEqual(sealed.records.map(record => record.story_id), ['US-001', 'US-002']);
    assert.match(sealed.generation.recordsDigest, /^[0-9a-f]{64}$/);

    const sealedAgain = sealVerificationGeneration(
      runId,
      started.generation.generationId,
      { base },
    );
    assert.equal(sealedAgain.ok, true);
    assert.equal(sealedAgain.resumed, true);

    const strict = getSealedVerificationGeneration(
      runId,
      started.generation.generationId,
      { base },
    );
    assert.equal(strict.ok, true, strict.reason);
    assert.deepEqual(strict.records, sealed.records);
    assert.equal(Object.isFrozen(strict.records), true);

    const late = addVerification(
      runId,
      generationRecord(started.generation, 'US-001'),
      { base },
    );
    assert.equal(late.ok, false);
  });
});

test('generation-aware append rejects wrong tree, story, pre-start time, and stale generation', async () => {
  await withRun(async ({ base, runId }) => {
    const started = beginVerificationGeneration(runId, {
      reviewTreeOid: REVIEW_TREE,
      storyIds: ['US-001'],
      phase: 'verify',
    }, { base });
    assert.equal(started.ok, true, started.reason);

    assert.equal(addVerification(runId, generationRecord(started.generation, 'US-001', {
      reviewTreeOid: OTHER_TREE,
    }), { base }).ok, false);
    assert.equal(addVerification(runId, generationRecord(started.generation, 'US-999'), {
      base,
    }).ok, false);
    assert.equal(addVerification(runId, generationRecord(started.generation, 'US-001', {
      timestamp: new Date(Date.parse(started.generation.startedAt) - 1).toISOString(),
    }), { base }).ok, false);

    assert.equal(addVerification(
      runId,
      generationRecord(started.generation, 'US-001'),
      { base },
    ).ok, true);
    assert.equal(addVerification(runId, generationRecord(started.generation, 'US-001', {
      evidence: 'different retry evidence',
    }), { base }).ok, false);
    assert.equal(sealVerificationGeneration(
      runId,
      started.generation.generationId,
      { base },
    ).ok, true);

    const next = beginVerificationGeneration(runId, {
      reviewTreeOid: REVIEW_TREE,
      storyIds: ['US-001'],
      phase: 'final-review',
    }, { base });
    assert.equal(next.ok, true, next.reason);
    assert.notEqual(next.generation.generationId, started.generation.generationId);
    assert.equal(addVerification(
      runId,
      generationRecord(started.generation, 'US-001'),
      { base },
    ).ok, false);
  });
});

test('an open generation can be superseded only by exact ID after the review tree changes', async () => {
  await withRun(async ({ base, runId }) => {
    const started = beginVerificationGeneration(runId, {
      reviewTreeOid: REVIEW_TREE,
      storyIds: ['US-001'],
      phase: 'final-review',
    }, { base });
    assert.equal(started.ok, true, started.reason);

    const blocked = beginVerificationGeneration(runId, {
      reviewTreeOid: OTHER_TREE,
      storyIds: ['US-001'],
      phase: 'final-review',
    }, { base });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.currentGenerationId, started.generation.generationId);

    const wrongCas = beginVerificationGeneration(runId, {
      reviewTreeOid: OTHER_TREE,
      storyIds: ['US-001'],
      phase: 'final-review',
    }, { base, supersedeGenerationId: '00000000-0000-4000-8000-000000000000' });
    assert.equal(wrongCas.ok, false);

    const superseded = beginVerificationGeneration(runId, {
      reviewTreeOid: OTHER_TREE,
      storyIds: ['US-001'],
      phase: 'final-review',
    }, { base, supersedeGenerationId: started.generation.generationId });
    assert.equal(superseded.ok, true, superseded.reason);
    assert.equal(superseded.supersededGenerationId, started.generation.generationId);
    assert.notEqual(superseded.generation.generationId, started.generation.generationId);
    assert.equal(superseded.generation.reviewTreeOid, OTHER_TREE);
  });
});

test('sealing fails closed for missing or duplicate records', async () => {
  await withRun(async ({ base, runId, runDir }) => {
    const started = beginVerificationGeneration(runId, {
      reviewTreeOid: REVIEW_TREE,
      storyIds: ['US-001', 'US-002'],
      phase: 'integrate',
    }, { base });
    assert.equal(started.ok, true, started.reason);
    assert.equal(addVerification(
      runId,
      generationRecord(started.generation, 'US-001'),
      { base },
    ).ok, true);
    const missing = sealVerificationGeneration(runId, started.generation.generationId, { base });
    assert.equal(missing.ok, false);

    assert.equal(addVerification(
      runId,
      generationRecord(started.generation, 'US-002'),
      { base },
    ).ok, true);
    const ledgerPath = path.join(runDir, 'verification.jsonl');
    const firstRecord = readFileSync(ledgerPath, 'utf8').split('\n').find(Boolean);
    appendFileSync(ledgerPath, `${firstRecord}\n`);
    const duplicate = sealVerificationGeneration(runId, started.generation.generationId, { base });
    assert.equal(duplicate.ok, false);
  });
});

for (const attack of ['symlink', 'hardlink', 'mode', 'oversize']) {
  test(`verification generation rejects an unsafe ${attack} manifest`, async (t) => {
    if (attack === 'mode' && process.platform === 'win32') {
      t.skip('POSIX mode assertion');
      return;
    }
    await withRun(async ({ root, base, runId, runDir }) => {
      const manifestPath = path.join(runDir, 'verification-generation.json');
      const outside = path.join(root, 'outside');
      writeFileSync(outside, attack === 'oversize' ? 'x'.repeat(300 * 1024) : '{}', {
        mode: attack === 'mode' ? 0o644 : 0o600,
      });
      if (attack === 'symlink') symlinkSync(outside, manifestPath);
      else if (attack === 'hardlink') linkSync(outside, manifestPath);
      else {
        linkSync(outside, manifestPath);
        unlinkSync(outside);
        if (attack === 'mode') chmodSync(manifestPath, 0o644);
      }

      const result = beginVerificationGeneration(runId, {
        reviewTreeOid: REVIEW_TREE,
        storyIds: ['US-001'],
        phase: 'verify',
      }, { base });
      assert.equal(result.ok, false);
    });
  });
}

test('strict sealed-generation read rejects a manifest replacement race', async () => {
  await withRun(async ({ base, runId }) => {
    const started = beginVerificationGeneration(runId, {
      reviewTreeOid: REVIEW_TREE,
      storyIds: ['US-001'],
      phase: 'final-review',
    }, { base });
    assert.equal(started.ok, true, started.reason);
    assert.equal(addVerification(
      runId,
      generationRecord(started.generation, 'US-001'),
      { base },
    ).ok, true);
    const sealed = sealVerificationGeneration(runId, started.generation.generationId, { base });
    assert.equal(sealed.ok, true, sealed.reason);

    const strict = getSealedVerificationGeneration(
      runId,
      started.generation.generationId,
      {
        base,
        _afterVerificationGenerationRead(filePath) {
          writeFileSync(filePath, JSON.stringify({
            ...sealed.generation,
            phase: 'tampered',
          }, null, 2), { mode: 0o600 });
        },
      },
    );
    assert.equal(strict.ok, false);
    assert.deepEqual(strict.records, []);
  });
});
