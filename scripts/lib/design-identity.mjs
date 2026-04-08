/**
 * Design identity loader/writer (v1.0.2 US-003)
 *
 * Wraps scripts/lib/memory.mjs to read/write .ao/memory/design-identity.json
 * with schema validation, 2KB projection for hook-hot-path injection, and
 * deep-merge semantics for /teach-design re-runs.
 *
 * Public API:
 *   loadIdentity()                  → full parsed object or {} on error
 *   loadIdentitySummary()           → 2KB-capped projection for subagent injection
 *   mergeIdentity(existing, update) → deep-merge: objects recurse, arrays replace
 *   saveIdentity(update)            → merge-and-write with schemaVersion: 1
 *   validateIdentity(obj)           → shape check, returns {valid, errors}
 *
 * Schema shape (top-level keys the hook cares about):
 *   { schemaVersion: 1,
 *     brand: { name, colors: [...] },
 *     typography: { fonts: [...] },
 *     spacing: { scale: [...] },
 *     components: { library },
 *     allowedFonts: [...],
 *     conventions: { notes } }
 *
 * All loaders are fail-safe and respect autonomy.json {memory: {disabled: true}}.
 */

import { readJsonFile, writeJsonFile } from './memory.mjs';

const FILE_NAME = 'design-identity.json';
const KNOWN_SCHEMA_VERSION = 1;
const SUMMARY_BUDGET_BYTES = 2048;

/**
 * Load the full design-identity.json file.
 * Returns {} on missing file, corrupted JSON, schemaVersion > known, or disabled memory.
 *
 * @returns {Promise<object>}
 */
export async function loadIdentity() {
  const raw = await readJsonFile(FILE_NAME);
  if (!raw || typeof raw !== 'object') return {};
  return raw;
}

/**
 * Project the identity to a 2KB-budget summary for hook-hot-path injection.
 * Mirrors the projection logic in scripts/lib/subagent-context.mjs so both
 * call sites stay in sync.
 *
 * @returns {Promise<object>}
 */
export async function loadIdentitySummary() {
  const raw = await loadIdentity();
  if (!raw || Object.keys(raw).length === 0) return {};

  const full = JSON.stringify(raw);
  if (full.length <= SUMMARY_BUDGET_BYTES) return raw;

  const summary = { schemaVersion: raw.schemaVersion ?? KNOWN_SCHEMA_VERSION };
  if (raw.brand) {
    summary.brand = {};
    if (raw.brand.name) summary.brand.name = raw.brand.name;
    if (Array.isArray(raw.brand.colors)) {
      summary.brand.colors = raw.brand.colors.slice(0, 3);
    }
  }
  if (raw.typography) {
    summary.typography = {};
    if (Array.isArray(raw.typography.fonts)) {
      summary.typography.fonts = raw.typography.fonts.slice(0, 2);
    }
  }
  if (Array.isArray(raw.allowedFonts)) {
    summary.allowedFonts = raw.allowedFonts.slice(0, 5);
  }
  if (raw.spacing) {
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
  if (JSON.stringify(summary).length > 2048) {
    return { schemaVersion: raw.schemaVersion ?? 1 };
  }
  return summary;
}

/**
 * Deep-merge semantics for /teach-design re-runs:
 *   - plain objects recurse (existing keys survive, update keys overwrite)
 *   - arrays REPLACE rather than concatenate (so allowedFonts stays precise)
 *   - scalars are replaced
 *
 * @param {object} existing
 * @param {object} update
 * @returns {object}
 */
export function mergeIdentity(existing, update) {
  if (!existing || typeof existing !== 'object') return update;
  if (!update || typeof update !== 'object') return existing;

  const result = { ...existing };
  for (const [key, val] of Object.entries(update)) {
    const prev = result[key];
    if (
      val && typeof val === 'object' && !Array.isArray(val) &&
      prev && typeof prev === 'object' && !Array.isArray(prev)
    ) {
      result[key] = mergeIdentity(prev, val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Shape validation — best-effort, only flags hard violations.
 *
 * @param {object} obj
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateIdentity(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, errors: ['must be an object'] };
  }
  if (obj.schemaVersion !== undefined && obj.schemaVersion !== KNOWN_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${KNOWN_SCHEMA_VERSION}, got ${obj.schemaVersion}`);
  }
  if (obj.brand !== undefined && (typeof obj.brand !== 'object' || Array.isArray(obj.brand))) {
    errors.push('brand must be an object');
  }
  if (obj.brand?.colors !== undefined && !Array.isArray(obj.brand.colors)) {
    errors.push('brand.colors must be an array');
  }
  if (obj.typography !== undefined && (typeof obj.typography !== 'object' || Array.isArray(obj.typography))) {
    errors.push('typography must be an object');
  }
  if (obj.typography?.fonts !== undefined && !Array.isArray(obj.typography.fonts)) {
    errors.push('typography.fonts must be an array');
  }
  if (obj.allowedFonts !== undefined && !Array.isArray(obj.allowedFonts)) {
    errors.push('allowedFonts must be an array');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Merge an update into the existing identity and persist.
 * Always stamps schemaVersion: 1 on write.
 *
 * @param {object} update
 * @returns {Promise<{ok: boolean, merged?: object, errors?: string[]}>}
 */
export async function saveIdentity(update) {
  const existing = await loadIdentity();
  const merged = mergeIdentity(existing, update);
  merged.schemaVersion = KNOWN_SCHEMA_VERSION;

  const { valid, errors } = validateIdentity(merged);
  if (!valid) return { ok: false, errors };

  const wrote = await writeJsonFile(FILE_NAME, merged);
  return wrote ? { ok: true, merged } : { ok: false, errors: ['write failed (memory disabled or I/O error)'] };
}
