import assert from 'node:assert/strict';
import test from 'node:test';
import { mapLimit } from '../src/mapLimit.mjs';

test('limits concurrency and preserves input order', async () => {
  let active = 0;
  let peak = 0;
  const started = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = mapLimit([3, 1, 2, 4], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    started.push(value);
    await gate;
    active -= 1;
    return value * 2;
  });
  await Promise.resolve();
  const initiallyStarted = [...started];
  release();
  const result = await pending;
  assert.deepEqual(initiallyStarted, [3, 1]);
  assert.equal(peak, 2);
  assert.deepEqual(result, [6, 2, 4, 8]);
});

test('rejects invalid limits', async () => {
  await assert.rejects(() => mapLimit([1], 0, async (value) => value), /limit/i);
});
