import { createTeamSession, spawnWorkerInSession, capturePane, killTeamSessions, buildWorkerCommand, sessionName, validateTmux, killSession } from './tmux-session.mjs';
import { sendMessage, readOutbox, readAllOutboxes, cleanupTeam } from './inbox-outbox.mjs';
import { addWisdom } from './wisdom.mjs';
import { writeFileSync, mkdirSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';

const STATE_DIR = '.omc/state';
const ARTIFACTS_DIR = '.omc/artifacts';

/**
 * Error patterns that indicate a Codex worker has failed unrecoverably.
 * Ordered from most specific to most generic to reduce false positives.
 * @type {Array<{ pattern: RegExp, reason: string }>}
 */
const CODEX_ERROR_PATTERNS = [
  { pattern: /authentication|unauthorized|invalid.*api.*key|API key/i, reason: 'auth_failed' },
  { pattern: /rate.?limit|429|quota.*exceeded|too many requests/i, reason: 'rate_limited' },
  { pattern: /command not found|ENOENT|codex:.*not found/i, reason: 'not_installed' },
  { pattern: /ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|network error/i, reason: 'network' },
  { pattern: /fatal error|unhandled exception|panic:|SIGSEGV|SIGABRT|segmentation fault/i, reason: 'crash' },
];

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

/**
 * Scan tmux pane output for known Codex failure signatures.
 * Returns the first matching error, or `{ failed: false }` if none match.
 * Only runs against 'codex'-type workers to avoid false positives on
 * normal Claude output that may contain words like "error" contextually.
 *
 * @param {string} output - Raw captured pane text
 * @returns {{ failed: boolean, reason?: string, message?: string }}
 */
export function detectCodexError(output) {
  try {
    if (!output || typeof output !== 'string') return { failed: false };

    for (const { pattern, reason } of CODEX_ERROR_PATTERNS) {
      const match = output.match(pattern);
      if (match) {
        return {
          failed: true,
          reason,
          message: match[0].slice(0, 200),
        };
      }
    }
    return { failed: false };
  } catch {
    return { failed: false };
  }
}

/**
 * Kill a failed Codex tmux session, record the failure in wisdom, and
 * return a descriptor that the caller can use to spawn a Claude fallback.
 *
 * The actual Task() call to spawn agent-olympus:executor cannot be made
 * from a Node.js library — it must be issued by the orchestrating Claude
 * agent. This function handles everything that CAN be done synchronously
 * (tmux cleanup + wisdom recording) and returns the information the
 * orchestrator needs to issue the Task() call.
 *
 * @param {string} teamName        - Team identifier
 * @param {string} workerName      - Name of the failed worker
 * @param {string} originalPrompt  - The prompt the Codex worker was given
 * @param {string} failureReason   - Reason code from detectCodexError()
 * @param {string} [sessionOverride] - Optional tmux session name override (e.g. 'atlas-codex-1');
 *                                     when omitted, the default sessionName(teamName, workerName) is used.
 * @returns {{ fallbackNeeded: boolean, teamName: string, workerName: string, prompt: string, reason: string }}
 */
export async function reassignToClaude(teamName, workerName, originalPrompt, failureReason, sessionOverride) {
  try {
    // Kill the failed tmux session
    const session = sessionOverride || sessionName(teamName, workerName);
    try { killSession(session); } catch {}

    // Record the fallback event as wisdom so future sessions avoid the same issue
    await addWisdom({
      category: 'tool',
      lesson: `Codex worker "${workerName}" failed (${failureReason}) — automatically reassigned to agent-olympus:executor. Avoid Codex for reason "${failureReason}" in this session.`,
      confidence: 'high',
    });

    return {
      fallbackNeeded: true,
      teamName,
      workerName,
      prompt: originalPrompt,
      reason: failureReason,
    };
  } catch {
    // fail-safe: return minimal descriptor so caller can still attempt a fallback
    return {
      fallbackNeeded: true,
      teamName,
      workerName,
      prompt: originalPrompt,
      reason: failureReason,
    };
  }
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
      completedAt: null,
      retryCount: 0,
      originalPrompt: w.prompt || '',  // persist for fallback recovery
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

  // Track whether any worker status changed so we can persist the update
  let stateChanged = false;

  for (let i = 0; i < state.workers.length; i++) {
    const worker = state.workers[i];
    const paneOutput = worker.session ? capturePane(worker.session, 200) : null;

    // Check errors FIRST for codex workers — errors take priority over completion signals
    let errorDetection = { failed: false };
    if (worker.type === 'codex' && worker.status === 'running' && paneOutput) {
      errorDetection = detectCodexError(paneOutput);
    }

    // Then check isDone (but error takes priority)
    const isDone = !errorDetection.failed && paneOutput && (
      paneOutput.includes('$') ||
      paneOutput.includes('completed') ||
      paneOutput.includes('Done') ||
      paneOutput.includes('Finished')
    );

    let resolvedStatus = worker.status;
    if (isDone) {
      resolvedStatus = 'completed';
    } else if (errorDetection.failed) {
      // For crash failures, allow one retry before marking as failed
      if (errorDetection.reason === 'crash' && (worker.retryCount || 0) < 1) {
        resolvedStatus = 'retry';
        state.workers[i].retryCount = (worker.retryCount || 0) + 1;
      } else {
        resolvedStatus = 'failed';
      }
    }

    const workerEntry = {
      name: worker.name,
      type: worker.type,
      status: resolvedStatus,
      lastOutput: paneOutput ? paneOutput.slice(-500) : null,
    };

    if (errorDetection.failed) {
      workerEntry.errorReason = errorDetection.reason;
      workerEntry.errorMessage = errorDetection.message;
    }

    status.workers.push(workerEntry);

    // Persist any status changes back to the state object
    const newStatus = workerEntry.status;
    if (newStatus && newStatus !== state.workers[i].status) {
      state.workers[i].status = newStatus;
      if (workerEntry.errorReason) {
        state.workers[i].errorReason = workerEntry.errorReason;
      }
      stateChanged = true;
    }
  }

  // Write state file once if anything changed
  if (stateChanged) saveTeamState(teamName, state);

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
