/**
 * Modular design reference pack selector (v1.0.2 US-002)
 *
 * Maps a diff scope to the minimal subset of the 7 design reference modules
 * that are actually relevant. Prevents context-window bloat when only 1-2
 * domains apply (e.g. a copy-only edit needs `ux-writing` alone, not all 7).
 *
 * Modules (skills/ui-review/reference/*.md):
 *   - typography
 *   - color-and-contrast
 *   - spatial-design
 *   - motion-design
 *   - interaction-design
 *   - responsive-design
 *   - ux-writing
 *
 * Public API:
 *   CANONICAL_MODULES               → the full 7-module list
 *   selectModules({diffPaths, diffContent?}) → string[] of module names
 *   loadModule(name, cwd?)          → string content (lazy-load a single module)
 *
 * The selection logic is REGEX-driven and deterministic so it can be unit
 * tested — per the M-B1 fix in prd.json US-002.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CANONICAL_MODULES = [
  'typography',
  'color-and-contrast',
  'spatial-design',
  'motion-design',
  'interaction-design',
  'responsive-design',
  'ux-writing',
];

// -----------------------------------------------------------------------------
// Path classifiers
// -----------------------------------------------------------------------------

const UI_EXTENSIONS = new Set([
  '.css', '.scss', '.sass', '.less',
  '.tsx', '.jsx', '.vue', '.svelte', '.html', '.htm',
]);

function isCopyOnly(paths) {
  if (!paths || paths.length === 0) return false;
  return paths.every((p) => /\b(i18n|locales?|copy|messages|strings)\b/i.test(p) ||
    /\.(json|yaml|yml|po|strings)$/i.test(p));
}

function hasCssPath(paths) {
  return paths.some((p) => /\.(css|scss|sass|less)$/i.test(p));
}

function hasComponentPath(paths) {
  return paths.some((p) => /\.(tsx|jsx|vue|svelte|html)$/i.test(p));
}

function hasLayoutHint(paths) {
  return paths.some((p) => /(layout|grid|container|wrapper|section|page)/i.test(p));
}

function hasMotionHint(paths, content) {
  if (paths.some((p) => /(anim|motion|transition|keyframe)/i.test(p))) return true;
  if (!content) return false;
  return /\b(keyframes?|transition|animation|cubic-bezier|ease(-in|-out|-in-out)?|@keyframes)\b/i.test(content);
}

function hasInteractionHint(paths, content) {
  if (paths.some((p) => /(button|input|form|modal|dialog|menu|dropdown|tab|carousel)/i.test(p))) return true;
  if (!content) return false;
  return /\b(onClick|onSubmit|onChange|hover:|focus:|active:|:hover|:focus|:active|aria-)\b/.test(content);
}

function hasResponsiveHint(paths, content) {
  if (!content) return false;
  return /\b(@media|sm:|md:|lg:|xl:|2xl:|min-width|max-width|breakpoint)\b/i.test(content);
}

function hasTypographyHint(content) {
  if (!content) return false;
  return /\b(font-family|font-size|font-weight|line-height|letter-spacing|text-[a-z0-9-]+|leading-|tracking-)\b/i.test(content);
}

function hasColorHint(content) {
  if (!content) return false;
  return /\b(color|background|bg-|text-|border-|#[0-9a-fA-F]{3,8}|rgb\(|hsl\()/i.test(content);
}

// -----------------------------------------------------------------------------
// selectModules
// -----------------------------------------------------------------------------

/**
 * Select the minimal set of reference modules for a diff.
 *
 * @param {object} options
 * @param {string[]} options.diffPaths - file paths in the diff
 * @param {string} [options.diffContent] - concatenated diff content (optional)
 * @returns {string[]} — subset of CANONICAL_MODULES
 */
export function selectModules({ diffPaths = [], diffContent = '' } = {}) {
  if (!Array.isArray(diffPaths)) return CANONICAL_MODULES.slice();

  // Empty input → fallback to full set with a debug warning (per AC-5).
  if (diffPaths.length === 0) {
    try { process.stderr.write('[ui-reference] empty diffPaths → full-set fallback\n'); } catch {}
    return CANONICAL_MODULES.slice();
  }

  // Copy-only diff → ux-writing alone (per AC-3).
  if (isCopyOnly(diffPaths)) return ['ux-writing'];

  const selected = new Set();

  // CSS-only hint: color-and-contrast + spatial-design + responsive-design
  // Per AC-2: selectModules(['src/styles/buttons.css']) → these three.
  if (hasCssPath(diffPaths)) {
    selected.add('color-and-contrast');
    selected.add('spatial-design');
    selected.add('responsive-design');
  }

  // Component path with style/font content (per AC-2: tsx + className/style/font
  // returns at minimum typography + color-and-contrast + spatial-design)
  if (hasComponentPath(diffPaths)) {
    if (diffContent && /(className|style=|font|color|bg-|text-)/.test(diffContent)) {
      selected.add('typography');
      selected.add('color-and-contrast');
      selected.add('spatial-design');
    }
  }

  // Content-driven hints (work regardless of file type)
  if (hasTypographyHint(diffContent)) selected.add('typography');
  if (hasColorHint(diffContent)) selected.add('color-and-contrast');

  // Motion (per AC-4: keyframes/transition/animation → motion + interaction)
  if (hasMotionHint(diffPaths, diffContent)) {
    selected.add('motion-design');
    selected.add('interaction-design');
  }

  // Interaction hints (buttons, forms, event handlers)
  if (hasInteractionHint(diffPaths, diffContent)) {
    selected.add('interaction-design');
  }

  // Responsive hints (@media, tailwind breakpoints)
  if (hasResponsiveHint(diffPaths, diffContent)) {
    selected.add('responsive-design');
  }

  // Layout hints
  if (hasLayoutHint(diffPaths)) {
    selected.add('spatial-design');
  }

  // No match → full-set fallback with warning (per AC-5).
  if (selected.size === 0) {
    try { process.stderr.write('[ui-reference] no rule matched → full-set fallback\n'); } catch {}
    return CANONICAL_MODULES.slice();
  }

  // Return in canonical order.
  return CANONICAL_MODULES.filter((m) => selected.has(m));
}

// -----------------------------------------------------------------------------
// Module lazy-load
// -----------------------------------------------------------------------------

/**
 * Load a single reference module from skills/ui-review/reference/<name>.md.
 * Returns empty string on any error (fail-safe).
 *
 * @param {string} name - module name (e.g. 'typography')
 * @param {string} [baseDir] - override the reference directory
 * @returns {string}
 */
export function loadModule(name, baseDir) {
  try {
    if (!CANONICAL_MODULES.includes(name)) return '';
    const dir = baseDir || path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..', '..', 'skills', 'ui-review', 'reference',
    );
    return readFileSync(path.join(dir, `${name}.md`), 'utf-8');
  } catch {
    return '';
  }
}
