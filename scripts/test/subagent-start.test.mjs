/**
 * Tests for scripts/subagent-start.mjs
 *
 * Tests via child_process: pipe JSON on stdin, read stdout JSON.
 * Tests cover:
 *   - outputs {} when no wisdom exists
 *   - outputs additionalContext when wisdom entries are present
 *   - only includes medium-confidence or better entries
 *   - always outputs valid JSON (fail-safe)
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
const SCRIPT = path.resolve(__dirname, '..', 'subagent-start.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ao-subagent-start-test-'));
}

async function removeTmpDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Run the subagent-start hook in `cwd` with stdin `input`.
 * Returns parsed JSON output.
 */
function runHook(input, cwd) {
  const json = JSON.stringify(input).replace(/'/g, "'\\''");
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
 * Write wisdom entries to .ao/wisdom.jsonl in `dir`.
 */
function writeWisdom(dir, entries) {
  const aoDir = path.join(dir, '.ao');
  mkdirSync(aoDir, { recursive: true, mode: 0o700 });
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(path.join(aoDir, 'wisdom.jsonl'), lines, { encoding: 'utf-8', mode: 0o600 });
}

// ---------------------------------------------------------------------------
// No wisdom — outputs {}
// ---------------------------------------------------------------------------

describe('subagent-start: no wisdom.jsonl → outputs {}', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    // No .ao directory at all
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('outputs Token Efficiency directive when no wisdom file exists (non-haiku default)', () => {
    const output = runHook({}, tmpDir);
    assert.ok(typeof output.additionalContext === 'string', 'should have additionalContext');
    assert.ok(output.additionalContext.includes('Token Efficiency'), 'should contain Token Efficiency directive');
    assert.ok(!output.additionalContext.includes('Prior Learnings'), 'should NOT contain Prior Learnings');
  });
});

describe('subagent-start: empty wisdom.jsonl → outputs {}', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    writeWisdom(tmpDir, []); // empty file
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('outputs Token Efficiency directive when wisdom file is empty (non-haiku default)', () => {
    const output = runHook({}, tmpDir);
    assert.ok(typeof output.additionalContext === 'string', 'should have additionalContext');
    assert.ok(output.additionalContext.includes('Token Efficiency'), 'should contain Token Efficiency directive');
    assert.ok(!output.additionalContext.includes('Prior Learnings'), 'should NOT contain Prior Learnings');
  });
});

// ---------------------------------------------------------------------------
// Wisdom entries present → outputs additionalContext
// ---------------------------------------------------------------------------

describe('subagent-start: wisdom entries present → outputs additionalContext', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    writeWisdom(tmpDir, [
      {
        timestamp: new Date().toISOString(),
        project: 'test',
        category: 'pattern',
        lesson: 'Always use atomic writes for state files',
        confidence: 'high',
      },
      {
        timestamp: new Date().toISOString(),
        project: 'test',
        category: 'build',
        lesson: 'Run npm ci for reproducible builds in CI',
        confidence: 'medium',
      },
    ]);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('includes additionalContext in output', () => {
    const output = runHook({}, tmpDir);
    assert.ok(typeof output.additionalContext === 'string', 'additionalContext should be a string');
  });

  it('additionalContext contains Prior Learnings header', () => {
    const output = runHook({}, tmpDir);
    assert.ok(
      output.additionalContext.includes('Prior Learnings'),
      'additionalContext should include Prior Learnings header',
    );
  });

  it('additionalContext includes lesson text', () => {
    const output = runHook({}, tmpDir);
    assert.ok(
      output.additionalContext.includes('atomic writes') ||
      output.additionalContext.includes('npm ci'),
      'additionalContext should contain lesson content',
    );
  });

  it('additionalContext includes category labels', () => {
    const output = runHook({}, tmpDir);
    assert.ok(
      output.additionalContext.includes('[pattern]') ||
      output.additionalContext.includes('[build]'),
      'additionalContext should include category labels',
    );
  });
});

// ---------------------------------------------------------------------------
// Only medium-confidence or better entries are included
// ---------------------------------------------------------------------------

describe('subagent-start: low-confidence wisdom is excluded', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    writeWisdom(tmpDir, [
      {
        timestamp: new Date().toISOString(),
        project: 'test',
        category: 'debug',
        lesson: 'This low confidence observation should be excluded from subagents',
        confidence: 'low',
      },
    ]);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('outputs only Token Efficiency (no wisdom) when only low-confidence entries exist', () => {
    const output = runHook({}, tmpDir);
    assert.ok(typeof output.additionalContext === 'string', 'should have additionalContext');
    assert.ok(output.additionalContext.includes('Token Efficiency'), 'should contain Token Efficiency directive');
    assert.ok(!output.additionalContext.includes('Prior Learnings'), 'should NOT contain wisdom');
  });
});

describe('subagent-start: medium-confidence is included, low is excluded', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    writeWisdom(tmpDir, [
      {
        timestamp: new Date().toISOString(),
        project: 'test',
        category: 'pattern',
        lesson: 'This medium confidence lesson should be included for subagents',
        confidence: 'medium',
      },
      {
        timestamp: new Date().toISOString(),
        project: 'test',
        category: 'debug',
        lesson: 'This low confidence lesson must be excluded from output',
        confidence: 'low',
      },
    ]);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('includes medium-confidence lesson', () => {
    const output = runHook({}, tmpDir);
    assert.ok(
      output.additionalContext?.includes('medium confidence lesson'),
      'medium confidence lesson should be present',
    );
  });

  it('excludes low-confidence lesson', () => {
    const output = runHook({}, tmpDir);
    assert.ok(
      !output.additionalContext?.includes('low confidence lesson'),
      'low confidence lesson should not be present',
    );
  });
});

// ---------------------------------------------------------------------------
// Stdin payload fields are accepted (future-proofing)
// ---------------------------------------------------------------------------

describe('subagent-start: accepts tool_input fields in stdin', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    writeWisdom(tmpDir, [
      {
        timestamp: new Date().toISOString(),
        project: 'test',
        category: 'architecture',
        lesson: 'Use ESM for all new scripts',
        confidence: 'high',
      },
    ]);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('handles subagent_type in tool_input without error', () => {
    const output = runHook(
      { tool_input: { subagent_type: 'agent-olympus:executor', prompt: 'do something' } },
      tmpDir,
    );
    assert.ok(typeof output === 'object', 'output should be an object');
    assert.ok(output.additionalContext?.includes('ESM'), 'should still inject wisdom');
  });
});

// ---------------------------------------------------------------------------
// Fail-safe — always valid JSON
// ---------------------------------------------------------------------------

describe('subagent-start: fail-safe — always valid JSON', () => {
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

// ---------------------------------------------------------------------------
// Token Efficiency directive injection
// ---------------------------------------------------------------------------

describe('subagent-start: non-haiku agent gets Token Efficiency directive even without wisdom', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    // No .ao directory — no wisdom file
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('injects Token Efficiency directive for executor even with no wisdom', () => {
    const output = runHook({ subagent_type: 'agent-olympus:executor' }, tmpDir);
    assert.ok(
      typeof output.additionalContext === 'string',
      'additionalContext should be present',
    );
    assert.ok(
      output.additionalContext.includes('Token Efficiency'),
      'additionalContext should contain Token Efficiency directive',
    );
  });
});

describe('subagent-start: haiku agent (explore) does NOT get Token Efficiency directive', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    // No .ao directory — no wisdom file
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('outputs {} for explore agent with no wisdom', () => {
    const output = runHook({ subagent_type: 'agent-olympus:explore' }, tmpDir);
    assert.deepEqual(output, {});
  });
});

describe('subagent-start: non-haiku agent with wisdom gets both Token Efficiency and Prior Learnings', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    writeWisdom(tmpDir, [
      {
        timestamp: new Date().toISOString(),
        project: 'test',
        category: 'pattern',
        lesson: 'Use dependency injection to decouple modules',
        confidence: 'high',
      },
    ]);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('additionalContext contains both Token Efficiency and Prior Learnings', () => {
    const output = runHook({ subagent_type: 'agent-olympus:executor' }, tmpDir);
    assert.ok(
      output.additionalContext.includes('Token Efficiency'),
      'additionalContext should contain Token Efficiency directive',
    );
    assert.ok(
      output.additionalContext.includes('Prior Learnings'),
      'additionalContext should contain Prior Learnings section',
    );
  });

  it('Token Efficiency directive appears before Prior Learnings', () => {
    const output = runHook({ subagent_type: 'agent-olympus:executor' }, tmpDir);
    const teIdx = output.additionalContext.indexOf('Token Efficiency');
    const plIdx = output.additionalContext.indexOf('Prior Learnings');
    assert.ok(teIdx !== -1, 'Token Efficiency directive must be present');
    assert.ok(plIdx !== -1, 'Prior Learnings section must be present');
    assert.ok(teIdx < plIdx, 'Token Efficiency must appear before Prior Learnings');
  });
});
