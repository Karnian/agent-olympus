import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  linkSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRun,
  getRunReviewBasePin,
  pinRunReviewBase,
} from '../lib/run-artifacts.mjs';

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);

async function withRun(fn) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ao-review-pin-'));
  try {
    const created = createRun('atlas', 'pin review base', {
      base,
      activate: false,
    });
    assert.equal(created.ok, true);
    await fn({ base, ...created });
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
}

function requested(commit = COMMIT_A) {
  return {
    baseRef: 'origin/main',
    baseRefCommit: commit,
    source: 'explicit',
  };
}

test('review base pin: first write is durable and exact replay is idempotent', async () => {
  await withRun(async ({ base, runId, runDir }) => {
    const first = pinRunReviewBase(runId, requested(), { base });
    assert.equal(first.ok, true);
    assert.equal(first.created, true);
    assert.equal(first.pin.baseRefCommit, COMMIT_A);
    assert.match(first.pin.pinDigest, /^[0-9a-f]{64}$/);

    const disk = JSON.parse(readFileSync(path.join(runDir, 'review-base.json'), 'utf8'));
    assert.deepEqual(disk, first.pin);

    const replay = pinRunReviewBase(runId, requested(), { base });
    assert.equal(replay.ok, true);
    assert.equal(replay.created, false);
    assert.deepEqual(replay.pin, first.pin);

    assert.deepEqual(getRunReviewBasePin(runId, { base }), {
      ok: true,
      pin: first.pin,
    });
  });
});

test('review base pin: a resumed run cannot move the ref resolution', async () => {
  await withRun(async ({ base, runId }) => {
    assert.equal(pinRunReviewBase(runId, requested(), { base }).ok, true);
    assert.deepEqual(pinRunReviewBase(runId, requested(COMMIT_B), { base }), {
      ok: false,
      reason: 'review-base-pin-mismatch',
    });
    assert.equal(getRunReviewBasePin(runId, { base }).pin.baseRefCommit, COMMIT_A);
  });
});

test('review base pin: missing and malformed identities fail closed', async () => {
  await withRun(async ({ base, runId }) => {
    assert.deepEqual(getRunReviewBasePin(runId, { base }), {
      ok: false,
      reason: 'review-base-pin-missing',
    });
    assert.equal(pinRunReviewBase(runId, {
      baseRef: '../main',
      baseRefCommit: COMMIT_A,
      source: 'explicit',
    }, { base }).ok, false);
    assert.equal(pinRunReviewBase(runId, {
      baseRef: 'origin/main',
      baseRefCommit: COMMIT_A.toUpperCase(),
      source: 'explicit',
    }, { base }).ok, false);
  });
});

test('review base pin: symlink and hardlink leaves are rejected', async () => {
  for (const kind of ['symlink', 'hardlink']) {
    await withRun(async ({ base, runId, runDir }) => {
      const outside = path.join(base, `${kind}-outside.json`);
      writeFileSync(outside, '{}', { mode: 0o600 });
      const leaf = path.join(runDir, 'review-base.json');
      if (kind === 'symlink') symlinkSync(outside, leaf);
      else linkSync(outside, leaf);

      const result = pinRunReviewBase(runId, requested(), { base });
      assert.equal(result.ok, false, `${kind} must fail closed`);
      assert.equal(getRunReviewBasePin(runId, { base }).ok, false);
    });
  }
});

test('review base pin: post-write permission drift is rejected', async () => {
  if (process.platform === 'win32') return;
  await withRun(async ({ base, runId, runDir }) => {
    assert.equal(pinRunReviewBase(runId, requested(), { base }).ok, true);
    chmodSync(path.join(runDir, 'review-base.json'), 0o644);
    const result = getRunReviewBasePin(runId, { base });
    assert.equal(result.ok, false);
    assert.match(result.reason, /unsafe|permissions/);
  });
});

test('review base pin: exact supported CI source identities are accepted', async () => {
  const sources = [
    'env:GITHUB_BASE_REF',
    'env:CI_MERGE_REQUEST_TARGET_BRANCH_NAME',
    'env:CHANGE_TARGET',
    'env:SYSTEM_PULLREQUEST_TARGETBRANCH',
  ];
  for (const source of sources) {
    await withRun(async ({ base, runId }) => {
      const result = pinRunReviewBase(runId, { ...requested(), source }, { base });
      assert.equal(result.ok, true, source);
      assert.equal(result.pin.source, source);
    });
  }

  await withRun(async ({ base, runId }) => {
    assert.equal(pinRunReviewBase(runId, {
      ...requested(),
      source: 'env:UNTRUSTED_BASE_REF',
    }, { base }).ok, false);
  });
});
