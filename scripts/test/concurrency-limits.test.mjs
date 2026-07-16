import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  CONCURRENCY_SCHEMA_VERSION,
  loadConcurrencyLimits,
  readActiveConcurrencyCounts,
  releaseConcurrencyReservation,
  releaseHookConcurrency,
  reserveWorkerBatchConcurrency,
  validateWorkerBatchConcurrency,
} from '../lib/concurrency-limits.mjs';
import { spawnTeam } from '../lib/worker-spawn.mjs';
import { snapshotPath, writeSnapshot } from '../lib/supervisor-state.mjs';

function temporaryDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), 'ao-concurrency-limits-'));
}

const LEDGER_CHILD = fileURLToPath(new URL('./fixtures/concurrency-ledger-child.mjs', import.meta.url));
const CONCURRENCY_GATE = fileURLToPath(new URL('../concurrency-gate.mjs', import.meta.url));

async function waitForFiles(files, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!files.every(file => existsSync(file))) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for: ${files.join(', ')}`);
    await sleep(10);
  }
}

function waitForExit(child) {
  if (child.exitCode != null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit, rejectExit) => {
    child.once('exit', resolveExit);
    child.once('error', rejectExit);
  });
}

function runGate(cwd, toolName) {
  const result = spawnSync(process.execPath, [CONCURRENCY_GATE], {
    cwd,
    input: JSON.stringify({
      tool_name: toolName,
      tool_input: { subagent_type: 'agent-olympus:executor' },
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      AO_CONCURRENCY_GLOBAL: '1',
      AO_CONCURRENCY_CLAUDE: '1',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

// Exact compatibility model of the 881f932 schema-v1 reader: unknown top-level
// fields are ignored, but any explicit version other than 1 is rejected.
function readWithBaselineV1Shape(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || (parsed.schemaVersion != null && parsed.schemaVersion !== 1)
    || !Array.isArray(parsed.activeTasks)
    || (parsed.queue != null && !Array.isArray(parsed.queue))) {
    throw new Error('concurrency ledger is malformed');
  }
  return { activeTasks: parsed.activeTasks, queue: parsed.queue || [] };
}

describe('shared concurrency limits', () => {
  it('loads JSONC configuration and applies environment overrides', () => {
    const root = temporaryDirectory();
    try {
      mkdirSync(path.join(root, 'config'));
      writeFileSync(path.join(root, 'config', 'model-routing.jsonc'), `{
        // shared by hooks and adapter batches
        "concurrency": {
          "maxParallelTasks": 7,
          "maxClaudeWorkers": 6,
          "maxCodexWorkers": 4,
          "maxGeminiWorkers": 3
        }
      }`);
      assert.deepEqual(loadConcurrencyLimits({
        pluginRoot: root,
        env: { AO_CONCURRENCY_CODEX: '2' },
      }), { global: 7, claude: 6, codex: 2, gemini: 3 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts only fresh provider tasks and fails closed on corrupt state', () => {
    const root = temporaryDirectory();
    try {
      const stateDir = path.join(root, '.ao', 'state');
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const now = Date.now();
      writeFileSync(path.join(stateDir, 'ao-concurrency.json'), JSON.stringify({
        activeTasks: [
          { id: 'fresh', provider: 'claude', startedAt: new Date(now - 1000).toISOString() },
          { id: 'stale', provider: 'codex', startedAt: new Date(now - 10 * 60 * 1000).toISOString() },
        ],
      }), { mode: 0o600 });
      assert.deepEqual(readActiveConcurrencyCounts(root, { now }), {
        global: 1, claude: 1, codex: 0, gemini: 0,
      });
      writeFileSync(path.join(stateDir, 'ao-concurrency.json'), '{broken', { mode: 0o600 });
      assert.equal(readActiveConcurrencyCounts(root).global, Infinity);
      const denied = reserveWorkerBatchConcurrency(root, [{ name: 'unsafe', type: 'claude' }], {
        teamName: 'unsafe-team',
        runId: 'cccccccccccccccc',
        limits: { global: 10, claude: 10, codex: 10, gemini: 10 },
      });
      assert.equal(denied.ok, false);
      assert.equal(denied.unsafe, true);
      assert.match(denied.errors.join('\n'), /malformed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('quarantines repeated malformed ledger content without admitting during recovery', () => {
    const root = temporaryDirectory();
    try {
      const stateDir = path.join(root, '.ao', 'state');
      const ledgerPath = path.join(stateDir, 'ao-concurrency.json');
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const now = Date.now();
      const limits = { global: 10, claude: 10, codex: 10, gemini: 10 };
      writeFileSync(ledgerPath, '{first-broken', { mode: 0o600 });

      const first = reserveWorkerBatchConcurrency(root, [{ name: 'blocked', type: 'claude' }], {
        teamName: 'blocked-a', runId: 'aaaaaaaaaaaaaaaa', limits, now,
      });
      assert.equal(first.ok, false);
      assert.equal(first.unsafe, true);
      assert.match(first.errors.join('\n'), /malformed JSON/);
      assert.match(first.errors.join('\n'), new RegExp(ledgerPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(first.errors.join('\n'), /Remediation:/);
      let quarantines = readdirSync(stateDir)
        .filter(file => file.startsWith('ao-concurrency.json.corrupt-'));
      assert.equal(quarantines.length, 1);
      assert.equal(readFileSync(path.join(stateDir, quarantines[0]), 'utf8'), '{first-broken');
      assert.equal(readActiveConcurrencyCounts(root, { now }).global, Infinity);

      writeFileSync(ledgerPath, '{second-broken', { mode: 0o600 });
      const second = reserveWorkerBatchConcurrency(root, [{ name: 'blocked', type: 'claude' }], {
        teamName: 'blocked-b', runId: 'bbbbbbbbbbbbbbbb', limits, now: now + 1,
      });
      assert.equal(second.ok, false);
      quarantines = readdirSync(stateDir)
        .filter(file => file.startsWith('ao-concurrency.json.corrupt-'));
      assert.equal(quarantines.length, 2);
      assert.equal(new Set(quarantines).size, 2);
      assert.ok(quarantines.some(file => readFileSync(path.join(stateDir, file), 'utf8')
        === '{second-broken'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('quarantines the exact bytes of malformed non-UTF-8 ledger content', () => {
    const root = temporaryDirectory();
    try {
      const stateDir = path.join(root, '.ao', 'state');
      const ledgerPath = path.join(stateDir, 'ao-concurrency.json');
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      // Invalid UTF-8 is placed inside an otherwise parseable JSON string so
      // replacement-character decoding cannot accidentally normalize it.
      const corrupt = Buffer.concat([
        Buffer.from('{"schemaVersion":2,"activeTasks":[],"queue":["'),
        Buffer.from([0xff, 0xfe]),
        Buffer.from('"]}'),
      ]);
      writeFileSync(ledgerPath, corrupt, { mode: 0o600 });

      const denied = reserveWorkerBatchConcurrency(root, [{ name: 'blocked', type: 'claude' }], {
        teamName: 'binary-recovery',
        runId: 'aaaaaaaaaaaaaaaa',
        limits: { global: 2, claude: 2, codex: 2, gemini: 2 },
      });
      assert.equal(denied.ok, false);
      assert.match(denied.errors.join('\n'), /not valid UTF-8/);
      const quarantine = readdirSync(stateDir)
        .find(file => file.startsWith('ao-concurrency.json.corrupt-'));
      assert.deepEqual(readFileSync(path.join(stateDir, quarantine)), corrupt);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses schema v2 so the baseline v1 reader rejects a recovery barrier', () => {
    const root = temporaryDirectory();
    try {
      const stateDir = path.join(root, '.ao', 'state');
      const ledgerPath = path.join(stateDir, 'ao-concurrency.json');
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      writeFileSync(ledgerPath, '{broken', { mode: 0o600 });

      const denied = reserveWorkerBatchConcurrency(root, [{ name: 'blocked', type: 'claude' }], {
        teamName: 'schema-boundary',
        runId: 'aaaaaaaaaaaaaaaa',
        limits: { global: 2, claude: 2, codex: 2, gemini: 2 },
      });
      assert.equal(denied.ok, false);
      const raw = readFileSync(ledgerPath, 'utf8');
      const recovered = JSON.parse(raw);
      assert.equal(CONCURRENCY_SCHEMA_VERSION, 2);
      assert.equal(recovered.schemaVersion, 2);
      assert.equal(recovered.recovery.kind, 'corrupt-ledger');
      assert.throws(() => readWithBaselineV1Shape(raw), /ledger is malformed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns a blocking hook decision on the first corrupt read and throughout recovery', () => {
    const root = temporaryDirectory();
    try {
      const stateDir = path.join(root, '.ao', 'state');
      const ledgerPath = path.join(stateDir, 'ao-concurrency.json');
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      writeFileSync(ledgerPath, '{broken', { mode: 0o600 });

      const first = runGate(root, 'Task');
      assert.equal(first.decision, 'block');
      assert.match(first.reason, /recovery barrier blocks admission/);
      assert.ok(first.reason.includes(ledgerPath));
      const second = runGate(root, 'Agent');
      assert.equal(second.decision, 'block');
      assert.match(second.reason, /recovery barrier blocks admission/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('quarantines malformed schema and entry content after filesystem validation', () => {
    const malformedCases = [
      ['empty', ''],
      ['schema', JSON.stringify({ schemaVersion: 2, activeTasks: 'not-an-array', queue: [] })],
      ['entry', JSON.stringify({
        schemaVersion: 2,
        activeTasks: [{ id: '', provider: 'claude', startedAt: new Date().toISOString() }],
        queue: [],
      })],
    ];
    for (const [label, content] of malformedCases) {
      const root = temporaryDirectory();
      try {
        const stateDir = path.join(root, '.ao', 'state');
        const ledgerPath = path.join(stateDir, 'ao-concurrency.json');
        mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        writeFileSync(ledgerPath, content, { mode: 0o600 });
        const denied = reserveWorkerBatchConcurrency(root, [{ name: label, type: 'claude' }], {
          teamName: `${label}-recovery`,
          runId: 'aaaaaaaaaaaaaaaa',
          limits: { global: 2, claude: 2, codex: 2, gemini: 2 },
        });
        assert.equal(denied.ok, false, label);
        assert.equal(denied.unsafe, true, label);
        assert.equal(readdirSync(stateDir)
          .filter(file => file.startsWith('ao-concurrency.json.corrupt-')).length, 1, label);
        const quarantine = readdirSync(stateDir)
          .find(file => file.startsWith('ao-concurrency.json.corrupt-'));
        assert.equal(readFileSync(path.join(stateDir, quarantine), 'utf8'), content, label);
        assert.equal(JSON.parse(readFileSync(ledgerPath, 'utf8')).recovery.kind,
          'corrupt-ledger', label);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('leaves unknown ledger versions untouched and blocks admission', () => {
    for (const version of [0, 3, 99]) {
      const root = temporaryDirectory();
      try {
        const stateDir = path.join(root, '.ao', 'state');
        const ledgerPath = path.join(stateDir, 'ao-concurrency.json');
        mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        const content = JSON.stringify({ schemaVersion: version, activeTasks: [], queue: [] });
        writeFileSync(ledgerPath, content, { mode: 0o600 });

        const denied = reserveWorkerBatchConcurrency(root, [{ name: 'blocked', type: 'claude' }], {
          teamName: 'unknown-version',
          runId: 'aaaaaaaaaaaaaaaa',
          limits: { global: 2, claude: 2, codex: 2, gemini: 2 },
        });
        assert.equal(denied.ok, false, String(version));
        assert.equal(denied.unsafe, true, String(version));
        assert.match(denied.errors.join('\n'), /schemaVersion .* is unsupported/, String(version));
        assert.equal(readFileSync(ledgerPath, 'utf8'), content, String(version));
        assert.equal(readdirSync(stateDir)
          .some(file => file.startsWith('ao-concurrency.json.corrupt-')), false, String(version));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('quarantines non-integer schemaVersion content instead of treating it as future state', () => {
    for (const version of [null, '2', true, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const root = temporaryDirectory();
      try {
        const stateDir = path.join(root, '.ao', 'state');
        const ledgerPath = path.join(stateDir, 'ao-concurrency.json');
        mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        const content = JSON.stringify({ schemaVersion: version, activeTasks: [], queue: [] });
        writeFileSync(ledgerPath, content, { mode: 0o600 });

        const denied = reserveWorkerBatchConcurrency(root, [{ name: 'blocked', type: 'claude' }], {
          teamName: 'malformed-version',
          runId: 'aaaaaaaaaaaaaaaa',
          limits: { global: 2, claude: 2, codex: 2, gemini: 2 },
        });
        assert.equal(denied.ok, false, String(version));
        assert.equal(denied.unsafe, true, String(version));
        assert.match(denied.errors.join('\n'), /schemaVersion is malformed/, String(version));
        const quarantine = readdirSync(stateDir)
          .find(file => file.startsWith('ao-concurrency.json.corrupt-'));
        assert.ok(quarantine, String(version));
        assert.equal(readFileSync(path.join(stateDir, quarantine), 'utf8'), content, String(version));
        assert.equal(JSON.parse(readFileSync(ledgerPath, 'utf8')).recovery.kind,
          'corrupt-ledger', String(version));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('defaults only absent legacy fields and fails closed on explicit nulls', () => {
    const limits = { global: 2, claude: 2, codex: 2, gemini: 2 };

    const v1RecoveryRoot = temporaryDirectory();
    try {
      const stateDir = path.join(v1RecoveryRoot, '.ao', 'state');
      const ledgerPath = path.join(stateDir, 'ao-concurrency.json');
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const original = JSON.stringify({
        schemaVersion: 1, activeTasks: [], queue: [], recovery: null,
      });
      writeFileSync(ledgerPath, original, { mode: 0o600 });
      const denied = reserveWorkerBatchConcurrency(
        v1RecoveryRoot,
        [{ name: 'blocked', type: 'claude' }],
        { teamName: 'v1-null-recovery', runId: 'aaaaaaaaaaaaaaaa', limits },
      );
      assert.equal(denied.ok, false);
      assert.match(denied.errors.join('\n'), /v1 contains unsupported recovery metadata/);
      assert.equal(readFileSync(ledgerPath, 'utf8'), original);
      assert.equal(readdirSync(stateDir)
        .some(file => file.startsWith('ao-concurrency.json.corrupt-')), false);
    } finally {
      rmSync(v1RecoveryRoot, { recursive: true, force: true });
    }

    const nullVersionRoot = temporaryDirectory();
    try {
      const stateDir = path.join(nullVersionRoot, '.ao', 'state');
      const ledgerPath = path.join(stateDir, 'ao-concurrency.json');
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const original = JSON.stringify({ schemaVersion: null, activeTasks: [], queue: [] });
      writeFileSync(ledgerPath, original, { mode: 0o600 });
      const denied = reserveWorkerBatchConcurrency(
        nullVersionRoot,
        [{ name: 'blocked', type: 'claude' }],
        { teamName: 'null-version', runId: 'bbbbbbbbbbbbbbbb', limits },
      );
      assert.equal(denied.ok, false);
      assert.match(denied.errors.join('\n'), /schemaVersion is malformed/);
      const quarantine = readdirSync(stateDir)
        .find(file => file.startsWith('ao-concurrency.json.corrupt-'));
      assert.equal(readFileSync(path.join(stateDir, quarantine), 'utf8'), original);
      assert.equal(JSON.parse(readFileSync(ledgerPath, 'utf8')).recovery.kind, 'corrupt-ledger');
    } finally {
      rmSync(nullVersionRoot, { recursive: true, force: true });
    }

    const nullKindRoot = temporaryDirectory();
    try {
      const stateDir = path.join(nullKindRoot, '.ao', 'state');
      const ledgerPath = path.join(stateDir, 'ao-concurrency.json');
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const now = Date.now();
      writeFileSync(path.join(stateDir, 'team-live-team.json'), JSON.stringify({
        teamName: 'live-team',
        runId: 'cccccccccccccccc',
        _concurrencyReservation: {
          schemaVersion: 1,
          reservationId: 'live-reservation',
          entryIds: ['live-entry'],
          reservedAt: new Date(now - 1000).toISOString(),
        },
        workers: [{
          name: 'live-worker',
          type: 'claude',
          status: 'running',
          startedAt: new Date(now - 1000).toISOString(),
          _concurrencyEntryId: 'live-entry',
        }],
      }), { mode: 0o600 });
      writeFileSync(ledgerPath, JSON.stringify({
        schemaVersion: 2,
        activeTasks: [{
          id: 'live-entry',
          reservationId: 'live-reservation',
          kind: null,
          provider: 'claude',
          startedAt: new Date(now - 1000).toISOString(),
          ownerPid: process.pid,
          teamName: 'live-team',
          runId: 'cccccccccccccccc',
          workerName: 'live-worker',
          workerIndex: 0,
        }],
        queue: [],
      }), { mode: 0o600 });
      const released = releaseHookConcurrency(
        nullKindRoot,
        { provider: 'claude', isSubagentStop: true },
        { now },
      );
      assert.deepEqual({ ok: released.ok, released: released.released }, { ok: true, released: 0 });
      assert.equal(readActiveConcurrencyCounts(nullKindRoot, { now }).global, Infinity);
      const recovered = JSON.parse(readFileSync(ledgerPath, 'utf8'));
      assert.equal(recovered.recovery.kind, 'corrupt-ledger');
      assert.equal(recovered.activeTasks[0].kind, 'team');
    } finally {
      rmSync(nullKindRoot, { recursive: true, force: true });
    }
  });

  it('reconstructs durable team reservations but retains the unknown-reservation barrier', () => {
    const root = temporaryDirectory();
    try {
      const stateDir = path.join(root, '.ao', 'state');
      const ledgerPath = path.join(stateDir, 'ao-concurrency.json');
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const now = Date.now();
      const reservedAt = new Date(now - 1000).toISOString();
      writeFileSync(path.join(stateDir, 'team-recovery-team.json'), JSON.stringify({
        teamName: 'recovery-team',
        runId: 'aaaaaaaaaaaaaaaa',
        _concurrencyReservation: {
          schemaVersion: 1,
          reservationId: 'durable-reservation',
          entryIds: ['durable-entry'],
          reservedAt,
        },
        workers: [{
          name: 'durable-worker',
          type: 'claude',
          model: 'sonnet',
          status: 'running',
          startedAt: reservedAt,
          _concurrencyEntryId: 'durable-entry',
        }],
      }), { mode: 0o600 });
      writeFileSync(ledgerPath, 'not-json', { mode: 0o600 });

      assert.equal(readActiveConcurrencyCounts(root, { now }).global, Infinity);
      const recovered = JSON.parse(readFileSync(ledgerPath, 'utf8'));
      assert.equal(recovered.activeTasks.length, 1);
      assert.equal(recovered.activeTasks[0].id, 'durable-entry');
      assert.equal(recovered.recovery.kind, 'corrupt-ledger');

      const afterBarrier = now + (3 * 60 * 1000) + 1;
      assert.deepEqual(readActiveConcurrencyCounts(root, { now: afterBarrier }), {
        global: 1, claude: 1, codex: 0, gemini: 0,
      });
      const settled = JSON.parse(readFileSync(ledgerPath, 'utf8'));
      assert.equal('recovery' in settled, false);
      assert.equal(settled.activeTasks.length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('re-scans durable teams written during recovery before reopening admission', () => {
    const root = temporaryDirectory();
    try {
      const stateDir = path.join(root, '.ao', 'state');
      const ledgerPath = path.join(stateDir, 'ao-concurrency.json');
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const now = Date.now();
      const reservedAt = new Date(now - 1000).toISOString();
      const limits = { global: 1, claude: 1, codex: 1, gemini: 1 };
      writeFileSync(ledgerPath, '{broken', { mode: 0o600 });

      const initial = reserveWorkerBatchConcurrency(root, [{ name: 'blocked', type: 'claude' }], {
        teamName: 'initial-probe', runId: 'aaaaaaaaaaaaaaaa', limits, now,
      });
      assert.equal(initial.ok, false);
      assert.equal(JSON.parse(readFileSync(ledgerPath, 'utf8')).activeTasks.length, 0);

      // This mirrors spawnTeam's launch window: its reservation existed in the
      // corrupt ledger, but its team file became durable after the first scan.
      writeFileSync(path.join(stateDir, 'team-late-team.json'), JSON.stringify({
        teamName: 'late-team',
        runId: 'bbbbbbbbbbbbbbbb',
        _concurrencyReservation: {
          schemaVersion: 1,
          reservationId: 'late-reservation',
          entryIds: ['late-entry'],
          reservedAt,
        },
        workers: [{
          name: 'late-worker',
          type: 'claude',
          status: 'running',
          startedAt: reservedAt,
          _concurrencyEntryId: 'late-entry',
        }],
      }), { mode: 0o600 });

      const afterBarrier = now + (3 * 60 * 1000) + 1;
      assert.deepEqual(readActiveConcurrencyCounts(root, { now: afterBarrier }), {
        global: 1, claude: 1, codex: 0, gemini: 0,
      });
      const denied = reserveWorkerBatchConcurrency(root, [{ name: 'new', type: 'claude' }], {
        teamName: 'new-team', runId: 'cccccccccccccccc', limits, now: afterBarrier + 1,
      });
      assert.equal(denied.ok, false);
      assert.match(denied.errors.join('\n'), /concurrency limit exceeded/);
      const settled = JSON.parse(readFileSync(ledgerPath, 'utf8'));
      assert.equal('recovery' in settled, false);
      assert.deepEqual(settled.activeTasks.map(entry => entry.id), ['late-entry']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps unsafe ledger artifacts blocking and reports stable remediation paths', () => {
    const root = temporaryDirectory();
    try {
      const stateDir = path.join(root, '.ao', 'state');
      const ledgerPath = path.join(stateDir, 'ao-concurrency.json');
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      writeFileSync(ledgerPath, '{broken', { mode: 0o600 });
      chmodSync(ledgerPath, 0o644);
      const denied = reserveWorkerBatchConcurrency(root, [{ name: 'unsafe', type: 'claude' }], {
        teamName: 'unsafe-ledger',
        runId: 'aaaaaaaaaaaaaaaa',
        limits: { global: 2, claude: 2, codex: 2, gemini: 2 },
      });
      assert.equal(denied.ok, false);
      assert.match(denied.errors.join('\n'), /concurrency state unavailable/);
      assert.match(denied.errors.join('\n'), /Remediation: restore owner-only access/);
      assert.ok(denied.errors.join('\n').includes(stateDir));
      assert.ok(denied.errors.join('\n').includes(ledgerPath));
      assert.equal(readdirSync(stateDir)
        .some(file => file.startsWith('ao-concurrency.json.corrupt-')), false);
      assert.equal(readFileSync(ledgerPath, 'utf8'), '{broken');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires owner-private 0700 concurrency directories', () => {
    if (process.platform === 'win32') return;
    const cases = ['ao', 'state'].flatMap(target => [0o755, 0o750, 0o711]
      .map(mode => ({ target, mode })));
    for (const { target, mode } of cases) {
      const root = temporaryDirectory();
      try {
        const aoDir = path.join(root, '.ao');
        const stateDir = path.join(aoDir, 'state');
        mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        chmodSync(target === 'ao' ? aoDir : stateDir, mode);
        const denied = reserveWorkerBatchConcurrency(root, [{ name: 'blocked', type: 'claude' }], {
          teamName: 'unsafe-directory',
          runId: 'aaaaaaaaaaaaaaaa',
          limits: { global: 2, claude: 2, codex: 2, gemini: 2 },
        });
        const label = `${target}:${mode.toString(8)}`;
        assert.equal(denied.ok, false, label);
        assert.equal(denied.unsafe, true, label);
        assert.match(denied.errors.join('\n'), /directory .* is unsafe/, label);
        assert.equal(existsSync(path.join(stateDir, 'ao-concurrency.json')), false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('reports an unwritable state directory without replacing the corrupt ledger', {
    skip: process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0),
  }, () => {
    const root = temporaryDirectory();
    const stateDir = path.join(root, '.ao', 'state');
    const ledgerPath = path.join(stateDir, 'ao-concurrency.json');
    try {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      writeFileSync(ledgerPath, '{broken', { mode: 0o600 });
      chmodSync(stateDir, 0o500);
      const denied = reserveWorkerBatchConcurrency(root, [{ name: 'blocked', type: 'claude' }], {
        teamName: 'unwritable-state',
        runId: 'aaaaaaaaaaaaaaaa',
        limits: { global: 2, claude: 2, codex: 2, gemini: 2 },
      });
      assert.equal(denied.ok, false);
      assert.ok(denied.errors.join('\n').includes(stateDir));
      assert.ok(denied.errors.join('\n').includes(ledgerPath));
      assert.match(denied.errors.join('\n'), /Remediation:/);
      assert.equal(readFileSync(ledgerPath, 'utf8'), '{broken');
    } finally {
      try { chmodSync(stateDir, 0o700); } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not quarantine symlink, hardlink, or oversized ledger artifacts', () => {
    const cases = [
      ['symlink', (root, ledgerPath) => {
        const target = path.join(root, 'target.json');
        writeFileSync(target, '{broken', { mode: 0o600 });
        symlinkSync(target, ledgerPath);
      }],
      ['hardlink', (root, ledgerPath) => {
        const target = path.join(root, 'target.json');
        writeFileSync(target, '{broken', { mode: 0o600 });
        linkSync(target, ledgerPath);
      }],
      ['oversized', (_root, ledgerPath) => {
        writeFileSync(ledgerPath, Buffer.alloc((1024 * 1024) + 1, 0x20), { mode: 0o600 });
      }],
    ];
    for (const [label, prepare] of cases) {
      const root = temporaryDirectory();
      try {
        const stateDir = path.join(root, '.ao', 'state');
        const ledgerPath = path.join(stateDir, 'ao-concurrency.json');
        mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        prepare(root, ledgerPath);
        const denied = reserveWorkerBatchConcurrency(root, [{ name: label, type: 'claude' }], {
          teamName: `${label}-team`,
          runId: 'aaaaaaaaaaaaaaaa',
          limits: { global: 2, claude: 2, codex: 2, gemini: 2 },
        });
        assert.equal(denied.ok, false, label);
        assert.equal(readdirSync(stateDir)
          .some(file => file.startsWith('ao-concurrency.json.corrupt-')), false, label);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('does not create or rewrite a ledger for missing and semantic no-op reads', () => {
    const root = temporaryDirectory();
    try {
      const ledgerPath = path.join(root, '.ao', 'state', 'ao-concurrency.json');
      assert.deepEqual(readActiveConcurrencyCounts(root), {
        global: 0, claude: 0, codex: 0, gemini: 0,
      });
      assert.equal(existsSync(ledgerPath), false);
      assert.deepEqual(releaseConcurrencyReservation(root, 'absent'), {
        ok: true, released: 0, reservationId: 'absent',
      });
      assert.equal(existsSync(ledgerPath), false);

      const admitted = reserveWorkerBatchConcurrency(root, [{ name: 'live', type: 'claude' }], {
        teamName: 'no-op-team',
        runId: 'aaaaaaaaaaaaaaaa',
        limits: { global: 2, claude: 2, codex: 2, gemini: 2 },
      });
      assert.equal(admitted.ok, true);
      const before = lstatSync(ledgerPath);
      assert.equal(readActiveConcurrencyCounts(root).global, 1);
      const afterRead = lstatSync(ledgerPath);
      assert.deepEqual({ dev: afterRead.dev, ino: afterRead.ino, mtimeMs: afterRead.mtimeMs },
        { dev: before.dev, ino: before.ino, mtimeMs: before.mtimeMs });
      assert.equal(releaseConcurrencyReservation(root, 'still-absent').released, 0);
      const afterRelease = lstatSync(ledgerPath);
      assert.deepEqual({ dev: afterRelease.dev, ino: afterRelease.ino, mtimeMs: afterRelease.mtimeMs },
        { dev: before.dev, ino: before.ino, mtimeMs: before.mtimeMs });

      assert.equal(releaseConcurrencyReservation(root, admitted.reservationId).released, 1);
      assert.equal(JSON.parse(readFileSync(ledgerPath, 'utf8')).activeTasks.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('durably writes stale pruning and legacy normalization migrations', () => {
    const root = temporaryDirectory();
    try {
      const stateDir = path.join(root, '.ao', 'state');
      const ledgerPath = path.join(stateDir, 'ao-concurrency.json');
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const now = Date.now();
      writeFileSync(ledgerPath, JSON.stringify({
        schemaVersion: 1,
        activeTasks: [{
          id: 'legacy-stale', provider: 'codex',
          startedAt: new Date(now - (10 * 60 * 1000)).toISOString(),
        }, {
          id: 'legacy-fresh', provider: 'claude',
          startedAt: new Date(now - 1000).toISOString(),
        }],
      }), { mode: 0o600 });
      const before = lstatSync(ledgerPath);

      assert.deepEqual(readActiveConcurrencyCounts(root, { now }), {
        global: 1, claude: 1, codex: 0, gemini: 0,
      });
      const after = lstatSync(ledgerPath);
      assert.notEqual(after.ino, before.ino);
      const migrated = JSON.parse(readFileSync(ledgerPath, 'utf8'));
      assert.equal(migrated.schemaVersion, 2);
      assert.deepEqual(migrated.queue, []);
      assert.deepEqual(migrated.activeTasks.map(entry => [entry.id, entry.kind]), [
        ['legacy-fresh', 'hook'],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never replaces a bounded ledger with an oversized canonical migration', () => {
    const root = temporaryDirectory();
    try {
      const stateDir = path.join(root, '.ao', 'state');
      const ledgerPath = path.join(stateDir, 'ao-concurrency.json');
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const maxBytes = 1024 * 1024;
      const legacy = {
        schemaVersion: 1,
        activeTasks: [{
          id: 'legacy-fresh',
          provider: 'claude',
          startedAt: new Date().toISOString(),
        }],
        queue: [''],
      };
      const base = JSON.stringify(legacy);
      legacy.queue[0] = 'x'.repeat(maxBytes - Buffer.byteLength(base));
      const original = JSON.stringify(legacy);
      assert.equal(Buffer.byteLength(original), maxBytes);
      writeFileSync(ledgerPath, original, { mode: 0o600 });

      assert.deepEqual(readActiveConcurrencyCounts(root), {
        global: Infinity, claude: Infinity, codex: Infinity, gemini: Infinity,
      });
      assert.equal(readFileSync(ledgerPath, 'utf8'), original);
      assert.deepEqual(readActiveConcurrencyCounts(root), {
        global: Infinity, claude: Infinity, codex: Infinity, gemini: Infinity,
      });
      assert.equal(readFileSync(ledgerPath, 'utf8'), original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('checks global and post-demotion provider batch counts', () => {
    const result = validateWorkerBatchConcurrency([
      { type: 'claude' },
      { type: 'claude' },
    ], {
      limits: { global: 2, claude: 2, codex: 1, gemini: 1 },
      active: { global: 1, claude: 0, codex: 1, gemini: 0 },
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /global concurrency limit exceeded/);
  });

  it('fails closed on an unsafe ledger artifact', () => {
    const root = temporaryDirectory();
    try {
      const limits = { global: 2, claude: 2, codex: 2, gemini: 2 };
      const first = reserveWorkerBatchConcurrency(root, [{ name: 'one', type: 'claude' }], {
        teamName: 'unsafe-mode', runId: 'ffffffffffffffff', limits,
      });
      assert.equal(first.ok, true);
      chmodSync(path.join(root, '.ao', 'state', 'ao-concurrency.json'), 0o644);
      assert.equal(readActiveConcurrencyCounts(root).global, Infinity);
      const second = reserveWorkerBatchConcurrency(root, [{ name: 'two', type: 'claude' }], {
        teamName: 'unsafe-mode-two', runId: 'eeeeeeeeeeeeeeee', limits,
      });
      assert.equal(second.ok, false);
      assert.equal(second.unsafe, true);
      assert.match(second.errors.join('\n'), /unsafe/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('spawnTeam denies an oversized adapter batch before any launch', async () => {
    const root = temporaryDirectory();
    try {
      await assert.rejects(
        spawnTeam('bounded-team', [
          { name: 'one', type: 'claude', prompt: 'one' },
          { name: 'two', type: 'claude', prompt: 'two' },
        ], root, { hasClaudeCli: true }, {
          runId: '0123456789abcdef',
          env: { AO_CONCURRENCY_GLOBAL: '1', AO_CONCURRENCY_CLAUDE: '1' },
          activeConcurrency: { global: 0, claude: 0, codex: 0, gemini: 0 },
          spawnSupervisor() {
            throw new Error('must not launch');
          },
        }),
        /spawnTeam concurrency denied/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('atomically admits only one of two concurrent processes and releases it cross-process', async () => {
    const root = temporaryDirectory();
    const start = path.join(root, 'start');
    const finish = path.join(root, 'finish');
    const readyA = path.join(root, 'ready-a');
    const readyB = path.join(root, 'ready-b');
    const resultA = path.join(root, 'result-a.json');
    const resultB = path.join(root, 'result-b.json');
    const releaseResult = path.join(root, 'release.json');
    let childA;
    let childB;
    try {
      childA = spawn(process.execPath, [
        LEDGER_CHILD, 'reserve', root, 'racer-a', readyA, start, resultA, finish,
      ], { stdio: 'ignore' });
      childB = spawn(process.execPath, [
        LEDGER_CHILD, 'reserve', root, 'racer-b', readyB, start, resultB, finish,
      ], { stdio: 'ignore' });
      await waitForFiles([readyA, readyB]);
      writeFileSync(start, 'go', { mode: 0o600 });
      await waitForFiles([resultA, resultB]);

      const results = [resultA, resultB].map(file => JSON.parse(readFileSync(file, 'utf8')));
      assert.equal(results.filter(result => result.ok).length, 1);
      assert.equal(results.filter(result => !result.ok).length, 1);
      const ledgerPath = path.join(root, '.ao', 'state', 'ao-concurrency.json');
      assert.equal(JSON.parse(readFileSync(ledgerPath, 'utf8')).activeTasks.length, 1);

      const winner = results.find(result => result.ok);
      const releaser = spawn(process.execPath, [
        LEDGER_CHILD, 'release', root, winner.reservationId, '', '', releaseResult, '',
      ], { stdio: 'ignore' });
      await waitForFiles([releaseResult]);
      assert.equal(await waitForExit(releaser), 0);
      const released = JSON.parse(readFileSync(releaseResult, 'utf8'));
      assert.deepEqual({ ok: released.ok, released: released.released }, { ok: true, released: 1 });
      assert.equal(JSON.parse(readFileSync(ledgerPath, 'utf8')).activeTasks.length, 0);
    } finally {
      try { writeFileSync(finish, 'done', { mode: 0o600 }); } catch {}
      if (childA) await waitForExit(childA).catch(() => {});
      if (childB) await waitForExit(childB).catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('shares atomic admission between Task/Agent hooks and detached workers', () => {
    const root = temporaryDirectory();
    try {
      assert.deepEqual(runGate(root, 'Task'), {});
      const blockedAgent = runGate(root, 'Agent');
      assert.equal(blockedAgent.decision, 'block');
      assert.match(blockedAgent.reason, /concurrency limit exceeded/);

      const detached = reserveWorkerBatchConcurrency(root, [{ name: 'detached', type: 'claude' }], {
        teamName: 'detached-team',
        runId: 'dddddddddddddddd',
        limits: { global: 1, claude: 1, codex: 1, gemini: 1 },
      });
      assert.equal(detached.ok, false);

      assert.equal(releaseHookConcurrency(root, { provider: 'claude' }).released, 1);
      const admitted = reserveWorkerBatchConcurrency(root, [{ name: 'detached', type: 'claude' }], {
        teamName: 'detached-team',
        runId: 'dddddddddddddddd',
        limits: { global: 1, claude: 1, codex: 1, gemini: 1 },
      });
      assert.equal(admitted.ok, true, admitted.errors?.join('; '));
      assert.equal(releaseConcurrencyReservation(root, admitted.reservationId).released, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reclaims a detached reservation only after durable worker terminal state', () => {
    const root = temporaryDirectory();
    try {
      const limits = { global: 1, claude: 1, codex: 1, gemini: 1 };
      const first = reserveWorkerBatchConcurrency(root, [{ name: 'worker-a', type: 'claude' }], {
        teamName: 'team-a', runId: 'aaaaaaaaaaaaaaaa', limits,
      });
      assert.equal(first.ok, true);
      const teamPath = path.join(root, '.ao', 'state', 'team-team-a.json');
      writeFileSync(teamPath, JSON.stringify({
        runId: 'aaaaaaaaaaaaaaaa',
        workers: [{
          name: 'worker-a',
          status: 'completed',
          _concurrencyEntryId: first.entryIds[0],
        }],
      }), { mode: 0o600 });

      const second = reserveWorkerBatchConcurrency(root, [{ name: 'worker-b', type: 'claude' }], {
        teamName: 'team-b', runId: 'bbbbbbbbbbbbbbbb', limits,
      });
      assert.equal(second.ok, true, second.errors?.join('; '));
      assert.equal(readActiveConcurrencyCounts(root).global, 1);
      assert.equal(releaseConcurrencyReservation(root, second.reservationId).released, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reclaims from a generation-bound terminal supervisor snapshot before team polling', () => {
    const root = temporaryDirectory();
    try {
      const limits = { global: 1, claude: 1, codex: 1, gemini: 1 };
      const runId = 'aaaaaaaaaaaaaaaa';
      const workerRunId = 'eeeeeeeeeeeeeeee';
      const first = reserveWorkerBatchConcurrency(root, [{ name: 'worker-a', type: 'claude' }], {
        teamName: 'team-a', runId, limits,
      });
      assert.equal(first.ok, true);
      writeFileSync(path.join(root, '.ao', 'state', 'team-team-a.json'), JSON.stringify({
        runId,
        projectRoot: root,
        workers: [{
          name: 'worker-a',
          status: 'running',
          _concurrencyEntryId: first.entryIds[0],
          _handle: { workerRunId },
        }],
      }), { mode: 0o600 });
      writeSnapshot(snapshotPath(root, runId, workerRunId), {
        runId,
        workerRunId,
        status: 'completed',
        supervisorPid: process.pid,
      });

      const second = reserveWorkerBatchConcurrency(root, [{ name: 'worker-b', type: 'claude' }], {
        teamName: 'team-b', runId: 'bbbbbbbbbbbbbbbb', limits,
      });
      assert.equal(second.ok, true, second.errors?.join('; '));
      assert.equal(releaseConcurrencyReservation(root, second.reservationId).released, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when durable team liveness is malformed and hook release cannot steal its slot', () => {
    const root = temporaryDirectory();
    try {
      const limits = { global: 1, claude: 1, codex: 1, gemini: 1 };
      const first = reserveWorkerBatchConcurrency(root, [{ name: 'worker-a', type: 'claude' }], {
        teamName: 'team-a', runId: 'aaaaaaaaaaaaaaaa', limits,
      });
      assert.equal(first.ok, true);
      writeFileSync(path.join(root, '.ao', 'state', 'team-team-a.json'), '{broken', { mode: 0o600 });

      const hookRelease = releaseHookConcurrency(root, { provider: 'claude', isSubagentStop: true });
      assert.deepEqual({ ok: hookRelease.ok, released: hookRelease.released }, { ok: true, released: 0 });
      const denied = reserveWorkerBatchConcurrency(root, [{ name: 'worker-b', type: 'claude' }], {
        teamName: 'team-b', runId: 'bbbbbbbbbbbbbbbb', limits,
      });
      assert.equal(denied.ok, false);
      assert.match(denied.errors.join('\n'), /concurrency limit exceeded/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
