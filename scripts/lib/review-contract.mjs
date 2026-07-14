import path from 'node:path';

export const REVIEW_SCHEMA_VERSION = 1;

const VERDICTS = new Set(['APPROVE', 'REVISE', 'REJECT', 'BLOCKED']);
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);
const REVIEWER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REVIEW_DIGEST = /^[0-9a-f]{64}$/;
const RESULT_FIELDS = Object.freeze([
  'schemaVersion',
  'reviewer',
  'reviewDigest',
  'verdict',
  'findings',
  'escalations',
]);
const FINDING_FIELDS = Object.freeze([
  'severity',
  'confidence',
  'file',
  'line',
  'evidence',
  'recommendation',
]);
const ESCALATION_FIELDS = Object.freeze(['additionalReviewer', 'reason']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateExactFields(value, expected, prefix, errors) {
  const actual = Object.keys(value);
  for (const field of expected) {
    if (!Object.hasOwn(value, field)) errors.push(`${prefix}.${field} is required`);
  }
  for (const field of actual) {
    if (!expected.includes(field)) errors.push(`${prefix}.${field} is not allowed`);
  }
}

/**
 * Return whether a path is a canonical, repository-relative POSIX path.
 * Review evidence uses one path spelling on every host so a Windows absolute
 * path, traversal, alternate separator, or normalization trick cannot escape
 * the reviewed diff boundary.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafeRepoRelativePath(value) {
  if (!nonEmptyString(value) || value.length > 4096) return false;
  if (/[\0\r\n]/.test(value) || value.includes('\\')) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  if (value.endsWith('/')) return false;

  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized.startsWith('../')) return false;
  return normalized.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function validateReviewPackageDiffPaths(reviewPackage, errors) {
  if (reviewPackage === undefined) return null;
  if (!isPlainObject(reviewPackage) || !Array.isArray(reviewPackage.diffPaths)) {
    errors.push('reviewPackage.diffPaths must be an array');
    return null;
  }

  const paths = new Set();
  for (const [index, value] of reviewPackage.diffPaths.entries()) {
    if (!isSafeRepoRelativePath(value)) {
      errors.push(`reviewPackage.diffPaths[${index}] is not a safe repo-relative path`);
      continue;
    }
    paths.add(value);
  }
  return paths;
}

function validateAllowedReviewers(allowedReviewers, errors) {
  if (allowedReviewers === undefined) return null;
  if (!Array.isArray(allowedReviewers)) {
    errors.push('allowedReviewers must be an array');
    return new Set();
  }

  const allowed = new Set();
  for (const [index, reviewer] of allowedReviewers.entries()) {
    if (!nonEmptyString(reviewer) || !REVIEWER_NAME.test(reviewer)) {
      errors.push(`allowedReviewers[${index}] is invalid`);
      continue;
    }
    allowed.add(reviewer);
  }
  return allowed;
}

function validateExpectedReviewDigest(options, errors) {
  const explicit = options.expectedReviewDigest;
  const packaged = options.reviewPackage?.reviewDigest;
  let packageValue;

  if (packaged !== undefined) {
    if (!isPlainObject(packaged)
      || packaged.algorithm !== 'sha256'
      || !REVIEW_DIGEST.test(packaged.value || '')) {
      errors.push('reviewPackage.reviewDigest must be a valid sha256 digest');
    } else {
      packageValue = packaged.value;
    }
  }

  if (explicit !== undefined && !REVIEW_DIGEST.test(explicit)) {
    errors.push('expectedReviewDigest must be a lowercase sha256 digest');
  }
  if (explicit !== undefined && packageValue !== undefined && explicit !== packageValue) {
    errors.push('expectedReviewDigest does not match reviewPackage.reviewDigest');
  }

  const expected = explicit === undefined ? packageValue : explicit;
  if (expected === undefined) {
    errors.push('expectedReviewDigest or reviewPackage.reviewDigest is required');
    return null;
  }
  return REVIEW_DIGEST.test(expected) ? expected : null;
}

function validateFinding(finding, index, errors, diffPathSet) {
  const prefix = `findings[${index}]`;
  if (!isPlainObject(finding)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  validateExactFields(finding, FINDING_FIELDS, prefix, errors);
  if (!SEVERITIES.has(finding.severity)) {
    errors.push(`${prefix}.severity is invalid`);
  }
  if (typeof finding.confidence !== 'number'
    || !Number.isFinite(finding.confidence)
    || finding.confidence < 0
    || finding.confidence > 1) {
    errors.push(`${prefix}.confidence must be between 0 and 1`);
  }
  if (finding.file !== null && !isSafeRepoRelativePath(finding.file)) {
    errors.push(`${prefix}.file must be a safe repo-relative path or null`);
  } else if (finding.file !== null && diffPathSet && !diffPathSet.has(finding.file)) {
    errors.push(`${prefix}.file is outside reviewPackage.diffPaths`);
  }
  if (finding.line !== null
    && (!Number.isSafeInteger(finding.line) || finding.line < 1)) {
    errors.push(`${prefix}.line must be a positive integer or null`);
  }
  if (finding.file === null && finding.line !== null) {
    errors.push(`${prefix}.line must be null when file is null`);
  }
  if (!nonEmptyString(finding.evidence)) errors.push(`${prefix}.evidence is required`);
  if (!nonEmptyString(finding.recommendation)) errors.push(`${prefix}.recommendation is required`);
}

export function parseReviewResult(rawOutput, options = {}) {
  const expectedReviewer = options.expectedReviewer;
  if (!nonEmptyString(rawOutput)) {
    throw new Error('review output must be a non-empty JSON string');
  }

  let result;
  try {
    result = JSON.parse(rawOutput.trim());
  } catch {
    throw new Error('review output must be exactly one JSON object without Markdown fences');
  }
  if (!isPlainObject(result)) throw new Error('review output must be a JSON object');

  const errors = [];
  validateExactFields(result, RESULT_FIELDS, 'result', errors);
  const diffPathSet = validateReviewPackageDiffPaths(options.reviewPackage, errors);
  const allowedReviewers = validateAllowedReviewers(options.allowedReviewers, errors);
  const expectedReviewDigest = validateExpectedReviewDigest(options, errors);
  if (result.schemaVersion !== REVIEW_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${REVIEW_SCHEMA_VERSION}`);
  }
  if (!nonEmptyString(result.reviewer) || !REVIEWER_NAME.test(result.reviewer)) {
    errors.push('reviewer must be a safe non-empty name');
  } else if (expectedReviewer && result.reviewer !== expectedReviewer) {
    errors.push(`reviewer must equal ${expectedReviewer}`);
  }
  if (!REVIEW_DIGEST.test(result.reviewDigest || '')) {
    errors.push('reviewDigest must be a lowercase sha256 digest');
  } else if (expectedReviewDigest && result.reviewDigest !== expectedReviewDigest) {
    errors.push('reviewDigest does not match the expected complete review package');
  }
  if (!VERDICTS.has(result.verdict)) errors.push('verdict is invalid');
  if (!Array.isArray(result.findings)) {
    errors.push('findings must be an array');
  } else {
    result.findings.forEach((finding, index) => validateFinding(finding, index, errors, diffPathSet));
    if (result.verdict === 'APPROVE' && result.findings.length !== 0) {
      errors.push('APPROVE must include zero findings');
    }
    if (result.verdict !== 'APPROVE' && result.findings.length === 0) {
      errors.push(`${result.verdict} must include at least one finding`);
    }
  }
  if (!Array.isArray(result.escalations)) {
    errors.push('escalations must be an array');
  } else {
    result.escalations.forEach((escalation, index) => {
      if (!isPlainObject(escalation)) {
        errors.push(`escalations[${index}] is invalid`);
        return;
      }
      validateExactFields(escalation, ESCALATION_FIELDS, `escalations[${index}]`, errors);
      if (!nonEmptyString(escalation.additionalReviewer)
        || !REVIEWER_NAME.test(escalation.additionalReviewer)
        || !nonEmptyString(escalation.reason)) {
        errors.push(`escalations[${index}] is invalid`);
      } else if (allowedReviewers === null) {
        errors.push('allowedReviewers is required when escalations are present');
      } else if (!allowedReviewers.has(escalation.additionalReviewer)) {
        errors.push(`escalations[${index}].additionalReviewer is not in allowedReviewers`);
      }
    });
    if (result.verdict === 'APPROVE' && result.escalations.length !== 0) {
      errors.push('APPROVE must include zero escalations');
    }
  }

  if (errors.length > 0) throw new Error(`invalid review result: ${errors.join('; ')}`);
  return result;
}

export function aggregateReviewResults(rawResults, expectedReviewers, options = {}) {
  const expected = [...new Set(Array.isArray(expectedReviewers) ? expectedReviewers : [])];
  if (expected.length === 0) {
    return {
      schemaVersion: REVIEW_SCHEMA_VERSION,
      verdict: 'BLOCKED',
      results: [],
      errors: ['no reviewers were selected'],
      escalations: [],
    };
  }

  const results = [];
  const errors = [];
  const allowedReviewers = validateAllowedReviewers(options.allowedReviewers, errors);
  for (const reviewer of expected) {
    if (!nonEmptyString(reviewer) || !REVIEWER_NAME.test(reviewer)) {
      errors.push(`${String(reviewer)}: expected reviewer name is invalid`);
      continue;
    }
    if (allowedReviewers && !allowedReviewers.has(reviewer)) {
      errors.push(`${reviewer}: expected reviewer is outside allowedReviewers`);
      continue;
    }
    try {
      const raw = rawResults instanceof Map ? rawResults.get(reviewer) : rawResults?.[reviewer];
      results.push(parseReviewResult(raw, {
        expectedReviewer: reviewer,
        expectedReviewDigest: options.expectedReviewDigest,
        allowedReviewers: options.allowedReviewers,
        reviewPackage: options.reviewPackage,
      }));
    } catch (error) {
      errors.push(`${reviewer}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let verdict = 'APPROVE';
  if (errors.length > 0 || results.some(result => result.verdict === 'BLOCKED')) verdict = 'BLOCKED';
  else if (results.some(result => result.verdict === 'REJECT')) verdict = 'REJECT';
  else if (results.some(result => result.verdict === 'REVISE')) verdict = 'REVISE';
  else if (results.some(result => result.findings.length > 0 || result.escalations.length > 0)) {
    verdict = 'BLOCKED';
    errors.push('APPROVE requires zero findings and zero escalations from every reviewer');
  }

  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    verdict,
    results,
    errors,
    escalations: results.flatMap(result => result.escalations),
  };
}
