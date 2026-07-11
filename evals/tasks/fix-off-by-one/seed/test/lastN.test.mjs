import assert from 'node:assert/strict';
import test from 'node:test';

import { lastN } from '../src/lastN.mjs';

test('lastN returns the requested suffix', () => {
  assert.deepEqual(lastN([1, 2, 3, 4], 2), [3, 4]);
});
