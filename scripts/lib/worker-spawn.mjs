import { createHash } from 'crypto';
import { createTeamSession, spawnWorkerInSession, capturePane, killTeamSessions, buildWorkerCommand, sessionName, validateTmux, killSession } from './tmux-session.mjs';
import { readOutbox, readAllOutboxes, cleanupTeam } from './inbox-outbox.mjs';
import { addWisdom } from './wisdom.mjs';
import { cleanupTeamWorktrees } from './worktree.mjs';
import { mkdirSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { buildRecoveryStrategy } from './stuck-recovery.mjs';
import { detectClaudePermissionLevel, claudePermissionModeFlag } from './permission-detect.mjs';
import { loadAutonomyConfig } from './autonomy.mjs';
import {
  resolveCodexApproval,
  shouldDemoteCodexWorker,
  detectHostSandbox,
  buildHostSandboxWarning,
} from './codex-approval.mjs';

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

// ─── Adapter registry (strategy table) ─────────────────────────────────────
// Maps adapter name → { loader, handleKey, monitorFn, shutdownFn, statusMap, errorLabel }
// Adding a new adapter requires only one new entry here.

const ADAPTER_REGISTRY = {
  'codex-appserver': {
    loader: () => import('./codex-appserver.mjs'),
    handleKey: '_liveHandle',
    monitorFn: 'monitor',
    shutdownFn: 'shutdownServer',
    statusMap: { ready: 'running' },
    errorLabel: 'Codex app-server',
  },
  'codex-exec': {
    loader: () => import('./codex-exec.mjs'),
    handleKey: '_liveHandle',
    monitorFn: 'monitor',
    shutdownFn: 'shutdown',
    statusMap: null,
    errorLabel: 'Codex exec',
  },
  'claude-cli': {
    loader: () => import('./claude-cli.mjs'),
    handleKey: '_liveHandle',
    monitorFn: 'monitor',
    shutdownFn: 'shutdown',
    statusMap: null,
    errorLabel: 'Claude CLI',
  },
  'gemini-acp': {
    loader: () => import('./gemini-acp.mjs'),
    handleKey: '_liveHandle',
    monitorFn: 'monitor',
    shutdownFn: 'shutdownServer',
    statusMap: null,
    errorLabel: 'Gemini ACP',
  },
  'gemini-exec': {
    loader: () => import('./gemini-exec.mjs'),
    handleKey: '_liveHandle',
    monitorFn: 'monitor',
    shutdownFn: 'shutdown',
    statusMap: null,
    errorLabel: 'Gemini exec',
  },
};

/**
 * Lazily load adapter modules needed by the given adapter names.
 * @param {string[]} adapterNames
 * @returns {Promise<Object.<string, Object>>} Map of adapter name -> loaded module
 */
async function loadRequiredAdapters(adapterNames) {
  const modules = {};
  const unique = [...new Set(adapterNames)];
  for (const name of unique) {
    const entry = ADAPTER_REGISTRY[name];
    if (entry) {
      modules[name] = await entry.loader();
    }
  }
  return modules;
}

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
 * Priority for codex workers: codex-appserver > codex-exec > tmux
 * Priority for claude workers: claude-cli > tmux
 * Default (all others): tmux
 *
 * - codex-appserver: multi-turn, structured errors, turn steering (Phase 2)
 * - codex-exec: single-turn JSONL, child_process.spawn (Phase 1)
 * - claude-cli: headless Claude Code via `-p --output-format stream-json` (Phase 3)
 * - tmux: legacy fallback for all worker types
 *
 * @param {Object} worker - Worker descriptor with { type, name, prompt }
 * @param {Object} capabilities - From preflight.detectCapabilities()
 * @returns {'codex-appserver' | 'codex-exec' | 'claude-cli' | 'gemini-acp' | 'gemini-exec' | 'tmux'}
 */
export function selectAdapter(worker, capabilities = {}) {
  if (worker.type === 'codex') {
    if (capabilities.hasCodexAppServer) return 'codex-appserver';
    if (capabilities.hasCodexExecJson) return 'codex-exec';
  }
  if (worker.type === 'claude') {
    if (capabilities.hasClaudeCli) return 'claude-cli';
  }
  if (worker.type === 'gemini') {
    if (capabilities.hasGeminiAcp) return 'gemini-acp';
    if (capabilities.hasGeminiCli) return 'gemini-exec';
  }
  return 'tmux';
}

// ─── Generic adapter monitor helper ────────────────────────────────────────

/**
 * Monitor a non-tmux worker via its adapter module.
 * Replaces the 5 per-adapter monitor functions with a single generic one.
 *
 * @param {Object} worker - Worker state from team state
 * @param {Object} adapterModule - The loaded adapter module
 * @param {Object} registryEntry - The ADAPTER_REGISTRY entry for this adapter
 * @returns {{ status: string, output: string, error?: { category: string, message: string } }}
 */
function monitorAdapterWorker(worker, adapterModule, registryEntry) {
  const handle = worker[registryEntry.handleKey];
  if (!handle) {
    return { status: 'failed', output: '', error: { category: 'crash', message: `No ${registryEntry.errorLabel} handle` } };
  }
  try {
    const snapshot = adapterModule[registryEntry.monitorFn](handle);
    let status = snapshot.status;
    if (registryEntry.statusMap && registryEntry.statusMap[status]) {
      status = registryEntry.statusMap[status];
    }
    const result = { status, output: (snapshot.output || '').slice(-500) };
    if (snapshot.error) {
      const category = typeof snapshot.error === 'string'
        ? snapshot.error
        : (snapshot.error.category || 'unknown');
      const message = typeof snapshot.error === 'object' && snapshot.error.message
        ? snapshot.error.message
        : `${registryEntry.errorLabel} error: ${category}`;
      result.error = { category, message };
    }
    return result;
  } catch {
    return { status: worker.status || 'running', output: '' };
  }
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
 * IMPORTANT: `_liveHandle` is an in-memory process reference that cannot survive
 * JSON serialization. When loading team state from disk, `_liveHandle` will always
 * be undefined. Callers with an in-process reference to the live team state should
 * pass it via `opts.liveState` to enable adapter-specific graceful shutdown.
 * Without it, falls back to tmux session cleanup.
 *
 * @param {string} teamName
 * @param {string} workerName
 * @param {string} originalPrompt
 * @param {string} failureReason
 * @param {string} [sessionOverride] - tmux session name override
 * @param {{ liveState?: object }} [opts] - Optional in-memory state with live handles
 * @returns {Promise<{ fallbackNeeded: boolean, teamName: string, workerName: string, prompt: string, reason: string }>}
 */
export async function reassignToClaude(teamName, workerName, originalPrompt, failureReason, sessionOverride, opts = {}) {
  try {
    // Prefer in-memory live state (has _liveHandle), fall back to disk-loaded state
    const state = opts.liveState || loadTeamState(teamName);
    const worker = state?.workers?.find(w => w.name === workerName);
    const adapterName = worker?._adapterName || 'tmux';
    // _liveHandle is ephemeral (non-serializable) — only present when state is in-memory
    const liveHandle = worker?._liveHandle || worker?._handle;

    const registryEntry = ADAPTER_REGISTRY[adapterName];
    if (registryEntry && liveHandle) {
      try {
        const adapterModule = await registryEntry.loader();
        await adapterModule[registryEntry.shutdownFn](liveHandle);
      } catch {}
    } else {
      // Fallback: tmux cleanup (also used when _liveHandle is unavailable from disk-loaded state)
      const session = sessionOverride || sessionName(teamName, workerName);
      try { killSession(session); } catch {}
    }

    await addWisdom({
      category: 'tool',
      lesson: `Worker "${workerName}" failed (${failureReason}) — automatically reassigned to agent-olympus:executor. Avoid worker type "${worker?.type || 'unknown'}" for reason "${failureReason}" in this session.`,
      confidence: 'high',
    });

    return { fallbackNeeded: true, teamName, workerName, prompt: originalPrompt, reason: failureReason };
  } catch {
    return { fallbackNeeded: true, teamName, workerName, prompt: originalPrompt, reason: failureReason };
  }
}

/**
 * Provider-specific worker fields that must NOT survive a codex→claude
 * demotion. `model` is the canonical example: a Codex model name like
 * `gpt-5` would be passed straight through to `claude-cli --model` and
 * fail. Stripping the field forces the demoted worker to use the Claude
 * default model instead.
 */
const CODEX_PROVIDER_FIELDS = ['model'];

/**
 * Demote codex-typed workers to claude when the host permission level is
 * too low for non-interactive codex execution. Mutates each worker in-place:
 * sets `type: 'claude'`, records `_demotedFrom: 'codex'` /
 * `_demotionReason: ...`, and strips provider-specific fields (`model`)
 * that would break the Claude path. Returns the count of demoted workers.
 * Exported for hermetic unit testing.
 *
 * Why demote: a `'suggest'` level → `read-only` sandbox would let codex
 * silently complete with "I can only suggest changes" and confuse Atlas/
 * Athena into marking the task done.
 *
 * @param {Array<{type: string}>} workers - Worker descriptors (mutated in place)
 * @param {'suggest'|'auto-edit'|'full-auto'} level - Resolved permission level
 * @returns {number} Count of demoted workers
 */
export function demoteCodexWorkersIfNeeded(workers, level) {
  if (!shouldDemoteCodexWorker(level)) return 0;
  let demoted = 0;
  for (const w of workers) {
    if (w && w.type === 'codex') {
      w._demotedFrom = 'codex';
      w._demotionReason = (
        `host permission level (${level}) too low for non-interactive codex worker. ` +
        `Fix: add \`"codex": { "approval": "full-auto" }\` to .ao/autonomy.json, ` +
        `or add "Bash(*)" + "Write(*)" to permissions.allow (or set permissions.defaultMode = "bypassPermissions") ` +
        `in .claude/settings.local.json.`
      );
      w.type = 'claude';
      // Strip provider-specific fields that would corrupt the Claude path.
      for (const field of CODEX_PROVIDER_FIELDS) {
        if (field in w) {
          w[`_demoted${field[0].toUpperCase()}${field.slice(1)}`] = w[field];
          delete w[field];
        }
      }
      demoted++;
    }
  }
  return demoted;
}

/**
 * Spawn a team of workers via the appropriate adapters.
 *
 * Production call signature is `spawnTeam(teamName, workers, cwd, capabilities)`.
 * Tests can pass a fifth `_inject` parameter to supply fake adapter modules
 * (bypassing `loadRequiredAdapters` dynamic imports) and a fake
 * `createTeamSession` (bypassing real tmux). Production callers MUST NOT
 * pass `_inject`; the parameter is prefixed with `_` to make that clear.
 *
 * @param {string} teamName
 * @param {Array<Object>} workers
 * @param {string} cwd
 * @param {Object} [capabilities]
 * @param {Object} [_inject] - Test-only dependency injection
 * @param {Object} [_inject.adapters] - { 'codex-exec'?, 'codex-appserver'?, 'claude-cli'?, 'gemini-exec'?, 'gemini-acp'? }
 * @param {Function} [_inject.createTeamSession] - Replaces tmux session creation
 * @param {Function} [_inject.validateTmux] - Replaces tmux install check
 */
export async function spawnTeam(teamName, workers, cwd, capabilities = {}, _inject = null) {
  // ─── Codex permission mirroring + demotion + host sandbox warning ──────
  // Resolve the effective codex level once (intersects permissions.allow
  // with host sandbox detection).
  const autonomy = loadAutonomyConfig(cwd);
  const codexLevel = resolveCodexApproval(autonomy, { cwd });
  demoteCodexWorkersIfNeeded(workers, codexLevel);

  // Surface host-sandbox ambiguity to the user via wisdom. When the host is
  // clearly sandboxed (container/seccomp/etc) but detection couldn't pin
  // down a tier, silently trusting `permissions.allow` would be wrong.
  // `addWisdom` dedupes on Jaccard similarity, so this won't spam the log
  // on repeated Atlas/Athena runs.
  try {
    const hostSandbox = detectHostSandbox({ cwd, autonomyConfig: autonomy });
    const warning = buildHostSandboxWarning(codexLevel, hostSandbox);
    if (warning && workers.some(w => w && w.type === 'codex')) {
      // Fire-and-forget — never block spawnTeam on wisdom logging
      addWisdom({
        category: 'architecture',
        lesson: warning,
        confidence: 'medium',
      }).catch(() => {});
    }
  } catch {
    // Wisdom warning is best-effort; never let it block spawnTeam
  }

  // Determine adapter per worker (after demotion)
  const adapterNames = workers.map(w => selectAdapter(w, capabilities));
  const needsTmux = adapterNames.some(a => a === 'tmux');

  // Tmux availability check — tests can inject a fake validator
  const tmuxValidator = _inject?.validateTmux || validateTmux;
  if (needsTmux && !tmuxValidator()) {
    throw new Error('tmux is not installed. Run: brew install tmux');
  }

  // Adapter modules: tests inject pre-built fake modules, production uses
  // dynamic import via the registry. Tests MUST supply every adapter name
  // they use in the workers array; missing adapters yield nulls (same as
  // prod when the adapter isn't needed).
  const adapterModules = _inject?.adapters
    ? { ..._inject.adapters }
    : await loadRequiredAdapters(adapterNames.filter(a => a !== 'tmux'));
  const codexExec = adapterModules['codex-exec'] || null;
  const codexAppServer = adapterModules['codex-appserver'] || null;
  const claudeCli = adapterModules['claude-cli'] || null;
  const geminiExec = adapterModules['gemini-exec'] || null;
  const geminiAcp = adapterModules['gemini-acp'] || null;

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

  // Spawn tmux workers first (need sessions created in batch).
  // Tests can inject a fake createTeamSession to avoid real tmux.
  const createTeamSessionFn = _inject?.createTeamSession || createTeamSession;
  const tmuxWorkers = workers.map((w, i) => ({ ...w, idx: i })).filter((_, i) => adapterNames[i] === 'tmux');
  let sessions = [];
  if (tmuxWorkers.length > 0) {
    sessions = createTeamSessionFn(teamName, tmuxWorkers, cwd);
  }

  let tmuxIdx = 0;
  for (let i = 0; i < workers.length; i++) {
    const worker = workers[i];

    if (adapterNames[i] === 'codex-appserver') {
      // Spawn via codex-appserver adapter (multi-turn)
      let serverHandle = null;
      try {
        serverHandle = codexAppServer.startServer({ cwd });
        // Initialize handshake (required before any other method)
        const initResult = await codexAppServer.initializeServer(serverHandle);
        if (initResult.error) {
          throw new Error(initResult.error.message || 'Failed to initialize server');
        }
        // Create thread and start first turn.
        // Pass `level` so the new permission-mirroring path in createThread
        // sets both approvalPolicy ('never') and sandbox (mapped from level).
        // `serviceName` replaces the removed `--session-source` CLI flag
        // (codex 0.118+) — observability tag for Athena/Atlas workers.
        const threadResult = await codexAppServer.createThread(serverHandle, {
          cwd,
          level: codexLevel,
          ephemeral: true,
          serviceName: `agent-olympus:${teamName}`,
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
        // Cleanup: kill the server process to prevent orphaned detached processes
        if (serverHandle) {
          try { await codexAppServer.shutdownServer(serverHandle, 2000); } catch {}
        }
      }
    } else if (adapterNames[i] === 'claude-cli') {
      // Spawn via claude-cli adapter (headless Claude Code -p mode)
      try {
        const permLevel = detectClaudePermissionLevel({ cwd });
        const handle = claudeCli.spawn(worker.prompt, {
          cwd,
          model: worker.model,
          appendSystemPrompt: worker.systemPrompt,
          maxBudgetUsd: worker.maxBudgetUsd,
          permissionMode: claudePermissionModeFlag(permLevel),
        });
        state.workers[i].status = 'running';
        state.workers[i].startedAt = new Date().toISOString();
        state.workers[i]._handle = { pid: handle.pid }; // sessionId populated async via init event
        state.workers[i]._liveHandle = handle;
      } catch (err) {
        state.workers[i].status = 'failed';
        state.workers[i].error = err.message;
      }
    } else if (adapterNames[i] === 'codex-exec') {
      // Spawn via codex-exec adapter.
      // Pass `level` so spawn() builds `-a never -s <sandbox>` global flags
      // mirroring the host Claude permission tier (Codex 0.118+).
      try {
        const handle = codexExec.spawn(worker.prompt, { cwd, level: codexLevel });
        state.workers[i].status = 'running';
        state.workers[i].startedAt = new Date().toISOString();
        state.workers[i]._handle = { pid: handle.pid }; // Serializable subset
        state.workers[i]._liveHandle = handle; // Non-serializable, for in-process monitoring
      } catch (err) {
        state.workers[i].status = 'failed';
        state.workers[i].error = err.message;
      }
    } else if (adapterNames[i] === 'gemini-acp') {
      // Spawn via gemini-acp adapter (multi-turn ACP JSON-RPC 2.0)
      let serverHandle = null;
      try {
        serverHandle = geminiAcp.startServer({ cwd });
        const initResult = await geminiAcp.initializeServer(serverHandle);
        if (initResult?.error) {
          throw new Error(initResult.error.message || 'Failed to initialize Gemini ACP server');
        }
        const sessionResult = await geminiAcp.createSession(serverHandle, {
          cwd,
          approvalMode: worker.approvalMode,
          model: worker.model,
        });
        if (sessionResult?.error) {
          throw new Error(sessionResult.error.message || 'Failed to create Gemini session');
        }
        // Fire-and-forget: sendPrompt returns a promise but we don't await it
        // so the worker starts running immediately (like codex-appserver's startTurn)
        geminiAcp.sendPrompt(serverHandle, worker.prompt).catch(() => {});
        state.workers[i].status = 'running';
        state.workers[i].startedAt = new Date().toISOString();
        state.workers[i]._handle = { pid: serverHandle.pid, sessionId: serverHandle._sessionId };
        state.workers[i]._liveHandle = serverHandle;
      } catch (err) {
        state.workers[i].status = 'failed';
        state.workers[i].error = err.message;
        if (serverHandle) {
          try { await geminiAcp.shutdownServer(serverHandle, 2000); } catch {}
        }
      }
    } else if (adapterNames[i] === 'gemini-exec') {
      // Spawn via gemini-exec adapter (single-turn)
      try {
        const handle = geminiExec.spawn(worker.prompt, {
          cwd,
          model: worker.model,
          approvalMode: worker.approvalMode,
        });
        state.workers[i].status = 'running';
        state.workers[i].startedAt = new Date().toISOString();
        state.workers[i]._handle = { pid: handle.pid };
        state.workers[i]._liveHandle = handle;
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

      const command = buildWorkerCommand(worker, { cwd: session?.worktreePath || cwd });
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

export function monitorTeam(teamName, _codexExecModule, _codexAppServerModule, _claudeCliModule, _geminiExecModule, _geminiAcpModule) {
  const state = loadTeamState(teamName);
  if (!state) return null;

  // Build adapter modules map from positional args (backward-compatible signature)
  const adapterModules = {
    'codex-exec': _codexExecModule || null,
    'codex-appserver': _codexAppServerModule || null,
    'claude-cli': _claudeCliModule || null,
    'gemini-exec': _geminiExecModule || null,
    'gemini-acp': _geminiAcpModule || null,
  };

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

    // ─── Dispatch monitoring to correct adapter via registry ───
    let monitorResult;
    const registryEntry = ADAPTER_REGISTRY[adapterName];
    const adapterModule = registryEntry ? adapterModules[adapterName] : null;

    if (registryEntry && adapterModule && worker[registryEntry.handleKey]) {
      monitorResult = monitorAdapterWorker(worker, adapterModule, registryEntry);
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

      // All non-tmux adapters store output in _liveHandle._output
      const registryEntry = ADAPTER_REGISTRY[adapter];
      if (registryEntry && worker._liveHandle) {
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
      const registryEntry = ADAPTER_REGISTRY[adapter];
      if (registryEntry && worker._liveHandle) {
        try {
          const adapterModule = await registryEntry.loader();
          await adapterModule[registryEntry.shutdownFn](worker._liveHandle);
        } catch {
          // Best-effort cleanup
        }
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
