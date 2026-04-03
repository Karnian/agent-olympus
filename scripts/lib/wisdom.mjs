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
 * 47 high-frequency English stop words removed before Jaccard comparison.
 * Limited to function words that carry no discriminative meaning for lesson similarity.
 */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all',
  'can', 'had', 'her', 'was', 'one', 'our', 'out', 'has',
  'his', 'how', 'its', 'may', 'new', 'now', 'old', 'see',
  'way', 'who', 'did', 'get', 'let', 'say', 'she', 'too',
  'use', 'that', 'with', 'have', 'this', 'will', 'your',
  'from', 'they', 'been', 'each', 'make', 'when', 'than',
]);

/**
 * Suffix stripping rules — longest suffixes first.
 * minBefore: minimum stem length after stripping (must be >= 4 to prevent false conflation).
 */
const SUFFIX_RULES = [
  { suffix: 'tion', minBefore: 4 },
  { suffix: 'sion', minBefore: 4 },
  { suffix: 'ness', minBefore: 4 },
  { suffix: 'ment', minBefore: 4 },
  { suffix: 'able', minBefore: 4 },
  { suffix: 'ible', minBefore: 4 },
  { suffix: 'ally', minBefore: 4 },
  { suffix: 'ing',  minBefore: 4 },
  { suffix: 'ies',  minBefore: 4 },
  { suffix: 'ed',   minBefore: 4 },
  { suffix: 'er',   minBefore: 4 },
  { suffix: 'ly',   minBefore: 4 },
  { suffix: 's',    minBefore: 4 },
];

/**
 * Strip a single common English suffix if the remaining stem is >= 4 chars.
 * @param {string} word
 * @returns {string}
 */
function stripSuffix(word) {
  for (const { suffix, minBefore } of SUFFIX_RULES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= minBefore) {
      return word.slice(0, word.length - suffix.length);
    }
  }
  return word;
}

/**
 * Tokenize text: lowercase, split, filter short words, remove stop words, strip suffixes.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2)
    .filter(w => !STOP_WORDS.has(w))
    .map(stripSuffix);
}

/**
 * Jaccard similarity between two strings using normalized tokens.
 * @param {string} a
 * @param {string} b
 * @returns {number} similarity 0–1
 */
function jaccardSimilarity(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
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

    // Auto-prune when file grows beyond threshold (every ~50 entries check)
    if (existing.length > 0 && existing.length % 50 === 0) {
      await pruneWisdom().catch(() => {});
    }
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

// ---------------------------------------------------------------------------
// Multi-dimensional scoring (US-C3R-002)
// ---------------------------------------------------------------------------

const CONFIDENCE_SCORES = { high: 1.0, medium: 0.66, low: 0.33 };

function scoreRecency(entry) {
  try {
    const ageMs = Date.now() - new Date(entry.timestamp).getTime();
    return Math.max(0, 1 - ageMs / MAX_AGE_MS);
  } catch {
    return 0;
  }
}

function scoreConfidence(entry) {
  return CONFIDENCE_SCORES[entry.confidence] ?? 0.33;
}

function scoreCategory(entry, queryCategory) {
  return entry.category === queryCategory ? 1.0 : 0.0;
}

function scoreIntent(entry, queryIntent) {
  return entry.intent === queryIntent ? 1.0 : 0.0;
}

function scoreFilePattern(entry, queryFilePattern) {
  const patterns = entry.filePatterns ?? [];
  return patterns.some(p => p.includes(queryFilePattern)) ? 1.0 : 0.0;
}

/**
 * Compute composite relevance score with weight renormalization.
 * Unspecified dimensions are excluded; active weights renormalize to sum to 1.0.
 */
function scoreEntry(entry, query) {
  const dims = [
    { weight: 0.3, score: scoreRecency(entry) },
    { weight: 0.1, score: scoreConfidence(entry) },
  ];

  if (query.category) {
    dims.push({ weight: 0.25, score: scoreCategory(entry, query.category) });
  }
  if (query.intent) {
    dims.push({ weight: 0.2, score: scoreIntent(entry, query.intent) });
  }
  if (query.filePattern) {
    dims.push({ weight: 0.15, score: scoreFilePattern(entry, query.filePattern) });
  }

  const totalWeight = dims.reduce((sum, d) => sum + d.weight, 0);
  return dims.reduce((sum, d) => sum + (d.weight / totalWeight) * d.score, 0);
}

/**
 * Query wisdom entries with flexible filtering.
 *
 * Scoring activates ONLY when the query object contains at least one of
 * {category, intent, filePattern}. Otherwise, entries are returned in
 * reverse chronological order (legacy behavior).
 *
 * Backwards-compatible overloads:
 *   queryWisdom(category, limit)            — legacy string-based call (recency-only)
 *   queryWisdom({ category, intent, minConfidence, filePattern, limit })
 *
 * @param {string|null|object} categoryOrOptions
 * @param {number} limit
 * @returns {Promise<Array>}
 */
export async function queryWisdom(categoryOrOptions, limit = 10) {
  try {
    const entries = await readAllEntries();

    // Legacy string/null path — bypass scorer entirely
    if (typeof categoryOrOptions === 'string' || categoryOrOptions === null || categoryOrOptions === undefined) {
      const category = categoryOrOptions;
      const filtered = category
        ? entries.filter(e => e.category === category)
        : entries;
      return filtered.toReversed().slice(0, limit);
    }

    // Options-object path
    const category = categoryOrOptions.category ?? null;
    const intent = categoryOrOptions.intent ?? null;
    const minConfidence = categoryOrOptions.minConfidence ?? null;
    const filePattern = categoryOrOptions.filePattern ?? null;
    const effectiveLimit = categoryOrOptions.limit ?? limit;

    const minRank = minConfidence != null ? (CONFIDENCE_RANK[minConfidence] ?? 0) : null;

    // Hard pre-filter (minConfidence is a filter, not a scoring dimension)
    const filtered = entries.filter(e => {
      if (minRank !== null) {
        const eRank = CONFIDENCE_RANK[e.confidence] ?? 0;
        if (eRank < minRank) return false;
      }
      return true;
    });

    // Determine if scoring should activate
    const hasScoringDimensions = category || intent || filePattern;

    if (!hasScoringDimensions) {
      // No scoring dimensions — recency-only (existing caller behavior)
      return filtered.toReversed().slice(0, effectiveLimit);
    }

    // Scoring path: filter by dimensions first, then score and sort
    const matched = filtered.filter(e => {
      if (category && e.category !== category) return false;
      if (intent && e.intent !== intent) return false;
      if (filePattern) {
        const patterns = e.filePatterns ?? [];
        if (!patterns.some(p => p.includes(filePattern))) return false;
      }
      return true;
    });

    const query = { category, intent, filePattern };
    matched.sort((a, b) => {
      const scoreDiff = scoreEntry(b, query) - scoreEntry(a, query);
      if (scoreDiff !== 0) return scoreDiff;
      // Tie-break: most recent first
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });

    return matched.slice(0, effectiveLimit);
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

// ---------------------------------------------------------------------------
// Export / Import (US-C3R-003)
// ---------------------------------------------------------------------------

/**
 * Export all wisdom entries as a JSON array string.
 * @returns {Promise<string>}
 */
export async function exportWisdom() {
  try {
    const entries = await readAllEntries();
    return JSON.stringify(entries, null, 2);
  } catch {
    return '[]';
  }
}

/**
 * Import wisdom entries from a JSON array string.
 * @param {string} jsonString — JSON array of wisdom entry objects
 * @param {{ merge?: boolean }} options — merge (default true) deduplicates via Jaccard
 * @returns {Promise<{ imported: number, duplicatesSkipped: number }>}
 */
export async function importWisdom(jsonString, { merge = true } = {}) {
  const incoming = JSON.parse(jsonString);
  if (!Array.isArray(incoming)) throw new Error('Expected JSON array');

  if (!merge) {
    const valid = incoming.filter(e => e.lesson && typeof e.lesson === 'string');
    await writeAllEntries(valid.map(e => ({
      timestamp: e.timestamp || new Date().toISOString(),
      project: e.project || path.basename(process.cwd()),
      category: e.category || 'general',
      lesson: e.lesson,
      ...(e.filePatterns ? { filePatterns: e.filePatterns } : {}),
      confidence: e.confidence || 'medium',
      ...(e.intent ? { intent: e.intent } : {}),
    })));
    return { imported: valid.length, duplicatesSkipped: 0 };
  }

  const existing = await readAllEntries();
  let duplicatesSkipped = 0;
  let imported = 0;

  for (const entry of incoming) {
    if (!entry.lesson || typeof entry.lesson !== 'string') continue;
    const isDup = existing.some(e => jaccardSimilarity(e.lesson, entry.lesson) >= 0.7);
    if (isDup) {
      duplicatesSkipped++;
      continue;
    }
    existing.push({
      timestamp: entry.timestamp || new Date().toISOString(),
      project: entry.project || path.basename(process.cwd()),
      category: entry.category || 'general',
      lesson: entry.lesson,
      ...(entry.filePatterns ? { filePatterns: entry.filePatterns } : {}),
      confidence: entry.confidence || 'medium',
      ...(entry.intent ? { intent: entry.intent } : {}),
    });
    imported++;
  }

  await fs.mkdir(path.dirname(WISDOM_PATH), { recursive: true, mode: 0o700 });
  await writeAllEntries(existing);
  return { imported, duplicatesSkipped };
}
