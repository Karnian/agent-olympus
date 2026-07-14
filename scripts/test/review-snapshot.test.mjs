import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildReviewPackage } from '../lib/review-package.mjs';
import {
  assertReviewSnapshotCurrent,
  cleanupReviewSnapshot,
  materializeReviewSnapshot,
} from '../lib/review-snapshot.mjs';

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ao-review-snapshot-test-'));
  const repo = path.join(root, 'repo');
  const snapshots = path.join(root, 'snapshots');
  mkdirSync(repo, { mode: 0o700 });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'AO Test']);
  git(repo, ['config', 'user.email', 'ao@example.test']);
  writeFileSync(path.join(repo, '.gitignore'), '.env\n');
  writeFileSync(path.join(repo, 'tracked.txt'), 'base\n');
  git(repo, ['add', '.gitignore', 'tracked.txt']);
  git(repo, ['commit', '-q', '-m', 'base']);
  return { root, repo, snapshots };
}

function waitForChildMarker(child, marker, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${marker}`)), timeoutMs);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.includes(marker)) {
        clearTimeout(timer);
        resolve(output);
      }
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', code => {
      if (!output.includes(marker)) {
        clearTimeout(timer);
        reject(new Error(`child exited ${code} before ${marker}: ${output}`));
      }
    });
  });
}

function waitForExit(child) {
  return new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
}

test('review snapshot materializes exact reviewed bytes and excludes ignored live secrets', async () => {
  const { root, repo, snapshots } = await fixture();
  try {
    writeFileSync(path.join(repo, 'tracked.txt'), 'reviewed change\n');
    writeFileSync(path.join(repo, 'new.txt'), 'reviewed untracked\n');
    writeFileSync(path.join(repo, '.env'), 'LIVE_SECRET=do-not-copy\n');
    const review = buildReviewPackage({ cwd: repo, baseRef: 'main' });
    const snapshot = materializeReviewSnapshot({
      cwd: repo,
      reviewTreeOid: review.reviewTreeOid,
      ownerId: 'atlas-xval-run-story',
      baseDir: snapshots,
      trustedRoot: root,
    });

    assert.notEqual(snapshot.path, repo);
    assert.equal(readFileSync(path.join(snapshot.path, 'tracked.txt'), 'utf8'), 'reviewed change\n');
    assert.equal(readFileSync(path.join(snapshot.path, 'new.txt'), 'utf8'), 'reviewed untracked\n');
    assert.equal(existsSync(path.join(snapshot.path, '.env')), false);
    assert.equal(assertReviewSnapshotCurrent(snapshot, {
      cwd: repo,
      baseDir: snapshots,
      trustedRoot: root,
    }), true);

    // The validator snapshot is stable even while the live repository moves.
    writeFileSync(path.join(repo, 'tracked.txt'), 'later live mutation\n');
    writeFileSync(path.join(repo, '.env'), 'LIVE_SECRET=changed-again\n');
    assert.equal(readFileSync(path.join(snapshot.path, 'tracked.txt'), 'utf8'), 'reviewed change\n');
    assert.equal(assertReviewSnapshotCurrent(snapshot, {
      cwd: repo,
      baseDir: snapshots,
      trustedRoot: root,
    }), true);

    // Deterministic ownership resumes the same exact snapshot.
    assert.deepEqual(materializeReviewSnapshot({
      cwd: repo,
      reviewTreeOid: review.reviewTreeOid,
      ownerId: 'atlas-xval-run-story',
      baseDir: snapshots,
      trustedRoot: root,
    }), snapshot);

    assert.throws(
      () => cleanupReviewSnapshot(snapshot, {
        cwd: repo,
        ownerId: 'different-owner',
        baseDir: snapshots,
        trustedRoot: root,
      }),
      /owner mismatch/,
    );
    assert.equal(cleanupReviewSnapshot(snapshot, {
      cwd: repo,
      ownerId: snapshot.ownerId,
      baseDir: snapshots,
      trustedRoot: root,
    }), true);
    assert.equal(existsSync(snapshot.path), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('review snapshot rejects byte drift before a validator result can be accepted', async () => {
  const { root, repo, snapshots } = await fixture();
  try {
    writeFileSync(path.join(repo, 'tracked.txt'), 'reviewed change\n');
    const review = buildReviewPackage({ cwd: repo, baseRef: 'main' });
    const snapshot = materializeReviewSnapshot({
      cwd: repo,
      reviewTreeOid: review.reviewTreeOid,
      ownerId: 'athena-xval-run-story',
      baseDir: snapshots,
      trustedRoot: root,
    });
    writeFileSync(path.join(snapshot.path, 'tracked.txt'), 'tampered snapshot\n');
    assert.throws(
      () => assertReviewSnapshotCurrent(snapshot, {
        cwd: repo,
        baseDir: snapshots,
        trustedRoot: root,
      }),
      /bytes no longer match/,
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('review snapshot rejects tracked symlinks instead of exposing outside paths', async () => {
  if (process.platform === 'win32') return;
  const { root, repo, snapshots } = await fixture();
  try {
    symlinkSync('/etc/passwd', path.join(repo, 'escape-link'));
    git(repo, ['add', 'escape-link']);
    git(repo, ['commit', '-q', '-m', 'tracked symlink']);
    const tree = git(repo, ['rev-parse', 'HEAD^{tree}']);
    assert.throws(
      () => materializeReviewSnapshot({
        cwd: repo,
        reviewTreeOid: tree,
        ownerId: 'atlas-xval-symlink',
        baseDir: snapshots,
        trustedRoot: root,
      }),
      /symlink or submodule/,
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('review snapshot O_EXCL owner prevents a contender from deleting the winner manifest', async () => {
  const { root, repo, snapshots } = await fixture();
  try {
    writeFileSync(path.join(repo, 'tracked.txt'), 'reviewed change\n');
    const review = buildReviewPackage({ cwd: repo, baseRef: 'main' });
    const moduleUrl = new URL('../lib/review-snapshot.mjs', import.meta.url).href;
    let contender;
    const snapshot = materializeReviewSnapshot({
      cwd: repo,
      reviewTreeOid: review.reviewTreeOid,
      ownerId: 'atlas-xval-concurrent',
      baseDir: snapshots,
      trustedRoot: root,
      _inject: {
        afterLock() {
          contender = spawnSync(process.execPath, ['--input-type=module', '-e', `
            import { materializeReviewSnapshot } from ${JSON.stringify(moduleUrl)};
            try {
              materializeReviewSnapshot(${JSON.stringify({
                cwd: repo,
                reviewTreeOid: review.reviewTreeOid,
                ownerId: 'atlas-xval-concurrent',
                baseDir: snapshots,
                trustedRoot: root,
              })});
              process.stdout.write('UNEXPECTED_SUCCESS');
            } catch (error) {
              process.stdout.write(String(error.message));
            }
          `], { encoding: 'utf8' });
        },
      },
    });
    assert.equal(contender.status, 0);
    assert.match(contender.stdout, /already in progress/);
    assert.equal(existsSync(`${snapshot.path}.json`), true);
    assert.equal(assertReviewSnapshotCurrent(snapshot, {
      cwd: repo,
      baseDir: snapshots,
      trustedRoot: root,
    }), true);
    assert.deepEqual(materializeReviewSnapshot({
      cwd: repo,
      reviewTreeOid: review.reviewTreeOid,
      ownerId: 'atlas-xval-concurrent',
      baseDir: snapshots,
      trustedRoot: root,
    }), snapshot);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('review snapshot accepts PID 1 as a valid live lock owner', async () => {
  const { root, repo, snapshots } = await fixture();
  try {
    writeFileSync(path.join(repo, 'tracked.txt'), 'reviewed change\n');
    const review = buildReviewPackage({ cwd: repo, baseRef: 'main' });
    let contenderError = '';
    materializeReviewSnapshot({
      cwd: repo,
      reviewTreeOid: review.reviewTreeOid,
      ownerId: 'atlas-xval-pid-one',
      baseDir: snapshots,
      trustedRoot: root,
      _inject: {
        afterLock() {
          const lockName = readdirSync(snapshots).find(name => name.endsWith('.lock'));
          assert.ok(lockName, 'owner lock should exist during materialization');
          const lockPath = path.join(snapshots, lockName);
          const owner = JSON.parse(readFileSync(lockPath, 'utf8'));
          owner.pid = 1;
          owner.pidStartId = null;
          writeFileSync(lockPath, JSON.stringify(owner), { mode: 0o600 });
          try {
            materializeReviewSnapshot({
              cwd: repo,
              reviewTreeOid: review.reviewTreeOid,
              ownerId: 'atlas-xval-pid-one',
              baseDir: snapshots,
              trustedRoot: root,
            });
          } catch (error) {
            contenderError = String(error.message);
          }
        },
      },
    });
    assert.match(contenderError, /already in progress/);
    assert.doesNotMatch(contenderError, /malformed/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('review snapshot reclaims a killed owner by PID start identity and removes its partial tree', async () => {
  const { root, repo, snapshots } = await fixture();
  try {
    writeFileSync(path.join(repo, 'tracked.txt'), 'reviewed change\n');
    const review = buildReviewPackage({ cwd: repo, baseRef: 'main' });
    const moduleUrl = new URL('../lib/review-snapshot.mjs', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { materializeReviewSnapshot } from ${JSON.stringify(moduleUrl)};
      materializeReviewSnapshot({
        cwd: ${JSON.stringify(repo)},
        reviewTreeOid: ${JSON.stringify(review.reviewTreeOid)},
        ownerId: 'atlas-xval-killed-owner',
        baseDir: ${JSON.stringify(snapshots)},
        trustedRoot: ${JSON.stringify(root)},
        _inject: { afterDirectory() {
          process.stdout.write('PARTIAL_READY\\n');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        } },
      });
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    await waitForChildMarker(child, 'PARTIAL_READY');
    const childExit = waitForExit(child);
    child.kill('SIGKILL');
    await childExit;

    const recovered = materializeReviewSnapshot({
      cwd: repo,
      reviewTreeOid: review.reviewTreeOid,
      ownerId: 'atlas-xval-killed-owner',
      baseDir: snapshots,
      trustedRoot: root,
    });
    assert.equal(assertReviewSnapshotCurrent(recovered, {
      cwd: repo,
      baseDir: snapshots,
      trustedRoot: root,
    }), true);
    assert.equal(existsSync(`${recovered.path}.lock`), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('review snapshot cleanup removes a killed post-manifest owner lock', async () => {
  const { root, repo, snapshots } = await fixture();
  try {
    writeFileSync(path.join(repo, 'tracked.txt'), 'reviewed change\n');
    const review = buildReviewPackage({ cwd: repo, baseRef: 'main' });
    const moduleUrl = new URL('../lib/review-snapshot.mjs', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { materializeReviewSnapshot } from ${JSON.stringify(moduleUrl)};
      materializeReviewSnapshot({
        cwd: ${JSON.stringify(repo)},
        reviewTreeOid: ${JSON.stringify(review.reviewTreeOid)},
        ownerId: 'athena-xval-killed-cleanup',
        baseDir: ${JSON.stringify(snapshots)},
        trustedRoot: ${JSON.stringify(root)},
        _inject: { afterManifest() {
          process.stdout.write('MANIFEST_READY\\n');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        } },
      });
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    await waitForChildMarker(child, 'MANIFEST_READY');
    const childExit = waitForExit(child);
    child.kill('SIGKILL');
    await childExit;

    const resumed = materializeReviewSnapshot({
      cwd: repo,
      reviewTreeOid: review.reviewTreeOid,
      ownerId: 'athena-xval-killed-cleanup',
      baseDir: snapshots,
      trustedRoot: root,
    });
    assert.equal(existsSync(`${resumed.path}.lock`), true);
    assert.equal(cleanupReviewSnapshot(resumed, {
      cwd: repo,
      ownerId: resumed.ownerId,
      baseDir: snapshots,
      trustedRoot: root,
    }), true);
    assert.equal(existsSync(`${resumed.path}.lock`), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
