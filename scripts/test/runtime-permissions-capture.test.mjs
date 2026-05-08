/**
 * End-to-end tests for scripts/runtime-permissions-capture.mjs.
 *
 * The hook is invoked as a subprocess (mirroring how Claude Code invokes it)
 * with a JSON payload on stdin. We then read the persisted cache file directly
 * and verify the captured fields.
 *
 * Issue #67/#68/#69: this hook is the bridge between Claude Code's runtime
 * `permission_mode` and the on-disk override layer that
 * `permission-detect.mjs` consumes.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const SCRIPT = resolve(__dirname, '..', 'runtime-permissions-capture.mjs');
const CACHE_REL = '.ao/state/ao-runtime-permissions.json';

function makeCwd() {
  const dir = join(tmpdir(), `ao-runtime-capture-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Invoke the hook with `payload` on stdin. Returns the resolved cache record
 * (or null when the hook chose not to write). Throws on hook crash.
 */
function runHook(payload, { cwd, env = {} } = {}) {
  const stdoutRaw = execFileSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(payload),
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10000,
  });
  // Hook MUST output `{}` on stdout regardless of what it captured (silent
  // observer contract).
  const out = stdoutRaw.trim();
  assert.equal(out, '{}', 'hook must emit {} on stdout (got: ' + out + ')');

  const cachePath = join(cwd, CACHE_REL);
  if (!existsSync(cachePath)) return null;
  return JSON.parse(readFileSync(cachePath, 'utf-8'));
}

describe('runtime-permissions-capture hook', () => {
  let cwd;
  beforeEach(() => { cwd = makeCwd(); });
  afterEach(() => {
    try { rmSync(cwd, { recursive: true, force: true }); } catch {}
  });

  it('captures top-level permission_mode (snake_case) from stdin', () => {
    const rec = runHook({
      permission_mode: 'bypassPermissions',
      session_id: 'sess-1',
      cwd,
    }, { cwd });
    assert.ok(rec, 'cache file should exist');
    assert.equal(rec.schemaVersion, 1);
    assert.equal(rec.permissionMode, 'bypassPermissions');
    assert.equal(rec.source, 'hook_stdin');
    assert.equal(rec.sessionId, 'sess-1');
  });

  it('captures top-level permissionMode (camelCase) from stdin', () => {
    const rec = runHook({
      permissionMode: 'acceptEdits',
      cwd,
    }, { cwd });
    assert.equal(rec.permissionMode, 'acceptEdits');
  });

  it('captures nested session.permission_mode', () => {
    const rec = runHook({
      session: { permission_mode: 'plan' },
      cwd,
    }, { cwd });
    assert.equal(rec.permissionMode, 'plan');
  });

  it('falls back to CLAUDE_PERMISSION_MODE env when stdin lacks the field', () => {
    const rec = runHook(
      { cwd },
      { cwd, env: { CLAUDE_PERMISSION_MODE: 'bypassPermissions' } },
    );
    assert.ok(rec);
    assert.equal(rec.source, 'env');
    assert.equal(rec.permissionMode, 'bypassPermissions');
  });

  it('writes nothing when neither stdin nor env carry a valid mode', () => {
    const rec = runHook({ cwd, foo: 'bar' }, { cwd });
    assert.equal(rec, null, 'no cache file should be written');
  });

  it('drops unknown mode values silently (no cache write)', () => {
    const rec = runHook({ permission_mode: 'godMode', cwd }, { cwd });
    assert.equal(rec, null);
  });

  it('survives empty/invalid stdin without crashing', () => {
    // Empty stdin → JSON parse fails → fall through to env probe → no env
    // → silent no-op (still emits {} on stdout, exits 0).
    const stdoutRaw = execFileSync(process.execPath, [SCRIPT], {
      input: '',
      cwd,
      env: process.env,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    assert.equal(stdoutRaw.trim(), '{}');
    assert.equal(existsSync(join(cwd, CACHE_REL)), false);
  });

  it('survives malformed JSON without crashing', () => {
    const stdoutRaw = execFileSync(process.execPath, [SCRIPT], {
      input: '{not-json}',
      cwd,
      env: process.env,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    assert.equal(stdoutRaw.trim(), '{}');
  });

  it('captures observed top-level keys for diagnostics', () => {
    const rec = runHook({
      permission_mode: 'default',
      session_id: 's1',
      cwd,
      transcript_path: '/tmp/x',
      hook_event_name: 'SessionStart',
    }, { cwd });
    assert.ok(rec.rawStdinKeys.includes('permission_mode'));
    assert.ok(rec.rawStdinKeys.includes('session_id'));
    assert.ok(rec.rawStdinKeys.length <= 20);
  });
});
