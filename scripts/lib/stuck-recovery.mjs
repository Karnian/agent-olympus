/**
 * Stuck Recovery Policy for stalled workers.
 * Provides a strategy chain: reframe → switch-agent → escalate.
 *
 * Called by worker-spawn.mjs when a worker's stalled flag is set.
 */

import { addWisdom } from './wisdom.mjs';

/**
 * Strategy definitions — exported for testing and introspection.
 * Each key maps to a static description of when that strategy is applied.
 * @type {{ reframe: object, 'switch-agent': object, escalate: object }}
 */
export const RECOVERY_STRATEGIES = {
  reframe: {
    description: 'Rewrite the worker prompt with more specific instructions extracted from last output.',
    appliesAt: 'recoveryAttempts === 0',
  },
  'switch-agent': {
    description: 'Switch to a different agent type better suited to the current stall pattern.',
    appliesAt: 'recoveryAttempts === 1',
  },
  escalate: {
    description: 'Signal the orchestrator to involve the user — automatic recovery exhausted.',
    appliesAt: 'recoveryAttempts >= 2',
  },
};

/**
 * Derive a concise context hint from the last captured pane output.
 * Looks for lines that contain an error keyword or end with '...' to surface
 * where the worker likely got stuck.
 *
 * @param {string|null|undefined} lastOutput
 * @returns {string}
 */
function extractContextHint(lastOutput) {
  if (!lastOutput || typeof lastOutput !== 'string') {
    return 'no output available';
  }

  const lines = lastOutput
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  if (lines.length === 0) return 'no output available';

  // Prefer lines that look like errors or warnings
  const errorLine = lines.find(l =>
    /error|warn|fail|exception|cannot|unable|timeout|stall/i.test(l)
  );
  if (errorLine) return errorLine.slice(0, 200);

  // Fall back to the last non-empty line
  return lines[lines.length - 1].slice(0, 200);
}

/**
 * Determine which agent type to switch to based on the current worker type.
 * Escalation ladder: executor → debugger → hephaestus → executor (wrap).
 *
 * @param {string|undefined} currentType
 * @returns {string}
 */
function nextAgentType(currentType) {
  const ladder = {
    executor: 'debugger',
    debugger: 'hephaestus',
  };
  return ladder[currentType] ?? 'executor';
}

/**
 * Build a recovery strategy for a stalled worker.
 * Returns a plain object with action, prompt, and reason fields.
 * Never throws — returns a safe escalate default on any error.
 *
 * @param {{ name: string, type: string, status: string, lastOutput: string|null, stalledMs: number, recoveryAttempts: number }} stalledWorker
 * @param {{ teamName: string, orchestrator: string, availableAgents: string[] }} context
 * @returns {{ action: 'reframe'|'switch-agent'|'escalate', prompt: string, reason: string }}
 */
export function buildRecoveryStrategy(stalledWorker, context) {
  try {
    const attempts = stalledWorker?.recoveryAttempts ?? 0;
    const workerName = stalledWorker?.name ?? 'unknown';
    const workerType = stalledWorker?.type ?? 'executor';
    const stalledMs = stalledWorker?.stalledMs ?? 0;
    const teamName = context?.teamName ?? 'unknown-team';
    const hint = extractContextHint(stalledWorker?.lastOutput);

    let action;
    let prompt;
    let reason;

    if (attempts === 0) {
      // Strategy 0: reframe — inject a more specific prompt using the last output hint
      action = 'reframe';
      prompt = [
        `Worker "${workerName}" appears stuck. The last captured output was:`,
        `  "${hint}"`,
        `Please continue from where you left off. Be explicit about:`,
        `  1. The exact file or command you are about to touch next.`,
        `  2. The concrete acceptance criterion you are trying to satisfy.`,
        `  3. Any blocker you have encountered and how you will resolve it.`,
      ].join('\n');
      reason = `Extracted last-output context: "${hint}". Reframing with explicit continuation instructions.`;
    } else if (attempts === 1) {
      // Strategy 1: switch-agent — try a more specialized role
      const nextType = nextAgentType(workerType);
      action = 'switch-agent';
      prompt = [
        `Worker "${workerName}" (type: ${workerType}) stalled twice. Escalating to agent type "${nextType}".`,
        `Hand off the task with this context:`,
        `  Last captured output: "${hint}"`,
        `  Team: ${teamName}`,
        `  Stalled for: ${Math.round(stalledMs / 1000)}s`,
      ].join('\n');
      reason = `Worker type "${workerType}" did not recover after reframe. Switching to "${nextType}" for deeper investigation.`;
    } else {
      // Strategy 2+: escalate — automatic recovery exhausted
      action = 'escalate';
      prompt = [
        `Worker "${workerName}" has failed to recover after ${attempts} attempt(s).`,
        `Summary of attempts:`,
        `  - Attempt 0: reframe prompt with last-output context`,
        `  - Attempt 1: switched agent type from "${workerType}" to "${nextAgentType(workerType)}"`,
        `  - Current attempt ${attempts}: escalating to user`,
        `Last captured output: "${hint}"`,
        `Stalled for: ${Math.round(stalledMs / 1000)}s`,
        `Please review the worker state and decide whether to retry, skip, or abort.`,
      ].join('\n');
      reason = `Exhausted ${attempts} recovery attempt(s) for worker "${workerName}". User intervention required.`;
    }

    // Record the stuck pattern in wisdom (fire-and-forget — never await)
    try {
      addWisdom({
        category: 'debug',
        lesson: `Worker "${workerName}" (type: ${workerType}) stalled in team "${teamName}" after ${Math.round(stalledMs / 1000)}s. Recovery action taken: ${action}. Hint: ${hint}`,
        confidence: 'medium',
      });
    } catch {
      // fail-safe: wisdom recording failure must not block recovery
    }

    return { action, prompt, reason };
  } catch {
    // fail-safe: always return a valid escalate descriptor
    return {
      action: 'escalate',
      prompt: 'Worker stalled and recovery strategy could not be determined. Please review manually.',
      reason: 'buildRecoveryStrategy encountered an internal error — escalating as a precaution.',
    };
  }
}

/**
 * Format a recovery strategy as a human-readable log line.
 *
 * @param {{ action: string, reason: string }} strategy
 * @param {{ name: string, type: string, stalledMs?: number, recoveryAttempts?: number }} worker
 * @returns {string}
 */
export function formatRecoveryLog(strategy, worker) {
  try {
    const name = worker?.name ?? 'unknown';
    const type = worker?.type ?? 'unknown';
    const stalledSec = worker?.stalledMs ? Math.round(worker.stalledMs / 1000) : 0;
    const attempts = worker?.recoveryAttempts ?? 0;
    const action = strategy?.action ?? 'unknown';
    const reason = strategy?.reason ?? '';

    return [
      `[stuck-recovery] worker="${name}" type="${type}"`,
      `stalledSec=${stalledSec} attempts=${attempts}`,
      `action="${action}" reason="${reason}"`,
    ].join(' | ');
  } catch {
    return '[stuck-recovery] could not format recovery log';
  }
}
