import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { discoverTestFiles, runTests } from '../run-tests.mjs';

test('discoverTestFiles recursively returns only sorted .test.mjs files', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ao-test-discovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'z.test.mjs'), '');
  writeFileSync(join(root, 'ignore.mjs'), '');
  writeFileSync(join(root, 'nested', 'a.test.mjs'), '');

  assert.deepEqual(discoverTestFiles(root), [
    join(root, 'nested', 'a.test.mjs'),
    join(root, 'z.test.mjs'),
  ]);
});

test('runTests invokes Node with explicit paths instead of a shell glob', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'ao-test-runner-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, 'scripts', 'test'), { recursive: true });
  writeFileSync(join(cwd, 'scripts', 'test', 'one.test.mjs'), '');
  let call = null;

  const result = runTests({
    cwd,
    spawn(command, args, options) {
      call = { command, args, options };
      return { status: 0 };
    },
  });

  assert.equal(result.status, 0);
  assert.equal(call.command, process.execPath);
  assert.deepEqual(call.args, ['--test', join('scripts', 'test', 'one.test.mjs')]);
  assert.equal(call.options.cwd, cwd);
  assert.equal(call.options.stdio, 'inherit');
});
