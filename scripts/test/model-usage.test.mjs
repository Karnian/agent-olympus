/**
 * Unit tests for scripts/lib/model-usage.mjs
 * Covers:
 *   - buildRecord() with all fields + defaults
 *   - resolveEffectiveModel() payload-vs-fallback-vs-unknown
 *   - AGENT_DEFAULT_MODEL correctness (matches agents/*.md frontmatter)
 *   - resolveUsagePath() (per-run vs fallback)
 *   - appendUsage() append-only semantics (no in-band trim)
 *   - trimFallbackUsage() size management
 *   - readUsageRecords() schemaVersion guard
 *   - summariseUsage() bucketing with new fields
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT_DEFAULT_MODEL,
  resolveEffectiveModel,
  buildRecord,
  resolveUsagePath,
  appendUsage,
  logUsage,
  trimFallbackUsage,
  readUsageRecords,
  summariseUsage,
} from '../lib/model-usage.mjs';

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ao-model-usage-test-'));
}

async function removeTmpDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// AGENT_DEFAULT_MODEL + resolveEffectiveModel
// ---------------------------------------------------------------------------

test('AGENT_DEFAULT_MODEL: opus-tier agents mapped to opus', () => {
  const opusAgents = ['architect', 'atlas', 'athena', 'hermes', 'metis', 'momus', 'prometheus'];
  for (const name of opusAgents) {
    assert.equal(AGENT_DEFAULT_MODEL[`agent-olympus:${name}`], 'opus', `${name} should be opus`);
  }
});

test('AGENT_DEFAULT_MODEL: haiku agents mapped to haiku', () => {
  assert.equal(AGENT_DEFAULT_MODEL['agent-olympus:explore'], 'haiku');
  assert.equal(AGENT_DEFAULT_MODEL['agent-olympus:writer'], 'haiku');
});

test('AGENT_DEFAULT_MODEL: sonnet agents mapped to sonnet', () => {
  const sonnetAgents = ['aphrodite', 'code-reviewer', 'debugger', 'designer',
                        'executor', 'hephaestus', 'security-reviewer', 'test-engineer', 'themis'];
  for (const name of sonnetAgents) {
    assert.equal(AGENT_DEFAULT_MODEL[`agent-olympus:${name}`], 'sonnet', `${name} should be sonnet`);
  }
});

test('resolveEffectiveModel: payload model wins over default', () => {
  const r = resolveEffectiveModel('sonnet', 'agent-olympus:metis');
  assert.equal(r.model, 'sonnet');
  assert.equal(r.source, 'payload');
});

test('resolveEffectiveModel: empty payload falls back to agent default', () => {
  const r = resolveEffectiveModel(null, 'agent-olympus:metis');
  assert.equal(r.model, 'opus');
  assert.equal(r.source, 'default');
});

test('resolveEffectiveModel: whitespace-only payload falls back', () => {
  const r = resolveEffectiveModel('   ', 'agent-olympus:explore');
  assert.equal(r.model, 'haiku');
  assert.equal(r.source, 'default');
});

test('resolveEffectiveModel: unknown agent + no payload → null/unknown', () => {
  const r = resolveEffectiveModel(null, 'agent-olympus:nonexistent');
  assert.equal(r.model, null);
  assert.equal(r.source, 'unknown');
});

test('resolveEffectiveModel: missing agentType + no payload → null/unknown', () => {
  const r = resolveEffectiveModel(null, null);
  assert.equal(r.model, null);
  assert.equal(r.source, 'unknown');
});

// ---------------------------------------------------------------------------
// buildRecord
// ---------------------------------------------------------------------------

test('buildRecord: all fields + modelSource=payload when model explicit', () => {
  const rec = buildRecord({
    runId: 'atlas-20260421-000001-abcd',
    agentType: 'agent-olympus:metis',
    model: 'opus',
    inputCharLength: 5000,
    outputCharLength: 1234,
    toolName: 'Task',
    transcriptPath: '/tmp/transcript.jsonl',
    stage: 'analysis',
  });
  assert.equal(rec.schemaVersion, 1);
  assert.equal(rec.model, 'opus');
  assert.equal(rec.modelSource, 'payload');
  assert.equal(rec.inputCharLength, 5000);
  assert.equal(rec.outputCharLength, 1234);
  assert.equal(rec.stage, 'analysis');
});

test('buildRecord: payload model missing → fallback to AGENT_DEFAULT_MODEL', () => {
  const rec = buildRecord({
    agentType: 'agent-olympus:prometheus',
    outputCharLength: 100,
  });
  assert.equal(rec.model, 'opus');
  assert.equal(rec.modelSource, 'default');
});

test('buildRecord: unknown agent → model=null, modelSource=unknown', () => {
  const rec = buildRecord({ agentType: 'agent-olympus:mystery' });
  assert.equal(rec.model, null);
  assert.equal(rec.modelSource, 'unknown');
});

test('buildRecord: missing fields default to null/0', () => {
  const rec = buildRecord({});
  assert.equal(rec.schemaVersion, 1);
  assert.equal(rec.runId, null);
  assert.equal(rec.agentType, null);
  assert.equal(rec.model, null);
  assert.equal(rec.modelSource, 'unknown');
  assert.equal(rec.inputCharLength, 0);
  assert.equal(rec.outputCharLength, 0);
  assert.equal(rec.stage, null);
});

// ---------------------------------------------------------------------------
// resolveUsagePath
// ---------------------------------------------------------------------------

test('resolveUsagePath: runId given → per-run file, fallback=false', async () => {
  const cwd = await makeTmpDir();
  try {
    const { path: p, fallback } = resolveUsagePath('atlas-abc123', { cwd });
    assert.match(p, /\.ao\/artifacts\/runs\/atlas-abc123\/model-usage\.jsonl$/);
    assert.equal(fallback, false);
  } finally {
    await removeTmpDir(cwd);
  }
});

test('resolveUsagePath: no runId → fallback file, fallback=true', async () => {
  const cwd = await makeTmpDir();
  try {
    const { path: p, fallback } = resolveUsagePath(null, { cwd });
    assert.match(p, /\.ao\/state\/ao-model-usage\.jsonl$/);
    assert.equal(fallback, true);
  } finally {
    await removeTmpDir(cwd);
  }
});

// ---------------------------------------------------------------------------
// appendUsage (append-only, NO in-band trim)
// ---------------------------------------------------------------------------

test('appendUsage: writes one JSONL line to active-run file', async () => {
  const cwd = await makeTmpDir();
  try {
    appendUsage(buildRecord({
      runId: 'atlas-test',
      agentType: 'agent-olympus:architect',
      model: 'opus',
      inputCharLength: 2000,
      outputCharLength: 500,
    }), { cwd });
    const p = path.join(cwd, '.ao', 'artifacts', 'runs', 'atlas-test', 'model-usage.jsonl');
    const parsed = JSON.parse(readFileSync(p, 'utf-8').trim());
    assert.equal(parsed.agentType, 'agent-olympus:architect');
    assert.equal(parsed.inputCharLength, 2000);
  } finally {
    await removeTmpDir(cwd);
  }
});

test('appendUsage: does NOT trim fallback file in-band (append-only)', async () => {
  const cwd = await makeTmpDir();
  try {
    const stateDir = path.join(cwd, '.ao', 'state');
    mkdirSync(stateDir, { recursive: true });
    const fp = path.join(stateDir, 'ao-model-usage.jsonl');
    // Pre-populate with 1100 valid lines.
    const seed = Array.from({ length: 1100 }, (_, i) =>
      JSON.stringify({ schemaVersion: 1, seq: i }) + '\n'
    ).join('');
    writeFileSync(fp, seed);

    appendUsage(buildRecord({ agentType: 'agent-olympus:writer', outputCharLength: 1 }), { cwd });

    // Append-only: total should be 1101, NOT capped to 1000.
    const lines = readFileSync(fp, 'utf-8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1101, 'appendUsage must not trim (race-prone under concurrency)');
  } finally {
    await removeTmpDir(cwd);
  }
});

test('appendUsage: never throws when target cannot be created', async () => {
  const cwd = await makeTmpDir();
  try {
    const blockedFile = path.join(cwd, 'not-a-dir');
    writeFileSync(blockedFile, 'x');
    assert.doesNotThrow(() => {
      appendUsage(buildRecord({ agentType: 'x' }), { cwd: blockedFile });
    });
  } finally {
    await removeTmpDir(cwd);
  }
});

// ---------------------------------------------------------------------------
// trimFallbackUsage (offline, explicit)
// ---------------------------------------------------------------------------

test('trimFallbackUsage: file missing → {0,0}', async () => {
  const cwd = await makeTmpDir();
  try {
    const res = trimFallbackUsage({ cwd });
    assert.deepEqual(res, { trimmedFrom: 0, trimmedTo: 0 });
  } finally {
    await removeTmpDir(cwd);
  }
});

test('trimFallbackUsage: under threshold → no change', async () => {
  const cwd = await makeTmpDir();
  try {
    appendUsage(buildRecord({ agentType: 'agent-olympus:writer', outputCharLength: 1 }), { cwd });
    const res = trimFallbackUsage({ cwd, maxLines: 100 });
    assert.equal(res.trimmedFrom, 1);
    assert.equal(res.trimmedTo, 1);
  } finally {
    await removeTmpDir(cwd);
  }
});

test('trimFallbackUsage: over threshold → trims to maxLines (FIFO keep-tail)', async () => {
  const cwd = await makeTmpDir();
  try {
    const stateDir = path.join(cwd, '.ao', 'state');
    mkdirSync(stateDir, { recursive: true });
    const fp = path.join(stateDir, 'ao-model-usage.jsonl');
    const seed = Array.from({ length: 1500 }, (_, i) =>
      JSON.stringify({ schemaVersion: 1, seq: i }) + '\n'
    ).join('');
    writeFileSync(fp, seed);

    const res = trimFallbackUsage({ cwd, maxLines: 1000 });
    assert.equal(res.trimmedFrom, 1500);
    assert.equal(res.trimmedTo, 1000);

    const lines = readFileSync(fp, 'utf-8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1000);
    // Oldest retained is seq=500 (dropped 0..499).
    assert.equal(JSON.parse(lines[0]).seq, 500);
    assert.equal(JSON.parse(lines[lines.length - 1]).seq, 1499);
  } finally {
    await removeTmpDir(cwd);
  }
});

// ---------------------------------------------------------------------------
// readUsageRecords (schemaVersion guard)
// ---------------------------------------------------------------------------

test('readUsageRecords: returns [] when file missing', () => {
  assert.deepEqual(readUsageRecords('/nonexistent/path/usage.jsonl'), []);
});

test('readUsageRecords: skips malformed JSON', async () => {
  const cwd = await makeTmpDir();
  try {
    const fp = path.join(cwd, 'usage.jsonl');
    writeFileSync(fp, [
      JSON.stringify({ schemaVersion: 1, agentType: 'a' }),
      'not-json',
      JSON.stringify({ schemaVersion: 1, agentType: 'b' }),
    ].join('\n') + '\n');
    const recs = readUsageRecords(fp);
    assert.equal(recs.length, 2);
  } finally {
    await removeTmpDir(cwd);
  }
});

test('readUsageRecords: skips schemaVersion > SCHEMA_VERSION (forward-compat guard)', async () => {
  const cwd = await makeTmpDir();
  try {
    const fp = path.join(cwd, 'usage.jsonl');
    writeFileSync(fp, [
      JSON.stringify({ schemaVersion: 1, agentType: 'v1-ok' }),
      JSON.stringify({ schemaVersion: 2, agentType: 'future' }),
      JSON.stringify({ schemaVersion: 99, agentType: 'way-future' }),
      JSON.stringify({ schemaVersion: 1, agentType: 'v1-also-ok' }),
    ].join('\n') + '\n');
    const recs = readUsageRecords(fp);
    assert.equal(recs.length, 2);
    assert.deepEqual(recs.map(r => r.agentType), ['v1-ok', 'v1-also-ok']);
  } finally {
    await removeTmpDir(cwd);
  }
});

test('readUsageRecords: skips records missing schemaVersion field', async () => {
  const cwd = await makeTmpDir();
  try {
    const fp = path.join(cwd, 'usage.jsonl');
    writeFileSync(fp, [
      JSON.stringify({ schemaVersion: 1, agentType: 'ok' }),
      JSON.stringify({ agentType: 'legacy-no-version' }),
    ].join('\n') + '\n');
    const recs = readUsageRecords(fp);
    assert.equal(recs.length, 1);
  } finally {
    await removeTmpDir(cwd);
  }
});

// ---------------------------------------------------------------------------
// summariseUsage (new fields: totalInputChars, modelSource counts)
// ---------------------------------------------------------------------------

test('summariseUsage: aggregates inputChars + outputChars + modelSource counts', () => {
  const recs = [
    { agentType: 'agent-olympus:metis', model: 'opus', modelSource: 'payload',
      inputCharLength: 3000, outputCharLength: 1000 },
    { agentType: 'agent-olympus:metis', model: 'opus', modelSource: 'default',
      inputCharLength: 4000, outputCharLength: 2000 },
    { agentType: 'agent-olympus:metis', model: 'opus', modelSource: 'default',
      inputCharLength: 2000, outputCharLength: 500 },
  ];
  const [entry] = summariseUsage(recs);
  assert.equal(entry.callCount, 3);
  assert.equal(entry.totalInputChars, 9000);
  assert.equal(entry.totalOutputChars, 3500);
  assert.equal(entry.payloadModelCount, 1);
  assert.equal(entry.defaultModelCount, 2);
});

test('summariseUsage: sorted by callCount desc', () => {
  const recs = [
    { agentType: 'a', model: 'opus', outputCharLength: 1 },
    { agentType: 'b', model: 'sonnet', outputCharLength: 1 },
    { agentType: 'b', model: 'sonnet', outputCharLength: 1 },
    { agentType: 'c', model: 'haiku', outputCharLength: 1 },
    { agentType: 'c', model: 'haiku', outputCharLength: 1 },
    { agentType: 'c', model: 'haiku', outputCharLength: 1 },
  ];
  const s = summariseUsage(recs);
  assert.deepEqual(s.map(e => e.agentType), ['c', 'b', 'a']);
});

// ---------------------------------------------------------------------------
// logUsage convenience
// ---------------------------------------------------------------------------

test('logUsage: end-to-end build + append + read', async () => {
  const cwd = await makeTmpDir();
  try {
    logUsage({
      runId: 'atlas-e2e',
      agentType: 'agent-olympus:momus',  // default opus
      inputCharLength: 1500,
      outputCharLength: 42,
      toolName: 'Task',
    }, { cwd });
    const p = path.join(cwd, '.ao', 'artifacts', 'runs', 'atlas-e2e', 'model-usage.jsonl');
    const recs = readUsageRecords(p);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].model, 'opus');
    assert.equal(recs[0].modelSource, 'default');
    assert.equal(recs[0].inputCharLength, 1500);
  } finally {
    await removeTmpDir(cwd);
  }
});
