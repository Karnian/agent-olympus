import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { migrateRuntimeLedger, reserveRuntimeSubtree, claimRuntimeChild, finishRuntimeChild,
  releaseRuntimeSubtree, readActiveConcurrencyCounts, reserveWorkerBatchConcurrency,
} from '../lib/concurrency-limits.mjs';
test('v3 subtree reservations retain parent capacity and convert children without double charging', () => {
  const root = mkdtempSync(join(tmpdir(), 'ao-runtime-ledger-'));
  try {
    migrateRuntimeLedger(root);
    const tree = reserveRuntimeSubtree(root, { runId: 'a'.repeat(16), parentId: 'parent', provider: 'claude', children: { codex: 2 } });
    assert.equal(tree.ok, true);
    assert.deepEqual(readActiveConcurrencyCounts(root), { global: 3, claude: 1, codex: 2, gemini: 0 });
    assert.equal(claimRuntimeChild(root, tree.parentEntryId, { childId: 'one', provider: 'codex' }).ok, true);
    assert.equal(claimRuntimeChild(root, tree.parentEntryId, { childId: 'two', provider: 'codex' }).ok, true);
    assert.equal(claimRuntimeChild(root, tree.parentEntryId, { childId: 'three', provider: 'codex' }).ok, false);
    assert.equal(readActiveConcurrencyCounts(root).global, 3);
    assert.equal(releaseRuntimeSubtree(root, tree.parentEntryId).ok, false);
    finishRuntimeChild(root, tree.parentEntryId, 'one');
    finishRuntimeChild(root, tree.parentEntryId, 'two');
    assert.equal(releaseRuntimeSubtree(root, tree.parentEntryId).ok, true);
    assert.equal(readActiveConcurrencyCounts(root).global, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('concurrent processes cannot claim more children than the pre-reserved capacity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ao-runtime-race-'));
  try {
    migrateRuntimeLedger(root);
    const tree = reserveRuntimeSubtree(root, { runId: 'a'.repeat(16), parentId: 'parent', provider: 'claude', children: { codex: 2 } });
    const modulePath = fileURLToPath(new URL('../lib/concurrency-limits.mjs', import.meta.url));
    const outcomes = await Promise.all([0, 1, 2, 3].map(index => promisify(execFile)(process.execPath, ['--input-type=module', '-e',
      `import { claimRuntimeChild } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(claimRuntimeChild(${JSON.stringify(root)},${JSON.stringify(tree.parentEntryId)},{childId:'child-${index}',provider:'codex'})));`,
    ]).then(response => JSON.parse(response.stdout))));
    assert.equal(outcomes.filter(value => value.ok).length, 2);
    assert.equal(readActiveConcurrencyCounts(root).global, 3);
    for (let index = 0; index < 4; index++) finishRuntimeChild(root, tree.parentEntryId, `child-${index}`);
    releaseRuntimeSubtree(root, tree.parentEntryId);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('downgrade refuses live reservations and unknown future state is preserved', () => {
  const root = mkdtempSync(join(tmpdir(), 'ao-runtime-upgrade-'));
  try {
    migrateRuntimeLedger(root);
    const tree = reserveRuntimeSubtree(root, { runId: 'a'.repeat(16), parentId: 'parent', provider: 'claude', children: {} });
    assert.throws(() => migrateRuntimeLedger(root, { downgrade: true }), /quiescent/);
    releaseRuntimeSubtree(root, tree.parentEntryId);
    const path = join(root, '.ao/state/ao-concurrency.json');
    const future = JSON.stringify({ schemaVersion: 999, activeTasks: [], queue: [] });
    writeFileSync(path, future);
    assert.equal(readActiveConcurrencyCounts(root).global, Infinity);
    assert.equal(readFileSync(path, 'utf8'), future);
    writeFileSync(path, JSON.stringify({ schemaVersion: 3, activeTasks: [], queue: [] }));
    migrateRuntimeLedger(root, { downgrade: true });
    assert.equal(JSON.parse(readFileSync(path)).schemaVersion, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('v3 migration refuses active v2; missing/corrupt protected ledger and unknown versions never authorize new work', () => {
  const root = mkdtempSync(join(tmpdir(), 'ao-runtime-ledger-'));
  try {
    assert.equal(reserveWorkerBatchConcurrency(root, [{ type: 'claude', name: 'old' }], { teamName: 'old', runId: 'b'.repeat(16) }).ok, true);
    assert.throws(() => migrateRuntimeLedger(root), /quiescent/);
    writeFileSync(join(root, '.ao/state/ao-concurrency.json'), JSON.stringify({ schemaVersion: 2, activeTasks: [], queue: [] }), { mode: 0o600 });
    migrateRuntimeLedger(root);
    const path = join(root, '.ao/state/ao-concurrency.json');
    assert.equal(JSON.parse(readFileSync(path)).schemaVersion, 3);
    writeFileSync(path, '{bad');
    assert.equal(readActiveConcurrencyCounts(root).global, Infinity);
    assert.equal(readFileSync(path, 'utf8'), '{bad');
    rmSync(path);
    assert.equal(readActiveConcurrencyCounts(root).global, Infinity);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
