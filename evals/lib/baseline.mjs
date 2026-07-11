import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteFile } from '../../scripts/lib/fs-atomic.mjs';

const ROOT_KEYS = new Set(['schemaVersion', 'track', 'k', 'tasks']);
const TASK_KEYS = new Set(['k', 'passHatK']);

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
    if (!exactKeys(entry, TASK_KEYS)) errors.push(`${taskId} must contain exactly k and passHatK`);
    if (!Number.isInteger(entry.k) || entry.k < 1) errors.push(`${taskId}.k must be a positive integer`);
    if (entry.passHatK !== true) errors.push(`${taskId}.passHatK must be true for a last-known-good baseline`);
    if (Number.isInteger(baseline.k) && entry.k !== baseline.k) errors.push(`${taskId}.k must equal baseline k`);
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

export async function updateBaselineTask(baselinePath, { taskId, k, passHatK }) {
  if (passHatK !== true) {
    throw new Error('Refusing to replace the last-known-good baseline with a failing result');
  }
  const baseline = readBaseline(baselinePath, { required: true });
  if (k !== baseline.k) {
    throw new Error(`Cannot update baseline at k=${k}; committed baseline uses k=${baseline.k}`);
  }
  if (!Object.hasOwn(baseline.tasks, taskId)) {
    throw new Error(`Cannot add unknown regression task via refresh: ${taskId}`);
  }
  const updated = {
    ...baseline,
    tasks: {
      ...baseline.tasks,
      [taskId]: { k, passHatK: true },
    },
  };
  await atomicWriteFile(baselinePath, `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
}
