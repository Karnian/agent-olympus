import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { importCandidate, invokeCandidate } from '../../lib/candidate-invoke.mjs';
import { gradeCandidate } from '../../lib/grader-subprocess.mjs';

const assertDeepEqual = assert.deepEqual.bind(assert);
const safeString = String;
const safeStringify = JSON.stringify;

function detail(error) {
  return error instanceof Error ? error.message : safeString(error ?? 'unknown error');
}

export async function hiddenCases(workdir) {
  try {
    const moduleUrl = pathToFileURL(path.join(workdir, 'src', 'lastN.mjs')).href;
    const { lastN } = await importCandidate(moduleUrl);
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
    for (let index = 0; index < cases.length; index += 1) {
      const arr = cases[index][0];
      const n = cases[index][1];
      const expected = cases[index][2];
      try {
        assertDeepEqual(await invokeCandidate(lastN, [arr, n]), expected);
      } catch {
        return {
          name: 'lastN-boundary',
          pass: false,
          detail: `lastN(${safeStringify(arr)}, ${n}) did not return ${safeStringify(expected)}`,
        };
      }
    }
    return { name: 'lastN-boundary', pass: true, detail: 'lastN returns the correct suffix boundaries' };
  } catch (error) {
    return { name: 'lastN-boundary', pass: false, detail: detail(error) };
  }
}

export async function grade(workdir, options = {}) {
  return gradeCandidate({
    workdir,
    graderUrl: import.meta.url,
    hiddenExport: 'hiddenCases',
    hiddenName: 'lastN-boundary',
    timeoutMs: options.timeoutMs,
  });
}
