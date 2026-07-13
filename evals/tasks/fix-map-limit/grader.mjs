import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  importCandidate,
  invokeCandidate,
  opaqueCallback,
} from '../../lib/candidate-invoke.mjs';
import { gradeCandidate } from '../../lib/grader-subprocess.mjs';

const assertDeepEqual = assert.deepEqual.bind(assert);
const assertOk = assert.ok.bind(assert);
const assertRejects = assert.rejects.bind(assert);
const SafeSet = Set;
const SafePromise = Promise;
const safePromiseResolve = Promise.resolve.bind(Promise);
const safeSetImmediate = setImmediate;
const safeMathMax = Math.max.bind(Math);
const safeArrayPush = Function.call.bind(Array.prototype.push);
const safeArraySlice = Function.call.bind(Array.prototype.slice);
const safeString = String;

function detail(error) {
  return error instanceof Error ? error.message : safeString(error ?? 'unknown error');
}

export async function hiddenCases(workdir) {
  try {
    const { mapLimit } = await importCandidate(pathToFileURL(path.join(workdir, 'src/mapLimit.mjs')).href);
    let active = 0;
    let peak = 0;
    const seenIndexes = [];
    let release;
    const gate = new SafePromise((resolve) => { release = resolve; });
    const mapper = opaqueCallback(async (value, index) => {
      active += 1;
      peak = safeMathMax(peak, active);
      safeArrayPush(seenIndexes, index);
      await gate;
      active -= 1;
      return `${index}:${value}`;
    });
    const pending = invokeCandidate(mapLimit, [[4, 3, 2, 1, 0], 3, mapper]);
    await new SafePromise((resolve) => safeSetImmediate(resolve));
    const initiallySeenIndexes = safeArraySlice(seenIndexes);
    release();
    const values = await pending;
    assertDeepEqual(initiallySeenIndexes, [0, 1, 2]);
    assertOk(peak <= 3 && peak > 1);
    assertDeepEqual(values, ['0:4', '1:3', '2:2', '3:1', '4:0']);
    assertDeepEqual(seenIndexes, [0, 1, 2, 3, 4]);
    assertDeepEqual(new SafeSet(seenIndexes).size, 5);
    assertDeepEqual(await invokeCandidate(mapLimit, [[], 2, async () => 'never']), []);

    const mapperFailure = { code: 'mapper-failed' };
    await assertRejects(
      invokeCandidate(mapLimit, [[0, 1, 2], 2, opaqueCallback(async (value) => {
        if (value === 1) throw mapperFailure;
        await safePromiseResolve();
        return value;
      })]),
      (error) => error === mapperFailure,
    );
    return {
      name: 'map-limit-invariants',
      pass: true,
      detail: 'bounded parallelism, ordering, indexes, empty input, and mapper rejection hold',
    };
  } catch (error) {
    return { name: 'map-limit-invariants', pass: false, detail: detail(error) };
  }
}

export async function grade(workdir, options = {}) {
  return gradeCandidate({
    workdir,
    graderUrl: import.meta.url,
    hiddenExport: 'hiddenCases',
    hiddenName: 'map-limit-invariants',
    timeoutMs: options.timeoutMs,
  });
}
