import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  HARDENED_FS_VIOLATION_CODE,
  bindSafeDirectoryPath,
  ensureSafeDirectoryPath,
  lstatOrMissing,
  readRegularArtifact,
  revalidateDirectoryBinding,
  revalidateRegularArtifact,
  sameFileGeneration,
  writeExclusiveRegularArtifact,
} from './hardened-fs.mjs';
import { withExecutionPrdMutationLock } from './execution-prd-lock.mjs';

export const HERMES_SPEC_SCHEMA_VERSION = 1;
export const MAX_HERMES_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_HERMES_SPEC_BYTES = 1024 * 1024;
export const MAX_HERMES_PRD_BYTES = 1024 * 1024;

const WRITE_VERDICTS = new Set(['CREATE', 'UPDATE', 'RECREATE']);
const ALL_VERDICTS = new Set(['PASS', ...WRITE_VERDICTS]);
const PRD_MODES = new Set(['product-feature', 'engineering-change', 'bugfix', 'reverse']);
const PRD_SCALES = new Set(['S', 'M', 'L']);
const REQUIRED_STRING_ARRAYS = ['goals', 'nonGoals', 'constraints', 'risks', 'openQuestions'];
const SAFE_PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_STORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GIVEN_WHEN_THEN = /^GIVEN\s+.+\s+WHEN\s+.+\s+THEN\s+.+$/s;
const MAX_SUMMARY_BYTES = 4 * 1024;
const MAX_ARRAY_ITEMS = 256;
const MAX_STORIES = 256;
const MAX_ACCEPTANCE_CRITERIA = 128;
const MAX_FIELD_BYTES = 16 * 1024;
const MAX_TRANSACTION_MANIFEST_BYTES = 64 * 1024;
const TRANSACTION_PREFIX = '.spec-artifact-txn-';
const CLEANUP_PREFIX = '.spec-artifact-cleanup-';
const TRANSACTION_MANIFEST = 'manifest.json';
const TRANSACTION_SCHEMA_VERSION = 1;
const SIMULATED_CRASH_CODE = 'AO_SPEC_ARTIFACT_SIMULATED_CRASH';
const NO_FOLLOW = fsConstants.O_NOFOLLOW || 0;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function boundedNonEmptyString(value, maxBytes = MAX_FIELD_BYTES) {
  return nonEmptyString(value) && byteLength(value) <= maxBytes;
}

function artifactViolation(message) {
  const error = new Error(message);
  error.code = HARDENED_FS_VIOLATION_CODE;
  return error;
}

function assertAoDirectoryMode(binding) {
  if (process.platform === 'win32') return;
  const leaf = binding.chain[binding.chain.length - 1]?.stat;
  if (!leaf || (leaf.mode & 0o022) !== 0) {
    throw artifactViolation('Hermes .ao directory is group/world-writable');
  }
}

function validateStringArray(prd, field, errors) {
  const value = prd[field];
  if (!Array.isArray(value)) {
    errors.push(`prd.${field} must be an array`);
    return;
  }
  if (value.length > MAX_ARRAY_ITEMS) {
    errors.push(`prd.${field} must contain at most ${MAX_ARRAY_ITEMS} items`);
  }
  if (value.some(item => !boundedNonEmptyString(item))) {
    errors.push(`prd.${field} must contain only bounded non-empty strings`);
  }
}

function validateProductFields(prd, errors) {
  const targetUsersValid = boundedNonEmptyString(prd.targetUsers)
    || (Array.isArray(prd.targetUsers)
      && prd.targetUsers.length > 0
      && prd.targetUsers.length <= MAX_ARRAY_ITEMS
      && prd.targetUsers.every(item => boundedNonEmptyString(item)));
  if (!targetUsersValid) {
    errors.push(
      'prd.targetUsers must be a bounded non-empty string or non-empty string array for product-feature',
    );
  }

  const validMetric = metric => {
    if (boundedNonEmptyString(metric)) return true;
    if (!isPlainObject(metric)
      || !boundedNonEmptyString(metric.metric)
      || !boundedNonEmptyString(metric.target)) return false;
    try {
      return byteLength(JSON.stringify(metric)) <= MAX_FIELD_BYTES;
    } catch {
      return false;
    }
  };
  if (!Array.isArray(prd.successMetrics)
    || prd.successMetrics.length === 0
    || prd.successMetrics.length > MAX_ARRAY_ITEMS
    || prd.successMetrics.some(metric => !validMetric(metric))) {
    errors.push(
      'prd.successMetrics must contain bounded strings or { metric, target } objects for product-feature',
    );
  }
}

export function validateHermesPrd(prd) {
  const errors = [];
  if (!isPlainObject(prd)) {
    return { ok: false, errors: ['prd must be an object'] };
  }

  if (!nonEmptyString(prd.projectName) || !SAFE_PROJECT_NAME.test(prd.projectName)) {
    errors.push('prd.projectName must be a safe non-empty slug');
  }
  if (!PRD_MODES.has(prd.mode)) {
    errors.push(`prd.mode must be one of ${[...PRD_MODES].join(', ')}`);
  }
  if (!PRD_SCALES.has(prd.scale)) {
    errors.push(`prd.scale must be one of ${[...PRD_SCALES].join(', ')}`);
  }
  for (const field of REQUIRED_STRING_ARRAYS) validateStringArray(prd, field, errors);
  if (prd.mode === 'product-feature') validateProductFields(prd, errors);

  if (!Array.isArray(prd.userStories) || prd.userStories.length === 0) {
    errors.push('prd.userStories must be a non-empty array');
  } else {
    if (prd.userStories.length > MAX_STORIES) {
      errors.push(`prd.userStories must contain at most ${MAX_STORIES} stories`);
    }
    const ids = new Set();
    for (const [index, story] of prd.userStories.entries()) {
      const prefix = `prd.userStories[${index}]`;
      if (!isPlainObject(story)) {
        errors.push(`${prefix} must be an object`);
        continue;
      }
      if (!boundedNonEmptyString(story.id) || !SAFE_STORY_ID.test(story.id)) {
        errors.push(`${prefix}.id must be a safe non-empty identifier`);
      } else if (ids.has(story.id)) {
        errors.push(`${prefix}.id must be unique`);
      } else {
        ids.add(story.id);
      }
      if (!boundedNonEmptyString(story.title)) {
        errors.push(`${prefix}.title must be a bounded non-empty string`);
      }
      if (!Array.isArray(story.acceptanceCriteria)
        || story.acceptanceCriteria.length === 0) {
        errors.push(`${prefix}.acceptanceCriteria must be a non-empty array`);
      } else {
        if (story.acceptanceCriteria.length > MAX_ACCEPTANCE_CRITERIA) {
          errors.push(
            `${prefix}.acceptanceCriteria must contain at most ${MAX_ACCEPTANCE_CRITERIA} items`,
          );
        }
        if (story.acceptanceCriteria.some(item => !boundedNonEmptyString(item))) {
          errors.push(`${prefix}.acceptanceCriteria must contain bounded non-empty strings`);
        }
        if (story.acceptanceCriteria.some(item => nonEmptyString(item)
          && !GIVEN_WHEN_THEN.test(item.trim()))) {
          errors.push(`${prefix}.acceptanceCriteria must use GIVEN ... WHEN ... THEN ...`);
        }
      }
      if (story.passes !== false) {
        errors.push(`${prefix}.passes must be false when the spec is created or replaced`);
      }
    }
  }

  let serialized;
  try {
    serialized = JSON.stringify(prd);
  } catch {
    errors.push('prd must be JSON serializable');
  }
  if (serialized && byteLength(serialized) > MAX_HERMES_PRD_BYTES) {
    errors.push(`prd exceeds the ${MAX_HERMES_PRD_BYTES}-byte limit`);
  }

  return { ok: errors.length === 0, errors };
}

export function parseHermesSpecEnvelope(rawOutput) {
  if (!nonEmptyString(rawOutput)) {
    throw new Error('Hermes output must be a non-empty JSON string');
  }
  if (byteLength(rawOutput) > MAX_HERMES_OUTPUT_BYTES) {
    throw new Error(`Hermes output exceeds the ${MAX_HERMES_OUTPUT_BYTES}-byte limit`);
  }

  let envelope;
  try {
    envelope = JSON.parse(rawOutput.trim());
  } catch {
    throw new Error('Hermes output must be exactly one JSON object without Markdown fences');
  }

  if (!isPlainObject(envelope)) throw new Error('Hermes output must be a JSON object');
  if (envelope.schemaVersion !== HERMES_SPEC_SCHEMA_VERSION) {
    throw new Error(`Hermes schemaVersion must be ${HERMES_SPEC_SCHEMA_VERSION}`);
  }
  if (!ALL_VERDICTS.has(envelope.verdict)) {
    throw new Error(`Hermes verdict must be one of ${[...ALL_VERDICTS].join(', ')}`);
  }
  if (!boundedNonEmptyString(envelope.summary, MAX_SUMMARY_BYTES)) {
    throw new Error('Hermes summary must be a bounded non-empty string');
  }

  if (envelope.verdict === 'PASS') {
    if (envelope.specMarkdown !== null || envelope.prd !== null) {
      throw new Error('PASS must set specMarkdown and prd to null');
    }
    return envelope;
  }

  if (!boundedNonEmptyString(envelope.specMarkdown, MAX_HERMES_SPEC_BYTES)) {
    throw new Error(
      `${envelope.verdict} must include non-empty specMarkdown within the byte limit`,
    );
  }
  const validation = validateHermesPrd(envelope.prd);
  if (!validation.ok) {
    throw new Error(`invalid Hermes prd: ${validation.errors.join('; ')}`);
  }
  return envelope;
}

function resolveArtifactContext(options, { createAo }) {
  const cwd = resolve(options.cwd || process.cwd());
  const trustedRoot = resolve(options.trustedRoot || cwd);
  const projectBinding = bindSafeDirectoryPath(cwd, 'Hermes project root', {
    trustedRoot,
    requirePrivateMode: false,
  });
  const aoDir = join(cwd, '.ao');
  const aoBinding = createAo
    ? ensureSafeDirectoryPath(aoDir, 'Hermes .ao directory', {
      trustedRoot,
      requirePrivateMode: false,
      requirePrivateAnchor: false,
    })
    : bindSafeDirectoryPath(aoDir, 'Hermes .ao directory', {
      trustedRoot,
      requirePrivateMode: false,
    });

  const context = {
    cwd,
    trustedRoot,
    aoDir,
    specPath: join(aoDir, 'spec.md'),
    prdPath: join(aoDir, 'prd.json'),
    revalidate() {
      revalidateDirectoryBinding(projectBinding, 'Hermes project root');
      revalidateDirectoryBinding(aoBinding, 'Hermes .ao directory');
      assertAoDirectoryMode(aoBinding);
    },
  };
  context.revalidate();
  return context;
}

function parsePersistedPrd(text) {
  let prd;
  try {
    prd = JSON.parse(text);
  } catch {
    throw new Error('existing .ao/prd.json is not valid JSON');
  }
  const validation = validateHermesPrd(prd);
  if (!validation.ok) {
    throw new Error(`invalid existing Hermes prd: ${validation.errors.join('; ')}`);
  }
  return prd;
}

function validateLegacyArtifactStat(stat, label, maxBytes) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.size <= 0 || stat.size > maxBytes) {
    throw artifactViolation(`${label} is unsafe`);
  }
  if (process.platform !== 'win32') {
    const permissions = stat.mode & 0o7777;
    // Compatibility migration is intentionally narrow: read-only sharing is
    // accepted, but executable, set-id, or group/world-writable artifacts are not.
    if ((permissions & 0o7000) !== 0 || (permissions & 0o133) !== 0) {
      throw artifactViolation(`${label} has unsafe legacy permissions`);
    }
  }
}

function prevalidateLegacyArtifact(path, label, maxBytes, context) {
  context.revalidate();
  const stat = lstatOrMissing(path);
  if (!stat) throw artifactViolation(`${label} is missing`);
  validateLegacyArtifactStat(stat, label, maxBytes);
  return stat;
}

function changeBoundArtifactMode(path, label, maxBytes, expected, targetMode, context) {
  let fd;
  let changed = false;
  const originalMode = expected.mode & 0o777;
  try {
    context.revalidate();
    const pathBefore = lstatSync(path);
    if (!sameFileGeneration(pathBefore, expected, 'full')) {
      throw artifactViolation(`${label} changed before permission migration`);
    }
    fd = openSync(path, fsConstants.O_RDONLY | NO_FOLLOW);
    const opened = fstatSync(fd);
    validateLegacyArtifactStat(opened, label, maxBytes);
    if (!sameFileGeneration(expected, opened, 'full')) {
      throw artifactViolation(`${label} changed before permission migration`);
    }
    context.revalidate();
    fchmodSync(fd, targetMode);
    changed = true;
    const updated = fstatSync(fd);
    if (!sameFileGeneration(opened, updated, 'object')
      || updated.size !== opened.size
      || (updated.mode & 0o777) !== targetMode) {
      throw artifactViolation(`${label} permission migration was not durable`);
    }
    context.revalidate();
    const pathAfter = lstatSync(path);
    if (!sameFileGeneration(updated, pathAfter, 'full')) {
      throw artifactViolation(`${label} changed during permission migration`);
    }
    return updated;
  } catch (error) {
    if (changed && fd !== undefined) {
      try {
        const current = fstatSync(fd);
        if (!sameFileGeneration(expected, current, 'object') || current.size !== expected.size) {
          throw artifactViolation(`${label} changed before permission rollback`);
        }
        fchmodSync(fd, originalMode);
        const restored = fstatSync(fd);
        if (!sameFileGeneration(expected, restored, 'object')
          || restored.size !== expected.size
          || (restored.mode & 0o777) !== originalMode) {
          throw artifactViolation(`${label} permission rollback was not durable`);
        }
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `${label} permission migration failed and could not be rolled back`,
        );
      }
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function migrateLegacyArtifactMode(path, label, maxBytes, expected, context) {
  if (process.platform === 'win32' || (expected.mode & 0o777) === 0o600) {
    return { changed: false, before: expected, after: expected };
  }
  const after = changeBoundArtifactMode(path, label, maxBytes, expected, 0o600, context);
  return { changed: true, before: expected, after };
}

function migrateLegacyArtifactPair(context) {
  // Validate the complete pair before changing either mode. This prevents a
  // bad second artifact from leaving only the first artifact hardened.
  const specBefore = prevalidateLegacyArtifact(
    context.specPath,
    'Hermes spec artifact',
    MAX_HERMES_SPEC_BYTES,
    context,
  );
  const prdBefore = prevalidateLegacyArtifact(
    context.prdPath,
    'Hermes PRD artifact',
    MAX_HERMES_PRD_BYTES,
    context,
  );

  let specMigration;
  try {
    specMigration = migrateLegacyArtifactMode(
      context.specPath,
      'Hermes spec artifact',
      MAX_HERMES_SPEC_BYTES,
      specBefore,
      context,
    );
    migrateLegacyArtifactMode(
      context.prdPath,
      'Hermes PRD artifact',
      MAX_HERMES_PRD_BYTES,
      prdBefore,
      context,
    );
  } catch (error) {
    if (specMigration?.changed) {
      try {
        changeBoundArtifactMode(
          context.specPath,
          'Hermes spec artifact',
          MAX_HERMES_SPEC_BYTES,
          specMigration.after,
          specMigration.before.mode & 0o777,
          context,
        );
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Hermes artifact permission migration failed and could not restore the pair',
        );
      }
    }
    throw error;
  }
}

function readAndValidateArtifactPair(context, expected = {}) {
  migrateLegacyArtifactPair(context);
  const readOptions = { generationPolicy: 'full', revalidateContext: context.revalidate };
  const specResult = readRegularArtifact(
    context.specPath,
    'Hermes spec artifact',
    MAX_HERMES_SPEC_BYTES,
    readOptions,
  );
  if (!nonEmptyString(specResult.text)) {
    throw new Error('existing .ao/spec.md must contain non-whitespace text');
  }
  const prdResult = readRegularArtifact(
    context.prdPath,
    'Hermes PRD artifact',
    MAX_HERMES_PRD_BYTES,
    readOptions,
  );
  const prd = parsePersistedPrd(prdResult.text);

  // Prove the first read still names the same generation after the second read.
  revalidateRegularArtifact(
    context.specPath,
    specResult.stat,
    'Hermes spec artifact',
    MAX_HERMES_SPEC_BYTES,
    { generationPolicy: 'full' },
  );
  revalidateRegularArtifact(
    context.prdPath,
    prdResult.stat,
    'Hermes PRD artifact',
    MAX_HERMES_PRD_BYTES,
    { generationPolicy: 'full' },
  );
  context.revalidate();

  if (expected.spec !== undefined && specResult.text !== expected.spec) {
    throw artifactViolation('persisted Hermes spec does not match the committed generation');
  }
  if (expected.prd !== undefined && prdResult.text !== expected.prd) {
    throw artifactViolation('persisted Hermes PRD does not match the committed generation');
  }
  return { prd, specStat: specResult.stat, prdStat: prdResult.stat };
}

function snapshotDestination(path, label, maxBytes) {
  const stat = lstatOrMissing(path);
  if (!stat) return null;
  validateLegacyArtifactStat(stat, label, maxBytes);
  return stat;
}

function sameSnapshot(current, expected) {
  if (!current || !expected) return current === expected;
  return sameFileGeneration(current, expected, 'full');
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function contentDescriptor(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  return { size: bytes.length, sha256: sha256(bytes) };
}

function inspectArtifactCandidate(path, label, maxBytes, context, {
  expectedStat = undefined,
  requirePrivateMode = false,
} = {}) {
  context.revalidate();
  const pathStat = lstatOrMissing(path);
  if (!pathStat) return null;
  validateLegacyArtifactStat(pathStat, label, maxBytes);
  if (requirePrivateMode && process.platform !== 'win32'
    && (pathStat.mode & 0o777) !== 0o600) {
    throw artifactViolation(`${label} is not private`);
  }
  if (expectedStat !== undefined && !sameFileGeneration(pathStat, expectedStat, 'full')) {
    throw artifactViolation(`${label} changed before transaction inspection`);
  }

  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | NO_FOLLOW);
    const opened = fstatSync(fd);
    validateLegacyArtifactStat(opened, label, maxBytes);
    if (requirePrivateMode && process.platform !== 'win32'
      && (opened.mode & 0o777) !== 0o600) {
      throw artifactViolation(`${label} is not private`);
    }
    if (!sameFileGeneration(pathStat, opened, 'full')) {
      throw artifactViolation(`${label} changed before transaction inspection`);
    }
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count <= 0) throw artifactViolation(`${label} was truncated during inspection`);
      offset += count;
    }
    const after = fstatSync(fd);
    if (!sameFileGeneration(opened, after, 'full')) {
      throw artifactViolation(`${label} changed during transaction inspection`);
    }
    context.revalidate();
    return { stat: after, ...contentDescriptor(buffer) };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function descriptorFromInspection(inspection) {
  return inspection ? { size: inspection.size, sha256: inspection.sha256 } : null;
}

function descriptorMatches(inspection, descriptor) {
  return Boolean(inspection && descriptor)
    && inspection.size === descriptor.size
    && inspection.sha256 === descriptor.sha256;
}

function validateManifestDescriptor(value, label, maxBytes, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (!isPlainObject(value)
    || !Number.isSafeInteger(value.size)
    || value.size <= 0
    || value.size > maxBytes
    || typeof value.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw artifactViolation(`${label} is invalid`);
  }
}

function fsyncDirectory(path) {
  if (process.platform === 'win32') return;
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0) | NO_FOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw artifactViolation('Hermes transaction directory changed before fsync');
    }
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function syncTransactionDirectories(context, transactionBinding) {
  context.revalidate();
  revalidateDirectoryBinding(transactionBinding, 'Hermes artifact transaction');
  fsyncDirectory(transactionBinding.path);
  fsyncDirectory(context.aoDir);
}

function assertDestinationUnchanged(path, expected, label) {
  const current = lstatOrMissing(path);
  if (!sameSnapshot(current, expected)) {
    throw artifactViolation(`${label} changed during Hermes artifact transaction`);
  }
}

function assertInstalledGeneration(path, expected, label) {
  const current = lstatSync(path);
  if (!sameFileGeneration(current, expected, 'object-mode') || current.size !== expected.size) {
    throw artifactViolation(`${label} is not the staged Hermes generation`);
  }
  return current;
}

function moveExistingToBackup(item, context) {
  if (!item.initial) return;
  assertDestinationUnchanged(item.finalPath, item.initial, item.label);
  context.revalidate();
  renameSync(item.finalPath, item.backupPath);
  item.oldMoved = true;
  item.backupStat = assertInstalledGeneration(item.backupPath, item.initial, item.label);
  syncTransactionDirectories(context, item.transactionBinding);
}

function installStaged(item, context) {
  assertDestinationUnchanged(item.finalPath, null, item.label);
  context.revalidate();
  renameSync(item.stagedPath, item.finalPath);
  item.installed = true;
  item.installedStat = assertInstalledGeneration(item.finalPath, item.stagedStat, item.label);
  syncTransactionDirectories(context, item.transactionBinding);
}

function rollbackItem(item, context) {
  if (item.installed) {
    assertInstalledGeneration(item.finalPath, item.installedStat, item.label);
    context.revalidate();
    renameSync(item.finalPath, item.stagedPath);
    item.installed = false;
    syncTransactionDirectories(context, item.transactionBinding);
    item.stagedStat = lstatSync(item.stagedPath);
  }
  if (item.oldMoved) {
    assertDestinationUnchanged(item.finalPath, null, item.label);
    assertInstalledGeneration(item.backupPath, item.backupStat, item.label);
    context.revalidate();
    renameSync(item.backupPath, item.finalPath);
    item.oldMoved = false;
    syncTransactionDirectories(context, item.transactionBinding);
  }

  const restored = lstatOrMissing(item.finalPath);
  if (item.initial === null) {
    if (restored !== null) throw artifactViolation(`${item.label} rollback left a new artifact`);
  } else if (!restored
    || !sameFileGeneration(restored, item.initial, 'object-mode')
    || restored.size !== item.initial.size) {
    throw artifactViolation(`${item.label} rollback did not restore the original generation`);
  }
}

function cleanupTransaction(context, transactionBinding, paths) {
  try {
    context.revalidate();
    revalidateDirectoryBinding(transactionBinding, 'Hermes artifact transaction');
    const manifestPath = paths.find(path => basename(path) === TRANSACTION_MANIFEST);
    if (!manifestPath) throw artifactViolation('Hermes transaction manifest path is missing');
    for (const path of paths.filter(candidate => candidate !== manifestPath)) {
      const stat = lstatOrMissing(path);
      if (stat) {
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
          throw artifactViolation('Hermes transaction cleanup artifact is unsafe');
        }
        unlinkSync(path);
      }
    }
    fsyncDirectory(transactionBinding.path);

    // Keep the manifest present until the active transaction directory has
    // atomically left the recovery namespace. A crash during final cleanup can
    // then leave only a harmless cleanup tombstone, never an active directory
    // without its journal.
    const transactionName = basename(transactionBinding.path);
    if (!transactionName.startsWith(TRANSACTION_PREFIX)) {
      throw artifactViolation('Hermes transaction directory name is invalid');
    }
    const cleanupDir = join(
      context.aoDir,
      `${CLEANUP_PREFIX}${transactionName.slice(TRANSACTION_PREFIX.length)}`,
    );
    if (lstatOrMissing(cleanupDir)) {
      throw artifactViolation('Hermes transaction cleanup destination already exists');
    }
    renameSync(transactionBinding.path, cleanupDir);
    fsyncDirectory(context.aoDir);

    const cleanupBinding = bindSafeDirectoryPath(
      cleanupDir,
      'Hermes artifact cleanup tombstone',
      { trustedRoot: context.trustedRoot, requirePrivateMode: true },
    );
    const movedManifest = join(cleanupDir, TRANSACTION_MANIFEST);
    const manifestStat = lstatSync(movedManifest);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.nlink !== 1
      || (process.platform !== 'win32' && (manifestStat.mode & 0o777) !== 0o600)) {
      throw artifactViolation('Hermes transaction cleanup manifest is unsafe');
    }
    unlinkSync(movedManifest);
    fsyncDirectory(cleanupBinding.path);
    rmdirSync(cleanupBinding.path);
    fsyncDirectory(context.aoDir);
  } catch {
    // The committed pair is authoritative. Unsafe or unexpectedly non-empty
    // transaction state is retained for inspection instead of recursively removed.
  }
}

function parseTransactionManifest(text, transactionId) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw artifactViolation('Hermes transaction manifest is not valid JSON');
  }
  if (!isPlainObject(manifest)
    || manifest.schemaVersion !== TRANSACTION_SCHEMA_VERSION
    || manifest.transactionId !== transactionId
    || !isPlainObject(manifest.artifacts)
    || !isPlainObject(manifest.artifacts.spec)
    || !isPlainObject(manifest.artifacts.prd)) {
    throw artifactViolation('Hermes transaction manifest is invalid');
  }
  validateManifestDescriptor(
    manifest.artifacts.spec.initial,
    'Hermes transaction initial spec descriptor',
    MAX_HERMES_SPEC_BYTES,
    { nullable: true },
  );
  validateManifestDescriptor(
    manifest.artifacts.spec.next,
    'Hermes transaction next spec descriptor',
    MAX_HERMES_SPEC_BYTES,
  );
  validateManifestDescriptor(
    manifest.artifacts.prd.initial,
    'Hermes transaction initial PRD descriptor',
    MAX_HERMES_PRD_BYTES,
    { nullable: true },
  );
  validateManifestDescriptor(
    manifest.artifacts.prd.next,
    'Hermes transaction next PRD descriptor',
    MAX_HERMES_PRD_BYTES,
  );
  return manifest;
}

function classifyRecoveryCandidate(inspection, initial, next) {
  if (!inspection) return 'missing';
  const matchesInitial = descriptorMatches(inspection, initial);
  const matchesNext = descriptorMatches(inspection, next);
  if (matchesInitial && matchesNext) return 'same';
  if (matchesNext) return 'next';
  if (matchesInitial) return 'initial';
  return 'unknown';
}

function assertRecoverySource(path, expected, label, context, transactionBinding) {
  context.revalidate();
  revalidateDirectoryBinding(transactionBinding, 'Hermes artifact transaction');
  const current = lstatSync(path);
  if (!sameFileGeneration(current, expected.stat, 'full')) {
    throw artifactViolation(`${label} changed during Hermes transaction recovery`);
  }
}

function unlinkRecoveryCandidate(path, expected, label, context, transactionBinding) {
  assertRecoverySource(path, expected, label, context, transactionBinding);
  unlinkSync(path);
  syncTransactionDirectories(context, transactionBinding);
}

function renameRecoveryCandidate(
  source,
  destination,
  expected,
  label,
  context,
  transactionBinding,
) {
  assertRecoverySource(source, expected, label, context, transactionBinding);
  if (lstatOrMissing(destination)) {
    throw artifactViolation(`${label} recovery destination is not empty`);
  }
  renameSync(source, destination);
  syncTransactionDirectories(context, transactionBinding);
}

function recoverInterruptedTransaction(context, transactionName) {
  const transactionId = transactionName.slice(TRANSACTION_PREFIX.length);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    transactionId,
  )) {
    throw artifactViolation('Hermes transaction directory name is invalid');
  }
  const transactionDir = join(context.aoDir, transactionName);
  const transactionBinding = bindSafeDirectoryPath(
    transactionDir,
    'Hermes artifact transaction',
    { trustedRoot: context.trustedRoot, requirePrivateMode: true },
  );
  const recoveryContext = {
    revalidate() {
      context.revalidate();
      revalidateDirectoryBinding(transactionBinding, 'Hermes artifact transaction');
    },
  };
  recoveryContext.revalidate();

  const knownNames = new Set([
    TRANSACTION_MANIFEST,
    'next-spec.md',
    'previous-spec.md',
    'next-prd.json',
    'previous-prd.json',
  ]);
  const entries = readdirSync(transactionDir);
  if (entries.length === 0) {
    // The manifest is the first file created in a transaction and every
    // destination rename happens only after it and both staged artifacts are
    // durable. Therefore a still-empty private transaction directory can only
    // be a pre-manifest crash remnant. Revalidate and re-read immediately before
    // rmdir so a concurrent writer either wins first or makes rmdir fail closed.
    recoveryContext.revalidate();
    if (readdirSync(transactionDir).length !== 0) {
      throw artifactViolation('Hermes pre-manifest transaction changed during recovery');
    }
    rmdirSync(transactionDir);
    fsyncDirectory(context.aoDir);
    return;
  }
  if (entries.some(name => !knownNames.has(name))) {
    throw artifactViolation('Hermes transaction contains an unknown artifact');
  }
  const manifestPath = join(transactionDir, TRANSACTION_MANIFEST);
  const manifestResult = readRegularArtifact(
    manifestPath,
    'Hermes transaction manifest',
    MAX_TRANSACTION_MANIFEST_BYTES,
    { generationPolicy: 'full', revalidateContext: recoveryContext.revalidate },
  );
  const manifest = parseTransactionManifest(manifestResult.text, transactionId);

  const items = [
    {
      label: 'Hermes spec artifact',
      maxBytes: MAX_HERMES_SPEC_BYTES,
      finalPath: context.specPath,
      stagedPath: join(transactionDir, 'next-spec.md'),
      backupPath: join(transactionDir, 'previous-spec.md'),
      initialDescriptor: manifest.artifacts.spec.initial,
      nextDescriptor: manifest.artifacts.spec.next,
    },
    {
      label: 'Hermes PRD artifact',
      maxBytes: MAX_HERMES_PRD_BYTES,
      finalPath: context.prdPath,
      stagedPath: join(transactionDir, 'next-prd.json'),
      backupPath: join(transactionDir, 'previous-prd.json'),
      initialDescriptor: manifest.artifacts.prd.initial,
      nextDescriptor: manifest.artifacts.prd.next,
    },
  ];

  for (const item of items) {
    item.final = inspectArtifactCandidate(
      item.finalPath,
      item.label,
      item.maxBytes,
      recoveryContext,
    );
    item.staged = inspectArtifactCandidate(
      item.stagedPath,
      `staged ${item.label}`,
      item.maxBytes,
      recoveryContext,
      { requirePrivateMode: true },
    );
    item.backup = inspectArtifactCandidate(
      item.backupPath,
      `backup ${item.label}`,
      item.maxBytes,
      recoveryContext,
    );
    item.finalClass = classifyRecoveryCandidate(
      item.final,
      item.initialDescriptor,
      item.nextDescriptor,
    );
    if (item.finalClass === 'unknown') {
      throw artifactViolation(`${item.label} does not match the recovery manifest`);
    }
    if (item.staged && !descriptorMatches(item.staged, item.nextDescriptor)) {
      throw artifactViolation(`staged ${item.label} does not match the recovery manifest`);
    }
    if (item.backup && (!item.initialDescriptor
      || !descriptorMatches(item.backup, item.initialDescriptor))) {
      throw artifactViolation(`backup ${item.label} does not match the recovery manifest`);
    }
    if (!item.initialDescriptor && item.backup) {
      throw artifactViolation(`backup ${item.label} exists without an initial generation`);
    }
    if (item.finalClass === 'initial' && item.backup) {
      throw artifactViolation(`${item.label} duplicates its initial recovery generation`);
    }
  }

  const committed = items.every(item => item.finalClass === 'next'
    || item.finalClass === 'same');
  if (!committed) {
    // Prove that both old generations can be restored before changing either
    // final path. Recovery remains idempotent if the process exits mid-rollback.
    for (const item of items) {
      if (item.initialDescriptor
        && item.finalClass !== 'initial'
        && item.finalClass !== 'same'
        && !item.backup) {
        throw artifactViolation(`${item.label} initial recovery generation is missing`);
      }
      if (!item.initialDescriptor
        && item.finalClass !== 'missing'
        && item.finalClass !== 'next') {
        throw artifactViolation(`${item.label} cannot restore an absent initial generation`);
      }
    }

    for (const item of items) {
      if (item.initialDescriptor) {
        if (item.finalClass === 'next') {
          unlinkRecoveryCandidate(
            item.finalPath,
            item.final,
            item.label,
            context,
            transactionBinding,
          );
        }
        if (item.finalClass === 'missing' || item.finalClass === 'next') {
          renameRecoveryCandidate(
            item.backupPath,
            item.finalPath,
            item.backup,
            `backup ${item.label}`,
            context,
            transactionBinding,
          );
        }
      } else if (item.finalClass === 'next') {
        unlinkRecoveryCandidate(
          item.finalPath,
          item.final,
          item.label,
          context,
          transactionBinding,
        );
      }
    }

    for (const item of items) {
      const restored = inspectArtifactCandidate(
        item.finalPath,
        item.label,
        item.maxBytes,
        recoveryContext,
      );
      if (item.initialDescriptor
        ? !descriptorMatches(restored, item.initialDescriptor)
        : restored !== null) {
        throw artifactViolation(`${item.label} recovery did not restore the initial generation`);
      }
    }
  }

  cleanupTransaction(context, transactionBinding, [
    manifestPath,
    ...items.flatMap(item => [item.stagedPath, item.backupPath]),
  ]);
}

function cleanupInterruptedTombstone(context, cleanupName) {
  const transactionId = cleanupName.slice(CLEANUP_PREFIX.length);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    transactionId,
  )) {
    throw artifactViolation('Hermes cleanup tombstone name is invalid');
  }
  const cleanupDir = join(context.aoDir, cleanupName);
  const cleanupBinding = bindSafeDirectoryPath(
    cleanupDir,
    'Hermes artifact cleanup tombstone',
    { trustedRoot: context.trustedRoot, requirePrivateMode: true },
  );
  const cleanupContext = {
    revalidate() {
      context.revalidate();
      revalidateDirectoryBinding(cleanupBinding, 'Hermes artifact cleanup tombstone');
    },
  };
  cleanupContext.revalidate();
  const entries = readdirSync(cleanupDir);
  if (entries.some(name => name !== TRANSACTION_MANIFEST)) {
    throw artifactViolation('Hermes cleanup tombstone contains an unknown artifact');
  }
  const manifestPath = join(cleanupDir, TRANSACTION_MANIFEST);
  if (entries.includes(TRANSACTION_MANIFEST)) {
    const manifestResult = readRegularArtifact(
      manifestPath,
      'Hermes cleanup tombstone manifest',
      MAX_TRANSACTION_MANIFEST_BYTES,
      { generationPolicy: 'full', revalidateContext: cleanupContext.revalidate },
    );
    parseTransactionManifest(manifestResult.text, transactionId);
    const current = lstatSync(manifestPath);
    if (!sameFileGeneration(current, manifestResult.stat, 'full')) {
      throw artifactViolation('Hermes cleanup tombstone manifest changed before removal');
    }
    unlinkSync(manifestPath);
    fsyncDirectory(cleanupDir);
  }
  rmdirSync(cleanupDir);
  fsyncDirectory(context.aoDir);
}

function recoverInterruptedTransactions(context) {
  context.revalidate();
  const entries = readdirSync(context.aoDir);
  context.revalidate();
  const cleanupTombstones = entries.filter(name => name.startsWith(CLEANUP_PREFIX));
  for (const cleanupName of cleanupTombstones) {
    cleanupInterruptedTombstone(context, cleanupName);
  }
  const transactions = entries.filter(name => name.startsWith(TRANSACTION_PREFIX));
  if (transactions.length > 1) {
    throw artifactViolation('multiple Hermes artifact transactions require manual inspection');
  }
  if (transactions.length === 1) {
    recoverInterruptedTransaction(context, transactions[0]);
  }
}

function commitArtifactPair(context, spec, prd, transactionHooks = {}) {
  context.revalidate();
  const specInitial = snapshotDestination(
    context.specPath,
    'existing Hermes spec artifact',
    MAX_HERMES_SPEC_BYTES,
  );
  const prdInitial = snapshotDestination(
    context.prdPath,
    'existing Hermes PRD artifact',
    MAX_HERMES_PRD_BYTES,
  );
  const specInitialInspection = specInitial
    ? inspectArtifactCandidate(
      context.specPath,
      'existing Hermes spec artifact',
      MAX_HERMES_SPEC_BYTES,
      context,
      { expectedStat: specInitial },
    )
    : null;
  const prdInitialInspection = prdInitial
    ? inspectArtifactCandidate(
      context.prdPath,
      'existing Hermes PRD artifact',
      MAX_HERMES_PRD_BYTES,
      context,
      { expectedStat: prdInitial },
    )
    : null;
  const transactionId = randomUUID();
  const transactionDir = join(context.aoDir, `${TRANSACTION_PREFIX}${transactionId}`);
  const transactionBinding = ensureSafeDirectoryPath(
    transactionDir,
    'Hermes artifact transaction',
    { trustedRoot: context.trustedRoot, requirePrivateMode: true, requirePrivateAnchor: false },
  );

  const specItem = {
    label: 'Hermes spec artifact',
    finalPath: context.specPath,
    stagedPath: join(transactionDir, 'next-spec.md'),
    backupPath: join(transactionDir, 'previous-spec.md'),
    initial: specInitial,
    transactionBinding,
    oldMoved: false,
    installed: false,
  };
  const prdItem = {
    label: 'Hermes PRD artifact',
    finalPath: context.prdPath,
    stagedPath: join(transactionDir, 'next-prd.json'),
    backupPath: join(transactionDir, 'previous-prd.json'),
    initial: prdInitial,
    transactionBinding,
    oldMoved: false,
    installed: false,
  };
  const manifestPath = join(transactionDir, TRANSACTION_MANIFEST);
  const cleanupPaths = [
    manifestPath,
    specItem.stagedPath,
    specItem.backupPath,
    prdItem.stagedPath,
    prdItem.backupPath,
  ];

  try {
    // The manifest is durable before the first final-path rename. A later
    // entry can therefore distinguish a completed new pair from any mixed
    // state and safely finish or roll back the transaction.
    fsyncDirectory(context.aoDir);
    const manifest = `${JSON.stringify({
      schemaVersion: TRANSACTION_SCHEMA_VERSION,
      transactionId,
      artifacts: {
        spec: {
          initial: descriptorFromInspection(specInitialInspection),
          next: contentDescriptor(spec),
        },
        prd: {
          initial: descriptorFromInspection(prdInitialInspection),
          next: contentDescriptor(prd),
        },
      },
    }, null, 2)}\n`;
    writeExclusiveRegularArtifact(
      manifestPath,
      'Hermes transaction manifest',
      manifest,
      MAX_TRANSACTION_MANIFEST_BYTES,
    );
    syncTransactionDirectories(context, transactionBinding);
    specItem.stagedStat = writeExclusiveRegularArtifact(
      specItem.stagedPath,
      'staged Hermes spec artifact',
      spec,
      MAX_HERMES_SPEC_BYTES,
    );
    prdItem.stagedStat = writeExclusiveRegularArtifact(
      prdItem.stagedPath,
      'staged Hermes PRD artifact',
      prd,
      MAX_HERMES_PRD_BYTES,
    );
    syncTransactionDirectories(context, transactionBinding);
    context.revalidate();
    revalidateDirectoryBinding(transactionBinding, 'Hermes artifact transaction');
    assertDestinationUnchanged(specItem.finalPath, specInitial, specItem.label);
    assertDestinationUnchanged(prdItem.finalPath, prdInitial, prdItem.label);

    moveExistingToBackup(specItem, context);
    moveExistingToBackup(prdItem, context);
    installStaged(specItem, context);

    if (transactionHooks.simulateCrashAfterSpecCommit === true) {
      const error = new Error('simulated crash after Hermes spec commit');
      error.code = SIMULATED_CRASH_CODE;
      throw error;
    }

    // Test-only fault injection lets regression tests remove the staged PRD and
    // exercise the real second rename failure. Production callers omit it.
    transactionHooks.beforePrdCommit?.(Object.freeze({
      stagedPrdPath: prdItem.stagedPath,
      prdPath: prdItem.finalPath,
    }));
    installStaged(prdItem, context);

    if (transactionHooks.simulateCrashAfterPrdCommit === true) {
      const error = new Error('simulated crash after Hermes PRD commit');
      error.code = SIMULATED_CRASH_CODE;
      throw error;
    }

    readAndValidateArtifactPair(context, { spec, prd });
  } catch (error) {
    if (error?.code === SIMULATED_CRASH_CODE) throw error;
    let rolledBack = false;
    try {
      rollbackItem(prdItem, context);
      rollbackItem(specItem, context);
      rolledBack = true;
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Hermes artifact transaction failed and could not restore the original pair',
      );
    } finally {
      if (rolledBack) cleanupTransaction(context, transactionBinding, cleanupPaths);
    }
    throw error;
  }

  cleanupTransaction(context, transactionBinding, cleanupPaths);
}

/**
 * Validate and persist one AO_SPEC_V1 envelope.
 *
 * `options.trustedRoot` may bind a project below a caller-owned root; every
 * directory between that root and `.ao` is then checked without following
 * symlinks. `options.transactionHooks` is reserved for regression fault tests.
 */
export function writeHermesSpecArtifacts(rawOutput, options = {}) {
  const envelope = parseHermesSpecEnvelope(rawOutput);
  const context = resolveArtifactContext(options, {
    createAo: envelope.verdict !== 'PASS',
  });
  return withExecutionPrdMutationLock({
    ...options,
    cwd: context.cwd,
    trustedRoot: context.trustedRoot,
  }, () => {
    context.revalidate();
    if (envelope.verdict === 'PASS') {
      recoverInterruptedTransactions(context);
      const existing = readAndValidateArtifactPair(context);
      return {
        written: false,
        validated: true,
        verdict: envelope.verdict,
        summary: envelope.summary,
        specPath: context.specPath,
        prdPath: context.prdPath,
        storyCount: existing.prd.userStories.length,
      };
    }

    recoverInterruptedTransactions(context);
    const spec = `${envelope.specMarkdown.trim()}\n`;
    const prd = `${JSON.stringify(envelope.prd, null, 2)}\n`;
    if (byteLength(spec) > MAX_HERMES_SPEC_BYTES || byteLength(prd) > MAX_HERMES_PRD_BYTES) {
      throw new Error('serialized Hermes artifacts exceed their byte limits');
    }
    commitArtifactPair(context, spec, prd, options.transactionHooks);

    return {
      written: true,
      validated: true,
      verdict: envelope.verdict,
      summary: envelope.summary,
      specPath: context.specPath,
      prdPath: context.prdPath,
      storyCount: envelope.prd.userStories.length,
    };
  });
}
