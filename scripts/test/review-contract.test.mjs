import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateReviewResults, parseReviewResult } from '../lib/review-contract.mjs';

const REVIEW_DIGEST = 'a'.repeat(64);

function reviewPackage(diffPaths = ['src/example.mjs'], digest = REVIEW_DIGEST) {
  return {
    diffPaths,
    reviewDigest: { algorithm: 'sha256', value: digest },
  };
}

function result(reviewer, verdict = 'APPROVE', overrides = {}) {
  const findings = verdict === 'APPROVE' ? [] : [{
    severity: 'high',
    confidence: 0.9,
    file: 'src/example.mjs',
    line: 12,
    evidence: 'The changed branch skips authorization.',
    recommendation: 'Restore the authorization guard.',
  }];
  return JSON.stringify({
    schemaVersion: 1,
    reviewer,
    reviewDigest: REVIEW_DIGEST,
    verdict,
    findings,
    escalations: [],
    ...overrides,
  });
}

function parse(raw, options = {}) {
  return parseReviewResult(raw, { expectedReviewDigest: REVIEW_DIGEST, ...options });
}

describe('AO_REVIEW_V1 contract', () => {
  it('parses a grounded review result bound to the expected package generation', () => {
    const parsed = parse(result('code-reviewer', 'REVISE'), {
      expectedReviewer: 'code-reviewer',
    });
    assert.equal(parsed.findings[0].confidence, 0.9);
    assert.equal(parsed.reviewDigest, REVIEW_DIGEST);
  });

  it('requires an expected digest and rejects stale or malformed generation bindings', () => {
    assert.throws(
      () => parseReviewResult(result('code-reviewer')),
      /expectedReviewDigest or reviewPackage\.reviewDigest is required/,
    );
    assert.throws(
      () => parse(result('code-reviewer', 'APPROVE', { reviewDigest: 'b'.repeat(64) })),
      /does not match the expected complete review package/,
    );
    assert.throws(
      () => parse(result('code-reviewer', 'APPROVE', { reviewDigest: 'not-a-digest' })),
      /reviewDigest must be a lowercase sha256 digest/,
    );
  });

  it('rejects prose, identity mismatch, and empty non-approve verdicts', () => {
    assert.throws(() => parse('VERDICT: APPROVE'), /exactly one JSON object/);
    assert.throws(
      () => parse(result('architect'), { expectedReviewer: 'code-reviewer' }),
      /reviewer must equal code-reviewer/,
    );
    assert.throws(
      () => parse(result('code-reviewer', 'REJECT', { findings: [] })),
      /must include at least one finding/,
    );
  });

  it('requires APPROVE to contain zero findings and zero escalations', () => {
    const finding = JSON.parse(result('code-reviewer', 'REVISE')).findings;
    assert.throws(
      () => parse(result('code-reviewer', 'APPROVE', { findings: finding })),
      /APPROVE must include zero findings/,
    );
    assert.throws(
      () => parse(result('code-reviewer', 'APPROVE', {
        escalations: [{ additionalReviewer: 'architect', reason: 'shared boundary changed' }],
      }), { allowedReviewers: ['code-reviewer', 'architect'] }),
      /APPROVE must include zero escalations/,
    );
  });

  it('enforces exact object shapes', () => {
    assert.throws(
      () => parse(result('code-reviewer', 'APPROVE', { summary: 'looks good' })),
      /result\.summary is not allowed/,
    );
    const finding = JSON.parse(result('code-reviewer', 'REVISE')).findings[0];
    assert.throws(
      () => parse(result('code-reviewer', 'REVISE', {
        findings: [{ ...finding, category: 'auth' }],
      })),
      /findings\[0\]\.category is not allowed/,
    );
  });

  it('rejects unsafe and out-of-package finding paths', () => {
    const finding = JSON.parse(result('code-reviewer', 'REVISE')).findings[0];
    for (const file of ['../secret.txt', '/etc/passwd', 'src/../secret.txt', 'C:\\temp\\secret.txt']) {
      assert.throws(
        () => parse(result('code-reviewer', 'REVISE', {
          findings: [{ ...finding, file }],
        })),
        /safe repo-relative path/,
      );
    }
    assert.throws(
      () => parse(result('code-reviewer', 'REVISE'), {
        reviewPackage: reviewPackage(['src/other.mjs']),
      }),
      /outside reviewPackage\.diffPaths/,
    );
    assert.doesNotThrow(() => parse(result('code-reviewer', 'REVISE'), {
      reviewPackage: reviewPackage(),
    }));
  });

  it('requires line to be null whenever file is null', () => {
    const finding = JSON.parse(result('code-reviewer', 'REVISE')).findings[0];
    assert.throws(
      () => parse(result('code-reviewer', 'REVISE', {
        findings: [{ ...finding, file: null, line: 42 }],
      })),
      /line must be null when file is null/,
    );
    assert.doesNotThrow(() => parse(result('code-reviewer', 'REVISE', {
      findings: [{ ...finding, file: null, line: null }],
    })));
  });

  it('requires escalations to target the active routed allowlist', () => {
    const escalation = [{ additionalReviewer: 'security-reviewer', reason: 'credential flow changed' }];
    const raw = result('code-reviewer', 'REVISE', { escalations: escalation });
    assert.throws(() => parse(raw), /allowedReviewers is required/);
    assert.throws(
      () => parse(raw, { allowedReviewers: ['code-reviewer', 'architect'] }),
      /not in allowedReviewers/,
    );
    assert.doesNotThrow(() => parse(raw, {
      allowedReviewers: ['code-reviewer', 'security-reviewer'],
    }));
  });

  it('blocks aggregation when the selected set escapes the active allowlist', () => {
    const aggregated = aggregateReviewResults({
      designer: result('designer'),
    }, ['designer'], {
      allowedReviewers: ['code-reviewer'],
      reviewPackage: reviewPackage(),
    });
    assert.equal(aggregated.verdict, 'BLOCKED');
    assert.match(aggregated.errors[0], /outside allowedReviewers/);
  });

  it('approves only when every expected reviewer returns APPROVE for one generation', () => {
    const approved = aggregateReviewResults({
      'code-reviewer': result('code-reviewer'),
      architect: result('architect'),
    }, ['code-reviewer', 'architect'], {
      allowedReviewers: ['code-reviewer', 'architect'],
      reviewPackage: reviewPackage(),
    });
    assert.equal(approved.verdict, 'APPROVE');

    const revise = aggregateReviewResults({
      'code-reviewer': result('code-reviewer', 'REVISE'),
      architect: result('architect'),
    }, ['code-reviewer', 'architect'], {
      allowedReviewers: ['code-reviewer', 'architect'],
      reviewPackage: reviewPackage(),
    });
    assert.equal(revise.verdict, 'REVISE');

    const stale = aggregateReviewResults({
      'code-reviewer': result('code-reviewer'),
      architect: result('architect', 'APPROVE', { reviewDigest: 'b'.repeat(64) }),
    }, ['code-reviewer', 'architect'], {
      allowedReviewers: ['code-reviewer', 'architect'],
      reviewPackage: reviewPackage(),
    });
    assert.equal(stale.verdict, 'BLOCKED');
    assert.match(stale.errors.join('\n'), /expected complete review package/);
  });

  it('fails closed on missing, malformed, or blocked results', () => {
    const options = { reviewPackage: reviewPackage() };
    const missing = aggregateReviewResults({
      'code-reviewer': result('code-reviewer'),
    }, ['code-reviewer', 'security-reviewer'], options);
    assert.equal(missing.verdict, 'BLOCKED');
    assert.match(missing.errors[0], /security-reviewer/);

    const blocked = aggregateReviewResults({
      'code-reviewer': result('code-reviewer', 'BLOCKED'),
    }, ['code-reviewer'], options);
    assert.equal(blocked.verdict, 'BLOCKED');
  });
});
