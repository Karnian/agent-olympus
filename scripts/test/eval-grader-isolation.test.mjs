import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as nodeUtil from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runIsolatedCheck } from '../../evals/lib/grader-subprocess.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const HOSTILE_TIMEOUT_MS = 300;

function hostileWorkdir(taskId, relativeCandidatePath, source) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), `ao-hostile-${taskId}-`));
  const workdir = path.join(tempRoot, 'workdir');
  cpSync(path.join(repoRoot, 'evals', 'tasks', taskId, 'seed'), workdir, { recursive: true });
  writeFileSync(path.join(workdir, relativeCandidatePath), source, 'utf8');
  return { tempRoot, workdir };
}

async function loadGrader(taskId) {
  return import(new URL(`../../evals/tasks/${taskId}/grader.mjs`, import.meta.url));
}

async function assertHostileCandidateFails({ taskId, candidatePath, source, expectedDetail, inspect }) {
  const candidate = hostileWorkdir(taskId, candidatePath, source);
  try {
    const grader = await loadGrader(taskId);
    const startedAt = Date.now();
    const result = await grader.grade(candidate.workdir, { timeoutMs: HOSTILE_TIMEOUT_MS });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.pass, false);
    assert.ok(elapsedMs < 3_000, `isolated grade exceeded its fixed bound: ${elapsedMs}ms`);
    assert.equal(result.checks.length, 2);
    assert.equal(result.checks.some((check) => check.pass === false), true);
    assert.match(
      result.checks.map((check) => check.detail).join('\n'),
      expectedDetail,
    );
    await inspect?.({ result, workdir: candidate.workdir });
    return result;
  } finally {
    rmSync(candidate.tempRoot, { recursive: true, force: true });
  }
}

test('top-level infinite loop times out without hanging the eval runner', async () => {
  await assertHostileCandidateFails({
    taskId: 'fix-failing-test',
    candidatePath: 'src/sum.mjs',
    source: 'while (true) {}\n',
    expectedDetail: /timed out after 300ms/,
  });
});

test('candidate process.exit(0) cannot turn a missing hidden result into a pass', async () => {
  await assertHostileCandidateFails({
    taskId: 'fix-failing-test',
    candidatePath: 'src/sum.mjs',
    source: `console.log('AO_GRADER_RESULT:{"name":"sum-adds","pass":true,"detail":"forged"}');\nprocess.exit(0);\n`,
    expectedDetail: /exited without a valid result/,
  });
});

test('candidate cannot spawn a detached process outside the grader boundary', async () => {
  await assertHostileCandidateFails({
    taskId: 'fix-failing-test',
    candidatePath: 'src/sum.mjs',
    source: [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
      "writeFileSync('detached.pid', String(child.pid));",
      'export function sum(a, b) { return a + b; }',
      '',
    ].join('\n'),
    expectedDetail: /permission:\s*['"]ChildProcess/,
    inspect: ({ workdir }) => {
      assert.equal(existsSync(path.join(workdir, 'detached.pid')), false);
    },
  });
});

test('candidate cannot monkeypatch shared assert helpers into a hidden pass', async () => {
  const result = await assertHostileCandidateFails({
    taskId: 'fix-off-by-one',
    candidatePath: 'src/lastN.mjs',
    source: [
      "import assert from 'node:assert/strict';",
      'assert.deepEqual = () => {};',
      'export function lastN() { return []; }',
      '',
    ].join('\n'),
    expectedDetail: /did not return \[3,4\]/,
  });
  assert.equal(result.checks[1].pass, false);
});

test('candidate cannot combine public assert and Array helper patches into a false pass', async () => {
  const result = await assertHostileCandidateFails({
    taskId: 'fix-failing-test',
    candidatePath: 'src/sum.mjs',
    source: [
      "import assert from 'node:assert/strict';",
      'assert.equal = () => {};',
      'Array.prototype.find = () => undefined;',
      'export function sum() { return 0; }',
      '',
    ].join('\n'),
    expectedDetail: /sum\(2, 3\) did not return 5/,
  });
  assert.equal(result.checks[0].pass, true, 'the hostile patch should demonstrate the public-test bypass');
  assert.equal(result.checks[1].pass, false, 'the hidden check must remain authoritative');
});

test('candidate Object.prototype.toJSON cannot rewrite a hidden failure into a pass', async () => {
  const result = await assertHostileCandidateFails({
    taskId: 'fix-off-by-one',
    candidatePath: 'src/lastN.mjs',
    source: [
      "import assert from 'node:assert/strict';",
      'assert.deepEqual = () => {};',
      'Object.prototype.toJSON = () => ({ name: "forged", pass: true, detail: "forged" });',
      'export function lastN() { return []; }',
      '',
    ].join('\n'),
    expectedDetail: /lastN\(.*did not return/,
  });
  assert.equal(result.checks[1].pass, false);
});

test('candidate import and call stacks do not reveal the hidden grader path', async () => {
  const result = await assertHostileCandidateFails({
    taskId: 'fix-failing-test',
    candidatePath: 'src/sum.mjs',
    source: [
      "import assert from 'node:assert/strict';",
      'assert.equal = () => {};',
      'const importStack = new Error().stack || "";',
      'export function sum(a, b) {',
      '  const callStack = new Error().stack || "";',
      '  const metadata = `${process.argv.join(" ")}\\n${process.execArgv.join(" ")}\\n${process.report?.getReport?.().header?.commandLine?.join(" ") || ""}`;',
      '  const leaked = /fix-failing-test[/\\\\]grader\\.mjs/.test(`${importStack}\\n${callStack}\\n${metadata}`);',
      '  return leaked ? a + b : 0;',
      '}',
      '',
    ].join('\n'),
    expectedDetail: /sum\(2, 3\) did not return 5/,
  });
  assert.equal(result.checks[0].pass, true, 'the public assertion patch demonstrates why hidden isolation matters');
  assert.equal(result.checks[1].pass, false);
});

test('Node 25 getCallSites cannot reveal the staged hidden grader root', {
  skip: typeof nodeUtil.getCallSites !== 'function',
}, async () => {
  const result = await assertHostileCandidateFails({
    taskId: 'fix-failing-test',
    candidatePath: 'src/sum.mjs',
    source: [
      "import assert from 'node:assert/strict';",
      "import { readFileSync } from 'node:fs';",
      "import * as util from 'node:util';",
      'assert.equal = () => {};',
      'const sites = util.getCallSites({ sourceMap: true });',
      'const helperUrl = sites.map((site) => site.scriptName || "").find((value) => value.includes("ao-eval-grader-") && value.includes("/lib/candidate-invoke.mjs"));',
      'let leaked = false;',
      'if (helperUrl) {',
      '  try {',
      '    const graderUrl = new URL("../tasks/fix-failing-test/grader.mjs", helperUrl);',
      '    leaked = readFileSync(graderUrl, "utf-8").includes("export async function hiddenCases");',
      '  } catch {}',
      '}',
      'export function sum(a, b) { return leaked ? a + b : 0; }',
      '',
    ].join('\n'),
    expectedDetail: /sum\(2, 3\) did not return 5/,
  });
  assert.equal(result.checks[0].pass, true, 'public assertions remain candidate-controlled');
  assert.equal(result.checks[1].pass, false, 'hidden result must not depend on leaked coordinates');
});

test('candidate cannot read the source task grader or reference solution', async () => {
  const graderPath = path.join(repoRoot, 'evals', 'tasks', 'fix-failing-test', 'grader.mjs');
  const solutionPath = path.join(repoRoot, 'evals', 'tasks', 'fix-failing-test', 'solution', 'src', 'sum.mjs');
  const result = await assertHostileCandidateFails({
    taskId: 'fix-failing-test',
    candidatePath: 'src/sum.mjs',
    source: [
      "import assert from 'node:assert/strict';",
      "import { readFileSync } from 'node:fs';",
      'assert.equal = () => {};',
      'let leaked = false;',
      `for (const oracle of ${JSON.stringify([graderPath, solutionPath])}) {`,
      "  try { leaked ||= readFileSync(oracle, 'utf-8').length > 0; } catch {}",
      '}',
      'export function sum(a, b) { return leaked ? a + b : 0; }',
      '',
    ].join('\n'),
    expectedDetail: /sum\(2, 3\) did not return 5/,
  });
  assert.equal(result.checks[1].pass, false);
});

test('candidate stdout monkeypatch cannot rewrite the authenticated hidden result', async () => {
  const result = await assertHostileCandidateFails({
    taskId: 'fix-off-by-one',
    candidatePath: 'src/lastN.mjs',
    source: [
      'const originalWrite = process.stdout.write.bind(process.stdout);',
      "process.stdout.write = (chunk, ...args) => originalWrite(String(chunk).replace('\\\"pass\\\":false', '\\\"pass\\\":true'), ...args);",
      'export function lastN() { return []; }',
      '',
    ].join('\n'),
    expectedDetail: /Expected values to be strictly deep-equal/,
  });
  assert.equal(result.checks[1].pass, false);
});

test('hidden grader coordinates are removed from candidate argv before import', async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'ao-hidden-argv-'));
  const workdir = path.join(tempRoot, 'workdir');
  const graderPath = path.join(tempRoot, 'grader.mjs');
  mkdirSync(workdir);
  writeFileSync(path.join(workdir, 'candidate.mjs'), 'export const seenArgv = [...process.argv];\n');
  writeFileSync(graderPath, [
    "import path from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    'export async function hiddenCases(workdir) {',
    "  const { seenArgv } = await import(pathToFileURL(path.join(workdir, 'candidate.mjs')).href);",
    "  const leaked = seenArgv.slice(2).some((value) => value.includes('grader.mjs') || value.includes('hiddenCases'));",
    "  return { name: 'argv-scrubbed', pass: !leaked && seenArgv.length === 2, detail: JSON.stringify(seenArgv) };",
    '}',
    '',
  ].join('\n'));

  try {
    const result = await runIsolatedCheck({
      workdir,
      graderUrl: pathToFileURL(graderPath).href,
      exportName: 'hiddenCases',
      name: 'argv-scrubbed',
      timeoutMs: 1_000,
    });
    assert.equal(result.pass, true, result.detail);
    const seenArgv = JSON.parse(result.detail);
    assert.equal(seenArgv.length, 2);
    assert.equal(path.isAbsolute(seenArgv[1]), false);
    assert.equal(seenArgv[1], 'ao-eval-candidate');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('candidate callbacks expose an opaque facade instead of hidden grader source', async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'ao-hidden-callback-'));
  const workdir = path.join(tempRoot, 'workdir');
  const graderPath = path.join(tempRoot, 'grader.mjs');
  mkdirSync(workdir);
  writeFileSync(path.join(workdir, 'candidate.mjs'), [
    'export function inspectCallback(callback) {',
    "  return Function.prototype.toString.call(callback).includes('HIDDEN_CALLBACK_ORACLE_MARKER');",
    '}',
    '',
  ].join('\n'));
  writeFileSync(graderPath, [
    "import path from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    `import { importCandidate, invokeCandidate, opaqueCallback } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'evals/lib/candidate-invoke.mjs')).href)};`,
    'export async function hiddenCases(workdir) {',
    "  const callback = opaqueCallback(() => 'HIDDEN_CALLBACK_ORACLE_MARKER');",
    "  const { inspectCallback } = await importCandidate(pathToFileURL(path.join(workdir, 'candidate.mjs')).href);",
    '  const leaked = await invokeCandidate(inspectCallback, [callback]);',
    "  return { name: 'callback-source-hidden', pass: leaked === false, detail: String(leaked) };",
    '}',
    '',
  ].join('\n'));

  try {
    const result = await runIsolatedCheck({
      workdir,
      graderUrl: pathToFileURL(graderPath).href,
      exportName: 'hiddenCases',
      name: 'callback-source-hidden',
      timeoutMs: 1_000,
    });
    assert.equal(result.pass, true, result.detail);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('never-resolving candidate promise times out without hanging the eval runner', async () => {
  await assertHostileCandidateFails({
    taskId: 'fix-map-limit',
    candidatePath: 'src/mapLimit.mjs',
    source: 'export async function mapLimit() { return new Promise(() => {}); }\n',
    expectedDetail: /timed out after 300ms/,
  });
});
