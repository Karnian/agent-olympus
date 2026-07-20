import { createHash } from 'node:crypto';
import path from 'node:path';
import { TextDecoder } from 'node:util';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_GROUP = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const CLAUDE_MODELS = new Set(['opus', 'sonnet', 'haiku']);
const WORKER_TYPES = new Set(['claude', 'codex', 'gemini']);
export const CLAUDE_EXECUTION_AGENT_TYPES = Object.freeze([
  'executor',
  'designer',
  'test-engineer',
  'debugger',
  'hephaestus',
  'writer',
]);
const CLAUDE_EXECUTION_AGENT_TYPE_SET = new Set(CLAUDE_EXECUTION_AGENT_TYPES);
const PRD_MODES = new Set(['product-feature', 'engineering-change', 'bugfix', 'reverse']);
const PRD_SCALES = new Set(['S', 'M', 'L']);
const REQUIRED_COMMON_ARRAYS = ['goals', 'nonGoals', 'constraints', 'risks', 'openQuestions'];
const GIVEN_WHEN_THEN = /^GIVEN\s+.+\s+WHEN\s+.+\s+THEN\s+.+$/s;
const MAX_STORIES = 256;
const MAX_SCOPE_ITEMS = 128;
const MAX_SCOPE_ENTRY_LENGTH = 512;
const MAX_GIT_PATH_ENTRY_LENGTH = 4096;
const MAX_GIT_PATH_LIST_BYTES = 1024 * 1024;
const MAX_GIT_PATHS = 10_000;
const MAX_PRODUCT_ITEMS = 256;
const MAX_PRODUCT_FIELD_BYTES = 16 * 1024;
const PRINTABLE_ASCII_PATH = /^[\x20-\x7E]+$/;
const FATAL_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function boundedNonEmpty(value) {
  return nonEmpty(value)
    && Buffer.byteLength(value, 'utf8') <= MAX_PRODUCT_FIELD_BYTES;
}

function isSafeRepoRelativeAsciiPath(value, maxLength = MAX_GIT_PATH_ENTRY_LENGTH) {
  if (!nonEmpty(value) || value.length > maxLength || !PRINTABLE_ASCII_PATH.test(value)) {
    return false;
  }
  if (value.includes('\\')) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || value.endsWith('/')) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized.startsWith('../')) return false;
  return normalized.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

function isSafeScopeEntry(value) {
  return isSafeRepoRelativeAsciiPath(value, MAX_SCOPE_ENTRY_LENGTH);
}

function canonicalPathKey(value) {
  // Safe paths are ASCII-only, so lower-casing is deterministic and does not
  // depend on locale or Unicode normalization behavior.
  return value.toLowerCase();
}

/**
 * Derive a namespaced runtime team identity without imposing that namespace on
 * the AO_SPEC projectName contract. The readable prefix is bounded and the
 * full planning slug remains collision-bound through SHA-256.
 */
export function buildExecutionTeamSlug(projectName, { orchestrator } = {}) {
  if (!SAFE_PROJECT_NAME.test(projectName || '')) {
    throw new Error('projectName must be a safe non-empty slug');
  }
  if (orchestrator !== 'atlas' && orchestrator !== 'athena') {
    throw new Error('orchestrator must be atlas or athena');
  }
  const namespace = `${orchestrator}-`;
  const unprefixed = projectName.startsWith(namespace)
    ? projectName.slice(namespace.length)
    : projectName;
  const readable = (unprefixed || 'project').slice(0, 60);
  const digest = createHash('sha256')
    .update(JSON.stringify([orchestrator, projectName]), 'utf8')
    .digest('hex')
    .slice(0, 12);
  return `${orchestrator}-${readable}-${digest}`;
}

function scopeEntriesOverlap(left, right) {
  // Ownership must be portable across the case-insensitive default filesystems
  // on macOS/Windows. Conservatively use that comparison on every platform so
  // a plan has the same meaning wherever it is resumed.
  const canonicalLeft = canonicalPathKey(left);
  const canonicalRight = canonicalPathKey(right);
  if (canonicalLeft === canonicalRight) return true;
  return canonicalLeft.startsWith(`${canonicalRight}/`)
    || canonicalRight.startsWith(`${canonicalLeft}/`);
}

function validateDependencyGraph(stories, storyById, errors) {
  // Iterative Kahn traversal avoids attacker-controlled recursion depth.
  const indegree = new Map();
  const dependents = new Map();
  for (const id of storyById.keys()) {
    indegree.set(id, 0);
    dependents.set(id, []);
  }
  for (const story of stories) {
    if (!isObject(story) || !storyById.has(story.id)) continue;
    for (const dependencyId of Array.isArray(story.dependsOn) ? story.dependsOn : []) {
      if (!storyById.has(dependencyId)) continue;
      indegree.set(story.id, indegree.get(story.id) + 1);
      dependents.get(dependencyId).push(story.id);
    }
  }
  const ready = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.pop();
    visited += 1;
    for (const dependentId of dependents.get(id)) {
      const next = indegree.get(dependentId) - 1;
      indegree.set(dependentId, next);
      if (next === 0) ready.push(dependentId);
    }
  }
  if (visited !== storyById.size) errors.push('dependency graph contains a cycle');
}

function validateAthenaScopeOwnership(stories, errors) {
  const peers = [];
  for (const story of stories) {
    if (!isObject(story) || !nonEmpty(story.assignedWorker)
      || !Array.isArray(story.scope)) continue;
    for (const peer of peers) {
      if (peer.assignedWorker === story.assignedWorker) continue;
      for (const left of peer.scope) {
        for (const right of story.scope) {
          if (isSafeScopeEntry(left) && isSafeScopeEntry(right)
            && scopeEntriesOverlap(left, right)) {
            errors.push(
              `${story.id} scope overlaps ${peer.id} across concurrently launched workers`,
            );
          }
        }
      }
    }
    peers.push(story);
  }
}

function validateAtlasScopeOwnership(stories, errors) {
  const peersByGroup = new Map();
  for (const story of stories) {
    if (!isObject(story) || !nonEmpty(story.parallelGroup) || !Array.isArray(story.scope)) continue;
    const peers = peersByGroup.get(story.parallelGroup) || [];
    for (const peer of peers) {
      for (const left of peer.scope) {
        for (const right of story.scope) {
          if (isSafeScopeEntry(left) && isSafeScopeEntry(right)
            && scopeEntriesOverlap(left, right)) {
            errors.push(
              `${story.id} scope overlaps ${peer.id} inside Atlas parallelGroup ${story.parallelGroup}`,
            );
          }
        }
      }
    }
    peers.push(story);
    peersByGroup.set(story.parallelGroup, peers);
  }
}

function validateCommonSpecFields(prd, errors) {
  if (!PRD_MODES.has(prd.mode)) errors.push('mode must be a supported AO_SPEC_V1 mode');
  if (!PRD_SCALES.has(prd.scale)) errors.push('scale must be S, M, or L');
  for (const field of REQUIRED_COMMON_ARRAYS) {
    if (!Array.isArray(prd[field]) || prd[field].some(item => !nonEmpty(item))) {
      errors.push(`${field} must be an array of non-empty strings`);
    }
  }

  if (prd.mode === 'product-feature') {
    const targetUsersValid = boundedNonEmpty(prd.targetUsers)
      || (Array.isArray(prd.targetUsers)
        && prd.targetUsers.length > 0
        && prd.targetUsers.length <= MAX_PRODUCT_ITEMS
        && prd.targetUsers.every(item => boundedNonEmpty(item)));
    if (!targetUsersValid) {
      errors.push(
        'targetUsers must be a bounded non-empty string or non-empty string array for product-feature',
      );
    }

    const validMetric = (metric) => {
      if (boundedNonEmpty(metric)) return true;
      if (!isObject(metric)
        || !boundedNonEmpty(metric.metric)
        || !boundedNonEmpty(metric.target)) return false;
      try {
        return Buffer.byteLength(JSON.stringify(metric), 'utf8') <= MAX_PRODUCT_FIELD_BYTES;
      } catch {
        return false;
      }
    };
    if (!Array.isArray(prd.successMetrics)
      || prd.successMetrics.length === 0
      || prd.successMetrics.length > MAX_PRODUCT_ITEMS
      || prd.successMetrics.some(metric => !validMetric(metric))) {
      errors.push(
        'successMetrics must contain bounded strings or { metric, target } objects for product-feature',
      );
    }
  }
}

/**
 * Resolve one validated Athena Claude execution role to the exact plugin agent
 * identifier consumed by Agent()/Task(). Planning/review-only personas are not
 * launchable through this path: Athena execution workers must be capable of
 * completing and committing their assigned story.
 */
export function resolveClaudeExecutionSubagentType(agentType) {
  if (!CLAUDE_EXECUTION_AGENT_TYPE_SET.has(agentType)) {
    throw new Error(
      `unsupported Claude execution agentType: ${String(agentType)}; expected one of ${CLAUDE_EXECUTION_AGENT_TYPES.join(', ')}`,
    );
  }
  return `agent-olympus:${agentType}`;
}

export function buildAtlasStoryDefinitions(prd, options = {}) {
  assertExecutionPrd(prd, {
    orchestrator: 'atlas',
    allowCompleted: options.allowCompleted === true,
  });
  return prd.userStories.map((story) => {
    const agentType = story.assignTo === 'claude' ? story.agentType : null;
    return {
      ...story,
      type: story.assignTo,
      agentType,
      subagentType: agentType ? resolveClaudeExecutionSubagentType(agentType) : null,
    };
  });
}

/**
 * Build the deterministic worker descriptors used by Athena after the exact
 * persisted PRD has passed validation. A Claude descriptor always contains a
 * concrete allowlisted `agentType` and fully-qualified `subagentType`; external
 * adapter workers contain neither, so no caller can accidentally interpolate
 * an unresolved `agent-olympus:<agentType>` placeholder.
 */
export function buildAthenaWorkerDefinitions(prd, options = {}) {
  assertExecutionPrd(prd, {
    orchestrator: 'athena',
    allowCompleted: options.allowCompleted === true,
  });

  const storiesByWorker = new Map();
  for (const story of prd.userStories) {
    const stories = storiesByWorker.get(story.assignedWorker) || [];
    stories.push(story);
    storiesByWorker.set(story.assignedWorker, stories);
  }

  return [...storiesByWorker.entries()].map(([name, stories]) => {
    const type = stories[0].workerType;
    const agentType = type === 'claude' ? stories[0].agentType : null;
    return {
      name,
      type,
      model: type === 'claude' ? (stories[0].model || 'sonnet') : undefined,
      agentType,
      subagentType: agentType ? resolveClaudeExecutionSubagentType(agentType) : null,
      stories,
      storyIds: stories.map(story => story.id),
      scope: [...new Set(stories.flatMap(story => story.scope))],
    };
  });
}

/**
 * Verify a worker branch only changed paths covered by its persisted scope.
 * Athena currently requires explicit paths/directories, so ownership matching
 * is exact-or-descendant and portable across case-insensitive filesystems.
 */
export function validateChangedPathsAgainstScope(changedPaths, scope) {
  if (!Array.isArray(changedPaths) || !Array.isArray(scope)
    || scope.length === 0 || scope.some(item => !isSafeScopeEntry(item) || /[*?\[\]{}!]/.test(item))
    || new Set(scope.map(canonicalPathKey)).size !== scope.length) {
    return { ok: false, outsideScope: [], error: 'changedPaths and explicit safe scope are required' };
  }
  const canonicalScope = scope.map(canonicalPathKey);
  const outsideScope = changedPaths.filter((item) => {
    if (!isSafeScopeEntry(item) || /[*?\[\]{}!]/.test(item)) return true;
    const candidate = canonicalPathKey(item);
    return !canonicalScope.some(owner => candidate === owner || candidate.startsWith(`${owner}/`));
  });
  return { ok: outsideScope.length === 0, outsideScope };
}

/**
 * Decode the byte-exact output of `git diff --name-only -z` (and equivalent
 * `-z` path-list commands). The parser never trims entries, requires terminal
 * NUL framing, decodes UTF-8 fatally, and rejects paths that are ambiguous on
 * the portable ASCII/case-insensitive execution boundary.
 *
 * @param {Buffer} buffer
 * @returns {string[]}
 */
export function parseNulDelimitedGitPaths(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('git path list must be provided as a Buffer');
  }
  if (buffer.length === 0) return [];
  if (buffer.length > MAX_GIT_PATH_LIST_BYTES) {
    throw new Error('git path list exceeds the byte limit');
  }
  if (buffer[buffer.length - 1] !== 0) {
    throw new Error('git path list must be NUL terminated');
  }

  const paths = [];
  const canonicalPaths = new Set();
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    const bytes = buffer.subarray(start, index);
    let entry;
    try {
      entry = FATAL_UTF8_DECODER.decode(bytes);
    } catch {
      throw new Error('git path list contains invalid UTF-8');
    }
    if (!isSafeRepoRelativeAsciiPath(entry)) {
      throw new Error('git path list contains an unsafe repo-relative path');
    }
    const canonical = canonicalPathKey(entry);
    if (canonicalPaths.has(canonical)) {
      throw new Error('git path list contains a duplicate or case-aliased path');
    }
    canonicalPaths.add(canonical);
    paths.push(entry);
    if (paths.length > MAX_GIT_PATHS) {
      throw new Error('git path list exceeds the path-count limit');
    }
    start = index + 1;
  }
  return paths;
}

export function validateExecutionPrd(prd, options = {}) {
  const orchestrator = options.orchestrator;
  const allowCompleted = options.allowCompleted === true;
  const errors = [];
  if (!['atlas', 'athena'].includes(orchestrator)) {
    return { ok: false, errors: ['orchestrator must be atlas or athena'] };
  }
  if (!isObject(prd)) return { ok: false, errors: ['prd must be an object'] };

  validateCommonSpecFields(prd, errors);

  // AO_SPEC owns one provider-agnostic project slug. Runtime namespaces are
  // derived separately by buildExecutionTeamSlug() so /plan output can flow
  // through Atlas or Athena enrichment without rewriting product identity.
  if (!nonEmpty(prd.projectName) || !SAFE_PROJECT_NAME.test(prd.projectName)) {
    errors.push('projectName must be a safe non-empty slug');
  }
  if (!Array.isArray(prd.userStories) || prd.userStories.length === 0) {
    errors.push('userStories must be a non-empty array');
    return { ok: false, errors };
  }
  if (prd.userStories.length > MAX_STORIES) {
    errors.push(`userStories must contain at most ${MAX_STORIES} stories`);
    return { ok: false, errors };
  }

  const storyIds = new Set();
  const storyById = new Map();
  const athenaWorkers = new Map();
  for (const [index, story] of prd.userStories.entries()) {
    const prefix = `userStories[${index}]`;
    if (!isObject(story)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    if (!nonEmpty(story.id) || !SAFE_ID.test(story.id)) {
      errors.push(`${prefix}.id must be a safe non-empty identifier`);
    } else if (storyIds.has(story.id)) {
      errors.push(`${prefix}.id must be unique`);
    } else {
      storyIds.add(story.id);
      storyById.set(story.id, story);
    }
    if (!nonEmpty(story.title)) errors.push(`${prefix}.title is required`);
    if (!Array.isArray(story.acceptanceCriteria)
      || story.acceptanceCriteria.length === 0
      || story.acceptanceCriteria.some(item => !nonEmpty(item))) {
      errors.push(`${prefix}.acceptanceCriteria must contain non-empty strings`);
    } else if (story.acceptanceCriteria.some(item => !GIVEN_WHEN_THEN.test(item.trim()))) {
      errors.push(`${prefix}.acceptanceCriteria must use GIVEN ... WHEN ... THEN ...`);
    }
    if (allowCompleted ? typeof story.passes !== 'boolean' : story.passes !== false) {
      errors.push(`${prefix}.passes must be ${allowCompleted ? 'boolean' : 'false'}`);
    }
    if (!nonEmpty(story.parallelGroup) || !SAFE_GROUP.test(story.parallelGroup)) {
      errors.push(`${prefix}.parallelGroup must be a safe non-empty identifier`);
    }
    if (!Array.isArray(story.scope)
      || story.scope.length === 0
      || story.scope.length > MAX_SCOPE_ITEMS
      || story.scope.some(item => !isSafeScopeEntry(item))
      || story.scope.some(item => /[*?\[\]{}!]/.test(item))
      || new Set(story.scope.filter(isSafeScopeEntry).map(canonicalPathKey)).size !== story.scope.length) {
      errors.push(`${prefix}.scope must contain unique explicit safe repo-relative paths`);
    }

    if (orchestrator === 'atlas') {
      if (!WORKER_TYPES.has(story.assignTo)) {
        errors.push(`${prefix}.assignTo must be claude, codex, or gemini`);
      }
      if (!CLAUDE_MODELS.has(story.model)) {
        errors.push(`${prefix}.model must be opus, sonnet, or haiku`);
      }
      if (story.assignTo === 'claude') {
        if (!CLAUDE_EXECUTION_AGENT_TYPE_SET.has(story.agentType)) {
          errors.push(
            `${prefix}.agentType must be one of ${CLAUDE_EXECUTION_AGENT_TYPES.join(', ')} for Claude workers`,
          );
        }
      } else if (story.agentType !== undefined) {
        errors.push(`${prefix}.agentType must be omitted for Codex/Gemini adapter workers`);
      }
      continue;
    }

    if (!nonEmpty(story.assignedWorker) || !SAFE_ID.test(story.assignedWorker)) {
      errors.push(`${prefix}.assignedWorker must be a safe non-empty identifier`);
    }
    if (!WORKER_TYPES.has(story.workerType)) {
      errors.push(`${prefix}.workerType must be claude, codex, or gemini`);
    }
    if (story.workerType === 'claude') {
      if (story.model !== undefined && !CLAUDE_MODELS.has(story.model)) {
        errors.push(`${prefix}.model must be opus, sonnet, or haiku for Claude workers`);
      }
      if (!CLAUDE_EXECUTION_AGENT_TYPE_SET.has(story.agentType)) {
        errors.push(
          `${prefix}.agentType must be one of ${CLAUDE_EXECUTION_AGENT_TYPES.join(', ')} for Claude workers`,
        );
      }
    } else if (story.agentType !== undefined) {
      errors.push(`${prefix}.agentType must be omitted for Codex/Gemini adapter workers`);
    }
    if ((story.workerType === 'codex' || story.workerType === 'gemini') && story.model !== undefined) {
      errors.push(`${prefix}.model must be omitted for external workers until provider-specific models are supported`);
    }
    if (nonEmpty(story.assignedWorker) && WORKER_TYPES.has(story.workerType)) {
      const prior = athenaWorkers.get(story.assignedWorker);
      const workerContract = `${story.workerType}:${story.model || ''}:${story.agentType || ''}`;
      if (prior && prior !== workerContract) {
        errors.push(`${prefix}.assignedWorker has conflicting workerType/model/agentType assignments`);
      } else {
        athenaWorkers.set(story.assignedWorker, workerContract);
      }
    }
  }

  if (Array.isArray(prd.userStories)) {
    const storyIndexes = new Map(prd.userStories
      .filter(story => isObject(story) && nonEmpty(story.id))
      .map((story, index) => [story.id, index]));
    for (const [index, story] of prd.userStories.entries()) {
      if (!isObject(story) || story.dependsOn === undefined) continue;
      if (!Array.isArray(story.dependsOn)
        || new Set(story.dependsOn).size !== story.dependsOn.length
        || story.dependsOn.some(id => !nonEmpty(id) || !storyIds.has(id) || id === story.id)) {
        errors.push(`userStories[${index}].dependsOn must reference other story IDs`);
        continue;
      }
      for (const dependencyId of story.dependsOn) {
        const dependency = storyById.get(dependencyId);
        if (!dependency) continue;
        if (orchestrator === 'athena') {
          if (dependency.assignedWorker !== story.assignedWorker) {
            errors.push(`${story.id} cannot depend on ${dependencyId} assigned to another concurrently launched worker`);
          } else if (storyIndexes.get(dependencyId) >= index) {
            errors.push(`${story.id} dependency ${dependencyId} must appear earlier for its sequential worker`);
          }
        } else if (dependency.parallelGroup === story.parallelGroup) {
          errors.push(`${story.id} cannot depend on ${dependencyId} in the same parallelGroup`);
        } else if (storyIndexes.get(dependencyId) >= index) {
          errors.push(`${story.id} dependency ${dependencyId} must appear in an earlier Atlas group`);
        }
      }
    }
  }
  validateDependencyGraph(prd.userStories, storyById, errors);
  if (orchestrator === 'athena') {
    validateAthenaScopeOwnership(prd.userStories, errors);
    const groups = new Set(prd.userStories
      .filter(isObject)
      .map(story => story.parallelGroup)
      .filter(nonEmpty));
    if (groups.size > 1) {
      errors.push('Athena currently supports exactly one concurrently launched parallelGroup');
    }
  } else {
    validateAtlasScopeOwnership(prd.userStories, errors);
    // Atlas executes groups in first-appearance order. Keep each group in one
    // contiguous block so that order cannot be reinterpreted by grouping code.
    const closedGroups = new Set();
    let currentGroup = null;
    let sawClaudeGroup = false;
    const groupProviders = new Map();
    for (const story of prd.userStories) {
      if (!isObject(story) || !nonEmpty(story.parallelGroup)) continue;
      if (currentGroup !== null && story.parallelGroup !== currentGroup) {
        closedGroups.add(currentGroup);
      }
      if (closedGroups.has(story.parallelGroup)) {
        errors.push(`Atlas parallelGroup ${story.parallelGroup} must be one contiguous block`);
      }
      currentGroup = story.parallelGroup;
      const providers = groupProviders.get(story.parallelGroup) || new Set();
      if (WORKER_TYPES.has(story.assignTo)) providers.add(story.assignTo);
      groupProviders.set(story.parallelGroup, providers);
    }
    for (const [group, providers] of groupProviders) {
      const containsClaude = providers.has('claude');
      if (providers.size !== 1) {
        errors.push(`Atlas parallelGroup ${group} must be provider-homogeneous`);
        if (containsClaude) sawClaudeGroup = true;
        continue;
      }
      const provider = [...providers][0];
      if (provider === 'claude') {
        sawClaudeGroup = true;
      } else if (sawClaudeGroup) {
        errors.push('Atlas external-provider groups must precede every Claude group');
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertExecutionPrd(prd, options = {}) {
  const validation = validateExecutionPrd(prd, options);
  if (!validation.ok) {
    throw new Error(`invalid ${options.orchestrator || 'execution'} PRD: ${validation.errors.join('; ')}`);
  }
  return prd;
}
