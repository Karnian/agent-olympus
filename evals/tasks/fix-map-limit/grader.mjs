import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TEST_TIMEOUT_MS = 60_000;

function detail(error) {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

function runTests(workdir) {
  return new Promise((resolve) => {
    const env = { ...process.env, CI: '1', NO_COLOR: '1', TZ: 'UTC' };
    delete env.NODE_TEST_CONTEXT;
    try {
      execFile('node', ['--test'], { cwd: workdir, env, timeout: TEST_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join('\n').trim().slice(-4000);
        resolve({ name: 'tests-pass', pass: !error, detail: error ? (output || detail(error)) : (output || 'node --test passed') });
      });
    } catch (error) {
      resolve({ name: 'tests-pass', pass: false, detail: detail(error) });
    }
  });
}

async function hiddenCases(workdir) {
  try {
    const { mapLimit } = await import(pathToFileURL(path.join(workdir, 'src/mapLimit.mjs')).href);
    let active = 0;
    let peak = 0;
    const seenIndexes = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const pending = mapLimit([4, 3, 2, 1, 0], 3, async (value, index) => {
      active += 1;
      peak = Math.max(peak, active);
      seenIndexes.push(index);
      await gate;
      active -= 1;
      return `${index}:${value}`;
    });
    await Promise.resolve();
    const initiallySeenIndexes = [...seenIndexes];
    release();
    const values = await pending;
    assert.deepEqual(initiallySeenIndexes, [0, 1, 2]);
    assert.ok(peak <= 3 && peak > 1);
    assert.deepEqual(values, ['0:4', '1:3', '2:2', '3:1', '4:0']);
    assert.deepEqual(new Set(seenIndexes).size, 5);
    assert.deepEqual(await mapLimit([], 2, async () => 'never'), []);
    return { name: 'map-limit-invariants', pass: true, detail: 'bounded parallelism, ordering, indexes, and empty input hold' };
  } catch (error) {
    return { name: 'map-limit-invariants', pass: false, detail: detail(error) };
  }
}

export async function grade(workdir) {
  try {
    const checks = [await runTests(workdir), await hiddenCases(workdir)];
    return { pass: checks.every((check) => check.pass), checks };
  } catch (error) {
    return { pass: false, checks: [{ name: 'grader-error', pass: false, detail: detail(error) }] };
  }
}
