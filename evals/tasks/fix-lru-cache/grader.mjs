import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  constructCandidate,
  importCandidate,
  invokeCandidateMethod,
} from '../../lib/candidate-invoke.mjs';
import { gradeCandidate } from '../../lib/grader-subprocess.mjs';

const assertEqual = assert.equal.bind(assert);
const assertThrows = assert.throws.bind(assert);
const SafeError = Error;

function detail(error) {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

export async function hiddenCases(workdir) {
  try {
    const { LRUCache } = await importCandidate(pathToFileURL(path.join(workdir, 'src/LRUCache.mjs')).href);
    const cache = await constructCandidate(LRUCache, [3]);
    await invokeCandidateMethod(cache, 'set', ['a', 1]);
    await invokeCandidateMethod(cache, 'set', ['b', 2]);
    await invokeCandidateMethod(cache, 'set', ['c', 3]);
    assertEqual(await invokeCandidateMethod(cache, 'get', ['a']), 1);
    assertEqual(await invokeCandidateMethod(cache, 'get', ['missing']), undefined);
    await invokeCandidateMethod(cache, 'set', ['d', 4]);
    assertEqual(await invokeCandidateMethod(cache, 'get', ['b']), undefined);
    await invokeCandidateMethod(cache, 'set', ['c', 30]);
    await invokeCandidateMethod(cache, 'set', ['e', 5]);
    assertEqual(await invokeCandidateMethod(cache, 'get', ['a']), undefined);
    assertEqual(await invokeCandidateMethod(cache, 'get', ['c']), 30);
    await assertRejectsCandidateConstruction(LRUCache);
    return { name: 'lru-invariants', pass: true, detail: 'read/update recency, misses, eviction, and capacity validation hold' };
  } catch (error) {
    return { name: 'lru-invariants', pass: false, detail: detail(error) };
  }
}

async function assertRejectsCandidateConstruction(LRUCache) {
  try {
    await constructCandidate(LRUCache, [0]);
  } catch (error) {
    assertThrows(() => { throw error; }, /capacity/i);
    return;
  }
  throw new SafeError('LRUCache(0) did not reject invalid capacity');
}

export async function grade(workdir, options = {}) {
  return gradeCandidate({
    workdir,
    graderUrl: import.meta.url,
    hiddenExport: 'hiddenCases',
    hiddenName: 'lru-invariants',
    timeoutMs: options.timeoutMs,
  });
}
