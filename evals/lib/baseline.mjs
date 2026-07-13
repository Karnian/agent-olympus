import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { atomicWriteFile } from '../../scripts/lib/fs-atomic.mjs';

const ROOT_KEYS = new Set(['schemaVersion', 'track', 'k', 'tasks']);
const TASK_KEYS = new Set([
  'k',
  'passHatK',
  'source',
  'runId',
  'measuredAt',
  'modelTier',
  'orchestrator',
  'benchmarkFingerprint',
  'pipelineProtocolFingerprint',
]);

function exactKeys(value, expected) {
  return Object.keys(value).every((key) => expected.has(key))
    && Object.keys(value).length === expected.size;
}

/** Validate the committed regression baseline format. */
export function validateBaseline(baseline) {
  const errors = [];
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    return ['baseline must be an object'];
  }
  if (!exactKeys(baseline, ROOT_KEYS)) errors.push('baseline must contain exactly schemaVersion, track, k, tasks');
  if (baseline.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (baseline.track !== 'regression') errors.push('track must be regression');
  if (!Number.isInteger(baseline.k) || baseline.k < 1) errors.push('k must be a positive integer');
  if (!baseline.tasks || typeof baseline.tasks !== 'object' || Array.isArray(baseline.tasks)) {
    errors.push('tasks must be an object');
    return errors;
  }
  if (Object.keys(baseline.tasks).length === 0) errors.push('tasks must not be empty');

  for (const [taskId, entry] of Object.entries(baseline.tasks)) {
    if (!taskId.trim()) errors.push('task ids must be non-empty');
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${taskId} must be an object`);
      continue;
    }
    if (!exactKeys(entry, TASK_KEYS)) errors.push(`${taskId} must contain the complete baseline task contract`);
    if (!Number.isInteger(entry.k) || entry.k < 1) errors.push(`${taskId}.k must be a positive integer`);
    if (entry.passHatK !== true) errors.push(`${taskId}.passHatK must be true for a last-known-good baseline`);
    if (Number.isInteger(baseline.k) && entry.k !== baseline.k) errors.push(`${taskId}.k must equal baseline k`);
    if (!['declared-target', 'live'].includes(entry.source)) errors.push(`${taskId}.source must be declared-target or live`);
    if (!['atlas', 'athena', 'solo'].includes(entry.orchestrator)) {
      errors.push(`${taskId}.orchestrator must be atlas, athena, or solo`);
    }
    for (const field of ['benchmarkFingerprint', 'pipelineProtocolFingerprint']) {
      if (typeof entry[field] !== 'string' || !/^[a-f0-9]{64}$/.test(entry[field])) {
        errors.push(`${taskId}.${field} must be a sha256 hex string`);
      }
    }
    if (entry.source === 'declared-target') {
      if (entry.runId !== null || entry.measuredAt !== null || entry.modelTier !== null) {
        errors.push(`${taskId} declared-target provenance must be null`);
      }
    } else {
      for (const field of ['runId', 'measuredAt', 'modelTier']) {
        if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
          errors.push(`${taskId}.${field} must be a non-empty string for a live baseline`);
        }
      }
    }
  }
  return errors;
}

export function readBaseline(baselinePath, { required = false } = {}) {
  if (!existsSync(baselinePath)) {
    if (required) throw new Error(`Missing baseline: ${baselinePath}`);
    return null;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
  const errors = validateBaseline(baseline);
  if (errors.length > 0) throw new Error(`Invalid baseline.json: ${errors.join('; ')}`);
  return baseline;
}

export function baselineValueForTask(baseline, taskId) {
  const value = baseline?.tasks?.[taskId]?.passHatK;
  return typeof value === 'boolean' ? (value ? 1 : 0) : null;
}

export async function updateBaselineTask(baselinePath, {
  taskId,
  k,
  passHatK,
  runId,
  measuredAt,
  modelTier,
  orchestrator,
  benchmarkFingerprint,
  pipelineProtocolFingerprint,
}) {
  if (passHatK !== true) {
    throw new Error('Refusing to replace the last-known-good baseline with a failing result');
  }
  const lockPath = `${baselinePath}.lock`;
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`Baseline refresh already in progress (or stale lock): ${lockPath}`);
    }
    throw error;
  }
  try {
    const baseline = readBaseline(baselinePath, { required: true });
    if (k !== baseline.k) {
      throw new Error(`Cannot update baseline at k=${k}; committed baseline uses k=${baseline.k}`);
    }
    if (!Object.hasOwn(baseline.tasks, taskId)) {
      throw new Error(`Cannot add unknown regression task via refresh: ${taskId}`);
    }
    for (const [field, value] of Object.entries({
      runId,
      measuredAt,
      modelTier,
      orchestrator,
      benchmarkFingerprint,
      pipelineProtocolFingerprint,
    })) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`Live baseline refresh requires ${field}`);
      }
    }
    for (const field of ['benchmarkFingerprint', 'pipelineProtocolFingerprint']) {
      const value = field === 'benchmarkFingerprint'
        ? benchmarkFingerprint
        : pipelineProtocolFingerprint;
      if (!/^[a-f0-9]{64}$/.test(value)) {
        throw new Error(`Live baseline refresh requires a sha256 ${field}`);
      }
    }
    const updated = {
      ...baseline,
      tasks: {
        ...baseline.tasks,
        [taskId]: {
          k,
          passHatK: true,
          source: 'live',
          runId,
          measuredAt,
          modelTier,
          orchestrator,
          benchmarkFingerprint,
          pipelineProtocolFingerprint,
        },
      },
    };
    await atomicWriteFile(baselinePath, `${JSON.stringify(updated, null, 2)}\n`);
    return updated;
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}
