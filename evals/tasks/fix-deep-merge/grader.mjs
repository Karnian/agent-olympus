import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TEST_TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT = 4_000;

function detail(error) {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

function runTests(workdir) {
  return new Promise((resolve) => {
    const env = { ...process.env, CI: '1', NO_COLOR: '1', TZ: 'UTC' };
    delete env.NODE_TEST_CONTEXT;
    try {
      execFile('node', ['--test'], {
        cwd: workdir,
        env,
        timeout: TEST_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      }, (error, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join('\n').trim().slice(-OUTPUT_LIMIT);
        resolve({
          name: 'tests-pass',
          pass: !error,
          detail: error ? (output || `node --test exited ${error.code ?? 'non-zero'}`) : (output || 'node --test passed'),
        });
      });
    } catch (error) {
      resolve({ name: 'tests-pass', pass: false, detail: detail(error) });
    }
  });
}

async function hiddenCases(workdir) {
  try {
    const { mergeConfig } = await import(pathToFileURL(path.join(workdir, 'src/mergeConfig.mjs')).href);
    assert.equal(typeof mergeConfig, 'function');
    const base = { a: { b: { c: 1 }, keep: true }, list: [{ n: 1 }] };
    const override = { a: { b: { d: 2 } }, list: [{ n: 9 }] };
    const merged = mergeConfig(base, override);
    assert.deepEqual(merged, { a: { b: { c: 1, d: 2 }, keep: true }, list: [{ n: 9 }] });
    merged.a.b.c = 7;
    merged.list[0].n = 8;
    assert.equal(base.a.b.c, 1);
    assert.equal(override.list[0].n, 9);
    return { name: 'deep-merge-invariants', pass: true, detail: 'nested merge, array replacement, and immutability hold' };
  } catch (error) {
    return { name: 'deep-merge-invariants', pass: false, detail: detail(error) };
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
