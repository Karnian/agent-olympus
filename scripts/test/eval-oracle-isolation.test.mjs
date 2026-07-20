import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stagePluginSnapshot } from '../../evals/lib/plugin-stage.mjs';

function write(root, relativePath, content = relativePath) {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

function mode(filePath) {
  return statSync(filePath).mode & 0o777;
}

test('plugin snapshot keeps the manifest while excluding eval oracles and mutable trees', () => {
  const testRoot = mkdtempSync(path.join(tmpdir(), 'ao-plugin-stage-test-'));
  const sourceRoot = path.join(testRoot, 'source');
  const tempParent = path.join(testRoot, 'staged');
  mkdirSync(sourceRoot);
  mkdirSync(tempParent);

  write(sourceRoot, '.claude-plugin/plugin.json', '{"name":"fixture"}\n');
  write(sourceRoot, 'hooks/hooks.json', '{"hooks":{}}\n');
  write(sourceRoot, 'skills/example/SKILL.md', '# Example\n');
  const executable = write(sourceRoot, 'scripts/hook.mjs', '#!/usr/bin/env node\n');
  chmodSync(executable, 0o755);

  write(sourceRoot, 'evals/tasks/demo/solution/answer.mjs', 'export const answer = 42;\n');
  write(sourceRoot, 'evals/tasks/demo/grader.mjs', 'export const secret = true;\n');
  write(sourceRoot, '.git/config', '[core]\n');
  write(sourceRoot, '.ao/state/private.json', '{}\n');
  write(sourceRoot, 'node_modules/example/index.js', 'module.exports = 1;\n');
  write(sourceRoot, '.claude/worktrees/worker/secret.txt', 'secret\n');
  write(sourceRoot, 'docs/plans/leak.md', 'original repo: /Users/example/agent-olympus\n');
  write(sourceRoot, 'scripts/test/oracle.test.mjs', 'export const oracle = true;\n');

  let staged;
  try {
    staged = stagePluginSnapshot(sourceRoot, { tempParent });

    assert.equal(existsSync(path.join(staged.pluginDir, '.claude-plugin/plugin.json')), true);
    assert.equal(existsSync(path.join(staged.pluginDir, 'hooks/hooks.json')), true);
    assert.equal(existsSync(path.join(staged.pluginDir, 'skills/example/SKILL.md')), true);
    assert.equal(existsSync(path.join(staged.pluginDir, 'evals')), false);
    assert.equal(existsSync(path.join(staged.pluginDir, '.git')), false);
    assert.equal(existsSync(path.join(staged.pluginDir, '.ao')), false);
    assert.equal(existsSync(path.join(staged.pluginDir, 'node_modules')), false);
    assert.equal(existsSync(path.join(staged.pluginDir, '.claude/worktrees')), false);
    assert.equal(existsSync(path.join(staged.pluginDir, 'docs')), false);
    assert.equal(existsSync(path.join(staged.pluginDir, 'scripts/test')), false);
    assert.equal(mode(staged.tempRoot), 0o700);
    assert.equal(mode(staged.pluginDir), 0o700);
    assert.equal(mode(path.join(staged.pluginDir, 'scripts')), 0o700);
    assert.equal(mode(path.join(staged.pluginDir, '.claude-plugin/plugin.json')), 0o600);
    assert.equal(mode(path.join(staged.pluginDir, 'scripts/hook.mjs')), 0o700);

    const tempRoot = staged.tempRoot;
    staged.cleanup();
    staged.cleanup();
    assert.equal(existsSync(tempRoot), false);
  } finally {
    staged?.cleanup();
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test('plugin snapshot can omit only the root hooks tree', () => {
  const testRoot = mkdtempSync(path.join(tmpdir(), 'ao-plugin-stage-hooks-'));
  const sourceRoot = path.join(testRoot, 'source');
  const tempParent = path.join(testRoot, 'staged');
  mkdirSync(sourceRoot);
  mkdirSync(tempParent);

  write(sourceRoot, '.claude-plugin/plugin.json', '{"name":"fixture"}\n');
  write(sourceRoot, 'hooks/hooks.json', '{"hooks":{}}\n');
  write(sourceRoot, 'skills/example/hooks/guide.md', '# Nested hook guide\n');
  write(sourceRoot, 'scripts/hook.mjs', 'export const hook = true;\n');

  let withHooks;
  let withoutHooks;
  try {
    withHooks = stagePluginSnapshot(sourceRoot, { tempParent });
    withoutHooks = stagePluginSnapshot(sourceRoot, { tempParent, includeHooks: false });

    assert.equal(existsSync(path.join(withHooks.pluginDir, 'hooks/hooks.json')), true);
    assert.equal(existsSync(path.join(withoutHooks.pluginDir, 'hooks')), false);
    assert.equal(
      existsSync(path.join(withoutHooks.pluginDir, 'skills/example/hooks/guide.md')),
      true,
    );
    assert.equal(existsSync(path.join(withoutHooks.pluginDir, 'scripts/hook.mjs')), true);
    assert.equal(Object.hasOwn(withoutHooks.fileFingerprints, 'hooks/hooks.json'), false);
    assert.notEqual(withHooks.fingerprint, withoutHooks.fingerprint);
  } finally {
    withHooks?.cleanup();
    withoutHooks?.cleanup();
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test('plugin snapshot fingerprints are stable and detect content and executable-bit changes', () => {
  const testRoot = mkdtempSync(path.join(tmpdir(), 'ao-plugin-stage-digest-'));
  const sourceRoot = path.join(testRoot, 'source');
  const tempParent = path.join(testRoot, 'staged');
  mkdirSync(sourceRoot);
  mkdirSync(tempParent);

  write(sourceRoot, '.claude-plugin/plugin.json', '{"name":"fixture"}\n');
  const skill = write(sourceRoot, 'skills/example/SKILL.md', '# Example\n');
  const runner = write(sourceRoot, 'scripts/nested/runner.mjs', 'export const run = true;\n');

  const capture = () => {
    const staged = stagePluginSnapshot(sourceRoot, { tempParent });
    try {
      return {
        fingerprint: staged.fingerprint,
        fileFingerprints: staged.fileFingerprints,
      };
    } finally {
      staged.cleanup();
    }
  };

  try {
    const first = capture();
    const second = capture();
    assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(Object.isFrozen(first.fileFingerprints), true);
    assert.deepEqual(Object.keys(first.fileFingerprints), [
      '.claude-plugin/plugin.json',
      'scripts/nested/runner.mjs',
      'skills/example/SKILL.md',
    ]);
    assert.deepEqual(second, first);

    writeFileSync(skill, '# Changed example\n');
    const contentChanged = capture();
    assert.notEqual(contentChanged.fingerprint, first.fingerprint);
    assert.notEqual(
      contentChanged.fileFingerprints['skills/example/SKILL.md'],
      first.fileFingerprints['skills/example/SKILL.md'],
    );
    assert.equal(
      contentChanged.fileFingerprints['scripts/nested/runner.mjs'],
      first.fileFingerprints['scripts/nested/runner.mjs'],
    );

    writeFileSync(skill, '# Example\n');
    chmodSync(runner, 0o755);
    const modeChanged = capture();
    assert.notEqual(modeChanged.fingerprint, first.fingerprint);
    assert.deepEqual(modeChanged.fileFingerprints, first.fileFingerprints);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test('plugin snapshot rejects an escaping symlink and cleans a partial snapshot', (t) => {
  const testRoot = mkdtempSync(path.join(tmpdir(), 'ao-plugin-stage-link-'));
  const sourceRoot = path.join(testRoot, 'source');
  const tempParent = path.join(testRoot, 'staged');
  mkdirSync(sourceRoot);
  mkdirSync(tempParent);
  write(sourceRoot, '.claude-plugin/plugin.json', '{"name":"fixture"}\n');
  const outside = write(testRoot, 'outside-secret.txt', 'do not copy\n');

  try {
    try {
      mkdirSync(path.join(sourceRoot, 'skills'));
      symlinkSync(outside, path.join(sourceRoot, 'skills/escape.txt'));
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip('symlinks are unavailable on this platform');
        return;
      }
      throw error;
    }

    assert.throws(
      () => stagePluginSnapshot(sourceRoot, { tempParent }),
      /Refusing to stage symbolic link: skills[/\\]escape\.txt/,
    );
    assert.deepEqual(readdirSync(tempParent), []);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
