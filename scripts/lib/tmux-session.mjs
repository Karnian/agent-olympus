import { execSync } from 'child_process';
import { mkdirSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { randomUUID } from 'crypto';

const SESSION_PREFIX = 'ao-team';

// Common binary search paths across platforms
const SEARCH_PATHS = [
  '/opt/homebrew/bin',   // macOS ARM (Apple Silicon)
  '/usr/local/bin',      // macOS Intel / Linux manual installs
  '/usr/bin',            // Linux system
  '/usr/sbin',           // Linux system
  '/home/linuxbrew/.linuxbrew/bin', // Linuxbrew
];

const _binCache = new Map();

/**
 * Resolve a binary name to its full path.
 * Checks PATH first (via `which`), then falls back to common locations.
 * Results are cached for the lifetime of the process.
 */
export function resolveBinary(name) {
  if (_binCache.has(name)) return _binCache.get(name);

  // Try which first (works if PATH is correct)
  try {
    const resolved = execSync(`which ${name}`, { stdio: 'pipe', encoding: 'utf-8' }).trim();
    if (resolved) { _binCache.set(name, resolved); return resolved; }
  } catch {}

  // Fallback: scan known paths
  for (const dir of SEARCH_PATHS) {
    const candidate = `${dir}/${name}`;
    if (existsSync(candidate)) { _binCache.set(name, candidate); return candidate; }
  }

  // Last resort: return bare name, let the OS figure it out
  _binCache.set(name, name);
  return name;
}

export function validateTmux() {
  const bin = resolveBinary('tmux');
  try {
    execSync(`"${bin}" -V`, { stdio: 'pipe' });
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

    try {
      // Kill existing session if any
      try { execSync(`"${resolveBinary('tmux')}" kill-session -t "${name}"`, { stdio: 'pipe' }); } catch {}

      // Create new detached session
      execSync(`"${resolveBinary('tmux')}" new-session -d -s "${name}" -c "${cwd}"`, { stdio: 'pipe' });

      results.push({ name: worker.name, session: name, status: 'created' });
    } catch (err) {
      results.push({ name: worker.name, session: name, status: 'failed', error: err.message });
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
    execSync(`"${resolveBinary('tmux')}" send-keys -t "${sessionName}" "${safeCommand}" Enter`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function capturePane(sessionName, lines = 80) {
  try {
    return execSync(`"${resolveBinary('tmux')}" capture-pane -pt "${sessionName}" -S -${lines}`, {
      stdio: 'pipe',
      encoding: 'utf-8'
    }).trim();
  } catch {
    return null;
  }
}

export function killSession(name) {
  try {
    execSync(`"${resolveBinary('tmux')}" kill-session -t "${name}"`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function killTeamSessions(teamName) {
  const prefix = `${SESSION_PREFIX}-${sanitizeName(teamName)}`;
  try {
    const sessions = execSync(`"${resolveBinary('tmux')}" list-sessions -F "#{session_name}"`, {
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
    const sessions = execSync(`"${resolveBinary('tmux')}" list-sessions -F "#{session_name}:#{session_created}"`, {
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

export function buildWorkerCommand(worker) {
  // Write the prompt to a temp file to avoid shell injection via inline quoting.
  // The command reads the file contents and passes them to the CLI via stdin
  // where possible, or via a subshell cat when the CLI only accepts a positional
  // argument.  The temp file is cleaned up by a trailing `; rm -f <path>`.
  const promptFile = writePromptFile(worker.prompt);
  const safeFile = sanitizeForShellArg(promptFile);

  switch (worker.type) {
    case 'codex':
      // `codex exec` reads the prompt as a positional argument; pipe via stdin.
      return `"${resolveBinary('codex')}" exec "$(cat "${safeFile}")"; rm -f "${safeFile}"`;
    case 'gemini':
      return `"${resolveBinary('gemini')}" "$(cat "${safeFile}")"; rm -f "${safeFile}"`;
    case 'claude':
    default:
      return `"${resolveBinary('claude')}" --print "$(cat "${safeFile}")"; rm -f "${safeFile}"`;
  }
}
