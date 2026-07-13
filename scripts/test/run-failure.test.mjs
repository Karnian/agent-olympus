import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRun, getActiveRunId } from '../lib/run-artifacts.mjs';
import {
  getPhaseSequence,
} from '../lib/phase-runner.mjs';
import {
  FAILURE_CODES_BY_CLASS,
  FAILURE_PHASES,
  RUN_FAILURE_SCHEMA_VERSION,
  finalizeFailedRun,
} from '../lib/run-failure.mjs';

const EXPECTED_CODES = {
  'task-outcome': [
    'verification_exhausted',
    'review_exhausted',
    'acceptance_criteria_unmet',
    'test_regression_unresolved',
  ],
  orchestration: [
    'phase_guard_exhausted',
    'worker_integration_failed',
    'recovery_state_invalid',
    'plan_validation_failed',
  ],
  infrastructure: [
    'provider_unavailable',
    'permission_denied',
    'environment_unavailable',
    'timeout',
  ],
  cancelled: ['user_cancelled'],
};

const EXPECTED_PHASES = [
  'preflight', 'triage', 'context', 'spec', 'plan', 'execute', 'verify',
  'spawn', 'monitor', 'wisdom', 'integrate', 'review', 'finalize', 'ship',
  'ci', 'complete',
];

const DEFAULT_FAILURE = {
  orchestrator: 'atlas',
  failureClass: 'task-outcome',
  code: 'verification_exhausted',
  phase: 'verify',
};
const RUN_FAILURE_URL = new URL('../lib/run-failure.mjs', import.meta.url).href;

function tempRoot(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'ao-run-failure-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function setupRunInRoot(root, orchestrator = 'atlas', failurePhase = orchestrator === 'athena' ? 'integrate' : 'verify') {
  const base = path.join(root, 'custom-runs');
  const stateDir = path.join(root, 'custom-state');
  const created = createRun(orchestrator, 'terminal failure test', { base, stateDir });
  assert.ok(created.runDir, 'test precondition: createRun must succeed');
  const now = new Date().toISOString();
  const ids = getPhaseSequence(orchestrator).map(item => item.id);
  const cut = ids.indexOf(failurePhase);
  assert.notEqual(cut, -1, 'test precondition: failure phase belongs to pipeline');
  const digest = 'a'.repeat(64);
  const phases = Object.fromEntries(ids.map((id, index) => [id, {
    status: index < cut ? 'completed' : (index === cut ? 'in_progress' : 'pending'),
    ...(index <= cut ? { startedAt: now, attempts: 1 } : {}),
    ...(index < cut ? { completedAt: now } : {}),
  }]));
  if (orchestrator === 'athena' && cut > ids.indexOf('monitor')) {
    const adapterRunId = 'a1b2c3d4e5f60718';
    phases.spawn.outputs = {
      teamSlug: 'athena-terminal-test',
      intendedWorkers: 'worker-a',
      spawnPath: 'adapter-only',
      launchState: 'durable',
      worktreeDigest: digest,
      adapterRunId,
    };
    phases.monitor.outputs = {
      teamSlug: 'athena-terminal-test',
      intendedWorkers: 'worker-a',
      terminalWorkers: 'worker-a',
      worktreeDigest: digest,
      adapterRunId,
    };
    writeFileSync(path.join(stateDir, 'team-athena-terminal-test.json'), JSON.stringify({
      teamName: 'athena-terminal-test',
      runId: adapterRunId,
      workers: [{ name: 'worker-a', status: 'completed' }],
    }), { mode: 0o600 });
  }
  writeFileSync(path.join(created.runDir, 'pipeline.json'), JSON.stringify({
    schemaVersion: 1,
    runId: created.runId,
    orchestrator,
    createdAt: now,
    updatedAt: now,
    attempt: 1,
    phases,
  }), { mode: 0o600 });
  return {
    root,
    base,
    stateDir,
    runId: created.runId,
    runDir: created.runDir,
    markerPath: path.join(created.runDir, 'terminal-failure.json'),
    pointerPath: path.join(stateDir, `ao-active-run-${orchestrator}.json`),
    summaryPath: path.join(created.runDir, 'summary.json'),
  };
}

function setupRun(t, orchestrator = 'atlas', failurePhase = orchestrator === 'athena' ? 'integrate' : 'verify') {
  return setupRunInRoot(tempRoot(t), orchestrator, failurePhase);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function mode(file) {
  return lstatSync(file).mode & 0o777;
}

function validMarker(runId, overrides = {}) {
  return {
    schemaVersion: RUN_FAILURE_SCHEMA_VERSION,
    runId,
    ...DEFAULT_FAILURE,
    failedAt: new Date().toISOString(),
    ...overrides,
  };
}

function assertRunStillActive(env, orchestrator = 'atlas') {
  assert.equal(readJson(env.summaryPath).status, 'running');
  assert.equal(getActiveRunId(orchestrator, { stateDir: env.stateDir }), env.runId);
}

function snapshotTerminalInputs(env, pointerPath = env.pointerPath) {
  const eventsPath = path.join(env.runDir, 'events.jsonl');
  return {
    summary: readFileSync(env.summaryPath),
    pipeline: readFileSync(path.join(env.runDir, 'pipeline.json')),
    events: existsSync(eventsPath) ? readFileSync(eventsPath) : null,
    pointer: readFileSync(pointerPath),
  };
}

function assertNoTerminalMutation(env, before, pointerPath = env.pointerPath) {
  const eventsPath = path.join(env.runDir, 'events.jsonl');
  assert.deepEqual(readFileSync(env.summaryPath), before.summary);
  assert.deepEqual(readFileSync(path.join(env.runDir, 'pipeline.json')), before.pipeline);
  assert.deepEqual(existsSync(eventsPath) ? readFileSync(eventsPath) : null, before.events);
  assert.deepEqual(readFileSync(pointerPath), before.pointer);
  assert.equal(existsSync(env.markerPath), false);
  const phase = readJson(path.join(env.runDir, 'pipeline.json')).phases[DEFAULT_FAILURE.phase];
  assert.equal(phase.status, 'in_progress');
  assert.equal(Object.hasOwn(phase, 'failureCode'), false);
}

test('published failure class/code and phase allowlists are exact', () => {
  assert.deepEqual(FAILURE_CODES_BY_CLASS, EXPECTED_CODES);
  assert.deepEqual(FAILURE_PHASES, EXPECTED_PHASES);
  assert.equal(Object.isFrozen(FAILURE_CODES_BY_CLASS), true);
  assert.equal(Object.values(FAILURE_CODES_BY_CLASS).every(Object.isFrozen), true);
  assert.equal(Object.isFrozen(FAILURE_PHASES), true);
});

test('finalizeFailedRun writes an immutable minimal marker, finalizes summary, and clears active pointer', (t) => {
  const env = setupRun(t, 'athena');
  chmodSync(env.runDir, 0o777);
  const failure = {
    orchestrator: 'athena',
    failureClass: 'orchestration',
    code: 'worker_integration_failed',
    phase: 'integrate',
  };

  const result = finalizeFailedRun(env.runId, failure, {
    base: env.base,
    stateDir: env.stateDir,
  });

  assert.equal(result.ok, true);
  assert.equal(result.markerPath, env.markerPath);
  assert.deepEqual(result.marker, readJson(env.markerPath));
  assert.deepEqual(Object.keys(result.marker), [
    'schemaVersion', 'runId', 'orchestrator', 'failureClass', 'code', 'phase', 'failedAt',
  ]);
  assert.equal(result.marker.schemaVersion, 1);
  assert.equal(result.marker.runId, env.runId);
  assert.equal(result.marker.orchestrator, 'athena');
  assert.equal(result.marker.failureClass, 'orchestration');
  assert.equal(result.marker.code, 'worker_integration_failed');
  assert.equal(result.marker.phase, 'integrate');
  assert.equal(Number.isFinite(Date.parse(result.marker.failedAt)), true);
  assert.equal(mode(env.runDir), 0o700);
  assert.equal(mode(env.markerPath), 0o600);
  assert.equal(existsSync(env.pointerPath), false);
  assert.equal(existsSync(path.join(env.runDir, '.terminal-failure.lock')), false);
  assert.equal(readdirSync(env.runDir).some((name) => name.startsWith('.tmp-')), false);

  const summary = readJson(env.summaryPath);
  assert.equal(summary.status, 'completed');
  assert.equal(summary.result, 'failure');
  assert.equal(summary.failureCode, 'worker_integration_failed');
  assert.equal(summary.failedPhase, 'integrate');
  assert.equal(summary.failureClass, undefined, 'finalizeRun receives only the agreed summary fields');
  assert.equal(summary.reason, undefined);

  const events = readFileSync(path.join(env.runDir, 'events.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, 'run_finalized');
  assert.equal(events.at(-1).detail.status, 'completed');
});

test('finalizeFailedRun recovers a trailing torn event and keeps run_finalized last', (t) => {
  const env = setupRun(t, 'atlas', 'verify');
  const eventsPath = path.join(env.runDir, 'events.jsonl');
  writeFileSync(eventsPath, [
    JSON.stringify({ type: 'before_damage', detail: 'kept' }),
    '{"type":"torn"',
  ].join('\n'), { mode: 0o600 });

  const result = finalizeFailedRun(env.runId, DEFAULT_FAILURE, {
    base: env.base,
    stateDir: env.stateDir,
  });

  assert.equal(result.ok, true);
  const valid = [];
  for (const line of readFileSync(eventsPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { valid.push(JSON.parse(line)); } catch {}
  }
  assert.deepEqual(valid.map(event => event.type), [
    'before_damage',
    'pipeline_phase_failed',
    'run_finalized',
  ]);
  assert.equal(valid.at(-1).type, 'run_finalized');
});

test('every exact class/code mapping is accepted', async (t) => {
  for (const [failureClass, codes] of Object.entries(EXPECTED_CODES)) {
    for (const code of codes) {
      await t.test(`${failureClass}/${code}`, (st) => {
        const env = setupRun(st, 'atlas', 'execute');
        const result = finalizeFailedRun(env.runId, {
          orchestrator: 'atlas',
          failureClass,
          code,
          phase: 'execute',
        }, { base: env.base, stateDir: env.stateDir });
        assert.equal(result.marker.failureClass, failureClass);
        assert.equal(result.marker.code, code);
      });
    }
  }
});

test('unknown enums and cross-class codes are rejected before filesystem mutation', () => {
  const invalid = [
    { ...DEFAULT_FAILURE, orchestrator: 'solo' },
    { ...DEFAULT_FAILURE, failureClass: 'product' },
    { ...DEFAULT_FAILURE, code: 'provider_unavailable' },
    { ...DEFAULT_FAILURE, code: 'raw_error_text' },
    { ...DEFAULT_FAILURE, phase: 'debug' },
  ];
  for (const failure of invalid) {
    assert.throws(() => finalizeFailedRun('atlas-valid-run', failure), /invalid|not allowed/);
  }
});

test('failure input rejects missing, raw reason, extra, symbol, prototype, and accessor fields', () => {
  const withSymbol = { ...DEFAULT_FAILURE };
  withSymbol[Symbol('hidden')] = 'secret';
  class FailureRecord {
    constructor() { Object.assign(this, DEFAULT_FAILURE); }
  }
  const withAccessor = { ...DEFAULT_FAILURE };
  Object.defineProperty(withAccessor, 'phase', { enumerable: true, get: () => 'verify' });

  const invalid = [
    null,
    { orchestrator: 'atlas', failureClass: 'task-outcome', code: 'verification_exhausted' },
    { ...DEFAULT_FAILURE, reason: 'raw provider stack trace' },
    { ...DEFAULT_FAILURE, extra: { prompt: 'secret' } },
    withSymbol,
    new FailureRecord(),
    withAccessor,
  ];
  for (const failure of invalid) {
    assert.throws(
      () => finalizeFailedRun('atlas-valid-run', failure),
      /exactly/,
    );
  }
});

test('unsafe run ids are rejected without path escape', (t) => {
  const root = tempRoot(t);
  const base = path.join(root, 'runs');
  const stateDir = path.join(root, 'state');
  const invalid = ['', '.', '..', '../escape', 'a/b', 'a\\b', '/absolute', '-leading', 'x'.repeat(129)];
  for (const runId of invalid) {
    assert.throws(
      () => finalizeFailedRun(runId, DEFAULT_FAILURE, { base, stateDir }),
      /invalid runId/,
    );
  }
  assert.equal(existsSync(path.join(root, 'escape')), false);
  assert.equal(existsSync(base), false);
});

test('missing run, mismatched summary, and mismatched active pointer fail before marker creation', async (t) => {
  await t.test('missing run', (st) => {
    const root = tempRoot(st);
    assert.throws(() => finalizeFailedRun('atlas-missing', DEFAULT_FAILURE, {
      base: path.join(root, 'runs'),
      stateDir: path.join(root, 'state'),
    }), /run directory|ENOENT/);
  });

  await t.test('summary mismatch', (st) => {
    const env = setupRun(st);
    const summary = readJson(env.summaryPath);
    writeFileSync(env.summaryPath, JSON.stringify({ ...summary, runId: 'other-run' }));
    assert.throws(() => finalizeFailedRun(env.runId, DEFAULT_FAILURE, {
      base: env.base, stateDir: env.stateDir,
    }), /summary identity mismatch/);
    assert.equal(existsSync(env.markerPath), false);
  });

  await t.test('pointer mismatch', (st) => {
    const env = setupRun(st);
    const pointer = readJson(env.pointerPath);
    writeFileSync(env.pointerPath, JSON.stringify({ ...pointer, runId: 'other-run' }));
    assert.throws(() => finalizeFailedRun(env.runId, DEFAULT_FAILURE, {
      base: env.base, stateDir: env.stateDir,
    }), /pointer identity mismatch/);
    assert.equal(existsSync(env.markerPath), false);
  });
});

test('invalid or future run start time is rejected before terminal mutation', (t) => {
  for (const startedAt of ['garbage', new Date(Date.now() + 30_000).toISOString()]) {
    const env = setupRun(t);
    const summary = readJson(env.summaryPath);
    writeFileSync(env.summaryPath, JSON.stringify({ ...summary, startedAt }), { mode: 0o600 });
    assert.throws(() => finalizeFailedRun(env.runId, DEFAULT_FAILURE, {
      base: env.base, stateDir: env.stateDir,
    }), /startedAt is invalid/);
    assert.equal(existsSync(env.markerPath), false);
    assert.equal(readJson(env.summaryPath).status, 'running');
    assert.equal(getActiveRunId('atlas', { stateDir: env.stateDir }), env.runId);
  }
});

test('Athena finalization requires exact adapter generation and code-verifiable workers', async (t) => {
  const mutations = [
    ['missing state', (env) => rmSync(path.join(env.stateDir, 'team-athena-terminal-test.json'))],
    ['stale generation', (env) => {
      const file = path.join(env.stateDir, 'team-athena-terminal-test.json');
      writeFileSync(file, JSON.stringify({ ...readJson(file), runId: 'ffffffffffffffff' }), { mode: 0o600 });
    }],
    ['stale monitor generation', (env) => {
      const file = path.join(env.runDir, 'pipeline.json');
      const pipeline = readJson(file);
      pipeline.phases.monitor.outputs.adapterRunId = 'ffffffffffffffff';
      writeFileSync(file, JSON.stringify(pipeline), { mode: 0o600 });
    }],
    ['native path', (env) => {
      const file = path.join(env.runDir, 'pipeline.json');
      const pipeline = readJson(file);
      pipeline.phases.spawn.outputs.spawnPath = 'native-or-mixed';
      pipeline.phases.spawn.outputs.adapterRunId = 'none';
      writeFileSync(file, JSON.stringify(pipeline), { mode: 0o600 });
    }],
    ['native fallback', (env) => {
      const file = path.join(env.stateDir, 'team-athena-terminal-test.json');
      const state = readJson(file);
      state.workers[0]._providerFallback = { provider: 'claude' };
      writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
    }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, (st) => {
      const env = setupRun(st, 'athena', 'integrate');
      mutate(env);
      assert.throws(() => finalizeFailedRun(env.runId, {
        orchestrator: 'athena', failureClass: 'orchestration',
        code: 'worker_integration_failed', phase: 'integrate',
      }, { base: env.base, stateDir: env.stateDir }), /Athena/);
      assertRunStillActive(env, 'athena');
    });
  }
});

test('pre-existing duplicate, corrupt, future-schema, and future-time markers fail closed', async (t) => {
  const cases = [
    ['duplicate', (env) => JSON.stringify(validMarker(env.runId)), /not backed by a failed pipeline phase/],
    ['corrupt-json', () => '{not-json', /corrupt/],
    ['corrupt-shape', (env) => JSON.stringify({ ...validMarker(env.runId), reason: 'raw' }), /corrupt/],
    ['older-schema', (env) => JSON.stringify(validMarker(env.runId, { schemaVersion: 0 })), /corrupt/],
    ['future-schema', (env) => JSON.stringify({ schemaVersion: 2, runId: env.runId }), /future schema/],
    ['future-time', (env) => JSON.stringify(validMarker(env.runId, {
      failedAt: new Date(Date.now() + 3_600_000).toISOString(),
    })), /in the future/],
  ];

  for (const [name, content, expected] of cases) {
    await t.test(name, (st) => {
      const env = setupRun(st);
      writeFileSync(env.markerPath, content(env), { mode: 0o600 });
      assert.throws(() => finalizeFailedRun(env.runId, DEFAULT_FAILURE, {
        base: env.base, stateDir: env.stateDir,
      }), expected);
      assertRunStillActive(env);
    });
  }
});

test('a second finalization cannot overwrite or reclassify a valid marker', (t) => {
  const env = setupRun(t);
  const first = finalizeFailedRun(env.runId, DEFAULT_FAILURE, {
    base: env.base, stateDir: env.stateDir,
  });
  const bytes = readFileSync(env.markerPath, 'utf8');

  assert.throws(() => finalizeFailedRun(env.runId, {
    orchestrator: 'atlas',
    failureClass: 'infrastructure',
    code: 'timeout',
    phase: 'execute',
  }, { base: env.base, stateDir: env.stateDir }), /already exists/);
  assert.equal(readFileSync(env.markerPath, 'utf8'), bytes);
  assert.deepEqual(readJson(env.markerPath), first.marker);
});

test('an existing finalization lock fails closed without writing a marker', (t) => {
  const env = setupRun(t);
  const lock = path.join(env.runDir, '.terminal-failure.lock');
  writeFileSync(lock, 'occupied', { mode: 0o600 });
  assert.throws(() => finalizeFailedRun(env.runId, DEFAULT_FAILURE, {
    base: env.base, stateDir: env.stateDir,
  }), /lock is unsafe|already in progress/);
  assert.equal(existsSync(env.markerPath), false);
  assertRunStillActive(env);
});

test('an exact marker resumes finalization after active-pointer removal failed', {
  skip: process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0),
}, (t) => {
  const env = setupRun(t);
  chmodSync(env.stateDir, 0o500);
  try {
    assert.throws(() => finalizeFailedRun(env.runId, DEFAULT_FAILURE, {
      base: env.base, stateDir: env.stateDir,
    }), /pointer was not removed|active-run-pointer-not-cleared/);
    assert.equal(existsSync(env.markerPath), true, 'marker must precede finalization');
    assert.equal(mode(env.markerPath), 0o600);
    assert.equal(existsSync(env.pointerPath), true);
    assert.equal(readJson(env.summaryPath).result, 'failure');
  } finally {
    chmodSync(env.stateDir, 0o700);
  }
  const resumed = finalizeFailedRun(env.runId, DEFAULT_FAILURE, {
    base: env.base, stateDir: env.stateDir,
  });
  assert.equal(resumed.ok, true);
  assert.equal(existsSync(env.pointerPath), false);
  assert.equal(readJson(env.summaryPath).result, 'failure');
});

test('symlink run directories, summaries, markers, and active pointers are rejected', {
  skip: process.platform === 'win32',
}, async (t) => {
  await t.test('run directory', (st) => {
    const root = tempRoot(st);
    const base = path.join(root, 'runs');
    const target = path.join(root, 'target');
    const stateDir = path.join(root, 'state');
    writeFileSync(target, 'not a directory');
    // A symlink is enough to prove no-follow behavior; its target type is irrelevant.
    symlinkSync(target, path.join(root, 'run-link'));
    assert.throws(() => finalizeFailedRun('run-link', DEFAULT_FAILURE, { base: root, stateDir }), /run directory/);
    assert.equal(existsSync(base), false);
  });

  for (const kind of ['summary', 'marker', 'pointer']) {
    await t.test(kind, (st) => {
      const env = setupRun(st);
      const external = path.join(env.root, `${kind}-external.json`);
      const target = kind === 'summary' ? env.summaryPath
        : kind === 'marker' ? env.markerPath
          : env.pointerPath;
      const original = kind === 'marker'
        ? JSON.stringify(validMarker(env.runId))
        : readFileSync(target, 'utf8');
      if (existsSync(target)) rmSync(target);
      writeFileSync(external, original);
      symlinkSync(external, target);
      assert.throws(() => finalizeFailedRun(env.runId, DEFAULT_FAILURE, {
        base: env.base, stateDir: env.stateDir,
      }), /unsafe|corrupt/);
      assert.equal(existsSync(external), true);
    });
  }
});

test('default .ao ancestor link is rejected before any terminal mutation', {
  skip: process.platform === 'win32',
}, (t) => {
  const env = setupRun(t);
  const workspace = path.join(env.root, 'workspace');
  const externalAo = path.join(env.root, 'external-ao');
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(path.join(externalAo, 'artifacts'), { recursive: true, mode: 0o700 });
  symlinkSync(env.base, path.join(externalAo, 'artifacts', 'runs'), 'dir');
  symlinkSync(env.stateDir, path.join(externalAo, 'state'), 'dir');
  symlinkSync(externalAo, path.join(workspace, '.ao'), 'dir');
  const before = snapshotTerminalInputs(env);
  const script = [
    `import { finalizeFailedRun } from ${JSON.stringify(RUN_FAILURE_URL)};`,
    `const failure = ${JSON.stringify(DEFAULT_FAILURE)};`,
    `try { finalizeFailedRun(${JSON.stringify(env.runId)}, failure); process.exitCode = 2; }`,
    `catch (error) { process.stdout.write(String(error?.message || error)); }`,
  ].join('\n');

  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: workspace,
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stdout, /unsafe|trusted root|finalization failed/);
  assertNoTerminalMutation(env, before);
});

test('custom-base parent link is rejected before any terminal mutation', {
  skip: process.platform === 'win32',
}, (t) => {
  const env = setupRun(t);
  const trustedRoot = path.join(env.root, 'trusted-workspace');
  mkdirSync(trustedRoot, { mode: 0o700 });
  symlinkSync(env.root, path.join(trustedRoot, 'linked-parent'), 'dir');
  const before = snapshotTerminalInputs(env);

  assert.throws(() => finalizeFailedRun(env.runId, DEFAULT_FAILURE, {
    base: path.join(trustedRoot, 'linked-parent', 'custom-runs'),
    stateDir: path.join(trustedRoot, 'linked-parent', 'custom-state'),
    trustedRoot,
  }), /unsafe|trusted root|finalization failed/);
  assertNoTerminalMutation(env, before);
});

test('linked state directory is rejected before pointer validation can mutate the run', {
  skip: process.platform === 'win32',
}, (t) => {
  const env = setupRun(t);
  const linkedStateDir = path.join(env.root, 'linked-state');
  symlinkSync(env.stateDir, linkedStateDir, 'dir');
  const before = snapshotTerminalInputs(env);

  assert.throws(() => finalizeFailedRun(env.runId, DEFAULT_FAILURE, {
    base: env.base,
    stateDir: linkedStateDir,
    trustedRoot: env.root,
  }), /unsafe|trusted root|finalization failed/);
  assertNoTerminalMutation(env, before);
});

test('explicit trustedRoot supports a legitimate custom failure-finalization base', {
  skip: process.platform === 'win32',
}, (t) => {
  const fixtureRoot = mkdtempSync(path.join(process.cwd(), '.ao-run-failure-trusted-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const env = setupRunInRoot(fixtureRoot);
  const childCwd = tempRoot(t);
  const script = [
    `import { finalizeFailedRun } from ${JSON.stringify(RUN_FAILURE_URL)};`,
    `const result = finalizeFailedRun(${JSON.stringify(env.runId)}, ${JSON.stringify(DEFAULT_FAILURE)}, ${JSON.stringify({
      base: env.base,
      stateDir: env.stateDir,
      trustedRoot: fixtureRoot,
    })});`,
    `process.stdout.write(JSON.stringify(result));`,
  ].join('\n');

  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: childCwd,
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.equal(JSON.parse(child.stdout).ok, true);
  assert.equal(readJson(env.summaryPath).result, 'failure');
  assert.equal(existsSync(env.pointerPath), false);
});
