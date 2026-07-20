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
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildWorkerCommand,
  composeWorkerCommand,
  createTeamSession,
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

// buildWorkerCommand writes an OS-temp ao-prompt-<uuid>.txt that the real command
// would `rm -f` at runtime; under `bash -n` nothing executes, so reap it here.
function reapPromptFiles(cmd) {
  const tempArtifacts = cmd.match(
    /\/[^'"\s;]*(?:ao-prompt-[0-9a-fA-F-]+\.txt|ao-gemini-readonly-[0-9a-fA-F-]+\.json)/g,
  ) || [];
  for (const m of new Set(tempArtifacts)) {
    try { unlinkSync(m); } catch {}
  }
}

const WORKER_TYPES = ['codex', 'gemini', 'claude'];
const SUPPORTED_CODEX_PROBE = () => ({
  version: '0.143.0',
  raw: 'codex-cli 0.143.0\n',
});
// Adversarial prompt exercising every char sanitizeForShellArg targets, plus
// shell metacharacters (`;`, `&`). Safe because it lives in a temp file read
// via `"$(cat ...)"`, never on the shell source line.
const ADVERSARIAL_PROMPT = 'fix "auth"; cost $5 `now` & deploy!';
const ENV = { AO_TEAM_NAME: 'team-1', AO_WORKER_NAME: 'w "1"', AO_WORKER_TYPE: 'codex' };

test('createTeamSession reuses an inherited worktree cwd without claiming its branch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ao-inherited-wt-'));
  const inherited = join(dir, 'root-worker-worktree');
  const log = join(dir, 'tmux-argv');
  writeFileSync(
    join(dir, 'tmux'),
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$AO_TMUX_ARGV_LOG"\nexit 0\n',
    { mode: 0o755 },
  );
  const originalPath = process.env.PATH;
  const originalLog = process.env.AO_TMUX_ARGV_LOG;
  process.env.PATH = `${dir}:${originalPath}`;
  process.env.AO_TMUX_ARGV_LOG = log;
  clearBinCache();
  try {
    const [session] = createTeamSession('failover-child', [{
      type: 'gemini',
      name: 'worker',
      prompt: 'same task',
      cwd: inherited,
      worktreePath: inherited,
      branchName: 'ao-worker-root-worker',
    }], dir);

    assert.equal(session.status, 'created');
    assert.equal(session.worktreePath, inherited);
    assert.equal(session.branchName, 'ao-worker-root-worker');
    assert.equal(session.worktreeCreated, false);
    assert.equal(session.worktreeInherited, true);
    const invocations = readFileSync(log, 'utf-8');
    assert.match(invocations, new RegExp(`new-session -d -s .* -c ${inherited.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  } finally {
    process.env.PATH = originalPath;
    if (originalLog === undefined) delete process.env.AO_TMUX_ARGV_LOG;
    else process.env.AO_TMUX_ARGV_LOG = originalLog;
    clearBinCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createTeamSession does not mistake an ordinary worker cwd for an inherited worktree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ao-ordinary-cwd-'));
  const requestedCwd = join(dir, 'requested-cwd');
  const log = join(dir, 'tmux-argv');
  mkdirSync(requestedCwd);
  writeFileSync(
    join(dir, 'tmux'),
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$AO_TMUX_ARGV_LOG"\nexit 0\n',
    { mode: 0o755 },
  );
  const originalPath = process.env.PATH;
  const originalLog = process.env.AO_TMUX_ARGV_LOG;
  process.env.PATH = `${dir}:${originalPath}`;
  process.env.AO_TMUX_ARGV_LOG = log;
  clearBinCache();
  try {
    const [session] = createTeamSession('ordinary-team', [{
      type: 'codex',
      name: 'worker',
      prompt: 'task',
      cwd: requestedCwd,
    }], dir);

    assert.equal(session.status, 'created');
    assert.equal(session.worktreeInherited, false);
    assert.notEqual(session.worktreePath, requestedCwd);
  } finally {
    process.env.PATH = originalPath;
    if (originalLog === undefined) delete process.env.AO_TMUX_ARGV_LOG;
    else process.env.AO_TMUX_ARGV_LOG = originalLog;
    clearBinCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test("composeWorkerCommand: prefixes env as KEY='value' via single-quote encoding", () => {
  const out = composeWorkerCommand('run', { A: 'x', B: 'has "quote" and $var' });
  assert.equal(out, `A='x' B='has "quote" and $var' run`);
  // Single-quote encoding adds no backslash escapes here (the old !-buggy path
  // would have produced \" and \$).
  assert.ok(!out.includes('\\'), 'single-quote encoding adds no backslashes for these values');
});

test('composeWorkerCommand: single-quotes values containing ! and embedded apostrophes', () => {
  // `!` must survive verbatim — the double-quote `\!` rule corrupted it. An
  // embedded apostrophe is rewritten as the classic '\'' sequence.
  assert.equal(composeWorkerCommand('run', { A: 'boom!' }), `A='boom!' run`);
  assert.equal(composeWorkerCommand('run', { A: "it's" }), `A='it'\\''s' run`);
});

test('composeWorkerCommand: skips env keys that are not valid shell identifiers', () => {
  // Defense-in-depth: a malformed/injected key must not become a command.
  const out = composeWorkerCommand('run', { GOOD_1: 'a', 'bad-key': 'b', 'x;rm -rf /': 'c', '': 'd' });
  assert.equal(out, `GOOD_1='a' run`);
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

test('read-only tmux worker commands enforce provider-native restrictive flags', () => {
  const codex = buildWorkerCommand(
    { type: 'codex', prompt: 'review', readOnly: true },
    { cwd: tmpdir(), autonomyConfig: {}, versionProbe: SUPPORTED_CODEX_PROBE },
  );
  const gemini = buildWorkerCommand(
    { type: 'gemini', prompt: 'review', readOnly: true },
    { cwd: tmpdir(), autonomyConfig: {} },
  );
  const claude = buildWorkerCommand(
    { type: 'claude', prompt: 'review', readOnly: true },
    { cwd: tmpdir(), autonomyConfig: {} },
  );
  try {
    assert.match(
      codex,
      /-a never -s read-only --strict-config -c project_doc_max_bytes=0 -c skills\.bundled\.enabled=false exec --ignore-user-config --ignore-rules --skip-git-repo-check --ephemeral/,
    );
    assert.match(gemini, /GEMINI_CLI_SYSTEM_SETTINGS_PATH='[^']*\/ao-gemini-readonly-/);
    assert.match(gemini, /--approval-mode plan -e none -p/);
    assert.match(gemini, /rm -f "[^"]*\/ao-gemini-readonly-/,
      'read-only settings must be removed after the CLI exits');
    assert.match(
      claude,
      /--print --bare --no-session-persistence --permission-mode plan --allowedTools Read,Glob,Grep -- "\$\(cat /,
    );
    assert.doesNotMatch(claude, /--allowedTools Read Glob Grep/);
    assert.doesNotMatch(claude, /(?<!no-)session-persistence\b/);
  } finally {
    for (const command of [codex, gemini, claude]) reapPromptFiles(command);
  }
});

test('Claude tmux commands terminate options immediately before the final prompt', () => {
  const readOnly = buildWorkerCommand(
    { type: 'claude', prompt: 'review', readOnly: true },
    { cwd: tmpdir(), autonomyConfig: {} },
  );
  const mutable = buildWorkerCommand(
    { type: 'claude', prompt: 'implement' },
    { cwd: tmpdir(), autonomyConfig: {} },
  );
  try {
    assert.match(readOnly, /--allowedTools Read,Glob,Grep -- "\$\(cat "[^"]+"\)"/);
    assert.match(mutable, /--print -- "\$\(cat "[^"]+"\)"/);
  } finally {
    reapPromptFiles(readOnly);
    reapPromptFiles(mutable);
  }
});

test('read-only Codex tmux fails closed on old/unknown versions before prompt creation', () => {
  for (const version of ['0.142.5', null]) {
    let promptWrites = 0;
    let probes = 0;
    assert.throws(
      () => buildWorkerCommand(
        { type: 'codex', prompt: 'review', readOnly: true },
        {
          cwd: tmpdir(),
          autonomyConfig: {},
          codexBinary: '/fake/codex',
          versionProbe: (binPath) => {
            probes += 1;
            assert.equal(binPath, '/fake/codex');
            return {
              version,
              raw: version ? `codex-cli ${version}\n` : 'unparseable\n',
            };
          },
          promptFileWriter: () => {
            promptWrites += 1;
            return '/tmp/ao-prompt-should-not-exist.txt';
          },
        },
      ),
      new RegExp(
        `read-only rule isolation requires Codex >=0\\.143\\.0 .*detected ${version || 'unknown'}\\. `
        + 'Upgrade with: npm install -g @openai/codex@latest',
      ),
    );
    assert.equal(probes, 1);
    assert.equal(promptWrites, 0, 'version rejection must precede prompt-file creation');
  }
});

test('read-only Codex tmux accepts the supported minimum version', () => {
  let promptWrites = 0;
  const command = buildWorkerCommand(
    { type: 'codex', prompt: 'review', readOnly: true },
    {
      cwd: tmpdir(),
      autonomyConfig: {},
      codexBinary: '/fake/codex',
      versionProbe: SUPPORTED_CODEX_PROBE,
      promptFileWriter: () => {
        promptWrites += 1;
        return '/tmp/ao-prompt-supported.txt';
      },
    },
  );

  assert.equal(promptWrites, 1);
  assert.match(command, /^"\/fake\/codex" -a never -s read-only --strict-config/);
});

test('Codex tmux commands terminate options before an option-shaped prompt', () => {
  for (const readOnly of [false, true]) {
    const command = buildWorkerCommand(
      { type: 'codex', prompt: '--help', readOnly },
      {
        cwd: tmpdir(),
        autonomyConfig: {},
        codexBinary: '/fake/codex',
        versionProbe: SUPPORTED_CODEX_PROBE,
      },
    );
    try {
      assert.match(
        command,
        /\bexec(?: --ignore-user-config --ignore-rules --skip-git-repo-check --ephemeral)? -- "\$\(cat "[^"]+"\)"/,
        `${readOnly ? 'read-only' : 'mutable'} command must place -- immediately before the prompt`,
      );
    } finally {
      reapPromptFiles(command);
    }
  }
});

// ---------------------------------------------------------------------------
// Gemini binary fallback wiring: the tmux gemini command must honor
// AO_GEMINI_BINARY (and therefore the gemini→agy fallback), not hardcode
// resolveBinary('gemini').
// ---------------------------------------------------------------------------

test('gemini worker command uses resolveGeminiBinary (AO_GEMINI_BINARY honored)', () => {
  const prev = process.env.AO_GEMINI_BINARY;
  process.env.AO_GEMINI_BINARY = '/fake/agy-compatible-binary';
  try {
    const command = buildWorkerCommand(
      { type: 'gemini', prompt: 'hello' },
      { cwd: tmpdir(), autonomyConfig: {} }
    );
    reapPromptFiles(command);
    assert.ok(
      command.includes('"/fake/agy-compatible-binary"'),
      `gemini command should spawn the override binary, got:\n${command}`
    );
  } finally {
    if (prev === undefined) delete process.env.AO_GEMINI_BINARY;
    else process.env.AO_GEMINI_BINARY = prev;
  }
});

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

// Run an env value through composeWorkerCommand and a REAL shell, reading it
// back from the SPAWNED process's environment (production semantics: the value
// is set in the child's env, read via getenv — not via `$VAR` on the same line,
// which `FOO=bar cmd "$FOO"` would expand too early). The nested `sh -c`
// resolves $AO_NOTE from the inherited child env. printf "%s" preserves the
// value byte-for-byte (no trailing newline added, internal bytes intact).
function envRoundTrip(value) {
  const composed = composeWorkerCommand(`sh -c 'printf "%s" "$AO_NOTE"'`, { AO_NOTE: value });
  return execFileSync('sh', ['-c', composed], { encoding: 'utf-8' });
}

test('round-trip: env value reaches the child env intact (single-quote encoding)', () => {
  // Packs every char the OLD double-quote path mishandled: `!` (the `\!`
  // corruption inside double quotes), plus $, backtick, ", and an apostrophe.
  const value = `bang! $x \`bt\` "dq" it's end`;
  assert.equal(envRoundTrip(value), value, `env value mangled`);
});

test('shellQuote ENCODER preserves a newline + tab losslessly (encoder-level)', () => {
  // This asserts the shellQuote ENCODING is lossless via a real `sh -c` — NOT
  // that such a value survives the tmux transport. tmux `send-keys` typed into
  // an interactive pane cannot reliably carry a tab (triggers completion) or a
  // newline (acts as Enter); production env values (AO_TEAM_NAME / worker name /
  // type) are single-line, so this is an encoder guarantee, not a transport one.
  const value = 'line1\nline2\tmid';
  assert.equal(envRoundTrip(value), value, `shellQuote mangled a multiline value`);
});

test('round-trip: a `!`-bearing value is NOT corrupted (regression for the \\! bug)', () => {
  // Direct discrimination: the double-quote path produced `worker\!`; single
  // quotes yield `worker!`.
  assert.equal(envRoundTrip('worker!'), 'worker!');
});
