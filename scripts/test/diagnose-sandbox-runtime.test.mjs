import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { captureRuntimePermissions } from '../lib/runtime-permissions.mjs';

const here = resolve(fileURLToPath(import.meta.url), '..');
const SCRIPT = resolve(here, '..', 'diagnose-sandbox.mjs');

describe('diagnose-sandbox runtime permission binding', () => {
  let cwd;
  let runtimeHome;
  const sessionId = 'diagnose-runtime-session';

  before(() => {
    cwd = join(tmpdir(), `ao-diagnose-runtime-${randomUUID()}`);
    runtimeHome = `${cwd}-home`;
    mkdirSync(join(cwd, '.ao', 'state'), { recursive: true, mode: 0o700 });
    mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(cwd, '.ao', 'state', 'ao-current-session.json'),
      JSON.stringify({ sessionId }),
      { mode: 0o600 },
    );
    assert.equal(captureRuntimePermissions({
      permissionMode: 'bypassPermissions',
      permissionModeObserved: true,
      source: 'hook_stdin',
      sessionId,
    }, { cwd, runtimeHome }), true);
  });

  after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runtimeHome, { recursive: true, force: true });
  });

  function report() {
    return JSON.parse(execFileSync(process.execPath, [SCRIPT, '--explain-permissions'], {
      cwd,
      env: { ...process.env, HOME: runtimeHome },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    }));
  }

  it('uses the same bound runtime result as permission detection', () => {
    const result = report();
    assert.equal(result.layers.runtime.present, true);
    assert.equal(result.layers.runtime.permissionMode, 'bypassPermissions');
    assert.equal(result.layers.runtime.level, 'full-auto');
    assert.equal(result.finalLevel, 'full-auto');
    assert.equal(result.decision.chosenSource, 'runtime');
  });

  it('reports runtime absent when the current-session pointer is missing', () => {
    unlinkSync(join(cwd, '.ao', 'state', 'ao-current-session.json'));
    const result = report();
    assert.equal(result.layers.runtime.present, false);
    assert.equal(result.finalLevel, 'suggest');
    assert.equal(result.decision.chosenSource, 'settings');
  });
});
