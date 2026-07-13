import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { importCandidate, invokeCandidate } from '../../lib/candidate-invoke.mjs';
import { gradeCandidate } from '../../lib/grader-subprocess.mjs';

const safeString = String;
const safeStringify = JSON.stringify;

function detail(error) {
  return error instanceof Error ? error.message : safeString(error ?? 'unknown error');
}

export async function hiddenCases(workdir) {
  try {
    const moduleUrl = pathToFileURL(path.join(workdir, 'src', 'greet.mjs')).href;
    const { greet } = await importCandidate(moduleUrl);
    if (typeof greet !== 'function') {
      return { name: 'greet-null-safe', pass: false, detail: 'greet export is not a function' };
    }

    const cases = [
      [null, 'HELLO, GUEST'],
      [{}, 'HELLO, GUEST'],
      [{ name: '' }, 'HELLO, GUEST'],
      [{ name: 'ada' }, 'HELLO, ADA'],
    ];
    for (let index = 0; index < cases.length; index += 1) {
      const input = cases[index][0];
      const expected = cases[index][1];
      if (await invokeCandidate(greet, [input]) !== expected) {
        return {
          name: 'greet-null-safe',
          pass: false,
          detail: `greet(${safeStringify(input)}) did not return ${expected}`,
        };
      }
    }
    return { name: 'greet-null-safe', pass: true, detail: 'greet handles null, nameless, and named users' };
  } catch (error) {
    return { name: 'greet-null-safe', pass: false, detail: detail(error) };
  }
}

export async function grade(workdir, options = {}) {
  return gradeCandidate({
    workdir,
    graderUrl: import.meta.url,
    hiddenExport: 'hiddenCases',
    hiddenName: 'greet-null-safe',
    timeoutMs: options.timeoutMs,
  });
}
