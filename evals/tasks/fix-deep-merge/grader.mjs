import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { importCandidate, invokeCandidate } from '../../lib/candidate-invoke.mjs';
import { gradeCandidate } from '../../lib/grader-subprocess.mjs';

const assertEqual = assert.equal.bind(assert);
const assertDeepEqual = assert.deepEqual.bind(assert);
const safeStructuredClone = structuredClone;

function detail(error) {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

export async function hiddenCases(workdir) {
  try {
    const { mergeConfig } = await importCandidate(pathToFileURL(path.join(workdir, 'src/mergeConfig.mjs')).href);
    assertEqual(typeof mergeConfig, 'function');
    const base = { a: { b: { c: 1 }, keep: true }, list: [{ n: 1 }] };
    const override = { a: { b: { d: 2 } }, list: [{ n: 9 }] };
    const baseBefore = safeStructuredClone(base);
    const overrideBefore = safeStructuredClone(override);
    const merged = await invokeCandidate(mergeConfig, [base, override]);
    assertDeepEqual(merged, { a: { b: { c: 1, d: 2 }, keep: true }, list: [{ n: 9 }] });
    assertDeepEqual(base, baseBefore);
    assertDeepEqual(override, overrideBefore);
    merged.a.b.c = 7;
    merged.list[0].n = 8;
    assertDeepEqual(base, baseBefore);
    assertDeepEqual(override, overrideBefore);
    return { name: 'deep-merge-invariants', pass: true, detail: 'nested merge, array replacement, and immutability hold' };
  } catch (error) {
    return { name: 'deep-merge-invariants', pass: false, detail: detail(error) };
  }
}

export async function grade(workdir, options = {}) {
  return gradeCandidate({
    workdir,
    graderUrl: import.meta.url,
    hiddenExport: 'hiddenCases',
    hiddenName: 'deep-merge-invariants',
    timeoutMs: options.timeoutMs,
  });
}
