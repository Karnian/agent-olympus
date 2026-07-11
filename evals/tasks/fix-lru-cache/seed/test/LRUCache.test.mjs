import assert from 'node:assert/strict';
import test from 'node:test';
import { LRUCache } from '../src/LRUCache.mjs';

test('reads refresh recency before eviction', () => {
  const cache = new LRUCache(2);
  cache.set('a', 1).set('b', 2);
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
});

test('updating an entry refreshes it without growing the cache', () => {
  const cache = new LRUCache(2);
  cache.set('a', 1).set('b', 2).set('a', 9).set('c', 3);
  assert.equal(cache.get('a'), 9);
  assert.equal(cache.get('b'), undefined);
});
