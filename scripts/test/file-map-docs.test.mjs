import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function repoPath(path) {
  return fileURLToPath(new URL(`../../${path}`, import.meta.url));
}

function listModules(dir) {
  return readdirSync(repoPath(dir)).filter(name => name.endsWith('.mjs')).sort();
}

describe('docs/internals/file-map.md', () => {
  const fileMap = readFileSync(repoPath('docs/internals/file-map.md'), 'utf8');

  it('catalogues every scripts/*.mjs entry point', () => {
    const missing = listModules('scripts').filter(name => !fileMap.includes(`| \`${name}\` |`));
    assert.deepEqual(missing, [], `add these to docs/internals/file-map.md: ${missing.join(', ')}`);
  });

  it('catalogues every scripts/lib/*.mjs module', () => {
    const missing = listModules('scripts/lib').filter(name => !fileMap.includes(`| \`${name}\` |`));
    assert.deepEqual(missing, [], `add these to docs/internals/file-map.md: ${missing.join(', ')}`);
  });

  it('lists no module that no longer exists', () => {
    const existing = new Set([...listModules('scripts'), ...listModules('scripts/lib')]);
    const stale = [...fileMap.matchAll(/^\| `([^`/]+\.mjs)` \|/gm)]
      .map(match => match[1])
      .filter(name => !existing.has(name));
    assert.deepEqual(stale, [], `remove these from docs/internals/file-map.md: ${stale.join(', ')}`);
  });

  it('is linked from AGENTS.md', () => {
    const agents = readFileSync(repoPath('AGENTS.md'), 'utf8');
    assert.match(agents, /\(docs\/internals\/file-map\.md\)/);
  });
});
