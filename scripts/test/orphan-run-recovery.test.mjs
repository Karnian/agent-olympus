import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { recoverOrphanedRun } from '../lib/orphan-run-recovery.mjs';
import {
  completePhase,
  enterPhase,
  initPipeline,
} from '../lib/phase-runner.mjs';
import { finalizeRun, getActiveRunId } from '../lib/run-artifacts.mjs';

const roots = [];
const RUN_ID = 'athena-20260712-120000-abcd';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function json(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function fixtureAt(cwd) {
  roots.push(cwd);
  const runsBase = path.join(cwd, '.ao', 'artifacts', 'runs');
  const stateDir = path.join(cwd, '.ao', 'state');
  const runDir = path.join(runsBase, RUN_ID);
  const summaryPath = path.join(runDir, 'summary.json');
  const pipelinePath = path.join(runDir, 'pipeline.json');
  const pointerPath = path.join(stateDir, 'ao-active-run-athena.json');
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(summaryPath, JSON.stringify({
    runId: RUN_ID,
    orchestrator: 'athena',
    task: 'resume safely',
    startedAt: '2026-07-12T03:00:00.000Z',
    status: 'running',
  }), { mode: 0o600 });
  assert.equal(initPipeline(RUN_ID, 'athena', { cwd }).ok, true);
  return { cwd, runsBase, stateDir, runDir, summaryPath, pipelinePath, pointerPath };
}

function fixture() {
  return fixtureAt(mkdtempSync(path.join(os.tmpdir(), 'ao-orphan-run-')));
}

function recover(handle, runId = RUN_ID) {
  return recoverOrphanedRun('athena', runId, {
    cwd: handle.cwd,
    runsBase: handle.runsBase,
    stateDir: handle.stateDir,
  });
}

test('recovers a proven orphan with an exclusive 0600 active pointer', () => {
  const handle = fixture();
  assert.deepEqual(recover(handle), {
    ok: true,
    recovered: true,
    runId: RUN_ID,
    reason: 'orphan-recovered',
    canCreateNewRun: false,
  });
  assert.deepEqual(json(handle.pointerPath), {
    runId: RUN_ID,
    orchestrator: 'athena',
    startedAt: '2026-07-12T03:00:00.000Z',
  });
  assert.equal(lstatSync(handle.pointerPath).mode & 0o777, 0o600);
  assert.equal(lstatSync(handle.stateDir).mode & 0o777, 0o700);

  assert.deepEqual(recover(handle), {
    ok: false,
    recovered: false,
    runId: null,
    reason: 'active-pointer-conflict',
    canCreateNewRun: false,
  }, 'a second caller must not co-own a run recovered by the CAS winner');
});

test('does not resurrect a run finalized between orphan proof and transition lock acquisition', () => {
  const handle = fixture();
  let interleavingCount = 0;

  const result = recoverOrphanedRun('athena', RUN_ID, {
    cwd: handle.cwd,
    runsBase: handle.runsBase,
    stateDir: handle.stateDir,
    _beforeTransitionLock() {
      interleavingCount += 1;
      assert.deepEqual(finalizeRun(RUN_ID, { result: 'success' }, {
        base: handle.runsBase,
        stateDir: handle.stateDir,
      }), { ok: true, idempotent: false });
    },
  });

  assert.equal(interleavingCount, 1);
  assert.deepEqual(result, {
    ok: false,
    recovered: false,
    runId: null,
    reason: 'run-already-terminal',
    canCreateNewRun: true,
  });
  assert.equal(json(handle.summaryPath).status, 'completed');
  assert.equal(existsSync(handle.pointerPath), false,
    'a completed run must never receive a stale recovered active pointer');
  assert.equal(getActiveRunId('athena', { stateDir: handle.stateDir }), null);
});

test('rejects every summary identity mismatch without publishing a pointer', () => {
  for (const mutate of [
    summary => { summary.runId = 'athena-20260712-120001-dead'; },
    summary => { summary.orchestrator = 'atlas'; },
    summary => { summary.status = 'completed'; },
    summary => { summary.startedAt = 'not-a-date'; },
    summary => { summary.startedAt = new Date(Date.now() + 30_000).toISOString(); },
  ]) {
    const handle = fixture();
    const summary = json(handle.summaryPath);
    mutate(summary);
    writeFileSync(handle.summaryPath, JSON.stringify(summary));
    const result = recover(handle);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'run-summary-unproven');
    assert.equal(result.canCreateNewRun, false);
    assert.equal(getActiveRunId('athena', { stateDir: handle.stateDir }), null);
  }
});

test('rejects symlinked summaries and pipelines (no-follow)', () => {
  for (const targetName of ['summary.json', 'pipeline.json']) {
    const handle = fixture();
    const targetPath = path.join(handle.runDir, targetName);
    const outside = path.join(handle.cwd, `outside-${targetName}`);
    writeFileSync(outside, readFileSync(targetPath));
    unlinkSync(targetPath);
    symlinkSync(outside, targetPath);
    const result = recover(handle);
    assert.equal(result.ok, false);
    assert.equal(
      result.reason,
      targetName === 'summary.json' ? 'run-summary-unproven' : 'pipeline-identity-unproven',
    );
    assert.equal(result.canCreateNewRun, false);
    assert.equal(getActiveRunId('athena', { stateDir: handle.stateDir }), null);
  }
});

test('rejects linked or non-private summary and pipeline evidence', () => {
  for (const targetName of ['summary.json', 'pipeline.json']) {
    const linked = fixture();
    const targetPath = path.join(linked.runDir, targetName);
    linkSync(targetPath, path.join(linked.cwd, `hardlink-${targetName}`));
    const linkedResult = recover(linked);
    assert.equal(linkedResult.ok, false);
    assert.equal(
      linkedResult.reason,
      targetName === 'summary.json' ? 'run-summary-unproven' : 'pipeline-identity-unproven',
    );
    assert.equal(linkedResult.canCreateNewRun, false);
    assert.equal(existsSync(linked.pointerPath), false);

    const permissive = fixture();
    chmodSync(path.join(permissive.runDir, targetName), 0o644);
    const permissiveResult = recover(permissive);
    assert.equal(permissiveResult.ok, false);
    assert.equal(
      permissiveResult.reason,
      targetName === 'summary.json' ? 'run-summary-unproven' : 'pipeline-identity-unproven',
    );
    assert.equal(permissiveResult.canCreateNewRun, false);
    assert.equal(existsSync(permissive.pointerPath), false);
  }
});

test('rejects a symlink in the run ancestry before publishing an active pointer', () => {
  const handle = fixture();
  const artifacts = path.join(handle.cwd, '.ao', 'artifacts');
  const outsideArtifacts = path.join(handle.cwd, 'outside-artifacts');
  renameSync(artifacts, outsideArtifacts);
  symlinkSync(outsideArtifacts, artifacts);

  const result = recover(handle);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'run-directory-unproven');
  assert.equal(result.canCreateNewRun, false);
  assert.equal(getActiveRunId('athena', { stateDir: handle.stateDir }), null);
  assert.equal(existsSync(handle.pointerPath), false);
});

test('requires an existing current-schema Athena pipeline identity', () => {
  for (const mutate of [
    pipeline => { pipeline.runId = 'athena-20260712-120001-copied'; },
    pipeline => { pipeline.schemaVersion += 1; },
    pipeline => { pipeline.orchestrator = 'atlas'; },
    pipeline => { delete pipeline.phases.spawn; },
    pipeline => { pipeline.phases.spawn.status = 'invented'; },
    pipeline => { pipeline.phases.context.status = 'completed'; },
  ]) {
    const handle = fixture();
    const pipeline = json(handle.pipelinePath);
    mutate(pipeline);
    writeFileSync(handle.pipelinePath, JSON.stringify(pipeline));
    const before = readFileSync(handle.pipelinePath);
    const result = recover(handle);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'pipeline-identity-unproven');
    assert.equal(result.canCreateNewRun, false);
    assert.deepEqual(readFileSync(handle.pipelinePath), before, 'recovery must not rewrite suspect ledgers');
    assert.equal(getActiveRunId('athena', { stateDir: handle.stateDir }), null);
  }
});

test('never overwrites a conflicting, corrupt, or symlink active pointer', () => {
  for (const prepare of [
    handle => writeFileSync(handle.pointerPath, JSON.stringify({
      runId: 'athena-20260712-120001-other',
      orchestrator: 'athena',
      startedAt: '2026-07-12T03:00:01.000Z',
    })),
    handle => writeFileSync(handle.pointerPath, '{'),
    handle => {
      const outside = path.join(handle.cwd, 'outside-pointer.json');
      writeFileSync(outside, '{}');
      symlinkSync(outside, handle.pointerPath);
    },
  ]) {
    const handle = fixture();
    prepare(handle);
    const before = lstatSync(handle.pointerPath).isSymbolicLink()
      ? readFileSync(path.join(handle.cwd, 'outside-pointer.json'))
      : readFileSync(handle.pointerPath);
    const result = recover(handle);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'active-pointer-conflict');
    assert.equal(result.canCreateNewRun, false);
    const after = lstatSync(handle.pointerPath).isSymbolicLink()
      ? readFileSync(path.join(handle.cwd, 'outside-pointer.json'))
      : readFileSync(handle.pointerPath);
    assert.deepEqual(after, before);
  }
});

test('invalid checkpoint identity is never sufficient to create a new run', () => {
  const handle = fixture();
  assert.deepEqual(recover(handle, '../escape'), {
    ok: false,
    recovered: false,
    runId: null,
    reason: 'invalid-recovery-identity',
    canCreateNewRun: false,
  });

  writeFileSync(handle.pointerPath, '{}');
  assert.equal(recover(handle, '../escape').canCreateNewRun, false);
});

test('a missing run directory preserves state because worker liveness is unproven', () => {
  const absent = fixture();
  rmSync(absent.runDir, { recursive: true, force: true });
  const teamMarker = path.join(absent.cwd, '.ao', 'teams', 'existing-team', 'status.jsonl');
  const supervisorMarker = path.join(
    absent.stateDir,
    'supervisor',
    RUN_ID,
    'worker-snapshot.json',
  );
  mkdirSync(path.dirname(teamMarker), { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(supervisorMarker), { recursive: true, mode: 0o700 });
  writeFileSync(teamMarker, '{"status":"running"}\n', { mode: 0o600 });
  writeFileSync(supervisorMarker, '{"status":"running"}\n', { mode: 0o600 });
  const teamBefore = readFileSync(teamMarker);
  const supervisorBefore = readFileSync(supervisorMarker);
  const absentResult = recover(absent);
  assert.deepEqual(absentResult, {
    ok: false,
    recovered: false,
    runId: null,
    reason: 'run-directory-absent',
    canCreateNewRun: false,
  });
  assert.equal(existsSync(absent.pointerPath), false);
  assert.deepEqual(readFileSync(teamMarker), teamBefore);
  assert.deepEqual(readFileSync(supervisorMarker), supervisorBefore);
});

test('a new run is allowed after exact terminal proof under the transition lock', () => {
  const terminal = fixture();
  assert.deepEqual(finalizeRun(RUN_ID, { result: 'success' }, {
    base: terminal.runsBase,
    stateDir: terminal.stateDir,
  }), { ok: true, idempotent: false });
  const terminalSummary = readFileSync(terminal.summaryPath);
  const terminalPipeline = readFileSync(terminal.pipelinePath);
  const terminalResult = recover(terminal);
  assert.deepEqual(terminalResult, {
    ok: false,
    recovered: false,
    runId: null,
    reason: 'run-already-terminal',
    canCreateNewRun: true,
  });
  assert.deepEqual(readFileSync(terminal.summaryPath), terminalSummary);
  assert.deepEqual(readFileSync(terminal.pipelinePath), terminalPipeline);
  assert.equal(existsSync(terminal.pointerPath), false);
});

test('a contradictory or future-dated completed summary is not terminal proof', () => {
  for (const mutate of [
    summary => { summary.failureCode = 'worker_integration_failed'; },
    summary => {
      summary.startedAt = new Date(Date.now() + 30_000).toISOString();
      summary.finishedAt = summary.startedAt;
      summary.duration_ms = 0;
    },
  ]) {
    const handle = fixture();
    assert.deepEqual(finalizeRun(RUN_ID, { result: 'success' }, {
      base: handle.runsBase,
      stateDir: handle.stateDir,
    }), { ok: true, idempotent: false });
    const summary = json(handle.summaryPath);
    mutate(summary);
    writeFileSync(handle.summaryPath, JSON.stringify(summary));

    const result = recover(handle);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'run-summary-unproven');
    assert.equal(result.canCreateNewRun, false);
    assert.equal(existsSync(handle.pointerPath), false);
  }
});

test('forwards an explicit trusted root when publishing a recovered pointer', () => {
  const externalRoot = mkdtempSync(path.join(os.homedir(), '.ao-orphan-trusted-'));
  const handle = fixtureAt(externalRoot);
  const result = recoverOrphanedRun('athena', RUN_ID, {
    cwd: path.join(handle.cwd, 'logical-project'),
    runsBase: handle.runsBase,
    stateDir: handle.stateDir,
    trustedRoot: handle.cwd,
  });

  assert.deepEqual(result, {
    ok: true,
    recovered: true,
    runId: RUN_ID,
    reason: 'orphan-recovered',
    canCreateNewRun: false,
  });
  assert.equal(getActiveRunId('athena', {
    stateDir: handle.stateDir,
    trustedRoot: handle.cwd,
  }), RUN_ID);
});

test('missing summary or pipeline in an existing run preserves state and stops', () => {
  for (const artifact of ['summary.json', 'pipeline.json']) {
    const handle = fixture();
    const target = path.join(handle.runDir, artifact);
    unlinkSync(target);
    const result = recover(handle);
    assert.equal(result.ok, false);
    assert.equal(
      result.reason,
      artifact === 'summary.json' ? 'run-summary-unproven' : 'pipeline-identity-unproven',
    );
    assert.equal(result.canCreateNewRun, false);
    assert.equal(existsSync(handle.pointerPath), false);
    assert.equal(existsSync(target), false, 'recovery must not recreate missing evidence');
  }
});

test('integration: recovered pointer resumes the existing ledger without resetting progress', async () => {
  const handle = fixture();
  assert.equal(enterPhase(RUN_ID, 'triage', { cwd: handle.cwd }).proceed, true);
  const completed = await completePhase(RUN_ID, 'triage', { designed: true }, {
    cwd: handle.cwd,
    saveCheckpoint: false,
  });
  assert.equal(completed.ok, true);
  const before = readFileSync(handle.pipelinePath);

  assert.equal(recover(handle).ok, true);
  const resumed = initPipeline(RUN_ID, 'athena', { cwd: handle.cwd });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.resumePhase, 'context');
  assert.deepEqual(resumed.completed, ['triage']);
  assert.equal(getActiveRunId('athena', { stateDir: handle.stateDir }), RUN_ID);

  const after = json(handle.pipelinePath);
  const original = JSON.parse(before);
  assert.deepEqual(after.phases, original.phases);
  assert.equal(after.attempt, original.attempt);
});

test('state directory must be real and is never followed through a symlink', () => {
  const handle = fixture();
  rmSync(handle.stateDir, { recursive: true, force: true });
  const outside = path.join(handle.cwd, 'outside-state');
  mkdirSync(outside);
  chmodSync(outside, 0o700);
  symlinkSync(outside, handle.stateDir);

  const result = recover(handle);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'state-directory-unsafe');
  assert.equal(result.canCreateNewRun, false);
  assert.equal(getActiveRunId('athena', { stateDir: outside }), null);
});

test('state directory ancestry must be real before pointer absence is trusted', () => {
  const handle = fixture();
  const stateParent = path.join(handle.cwd, 'state-parent');
  const outsideParent = path.join(handle.cwd, 'outside-state-parent');
  const stateDir = path.join(stateParent, 'state');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  renameSync(stateParent, outsideParent);
  symlinkSync(outsideParent, stateParent);

  const result = recoverOrphanedRun('athena', RUN_ID, {
    cwd: handle.cwd,
    runsBase: handle.runsBase,
    stateDir,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'state-directory-unsafe');
  assert.equal(result.canCreateNewRun, false);
});
