/**
 * Taste memory (v1.0.2 US-009)
 *
 * Persists aesthetic preferences ("I prefer minimal layouts", "no rounded corners")
 * to .ao/memory/taste.jsonl. Sibling to wisdom.jsonl: wisdom records facts, taste
 * records aesthetics. Replayed by scripts/lib/subagent-context.mjs into the
 * additionalContext for designer/aphrodite/ui-review subagent spawns.
 *
 * Public API:
 *   recordTaste(entry)            → append a taste entry; auto-prunes to MAX_ENTRIES
 *   loadTaste(limit)              → return last `limit` entries (default 20)
 *   pruneTaste({id, category, before}) → explicit prune by id, category, or ts cutoff
 *   makeTasteEntry(partial)       → factory: stamps id, timestamp, schemaVersion
 *
 * Schema (per-line):
 *   { schemaVersion: 1,
 *     id: <uuid-ish>,
 *     timestamp: <ISO-8601>,
 *     source: 'user' | 'auto',
 *     category: 'typography' | 'color' | 'layout' | 'motion' | 'copy',
 *     preference: <string>,
 *     antiPreference: <string|undefined>,
 *     confidence: 'low' | 'med' | 'high' }
 *
 * Fail-safe: corrupted file → []. schemaVersion > 1 lines → skipped.
 * FIFO prune at MAX_ENTRIES = 200.
 */

import { readJsonlFile, appendJsonlLine, writeJsonlFile } from './memory.mjs';
import crypto from 'node:crypto';

const FILE_NAME = 'taste.jsonl';
const KNOWN_SCHEMA_VERSION = 1;
const MAX_ENTRIES = 200;
const VALID_CATEGORIES = new Set(['typography', 'color', 'layout', 'motion', 'copy']);
const VALID_CONFIDENCE = new Set(['low', 'med', 'high']);
const VALID_SOURCE = new Set(['user', 'auto']);

/**
 * Build a fully-formed taste entry from a partial input. Stamps schemaVersion,
 * id, and timestamp. Validates required fields.
 *
 * @param {object} partial
 * @returns {object|null} entry, or null if invalid
 */
export function makeTasteEntry(partial) {
  if (!partial || typeof partial !== 'object') return null;
  const category = partial.category;
  const preference = partial.preference;
  if (!VALID_CATEGORIES.has(category)) return null;
  if (typeof preference !== 'string' || preference.trim() === '') return null;

  return {
    schemaVersion: KNOWN_SCHEMA_VERSION,
    id: partial.id || crypto.randomUUID(),
    timestamp: partial.timestamp || new Date().toISOString(),
    source: VALID_SOURCE.has(partial.source) ? partial.source : 'user',
    category,
    preference: preference.trim(),
    antiPreference: typeof partial.antiPreference === 'string'
      ? partial.antiPreference.trim()
      : undefined,
    confidence: VALID_CONFIDENCE.has(partial.confidence) ? partial.confidence : 'med',
  };
}

/**
 * Append a taste entry to taste.jsonl. Auto-prunes to MAX_ENTRIES via FIFO if
 * the file overflows.
 *
 * @param {object} partial
 * @returns {Promise<{ok: boolean, entry?: object, error?: string}>}
 */
export async function recordTaste(partial) {
  const entry = makeTasteEntry(partial);
  if (!entry) return { ok: false, error: 'invalid taste entry shape' };

  const wrote = await appendJsonlLine(FILE_NAME, entry);
  if (!wrote) return { ok: false, error: 'append failed (memory disabled or I/O error)' };

  // Check overflow → FIFO prune
  const all = await readJsonlFile(FILE_NAME);
  if (all.length > MAX_ENTRIES) {
    const trimmed = all.slice(all.length - MAX_ENTRIES);
    await writeJsonlFile(FILE_NAME, trimmed);
  }
  return { ok: true, entry };
}

/**
 * Load the most recent taste entries.
 *
 * @param {number} [limit=20]
 * @returns {Promise<object[]>}
 */
export async function loadTaste(limit = 20) {
  const all = await readJsonlFile(FILE_NAME);
  if (!Array.isArray(all)) return [];
  if (limit <= 0) return [];
  return all.slice(-limit);
}

/**
 * Explicit prune by id, category, or timestamp cutoff.
 *
 * @param {object} criteria
 * @param {string} [criteria.id] - exact entry id
 * @param {string} [criteria.category] - drop all of this category
 * @param {string} [criteria.before] - drop entries with timestamp < this ISO date
 * @returns {Promise<{ok: boolean, removed: number}>}
 */
export async function pruneTaste(criteria = {}) {
  // Reject empty / no-op criteria — refuse to nuke history accidentally.
  const hasId = typeof criteria.id === 'string' && criteria.id.length > 0;
  const hasCategory = typeof criteria.category === 'string' && criteria.category.length > 0;
  const hasBefore = typeof criteria.before === 'string' && criteria.before.length > 0;
  if (!hasId && !hasCategory && !hasBefore) {
    return { ok: false, removed: 0, error: 'pruneTaste requires at least one selector: id, category, or before' };
  }

  const all = await readJsonlFile(FILE_NAME);
  if (!Array.isArray(all) || all.length === 0) return { ok: true, removed: 0 };

  const beforeTs = hasBefore ? Date.parse(criteria.before) : null;
  const kept = all.filter((entry) => {
    if (criteria.id && entry.id === criteria.id) return false;
    if (criteria.category && entry.category === criteria.category) return false;
    if (beforeTs && Date.parse(entry.timestamp) < beforeTs) return false;
    return true;
  });

  const removed = all.length - kept.length;
  if (removed === 0) return { ok: true, removed: 0 };

  const wrote = await writeJsonlFile(FILE_NAME, kept);
  return { ok: wrote, removed };
}
