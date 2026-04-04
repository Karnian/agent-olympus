/**
 * Checkpoint system for Atlas/Athena session recovery
 * Saves phase state so interrupted sessions can resume from where they stopped
 */

import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './fs-atomic.mjs';
import { getActiveRunId, addEvent } from './run-artifacts.mjs';

const STATE_DIR = path.join('.ao', 'state');
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export const PHASE_NAMES = {
  atlas:  ['TRIAGE', 'ANALYZE', 'PLAN', 'EXECUTE', 'VERIFY', 'REVIEW', 'SLOP_CLEAN', 'COMMIT'],
  athena: ['TRIAGE', 'PLAN', 'SPAWN_TEAM', 'MONITOR', 'INTEGRATE_VERIFY', 'REVIEW', 'SLOP_CLEAN', 'COMMIT'],
};

/**
 * Build the checkpoint filename, optionally scoped to a session.
 * @param {'atlas'|'athena'} orchestrator
 * @param {string|null} sessionId
 * @returns {string} filename (not full path)
 */
function checkpointFilename(orchestrator, sessionId) {
  return sessionId
    ? `checkpoint-${orchestrator}-${sessionId}.json`
    : `checkpoint-${orchestrator}.json`;
}

/**
 * Try to load and validate a single checkpoint file.
 * Returns the checkpoint object if valid and not expired, null otherwise.
 * Deletes expired files as a side effect.
 * @param {string} filePath
 * @returns {Promise<object|null>}
 */
async function tryLoadCheckpointFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const checkpoint = JSON.parse(raw);

    const savedAt = new Date(checkpoint.savedAt).getTime();
    if (Number.isNaN(savedAt)) {
      await fs.unlink(filePath).catch(() => {});
      return null;
    }

    if (Date.now() - savedAt > TTL_MS) {
      await fs.unlink(filePath).catch(() => {});
      return null;
    }

    return checkpoint;
  } catch {
    return null;
  }
}

/**
 * Save checkpoint after each phase transition.
 * When data.sessionId is provided, the checkpoint is scoped to that session,
 * allowing concurrent Atlas/Athena runs without overwriting each other.
 *
 * @param {'atlas'|'athena'} orchestrator
 * @param {{ phase: number, sessionId?: string, prdSnapshot?: object, completedStories?: string[], activeWorkers?: string[], worktrees?: Object.<string, {path: string, branch: string}>, startedAt?: string, taskDescription?: string }} data
 */
export async function saveCheckpoint(orchestrator, data) {
  try {
    await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });

    const sessionId = data.sessionId || null;
    const checkpoint = {
      orchestrator,
      ...data,
      savedAt: new Date().toISOString(),
    };

    const filePath = path.join(STATE_DIR, checkpointFilename(orchestrator, sessionId));

    // Emit events to active run if one exists (US-002 + US-003)
    const activeRunId = getActiveRunId(orchestrator);
    if (activeRunId) {
      // Detect phase change for phase_transition event (US-003)
      let previousPhase = null;
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const prev = JSON.parse(raw);
        previousPhase = prev.phase ?? null;
      } catch {
        // No previous checkpoint — first save
      }

      const currentPhase = data.phase ?? null;
      if (currentPhase !== null && currentPhase !== previousPhase) {
        addEvent(activeRunId, {
          type: 'phase_transition',
          phase: currentPhase,
          detail: {
            from: previousPhase,
            to: currentPhase,
            fromName: previousPhase !== null ? (PHASE_NAMES[orchestrator]?.[previousPhase] ?? null) : null,
            toName: PHASE_NAMES[orchestrator]?.[currentPhase] ?? null,
          },
        });
      }

      // Emit checkpoint_saved event (US-002)
      addEvent(activeRunId, {
        type: 'checkpoint_saved',
        phase: currentPhase,
        detail: { ...data },
      });
    }

    await atomicWriteFile(filePath, JSON.stringify(checkpoint, null, 2));
  } catch {
    // fail-safe: never throw
  }
}

/**
 * Load existing checkpoint if < 24h old.
 * When opts.sessionId is provided, looks for that session's checkpoint first.
 * Without sessionId, finds the most recent valid checkpoint (legacy or session-scoped).
 *
 * @param {'atlas'|'athena'} orchestrator
 * @param {{ sessionId?: string }} [opts]
 * @returns {Promise<object|null>}
 */
export async function loadCheckpoint(orchestrator, opts = {}) {
  try {
    const sessionId = opts.sessionId || null;

    // 1. If sessionId provided, try exact match first
    if (sessionId) {
      const exact = await tryLoadCheckpointFile(
        path.join(STATE_DIR, checkpointFilename(orchestrator, sessionId))
      );
      if (exact) return exact;
    }

    // 2. Try legacy singleton file
    const legacy = await tryLoadCheckpointFile(
      path.join(STATE_DIR, checkpointFilename(orchestrator, null))
    );
    if (legacy) return legacy;

    // 3. Scan for any session-scoped checkpoint files, return newest valid
    const prefix = `checkpoint-${orchestrator}-`;
    let entries;
    try {
      entries = await fs.readdir(STATE_DIR);
    } catch {
      return null;
    }

    const candidates = entries.filter(f => f.startsWith(prefix) && f.endsWith('.json'));

    let newest = null;
    let newestTime = 0;

    for (const file of candidates) {
      const cp = await tryLoadCheckpointFile(path.join(STATE_DIR, file));
      if (cp) {
        const t = new Date(cp.savedAt).getTime();
        if (t > newestTime) {
          newest = cp;
          newestTime = t;
        }
      }
    }

    return newest;
  } catch {
    return null;
  }
}

/**
 * Delete checkpoint on clean completion.
 * When opts.sessionId is provided, only deletes that session's checkpoint.
 *
 * @param {'atlas'|'athena'} orchestrator
 * @param {{ sessionId?: string }} [opts]
 */
export async function clearCheckpoint(orchestrator, opts = {}) {
  try {
    // Emit checkpoint_cleared event if active run exists (US-002)
    const activeRunId = getActiveRunId(orchestrator);
    if (activeRunId) {
      addEvent(activeRunId, {
        type: 'checkpoint_cleared',
        detail: {},
      });
    }

    const sessionId = opts?.sessionId || null;
    const filePath = path.join(STATE_DIR, checkpointFilename(orchestrator, sessionId));
    await fs.unlink(filePath);
  } catch {
    // fail-safe: no-op on error
  }
}

/**
 * Format checkpoint for human-readable display.
 * @param {object} checkpoint
 * @returns {string} e.g. "Phase 3 (EXECUTE), 2/5 stories complete, started 3h ago"
 */
export function formatCheckpoint(checkpoint) {
  try {
    const phase = checkpoint.phase ?? 0;
    const phaseName = PHASE_NAMES[checkpoint.orchestrator]?.[phase] ?? `Phase ${phase}`;

    const completedStories = checkpoint.completedStories ?? [];
    const totalStories =
      checkpoint.prdSnapshot?.userStories?.length ?? completedStories.length;
    const storySummary =
      totalStories > 0
        ? `${completedStories.length}/${totalStories} stories complete`
        : `${completedStories.length} stories complete`;

    const startedAt = checkpoint.startedAt
      ? new Date(checkpoint.startedAt)
      : new Date(checkpoint.savedAt);
    const ageMs = Date.now() - startedAt.getTime();
    const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
    const ageMinutes = Math.floor((ageMs % (60 * 60 * 1000)) / (60 * 1000));
    const ageStr =
      ageHours > 0
        ? `${ageHours}h ago`
        : ageMinutes > 0
          ? `${ageMinutes}m ago`
          : 'just now';

    return `Phase ${phase} (${phaseName}), ${storySummary}, started ${ageStr}`;
  } catch {
    return 'checkpoint found (details unavailable)';
  }
}
