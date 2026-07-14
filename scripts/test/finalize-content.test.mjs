import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  upsertChangelogEntry,
  upsertTechDebtTrackerRow,
} from '../lib/finalize-content.mjs';

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ao-finalize-content-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('upsertChangelogEntry replaces the same run and preserves other entries', async () => {
  await withTempDir(async dir => {
    const file = path.join(dir, 'CHANGELOG.md');
    await fs.writeFile(file, '# Changelog\n\n## [1.0.0] - 2026-01-01\n\nOld\n');
    upsertChangelogEntry(file, '## [1.1.0] - 2026-07-14\n\nFirst', { runId: 'run-1', cwd: dir });
    upsertChangelogEntry(file, '## [1.1.0] - 2026-07-14\n\nUpdated', { runId: 'run-1', cwd: dir });

    const content = await fs.readFile(file, 'utf8');
    assert.equal((content.match(/ao-finalize:run-1:changelog:start/g) || []).length, 1);
    assert.doesNotMatch(content, /First/);
    assert.match(content, /Updated/);
    assert.match(content, /Old/);
    assert.ok(content.indexOf('Updated') < content.indexOf('## [1.0.0]'));
  });
});

test('upsertTechDebtTrackerRow is idempotent for one run', async () => {
  await withTempDir(async dir => {
    const file = path.join(dir, 'tracker.md');
    upsertTechDebtTrackerRow(file, '| 2026-07-14 | audit | 2 | 1 | first |', { runId: 'run.2', cwd: dir });
    upsertTechDebtTrackerRow(file, '| 2026-07-14 | audit | 3 | 2 | updated |', { runId: 'run.2', cwd: dir });

    const content = await fs.readFile(file, 'utf8');
    assert.equal((content.match(/ao-finalize:run\.2:tech-debt:start/g) || []).length, 1);
    assert.doesNotMatch(content, /\| first \|/);
    assert.match(content, /\| updated <!-- ao-finalize:/);
    assert.match(content, /# Tech Debt Tracker/);
    const lines = content.trimEnd().split('\n');
    const separator = lines.findIndex(line => line.startsWith('|------'));
    assert.ok(separator >= 0);
    assert.match(lines[separator + 1], /^\| 2026-07-14 .*ao-finalize:run\.2:tech-debt:start.*\|$/);
    assert.equal(lines.some(line => line.startsWith('<!-- ao-finalize:run.2:tech-debt')), false);
  });
});

test('upsertTechDebtTrackerRow rejects marker injection and unescaped extra columns', async () => {
  await withTempDir(async dir => {
    const file = path.join(dir, 'tracker.md');
    assert.throws(
      () => upsertTechDebtTrackerRow(
        file,
        '| 2026-07-14 | audit | 2 | 1 | <!-- ao-finalize:evil:tech-debt:start --> |',
        { runId: 'run-safe', cwd: dir },
      ),
      /safe five-column/,
    );
    assert.throws(
      () => upsertTechDebtTrackerRow(
        file,
        '| 2026-07-14 | audit | extra | 2 | 1 | notes |',
        { runId: 'run-safe', cwd: dir },
      ),
      /safe five-column/,
    );
    assert.doesNotThrow(() => upsertTechDebtTrackerRow(
      file,
      '| 2026-07-14 | audit \\| review | 2 | 1 | notes |',
      { runId: 'run-safe', cwd: dir },
    ));
  });
});

test('finalize writers reject unsafe run IDs and corrupt duplicate markers', async () => {
  await withTempDir(async dir => {
    const file = path.join(dir, 'CHANGELOG.md');
    assert.throws(
      () => upsertChangelogEntry(file, '## [1.0.0]', { runId: '../escape', cwd: dir }),
      /runId must be a safe/,
    );
    await fs.writeFile(file, [
      '# Changelog',
      '<!-- ao-finalize:run-3:changelog:start -->',
      '<!-- ao-finalize:run-3:changelog:start -->',
      '<!-- ao-finalize:run-3:changelog:end -->',
    ].join('\n'));
    assert.throws(
      () => upsertChangelogEntry(file, '## [1.0.0]', { runId: 'run-3', cwd: dir }),
      /missing, duplicated, or out of order/,
    );
  });
});

test('finalize writers reject symlinks and preserve normal document mode', async () => {
  await withTempDir(async dir => {
    const outside = path.join(dir, 'outside.md');
    const symlink = path.join(dir, 'CHANGELOG.md');
    await fs.writeFile(outside, 'private outside content', { mode: 0o600 });
    await fs.symlink(outside, symlink);
    assert.throws(
      () => upsertChangelogEntry(symlink, '## [1.0.0]', { runId: 'run-4', cwd: dir }),
      /regular document/,
    );
    assert.equal(await fs.readFile(outside, 'utf8'), 'private outside content');

    await fs.unlink(symlink);
    await fs.writeFile(symlink, '# Changelog\n', { mode: 0o644 });
    upsertChangelogEntry(symlink, '## [1.0.0]', { runId: 'run-4', cwd: dir });
    const mode = (await fs.stat(symlink)).mode & 0o777;
    assert.equal(mode, 0o644);
  });
});

test('finalize writers reject paths outside cwd and oversized inputs', async () => {
  await withTempDir(async dir => {
    const outside = path.join(path.dirname(dir), `${path.basename(dir)}-outside.md`);
    try {
      assert.throws(
        () => upsertChangelogEntry(outside, '## [1.0.0]', { runId: 'run-5', cwd: dir }),
        /must stay inside cwd/,
      );
      const file = path.join(dir, 'CHANGELOG.md');
      await fs.writeFile(file, 'x'.repeat(4 * 1024 * 1024 + 1), { mode: 0o644 });
      assert.throws(
        () => upsertChangelogEntry(file, '## [1.0.0]', { runId: 'run-5', cwd: dir }),
        /bounded, non-writable regular document/,
      );
    } finally {
      await fs.rm(outside, { force: true });
    }
  });
});
