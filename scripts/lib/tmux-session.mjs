import { execSync } from 'child_process';
import { mkdirSync, existsSync } from 'fs';

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
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ');

  const fullCommand = envStr ? `${envStr} ${command}` : command;

  try {
    execSync(`"${resolveBinary('tmux')}" send-keys -t "${sessionName}" "${fullCommand}" Enter`, { stdio: 'pipe' });
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
  const prompt = worker.prompt.replace(/"/g, '\\"');
  switch (worker.type) {
    case 'codex':
      return `"${resolveBinary('codex')}" exec "${prompt}"`;
    case 'gemini':
      return `"${resolveBinary('gemini')}" "${prompt}"`;
    case 'claude':
    default:
      return `"${resolveBinary('claude')}" --print "${prompt}"`;
  }
}
