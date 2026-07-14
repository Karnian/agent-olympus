/**
 * Hardened authoritative store for `.ao/prd.json` after AO_SPEC creation.
 *
 * The planning artifact is immutable except for explicitly allowlisted
 * execution-assignment fields. Every mutation is serialized by a
 * crash-reclaimable owner lock and guarded by a content-generation CAS.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join, resolve } from 'node:path';
import { assertExecutionPrd } from './execution-prd.mjs';
import {
  HARDENED_FS_VIOLATION_CODE,
  bindSafeDirectoryPath,
  readRegularArtifact,
  revalidateDirectoryBinding,
  revalidateRegularArtifact,
  sameFileGeneration,
  writeExclusiveRegularArtifact,
} from './hardened-fs.mjs';
import { MAX_HERMES_PRD_BYTES, validateHermesPrd } from './spec-artifact.mjs';
import {
  EXECUTION_PRD_CONFLICT_CODE,
  EXECUTION_PRD_LOCK_RELATIVE_PATH,
  withExecutionPrdMutationLock,
} from './execution-prd-lock.mjs';

export { EXECUTION_PRD_CONFLICT_CODE, EXECUTION_PRD_LOCK_RELATIVE_PATH };
export const EXECUTION_PRD_INVALID_CODE = 'AO_EXECUTION_PRD_INVALID';

const PRD_LABEL = 'execution PRD';
const GENERATION = /^[a-f0-9]{64}$/;
const ORCHESTRATORS = new Set(['atlas', 'athena']);
const COMMON_EXECUTION_FIELDS = Object.freeze([
  'parallelGroup',
  'scope',
  'dependsOn',
  'requiresTDD',
]);
const ORCHESTRATOR_EXECUTION_FIELDS = Object.freeze({
  atlas: ['assignTo', 'model', 'agentType'],
  athena: ['assignedWorker', 'workerType', 'model', 'agentType'],
});

function storeError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function invalid(message, cause) {
  return storeError(EXECUTION_PRD_INVALID_CODE, message, cause);
}

function conflict(message) {
  return storeError(EXECUTION_PRD_CONFLICT_CODE, message);
}

function hardenedViolation(message) {
  return storeError(HARDENED_FS_VIOLATION_CODE, message);
}

function assertOrchestrator(orchestrator) {
  if (!ORCHESTRATORS.has(orchestrator)) {
    throw invalid('orchestrator must be atlas or athena');
  }
  return orchestrator;
}

function assertAoDirectoryMode(binding) {
  if (process.platform === 'win32') return;
  const leaf = binding.chain[binding.chain.length - 1]?.stat;
  if (!leaf || (leaf.mode & 0o022) !== 0) {
    throw hardenedViolation('execution PRD .ao directory is group/world-writable');
  }
}

function bindStoreContext(options = {}) {
  const cwd = resolve(options.cwd || process.cwd());
  const trustedRoot = resolve(options.trustedRoot || cwd);
  const aoPath = join(cwd, '.ao');
  const aoBinding = bindSafeDirectoryPath(aoPath, 'execution PRD .ao directory', {
    trustedRoot,
    requirePrivateMode: false,
  });
  assertAoDirectoryMode(aoBinding);

  const context = {
    cwd,
    trustedRoot,
    aoPath,
    prdPath: join(aoPath, 'prd.json'),
    aoBinding,
    revalidate() {
      revalidateDirectoryBinding(aoBinding, 'execution PRD .ao directory');
      assertAoDirectoryMode(aoBinding);
    },
  };
  context.revalidate();
  return context;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw invalid(`${label} is not valid JSON`, cause);
  }
}

function normalizeJsonPrd(prd) {
  let serialized;
  try {
    serialized = JSON.stringify(prd, null, 2);
  } catch (cause) {
    throw invalid('execution PRD must be JSON serializable', cause);
  }
  if (typeof serialized !== 'string') {
    throw invalid('execution PRD must be a JSON object');
  }
  serialized += '\n';
  if (Buffer.byteLength(serialized, 'utf8') > MAX_HERMES_PRD_BYTES) {
    throw invalid(`execution PRD exceeds the ${MAX_HERMES_PRD_BYTES}-byte limit`);
  }
  return { prd: parseJson(serialized, PRD_LABEL), serialized };
}

function validatePlanningPrd(prd) {
  const result = validateHermesPrd(prd);
  if (!result.ok) {
    throw invalid(`invalid planning PRD: ${result.errors.join('; ')}`);
  }
  return prd;
}

function validatePersistedExecutionPrd(prd, orchestrator, allowCompleted = true) {
  try {
    assertExecutionPrd(prd, { orchestrator, allowCompleted });
    const storyById = new Map(prd.userStories.map(story => [story.id, story]));
    for (const story of prd.userStories) {
      if (story.passes !== true) continue;
      const incomplete = (story.dependsOn || []).filter(
        dependencyId => storyById.get(dependencyId)?.passes !== true,
      );
      if (incomplete.length > 0) {
        throw new Error(
          `${story.id} cannot pass before dependencies: ${incomplete.join(', ')}`,
        );
      }
    }
    return prd;
  } catch (cause) {
    throw invalid(cause.message, cause);
  }
}

export function computeExecutionPrdGeneration(prd) {
  let compact;
  try {
    compact = JSON.stringify(prd);
  } catch (cause) {
    throw invalid('execution PRD generation requires JSON-serializable input', cause);
  }
  if (typeof compact !== 'string') {
    throw invalid('execution PRD generation requires a JSON value');
  }
  return createHash('sha256').update(compact, 'utf8').digest('hex');
}

function readPrdRecord(context, validator) {
  const artifact = readRegularArtifact(context.prdPath, PRD_LABEL, MAX_HERMES_PRD_BYTES, {
    generationPolicy: 'full',
    revalidateContext: () => context.revalidate(),
  });
  const prd = parseJson(artifact.text, PRD_LABEL);
  validator(prd);
  return {
    prd,
    generation: computeExecutionPrdGeneration(prd),
    stat: artifact.stat,
  };
}

function publicRecord(record, changed = false) {
  return { prd: record.prd, generation: record.generation, changed };
}

function assertExpectedGeneration(expectedGeneration) {
  if (typeof expectedGeneration !== 'string' || !GENERATION.test(expectedGeneration)) {
    throw invalid('expectedGeneration must be a 64-character SHA-256 generation');
  }
}

function assertCurrentGeneration(record, expectedGeneration) {
  assertExpectedGeneration(expectedGeneration);
  if (record.generation !== expectedGeneration) {
    throw conflict(
      `execution PRD generation changed: expected ${expectedGeneration}, found ${record.generation}`,
    );
  }
}

function strippedPlanningShape(prd, orchestrator) {
  const clone = structuredClone(prd);
  const removable = [
    ...COMMON_EXECUTION_FIELDS,
    ...ORCHESTRATOR_EXECUTION_FIELDS[orchestrator],
  ];
  for (const story of clone.userStories || []) {
    if (!story || typeof story !== 'object' || Array.isArray(story)) continue;
    for (const field of removable) delete story[field];
  }
  return clone;
}

function assertAssignmentOnlyEnrichment(source, candidate, orchestrator) {
  if (!isDeepStrictEqual(
    strippedPlanningShape(source, orchestrator),
    strippedPlanningShape(candidate, orchestrator),
  )) {
    throw invalid(
      'execution enrichment may only add or replace allowlisted assignment fields on existing stories',
    );
  }
}

function cleanupTemp(tempPath, expectedStat) {
  if (!expectedStat) return;
  try {
    const current = lstatSync(tempPath);
    if (sameFileGeneration(current, expectedStat, 'full')) unlinkSync(tempPath);
  } catch {}
}

function fsyncDirectory(path) {
  if (process.platform === 'win32') return;
  let fd;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function commitPrd(context, current, nextPrd, validator, options = {}) {
  const normalized = normalizeJsonPrd(nextPrd);
  validator(normalized.prd);
  const expectedGeneration = computeExecutionPrdGeneration(normalized.prd);
  const tempPath = join(context.aoPath, `.execution-prd-${randomUUID()}.tmp`);
  let tempStat = null;
  try {
    context.revalidate();
    revalidateRegularArtifact(context.prdPath, current.stat, PRD_LABEL, MAX_HERMES_PRD_BYTES, {
      generationPolicy: 'full',
    });
    options._inject?.beforeCommit?.();
    tempStat = writeExclusiveRegularArtifact(
      tempPath,
      'execution PRD temporary artifact',
      normalized.serialized,
      MAX_HERMES_PRD_BYTES,
    );
    context.revalidate();
    revalidateRegularArtifact(context.prdPath, current.stat, PRD_LABEL, MAX_HERMES_PRD_BYTES, {
      generationPolicy: 'full',
    });
    revalidateRegularArtifact(
      tempPath,
      tempStat,
      'execution PRD temporary artifact',
      MAX_HERMES_PRD_BYTES,
      { generationPolicy: 'full' },
    );
    context.revalidate();
    renameSync(tempPath, context.prdPath);
    tempStat = null;
    fsyncDirectory(context.aoPath);
    options._inject?.afterAtomicWrite?.();
  } finally {
    cleanupTemp(tempPath, tempStat);
  }

  const persisted = readPrdRecord(context, validator);
  if (persisted.generation !== expectedGeneration) {
    throw hardenedViolation('execution PRD changed immediately after atomic replacement');
  }
  return persisted;
}

/** Hardened read of the immutable AO_SPEC planning PRD before enrichment. */
export function readPlanningPrdForExecution(options = {}) {
  const context = bindStoreContext(options);
  return publicRecord(readPrdRecord(context, validatePlanningPrd));
}

/** Hardened read of the authoritative enriched/resumable execution PRD. */
export function readExecutionPrd(options = {}) {
  const orchestrator = assertOrchestrator(options.orchestrator);
  const context = bindStoreContext(options);
  return publicRecord(readPrdRecord(
    context,
    prd => validatePersistedExecutionPrd(prd, orchestrator, true),
  ));
}

/**
 * CAS-replace the planning PRD with assignment-only execution enrichment.
 * All non-assignment AO_SPEC content, story order, and passes=false values are
 * preserved byte-semantically as JSON values.
 */
export function enrichExecutionPrd(candidatePrd, options = {}) {
  const orchestrator = assertOrchestrator(options.orchestrator);
  const context = bindStoreContext(options);
  return withExecutionPrdMutationLock(options, () => {
    const current = readPrdRecord(context, validatePlanningPrd);
    assertCurrentGeneration(current, options.expectedGeneration);
    const normalized = normalizeJsonPrd(candidatePrd);
    assertAssignmentOnlyEnrichment(current.prd, normalized.prd, orchestrator);
    validatePersistedExecutionPrd(normalized.prd, orchestrator, false);
    const nextGeneration = computeExecutionPrdGeneration(normalized.prd);
    if (nextGeneration === current.generation) {
      return publicRecord(current, false);
    }
    const persisted = commitPrd(
      context,
      current,
      normalized.prd,
      prd => validatePersistedExecutionPrd(prd, orchestrator, false),
      options,
    );
    return publicRecord(persisted, true);
  });
}

/** CAS transition (or rollback) for one or more persisted story pass flags. */
export function setExecutionStoryPasses(storyIds, passes, options = {}) {
  const orchestrator = assertOrchestrator(options.orchestrator);
  if (!Array.isArray(storyIds)
    || storyIds.length === 0
    || storyIds.some(id => typeof id !== 'string' || id.length === 0)
    || new Set(storyIds).size !== storyIds.length) {
    throw invalid('storyIds must be a non-empty array of unique story IDs');
  }
  if (typeof passes !== 'boolean') throw invalid('passes must be boolean');

  const context = bindStoreContext(options);
  return withExecutionPrdMutationLock(options, () => {
    const validator = prd => validatePersistedExecutionPrd(prd, orchestrator, true);
    const current = readPrdRecord(context, validator);
    assertCurrentGeneration(current, options.expectedGeneration);
    const requestedIds = new Set(storyIds);
    const knownIds = new Set(current.prd.userStories.map(story => story.id));
    const missing = storyIds.filter(id => !knownIds.has(id));
    if (missing.length > 0) {
      throw invalid(`unknown execution story IDs: ${missing.join(', ')}`);
    }

    const nextPrd = structuredClone(current.prd);
    if (!passes) {
      const rollbackIds = new Set(requestedIds);
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const story of nextPrd.userStories) {
          if (rollbackIds.has(story.id)
            || !(story.dependsOn || []).some(id => rollbackIds.has(id))) continue;
          rollbackIds.add(story.id);
          expanded = true;
        }
      }
      for (const id of rollbackIds) requestedIds.add(id);
    }
    for (const story of nextPrd.userStories) {
      if (requestedIds.has(story.id)) story.passes = passes;
    }
    const nextGeneration = computeExecutionPrdGeneration(nextPrd);
    if (nextGeneration === current.generation) {
      return publicRecord(current, false);
    }
    const persisted = commitPrd(context, current, nextPrd, validator, options);
    return publicRecord(persisted, true);
  });
}
