import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TEST_TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT = 4_000;

function tail(value) {
  const text = String(value ?? '').trim();
  return text.length > OUTPUT_LIMIT ? text.slice(-OUTPUT_LIMIT) : text;
}

function errorDetail(error) {
  if (!error) {
    return 'unknown error';
  }
  return error instanceof Error ? error.message : String(error);
}

function testEnv() {
  const env = { ...process.env, CI: '1', NO_COLOR: '1', TZ: 'UTC' };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function runTests(workdir) {
  return new Promise((resolve) => {
    try {
      execFile(
        'node',
        ['--test'],
        {
          cwd: workdir,
          env: testEnv(),
          timeout: TEST_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const output = tail([stdout, stderr].filter(Boolean).join('\n'));
          if (error) {
            const reason = error.killed || error.signal
              ? 'node --test timed out'
              : `node --test exited ${error.code ?? 'non-zero'}`;
            resolve({
              name: 'tests-pass',
              pass: false,
              detail: output ? `${reason}\n${output}` : reason,
            });
            return;
          }

          resolve({
            name: 'tests-pass',
            pass: true,
            detail: output || 'node --test passed',
          });
        },
      );
    } catch (error) {
      resolve({
        name: 'tests-pass',
        pass: false,
        detail: errorDetail(error),
      });
    }
  });
}

async function checkLastNBoundary(workdir) {
  try {
    const moduleUrl = pathToFileURL(path.join(workdir, 'src', 'lastN.mjs')).href;
    const { lastN } = await import(moduleUrl);
    if (typeof lastN !== 'function') {
      return { name: 'lastN-boundary', pass: false, detail: 'lastN export is not a function' };
    }

    const cases = [
      [[1, 2, 3, 4], 2, [3, 4]],
      [[1, 2, 3], 3, [1, 2, 3]],
      [[1, 2, 3], 1, [3]],
      [[1, 2, 3], 0, []],
      [[1, 2], 5, [1, 2]],
    ];

    for (const [arr, n, expected] of cases) {
      try {
        assert.deepEqual(lastN(arr, n), expected);
      } catch {
        return {
          name: 'lastN-boundary',
          pass: false,
          detail: `lastN(${JSON.stringify(arr)}, ${n}) did not return ${JSON.stringify(expected)}`,
        };
      }
    }

    return {
      name: 'lastN-boundary',
      pass: true,
      detail: 'lastN returns the correct suffix boundaries',
    };
  } catch (error) {
    return {
      name: 'lastN-boundary',
      pass: false,
      detail: errorDetail(error),
    };
  }
}

export async function grade(workdir) {
  try {
    const checks = [
      await runTests(workdir),
      await checkLastNBoundary(workdir),
    ];
    return {
      pass: checks.every((check) => check.pass),
      checks,
    };
  } catch (error) {
    return {
      pass: false,
      checks: [{ name: 'grader-error', pass: false, detail: errorDetail(error) }],
    };
  }
}
