import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CLI = path.join(ROOT, 'scripts', 'eval-candidates.mjs');

test('eval candidate CLI exposes only local review lifecycle commands', () => {
  const help = execFileSync(process.execPath, [CLI, '--help'], {
    cwd: ROOT,
    encoding: 'utf-8',
  });
  for (const command of ['collect', 'list', 'show', 'approve', 'reject', 'link']) {
    assert.match(help, new RegExp(`\\b${command}\\b`));
  }
  assert.doesNotMatch(help, /promote|scaffold|commit|push|provider/i);
});

test('eval candidate CLI fails closed on unknown commands and invalid status', () => {
  for (const args of [['promote'], ['list', 'future']]) {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      encoding: 'utf-8',
    });
    assert.equal(result.status, 2);
    assert.match(`${result.stdout}${result.stderr}`, /unknown-command|invalid-status/);
  }
});

test('eval candidate CLI source has no network, provider, or git mutation primitive', () => {
  const source = readFileSync(CLI, 'utf-8');
  const executableSource = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(source, /from\s+['"]node:child_process|fetch\s*\(|https?:|spawn\s*\(|exec(?:File|Sync)?\s*\(/);
  assert.doesNotMatch(source, /\b(?:git|gh)\s+(?:add|commit|push|checkout|merge)\b/);
  assert.doesNotMatch(executableSource, /promote|scaffold/);
});
