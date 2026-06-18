/**
 * Unit tests for scripts/lib/phase-runner.mjs
 *
 * Covers the pure HU-06.1 runner contract: phase sequence shape, durable
 * pipeline ledger, loop-guard absorption, ledger-first completion, fail-open
 * polarity, and checkpoint injection.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MONITOR_CAP,
  CI_CAP,
  QUALITY_CAP,
  SCHEMA_VERSION,
  getPhaseSequence,
  initPipeline,
  enterPhase,
  beginAttempt,
  reattempt,
  loopTick,
  recordPhaseError,
  completePhase,
  skipPhase,
  reopenPhase,
  nextPhase,
  getPipelineState,
  isComplete,
} from '../lib/phase-runner.mjs';

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'ao-phase-runner-test-'));
}

async function removeTmpDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

function pipelinePath(cwd, runId) {
  return path.join(cwd, '.ao', 'artifacts', 'runs', runId, 'pipeline.json');
}

function guardPath(cwd, runId) {
  return path.join(cwd, '.ao', 'artifacts', 'runs', runId, 'loop-guard.json');
}

function eventsPath(cwd, runId) {
  return path.join(cwd, '.ao', 'artifacts', 'runs', runId, 'events.jsonl');
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function readEvents(cwd, runId) {
  const file = eventsPath(cwd, runId);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

async function completeNoCheckpoint(runId, phaseId, cwd, outputs = undefined) {
  return completePhase(runId, phaseId, outputs, { cwd, saveCheckpoint: false });
}

async function completeThrough(runId, cwd, phaseIds) {
  for (const phaseId of phaseIds) {
    enterPhase(runId, phaseId, { cwd });
    await completeNoCheckpoint(runId, phaseId, cwd);
  }
}

// ---------------------------------------------------------------------------
// Phase sequence shape
// ---------------------------------------------------------------------------

describe('phase sequence well-formedness', () => {
  test('exports constants from the HU-06.1 contract', () => {
    assert.equal(MONITOR_CAP, 10);
    assert.equal(CI_CAP, 2);
    assert.equal(QUALITY_CAP, 2);
    assert.equal(SCHEMA_VERSION, 1);
  });

  test('atlas and athena descriptors match the plan constraints', () => {
    const validGuards = new Set([null, 'reviewRounds', 'monitor', 'ci', 'quality']);
    for (const orchestrator of ['atlas', 'athena']) {
      const seq = getPhaseSequence(orchestrator);
      assert.ok(seq.length > 0, `${orchestrator} sequence must exist`);
      assert.deepEqual(new Set(seq.map(p => p.id)).size, seq.length, `${orchestrator} ids must be unique`);
      let lastCheckpoint = -1;
      for (const desc of seq) {
        assert.ok(validGuards.has(desc.loopGuard), `invalid loopGuard ${desc.loopGuard}`);
        assert.notEqual(desc.loopGuard, 'iterations');
        assert.ok(desc.checkpointIndex >= lastCheckpoint, `${orchestrator} checkpointIndex must be monotonic`);
        lastCheckpoint = desc.checkpointIndex;
      }
    }
  });

  test('unknown orchestrator returns an empty sequence', () => {
    assert.deepEqual(getPhaseSequence('unknown'), []);
  });
});

// ---------------------------------------------------------------------------
// Enter / resume
// ---------------------------------------------------------------------------

describe('enterPhase', () => {
  test('skips completed and skipped phases', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-enter', 'atlas', { cwd });
      enterPhase('run-enter', 'triage', { cwd });
      await completeNoCheckpoint('run-enter', 'triage', cwd);
      assert.deepEqual(
        enterPhase('run-enter', 'triage', { cwd }),
        { proceed: false, skip: true, reason: undefined, status: 'completed', degraded: false },
      );

      skipPhase('run-enter', 'context', 'trivial', { cwd });
      const skipped = enterPhase('run-enter', 'context', { cwd });
      assert.equal(skipped.proceed, false);
      assert.equal(skipped.skip, true);
      assert.equal(skipped.status, 'skipped');
      assert.equal(skipped.reason, 'trivial');
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('recover phases return reason recover on in_progress resume', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-recover', 'athena', { cwd });
      await completeThrough('run-recover', cwd, ['triage', 'context', 'spec', 'plan']);
      const first = enterPhase('run-recover', 'spawn', { cwd });
      assert.equal(first.proceed, true);
      assert.equal(first.status, 'in_progress');

      const second = enterPhase('run-recover', 'spawn', { cwd });
      assert.equal(second.proceed, true);
      assert.equal(second.reason, 'recover');
      assert.equal(second.status, 'in_progress');
    } finally {
      await removeTmpDir(cwd);
    }
  });
});

// ---------------------------------------------------------------------------
// Attempts and loop caps
// ---------------------------------------------------------------------------

describe('beginAttempt + reattempt', () => {
  test('first attempt + 14 reattempts fill cap, next reattempt blocks without count skip', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-attempts', 'atlas', { cwd });
      const first = beginAttempt('run-attempts', { cwd });
      assert.equal(first.allowed, true);
      assert.equal(first.count, 1);

      const counts = [];
      for (let i = 0; i < 14; i++) {
        const r = reattempt('run-attempts', { reopen: ['verify'], reason: 'review_reject' }, { cwd });
        assert.equal(r.allowed, true);
        counts.push(r.count);
        assert.deepEqual(r.reopened, ['verify']);
      }
      assert.deepEqual(counts, Array.from({ length: 14 }, (_, i) => i + 2));

      const blocked = reattempt('run-attempts', { reopen: ['verify'], reason: 'review_reject' }, { cwd });
      assert.equal(blocked.allowed, false);
      assert.equal(blocked.count, 15);
      assert.deepEqual(blocked.reopened, []);
      assert.equal(readJson(guardPath(cwd, 'run-attempts')).counters.iterations.count, 15);
      assert.equal(readJson(pipelinePath(cwd, 'run-attempts')).attempt, 15);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('attempt mirror corruption never changes cap enforcement', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-mirror', 'atlas', { cwd });
      assert.equal(beginAttempt('run-mirror', { cwd }).count, 1);
      const ledger = readJson(pipelinePath(cwd, 'run-mirror'));
      ledger.attempt = 999;
      writeFileSync(pipelinePath(cwd, 'run-mirror'), JSON.stringify(ledger, null, 2));

      const second = reattempt('run-mirror', { reopen: ['verify'], reason: 'review_reject' }, { cwd });
      assert.equal(second.allowed, true);
      assert.equal(second.count, 2);
      assert.equal(readJson(pipelinePath(cwd, 'run-mirror')).attempt, 2);
    } finally {
      await removeTmpDir(cwd);
    }
  });
});

describe('loopTick', () => {
  test('dispatches review, monitor, ci, and quality caps', async () => {
    const cwd = await makeTmpDir();
    try {
      const cases = [
        ['review', 3],
        ['monitor', 10],
        ['ci', 2],
        ['quality', 2],
      ];
      for (const [key, cap] of cases) {
        const runId = `run-${key}`;
        const results = [];
        for (let i = 0; i < cap + 1; i++) results.push(loopTick(runId, key, { cwd }));
        assert.deepEqual(results.map(r => r.allowed), [...Array(cap).fill(true), false], `${key} allowed sequence`);
        assert.equal(results.at(-1).count, cap, `${key} count pinned at cap`);
      }
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('resolves phase ids to descriptor loop guards', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-phase-loop', 'athena', { cwd });
      for (let i = 0; i < 10; i++) assert.equal(loopTick('run-phase-loop', 'monitor', { cwd }).allowed, true);
      const blocked = loopTick('run-phase-loop', 'monitor', { cwd });
      assert.equal(blocked.allowed, false);
      assert.equal(blocked.cap, 10);
    } finally {
      await removeTmpDir(cwd);
    }
  });
});

describe('recordPhaseError', () => {
  test('escalates on the 3rd matching error signature', async () => {
    const cwd = await makeTmpDir();
    try {
      const a = recordPhaseError('run-errors', 'verify', 'TypeError at app.js:10', { cwd });
      const b = recordPhaseError('run-errors', 'verify', 'TypeError at app.js:12', { cwd });
      const c = recordPhaseError('run-errors', 'verify', 'TypeError at app.js:99', { cwd });
      assert.deepEqual([a.repeatCount, b.repeatCount, c.repeatCount], [1, 2, 3]);
      assert.deepEqual([a.shouldEscalate, b.shouldEscalate, c.shouldEscalate], [false, false, true]);
      assert.equal(c.threshold, 3);
    } finally {
      await removeTmpDir(cwd);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase completion, events, skips, reopens
// ---------------------------------------------------------------------------

describe('completePhase', () => {
  test('writes ledger and pipeline event before injected saveCheckpoint', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-complete', 'atlas', { cwd });
      enterPhase('run-complete', 'triage', { cwd });
      const order = [];
      const result = await completePhase('run-complete', 'triage', { storyCount: 1 }, {
        cwd,
        _saveCheckpoint: async (orchestrator, payload) => {
          order.push('checkpoint');
          assert.equal(orchestrator, 'atlas');
          assert.equal(payload.phase, 0);
          assert.equal(readJson(pipelinePath(cwd, 'run-complete')).phases.triage.status, 'completed');
          assert.equal(readEvents(cwd, 'run-complete').filter(e => e.type === 'pipeline_phase_completed').length, 1);
          return { ok: true, degraded: false };
        },
      });

      assert.equal(result.ok, true);
      assert.equal(result.next, 'context');
      assert.equal(result.checkpointDegraded, false);
      assert.deepEqual(order, ['checkpoint']);
      const events = readEvents(cwd, 'run-complete');
      assert.equal(events.filter(e => e.type === 'pipeline_phase_completed').length, 1);
      assert.equal(events.filter(e => e.type === 'phase_transition').length, 0);
      assert.equal(events.filter(e => e.type === 'checkpoint_saved').length, 0);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('simulated crash between ledger and checkpoint leaves ledger authoritative', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-crash', 'atlas', { cwd });
      const result = await completePhase('run-crash', 'triage', undefined, {
        cwd,
        _saveCheckpoint: async () => {
          throw new Error('checkpoint crash');
        },
      });
      assert.equal(result.ok, true);
      assert.equal(result.checkpointDegraded, true);
      assert.equal(readJson(pipelinePath(cwd, 'run-crash')).phases.triage.status, 'completed');
      assert.equal(initPipeline('run-crash', 'atlas', { cwd }).resumePhase, 'context');
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('outputs are scalars-only and capped around 4KB', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-outputs', 'atlas', { cwd });
      await completeNoCheckpoint('run-outputs', 'triage', cwd, {
        ok: true,
        count: 3,
        nested: { dropped: true },
        list: ['dropped'],
        huge: 'x'.repeat(9000),
      });
      const outputs = readJson(pipelinePath(cwd, 'run-outputs')).phases.triage.outputs;
      assert.equal(outputs.truncated, true);
      assert.equal(typeof outputs.tail, 'string');
      assert.ok(Buffer.byteLength(JSON.stringify(outputs), 'utf-8') <= 4096);
      assert.equal(outputs.tail.includes('x'.repeat(20)), true);
    } finally {
      await removeTmpDir(cwd);
    }
  });
});

describe('skipPhase and reopenPhase', () => {
  test('skipPhase marks optional phases skipped and resume does not re-evaluate them', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-skip', 'atlas', { cwd });
      await completeThrough('run-skip', cwd, ['triage']);
      skipPhase('run-skip', 'context', 'trivial', { cwd });
      skipPhase('run-skip', 'spec', 'trivial', { cwd });
      skipPhase('run-skip', 'plan', 'trivial', { cwd });
      const resumed = initPipeline('run-skip', 'atlas', { cwd });
      assert.equal(resumed.resumePhase, 'execute');
      assert.deepEqual(resumed.completed, ['triage', 'context', 'spec', 'plan']);
      assert.equal(enterPhase('run-skip', 'context', { cwd }).skip, true);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('reopenPhase is allowed only for reopenableFor and does not tick the 15-cap', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-reopen', 'atlas', { cwd });
      beginAttempt('run-reopen', { cwd });
      const allowed = reopenPhase('run-reopen', 'plan', { reason: 'light_mode_rewind' }, { cwd });
      assert.equal(allowed.ok, true);
      assert.equal(allowed.rejected, false);
      assert.equal(readJson(pipelinePath(cwd, 'run-reopen')).phases.plan.status, 'pending');
      assert.equal(readJson(guardPath(cwd, 'run-reopen')).counters.iterations.count, 1);

      const rejected = reopenPhase('run-reopen', 'plan', { reason: 'review_reject' }, { cwd });
      assert.equal(rejected.ok, true);
      assert.equal(rejected.rejected, true);
      assert.equal(readJson(guardPath(cwd, 'run-reopen')).counters.iterations.count, 1);
    } finally {
      await removeTmpDir(cwd);
    }
  });
});

// ---------------------------------------------------------------------------
// Resume, schema fail-safe, isolation
// ---------------------------------------------------------------------------

describe('resume semantics', () => {
  test('in_progress verify resumes at verify and earlier phases skip', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-resume', 'atlas', { cwd });
      await completeThrough('run-resume', cwd, ['triage', 'context', 'spec', 'plan', 'execute']);
      enterPhase('run-resume', 'verify', { cwd });

      const resumed = initPipeline('run-resume', 'atlas', { cwd });
      assert.equal(resumed.resumePhase, 'verify');
      assert.equal(resumed.resumePolicy, 'reexecute');
      assert.equal(enterPhase('run-resume', 'execute', { cwd }).skip, true);
      assert.equal(nextPhase('run-resume', { cwd }), 'verify');
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('recover phase in_progress reports resumePolicy recover', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-recover-policy', 'athena', { cwd });
      await completeThrough('run-recover-policy', cwd, ['triage', 'context', 'spec', 'plan']);
      enterPhase('run-recover-policy', 'spawn', { cwd });
      const resumed = initPipeline('run-recover-policy', 'athena', { cwd });
      assert.equal(resumed.resumePhase, 'spawn');
      assert.equal(resumed.resumePolicy, 'recover');
    } finally {
      await removeTmpDir(cwd);
    }
  });
});

describe('schemaVersion and corrupt-file fail-safe', () => {
  test('future schemaVersion starts fresh and reports degraded', async () => {
    const cwd = await makeTmpDir();
    try {
      const p = pipelinePath(cwd, 'run-future');
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify({
        schemaVersion: 99,
        orchestrator: 'atlas',
        phases: { triage: { status: 'completed' } },
      }));
      const r = initPipeline('run-future', 'atlas', { cwd });
      assert.equal(r.degraded, true);
      assert.equal(r.resumePhase, 'triage');
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('garbage JSON and array payload fail open to a fresh ledger', async () => {
    const cwd = await makeTmpDir();
    try {
      const garbage = pipelinePath(cwd, 'run-garbage');
      mkdirSync(path.dirname(garbage), { recursive: true });
      writeFileSync(garbage, '{not-json');
      const g = initPipeline('run-garbage', 'atlas', { cwd });
      assert.equal(g.degraded, true);
      assert.equal(g.resumePhase, 'triage');

      const arr = pipelinePath(cwd, 'run-array');
      mkdirSync(path.dirname(arr), { recursive: true });
      writeFileSync(arr, '[1,2,3]');
      const a = initPipeline('run-array', 'atlas', { cwd });
      assert.equal(a.degraded, true);
      assert.equal(a.resumePhase, 'triage');
    } finally {
      await removeTmpDir(cwd);
    }
  });
});

describe('isolation and fail-open', () => {
  test('different runs are isolated', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-a', 'atlas', { cwd });
      initPipeline('run-b', 'atlas', { cwd });
      await completeNoCheckpoint('run-a', 'triage', cwd);
      assert.equal(nextPhase('run-a', { cwd }), 'context');
      assert.equal(nextPhase('run-b', { cwd }), 'triage');
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('missing runId fails open with degraded permissive results', () => {
    assert.equal(initPipeline('', 'atlas').degraded, true);
    assert.equal(enterPhase('', 'triage').proceed, true);
    assert.equal(beginAttempt('').allowed, true);
    assert.equal(reattempt('', { reopen: ['verify'] }).allowed, true);
    assert.equal(loopTick('', 'review').allowed, true);
    assert.equal(recordPhaseError('', 'verify', 'boom').shouldEscalate, false);
  });

  test('pipeline.json coexists with loop-guard.json without clobbering', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-coexist', 'atlas', { cwd });
      beginAttempt('run-coexist', { cwd });
      await completeNoCheckpoint('run-coexist', 'triage', cwd);
      assert.ok(existsSync(pipelinePath(cwd, 'run-coexist')));
      assert.ok(existsSync(guardPath(cwd, 'run-coexist')));
      assert.equal(readJson(guardPath(cwd, 'run-coexist')).counters.iterations.count, 1);
      assert.equal(readJson(pipelinePath(cwd, 'run-coexist')).phases.triage.status, 'completed');
    } finally {
      await removeTmpDir(cwd);
    }
  });
});

describe('isComplete', () => {
  test('required phases must be terminal while skippable pending phases do not block', async () => {
    const cwd = await makeTmpDir();
    try {
      initPipeline('run-done', 'atlas', { cwd });
      assert.equal(isComplete('run-done', { cwd }), false);
      const required = ['triage', 'execute', 'verify', 'review', 'finalize', 'ship', 'ci', 'complete'];
      for (const phaseId of required) await completeNoCheckpoint('run-done', phaseId, cwd);
      assert.equal(isComplete('run-done', { cwd }), true);
    } finally {
      await removeTmpDir(cwd);
    }
  });

  test('getPipelineState returns a fresh default on unknown run', () => {
    const state = getPipelineState('missing-run', { cwd: '/tmp/ao-missing-phase-runner' });
    assert.equal(state.schemaVersion, 1);
    assert.deepEqual(state.phases, {});
  });
});
