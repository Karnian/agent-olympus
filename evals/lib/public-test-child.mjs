#!/usr/bin/env node

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function discover(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...discover(fullPath));
    else if (entry.isFile() && /(?:^|\.)test\.mjs$/i.test(entry.name)) files.push(fullPath);
  }
  return files.sort();
}

const workdir = process.argv[2];
if (!workdir) throw new Error('public-test-child requires a workdir');
const testFiles = discover(workdir);
if (testFiles.length === 0) throw new Error('no .test.mjs files found');

for (const testFile of testFiles) {
  await import(pathToFileURL(testFile).href);
}
