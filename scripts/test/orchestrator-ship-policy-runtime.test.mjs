import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  appendUserTaskUpdate,
  createRun,
} from '../lib/run-artifacts.mjs';
import {
  completePhase,
  enterPhase,
  getPipelineState,
  initPipeline,
  loopTick,
} from '../lib/phase-runner.mjs';
import {
  __resetForTest as resetPrCreateForTest,
  __setExecFileSyncForTest as setPrCreateExecForTest,
} from '../lib/pr-create.mjs';
import {
  __resetForTest as resetCiWatchForTest,
  __setExecFileSyncForTest as setCiWatchExecForTest,
} from '../lib/ci-watch.mjs';
import {
  __resetRuntimeExecFileSyncForTest,
  __setRuntimeExecFileSyncForTest,
  executeRuntimeCommand,
} from '../orchestrator-runtime.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNTIME = join(ROOT, 'scripts', 'orchestrator-runtime.mjs');
const PRE_SHIP_PHASES = [
  'triage',
  'context',
  'spec',
  'plan',
  'execute',
  'verify',
  'review',
  'finalize',
];

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function invoke(cwd, args, env = {}) {
  const result = spawnSync(process.execPath, [RUNTIME, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.stderr, '');
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  return { ...result, json: JSON.parse(result.stdout) };
}

async function invokeDirect(args) {
  try {
    const json = await executeRuntimeCommand(args);
    return { status: 0, json, stdout: JSON.stringify(json) };
  } catch (error) {
    return {
      status: 1,
      json: { error: { code: error?.code, message: error?.message, detail: error?.detail } },
      stdout: '',
    };
  }
}

async function project(task, shipMode) {
  const cwd = mkdtempSync(join(tmpdir(), 'ao-runtime-ship-policy-'));
  chmodSync(cwd, 0o700);
  git(cwd, ['init', '--initial-branch=main']);
  git(cwd, ['config', 'user.name', 'Atlas Ship Runtime Test']);
  git(cwd, ['config', 'user.email', 'atlas-ship@example.test']);
  writeFileSync(join(cwd, '.gitignore'), '.ao/\n');
  writeFileSync(join(cwd, 'README.md'), '# Runtime ship policy\n');
  git(cwd, ['add', '.gitignore', 'README.md']);
  git(cwd, ['commit', '-m', 'base']);
  git(cwd, ['switch', '-c', 'feature/runtime-ship-policy']);

  const ao = join(cwd, '.ao');
  const base = join(ao, 'artifacts', 'runs');
  const stateDir = join(ao, 'state');
  mkdirSync(ao, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(ao, 'autonomy.json'),
    `${JSON.stringify({ ship: { mode: shipMode } })}\n`,
  );
  const created = createRun('atlas', task, { base, stateDir, trustedRoot: cwd });
  assert.equal(created.ok, true);
  assert.equal(appendUserTaskUpdate(created.runId, task, {
    base,
    trustedRoot: cwd,
    allowCreate: true,
  }).ok, true);
  const initialized = initPipeline(created.runId, 'atlas', { cwd });
  assert.equal(initialized.ok, true);

  for (const phase of PRE_SHIP_PHASES) {
    const entered = enterPhase(created.runId, phase, { cwd });
    assert.equal(entered.proceed, true, `${phase} must enter`);
    const loop = phase === 'review'
        ? 'review'
        : phase === 'finalize'
          ? 'final-review'
          : null;
    if (loop) {
      assert.equal(loopTick(created.runId, loop, { cwd }).allowed, true);
    }
    const completionOutputs = phase === 'finalize'
      ? {
          finalReviewDigest: 'a'.repeat(64),
          finalReviewTreeOid: git(cwd, ['rev-parse', 'HEAD^{tree}']),
          finalCommit: git(cwd, ['rev-parse', 'HEAD']),
        }
      : undefined;
    const completed = await completePhase(created.runId, phase, completionOutputs, {
      cwd,
      saveCheckpoint: false,
    });
    assert.equal(completed.ok, true, `${phase} must complete`);
    assert.equal(completed.degraded, false, `${phase} must remain durable`);
  }
  assert.equal(getPipelineState(created.runId, { cwd }).phases.ship.status, 'pending');
  return {
    cwd,
    runId: created.runId,
    base,
    stateDir,
    finalCommit: git(cwd, ['rev-parse', 'HEAD']),
  };
}

function clean(...paths) {
  for (const path of paths) rmSync(path, { recursive: true, force: true });
}

describe('Atlas runtime ship-policy boundary', () => {
  it('denies ship entry when persistent ship.mode is never', async () => {
    const fixture = await project('prepare a local branch', 'never');
    try {
      const denied = invoke(fixture.cwd, [
        'enter', 'atlas', fixture.runId, 'ship',
      ]);
      assert.notEqual(denied.status, 0);
      assert.equal(denied.json.error.code, 'ship-policy-denied');
      assert.equal(
        getPipelineState(fixture.runId, { cwd: fixture.cwd }).phases.ship.status,
        'pending',
      );
    } finally {
      clean(fixture.cwd);
    }
  });

  it('binds ship and CI skips to the durable policy and observed ship outcome', async () => {
    const neverFixture = await project('prepare a local branch', 'never');
    const autoFixture = await project('implement and ship the change', 'auto');
    try {
      const wrongNeverSkip = invoke(neverFixture.cwd, [
        'skip', 'atlas', neverFixture.runId, 'ship', 'user-declined',
      ]);
      assert.notEqual(wrongNeverSkip.status, 0);
      assert.equal(wrongNeverSkip.json.error.code, 'ship-skip-policy-mismatch');

      const skippedShip = invoke(neverFixture.cwd, [
        'skip', 'atlas', neverFixture.runId, 'ship', 'not-applicable',
      ]);
      assert.equal(skippedShip.status, 0, skippedShip.stdout);
      const terminalShipReplay = invoke(neverFixture.cwd, [
        'enter', 'atlas', neverFixture.runId, 'ship',
      ]);
      assert.equal(terminalShipReplay.status, 0, terminalShipReplay.stdout);
      assert.equal(terminalShipReplay.json.result.skip, true);
      const forgedWatchDisabled = invoke(neverFixture.cwd, [
        'skip', 'atlas', neverFixture.runId, 'ci', 'watch-disabled',
      ]);
      assert.notEqual(forgedWatchDisabled.status, 0);
      assert.equal(forgedWatchDisabled.json.error.code, 'ci-skip-evidence-mismatch');
      const skippedCi = invoke(neverFixture.cwd, [
        'skip', 'atlas', neverFixture.runId, 'ci', 'no-pr',
      ]);
      assert.equal(skippedCi.status, 0, skippedCi.stdout);

      for (const reason of ['not-applicable', 'user-declined']) {
        const denied = invoke(autoFixture.cwd, [
          'skip', 'atlas', autoFixture.runId, 'ship', reason,
        ]);
        assert.notEqual(denied.status, 0);
        assert.equal(denied.json.error.code, 'ship-skip-policy-mismatch');
      }
      git(autoFixture.cwd, [
        'remote', 'add', 'origin', 'file:///definitely-unavailable/runtime-ship.git',
      ]);
      const unavailable = invoke(autoFixture.cwd, [
        'skip', 'atlas', autoFixture.runId, 'ship', 'preflight-unavailable',
      ]);
      assert.equal(unavailable.status, 0, unavailable.stdout);
    } finally {
      clean(neverFixture.cwd, autoFixture.cwd);
    }
  });

  it('re-reads durable follow-ups and denies ship entry after a no-push instruction', async () => {
    const fixture = await project('implement and ship the change', 'auto');
    try {
      const appended = appendUserTaskUpdate(fixture.runId, 'Do not push this branch.', {
        base: fixture.base,
        trustedRoot: fixture.cwd,
      });
      assert.equal(appended.ok, true);
      const denied = invoke(fixture.cwd, [
        'enter', 'atlas', fixture.runId, 'ship',
      ]);
      assert.notEqual(denied.status, 0);
      assert.equal(denied.json.error.code, 'ship-policy-denied');
      assert.equal(denied.json.error.detail.taskForbidsShipping, true);
    } finally {
      clean(fixture.cwd);
    }
  });

  it('fails closed for ask mode because run events cannot attest a human answer', async () => {
    const fixture = await project('ship after approval', 'ask');
    try {
      const denied = invoke(fixture.cwd, ['enter', 'atlas', fixture.runId, 'ship']);
      assert.notEqual(denied.status, 0);
      assert.equal(denied.json.error.code, 'ship-approval-unattested');
      assert.match(denied.json.error.message, /host-attested approval receipt/i);
    } finally {
      clean(fixture.cwd);
    }
  });

  it('derives auto-mode completion from remote + PR evidence', async () => {
    const fixture = await project('ship the reviewed change', 'auto');
    const remote = mkdtempSync(join(tmpdir(), 'ao-runtime-ship-remote-'));
    const previousCwd = process.cwd();
    let mocksInstalled = false;
    try {
      git(remote, ['init', '--bare', '--initial-branch=main']);
      const originUrl = 'https://github.com/acme/runtime-ship-fixture.git';
      const pushUrl = 'git@github.com:acme/runtime-ship-fixture.git';
      git(fixture.cwd, ['remote', 'add', 'origin', originUrl]);
      git(fixture.cwd, ['push', remote, 'main:refs/heads/main']);

      const branchName = git(fixture.cwd, ['branch', '--show-current']);
      const headCommit = git(fixture.cwd, ['rev-parse', 'HEAD']);
      assert.equal(headCommit, fixture.finalCommit);
      const commandMock = (command, args, options = {}) => {
        if (command === 'gh' && args[0] === 'repo' && args[1] === 'view') {
          return '{"defaultBranchRef":{"name":"main"},"nameWithOwner":"acme/runtime-ship-fixture"}\n';
        }
        if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return `${JSON.stringify({
            url: 'https://github.com/acme/runtime-ship-fixture/pull/7',
            headRefName: branchName,
            headRefOid: headCommit,
            baseRefName: 'main',
            isCrossRepository: false,
          })}\n`;
        }
        if (command === 'gh' && args[0] === 'run' && args[1] === 'list') {
          return `${JSON.stringify([{
            databaseId: 77,
            status: 'completed',
            conclusion: 'success',
            headSha: headCommit,
          }])}\n`;
        }
        if (command === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
          return `${args.includes('--push') ? pushUrl : originUrl}\n`;
        }
        const actualArgs = command === 'git' && args[0] === 'ls-remote'
          ? ['ls-remote', '--refs', remote, args[3]]
          : args;
        if (command !== 'git') throw new Error(`unexpected command: ${command}`);
        const result = spawnSync('/usr/bin/git', actualArgs, {
          cwd: options.cwd || fixture.cwd,
          encoding: 'utf8',
        });
        if (result.status !== 0) throw new Error(result.stderr || 'git command failed');
        return result.stdout;
      };
      setPrCreateExecForTest(commandMock);
      setCiWatchExecForTest(commandMock);
      __setRuntimeExecFileSyncForTest(commandMock);
      mocksInstalled = true;
      process.chdir(fixture.cwd);

      git(fixture.cwd, ['commit', '--allow-empty', '-m', 'unreviewed after finalize']);
      const unreviewedEntry = await invokeDirect([
        'enter', 'atlas', fixture.runId, 'ship',
      ]);
      assert.notEqual(unreviewedEntry.status, 0);
      assert.equal(unreviewedEntry.json.error.code, 'ship-finalize-head-mismatch');
      assert.equal(
        getPipelineState(fixture.runId, { cwd: fixture.cwd }).phases.ship.status,
        'pending',
      );
      git(fixture.cwd, ['reset', '--hard', headCommit]);

      const entered = await invokeDirect([
        'enter', 'atlas', fixture.runId, 'ship',
      ]);
      assert.equal(entered.status, 0, entered.stdout);

      const output = (head = headCommit) => [
        'complete', 'atlas', fixture.runId, 'ship',
        'pushPerformed=true',
        'createdPrUrl=https://github.com/acme/runtime-ship-fixture/pull/7',
        `branchName=${branchName}`,
        'baseBranch=main',
        `headCommit=${head}`,
        `repoOriginUrl=${originUrl}`,
        `repoPushUrl=${pushUrl}`,
        'repoRepository=github.com/acme/runtime-ship-fixture',
        'repoDefaultBranch=main',
      ];
      const forgedHead = await invokeDirect(output('f'.repeat(40)));
      assert.notEqual(forgedHead.status, 0);
      assert.equal(forgedHead.json.error.code, 'ship-evidence-mismatch');

      const missingRemote = await invokeDirect(output());
      assert.notEqual(missingRemote.status, 0);
      assert.equal(missingRemote.json.error.code, 'ship-remote-head-mismatch');

      git(fixture.cwd, ['commit', '--allow-empty', '-m', 'unreviewed during ship']);
      const changedDuringShip = await invokeDirect(output(git(fixture.cwd, ['rev-parse', 'HEAD'])));
      assert.notEqual(changedDuringShip.status, 0);
      assert.equal(changedDuringShip.json.error.code, 'ship-finalize-head-mismatch');
      git(fixture.cwd, ['reset', '--hard', headCommit]);

      git(fixture.cwd, ['push', remote, `${branchName}:refs/heads/${branchName}`]);
      const completed = await invokeDirect(output());
      assert.equal(completed.status, 0, completed.stdout);
      const persisted = getPipelineState(fixture.runId, { cwd: fixture.cwd }).phases.ship;
      assert.equal(persisted.status, 'completed');
      assert.deepEqual(persisted.outputs, {
        pushPerformed: true,
        createdPrUrl: 'https://github.com/acme/runtime-ship-fixture/pull/7',
        branchName,
        baseBranch: 'main',
        headCommit,
        repoOriginUrl: originUrl,
        repoPushUrl: pushUrl,
        repoRepository: 'github.com/acme/runtime-ship-fixture',
        repoDefaultBranch: 'main',
      });

      git(fixture.cwd, ['commit', '--allow-empty', '-m', 'unreviewed before CI']);
      const changedBeforeCi = await invokeDirect([
        'enter', 'atlas', fixture.runId, 'ci',
      ]);
      assert.notEqual(changedBeforeCi.status, 0);
      assert.equal(changedBeforeCi.json.error.code, 'ship-finalize-head-mismatch');
      git(fixture.cwd, ['reset', '--hard', headCommit]);

      const enteredCi = await invokeDirect([
        'enter', 'atlas', fixture.runId, 'ci',
      ]);
      assert.equal(enteredCi.status, 0, enteredCi.stdout);
      const forgedGenericCompletion = await invokeDirect([
        'complete', 'atlas', fixture.runId, 'ci', `ciHeadCommit=${headCommit}`,
      ]);
      assert.notEqual(forgedGenericCompletion.status, 0);
      assert.equal(forgedGenericCompletion.json.error.code, 'evidence-completion-required');
      const forgedNoPr = await invokeDirect([
        'skip', 'atlas', fixture.runId, 'ci', 'no-pr',
      ]);
      assert.notEqual(forgedNoPr.status, 0);
      assert.equal(forgedNoPr.json.error.code, 'ci-skip-evidence-mismatch');
      const tickedCi = await invokeDirect([
        'tick', 'atlas', fixture.runId, 'ci',
      ]);
      assert.equal(tickedCi.status, 0, tickedCi.stdout);
      const completedCi = await invokeDirect([
        'complete-ci', 'atlas', fixture.runId,
      ]);
      assert.equal(completedCi.status, 0, completedCi.stdout);
      const persistedCi = getPipelineState(fixture.runId, { cwd: fixture.cwd }).phases.ci;
      assert.equal(persistedCi.status, 'completed');
      assert.equal(persistedCi.outputs.ciHeadCommit, headCommit);
      assert.equal(completedCi.json.result.observation.status, 'passed');
    } finally {
      if (mocksInstalled) {
        resetPrCreateForTest();
        resetCiWatchForTest();
        __resetRuntimeExecFileSyncForTest();
      }
      process.chdir(previousCwd);
      clean(fixture.cwd, remote);
    }
  });
});
