/**
 * Unit tests for scripts/lib/stdin.mjs
 * Tests readStdin() behavior using child_process to simulate real stdin scenarios.
 * We cannot pipe data into process.stdin of the current test runner directly,
 * so each behavioral test spawns a tiny child process and checks its output.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readStdin } from '../lib/stdin.mjs';

const SCRIPTS_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');

// ---------------------------------------------------------------------------
// Test: module contract
// ---------------------------------------------------------------------------

test('readStdin: exported as an async function', () => {
  assert.equal(typeof readStdin, 'function');
  // AsyncFunction.constructor.name is 'AsyncFunction'
  assert.equal(readStdin.constructor.name, 'AsyncFunction');
});

test('readStdin: returns a Promise', () => {
  // Call with an impossibly short timeout so it resolves immediately.
  // We must consume the promise to avoid unhandled rejection noise.
  const p = readStdin(1);
  assert.ok(p instanceof Promise);
  return p; // let node:test await it
});

// ---------------------------------------------------------------------------
// Test: behavioral tests via child processes
// ---------------------------------------------------------------------------

test('readStdin: reads piped stdin data correctly', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import { readStdin } from '${SCRIPTS_ROOT}/scripts/lib/stdin.mjs';
        const data = await readStdin(2000);
        process.stdout.write(data);
      `,
    ],
    {
      input: 'hello world',
      encoding: 'utf-8',
      timeout: 8000,
    }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.equal(result.stdout, 'hello world');
});

test('readStdin: returns empty string when stdin closes with no data', () => {
  // spawnSync with no `input` option → stdin is /dev/null (empty, closes immediately)
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import { readStdin } from '${SCRIPTS_ROOT}/scripts/lib/stdin.mjs';
        const data = await readStdin(2000);
        process.stdout.write(JSON.stringify({ data }));
      `,
    ],
    {
      encoding: 'utf-8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'pipe'], // stdin = /dev/null
    }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.data, '');
});

test('readStdin: reads multi-chunk / multi-line input', () => {
  const payload = 'line1\nline2\nline3\n{"key":"value"}';
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import { readStdin } from '${SCRIPTS_ROOT}/scripts/lib/stdin.mjs';
        const data = await readStdin(2000);
        process.stdout.write(data);
      `,
    ],
    {
      input: payload,
      encoding: 'utf-8',
      timeout: 8000,
    }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.equal(result.stdout, payload);
});

test('readStdin: returns a string (not a Buffer) for UTF-8 input', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import { readStdin } from '${SCRIPTS_ROOT}/scripts/lib/stdin.mjs';
        const data = await readStdin(2000);
        process.stdout.write(JSON.stringify({ type: typeof data }));
      `,
    ],
    {
      input: '{"hello":"world"}',
      encoding: 'utf-8',
      timeout: 8000,
    }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.type, 'string');
});
