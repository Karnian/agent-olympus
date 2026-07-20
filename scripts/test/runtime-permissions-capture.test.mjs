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
import {
  loadRuntimePermissions,
  loadRuntimeSessionIdentity,
} from '../lib/runtime-permissions.mjs';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const SCRIPT = resolve(__dirname, '..', 'runtime-permissions-capture.mjs');
const CACHE_REL = '.ao/state/ao-runtime-permissions.json';

function makeCwd() {
  const dir = join(tmpdir(), `ao-runtime-capture-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runtimeHomeFor(cwd) {
  return `${cwd}-runtime-home`;
}

/**
 * Invoke the hook with `payload` on stdin. Returns the resolved cache record
 * (or null when the hook chose not to write). Throws on hook crash.
 */
function runHook(payload, { cwd, env = {} } = {}) {
  mkdirSync(runtimeHomeFor(cwd), { recursive: true, mode: 0o700 });
  const stdoutRaw = execFileSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(payload),
    cwd,
    env: { ...process.env, HOME: runtimeHomeFor(cwd), ...env },
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

function loadGrant(cwd) {
  const identity = loadRuntimeSessionIdentity({ cwd });
  if (!identity) return null;
  return loadRuntimePermissions({
    cwd,
    runtimeHome: runtimeHomeFor(cwd),
    expectedSessionId: identity.sessionId,
    expectedCaptureId: identity.captureId,
  });
}

describe('runtime-permissions-capture hook', () => {
  let cwd;
  beforeEach(() => { cwd = makeCwd(); });
  afterEach(() => {
    try { rmSync(cwd, { recursive: true, force: true }); } catch {}
    try { rmSync(runtimeHomeFor(cwd), { recursive: true, force: true }); } catch {}
  });

  it('captures top-level permission_mode (snake_case) from stdin', () => {
    const rec = runHook({
      permission_mode: 'bypassPermissions',
      session_id: 'sess-1',
      cwd,
    }, { cwd });
    assert.ok(rec, 'cache file should exist');
    assert.equal(rec.schemaVersion, 1);
    assert.equal(rec.permissionObservation, 'recognized');
    assert.equal(rec.source, 'hook_stdin');
    assert.equal(rec.sessionId, 'sess-1');
    assert.equal(loadGrant(cwd).permissionMode, 'bypassPermissions');
  });

  it('captures top-level permissionMode (camelCase) from stdin', () => {
    const rec = runHook({
      permissionMode: 'acceptEdits',
      session_id: 'sess-camel',
      cwd,
    }, { cwd });
    assert.equal(rec.permissionObservation, 'recognized');
    assert.equal(loadGrant(cwd).permissionMode, 'acceptEdits');
  });

  it('captures nested session.permission_mode', () => {
    const rec = runHook({
      session: { permission_mode: 'plan' },
      session_id: 'sess-nested',
      cwd,
    }, { cwd });
    assert.equal(loadGrant(cwd).permissionMode, 'plan');
  });

  it('captures current auto and dontAsk permission modes', () => {
    runHook({ permission_mode: 'auto', session_id: 'sess-current', cwd }, { cwd });
    assert.equal(loadGrant(cwd).permissionMode, 'auto');
    runHook({ permission_mode: 'dontAsk', session_id: 'sess-current', cwd }, { cwd });
    assert.equal(loadGrant(cwd).permissionMode, 'dontAsk');
  });

  it('records identity but never promotes from CLAUDE_PERMISSION_MODE env', () => {
    const rec = runHook(
      { cwd, session_id: 'sess-env' },
      { cwd, env: { CLAUDE_PERMISSION_MODE: 'bypassPermissions' } },
    );
    assert.ok(rec);
    assert.equal(rec.source, 'hook_stdin');
    assert.equal(rec.permissionObservation, 'absent');
    assert.equal(loadGrant(cwd), null);
  });

  it('writes nothing when neither stdin nor env carry a valid mode', () => {
    const rec = runHook({ cwd, foo: 'bar' }, { cwd });
    assert.equal(rec, null, 'no cache file should be written');
  });

  it('records an explicitly unknown mode as no permission grant', () => {
    const rec = runHook({ permission_mode: 'godMode', session_id: 'sess-unknown', cwd }, { cwd });
    assert.equal(rec.permissionObservation, 'unknown');
    assert.equal(loadGrant(cwd), null);
  });

  it('preserves a hook session ID when the permission enum is newer than this build', () => {
    const rec = runHook({
      permission_mode: 'futureMode',
      session_id: 'future-session',
      cwd,
    }, { cwd });
    assert.equal(rec.permissionObservation, 'unknown');
    assert.equal(rec.source, 'hook_stdin');
    assert.equal(rec.sessionId, 'future-session');
  });

  it('keeps a same-session permission mode across identity-only hook payloads', () => {
    runHook({
      permission_mode: 'bypassPermissions',
      session_id: 'stable-session',
      cwd,
    }, { cwd });
    const rec = runHook({ session_id: 'stable-session', cwd }, { cwd });
    assert.equal(rec.permissionObservation, 'recognized');
    assert.equal(rec.sessionId, 'stable-session');
    assert.equal(loadGrant(cwd).permissionMode, 'bypassPermissions');
  });

  it('explicit unknown mode clears an older same-session grant', () => {
    runHook({
      permission_mode: 'bypassPermissions',
      session_id: 'changing-session',
      cwd,
    }, { cwd });
    const rec = runHook({
      permission_mode: 'futureMode',
      session_id: 'changing-session',
      cwd,
    }, { cwd });
    assert.equal(rec.permissionObservation, 'unknown');
    assert.equal(loadGrant(cwd), null);
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
