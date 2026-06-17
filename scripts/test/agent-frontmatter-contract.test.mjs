import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOWED_KEYS = new Set(['name', 'model', 'description', 'tools', 'disallowedTools']);
const ALLOWED_MODELS = new Set(['haiku', 'sonnet', 'opus']);
const READONLY_AGENTS = ['explore', 'architect', 'code-reviewer', 'security-reviewer', 'momus'];
const READONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);
const BUILTIN_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Grep',
  'Glob',
  'Bash',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'Skill',
  'TodoWrite',
  'BashOutput',
  'KillShell',
]);

function parseFrontmatter(source) {
  const lines = source.split(/\r?\n/);
  if (lines[0] !== '---') {
    throw new Error('missing opening frontmatter delimiter');
  }

  const endIndex = lines.findIndex((line, index) => index > 0 && line === '---');
  if (endIndex === -1) {
    throw new Error('missing closing frontmatter delimiter');
  }

  const frontmatter = {};
  for (const line of lines.slice(1, endIndex)) {
    if (line.trim() === '') {
      continue;
    }

    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      throw new Error(`invalid frontmatter line: ${line}`);
    }

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    frontmatter[key] = value;
  }

  return frontmatter;
}

function tokenizeTools(value) {
  if (!value || value.trim() === '') {
    return [];
  }

  const tokens = [];
  let token = '';
  let depth = 0;

  for (const char of value) {
    if (char === '(') {
      depth += 1;
      token += char;
      continue;
    }

    if (char === ')') {
      depth -= 1;
      if (depth < 0) {
        throw new Error(`unbalanced tools token: ${value}`);
      }
      token += char;
      continue;
    }

    if (char === ',' && depth === 0) {
      const trimmed = token.trim();
      if (trimmed) {
        tokens.push(trimmed);
      }
      token = '';
      continue;
    }

    token += char;
  }

  if (depth !== 0) {
    throw new Error(`unbalanced tools token: ${value}`);
  }

  const trimmed = token.trim();
  if (trimmed) {
    tokens.push(trimmed);
  }

  return tokens;
}

function isRecognizedToolToken(token) {
  if (BUILTIN_TOOLS.has(token)) {
    return true;
  }

  if (/^(Bash|Agent|Task)\(.+\)$/.test(token)) {
    return true;
  }

  return /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/.test(token);
}

function assertExactSet(actual, expected, label) {
  for (const token of expected) {
    assert.ok(actual.has(token), `${label}: missing ${token}`);
  }
  for (const token of actual) {
    assert.ok(expected.has(token), `${label}: unexpected ${token}`);
  }
  assert.equal(actual.size, expected.size, `${label}: expected ${expected.size} tools, got ${actual.size}`);
}

function validateAgentFrontmatter({ source, fileStem, readonlyAgents = READONLY_AGENTS }) {
  const frontmatter = parseFrontmatter(source);

  for (const key of Object.keys(frontmatter)) {
    assert.ok(ALLOWED_KEYS.has(key), `${fileStem}: unknown frontmatter key ${key}`);
  }

  assert.equal(frontmatter.name, fileStem, `${fileStem}: name must equal file stem`);
  assert.ok(ALLOWED_MODELS.has(frontmatter.model), `${fileStem}: invalid model ${frontmatter.model}`);
  assert.ok(frontmatter.description?.length > 0, `${fileStem}: description is required`);

  let toolsTokens = [];
  if ('tools' in frontmatter) {
    toolsTokens = tokenizeTools(frontmatter.tools);
    for (const token of toolsTokens) {
      assert.ok(isRecognizedToolToken(token), `${fileStem}: unrecognized tools token ${token}`);
    }
  }

  if (readonlyAgents.includes(fileStem)) {
    assert.ok('tools' in frontmatter, `${fileStem}: read-only agent must declare tools`);
    assertExactSet(new Set(toolsTokens), READONLY_TOOLS, `${fileStem}: read-only tools`);
  }

  return { frontmatter, toolsTokens };
}

async function readAgentFiles() {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const agentsDir = path.resolve(testDir, '../../agents');
  const entries = await fs.readdir(agentsDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.join(agentsDir, entry.name))
    .sort();

  return Promise.all(files.map(async (filePath) => ({
    filePath,
    fileStem: path.basename(filePath, '.md'),
    source: await fs.readFile(filePath, 'utf8'),
  })));
}

describe('agent frontmatter parser', () => {
  it('parses frontmatter regardless of key order and preserves colons in values', () => {
    const parsed = parseFrontmatter(`---
description: Query adapter: Codex/Gemini cross-check
model: sonnet
name: ask
---

Body
`);

    assert.deepEqual(parsed, {
      description: 'Query adapter: Codex/Gemini cross-check',
      model: 'sonnet',
      name: 'ask',
    });
  });

  it('tokenizes tools on top-level commas only', () => {
    assert.deepEqual(
      tokenizeTools('Read, Bash(git diff:*), Agent(a, b), mcp__preview__snapshot'),
      ['Read', 'Bash(git diff:*)', 'Agent(a, b)', 'mcp__preview__snapshot'],
    );
  });
});

describe('agent frontmatter contract', () => {
  it('validates every agents/*.md schema and read-only allowlist contract', async () => {
    const agents = await readAgentFiles();
    assert.ok(agents.length > 0, 'expected at least one agent file');

    for (const agent of agents) {
      validateAgentFrontmatter(agent);
    }
  });

  it('fails read-only fixtures that include write, shell, or delegation tools', () => {
    assert.throws(
      () => validateAgentFrontmatter({
        fileStem: 'explore',
        source: `---
name: explore
model: haiku
description: Fixture read-only agent
tools: Read, Grep, Glob, WebFetch, WebSearch, Write, Bash(git diff:*), Agent(executor)
---
`,
      }),
      /unexpected (Write|Bash\(git diff:\*\)|Agent\(executor\))/,
    );
  });

  it('fails a tool key typo instead of inheriting all tools silently', () => {
    assert.throws(
      () => validateAgentFrontmatter({
        fileStem: 'explore',
        source: `---
name: explore
model: haiku
description: Fixture read-only agent
tool: Read, Grep, Glob, WebFetch, WebSearch
---
`,
      }),
      /unknown frontmatter key tool/,
    );
  });

  it('fails unrecognized tools tokens', () => {
    assert.throws(
      () => validateAgentFrontmatter({
        fileStem: 'writer',
        source: `---
name: writer
model: haiku
description: Fixture writer
tools: Read, Reed
---
`,
      }),
      /unrecognized tools token Reed/,
    );
  });
});
