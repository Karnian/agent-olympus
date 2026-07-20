/**
 * Code-owned Atlas review evidence and approval ledger.
 *
 * Callers may select an already-created approval by its digest, but they may
 * not supply Git object IDs as proof. Git, PRD, verification-generation, and
 * reviewer identities are all derived again from hardened project state.
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join, resolve } from 'node:path';

import { readExecutionPrd } from './execution-prd-store.mjs';
import { validateChangedPathsAgainstScope } from './execution-prd.mjs';
import {
  readRegularArtifact,
  writeExclusiveRegularArtifact,
} from './hardened-fs.mjs';
import { aggregateReviewResults } from './review-contract.mjs';
import {
  assertCompleteReviewPackageIntegrity,
  assertReviewPackageCurrent,
  assertReviewPackageHeadTree,
  attachReviewContext,
  bindFinalCommitProposal,
  buildReviewPackage,
  getReviewWorktreeState,
  materializeApprovedReviewCommit,
  resolveReviewBase,
} from './review-package.mjs';
import { routeReviewers } from './review-router.mjs';
import {
  addVerification,
  beginVerificationGeneration,
  bindRunFinalizationPaths,
  getRunReviewBasePin,
  getSealedVerificationGeneration,
  getVerificationGenerationProgress,
  sealVerificationGeneration,
} from './run-artifacts.mjs';

const SCHEMA_VERSION = 1;
const PHASES = new Set(['review', 'final-review']);
const DIGEST = /^[0-9a-f]{64}$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GENERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REVIEWER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VERIFICATION_VERDICTS = new Set(['pass', 'fail']);
const RECORD_FIELDS = Object.freeze(['story_id', 'verdict', 'evidence', 'verifiedBy', 'criteria']);
const CRITERION_FIELDS = Object.freeze([
  'criterion_index',
  'criterion_text',
  'verdict',
  'evidence',
]);
const ARTIFACT_FIELDS = Object.freeze([
  'schemaVersion',
  'runId',
  'phase',
  'generationId',
  'reviewPackage',
  'reviewers',
  'results',
  'approvedAt',
  'integrity',
]);
const BINDING_FIELDS = Object.freeze([
  'schemaVersion',
  'runId',
  'phase',
  'generationId',
  'reviewTreeOid',
  'finalCommitProposal',
  'storyIds',
  'prdGeneration',
  'route',
  'boundAt',
  'integrity',
]);
const MAX_RECORD_BYTES = 128 * 1024;
const MAX_EVIDENCE_BYTES = 32 * 1024;
const MAX_RESULTS_BYTES = 1024 * 1024;
const MAX_APPROVAL_BYTES = 16 * 1024 * 1024;
const MAX_BINDING_BYTES = 512 * 1024;

function fail(message, cause) {
  throw new Error(message, cause ? { cause } : undefined);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactFields(value, fields) {
  return isPlainObject(value)
    && Object.keys(value).length === fields.length
    && fields.every(field => Object.hasOwn(value, field));
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

function monotonicIsoTimestamp(floors = []) {
  let timestamp = Date.now();
  for (const floor of floors) {
    const parsed = canonicalTimestamp(floor);
    if (parsed === null) fail('timestamp floor is not canonical');
    timestamp = Math.max(timestamp, parsed);
  }
  return new Date(timestamp).toISOString();
}

function boundedString(value, maxBytes = MAX_EVIDENCE_BYTES) {
  return typeof value === 'string'
    && value.trim().length > 0
    && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function requirePhase(phase) {
  if (!PHASES.has(phase)) fail('phase must be review or final-review');
  return phase;
}

function requireGenerationId(generationId) {
  if (!GENERATION_ID.test(generationId || '')) fail('invalid verification generation id');
  return generationId;
}

function requireDigest(reviewDigest) {
  if (!DIGEST.test(reviewDigest || '')) fail('review digest must be a lowercase sha256 digest');
  return reviewDigest;
}

function cwdFrom(opts) {
  const cwd = resolve(opts.cwd || process.cwd());
  if (cwd.includes('\0')) fail('cwd contains a NUL byte');
  return cwd;
}

function runOpts(opts) {
  const selected = {};
  for (const key of ['base', 'trustedRoot', 'stateDir', '_runLockOwner']) {
    if (Object.hasOwn(opts, key)) selected[key] = opts[key];
  }
  return selected;
}

function prdOpts(opts) {
  return {
    cwd: cwdFrom(opts),
    trustedRoot: opts.trustedRoot || cwdFrom(opts),
    orchestrator: 'atlas',
  };
}

function loadPrd(opts) {
  const record = readExecutionPrd(prdOpts(opts));
  if (!record?.prd || !Array.isArray(record.prd.userStories) || record.prd.userStories.length === 0) {
    fail('execution PRD is unavailable');
  }
  return record;
}

function storyIds(prd) {
  return prd.userStories.map(story => story.id);
}

function authoritativeRunScope(prd) {
  const scope = [];
  const seen = new Set();
  for (const story of prd.userStories) {
    for (const entry of story.scope) {
      // Scope paths are validated printable ASCII. Execution may assign the
      // same path to sequential stories, so collapse those aliases before the
      // shared validator applies its portable case-insensitive boundary.
      const key = entry.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      scope.push(entry);
    }
  }
  return scope;
}

function assertReviewPathsWithinAuthoritativeScope(reviewPackage, prd) {
  // A review package represents the collective run tree, not one worker's
  // isolated output. Its authority is therefore the union of every persisted
  // story scope; per-story verification still proves each story's criteria.
  const result = validateChangedPathsAgainstScope(
    reviewPackage.diffPaths,
    authoritativeRunScope(prd),
  );
  if (!result.ok) {
    const detail = result.error
      || `outside-scope paths: ${result.outsideScope.join(', ')}`;
    fail(`review package exceeds authoritative execution PRD scope: ${detail}`);
  }
}

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function loadPinnedGitEvidence(runId, opts) {
  const cwd = cwdFrom(opts);
  const pinResult = getRunReviewBasePin(runId, runOpts(opts));
  if (!pinResult.ok) fail(`review base pin is unavailable: ${pinResult.reason}`);
  const pin = pinResult.pin;
  const resolvedPin = resolveReviewBase({ cwd, baseRef: pin.baseRefCommit });
  if (resolvedPin.baseRefCommit !== pin.baseRefCommit) {
    fail('pinned review base no longer resolves to its commit');
  }
  const gitEvidence = buildReviewPackage({ cwd, baseRef: pin.baseRefCommit });
  if (gitEvidence.baseRefCommit !== pin.baseRefCommit
    || gitEvidence.baseRef !== pin.baseRefCommit) {
    fail('review package is not bound to the immutable review-base commit');
  }
  return { cwd, pin, gitEvidence };
}

function assertGenerationIdentity(generation, phase, generationId, reviewTreeOid, prd) {
  if (!generation || generation.generationId !== generationId
    || generation.phase !== phase
    || generation.reviewTreeOid !== reviewTreeOid
    || !sameStringSet(generation.storyIds, storyIds(prd))) {
    fail('verification generation identity does not match the review boundary');
  }
}

function loadCompletePackage(runId, phase, generationId, opts) {
  requirePhase(phase);
  requireGenerationId(generationId);
  const { cwd, pin, gitEvidence } = loadPinnedGitEvidence(runId, opts);
  const prdRecord = loadPrd(opts);
  assertReviewPathsWithinAuthoritativeScope(gitEvidence, prdRecord.prd);
  const sealed = getSealedVerificationGeneration(runId, generationId, runOpts(opts));
  if (!sealed.ok) fail(`sealed verification generation is unavailable: ${sealed.reason}`);
  assertGenerationIdentity(
    sealed.generation,
    phase,
    generationId,
    gitEvidence.reviewTreeOid,
    prdRecord.prd,
  );
  const binding = requireVerificationBinding(
    runId,
    phase,
    generationId,
    gitEvidence,
    prdRecord,
    cwd,
    opts,
  );
  if (canonicalTimestamp(binding.boundAt) < canonicalTimestamp(sealed.generation.startedAt)) {
    fail('review verification binding predates its verification generation');
  }
  const boundGitEvidence = bindFinalCommitProposal(
    gitEvidence,
    binding.finalCommitProposal,
  );
  const reviewPackage = attachReviewContext(boundGitEvidence, {
    prd: prdRecord.prd,
    verification: sealed.records,
  });
  assertCompleteReviewPackageIntegrity(reviewPackage);
  assertReviewPackageCurrent(reviewPackage, { cwd });

  const prdAfter = loadPrd(opts);
  const sealedAfter = getSealedVerificationGeneration(runId, generationId, runOpts(opts));
  if (prdAfter.generation !== prdRecord.generation
    || !sealedAfter.ok
    || !isDeepStrictEqual(sealedAfter.generation, sealed.generation)
    || !isDeepStrictEqual(sealedAfter.records, sealed.records)) {
    fail('review context changed while the package was assembled');
  }
  return { cwd, pin, prdRecord, sealed, binding, reviewPackage };
}

function normalizeVerificationRecord(rawRecord, story) {
  if (!exactFields(rawRecord, RECORD_FIELDS)) {
    fail(`verification record fields must be exactly: ${RECORD_FIELDS.join(', ')}`);
  }
  let serialized;
  try { serialized = JSON.stringify(rawRecord); }
  catch (cause) { fail('verification record must be JSON serializable', cause); }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_RECORD_BYTES) {
    fail('verification record exceeds its size bound');
  }
  if (!STORY_ID.test(rawRecord.story_id || '') || rawRecord.story_id !== story?.id) {
    fail('verification record story_id is not the requested PRD story');
  }
  if (!VERIFICATION_VERDICTS.has(rawRecord.verdict)) {
    fail('verification verdict must be pass or fail; skip cannot authorize completion');
  }
  if (!boundedString(rawRecord.evidence)) fail('verification evidence is invalid or oversized');
  if (!REVIEWER.test(rawRecord.verifiedBy || '')) fail('verification verifiedBy is invalid');

  const expected = story.acceptanceCriteria;
  if (!Array.isArray(rawRecord.criteria) || rawRecord.criteria.length !== expected.length) {
    fail('verification criteria must cover every acceptance criterion exactly once');
  }
  const byIndex = new Map();
  for (const criterion of rawRecord.criteria) {
    if (!exactFields(criterion, CRITERION_FIELDS)
      || !Number.isSafeInteger(criterion.criterion_index)
      || criterion.criterion_index < 0
      || criterion.criterion_index >= expected.length
      || byIndex.has(criterion.criterion_index)
      || criterion.criterion_text !== expected[criterion.criterion_index]
      || !VERIFICATION_VERDICTS.has(criterion.verdict)
      || !boundedString(criterion.evidence)) {
      fail('verification criterion is malformed, duplicated, or inconsistent with the PRD');
    }
    byIndex.set(criterion.criterion_index, structuredClone(criterion));
  }
  const criteria = [...byIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, criterion]) => criterion);
  const rollup = criteria.some(criterion => criterion.verdict === 'fail') ? 'fail' : 'pass';
  if (rawRecord.verdict !== rollup) fail('verification verdict disagrees with criterion evidence');

  return {
    story_id: rawRecord.story_id,
    verdict: rawRecord.verdict,
    evidence: rawRecord.evidence,
    verifiedBy: rawRecord.verifiedBy,
    criteria,
  };
}

function parseResultsPayload(rawPayload) {
  let text;
  try {
    text = typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload);
  } catch (cause) {
    fail('review results payload must be JSON serializable', cause);
  }
  if (!boundedString(text, MAX_RESULTS_BYTES)) fail('review results payload is empty or oversized');
  let payload;
  try { payload = JSON.parse(text); }
  catch (cause) { fail('review results payload must be exactly one JSON object', cause); }
  if (!isPlainObject(payload)) fail('review results payload must map reviewer names to results');
  return payload;
}

function routeForPackage(reviewPackage, cwd) {
  const route = routeReviewers({
    diffPaths: reviewPackage.diffPaths,
    diffContent: reviewPackage.diff,
    baseDir: cwd,
  });
  if (!Array.isArray(route.reviewers)
    || route.reviewers.length === 0
    || route.reviewers.length > 5
    || new Set(route.reviewers).size !== route.reviewers.length
    || route.reviewers.some(reviewer => !REVIEWER.test(reviewer))) {
    fail('review router did not produce one to five unique approval reviewers');
  }
  const allowed = new Set(route.allowedReviewers);
  if (route.reviewers.some(reviewer => !allowed.has(reviewer))) {
    fail('review router selected a reviewer outside its active approval allowlist');
  }
  return { route, allowed };
}

function normalizeApprovedResults(payload, reviewPackage, cwd) {
  const { route, allowed } = routeForPackage(reviewPackage, cwd);
  const names = Object.keys(payload);
  if (names.length > 5 || new Set(names).size !== names.length
    || names.some(name => !REVIEWER.test(name) || !allowed.has(name))) {
    fail('review result names must be one to five active bare reviewer names');
  }
  const missing = route.reviewers.filter(reviewer => !Object.hasOwn(payload, reviewer));
  if (missing.length > 0) fail(`review results are missing routed reviewers: ${missing.join(', ')}`);
  const extras = names.filter(name => !route.reviewers.includes(name)).sort();
  const reviewers = [...route.reviewers, ...extras];
  const rawResults = Object.fromEntries(reviewers.map(reviewer => {
    let raw;
    try { raw = JSON.stringify(payload[reviewer]); }
    catch (cause) { fail(`${reviewer} review result is not JSON serializable`, cause); }
    return [reviewer, raw];
  }));
  const aggregate = aggregateReviewResults(rawResults, reviewers, {
    expectedReviewDigest: reviewPackage.reviewDigest.value,
    allowedReviewers: [...allowed],
    reviewPackage,
  });
  if (aggregate.verdict !== 'APPROVE'
    || aggregate.errors.length !== 0
    || aggregate.escalations.length !== 0
    || aggregate.results.length !== reviewers.length
    || aggregate.results.some(result => result.findings.length !== 0
      || result.escalations.length !== 0)) {
    fail(`review approval gate rejected results: ${aggregate.errors.join('; ') || aggregate.verdict}`);
  }
  return { reviewers, results: aggregate.results };
}

function artifactIntegrityMaterial(artifact) {
  return {
    schemaVersion: artifact.schemaVersion,
    runId: artifact.runId,
    phase: artifact.phase,
    generationId: artifact.generationId,
    reviewPackage: artifact.reviewPackage,
    reviewers: artifact.reviewers,
    results: artifact.results,
    approvedAt: artifact.approvedAt,
  };
}

function computeArtifactIntegrity(artifact) {
  return createHash('sha256')
    .update(JSON.stringify(artifactIntegrityMaterial(artifact)), 'utf8')
    .digest('hex');
}

function approvalLeaf(phase, reviewDigest) {
  requirePhase(phase);
  requireDigest(reviewDigest);
  return `review-approval-${phase}-${reviewDigest}.json`;
}

function bindingLeaf(phase, generationId) {
  requirePhase(phase);
  requireGenerationId(generationId);
  return `review-verification-${phase}-${generationId}.json`;
}

function bindingIntegrityMaterial(binding) {
  return {
    schemaVersion: binding.schemaVersion,
    runId: binding.runId,
    phase: binding.phase,
    generationId: binding.generationId,
    reviewTreeOid: binding.reviewTreeOid,
    finalCommitProposal: binding.finalCommitProposal,
    storyIds: binding.storyIds,
    prdGeneration: binding.prdGeneration,
    route: binding.route,
    boundAt: binding.boundAt,
  };
}

function computeBindingIntegrity(binding) {
  return createHash('sha256')
    .update(JSON.stringify(bindingIntegrityMaterial(binding)), 'utf8')
    .digest('hex');
}

function normalizedRouteSnapshot(reviewPackage, cwd) {
  const { route } = routeForPackage(reviewPackage, cwd);
  return JSON.parse(JSON.stringify(route));
}

function parseVerificationBinding(text) {
  let binding;
  try { binding = JSON.parse(text); }
  catch (cause) { fail('review verification binding is invalid JSON', cause); }
  if (!exactFields(binding, BINDING_FIELDS)) {
    fail('review verification binding has an invalid shape');
  }
  return binding;
}

function readVerificationBinding(runId, phase, generationId, opts, allowMissing = false) {
  const paths = bindRunFinalizationPaths(runId, runOpts(opts));
  const artifact = readRegularArtifact(
    join(paths.dir, bindingLeaf(phase, generationId)),
    'review verification binding',
    MAX_BINDING_BYTES,
    {
      allowMissing,
      revalidateContext: () => paths.revalidate(),
    },
  );
  return { paths, binding: artifact.present ? parseVerificationBinding(artifact.text) : null };
}

function validateVerificationBinding(
  binding,
  runId,
  phase,
  generationId,
  gitEvidence,
  prdRecord,
  cwd,
) {
  if (binding.schemaVersion !== SCHEMA_VERSION
    || binding.runId !== runId
    || binding.phase !== phase
    || binding.generationId !== generationId
    || binding.reviewTreeOid !== gitEvidence.reviewTreeOid
    || binding.prdGeneration !== prdRecord.generation
    || !DIGEST.test(binding.prdGeneration || '')
    || !sameStringSet(binding.storyIds, storyIds(prdRecord.prd))
    || binding.integrity?.algorithm !== 'sha256'
    || !DIGEST.test(binding.integrity?.value || '')
    || binding.integrity.value !== computeBindingIntegrity(binding)) {
    fail('review verification binding identity or integrity is invalid');
  }
  const boundGitEvidence = bindFinalCommitProposal(
    gitEvidence,
    binding.finalCommitProposal,
  );
  const currentHead = resolveReviewBase({ cwd, baseRef: 'HEAD' }).baseRefCommit;
  if (currentHead === boundGitEvidence.headCommit) {
    assertReviewPackageCurrent(boundGitEvidence, { cwd });
  } else if (currentHead === boundGitEvidence.finalCommitProposal.objectId) {
    assertReviewPackageHeadTree(boundGitEvidence, { cwd });
  } else {
    fail('review verification binding is stale for the current HEAD');
  }
  const boundAt = canonicalTimestamp(binding.boundAt);
  if (boundAt === null || boundAt > Date.now() + 60_000) {
    fail('review verification binding timestamp is invalid');
  }
  const currentRoute = normalizedRouteSnapshot(gitEvidence, cwd);
  if (!isDeepStrictEqual(binding.route, currentRoute)) {
    fail('review routing state changed after verification started');
  }
  return binding;
}

function persistVerificationBinding(
  runId,
  phase,
  generationId,
  generationStartedAt,
  gitEvidence,
  prdRecord,
  cwd,
  opts,
) {
  const candidate = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    phase,
    generationId,
    reviewTreeOid: gitEvidence.reviewTreeOid,
    finalCommitProposal: gitEvidence.finalCommitProposal,
    storyIds: [...storyIds(prdRecord.prd)].sort(),
    prdGeneration: prdRecord.generation,
    route: normalizedRouteSnapshot(gitEvidence, cwd),
    boundAt: monotonicIsoTimestamp([generationStartedAt]),
  };
  candidate.integrity = {
    algorithm: 'sha256',
    value: computeBindingIntegrity(candidate),
  };
  const current = readVerificationBinding(runId, phase, generationId, opts, true);
  if (current.binding) {
    const existing = validateVerificationBinding(
      current.binding,
      runId,
      phase,
      generationId,
      gitEvidence,
      prdRecord,
      cwd,
    );
    const expected = {
      ...bindingIntegrityMaterial(candidate),
      finalCommitProposal: existing.finalCommitProposal,
      boundAt: existing.boundAt,
    };
    if (!isDeepStrictEqual(bindingIntegrityMaterial(existing), expected)) {
      fail('review verification binding collides with different evidence');
    }
    return existing;
  }
  const serialized = JSON.stringify(candidate, null, 2);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_BINDING_BYTES) {
    fail('review verification binding exceeds its size bound');
  }
  try {
    current.paths.revalidate();
    writeExclusiveRegularArtifact(
      join(current.paths.dir, bindingLeaf(phase, generationId)),
      'review verification binding',
      serialized,
      MAX_BINDING_BYTES,
    );
    current.paths.revalidate();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const persisted = readVerificationBinding(runId, phase, generationId, opts).binding;
  validateVerificationBinding(
    persisted,
    runId,
    phase,
    generationId,
    gitEvidence,
    prdRecord,
    cwd,
  );
  const expected = {
    ...bindingIntegrityMaterial(candidate),
    finalCommitProposal: persisted.finalCommitProposal,
    boundAt: persisted.boundAt,
  };
  if (!isDeepStrictEqual(bindingIntegrityMaterial(persisted), expected)) {
    fail('persisted review verification binding does not match its evidence');
  }
  return persisted;
}

function requireVerificationBinding(
  runId,
  phase,
  generationId,
  gitEvidence,
  prdRecord,
  cwd,
  opts,
) {
  const read = readVerificationBinding(runId, phase, generationId, opts);
  return validateVerificationBinding(
    read.binding,
    runId,
    phase,
    generationId,
    gitEvidence,
    prdRecord,
    cwd,
  );
}

function approvalPath(runId, phase, reviewDigest, opts) {
  const paths = bindRunFinalizationPaths(runId, runOpts(opts));
  return { paths, path: join(paths.dir, approvalLeaf(phase, reviewDigest)) };
}

function parseApprovalArtifact(text) {
  let artifact;
  try { artifact = JSON.parse(text); }
  catch (cause) { fail('review approval artifact is invalid JSON', cause); }
  if (!exactFields(artifact, ARTIFACT_FIELDS)) fail('review approval artifact has an invalid shape');
  return artifact;
}

function readApprovalArtifact(runId, phase, reviewDigest, opts, allowMissing = false) {
  const binding = approvalPath(runId, phase, reviewDigest, opts);
  const read = readRegularArtifact(
    binding.path,
    'review approval artifact',
    MAX_APPROVAL_BYTES,
    {
      allowMissing,
      revalidateContext: () => binding.paths.revalidate(),
    },
  );
  return { ...binding, artifact: read.present ? parseApprovalArtifact(read.text) : null };
}

function validateApprovalArtifact(artifact, runId, phase, reviewDigest, opts) {
  if (artifact.schemaVersion !== SCHEMA_VERSION
    || artifact.runId !== runId
    || artifact.phase !== phase
    || !GENERATION_ID.test(artifact.generationId || '')
    || artifact.reviewPackage?.reviewDigest?.value !== reviewDigest
    || artifact.integrity?.algorithm !== 'sha256'
    || !DIGEST.test(artifact.integrity?.value || '')
    || artifact.integrity.value !== computeArtifactIntegrity(artifact)) {
    fail('review approval artifact identity or integrity is invalid');
  }
  const approvedAt = canonicalTimestamp(artifact.approvedAt);
  if (approvedAt === null || approvedAt > Date.now() + 60_000) {
    fail('review approval timestamp is invalid');
  }
  assertCompleteReviewPackageIntegrity(artifact.reviewPackage);

  const cwd = cwdFrom(opts);
  const pinResult = getRunReviewBasePin(runId, runOpts(opts));
  if (!pinResult.ok) fail(`review base pin is unavailable: ${pinResult.reason}`);
  const resolvedPin = resolveReviewBase({ cwd, baseRef: pinResult.pin.baseRefCommit });
  if (resolvedPin.baseRefCommit !== pinResult.pin.baseRefCommit
    || artifact.reviewPackage.baseRef !== pinResult.pin.baseRefCommit
    || artifact.reviewPackage.baseRefCommit !== pinResult.pin.baseRefCommit) {
    fail('approval package is not bound to the immutable review base');
  }

  const prdRecord = loadPrd(opts);
  if (!isDeepStrictEqual(prdRecord.prd, artifact.reviewPackage.prd)) {
    fail('approval package PRD no longer matches the authoritative execution PRD');
  }
  assertReviewPathsWithinAuthoritativeScope(artifact.reviewPackage, prdRecord.prd);
  const binding = requireVerificationBinding(
    runId,
    phase,
    artifact.generationId,
    artifact.reviewPackage,
    prdRecord,
    cwd,
    opts,
  );
  const sealed = getSealedVerificationGeneration(
    runId,
    artifact.generationId,
    runOpts(opts),
  );
  if (!sealed.ok) fail(`approval verification generation is unavailable: ${sealed.reason}`);
  assertGenerationIdentity(
    sealed.generation,
    phase,
    artifact.generationId,
    artifact.reviewPackage.reviewTreeOid,
    prdRecord.prd,
  );
  if (!isDeepStrictEqual(sealed.records, artifact.reviewPackage.verification)) {
    fail('approval verification records do not match the sealed generation');
  }
  const approvedAtFloor = canonicalTimestamp(sealed.generation.sealedAt);
  const bindingAt = canonicalTimestamp(binding.boundAt);
  if (approvedAtFloor === null
    || bindingAt === null
    || bindingAt < canonicalTimestamp(sealed.generation.startedAt)
    || approvedAt < approvedAtFloor) {
    fail('review approval predates its sealed verification generation');
  }

  if (!Array.isArray(artifact.reviewers)
    || !Array.isArray(artifact.results)
    || artifact.reviewers.length === 0
    || artifact.reviewers.length > 5
    || artifact.results.length !== artifact.reviewers.length
    || new Set(artifact.reviewers).size !== artifact.reviewers.length) {
    fail('review approval reviewer/result roster is invalid');
  }
  const payload = Object.fromEntries(artifact.results.map(result => [result?.reviewer, result]));
  const normalized = normalizeApprovedResults(payload, artifact.reviewPackage, cwd);
  if (!isDeepStrictEqual(normalized.reviewers, artifact.reviewers)
    || !isDeepStrictEqual(normalized.results, artifact.results)) {
    fail('review approval results are not canonical for the routed roster');
  }
  return artifact;
}

function sameApprovalSemantics(left, right) {
  return isDeepStrictEqual(artifactIntegrityMaterial(left), {
    ...artifactIntegrityMaterial(right),
    approvedAt: left.approvedAt,
  });
}

/** Open or resume verification for the exact current Git tree and PRD stories. */
export function startBoundVerification(runId, phase, opts = {}) {
  requirePhase(phase);
  const { cwd, gitEvidence } = loadPinnedGitEvidence(runId, opts);
  const prdBefore = loadPrd(opts);
  assertReviewPathsWithinAuthoritativeScope(gitEvidence, prdBefore.prd);
  const started = beginVerificationGeneration(runId, {
    reviewTreeOid: gitEvidence.reviewTreeOid,
    storyIds: storyIds(prdBefore.prd),
    phase,
  }, {
    ...runOpts(opts),
    ...(opts.supersedeGenerationId === undefined
      ? {}
      : { supersedeGenerationId: requireGenerationId(opts.supersedeGenerationId) }),
  });
  if (!started.ok) fail(`verification generation could not start: ${started.reason}`);
  persistVerificationBinding(
    runId,
    phase,
    started.generation.generationId,
    started.generation.startedAt,
    gitEvidence,
    prdBefore,
    cwd,
    opts,
  );
  assertReviewPackageCurrent(gitEvidence, { cwd });
  const prdAfter = loadPrd(opts);
  if (prdAfter.generation !== prdBefore.generation) {
    fail('execution PRD changed while verification started');
  }
  requireVerificationBinding(
    runId,
    phase,
    started.generation.generationId,
    gitEvidence,
    prdAfter,
    cwd,
    opts,
  );
  const progress = getVerificationGenerationProgress(
    runId,
    started.generation.generationId,
    runOpts(opts),
  );
  if (!progress.ok) fail(`verification generation progress is unavailable: ${progress.reason}`);
  assertGenerationIdentity(
    progress.generation,
    phase,
    started.generation.generationId,
    gitEvidence.reviewTreeOid,
    prdBefore.prd,
  );
  return Object.freeze({
    ok: true,
    resumed: started.resumed === true,
    generationId: started.generation.generationId,
    phase,
    reviewTreeOid: gitEvidence.reviewTreeOid,
    storyIds: Object.freeze([...started.generation.storyIds]),
    missingStoryIds: Object.freeze([...progress.missingStoryIds]),
  });
}

/** Append one caller-supplied semantic record with server-owned binding fields. */
export function recordBoundVerification(runId, generationId, rawRecord, opts = {}) {
  requireGenerationId(generationId);
  const progress = getVerificationGenerationProgress(runId, generationId, runOpts(opts));
  if (!progress.ok) fail(`verification generation progress is unavailable: ${progress.reason}`);
  if (!PHASES.has(progress.generation.phase)) fail('verification generation phase is not reviewable');
  const { cwd, gitEvidence } = loadPinnedGitEvidence(runId, opts);
  if (gitEvidence.reviewTreeOid !== progress.generation.reviewTreeOid) {
    fail('current Git tree changed after verification started');
  }
  const prdBefore = loadPrd(opts);
  assertReviewPathsWithinAuthoritativeScope(gitEvidence, prdBefore.prd);
  assertGenerationIdentity(
    progress.generation,
    progress.generation.phase,
    generationId,
    gitEvidence.reviewTreeOid,
    prdBefore.prd,
  );
  const binding = requireVerificationBinding(
    runId,
    progress.generation.phase,
    generationId,
    gitEvidence,
    prdBefore,
    cwd,
    opts,
  );
  const story = prdBefore.prd.userStories.find(candidate => candidate.id === rawRecord?.story_id);
  const normalized = normalizeVerificationRecord(rawRecord, story);
  const appended = addVerification(runId, {
    ...normalized,
    reviewTreeOid: progress.generation.reviewTreeOid,
    verificationGenerationId: generationId,
    timestamp: monotonicIsoTimestamp([
      progress.generation.startedAt,
      binding.boundAt,
    ]),
  }, runOpts(opts));
  if (!appended.ok) fail(`verification record could not be persisted: ${appended.reason}`);
  const after = getVerificationGenerationProgress(runId, generationId, runOpts(opts));
  const prdAfter = loadPrd(opts);
  if (!after.ok
    || prdAfter.generation !== prdBefore.generation
    || !after.records.some(record => record.story_id === normalized.story_id)) {
    fail('verification record was not durably bound to the current generation');
  }
  return Object.freeze({
    ok: true,
    reused: appended.reused === true,
    generationId,
    storyId: normalized.story_id,
    missingStoryIds: Object.freeze([...after.missingStoryIds]),
  });
}

/** Seal verification and prove that it forms a usable complete review package. */
export function sealBoundVerification(runId, phase, generationId, opts = {}) {
  requirePhase(phase);
  requireGenerationId(generationId);
  const sealed = sealVerificationGeneration(runId, generationId, runOpts(opts));
  if (!sealed.ok) fail(`verification generation could not seal: ${sealed.reason}`);
  const complete = loadCompletePackage(runId, phase, generationId, opts);
  return Object.freeze({
    ok: true,
    resumed: sealed.resumed === true,
    generationId,
    phase,
    reviewDigest: complete.reviewPackage.reviewDigest.value,
    reviewTreeOid: complete.reviewPackage.reviewTreeOid,
    reviewers: Object.freeze([...complete.binding.route.reviewers]),
    allowedReviewers: Object.freeze([...complete.binding.route.allowedReviewers]),
  });
}

/** Validate all routed approvals and exclusively persist an immutable ledger artifact. */
export function approveBoundReview(runId, phase, generationId, rawResultsPayload, opts = {}) {
  const complete = loadCompletePackage(runId, phase, generationId, opts);
  const payload = parseResultsPayload(rawResultsPayload);
  const approved = normalizeApprovedResults(payload, complete.reviewPackage, complete.cwd);
  assertReviewPackageCurrent(complete.reviewPackage, { cwd: complete.cwd });

  const reviewDigest = complete.reviewPackage.reviewDigest.value;
  const candidate = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    phase,
    generationId,
    reviewPackage: complete.reviewPackage,
    reviewers: approved.reviewers,
    results: approved.results,
    approvedAt: monotonicIsoTimestamp([
      complete.sealed.generation.sealedAt,
      complete.binding.boundAt,
      ...complete.sealed.records.map(record => record.timestamp),
    ]),
  };
  candidate.integrity = {
    algorithm: 'sha256',
    value: computeArtifactIntegrity(candidate),
  };

  const existing = readApprovalArtifact(runId, phase, reviewDigest, opts, true);
  if (existing.artifact) {
    const validated = validateApprovalArtifact(
      existing.artifact,
      runId,
      phase,
      reviewDigest,
      opts,
    );
    if (!sameApprovalSemantics(validated, candidate)) {
      fail('review approval artifact collides with different approval evidence');
    }
    return Object.freeze({
      ok: true,
      created: false,
      generationId,
      phase,
      reviewDigest,
      reviewTreeOid: validated.reviewPackage.reviewTreeOid,
    });
  }

  const serialized = JSON.stringify(candidate, null, 2);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_APPROVAL_BYTES) {
    fail('review approval artifact exceeds its size bound');
  }
  let created = false;
  try {
    existing.paths.revalidate();
    writeExclusiveRegularArtifact(
      existing.path,
      'review approval artifact',
      serialized,
      MAX_APPROVAL_BYTES,
    );
    existing.paths.revalidate();
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  const persisted = loadBoundApproval(runId, phase, reviewDigest, opts);
  if (!sameApprovalSemantics(persisted, candidate)) {
    fail('persisted review approval does not match the approved evidence');
  }
  assertReviewPackageCurrent(persisted.reviewPackage, { cwd: complete.cwd });
  return Object.freeze({
    ok: true,
    created,
    generationId,
    phase,
    reviewDigest,
    reviewTreeOid: persisted.reviewPackage.reviewTreeOid,
  });
}

/** Strictly load and revalidate one immutable approval selected by its digest. */
export function loadBoundApproval(runId, phase, reviewDigest, opts = {}) {
  requirePhase(phase);
  requireDigest(reviewDigest);
  const read = readApprovalArtifact(runId, phase, reviewDigest, opts);
  return Object.freeze(structuredClone(
    validateApprovalArtifact(read.artifact, runId, phase, reviewDigest, opts),
  ));
}

/** Derive review phase outputs from a current immutable approval. */
export function validateReviewPhaseCompletion(runId, reviewDigest, opts = {}) {
  const artifact = loadBoundApproval(runId, 'review', reviewDigest, opts);
  assertReviewPackageCurrent(artifact.reviewPackage, { cwd: cwdFrom(opts) });
  return Object.freeze({
    approvedReviewDigest: artifact.reviewPackage.reviewDigest.value,
    approvedReviewTreeOid: artifact.reviewPackage.reviewTreeOid,
  });
}

function gitStatusPorcelain(cwd) {
  try {
    return getReviewWorktreeState({ cwd }).dirty ? 'dirty' : '';
  } catch (cause) {
    fail('Git status could not prove a clean final tree', cause);
  }
}

/** Derive finalization outputs from the committed tree approved in final-review. */
export function validateFinalizePhaseCompletion(runId, reviewDigest, opts = {}) {
  const cwd = cwdFrom(opts);
  const artifact = loadBoundApproval(runId, 'final-review', reviewDigest, opts);
  const materialized = materializeApprovedReviewCommit(artifact.reviewPackage, { cwd });
  if (!OBJECT_ID.test(materialized.finalCommit)) {
    fail('approved final commit did not materialize as a real commit object');
  }
  if (gitStatusPorcelain(cwd) !== '') fail('final Git tree changed during completion validation');
  const finalCommit = resolveReviewBase({ cwd, baseRef: 'HEAD' }).baseRefCommit;
  if (finalCommit !== materialized.finalCommit) fail('HEAD changed during completion validation');
  assertReviewPackageHeadTree(artifact.reviewPackage, { cwd });
  return Object.freeze({
    finalReviewDigest: artifact.reviewPackage.reviewDigest.value,
    finalReviewTreeOid: artifact.reviewPackage.reviewTreeOid,
    finalCommit,
  });
}
