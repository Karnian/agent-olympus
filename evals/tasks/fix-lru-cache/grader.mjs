import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TEST_TIMEOUT_MS = 60_000;

function detail(error) {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

function runTests(workdir) {
  return new Promise((resolve) => {
    const env = { ...process.env, CI: '1', NO_COLOR: '1', TZ: 'UTC' };
    delete env.NODE_TEST_CONTEXT;
    try {
      execFile('node', ['--test'], { cwd: workdir, env, timeout: TEST_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join('\n').trim().slice(-4000);
        resolve({ name: 'tests-pass', pass: !error, detail: error ? (output || detail(error)) : (output || 'node --test passed') });
      });
    } catch (error) {
      resolve({ name: 'tests-pass', pass: false, detail: detail(error) });
    }
  });
}

async function hiddenCases(workdir) {
  try {
    const { LRUCache } = await import(pathToFileURL(path.join(workdir, 'src/LRUCache.mjs')).href);
    const cache = new LRUCache(3);
    cache.set('a', 1).set('b', 2).set('c', 3);
    assert.equal(cache.get('a'), 1);
    assert.equal(cache.get('missing'), undefined);
    cache.set('d', 4);
    assert.equal(cache.get('b'), undefined);
    cache.set('c', 30).set('e', 5);
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.get('c'), 30);
    assert.throws(() => new LRUCache(0), /capacity/i);
    return { name: 'lru-invariants', pass: true, detail: 'read/update recency, misses, eviction, and capacity validation hold' };
  } catch (error) {
    return { name: 'lru-invariants', pass: false, detail: detail(error) };
  }
}

export async function grade(workdir) {
  try {
    const checks = [await runTests(workdir), await hiddenCases(workdir)];
    return { pass: checks.every((check) => check.pass), checks };
  } catch (error) {
    return { pass: false, checks: [{ name: 'grader-error', pass: false, detail: detail(error) }] };
  }
}
