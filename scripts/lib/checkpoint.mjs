/**
 * Checkpoint system for Atlas/Athena session recovery
 * Saves phase state so interrupted sessions can resume from where they stopped
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './fs-atomic.mjs';

const STATE_DIR = path.join('.ao', 'state');
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const PHASE_NAMES = {
  atlas:  ['TRIAGE', 'ANALYZE', 'PLAN', 'EXECUTE', 'VERIFY', 'REVIEW', 'SLOP_CLEAN', 'COMMIT'],
  athena: ['TRIAGE', 'PLAN', 'SPAWN_TEAM', 'MONITOR', 'INTEGRATE_VERIFY', 'REVIEW', 'SLOP_CLEAN', 'COMMIT'],
};

/**
 * Save checkpoint after each phase transition.
 * @param {'atlas'|'athena'} orchestrator
 * @param {{ phase: number, prdSnapshot?: object, completedStories?: string[], activeWorkers?: string[], worktrees?: Object.<string, {path: string, branch: string}>, startedAt?: string, taskDescription?: string }} data
 */
export async function saveCheckpoint(orchestrator, data) {
  try {
    await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });

    const checkpoint = {
      orchestrator,
      ...data,
      savedAt: new Date().toISOString(),
    };

    const filePath = path.join(STATE_DIR, `checkpoint-${orchestrator}.json`);
    await atomicWriteFile(filePath, JSON.stringify(checkpoint, null, 2));
  } catch {
    // fail-safe: never throw
  }
}

/**
 * Load existing checkpoint if < 24h old.
 * @param {'atlas'|'athena'} orchestrator
 * @returns {Promise<object|null>}
 */
export async function loadCheckpoint(orchestrator) {
  try {
    const filePath = path.join(STATE_DIR, `checkpoint-${orchestrator}.json`);
    const raw = await fs.readFile(filePath, 'utf-8');
    const checkpoint = JSON.parse(raw);

    const savedAt = new Date(checkpoint.savedAt).getTime();
    if (Number.isNaN(savedAt)) {
      await fs.unlink(filePath).catch(() => {});
      return null;
    }
    const age = Date.now() - savedAt;

    if (age > TTL_MS) {
      // Expired — delete silently and return null
      await fs.unlink(filePath).catch(() => {});
      return null;
    }

    return checkpoint;
  } catch {
    return null;
  }
}

/**
 * Delete checkpoint on clean completion.
 * @param {'atlas'|'athena'} orchestrator
 */
export async function clearCheckpoint(orchestrator) {
  try {
    const filePath = path.join(STATE_DIR, `checkpoint-${orchestrator}.json`);
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
