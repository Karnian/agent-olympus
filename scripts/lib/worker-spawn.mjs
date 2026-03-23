import { createTeamSession, spawnWorkerInSession, capturePane, killTeamSessions, buildWorkerCommand, sessionName, validateTmux } from './tmux-session.mjs';
import { sendMessage, readOutbox, readAllOutboxes, cleanupTeam } from './inbox-outbox.mjs';
import { writeFileSync, mkdirSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';

const STATE_DIR = '.omc/state';
const ARTIFACTS_DIR = '.omc/artifacts';

function saveTeamState(teamName, state) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(STATE_DIR, `team-${teamName}.json`),
    JSON.stringify(state, null, 2),
    { encoding: 'utf-8', mode: 0o600 }
  );
}

function loadTeamState(teamName) {
  const path = join(STATE_DIR, `team-${teamName}.json`);
  try { return JSON.parse(readFileSync(path, 'utf-8')); }
  catch { return null; }
}

export async function spawnTeam(teamName, workers, cwd) {
  if (!validateTmux()) {
    throw new Error('tmux is not installed. Run: brew install tmux');
  }

  const state = {
    teamName,
    workers: workers.map(w => ({
      ...w,
      status: 'pending',
      startedAt: null,
      completedAt: null
    })),
    phase: 'spawning',
    startedAt: new Date().toISOString(),
    cwd
  };

  // Create tmux sessions
  const sessions = createTeamSession(teamName, workers, cwd);

  // Spawn workers
  for (let i = 0; i < workers.length; i++) {
    const worker = workers[i];
    const session = sessions[i];

    if (session.status !== 'created') {
      state.workers[i].status = 'failed';
      state.workers[i].error = session.error;
      continue;
    }

    const command = buildWorkerCommand(worker);
    const env = {
      OMC_TEAM_NAME: teamName,
      OMC_WORKER_NAME: worker.name,
      OMC_WORKER_TYPE: worker.type
    };

    const spawned = spawnWorkerInSession(session.session, command, env);
    state.workers[i].status = spawned ? 'running' : 'failed';
    state.workers[i].startedAt = new Date().toISOString();
    state.workers[i].session = session.session;
  }

  state.phase = 'running';
  saveTeamState(teamName, state);
  return state;
}

export function monitorTeam(teamName) {
  const state = loadTeamState(teamName);
  if (!state) return null;

  const status = {
    teamName,
    phase: state.phase,
    workers: [],
    outboxes: readAllOutboxes(teamName)
  };

  for (const worker of state.workers) {
    const paneOutput = worker.session ? capturePane(worker.session, 30) : null;

    // Heuristic: check if worker is done
    const isDone = paneOutput && (
      paneOutput.includes('$') || // back to shell prompt
      paneOutput.includes('completed') ||
      paneOutput.includes('Done') ||
      paneOutput.includes('Finished')
    );

    status.workers.push({
      name: worker.name,
      type: worker.type,
      status: isDone ? 'completed' : worker.status,
      lastOutput: paneOutput ? paneOutput.slice(-500) : null
    });
  }

  return status;
}

export function collectResults(teamName) {
  const outboxes = readAllOutboxes(teamName);
  const results = {};

  for (const [worker, messages] of Object.entries(outboxes)) {
    results[worker] = messages.map(m => m.body).join('\n\n');
  }

  // Also capture final pane outputs
  const state = loadTeamState(teamName);
  if (state) {
    for (const worker of state.workers) {
      if (worker.session) {
        const output = capturePane(worker.session, 200);
        if (output && !results[worker.name]) {
          results[worker.name] = output;
        }
      }
    }
  }

  // Save artifacts
  const artifactsDir = join(ARTIFACTS_DIR, 'team', teamName);
  mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });

  for (const [worker, result] of Object.entries(results)) {
    writeFileSync(
      join(artifactsDir, `${worker}.md`),
      `# ${worker} Output\n\n${result}`,
      { encoding: 'utf-8', mode: 0o600 }
    );
  }

  return results;
}

export function shutdownTeam(teamName) {
  const killed = killTeamSessions(teamName);
  cleanupTeam(teamName);

  // Clean state file
  const statePath = join(STATE_DIR, `team-${teamName}.json`);
  try { unlinkSync(statePath); } catch {}

  return { killed };
}
