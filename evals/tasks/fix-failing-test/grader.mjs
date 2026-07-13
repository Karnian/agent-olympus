import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { importCandidate, invokeCandidate } from '../../lib/candidate-invoke.mjs';
import { gradeCandidate } from '../../lib/grader-subprocess.mjs';

const safeString = String;

function detail(error) {
  return error instanceof Error ? error.message : safeString(error ?? 'unknown error');
}

export async function hiddenCases(workdir) {
  try {
    const moduleUrl = pathToFileURL(path.join(workdir, 'src', 'sum.mjs')).href;
    const { sum } = await importCandidate(moduleUrl);
    if (typeof sum !== 'function') {
      return { name: 'sum-adds', pass: false, detail: 'sum export is not a function' };
    }

    const cases = [
      [2, 3, 5],
      [-4, 6, 2],
      [10, -3, 7],
      [0, 0, 0],
    ];
    for (let index = 0; index < cases.length; index += 1) {
      const current = cases[index];
      const a = current[0];
      const b = current[1];
      const expected = current[2];
      if (await invokeCandidate(sum, [a, b]) !== expected) {
        return { name: 'sum-adds', pass: false, detail: `sum(${a}, ${b}) did not return ${expected}` };
      }
    }
    return { name: 'sum-adds', pass: true, detail: 'sum adds representative inputs' };
  } catch (error) {
    return { name: 'sum-adds', pass: false, detail: detail(error) };
  }
}

export async function grade(workdir, options = {}) {
  return gradeCandidate({
    workdir,
    graderUrl: import.meta.url,
    hiddenExport: 'hiddenCases',
    hiddenName: 'sum-adds',
    timeoutMs: options.timeoutMs,
  });
}
