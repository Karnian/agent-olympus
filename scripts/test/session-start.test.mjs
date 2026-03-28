/**
 * Tests for scripts/session-start.mjs
 *
 * Tests via child_process: pipe `{}` on stdin, read stdout JSON.
 * Tests cover:
 *   - no checkpoint, no wisdom → outputs {}
 *   - existing checkpoint file → injects "Interrupted Session" section
 *   - wisdom entries → injects "Prior Learnings" section
 *   - git repo → may inject "Recent Changes" section
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
const SCRIPT = path.resolve(__dirname, '..', 'session-start.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ao-session-start-test-'));
}

async function removeTmpDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Run the session-start hook in `cwd` with stdin `input`.
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
 * Initialize a bare git repo in the given directory (no commits).
 */
function initGitRepo(dir) {
  execSync('git init -q', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
}

/**
 * Write a valid checkpoint file for the given orchestrator.
 */
function writeCheckpoint(dir, orchestrator, data = {}) {
  const stateDir = path.join(dir, '.ao', 'state');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const checkpoint = {
    orchestrator,
    phase: data.phase ?? 2,
    completedStories: data.completedStories ?? ['story-1'],
    savedAt: data.savedAt ?? new Date().toISOString(),
    startedAt: data.startedAt ?? new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    ...data,
  };
  writeFileSync(
    path.join(stateDir, `checkpoint-${orchestrator}.json`),
    JSON.stringify(checkpoint, null, 2),
    { encoding: 'utf-8', mode: 0o600 },
  );
}

/**
 * Write wisdom entries to .ao/wisdom.jsonl.
 */
function writeWisdom(dir, entries) {
  const aoDir = path.join(dir, '.ao');
  mkdirSync(aoDir, { recursive: true, mode: 0o700 });
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(path.join(aoDir, 'wisdom.jsonl'), lines, { encoding: 'utf-8', mode: 0o600 });
}

// ---------------------------------------------------------------------------
// No context: empty state → outputs {}
// ---------------------------------------------------------------------------

describe('session-start: no checkpoint, no wisdom, no git', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    // Plain directory, no git, no .ao/
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('outputs {} when there is nothing to inject', () => {
    const output = runHook({}, tmpDir);
    // Should be an empty object (no additionalContext)
    assert.deepEqual(output, {});
  });
});

// ---------------------------------------------------------------------------
// Checkpoint present → injects Interrupted Session section
// ---------------------------------------------------------------------------

describe('session-start: atlas checkpoint present', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    writeCheckpoint(tmpDir, 'atlas', { phase: 3, completedStories: ['story-1', 'story-2'] });
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('includes additionalContext with Interrupted Session section', () => {
    const output = runHook({}, tmpDir);
    assert.ok(typeof output.additionalContext === 'string', 'additionalContext should be a string');
    assert.ok(
      output.additionalContext.includes('Interrupted Session'),
      'should include "Interrupted Session" heading',
    );
  });

  it('mentions the orchestrator name', () => {
    const output = runHook({}, tmpDir);
    assert.ok(
      output.additionalContext.toLowerCase().includes('atlas'),
      'context should reference the atlas orchestrator',
    );
  });

  it('includes resume instruction with slash command', () => {
    const output = runHook({}, tmpDir);
    assert.match(
      output.additionalContext,
      /\/atlas|\/cancel/,
      'should include /atlas or /cancel instruction',
    );
  });
});

describe('session-start: athena checkpoint present', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    writeCheckpoint(tmpDir, 'athena', { phase: 1 });
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('includes Interrupted Session for athena checkpoint', () => {
    const output = runHook({}, tmpDir);
    assert.ok(output.additionalContext?.includes('Interrupted Session'));
    assert.ok(output.additionalContext?.toLowerCase().includes('athena'));
  });
});

describe('session-start: expired checkpoint (>24h) is ignored', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    const expiredAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeCheckpoint(tmpDir, 'atlas', { savedAt: expiredAt });
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('does not inject checkpoint context when checkpoint is expired', () => {
    const output = runHook({}, tmpDir);
    // Either empty object or additionalContext without "Interrupted Session"
    const ctx = output.additionalContext ?? '';
    assert.ok(
      !ctx.includes('Interrupted Session'),
      'expired checkpoint should not appear in context',
    );
  });
});

// ---------------------------------------------------------------------------
// Wisdom entries → injects Prior Learnings section
// ---------------------------------------------------------------------------

describe('session-start: wisdom entries present', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    writeWisdom(tmpDir, [
      {
        timestamp: new Date().toISOString(),
        project: 'test',
        category: 'pattern',
        lesson: 'Always use atomic writes for state files to avoid corruption',
        confidence: 'high',
      },
      {
        timestamp: new Date().toISOString(),
        project: 'test',
        category: 'build',
        lesson: 'Run npm ci instead of npm install in CI for reproducible builds',
        confidence: 'medium',
      },
    ]);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('includes additionalContext with Prior Learnings section', () => {
    const output = runHook({}, tmpDir);
    assert.ok(typeof output.additionalContext === 'string');
    assert.ok(
      output.additionalContext.includes('Prior Learnings'),
      'should include "Prior Learnings" heading',
    );
  });

  it('includes lesson text from wisdom entries', () => {
    const output = runHook({}, tmpDir);
    assert.ok(
      output.additionalContext.includes('atomic writes') ||
      output.additionalContext.includes('npm ci'),
      'should include lesson content from wisdom entries',
    );
  });
});

describe('session-start: low-confidence wisdom is excluded', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    writeWisdom(tmpDir, [
      {
        timestamp: new Date().toISOString(),
        project: 'test',
        category: 'debug',
        lesson: 'This is a low confidence observation that should be excluded',
        confidence: 'low',
      },
    ]);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('does not inject low-confidence wisdom entries', () => {
    const output = runHook({}, tmpDir);
    const ctx = output.additionalContext ?? '';
    assert.ok(
      !ctx.includes('low confidence observation'),
      'low-confidence wisdom should not appear in context',
    );
  });
});

// ---------------------------------------------------------------------------
// Git repo present → injects Recent Changes section
// ---------------------------------------------------------------------------

describe('session-start: git repo with commits', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    initGitRepo(tmpDir);
    // Create a commit so git log returns something
    writeFileSync(path.join(tmpDir, 'README.md'), '# Test', 'utf-8');
    execSync('git add README.md', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit -m "initial commit"', { cwd: tmpDir, stdio: 'pipe' });
    // Add wisdom so there's at least one context section (ensuring output is non-empty)
    writeWisdom(tmpDir, [
      {
        timestamp: new Date().toISOString(),
        project: 'test',
        category: 'build',
        lesson: 'Use ESM modules for all new scripts in this project',
        confidence: 'high',
      },
    ]);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('includes Recent Changes section from git log', () => {
    const output = runHook({}, tmpDir);
    assert.ok(typeof output.additionalContext === 'string');
    assert.ok(
      output.additionalContext.includes('Recent Changes'),
      'should include "Recent Changes" section',
    );
  });

  it('includes the commit message in recent changes', () => {
    const output = runHook({}, tmpDir);
    assert.ok(
      output.additionalContext.includes('initial commit'),
      'should include the commit message text',
    );
  });
});

// ---------------------------------------------------------------------------
// Output is always valid JSON (fail-safe)
// ---------------------------------------------------------------------------

describe('session-start: fail-safe — always valid JSON', () => {
  it('outputs valid JSON even for completely empty input', () => {
    const raw = execSync(`echo '' | node "${SCRIPT}"`, {
      encoding: 'utf-8',
      cwd: os.tmpdir(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    assert.doesNotThrow(() => JSON.parse(raw.trim()), 'output should always be valid JSON');
  });

  it('outputs valid JSON for non-JSON stdin', () => {
    const raw = execSync(`echo 'not json' | node "${SCRIPT}"`, {
      encoding: 'utf-8',
      cwd: os.tmpdir(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    assert.doesNotThrow(() => JSON.parse(raw.trim()), 'output should always be valid JSON');
  });
});

// ---------------------------------------------------------------------------
// Both checkpoint and wisdom present — sections are combined
// ---------------------------------------------------------------------------

describe('session-start: checkpoint and wisdom combined', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await makeTmpDir();
    writeCheckpoint(tmpDir, 'atlas', { phase: 1 });
    writeWisdom(tmpDir, [
      {
        timestamp: new Date().toISOString(),
        project: 'test',
        category: 'pattern',
        lesson: 'Keep hook scripts fail-safe with try/catch at the top level',
        confidence: 'high',
      },
    ]);
  });
  after(async () => { await removeTmpDir(tmpDir); });

  it('includes both Interrupted Session and Prior Learnings in a single additionalContext', () => {
    const output = runHook({}, tmpDir);
    assert.ok(output.additionalContext?.includes('Interrupted Session'));
    assert.ok(output.additionalContext?.includes('Prior Learnings'));
  });
});
