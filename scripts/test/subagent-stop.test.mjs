/**
 * Tests for scripts/subagent-stop.mjs
 *
 * Tests via child_process: pipe JSON on stdin, observe stdout and state file.
 * Tests cover:
 *   - captures result with timestamp and structured fields
 *   - caps at MAX_RESULTS (50), FIFO removal of oldest
 *   - handles empty/missing last_assistant_message gracefully (outputs {}, no write)
 *   - creates state dir if missing
 *   - always outputs valid JSON (fail-safe)
 *
 * Uses node:test — zero npm dependencies.
 * All I/O uses temporary directories; the real .ao/ directory is never touched.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '..', 'subagent-stop.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ao-subagent-stop-test-'));
}

async function removeTmpDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Run the subagent-stop hook with the given JSON payload.
 * Returns parsed JSON output from stdout.
 */
function runHook(payload, cwd) {
  const json = JSON.stringify(payload).replace(/'/g, "'\\''");
  const raw = execSync(`echo '${json}' | node "${SCRIPT}"`, {
    encoding: 'utf-8',
    cwd,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10000,
  });
  return JSON.parse(raw.trim());
}

/**
 * Read the results file from the given tmp directory.
 */
function readResults(dir) {
  const file = path.join(dir, '.ao', 'state', 'ao-subagent-results.json');
  return JSON.parse(readFileSync(file, 'utf-8'));
}

/** Build a valid SubagentStop payload with a non-empty message. */
function makePayload(overrides = {}) {
  return {
    last_assistant_message: 'Task completed successfully.',
    tool_name: 'Task',
    tool_input: { subagent_type: 'agent-olympus:executor' },
    agent_transcript_path: '/tmp/transcript.json',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Basic capture
// ---------------------------------------------------------------------------

describe('subagent-stop: captures result with timestamp', () => {
  let tmpDir;
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async () => { await removeTmpDir(tmpDir); });

  it('outputs {}', () => {
    const output = runHook(makePayload(), tmpDir);
    assert.deepEqual(output, {});
  });

  it('writes ao-subagent-results.json with one entry', () => {
    const results = readResults(tmpDir);
    assert.equal(results.length, 1);
  });

  it('entry has a timestamp', () => {
    const results = readResults(tmpDir);
    assert.ok(results[0].timestamp, 'entry should have a timestamp');
    assert.doesNotThrow(() => new Date(results[0].timestamp), 'timestamp should be parseable');
  });

  it('entry captures toolName and agentType', () => {
    const results = readResults(tmpDir);
    assert.equal(results[0].toolName, 'Task');
    assert.equal(results[0].agentType, 'agent-olympus:executor');
  });

  it('entry captures transcriptPath', () => {
    const results = readResults(tmpDir);
    assert.equal(results[0].transcriptPath, '/tmp/transcript.json');
  });

  it('entry captures lastMessage content', () => {
    const results = readResults(tmpDir);
    assert.ok(results[0].lastMessage.includes('Task completed successfully.'));
  });
});

// ---------------------------------------------------------------------------
// State dir created when missing
// ---------------------------------------------------------------------------

describe('subagent-stop: creates state directory if missing', () => {
  let tmpDir;
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async () => { await removeTmpDir(tmpDir); });

  it('creates .ao/state/ and results file even when directory does not exist', () => {
    const stateDir = path.join(tmpDir, '.ao', 'state');
    assert.ok(!existsSync(stateDir), 'state dir should not exist before hook runs');

    runHook(makePayload(), tmpDir);

    assert.ok(existsSync(stateDir), 'state dir should be created by the hook');
    assert.ok(
      existsSync(path.join(stateDir, 'ao-subagent-results.json')),
      'results file should be created',
    );
  });
});

// ---------------------------------------------------------------------------
// Empty / missing last_assistant_message — no write
// ---------------------------------------------------------------------------

describe('subagent-stop: empty last_assistant_message is skipped', () => {
  let tmpDir;
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async () => { await removeTmpDir(tmpDir); });

  it('outputs {} for empty string message', () => {
    const output = runHook({ last_assistant_message: '' }, tmpDir);
    assert.deepEqual(output, {});
  });

  it('does not create results file when message is empty', () => {
    const file = path.join(tmpDir, '.ao', 'state', 'ao-subagent-results.json');
    assert.ok(!existsSync(file), 'results file should not be created for empty message');
  });
});

describe('subagent-stop: missing last_assistant_message field is skipped', () => {
  let tmpDir;
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async () => { await removeTmpDir(tmpDir); });

  it('outputs {} when last_assistant_message is absent', () => {
    const output = runHook({ tool_name: 'Task' }, tmpDir);
    assert.deepEqual(output, {});
  });

  it('does not create results file when field is absent', () => {
    const file = path.join(tmpDir, '.ao', 'state', 'ao-subagent-results.json');
    assert.ok(!existsSync(file), 'results file should not be created when message field is missing');
  });
});

describe('subagent-stop: whitespace-only message is skipped', () => {
  let tmpDir;
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async () => { await removeTmpDir(tmpDir); });

  it('outputs {} for whitespace-only message', () => {
    const output = runHook({ last_assistant_message: '   \n\t  ' }, tmpDir);
    assert.deepEqual(output, {});
  });
});

// ---------------------------------------------------------------------------
// FIFO cap at 50 entries
// ---------------------------------------------------------------------------

describe('subagent-stop: caps results at MAX_RESULTS (50)', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();

    // Pre-populate results file with 50 entries
    const stateDir = path.join(tmpDir, '.ao', 'state');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const existing = Array.from({ length: 50 }, (_, i) => ({
      timestamp: new Date(Date.now() - (50 - i) * 1000).toISOString(),
      toolName: 'Task',
      agentType: 'agent-olympus:executor',
      transcriptPath: null,
      lastMessage: `Message number ${i + 1}`,
    }));
    writeFileSync(
      path.join(stateDir, 'ao-subagent-results.json'),
      JSON.stringify(existing, null, 2),
      { encoding: 'utf-8', mode: 0o600 },
    );
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('still outputs {} after adding the 51st entry', () => {
    const output = runHook(makePayload({ last_assistant_message: 'Entry 51' }), tmpDir);
    assert.deepEqual(output, {});
  });

  it('results file has exactly 50 entries after overflow', () => {
    const results = readResults(tmpDir);
    assert.equal(results.length, 50, 'should cap at 50 entries');
  });

  it('oldest entry is removed (FIFO)', () => {
    const results = readResults(tmpDir);
    // "Message number 1" was the oldest and should be gone
    const hasOldest = results.some(r => r.lastMessage === 'Message number 1');
    assert.ok(!hasOldest, 'oldest entry should have been evicted');
  });

  it('newest entry (51st) is present', () => {
    const results = readResults(tmpDir);
    const hasNewest = results.some(r => r.lastMessage === 'Entry 51');
    assert.ok(hasNewest, 'newly added entry should be present');
  });
});

// ---------------------------------------------------------------------------
// Large lastMessage is capped at 4000 chars
// ---------------------------------------------------------------------------

describe('subagent-stop: caps lastMessage at 4000 chars', () => {
  let tmpDir;
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async () => { await removeTmpDir(tmpDir); });

  it('truncates oversized lastMessage to 4000 chars', () => {
    const bigMessage = 'x'.repeat(10000);
    runHook(makePayload({ last_assistant_message: bigMessage }), tmpDir);
    const results = readResults(tmpDir);
    assert.ok(results[0].lastMessage.length <= 4000, 'lastMessage should be capped at 4000 chars');
  });
});

// ---------------------------------------------------------------------------
// Multiple appends accumulate correctly
// ---------------------------------------------------------------------------

describe('subagent-stop: multiple sequential calls accumulate results', () => {
  let tmpDir;
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async () => { await removeTmpDir(tmpDir); });

  it('accumulates three entries from three separate calls', () => {
    runHook(makePayload({ last_assistant_message: 'First result' }), tmpDir);
    runHook(makePayload({ last_assistant_message: 'Second result' }), tmpDir);
    runHook(makePayload({ last_assistant_message: 'Third result' }), tmpDir);

    const results = readResults(tmpDir);
    assert.equal(results.length, 3);
    assert.equal(results[0].lastMessage, 'First result');
    assert.equal(results[1].lastMessage, 'Second result');
    assert.equal(results[2].lastMessage, 'Third result');
  });
});

// ---------------------------------------------------------------------------
// Fail-safe — always valid JSON
// ---------------------------------------------------------------------------

describe('subagent-stop: fail-safe — always valid JSON', () => {
  it('outputs valid JSON for non-JSON stdin', () => {
    const raw = execSync(`echo 'not json' | node "${SCRIPT}"`, {
      encoding: 'utf-8',
      cwd: os.tmpdir(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    assert.doesNotThrow(() => JSON.parse(raw.trim()), 'output should be valid JSON even for bad input');
  });

  it('outputs valid JSON for empty stdin', () => {
    const raw = execSync(`echo '' | node "${SCRIPT}"`, {
      encoding: 'utf-8',
      cwd: os.tmpdir(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    assert.doesNotThrow(() => JSON.parse(raw.trim()), 'output should be valid JSON for empty stdin');
  });
});
