import { execSync } from 'child_process';
import { mkdirSync } from 'fs';

const SESSION_PREFIX = 'omc-team';

export function validateTmux() {
  try {
    execSync('which tmux', { stdio: 'pipe' });
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
      try { execSync(`tmux kill-session -t "${name}"`, { stdio: 'pipe' }); } catch {}

      // Create new detached session
      execSync(`tmux new-session -d -s "${name}" -c "${cwd}"`, { stdio: 'pipe' });

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
    execSync(`tmux send-keys -t "${sessionName}" "${fullCommand}" Enter`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function capturePane(sessionName, lines = 80) {
  try {
    return execSync(`tmux capture-pane -pt "${sessionName}" -S -${lines}`, {
      stdio: 'pipe',
      encoding: 'utf-8'
    }).trim();
  } catch {
    return null;
  }
}

export function killSession(name) {
  try {
    execSync(`tmux kill-session -t "${name}"`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function killTeamSessions(teamName) {
  const prefix = `${SESSION_PREFIX}-${sanitizeName(teamName)}`;
  try {
    const sessions = execSync('tmux list-sessions -F "#{session_name}"', {
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
    const sessions = execSync('tmux list-sessions -F "#{session_name}:#{session_created}"', {
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
  switch (worker.type) {
    case 'codex':
      return `codex exec "${worker.prompt.replace(/"/g, '\\"')}"`;
    case 'gemini':
      return `gemini "${worker.prompt.replace(/"/g, '\\"')}"`;
    case 'claude':
    default:
      return `claude --print "${worker.prompt.replace(/"/g, '\\"')}"`;
  }
}
