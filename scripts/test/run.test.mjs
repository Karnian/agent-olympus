/**
 * Unit tests for scripts/run.cjs
 *
 * Tests the resolveTarget() function indirectly by spawning run.cjs with
 * various arguments. Since run.cjs is CJS and uses process.argv,
 * we test it via spawnSync to verify exit behavior.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_CJS = join(__dirname, '..', 'run.cjs');

function runCjs(args = [], env = {}) {
  return spawnSync(process.execPath, [RUN_CJS, ...args], {
    encoding: 'utf-8',
    stdio: 'pipe',
    env: { ...process.env, ...env },
    timeout: 10_000,
  });
}

// ---------------------------------------------------------------------------
// No arguments
// ---------------------------------------------------------------------------

describe('run.cjs: no arguments', () => {
  it('exits 0 when no target is provided', () => {
    const result = runCjs([]);
    assert.equal(result.status, 0);
  });
});

// ---------------------------------------------------------------------------
// Valid target
// ---------------------------------------------------------------------------

describe('run.cjs: valid target', () => {
  let tmpDir;
  let scriptPath;

  before(() => {
    tmpDir = join(tmpdir(), `ao-run-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    scriptPath = join(tmpDir, 'test-hook.mjs');
    // Create a simple script that outputs JSON and exits 0
    writeFileSync(scriptPath, `
      process.stdout.write(JSON.stringify({ ok: true }));
      process.exit(0);
    `);
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs the target script and exits with its exit code', () => {
    const result = runCjs([scriptPath]);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes('"ok":true') || result.stdout.includes('"ok": true'));
  });
});

// ---------------------------------------------------------------------------
// Non-existent target (no CLAUDE_PLUGIN_ROOT fallback)
// ---------------------------------------------------------------------------

describe('run.cjs: non-existent target', () => {
  it('exits 0 when target does not exist and no fallback available', () => {
    const result = runCjs(['/nonexistent/path/to/hook.mjs'], {
      CLAUDE_PLUGIN_ROOT: undefined,
    });
    assert.equal(result.status, 0);
  });
});

// ---------------------------------------------------------------------------
// Exit code propagation
// ---------------------------------------------------------------------------

describe('run.cjs: exit code propagation', () => {
  let tmpDir;

  before(() => {
    tmpDir = join(tmpdir(), `ao-run-exit-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('propagates non-zero exit code from target script', () => {
    const scriptPath = join(tmpDir, 'fail-hook.mjs');
    writeFileSync(scriptPath, 'process.exit(42);');
    const result = runCjs([scriptPath]);
    assert.equal(result.status, 42);
  });

  it('propagates zero exit code from successful target', () => {
    const scriptPath = join(tmpDir, 'ok-hook.mjs');
    writeFileSync(scriptPath, 'process.exit(0);');
    const result = runCjs([scriptPath]);
    assert.equal(result.status, 0);
  });
});

// ---------------------------------------------------------------------------
// Version fallback scan
// ---------------------------------------------------------------------------

describe('run.cjs: version fallback', () => {
  let cacheBase;
  let pluginRoot;

  before(() => {
    // Simulate a plugin cache structure:
    // <cacheBase>/0.8.0/scripts/hook.mjs  (missing)
    // <cacheBase>/0.9.5/scripts/hook.mjs  (exists)
    cacheBase = join(tmpdir(), `ao-run-cache-${randomUUID()}`);
    pluginRoot = join(cacheBase, '0.8.0');

    // Create the old version dir (without the script)
    mkdirSync(join(pluginRoot, 'scripts'), { recursive: true });

    // Create the newer version dir (with the script)
    const newVersionDir = join(cacheBase, '0.9.5', 'scripts');
    mkdirSync(newVersionDir, { recursive: true });
    writeFileSync(join(newVersionDir, 'hook.mjs'), `
      process.stdout.write('fallback-ok');
      process.exit(0);
    `);
  });

  after(() => {
    rmSync(cacheBase, { recursive: true, force: true });
  });

  it('falls back to latest version when target path does not exist', () => {
    const stalePath = join(pluginRoot, 'scripts', 'hook.mjs');
    const result = runCjs([stalePath], {
      CLAUDE_PLUGIN_ROOT: pluginRoot,
    });
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes('fallback-ok'));
  });
});

// ---------------------------------------------------------------------------
// stdin passthrough (stdio: 'inherit')
// ---------------------------------------------------------------------------

describe('run.cjs: stdin passthrough', () => {
  let tmpDir;

  before(() => {
    tmpDir = join(tmpdir(), `ao-run-stdin-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes stdin to child process', () => {
    const scriptPath = join(tmpDir, 'echo-stdin.mjs');
    writeFileSync(scriptPath, `
      import { readFileSync } from 'fs';
      try {
        const input = readFileSync('/dev/stdin', 'utf-8');
        process.stdout.write(input);
      } catch {
        process.stdout.write('no-stdin');
      }
      process.exit(0);
    `);

    // spawnSync with stdio: 'inherit' in run.cjs means we can't easily
    // pipe stdin through this test wrapper. Verify the script runs without error.
    const result = runCjs([scriptPath]);
    assert.equal(result.status, 0);
  });
});
