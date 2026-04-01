import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'check-version-sync.mjs');

describe('check-version-sync', () => {
  it('exits 0 when versions are in sync', () => {
    // Since we just synced all versions to 0.9.1, this should pass
    const result = execFileSync('node', [SCRIPT], { encoding: 'utf-8' });
    assert.ok(result.includes('OK'));
  });
});
