/**
 * Review router (v1.1.0 US-005)
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
 *   routeReviewers({diffPaths, diffContent, baseDir?}) → {reviewers, matchedRules, securityHit, warning, reviewResultContract}
 *   handleEscalation(currentSet, flag, options?) → validated escalation result
 *   isApprovalReviewer(reviewer, config?)   → whether a role is safe for an approval gate
 *   activeApprovalReviewers(config?)        → active code/config allowlist intersection
 *   isRouterDisabled(baseDir?)              → boolean (autonomy.json gate)
 *
 * Disable via .ao/autonomy.json → { "reviewRouter": { "disabled": true } }.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AO_REVIEW_V1_CONTRACT } from './review-contract.mjs';

const CONFIG_REL = 'config/review-routing.jsonc';
const AUTONOMY_REL = '.ao/autonomy.json';

// This is intentionally a code-level allowlist, not merely config. Review
// routing is an approval gate: a stale or locally modified config must not be
// able to grant implementation agents a vote. Themis may execute verification
// commands but has no direct edit tools; review-package freshness rejects any
// command side effect that changes the tree.
const BUILTIN_APPROVAL_REVIEWERS = Object.freeze([
  'aphrodite',
  'architect',
  'code-reviewer',
  'security-reviewer',
  'themis',
]);

// Changes to the machinery that selects or validates approval reviewers must
// review themselves under a code-level policy. The working-tree config is not
// trusted to narrow this set for that generation.
const REVIEW_POLICY_PATHS = new Set([
  '.ao/autonomy.json',
  'agents/aphrodite.md',
  'agents/architect.md',
  'agents/athena.md',
  'agents/atlas.md',
  'agents/code-reviewer.md',
  'agents/security-reviewer.md',
  'agents/themis.md',
  'config/review-routing.jsonc',
  'scripts/lib/phase-runner.mjs',
  'scripts/lib/review-contract.mjs',
  'scripts/lib/review-package.mjs',
  'scripts/lib/review-router.mjs',
  'scripts/lib/run-artifacts.mjs',
  'skills/athena/SKILL.md',
  'skills/atlas/SKILL.md',
]);

const DEFAULT_REVIEW_RESULT_CONTRACT = AO_REVIEW_V1_CONTRACT;

function approvalReviewerSet(config = {}) {
  const builtins = new Set(BUILTIN_APPROVAL_REVIEWERS);
  if (!Object.hasOwn(config, 'approvalReviewers')) {
    return builtins;
  }
  if (!Array.isArray(config.approvalReviewers)) return new Set();
  return new Set(config.approvalReviewers.filter((name) => builtins.has(name)));
}

/**
 * Return the active approval allowlist. Configuration may narrow the built-in
 * read-only list but can never expand it.
 *
 * @param {object} [config]
 * @returns {string[]}
 */
export function activeApprovalReviewers(config = {}) {
  return [...approvalReviewerSet(config)];
}

/**
 * Return whether an agent is a known non-implementation approval reviewer and
 * is enabled by the active routing config.
 *
 * @param {string} reviewer
 * @param {object} [config]
 * @returns {boolean}
 */
export function isApprovalReviewer(reviewer, config = {}) {
  return typeof reviewer === 'string' && approvalReviewerSet(config).has(reviewer);
}

function cloneReviewResultContract(config = {}) {
  const candidate = config?.reviewResultContract;
  const exactArray = (actual, expected) => Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
  const valid = candidate?.name === 'AO_REVIEW_V1' &&
    candidate?.schemaVersion === 1 &&
    exactArray(candidate?.verdicts, DEFAULT_REVIEW_RESULT_CONTRACT.verdicts) &&
    exactArray(candidate?.required, DEFAULT_REVIEW_RESULT_CONTRACT.required) &&
    exactArray(candidate?.findingRequired, DEFAULT_REVIEW_RESULT_CONTRACT.findingRequired) &&
    exactArray(candidate?.escalationRequired, DEFAULT_REVIEW_RESULT_CONTRACT.escalationRequired);
  const source = valid ? candidate : DEFAULT_REVIEW_RESULT_CONTRACT;
  return {
    name: source.name,
    schemaVersion: source.schemaVersion,
    verdicts: [...source.verdicts],
    required: [...source.required],
    findingRequired: [...source.findingRequired],
    escalationRequired: [...source.escalationRequired],
  };
}

function sanitizeReviewers(reviewers, config, rejected = new Set()) {
  const safe = [];
  for (const reviewer of Array.isArray(reviewers) ? reviewers : []) {
    if (isApprovalReviewer(reviewer, config)) safe.push(reviewer);
    else if (typeof reviewer === 'string' && reviewer !== '*') rejected.add(reviewer);
  }
  return safe;
}

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
  const configured = sanitizeReviewers(config?.fallback, config);
  if (Array.isArray(config?.fallback)) return configured;
  return activeApprovalReviewers(config);
}

/**
 * Route a diff to the minimal reviewer set.
 *
 * @param {object} params
 * @param {string[]} params.diffPaths
 * @param {string} [params.diffContent]
 * @param {string} [params.baseDir]
 * @returns {{reviewers: string[], allowedReviewers: string[], matchedRules: string[], securityHit: boolean, warning: string|null, disabled: boolean, rejectedReviewers: string[], reviewResultContract: object, policySelfReview: boolean}}
 */
export function routeReviewers({ diffPaths = [], diffContent = '', baseDir = process.cwd() } = {}) {
  const config = loadRoutingConfig(baseDir);
  const reviewResultContract = cloneReviewResultContract(config);
  const allowedReviewers = activeApprovalReviewers(config);

  const policySelfReview = Array.isArray(diffPaths)
    && diffPaths.some((reviewPath) => REVIEW_POLICY_PATHS.has(reviewPath));
  if (policySelfReview) {
    const immutableReviewers = [...BUILTIN_APPROVAL_REVIEWERS];
    return {
      reviewers: immutableReviewers,
      allowedReviewers: [...immutableReviewers],
      matchedRules: ['review-policy-self-change'],
      securityHit: false,
      warning: 'review-router: review policy changed; forcing immutable built-in reviewer set',
      disabled: false,
      rejectedReviewers: [],
      reviewResultContract: cloneReviewResultContract(),
      policySelfReview: true,
    };
  }

  if (isRouterDisabled(baseDir)) {
    return {
      reviewers: fullReviewerSet(config),
      allowedReviewers,
      matchedRules: [],
      securityHit: false,
      warning: null,
      disabled: true,
      rejectedReviewers: [],
      reviewResultContract,
      policySelfReview: false,
    };
  }

  const alwaysInclude = Array.isArray(config?.alwaysInclude) ? config.alwaysInclude : [];
  const rules = Array.isArray(config?.rules) ? config.rules : [];
  const rejectedReviewers = new Set();

  // Rollback path: alwaysInclude:["*"] forces the full fallback reviewer set on every diff.
  if (alwaysInclude.includes('*')) {
    return {
      reviewers: fullReviewerSet(config),
      allowedReviewers,
      matchedRules: [],
      securityHit: false,
      warning: 'review-router: alwaysInclude:["*"] forces full fallback reviewer set (rollback mode)',
      disabled: false,
      rejectedReviewers: [],
      reviewResultContract,
      policySelfReview: false,
    };
  }

  const matchedRules = [];
  const reviewerSet = new Set(sanitizeReviewers(alwaysInclude, config, rejectedReviewers));

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
      for (const r of sanitizeReviewers(rule.reviewers, config, rejectedReviewers)) {
        reviewerSet.add(r);
      }
    }
  }

  // Security pattern scan (force-include security-reviewer)
  let securityHit = false;
  if (diffContent) {
    const patterns = compileSecurityPatterns(config);
    for (const re of patterns) {
      if (re.test(diffContent)) {
        securityHit = true;
        if (isApprovalReviewer('security-reviewer', config)) {
          reviewerSet.add('security-reviewer');
        } else {
          rejectedReviewers.add('security-reviewer');
        }
        break;
      }
    }
  }

  // No rule matched, or all matched reviewers were unsafe, → full fallback.
  const warnings = [];
  if (rejectedReviewers.size > 0) {
    warnings.push(`review-router: rejected non-approval reviewers: ${[...rejectedReviewers].join(', ')}`);
  }
  if (allowedReviewers.length === 0) {
    warnings.push('review-router: active approval reviewer allowlist is empty; review must block');
  }
  if ((matchedRules.length === 0 && !securityHit) || reviewerSet.size === 0) {
    const cause = reviewerSet.size === 0 && matchedRules.length > 0
      ? 'matched rules produced no safe approval reviewers'
      : `no rule matched (${diffPaths.length} paths)`;
    warnings.push(`review-router: ${cause}; falling back to full reviewer set`);
    const fb = fullReviewerSet(config);
    for (const r of fb) reviewerSet.add(r);
  }

  return {
    reviewers: Array.from(reviewerSet),
    allowedReviewers,
    matchedRules,
    securityHit,
    warning: warnings.length > 0 ? warnings.join('; ') : null,
    disabled: false,
    rejectedReviewers: [...rejectedReviewers],
    reviewResultContract,
    policySelfReview: false,
  };
}

/**
 * Handle a mid-run reviewer escalation flag.
 *
 * Expected flag shape:
 *   { additionalReviewer: 'security-reviewer', reason: '...' } // AO_REVIEW_V1
 * Legacy shape (still accepted):
 *   { type: 'RE-REVIEW-REQUESTED', additionalReviewer: 'security-reviewer', reason: '...' }
 *
 * @param {string[]} currentSet
 * @param {object} flag
 * @param {object} [options]
 * @param {string[]} [options.allowedReviewers] exact active allowlist returned by routeReviewers()
 * @param {string} [options.baseDir] used to load the active allowlist when one is not supplied
 * @returns {{reviewers: string[], escalated: boolean, rejected: boolean, reason: string|null, warning: string|null}}
 */
export function handleEscalation(currentSet, flag, options = {}) {
  if (!Array.isArray(currentSet)) currentSet = [];
  const configured = loadRoutingConfig(options.baseDir || process.cwd());
  const active = Object.hasOwn(options, 'allowedReviewers')
    ? new Set((Array.isArray(options.allowedReviewers) ? options.allowedReviewers : [])
      .filter((reviewer) => BUILTIN_APPROVAL_REVIEWERS.includes(reviewer)))
    : approvalReviewerSet(configured);
  const removed = currentSet.filter((reviewer) => !active.has(reviewer));
  const next = new Set(currentSet.filter((reviewer) => active.has(reviewer)));
  const warnings = removed.length > 0
    ? [`review-router: removed reviewers outside active allowlist: ${removed.join(', ')}`]
    : [];

  const validObject = flag !== null && typeof flag === 'object' && !Array.isArray(flag);
  const validType = validObject && (flag.type === undefined || flag.type === 'RE-REVIEW-REQUESTED');
  const allowedFields = flag?.type === undefined
    ? AO_REVIEW_V1_CONTRACT.escalationRequired
    : ['type', ...AO_REVIEW_V1_CONTRACT.escalationRequired];
  const exactFields = validObject && Object.keys(flag).every((field) => allowedFields.includes(field));
  const safeTarget = typeof flag?.additionalReviewer === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(flag.additionalReviewer);
  const validReason = typeof flag?.reason === 'string' && flag.reason.trim().length > 0;
  if (!validType || !exactFields || !safeTarget || !validReason) {
    warnings.push('review-router: rejected malformed escalation request');
    return {
      reviewers: [...next],
      escalated: false,
      rejected: true,
      reason: null,
      warning: warnings.join('; '),
    };
  }
  if (!active.has(flag.additionalReviewer)) {
    warnings.push(`review-router: rejected escalation outside active allowlist: ${flag.additionalReviewer}`);
    return {
      reviewers: [...next],
      escalated: false,
      rejected: true,
      reason: flag.reason || null,
      warning: warnings.join('; '),
    };
  }
  const already = next.has(flag.additionalReviewer);
  next.add(flag.additionalReviewer);
  return {
    reviewers: Array.from(next),
    escalated: !already,
    rejected: false,
    reason: flag.reason || null,
    warning: warnings.length > 0 ? warnings.join('; ') : null,
  };
}
