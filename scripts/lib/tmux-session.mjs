import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { randomUUID } from 'crypto';
import { createWorkerWorktree } from './worktree.mjs';
import { resolveBinary, buildEnhancedPath } from './resolve-binary.mjs';
import { resolveGeminiBinary } from './gemini-binary.mjs';
import { resolveCodexApproval, buildCodexExecArgs } from './codex-approval.mjs';
import { resolveGeminiApproval, geminiApprovalFlag } from './gemini-approval.mjs';
import { loadAutonomyConfig } from './autonomy.mjs';

// Re-export for backward compatibility with callers that import from tmux-session
export { resolveBinary } from './resolve-binary.mjs';

const SESSION_PREFIX = 'ao-team';

/**
 * Sentinel token echoed into the tmux pane after a worker's CLI exits, so the
 * monitor can read an EXPLICIT, provider-agnostic exit status instead of
 * inferring completion from a returned shell prompt (which marked every failed
 * or no-op worker `completed` — a silent success). Shared with the consumer
 * (`parseExitMarker` in worker-spawn.mjs) as the single source of truth so the
 * producer and parser can never drift. Format in the pane: `__AO_EXIT__:<code>`.
 */
export const WORKER_EXIT_MARKER = '__AO_EXIT__';

/**
 * Build a robust PATH string that includes all known binary directories.
 * Delegates to buildEnhancedPath() in resolve-binary.mjs.
 * Kept as a named export for backward compatibility with existing callers.
 *
 * @returns {string} colon-separated PATH string
 */
export function buildResolvedPath() {
  return buildEnhancedPath();
}

export function validateTmux() {
  const bin = resolveBinary('tmux');
  try {
    execFileSync(bin, ['-V'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function isInsideTmux() {
  return !!process.env.TMUX;
}

export function sanitizeName(name) {
  return String(name).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 50);
}

/**
 * Escape a string for embedding inside a DOUBLE-quoted shell argument passed via
 * tmux send-keys.
 *
 * PREFER `shellQuote()` for encoding arbitrary VALUES — it is byte-for-byte safe.
 * This function is retained for the controlled prompt-file path (a /tmp UUID
 * path with no shell metacharacters) and for back-compat, but it has a known
 * flaw: the `!`→`\!` rule is only sound in INTERACTIVE bash (history expansion);
 * inside double quotes in POSIX sh / non-interactive bash a backslash before `!`
 * is NOT special, so `\!` survives literally and corrupts the value. Do not use
 * it for values that may contain `!`.
 *
 *   "  →  \"   (closes the surrounding double-quote)
 *   \  →  \\   (escape character — must come first)
 *   $  →  \$   (variable expansion)
 *   `  →  \`   (command substitution)
 *   !  →  \!   (history expansion — interactive bash only; see caveat above)
 */
export function sanitizeForShellArg(str) {
  return String(str)
    .replace(/\\/g, '\\\\')   // backslash first
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
    .replace(/!/g, '\\!');
}

/**
 * Encode an arbitrary string as ONE shell word using POSIX single-quote
 * quoting: wrap in '…' and rewrite every embedded apostrophe as the classic
 * '\'' sequence (close-quote, escaped literal quote, reopen-quote).
 *
 * Inside single quotes NOTHING is special — not $ ` \ ! " or newline — so the
 * value reaches the pane shell byte-for-byte. This is preferred over
 * `sanitizeForShellArg` (double-quote + backslash escaping), whose `!`→`\!`
 * rule is WRONG inside double quotes: in POSIX sh and non-interactive bash a
 * backslash before `!` is not special, so `\!` survives literally and corrupts
 * any value containing `!` (e.g. `worker!` → `worker\!` in the pane).
 *
 * The returned string INCLUDES its own surrounding quotes — callers must NOT
 * wrap it again (use `KEY=${shellQuote(v)}`, not `KEY="${shellQuote(v)}"`).
 *
 * @param {string} str
 * @returns {string} e.g. `abc` → `'abc'`, `a'b` → `'a'\''b'`, `x!` → `'x!'`
 */
export function shellQuote(str) {
  return `'${String(str).replace(/'/g, "'\\''")}'`;
}

/** A valid POSIX shell identifier for an env var name (no metacharacters). */
const VALID_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Write a prompt to a unique temp file and return the file path.
 * The caller is responsible for deleting the file after the command runs.
 * File is created with mode 0o600 (owner read/write only).
 */
export function writePromptFile(prompt) {
  const filePath = `/tmp/ao-prompt-${randomUUID()}.txt`;
  writeFileSync(filePath, String(prompt), { encoding: 'utf-8', mode: 0o600 });
  return filePath;
}

/**
 * Delete a temp prompt file, ignoring errors (best-effort cleanup).
 */
export function removePromptFile(filePath) {
  try { unlinkSync(filePath); } catch {}
}

export function sessionName(teamName, workerName) {
  return `${SESSION_PREFIX}-${sanitizeName(teamName)}-${sanitizeName(workerName)}`;
}

export function createTeamSession(teamName, workers, cwd) {
  const results = [];

  for (const worker of workers) {
    const name = sessionName(teamName, worker.name);

    // A failover worker may already belong to the root Athena worker's
    // worktree. Reuse that exact execution directory without claiming
    // ownership: the child team must never create/delete a replacement branch
    // around edits that belong to the root task. Ordinary workers still get a
    // newly-created isolated worktree (fail-safe: falls back to cwd).
    // `cwd` is the requested execution directory for every worker; it does not
    // imply that a caller already created and owns an isolated worktree. Only
    // an explicit worktreePath carries that ownership/affinity contract.
    const inheritedCwd = worker?.worktreePath || null;
    const worktreeInfo = inheritedCwd
      ? {
          worktreePath: inheritedCwd,
          branchName: worker?.branchName || null,
          created: false,
          inherited: true,
        }
      : createWorkerWorktree(cwd, teamName, worker.name);
    const sessionCwd = inheritedCwd || (worktreeInfo.created ? worktreeInfo.worktreePath : cwd);

    try {
      // Kill existing session if any
      const tmux = resolveBinary('tmux');
      try { execFileSync(tmux, ['kill-session', '-t', name], { stdio: 'pipe' }); } catch {}

      // Create new detached session rooted at the worker's worktree (or cwd on fallback).
      // Worker-scoped env vars (e.g. GEMINI_API_KEY resolved from the OS secret
      // store) are passed via `tmux new-session -e KEY=VAL` so they enter the
      // shell's initial environment without ever appearing in send-keys input
      // or capture-pane output. Fail-safe: if worker.env is missing/malformed,
      // we fall back to the minimal `new-session` call.
      const newSessionArgs = ['new-session', '-d', '-s', name, '-c', sessionCwd];
      const workerEnv = worker && typeof worker.env === 'object' && worker.env ? worker.env : null;
      if (workerEnv) {
        for (const [k, v] of Object.entries(workerEnv)) {
          if (typeof k !== 'string' || !k) continue;
          if (typeof v !== 'string' || !v) continue;
          newSessionArgs.push('-e', `${k}=${v}`);
        }
      }
      execFileSync(tmux, newSessionArgs, { stdio: 'pipe' });

      // Inject resolved PATH so CLIs (codex, claude, etc.) are always findable,
      // even when the tmux shell doesn't inherit the parent's full PATH.
      // send-keys types this literally into the pane (no outer shell), so the
      // PATH value is single-quoted — byte-for-byte safe, same encoding as env
      // values in composeWorkerCommand() (shellQuote supplies its own quotes).
      const resolvedPath = buildResolvedPath();
      try {
        execFileSync(tmux, ['send-keys', '-t', name, `export PATH=${shellQuote(resolvedPath)}`, 'Enter'], { stdio: 'pipe' });
      } catch {}

      results.push({
        name: worker.name,
        session: name,
        status: 'created',
        worktreePath: worktreeInfo.worktreePath,
        branchName: worktreeInfo.branchName,
        worktreeCreated: worktreeInfo.created,
        worktreeInherited: Boolean(worktreeInfo.inherited),
      });
    } catch (err) {
      // Redact any secret values that may have been embedded in argv
      // (e.g. `-e GEMINI_API_KEY=<val>`) before surfacing the error — tmux
      // argv errors echo the full command line, and that error.message can
      // persist in state files read by the user.
      const rawMsg = typeof err?.message === 'string' ? err.message : String(err);
      const safeMsg = rawMsg.replace(/([A-Z][A-Z0-9_]*_(?:KEY|TOKEN|SECRET|PASSWORD))=\S+/g, '$1=<redacted>');
      results.push({
        name: worker.name,
        session: name,
        status: 'failed',
        error: safeMsg,
        worktreePath: worktreeInfo.worktreePath,
        branchName: worktreeInfo.branchName,
        worktreeCreated: worktreeInfo.created,
        worktreeInherited: Boolean(worktreeInfo.inherited),
      });
    }
  }

  return results;
}

/**
 * Compose the exact command string that `spawnWorkerInSession` types into the
 * tmux pane. Returned verbatim as the send-keys argument.
 *
 * This is the SINGLE, authoritative escaping level for the tmux fallback path.
 * `tmux send-keys` types its argument literally into the pane — we spawn tmux
 * via execFileSync argv, NOT a shell string, so there is no intermediate shell
 * to consume an escaping layer. The returned string must therefore already be
 * valid shell as-is for the pane's shell to interpret.
 *
 * Escaping happens exactly ONCE, at the value level:
 *   - env values are escaped via sanitizeForShellArg() and wrapped in double
 *     quotes so an odd value can't break out of its KEY="value" assignment.
 *   - `command` comes from buildWorkerCommand(), which already quotes the
 *     binary path, the `"$(cat "<file>")"` substitution, and the trailing
 *     `rm -f "<file>"` at the correct single level.
 *
 * DO NOT re-escape the composed string. Before commit d9abd9e the send-keys
 * call went through execSync(`tmux send-keys ... "${cmd}"`) where /bin/sh
 * stripped one escaping layer; that migration to execFileSync argv removed the
 * outer shell, so a second sanitizeForShellArg() pass now leaks backslashes
 * into the pane verbatim — turning `"$(cat ...)"` into the literal text
 * `\"\$(cat ...)\"`, a shell syntax error that silently no-ops the worker.
 *
 * @param {string} command - command produced by buildWorkerCommand()
 * @param {Object} [env]    - worker env vars to prefix as KEY="value"
 * @returns {string} the exact string passed as the send-keys argument
 */
export function composeWorkerCommand(command, env = {}) {
  const envStr = Object.entries(env)
    // Defense-in-depth: skip any key that isn't a valid shell identifier so a
    // malformed/injected name can't turn the prefix into an arbitrary command
    // (matches the `-e KEY=VAL` guard in createTeamSession). Production only
    // passes fixed AO_* keys, so this drops nothing in practice.
    .filter(([k]) => VALID_ENV_KEY.test(k))
    // Single-quote the VALUE so it reaches the pane shell byte-for-byte —
    // sidesteps the `!`/`$`/backtick/backslash hazards of double-quote escaping
    // (see shellQuote). shellQuote supplies its own quotes, so no `"…"` wrapper.
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join(' ');

  return envStr ? `${envStr} ${command}` : command;
}

export function spawnWorkerInSession(sessionName, command, env = {}) {
  // composeWorkerCommand() applies the single correct escaping level — see its
  // docstring for why the composed string must NOT be re-escaped here.
  const fullCommand = composeWorkerCommand(command, env);

  try {
    execFileSync(resolveBinary('tmux'), ['send-keys', '-t', sessionName, fullCommand, 'Enter'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function capturePane(sessionName, lines = 80) {
  try {
    // `-J` joins wrapped lines so a long logical line (e.g. the `__AO_EXIT__:…`
    // exit sentinel on a narrow pane) is captured intact rather than split
    // across physical rows — otherwise parseExitMarker would miss a wrapped
    // marker and the worker would look stuck until stall detection.
    return execFileSync(resolveBinary('tmux'), ['capture-pane', '-pJt', sessionName, '-S', `-${lines}`], {
      stdio: 'pipe',
      encoding: 'utf-8'
    }).trim();
  } catch {
    return null;
  }
}

export function killSession(name) {
  try {
    execFileSync(resolveBinary('tmux'), ['kill-session', '-t', name], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function killTeamSessions(teamName) {
  const prefix = `${SESSION_PREFIX}-${sanitizeName(teamName)}`;
  try {
    const sessions = execFileSync(resolveBinary('tmux'), ['list-sessions', '-F', '#{session_name}'], {
      stdio: 'pipe',
      encoding: 'utf-8'
    }).trim().split('\n');

    let killed = 0;
    for (const s of sessions) {
      if (s.startsWith(prefix)) {
        killSession(s);
        killed++;
      }
    }
    return killed;
  } catch {
    return 0;
  }
}

export function listTeamSessions(teamName) {
  const prefix = teamName
    ? `${SESSION_PREFIX}-${sanitizeName(teamName)}`
    : SESSION_PREFIX;

  try {
    const sessions = execFileSync(resolveBinary('tmux'), ['list-sessions', '-F', '#{session_name}:#{session_created}'], {
      stdio: 'pipe',
      encoding: 'utf-8'
    }).trim().split('\n');

    return sessions
      .filter(s => s.startsWith(prefix))
      .map(s => {
        const [name, created] = s.split(':');
        return { name, createdAt: parseInt(created) * 1000 };
      });
  } catch {
    return [];
  }
}

/**
 * Append the exit-status sentinel to a worker's CLI command.
 *
 * Ordering is load-bearing:
 *   1. run the CLI;
 *   2. capture its exit code into `__ao_ec` BEFORE anything else — `rm` would
 *      otherwise clobber `$?`;
 *   3. clean up the prompt file;
 *   4. echo `__AO_EXIT__:<code>` LAST so it is the final pane line before the
 *      shell prompt, where `parseExitMarker` reliably finds it.
 *
 * Portable across sh/bash/zsh (`$?`, simple var, `echo`). The marker prefix is
 * literal; only the executed echo prints a digit after the colon, so the
 * monitor never mistakes the echoed (unexpanded `$__ao_ec`) command line for a
 * real exit code.
 *
 * When `nonce` is supplied it is interpolated into the emitted line
 * (`__AO_EXIT__:<nonce>:<code>`) so the consumer can require a per-invocation
 * secret — worker OUTPUT that happens to print `__AO_EXIT__:0` cannot forge a
 * completion because it does not know the random nonce. The nonce is restricted
 * to hex by the caller, so it carries no shell metacharacters.
 *
 * @param {string} cliCommand - the CLI invocation (no trailing cleanup)
 * @param {string} safeFile    - sanitized prompt-file path to remove
 * @param {string} [nonce]     - per-invocation hex token to scope the marker
 * @returns {string}
 */
function withExitMarker(cliCommand, safeFile, nonce) {
  const marker = nonce ? `${WORKER_EXIT_MARKER}:${nonce}` : WORKER_EXIT_MARKER;
  // `<cli> && __ao_ec=0 || __ao_ec=$?` rather than `<cli>; __ao_ec=$?`:
  //  - ERREXIT-SAFE: a bare failing command at statement level would terminate a
  //    pane shell under `set -e` before `$?` is read (no sentinel → stuck worker).
  //    Operands of `&&`/`||` are exempt from errexit, so a non-zero CLI is
  //    captured instead of killing the shell.
  //  - ALWAYS ASSIGNS `__ao_ec` (0 on success via the `&& __ao_ec=0` arm, the
  //    real code on failure via `|| __ao_ec=$?`). A plain `<cli> || __ao_ec=$?`
  //    only assigns on failure, so in a REUSED pane a prior command's non-zero
  //    code leaks into this command's success (`${__ao_ec:-0}` only covers
  //    UNSET, not a stale value) — emitting a false failure. `__ao_ec=0` never
  //    fails, so the `&& … || …` chain is a safe two-way assignment.
  //  - `<cli>` stays the FIRST simple command so composeWorkerCommand's
  //    `KEY='val' ` env prefix still exports into the CLI's environment — a
  //    compound `if …`/`{ …; }` could NOT be prefixed that way.
  // The leading `echo ""` puts the marker at column 0 for the line-anchored
  // parser, so it matches the EXECUTED echo, never the typed command echo (where
  // the marker sits mid-line after `echo "`).
  return `${cliCommand} && __ao_ec=0 || __ao_ec=$?; rm -f "${safeFile}"; echo ""; echo "${marker}:$__ao_ec"`;
}

export function buildWorkerCommand(worker, opts = {}) {
  // Write the prompt to a temp file to avoid shell injection via inline quoting.
  // The command reads the file contents and passes them to the CLI via stdin
  // where possible, or via a subshell cat when the CLI only accepts a positional
  // argument. The temp file is removed and an exit-status sentinel emitted by
  // withExitMarker() once the CLI returns.
  const promptFile = writePromptFile(worker.prompt);
  const safeFile = sanitizeForShellArg(promptFile);
  // Per-invocation hex nonce (from the caller) scopes the exit sentinel so
  // worker output can't forge a completion. Omitted → legacy unscoped marker.
  const exitNonce = opts.exitNonce;

  switch (worker.type) {
    case 'codex': {
      // Mirror Claude's permission level to Codex sandbox mode.
      // Detect from autonomy.json config or Claude settings files.
      // Codex 0.118+: -a/-s are GLOBAL flags and MUST appear BEFORE `exec`.
      const autonomyConfig = opts.autonomyConfig || loadAutonomyConfig(opts.cwd || process.cwd());
      const level = resolveCodexApproval(autonomyConfig, { cwd: opts.cwd });
      const codexArgs = buildCodexExecArgs(level).join(' '); // "-a never -s <sandbox>"
      return withExitMarker(`"${resolveBinary('codex')}" ${codexArgs} exec "$(cat "${safeFile}")"`, safeFile, exitNonce);
    }
    case 'gemini': {
      // Mirror Claude's permission level to Gemini approval mode
      const gAutonomy = opts.autonomyConfig || loadAutonomyConfig(opts.cwd || process.cwd());
      const gMode = resolveGeminiApproval(gAutonomy, { cwd: opts.cwd });
      const gFlag = geminiApprovalFlag(gMode);
      const gFlagPart = gFlag ? ` ${gFlag}` : '';
      // resolveGeminiBinary: honors AO_GEMINI_BINARY and falls back to agy
      // when the gemini CLI is absent (2026-06-18 tier split).
      return withExitMarker(`"${resolveGeminiBinary().path}"${gFlagPart} -p "$(cat "${safeFile}")"`, safeFile, exitNonce);
    }
    case 'claude':
    default:
      return withExitMarker(`"${resolveBinary('claude')}" --print "$(cat "${safeFile}")"`, safeFile, exitNonce);
  }
}
