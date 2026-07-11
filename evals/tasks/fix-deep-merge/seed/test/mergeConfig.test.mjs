import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeConfig } from '../src/mergeConfig.mjs';

test('preserves nested defaults while applying nested overrides', () => {
  assert.deepEqual(
    mergeConfig(
      { worker: { timeout: 30, retries: 2 }, tags: ['stable'] },
      { worker: { retries: 5 }, tags: ['canary'] },
    ),
    { worker: { timeout: 30, retries: 5 }, tags: ['canary'] },
  );
});

test('does not alias nested input data', () => {
  const base = { nested: { value: 1 } };
  const merged = mergeConfig(base, {});
  merged.nested.value = 9;
  assert.equal(base.nested.value, 1);
});
