import { createHash } from 'crypto';
import { createTeamSession, spawnWorkerInSession, capturePane, killTeamSessions, buildWorkerCommand, sessionName, validateTmux, killSession } from './tmux-session.mjs';
import { readOutbox, readAllOutboxes, cleanupTeam } from './inbox-outbox.mjs';
import { addWisdom } from './wisdom.mjs';
import { cleanupTeamWorktrees } from './worktree.mjs';
import { mkdirSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { atomicWriteFileSync } from './fs-atomic.mjs';

const STATE_DIR = '.ao/state';
const ARTIFACTS_DIR = '.ao/artifacts';

/** Default stall threshold in milliseconds (5 minutes of zero output change) */
const STALL_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Compute a short hash of a string for cheap equality comparison.
 * @param {string} str
 * @returns {string}
 */
function quickHash(str) {
  return createHash('md5').update(str || '').digest('hex');
}

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
  atomicWriteFileSync(
    join(STATE_DIR, `team-${teamName}.json`),
    JSON.stringify(state, null, 2)
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

  // Create tmux sessions (each session gets its own git worktree)
  const sessions = createTeamSession(teamName, workers, cwd);

  // Spawn workers
  for (let i = 0; i < workers.length; i++) {
    const worker = workers[i];
    const session = sessions[i];

    if (session.status !== 'created') {
      state.workers[i].status = 'failed';
      state.workers[i].error = session.error;
      // Still record worktree info even for failed sessions (for cleanup)
      state.workers[i].worktreePath = session.worktreePath || null;
      state.workers[i].branchName = session.branchName || null;
      state.workers[i].worktreeCreated = session.worktreeCreated || false;
      continue;
    }

    const command = buildWorkerCommand(worker);
    const env = {
      AO_TEAM_NAME: teamName,
      AO_WORKER_NAME: worker.name,
      AO_WORKER_TYPE: worker.type
    };

    const spawned = spawnWorkerInSession(session.session, command, env);
    state.workers[i].status = spawned ? 'running' : 'failed';
    state.workers[i].startedAt = new Date().toISOString();
    state.workers[i].session = session.session;
    // Record worktree info for merge/cleanup later
    state.workers[i].worktreePath = session.worktreePath || null;
    state.workers[i].branchName = session.branchName || null;
    state.workers[i].worktreeCreated = session.worktreeCreated || false;
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

    // Improved isDone detection:
    // Check the last few lines for a shell prompt ('$ ' at end of output),
    // rather than scanning the entire pane, to avoid false positives from
    // inline '$' in code output. Both Codex and Claude workers run in tmux
    // shells, so the completion signal is the same: the shell prompt returns.
    let isDone = false;
    if (!errorDetection.failed && paneOutput && worker.status === 'running') {
      const lastLines = paneOutput.split('\n').slice(-5).join('\n');
      // Match both bash ($) and zsh (%) prompts, with optional path/username prefix
      isDone = /[$%]\s*$/.test(lastLines.trim());
    }

    // Activity-based liveness detection: track output changes over time
    const currentHash = quickHash(paneOutput);
    const prevHash = worker.lastOutputHash || null;
    const now = Date.now();

    if (currentHash !== prevHash) {
      // Output changed — worker is active
      state.workers[i].lastOutputHash = currentHash;
      state.workers[i].lastActivityAt = new Date(now).toISOString();
      stateChanged = true;
    } else if (worker.status === 'running' && worker.lastActivityAt) {
      // Output unchanged — check for stall
      const stalledMs = now - new Date(worker.lastActivityAt).getTime();
      if (stalledMs > STALL_THRESHOLD_MS && !worker.stalled) {
        state.workers[i].stalled = true;
        state.workers[i].stalledMs = stalledMs;
        stateChanged = true;
      }
    }
    // Initialize lastActivityAt on first monitor cycle
    if (!state.workers[i].lastActivityAt && worker.status === 'running') {
      state.workers[i].lastActivityAt = new Date(now).toISOString();
      state.workers[i].lastOutputHash = currentHash;
      stateChanged = true;
    }

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

    // Report stall state to the orchestrator (informational, not a kill)
    if (state.workers[i].stalled) {
      workerEntry.stalled = true;
      workerEntry.stalledMs = state.workers[i].stalledMs;
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
    atomicWriteFileSync(
      join(artifactsDir, `${worker}.md`),
      `# ${worker} Output\n\n${result}`
    );
  }

  return results;
}

export function shutdownTeam(teamName, cwd) {
  const killed = killTeamSessions(teamName);
  cleanupTeam(teamName);

  // Clean up git worktrees for this team (fail-safe)
  if (cwd) {
    try { cleanupTeamWorktrees(cwd, teamName); } catch {}
  }

  // Clean state file
  const statePath = join(STATE_DIR, `team-${teamName}.json`);
  try { unlinkSync(statePath); } catch {}

  return { killed };
}
