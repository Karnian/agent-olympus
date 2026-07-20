import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VALID_TRACKS = new Set(['all', 'regression', 'capability']);
const REQUIRED_TASK_KEYS = new Set([
  'schemaVersion',
  'id',
  'track',
  'orchestrator',
  'prompt',
  'difficulty',
  'timeoutMs',
  'modelTier',
  'k',
]);
const TASK_KEYS = new Set([...REQUIRED_TASK_KEYS, 'agent', 'maxBudgetUsd']);
const TASK_TRACKS = new Set(['regression', 'capability']);
const ORCHESTRATORS = new Set(['atlas', 'athena', 'solo', 'agent']);
const AGENT_NAMES = new Set([
  'atlas', 'athena', 'metis', 'prometheus', 'momus', 'hermes', 'executor',
  'designer', 'aphrodite', 'test-engineer', 'debugger', 'architect',
  'security-reviewer', 'code-reviewer', 'explore', 'writer', 'hephaestus',
  'ask', 'themis',
]);
const SAFE_MODEL_SELECTOR = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
const EVAL_LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const EVALS_DIR = path.dirname(EVAL_LIB_DIR);
const REPO_ROOT = path.dirname(EVALS_DIR);
const GRADER_RUNTIME_FILES = [
  'candidate-invoke.mjs',
  'grade-child.mjs',
  'grader-subprocess.mjs',
  'public-test-child.mjs',
  'subprocess-supervisor.mjs',
];
const HARNESS_RUNTIME_FILES = [
  { absolutePath: path.join(EVALS_DIR, 'run.mjs'), relativePath: 'harness/run.mjs' },
  { absolutePath: path.join(EVAL_LIB_DIR, 'orchestrate.mjs'), relativePath: 'harness/orchestrate.mjs' },
  { absolutePath: path.join(EVAL_LIB_DIR, 'pipeline-evidence.mjs'), relativePath: 'harness/pipeline-evidence.mjs' },
  { absolutePath: path.join(EVAL_LIB_DIR, 'plugin-stage.mjs'), relativePath: 'harness/plugin-stage.mjs' },
  { absolutePath: path.join(EVAL_LIB_DIR, 'score.mjs'), relativePath: 'harness/score.mjs' },
  { absolutePath: path.join(EVAL_LIB_DIR, 'tasks.mjs'), relativePath: 'harness/tasks.mjs' },
  { absolutePath: path.join(REPO_ROOT, 'hooks/hooks.json'), relativePath: 'harness/hooks.json' },
  { absolutePath: path.join(REPO_ROOT, 'scripts/orchestrator-runtime.mjs'), relativePath: 'harness/orchestrator-runtime.mjs' },
  { absolutePath: path.join(REPO_ROOT, 'scripts/orchestrator-skill-init.mjs'), relativePath: 'harness/orchestrator-skill-init.mjs' },
  { absolutePath: path.join(REPO_ROOT, 'scripts/orchestrator-stop-gate.mjs'), relativePath: 'harness/orchestrator-stop-gate.mjs' },
  { absolutePath: path.join(REPO_ROOT, 'scripts/stop-hook.mjs'), relativePath: 'harness/stop-hook.mjs' },
  { absolutePath: path.join(REPO_ROOT, 'scripts/lib/loop-guard.mjs'), relativePath: 'harness/loop-guard.mjs' },
  { absolutePath: path.join(REPO_ROOT, 'scripts/lib/phase-runner.mjs'), relativePath: 'harness/phase-runner.mjs' },
  { absolutePath: path.join(REPO_ROOT, 'scripts/lib/run-artifacts.mjs'), relativePath: 'harness/run-artifacts.mjs' },
];
const LOCAL_MODULE_EXTENSIONS = ['.mjs', '.js', '.cjs', '.json', '.node'];
const STATIC_IMPORT_RE = /(?:^|[;\n])\s*(?:import|export)\s+(?:[^'"`]*?\s+from\s*)?['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*(?=[,)])/g;

/** Enforce the checked-in task schema without adding a JSON-schema runtime. */
export function validateTaskDefinition(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw new Error('task.json must contain a JSON object');
  }
  const errors = [];
  const keys = Object.keys(task);
  for (const key of REQUIRED_TASK_KEYS) {
    if (!Object.hasOwn(task, key)) errors.push(`${key} is required`);
  }
  for (const key of keys) {
    if (!TASK_KEYS.has(key)) errors.push(`unexpected property: ${key}`);
  }
  if (task.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (typeof task.id !== 'string' || task.id.trim() === '') errors.push('id must be a non-empty string');
  if (!TASK_TRACKS.has(task.track)) errors.push('track must be one of: regression, capability');
  if (!ORCHESTRATORS.has(task.orchestrator)) {
    errors.push('orchestrator must be one of: atlas, athena, solo, agent');
  }
  if (task.orchestrator === 'agent') {
    if (!Object.hasOwn(task, 'agent')) errors.push('agent is required when orchestrator is agent');
    else if (!AGENT_NAMES.has(task.agent)) errors.push('agent must name a bundled Agent Olympus agent');
    if (task.track !== 'capability') errors.push('direct-agent tasks must use capability track');
    if (!Object.hasOwn(task, 'maxBudgetUsd')) {
      errors.push('maxBudgetUsd is required when orchestrator is agent');
    }
  } else if (Object.hasOwn(task, 'agent')) {
    errors.push('agent is only allowed when orchestrator is agent');
  }
  if (Object.hasOwn(task, 'maxBudgetUsd')
    && (!Number.isFinite(task.maxBudgetUsd)
      || task.maxBudgetUsd <= 0
      || task.maxBudgetUsd > 100)) {
    errors.push('maxBudgetUsd must be a finite number greater than 0 and at most 100');
  }
  if (typeof task.prompt !== 'string' || task.prompt.trim() === '') errors.push('prompt must be a non-empty string');
  if (typeof task.difficulty !== 'string') errors.push('difficulty must be a string');
  if (!Number.isInteger(task.timeoutMs) || task.timeoutMs < 1) errors.push('timeoutMs must be a positive integer');
  if (typeof task.modelTier !== 'string' || !SAFE_MODEL_SELECTOR.test(task.modelTier)) {
    errors.push('modelTier must be a safe Claude model selector');
  }
  if (!Number.isInteger(task.k) || task.k < 1) errors.push('k must be a positive integer');
  if (errors.length > 0) throw new Error(`Invalid task.json: ${errors.join('; ')}`);
  return task;
}

function taskFiles(taskDir) {
  const files = [];
  const visit = (absolutePath, relativePath) => {
    const stats = lstatSync(absolutePath);
    if (stats.isSymbolicLink()) throw new Error(`Eval task fingerprints reject symlinks: ${relativePath}`);
    if (stats.isDirectory()) {
      for (const entry of readdirSync(absolutePath).sort()) {
        visit(path.join(absolutePath, entry), path.posix.join(relativePath, entry));
      }
      return;
    }
    if (!stats.isFile()) throw new Error(`Eval task fingerprints require regular files: ${relativePath}`);
    files.push({ absolutePath, relativePath });
  };
  visit(path.join(taskDir, 'task.json'), 'task.json');
  visit(path.join(taskDir, 'grader.mjs'), 'grader.mjs');
  visit(path.join(taskDir, 'seed'), 'seed');
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function fingerprintFiles(domain, files) {
  const hash = createHash('sha256');
  hash.update(`${domain}\0`);
  for (const file of [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    const content = file.content ?? readFileSync(file.absolutePath);
    hash.update(file.relativePath);
    hash.update('\0');
    hash.update(String(content.length));
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function localImportSpecifiers(source) {
  const specifiers = new Set();
  for (const pattern of [STATIC_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      if (match[1].startsWith('.')) specifiers.add(match[1]);
    }
  }
  return [...specifiers].sort();
}

function resolveLocalImport(importer, specifier, canonicalRepoRoot) {
  let unresolved;
  try {
    unresolved = fileURLToPath(new URL(specifier, pathToFileURL(importer)));
  } catch {
    throw new Error(`Invalid local protocol import ${JSON.stringify(specifier)} from ${importer}`);
  }
  const extension = path.extname(unresolved);
  const candidates = extension
    ? [unresolved]
    : [
      unresolved,
      ...LOCAL_MODULE_EXTENSIONS.map((suffix) => `${unresolved}${suffix}`),
      ...LOCAL_MODULE_EXTENSIONS.map((suffix) => path.join(unresolved, `index${suffix}`)),
    ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const stats = lstatSync(candidate);
    if (stats.isSymbolicLink()) {
      throw new Error(`Protocol dependency fingerprints reject symlinks: ${candidate}`);
    }
    if (!stats.isFile()) continue;
    const canonical = realpathSync(candidate);
    if (!isWithin(canonicalRepoRoot, canonical)) {
      throw new Error(`Protocol dependency escapes repository boundary: ${specifier}`);
    }
    return canonical;
  }
  throw new Error(`Cannot resolve local protocol import ${JSON.stringify(specifier)} from ${importer}`);
}

/**
 * Collect the deterministic repo-local relative-import closure of the live
 * measurement roots. Builtins and package imports are intentionally excluded.
 */
export function collectPipelineProtocolFiles({
  repoRoot = REPO_ROOT,
  rootFiles = HARNESS_RUNTIME_FILES,
} = {}) {
  const canonicalRepoRoot = realpathSync(path.resolve(repoRoot));
  const pending = rootFiles.map((entry) => path.resolve(
    typeof entry === 'string' ? entry : entry.absolutePath,
  ));
  const visited = new Set();
  const files = [];

  while (pending.length > 0) {
    const requested = pending.pop();
    if (!existsSync(requested)) throw new Error(`Missing protocol fingerprint root: ${requested}`);
    const stats = lstatSync(requested);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`Protocol fingerprint roots must be regular non-symlink files: ${requested}`);
    }
    const canonical = realpathSync(requested);
    if (!isWithin(canonicalRepoRoot, canonical)) {
      throw new Error(`Protocol fingerprint root escapes repository boundary: ${requested}`);
    }
    if (visited.has(canonical)) continue;
    visited.add(canonical);

    const relative = path.relative(canonicalRepoRoot, canonical).split(path.sep).join('/');
    files.push({ absolutePath: canonical, relativePath: `protocol/${relative}` });
    if (!['.mjs', '.js', '.cjs'].includes(path.extname(canonical))) continue;
    const source = readFileSync(canonical, 'utf-8');
    for (const specifier of localImportSpecifiers(source).reverse()) {
      pending.push(resolveLocalImport(canonical, specifier, canonicalRepoRoot));
    }
  }

  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/**
 * Hash only the executable benchmark/grader contract.
 *
 * Pipeline mechanics deliberately do not participate: changing the production
 * phase runner must not make an otherwise identical task outcome impossible to
 * compare. `fingerprintPipelineProtocol()` records that independent identity.
 */
export function fingerprintBenchmark(taskDir) {
  return fingerprintFiles('agent-olympus-eval-benchmark-v3', [
    ...taskFiles(path.resolve(taskDir)),
    ...GRADER_RUNTIME_FILES.map((name) => ({
      absolutePath: path.join(EVAL_LIB_DIR, name),
      relativePath: `grader-runtime/${name}`,
    })),
  ]);
}

/**
 * Hash the treatment-neutral task fixture for paired persona comparisons.
 *
 * The task id and selected agent identify an experimental arm, so they remain
 * in `fingerprintBenchmark()` but are deliberately excluded here. All other
 * prompt/behavior fields plus the seed, grader, and grader runtime must match
 * before two arms can claim an apples-to-apples fixture. Route, model, timeout,
 * k, and budget are treatment/measurement provenance, not fixture identity.
 */
export function fingerprintComparableFixture(taskDir) {
  const resolvedTaskDir = path.resolve(taskDir);
  const task = validateTaskDefinition(JSON.parse(
    readFileSync(path.join(resolvedTaskDir, 'task.json'), 'utf-8'),
  ));
  const neutralContract = {
    schemaVersion: task.schemaVersion,
    track: task.track,
    prompt: task.prompt,
    difficulty: task.difficulty,
  };
  return fingerprintFiles('agent-olympus-eval-comparable-fixture-v1', [
    {
      relativePath: 'task-contract.json',
      content: Buffer.from(JSON.stringify(neutralContract), 'utf-8'),
    },
    ...taskFiles(resolvedTaskDir).filter((file) => file.relativePath !== 'task.json'),
    ...GRADER_RUNTIME_FILES.map((name) => ({
      absolutePath: path.join(EVAL_LIB_DIR, name),
      relativePath: `grader-runtime/${name}`,
    })),
  ]);
}

/** Hash the live measurement protocol and all repo-local implementation dependencies. */
export function fingerprintPipelineProtocol(options = {}) {
  return fingerprintFiles(
    'agent-olympus-eval-pipeline-protocol-v2',
    collectPipelineProtocolFiles(options),
  );
}

export function discoverTasks(tasksDir, track = 'all') {
  if (!VALID_TRACKS.has(track)) {
    throw new Error(`track must be one of: ${[...VALID_TRACKS].join(', ')}`);
  }

  const tasks = readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => {
      const taskDir = path.join(tasksDir, entry.name);
      const task = validateTaskDefinition(JSON.parse(readFileSync(path.join(taskDir, 'task.json'), 'utf-8')));
      return { task, taskDir };
    })
    .filter(({ task }) => track === 'all' || task.track === track)
    .sort((a, b) => a.task.id.localeCompare(b.task.id));

  const ids = new Set();
  for (const { task } of tasks) {
    if (typeof task.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(task.id)) {
      throw new Error(`Unsafe eval task id: ${JSON.stringify(task.id)}`);
    }
    if (ids.has(task.id)) throw new Error(`Duplicate eval task id: ${task.id}`);
    ids.add(task.id);
  }
  return tasks;
}
