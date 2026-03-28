/**
 * Tests for scripts/model-router.mjs (the PreToolUse hook)
 *
 * Tests via child_process: pipe PreToolUse JSON on stdin, read stdout JSON.
 * Tests cover:
 *   - DISABLE_AO guard
 *   - non-Task tool_name → passes through silently
 *   - Task tool_name, no intent state → passes through silently
 *   - Task tool_name, stale intent state (>10 min) → passes through silently
 *   - Task tool_name, valid intent state → injects MODEL ROUTING context
 *   - Agent tool_name is also handled
 *   - hookSpecificOutput shape and content
 *
 * Uses node:test — zero npm dependencies.
 * All I/O uses temporary directories; the real .ao/ directory is never touched.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '..', 'model-router.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ao-model-router-hook-test-'));
}

async function removeTmpDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Run the model-router hook with the given input in `cwd`.
 * Returns parsed JSON output.
 */
function runHook(input, { cwd, env = {} } = {}) {
  const json = JSON.stringify(input).replace(/'/g, "'\\''");
  const raw = execSync(`echo '${json}' | node "${SCRIPT}"`, {
    encoding: 'utf-8',
    cwd: cwd || os.tmpdir(),
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10000,
  });
  return JSON.parse(raw.trim());
}

/**
 * Write an intent state file into <dir>/.ao/state/ao-intent.json.
 * `savedAt` defaults to now (fresh); pass a timestamp to simulate staleness.
 */
function writeIntentState(dir, intentData, savedAt = null) {
  const stateDir = path.join(dir, '.ao', 'state');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(stateDir, 'ao-intent.json'),
    JSON.stringify({
      category: intentData.category ?? 'deep',
      confidence: intentData.confidence ?? 0.85,
      scores: intentData.scores ?? { deep: 2.0, planning: 0.5 },
      savedAt: savedAt ?? new Date().toISOString(),
    }, null, 2),
    { encoding: 'utf-8', mode: 0o600 },
  );
}

// ---------------------------------------------------------------------------
// DISABLE_AO guard
// ---------------------------------------------------------------------------

describe('model-router-hook: DISABLE_AO guard', () => {
  it('passes through with suppressOutput when DISABLE_AO=1', () => {
    const output = runHook(
      { tool_name: 'Task', tool_input: { subagent_type: 'agent-olympus:architect' } },
      { env: { DISABLE_AO: '1' } },
    );
    assert.equal(output.continue, true);
    assert.equal(output.suppressOutput, true);
    assert.ok(!output.hookSpecificOutput, 'should not inject routing context when disabled');
  });
});

// ---------------------------------------------------------------------------
// Non-Task tool_name → passes through silently
// ---------------------------------------------------------------------------

describe('model-router-hook: non-Task tool_name is ignored', () => {
  it('passes through with suppressOutput for Bash tool', () => {
    const output = runHook({ tool_name: 'Bash', tool_input: { command: 'ls' } });
    assert.equal(output.continue, true);
    assert.equal(output.suppressOutput, true);
  });

  it('passes through with suppressOutput for Read tool', () => {
    const output = runHook({ tool_name: 'Read', tool_input: { file_path: '/tmp/foo' } });
    assert.equal(output.continue, true);
    assert.equal(output.suppressOutput, true);
  });

  it('passes through with suppressOutput for Edit tool', () => {
    const output = runHook({ tool_name: 'Edit', tool_input: {} });
    assert.equal(output.continue, true);
    assert.equal(output.suppressOutput, true);
  });
});

// ---------------------------------------------------------------------------
// Missing intent state → passes through silently
// ---------------------------------------------------------------------------

describe('model-router-hook: missing intent state file', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    // No .ao/state/ao-intent.json written
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('passes through when intent state file is absent', () => {
    const output = runHook(
      {
        tool_name: 'Task',
        tool_input: { subagent_type: 'agent-olympus:executor' },
        cwd: tmpDir,
      },
      { cwd: tmpDir },
    );
    assert.equal(output.continue, true);
    assert.equal(output.suppressOutput, true);
    assert.ok(!output.hookSpecificOutput, 'should not inject routing context with no intent state');
  });
});

// ---------------------------------------------------------------------------
// Stale intent state (>10 min old) → passes through silently
// ---------------------------------------------------------------------------

describe('model-router-hook: stale intent state is ignored', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    writeIntentState(tmpDir, { category: 'deep', confidence: 0.9 }, elevenMinutesAgo);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('passes through when intent state is older than 10 minutes', () => {
    const output = runHook(
      {
        tool_name: 'Task',
        tool_input: { subagent_type: 'agent-olympus:architect' },
        cwd: tmpDir,
      },
      { cwd: tmpDir },
    );
    assert.equal(output.continue, true);
    assert.equal(output.suppressOutput, true);
    assert.ok(
      !output.hookSpecificOutput,
      'should not inject routing context for stale intent state',
    );
  });
});

describe('model-router-hook: intent state exactly at 10 min boundary', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    // Exactly 10 minutes and 1 second ago — should be stale
    const justOverTen = new Date(Date.now() - 10 * 60 * 1000 - 1000).toISOString();
    writeIntentState(tmpDir, { category: 'deep', confidence: 0.8 }, justOverTen);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('treats intent state just over 10 minutes old as stale', () => {
    const output = runHook(
      {
        tool_name: 'Task',
        tool_input: { subagent_type: 'agent-olympus:architect' },
        cwd: tmpDir,
      },
      { cwd: tmpDir },
    );
    assert.equal(output.continue, true);
    assert.equal(output.suppressOutput, true);
  });
});

// ---------------------------------------------------------------------------
// Valid fresh intent state → injects MODEL ROUTING context
// ---------------------------------------------------------------------------

describe('model-router-hook: fresh intent state injects routing context', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    writeIntentState(tmpDir, {
      category: 'deep',
      confidence: 0.85,
      scores: { deep: 2.0, planning: 0.5, quick: 0.1 },
    });
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('injects hookSpecificOutput with additionalContext', () => {
    const output = runHook(
      {
        tool_name: 'Task',
        tool_input: { subagent_type: 'agent-olympus:architect' },
        cwd: tmpDir,
      },
      { cwd: tmpDir },
    );
    assert.equal(output.continue, true);
    assert.ok(output.hookSpecificOutput?.additionalContext, 'should inject additionalContext');
  });

  it('additionalContext includes MODEL ROUTING header', () => {
    const output = runHook(
      {
        tool_name: 'Task',
        tool_input: { subagent_type: 'agent-olympus:architect' },
        cwd: tmpDir,
      },
      { cwd: tmpDir },
    );
    const ctx = output.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(ctx.includes('[MODEL ROUTING]'), `additionalContext should include [MODEL ROUTING], got: ${ctx}`);
  });

  it('hookEventName is PreToolUse', () => {
    const output = runHook(
      {
        tool_name: 'Task',
        tool_input: { subagent_type: 'agent-olympus:architect' },
        cwd: tmpDir,
      },
      { cwd: tmpDir },
    );
    assert.equal(output.hookSpecificOutput?.hookEventName, 'PreToolUse');
  });

  it('additionalContext includes recommended agent and model', () => {
    const output = runHook(
      {
        tool_name: 'Task',
        tool_input: { subagent_type: 'agent-olympus:architect' },
        cwd: tmpDir,
      },
      { cwd: tmpDir },
    );
    const ctx = output.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(ctx.includes('Recommended:'), `should include "Recommended:", got: ${ctx}`);
  });

  it('additionalContext includes the spawning subagent type', () => {
    const output = runHook(
      {
        tool_name: 'Task',
        tool_input: { subagent_type: 'agent-olympus:architect' },
        cwd: tmpDir,
      },
      { cwd: tmpDir },
    );
    const ctx = output.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(
      ctx.includes('agent-olympus:architect'),
      `additionalContext should include the subagent type, got: ${ctx}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Agent tool_name is also handled
// ---------------------------------------------------------------------------

describe('model-router-hook: Agent tool_name is treated same as Task', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    writeIntentState(tmpDir, { category: 'deep', confidence: 0.9 });
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('injects routing context for Agent tool_name', () => {
    const output = runHook(
      {
        tool_name: 'Agent',
        tool_input: { subagent_type: 'agent-olympus:executor' },
        cwd: tmpDir,
      },
      { cwd: tmpDir },
    );
    assert.equal(output.continue, true);
    assert.ok(
      output.hookSpecificOutput?.additionalContext,
      'should inject context for Agent tool_name',
    );
  });
});

// ---------------------------------------------------------------------------
// Unknown category → passes through silently
// ---------------------------------------------------------------------------

describe('model-router-hook: unknown category passes through silently', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    writeIntentState(tmpDir, {
      category: 'unknown',
      confidence: 0,
      scores: { deep: 0, planning: 0, quick: 0 },
    });
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('does not inject routing context when intent category is unknown', () => {
    const output = runHook(
      {
        tool_name: 'Task',
        tool_input: { subagent_type: 'agent-olympus:executor' },
        cwd: tmpDir,
      },
      { cwd: tmpDir },
    );
    assert.equal(output.continue, true);
    assert.equal(output.suppressOutput, true);
    assert.ok(!output.hookSpecificOutput, 'should not inject context for unknown intent');
  });
});

// ---------------------------------------------------------------------------
// Malformed input
// ---------------------------------------------------------------------------

describe('model-router-hook: malformed input handling', () => {
  it('returns valid JSON for non-JSON stdin', () => {
    const raw = execSync(`echo 'not json' | node "${SCRIPT}"`, {
      encoding: 'utf-8',
      cwd: os.tmpdir(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    assert.doesNotThrow(() => JSON.parse(raw.trim()));
    const output = JSON.parse(raw.trim());
    assert.equal(output.continue, true);
  });

  it('returns valid JSON for empty stdin', () => {
    const raw = execSync(`echo '' | node "${SCRIPT}"`, {
      encoding: 'utf-8',
      cwd: os.tmpdir(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    assert.doesNotThrow(() => JSON.parse(raw.trim()));
  });
});
