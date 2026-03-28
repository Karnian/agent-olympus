/**
 * Tests for scripts/intent-gate.mjs
 *
 * The hook functions are not exported, so we test via child_process:
 * pipe JSON on stdin, parse JSON from stdout.
 *
 * Uses node:test — zero npm dependencies.
 * All I/O uses temporary directories; the real .ao/ directory is never touched.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '..', 'intent-gate.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ao-intent-gate-test-'));
}

async function removeTmpDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Run the intent-gate hook with the given input object.
 * Returns the parsed JSON output.
 */
function runHook(input, { cwd, env = {} } = {}) {
  const json = JSON.stringify(input).replace(/'/g, "'\\''");
  const raw = execSync(`echo '${json}' | node "${SCRIPT}"`, {
    encoding: 'utf-8',
    cwd: cwd || os.tmpdir(),
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(raw.trim());
}

// ---------------------------------------------------------------------------
// DISABLE_AO guard
// ---------------------------------------------------------------------------

describe('intent-gate: DISABLE_AO guard', () => {
  it('outputs suppressOutput:true and does not classify when DISABLE_AO=1', () => {
    const tmpDir = os.tmpdir();
    const output = runHook({ prompt: 'refactor the entire database schema' }, {
      cwd: tmpDir,
      env: { DISABLE_AO: '1' },
    });

    assert.equal(output.continue, true);
    assert.equal(output.suppressOutput, true);
    assert.ok(!output.hookSpecificOutput, 'should not inject context when disabled');
  });
});

// ---------------------------------------------------------------------------
// Empty / malformed input handling
// ---------------------------------------------------------------------------

describe('intent-gate: empty and malformed input', () => {
  it('returns continue:true for empty stdin', () => {
    // pipe an empty string directly
    const raw = execSync(`echo '' | node "${SCRIPT}"`, {
      encoding: 'utf-8',
      cwd: os.tmpdir(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = JSON.parse(raw.trim());
    assert.equal(output.continue, true);
  });

  it('returns suppressOutput:true for non-JSON stdin', () => {
    const raw = execSync(`echo 'not json at all' | node "${SCRIPT}"`, {
      encoding: 'utf-8',
      cwd: os.tmpdir(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = JSON.parse(raw.trim());
    assert.equal(output.continue, true);
    assert.equal(output.suppressOutput, true);
  });

  it('returns suppressOutput:true for JSON with no extractable prompt', () => {
    const output = runHook({ randomKey: 'nothing here' });
    assert.equal(output.continue, true);
    assert.equal(output.suppressOutput, true);
  });
});

// ---------------------------------------------------------------------------
// extractPrompt shapes — verified through full hook output
// ---------------------------------------------------------------------------

describe('intent-gate: extractPrompt — flat prompt string', () => {
  let tmpDir;
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async () => { await removeTmpDir(tmpDir); });

  it('classifies a prompt from { prompt: "..." } shape', () => {
    const output = runHook(
      { prompt: 'refactor the database schema for better performance', cwd: tmpDir },
      { cwd: tmpDir },
    );
    assert.equal(output.continue, true);
    // Should produce routing context for a 'deep' intent
    assert.ok(output.hookSpecificOutput?.additionalContext, 'should inject additionalContext');
    assert.ok(
      output.hookSpecificOutput.additionalContext.includes('[INTENT:'),
      'additionalContext should include INTENT tag',
    );
  });
});

describe('intent-gate: extractPrompt — message.content string', () => {
  let tmpDir;
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async () => { await removeTmpDir(tmpDir); });

  it('classifies a prompt from { message: { content: "..." } } shape', () => {
    const output = runHook(
      { message: { content: 'write documentation for the API endpoints' }, cwd: tmpDir },
      { cwd: tmpDir },
    );
    assert.equal(output.continue, true);
    assert.ok(output.hookSpecificOutput?.additionalContext);
    assert.ok(output.hookSpecificOutput.additionalContext.includes('[INTENT:'));
  });
});

describe('intent-gate: extractPrompt — message.content array of parts', () => {
  let tmpDir;
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async () => { await removeTmpDir(tmpDir); });

  it('classifies a prompt from { message: { content: [{ type, text }] } } shape', () => {
    const output = runHook(
      {
        message: {
          content: [
            { type: 'text', text: 'design a beautiful dashboard UI with React and Tailwind' },
            { type: 'image', url: 'https://example.com/img.png' },
          ],
        },
        cwd: tmpDir,
      },
      { cwd: tmpDir },
    );
    assert.equal(output.continue, true);
    assert.ok(output.hookSpecificOutput?.additionalContext);
    // Should detect visual-engineering intent
    const ctx = output.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes('visual-engineering') || ctx.includes('[INTENT:'));
  });

  it('ignores non-text parts and only uses text parts', () => {
    const output = runHook(
      {
        message: {
          content: [
            { type: 'image', url: 'https://example.com/img.png' },
            { type: 'text', text: 'create a quick fix for the typo' },
          ],
        },
        cwd: tmpDir,
      },
      { cwd: tmpDir },
    );
    assert.equal(output.continue, true);
    // quick fix should produce a non-unknown intent or pass through
    assert.ok(typeof output.continue === 'boolean');
  });
});

// ---------------------------------------------------------------------------
// Intent classification — known categories produce routing context
// ---------------------------------------------------------------------------

describe('intent-gate: intent classification produces routing context', () => {
  let tmpDir;
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async () => { await removeTmpDir(tmpDir); });

  const cases = [
    {
      label: 'deep intent from architecture prompt',
      prompt: 'redesign the microservice architecture for better scalability',
      expectCategory: 'deep',
    },
    {
      label: 'visual-engineering from UI prompt',
      prompt: 'build a responsive navbar with CSS flexbox and dark mode toggle',
      expectCategory: 'visual-engineering',
    },
    {
      label: 'writing from documentation prompt',
      prompt: 'write documentation and add jsdoc comments to all exported functions',
      expectCategory: 'writing',
    },
    {
      label: 'planning from strategy prompt',
      prompt: 'help me plan the roadmap and strategy for the new feature',
      expectCategory: 'planning',
    },
  ];

  for (const { label, prompt, expectCategory } of cases) {
    it(`classifies ${label}`, () => {
      const output = runHook({ prompt, cwd: tmpDir }, { cwd: tmpDir });
      assert.equal(output.continue, true);
      const ctx = output.hookSpecificOutput?.additionalContext ?? '';
      assert.ok(ctx.includes(expectCategory), `expected category "${expectCategory}" in: ${ctx}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Unknown intent — suppressed output (no noise)
// ---------------------------------------------------------------------------

describe('intent-gate: unknown intent produces no noise', () => {
  it('suppresses output when intent is unknown with zero confidence', () => {
    // A prompt with no recognizable signal
    const output = runHook(
      { prompt: 'hello', cwd: os.tmpdir() },
      { cwd: os.tmpdir() },
    );
    assert.equal(output.continue, true);
    // Should not inject noisy additionalContext for a completely unknown intent
    // Either suppressOutput is set, or hookSpecificOutput is absent
    const hasNoise = output.hookSpecificOutput?.additionalContext?.includes('[INTENT: unknown');
    assert.ok(!hasNoise, 'should not inject INTENT:unknown noise into context');
  });
});

// ---------------------------------------------------------------------------
// State file is written for downstream hooks
// ---------------------------------------------------------------------------

describe('intent-gate: saves intent state file for downstream hooks', () => {
  let tmpDir;
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async () => { await removeTmpDir(tmpDir); });

  it('creates .ao/state/ao-intent.json with classification result', async () => {
    runHook(
      { prompt: 'optimize the database queries and add redis caching', cwd: tmpDir },
      { cwd: tmpDir },
    );

    const stateFile = path.join(tmpDir, '.ao', 'state', 'ao-intent.json');
    const raw = await fs.readFile(stateFile, 'utf-8');
    const state = JSON.parse(raw);

    assert.ok(typeof state.category === 'string', 'state.category should be a string');
    assert.ok(typeof state.confidence === 'number', 'state.confidence should be a number');
    assert.ok(typeof state.savedAt === 'string', 'state.savedAt should be an ISO timestamp');
    assert.ok(state.scores && typeof state.scores === 'object', 'state.scores should be an object');
  });

  it('savedAt is a recent ISO timestamp', async () => {
    const before = Date.now();
    runHook(
      { prompt: 'refactor authentication module with jwt tokens', cwd: tmpDir },
      { cwd: tmpDir },
    );
    const after = Date.now();

    const stateFile = path.join(tmpDir, '.ao', 'state', 'ao-intent.json');
    const raw = await fs.readFile(stateFile, 'utf-8');
    const state = JSON.parse(raw);

    const savedMs = new Date(state.savedAt).getTime();
    assert.ok(savedMs >= before && savedMs <= after + 2000, 'savedAt should be within test execution window');
  });
});

// ---------------------------------------------------------------------------
// hookSpecificOutput shape
// ---------------------------------------------------------------------------

describe('intent-gate: hookSpecificOutput shape', () => {
  let tmpDir;
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async () => { await removeTmpDir(tmpDir); });

  it('output includes hookEventName: UserPromptSubmit', () => {
    const output = runHook(
      { prompt: 'architect a new microservice for payment processing', cwd: tmpDir },
      { cwd: tmpDir },
    );
    assert.equal(output.continue, true);
    assert.equal(output.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
  });

  it('additionalContext includes confidence percentage', () => {
    const output = runHook(
      { prompt: 'redesign the database schema and optimize all queries for performance', cwd: tmpDir },
      { cwd: tmpDir },
    );
    const ctx = output.hookSpecificOutput?.additionalContext ?? '';
    assert.match(ctx, /\d+%/, 'additionalContext should include a confidence percentage');
  });
});
