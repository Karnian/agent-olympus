import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

for (const skill of ['atlas', 'athena']) {
  test(`${skill} provider fallback recipe consumes targetProvider and dispatches provider child teams`, () => {
    const source = readFileSync(path.join(REPO_ROOT, `skills/${skill}/SKILL.md`), 'utf-8');
    assert.match(source, /reassignProvider\(/);
    assert.match(source, /dispatchProviderFallback\(/);
    assert.match(source, /pollProviderFallback\(/);
    assert.match(source, /completeClaudeFallback\(/);
    assert.match(source, /targetProvider/);
    assert.match(source, /progress\.status === 'running'/);
    assert.match(source, /progress\.status === 'completed'/);
    assert.match(source, /progress\.status === 'claude-task'/);
    assert.match(source, /replacementWorker\.prompt/);
    assert.match(source, /progress\.output/);
    assert.match(source, /const claudeOutput = Task/);
    assert.doesNotMatch(source, /providerChildTeams/);
    assert.doesNotMatch(source, /reassignToClaude\(/);
  });
}
