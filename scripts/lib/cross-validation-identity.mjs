/** Strict, bounded identity shared by cross-validation workers and supervisors. */

import { createHash } from 'node:crypto';

export const REVIEW_TREE_OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const VALIDATION_PROMPT_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
export const VALIDATION_SNAPSHOT_ID_PATTERN = /^xval-[0-9a-f]{32}$/;
export const VALIDATION_SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const VALIDATION_IDENTITY_FIELDS = Object.freeze([
  'schemaVersion',
  'orchestrator',
  'runId',
  'storyId',
  'reviewTreeOid',
  'snapshotId',
  'promptDigest',
]);
const VALIDATION_IDENTITY_KEYS = new Set(VALIDATION_IDENTITY_FIELDS);

export function normalizeCrossValidationIdentity(value, label = 'validationIdentity') {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(value);
  if (keys.length !== VALIDATION_IDENTITY_FIELDS.length
    || keys.some(key => !VALIDATION_IDENTITY_KEYS.has(key))
    || VALIDATION_IDENTITY_FIELDS.some(
      key => !Object.prototype.hasOwnProperty.call(value, key),
    )) {
    throw new Error(`${label} must use the exact cross-validation envelope`);
  }
  if (typeof value.reviewTreeOid !== 'string'
    || !REVIEW_TREE_OID_PATTERN.test(value.reviewTreeOid)
    || typeof value.snapshotId !== 'string'
    || !VALIDATION_SNAPSHOT_ID_PATTERN.test(value.snapshotId)
    || typeof value.promptDigest !== 'string'
    || !VALIDATION_PROMPT_DIGEST_PATTERN.test(value.promptDigest)) {
    throw new Error(`${label} requires exact reviewTreeOid, snapshotId, and promptDigest`);
  }
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is invalid`);
  }
  if (value.orchestrator !== 'atlas' && value.orchestrator !== 'athena') {
    throw new Error(`${label}.orchestrator is invalid`);
  }
  for (const field of ['runId', 'storyId']) {
    if (typeof value[field] !== 'string' || !VALIDATION_SAFE_ID_PATTERN.test(value[field])) {
      throw new Error(`${label}.${field} is invalid`);
    }
  }
  return {
    schemaVersion: value.schemaVersion,
    orchestrator: value.orchestrator,
    runId: value.runId,
    storyId: value.storyId,
    reviewTreeOid: value.reviewTreeOid,
    snapshotId: value.snapshotId,
    promptDigest: value.promptDigest,
  };
}

export function crossValidationIdentityKey(value, label = 'validationIdentity') {
  const normalized = normalizeCrossValidationIdentity(value, label);
  return normalized ? JSON.stringify(normalized) : null;
}

/**
 * Validate the self-referential prompt digest contract. The builder hashes a
 * canonical template containing `<PROMPT_DIGEST>`, then substitutes the digest
 * into every placeholder in the delivered prompt.
 */
export function assertCrossValidationPromptIdentity(prompt, identity, label = 'worker') {
  if (typeof prompt !== 'string' || !prompt.includes(identity.promptDigest)) {
    throw new Error(`${label} prompt does not carry its validation digest`);
  }
  const canonical = prompt.split(identity.promptDigest).join('<PROMPT_DIGEST>');
  const actual = createHash('sha256').update(canonical, 'utf8').digest('hex');
  if (actual !== identity.promptDigest) {
    throw new Error(`${label} prompt digest does not match validationIdentity`);
  }
  return true;
}
