#!/usr/bin/env node

/**
 * Cross-platform test entrypoint.
 *
 * Node 20 does not expand CLI globs itself, POSIX shells disagree on `**`, and
 * Windows cmd.exe does not expand `*.test.mjs`. Enumerate the repository's
 * intended test root in Node, then pass explicit paths to the built-in runner.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve } from 'node:path';

export function discoverTestFiles(testRoot) {
  const root = resolve(testRoot);
  const files = [];

  const visit = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.test.mjs')) files.push(path);
    }
  };

  visit(root);
  return files;
}

export function runTests({
  cwd = process.cwd(),
  testRoot = join('scripts', 'test'),
  spawn = spawnSync,
} = {}) {
  const files = discoverTestFiles(resolve(cwd, testRoot));
  if (files.length === 0) {
    throw new Error(`No .test.mjs files found under ${resolve(cwd, testRoot)}`);
  }
  const args = ['--test', ...files.map((file) => relative(cwd, file))];
  return spawn(process.execPath, args, { cwd, stdio: 'inherit' });
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  try {
    const result = runTests();
    if (result.error) throw result.error;
    process.exitCode = Number.isInteger(result.status) ? result.status : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
