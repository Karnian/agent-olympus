/**
 * Review router (v1.0.2 US-005)
 *
 * Maps a diff scope (paths + content) to the minimal set of reviewer agents.
 * Consults config/review-routing.jsonc. Always force-includes security-reviewer
 * when any content matches the securityPatterns regex set. Supports a
 * reviewer-triggered escalation flag (handleEscalation) so mid-run reviewers
 * can pull additional reviewers into the same iteration.
 *
 * Public API:
 *   loadRoutingConfig(baseDir?)             → parsed config or {} on failure
 *   compileSecurityPatterns(config)         → RegExp[]
 *   routeReviewers({diffPaths, diffContent, baseDir?}) → {reviewers, matchedRules, securityHit, warning}
 *   handleEscalation(currentSet, flag)      → new set including escalation target
 *   isRouterDisabled(baseDir?)              → boolean (autonomy.json gate)
 *
 * Disable via .ao/autonomy.json → { "reviewRouter": { "disabled": true } }.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const CONFIG_REL = 'config/review-routing.jsonc';
const AUTONOMY_REL = '.ao/autonomy.json';

/**
 * Strip // line comments from JSONC (naive, good enough for trusted config).
 * @param {string} text
 * @returns {string}
 */
function stripJsoncComments(text) {
  return text
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      if (idx === -1) return line;
      // Avoid stripping // inside a quoted string (naive check)
      const before = line.slice(0, idx);
      const quotes = (before.match(/"/g) || []).length;
      if (quotes % 2 === 1) return line;
      return before;
    })
    .join('\n');
}

/**
 * Load & parse config/review-routing.jsonc. Fail-safe: returns {} on error.
 *
 * @param {string} [baseDir=process.cwd()]
 * @returns {object}
 */
export function loadRoutingConfig(baseDir = process.cwd()) {
  try {
    const full = path.join(baseDir, CONFIG_REL);
    const raw = readFileSync(full, 'utf-8');
    const stripped = stripJsoncComments(raw);
    const parsed = JSON.parse(stripped);
    if (!parsed || typeof parsed !== 'object') return {};
    if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== 1) return {};
    return parsed;
  } catch {
    return {};
  }
}

/**
 * Compile securityPatterns to case-insensitive RegExp instances.
 * Invalid patterns are silently dropped.
 *
 * @param {object} config
 * @returns {RegExp[]}
 */
export function compileSecurityPatterns(config) {
  const patterns = Array.isArray(config?.securityPatterns) ? config.securityPatterns : [];
  const compiled = [];
  for (const p of patterns) {
    try {
      compiled.push(new RegExp(p, 'i'));
    } catch {
      // skip malformed pattern
    }
  }
  return compiled;
}

/**
 * Check if the router is disabled via autonomy.json.
 *
 * @param {string} [baseDir=process.cwd()]
 * @returns {boolean}
 */
export function isRouterDisabled(baseDir = process.cwd()) {
  try {
    const raw = readFileSync(path.join(baseDir, AUTONOMY_REL), 'utf-8');
    const config = JSON.parse(raw);
    return config?.reviewRouter?.disabled === true;
  } catch {
    return false;
  }
}

/**
 * Build a full fallback reviewer set when the router is disabled or has no match.
 *
 * @param {object} config
 * @returns {string[]}
 */
function fullReviewerSet(config) {
  if (Array.isArray(config?.fallback) && config.fallback.length > 0) {
    return [...config.fallback];
  }
  return ['code-reviewer', 'architect', 'security-reviewer', 'aphrodite', 'test-engineer'];
}

/**
 * Route a diff to the minimal reviewer set.
 *
 * @param {object} params
 * @param {string[]} params.diffPaths
 * @param {string} [params.diffContent]
 * @param {string} [params.baseDir]
 * @returns {{reviewers: string[], matchedRules: string[], securityHit: boolean, warning: string|null, disabled: boolean}}
 */
export function routeReviewers({ diffPaths = [], diffContent = '', baseDir = process.cwd() } = {}) {
  if (isRouterDisabled(baseDir)) {
    const config = loadRoutingConfig(baseDir);
    return {
      reviewers: fullReviewerSet(config),
      matchedRules: [],
      securityHit: false,
      warning: null,
      disabled: true,
    };
  }

  const config = loadRoutingConfig(baseDir);
  const alwaysInclude = Array.isArray(config?.alwaysInclude) ? config.alwaysInclude : [];
  const rules = Array.isArray(config?.rules) ? config.rules : [];

  // Rollback path: alwaysInclude:["*"] forces the full fallback reviewer set on every diff.
  if (alwaysInclude.includes('*')) {
    return {
      reviewers: fullReviewerSet(config),
      matchedRules: [],
      securityHit: false,
      warning: 'review-router: alwaysInclude:["*"] forces full fallback reviewer set (rollback mode)',
      disabled: false,
    };
  }

  const matchedRules = [];
  const reviewerSet = new Set(alwaysInclude);

  // Apply path-based rules
  for (const rule of rules) {
    if (!rule?.pathMatch || !Array.isArray(rule?.reviewers)) continue;
    let regex;
    try {
      regex = new RegExp(rule.pathMatch, 'i');
    } catch {
      continue;
    }
    const hit = diffPaths.some((p) => regex.test(p));
    if (hit) {
      matchedRules.push(rule.name || rule.pathMatch);
      for (const r of rule.reviewers) reviewerSet.add(r);
    }
  }

  // Security pattern scan (force-include security-reviewer)
  let securityHit = false;
  if (diffContent) {
    const patterns = compileSecurityPatterns(config);
    for (const re of patterns) {
      if (re.test(diffContent)) {
        securityHit = true;
        reviewerSet.add('security-reviewer');
        break;
      }
    }
  }

  // No rule matched → full fallback + warning
  let warning = null;
  if (matchedRules.length === 0 && !securityHit) {
    warning = `review-router: no rule matched (${diffPaths.length} paths); falling back to full reviewer set`;
    const fb = fullReviewerSet(config);
    for (const r of fb) reviewerSet.add(r);
  }

  return {
    reviewers: Array.from(reviewerSet),
    matchedRules,
    securityHit,
    warning,
    disabled: false,
  };
}

/**
 * Handle a mid-run reviewer escalation flag.
 *
 * Expected flag shape:
 *   { type: 'RE-REVIEW-REQUESTED', additionalReviewer: 'security-reviewer', reason: '...' }
 *
 * @param {string[]} currentSet
 * @param {object} flag
 * @returns {{reviewers: string[], escalated: boolean, reason: string|null}}
 */
export function handleEscalation(currentSet, flag) {
  if (!Array.isArray(currentSet)) currentSet = [];
  if (!flag || flag.type !== 'RE-REVIEW-REQUESTED' || typeof flag.additionalReviewer !== 'string') {
    return { reviewers: [...currentSet], escalated: false, reason: null };
  }
  const next = new Set(currentSet);
  const already = next.has(flag.additionalReviewer);
  next.add(flag.additionalReviewer);
  return {
    reviewers: Array.from(next),
    escalated: !already,
    reason: flag.reason || null,
  };
}
