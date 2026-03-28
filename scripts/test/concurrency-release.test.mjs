/**
 * Tests for scripts/concurrency-release.mjs
 *
 * Tests via child_process: pipe PostToolUse JSON on stdin, observe stdout
 * and the resulting .ao/state/ao-concurrency.json state file.
 * Tests cover:
 *   - non-Task/Agent tool_name → outputs {} without touching state
 *   - Task tool_name, no existing state → outputs {} gracefully
 *   - releases the oldest matching provider task from activeTasks
 *   - does not release tasks for a different provider
 *   - prunes stale tasks (>10 min old) regardless of provider
 *   - prunes stale tasks while also releasing a matching fresh task
 *   - empty activeTasks after release → state is valid JSON
 *
 * Uses node:test — zero npm dependencies.
 * All I/O uses temporary directories; the real .ao/ directory is never touched.
 *
 * NOTE: concurrency-release.mjs resolves STATE_FILE relative to process.cwd()
 * at module load time, so we cannot override it via `cwd:` at exec time.
 * We therefore set the working directory via the `cwd` option of execSync,
 * but must also ensure the script re-evaluates STATE_FILE — we use a wrapper
 * that cd-s into tmpDir before invoking the script, so process.cwd() resolves
 * to our tmpDir during module evaluation.
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
const SCRIPT = path.resolve(__dirname, '..', 'concurrency-release.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ao-concurrency-release-test-'));
}

async function removeTmpDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

function stateFilePath(dir) {
  return path.join(dir, '.ao', 'state', 'ao-concurrency.json');
}

/**
 * Run the concurrency-release hook with the given input,
 * with process.cwd() set to `cwd` so the script resolves STATE_FILE correctly.
 */
function runHook(input, cwd) {
  const json = JSON.stringify(input).replace(/'/g, "'\\''");
  // Use `cd <cwd> &&` so process.cwd() is the tmpDir when the ESM module is evaluated
  const raw = execSync(`cd "${cwd}" && echo '${json}' | node "${SCRIPT}"`, {
    encoding: 'utf-8',
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10000,
  });
  return JSON.parse(raw.trim());
}

/**
 * Write an initial concurrency state to <dir>/.ao/state/ao-concurrency.json.
 */
function writeState(dir, activeTasks) {
  const stateDir = path.join(dir, '.ao', 'state');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    stateFilePath(dir),
    JSON.stringify({ activeTasks }, null, 2),
    { encoding: 'utf-8', mode: 0o600 },
  );
}

/**
 * Read and parse the current state file.
 */
function readState(dir) {
  const raw = readFileSync(stateFilePath(dir), 'utf-8');
  return JSON.parse(raw);
}

/**
 * Build a task object with the given provider and age offset in milliseconds.
 * Negative ageMs means the task started in the past.
 */
function makeTask(id, provider, ageMs = -1000) {
  return {
    id,
    provider,
    startedAt: new Date(Date.now() + ageMs).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Non-Task / non-Agent tool_name → state is unchanged
// ---------------------------------------------------------------------------

describe('concurrency-release: non-Task tool_name is ignored', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    writeState(tmpDir, [makeTask('task-1', 'claude')]);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('outputs {} for Bash tool_name', () => {
    const output = runHook({ tool_name: 'Bash', tool_input: {} }, tmpDir);
    assert.deepEqual(output, {});
  });

  it('does not modify state file for non-Task tool_name', () => {
    const before = readState(tmpDir);
    runHook({ tool_name: 'Read', tool_input: {} }, tmpDir);
    const after = readState(tmpDir);
    assert.deepEqual(after, before, 'state should be unchanged for non-Task tool');
  });
});

// ---------------------------------------------------------------------------
// No existing state file → outputs {} gracefully
// ---------------------------------------------------------------------------

describe('concurrency-release: no existing state file', () => {
  let tmpDir;
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async () => { await removeTmpDir(tmpDir); });

  it('outputs {} when state file does not exist', () => {
    const output = runHook(
      { tool_name: 'Task', tool_input: { subagent_type: 'agent-olympus:executor' } },
      tmpDir,
    );
    assert.deepEqual(output, {});
  });

  it('creates the state file with empty activeTasks', () => {
    runHook(
      { tool_name: 'Task', tool_input: { subagent_type: 'agent-olympus:executor' } },
      tmpDir,
    );
    assert.ok(existsSync(stateFilePath(tmpDir)), 'state file should be created');
    const state = readState(tmpDir);
    assert.ok(Array.isArray(state.activeTasks), 'activeTasks should be an array');
  });
});

// ---------------------------------------------------------------------------
// Releases oldest matching provider task
// ---------------------------------------------------------------------------

describe('concurrency-release: releases oldest matching claude task', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    writeState(tmpDir, [
      makeTask('claude-old', 'claude', -5 * 60 * 1000),  // 5 min ago (oldest)
      makeTask('claude-new', 'claude', -1 * 60 * 1000),  // 1 min ago
      makeTask('codex-task', 'codex',  -2 * 60 * 1000),  // unrelated provider
    ]);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('outputs {}', () => {
    const output = runHook(
      { tool_name: 'Task', tool_input: { subagent_type: 'agent-olympus:executor' } },
      tmpDir,
    );
    assert.deepEqual(output, {});
  });

  it('removes exactly one claude task (the oldest)', () => {
    const state = readState(tmpDir);
    const claudeTasks = state.activeTasks.filter(t => t.provider === 'claude');
    assert.equal(claudeTasks.length, 1, 'one claude task should remain');
  });

  it('keeps the newer claude task', () => {
    const state = readState(tmpDir);
    const claudeTasks = state.activeTasks.filter(t => t.provider === 'claude');
    assert.equal(claudeTasks[0].id, 'claude-new', 'the newer claude task should be retained');
  });

  it('does not touch the codex task', () => {
    const state = readState(tmpDir);
    const codexTasks = state.activeTasks.filter(t => t.provider === 'codex');
    assert.equal(codexTasks.length, 1, 'codex task should be unchanged');
    assert.equal(codexTasks[0].id, 'codex-task');
  });
});

// ---------------------------------------------------------------------------
// Different provider — does not release tasks for a different provider
// ---------------------------------------------------------------------------

describe('concurrency-release: does not release tasks for a different provider', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    writeState(tmpDir, [
      makeTask('gemini-task', 'gemini', -2 * 60 * 1000),
    ]);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('does not release a gemini task when claude task finishes', () => {
    // Simulate a claude task finishing (subagent_type defaults to claude provider)
    runHook(
      { tool_name: 'Task', tool_input: { subagent_type: 'agent-olympus:executor' } },
      tmpDir,
    );
    const state = readState(tmpDir);
    const geminiTasks = state.activeTasks.filter(t => t.provider === 'gemini');
    assert.equal(geminiTasks.length, 1, 'gemini task should not be released by claude completion');
  });
});

// ---------------------------------------------------------------------------
// Stale tasks are pruned regardless of provider
// ---------------------------------------------------------------------------

describe('concurrency-release: prunes stale tasks (>10 min)', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    writeState(tmpDir, [
      makeTask('stale-1', 'claude',  -11 * 60 * 1000), // 11 min ago — stale
      makeTask('stale-2', 'gemini',  -15 * 60 * 1000), // 15 min ago — stale
      makeTask('fresh-1', 'codex',    -3 * 60 * 1000), // 3 min ago — keep
    ]);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('removes stale tasks from state', () => {
    runHook(
      { tool_name: 'Task', tool_input: { subagent_type: 'agent-olympus:executor' } },
      tmpDir,
    );
    const state = readState(tmpDir);
    const ids = state.activeTasks.map(t => t.id);
    assert.ok(!ids.includes('stale-1'), 'stale-1 should be pruned');
    assert.ok(!ids.includes('stale-2'), 'stale-2 should be pruned');
  });

  it('retains fresh tasks from other providers', () => {
    const state = readState(tmpDir);
    const ids = state.activeTasks.map(t => t.id);
    assert.ok(ids.includes('fresh-1'), 'fresh codex task should be retained');
  });
});

// ---------------------------------------------------------------------------
// Prune stale AND release matching in a single call
// ---------------------------------------------------------------------------

describe('concurrency-release: prunes stale and releases matching in one pass', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    writeState(tmpDir, [
      makeTask('stale-claude',  'claude', -12 * 60 * 1000), // stale — pruned
      makeTask('fresh-claude',  'claude',  -2 * 60 * 1000), // released (oldest remaining)
      makeTask('fresh-claude2', 'claude',  -1 * 60 * 1000), // kept
      makeTask('stale-codex',   'codex',  -11 * 60 * 1000), // stale — pruned
    ]);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('correctly prunes stale tasks and releases one matching task', () => {
    runHook(
      { tool_name: 'Task', tool_input: { subagent_type: 'agent-olympus:executor' } },
      tmpDir,
    );
    const state = readState(tmpDir);
    const ids = state.activeTasks.map(t => t.id);

    assert.ok(!ids.includes('stale-claude'),  'stale-claude should be pruned');
    assert.ok(!ids.includes('stale-codex'),   'stale-codex should be pruned');
    assert.ok(!ids.includes('fresh-claude'),  'fresh-claude should be released');
    assert.ok(ids.includes('fresh-claude2'),  'fresh-claude2 should be retained');
  });

  it('leaves exactly one task after combined prune+release', () => {
    const state = readState(tmpDir);
    assert.equal(state.activeTasks.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Agent tool_name is handled same as Task
// ---------------------------------------------------------------------------

describe('concurrency-release: Agent tool_name is handled', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    writeState(tmpDir, [
      makeTask('claude-agent', 'claude', -1 * 60 * 1000),
    ]);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('releases a task when tool_name is Agent', () => {
    runHook(
      { tool_name: 'Agent', tool_input: { subagent_type: 'agent-olympus:executor' } },
      tmpDir,
    );
    const state = readState(tmpDir);
    const claudeTasks = state.activeTasks.filter(t => t.provider === 'claude');
    assert.equal(claudeTasks.length, 0, 'claude task should be released for Agent tool_name');
  });
});

// ---------------------------------------------------------------------------
// State file is always valid JSON after hook run
// ---------------------------------------------------------------------------

describe('concurrency-release: state file is always valid JSON', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    writeState(tmpDir, [makeTask('task-1', 'claude', -1000)]);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('state file contains valid JSON after release', () => {
    runHook(
      { tool_name: 'Task', tool_input: { subagent_type: 'agent-olympus:executor' } },
      tmpDir,
    );
    assert.doesNotThrow(() => readState(tmpDir), 'state file should be valid JSON after hook run');
  });

  it('activeTasks is always an array in the resulting state', () => {
    const state = readState(tmpDir);
    assert.ok(Array.isArray(state.activeTasks), 'activeTasks should be an array');
  });
});

// ---------------------------------------------------------------------------
// Codex provider detection via model field
// ---------------------------------------------------------------------------

describe('concurrency-release: provider detection via model field', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    writeState(tmpDir, [
      makeTask('codex-task', 'codex', -2 * 60 * 1000),
      makeTask('claude-task', 'claude', -1 * 60 * 1000),
    ]);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('releases codex task when model field indicates openai', () => {
    runHook(
      { tool_name: 'Task', tool_input: { model: 'codex-mini', subagent_type: '' } },
      tmpDir,
    );
    const state = readState(tmpDir);
    const codexTasks = state.activeTasks.filter(t => t.provider === 'codex');
    assert.equal(codexTasks.length, 0, 'codex task should be released when model is codex-mini');
  });

  it('retains claude task when codex provider is released', () => {
    const state = readState(tmpDir);
    const claudeTasks = state.activeTasks.filter(t => t.provider === 'claude');
    assert.equal(claudeTasks.length, 1, 'claude task should be retained');
  });
});
