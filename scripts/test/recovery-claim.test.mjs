import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { acquireRecoveryClaim } from '../lib/recovery-claim.mjs';
import {
  acquireRunFinalizationLock,
  holdsRunFinalizationLock,
  isValidRunFinalizationLockOwner,
  releaseRunFinalizationLock,
} from '../lib/run-finalization-lock.mjs';
import { readProcStartId } from '../lib/proc-identity.mjs';

const CLAIM_MODULE_URL = new URL('../lib/recovery-claim.mjs', import.meta.url).href;

function rootClaimPath(dir, namespace, generation) {
  const digest = createHash('sha256').update(String(generation)).digest('hex');
  return path.join(dir, `.${namespace}-recovery-${digest}.claim`);
}

function successorClaimPath(dir, namespace, generation, predecessorToken) {
  const generationDigest = createHash('sha256').update(String(generation)).digest('hex');
  const predecessorDigest = createHash('sha256').update(predecessorToken).digest('hex');
  return path.join(
    dir,
    `.${namespace}-recovery-${generationDigest}-successor-${predecessorDigest}.claim`,
  );
}

function writeClaim(dir, namespace, generation, overrides = {}) {
  const digest = createHash('sha256').update(String(generation)).digest('hex');
  const claimPath = rootClaimPath(dir, namespace, generation);
  writeFileSync(claimPath, `${JSON.stringify({
    schemaVersion: 1,
    token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    pid: 999_999_999,
    startId: null,
    generationDigest: digest,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  })}\n`, { mode: 0o600 });
  return claimPath;
}

async function waitForFiles(paths, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (paths.every(existsSync)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${paths.join(', ')}`);
}

function collectChild(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => {
      if (code !== 0) reject(new Error(`claim contender exited ${code}: ${stderr}`));
      else resolve(JSON.parse(stdout));
    });
  });
}

test('one stale generation elects exactly one live recovery claimant', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ao-recovery-claim-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = acquireRecoveryClaim(dir, 'queue', 'old-token');
  const second = acquireRecoveryClaim(dir, 'queue', 'old-token');
  const nextGeneration = acquireRecoveryClaim(dir, 'queue', 'new-token');
  assert.equal(first.won, true);
  assert.equal(second.won, false);
  assert.equal(second.path, first.path);
  assert.equal(nextGeneration.won, true);
  assert.equal(readdirSync(dir).filter(name => name.endsWith('.claim')).length, 2);
  if (process.platform !== 'win32') assert.equal(lstatSync(first.path).mode & 0o777, 0o600);
});

test('a dead recovery claimant is succeeded for the same live lock generation', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ao-recovery-dead-claimant-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeClaim(dir, 'queue', 'same-generation');

  const recovered = acquireRecoveryClaim(dir, 'queue', 'same-generation', {
    staleMs: 0,
    isGenerationCurrent: () => true,
  });

  assert.equal(recovered.won, true);
  assert.match(path.basename(recovered.path), /-successor-[a-f0-9]{64}\.claim$/);
  assert.equal(readdirSync(dir).filter(name => name.endsWith('.claim')).length, 2);
});

test('a dead successor claimant can itself be succeeded', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ao-recovery-dead-successor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const generation = 'same-generation';
  const rootToken = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  writeClaim(dir, 'queue', generation, { token: rootToken });
  const generationDigest = createHash('sha256').update(generation).digest('hex');
  writeFileSync(successorClaimPath(dir, 'queue', generation, rootToken), `${JSON.stringify({
    schemaVersion: 1,
    token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    pid: 999_999_999,
    startId: null,
    generationDigest,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  })}\n`, { mode: 0o600 });

  const recovered = acquireRecoveryClaim(dir, 'queue', generation, {
    staleMs: 0,
    isGenerationCurrent: () => true,
  });

  assert.equal(recovered.won, true);
  assert.notEqual(recovered.path, successorClaimPath(dir, 'queue', generation, rootToken));
  assert.equal(readdirSync(dir).filter(name => name.endsWith('.claim')).length, 3);
});

test('a live recovery claimant is never stolen even after the grace period', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ao-recovery-live-claimant-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const claimPath = writeClaim(dir, 'queue', 'same-generation', {
    pid: process.pid,
    startId: readProcStartId(process.pid),
  });

  const contender = acquireRecoveryClaim(dir, 'queue', 'same-generation', {
    staleMs: 0,
    isGenerationCurrent: () => true,
  });

  assert.equal(contender.won, false);
  assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.claim')), [
    path.basename(claimPath),
  ]);
});

test('a reused live PID with a different start identity does not retain the claim', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ao-recovery-reused-pid-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeClaim(dir, 'queue', 'same-generation', {
    pid: 4242,
    startId: 'old-process-start',
  });

  const contender = acquireRecoveryClaim(dir, 'queue', 'same-generation', {
    staleMs: 0,
    processKill: () => {},
    readProcStartId: () => 'new-process-start',
    isGenerationCurrent: () => true,
  });

  assert.equal(contender.won, true);
  assert.match(path.basename(contender.path), /-successor-[a-f0-9]{64}\.claim$/);
});

test('a claim publication cannot win after the guarded lock generation changes', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ao-recovery-generation-fence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeClaim(dir, 'queue', 'same-generation');
  let checks = 0;

  const contender = acquireRecoveryClaim(dir, 'queue', 'same-generation', {
    staleMs: 0,
    isGenerationCurrent: () => {
      checks += 1;
      return checks < 3;
    },
  });

  assert.equal(contender.won, false);
  assert.equal(checks, 3, 'the guarded generation must be checked before and after publication');
  assert.equal(
    readdirSync(dir).filter(name => name.endsWith('.claim')).length,
    2,
    'a post-publication generation change leaves a harmless claim tied to the old generation',
  );
});

test('concurrent dead-claimant recovery elects one process for the live lock generation', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ao-recovery-concurrent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const targetPath = path.join(dir, 'target-generation');
  const goPath = path.join(dir, 'go');
  writeFileSync(targetPath, 'same-generation', { mode: 0o600 });
  writeClaim(dir, 'queue', 'same-generation');
  const script = `
    import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { acquireRecoveryClaim } from ${JSON.stringify(CLAIM_MODULE_URL)};
    const [dir, targetPath, goPath, id] = process.argv.slice(1);
    writeFileSync(join(dir, 'ready-' + id), id);
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(goPath)) Atomics.wait(wait, 0, 0, 5);
    const result = acquireRecoveryClaim(dir, 'queue', 'same-generation', {
      staleMs: 0,
      isGenerationCurrent: () => existsSync(targetPath),
    });
    if (result.won) unlinkSync(targetPath);
    process.stdout.write(JSON.stringify({ won: result.won }));
  `;
  const children = ['a', 'b'].map(id => spawn(process.execPath, [
    '--input-type=module', '-e', script, dir, targetPath, goPath, id,
  ], { stdio: ['ignore', 'pipe', 'pipe'] }));
  const resultsPromise = Promise.all(children.map(collectChild));
  await waitForFiles(['a', 'b'].map(id => path.join(dir, `ready-${id}`)));
  writeFileSync(goPath, 'go', { mode: 0o600 });
  const results = await resultsPromise;

  assert.equal(results.filter(result => result.won).length, 1);
  assert.equal(existsSync(targetPath), false);
});

test('PID 1 is a valid non-signalling lock owner', () => {
  assert.equal(isValidRunFinalizationLockOwner({
    schemaVersion: 1,
    token: '12345678-1234-4123-8123-123456789abc',
    pid: 1,
    startId: null,
    createdAt: new Date().toISOString(),
  }), true);
});

test('an observer of an old generation cannot remove its replacement owner', (t) => {
  const runDir = mkdtempSync(path.join(tmpdir(), 'ao-finalize-generation-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  const lockDir = path.join(runDir, '.terminal-failure.lock');
  mkdirSync(lockDir, { mode: 0o700 });
  const oldToken = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
    schemaVersion: 1,
    token: oldToken,
    pid: 999_999_999,
    startId: null,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  }), { mode: 0o600 });

  const replacement = acquireRunFinalizationLock(runDir);
  assert.equal(holdsRunFinalizationLock(runDir, replacement), true);
  assert.equal(acquireRecoveryClaim(runDir, 'run-finalize', oldToken).won, false);
  assert.throws(() => acquireRunFinalizationLock(runDir), /already in progress/);
  assert.equal(holdsRunFinalizationLock(runDir, replacement), true);
  assert.equal(releaseRunFinalizationLock(runDir, replacement), true);
});

test('run finalization re-elects after the first stale-lock recoverer dies', (t) => {
  const runDir = mkdtempSync(path.join(tmpdir(), 'ao-finalize-dead-recoverer-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  const lockDir = path.join(runDir, '.terminal-failure.lock');
  mkdirSync(lockDir, { mode: 0o700 });
  const oldToken = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
    schemaVersion: 1,
    token: oldToken,
    pid: 999_999_999,
    startId: null,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  }), { mode: 0o600 });
  writeClaim(runDir, 'run-finalize', oldToken);

  const replacement = acquireRunFinalizationLock(runDir);

  assert.equal(holdsRunFinalizationLock(runDir, replacement), true);
  assert.equal(releaseRunFinalizationLock(runDir, replacement), true);
});
