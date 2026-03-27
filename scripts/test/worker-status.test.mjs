/**
 * Unit tests for scripts/lib/worker-status.mjs
 *
 * worker-status.mjs uses TEAMS_DIR = '.ao/teams' (relative constant).
 * All fs calls resolve relative to process.cwd() at call time.
 * We use withTmpCwd() to isolate each test in a fresh temp directory.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ao-status-test-'));
}

async function removeTmpDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Run fn(mod, tmpDir) with process.cwd() pointed at a fresh temp directory.
 * Cache-busting ensures a fresh module instance per test so module-level
 * constants always resolve against the isolated tmpDir.
 */
async function withTmpCwd(fn) {
  const tmpDir = await makeTmpDir();
  const original = process.cwd();
  process.chdir(tmpDir);
  const buster = Buffer.from(tmpDir).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
  const modPath = new URL('../lib/worker-status.mjs?cb=' + buster, import.meta.url).href;
  try {
    const mod = await import(modPath);
    await fn(mod, tmpDir);
  } finally {
    process.chdir(original);
    await removeTmpDir(tmpDir);
  }
}

// ---------------------------------------------------------------------------
// Test: reportWorkerStatus
// ---------------------------------------------------------------------------

test('reportWorkerStatus: creates status.jsonl with correct record fields', async () => {
  await withTmpCwd(async ({ reportWorkerStatus }, tmpDir) => {
    reportWorkerStatus('team-a', 'executor', 'implementing', 'writing endpoints');

    const filePath = path.join(tmpDir, '.ao', 'teams', 'team-a', 'status.jsonl');
    assert.ok(existsSync(filePath), 'status.jsonl should be created');

    const content = await fs.readFile(filePath, 'utf-8');
    const record = JSON.parse(content.trim());

    assert.equal(record.worker, 'executor');
    assert.equal(record.phase, 'implementing');
    assert.equal(record.progress, 'writing endpoints');
    assert.ok(typeof record.timestamp === 'string', 'timestamp should be a string');
    assert.ok(!isNaN(Date.parse(record.timestamp)), 'timestamp should be a valid ISO date');
  });
});

test('reportWorkerStatus: multiple calls append multiple records', async () => {
  await withTmpCwd(async ({ reportWorkerStatus }, tmpDir) => {
    reportWorkerStatus('team-b', 'worker-1', 'planning', 'started');
    reportWorkerStatus('team-b', 'worker-1', 'implementing', 'in progress');

    const filePath = path.join(tmpDir, '.ao', 'teams', 'team-b', 'status.jsonl');
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    assert.equal(lines.length, 2, 'should have two JSONL lines');
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    assert.equal(first.phase, 'planning');
    assert.equal(second.phase, 'implementing');
  });
});

// ---------------------------------------------------------------------------
// Test: readTeamStatus
// ---------------------------------------------------------------------------

test('readTeamStatus: returns empty Map when no status file exists', async () => {
  await withTmpCwd(async ({ readTeamStatus }) => {
    const map = readTeamStatus('nonexistent-team');
    assert.ok(map instanceof Map);
    assert.equal(map.size, 0);
  });
});

test('readTeamStatus: latest record per worker wins (last-write-wins)', async () => {
  await withTmpCwd(async ({ reportWorkerStatus, readTeamStatus }) => {
    reportWorkerStatus('team-c', 'worker-1', 'planning', 'started');
    reportWorkerStatus('team-c', 'worker-1', 'implementing', 'in progress');
    reportWorkerStatus('team-c', 'worker-2', 'done', 'finished');

    const map = readTeamStatus('team-c');
    assert.equal(map.size, 2);
    assert.equal(map.get('worker-1').phase, 'implementing', 'latest phase should win');
    assert.equal(map.get('worker-2').phase, 'done');
  });
});

test('readTeamStatus: handles corrupt JSONL lines gracefully', async () => {
  await withTmpCwd(async ({ readTeamStatus }, tmpDir) => {
    const dir = path.join(tmpDir, '.ao', 'teams', 'corrupt-team');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'status.jsonl'),
      'NOT_JSON\n{"worker":"w","phase":"done","progress":"ok","timestamp":"2026-01-01T00:00:00.000Z"}\n'
    );

    const map = readTeamStatus('corrupt-team');
    assert.equal(map.size, 1, 'valid record should be read despite corrupt line');
    assert.equal(map.get('w').phase, 'done');
  });
});

// ---------------------------------------------------------------------------
// Test: formatStatusMarkdown
// ---------------------------------------------------------------------------

test('formatStatusMarkdown: returns empty string when no status exists', async () => {
  await withTmpCwd(async ({ formatStatusMarkdown }) => {
    const md = formatStatusMarkdown('empty-team');
    assert.equal(md, '');
  });
});

test('formatStatusMarkdown: returns markdown table with header and worker row', async () => {
  await withTmpCwd(async ({ reportWorkerStatus, formatStatusMarkdown }) => {
    reportWorkerStatus('team-d', 'api-worker', 'implementing', 'writing auth routes');

    const md = formatStatusMarkdown('team-d');
    assert.ok(md.includes('## Athena Team Status'), 'should include section header');
    assert.ok(md.includes('| Worker |'), 'should include table header row');
    assert.ok(md.includes('api-worker'), 'should include worker name');
    assert.ok(md.includes('implementing'), 'should include phase');
    assert.ok(md.includes('writing auth routes'), 'should include progress text');
  });
});

test('formatStatusMarkdown: includes phase indicator symbols', async () => {
  await withTmpCwd(async ({ reportWorkerStatus, formatStatusMarkdown }) => {
    reportWorkerStatus('team-e', 'w1', 'done', 'complete');
    reportWorkerStatus('team-e', 'w2', 'failed', 'error');
    reportWorkerStatus('team-e', 'w3', 'blocked', 'waiting');

    const md = formatStatusMarkdown('team-e');
    assert.ok(md.includes('✓'), 'done should show ✓');
    assert.ok(md.includes('✗'), 'failed should show ✗');
    assert.ok(md.includes('⚠'), 'blocked should show ⚠');
  });
});

// ---------------------------------------------------------------------------
// Test: clearTeamStatus
// ---------------------------------------------------------------------------

test('clearTeamStatus: deletes status.jsonl file', async () => {
  await withTmpCwd(async ({ reportWorkerStatus, clearTeamStatus }, tmpDir) => {
    reportWorkerStatus('team-f', 'worker', 'done', 'complete');

    const filePath = path.join(tmpDir, '.ao', 'teams', 'team-f', 'status.jsonl');
    assert.ok(existsSync(filePath), 'status.jsonl should exist before clear');

    clearTeamStatus('team-f');
    assert.ok(!existsSync(filePath), 'status.jsonl should be removed after clear');
  });
});

test('clearTeamStatus: no-op when file does not exist (no throw)', async () => {
  await withTmpCwd(async ({ clearTeamStatus }) => {
    assert.doesNotThrow(() => clearTeamStatus('no-such-team'));
  });
});
