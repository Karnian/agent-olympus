/**
 * Structured wisdom system for agent-olympus
 * Replaces progress.txt with queryable JSONL format
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './fs-atomic.mjs';

const WISDOM_PATH = path.join(process.cwd(), '.ao', 'wisdom.jsonl');
const PROGRESS_PATH = path.join(process.cwd(), '.ao', 'progress.txt');
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/**
 * Jaccard similarity between two strings (word-level, words > 2 chars)
 * @param {string} a
 * @param {string} b
 * @returns {number} similarity 0–1
 */
function jaccardSimilarity(a, b) {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const intersection = [...setA].filter(w => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Read all entries from wisdom.jsonl
 * @returns {Promise<Array>}
 */
async function readAllEntries() {
  try {
    const content = await fs.readFile(WISDOM_PATH, 'utf-8');
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try { return JSON.parse(line); }
        catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Write all entries to wisdom.jsonl (rewrite)
 * @param {Array} entries
 */
async function writeAllEntries(entries) {
  const content = entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
  await atomicWriteFile(WISDOM_PATH, content);
}

/**
 * Add a wisdom entry with best-effort deduplication.
 * Note: Dedup is not atomic — concurrent callers may both pass the
 * similarity check. This is acceptable since duplicates are pruned
 * by pruneWisdom() and the append itself is POSIX-atomic for small writes.
 * @param {{ category: string, lesson: string, filePatterns?: string[], confidence?: string, intent?: string }} entry
 *   category: 'test' | 'build' | 'architecture' | 'pattern' | 'debug' | 'performance' | 'general'
 *   confidence: 'high' | 'medium' | 'low'
 *   intent: 'visual-engineering' | 'deep' | 'quick' | 'writing' | 'planning' | 'unknown' (optional)
 */
export async function addWisdom(entry) {
  try {
    const existing = await readAllEntries();

    // Deduplication: skip if ≥70% Jaccard similarity with any existing lesson.
    // Threshold lowered from 0.8 → 0.7 to catch more near-duplicates that
    // can slip through when concurrent callers both pass the check simultaneously.
    for (const e of existing) {
      if (jaccardSimilarity(entry.lesson, e.lesson) >= 0.7) {
        return;
      }
    }

    const record = {
      timestamp: new Date().toISOString(),
      project: path.basename(process.cwd()),
      category: entry.category || 'general',
      lesson: entry.lesson,
      ...(entry.filePatterns ? { filePatterns: entry.filePatterns } : {}),
      confidence: entry.confidence || 'medium',
      ...(entry.intent ? { intent: entry.intent } : {}),
    };

    await fs.mkdir(path.dirname(WISDOM_PATH), { recursive: true, mode: 0o700 });
    await fs.appendFile(WISDOM_PATH, JSON.stringify(record) + '\n', { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // fail-safe: never throw
  }
}

/**
 * Confidence level ordering for minConfidence filter.
 * @param {string} level
 * @returns {number}
 */
const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };

/**
 * Query wisdom entries with flexible filtering, most recent first.
 *
 * Backwards-compatible overloads:
 *   queryWisdom(category, limit)            — legacy string-based call
 *   queryWisdom({ category, intent, minConfidence, filePattern, limit })
 *
 * @param {string|null|object} categoryOrOptions
 *   string|null  → filter by category (legacy)
 *   object       → { category?, intent?, minConfidence?, filePattern?, limit? }
 *     category       - category to filter, or omit/null for all
 *     intent         - 'visual-engineering'|'deep'|'quick'|'writing'|'planning'|'unknown'
 *     minConfidence  - 'high'|'medium'|'low' (inclusive lower bound)
 *     filePattern    - substring match against any element of entry.filePatterns[]
 *     limit          - max entries to return (overrides second argument)
 * @param {number} limit - max entries (used only in legacy string-based call)
 * @returns {Promise<Array>}
 */
export async function queryWisdom(categoryOrOptions, limit = 10) {
  try {
    const entries = await readAllEntries();

    let category = null;
    let intent = null;
    let minConfidence = null;
    let filePattern = null;
    let effectiveLimit = limit;

    if (categoryOrOptions !== null && typeof categoryOrOptions === 'object') {
      // New options-object form
      category = categoryOrOptions.category ?? null;
      intent = categoryOrOptions.intent ?? null;
      minConfidence = categoryOrOptions.minConfidence ?? null;
      filePattern = categoryOrOptions.filePattern ?? null;
      effectiveLimit = categoryOrOptions.limit ?? limit;
    } else {
      // Legacy string (or null) form
      category = categoryOrOptions;
    }

    const minRank = minConfidence != null ? (CONFIDENCE_RANK[minConfidence] ?? 0) : null;

    const filtered = entries.filter(e => {
      if (category && e.category !== category) return false;
      if (intent && e.intent !== intent) return false;
      if (minRank !== null) {
        const eRank = CONFIDENCE_RANK[e.confidence] ?? 0;
        if (eRank < minRank) return false;
      }
      if (filePattern) {
        const patterns = e.filePatterns ?? [];
        if (!patterns.some(p => p.includes(filePattern))) return false;
      }
      return true;
    });

    // Most recent first
    return filtered.toReversed().slice(0, effectiveLimit);
  } catch {
    return [];
  }
}

/**
 * Prune entries older than 90 days, remove duplicates (Jaccard ≥ 0.7),
 * and keep at most maxEntries (most recent).
 *
 * Deduplication runs over the full set so any duplicates that slipped
 * through concurrent addWisdom() calls are cleaned up here.
 * When duplicates are found the LATER entry (higher index) is kept so
 * that the most-recently appended version survives.
 *
 * @param {number} maxEntries
 */
export async function pruneWisdom(maxEntries = 200) {
  try {
    const entries = await readAllEntries();
    const cutoff = Date.now() - MAX_AGE_MS;

    // 1. Remove stale entries
    const fresh = entries.filter(e => {
      try { return new Date(e.timestamp).getTime() >= cutoff; }
      catch { return true; } // keep entries with unparseable timestamps
    });

    // 2. Deduplicate: iterate oldest→newest; mark an entry for removal when a
    //    later entry is sufficiently similar (≥ 0.7 Jaccard), keeping the newer one.
    const kept = [];
    for (let i = 0; i < fresh.length; i++) {
      let isDuplicate = false;
      for (let j = i + 1; j < fresh.length; j++) {
        if (jaccardSimilarity(fresh[i].lesson, fresh[j].lesson) >= 0.7) {
          isDuplicate = true;
          break;
        }
      }
      if (!isDuplicate) kept.push(fresh[i]);
    }

    // 3. Keep most recent maxEntries
    const pruned = kept.length > maxEntries
      ? kept.slice(kept.length - maxEntries)
      : kept;

    await writeAllEntries(pruned);
  } catch {
    // fail-safe
  }
}

/**
 * One-time migration from progress.txt → wisdom.jsonl
 * No-op if wisdom.jsonl already exists or progress.txt does not exist
 */
export async function migrateProgressTxt() {
  try {
    // Skip if already migrated
    try {
      await fs.access(WISDOM_PATH);
      return; // wisdom.jsonl exists, already migrated
    } catch {
      // wisdom.jsonl does not exist, proceed
    }

    // Check if progress.txt exists
    let content;
    try {
      content = await fs.readFile(PROGRESS_PATH, 'utf-8');
    } catch {
      return; // no progress.txt to migrate
    }

    // Parse progress.txt — split by double newlines or bullet points
    const chunks = content
      .split(/\n\n+/)
      .map(chunk => chunk.trim())
      .filter(chunk => chunk.length > 10);

    const entries = [];
    const project = path.basename(process.cwd());

    for (const chunk of chunks) {
      // Split bullet lines within the chunk into individual lessons
      const lines = chunk
        .split('\n')
        .map(l => l.replace(/^[-*•]\s*/, '').trim())
        .filter(l => l.length > 10);

      for (const line of lines) {
        entries.push({
          timestamp: new Date().toISOString(),
          project,
          category: 'general',
          lesson: line,
          confidence: 'medium',
        });
      }
    }

    if (entries.length > 0) {
      await writeAllEntries(entries);
    } else {
      // Write empty file to mark migration complete
      await writeAllEntries([]);
    }

    // Rename progress.txt → progress.txt.bak
    await fs.rename(PROGRESS_PATH, PROGRESS_PATH + '.bak');
  } catch {
    // fail-safe: no-op
  }
}

/**
 * Format wisdom entries for prompt injection
 * @param {Array} entries
 * @param {number} maxLines
 * @returns {string}
 */
export function formatWisdomForPrompt(entries, maxLines = 20) {
  if (!entries || entries.length === 0) return '';
  const lines = entries
    .slice(0, maxLines)
    .map(e => `- [${e.category}] ${e.lesson}`);
  return '## Prior Learnings\n' + lines.join('\n');
}
