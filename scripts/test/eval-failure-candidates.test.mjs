import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  addEvent,
  addVerification,
  createRun,
  setActiveRunId,
} from '../lib/run-artifacts.mjs';
import { finalizeFailedRun } from '../lib/run-failure.mjs';
import { getPhaseSequence } from '../lib/phase-runner.mjs';
import { readProcStartId } from '../lib/proc-identity.mjs';
import {
  FAILURE_CANDIDATE_PENDING_CAP,
  FAILURE_CANDIDATE_SCHEMA_VERSION,
  collectRunFailureCandidate,
  linkFailureCandidate,
  listFailureCandidates,
  reviewFailureCandidate,
} from '../lib/eval-failure-candidates.mjs';

const execFile = promisify(execFileCallback);
const MODULE_URL = pathToFileURL(
  path.resolve('scripts/lib/eval-failure-candidates.mjs'),
).href;
const SECRET = 'HU17_SECRET_SENTINEL_7d83b6f2';
const REVIEWED_AT = '2026-07-12T12:00:00.000Z';
const LINKED_AT = '2026-07-12T12:01:00.000Z';

function tempEnvironment(t, suffix = '') {
  const root = mkdtempSync(path.join(tmpdir(), `ao-eval-candidate-${suffix}`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    runsBase: path.join(root, '.ao', 'artifacts', 'runs'),
    stateDir: path.join(root, '.ao', 'state'),
    candidateBase: path.join(root, '.ao', 'eval-candidates'),
  };
}

function candidateOpts(env, extra = {}) {
  return {
    runsBase: env.runsBase,
    stateDir: env.stateDir,
    candidateBase: env.candidateBase,
    ...extra,
  };
}

function candidatePath(env, candidateId) {
  return path.join(env.candidateBase, 'records', `${candidateId}.json`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function mode(file) {
  return lstatSync(file).mode & 0o777;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function createFailedRun(t, env, options = {}) {
  const orchestrator = options.orchestrator || 'atlas';
  const failureClass = options.failureClass || 'task-outcome';
  const code = options.code || (
    failureClass === 'orchestration'
      ? (orchestrator === 'athena' ? 'worker_integration_failed' : 'plan_validation_failed')
      : failureClass === 'infrastructure'
        ? 'provider_unavailable'
        : failureClass === 'cancelled'
          ? 'user_cancelled'
          : 'verification_exhausted'
  );
  const phase = options.phase || (failureClass === 'orchestration'
    ? (orchestrator === 'athena' ? 'integrate' : 'plan')
    : (orchestrator === 'athena' ? 'integrate' : 'verify'));
  const created = createRun(
    orchestrator,
    options.task || `private task ${SECRET} ${env.root}`,
    { base: env.runsBase, stateDir: env.stateDir },
  );
  assert.ok(created.runDir, 'test precondition: run must be created');

  const summaryPath = path.join(created.runDir, 'summary.json');
  const initialSummary = readJson(summaryPath);
  writeFileSync(summaryPath, JSON.stringify({
    ...initialSummary,
    evidence: { sample: SECRET, absolutePath: env.root },
    errors: [{ sample: SECRET }],
    sourceOutput: `${SECRET}:${env.root}`,
    providerOutput: `${SECRET}:${env.root}`,
  }), { mode: 0o600 });
  addEvent(created.runId, {
    phase: 'verify',
    type: 'verification_failed',
    detail: { errorSample: SECRET, output: env.root },
  }, { base: env.runsBase });
  addVerification(created.runId, {
    story_id: 'US-SECRET',
    verdict: 'fail',
    evidence: `${SECRET}:${env.root}`,
    verifiedBy: 'themis',
  }, { base: env.runsBase });

  const phaseIds = getPhaseSequence(orchestrator).map(item => item.id);
  const failureIndex = phaseIds.indexOf(phase);
  assert.notEqual(failureIndex, -1, 'test precondition: failure phase belongs to orchestrator');
  const pipelineNow = new Date().toISOString();
  const phases = Object.fromEntries(phaseIds.map((id, index) => [id, {
    status: index < failureIndex ? 'completed' : (index === failureIndex ? 'in_progress' : 'pending'),
    ...(index <= failureIndex ? { startedAt: pipelineNow, attempts: 1 } : {}),
    ...(index < failureIndex ? { completedAt: pipelineNow } : {}),
  }]));
  writeFileSync(path.join(created.runDir, 'pipeline.json'), JSON.stringify({
    schemaVersion: 1,
    runId: created.runId,
    orchestrator,
    createdAt: initialSummary.startedAt,
    updatedAt: pipelineNow,
    attempt: 1,
    phases,
  }), { mode: 0o600 });
  if (options.knownArtifacts !== false) {
    writeFileSync(path.join(created.runDir, 'loop-guard.json'), JSON.stringify({
      schemaVersion: 1,
      counters: { attempts: 1 },
      errors: { [SECRET]: { count: 3, sample: env.root } },
    }), { mode: 0o600 });
  }

  const finalized = finalizeFailedRun(created.runId, {
    orchestrator,
    failureClass,
    code,
    phase,
  }, { base: env.runsBase, stateDir: env.stateDir });
  assert.equal(finalized.ok, true);
  return {
    ...created,
    summaryPath,
    markerPath: path.join(created.runDir, 'terminal-failure.json'),
    failureClass,
    code,
    phase,
  };
}

test('collect stores only exact allowlisted metadata and hash/count signals', (t) => {
  const env = tempEnvironment(t, 'allowlist-');
  const run = createFailedRun(t, env);
  const result = collectRunFailureCandidate(run.runId, candidateOpts(env));

  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.match(result.candidate.candidateId, /^efc-[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(result.candidate), [
    'schemaVersion', 'candidateId', 'status', 'run', 'signals', 'review', 'link',
  ]);
  assert.equal(result.candidate.schemaVersion, FAILURE_CANDIDATE_SCHEMA_VERSION);
  assert.equal(result.candidate.status, 'pending');
  assert.deepEqual(result.candidate.run, {
    runId: run.runId,
    orchestrator: 'atlas',
    failureClass: 'task-outcome',
    failureCode: 'verification_exhausted',
    failurePhase: 'verify',
    failedAt: readJson(run.markerPath).failedAt,
    startedAt: readJson(run.summaryPath).startedAt,
    finishedAt: readJson(run.summaryPath).finishedAt,
    durationMs: readJson(run.summaryPath).duration_ms,
  });
  assert.deepEqual(Object.keys(result.candidate.signals), [
    'summary', 'terminalFailure', 'events', 'verification', 'pipeline', 'loopGuard',
  ]);
  assert.equal(result.candidate.signals.events.records, 3);
  assert.equal(result.candidate.signals.verification.records, 1);
  assert.equal(result.candidate.signals.pipeline.phases, getPhaseSequence('atlas').length);
  assert.equal(result.candidate.signals.loopGuard.errorSignatures, 1);

  const file = candidatePath(env, result.candidate.candidateId);
  const raw = readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, new RegExp(SECRET));
  assert.equal(raw.includes(env.root), false, 'absolute source paths must not persist');
  assert.equal(raw.includes('"task"'), false);
  assert.equal(raw.includes('"evidence"'), false);
  assert.equal(raw.includes('"errors"'), false);
  assert.equal(raw.includes('"sourceOutput"'), false);
  assert.equal(raw.includes('"providerOutput"'), false);
  assert.deepEqual(readJson(file), result.candidate);

  if (process.platform !== 'win32') {
    assert.equal(mode(env.candidateBase), 0o700);
    assert.equal(mode(path.join(env.candidateBase, 'records')), 0o700);
    assert.equal(mode(file), 0o600);
  }
  assert.equal(readdirSync(env.candidateBase).includes('.queue-lock'), false);
  assert.equal(
    readdirSync(env.candidateBase).some(name => name.startsWith('.queue-lock-intent-')),
    false,
  );
  assert.equal(
    readdirSync(path.join(env.candidateBase, 'records')).some(name => name.startsWith('.tmp-')),
    false,
  );
});

test('candidate identity and collection are deterministic and idempotent', (t) => {
  const env = tempEnvironment(t, 'dedupe-');
  const run = createFailedRun(t, env, { knownArtifacts: false });
  const first = collectRunFailureCandidate(run.runId, candidateOpts(env));
  const second = collectRunFailureCandidate(run.runId, candidateOpts(env));
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(second.ok, true);
  assert.equal(second.created, false);
  assert.deepEqual(second.candidate, first.candidate);
  assert.equal(listFailureCandidates(candidateOpts(env)).length, 1);

  const otherBase = path.join(env.root, 'second-candidate-base');
  const third = collectRunFailureCandidate(run.runId, candidateOpts(env, {
    candidateBase: otherBase,
  }));
  assert.equal(third.ok, true);
  assert.equal(third.created, true);
  assert.equal(third.candidate.candidateId, first.candidate.candidateId);
  assert.deepEqual(third.candidate, first.candidate);
});

test('base aliases follow run-artifact and queue conventions', (t) => {
  const env = tempEnvironment(t, 'base-alias-');
  const run = createFailedRun(t, env, { knownArtifacts: false });
  const collected = collectRunFailureCandidate(run.runId, {
    base: env.runsBase,
    stateDir: env.stateDir,
    candidateBase: env.candidateBase,
  });
  assert.equal(collected.ok, true);
  assert.equal(listFailureCandidates({ base: env.candidateBase }).length, 1);
  const reviewed = reviewFailureCandidate(
    collected.candidate.candidateId,
    'reject',
    { base: env.candidateBase, now: REVIEWED_AT },
  );
  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.candidate.status, 'rejected');
});

test('a nonstandard custom runsBase requires an explicit stateDir', (t) => {
  const env = tempEnvironment(t, 'custom-state-');
  env.runsBase = path.join(env.root, 'custom-runs');
  env.stateDir = path.join(env.root, 'custom-state');
  const run = createFailedRun(t, env, { knownArtifacts: false });

  assert.deepEqual(
    collectRunFailureCandidate(run.runId, {
      runsBase: env.runsBase,
      candidateBase: env.candidateBase,
    }),
    { ok: false, reason: 'state-dir-required' },
  );
  assert.deepEqual(listFailureCandidates({ candidateBase: env.candidateBase }), []);

  const collected = collectRunFailureCandidate(run.runId, candidateOpts(env));
  assert.equal(collected.ok, true);
  assert.equal(collected.created, true);
});

test('only marker-backed finalized task-outcome and orchestration failures are eligible', async (t) => {
  await t.test('missing terminal marker', (st) => {
    const env = tempEnvironment(st, 'missing-marker-');
    const created = createRun('atlas', 'still running', {
      base: env.runsBase,
      stateDir: env.stateDir,
    });
    const result = collectRunFailureCandidate(created.runId, candidateOpts(env, {
      failureClass: 'task-outcome',
    }));
    assert.equal(result.ok, false);
    assert.equal(listFailureCandidates(candidateOpts(env)).length, 0);
  });

  for (const failureClass of ['infrastructure', 'cancelled']) {
    await t.test(`${failureClass} is ineligible`, (st) => {
      const env = tempEnvironment(st, `${failureClass}-`);
      const run = createFailedRun(st, env, { failureClass });
      const result = collectRunFailureCandidate(run.runId, candidateOpts(env));
      assert.equal(result.ok, false);
      assert.equal(listFailureCandidates(candidateOpts(env)).length, 0);
    });
  }

  await t.test('orchestration is eligible', (st) => {
    const env = tempEnvironment(st, 'orchestration-');
    const run = createFailedRun(st, env, { failureClass: 'orchestration' });
    const result = collectRunFailureCandidate(run.runId, candidateOpts(env));
    assert.equal(result.ok, true);
    assert.equal(result.candidate.run.failureClass, 'orchestration');
  });

  await t.test('caller classification cannot override the durable marker', (st) => {
    const env = tempEnvironment(st, 'class-mismatch-');
    const run = createFailedRun(st, env);
    const result = collectRunFailureCandidate(run.runId, candidateOpts(env, {
      failureClass: 'orchestration',
    }));
    assert.equal(result.ok, false);
  });
});

test('finalization ordering and cleared active identity are mandatory', async (t) => {
  await t.test('event after run_finalized', (st) => {
    const env = tempEnvironment(st, 'late-event-');
    const run = createFailedRun(st, env);
    appendFileSync(path.join(run.runDir, 'events.jsonl'), `${JSON.stringify({
      type: 'late-output',
      detail: SECRET,
      timestamp: new Date().toISOString(),
    })}\n`);
    const result = collectRunFailureCandidate(run.runId, candidateOpts(env));
    assert.deepEqual(result, { ok: false, reason: 'run-not-finalized' });
  });

  await t.test('matching active pointer', (st) => {
    const env = tempEnvironment(st, 'active-pointer-');
    const run = createFailedRun(st, env);
    setActiveRunId('atlas', run.runId, { stateDir: env.stateDir });
    const result = collectRunFailureCandidate(run.runId, candidateOpts(env));
    assert.deepEqual(result, { ok: false, reason: 'run-still-active' });
  });

  await t.test('mismatched summary failure tuple', (st) => {
    const env = tempEnvironment(st, 'summary-mismatch-');
    const run = createFailedRun(st, env);
    const summary = readJson(run.summaryPath);
    writeFileSync(run.summaryPath, JSON.stringify({
      ...summary,
      failureCode: 'acceptance_criteria_unmet',
    }), { mode: 0o600 });
    const result = collectRunFailureCandidate(run.runId, candidateOpts(env));
    assert.equal(result.ok, false);
  });
});

test('collector independently verifies the exact failed pipeline cut and event', async (t) => {
  for (const mutation of ['wrong-code', 'forged-core-skip', 'missing-failure-event']) {
    await t.test(mutation, (st) => {
      const env = tempEnvironment(st, `exact-cut-${mutation}-`);
      const run = createFailedRun(st, env);
      const pipelinePath = path.join(run.runDir, 'pipeline.json');
      if (mutation === 'wrong-code') {
        const pipeline = readJson(pipelinePath);
        pipeline.phases.verify.failureCode = 'acceptance_criteria_unmet';
        writeFileSync(pipelinePath, JSON.stringify(pipeline), { mode: 0o600 });
      } else if (mutation === 'forged-core-skip') {
        const pipeline = readJson(pipelinePath);
        pipeline.phases.execute = { status: 'skipped', reason: 'forged' };
        writeFileSync(pipelinePath, JSON.stringify(pipeline), { mode: 0o600 });
      } else {
        const eventsPath = path.join(run.runDir, 'events.jsonl');
        const events = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean)
          .map(line => JSON.parse(line))
          .filter(event => event.type !== 'pipeline_phase_failed');
        writeFileSync(eventsPath, `${events.map(event => JSON.stringify(event)).join('\n')}\n`, { mode: 0o600 });
      }
      const result = collectRunFailureCandidate(run.runId, candidateOpts(env));
      assert.equal(result.ok, false);
      assert.equal(
        result.reason,
        mutation === 'missing-failure-event' ? 'run-not-finalized' : 'invalid-pipeline-failure-cut',
      );
    });
  }
});

test('source symlinks, corrupt/future schemas, and oversized artifacts fail closed', {
  skip: process.platform === 'win32',
}, async (t) => {
  await t.test('symlink marker', (st) => {
    const env = tempEnvironment(st, 'marker-link-');
    const run = createFailedRun(st, env);
    const real = `${run.markerPath}.real`;
    renameSync(run.markerPath, real);
    symlinkSync(real, run.markerPath);
    assert.equal(collectRunFailureCandidate(run.runId, candidateOpts(env)).ok, false);
  });

  await t.test('symlink run directory', (st) => {
    const env = tempEnvironment(st, 'run-link-');
    const run = createFailedRun(st, env);
    const real = `${run.runDir}-real`;
    renameSync(run.runDir, real);
    symlinkSync(real, run.runDir, 'dir');
    assert.equal(collectRunFailureCandidate(run.runId, candidateOpts(env)).ok, false);
  });

  await t.test('future marker schema', (st) => {
    const env = tempEnvironment(st, 'future-marker-');
    const run = createFailedRun(st, env);
    const marker = readJson(run.markerPath);
    writeFileSync(run.markerPath, JSON.stringify({ ...marker, schemaVersion: 2 }), { mode: 0o600 });
    assert.equal(collectRunFailureCandidate(run.runId, candidateOpts(env)).ok, false);
  });

  await t.test('future pipeline schema', (st) => {
    const env = tempEnvironment(st, 'future-pipeline-');
    const run = createFailedRun(st, env);
    const pipelinePath = path.join(run.runDir, 'pipeline.json');
    const pipeline = readJson(pipelinePath);
    writeFileSync(pipelinePath, JSON.stringify({ ...pipeline, schemaVersion: 2 }), { mode: 0o600 });
    assert.equal(collectRunFailureCandidate(run.runId, candidateOpts(env)).ok, false);
  });

  await t.test('corrupt verification JSONL', (st) => {
    const env = tempEnvironment(st, 'corrupt-verification-');
    const run = createFailedRun(st, env);
    writeFileSync(path.join(run.runDir, 'verification.jsonl'), '{broken\n', { mode: 0o600 });
    assert.equal(collectRunFailureCandidate(run.runId, candidateOpts(env)).ok, false);
  });

  await t.test('oversized marker', (st) => {
    const env = tempEnvironment(st, 'oversized-marker-');
    const run = createFailedRun(st, env);
    writeFileSync(run.markerPath, 'x'.repeat(70 * 1024), { mode: 0o600 });
    assert.deepEqual(
      collectRunFailureCandidate(run.runId, candidateOpts(env)),
      { ok: false, reason: 'oversized-artifact' },
    );
  });

  await t.test('symlink candidate base', (st) => {
    const env = tempEnvironment(st, 'candidate-link-');
    const run = createFailedRun(st, env);
    const target = path.join(env.root, 'real-candidates');
    mkdirSync(target, { recursive: true, mode: 0o700 });
    symlinkSync(target, env.candidateBase, 'dir');
    assert.equal(collectRunFailureCandidate(run.runId, candidateOpts(env)).ok, false);
  });
});

test('review and link lifecycle is exact, atomic, and idempotent', (t) => {
  const env = tempEnvironment(t, 'lifecycle-');
  const run = createFailedRun(t, env, { knownArtifacts: false });
  const collected = collectRunFailureCandidate(run.runId, candidateOpts(env));
  const id = collected.candidate.candidateId;

  assert.deepEqual(
    reviewFailureCandidate(id, 'maybe', candidateOpts(env)),
    { ok: false, reason: 'invalid-review-decision' },
  );
  assert.deepEqual(
    linkFailureCandidate(id, 'golden-task', candidateOpts(env)),
    { ok: false, reason: 'candidate-not-approved' },
  );

  const approved = reviewFailureCandidate(id, 'approve', candidateOpts(env, { now: REVIEWED_AT }));
  assert.equal(approved.ok, true);
  assert.equal(approved.changed, true);
  assert.equal(approved.candidate.status, 'approved');
  assert.deepEqual(approved.candidate.review, {
    decision: 'approve', reviewedAt: REVIEWED_AT,
  });
  const approvedAgain = reviewFailureCandidate(id, 'approve', candidateOpts(env, {
    now: '2026-07-12T13:00:00.000Z',
  }));
  assert.equal(approvedAgain.ok, true);
  assert.equal(approvedAgain.changed, false);
  assert.equal(approvedAgain.candidate.review.reviewedAt, REVIEWED_AT);
  assert.deepEqual(
    reviewFailureCandidate(id, 'reject', candidateOpts(env)),
    { ok: false, reason: 'candidate-already-reviewed' },
  );

  assert.deepEqual(
    linkFailureCandidate(id, '../escape', candidateOpts(env)),
    { ok: false, reason: 'invalid-task-id' },
  );
  const linked = linkFailureCandidate(id, 'fix-null-deref', candidateOpts(env, { now: LINKED_AT }));
  assert.equal(linked.ok, true);
  assert.equal(linked.changed, true);
  assert.deepEqual(linked.candidate.link, {
    taskId: 'fix-null-deref', linkedAt: LINKED_AT,
  });
  const linkedAgain = linkFailureCandidate(id, 'fix-null-deref', candidateOpts(env, {
    now: '2026-07-12T14:00:00.000Z',
  }));
  assert.equal(linkedAgain.ok, true);
  assert.equal(linkedAgain.changed, false);
  assert.equal(linkedAgain.candidate.link.linkedAt, LINKED_AT);
  assert.deepEqual(
    linkFailureCandidate(id, 'other-task', candidateOpts(env)),
    { ok: false, reason: 'candidate-already-linked' },
  );

  assert.deepEqual(listFailureCandidates(candidateOpts(env)), []);
  assert.equal(listFailureCandidates(candidateOpts(env, { status: 'approved' })).length, 1);
  assert.equal(listFailureCandidates(candidateOpts(env, { status: 'all' })).length, 1);
  assert.deepEqual(readJson(candidatePath(env, id)), linked.candidate);
  assert.equal(
    readdirSync(path.join(env.candidateBase, 'records')).some(name => name.startsWith('.tmp-')),
    false,
  );
});

async function childCollect(env, runId) {
  const code = `
    const [moduleUrl, runId, runsBase, candidateBase, stateDir] = process.argv.slice(1);
    const mod = await import(moduleUrl);
    const result = mod.collectRunFailureCandidate(runId, { runsBase, candidateBase, stateDir });
    process.stdout.write(JSON.stringify(result));
  `;
  const { stdout } = await execFile(process.execPath, [
    '--input-type=module', '-e', code,
    MODULE_URL, runId, env.runsBase, env.candidateBase, env.stateDir,
  ], { maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout);
}

async function childReview(env, candidateId) {
  const code = `
    const [moduleUrl, candidateId, candidateBase] = process.argv.slice(1);
    const mod = await import(moduleUrl);
    const result = mod.reviewFailureCandidate(candidateId, 'approve', {
      candidateBase,
      now: '${REVIEWED_AT}',
    });
    process.stdout.write(JSON.stringify(result));
  `;
  const { stdout } = await execFile(process.execPath, [
    '--input-type=module', '-e', code,
    MODULE_URL, candidateId, env.candidateBase,
  ], { maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout);
}

test('concurrent collectors and reviewers converge to one atomic record', async (t) => {
  const env = tempEnvironment(t, 'concurrent-');
  const run = createFailedRun(t, env, { knownArtifacts: false });
  const collected = await Promise.all(
    Array.from({ length: 12 }, () => childCollect(env, run.runId)),
  );
  assert.equal(collected.every(result => result.ok), true);
  assert.equal(collected.filter(result => result.created).length, 1);
  assert.equal(new Set(collected.map(result => result.candidate.candidateId)).size, 1);
  assert.equal(listFailureCandidates(candidateOpts(env)).length, 1);

  const id = collected[0].candidate.candidateId;
  const reviewed = await Promise.all(
    Array.from({ length: 12 }, () => childReview(env, id)),
  );
  assert.equal(reviewed.every(result => result.ok), true, JSON.stringify(reviewed));
  assert.equal(reviewed.filter(result => result.changed).length, 1);
  assert.equal(reviewed.every(result => result.candidate.status === 'approved'), true);
  assert.equal(listFailureCandidates(candidateOpts(env, { status: 'approved' })).length, 1);
  assert.equal(readdirSync(env.candidateBase).includes('.queue-lock'), false);
  assert.equal(
    readdirSync(env.candidateBase).some(name => name.startsWith('.queue-lock-intent-')),
    false,
  );
  assert.equal(
    readdirSync(path.join(env.candidateBase, 'records')).filter(name => name.endsWith('.json')).length,
    1,
  );
});

function installQueueLock(env, owner) {
  listFailureCandidates(candidateOpts(env));
  const lockPath = path.join(env.candidateBase, '.queue-lock');
  mkdirSync(lockPath, { mode: 0o700 });
  writeFileSync(
    path.join(lockPath, 'owner.json'),
    `${JSON.stringify(owner)}\n`,
    { mode: 0o600 },
  );
  return lockPath;
}

test('an old live queue owner is never stolen or released by a contender', (t) => {
  const env = tempEnvironment(t, 'live-lock-');
  const run = createFailedRun(t, env, { knownArtifacts: false });
  const owner = {
    schemaVersion: 1,
    token: '00000000-0000-4000-8000-000000000001',
    pid: process.pid,
    startId: readProcStartId(process.pid),
    createdAt: new Date(Date.now() - 120_000).toISOString(),
  };
  const lockPath = installQueueLock(env, owner);

  assert.deepEqual(
    collectRunFailureCandidate(run.runId, candidateOpts(env)),
    { ok: false, reason: 'queue-busy' },
  );
  assert.deepEqual(readJson(path.join(lockPath, 'owner.json')), owner);
  assert.equal(existsSync(lockPath), true);
  assert.deepEqual(listFailureCandidates(candidateOpts(env)), []);
});

test('a provably dead stale queue owner is reclaimed without weakening ownership', (t) => {
  const env = tempEnvironment(t, 'dead-lock-');
  const run = createFailedRun(t, env, { knownArtifacts: false });
  const lockPath = installQueueLock(env, {
    schemaVersion: 1,
    token: '00000000-0000-4000-8000-000000000002',
    pid: 99_999_999,
    startId: 'dead-process-start-id',
    createdAt: new Date(Date.now() - 120_000).toISOString(),
  });

  const collected = collectRunFailureCandidate(run.runId, candidateOpts(env));
  assert.equal(collected.ok, true);
  assert.equal(collected.created, true);
  assert.equal(existsSync(lockPath), false);
});

test('a crash before atomic lock publication leaves only a non-blocking intent', (t) => {
  const env = tempEnvironment(t, 'intent-crash-');
  const run = createFailedRun(t, env, { knownArtifacts: false });
  listFailureCandidates(candidateOpts(env));
  const intentPath = path.join(
    env.candidateBase,
    '.queue-lock-intent-00000000-0000-4000-8000-000000000003',
  );
  mkdirSync(intentPath, { mode: 0o700 });
  writeFileSync(path.join(intentPath, 'owner.json'), JSON.stringify({
    schemaVersion: 1,
    token: '00000000-0000-4000-8000-000000000003',
    pid: 99_999_999,
    startId: 'dead-before-publication',
    createdAt: new Date(Date.now() - 120_000).toISOString(),
  }), { mode: 0o600 });

  const collected = collectRunFailureCandidate(run.runId, candidateOpts(env));
  assert.equal(collected.ok, true);
  assert.equal(collected.created, true);
  assert.equal(existsSync(intentPath), true, 'orphan intent is inert and can be swept separately');
  assert.equal(existsSync(path.join(env.candidateBase, '.queue-lock')), false);
});

function syntheticCandidate(index) {
  const startedAt = '2026-07-12T00:00:00.000Z';
  const failedAt = '2026-07-12T00:00:01.000Z';
  const finishedAt = '2026-07-12T00:00:02.000Z';
  const run = {
    runId: `atlas-synthetic-${index}`,
    orchestrator: 'atlas',
    failureClass: 'task-outcome',
    failureCode: 'verification_exhausted',
    failurePhase: 'verify',
    failedAt,
    startedAt,
    finishedAt,
    durationMs: 2_000,
  };
  const signals = {
    summary: { sha256: sha256(`summary-${index}`), bytes: 100 },
    terminalFailure: { sha256: sha256(`marker-${index}`), bytes: 100 },
    events: { present: true, sha256: sha256(`events-${index}`), bytes: 100, records: 1 },
    verification: { present: false, sha256: null, bytes: 0, records: 0 },
    pipeline: { present: false, sha256: null, bytes: 0, phases: 0 },
    loopGuard: {
      present: false, sha256: null, bytes: 0, counters: 0, errorSignatures: 0,
    },
  };
  const core = { schemaVersion: FAILURE_CANDIDATE_SCHEMA_VERSION, run, signals };
  const candidateId = `efc-${sha256(JSON.stringify(core))}`;
  return {
    schemaVersion: FAILURE_CANDIDATE_SCHEMA_VERSION,
    candidateId,
    status: 'pending',
    run,
    signals,
    review: { decision: null, reviewedAt: null },
    link: { taskId: null, linkedAt: null },
  };
}

function rejectedSyntheticCandidate(index) {
  const candidate = syntheticCandidate(index);
  return {
    ...candidate,
    status: 'rejected',
    review: {
      decision: 'reject',
      reviewedAt: '2026-07-12T00:02:00.000Z',
    },
  };
}

function spawnLateEventAppender(lockPath, eventsPath) {
  const code = `
    const { appendFileSync, existsSync } = await import('node:fs');
    const path = await import('node:path');
    const [lockPath, eventsPath] = process.argv.slice(1);
    process.stdout.write('READY\\n');
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      if (existsSync(path.join(lockPath, 'owner.json'))) {
        clearInterval(timer);
        setTimeout(() => {
          appendFileSync(eventsPath, JSON.stringify({
            type: 'late_provider_output',
            detail: 'must invalidate finalized-last',
            timestamp: new Date().toISOString(),
          }) + '\\n');
          process.exit(0);
        }, 10);
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        process.exit(2);
      }
    }, 1);
  `;
  const child = spawn(process.execPath, [
    '--input-type=module', '-e', code, lockPath, eventsPath,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', chunk => {
      if (chunk.toString().includes('READY')) resolve();
      else reject(new Error(`late appender did not become ready: ${chunk}`));
    });
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', codeValue => {
      if (codeValue === 0) resolve();
      else reject(new Error(`late appender exited ${codeValue}: ${stderr}`));
    });
  });
  return { ready, exited };
}

test('source artifacts are revalidated inside the queue lock immediately before commit', async (t) => {
  const env = tempEnvironment(t, 'source-race-');
  const run = createFailedRun(t, env, { knownArtifacts: false });
  listFailureCandidates(candidateOpts(env));
  for (let index = 0; index < 499; index += 1) {
    const candidate = rejectedSyntheticCandidate(index + 10_000);
    writeFileSync(candidatePath(env, candidate.candidateId), JSON.stringify(candidate), {
      mode: 0o600,
    });
  }

  const appender = spawnLateEventAppender(
    path.join(env.candidateBase, '.queue-lock'),
    path.join(run.runDir, 'events.jsonl'),
  );
  await appender.ready;
  const collected = collectRunFailureCandidate(run.runId, candidateOpts(env));
  await appender.exited;

  assert.deepEqual(collected, { ok: false, reason: 'source-artifacts-changed' });
  const all = listFailureCandidates(candidateOpts(env, { status: 'all' }));
  assert.equal(all.length, 499);
  assert.equal(all.some(candidate => candidate.run.runId === run.runId), false);
});

test('pending queue enforces the hard 500-candidate cap', (t) => {
  const env = tempEnvironment(t, 'cap-');
  assert.equal(FAILURE_CANDIDATE_PENDING_CAP, 500);
  listFailureCandidates(candidateOpts(env));
  const records = path.join(env.candidateBase, 'records');
  for (let index = 0; index < FAILURE_CANDIDATE_PENDING_CAP; index += 1) {
    const candidate = syntheticCandidate(index);
    writeFileSync(candidatePath(env, candidate.candidateId), `${JSON.stringify(candidate)}\n`, {
      mode: 0o600,
    });
  }
  assert.equal(readdirSync(records).length, FAILURE_CANDIDATE_PENDING_CAP);

  const run = createFailedRun(t, env, { knownArtifacts: false });
  assert.deepEqual(
    collectRunFailureCandidate(run.runId, candidateOpts(env)),
    { ok: false, reason: 'pending-cap-reached' },
  );
  assert.equal(listFailureCandidates(candidateOpts(env)).length, FAILURE_CANDIDATE_PENDING_CAP);
});

test('corrupt, future-schema, oversized, and symlink queue records fail closed', {
  skip: process.platform === 'win32',
}, async (t) => {
  const cases = [
    ['corrupt', (file) => writeFileSync(file, '{broken', { mode: 0o600 })],
    ['future', (file) => {
      const value = readJson(file);
      writeFileSync(file, JSON.stringify({ ...value, schemaVersion: 2 }), { mode: 0o600 });
    }],
    ['oversized', (file) => writeFileSync(file, 'x'.repeat(70 * 1024), { mode: 0o600 })],
    ['symlink', (file) => {
      const real = `${file}.real`;
      renameSync(file, real);
      symlinkSync(real, file);
    }],
    ['unsafe-permissions', (file) => chmodSync(file, 0o644)],
    ['duplicate-run', (file) => {
      const duplicate = readJson(file);
      duplicate.signals.summary.sha256 = sha256('different-finalized-summary');
      const core = {
        schemaVersion: duplicate.schemaVersion,
        run: duplicate.run,
        signals: duplicate.signals,
      };
      duplicate.candidateId = `efc-${sha256(JSON.stringify(core))}`;
      writeFileSync(
        path.join(path.dirname(file), `${duplicate.candidateId}.json`),
        JSON.stringify(duplicate),
        { mode: 0o600 },
      );
    }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, (st) => {
      const env = tempEnvironment(st, `queue-${name}-`);
      const run = createFailedRun(st, env, { knownArtifacts: false });
      const collected = collectRunFailureCandidate(run.runId, candidateOpts(env));
      const file = candidatePath(env, collected.candidate.candidateId);
      mutate(file);
      assert.deepEqual(listFailureCandidates(candidateOpts(env, { status: 'all' })), []);
      assert.equal(
        reviewFailureCandidate(collected.candidate.candidateId, 'approve', candidateOpts(env)).ok,
        false,
      );
    });
  }
});

test('public path identifiers reject traversal without filesystem escape', (t) => {
  const env = tempEnvironment(t, 'paths-');
  assert.deepEqual(
    collectRunFailureCandidate('../escape', candidateOpts(env)),
    { ok: false, reason: 'invalid-run-id' },
  );
  assert.deepEqual(
    reviewFailureCandidate('../escape', 'approve', candidateOpts(env)),
    { ok: false, reason: 'invalid-candidate-id' },
  );
  assert.deepEqual(
    linkFailureCandidate(`efc-${'a'.repeat(64)}`, '/absolute/task', candidateOpts(env)),
    { ok: false, reason: 'invalid-task-id' },
  );
});
