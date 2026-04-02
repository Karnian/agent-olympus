import { createHash } from 'crypto';
import { createTeamSession, spawnWorkerInSession, capturePane, killTeamSessions, buildWorkerCommand, sessionName, validateTmux, killSession } from './tmux-session.mjs';
import { readOutbox, readAllOutboxes, cleanupTeam } from './inbox-outbox.mjs';
import { addWisdom } from './wisdom.mjs';
import { cleanupTeamWorktrees } from './worktree.mjs';
import { mkdirSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { buildRecoveryStrategy } from './stuck-recovery.mjs';

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
 * Error patterns that indicate a Codex worker has failed unrecoverably (tmux path).
 * @type {Array<{ pattern: RegExp, reason: string }>}
 */
const CODEX_ERROR_PATTERNS = [
  { pattern: /authentication|unauthorized|invalid.*api.*key|API key/i, reason: 'auth_failed' },
  { pattern: /rate.?limit|429|quota.*exceeded|too many requests/i, reason: 'rate_limited' },
  { pattern: /command not found|ENOENT|codex:.*not found|No such file or directory|not found in PATH/i, reason: 'not_installed' },
  { pattern: /ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|network error/i, reason: 'network' },
  { pattern: /fatal error|unhandled exception|panic:|SIGSEGV|SIGABRT|segmentation fault/i, reason: 'crash' },
];

// ─── State persistence ──────────────────────────────────────────────────────

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

// ─── Adapter selection ──────────────────────────────────────────────────────

/**
 * Select the appropriate spawn adapter for a worker.
 * Pure function — no side effects.
 *
 * Priority: codex-appserver > codex-exec > tmux
 * - codex-appserver: multi-turn, structured errors, turn steering (Phase 2)
 * - codex-exec: single-turn JSONL, child_process.spawn (Phase 1)
 * - tmux: legacy fallback for all worker types
 *
 * @param {Object} worker - Worker descriptor with { type, name, prompt }
 * @param {Object} capabilities - From preflight.detectCapabilities()
 * @returns {'codex-appserver' | 'codex-exec' | 'tmux'}
 */
export function selectAdapter(worker, capabilities = {}) {
  if (worker.type === 'codex') {
    if (capabilities.hasCodexAppServer) return 'codex-appserver';
    if (capabilities.hasCodexExecJson) return 'codex-exec';
  }
  return 'tmux';
}

/**
 * Lazily load the codex-exec adapter module.
 * @returns {Promise<Object>} The codex-exec module
 */
async function loadCodexExecAdapter() {
  return import('./codex-exec.mjs');
}

/**
 * Lazily load the codex-appserver adapter module.
 * @returns {Promise<Object>} The codex-appserver module
 */
async function loadCodexAppServerAdapter() {
  return import('./codex-appserver.mjs');
}

// ─── Tmux adapter helpers (inline — wraps existing tmux-session functions) ──

/**
 * Monitor a tmux-based worker via capturePane + error detection.
 * Returns a MonitorResult-shaped object.
 *
 * @param {Object} worker - Worker state object with session, type, etc.
 * @returns {{ status: string, output: string, error?: { category: string, message: string }, stalled?: boolean, stalledMs?: number }}
 */
function monitorTmuxWorker(worker) {
  const paneOutput = worker.session ? capturePane(worker.session, 200) : null;

  // Error detection for codex workers in tmux path
  let errorDetection = { failed: false };
  if (worker.type === 'codex' && worker.status === 'running' && paneOutput) {
    errorDetection = detectCodexError(paneOutput);
  }

  // Completion detection: shell prompt returns
  let isDone = false;
  if (!errorDetection.failed && paneOutput && worker.status === 'running') {
    const lastLines = paneOutput.split('\n').slice(-5).join('\n');
    isDone = /[$%]\s*$/.test(lastLines.trim());
  }

  const result = {
    status: isDone ? 'completed' : (errorDetection.failed ? 'failed' : worker.status),
    output: paneOutput ? paneOutput.slice(-500) : '',
  };

  if (errorDetection.failed) {
    result.error = {
      category: errorDetection.reason,
      message: errorDetection.message || 'Codex tmux error',
    };
  }

  return result;
}

/**
 * Monitor a codex-exec-based worker via the codex-exec adapter.
 * Returns a MonitorResult-shaped object.
 *
 * @param {Object} worker - Worker state object with _handle
 * @param {Object} codexExec - The loaded codex-exec module
 * @returns {{ status: string, output: string, error?: { category: string, message: string }, stalled?: boolean, stalledMs?: number }}
 */
function monitorCodexExecWorker(worker, codexExec) {
  if (!worker._handle) {
    return { status: 'failed', output: '', error: { category: 'crash', message: 'No codex-exec handle' } };
  }
  const mr = codexExec.monitor(worker._handle);
  const result = {
    status: mr.status,
    output: (mr.output || '').slice(-500),
  };
  if (mr.error) {
    result.error = mr.error;
  }
  return result;
}

/**
 * Monitor a codex-appserver-based worker via the codex-appserver adapter.
 * Returns a MonitorResult-shaped object.
 *
 * @param {Object} worker - Worker state object with _liveHandle
 * @param {Object} appserver - The loaded codex-appserver module
 * @returns {{ status: string, output: string, error?: { category: string, message: string }, stalled?: boolean, stalledMs?: number }}
 */
function monitorCodexAppServerWorker(worker, appserver) {
  if (!worker._liveHandle) {
    return { status: 'failed', output: '', error: { category: 'crash', message: 'No app-server handle' } };
  }
  const mr = appserver.monitor(worker._liveHandle);
  const result = {
    status: mr.status === 'ready' ? 'running' : mr.status,
    output: (mr.output || '').slice(-500),
  };
  if (mr.error) {
    result.error = mr.error;
  }
  return result;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Scan tmux pane output for known Codex failure signatures.
 * Returns the first matching error, or `{ failed: false }` if none match.
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
        return { failed: true, reason, message: match[0].slice(0, 200) };
      }
    }
    return { failed: false };
  } catch {
    return { failed: false };
  }
}

/**
 * Kill a failed worker, record the failure in wisdom, and return a
 * descriptor for the orchestrator to spawn a Claude fallback.
 * Adapter-aware: calls the correct shutdown method based on _adapterName.
 *
 * @param {string} teamName
 * @param {string} workerName
 * @param {string} originalPrompt
 * @param {string} failureReason
 * @param {string} [sessionOverride] - tmux session name override
 * @returns {Promise<{ fallbackNeeded: boolean, teamName: string, workerName: string, prompt: string, reason: string }>}
 */
export async function reassignToClaude(teamName, workerName, originalPrompt, failureReason, sessionOverride) {
  try {
    // Load team state to find the worker's adapter
    const state = loadTeamState(teamName);
    const worker = state?.workers?.find(w => w.name === workerName);
    const adapterName = worker?._adapterName || 'tmux';

    if (adapterName === 'codex-appserver' && worker?._liveHandle) {
      // Shutdown via codex-appserver adapter
      try {
        const appserver = await loadCodexAppServerAdapter();
        await appserver.shutdownServer(worker._liveHandle);
      } catch {}
    } else if (adapterName === 'codex-exec' && worker?._handle) {
      // Shutdown via codex-exec adapter
      try {
        const codexExec = await loadCodexExecAdapter();
        codexExec.shutdown(worker._handle);
      } catch {}
    } else {
      // Shutdown via tmux (default)
      const session = sessionOverride || sessionName(teamName, workerName);
      try { killSession(session); } catch {}
    }

    await addWisdom({
      category: 'tool',
      lesson: `Codex worker "${workerName}" failed (${failureReason}) — automatically reassigned to agent-olympus:executor. Avoid Codex for reason "${failureReason}" in this session.`,
      confidence: 'high',
    });

    return { fallbackNeeded: true, teamName, workerName, prompt: originalPrompt, reason: failureReason };
  } catch {
    return { fallbackNeeded: true, teamName, workerName, prompt: originalPrompt, reason: failureReason };
  }
}

export async function spawnTeam(teamName, workers, cwd, capabilities = {}) {
  // Determine adapter per worker
  const adapterNames = workers.map(w => selectAdapter(w, capabilities));
  const needsTmux = adapterNames.some(a => a === 'tmux');

  if (needsTmux && !validateTmux()) {
    throw new Error('tmux is not installed. Run: brew install tmux');
  }

  // Lazy-load adapters as needed
  let codexExec = null;
  let codexAppServer = null;
  if (adapterNames.includes('codex-exec')) {
    codexExec = await loadCodexExecAdapter();
  }
  if (adapterNames.includes('codex-appserver')) {
    codexAppServer = await loadCodexAppServerAdapter();
  }

  const state = {
    teamName,
    workers: workers.map((w, i) => ({
      ...w,
      status: 'pending',
      startedAt: null,
      completedAt: null,
      retryCount: 0,
      originalPrompt: w.prompt || '',
      _adapterName: adapterNames[i],
    })),
    phase: 'spawning',
    startedAt: new Date().toISOString(),
    cwd
  };

  // Spawn tmux workers first (need sessions created in batch)
  const tmuxWorkers = workers.map((w, i) => ({ ...w, idx: i })).filter((_, i) => adapterNames[i] === 'tmux');
  let sessions = [];
  if (tmuxWorkers.length > 0) {
    sessions = createTeamSession(teamName, tmuxWorkers, cwd);
  }

  let tmuxIdx = 0;
  for (let i = 0; i < workers.length; i++) {
    const worker = workers[i];

    if (adapterNames[i] === 'codex-appserver') {
      // Spawn via codex-appserver adapter (multi-turn)
      try {
        const serverHandle = codexAppServer.startServer({
          cwd,
          sessionSource: `agent-olympus:${teamName}`,
        });
        // Create thread and start first turn
        const threadResult = await codexAppServer.createThread(serverHandle, {
          cwd,
          approvalPolicy: 'never',
          ephemeral: true,
        });
        if (threadResult.error) {
          throw new Error(threadResult.error.message || 'Failed to create thread');
        }
        const turnResult = await codexAppServer.startTurn(serverHandle, worker.prompt);
        if (turnResult.error) {
          throw new Error(turnResult.error.message || 'Failed to start turn');
        }
        state.workers[i].status = 'running';
        state.workers[i].startedAt = new Date().toISOString();
        state.workers[i]._handle = { pid: serverHandle.pid, threadId: serverHandle.threadId, turnId: serverHandle.turnId };
        state.workers[i]._liveHandle = serverHandle;
      } catch (err) {
        state.workers[i].status = 'failed';
        state.workers[i].error = err.message;
      }
    } else if (adapterNames[i] === 'codex-exec') {
      // Spawn via codex-exec adapter
      try {
        const handle = codexExec.spawn(worker.prompt, { cwd });
        state.workers[i].status = 'running';
        state.workers[i].startedAt = new Date().toISOString();
        state.workers[i]._handle = { pid: handle.pid }; // Serializable subset
        state.workers[i]._liveHandle = handle; // Non-serializable, for in-process monitoring
      } catch (err) {
        state.workers[i].status = 'failed';
        state.workers[i].error = err.message;
      }
    } else {
      // Spawn via tmux
      const session = sessions[tmuxIdx++];
      if (!session || session.status !== 'created') {
        state.workers[i].status = 'failed';
        state.workers[i].error = session?.error || 'Session creation failed';
        state.workers[i].worktreePath = session?.worktreePath || null;
        state.workers[i].branchName = session?.branchName || null;
        state.workers[i].worktreeCreated = session?.worktreeCreated || false;
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
      state.workers[i].worktreePath = session?.worktreePath || null;
      state.workers[i].branchName = session?.branchName || null;
      state.workers[i].worktreeCreated = session?.worktreeCreated || false;
    }
  }

  state.phase = 'running';
  saveTeamState(teamName, state);
  return state;
}

export function monitorTeam(teamName, _codexExecModule, _codexAppServerModule) {
  const state = loadTeamState(teamName);
  if (!state) return null;

  // Lazy-loaded adapter modules (passed in or null)
  const codexExec = _codexExecModule || null;
  const codexAppServer = _codexAppServerModule || null;

  const status = {
    teamName,
    phase: state.phase,
    workers: [],
    outboxes: readAllOutboxes(teamName)
  };

  let stateChanged = false;

  for (let i = 0; i < state.workers.length; i++) {
    const worker = state.workers[i];
    const adapterName = worker._adapterName || 'tmux';

    // ─── Dispatch monitoring to correct adapter ───
    let monitorResult;
    if (adapterName === 'codex-appserver' && codexAppServer && worker._liveHandle) {
      monitorResult = monitorCodexAppServerWorker(worker, codexAppServer);
    } else if (adapterName === 'codex-exec' && codexExec && worker._liveHandle) {
      monitorResult = monitorCodexExecWorker({ ...worker, _handle: worker._liveHandle }, codexExec);
    } else {
      monitorResult = monitorTmuxWorker(worker);
    }

    // ─── Activity-based stall detection (adapter-agnostic) ───
    const currentHash = quickHash(monitorResult.output);
    const prevHash = worker.lastOutputHash || null;
    const now = Date.now();

    if (currentHash !== prevHash) {
      state.workers[i].lastOutputHash = currentHash;
      state.workers[i].lastActivityAt = new Date(now).toISOString();
      stateChanged = true;
    } else if (worker.status === 'running' && worker.lastActivityAt) {
      const stalledMs = now - new Date(worker.lastActivityAt).getTime();
      if (stalledMs > STALL_THRESHOLD_MS && !worker.stalled) {
        state.workers[i].stalled = true;
        state.workers[i].stalledMs = stalledMs;
        stateChanged = true;
      }
    }
    if (!state.workers[i].lastActivityAt && worker.status === 'running') {
      state.workers[i].lastActivityAt = new Date(now).toISOString();
      state.workers[i].lastOutputHash = currentHash;
      stateChanged = true;
    }

    // ─── Resolve final status ───
    let resolvedStatus = worker.status;
    if (monitorResult.status === 'completed') {
      resolvedStatus = 'completed';
    } else if (monitorResult.error) {
      // For crash failures, allow one retry before marking as failed
      if (monitorResult.error.category === 'crash' && (worker.retryCount || 0) < 1) {
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
      lastOutput: monitorResult.output || null,
    };

    if (monitorResult.error) {
      workerEntry.errorReason = monitorResult.error.category;
      workerEntry.errorMessage = monitorResult.error.message;
    }

    // ─── Stall recovery (adapter-agnostic) ───
    if (state.workers[i].stalled && !state.workers[i].recovered) {
      workerEntry.stalled = true;
      workerEntry.stalledMs = state.workers[i].stalledMs;

      if (state.workers[i].recoveryAttempts == null) {
        state.workers[i].recoveryAttempts = 0;
      }
      try {
        workerEntry.recoveryStrategy = buildRecoveryStrategy(
          { name: worker.name, type: worker.type, status: worker.status, lastOutput: workerEntry.lastOutput, stalledMs: state.workers[i].stalledMs, recoveryAttempts: state.workers[i].recoveryAttempts },
          { teamName, orchestrator: 'athena', availableAgents: [] }
        );
      } catch {}
      state.workers[i].recoveryAttempts = (state.workers[i].recoveryAttempts || 0) + 1;
      stateChanged = true;
    }

    status.workers.push(workerEntry);

    // Persist status changes
    if (resolvedStatus !== state.workers[i].status) {
      state.workers[i].status = resolvedStatus;
      if (workerEntry.errorReason) state.workers[i].errorReason = workerEntry.errorReason;
      stateChanged = true;
    }
  }

  if (stateChanged) saveTeamState(teamName, state);
  return status;
}

export function collectResults(teamName) {
  const outboxes = readAllOutboxes(teamName);
  const results = {};

  for (const [worker, messages] of Object.entries(outboxes)) {
    results[worker] = messages.map(m => m.body).join('\n\n');
  }

  const state = loadTeamState(teamName);
  if (state) {
    for (const worker of state.workers) {
      // Skip workers that already have outbox results
      if (results[worker.name]) continue;

      const adapter = worker._adapterName || 'tmux';

      if (adapter === 'codex-appserver' && worker._liveHandle) {
        // App-server: output is in the live handle
        const output = worker._liveHandle._output;
        if (output) results[worker.name] = output;
      } else if (adapter === 'codex-exec' && worker._liveHandle) {
        // Codex-exec: output is in the live handle
        const output = worker._liveHandle._output;
        if (output) results[worker.name] = output;
      } else if (worker.session) {
        // Tmux: capture pane output
        const output = capturePane(worker.session, 200);
        if (output) results[worker.name] = output;
      }
    }
  }

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

export async function shutdownTeam(teamName, cwd) {
  // Shutdown non-tmux workers first (appserver + codex-exec child processes)
  const state = loadTeamState(teamName);
  if (state) {
    for (const worker of state.workers) {
      const adapter = worker._adapterName || 'tmux';
      try {
        if (adapter === 'codex-appserver' && worker._liveHandle) {
          const appserver = await loadCodexAppServerAdapter();
          await appserver.shutdownServer(worker._liveHandle);
        } else if (adapter === 'codex-exec' && worker._liveHandle) {
          const codexExec = await loadCodexExecAdapter();
          await codexExec.shutdown(worker._liveHandle);
        }
      } catch {
        // Best-effort cleanup
      }
    }
  }

  // Kill tmux sessions
  const killed = killTeamSessions(teamName);
  cleanupTeam(teamName);

  if (cwd) {
    try { cleanupTeamWorktrees(cwd, teamName); } catch {}
  }

  const statePath = join(STATE_DIR, `team-${teamName}.json`);
  try { unlinkSync(statePath); } catch {}

  return { killed };
}
