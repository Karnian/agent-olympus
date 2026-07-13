import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CHILD_RUNNER = fileURLToPath(new URL('./grade-child.mjs', import.meta.url));
const EVAL_LIB_DIR = path.dirname(CHILD_RUNNER);
const CANDIDATE_INVOKE = path.join(EVAL_LIB_DIR, 'candidate-invoke.mjs');
const EVAL_TASKS_DIR = realpathSync(path.resolve(EVAL_LIB_DIR, '..', 'tasks'));
const PUBLIC_TEST_RUNNER = fileURLToPath(new URL('./public-test-child.mjs', import.meta.url));
const SUBPROCESS_SUPERVISOR = fileURLToPath(new URL('./subprocess-supervisor.mjs', import.meta.url));
const RESULT_MARKER = 'AO_GRADER_RESULT:';
const OUTPUT_LIMIT = 4_000;
const MAX_BUFFER = 1024 * 1024;
const SUPERVISOR_GRACE_MS = 2_000;
const HIDDEN_GRADER_SUBPROCESS_STUB = [
  'export function gradeCandidate() {',
  "  throw new Error('gradeCandidate is unavailable inside a hidden-check child');",
  '}',
  '',
].join('\n');

export const DEFAULT_GRADER_TIMEOUT_MS = 60_000;

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function stageTaskGrader(graderPath) {
  const canonicalGrader = realpathSync(graderPath);
  const taskDir = path.dirname(canonicalGrader);
  if (path.basename(canonicalGrader) !== 'grader.mjs' || !isWithin(EVAL_TASKS_DIR, taskDir)) {
    return {
      graderPath: canonicalGrader,
      readPaths: [canonicalGrader],
      cleanup: () => {},
    };
  }

  const relativeTaskDir = path.relative(EVAL_TASKS_DIR, taskDir);
  if (!relativeTaskDir || relativeTaskDir.includes(path.sep)) {
    throw new Error(`Unsupported eval grader location: ${canonicalGrader}`);
  }
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'ao-eval-grader-'));
  try {
    chmodSync(tempRoot, 0o700);
    const canonicalTempRoot = realpathSync(tempRoot);
    const stagedTaskDir = path.join(canonicalTempRoot, 'tasks', relativeTaskDir);
    const stagedLibDir = path.join(canonicalTempRoot, 'lib');
    mkdirSync(stagedTaskDir, { recursive: true, mode: 0o700 });
    mkdirSync(stagedLibDir, { recursive: true, mode: 0o700 });
    const stagedGraderPath = path.join(stagedTaskDir, 'grader.mjs');
    const stagedCandidateInvoke = path.join(stagedLibDir, 'candidate-invoke.mjs');
    const stagedGraderSubprocess = path.join(stagedLibDir, 'grader-subprocess.mjs');
    cpSync(CANDIDATE_INVOKE, stagedCandidateInvoke, { force: true });
    writeFileSync(stagedGraderSubprocess, HIDDEN_GRADER_SUBPROCESS_STUB, { mode: 0o600 });
    cpSync(canonicalGrader, stagedGraderPath, { force: true });
    return {
      graderPath: stagedGraderPath,
      // File-scoped grants prevent candidate code from enumerating the staged
      // root. Same-process grading still relies on coordinate redaction, but no
      // longer grants recursive read access to every copied harness module.
      readPaths: [stagedGraderPath, stagedCandidateInvoke, stagedGraderSubprocess],
      cleanup: () => rmSync(canonicalTempRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

function detail(error) {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

function tail(value) {
  const text = String(value ?? '').trim();
  return text.length > OUTPUT_LIMIT ? text.slice(-OUTPUT_LIMIT) : text;
}

function stableEnv() {
  const env = {
    CI: '1',
    NO_COLOR: '1',
    TZ: 'UTC',
    LANG: 'C',
    LC_ALL: 'C',
  };
  // Node needs SystemRoot to resolve system libraries on Windows. Avoid
  // inheriting mutable execution controls such as NODE_OPTIONS everywhere.
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

function boundedTimeout(value) {
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_GRADER_TIMEOUT_MS;
}

function permissionArgs(workdir, entryPoint, extraReadPaths = []) {
  const flags = process.allowedNodeEnvironmentFlags;
  const permissionFlag = flags?.has('--permission')
    ? '--permission'
    : flags?.has('--experimental-permission')
      ? '--experimental-permission'
      : null;
  if (!permissionFlag) {
    throw new Error('The Node permission model is required for bounded eval grading');
  }
  return [
    permissionFlag,
    `--allow-fs-read=${workdir}`,
    `--allow-fs-read=${CANDIDATE_INVOKE}`,
    // Node 20 applies the permission model to the main ESM entry point too.
    // Grant only that runner file, not evals/lib, so adjacent grader helpers
    // and source task oracles remain outside the child process read boundary.
    `--allow-fs-read=${entryPoint}`,
    ...extraReadPaths.map((value) => `--allow-fs-read=${value}`),
    `--allow-fs-write=${workdir}`,
  ];
}

function failureReason(error, label, timeoutMs) {
  if (error?.killed || error?.signal === 'SIGKILL' || error?.code === 'ETIMEDOUT') {
    return `${label} timed out after ${timeoutMs}ms`;
  }
  return `${label} exited ${error?.code ?? 'non-zero'}`;
}

function supervisorError(response) {
  if (response.timedOut) return { code: 'ETIMEDOUT', killed: true };
  if (response.overflow) return { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' };
  if (response.error) return { code: response.error.code, message: response.error.message };
  if (response.code !== 0) return { code: response.code, signal: response.signal };
  return null;
}

function execFileBounded(file, args, options, timeoutMs, input, callback) {
  if (file !== process.execPath) throw new Error('bounded grader execution only supports the current Node binary');
  const nonce = randomBytes(16).toString('hex');
  const child = execFile(
    process.execPath,
    [SUBPROCESS_SUPERVISOR],
    {
      cwd: options.cwd,
      env: options.env,
      timeout: timeoutMs + SUPERVISOR_GRACE_MS,
      killSignal: 'SIGKILL',
      // Supervisor output is JSON containing escaped child output.
      maxBuffer: (options.maxBuffer ?? MAX_BUFFER) * 8 + 64 * 1024,
      shell: false,
      windowsHide: true,
    },
    (error, stdout, stderr) => {
      if (error) {
        callback(error, '', stderr);
        return;
      }
      let response;
      try {
        response = JSON.parse(String(stdout).trim());
      } catch {
        callback({ code: 'EPROTO', message: 'invalid subprocess supervisor response' }, '', stderr);
        return;
      }
      if (response?.schemaVersion !== 1 || response.nonce !== nonce) {
        callback({ code: 'EPROTO', message: 'mismatched subprocess supervisor response' }, '', stderr);
        return;
      }
      callback(supervisorError(response), response.stdout ?? '', response.stderr ?? '');
    },
  );
  child.stdin?.on('error', () => {});
  child.stdin?.end(JSON.stringify({
    schemaVersion: 1,
    nonce,
    args,
    cwd: options.cwd,
    env: options.env,
    timeoutMs,
    maxBuffer: options.maxBuffer ?? MAX_BUFFER,
    input,
  }));
  return child;
}

/** Run public Node tests without loading candidate code in the eval runner. */
export function runPublicTests(workdir, options = {}) {
  const timeoutMs = boundedTimeout(options.timeoutMs);
  return new Promise((resolve) => {
    try {
      const canonicalWorkdir = realpathSync(workdir);
      execFileBounded(
        process.execPath,
        [...permissionArgs(canonicalWorkdir, PUBLIC_TEST_RUNNER), PUBLIC_TEST_RUNNER, canonicalWorkdir],
        {
          cwd: canonicalWorkdir,
          env: stableEnv(),
          maxBuffer: MAX_BUFFER,
          shell: false,
          windowsHide: true,
        },
        timeoutMs,
        null,
        (error, stdout, stderr) => {
          const output = tail([stdout, stderr].filter(Boolean).join('\n'));
          if (error) {
            const reason = failureReason(error, 'node --test', timeoutMs);
            resolve({
              name: 'tests-pass',
              pass: false,
              detail: output ? `${reason}\n${output}` : reason,
            });
            return;
          }
          resolve({ name: 'tests-pass', pass: true, detail: output || 'node --test passed' });
        },
      );
    } catch (error) {
      resolve({ name: 'tests-pass', pass: false, detail: detail(error) });
    }
  });
}

function parseChildResult(stdout, marker, fallbackName) {
  const output = String(stdout ?? '');
  const markerIndex = output.lastIndexOf(marker);
  if (markerIndex === -1) return null;
  const line = output.slice(markerIndex + marker.length).split(/\r?\n/, 1)[0];
  try {
    const value = JSON.parse(line);
    return {
      name: typeof value?.name === 'string' ? value.name : fallbackName,
      pass: Boolean(value?.pass),
      detail: value?.detail == null ? '' : String(value.detail),
    };
  } catch {
    return null;
  }
}

/**
 * Run a grader export in a disposable Node process. The export may import and
 * call candidate code; the parent eval runner never does. A missing result is
 * a failure even when hostile candidate code calls process.exit(0).
 */
export function runIsolatedCheck({ workdir, graderUrl, exportName, name, timeoutMs: requestedTimeout }) {
  const timeoutMs = boundedTimeout(requestedTimeout);
  return new Promise((resolve) => {
    let stagedGrader;
    try {
      const canonicalWorkdir = realpathSync(workdir);
      stagedGrader = stageTaskGrader(fileURLToPath(graderUrl));
      const nonce = randomBytes(16).toString('hex');
      const resultMarker = `${RESULT_MARKER}${nonce}:`;
      execFileBounded(
        process.execPath,
        [...permissionArgs(canonicalWorkdir, CHILD_RUNNER, stagedGrader.readPaths), CHILD_RUNNER],
        {
          cwd: canonicalWorkdir,
          env: stableEnv(),
          maxBuffer: MAX_BUFFER,
          shell: false,
          windowsHide: true,
        },
        timeoutMs,
        JSON.stringify({
          nonce,
          graderUrl: pathToFileURL(realpathSync(stagedGrader.graderPath)).href,
          exportName,
          workdir: canonicalWorkdir,
        }),
        (error, stdout, stderr) => {
          stagedGrader.cleanup();
          const fallbackName = name || 'hidden-check';
          const output = tail([stdout, stderr].filter(Boolean).join('\n'));
          if (error) {
            const reason = failureReason(error, 'isolated check', timeoutMs);
            resolve({ name: fallbackName, pass: false, detail: output ? `${reason}\n${output}` : reason });
            return;
          }
          const result = parseChildResult(stdout, resultMarker, fallbackName);
          if (!result) {
            resolve({
              name: fallbackName,
              pass: false,
              detail: output
                ? `isolated check exited without a valid result\n${output}`
                : 'isolated check exited without a valid result',
            });
            return;
          }
          resolve(result);
        },
      );
    } catch (error) {
      stagedGrader?.cleanup();
      resolve({ name: name || 'hidden-check', pass: false, detail: detail(error) });
    }
  });
}

/** Run public and hidden checks in a fixed order and always return both results. */
export async function gradeCandidate({ workdir, graderUrl, hiddenExport, hiddenName, timeoutMs }) {
  try {
    // The checks share a candidate workdir. Running them concurrently lets a
    // test that writes files race hidden validation and breaks determinism.
    const publicCheck = await runPublicTests(workdir, { timeoutMs });
    const hiddenCheck = await runIsolatedCheck({
      workdir,
      graderUrl,
      exportName: hiddenExport,
      name: hiddenName,
      timeoutMs,
    });
    const checks = [publicCheck, hiddenCheck];
    return { pass: checks.every((check) => check.pass), checks };
  } catch (error) {
    return {
      pass: false,
      checks: [{ name: 'grader-error', pass: false, detail: detail(error) }],
    };
  }
}
