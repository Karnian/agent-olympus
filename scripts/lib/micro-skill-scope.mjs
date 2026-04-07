/**
 * Micro-skill scope checker (v1.0.2 US-004)
 *
 * Surgical style-pass micro-skills (/normalize, /polish, /typeset, /arrange)
 * must each stay in their own lane. This module provides regex-based scope
 * classifiers so each skill can verify its own diff before reporting success.
 *
 * Public API:
 *   classifyDiffLine(line)        → Set<'typography'|'color'|'layout'|'motion'|'token'|'other'>
 *   classifyDiff(diffText)        → { typography, color, layout, motion, token, other, total }
 *   checkScope(diffText, allowed) → { ok, violations, counts }
 *
 * "allowed" is an array of scope tags the micro-skill is permitted to touch.
 * Any category with count > 0 that isn't in allowed is a violation.
 *
 * Conventions:
 *   - Only '+' and '-' lines (actual diff deltas) are classified; context
 *     lines and file headers are ignored.
 *   - A single line may belong to multiple categories (e.g. a line that
 *     changes both font-size and color counts in both).
 *   - '(token)' is set when a hardcoded hex/rgb/px literal is replaced with a
 *     `var(--...)` reference (the /normalize signal).
 */

const TYPOGRAPHY_PATTERNS = [
  /font-family\s*:/i,
  /font-size\s*:/i,
  /font-weight\s*:/i,
  /font-style\s*:/i,
  /font-variant\s*:/i,
  /line-height\s*:/i,
  /letter-spacing\s*:/i,
  /text-transform\s*:/i,
  /text-align\s*:/i,
  /text-decoration\s*:/i,
  /text-indent\s*:/i,
  /@font-face/i,
  /\btext-\w+\b/i,       // tailwind text-* utility
  /\bfont-\w+\b/i,       // tailwind font-* utility
  /\bleading-\w+\b/i,    // tailwind leading-*
  /\btracking-\w+\b/i,   // tailwind tracking-*
];

const COLOR_PATTERNS = [
  /\bcolor\s*:/i,
  /background(-color)?\s*:/i,
  /\bborder-color\s*:/i,
  /\boutline-color\s*:/i,
  /\bfill\s*:/i,
  /\bstroke\s*:/i,
  /#[0-9a-f]{3,8}\b/i,
  /\brgba?\s*\(/i,
  /\bhsla?\s*\(/i,
  /\bbg-\w+\b/i,         // tailwind bg-*
  /\btext-(red|blue|green|yellow|gray|slate|zinc|neutral|stone|orange|amber|lime|emerald|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose)\b/i,
];

const LAYOUT_PATTERNS = [
  /\bdisplay\s*:/i,
  /\bposition\s*:/i,
  /\bflex(-\w+)?\s*:/i,
  /\bgrid(-\w+)?\s*:/i,
  /\bmargin(-\w+)?\s*:/i,
  /\bpadding(-\w+)?\s*:/i,
  /\bgap\s*:/i,
  /\bwidth\s*:/i,
  /\bheight\s*:/i,
  /\bmin-(width|height)\s*:/i,
  /\bmax-(width|height)\s*:/i,
  /\btop\s*:/i,
  /\bleft\s*:/i,
  /\bright\s*:/i,
  /\bbottom\s*:/i,
  /\bz-index\s*:/i,
  /\boverflow\s*:/i,
  /\b(p|m|px|py|mx|my|pt|pb|pl|pr|mt|mb|ml|mr)-\w+\b/i,  // tailwind spacing
  /\b(w|h|min-w|min-h|max-w|max-h)-\w+\b/i,              // tailwind sizing
  /\b(flex|grid|block|inline|hidden|absolute|relative|fixed|sticky)\b/i,
];

const MOTION_PATTERNS = [
  /\btransition(-\w+)?\s*:/i,
  /\banimation(-\w+)?\s*:/i,
  /@keyframes/i,
  /\bease-\w+\b/i,
  /\bduration-\d+\b/i,
  /\bdelay-\d+\b/i,
  /\btransform\s*:/i,
  /\btranslate[XYZ]?\s*\(/i,
  /\brotate[XYZ]?\s*\(/i,
  /\bscale[XYZ]?\s*\(/i,
];

// /normalize signal: replacing a hardcoded literal with a var(--token) reference.
const TOKEN_PATTERNS = [
  /var\s*\(\s*--[\w-]+/i,
  /theme\s*\(\s*['"][\w.-]+['"]/i,
];

/**
 * Classify a single diff line into a set of scope tags. Only '+' / '-' lines
 * are classified.
 *
 * @param {string} line
 * @returns {Set<string>}
 */
export function classifyDiffLine(line) {
  const tags = new Set();
  if (typeof line !== 'string' || line.length === 0) return tags;
  // Ignore context & file headers
  if (!(line[0] === '+' || line[0] === '-')) return tags;
  if (line.startsWith('+++') || line.startsWith('---')) return tags;
  const body = line.slice(1);

  if (TYPOGRAPHY_PATTERNS.some((re) => re.test(body))) tags.add('typography');
  if (COLOR_PATTERNS.some((re) => re.test(body))) tags.add('color');
  if (LAYOUT_PATTERNS.some((re) => re.test(body))) tags.add('layout');
  if (MOTION_PATTERNS.some((re) => re.test(body))) tags.add('motion');
  if (TOKEN_PATTERNS.some((re) => re.test(body))) tags.add('token');

  // Anything that looked like a diff delta but matched nothing is "other"
  if (tags.size === 0 && body.trim().length > 0) tags.add('other');
  return tags;
}

/**
 * Walk a unified diff and count scope categories.
 *
 * @param {string} diffText
 * @returns {{typography:number, color:number, layout:number, motion:number, token:number, other:number, total:number, lines:number}}
 */
export function classifyDiff(diffText) {
  const counts = { typography: 0, color: 0, layout: 0, motion: 0, token: 0, other: 0, total: 0, lines: 0 };
  if (typeof diffText !== 'string' || diffText.length === 0) return counts;

  for (const line of diffText.split('\n')) {
    if (!(line.startsWith('+') || line.startsWith('-'))) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    counts.lines += 1;
    const tags = classifyDiffLine(line);
    for (const tag of tags) {
      counts[tag] = (counts[tag] || 0) + 1;
      counts.total += 1;
    }
  }
  return counts;
}

/**
 * Check a diff against an allowed scope list. Any category with count > 0
 * that is not in `allowed` is a violation.
 *
 * @param {string} diffText
 * @param {string[]} allowed
 * @returns {{ok: boolean, violations: string[], counts: object}}
 */
export function checkScope(diffText, allowed) {
  const counts = classifyDiff(diffText);
  const allowedSet = new Set(allowed || []);
  const violations = [];
  for (const cat of ['typography', 'color', 'layout', 'motion', 'token']) {
    if (counts[cat] > 0 && !allowedSet.has(cat)) {
      violations.push(`${cat} (${counts[cat]} lines)`);
    }
  }
  return { ok: violations.length === 0, violations, counts };
}

/**
 * Canonical allow-lists per micro-skill.
 */
export const MICRO_SKILL_SCOPES = {
  normalize: ['token', 'color', 'typography', 'layout', 'motion'],
  // /polish may touch anything micro — but NOT add brand-new structural patterns.
  // We treat polish's scope as 'any delta is OK' and rely on diff size heuristics instead.
  polish: ['token', 'color', 'typography', 'layout', 'motion', 'other'],
  typeset: ['typography'],
  arrange: ['layout'],
};
