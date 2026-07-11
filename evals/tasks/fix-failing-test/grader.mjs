import { execFile } from 'node:child_process';
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

async function checkSumAdds(workdir) {
  try {
    const moduleUrl = pathToFileURL(path.join(workdir, 'src', 'sum.mjs')).href;
    const { sum } = await import(moduleUrl);
    if (typeof sum !== 'function') {
      return { name: 'sum-adds', pass: false, detail: 'sum export is not a function' };
    }

    const cases = [
      [2, 3, 5],
      [-4, 6, 2],
      [10, -3, 7],
      [0, 0, 0],
    ];
    const failed = cases.find(([a, b, expected]) => sum(a, b) !== expected);
    if (failed) {
      const [a, b, expected] = failed;
      return {
        name: 'sum-adds',
        pass: false,
        detail: `sum(${a}, ${b}) did not return ${expected}`,
      };
    }

    return { name: 'sum-adds', pass: true, detail: 'sum adds representative inputs' };
  } catch (error) {
    return {
      name: 'sum-adds',
      pass: false,
      detail: errorDetail(error),
    };
  }
}

export async function grade(workdir) {
  try {
    const checks = [
      await runTests(workdir),
      await checkSumAdds(workdir),
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
