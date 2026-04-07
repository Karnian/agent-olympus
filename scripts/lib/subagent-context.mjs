/**
 * Single-pass context loader for SubagentStart hook (v1.0.2 F-001)
 *
 * Replaces the previous multi-read pattern in scripts/subagent-start.mjs
 * (4 sequential queryWisdom calls → Promise.all one-shot) and adds two
 * new context sources: design-identity and taste-memory.
 *
 * Design constraints (per prd.json F-001 acceptance criteria):
 *   - ONE wisdom read (plus parallel identity + taste reads) under 1500ms p95
 *   - Hard 2500ms wall-clock race cap; timeout returns an empty bundle (fail-safe)
 *   - Per-loader fail-safe: if any loader throws, the others still succeed
 *   - Category filtering split done IN-MEMORY after the single read
 *   - autonomy.json { subagentContext: { disabled: true } } short-circuits to {}
 *
 * Public API:
 *   loadContextBundle({ agentName, budgetMs? }) → Promise<{
 *     wisdom: Array,
 *     designIdentity: object,
 *     taste: Array,
 *     metadata: { elapsedMs, timedOut, errors }
 *   }>
 *
 * The bundle is consumed by scripts/subagent-start.mjs which formats it
 * into additionalContext for the spawning subagent.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { queryWisdom } from './wisdom.mjs';
import { readJsonFile, readJsonlFile } from './memory.mjs';

const DEFAULT_BUDGET_MS = 1500;
const HARD_CAP_MS = 2500;

// Category map mirrors the previous subagent-start.mjs logic.
// Single-pass design: query ALL categories at once, filter in-memory.
const CATEGORY_MAP = {
  'test-engineer': ['test', 'build', 'debug'],
  'debugger': ['debug', 'build', 'test'],
  'designer': ['pattern', 'architecture'],
  'aphrodite': ['pattern', 'architecture'],
  'architect': ['architecture', 'pattern'],
  'security-reviewer': ['debug', 'architecture'],
  'code-reviewer': ['pattern', 'architecture', 'debug'],
  'executor': ['pattern', 'build', 'debug'],
  'writer': ['general'],
  'explore': ['architecture', 'pattern'],
};

// Subagents that receive design-identity + taste injection.
const DESIGN_AGENTS = new Set(['designer', 'aphrodite', 'ui-review', 'ui-reviewer']);

/**
 * Check autonomy.json for { subagentContext: { disabled: true } }.
 * Uses a direct sync read to avoid importing autonomy.mjs (which would
 * pull in the full validator on a hot path).
 *
 * @param {string} [cwd]
 * @returns {boolean}
 */
export function isSubagentContextDisabled(cwd = process.cwd()) {
  try {
    const raw = readFileSync(path.join(cwd, '.ao', 'autonomy.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed?.subagentContext?.disabled === true;
  } catch {
    return false;
  }
}

/**
 * Normalize a subagent_type string like "agent-olympus:designer" to a bare
 * agent name.
 *
 * @param {string} subagentType
 * @returns {string}
 */
export function normalizeAgentName(subagentType) {
  if (!subagentType || typeof subagentType !== 'string') return '';
  return subagentType.replace(/^agent-olympus:/, '').trim();
}

/**
 * Load wisdom for the given agent in a single read, filtering by relevant
 * categories in-memory. This is the primary change vs the v1.0.1 hook,
 * which issued 4 sequential queryWisdom() calls.
 *
 * @param {string} agentName
 * @returns {Promise<Array>}
 */
async function loadWisdomFor(agentName) {
  const categories = CATEGORY_MAP[agentName];
  // Single read of all entries — we pass a plain string|null (legacy API path
  // in wisdom.mjs) which returns reverse-chronological up to the limit.
  // For a filtered agent, fetch a larger batch then filter in-memory.
  if (!categories) {
    // Unknown agent → single read with min-confidence filter.
    return queryWisdom({ minConfidence: 'medium', limit: 10 });
  }

  // Fetch a larger pool once (20 entries), then filter to matching categories
  // + take top 10 unique lessons. This replaces 4+ sequential reads.
  const pool = await queryWisdom(null, 40);
  if (!Array.isArray(pool)) return [];

  const seen = new Set();
  const out = [];
  // First pass: include entries that match one of the agent's categories
  for (const e of pool) {
    if (!categories.includes(e.category)) continue;
    const key = e.lesson || e.text || '';
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
    if (out.length >= 10) break;
  }
  // Second pass: top-up with recent high-confidence entries regardless of category
  if (out.length < 10) {
    for (const e of pool) {
      if (e.confidence !== 'high') continue;
      const key = e.lesson || e.text || '';
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
      if (out.length >= 10) break;
    }
  }
  return out;
}

/**
 * Load the design identity file for design-facing agents.
 * Applies a 2KB cap by projecting top-level keys + first 3 colors + first 2 fonts
 * (per US-003 AC: "returns a summarized projection ... capped at 2KB").
 *
 * @returns {Promise<object>}
 */
async function loadDesignIdentity() {
  const raw = await readJsonFile('design-identity.json');
  if (!raw || typeof raw !== 'object') return {};
  const serialized = JSON.stringify(raw);
  if (serialized.length <= 2048) return raw;

  // Project to a budget-friendly summary.
  const summary = { schemaVersion: raw.schemaVersion ?? 1 };
  if (raw.brand) {
    summary.brand = {
      ...(raw.brand.name ? { name: raw.brand.name } : {}),
      ...(Array.isArray(raw.brand.colors)
        ? { colors: raw.brand.colors.slice(0, 3) }
        : {}),
    };
  }
  if (raw.typography) {
    summary.typography = {
      ...(Array.isArray(raw.typography.fonts)
        ? { fonts: raw.typography.fonts.slice(0, 2) }
        : {}),
    };
  }
  if (Array.isArray(raw.allowedFonts)) {
    summary.allowedFonts = raw.allowedFonts.slice(0, 5);
  }
  if (raw.spacing) {
    // spacing can be unbounded (PRD example: 1000-element scale). Truncate to first 8 entries.
    if (Array.isArray(raw.spacing)) {
      summary.spacing = raw.spacing.slice(0, 8);
    } else if (raw.spacing && typeof raw.spacing === 'object' && Array.isArray(raw.spacing.scale)) {
      summary.spacing = { ...raw.spacing, scale: raw.spacing.scale.slice(0, 8) };
    } else {
      summary.spacing = raw.spacing;
    }
  }
  if (raw.components?.library) {
    summary.components = { library: raw.components.library };
  }

  // Hard 2KB enforcement: drop optional fields in priority order until under budget.
  const priority = ['components', 'spacing', 'allowedFonts', 'typography', 'brand'];
  for (const field of priority) {
    if (JSON.stringify(summary).length <= 2048) break;
    delete summary[field];
  }
  // Final fallback: if even {schemaVersion} is somehow >2KB (impossible), return minimal.
  if (JSON.stringify(summary).length > 2048) {
    return { schemaVersion: raw.schemaVersion ?? 1 };
  }
  return summary;
}

/**
 * Load the most recent taste entries for design-facing agents.
 * Returns the last 20 entries, capped at 1KB total (per US-009 AC).
 *
 * @returns {Promise<Array>}
 */
async function loadTasteEntries() {
  const all = await readJsonlFile('taste.jsonl');
  if (!Array.isArray(all) || all.length === 0) return [];
  const recent = all.slice(-20);

  // Cap the serialized footprint at 1KB by truncating from the oldest side.
  let serialized = JSON.stringify(recent);
  let trimmed = recent.slice();
  while (serialized.length > 1024 && trimmed.length > 1) {
    trimmed = trimmed.slice(1);
    serialized = JSON.stringify(trimmed);
  }
  return trimmed;
}

/**
 * Load the full context bundle for a subagent.
 *
 * Runs all loaders concurrently via Promise.all and wraps the whole thing
 * in a Promise.race against a wall-clock cap. Each loader is individually
 * fail-safe, so a slow or throwing loader does not contaminate the others.
 *
 * @param {object} options
 * @param {string} options.agentName - bare agent name (no "agent-olympus:" prefix)
 * @param {number} [options.budgetMs=1500] - soft budget (ignored — hard cap applies)
 * @returns {Promise<{wisdom:Array, designIdentity:object, taste:Array, metadata:object}>}
 */
export async function loadContextBundle({ agentName = '', budgetMs = DEFAULT_BUDGET_MS } = {}) {
  const started = Date.now();
  const metadata = { elapsedMs: 0, timedOut: false, errors: {}, budgetMs };

  if (isSubagentContextDisabled()) {
    metadata.disabled = true;
    metadata.elapsedMs = Date.now() - started;
    return { wisdom: [], designIdentity: {}, taste: [], metadata };
  }

  const isDesignAgent = DESIGN_AGENTS.has(agentName);

  // Per-loader fail-safe wrappers.
  const wisdomP = loadWisdomFor(agentName).catch((err) => {
    metadata.errors.wisdom = String(err?.message || err);
    return [];
  });
  const identityP = (isDesignAgent ? loadDesignIdentity() : Promise.resolve({})).catch((err) => {
    metadata.errors.designIdentity = String(err?.message || err);
    return {};
  });
  const tasteP = (isDesignAgent ? loadTasteEntries() : Promise.resolve([])).catch((err) => {
    metadata.errors.taste = String(err?.message || err);
    return [];
  });

  // Hard wall-clock race.
  const allLoaders = Promise.all([wisdomP, identityP, tasteP]).then(
    ([wisdom, designIdentity, taste]) => ({ wisdom, designIdentity, taste }),
  );

  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve({ __timedOut: true }), HARD_CAP_MS).unref?.();
  });

  const result = await Promise.race([allLoaders, timeout]);
  metadata.elapsedMs = Date.now() - started;

  if (result.__timedOut) {
    metadata.timedOut = true;
    return { wisdom: [], designIdentity: {}, taste: [], metadata };
  }

  return {
    wisdom: result.wisdom || [],
    designIdentity: result.designIdentity || {},
    taste: result.taste || [],
    metadata,
  };
}

/**
 * Format the bundle into a single additionalContext string for injection.
 * Exported so the hook can keep all prompt-shape logic in one place.
 *
 * @param {object} bundle
 * @param {object} [opts]
 * @param {boolean} [opts.includeTokenEfficiency=true]
 * @returns {string}
 */
export function formatBundle(bundle, { includeTokenEfficiency = true } = {}) {
  const parts = [];

  if (includeTokenEfficiency) {
    parts.push(
      [
        '## Token Efficiency',
        '- No sycophantic openers/closers. No narration ("Now I will...", "Let me...").',
        '- No restating the task. Lead with answer/action.',
        '- Structured output (bullets/tables/JSON) over prose.',
        '- Minimum viable output. Prefer targeted edits over rewrites.',
      ].join('\n'),
    );
  }

  const wisdom = bundle?.wisdom || [];
  if (wisdom.length > 0) {
    const lines = wisdom.slice(0, 20).map((e) => `- [${e.category || 'general'}] ${e.lesson || e.text || ''}`);
    parts.push('## Prior Learnings\n' + lines.join('\n'));
  }

  const identity = bundle?.designIdentity || {};
  if (identity && typeof identity === 'object' && Object.keys(identity).length > 0) {
    parts.push('## Design Identity\n```json\n' + JSON.stringify(identity, null, 2) + '\n```');
  }

  const taste = bundle?.taste || [];
  if (Array.isArray(taste) && taste.length > 0) {
    const lines = taste.map((e) => {
      const cat = e.category || 'general';
      const pref = e.preference || '';
      const anti = e.antiPreference ? ` (avoid: ${e.antiPreference})` : '';
      return `- [${cat}] ${pref}${anti}`;
    });
    parts.push('## Taste Memory (recent preferences)\n' + lines.join('\n'));
  }

  return parts.join('\n\n');
}
