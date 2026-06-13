/**
 * Regression tests for the tmux send-keys command COMPOSITION.
 *
 * Guards against the double-escaping bug: env values were escaped once for
 * embedding (`KEY="${sanitizeForShellArg(v)}"`), then the ENTIRE composed
 * command was escaped AGAIN (`sanitizeForShellArg(fullCommand)`) before being
 * handed to `execFileSync(tmux, ['send-keys', ..., cmd, 'Enter'])`.
 *
 * The pre-d9abd9e path went through `execSync(`tmux send-keys ... "${cmd}"`)`,
 * where the intermediate /bin/sh consumed one escaping level. After the
 * migration to `execFileSync` argv there is NO outer shell, so the second
 * escaping pass leaked into the pane verbatim — turning `"$(cat ...)"` into the
 * literal text `\"\$(cat ...)\"`, a shell syntax error (`unexpected token '('`)
 * that silently failed to start every tmux-fallback worker. Worse,
 * `monitorTmuxWorker` then saw the returned shell prompt and marked the worker
 * `completed` — a silent no-op reported as success.
 *
 * The existing tmux-session.test.mjs pins `sanitizeForShellArg` in ISOLATION,
 * which is exactly why this composition regression slipped through. These tests
 * assert on the *composed* string that actually reaches the tmux argv, and run
 * it through a real shell to prove it both parses and preserves its values.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildWorkerCommand,
  composeWorkerCommand,
  spawnWorkerInSession,
  sanitizeForShellArg,
  writePromptFile,
  removePromptFile,
} from '../lib/tmux-session.mjs';
import { clearBinCache } from '../lib/resolve-binary.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// `bash -n` is the cleanest syntax-only check. Skip gracefully if bash is
// somehow absent (the project targets darwin/linux, where bash is universal).
function hasBash() {
  try {
    execFileSync('bash', ['-c', 'true'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
const HAS_BASH = hasBash();
const BASH_SKIP = HAS_BASH ? false : 'bash not available';

// Write `str` to a temp .sh and syntax-check it with `bash -n` (no execution).
// Returns { ok, stderr }.
function bashSyntaxCheck(str) {
  const dir = mkdtempSync(join(tmpdir(), 'ao-compose-'));
  const file = join(dir, 'cmd.sh');
  try {
    writeFileSync(file, str);
    execFileSync('bash', ['-n', file], { stdio: 'pipe' });
    return { ok: true, stderr: '' };
  } catch (e) {
    return { ok: false, stderr: String(e.stderr || e.message) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// buildWorkerCommand writes a /tmp/ao-prompt-<uuid>.txt that the real command
// would `rm -f` at runtime; under `bash -n` nothing executes, so reap it here.
function reapPromptFiles(cmd) {
  for (const m of cmd.match(/\/tmp\/ao-prompt-[0-9a-fA-F-]+\.txt/g) || []) {
    try { unlinkSync(m); } catch {}
  }
}

const WORKER_TYPES = ['codex', 'gemini', 'claude'];
// Adversarial prompt exercising every char sanitizeForShellArg targets, plus
// shell metacharacters (`;`, `&`). Safe because it lives in a temp file read
// via `"$(cat ...)"`, never on the shell source line.
const ADVERSARIAL_PROMPT = 'fix "auth"; cost $5 `now` & deploy!';
const ENV = { AO_TEAM_NAME: 'team-1', AO_WORKER_NAME: 'w "1"', AO_WORKER_TYPE: 'codex' };

// ---------------------------------------------------------------------------
// composeWorkerCommand — pure output (no shell)
// ---------------------------------------------------------------------------

test('composeWorkerCommand: does NOT re-escape the command (single escaping level)', () => {
  const command = '"/bin/codex" exec "$(cat "/tmp/p.txt")"; rm -f "/tmp/p.txt"';
  const out = composeWorkerCommand(command, {});
  // No env → command passes through byte-for-byte.
  assert.equal(out, command);
  // The hallmark of the bug: escaped quotes / dollar leaking into the command.
  assert.ok(!out.includes('\\"'), 'must not contain escaped double-quotes');
  assert.ok(!out.includes('\\$'), 'must not contain escaped dollar signs');
});

test('composeWorkerCommand: prefixes env as KEY="value" with single-level escaping', () => {
  const out = composeWorkerCommand('run', { A: 'x', B: 'has "quote" and $var' });
  assert.equal(out, 'A="x" B="has \\"quote\\" and \\$var" run');
});

test('composeWorkerCommand: empty / missing env returns the command unchanged', () => {
  assert.equal(composeWorkerCommand('codex exec', {}), 'codex exec');
  assert.equal(composeWorkerCommand('codex exec'), 'codex exec'); // default param
});

// ---------------------------------------------------------------------------
// Real-shell syntax check on the ACTUAL production composition
// (buildWorkerCommand → composeWorkerCommand → the exact tmux send-keys arg)
// ---------------------------------------------------------------------------

for (const type of WORKER_TYPES) {
  test(`composed ${type} worker command is valid shell syntax (bash -n)`, { skip: BASH_SKIP }, () => {
    const command = buildWorkerCommand(
      { type, prompt: ADVERSARIAL_PROMPT },
      { cwd: tmpdir(), autonomyConfig: {} }
    );
    const composed = composeWorkerCommand(command, ENV);
    reapPromptFiles(command);

    const { ok, stderr } = bashSyntaxCheck(composed);
    assert.ok(ok, `bash -n rejected composed ${type} command:\n${composed}\n${stderr}`);
  });
}

// ---------------------------------------------------------------------------
// Discrimination: the OLD double-escaped form MUST fail — proves this test
// would have caught the regression (and that the single level is meaningful).
// ---------------------------------------------------------------------------

test('regression guard discriminates: re-escaping the composed string breaks shell syntax', { skip: BASH_SKIP }, () => {
  const command = buildWorkerCommand(
    { type: 'codex', prompt: ADVERSARIAL_PROMPT },
    { cwd: tmpdir(), autonomyConfig: {} }
  );
  const composed = composeWorkerCommand(command, ENV);
  reapPromptFiles(command);

  // The fixed composition parses cleanly...
  assert.ok(bashSyntaxCheck(composed).ok, 'fixed composition should parse');

  // ...and the historical double-escape (sanitizeForShellArg over the whole
  // composed string — what the buggy line produced) is a shell syntax error.
  const doubleEscaped = sanitizeForShellArg(composed);
  const { ok, stderr } = bashSyntaxCheck(doubleEscaped);
  assert.equal(ok, false, 'double-escaped form should be rejected by the shell');
  assert.match(stderr, /syntax error/i, 'should fail with a shell syntax error');
});

// ---------------------------------------------------------------------------
// Boundary: drive the REAL spawnWorkerInSession and assert the exact string it
// hands to `tmux send-keys`. composeWorkerCommand is unit-tested above, but
// spawnWorkerInSession could DIVERGE from it — e.g. someone re-introduces
// `sanitizeForShellArg(fullCommand)` there and every helper test stays green
// (the gap Codex flagged). A fake `tmux` on PATH records the send-keys argv so
// the guard fires at the actual execFileSync boundary.
// ---------------------------------------------------------------------------

test('spawnWorkerInSession: the exact send-keys argument reaches tmux as valid shell', { skip: BASH_SKIP }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ao-faketmux-'));
  const log = join(dir, 'argv');
  // For `send-keys -t <session> <ARG> Enter`, $4 is ARG. Record it verbatim
  // (printf '%s' preserves spaces/newlines) and exit 0 so the helper sees ok.
  writeFileSync(
    join(dir, 'tmux'),
    `#!/bin/sh\nif [ "$1" = "send-keys" ]; then printf '%s' "$4" > "$AO_TMUX_ARGV_LOG"; fi\nexit 0\n`,
    { mode: 0o755 }
  );

  const origPath = process.env.PATH;
  const origLog = process.env.AO_TMUX_ARGV_LOG;
  process.env.PATH = `${dir}:${origPath}`;
  process.env.AO_TMUX_ARGV_LOG = log;
  clearBinCache(); // force `which tmux` to re-resolve to the fake

  let command;
  try {
    command = buildWorkerCommand({ type: 'codex', prompt: ADVERSARIAL_PROMPT }, { cwd: tmpdir(), autonomyConfig: {} });
    const ok = spawnWorkerInSession('ao-boundary-session', command, ENV);
    assert.equal(ok, true, 'spawnWorkerInSession should report success');

    const captured = readFileSync(log, 'utf-8');
    // It must be exactly what the helper composes (no extra escaping layer)...
    assert.equal(captured, composeWorkerCommand(command, ENV), 'send-keys arg diverged from composeWorkerCommand');
    // ...and valid shell. Re-introducing sanitizeForShellArg(fullCommand) in
    // spawnWorkerInSession would make THIS fail — the regression we guard.
    assert.ok(bashSyntaxCheck(captured).ok, `send-keys arg is not valid shell:\n${captured}`);
  } finally {
    process.env.PATH = origPath;
    if (origLog === undefined) delete process.env.AO_TMUX_ARGV_LOG;
    else process.env.AO_TMUX_ARGV_LOG = origLog;
    clearBinCache();
    if (command) reapPromptFiles(command);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Round-trip: values reach a real shell intact (sh -c, no execution faking)
// ---------------------------------------------------------------------------

test('round-trip: prompt content survives the "$(cat file)" substitution intact', () => {
  const promptFile = writePromptFile(ADVERSARIAL_PROMPT);
  const safeFile = sanitizeForShellArg(promptFile);
  try {
    // Same `"$(cat "<file>")"` construct buildWorkerCommand emits. printf gets
    // the content as an ARG, so any % in data is harmless.
    // NOTE: command substitution strips TRAILING newlines and NUL bytes;
    // ADVERSARIAL_PROMPT has neither, so this asserts metacharacter fidelity,
    // not byte-exact preservation of trailing whitespace/NUL.
    const command = `printf '%s' "$(cat "${safeFile}")"`;
    const composed = composeWorkerCommand(command, {});
    const out = execFileSync('sh', ['-c', composed], { encoding: 'utf-8' });
    assert.equal(out, ADVERSARIAL_PROMPT, `prompt content mangled: ${JSON.stringify(out)}`);
  } finally {
    removePromptFile(promptFile);
  }
});

test('round-trip: env value reaches the child process environment intact', () => {
  // Mirrors production: `AO_X="val" <binary> ...` sets AO_X in the SPAWNED
  // process's environment (read via getenv), not via `$AO_X` on the same line.
  // We deliberately read it inside a nested `sh -c` so the var is resolved from
  // the inherited child env — `FOO=bar cmd "$FOO"` would expand $FOO too early.
  const envValue = 'team "1" $x';
  const composed = composeWorkerCommand(`sh -c 'printf "%s" "$AO_NOTE"'`, { AO_NOTE: envValue });
  const out = execFileSync('sh', ['-c', composed], { encoding: 'utf-8' });
  assert.equal(out, envValue, `env value mangled: ${JSON.stringify(out)}`);
});
