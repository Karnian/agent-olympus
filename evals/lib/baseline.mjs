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
  'claudeCliVersion',
  'pluginFingerprint',
  'targetPromptFingerprint',
  'observedModels',
  'maxBudgetUsd',
  'providerRuntime',
]);
const PROVIDER_RUNTIME_KEYS = new Set([
  'effort',
  'efforts',
  'fastModeStates',
  'usageSpeeds',
  'serviceTiers',
]);

function exactKeys(value, expected) {
  return Object.keys(value).every((key) => expected.has(key))
    && Object.keys(value).length === expected.size;
}

function validObservedModels(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return false;
  if (value.some((model) => (
    typeof model !== 'string'
    || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(model)
  ))) return false;
  return new Set(value).size === value.length
    && value.every((model, index) => index === 0 || value[index - 1].localeCompare(model) < 0);
}

function validRuntimeValues(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= 16
    && value.every((entry, index) => (
      typeof entry === 'string'
      && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/.test(entry)
      && (index === 0 || value[index - 1].localeCompare(entry) < 0)
    ));
}

function validProviderRuntime(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && exactKeys(value, PROVIDER_RUNTIME_KEYS)
    && typeof value.effort === 'string'
    && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/.test(value.effort)
    && validRuntimeValues(value.efforts)
    && value.efforts.length === 1
    && value.efforts[0] === value.effort
    && validRuntimeValues(value.fastModeStates)
    && validRuntimeValues(value.usageSpeeds)
    && validRuntimeValues(value.serviceTiers);
}

/** Validate the committed regression baseline format. */
export function validateBaseline(baseline) {
  const errors = [];
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    return ['baseline must be an object'];
  }
  if (!exactKeys(baseline, ROOT_KEYS)) errors.push('baseline must contain exactly schemaVersion, track, k, tasks');
  if (baseline.schemaVersion !== 2) errors.push('schemaVersion must be 2');
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
      if (entry.runId !== null
        || entry.measuredAt !== null
        || entry.modelTier !== null
        || entry.claudeCliVersion !== null
        || entry.pluginFingerprint !== null
        || entry.targetPromptFingerprint !== null
        || entry.observedModels !== null
        || entry.maxBudgetUsd !== null
        || entry.providerRuntime !== null) {
        errors.push(`${taskId} declared-target provenance must be null`);
      }
    } else {
      for (const field of ['runId', 'measuredAt', 'modelTier', 'claudeCliVersion']) {
        if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
          errors.push(`${taskId}.${field} must be a non-empty string for a live baseline`);
        }
      }
      if (!/^\d+\.\d+(?:\.\d+)?$/.test(entry.claudeCliVersion ?? '')) {
        errors.push(`${taskId}.claudeCliVersion must be a semantic version for a live baseline`);
      }
      if (!validObservedModels(entry.observedModels)) {
        errors.push(`${taskId}.observedModels must be a unique, sorted, non-empty safe model list for a live baseline`);
      }
      if (!Number.isFinite(entry.maxBudgetUsd)
        || entry.maxBudgetUsd <= 0
        || entry.maxBudgetUsd > 100) {
        errors.push(`${taskId}.maxBudgetUsd must be greater than 0 and at most 100 for a live baseline`);
      }
      if (!validProviderRuntime(entry.providerRuntime)) {
        errors.push(`${taskId}.providerRuntime must contain complete, unique, sorted live runtime provenance`);
      }
      if (entry.orchestrator === 'solo') {
        if (entry.pluginFingerprint !== null || entry.targetPromptFingerprint !== null) {
          errors.push(`${taskId} solo live provenance must not claim plugin fingerprints`);
        }
      } else {
        for (const field of ['pluginFingerprint', 'targetPromptFingerprint']) {
          if (typeof entry[field] !== 'string' || !/^[a-f0-9]{64}$/.test(entry[field])) {
            errors.push(`${taskId}.${field} must be a sha256 hex string for a live plugin baseline`);
          }
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
  claudeCliVersion,
  pluginFingerprint,
  targetPromptFingerprint,
  observedModels,
  maxBudgetUsd,
  providerRuntime,
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
      claudeCliVersion,
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
    if (!/^\d+\.\d+(?:\.\d+)?$/.test(claudeCliVersion)) {
      throw new Error('Live baseline refresh requires a semantic claudeCliVersion');
    }
    if (!validObservedModels([...new Set(Array.isArray(observedModels) ? observedModels : [])].sort())) {
      throw new Error('Live baseline refresh requires non-empty safe observedModels');
    }
    if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0 || maxBudgetUsd > 100) {
      throw new Error('Live baseline refresh requires maxBudgetUsd greater than 0 and at most 100');
    }
    if (!validProviderRuntime(providerRuntime)) {
      throw new Error('Live baseline refresh requires complete providerRuntime provenance');
    }
    if (orchestrator === 'solo') {
      if (pluginFingerprint !== null || targetPromptFingerprint !== null) {
        throw new Error('Solo baseline refresh must not claim plugin fingerprints');
      }
    } else {
      for (const [field, value] of Object.entries({ pluginFingerprint, targetPromptFingerprint })) {
        if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
          throw new Error(`Live baseline refresh requires a sha256 ${field}`);
        }
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
          claudeCliVersion,
          pluginFingerprint,
          targetPromptFingerprint,
          observedModels: [...new Set(observedModels)].sort(),
          maxBudgetUsd,
          providerRuntime: {
            effort: providerRuntime.effort,
            efforts: [...providerRuntime.efforts],
            fastModeStates: [...providerRuntime.fastModeStates],
            usageSpeeds: [...providerRuntime.usageSpeeds],
            serviceTiers: [...providerRuntime.serviceTiers],
          },
        },
      },
    };
    await atomicWriteFile(baselinePath, `${JSON.stringify(updated, null, 2)}\n`);
    return updated;
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}
