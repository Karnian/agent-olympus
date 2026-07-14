import { assertExecutionPrd } from './execution-prd.mjs';

export const CONSENSUS_ASSIGNMENT_PLAN_CONTRACT = 'AO_CONSENSUS_ASSIGNMENT_PLAN_V1';
export const CONSENSUS_ASSIGNMENT_PLAN_SCHEMA_VERSION = 1;

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_SUMMARY_BYTES = 4 * 1024;
const MAX_ASSIGNMENTS = 256;
const GENERATION = /^[a-f0-9]{64}$/;
const ORCHESTRATORS = new Set(['atlas', 'athena']);
const PROVIDERS = new Set(['claude', 'codex', 'gemini']);
const MODELS = new Set(['opus', 'sonnet', 'haiku']);
const CLAUDE_AGENT_TYPES = new Set([
  'executor',
  'designer',
  'test-engineer',
  'debugger',
  'hephaestus',
  'writer',
]);
const ENVELOPE_KEYS = new Set([
  'schemaVersion',
  'contract',
  'verdict',
  'approvalBasis',
  'orchestrator',
  'sourcePrdGeneration',
  'revisionCycles',
  'summary',
  'assignments',
]);
const COMMON_ASSIGNMENT_KEYS = [
  'storyId',
  'parallelGroup',
  'scope',
  'dependsOn',
  'requiresTDD',
];
const ASSIGNMENT_KEYS = Object.freeze({
  atlas: new Set([...COMMON_ASSIGNMENT_KEYS, 'assignTo', 'model', 'agentType']),
  athena: new Set([
    ...COMMON_ASSIGNMENT_KEYS,
    'assignedWorker',
    'workerType',
    'model',
    'agentType',
  ]),
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertExactKeys(value, allowed, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unknown fields: ${unknown.join(', ')}`);
  }
}

function assertStringArray(value, label, { required = false } = {}) {
  if (value === undefined && !required) return;
  if (!Array.isArray(value)
    || (required && value.length === 0)
    || value.some(item => !nonEmpty(item))) {
    throw new Error(`${label} must be ${required ? 'a non-empty' : 'an'} array of non-empty strings`);
  }
}

function assertCommonAssignment(assignment, index) {
  const label = `assignments[${index}]`;
  if (!nonEmpty(assignment.storyId)) throw new Error(`${label}.storyId is required`);
  if (!nonEmpty(assignment.parallelGroup)) throw new Error(`${label}.parallelGroup is required`);
  assertStringArray(assignment.scope, `${label}.scope`, { required: true });
  assertStringArray(assignment.dependsOn, `${label}.dependsOn`);
  if (assignment.requiresTDD !== undefined && typeof assignment.requiresTDD !== 'boolean') {
    throw new Error(`${label}.requiresTDD must be boolean when present`);
  }
}

function assertProviderFields(assignment, index, orchestrator) {
  const label = `assignments[${index}]`;
  const provider = orchestrator === 'atlas' ? assignment.assignTo : assignment.workerType;
  if (!PROVIDERS.has(provider)) {
    throw new Error(`${label}.${orchestrator === 'atlas' ? 'assignTo' : 'workerType'} must be claude, codex, or gemini`);
  }

  if (orchestrator === 'atlas') {
    if (!MODELS.has(assignment.model)) {
      throw new Error(`${label}.model must be opus, sonnet, or haiku`);
    }
  } else {
    if (!nonEmpty(assignment.assignedWorker)) {
      throw new Error(`${label}.assignedWorker is required`);
    }
    if (assignment.model !== undefined && !MODELS.has(assignment.model)) {
      throw new Error(`${label}.model must be opus, sonnet, or haiku when present`);
    }
  }

  if (provider === 'claude') {
    if (!CLAUDE_AGENT_TYPES.has(assignment.agentType)) {
      throw new Error(`${label}.agentType must name an allowlisted Claude execution role`);
    }
  } else {
    if (assignment.agentType !== undefined) {
      throw new Error(`${label}.agentType must be omitted for external workers`);
    }
    if (orchestrator === 'athena' && assignment.model !== undefined) {
      throw new Error(`${label}.model must be omitted for Athena external workers`);
    }
  }
}

function validateEnvelope(envelope, { orchestrator } = {}) {
  assertExactKeys(envelope, ENVELOPE_KEYS, 'consensus assignment plan');
  if (envelope.schemaVersion !== CONSENSUS_ASSIGNMENT_PLAN_SCHEMA_VERSION) {
    throw new Error(`consensus assignment plan schemaVersion must be ${CONSENSUS_ASSIGNMENT_PLAN_SCHEMA_VERSION}`);
  }
  if (envelope.contract !== CONSENSUS_ASSIGNMENT_PLAN_CONTRACT) {
    throw new Error(`consensus assignment plan contract must be ${CONSENSUS_ASSIGNMENT_PLAN_CONTRACT}`);
  }
  if (envelope.verdict !== 'APPROVE') {
    throw new Error('consensus assignment plan verdict must be APPROVE');
  }
  if (!['reviewers', 'user-override'].includes(envelope.approvalBasis)) {
    throw new Error('consensus assignment plan approvalBasis must be reviewers or user-override');
  }
  if (!ORCHESTRATORS.has(envelope.orchestrator)) {
    throw new Error('consensus assignment plan orchestrator must be atlas or athena');
  }
  if (orchestrator !== undefined && envelope.orchestrator !== orchestrator) {
    throw new Error(`consensus assignment plan orchestrator must be ${orchestrator}`);
  }
  if (!GENERATION.test(envelope.sourcePrdGeneration || '')) {
    throw new Error('consensus assignment plan sourcePrdGeneration must be a SHA-256 generation');
  }
  if (!Number.isInteger(envelope.revisionCycles)
    || envelope.revisionCycles < 0
    || envelope.revisionCycles > 2) {
    throw new Error('consensus assignment plan revisionCycles must be an integer from 0 through 2');
  }
  if (!nonEmpty(envelope.summary)
    || Buffer.byteLength(envelope.summary, 'utf8') > MAX_SUMMARY_BYTES) {
    throw new Error('consensus assignment plan summary must be bounded and non-empty');
  }
  if (!Array.isArray(envelope.assignments)
    || envelope.assignments.length === 0
    || envelope.assignments.length > MAX_ASSIGNMENTS) {
    throw new Error(`consensus assignment plan assignments must contain 1-${MAX_ASSIGNMENTS} items`);
  }

  const storyIds = new Set();
  envelope.assignments.forEach((assignment, index) => {
    assertExactKeys(
      assignment,
      ASSIGNMENT_KEYS[envelope.orchestrator],
      `assignments[${index}]`,
    );
    assertCommonAssignment(assignment, index);
    assertProviderFields(assignment, index, envelope.orchestrator);
    if (storyIds.has(assignment.storyId)) {
      throw new Error(`assignments[${index}].storyId must be unique`);
    }
    storyIds.add(assignment.storyId);
  });

  return envelope;
}

/** Parse one strict assignment-only consensus result. */
export function parseConsensusAssignmentPlan(rawOutput, options = {}) {
  if (!nonEmpty(rawOutput)) {
    throw new Error('consensus assignment plan output must be a non-empty JSON string');
  }
  if (Buffer.byteLength(rawOutput, 'utf8') > MAX_OUTPUT_BYTES) {
    throw new Error(`consensus assignment plan output exceeds ${MAX_OUTPUT_BYTES} bytes`);
  }
  let envelope;
  try {
    envelope = JSON.parse(rawOutput.trim());
  } catch {
    throw new Error('consensus assignment plan output must be exactly one JSON object');
  }
  return validateEnvelope(envelope, options);
}

/**
 * Merge only validated assignment fields onto the immutable AO_SPEC planning
 * stories, then reuse the canonical execution validator before persistence.
 */
export function buildConsensusExecutionPrd(planningPrd, assignmentPlan, options = {}) {
  const orchestrator = options.orchestrator;
  validateEnvelope(assignmentPlan, { orchestrator });
  if (!isPlainObject(planningPrd) || !Array.isArray(planningPrd.userStories)) {
    throw new Error('planningPrd must contain userStories');
  }
  if (assignmentPlan.sourcePrdGeneration !== options.sourcePrdGeneration) {
    throw new Error('consensus assignment plan source generation does not match the planning PRD');
  }
  if (planningPrd.userStories.length !== assignmentPlan.assignments.length) {
    throw new Error('consensus assignment plan must assign every planning story exactly once');
  }

  const candidate = structuredClone(planningPrd);
  for (let index = 0; index < candidate.userStories.length; index += 1) {
    const story = candidate.userStories[index];
    const assignment = assignmentPlan.assignments[index];
    if (!isPlainObject(story) || story.id !== assignment.storyId) {
      throw new Error('consensus assignment plan story order must exactly match the planning PRD');
    }
    const provider = orchestrator === 'atlas' ? assignment.assignTo : assignment.workerType;
    if (provider === 'codex' && options.hasCodex !== true) {
      throw new Error(`consensus assignment plan assigns unavailable Codex story ${story.id}`);
    }
    if (provider === 'gemini' && options.hasGemini !== true) {
      throw new Error(`consensus assignment plan assigns unavailable Gemini story ${story.id}`);
    }
    const { storyId, ...assignmentFields } = assignment;
    Object.assign(story, structuredClone(assignmentFields));
  }

  assertExecutionPrd(candidate, { orchestrator, allowCompleted: false });
  return candidate;
}
