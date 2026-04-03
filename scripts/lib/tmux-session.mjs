import { execFileSync } from 'child_process';
import { mkdirSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { randomUUID } from 'crypto';
import { dirname } from 'path';
import { createWorkerWorktree } from './worktree.mjs';
import { resolveBinary, resolveClaudeBinary, SEARCH_PATHS } from './resolve-binary.mjs';
import { resolveCodexApproval, codexApprovalFlag } from './codex-approval.mjs';
import { loadAutonomyConfig } from './autonomy.mjs';

// Re-export for backward compatibility with callers that import from tmux-session
export { resolveBinary } from './resolve-binary.mjs';

const SESSION_PREFIX = 'ao-team';

/**
 * Build a robust PATH string that includes all known binary directories.
 * Merges the current process PATH, SEARCH_PATHS, and parent directories of
 * resolved binaries (codex, claude, tmux, git, node).
 * Used to inject PATH into tmux sessions so workers can find CLIs regardless
 * of how the shell inside tmux initializes its environment.
 *
 * @returns {string} colon-separated PATH string
 */
export function buildResolvedPath() {
  const dirs = new Set();

  // Collect from current process PATH
  if (process.env.PATH) {
    for (const p of process.env.PATH.split(':')) {
      if (p) dirs.add(p);
    }
  }

  // Add known search paths that actually exist
  for (const p of SEARCH_PATHS) {
    if (existsSync(p)) dirs.add(p);
  }

  // Add parent directories of resolved key binaries
  for (const bin of ['codex', 'tmux', 'git', 'node']) {
    try {
      const resolved = resolveBinary(bin);
      if (resolved && resolved !== bin && resolved.includes('/')) {
        dirs.add(dirname(resolved));
      }
    } catch {}
  }

  // Claude CLI lives in a versioned app bundle path — use dedicated resolver
  try {
    const claudePath = resolveClaudeBinary();
    if (claudePath && claudePath !== 'claude' && claudePath.includes('/')) {
      dirs.add(dirname(claudePath));
    }
  } catch {}

  return [...dirs].join(':');
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
 * Escape a string for safe embedding inside a double-quoted shell argument
 * that will be passed via tmux send-keys.
 *
 * tmux send-keys forwards the string literally to the terminal, which means
 * the shell running inside the pane interprets it.  We must escape every
 * character that has special meaning to the shell:
 *   "  →  \"   (closes the surrounding double-quote)
 *   \  →  \\   (escape character — must come first)
 *   $  →  \$   (variable expansion)
 *   `  →  \`   (command substitution)
 *   !  →  \!   (history expansion in bash)
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

    // Create an isolated git worktree for this worker (fail-safe: falls back to cwd)
    const worktreeInfo = createWorkerWorktree(cwd, teamName, worker.name);
    const sessionCwd = worktreeInfo.created ? worktreeInfo.worktreePath : cwd;

    try {
      // Kill existing session if any
      const tmux = resolveBinary('tmux');
      try { execFileSync(tmux, ['kill-session', '-t', name], { stdio: 'pipe' }); } catch {}

      // Create new detached session rooted at the worker's worktree (or cwd on fallback)
      execFileSync(tmux, ['new-session', '-d', '-s', name, '-c', sessionCwd], { stdio: 'pipe' });

      // Inject resolved PATH so CLIs (codex, claude, etc.) are always findable,
      // even when the tmux shell doesn't inherit the parent's full PATH.
      const resolvedPath = buildResolvedPath();
      try {
        execFileSync(tmux, ['send-keys', '-t', name, `export PATH="${resolvedPath}"`, 'Enter'], { stdio: 'pipe' });
      } catch {}

      results.push({
        name: worker.name,
        session: name,
        status: 'created',
        worktreePath: worktreeInfo.worktreePath,
        branchName: worktreeInfo.branchName,
        worktreeCreated: worktreeInfo.created,
      });
    } catch (err) {
      results.push({
        name: worker.name,
        session: name,
        status: 'failed',
        error: err.message,
        worktreePath: worktreeInfo.worktreePath,
        branchName: worktreeInfo.branchName,
        worktreeCreated: worktreeInfo.created,
      });
    }
  }

  return results;
}

export function spawnWorkerInSession(sessionName, command, env = {}) {
  const envStr = Object.entries(env)
    // Env values are sanitized so they can be embedded inside double-quotes.
    .map(([k, v]) => `${k}="${sanitizeForShellArg(v)}"`)
    .join(' ');

  const fullCommand = envStr ? `${envStr} ${command}` : command;

  // `tmux send-keys` passes the argument string directly to the terminal.
  // Wrap in double-quotes and escape the content so that special shell
  // characters inside `fullCommand` cannot break out of the argument.
  const safeCommand = sanitizeForShellArg(fullCommand);

  try {
    execFileSync(resolveBinary('tmux'), ['send-keys', '-t', sessionName, safeCommand, 'Enter'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function capturePane(sessionName, lines = 80) {
  try {
    return execFileSync(resolveBinary('tmux'), ['capture-pane', '-pt', sessionName, '-S', `-${lines}`], {
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

export function buildWorkerCommand(worker, opts = {}) {
  // Write the prompt to a temp file to avoid shell injection via inline quoting.
  // The command reads the file contents and passes them to the CLI via stdin
  // where possible, or via a subshell cat when the CLI only accepts a positional
  // argument.  The temp file is cleaned up by a trailing `; rm -f <path>`.
  const promptFile = writePromptFile(worker.prompt);
  const safeFile = sanitizeForShellArg(promptFile);

  switch (worker.type) {
    case 'codex': {
      // Mirror Claude's permission level to Codex approval mode.
      // Detect from autonomy.json config or Claude settings files.
      const autonomyConfig = opts.autonomyConfig || loadAutonomyConfig(opts.cwd || process.cwd());
      const approval = resolveCodexApproval(autonomyConfig, { cwd: opts.cwd });
      const flag = codexApprovalFlag(approval);
      const flagPart = flag ? ` ${flag}` : '';
      return `"${resolveBinary('codex')}"${flagPart} exec "$(cat "${safeFile}")"; rm -f "${safeFile}"`;
    }
    case 'gemini':
      return `"${resolveBinary('gemini')}" "$(cat "${safeFile}")"; rm -f "${safeFile}"`;
    case 'claude':
    default:
      return `"${resolveBinary('claude')}" --print "$(cat "${safeFile}")"; rm -f "${safeFile}"`;
  }
}
