import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  crossValidationIdentityKey,
  normalizeCrossValidationIdentity,
} from './cross-validation-identity.mjs';

export const CROSS_VALIDATION_SCHEMA_VERSION = 1;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REVIEW_TREE_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PROVIDERS = new Set(['codex', 'gemini']);
const VERDICTS = new Set(['PASS', 'FAIL']);
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);
const SNAPSHOT_ID = /^xval-[0-9a-f]{32}$/;

function requireSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new Error(`${label} must be a safe identifier`);
  }
  return value;
}

function requireReviewTreeOid(value) {
  if (typeof value !== 'string' || !REVIEW_TREE_OID.test(value)) {
    throw new Error('reviewTreeOid must be an exact lowercase Git object ID');
  }
  return value;
}

function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0
    || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${label} must contain non-empty strings`);
  }
  return value;
}

function promptDigest(prompt) {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

export function buildCrossValidationTeamName({ orchestrator, runId, storyId, reviewTreeOid } = {}) {
  if (orchestrator !== 'atlas' && orchestrator !== 'athena') {
    throw new Error('orchestrator must be atlas or athena');
  }
  requireSafeId(runId, 'runId');
  requireSafeId(storyId, 'storyId');
  requireReviewTreeOid(reviewTreeOid);
  const identityHash = createHash('sha256')
    .update(JSON.stringify([orchestrator, runId, storyId]))
    .digest('hex')
    .slice(0, 16);
  return `${orchestrator}-xval-${reviewTreeOid}-${identityHash}`;
}

function requireSnapshot(snapshot, teamName, reviewTreeOid) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || Object.keys(snapshot).length !== 5
    || snapshot.schemaVersion !== 1
    || !SNAPSHOT_ID.test(snapshot.snapshotId || '')
    || snapshot.ownerId !== teamName
    || snapshot.reviewTreeOid !== reviewTreeOid
    || typeof snapshot.path !== 'string'
    || !path.isAbsolute(snapshot.path)
    || snapshot.path.includes('\0')
    || Buffer.byteLength(snapshot.path, 'utf8') > 4096) {
    throw new Error('cross-validation requires a team-owned exact-tree snapshot');
  }
  return snapshot;
}

/**
 * Build the complete immutable identity and read-only worker descriptor for one
 * external cross-validation attempt. The exact review tree is present in the
 * team key, persisted worker descriptor, supervisor manifest, and failover
 * identity; callers never key a validator by run/story alone.
 */
export function buildCrossValidationRequest(options = {}) {
  const orchestrator = options.orchestrator;
  if (orchestrator !== 'atlas' && orchestrator !== 'athena') {
    throw new Error('orchestrator must be atlas or athena');
  }
  const runId = requireSafeId(options.runId, 'runId');
  const storyId = requireSafeId(options.storyId, 'storyId');
  const reviewTreeOid = requireReviewTreeOid(options.reviewTreeOid);
  const provider = options.provider;
  if (!PROVIDERS.has(provider)) throw new Error('provider must be codex or gemini');
  if (typeof options.storyTitle !== 'string' || !options.storyTitle.trim()) {
    throw new Error('storyTitle is required');
  }
  const scope = requireStringArray(options.scope, 'scope');
  const acceptanceCriteria = requireStringArray(
    options.acceptanceCriteria,
    'acceptanceCriteria',
  );
  const teamName = buildCrossValidationTeamName({ orchestrator, runId, storyId, reviewTreeOid });
  const snapshot = requireSnapshot(options.snapshot, teamName, reviewTreeOid);
  const promptTemplate = [
    'READ-ONLY CROSS-VALIDATION. The runtime enforces read-only mode; do not request mutation.',
    `Review tree OID: ${reviewTreeOid}`,
    `Exact-tree snapshot ID: ${snapshot.snapshotId}`,
    'Validation prompt digest: <PROMPT_DIGEST>',
    'The current directory is a dedicated materialization of that tree with no live repository metadata. Do not access parent or external paths.',
    `Story: ${storyId}: ${options.storyTitle}`,
    `Authorized implementation scope: ${scope.join(', ')}`,
    `Acceptance criteria:\n${acceptanceCriteria.map(item => `- ${item}`).join('\n')}`,
    `Golden principles: ${options.harnessContext || 'none'}`,
    'Check every criterion with concrete evidence and report architecture or regression risks.',
    'Return exactly one JSON object and no markdown: '
      + '{"schemaVersion":1,"reviewTreeOid":"<copy exact OID>",'
      + `"snapshotId":"${snapshot.snapshotId}","promptDigest":"<PROMPT_DIGEST>",`
      + '"verdict":"PASS|FAIL","findings":[{"severity":"critical|high|medium|low|info",'
      + '"evidence":"specific evidence","recommendation":"specific recommendation"}]}. '
      + 'PASS requires an empty findings array; FAIL requires at least one finding.',
  ].join('\n\n');
  const validationPromptDigest = promptDigest(promptTemplate);
  const prompt = promptTemplate.replaceAll('<PROMPT_DIGEST>', validationPromptDigest);
  const identity = Object.freeze({
    schemaVersion: CROSS_VALIDATION_SCHEMA_VERSION,
    orchestrator,
    runId,
    storyId,
    reviewTreeOid,
    snapshotId: snapshot.snapshotId,
    promptDigest: validationPromptDigest,
  });
  return Object.freeze({
    identity,
    teamName,
    snapshot,
    worker: Object.freeze({
      name: 'external-validator',
      type: provider,
      prompt,
      cwd: snapshot.path,
      worktreePath: snapshot.path,
      readOnly: true,
      reviewTreeOid,
      validationIdentity: identity,
    }),
  });
}

/** Fail closed before reusing a persisted team from an interrupted poll. */
export function assertCrossValidationTeamState(state, request) {
  if (!state || state.teamName !== request?.teamName
    || !Array.isArray(state.workers) || state.workers.length !== 1) {
    throw new Error('cross-validation team state does not match the requested identity');
  }
  const expected = request.worker;
  const actual = state.workers[0];
  const actualPrompt = actual.originalPrompt ?? actual.prompt;
  let identityMatches = false;
  try {
    identityMatches = crossValidationIdentityKey(actual.validationIdentity)
      === crossValidationIdentityKey(request.identity, 'requested validationIdentity');
  } catch {
    identityMatches = false;
  }
  if (actual.name !== expected.name
    || actual.readOnly !== true
    || actual.reviewTreeOid !== expected.reviewTreeOid
    || actualPrompt !== expected.prompt
    || actual.cwd !== request.snapshot.path
    || actual.worktreePath !== request.snapshot.path
    || !identityMatches) {
    throw new Error('persisted cross-validation worker is stale or unbound');
  }
  return state;
}

/** Parse the validator's tree-bound result; prose or an echoed stale OID fails. */
export function parseCrossValidationResult(raw, expectedIdentity) {
  let normalizedExpected;
  try {
    normalizedExpected = normalizeCrossValidationIdentity(
      expectedIdentity,
      'cross-validation expected identity',
    );
  } catch {
    throw new Error('cross-validation expected identity is invalid');
  }
  if (!normalizedExpected) throw new Error('cross-validation expected identity is invalid');
  const reviewTreeOid = requireReviewTreeOid(normalizedExpected.reviewTreeOid);
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 256 * 1024) {
    throw new Error('cross-validation result must be bounded JSON text');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    throw new Error('cross-validation result is not one JSON object');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).length !== 6
    || parsed.schemaVersion !== CROSS_VALIDATION_SCHEMA_VERSION
    || parsed.reviewTreeOid !== reviewTreeOid
    || parsed.snapshotId !== normalizedExpected.snapshotId
    || parsed.promptDigest !== normalizedExpected.promptDigest
    || !VERDICTS.has(parsed.verdict)
    || !Array.isArray(parsed.findings)) {
    throw new Error('cross-validation result does not match the requested review tree');
  }
  for (const finding of parsed.findings) {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)
      || Object.keys(finding).length !== 3
      || !SEVERITIES.has(finding.severity)
      || typeof finding.evidence !== 'string' || !finding.evidence.trim()
      || typeof finding.recommendation !== 'string' || !finding.recommendation.trim()) {
      throw new Error('cross-validation result contains an invalid finding');
    }
  }
  if ((parsed.verdict === 'PASS' && parsed.findings.length !== 0)
    || (parsed.verdict === 'FAIL' && parsed.findings.length === 0)) {
    throw new Error('cross-validation verdict and findings disagree');
  }
  return Object.freeze({
    schemaVersion: parsed.schemaVersion,
    reviewTreeOid: parsed.reviewTreeOid,
    snapshotId: parsed.snapshotId,
    promptDigest: parsed.promptDigest,
    verdict: parsed.verdict,
    findings: Object.freeze(parsed.findings.map(finding => Object.freeze({
      severity: finding.severity,
      evidence: finding.evidence,
      recommendation: finding.recommendation,
    }))),
  });
}
