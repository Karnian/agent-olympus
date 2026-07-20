import {
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ROUTING_CONFIG } from '../../scripts/lib/config-validator.mjs';
import { parseReviewResult } from '../../scripts/lib/review-contract.mjs';
import { parseHermesSpecEnvelope } from '../../scripts/lib/spec-artifact.mjs';
import { parseStageVerdict } from '../../scripts/lib/stage-escalation.mjs';

export const ROLE_MANIFEST_SCHEMA_VERSION = 1;
export const ROLE_NAMESPACE = 'agent-olympus';
export const EXPECTED_AGENT_NAMES = Object.freeze([
  'aphrodite',
  'architect',
  'ask',
  'athena',
  'atlas',
  'code-reviewer',
  'debugger',
  'designer',
  'executor',
  'explore',
  'hephaestus',
  'hermes',
  'metis',
  'momus',
  'prometheus',
  'security-reviewer',
  'test-engineer',
  'themis',
  'writer',
]);
export const DECLARED_READ_ONLY_AGENTS = Object.freeze([
  'aphrodite',
  'architect',
  'code-reviewer',
  'explore',
  'security-reviewer',
]);

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(MODULE_DIR, '../..');
const DEFAULT_MANIFEST_PATH = path.join(DEFAULT_REPO_ROOT, 'evals', 'roles', 'manifest.json');
const MAX_MANIFEST_BYTES = 256 * 1024;
const TOP_LEVEL_KEYS = Object.freeze(['schemaVersion', 'namespace', 'agents']);
const AGENT_KEYS = Object.freeze([
  'name',
  'invocation',
  'model',
  'tools',
  'readOnly',
  'machineOutputs',
]);
const FRONTMATTER_KEYS = new Set(['name', 'model', 'description', 'tools']);
const MODEL_TIERS = new Set(['haiku', 'sonnet', 'opus']);
const MACHINE_OUTPUTS = new Set(['AO_REVIEW_V1', 'AO_SPEC_V1', 'STAGE_VERDICT']);
const BUILTIN_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'Edit',
  'Write',
  'Bash',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
  'Agent',
  'Task',
  'Skill',
  'TodoWrite',
  'BashOutput',
  'KillShell',
]);
const READ_ONLY_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'mcp__Claude_Preview__preview_screenshot',
  'mcp__Claude_Preview__preview_snapshot',
]);
const REVIEWERS = Object.freeze([
  'aphrodite',
  'architect',
  'code-reviewer',
  'security-reviewer',
  'themis',
]);
const REVIEW_DIGEST = 'a'.repeat(64);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message) {
  throw new Error(`Role contract validation failed: ${message}`);
}

function assertExactKeys(value, expected, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value);
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  const unexpected = actual.filter((key) => !expected.includes(key));
  if (missing.length > 0) fail(`${label} missing keys: ${missing.join(', ')}`);
  if (unexpected.length > 0) fail(`${label} unexpected keys: ${unexpected.join(', ')}`);
}

function assertUniqueStrings(values, label) {
  if (!Array.isArray(values)) fail(`${label} must be an array`);
  const seen = new Set();
  for (const [index, value] of values.entries()) {
    if (typeof value !== 'string' || value.trim() === '') {
      fail(`${label}[${index}] must be a non-empty string`);
    }
    if (seen.has(value)) fail(`${label} contains duplicate ${value}`);
    seen.add(value);
  }
  return seen;
}

function toolBaseName(token) {
  const constrained = token.match(/^([A-Za-z][A-Za-z0-9]*)(?:\(.+\))?$/);
  return constrained ? constrained[1] : token;
}

function isRecognizedToolToken(token) {
  const base = toolBaseName(token);
  if (BUILTIN_TOOLS.has(base)) return true;
  return /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/.test(token);
}

function sameStringSet(actual, expected) {
  return actual.length === expected.length
    && actual.every((value) => expected.includes(value));
}

/** Parse the comma-delimited Claude agent `tools:` syntax without splitting constraints. */
export function parseToolDeclaration(value) {
  if (typeof value !== 'string' || value.trim() === '') return [];
  const tools = [];
  let token = '';
  let depth = 0;
  for (const char of value) {
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth < 0) fail(`unbalanced tools declaration: ${value}`);
    }
    if (char === ',' && depth === 0) {
      const trimmed = token.trim();
      if (!trimmed) fail(`empty tool token in declaration: ${value}`);
      tools.push(trimmed);
      token = '';
    } else {
      token += char;
    }
  }
  if (depth !== 0) fail(`unbalanced tools declaration: ${value}`);
  const trimmed = token.trim();
  if (!trimmed) fail(`empty tool token in declaration: ${value}`);
  tools.push(trimmed);
  return tools;
}

/** Parse the strict, single-line frontmatter form currently used by agents/*.md. */
export function parseAgentFrontmatter(source, label = 'agent') {
  if (typeof source !== 'string') fail(`${label} source must be a string`);
  const lines = source.split(/\r?\n/);
  if (lines[0] !== '---') fail(`${label} is missing the opening frontmatter delimiter`);
  const end = lines.findIndex((line, index) => index > 0 && line === '---');
  if (end === -1) fail(`${label} is missing the closing frontmatter delimiter`);

  const frontmatter = {};
  for (const line of lines.slice(1, end)) {
    if (line.trim() === '') continue;
    const separator = line.indexOf(':');
    if (separator <= 0) fail(`${label} has unsupported frontmatter syntax: ${line}`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!FRONTMATTER_KEYS.has(key)) fail(`${label} has unexpected frontmatter field ${key}`);
    if (Object.hasOwn(frontmatter, key)) fail(`${label} repeats frontmatter field ${key}`);
    frontmatter[key] = value;
  }
  for (const key of ['name', 'model', 'description']) {
    if (typeof frontmatter[key] !== 'string' || frontmatter[key] === '') {
      fail(`${label} requires non-empty frontmatter field ${key}`);
    }
  }
  return frontmatter;
}

/** Validate the checked-in manifest without consulting agent files. */
export function validateRoleManifest(manifest) {
  assertExactKeys(manifest, TOP_LEVEL_KEYS, 'manifest');
  if (manifest.schemaVersion !== ROLE_MANIFEST_SCHEMA_VERSION) {
    fail(`manifest.schemaVersion must be ${ROLE_MANIFEST_SCHEMA_VERSION}`);
  }
  if (manifest.namespace !== ROLE_NAMESPACE) {
    fail(`manifest.namespace must be ${ROLE_NAMESPACE}`);
  }
  if (!Array.isArray(manifest.agents)) fail('manifest.agents must be an array');

  const names = [];
  const readOnlyNames = [];
  for (const [index, agent] of manifest.agents.entries()) {
    const label = `manifest.agents[${index}]`;
    assertExactKeys(agent, AGENT_KEYS, label);
    if (typeof agent.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(agent.name)) {
      fail(`${label}.name is invalid`);
    }
    names.push(agent.name);
    if (agent.invocation !== `${ROLE_NAMESPACE}:${agent.name}`) {
      fail(`${label}.invocation must be ${ROLE_NAMESPACE}:${agent.name}`);
    }
    if (!MODEL_TIERS.has(agent.model)) fail(`${label}.model is invalid`);
    if (typeof agent.readOnly !== 'boolean') fail(`${label}.readOnly must be boolean`);
    if (agent.readOnly) readOnlyNames.push(agent.name);

    if (agent.tools !== null) {
      const toolSet = assertUniqueStrings(agent.tools, `${label}.tools`);
      if (toolSet.size === 0) fail(`${label}.tools must not be empty`);
      for (const tool of agent.tools) {
        if (!isRecognizedToolToken(tool)) fail(`${label}.tools contains unrecognized tool ${tool}`);
        if (agent.readOnly && !READ_ONLY_TOOLS.has(tool)) {
          fail(`${label} read-only policy forbids tool ${tool}`);
        }
      }
    } else if (agent.readOnly) {
      fail(`${label} read-only agent must declare an explicit tools allowlist`);
    }

    const outputs = assertUniqueStrings(agent.machineOutputs, `${label}.machineOutputs`);
    for (const output of outputs) {
      if (!MACHINE_OUTPUTS.has(output)) fail(`${label}.machineOutputs contains unsupported ${output}`);
    }
  }

  const nameSet = new Set(names);
  if (nameSet.size !== names.length) {
    const duplicate = names.find((name, index) => names.indexOf(name) !== index);
    fail(`manifest.agents contains duplicate ${duplicate}`);
  }
  const missing = EXPECTED_AGENT_NAMES.filter((name) => !nameSet.has(name));
  const unexpected = names.filter((name) => !EXPECTED_AGENT_NAMES.includes(name));
  if (missing.length > 0) fail(`manifest.agents missing expected agents: ${missing.join(', ')}`);
  if (unexpected.length > 0) fail(`manifest.agents contains unexpected agents: ${unexpected.join(', ')}`);
  if (names.length !== EXPECTED_AGENT_NAMES.length) {
    fail(`manifest.agents must contain exactly ${EXPECTED_AGENT_NAMES.length} agents`);
  }
  if (names.some((name, index) => name !== [...names].sort()[index])) {
    fail('manifest.agents must be sorted by name');
  }
  if (!sameStringSet(readOnlyNames, DECLARED_READ_ONLY_AGENTS)) {
    fail(`manifest read-only inventory must be exactly ${DECLARED_READ_ONLY_AGENTS.join(', ')}`);
  }
  return manifest;
}

export function readRoleManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  const stats = lstatSync(manifestPath);
  if (!stats.isFile() || stats.isSymbolicLink()) fail('manifest must be a regular non-symlink file');
  if (stats.size > MAX_MANIFEST_BYTES) fail(`manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateRoleManifest(manifest);
}

function inferMachineOutputs(source) {
  const outputs = [];
  if (source.includes('AO_REVIEW_V1')) outputs.push('AO_REVIEW_V1');
  if (source.includes('AO_SPEC_V1')) outputs.push('AO_SPEC_V1');
  if (/```\s*stage[_-]verdict\b/i.test(source)) outputs.push('STAGE_VERDICT');
  return outputs;
}

function jsonExamplesAfter(source, marker, label) {
  const start = source.indexOf(marker);
  if (start === -1) fail(`${label} is missing ${marker}`);
  const examples = [...source.slice(start).matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)]
    .map((match, index) => {
      try {
        return JSON.parse(match[1]);
      } catch (error) {
        fail(`${label} ${marker} JSON example ${index} is invalid: ${error.message}`);
      }
    });
  if (examples.length === 0) fail(`${label} is missing a ${marker} JSON example`);
  return examples;
}

function validateReviewExamples(name, source) {
  const examples = jsonExamplesAfter(source, 'AO_REVIEW_V1', name);
  for (const [index, example] of examples.entries()) {
    const materialized = structuredClone(example);
    materialized.reviewDigest = REVIEW_DIGEST;
    const diffPaths = materialized.findings
      .map((finding) => finding.file)
      .filter((file) => file !== null);
    try {
      parseReviewResult(JSON.stringify(materialized), {
        expectedReviewer: name,
        expectedReviewDigest: REVIEW_DIGEST,
        allowedReviewers: REVIEWERS,
        reviewPackage: {
          diffPaths,
          reviewDigest: { algorithm: 'sha256', value: REVIEW_DIGEST },
        },
      });
    } catch (error) {
      fail(`${name} AO_REVIEW_V1 example ${index} fails production parser: ${error.message}`);
    }
  }
  return examples.length;
}

function validateSpecExamples(name, source) {
  const examples = jsonExamplesAfter(source, 'AO_SPEC_V1', name);
  for (const [index, example] of examples.entries()) {
    try {
      parseHermesSpecEnvelope(JSON.stringify(example));
    } catch (error) {
      fail(`${name} AO_SPEC_V1 example ${index} fails production parser: ${error.message}`);
    }
  }
  return examples.length;
}

function validateStageExamples(name, source) {
  const matches = [...source.matchAll(/```\s*stage[_-]verdict\b[^\n]*\n?([\s\S]*?)```/gi)];
  if (matches.length === 0) fail(`${name} is missing a STAGE_VERDICT example`);
  for (const [index, match] of matches.entries()) {
    const body = match[1];
    const parsed = parseStageVerdict(`\`\`\`stage_verdict\n${body}\n\`\`\``);
    if (!parsed?.stage || !parsed.verdict || !parsed.confidence || !parsed.escalateTo) {
      fail(`${name} STAGE_VERDICT example ${index} fails production parser`);
    }
    if (parsed.reasons.length === 0 || parsed.evidence.length === 0) {
      fail(`${name} STAGE_VERDICT example ${index} must include reasons and evidence`);
    }
  }
  return matches.length;
}

function validateNamespacedReferences(name, source, knownNames) {
  for (const match of source.matchAll(/\bagent-olympus:([a-z][a-z0-9-]*)\b/g)) {
    if (!knownNames.has(match[1])) fail(`${name} references unknown agent ${match[0]}`);
  }
}

function validateOrchestratorCatalog(name, source, expectedNames) {
  const marker = '## Available Agents';
  const start = source.indexOf(marker);
  if (start === -1) fail(`${name} is missing its namespaced Available Agents catalog`);
  const tail = source.slice(start + marker.length);
  const nextSection = tail.search(/\n## /);
  const section = nextSection === -1 ? tail : tail.slice(0, nextSection);
  const references = [...section.matchAll(/agent-olympus:([a-z][a-z0-9-]*)/g)]
    .map((match) => match[1]);
  const unique = new Set(references);
  if (unique.size !== references.length) fail(`${name} Available Agents catalog contains duplicates`);
  if (!sameStringSet(references, expectedNames)) {
    fail(`${name} Available Agents catalog must contain every specialist using the agent-olympus namespace`);
  }
}

function validateAgentFile(entry, source) {
  const frontmatter = parseAgentFrontmatter(source, entry.name);
  if (frontmatter.name !== entry.name) fail(`${entry.name} frontmatter name does not match manifest`);
  if (frontmatter.model !== entry.model) fail(`${entry.name} model does not match manifest`);
  const declaredTools = Object.hasOwn(frontmatter, 'tools')
    ? parseToolDeclaration(frontmatter.tools)
    : null;
  if (entry.tools === null && declaredTools !== null) {
    fail(`${entry.name} unexpectedly declares tools while manifest inherits them`);
  }
  if (entry.tools !== null && declaredTools === null) fail(`${entry.name} must declare tools`);
  if (entry.tools !== null && !sameStringSet(declaredTools, entry.tools)) {
    fail(`${entry.name} tools declaration does not match manifest`);
  }
  if (declaredTools !== null) {
    const unique = new Set(declaredTools);
    if (unique.size !== declaredTools.length) fail(`${entry.name} tools declaration contains duplicates`);
    for (const tool of declaredTools) {
      if (!isRecognizedToolToken(tool)) fail(`${entry.name} declares unrecognized tool ${tool}`);
      if (entry.readOnly && !READ_ONLY_TOOLS.has(tool)) {
        fail(`${entry.name} read-only policy forbids declared tool ${tool}`);
      }
    }
  }

  const inferredOutputs = inferMachineOutputs(source);
  if (!sameStringSet(inferredOutputs, entry.machineOutputs)) {
    fail(`${entry.name} machine-output declarations do not match documented contracts`);
  }
  let examples = 0;
  if (entry.machineOutputs.includes('AO_REVIEW_V1')) examples += validateReviewExamples(entry.name, source);
  if (entry.machineOutputs.includes('AO_SPEC_V1')) examples += validateSpecExamples(entry.name, source);
  if (entry.machineOutputs.includes('STAGE_VERDICT')) examples += validateStageExamples(entry.name, source);
  return { frontmatter, examples };
}

/** Validate all 19 checked-in agent contracts without invoking a provider. */
export function validateRoleContracts(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const manifestPath = path.resolve(options.manifestPath ?? path.join(repoRoot, 'evals/roles/manifest.json'));
  const manifest = options.manifest === undefined
    ? readRoleManifest(manifestPath)
    : validateRoleManifest(options.manifest);
  const agentsDir = path.join(repoRoot, 'agents');
  const files = readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith('.md'));
  const actualNames = files.map((entry) => path.basename(entry.name, '.md')).sort();
  if (!sameStringSet(actualNames, EXPECTED_AGENT_NAMES)) {
    fail('agents directory must contain exactly the 19 manifest agents');
  }
  for (const entry of files) {
    if (!entry.isFile() || entry.isSymbolicLink()) fail(`agents/${entry.name} must be a regular file`);
  }

  const knownNames = new Set(EXPECTED_AGENT_NAMES);
  let exampleCount = 0;
  for (const entry of manifest.agents) {
    const agentPath = path.join(agentsDir, `${entry.name}.md`);
    const source = readFileSync(agentPath, 'utf8');
    const result = validateAgentFile(entry, source);
    exampleCount += result.examples;
    validateNamespacedReferences(entry.name, source, knownNames);
  }

  const specialists = EXPECTED_AGENT_NAMES.filter((name) => !['atlas', 'athena'].includes(name));
  for (const orchestrator of ['atlas', 'athena']) {
    validateOrchestratorCatalog(
      orchestrator,
      readFileSync(path.join(agentsDir, `${orchestrator}.md`), 'utf8'),
      specialists,
    );
  }
  for (const [route, config] of Object.entries(DEFAULT_ROUTING_CONFIG.routes)) {
    if (typeof config.agent !== 'string' || !config.agent.startsWith(`${ROLE_NAMESPACE}:`)) {
      fail(`default route ${route} must use the ${ROLE_NAMESPACE} namespace`);
    }
    const name = config.agent.slice(ROLE_NAMESPACE.length + 1);
    if (!knownNames.has(name)) fail(`default route ${route} references unknown agent ${config.agent}`);
  }

  return Object.freeze({
    schemaVersion: ROLE_MANIFEST_SCHEMA_VERSION,
    namespace: ROLE_NAMESPACE,
    agentCount: manifest.agents.length,
    readOnlyAgentCount: manifest.agents.filter((entry) => entry.readOnly).length,
    machineExampleCount: exampleCount,
  });
}
