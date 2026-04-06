/**
 * Tests for scripts/plan-execute-gate.mjs
 *
 * Tests via child_process: pipe JSON on stdin, read stdout JSON.
 * Tests cover:
 *   - mode=solo → outputs {}
 *   - mode=ask + simple plan → outputs {} (skip trivial)
 *   - mode=ask + complex plan → outputs additionalContext with AskUserQuestion instruction
 *   - mode=atlas → outputs additionalContext with atlas routing
 *   - mode=athena → outputs additionalContext with athena routing
 *   - AskUserQuestion payload consistency across modes
 *   - fallback instruction presence
 *   - marker file creation
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
const SCRIPT = path.resolve(__dirname, '..', 'plan-execute-gate.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ao-plan-gate-test-'));
}

async function removeTmpDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Run the plan-execute-gate hook in `cwd` with stdin `input`.
 * Returns parsed JSON output.
 */
function runHook(input, cwd) {
  const json = JSON.stringify(input).replace(/'/g, "'\\''");
  const raw = execSync(`echo '${json}' | node "${SCRIPT}"`, {
    encoding: 'utf-8',
    cwd,
    env: { ...process.env, DISABLE_AO: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10000,
  });
  return JSON.parse(raw.trim());
}

/**
 * Write .ao/autonomy.json with given planExecution mode.
 */
function writeAutonomy(dir, mode) {
  const aoDir = path.join(dir, '.ao');
  mkdirSync(aoDir, { recursive: true });
  writeFileSync(path.join(aoDir, 'autonomy.json'), JSON.stringify({ planExecution: mode }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('plan-execute-gate', () => {
  let tmpDir;

  before(async () => {
    tmpDir = await makeTmpDir();
  });

  after(async () => {
    await removeTmpDir(tmpDir);
  });

  describe('DISABLE_AO', () => {
    it('outputs {} when DISABLE_AO=1', () => {
      const raw = execSync(`echo '{}' | node "${SCRIPT}"`, {
        encoding: 'utf-8',
        cwd: tmpDir,
        env: { ...process.env, DISABLE_AO: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      });
      const result = JSON.parse(raw.trim());
      assert.deepStrictEqual(result, {});
    });
  });

  describe('mode=solo', () => {
    it('outputs {} for solo mode', async () => {
      const dir = await makeTmpDir();
      try {
        writeAutonomy(dir, 'solo');
        const result = runHook({ cwd: dir }, dir);
        assert.deepStrictEqual(result, {});
      } finally {
        await removeTmpDir(dir);
      }
    });
  });

  describe('mode=ask', () => {
    it('outputs {} for simple plans (≤2 allowedPrompts)', async () => {
      const dir = await makeTmpDir();
      try {
        writeAutonomy(dir, 'ask');
        const result = runHook({
          cwd: dir,
          tool_input: { allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }] },
        }, dir);
        assert.deepStrictEqual(result, {});
      } finally {
        await removeTmpDir(dir);
      }
    });

    it('outputs AskUserQuestion instructions for complex plans', async () => {
      const dir = await makeTmpDir();
      try {
        writeAutonomy(dir, 'ask');
        const result = runHook({
          cwd: dir,
          tool_input: {
            allowedPrompts: [
              { tool: 'Bash', prompt: 'run tests' },
              { tool: 'Bash', prompt: 'build' },
              { tool: 'Bash', prompt: 'lint' },
            ],
          },
        }, dir);

        assert.ok(result.hookSpecificOutput);
        const ctx = result.hookSpecificOutput.additionalContext;
        assert.ok(ctx.includes('AskUserQuestion'), 'should mention AskUserQuestion');
        assert.ok(ctx.includes('Solo (Recommended)'), 'should have Solo option');
        assert.ok(ctx.includes('Atlas'), 'should have Atlas option');
        assert.ok(ctx.includes('Athena'), 'should have Athena option');
        assert.ok(ctx.includes('Claude+Codex+Gemini'), 'Athena should mention all workers');
      } finally {
        await removeTmpDir(dir);
      }
    });

    it('includes fallback instruction', async () => {
      const dir = await makeTmpDir();
      try {
        writeAutonomy(dir, 'ask');
        const result = runHook({
          cwd: dir,
          tool_input: {
            allowedPrompts: [
              { tool: 'Bash', prompt: 'a' },
              { tool: 'Bash', prompt: 'b' },
              { tool: 'Bash', prompt: 'c' },
            ],
          },
        }, dir);

        const ctx = result.hookSpecificOutput.additionalContext;
        assert.ok(ctx.includes('fall back'), 'should include fallback instruction');
        assert.ok(ctx.includes('numbered markdown list'), 'should mention markdown list fallback');
      } finally {
        await removeTmpDir(dir);
      }
    });

    it('has consistent payload structure (JSON-parseable options block)', async () => {
      const dir = await makeTmpDir();
      try {
        writeAutonomy(dir, 'ask');
        const result = runHook({
          cwd: dir,
          tool_input: {
            allowedPrompts: [
              { tool: 'Bash', prompt: 'a' },
              { tool: 'Bash', prompt: 'b' },
              { tool: 'Bash', prompt: 'c' },
            ],
          },
        }, dir);

        const ctx = result.hookSpecificOutput.additionalContext;
        // Extract JSON block between { and }
        const jsonMatch = ctx.match(/\{[\s\S]*"questions"[\s\S]*\}/);
        assert.ok(jsonMatch, 'should contain a JSON payload');
        const payload = JSON.parse(jsonMatch[0]);
        assert.ok(Array.isArray(payload.questions), 'should have questions array');
        assert.equal(payload.questions[0].options.length, 3, 'should have 3 options');
        assert.equal(payload.questions[0].multiSelect, false, 'should be single-select');
      } finally {
        await removeTmpDir(dir);
      }
    });
  });

  describe('mode=atlas', () => {
    it('outputs atlas routing context', async () => {
      const dir = await makeTmpDir();
      try {
        writeAutonomy(dir, 'atlas');
        const result = runHook({ cwd: dir }, dir);
        assert.ok(result.hookSpecificOutput);
        const ctx = result.hookSpecificOutput.additionalContext;
        assert.ok(ctx.includes('atlas'), 'should mention atlas');
        assert.ok(ctx.includes('/atlas'), 'should reference /atlas skill');
      } finally {
        await removeTmpDir(dir);
      }
    });
  });

  describe('mode=athena', () => {
    it('outputs athena routing context', async () => {
      const dir = await makeTmpDir();
      try {
        writeAutonomy(dir, 'athena');
        const result = runHook({ cwd: dir }, dir);
        assert.ok(result.hookSpecificOutput);
        const ctx = result.hookSpecificOutput.additionalContext;
        assert.ok(ctx.includes('athena'), 'should mention athena');
        assert.ok(ctx.includes('/athena'), 'should reference /athena skill');
      } finally {
        await removeTmpDir(dir);
      }
    });
  });

  describe('marker file', () => {
    it('creates ao-plan-pending.json marker for complex ask mode', async () => {
      const dir = await makeTmpDir();
      try {
        writeAutonomy(dir, 'ask');
        runHook({
          cwd: dir,
          tool_input: {
            allowedPrompts: [
              { tool: 'Bash', prompt: 'a' },
              { tool: 'Bash', prompt: 'b' },
              { tool: 'Bash', prompt: 'c' },
            ],
          },
        }, dir);

        const markerPath = path.join(dir, '.ao', 'state', 'ao-plan-pending.json');
        assert.ok(existsSync(markerPath), 'marker file should exist');
        const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
        assert.equal(marker.mode, 'ask');
        assert.equal(marker.handled, false, 'marker should be unhandled');
      } finally {
        await removeTmpDir(dir);
      }
    });

    it('creates handled marker for solo mode', async () => {
      const dir = await makeTmpDir();
      try {
        writeAutonomy(dir, 'solo');
        runHook({ cwd: dir }, dir);

        const markerPath = path.join(dir, '.ao', 'state', 'ao-plan-pending.json');
        assert.ok(existsSync(markerPath), 'marker file should exist');
        const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
        assert.equal(marker.handled, true, 'solo marker should be pre-handled');
      } finally {
        await removeTmpDir(dir);
      }
    });
  });

  describe('default mode (no autonomy.json)', () => {
    it('defaults to ask mode for complex plans', async () => {
      const dir = await makeTmpDir();
      try {
        // No autonomy.json written — should default to 'ask'
        const result = runHook({
          cwd: dir,
          tool_input: {
            allowedPrompts: [
              { tool: 'Bash', prompt: 'a' },
              { tool: 'Bash', prompt: 'b' },
              { tool: 'Bash', prompt: 'c' },
            ],
          },
        }, dir);

        assert.ok(result.hookSpecificOutput);
        const ctx = result.hookSpecificOutput.additionalContext;
        assert.ok(ctx.includes('AskUserQuestion'));
      } finally {
        await removeTmpDir(dir);
      }
    });
  });
});
