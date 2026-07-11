import assert from 'node:assert/strict';
import test from 'node:test';

import { greet } from '../src/greet.mjs';

test('greet falls back for null users', () => {
  assert.equal(greet(null), 'HELLO, GUEST');
});
